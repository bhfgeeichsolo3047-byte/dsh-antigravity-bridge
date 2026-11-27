/**
 * dsh-agy-collab v2 — 角色载体
 *
 * 规格 §6.1 / §6.3 / §6.5 / §6.6 / §6.9 / §7.2。
 *
 * 一个角色 = 权限档 × 载体。本文件只负责「把角色起起来」：
 *   - 进程内：ctx.agents.create() 建一个无历史的新 agent
 *   - 会话：直接用当前 DSH 会话（不建实例）
 *   - 进程外：交给 broker 唤醒（本文件只产出唤醒所需描述）
 *
 * 三层强制顺序（§6.3）：协议层没有写通道 → tools.restrict 物理裁剪 → 提示词说明。
 * 本文件实现第二层，且只在 agent.ctx（scoped context）里调 restrict。
 *
 * 零外部依赖；agents 服务、工具清单、消息构造全部注入，便于离线测试。
 */

import crypto from 'node:crypto';

import { registerActorSession, unregisterActorSession } from '../actor-sessions.js';

/** 只读白名单：这些是 DSH 真实存在的全局只读工具实名（不是 read_file）。 */
export const READONLY_GLOBAL_TOOLS = Object.freeze(['read', 'read_image', 'glob', 'grep']);

/** 三个角色的默认提示词标题（settings 页与 prompt section 共用）。 */
export const ROLE_TITLES = Object.freeze({
  planner: '规划者',
  executor: '执行者',
  reviewer: '审核者',
});

/**
 * 动态构造 restrict 的 allow 清单。
 *
 * 为什么必须动态：tools.restrict() 对未知名抛错并回滚整个 create
 * （dsh-tools/src/index.ts:194），所以只能取「当前已注册全局工具 ∩ 只读白名单」。
 * @param {string[]} knownGlobalTools 当前视图里的已知全局工具名
 * @returns {string[]}
 */
export function computeReadonlyAllow(knownGlobalTools = []) {
  const known = new Set(knownGlobalTools.map((v) => String(v)));
  return READONLY_GLOBAL_TOOLS.filter((name) => known.has(name));
}

/**
 * 写 / 执行类全局工具名：allow 拿不到时用它们做 deny 兜底。
 * 名字按宿主实名写（read/read_image/glob/grep 之外的那些会改世界的工具）。
 */
export const DANGEROUS_GLOBAL_TOOLS = Object.freeze([
  'write',
  'edit',
  'apply_patch',
  'bash',
  'pwsh',
  'shell',
  'run_code',
  'wsl',
]);

/** 从已知全局工具里挑出必须挡掉的写/执行工具（用于 deny 兜底）。 */
export function computeDangerousDeny(knownGlobalTools = []) {
  const known = new Set(knownGlobalTools.map((v) => String(v)));
  return DANGEROUS_GLOBAL_TOOLS.filter((name) => known.has(name));
}

/** 进程内角色会话 id：带前缀便于在白名单里识别，且不会撞上真实会话。 */
export function actorSessionId(role, taskId) {
  return `agy-collab-${role}-${taskId}-${crypto.randomBytes(4).toString('hex')}`;
}

/** 生成任务 id：t-YYYY-MMDD-NN 形态，NN 是当天序号。 */
export function makeTaskId({ now = Date.now(), seq = 1 } = {}) {
  const d = new Date(Number(now) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `t-${d.getFullYear()}-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(seq)}`;
}

/**
 * 角色提示词正文（最弱的一层，只做说明；真正的隔离靠 restrict）。
 * 冷调用意味着每次都要把「你是谁、读什么、写什么、不许做什么」讲全。
 */
export function buildRolePrompt(role, ctxInfo = {}) {
  const {
    taskId = '(unknown)',
    workspaceDir = '(unknown)',
    repoCwd = null,
    round = 1,
    reviewerMode = 'strict',
    estimateSubagents = false,
    roleBindingMode = 'triple',
  } = ctxInfo;

  const common = [
    `你是一个无状态的协作角色，本次调用的任务 id 是 ${taskId}。`,
    '你没有上一次调用的记忆，所有需要的信息都在工作台目录里，读完再动手。',
    `工作台目录：${workspaceDir}`,
    repoCwd
      ? `目标仓库目录：${repoCwd}（只读观察用；你要动它，Host 会按 git status 判定越权）`
      : '目标仓库目录：本次任务未指定（没有仓库可看，只按工作台文件判断）。',
    '你不写仓库文件，也不写工作台的 01-原始任务需求和目的（那份由 Host 独占）。',
    '需要落盘时调用 collab_write 工具，由 Host 校验后写入；不要试图用别的通道写文件。',
  ].join('\n');

  if (role === 'planner') {
    const lines = [
      common,
      '',
      '你的职责是规划，不是实现：',
      '- 读 01-原始任务需求和目的/request.md 弄清用户要什么。',
      '- 写 02-执行方案/plan.md：分步方案，每步写清目的与预计用到的工具类型。',
      '- 写 03-任务清单/tasks.md：只写「要达到什么」，不写怎么实现。front-matter 只许 requirements[]，正文不许代码围栏、不许表格、不许复选框。这份文件全流程只写一次，写完冻结。',
    ];
    if (estimateSubagents) {
      lines.push('- 每一步可给 subagent_count：预估主 agent 需要生成几个子 agent（0 表示不需要）。');
    } else {
      lines.push('- 不要填 subagent_count：预估子 agent 数量这个开关是关的。');
    }
    if (round > 1) {
      lines.push(`- 本轮是第 ${round} 轮返工：读 04-审核结果/review-r${round - 1}.md，写 05-修改方案/revision-r${round - 1}.md，只针对 findings 里的 required_fix。`);
    }
    return lines.join('\n');
  }

  if (role === 'reviewer') {
    const lines = [
      common,
      '',
      '你的职责是审核，不是动手：',
      '- 先读 03-任务清单/tasks.md 弄清需求与目的（这份已冻结，不会变）。',
      '- 再读仓库的客观产物（文件树、git status、git diff）判断需求是否达成。',
      '- 不要读 02-执行方案，也不要读执行者的任何主观叙述 —— 那会把你的判断带偏。',
    ];
    if (reviewerMode === 'strict') {
      lines.push('- 严格档：每条 finding 必须写 requirement_ref，且必须命中 tasks.md 里真实存在的 id，否则算协议违规。');
    }
    if (roleBindingMode === 'dual') {
      lines.push('- 双 agent 模式下你可能同时承担规划与审核：本次是审核调用，不得引用你作为规划者的记忆，只以工作台文件为准。');
    }
    lines.push('- 首发审核写 04-审核结果/review-r<N>.md；终审写 06-最终审核/final.md。');
    return lines.join('\n');
  }

  return common;
}

/**
 * 在 agent.ctx 里做隔离：注册 collab_write + restrict 掉一切非只读工具。
 *
 * 关键约束（实查得来）：
 *  - tools.restrict() 必须在 scoped context 里调，否则抛错；
 *  - allow 里出现未知名会抛错并回滚 create，所以要先用 computeReadonlyAllow 过滤；
 *  - agentCtx.tools.register() 注册的工具天然不受 restrict 影响，所以 collab_write 不能进 allow。
 *
 * @returns {{ ok: boolean, allow?: string[], error?: string }}
 */
export function applyRoleIsolation(agentCtx, { role, tools = [], collabWriteTool, knownGlobalTools }) {
  try {
    const toRegister = [...tools];
    if (collabWriteTool) toRegister.push(collabWriteTool);
    if (typeof agentCtx?.tools?.register === 'function') {
      for (const tool of toRegister) agentCtx.tools.register(tool);
    }
    const allow = computeReadonlyAllow(knownGlobalTools);
    if (allow.length > 0 && typeof agentCtx?.tools?.restrict === 'function') {
      agentCtx.tools.restrict({ allow });
      return { ok: true, allow };
    }
    // allow 为空（拿不到全局工具视图）时不能静默放开：只要已知清单里出现写/执行类工具，
    // 就用 deny 兜底把它们显式挡掉。两者都做不到才是真正的降级，由调用方记进 history。
    const deny = computeDangerousDeny(knownGlobalTools);
    if (deny.length > 0 && typeof agentCtx?.tools?.restrict === 'function') {
      agentCtx.tools.restrict({ deny });
      return { ok: true, allow, deny, degraded: true };
    }
    return { ok: true, allow, degraded: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 收集当前视图里的已知全局工具名（用于 computeReadonlyAllow）。
 *
 * 三条取法按可靠性排：
 *  1. view().knownNames / restrictableNames —— 最准，但 view 在 TS 源码里是 private；
 *  2. definitions()（dsh-tools/src/index.ts:305，公开方法）—— 插件乱序加载时的兜底；
 *  3. 都拿不到返回空表：allow 为空时不调 restrict，退化成「只靠提示词」，
 *     这是明确的降级而不是静默成功 —— 调用方应把 allow=[] 记进 history。
 *
 * 之所以必须支持动态读取：dsh-tool-fs / dsh-tool-bash 可能在插件挂载之后才注册，
 * 挂载时快照一次会永久冻结成空数组（A 审核第二轮阻塞 ②）。
 */
export function knownGlobalToolNames(toolsService) {
  try {
    const view = toolsService?.view?.();
    if (view?.knownNames) return [...view.knownNames];
    if (view?.restrictableNames) return [...view.restrictableNames];
  } catch {
    // fall through to definitions()
  }
  try {
    const defs = toolsService?.definitions?.();
    if (Array.isArray(defs)) {
      return defs.map((d) => String(d?.name ?? '')).filter(Boolean);
    }
  } catch {
    // fall through
  }
  return [];
}

/**
 * broker /relay 的请求体（唤醒进程外角色时用，§7.2 第 3 步）。
 *
 * 字段名与 broker 侧一致（role / round / stage / cold / roleBinding / estimateSubagents），
 * 不要用 task_id / workspace_dir 这类下划线写法 —— broker 不认，A 侧也就拿不到工作台路径。
 * A 侧靠 role 决定载 planner.md 还是 reviewer.md（§11.2），靠 round 决定写 review-r{N} / revision-r{N}。
 */
export function externalWakePayload({
  role,
  taskId,
  workspaceDir,
  round = 1,
  stage = '',
  cold = false,
  roleBinding = 'triple',
  estimateSubagents = false,
  task = '',
  sessionId = '',
}) {
  return {
    role,
    taskId,
    workspace: workspaceDir,
    round,
    stage,
    cold: Boolean(cold),
    roleBinding,
    estimateSubagents: Boolean(estimateSubagents),
    task,
    sessionId,
    must_report_handled_in: true,
  };
}

/**
 * 起一个进程内角色。
 *
 * setup 只做「组合」（注册 + restrict + prompt section），不驱动；
 * 驱动必须在 create resolve 之后由调用方 followup（dsh-agent 的硬约束）。
 *
 * @param {object} input
 * @param {object} input.agents agents 服务（ctx.inject(['agents'], ...) 拿到）
 * @param {string} input.role planner | reviewer
 * @param {string} input.taskId
 * @param {string} input.workspaceDir
 * @param {object} [input.agentOptions] { provider, model, reasoningEffort }
 * @param {object} [input.promptSection] { name, order, text } 由调用方给（避免本文件依赖宿主 API）
 * @param {object[]} [input.tools] 要注册进 agent 的工具定义（collab_write / collab_abort）
 * @param {string[]} [input.knownGlobalTools]
 * @returns {Promise<{ ok: boolean, handle?: object, sessionId?: string, allow?: string[], error?: string }>}
 */
export async function spawnInProcessRole(input) {
  const {
    agents,
    role,
    taskId,
    workspaceDir,
    agentOptions,
    promptSection,
    tools = [],
    collabWriteTool,
    knownGlobalTools = [],
    meta = {},
  } = input ?? {};
  if (!agents || typeof agents.create !== 'function') {
    return { ok: false, error: 'agents 服务不可用：需要 ctx.inject([agents], ...) 懒注入' };
  }
  if (role !== 'planner' && role !== 'reviewer') {
    return { ok: false, error: `进程内角色只能是 planner 或 reviewer，收到 ${String(role)}` };
  }
  const sessionId = actorSessionId(role, taskId ?? 'task');
  let allow = [];
  // 必须在 create 之前登记：宿主 agent/created 钩子在 create 内部就会触发，
  // 登记晚一步会让那一次钩子把角色当成普通会话（§6.9 的竞态）。
  registerActorSession(sessionId);
  try {
    const handle = await agents.create({
      sessionId,
      meta: { cwd: workspaceDir, ...meta },
      agentOptions: agentOptions ?? undefined,
      setup: (agentCtx) => {
        if (promptSection) {
          const register = agentCtx?.systemPrompt?.section ?? agentCtx?.systemPrompt?.register;
          if (typeof register === 'function') {
            register.call(agentCtx.systemPrompt, promptSection);
          }
        }
        const applied = applyRoleIsolation(agentCtx, { role, tools, collabWriteTool, knownGlobalTools });
        if (!applied.ok) throw new Error(applied.error);
        allow = applied.allow ?? [];
      },
    });
    return { ok: true, handle, sessionId, allow };
  } catch (error) {
    // create 失败要把预登记撤掉，否则白名单里留下一个永远不会被 dispose 的幽灵 id。
    unregisterActorSession(sessionId);
    return { ok: false, sessionId, error: String(error?.message ?? error) };
  }
}

/** 关闭进程内角色（用完即弃，§6.5 冷调用），并从白名单里撤销登记。 */
export async function disposeRole(handle, sessionId) {
  if (sessionId) unregisterActorSession(sessionId);
  if (!handle || typeof handle.dispose !== 'function') return { ok: true };
  try {
    await handle.dispose();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 双 agent 模式的冷启动判据（§7.2）。
 * 判据是进程内实例身份，不看提示词、也不看 actor_id
 * —— dual 下两槽 actor_id 本来就相同，靠它无从判断。
 * @returns {{ cold: boolean, reason?: string }}
 */
export function coldStartDecision({ role, plannerHandle, reviewerHandle } = {}) {
  if (role !== 'reviewer') return { cold: true };
  if (plannerHandle && reviewerHandle && plannerHandle === reviewerHandle) {
    return { cold: false, reason: '审核阶段复用了规划阶段的同一个实例句柄，必须重新 create' };
  }
  return { cold: true };
}
