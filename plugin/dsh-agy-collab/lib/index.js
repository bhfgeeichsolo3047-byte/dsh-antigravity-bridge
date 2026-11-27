/**
 * dsh-agy-collab — DeepSeek Harness (D) <-> Antigravity (A) 后台静默协作插件（Host 端）
 *
 * 设计原则与边界约束：
 *   1. 严格按开关隔离：仅当用户在 D 对话框点击开启「A↔D 协作」按钮时，才向当前会话注入协作协议与启用后台转达。
 *      当按钮处于关闭状态时，systemPrompt 段落返回空字符串 ""，不占 token、不改写人设、不影响任何其他插件或功能。
 *   2. 职责分工：
 *      - 阶段一 (phase="plan")：D 收到用户任务后，先通过本地网络 (127.0.0.1:18765) 静默转达给 A，
 *        A 只负责开局整体任务规划并向 D 提交任务方案。
 *      - 阶段二 (D 执行)：D 按照 A 的规划方案执行具体任务。
 *      - 阶段三 (phase="review")：D 将任务执行结果返回给 A，A 审核可行性及是否需要修改，
 *        明确告知 D 是可以直接使用 (APPROVED) 还是需要修改哪些地方 (CHANGES_REQUESTED)。
 *   3. 兼容 Xsdsh-purge 与原生 DSH：提示词段名采用 `xsdshpg-agy-collab`，既符合原生 DSH 的
 *      systemPrompt.section 规范，又在 Xsdsh-purge 白名单内不会被清洗滤除，且绝不触碰其他插件的段名。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { isActorSession } from './actor-sessions.js';
// broker 的端口归属判定与 pid 归属记录都收敛在 broker-client.js（规格 §10.2 / §10.4），
// 这里只消费它的结论，不再自己 probe / spawn。
import {
  BROKER_STATE,
  DEFAULT_BROKER_PORT,
  ensureBroker,
  foreignPortMessage,
} from './broker-client.js';
// 端口优先级与「哪些角色在进程外」的唯一实现都在 v2/config.js，这里复用而不是再写一份。
import { externalRoles, readConfigFile, resolveBrokerPort } from './v2/config.js';
// v2 的开关判据是全局唯一来源：v1 入口只消费它，不自己写字符串比较。
// v2/index.js 不反向 import 本文件，静态引入无循环依赖。
import { isV2Enabled } from './v2/index.js';

export const name = 'dsh-agy-collab';
export const inject = ['tools', 'systemPrompt'];

const BROKER_HOST = process.env.DSH_AGY_COLLAB_HOST || '127.0.0.1';
const DATA_DIR = path.join(os.homedir(), '.dsh', 'agy-collab');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const BROKER_SCRIPT = path.join(DATA_DIR, 'broker.mjs');
const ROUTE_PREFIX = '/api/agy-collab';
const TOOL_NAME = 'agy_collab_relay';
const PROMPT_SECTION_NAME = 'xsdshpg-agy-collab';
const TOOL_TIMEOUT_MS = 540_000;

/**
 * 数据目录解析：显式参数 > env DSH_AGY_COLLAB_DATA_DIR > ~/.dsh/agy-collab。
 * v2 的 state.json 就在这个目录里，所以读写 state.json 必须认同一套优先级，
 * 否则测试或逃生口场景会写到用户真实目录上去。
 */
function resolveDataDir(opts = {}) {
  const explicit = opts?.dataDir;
  if (explicit) return path.resolve(explicit);
  const fromEnv = process.env.DSH_AGY_COLLAB_DATA_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  return DATA_DIR;
}

function stateFileOf(dataDir) {
  return path.join(dataDir, 'state.json');
}

/** 读盘上的完整原始对象（含 v2 的 schema_version / roles / workspaceRoot 等键）。 */
function readRawLocalState(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFileOf(dataDir), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  } catch {
    // ignore
  }
  return {};
}

/**
 * 读 state.json。**保留所有未知键**（v2 字段一律原样带出），只把三个 v1 键归一化。
 * 只返回三个键会把 v2 配置读丢，进而被下一次写盘整文件抹掉——这是 v2 默认开启后
 * 最危险的一条路径，故此处与 writeLocalState 一起改。
 */
export function readLocalState(opts = {}) {
  const raw = readRawLocalState(resolveDataDir(opts));
  return {
    ...raw,
    enabled: Boolean(raw.enabled),
    sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

function writeLocalState(nextState, opts = {}) {
  const dataDir = resolveDataDir(opts);
  const file = stateFileOf(dataDir);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    // 写前重读盘上原文件做底再合并：绝不因为只改一个开关就把 v2 配置整文件覆盖掉。
    const merged = { ...readRawLocalState(dataDir), ...nextState };
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // ignore
  }
}

function readLocalRecords() {
  try {
    const raw = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.records)) return raw.records;
  } catch {
    // ignore
  }
  return [];
}

function clearLocalRecords() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${RECORDS_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, '[]\n', 'utf8');
    fs.renameSync(tmp, RECORDS_FILE);
  } catch {
    // ignore
  }
}

export function isCollabEnabled(sessionId, opts = {}) {
  const st = readLocalState(opts);
  if (sessionId && Object.prototype.hasOwnProperty.call(st.sessions, sessionId)) {
    return Boolean(st.sessions[sessionId]);
  }
  return Boolean(st.enabled);
}

/**
 * 翻转/设置协作开关。只写该会话自己的键（v1 曾经把所有 session 键写成同一个值，
 * 会让「本会话关掉」变成「全部会话关掉」），并在写盘时保留 v2 的全部配置字段。
 */
export function setCollabEnabled(sessionId, enabled, opts = {}) {
  const st = readLocalState(opts);
  const next = typeof enabled === 'boolean' ? enabled : !isCollabEnabled(sessionId, opts);
  st.enabled = next;
  if (sessionId) {
    st.sessions[sessionId] = next;
  }
  st.updatedAt = Date.now();
  writeLocalState(st, opts);
  return next;
}

/**
 * 当前该连哪个端口（§10.6）：env DSH_AGY_COLLAB_PORT > state.json 的 brokerPort > 18765。
 * 每次现算而不是模块加载时算一次 —— 用户在设置页改端口后无需重启 Host。
 */
function currentBrokerPort() {
  try {
    return resolveBrokerPort(readConfigFile(resolveDataDir()), process.env);
  } catch {
    return DEFAULT_BROKER_PORT;
  }
}

/**
 * broker 运行态缓存。只在同一进程内复用：
 *   state      最近一次 ensureBroker 的结局（attached / spawned / foreign / unreachable / missing_script）
 *   port       上一次判定用的端口
 *   message    异己占用或 spawn 失败时给用户看的文案
 *   checkedAt  上一次判定的时刻，用来做失败冷却，避免每次 /state 都去 spawn 一个起不来的进程
 */
const brokerRuntime = {
  state: null,
  port: null,
  message: null,
  pid: null,
  health: null,
  checkedAt: 0,
  inflight: null,
};

/** 失败后的冷却窗口：这段时间内不再重复 spawn，直接把上次的结论还回去。 */
const BROKER_RETRY_COOLDOWN_MS = 15_000;

/**
 * 端口归属四步判定（§10.2）在本进程内的唯一入口。
 *
 * 早先这里是「probe 失败就 spawn，然后 setTimeout(400) 直接 resolve(true)」——
 * 无论 broker 起没起来都报成功，UI 上永远显示在线。现在改成调用 broker-client 的
 * ensureBroker：spawn 之后必须真的探到自家 /health 签名才算成功。
 *
 * @returns {Promise<{ state: string, port: number, message: string|null, pid: number|null, health: object|null }>}
 */
function ensureBrokerProcess() {
  const now = Date.now();
  const retryable =
    brokerRuntime.state === null
    || brokerRuntime.state === BROKER_STATE.unreachable
    || brokerRuntime.state === BROKER_STATE.missing_script;
  if (retryable && brokerRuntime.state !== null && now - brokerRuntime.checkedAt < BROKER_RETRY_COOLDOWN_MS) {
    return Promise.resolve(brokerRuntime);
  }
  if (brokerRuntime.inflight) return brokerRuntime.inflight;

  const port = currentBrokerPort();
  brokerRuntime.inflight = ensureBroker({
    host: BROKER_HOST,
    port,
    scriptPath: BROKER_SCRIPT,
    dataDir: resolveDataDir(),
  })
    .then((result) => {
      brokerRuntime.state = result.state;
      brokerRuntime.port = Number(result.port) || port;
      brokerRuntime.message = result.message ?? null;
      brokerRuntime.pid = result.pid ?? null;
      brokerRuntime.health = result.health ?? null;
      brokerRuntime.checkedAt = Date.now();
      return brokerRuntime;
    })
    .catch((error) => {
      brokerRuntime.state = BROKER_STATE.unreachable;
      brokerRuntime.port = port;
      brokerRuntime.message = String(error?.message ?? error);
      brokerRuntime.checkedAt = Date.now();
      return brokerRuntime;
    })
    .finally(() => {
      brokerRuntime.inflight = null;
    });
  return brokerRuntime.inflight;
}

/** broker 是否可用（能承载 /state 与 /records 的读写）。 */
function isBrokerOnline() {
  return brokerRuntime.state === BROKER_STATE.attached || brokerRuntime.state === BROKER_STATE.spawned;
}

/**
 * broker 不可用时的统一文案：异己占用给「改端口/关掉占用它的程序」，
 * 其余情况说明是连不上而不是别人的进程。
 */
function brokerOfflineMessage() {
  if (brokerRuntime.state === BROKER_STATE.foreign) {
    return brokerRuntime.message || foreignPortMessage(brokerRuntime.port ?? currentBrokerPort());
  }
  if (brokerRuntime.message) return brokerRuntime.message;
  return `无法连接到本地 A↔D 协作消息总线 (127.0.0.1:${brokerRuntime.port ?? currentBrokerPort()})`;
}

function callBroker(method, endpoint, payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const bodyStr = payload ? JSON.stringify(payload) : '';
    const req = http.request(
      {
        hostname: BROKER_HOST,
        port: currentBrokerPort(),
        path: endpoint,
        method,
        headers: payload
          ? {
              'content-type': 'application/json; charset=utf-8',
              'content-length': Buffer.byteLength(bodyStr),
            }
          : {},
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/** Built-in fallback for defineTool so the plugin never fails if @deepseek-ai/dsh-tools is inside app.asar */
function defineToolCompat(options) {
  const compileProps = (map) => {
    const properties = {};
    const required = [];
    for (const [k, spec] of Object.entries(map || {})) {
      const { required: reqMark, ...rest } = spec || {};
      if (reqMark === true) required.push(k);
      properties[k] = rest;
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  };
  return {
    name: options.name,
    description: options.description,
    parameters: compileProps(options.parameters || {}),
    timeoutMs: options.timeoutMs || TOOL_TIMEOUT_MS,
    output: {
      schema: options.output?.schema || { type: 'object', properties: { text: { type: 'string' } } },
      render: options.output?.render || ((_args, val) => [{ type: 'text', text: String(val?.text ?? '') }]),
    },
    async execute(args, exec) {
      return options.execute(args, exec);
    },
  };
}

async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (typeof mod?.defineTool === 'function') return mod.defineTool;
  } catch {
    // fallback to compat
  }
  return defineToolCompat;
}

function sessionIdOfContext(context) {
  const session = context?.agent?.session || context?.session || null;
  return String(session?.header?.id ?? session?.id ?? '').trim();
}

function buildCollabPrompt() {
  return [
    '## 【A↔D 双智能体后台静默协作模式已开启（最高执行纪律）】',
    '当前用户已在对话框开启 **A↔D 协作开关**（你 = Agent D [DeepSeek Harness]，协助方 = Agent A [Antigravity]）。',
    '只要本开关处于开启状态，你在处理用户本轮及后续**所有任务**时，**必须严格遵守以下三项铁律**，通过内置工具 `agy_collab_relay` 在后台静默与 Agent A 通信协作：',
    '',
    '1. **铁律一：所有任务开局必须先规划，无任何豁免 (`phase: "plan"`)**',
    '   - 不仅仅是“编写或修改业务代码”，**无论任务类型是什么——包括只读验证、测试运行、代码审计、问题排查、信息调研、文档分析或方案设计等所有任务**——在开始正式执行任务前，你都**必须先整理好用户的完整需求、目标范围及必要上下文**，第一时间调用 `agy_collab_relay`（设置 `phase: "plan"`，传入整理后的 `task`、当前 `workspace` 路径及必要 `context`）发给 Agent A。',
    '   - **严禁**以“只做只读操作”、“只跑测试/验证”或“不改代码”为由跳过 `phase: "plan"` 擅自开始执行或直接跳到 `review`！必须等待 Agent A 完成规划并返回整体任务方案后，才可开始正式执行。',
    '',
    '2. **铁律二：执行过程中遇到疑问或不确定选择必须先协商 (`phase: "consult"`)**',
    '   - 按照 Agent A 提交的任务方案正式执行期间，一旦你遇到**任何疑问、需求或验收边界歧义、未预料到的报错/阻塞，或面临多个不确定的技术实现/参数/取舍选择**，**禁止擅自猜测或拍脑袋决定**。',
    '   - 你必须暂停该分支操作并调用 `agy_collab_relay`（设置 `phase: "consult"`，在 `task` 中写明当前遇到的核心疑问/抉择点，在 `context` 中附上当前进展、相关事实依据及各备选方案分析）提交给 Agent A 讨论确认。',
    '   - 等待双方交流确定（Agent A 返回 `CONSULT_ANSWERED`）后，再按确认后的方案继续执行任务；整个任务过程中可多次调用 `consult`。',
    '',
    '3. **铁律三：任务执行完毕必须提交结果由 A 审核 (`phase: "review"`)**',
    '   - 全部任务执行完毕后（含只读验证、分析调研或代码修改任务），**在向用户做最终完成汇报之前**，你必须再次调用 `agy_collab_relay`（设置 `phase: "review"`，在 `execution_report` 中详细填入执行过程、结论依据、修改文件清单及验证/测试输出）。',
    '   - Agent A 会审核可行性及是否需要修改：',
    '     - 若 Agent A 返回 `APPROVED`（可以直接使用该方案），你再向用户汇报最终成果；',
    '     - 若 Agent A 返回 `CHANGES_REQUESTED`（指出需要修改的地方），你必须按照 Agent A 的修改意见完成修正，并再次调用 `agy_collab_relay(phase: "review")` 提交审核，直至审核通过。',
  ].join('\n');
}

/**
 * 该会话要不要注入协作提示词（规格 §6.9 的判据集中在这里，便于离线测试）。
 *
 * 四条排除理由：
 *   1. 宿主自己起的子代理带 origin === 'subagent'，不重复触发主代理的开局转达；
 *   2. 插件自己 ctx.agents.create() 出来的角色没有那个标记
 *      （dsh-subagent/src/child-agent.ts:152），只能查插件自持的 actor 白名单；
 *   3. 会话开关是关的；
 *   4. v2 已启用（默认启用，只有显式 DSH_AGY_COLLAB_V2=0/false/off/no 才关）——
 *      v2 是进程内工作台闭环，不需要外部 agy_collab_relay 的三铁律。不排除的话，
 *      v2 会话会被注入一段要求它去调 v1 relay 的提示词，模型会真的去调一个当前
 *      流程里不存在的工具。判据统一走 v2 模块导出的 isV2Enabled()。
 */
export function shouldInjectCollabPrompt(context, deps = {}) {
  const actorCheck = deps.actorCheck ?? isActorSession;
  const enabledCheck = deps.enabledCheck ?? isCollabEnabled;
  const env = deps.env ?? process.env;
  if (isV2Enabled(env)) return false;
  const origin = context?.agent?.session?.header?.origin;
  if (origin === 'subagent') return false;
  const sid = sessionIdOfContext(context);
  if (actorCheck(sid)) return false;
  if (!enabledCheck(sid)) return false;
  return true;
}

function registerPromptSection(ctx) {
  const sectionSpec = {
    name: PROMPT_SECTION_NAME,
    order: 5200,
    interpolate: false,
    text: (context) => (shouldInjectCollabPrompt(context) ? buildCollabPrompt() : ''),
  };

  const hosts = [];
  try {
    if (ctx?.systemPrompt?.ctx) hosts.push(ctx.systemPrompt.ctx);
  } catch {
    // ignore
  }
  if (ctx && !hosts.includes(ctx)) hosts.push(ctx);

  const disposers = [];
  for (const host of hosts) {
    try {
      if (host?.systemPrompt?.section) {
        const d = host.systemPrompt.section(sectionSpec);
        if (typeof d === 'function') disposers.push(d);
      }
    } catch {
      // ignore duplicate registration on HMR
    }
  }
  return () => {
    for (const d of disposers) {
      try { d(); } catch { /* ignore */ }
    }
  };
}

function allowSameOrigin(req, res) {
  const site = String(req?.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site') {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'cross-site blocked' }));
    return false;
  }
  return true;
}

function installWebRoutes(ctx) {
  if (typeof ctx?.inject !== 'function') return;
  try {
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(() => {
        return scoped.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: async (req, res) => {
            if (!allowSameOrigin(req, res)) return;
            const send = (status, data) => {
              res.writeHead(status, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              });
              res.end(JSON.stringify(data));
            };

            try {
              const url = new URL(req.url || '/', 'http://127.0.0.1');
              const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/state';
              const sessionId = url.searchParams.get('sessionId') || '';

              if (sub === '/state' && (req.method === 'GET' || req.method === 'HEAD')) {
                const runtime = await ensureBrokerProcess();
                const brokerStatus = isBrokerOnline()
                  ? await callBroker('GET', `/state?sessionId=${encodeURIComponent(sessionId)}`, null, 1200)
                  : null;
                const enabled = isCollabEnabled(sessionId);
                const records = Array.isArray(brokerStatus?.records) ? brokerStatus.records : readLocalRecords();
                send(200, {
                  ok: true,
                  enabled,
                  globalEnabled: readLocalState().enabled,
                  brokerOnline: Boolean(brokerStatus?.brokerOnline) || isBrokerOnline(),
                  aListening: Boolean(brokerStatus?.aListening),
                  pendingCount: Number(brokerStatus?.pendingCount || 0),
                  records,
                  // 端口由 Host 侧现算并下发：客户端不再硬编码 18765（§10.6）。
                  brokerPort: Number(runtime?.port) || currentBrokerPort(),
                  brokerState: runtime?.state ?? null,
                  brokerMessage: isBrokerOnline() ? null : brokerOfflineMessage(),
                  brokerPid: runtime?.pid ?? null,
                });
                return;
              }

              if (sub === '/state' && req.method === 'POST') {
                const chunks = [];
                for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
                const sid = typeof body.sessionId === 'string' ? body.sessionId.trim() : sessionId;
                const nextEnabled = setCollabEnabled(sid, typeof body.enabled === 'boolean' ? body.enabled : undefined);
                const runtime = await ensureBrokerProcess();
                const brokerRes = isBrokerOnline()
                  ? await callBroker('POST', '/state', { sessionId: sid, enabled: nextEnabled }, 1500)
                  : null;
                const records = Array.isArray(brokerRes?.records) ? brokerRes.records : readLocalRecords();
                send(200, {
                  ok: true,
                  enabled: nextEnabled,
                  globalEnabled: nextEnabled,
                  brokerOnline: Boolean(brokerRes?.brokerOnline) || isBrokerOnline(),
                  aListening: Boolean(brokerRes?.aListening),
                  records,
                  brokerPort: Number(runtime?.port) || currentBrokerPort(),
                  brokerState: runtime?.state ?? null,
                  brokerMessage: isBrokerOnline() ? null : brokerOfflineMessage(),
                  brokerPid: runtime?.pid ?? null,
                });
                return;
              }

              if (sub === '/records' && (req.method === 'GET' || req.method === 'HEAD')) {
                await ensureBrokerProcess();
                const brokerRecs = isBrokerOnline() ? await callBroker('GET', '/records', null, 1200) : null;
                const records = Array.isArray(brokerRecs?.records) ? brokerRecs.records : readLocalRecords();
                send(200, {
                  ok: true,
                  records,
                  brokerPort: Number(brokerRuntime.port) || currentBrokerPort(),
                  brokerState: brokerRuntime.state ?? null,
                });
                return;
              }

              if (sub === '/clear' && req.method === 'POST') {
                await ensureBrokerProcess();
                clearLocalRecords();
                const brokerClear = isBrokerOnline()
                  ? await callBroker('POST', '/records/clear', {}, 1500)
                  : null;
                send(200, {
                  ok: true,
                  records: Array.isArray(brokerClear?.records) ? brokerClear.records : [],
                  brokerPort: Number(brokerRuntime.port) || currentBrokerPort(),
                  brokerState: brokerRuntime.state ?? null,
                });
                return;
              }

              send(404, { ok: false, error: `Unknown route: ${sub}` });
            } catch (err) {
              send(500, { ok: false, error: String(err?.message || err) });
            }
          },
        });
      }, 'dsh-agy-collab: web routes');
    });
  } catch {
    // ignore in headless mode
  }
}

export async function apply(ctx) {
  const disposers = [];
  // v2 默认开启；只有显式 DSH_AGY_COLLAB_V2=0/false/off/no 才退回 v1 双智能体模式。
  // 两种模式互斥：同一会话只挂一套协议，避免模型在 v2 流程里误调 v1 relay。
  const v2On = isV2Enabled(process.env);
  try {
    // broker 只在「有进程外角色」时才需要（§10.1）：进程内三角色闭环完全不经过它。
    // 但仍先探一次并缓存结论 —— 看板要显示总线四态（§12.4），且用户可能刚把某个角色
    // 改成 external。探活本身不发 spawn（ensureBroker 会先 probe），代价是 1s 内的一个
    // GET /health，比「什么都不问就显示离线」更诚实。
    ensureBrokerProcess().catch(() => {});

    // 1. Register conditional systemPrompt section
    disposers.push(registerPromptSection(ctx));

    // 2. Register collaboration relay tool（仅 v1 回退模式；v2 默认下不注册）
    const defineTool = await loadDefineTool();
    const toolDef = defineTool({
      name: TOOL_NAME,
      description:
        '与本地网络中的 Agent A (Antigravity) 进行后台静默协作通信（仅在用户开启 A↔D 协作开关时使用）。支持三个阶段：phase="plan"（所有任务在开始正式执行前必须调用：整理用户需求提交给 A 获取整体规划方案）；phase="consult"（任务执行途中遇到任何疑问或不确定选择时调用：与 A 协商确认后再继续执行）；phase="review"（任务执行完成后将执行结果提交给 A 审核可行性及是否需要修改）。',
      timeoutMs: TOOL_TIMEOUT_MS,
      parameters: {
        phase: {
          type: 'string',
          required: true,
          enum: ['plan', 'consult', 'review'],
          description:
            '协作阶段："plan" 为全类型任务开局前整理需求请求整体规划方案；"consult" 为执行途中遇疑问或不确定选择时向 A 协商确认；"review" 为提交执行结果请 A 审核可行性与修改意见。',
        },
        task: {
          type: 'string',
          required: true,
          description: '整理后的用户任务需求描述（在 phase="consult" 时可简要描述当前任务目标及遇到的核心疑问/抉择点）。',
        },
        workspace: {
          type: 'string',
          description: '当前任务所在的工作区目录路径（cwd）。',
        },
        context: {
          type: 'string',
          description:
            '补充背景信息、目录结构摘要；在 phase="consult" 时写明当前进展、具体疑问与备选方案；在 phase="review" 时附上此前 A 给出的规划与协商要点。',
        },
        execution_report: {
          type: 'string',
          description: '当 phase="review" 时必填：你完成任务后的具体执行结果、修改的文件列表、关键实现说明及验证/测试输出。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            phase: { type: 'string' },
            verdict: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      async execute(args, exec) {
        const sessionId = sessionIdOfContext(exec);
        if (!isCollabEnabled(sessionId)) {
          return {
            text: '当前对话框的「A↔D 协作」开关处于【关闭】状态，无需向 Agent A 后台转达，请直接按正常流程独立完成用户任务。',
            phase: String(args?.phase || 'plan'),
            verdict: 'DISABLED',
          };
        }

        const phase = args?.phase === 'review' ? 'review' : args?.phase === 'consult' ? 'consult' : 'plan';
        const task = String(args?.task || '').trim();
        const workspace = String(
          args?.workspace || exec?.agent?.session?.header?.cwd || process.cwd(),
        ).trim();
        const context = String(args?.context || '').trim();
        const executionReport = String(args?.execution_report || '').trim();

        await ensureBrokerProcess();
        const res = await callBroker(
          'POST',
          '/relay',
          {
            sessionId,
            phase,
            task,
            workspace,
            context,
            executionReport,
            timeoutMs: 480_000,
          },
          500_000,
        );

        if (!res || !res.ok) {
          const errMsg = res?.error || `${brokerOfflineMessage()}。`;
          return {
            text: `[A↔D 后台通信提示] ${errMsg}`,
            phase,
            verdict: 'ERROR',
          };
        }

        const verdict = String(
          res.verdict || (phase === 'plan' ? 'PLAN_READY' : phase === 'consult' ? 'CONSULT_ANSWERED' : 'APPROVED'),
        );
        const content = String(res.content || '').trim();

        if (phase === 'plan') {
          return {
            text: [
              '=== 来自 Agent A (Antigravity) 的开局任务规划方案 ===',
              content,
              '====================================================',
              '【下一步指令】：请严格按照上方 Agent A 提交的任务方案执行任务。执行途中若遇任何疑问或不确定选择，请调用 `agy_collab_relay(phase: "consult")` 与 A 协商确定；全部执行完成后，请务必再次调用 `agy_collab_relay`（设置 `phase: "review"` 并附上 `execution_report`）将执行结果交由 Agent A 审核！',
            ].join('\n\n'),
            phase: 'plan',
            verdict,
          };
        }

        if (phase === 'consult') {
          return {
            text: [
              `=== 来自 Agent A (Antigravity) 的途中协商与决策回复 [${verdict}] ===`,
              content,
              '====================================================',
              '【下一步指令】：请严格按照上方 Agent A 与你协商确定的决策方案继续执行任务。若后续执行中还有新的疑问可继续调用 `agy_collab_relay(phase: "consult")`；全部任务执行完成后，请调用 `agy_collab_relay(phase: "review")` 提交最终结果审核！',
            ].join('\n\n'),
            phase: 'consult',
            verdict,
          };
        }

        const approved = verdict.toUpperCase() === 'APPROVED';
        return {
          text: [
            `=== 来自 Agent A (Antigravity) 的最终结果审核结论 [${verdict}] ===`,
            content,
            '====================================================',
            approved
              ? '✅ 【审核通过】：Agent A 确认该方案和执行结果可以直接使用！你现在可以向用户做最终成果汇报。'
              : '⚠️ 【需要修改】：Agent A 指出了上述需要修改的地方。请立即按照上述审核意见修改完善，修改完成后再次调用 `agy_collab_relay(phase="review")` 提交给 Agent A 复核！',
          ].join('\n\n'),
          phase: 'review',
          verdict,
        };
      },
    });

    if (!v2On) {
      try {
        const d = ctx.tools.register(toolDef);
        if (typeof d === 'function') disposers.push(d);
      } catch (e) {
        if (!/already registered/i.test(String(e?.message || e))) throw e;
      }
    }

    // 3. Install same-origin web routes for the dialog toggle button
    installWebRoutes(ctx);

    // 4. v2 装配（三角色 + 六目录临时工作台）。默认路径。
    //    只有显式 DSH_AGY_COLLAB_V2=0/false/off/no 才跳过；跳过时插件行为退回 v1
    //    双智能体模式（注册 agy_collab_relay + 注入三铁律提示词）。
    if (v2On) {
      try {
        const { mountV2 } = await import('./v2/index.js');
        const dispose = await mountV2(ctx, {
          // §10.3：把「外部角色要用的总线能不能用」的判定交给 Host 侧，
          // 因为端口归属、pid 归属记录与 broker 运行态都只在这里。
          async checkExternalRoles({ roles = [] } = {}) {
            const runtime = await ensureBrokerProcess();
            if (isBrokerOnline()) return { ok: true, port: runtime?.port ?? null };
            return {
              ok: false,
              message: brokerOfflineMessage(),
              state: runtime?.state ?? null,
              roles,
            };
          },
          log: (msg) => {
            try {
              ctx?.logger?.info?.(msg);
            } catch {
              // ignore
            }
          },
        });
        if (typeof dispose === 'function') disposers.push(dispose);
      } catch (error) {
        try {
          ctx?.logger?.warn?.(`[dsh-agy-collab] v2 装配失败：${error?.message ?? error}`);
        } catch {
          // ignore
        }
      }
    }

    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        for (const d of disposers.splice(0).reverse()) {
          try { d?.(); } catch { /* ignore */ }
        }
      }, 'dsh-agy-collab: cleanup');
    }
  } catch (err) {
    try {
      ctx?.logger?.warn?.(`[dsh-agy-collab] init warning: ${err?.message || err}`);
    } catch {
      // ignore
    }
  }
  return () => {
    for (const d of disposers.splice(0).reverse()) {
      try { d?.(); } catch { /* ignore */ }
    }
  };
}

export default { name, inject, apply };
