import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_V1_PATHS,
  MANIFEST_NAME,
  MANIFEST_SCHEMA_VERSION,
  TEMPLATE_FILES,
  TEMPLATE_SUBDIR,
  applyTemplateSync,
  inspectTemplates,
  planTemplateSync,
  readManifest,
  sha256Of,
  templateVersionOf,
} from '../../scripts/template-sync.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SRC_DIR = path.resolve(HERE, '..', '..', 'antigravity', 'rules', 'dsh-collab');

function mkConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tpl-'));
}

function writeManifest(dir, files, schemaVersion = MANIFEST_SCHEMA_VERSION) {
  fs.writeFileSync(
    path.join(dir, MANIFEST_NAME),
    JSON.stringify({ schemaVersion, files }, null, 2),
    'utf8',
  );
}

function put(dir, relPath, content) {
  const dest = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, 'utf8');
  return dest;
}

function read(dir, relPath) {
  return fs.readFileSync(path.join(dir, relPath), 'utf8');
}

function exists(dir, relPath) {
  return fs.existsSync(path.join(dir, relPath));
}

// ---------------------------------------------------------------- 纯函数

test('sha256Of 对同一输入稳定，对不同输入不同', () => {
  assert.equal(sha256Of('a'), sha256Of('a'));
  assert.notEqual(sha256Of('a'), sha256Of('b'));
  assert.match(sha256Of('a'), /^[0-9a-f]{64}$/);
});

test('templateVersionOf 从 front-matter 读 template_version', () => {
  const md = '---\nname: x\ntemplate_version: 2.0.0\n---\n\n# body\n';
  assert.equal(templateVersionOf(md), '2.0.0');
});

test('templateVersionOf 缺 front-matter 或字段时返回 null', () => {
  assert.equal(templateVersionOf('# 没有 front-matter'), null);
  assert.equal(templateVersionOf('---\nname: x\n---\nbody'), null);
});

// ---------------------------------------------------------------- manifest 四态

test('readManifest：文件不存在判 absent', () => {
  const dir = mkConfigDir();
  const r = readManifest(dir);
  assert.equal(r.kind, 'absent');
  assert.equal(r.manifest, null);
});

test('readManifest：合法 manifest 判 current 并过滤坏条目', () => {
  const dir = mkConfigDir();
  writeManifest(dir, [
    { path: 'rules/dsh-collab/planner.md', sha256: 'aa' },
    { nonsense: true },
    { path: 123 },
  ]);
  const r = readManifest(dir);
  assert.equal(r.kind, 'current');
  assert.equal(r.manifest.files.length, 1);
  assert.equal(r.manifest.files[0].path, 'rules/dsh-collab/planner.md');
});

test('readManifest：坏 JSON 判 unrecognized', () => {
  const dir = mkConfigDir();
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), '{not json', 'utf8');
  assert.equal(readManifest(dir).kind, 'unrecognized');
});

test('readManifest：schemaVersion 不认识判 unrecognized（触发首次迁移）', () => {
  const dir = mkConfigDir();
  writeManifest(dir, [], 99);
  const r = readManifest(dir);
  assert.equal(r.kind, 'unrecognized');
  assert.match(r.reason, /schemaVersion=99/);
});

test('readManifest：顶层是数组判 unrecognized', () => {
  const dir = mkConfigDir();
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), '[]', 'utf8');
  assert.equal(readManifest(dir).kind, 'unrecognized');
});

// ---------------------------------------------------------------- 首次迁移

test('首次安装：清理两个 v1 遗留物，且不把它们写进 manifest', () => {
  const dir = mkConfigDir();
  for (const rel of LEGACY_V1_PATHS) put(dir, rel, 'v1 legacy');

  const plan = planTemplateSync({ geminiConfigDir: dir, srcDir: SRC_DIR });
  assert.equal(plan.firstRun, true);
  assert.equal(plan.legacy.length, 2);
  assert.deepEqual(
    plan.legacy.map((l) => l.relPath).sort(),
    [...LEGACY_V1_PATHS].sort(),
  );

  applyTemplateSync(plan, { dryRun: false });

  for (const rel of LEGACY_V1_PATHS) assert.equal(exists(dir, rel), false, `${rel} 应被删除`);
  const manifest = JSON.parse(read(dir, MANIFEST_NAME));
  const paths = manifest.files.map((f) => f.path);
  for (const rel of LEGACY_V1_PATHS) assert.equal(paths.includes(rel), false, 'legacy 不该进 manifest');
  assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA_VERSION);
});

test('首次安装：v1 遗留物不存在时跳过而不报错', () => {
  const dir = mkConfigDir();
  const plan = planTemplateSync({ geminiConfigDir: dir, srcDir: SRC_DIR });
  const done = applyTemplateSync(plan, { dryRun: false });
  assert.deepEqual(done.deleted, []);
  assert.equal(done.skippedLegacy.length, 2);
});

test('首次安装：删除 v1 skill 后清空空的 skills/dsh-collab 目录', () => {
  const dir = mkConfigDir();
  put(dir, path.join('skills', 'dsh-collab', 'SKILL.md'), 'v1');
  applyTemplateSync(planTemplateSync({ geminiConfigDir: dir, srcDir: SRC_DIR }), { dryRun: false });
  assert.equal(fs.existsSync(path.join(dir, 'skills', 'dsh-collab')), false);
});

test('首次安装：skills 目录里还有别人的文件时不清目录', () => {
  const dir = mkConfigDir();
  put(dir, path.join('skills', 'dsh-collab', 'SKILL.md'), 'v1');
  put(dir, path.join('skills', 'dsh-collab', 'user-notes.md'), 'mine');
  applyTemplateSync(planTemplateSync({ geminiConfigDir: dir, srcDir: SRC_DIR }), { dryRun: false });
  assert.equal(exists(dir, path.join('skills', 'dsh-collab', 'SKILL.md')), false);
  assert.equal(exists(dir, path.join('skills', 'dsh-collab', 'user-notes.md')), true);
});

test('首次迁移后立刻写 manifest，下一次不再是 firstRun', () => {
  const dir = mkConfigDir();
  applyTemplateSync(planTemplateSync({ geminiConfigDir: dir, srcDir: SRC_DIR }), { dryRun: false });
  const plan2 = planTemplateSync({ geminiConfigDir: dir, srcDir: SRC_DIR });
  assert.equal(plan2.firstRun, false);
  assert.equal(plan2.legacy.length, 0);
});

test('schemaVersion 不认识也走首次迁移清理', () => {
  const dir = mkConfigDir();
  writeManifest(dir, [], 99);
  put(dir, LEGACY_V1_PATHS[0], 'v1');
  const plan = planTemplateSync({ geminiConfigDir: dir, srcDir: SRC_DIR });
  assert.equal(plan.firstRun, true);
  assert.equal(plan.legacy.length, 2);
});

// ---------------------------------------------------------------- 三条规则

test('规则 1：本次分发的两个模板被覆盖写，且 manifest 记下 sha256', () => {
  const dir = mkConfigDir();
  const plan = planTemplateSync({ geminiConfigDir: dir, srcDir: SRC_DIR });
  applyTemplateSync(plan, { dryRun: false });

  assert.equal(plan.writes.length, TEMPLATE_FILES.length);
  const manifest = JSON.parse(read(dir, MANIFEST_NAME));
  assert.equal(manifest.files.length, TEMPLATE_FILES.length);

  for (const w of plan.writes) {
    assert.equal(exists(dir, w.relPath), true);
    assert.equal(sha256Of(read(dir, w.relPath)), w.sha256);
    const entry = manifest.files.find((f) => f.path === w.relPath);
    assert.ok(entry, 'manifest 里应有 ' + w.relPath);
    assert.equal(entry.sha256, w.sha256);
  }
});

test('规则 2：manifest 记过但本次不再分发的文件被删除并移出 manifest', () => {
  const dir = mkConfigDir();
  applyTemplateSync(planTemplateSync({ geminiConfigDir: dir, srcDir: SRC_DIR }), { dryRun: false });

  // 模拟上一版多分发了一个文件
  const stale = path.join(TEMPLATE_SUBDIR, 'executor.md');
  put(dir, stale, 'old template');
  const manifest = JSON.parse(read(dir, MANIFEST_NAME));
  manifest.files.push({ path: stale, sha256: sha256Of('old template') });
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');

  const plan = planTemplateSync({ geminiConfigDir: dir, srcDir: SRC_DIR });
  assert.equal(plan.firstRun, false);
  assert.deepEqual(plan.deletes.map((d) => d.relPath), [stale]);

  applyTemplateSync(plan, { dryRun: false });
  assert.equal(exists(dir, stale), false);
  const after = JSON.parse(read(dir, MANIFEST_NAME));
  assert.equal(after.files.some((f) => f.path === stale), false);
});

test('规则 3：不在 manifest 里的文件一律不碰', () => {
  const dir = mkConfigDir();
  applyTemplateSync(planTemplateSync({ geminiConfigDir: dir, srcDir: SRC_DIR }), { dryRun: false });

  const mine = path.join(TEMPLATE_SUBDIR, 'my-own-rule.md');
  put(dir, mine, 'user file');
  const otherRoot = path.join('rules', 'something-else.md');
  put(dir, otherRoot, 'another user file');

  applyTemplateSync(planTemplateSync({ geminiConfigDir: dir, srcDir: SRC_DIR }), { dryRun: false });
  assert.equal(read(dir, mine), 'user file');
  assert.equal(read(dir, otherRoot), 'another user file');
});

// ---------------------------------------------------------------- dry-run

test('dry-run 不改任何文件，但 plan 里已列出将删除与将写入', () => {
  const dir = mkConfigDir();
  put(dir, LEGACY_V1_PATHS[0], 'v1');

  const plan = planTemplateSync({ geminiConfigDir: dir, srcDir: SRC_DIR });
  const done = applyTemplateSync(plan, { dryRun: true });

  assert.equal(exists(dir, LEGACY_V1_PATHS[0]), true, 'dry-run 不该删文件');
  assert.equal(exists(dir, plan.writes[0].relPath), false, 'dry-run 不该写文件');
  assert.equal(exists(dir, MANIFEST_NAME), false, 'dry-run 不该写 manifest');
  assert.deepEqual(done.deleted, [LEGACY_V1_PATHS[0]]);
  assert.equal(done.written.length, TEMPLATE_FILES.length);
});

// ---------------------------------------------------------------- 路径替换

test('collabDirPosix 会替换模板里的 ~/.dsh/agy-collab', () => {
  const dir = mkConfigDir();
  const plan = planTemplateSync({
    geminiConfigDir: dir,
    srcDir: SRC_DIR,
    collabDirPosix: '/custom/collab',
  });
  applyTemplateSync(plan, { dryRun: false });
  for (const w of plan.writes) {
    const text = read(dir, w.relPath);
    assert.equal(text.includes('~/.dsh/agy-collab'), false);
    assert.equal(text.includes('/custom/collab'), true);
  }
});

// ---------------------------------------------------------------- 三态

test('inspectTemplates：没装判 not_installed', () => {
  const dir = mkConfigDir();
  const view = inspectTemplates({ geminiConfigDir: dir, srcDir: SRC_DIR });
  assert.equal(view.status, 'not_installed');
  assert.equal(view.items.every((i) => i.state === 'missing'), true);
});

test('inspectTemplates：装好且一致判 installed，并带 template_version', () => {
  const dir = mkConfigDir();
  applyTemplateSync(planTemplateSync({ geminiConfigDir: dir, srcDir: SRC_DIR }), { dryRun: false });
  const view = inspectTemplates({ geminiConfigDir: dir, srcDir: SRC_DIR });
  assert.equal(view.status, 'installed');
  assert.equal(view.items.every((i) => i.state === 'in_sync'), true);
  assert.equal(view.items.every((i) => typeof i.templateVersion === 'string'), true);
  assert.deepEqual(view.legacyPresent, []);
});

test('inspectTemplates：已装但被改过判 drifted', () => {
  const dir = mkConfigDir();
  applyTemplateSync(planTemplateSync({ geminiConfigDir: dir, srcDir: SRC_DIR }), { dryRun: false });
  put(dir, path.join(TEMPLATE_SUBDIR, 'planner.md'), '被人改过');

  const view = inspectTemplates({ geminiConfigDir: dir, srcDir: SRC_DIR });
  assert.equal(view.status, 'drifted');
  const planner = view.items.find((i) => i.name === 'planner.md');
  assert.equal(planner.state, 'drifted');
  assert.notEqual(planner.installedSha256, planner.bundledSha256);
});

test('inspectTemplates：磁盘上是上一版（与 manifest 一致但与 bundled 不同）判 outdated', () => {
  const dir = mkConfigDir();
  applyTemplateSync(planTemplateSync({ geminiConfigDir: dir, srcDir: SRC_DIR }), { dryRun: false });

  // 造一个「上一版」：文件内容改掉，并把 manifest 的 sha 也改成它的
  const oldContent = '---\ntemplate_version: 1.0.0\n---\nold\n';
  put(dir, path.join(TEMPLATE_SUBDIR, 'planner.md'), oldContent);
  const manifest = JSON.parse(read(dir, MANIFEST_NAME));
  for (const f of manifest.files) {
    if (f.path.endsWith('planner.md')) f.sha256 = sha256Of(oldContent);
  }
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');

  const view = inspectTemplates({ geminiConfigDir: dir, srcDir: SRC_DIR });
  const planner = view.items.find((i) => i.name === 'planner.md');
  assert.equal(planner.state, 'outdated');
  assert.equal(view.status, 'drifted');
});

test('inspectTemplates：残留 v1 文件时即使模板都对也判 drifted', () => {
  const dir = mkConfigDir();
  applyTemplateSync(planTemplateSync({ geminiConfigDir: dir, srcDir: SRC_DIR }), { dryRun: false });
  put(dir, LEGACY_V1_PATHS[0], 'v1 leftover');

  const view = inspectTemplates({ geminiConfigDir: dir, srcDir: SRC_DIR });
  assert.equal(view.status, 'drifted');
  assert.deepEqual(view.legacyPresent, [LEGACY_V1_PATHS[0]]);
});

// ---------------------------------------------------------------- 源模板自身

test('两份源模板都带 role 与 template_version front-matter，且用 role 而非 phase', () => {
  for (const name of TEMPLATE_FILES) {
    const text = fs.readFileSync(path.join(SRC_DIR, name), 'utf8');
    assert.match(text, /^---\r?\n/, name + ' 应有 front-matter');
    assert.match(text, /template_version:\s*2\./, name + ' 应是 v2 模板');
    const expectRole = name.startsWith('planner') ? 'planner' : 'reviewer';
    assert.match(text, new RegExp('role:\\s*' + expectRole), name + ' front-matter 的 role 应正确');
  }
});

test('两份源模板不把 v1 旧词表当命令用（只允许出现在明令禁止的句子里）', () => {
  // §9.2：旧词表是删除不是翻译。模板里允许写「没有 APPROVED」这种否定说明 ——
  // 那是告诉 A 别再用它；但绝不能出现 --verdict "APPROVED" 这类可直接照抄的命令。
  const banned = ['PLAN_READY', 'CONSULT_ANSWERED', 'APPROVED', 'CHANGES_REQUESTED'];
  const negation = /没有|不再|不是|禁止|删|旧词表|不许|不要/;
  for (const name of TEMPLATE_FILES) {
    const text = fs.readFileSync(path.join(SRC_DIR, name), 'utf8');
    for (const word of banned) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.includes(word)) continue;
        assert.match(line, negation, `${name} 里 ${word} 只该出现在否定说明中，实际行：${line.trim()}`);
      }
    }
    // 更硬的一条：不许有把旧词表塞进 --verdict 的现成命令
    assert.equal(/--verdict\s+"?(PLAN_READY|CONSULT_ANSWERED|APPROVED|CHANGES_REQUESTED)/.test(text), false, name + ' 不该给出旧词表的 --verdict 命令');
  }
});

test('Reviewer 模板明确禁止读 02-执行方案', () => {
  const text = fs.readFileSync(path.join(SRC_DIR, 'reviewer.md'), 'utf8');
  assert.match(text, /02-执行方案/);
  assert.match(text, /不能读|不要读|不许读/);
});

test('Planner 模板写明 03 只写一次并冻结', () => {
  const text = fs.readFileSync(path.join(SRC_DIR, 'planner.md'), 'utf8');
  assert.match(text, /03-任务清单/);
  assert.match(text, /冻结/);
});
