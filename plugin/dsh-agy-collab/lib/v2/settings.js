/**
 * 设置页的服务层（规格 §12）。
 *
 * 客户端只能「发意图」，不能直接改盘：所有写入都经过这里，
 * 由 Host 用 config.js 的 setter 算出新配置、校验角色绑定自洽、再原子落盘。
 *
 * 这一层还负责把运行台要读的东西拼成一份快照：
 *   - config      当前配置（归一化后）
 *   - runtime     当前会话的编排器快照（没有任务时 active:false）
 *   - templates   A 侧模板三态（§11.5）
 *   - broker      总线四态（§12.4，运行态由调用方注入）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  CARRIERS,
  MAX_REJECTION_LIMIT,
  MIN_REJECTION_LIMIT,
  REVIEWER_MODES,
  ROLE_BINDING_MODES,
  ROLE_NAMES,
  normalizeConfig,
  resolveBrokerPort,
  setBrokerPort,
  setCollabEnabled,
  setEstimateSubagents,
  setGlobalEnabled,
  setRejectionLimit,
  setReviewerMode,
  setRoleBinding,
  setRoleBindingMode,
  setWorkspaceRoot,
  validateRoleBindings,
  writeConfigFile,
} from './config.js';

/** 与 scripts/template-sync.mjs 同名同形，但插件被单独复制到 ~/.dsh/agy-collab，不能 import 脚本目录。 */
export const TEMPLATE_MANIFEST_NAME = '.dsh-collab-manifest.json';
export const TEMPLATE_MANIFEST_SCHEMA_VERSION = 1;
export const TEMPLATE_SUBDIR = path.join('rules', 'dsh-collab');
export const TEMPLATE_FILES = Object.freeze(['planner.md', 'reviewer.md']);
/** v1 遗留物：首次装 v2 时由 install.mjs 删掉；这里只负责在它们还活着时报警。 */
export const LEGACY_TEMPLATE_PATHS = Object.freeze([
  path.join('rules', 'dsh-collab-protocol.md'),
  path.join('skills', 'dsh-collab', 'SKILL.md'),
]);

/** ~/.gemini/config；env GEMINI_CONFIG_DIR 可覆盖（与 install.mjs 一致）。 */
export function resolveGeminiConfigDir(env = process.env) {
  const explicit = String(env?.GEMINI_CONFIG_DIR ?? '').trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), '.gemini', 'config');
}

function sha256OfFile(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** 从 front-matter 里取 template_version（只读第一段 --- 之间）。 */
export function templateVersionOf(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const head = text.split(/\n---\s*\n/)[0] ?? '';
    const m = /^template_version:\s*(.+)$/m.exec(head);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function readManifest(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { kind: 'absent', files: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unrecognized', files: [], reason: 'manifest 不是合法 JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unrecognized', files: [], reason: 'manifest 顶层不是对象' };
  }
  if (Number(parsed.schemaVersion) !== TEMPLATE_MANIFEST_SCHEMA_VERSION) {
    return {
      kind: 'unrecognized',
      files: [],
      reason: `schemaVersion=${parsed.schemaVersion} 不认识（本版只认 ${TEMPLATE_MANIFEST_SCHEMA_VERSION}）`,
    };
  }
  const files = Array.isArray(parsed.files) ? parsed.files : [];
  return {
    kind: 'current',
    files: files.filter((f) => f && typeof f.path === 'string'),
  };
}

/**
 * A 侧模板三态（§11.5）。
 * 判据只有一条：磁盘上的文件与 manifest 记的 sha256 是否一致。
 * 「bundled 是否更新」由 install.mjs 负责判断（插件运行时拿不到仓库里的模板源），
 * 所以这里把「磁盘 = 记录」叫 installed，不一致叫 drifted，两份都不在叫 not_installed。
 *
 * @returns {{ status: 'not_installed'|'installed'|'drifted', manifestKind: string, items: object[], legacyPresent: string[] }}
 */
export function inspectInstalledTemplates({ geminiConfigDir = resolveGeminiConfigDir() } = {}) {
  const manifestFile = path.join(geminiConfigDir, TEMPLATE_MANIFEST_NAME);
  const manifest = readManifest(manifestFile);
  const recorded = new Map();
  for (const f of manifest.files) recorded.set(f.path, String(f.sha256 ?? ''));

  const items = TEMPLATE_FILES.map((name) => {
    const relPath = path.join(TEMPLATE_SUBDIR, name);
    const file = path.join(geminiConfigDir, relPath);
    const actual = sha256OfFile(file);
    const expected = recorded.get(relPath) ?? recorded.get(relPath.split(path.sep).join('/')) ?? null;
    let state;
    if (!actual) state = 'missing';
    else if (!expected) state = 'drifted';
    else state = actual === expected ? 'in_sync' : 'drifted';
    return {
      name,
      relPath,
      path: file,
      state,
      templateVersion: actual ? templateVersionOf(file) : null,
      sha256: actual,
    };
  });

  const legacyPresent = LEGACY_TEMPLATE_PATHS.filter((rel) =>
    fs.existsSync(path.join(geminiConfigDir, rel)),
  );

  let status;
  if (items.every((it) => it.state === 'missing')) status = 'not_installed';
  else if (items.every((it) => it.state === 'in_sync') && legacyPresent.length === 0) {
    status = 'installed';
  } else status = 'drifted';

  return { status, manifestKind: manifest.kind, manifestFile, items, legacyPresent };
}

/** 允许从设置页改的顶层键（白名单；不在表里的一律拒收，避免 UI 变成任意写盘入口）。 */
export const PATCHABLE_KEYS = Object.freeze([
  'enabled',
  'globalEnabled',
  'role_binding_mode',
  'reviewer_mode',
  'rejection_limit',
  'estimate_subagents',
  'workspaceRoot',
  'brokerPort',
  'roles',
]);

/**
 * 把一次 patch 应用到一个配置对象上。
 * 不落盘：落盘由调用方在 validateRoleBindings 通过之后做。
 * @returns {{ ok: boolean, config?: object, error?: string }}
 */
export function applyConfigPatch({ config, patch, dataDir = null, sessionId = '', stage, now = Date.now() }) {
  const keys = Object.keys(patch ?? {});
  const unknown = keys.filter((k) => !PATCHABLE_KEYS.includes(k));
  if (unknown.length) return { ok: false, error: `不认识的配置项：${unknown.join('、')}` };
  if (!keys.length) return { ok: false, error: 'patch 是空的，没有要改的项' };

  let next = normalizeConfig(config, { now });

  try {
    if (patch.enabled !== undefined) {
      if (!sessionId) return { ok: false, error: '协作开关是按会话的，必须带 sessionId' };
      next = setCollabEnabled(next, sessionId, Boolean(patch.enabled), { now });
    }
    if (patch.globalEnabled !== undefined) {
      next = setGlobalEnabled(next, Boolean(patch.globalEnabled), { now });
    }
    if (patch.role_binding_mode !== undefined) {
      next = setRoleBindingMode(next, patch.role_binding_mode, { now });
    }
    if (patch.reviewer_mode !== undefined) {
      next = setReviewerMode(next, patch.reviewer_mode, { now });
    }
    if (patch.rejection_limit !== undefined) {
      const result = setRejectionLimit(next, patch.rejection_limit, { stage, now });
      if (!result.ok) return { ok: false, error: result.error };
      next = result.config;
    }
    if (patch.estimate_subagents !== undefined) {
      next = setEstimateSubagents(next, Boolean(patch.estimate_subagents), { now });
    }
    if (patch.workspaceRoot !== undefined) {
      next = setWorkspaceRoot(next, patch.workspaceRoot, { now, dataDir });
    }
    if (patch.brokerPort !== undefined) {
      next = setBrokerPort(next, patch.brokerPort, { now });
    }
    if (patch.roles !== undefined) {
      if (!patch.roles || typeof patch.roles !== 'object' || Array.isArray(patch.roles)) {
        return { ok: false, error: 'roles 必须是对象' };
      }
      for (const role of Object.keys(patch.roles)) {
        if (!ROLE_NAMES.includes(role)) return { ok: false, error: `不认识的角色：${role}` };
        next = setRoleBinding(next, role, patch.roles[role] ?? {}, { now });
      }
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }

  const validation = validateRoleBindings(next);
  if (!validation.ok) return { ok: false, error: validation.errors.join('；') };
  return { ok: true, config: next };
}

/** 角色绑定在设置页展示用的说明（只读文本，不含判定逻辑）。 */
export const ROLE_META = Object.freeze({
  planner: {
    title: '规划 agent',
    brief: '任务拆解 · 步骤规划 · 只写 02/03/05',
    read: '01 / 03 / 04 / 05',
    write: '02 plan.md、03 tasks.md、05 revision-r<N>.md',
    note: '无 bash、无仓库写通道；03 全流程只写一次，写完冻结。',
  },
  executor: {
    title: '主 agent（执行）',
    brief: '当前会话 · 固定不可换 · 唯一有仓库写权限',
    read: '全部（含仓库）',
    write: '不写任何六目录文件，只写仓库产物',
    note: '想改需求的唯一合法路径是判阻塞（running → blocked）。',
  },
  reviewer: {
    title: '审核 agent',
    brief: '只读 · 只判是否达成 · 只写 04/06',
    read: '01 / 03 / 04 / 06 + 仓库客观产物',
    write: '04 review-r<N>.md、06 final.md',
    note: '输入里没有 Executor 的任何主观叙述；不读 02（读了会被方案带偏）。',
  },
});

/**
 * 设置页要的那一份快照。
 * @param {object} opts
 * @param {object} opts.config      当前配置
 * @param {string} opts.sessionId   当前会话（决定协作开关与 runtime）
 * @param {object} [opts.runtime]   当前会话编排器快照（active/state/round/...）
 * @param {object} [opts.broker]    总线运行态 { state, port, pid, message }
 * @param {object} [opts.env]
 */
export function buildSettingsSnapshot({ config, sessionId = '', runtime = null, broker = null, env = process.env } = {}) {
  const normalized = normalizeConfig(config, {});
  const validation = validateRoleBindings(normalized);
  const templates = inspectInstalledTemplates({ geminiConfigDir: resolveGeminiConfigDir(env) });
  const effectiveBrokerPort = resolveBrokerPort(normalized, env);
  return {
    config: normalized,
    sessionId: String(sessionId ?? '').trim(),
    enabled: Boolean(
      sessionId && Object.prototype.hasOwnProperty.call(normalized.sessions ?? {}, String(sessionId).trim())
        ? normalized.sessions[String(sessionId).trim()]
        : normalized.enabled,
    ),
    validation,
    roles: ROLE_META,
    enums: {
      role_binding_mode: [...ROLE_BINDING_MODES],
      reviewer_mode: [...REVIEWER_MODES],
      carriers: [...CARRIERS],
      rejection_limit: { min: MIN_REJECTION_LIMIT, max: MAX_REJECTION_LIMIT },
    },
    templates,
    broker: {
      state: broker?.state ?? 'unknown',
      port: broker?.port ?? effectiveBrokerPort,
      pid: broker?.pid ?? null,
      message: broker?.message ?? null,
    },
    runtime: runtime ?? { active: false },
  };
}

/**
 * 写入一份配置并返回新配置。调用方负责先把 patch 算过（applyConfigPatch）。
 */
export function persistConfig(dataDir, config, { now = Date.now() } = {}) {
  return writeConfigFile(dataDir, config, { now });
}
