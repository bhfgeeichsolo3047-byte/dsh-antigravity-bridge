/**
 * dsh-agy-collab v2 — 配置层
 *
 * 负责「配置 state.json」的全部读写：默认值、schema v2 迁移闸、按会话开关、
 * 角色绑定校验、boot-id 推导。零外部依赖，只碰 node 内置模块。
 *
 * 与「任务 state.json」的区别见 docs/specs/dsh-agy-collab-v2-spec.md §1.1：
 * 配置侧管「要不要跑」（长期存在），任务侧管「跑到哪了」（随 Host 退出删除）。
 * 本文件绝不触碰任务 state.json。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const CONFIG_SCHEMA_VERSION = 2;
export const STATE_FILE_NAME = 'state.json';
export const RECORDS_FILE_NAME = 'records.json';
export const HISTORY_FILE_NAME = 'history.jsonl';
export const DEFAULT_BROKER_PORT = 18765;
export const DEFAULT_REJECTION_LIMIT = 2;
export const MIN_REJECTION_LIMIT = 1;
export const MAX_REJECTION_LIMIT = 5;
export const ROLE_BINDING_MODES = Object.freeze(['triple', 'dual']);
export const REVIEWER_MODES = Object.freeze(['strict', 'loose']);
export const ROLE_NAMES = Object.freeze(['planner', 'executor', 'reviewer']);
export const CARRIERS = Object.freeze(['in-process', 'session', 'external']);

/** 角色绑定默认值：三角色三角色，Executor 固定当前会话。 */
export function defaultRoles() {
  return {
    planner: { carrier: 'in-process', model: null, actor_id: null },
    executor: { carrier: 'session', model: null, actor_id: null },
    reviewer: { carrier: 'in-process', model: null, actor_id: null },
  };
}

/**
 * 一份完整的 v2 配置默认值。
 * workspaceRoot 缺省跟着 dataDir 走：数据目录被 env 或参数改到临时位置时，
 * 工作台也必须跟着走，否则测试/冒烟会把临时任务写进用户真实 home。
 */
export function defaultConfig(now = Date.now(), { dataDir } = {}) {
  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    enabled: false,
    sessions: {},
    brokerPort: DEFAULT_BROKER_PORT,
    workspaceRoot: dataDir ? path.join(dataDir, 'workspace') : '~/.dsh/agy-collab/workspace',
    role_binding_mode: 'triple',
    roles: defaultRoles(),
    reviewer_mode: 'strict',
    rejection_limit: DEFAULT_REJECTION_LIMIT,
    estimate_subagents: false,
    updatedAt: Number(now) || 0,
  };
}

/** 配置 state.json 的绝对路径。 */
export function configPath(dataDir) {
  return path.join(dataDir, STATE_FILE_NAME);
}

/** 原子写：先写同目录临时文件再 rename，避免半截文件。 */
export function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 读原始配置对象（不补默认值）；文件不存在或损坏返回 null。 */
export function readConfigFile(dataDir) {
  return readJsonOrNull(configPath(dataDir));
}

/**
 * 把任意来源的对象归一成合法 v2 配置。
 * 未知键原位保留（§8「旧字段 enabled/sessions/updatedAt 原位保留，不搬家」）。
 */
export function normalizeConfig(raw, { now = Date.now(), dataDir } = {}) {
  const base = defaultConfig(now, { dataDir });
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...src };

  out.schema_version = CONFIG_SCHEMA_VERSION;
  out.enabled = Boolean(src.enabled);
  out.sessions = src.sessions && typeof src.sessions === 'object' && !Array.isArray(src.sessions)
    ? Object.fromEntries(Object.entries(src.sessions).map(([k, v]) => [k, Boolean(v)]))
    : {};

  const port = Number(src.brokerPort);
  out.brokerPort = Number.isInteger(port) && port > 0 && port < 65536 ? port : base.brokerPort;

  out.workspaceRoot = typeof src.workspaceRoot === 'string' && src.workspaceRoot.trim()
    ? src.workspaceRoot.trim()
    : base.workspaceRoot;

  out.role_binding_mode = ROLE_BINDING_MODES.includes(src.role_binding_mode)
    ? src.role_binding_mode
    : base.role_binding_mode;

  const roles = src.roles && typeof src.roles === 'object' ? src.roles : {};
  out.roles = {};
  for (const role of ROLE_NAMES) {
    const given = roles[role] && typeof roles[role] === 'object' ? roles[role] : {};
    const fallback = base.roles[role];
    out.roles[role] = {
      carrier: CARRIERS.includes(given.carrier) ? given.carrier : fallback.carrier,
      model: typeof given.model === 'string' && given.model.trim() ? given.model.trim() : null,
      actor_id: typeof given.actor_id === 'string' && given.actor_id.trim() ? given.actor_id.trim() : null,
    };
  }
  // Executor 载体固定当前会话（§6.1 表格：不可换）。
  out.roles.executor.carrier = 'session';

  out.reviewer_mode = REVIEWER_MODES.includes(src.reviewer_mode) ? src.reviewer_mode : base.reviewer_mode;

  const limit = Number(src.rejection_limit);
  out.rejection_limit = Number.isInteger(limit)
    ? Math.min(MAX_REJECTION_LIMIT, Math.max(MIN_REJECTION_LIMIT, limit))
    : base.rejection_limit;

  out.estimate_subagents = Boolean(src.estimate_subagents);
  out.updatedAt = Number(src.updatedAt) || 0;
  return out;
}

/** 写归一化后的配置。 */
export function writeConfigFile(dataDir, config, { now = Date.now() } = {}) {
  const next = normalizeConfig(config, { now, dataDir });
  next.updatedAt = Number(now) || Date.now();
  writeFileAtomic(configPath(dataDir), JSON.stringify(next, null, 2) + '\n');
  return next;
}

/** 是否需要迁移：文件不存在，或 schema_version 不是 2。 */
export function needsMigration(raw) {
  return !raw || raw.schema_version !== CONFIG_SCHEMA_VERSION;
}

function stampDate(now) {
  const d = new Date(Number(now) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * 迁移闸（§9.5）：读到 schema_version !== 2 时执行一次。
 * 先冷备份 state.json / records.json / history.jsonl 到 archive-YYYYMMDD/，再写回 v2。
 * 不迁存量 records（§9.4）：备份保留，运行时清空由调用方决定。
 * @returns {{ migrated: boolean, created: boolean, config: object, backupPath: string|null }}
 *   created 表示磁盘上原本没有配置文件（首次初始化），此时没有可备份的旧文件。
 */
export function migrateConfigIfNeeded({ dataDir, now = Date.now() } = {}) {
  const raw = readConfigFile(dataDir);
  if (!needsMigration(raw)) {
    return { migrated: false, created: false, config: normalizeConfig(raw, { now, dataDir }), backupPath: null };
  }
  let backupPath = null;
  if (raw) {
    backupPath = path.join(dataDir, `archive-${stampDate(now)}`);
    try {
      fs.mkdirSync(backupPath, { recursive: true });
      for (const name of [STATE_FILE_NAME, RECORDS_FILE_NAME, HISTORY_FILE_NAME]) {
        const src = path.join(dataDir, name);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupPath, name));
      }
    } catch {
      // 备份失败不阻断迁移：配置正确性优先，备份是尽力而为。
    }
  }
  const config = writeConfigFile(dataDir, normalizeConfig(raw, { now, dataDir }), { now });
  return { migrated: true, created: !raw, config, backupPath };
}

/**
 * 推导本次开机的 boot-id（6 位十六进制）。
 * 用「当前时刻 - 开机时长」得到开机时刻，取整到分钟再哈希：
 * 同一开机的所有进程算出同一个值，重启后必然变化，无需平台 API。
 */
export function resolveBootId({ now = Date.now(), uptime = os.uptime(), salt = '' } = {}) {
  const bootMs = Number(now) - Number(uptime) * 1000;
  const minute = Math.round(bootMs / 60000);
  return crypto.createHash('sha256').update(`${minute}|${salt}`).digest('hex').slice(0, 6);
}

/** 展开 ~ 并归一成绝对路径。 */
export function expandHome(input, { home = os.homedir() } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  if (raw === '~') return home;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(home, raw.slice(2));
  return path.resolve(raw);
}

/**
 * 配置里的 workspaceRoot → 绝对路径。
 * 配置没写时优先落在 dataDir/workspace，最后才回退到 home 默认值。
 */
export function resolveWorkspaceRoot(config, opts = {}) {
  const declared = config?.workspaceRoot;
  if (typeof declared === 'string' && declared.trim()) return expandHome(declared, opts);
  const dataDir = opts.dataDir;
  if (typeof dataDir === 'string' && dataDir.trim()) return path.join(dataDir, 'workspace');
  return expandHome(defaultConfig().workspaceRoot, opts);
}

/** 端口优先级：env DSH_AGY_COLLAB_PORT > 配置 brokerPort > 18765（§10.6）。 */
export function resolveBrokerPort(config, env = process.env) {
  const fromEnv = Number(env?.DSH_AGY_COLLAB_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  const fromConfig = Number(config?.brokerPort);
  if (Number.isInteger(fromConfig) && fromConfig > 0 && fromConfig < 65536) return fromConfig;
  return DEFAULT_BROKER_PORT;
}

/**
 * 按会话判断协作是否开启：该会话有显式覆盖就用它，否则回退全局默认。
 * 与 v1 的 isCollabEnabled 语义一致，只是改成纯函数（配置对象由调用方持有）。
 */
export function isCollabEnabled(config, sessionId) {
  const sid = String(sessionId ?? '').trim();
  const sessions = config?.sessions ?? {};
  if (sid && Object.prototype.hasOwnProperty.call(sessions, sid)) return Boolean(sessions[sid]);
  return Boolean(config?.enabled);
}

/**
 * 改某个会话的开关。
 * 修掉 v1 的缺陷（lib/index.js:98-100 把 enabled 写进所有 session）：
 * 只动这一个会话的键，其他会话原样保留。
 */
export function setCollabEnabled(config, sessionId, enabled, { now = Date.now() } = {}) {
  const next = normalizeConfig(config, { now });
  const sid = String(sessionId ?? '').trim();
  const value = typeof enabled === 'boolean' ? enabled : !isCollabEnabled(next, sid);
  if (sid) next.sessions[sid] = value;
  else next.enabled = value;
  next.updatedAt = Number(now) || Date.now();
  return next;
}

/** 改全局默认开关（新会话没有显式覆盖时用它）。 */
export function setGlobalEnabled(config, enabled, { now = Date.now() } = {}) {
  const next = normalizeConfig(config, { now });
  next.enabled = Boolean(enabled);
  next.updatedAt = Number(now) || Date.now();
  return next;
}

/**
 * 改角色绑定。只允许改 carrier / model / actor_id 三个字段。
 * @throws 角色名或载体非法时抛错（配置错误应当立即暴露，不静默忽略）。
 */
export function setRoleBinding(config, role, patch, { now = Date.now() } = {}) {
  if (!ROLE_NAMES.includes(role)) throw new Error(`unknown role "${role}"`);
  const next = normalizeConfig(config, { now });
  const target = { ...next.roles[role] };
  if (patch?.carrier !== undefined) {
    if (!CARRIERS.includes(patch.carrier)) throw new Error(`unknown carrier "${patch.carrier}"`);
    target.carrier = patch.carrier;
  }
  if (patch?.model !== undefined) target.model = patch.model ? String(patch.model).trim() : null;
  if (patch?.actor_id !== undefined) target.actor_id = patch.actor_id ? String(patch.actor_id).trim() : null;
  next.roles[role] = target;
  // Executor 载体固定当前会话，任何写入都归位（§6.1）。
  next.roles.executor.carrier = 'session';
  next.updatedAt = Number(now) || Date.now();
  return next;
}

/** 改绑定模式。 */
export function setRoleBindingMode(config, mode, { now = Date.now() } = {}) {
  if (!ROLE_BINDING_MODES.includes(mode)) throw new Error(`unknown role_binding_mode "${mode}"`);
  const next = normalizeConfig(config, { now });
  next.role_binding_mode = mode;
  next.updatedAt = Number(now) || Date.now();
  return next;
}

/**
 * 驳回上限只在 drafting 阶段可改（§14 硬前提 3）。
 * @returns {{ ok: boolean, config?: object, error?: string }}
 */
export function setRejectionLimit(config, limit, { stage, now = Date.now() } = {}) {
  if (stage !== undefined && stage !== 'drafting') {
    return { ok: false, error: `驳回上限只能在 drafting 阶段修改，当前阶段是 ${stage}` };
  }
  const n = Number(limit);
  if (!Number.isInteger(n) || n < MIN_REJECTION_LIMIT || n > MAX_REJECTION_LIMIT) {
    return { ok: false, error: `驳回上限必须是 ${MIN_REJECTION_LIMIT}-${MAX_REJECTION_LIMIT} 的整数，收到 ${limit}` };
  }
  const next = normalizeConfig(config, { now });
  next.rejection_limit = n;
  next.updatedAt = Number(now) || Date.now();
  return { ok: true, config: next };
}

/** 改审核档位（strict | loose）。 */
export function setReviewerMode(config, mode, { now = Date.now() } = {}) {
  if (!REVIEWER_MODES.includes(mode)) throw new Error(`unknown reviewer_mode "${mode}"`);
  const next = normalizeConfig(config, { now });
  next.reviewer_mode = mode;
  next.updatedAt = Number(now) || Date.now();
  return next;
}

/** 预估子 agent 数量开关（Planner 是否要在 plan.steps[].subagent_count 里给数）。 */
export function setEstimateSubagents(config, enabled, { now = Date.now() } = {}) {
  const next = normalizeConfig(config, { now });
  next.estimate_subagents = Boolean(enabled);
  next.updatedAt = Number(now) || Date.now();
  return next;
}

/** 改临时工作台根路径。空串回落到默认（dataDir/workspace）。 */
export function setWorkspaceRoot(config, workspaceRoot, { now = Date.now(), dataDir = null } = {}) {
  const next = normalizeConfig(config, { now });
  const raw = typeof workspaceRoot === 'string' ? workspaceRoot.trim() : '';
  if (!raw) {
    next.workspaceRoot = dataDir
      ? path.join(dataDir, 'workspace')
      : path.join(os.homedir(), '.dsh', 'agy-collab', 'workspace');
  } else {
    if (/[\0]/.test(raw)) throw new Error('workspaceRoot 不能包含空字符');
    next.workspaceRoot = raw;
  }
  next.updatedAt = Number(now) || Date.now();
  return next;
}

/** 改总线端口（§10.6：env 仍然优先于配置）。 */
export function setBrokerPort(config, port, { now = Date.now() } = {}) {
  const n = Number(port);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`brokerPort 必须是 1-65535 的整数，收到 ${port}`);
  }
  const next = normalizeConfig(config, { now });
  next.brokerPort = n;
  next.updatedAt = Number(now) || Date.now();
  return next;
}

/**
 * 校验角色绑定是否自洽。
 * triple 模式：同一 actor 出现在两槽 → 拒启（§7.1）。
 * dual 模式：允许 Planner 与 Reviewer 同一 actor；Executor 仍是当前会话，不参与比对。
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateRoleBindings(config) {
  const errors = [];
  const roles = config?.roles ?? {};
  const mode = config?.role_binding_mode ?? 'triple';

  for (const role of ROLE_NAMES) {
    const carrier = roles[role]?.carrier;
    if (!CARRIERS.includes(carrier)) errors.push(`角色 ${role} 的载体 "${carrier}" 非法`);
  }
  if (roles.executor?.carrier !== 'session') {
    errors.push('Executor 的载体必须是 session（当前 DSH 会话），不可更换');
  }
  if (mode === 'triple') {
    const seen = new Map();
    for (const role of ['planner', 'reviewer']) {
      const actor = roles[role]?.actor_id;
      if (!actor) continue;
      if (seen.has(actor)) {
        errors.push(`triple 模式下 actor "${actor}" 同时出现在 ${seen.get(actor)} 与 ${role} 两槽`);
      } else {
        seen.set(actor, role);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 哪些角色绑到了进程外（只有这些才需要 broker，§10.1）。 */
export function externalRoles(config) {
  const roles = config?.roles ?? {};
  return ROLE_NAMES.filter((role) => roles[role]?.carrier === 'external');
}
