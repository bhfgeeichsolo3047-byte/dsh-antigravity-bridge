/**
 * A 侧角色模板的声明式同步（规格 §11.3 / §11.3.1 / §11.4 / §11.5）。
 *
 * 为什么需要它：v1 的 install.mjs 只做「覆盖写」，从不记录自己装过什么。
 * 于是装 v2 时旧文件原地留着，A 侧会同时看到两套规则 —— 而两份规则里
 * 词表是冲突的（PLAN_READY vs verdict: pass），A 会按先读到的那份回传。
 *
 * 四条规则（§11.3 + §11.3.1）：
 *   1. 本次要分发  → 覆盖写 + 记进 manifest
 *   2. manifest 里记过、本次不再分发 → 删除 + 从 manifest 移除
 *   3. 不在 manifest 里的一律不碰（用户自己放的文件不动）
 *   4. manifest 不存在或 schemaVersion 不认识 = 首次迁移 → 显式清理 LEGACY_V1_PATHS，
 *      但不写进 manifest（写进去下次会误以为是我装的，用户重装旧版就删不掉了）
 *
 * 判新旧用 sha256，不用版本号（§11.4）。front-matter 的 template_version 只给人看。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MANIFEST_NAME = '.dsh-collab-manifest.json';
export const MANIFEST_SCHEMA_VERSION = 1;

/** 模板在 geminiConfigDir 下的落点：单独一个目录，便于按目录清理，也不与其他规则文件混在一起。 */
export const TEMPLATE_SUBDIR = path.join('rules', 'dsh-collab');

/** 恒定两份（§11.1）。Executor 没有 A 侧模板 —— 它绑 DSH 当前会话，A 从不扮演它。 */
export const TEMPLATE_FILES = ['planner.md', 'reviewer.md'];

/** v1 遗留物的精确路径（相对 geminiConfigDir）。只删这两个，不做目录级扫描。 */
export const LEGACY_V1_PATHS = [
  path.join('rules', 'dsh-collab-protocol.md'),
  path.join('skills', 'dsh-collab', 'SKILL.md'),
];

export function sha256Of(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function manifestPathOf(geminiConfigDir) {
  return path.join(geminiConfigDir, MANIFEST_NAME);
}

/** 从 front-matter 里读 template_version，纯给人看；读不到返回 null。 */
export function templateVersionOf(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return null;
  const v = /^template_version:\s*(.+)$/m.exec(m[1]);
  return v ? v[1].trim() : null;
}

/**
 * 读 manifest 并判它的「可信度」。
 * kind: absent（从未装过 v2）| current（认识这个 schemaVersion）| unrecognized（有文件但不认识）
 * 后两种都算「不是首次」；absent 与 unrecognized 都要走首次迁移清理。
 */
export function readManifest(geminiConfigDir) {
  const file = manifestPathOf(geminiConfigDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { kind: 'absent', file, manifest: null, reason: 'manifest 不存在' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unrecognized', file, manifest: null, reason: 'manifest 不是合法 JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unrecognized', file, manifest: null, reason: 'manifest 顶层不是对象' };
  }
  if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return {
      kind: 'unrecognized',
      file,
      manifest: parsed,
      reason: `schemaVersion=${String(parsed.schemaVersion)} 不认识（本版只认 ${MANIFEST_SCHEMA_VERSION}）`,
    };
  }
  const files = Array.isArray(parsed.files)
    ? parsed.files.filter((f) => f && typeof f.path === 'string')
    : [];
  return { kind: 'current', file, manifest: { schemaVersion: MANIFEST_SCHEMA_VERSION, files }, reason: null };
}

/**
 * 算出这次要做什么，不落盘。返回的 plan 可直接打印（--dry-run）或交给 applyTemplateSync。
 */
export function planTemplateSync({ geminiConfigDir, srcDir, collabDirPosix = null }) {
  const read = readManifest(geminiConfigDir);
  const firstRun = read.kind !== 'current';

  const writes = [];
  for (const name of TEMPLATE_FILES) {
    const src = path.join(srcDir, name);
    if (!fs.existsSync(src)) {
      throw new Error(`模板源文件缺失：${src}`);
    }
    let content = fs.readFileSync(src, 'utf8');
    if (collabDirPosix) content = content.replaceAll('~/.dsh/agy-collab', collabDirPosix);
    writes.push({
      name,
      relPath: path.join(TEMPLATE_SUBDIR, name),
      dest: path.join(geminiConfigDir, TEMPLATE_SUBDIR, name),
      content,
      sha256: sha256Of(content),
      templateVersion: templateVersionOf(content),
    });
  }

  const previous = read.kind === 'current' ? read.manifest.files : [];
  const previousPaths = new Set(previous.map((f) => f.path));
  const nowPaths = new Set(writes.map((w) => w.relPath));

  // 规则 2：manifest 记过、本次不再分发的 → 删
  const deletes = [];
  for (const entry of previous) {
    if (nowPaths.has(entry.path)) continue;
    deletes.push({
      relPath: entry.path,
      dest: path.join(geminiConfigDir, entry.path),
      reason: 'manifest 记过但本版不再分发',
    });
  }

  // 规则 4：首次迁移 → 清 v1 遗留物。已经在 manifest 里的不重复删（上面已处理）。
  const legacy = [];
  if (firstRun) {
    for (const relPath of LEGACY_V1_PATHS) {
      if (previousPaths.has(relPath)) continue;
      legacy.push({
        relPath,
        dest: path.join(geminiConfigDir, relPath),
        reason: 'v1 遗留物，首次建 manifest 时清理',
      });
    }
  }

  return {
    firstRun,
    manifestFile: read.file,
    manifestKind: read.kind,
    manifestReason: read.reason,
    writes,
    deletes,
    legacy,
    nextManifest: {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      files: writes.map((w) => ({ path: w.relPath, sha256: w.sha256 })),
    },
  };
}

/** 落盘。返回实际动作清单，供调用方打印。 */
export function applyTemplateSync(plan, { dryRun = false } = {}) {
  const done = { written: [], deleted: [], skippedLegacy: [], manifest: null };

  for (const w of plan.writes) {
    if (!dryRun) {
      fs.mkdirSync(path.dirname(w.dest), { recursive: true });
      fs.writeFileSync(w.dest, w.content, 'utf8');
    }
    done.written.push(w.relPath);
  }

  for (const d of [...plan.deletes, ...plan.legacy]) {
    if (!fs.existsSync(d.dest)) {
      if (plan.legacy.includes(d)) done.skippedLegacy.push(d.relPath);
      continue;
    }
    if (!dryRun) {
      fs.rmSync(d.dest, { force: true });
      // v1 skill 在独立目录里，删完文件顺手清空目录（只清空，不递归删别人的东西）
      if (d.relPath.includes('skills')) {
        try {
          const dir = path.dirname(d.dest);
          if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        } catch {
          // 目录非空或权限不足：留着，不影响正确性
        }
      }
    }
    done.deleted.push(d.relPath);
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(plan.manifestFile), { recursive: true });
    fs.writeFileSync(plan.manifestFile, JSON.stringify(plan.nextManifest, null, 2) + '\n', 'utf8');
  }
  done.manifest = plan.manifestFile;
  return done;
}

/**
 * 给设置页用的三态（§11.5）：
 *   not_installed — 没装，外部角色不可用，只能跑进程内三角色
 *   installed     — 装了且哈希一致，显示 template_version
 *   drifted       — 装了但哈希不符，A 侧可能仍按旧协议回传，要提示「重新安装」
 */
export function inspectTemplates({ geminiConfigDir, srcDir, collabDirPosix = null }) {
  const plan = planTemplateSync({ geminiConfigDir, srcDir, collabDirPosix });
  const read = readManifest(geminiConfigDir);
  const recorded = new Map(
    (read.kind === 'current' ? read.manifest.files : []).map((f) => [f.path, f.sha256]),
  );

  const items = plan.writes.map((w) => {
    const exists = fs.existsSync(w.dest);
    let installedSha = null;
    if (exists) installedSha = sha256Of(fs.readFileSync(w.dest));
    const recordedSha = recorded.get(w.relPath) ?? null;
    let state;
    if (!exists) state = 'missing';
    else if (installedSha === w.sha256) state = 'in_sync';
    else if (recordedSha && installedSha === recordedSha) state = 'outdated';
    else state = 'drifted';
    return {
      name: w.name,
      relPath: w.relPath,
      templateVersion: w.templateVersion,
      bundledSha256: w.sha256,
      installedSha256: installedSha,
      recordedSha256: recordedSha,
      state,
    };
  });

  const legacyPresent = LEGACY_V1_PATHS.filter((p) => fs.existsSync(path.join(geminiConfigDir, p)));

  let status;
  if (!read.kind || read.kind === 'absent' || items.every((i) => i.state === 'missing')) {
    status = 'not_installed';
  } else if (items.every((i) => i.state === 'in_sync') && legacyPresent.length === 0) {
    status = 'installed';
  } else {
    status = 'drifted';
  }

  return { status, manifestKind: read.kind, items, legacyPresent };
}
