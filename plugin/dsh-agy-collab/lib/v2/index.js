/**
 * dsh-agy-collab v2 — 装配层（唯一的宿主入口）
 *
 * 规格 §13 第 1–5 步的可跑最小闭环挂载点。
 *
 * 铁律：v2 三角色闭环是默认路径。只有显式把 DSH_AGY_COLLAB_V2 设成 0/false/off/no 时本文件
 * 才完全不装配，此时插件行为退回 v1（不迁移配置、不清 records、不注册 v2 工具）。
 *
 * 本文件只做四件事：
 *   1. 读配置（必要时迁移到 schema v2）
 *   2. 懒注入 agents + tools，建 orchestrator 并 boot
 *   3. 把 Host 侧工具（collab_start + Executor 三件）注册进当前会话
 *   4. 把 shutdown 挂到 ctx.effect 的清理链上（Host 退出即删自己那棵工作台树）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  migrateConfigIfNeeded,
  readConfigFile,
  resolveBootId,
  resolveBrokerPort,
} from './config.js';
import { createOrchestrator } from './orchestrator.js';
import { knownGlobalToolNames } from './roles.js';
import {
  TOOL_NAMES,
  TOOL_OUTPUT_SCHEMA,
  TOOL_SPECS,
  buildToolDefinitions,
  compileParameterSchemaSpec,
  createAbortHandler,
  createMarkBlockedHandler,
  createSubmitForReviewHandler,
  renderToolResult,
} from './tools.js';

/** v2 的开关变量名。默认开启，显式关掉才退回 v1。 */
export const V2_ENV_FLAG = 'DSH_AGY_COLLAB_V2';

/** 显式关闭 v2 的取值（忽略大小写与首尾空白）。其余取值——包括未设置——都算开启。 */
export const V2_DISABLE_VALUES = Object.freeze(['0', 'false', 'off', 'no']);

/** Host 侧启动任务的工具名（T1）。规格只定义了角色侧四个工具，T1 的触发点是这个。 */
export const START_TOOL_NAME = 'collab_start';

/**
 * v2 是否启用。默认 true；只有显式设成 0/false/off/no 才 false。
 * 这是全插件唯一的开关判据，v1 入口必须 import 本函数，不要自己写字符串比较。
 */
export function isV2Enabled(env = process.env) {
  const raw = env?.[V2_ENV_FLAG];
  if (raw === undefined || raw === null) return true;
  return !V2_DISABLE_VALUES.includes(String(raw).trim().toLowerCase());
}

/**
 * 动态拿宿主的 createUserMessage（dsh-llm/src/message.ts:246）。
 * 拿不到时返回 null，orchestrator 会退回最小兼容形状。
 */
async function loadCreateUserMessage() {
  try {
    const mod = await import('@deepseek-ai/dsh-llm/message');
    if (typeof mod?.createUserMessage === 'function') return mod.createUserMessage;
  } catch {
    // fall through
  }
  try {
    const mod = await import('@deepseek-ai/dsh-llm');
    if (typeof mod?.createUserMessage === 'function') return mod.createUserMessage;
  } catch {
    // fall through
  }
  return null;
}

/** 动态拿宿主的 defineTool；拿不到时返回 null，由调用方明确降级。 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (typeof mod?.defineTool === 'function') return mod.defineTool;
  } catch {
    // fall through
  }
  try {
    const mod = await import('@deepseek-ai/dsh-tools/schema');
    if (typeof mod?.defineTool === 'function') return mod.defineTool;
  } catch {
    // fall through
  }
  // 宿主不可用时的最小兼容层：把 ParameterSchemaSpec 编译回裸 JSON Schema，
  // 并补齐 output.schema / output.render（否则 ToolsService.register() 会拒掉）。
  return (spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: compileParameterSchemaSpec(spec.parameters),
    output: {
      schema: spec.output?.schema ?? TOOL_OUTPUT_SCHEMA,
      // 兜底渲染必须与 buildToolDefinitions 用同一个渲染器：早先这里只吐 message，
      // 宿主没装 @deepseek-ai/dsh-tools 时 data（instruction / task_root）会被整个丢掉。
      render: spec.output?.render
        ?? ((_args, value) => [{ type: 'text', text: renderToolResult(value) }]),
    },
    execute: spec.execute,
  });
}

const START_TOOL_SPEC = Object.freeze({
  name: START_TOOL_NAME,
  description:
    '开一个新的三角色协作任务（规划者 → 执行者 → 审核者）。调用后 Host 会建临时工作台、写 01 原始需求，并把 Planner 冷启动去写 02 执行方案与 03 任务清单。',
  parameters: {
    type: 'object',
    properties: {
      request: { type: 'string', description: '用户的原始需求原话（必填，会原样写进 01/request.md）' },
      purpose: { type: 'string', description: '这次要达到什么目的（可选，写进 01/request.md 的「目的」段）' },
      task_id: { type: 'string', description: '自定义任务 id（可选，缺省自动生成 t-YYYY-MMDD-NN）' },
    },
    required: ['request'],
  },
});

/**
 * 装配 v2。返回 dispose 函数；v2 未开启时返回 null（调用方无需区分）。
 *
 * @param {object} ctx 宿主插件上下文
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @param {string} [opts.dataDir]
 * @param {function} [opts.log]
 */
export async function mountV2(ctx, opts = {}) {
  const env = opts.env ?? process.env;
  if (!isV2Enabled(env)) return null;

  // 数据目录优先级：显式参数 > env DSH_AGY_COLLAB_DATA_DIR > ~/.dsh/agy-collab。
  // 冒烟与测试必须走前两条，否则会就地迁移用户真实的 state.json。
  const dataDir = opts.dataDir
    ?? (env.DSH_AGY_COLLAB_DATA_DIR ? path.resolve(env.DSH_AGY_COLLAB_DATA_DIR) : null)
    ?? path.join(os.homedir(), '.dsh', 'agy-collab');
  const log = opts.log ?? ((msg) => {
    try {
      ctx?.logger?.info?.(msg);
    } catch {
      // ignore
    }
  });

  fs.mkdirSync(dataDir, { recursive: true });
  const { config, migrated, created, backupPath } = migrateConfigIfNeeded({ dataDir });
  if (created) log(`[v2] 首次初始化 schema v2 配置：${path.join(dataDir, 'state.json')}`);
  else if (migrated) log(`[v2] 配置已迁移到 schema v2，旧文件备份在 ${backupPath}`);
  const brokerPort = resolveBrokerPort(config, env);
  log(`[v2] 装配开始 dataDir=${dataDir} brokerPort=${brokerPort}`);

  const defineTool = await loadDefineTool();
  const createUserMessage = await loadCreateUserMessage();
  const disposers = [];
  // 一个会话一个编排器：多会话并发时各自的 state.task 不能互相覆盖（A 审核第 2 条）。
  const orchestrators = new Map();
  let hostTreeRemoved = false;

  const disposeAll = () => {
    for (const d of disposers.splice(0).reverse()) {
      try {
        d?.();
      } catch {
        // ignore
      }
    }
    // 工作台树是整棵按 pid+bootId 删的，只需要删一次；重复删会打出误导性的 removed=false。
    if (!hostTreeRemoved && orchestrators.size > 0) {
      hostTreeRemoved = true;
      for (const orch of orchestrators.values()) {
        try {
          orch.shutdown();
          break;
        } catch {
          // ignore
        }
      }
    }
    // 编排器里只留纯数据；会话路由是每次调用现算的局部变量，没有需要额外清空的缓存。
    orchestrators.clear();
  };

  // agents 必须懒注入：写进顶层 inject 会让插件在没装 agent 的 profile 里起不来。
  const mountInto = (scoped) => {
    const agents = scoped?.agents ?? null;
    const toolsService = scoped?.tools ?? null;
    const knownGlobalTools = toolsService ? knownGlobalToolNames(toolsService) : [];
    let booted = false;

    /**
     * 取（或懒建）某个会话的编排器：一个会话一个实例，state.task 不互相覆盖。
     *
     * 编排器**不持有 exec**：会话路由由每个工具调用处现算成纯数据值对象传进去。
     * 早先这里存过一个 exec 引用表（orchestratorExec），既让 agent/session 跟着编排器
     * 活到进程结束（泄漏），又把「这一次调用用的是哪条路由」变成隐式时序。
     */
    const orchestratorFor = (sessionId) => {
      const key = String(sessionId ?? '').trim();
      if (!key) return null;
      let orch = orchestrators.get(key);
      if (orch) return orch;
      orch = createOrchestrator({
        dataDir,
        config,
        agents,
        defineTool,
        createUserMessage,
        // 动态读取：插件挂载时 dsh-tool-fs / dsh-tool-bash 可能还没注册（A 审核第二轮阻塞 ②）。
        getKnownGlobalTools: () => knownGlobalToolNames(scoped?.tools),
        knownGlobalTools,
        log,
      });
      if (!booted) {
        orch.boot();
        booted = true;
      }
      orchestrators.set(key, orch);
      return orch;
    };

    /**
     * 4 个 Host 工具共用的会话 id 解析：显式参数 > exec 里的会话 > 当前 scope 的会话。
     * 分散写会让某个工具漏掉一路来源，导致「找不到工作台」。
     */
    const resolveSessionId = (args, exec) => {
      const explicit = String(args?.session_id ?? '').trim();
      if (explicit) return explicit;
      return String(sessionIdOf(exec) || sessionIdOf(scoped) || '').trim();
    };

    const sessionCwd = (exec) => {
      try {
        return exec?.agent?.session?.header?.cwd ?? scoped?.agent?.session?.header?.cwd ?? null;
      } catch {
        return null;
      }
    };

    /**
     * 当前会话正在用的 provider/model —— 进程内角色实例必须显式带上它。
     *
     * 宿主 agents.create() 不会替我们继承父会话路由（只有 dsh-subagent 的
     * child-agent.ts:98 会），不给就会在 preStep 抛 "has no provider/model"。
     * 三路来源按可靠性排序：Executor agent 的活选择 > 会话最近一次请求头 > scope 上的 agent。
     */
    const resolveSessionRoute = (exec) => {
      const pick = (selection) => {
        if (!selection || typeof selection !== 'object') return null;
        const provider = String(selection.provider ?? '').trim();
        const model = String(selection.model ?? '').trim();
        if (!provider || !model) return null;
        const out = { provider, model };
        const effort = String(selection.reasoningEffort ?? '').trim();
        if (effort) out.reasoningEffort = effort;
        return out;
      };
      const sources = [
        () => exec?.agent?.model?.current?.(),
        () => exec?.agent?.session?.requestHeader?.()?.config,
        () => scoped?.agent?.model?.current?.(),
        () => scoped?.agent?.session?.requestHeader?.()?.config,
      ];
      for (const read of sources) {
        try {
          const route = pick(read());
          if (route) return route;
        } catch {
          // 读不到就换下一路，不要因为一个来源抛错就整体失败
        }
      }
      return null;
    };

    // Host 侧工具：启动任务 + Executor 三件。角色侧工具在各自的 setup 里注册。
    const hostHandlers = {
      [START_TOOL_NAME]: async (args = {}, exec = null) => {
        const sessionId = resolveSessionId(args, exec);
        const orch = orchestratorFor(sessionId);
        if (!orch) return { ok: false, message: '拿不到会话 id，无法定位工作台' };
        // 路由在调用处现算成纯对象：编排器不持有 exec，也不缓存路由。
        const route = resolveSessionRoute(exec);
        try {
          const started = orch.startTask({
            sessionId,
            requestText: String(args.request ?? ''),
            purpose: String(args.purpose ?? ''),
            taskId: args.task_id,
            repoCwd: sessionCwd(exec),
          });
          const drafting = await orch.runDrafting({ route });
          if (!drafting.ok) {
            return {
              ok: false,
              message: `任务 ${started.taskId} 已建，但规划未通过：${drafting.error}`,
              data: { task_id: started.taskId, task_root: started.paths.taskRoot, state: orch.getTask()?.state },
            };
          }
          // 规划通过后必须推进到 running（T4），否则 Executor 拿着 ready 的任务无处提交。
          const round = orch.startRound();
          if (!round.ok) {
            return {
              ok: false,
              message: `规划通过但推进到 running 失败：${round.error}`,
              data: { task_id: started.taskId, task_root: started.paths.taskRoot, state: orch.getTask()?.state },
            };
          }
          const requirementIds = drafting.requirementIds ?? [];
          return {
            ok: true,
            message: [
              `任务 ${started.taskId} 已进入 running，03 任务清单共 ${requirementIds.length} 条需求；按 02 执行方案的步骤改仓库，改完调 collab_submit_for_review。`,
              // 双保险：v2 会话不该再去调 v1 的 agy_collab_relay（v2 下那个工具根本不注册、
              // v1 提示词也不注入，但模型可能从历史上下文里想起旧协议，这里明说一句把它掐掉）。
              '本任务走 v2 进程内工作台闭环，无需调用外部 agy_collab_relay。',
            ].join('\n'),
            data: {
              task_id: started.taskId,
              task_root: started.paths.taskRoot,
              state: orch.getTask()?.state,
              plan_path: path.join(started.paths.dirs.plan, 'plan.md'),
              tasks_path: path.join(started.paths.dirs.tasks, 'tasks.md'),
              requirements: requirementIds,
            },
          };
        } catch (error) {
          return { ok: false, message: String(error?.message ?? error) };
        }
      },

      // 提交审核：先把 running 推进到 reviewing / final-review，然后立刻驱动 Reviewer 冷调用，
      // 驳回时接着驱动 Planner 出 05，并把「下一步做什么」直接还给 Executor（否则任务会停在 revising 没人推）。
      [TOOL_NAMES.submit]: async (args = {}, exec = null) => {
        const orch = orchestratorFor(resolveSessionId(args, exec));
        if (!orch) return { ok: false, message: '拿不到会话 id，无法定位工作台' };
        const route = resolveSessionRoute(exec);
        const submit = createSubmitForReviewHandler({
          getTask: () => orch.getTask(),
          applyEvent: (event, opts) => orch.applyEvent(event, opts),
        });
        const submitted = await submit(args);
        if (!submitted.ok) return submitted;

        const review = await orch.runReview({ route });
        const task = orch.getTask();
        if (!review.ok) {
          return {
            ok: false,
            message: `已提交，但审核没有完成：${review.error}`,
            data: { state: task?.state ?? null, task_root: orch.getPaths()?.taskRoot ?? null },
          };
        }

        const data = {
          state: task?.state ?? null,
          verdict: review.verdict ?? null,
          findings: review.findings ?? [],
          rejection_count: task?.rejection_count ?? 0,
          rejection_limit: config.rejection_limit,
          round: task?.round ?? 1,
          task_root: orch.getPaths()?.taskRoot ?? null,
        };

        if (review.state === 'done') {
          return { ok: true, message: '审核通过，任务已完成。', data };
        }
        if (review.state === 'escalated') {
          return {
            ok: false,
            message: `审核未通过且已到上限，任务升级人工处理（findings 见 data）。`,
            data,
          };
        }
        if (review.state === 'revising') {
          const revision = await orch.runRevision({ route });
          if (!revision.ok) {
            // 两次原地重写都没交付：任务卡在 revising 不会自己前进，明确提示可以中止。
            return {
              ok: false,
              message: `审核驳回，但修改方案没有出来：${revision.error}。任务停在 ${revision.state ?? 'revising'}，可以调 collab_abort 中止，或让用户介入。`,
              data: { ...data, state: revision.state ?? null, revision_attempts: revision.attempts ?? null },
            };
          }
          const nextTask = orch.getTask();
          return {
            ok: true,
            message: `审核驳回（第 ${nextTask.rejection_count} 次），Planner 已出修改方案。请按下面这段返工。`,
            data: {
              ...data,
              state: nextTask.state,
              round: nextTask.round,
              instruction: orch.executorInstructionFor(nextTask.round),
            },
          };
        }
        return { ok: true, message: `审核结束，当前状态 ${review.state}。`, data };
      },

      [TOOL_NAMES.blocked]: async (args = {}, exec = null) => {
        const orch = orchestratorFor(resolveSessionId(args, exec));
        if (!orch) return { ok: false, message: '拿不到会话 id，无法定位工作台' };
        const handler = createMarkBlockedHandler({
          getTask: () => orch.getTask(),
          applyEvent: (event, opts) => orch.applyEvent(event, opts),
        });
        return handler(args);
      },

      [TOOL_NAMES.abort]: async (args = {}, exec = null) => {
        const orch = orchestratorFor(resolveSessionId(args, exec));
        if (!orch) return { ok: false, message: '拿不到会话 id，无法定位工作台' };
        const handler = createAbortHandler({
          getTask: () => orch.getTask(),
          applyEvent: (event, opts) => orch.applyEvent(event, opts),
        });
        return handler(args);
      },
    };

    const hostToolDefs = buildToolDefinitions({
      defineTool,
      handlers: hostHandlers,
      extraSpecs: [START_TOOL_SPEC],
    });
    for (const def of hostToolDefs) {
      try {
        const d = scoped.tools.register(def);
        if (typeof d === 'function') disposers.push(d);
      } catch (error) {
        log(`[v2] 注册工具 ${def.name} 失败：${error?.message ?? error}`);
      }
    }

    // 运行台读的快照（设置页第 8 步会用；这里先给出稳定形状）。
    try {
      scoped.effect?.(() => () => {
        // 每个会话卸载时不需要做事，工作台树在 Host 退出时统一删
      }, 'dsh-agy-collab-v2: session scope');
    } catch {
      // ignore
    }
  };

  try {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['agents', 'tools'], (scoped) => {
        try {
          mountInto(scoped);
        } catch (error) {
          log(`[v2] 装配失败：${error?.message ?? error}`);
        }
      });
    } else {
      mountInto(ctx);
    }
  } catch (error) {
    log(`[v2] 注入失败：${error?.message ?? error}`);
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => disposeAll, 'dsh-agy-collab-v2: cleanup');
  }

  return disposeAll;
}

function sessionIdOf(source) {
  try {
    return source?.agent?.session?.header?.id ?? source?.session?.id ?? source?.sessionId ?? '';
  } catch {
    return '';
  }
}

export { TOOL_NAMES, TOOL_SPECS, buildToolDefinitions };
export { readConfigFile, resolveBootId };
