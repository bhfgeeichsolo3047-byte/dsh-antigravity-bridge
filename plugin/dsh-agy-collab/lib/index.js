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

export const name = 'dsh-agy-collab';
export const inject = ['tools', 'systemPrompt'];

const BROKER_HOST = process.env.DSH_AGY_COLLAB_HOST || '127.0.0.1';
const BROKER_PORT = Number(process.env.DSH_AGY_COLLAB_PORT || 18765);
const DATA_DIR = path.join(os.homedir(), '.dsh', 'agy-collab');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const BROKER_SCRIPT = path.join(DATA_DIR, 'broker.mjs');
const ROUTE_PREFIX = '/api/agy-collab';
const TOOL_NAME = 'agy_collab_relay';
const PROMPT_SECTION_NAME = 'xsdshpg-agy-collab';
const TOOL_TIMEOUT_MS = 540_000;

function readLocalState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      enabled: Boolean(raw.enabled),
      sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
      updatedAt: Number(raw.updatedAt) || 0,
    };
  } catch {
    return { enabled: false, sessions: {}, updatedAt: 0 };
  }
}

function writeLocalState(nextState) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(nextState, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, STATE_FILE);
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

function isCollabEnabled(sessionId) {
  const st = readLocalState();
  if (sessionId && Object.prototype.hasOwnProperty.call(st.sessions, sessionId)) {
    return Boolean(st.sessions[sessionId]);
  }
  return Boolean(st.enabled);
}

function setCollabEnabled(sessionId, enabled) {
  const st = readLocalState();
  const next = typeof enabled === 'boolean' ? enabled : !isCollabEnabled(sessionId);
  st.enabled = next;
  if (sessionId) {
    st.sessions[sessionId] = next;
  }
  for (const k of Object.keys(st.sessions)) {
    st.sessions[k] = next;
  }
  st.updatedAt = Date.now();
  writeLocalState(st);
  return next;
}

function ensureBrokerProcess() {
  return new Promise((resolve) => {
    const req = http.get(`http://${BROKER_HOST}:${BROKER_PORT}/health`, { timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => {
      try {
        if (fs.existsSync(BROKER_SCRIPT)) {
          const child = spawn(process.execPath, [BROKER_SCRIPT], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          child.unref();
        }
      } catch {
        // ignore
      }
      setTimeout(() => resolve(true), 400);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function callBroker(method, endpoint, payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const bodyStr = payload ? JSON.stringify(payload) : '';
    const req = http.request(
      {
        hostname: BROKER_HOST,
        port: BROKER_PORT,
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
 *   4. v2 已启用（DSH_AGY_COLLAB_V2=1）—— v2 是进程内工作台闭环，不需要外部
 *      agy_collab_relay 的三铁律。不排除的话，v2 会话会被注入一段要求它去调
 *      v1 relay 的提示词，模型会真的去调一个当前流程里不存在的工具。
 *      未设这个变量时本函数行为与 v1 完全一致。
 */
export function shouldInjectCollabPrompt(context, deps = {}) {
  const actorCheck = deps.actorCheck ?? isActorSession;
  const enabledCheck = deps.enabledCheck ?? isCollabEnabled;
  const env = deps.env ?? process.env;
  if (String(env?.DSH_AGY_COLLAB_V2 ?? '') === '1') return false;
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
                await ensureBrokerProcess();
                const brokerStatus = await callBroker('GET', `/state?sessionId=${encodeURIComponent(sessionId)}`, null, 1200);
                const enabled = isCollabEnabled(sessionId);
                const records = Array.isArray(brokerStatus?.records) ? brokerStatus.records : readLocalRecords();
                send(200, {
                  ok: true,
                  enabled,
                  globalEnabled: readLocalState().enabled,
                  brokerOnline: Boolean(brokerStatus?.brokerOnline),
                  aListening: Boolean(brokerStatus?.aListening),
                  pendingCount: Number(brokerStatus?.pendingCount || 0),
                  records,
                });
                return;
              }

              if (sub === '/state' && req.method === 'POST') {
                const chunks = [];
                for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
                const sid = typeof body.sessionId === 'string' ? body.sessionId.trim() : sessionId;
                const nextEnabled = setCollabEnabled(sid, typeof body.enabled === 'boolean' ? body.enabled : undefined);
                await ensureBrokerProcess();
                const brokerRes = await callBroker('POST', '/state', { sessionId: sid, enabled: nextEnabled }, 1500);
                const records = Array.isArray(brokerRes?.records) ? brokerRes.records : readLocalRecords();
                send(200, {
                  ok: true,
                  enabled: nextEnabled,
                  globalEnabled: nextEnabled,
                  brokerOnline: Boolean(brokerRes?.brokerOnline ?? true),
                  aListening: Boolean(brokerRes?.aListening),
                  records,
                });
                return;
              }

              if (sub === '/records' && (req.method === 'GET' || req.method === 'HEAD')) {
                await ensureBrokerProcess();
                const brokerRecs = await callBroker('GET', '/records', null, 1200);
                const records = Array.isArray(brokerRecs?.records) ? brokerRecs.records : readLocalRecords();
                send(200, {
                  ok: true,
                  records,
                });
                return;
              }

              if (sub === '/clear' && req.method === 'POST') {
                await ensureBrokerProcess();
                clearLocalRecords();
                const brokerClear = await callBroker('POST', '/records/clear', {}, 1500);
                send(200, {
                  ok: true,
                  records: Array.isArray(brokerClear?.records) ? brokerClear.records : [],
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
  try {
    // Ensure background broker is running silently
    ensureBrokerProcess().catch(() => {});

    // 1. Register conditional systemPrompt section
    disposers.push(registerPromptSection(ctx));

    // 2. Register collaboration relay tool
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
          const errMsg = res?.error || '无法连接到本地 A↔D 协作消息总线 (127.0.0.1:18765)。';
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

    try {
      const d = ctx.tools.register(toolDef);
      if (typeof d === 'function') disposers.push(d);
    } catch (e) {
      if (!/already registered/i.test(String(e?.message || e))) throw e;
    }

    // 3. Install same-origin web routes for the dialog toggle button
    installWebRoutes(ctx);

    // 4. v2 装配（三角色 + 六目录临时工作台）。
    //    只有显式设置 DSH_AGY_COLLAB_V2=1 时才挂载；不设时插件行为与 v1 完全一致，
    //    不迁移配置、不动 records.json、不碰 broker。
    if (String(process.env.DSH_AGY_COLLAB_V2 || '') === '1') {
      try {
        const { mountV2 } = await import('./v2/index.js');
        const dispose = await mountV2(ctx, {
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
