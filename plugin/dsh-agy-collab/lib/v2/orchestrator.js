/**
 * dsh-agy-collab v2 — 编排层
 *
 * 把 config / workspace / artifacts / state-machine / roles / tools 串成一条能跑的任务流。
 * 规格 §13 第 1–5 步的可跑最小闭环。
 *
 * 设计约束：
 *  - 本文件不 import 任何宿主包；agents、defineTool、日志、时间全部注入。
 *  - 唯一写任务 state.json 的地方是本文件（Host 独占），角色拿不到写通道。
 *  - 每个角色调用前后各取一次快照，越权由快照 diff 判（§6.4）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic, resolveWorkspaceRoot, resolveBootId, isCollabEnabled } from './config.js';
import {
  SLOT_ORDER,
  WORKSPACE_DIRS,
  createWorkspace,
  filePath,
  relKey,
  removeHostTree,
  snapshotTree,
  assertSnapshotDelta,
  gitStatusPorcelain,
  sha256OfFile,
  sweepOrphans,
  TASK_STATE_FILE,
} from './workspace.js';
import { validateArtifact } from './artifacts.js';
import {
  FORMAT_VIOLATION_LIMIT,
  PROTOCOL_RETRY_LIMIT,
  createTaskState,
  reduce,
  reviewSlotFor,
  isTerminal,
  writableSlots,
} from './state-machine.js';
import {
  buildRolePrompt,
  disposeRole,
  makeTaskId,
  spawnInProcessRole,
} from './roles.js';
import {
  buildToolDefinitions,
  createAbortHandler,
  createCollabWriteHandler,
  createMarkBlockedHandler,
  createSubmitForReviewHandler,
  TOOL_NAMES,
} from './tools.js';

/** 读任务 state.json；不存在返回 null。 */
export function readTaskState(taskRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(taskRoot, TASK_STATE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** 写任务 state.json（Host 独占写方）。 */
export function writeTaskState(taskRoot, task) {
  writeFileAtomic(path.join(taskRoot, TASK_STATE_FILE), JSON.stringify(task, null, 2) + '\n');
  return task;
}

/** 读某个 slot 下某个文件的内容；不存在返回 null。 */
export function readArtifact(paths, slot, fileName) {
  try {
    return fs.readFileSync(filePath(paths, slot, fileName), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 一次任务编排器。
 * @param {object} deps
 * @param {string} deps.dataDir 配置目录（~/.dsh/agy-collab）
 * @param {object} deps.config 配置对象（由调用方持有并写盘）
 * @param {object} [deps.agents] agents 服务；缺省则进程内角色不可用
 * @param {function} [deps.log]
 * @param {function} [deps.now]
 * @param {function} [deps.runGit] git 执行器（越权判定与 Reviewer 输入）
 * @param {function} [deps.deliver] (agent, message) => void，默认 agent.followup
 * @param {function} [deps.createUserMessage] 宿主的 createUserMessage；缺省用最小兼容形状
 */
export function createOrchestrator(deps = {}) {
  const {
    dataDir,
    config,
    agents = null,
    log = () => {},
    now = () => Date.now(),
    runGit = null,
    deliver = (agent, message) => agent.followup(message),
    createUserMessage = null,
    hostPid = process.pid,
    bootId = resolveBootId({ now: now() }),
    // 全局工具清单必须「调用时」读：dsh-tool-fs / dsh-tool-bash 可能在插件挂载之后才注册，
    // 挂载时快照一次会永久冻结成空数组，applyRoleIsolation 就退化成放开全局写/执行工具。
    getKnownGlobalTools = null,
    knownGlobalTools = [],
  } = deps;

  /** 每次起角色前动态取一次全局工具名；没有动态来源时回退静态注入。 */
  function currentKnownGlobalTools() {
    try {
      if (typeof getKnownGlobalTools === 'function') {
        const names = getKnownGlobalTools();
        if (Array.isArray(names)) return names;
      }
    } catch (error) {
      log(`[v2] 读取全局工具清单失败，退回静态清单：${error?.message ?? error}`);
    }
    return Array.isArray(knownGlobalTools) ? knownGlobalTools : [];
  }

  if (!dataDir) throw new Error('createOrchestrator 需要 dataDir');
  if (!config) throw new Error('createOrchestrator 需要 config');

  const root = resolveWorkspaceRoot(config, { dataDir });
  const state = {
    paths: null,
    task: null,
    actorSessionIds: new Set(),
    plannerInvocationId: null,
    reviewerInvocationId: null,
    lastRequirementIds: [],
    // Host 自己最近一次写任务 state.json 的哈希。越权判定只在这个哈希对得上时才豁免
    // state.json（§6.4）：角色篡改它会让哈希对不上，于是照样进 extras。
    lastHostStateSha: null,
  };

  /** 任务 state.json 的绝对路径。 */
  function taskStatePath() {
    return state.paths ? path.join(state.paths.taskRoot, TASK_STATE_FILE) : null;
  }

  /** 记一次 Host 自己落盘的 state.json 哈希。 */
  function rememberHostStateSha() {
    const file = taskStatePath();
    state.lastHostStateSha = file ? sha256OfFile(file) : null;
    return state.lastHostStateSha;
  }

  /**
   * 仓库侧客观状态的指纹（§6.4 第二半：角色不许动仓库）。
   * 没有 repoCwd 或不是 git 仓库时返回空串，前后相等即视为未变动。
   */
  function repoStatus() {
    const cwd = state.task?.repo_cwd;
    if (!cwd) return '';
    return gitStatusPorcelain(cwd, { run: runGit });
  }

  const stamp = () => Number(now()) || Date.now();

  /**
   * 把一段纯文本变成宿主能收的用户消息。
   * 宿主契约（dsh-llm/src/message.ts:246 createUserMessage）要求
   * { content: ContentBlock[], source: { kind: 'user' } }；插件发消息只有这一个合法 kind。
   */
  function makeUserMessage(text) {
    const content = [{ type: 'text', text: String(text ?? '') }];
    if (typeof createUserMessage === 'function') {
      return createUserMessage({ content, source: { kind: 'user' } });
    }
    return { role: 'user', content, source: { kind: 'user' } };
  }

  /** 启动时的静默清扫（§3.3）+ 本 Host 的目录骨架。 */
  function boot() {
    const swept = sweepOrphans({ root, bootId });
    const hostRoot = path.join(root, `${hostPid}-${bootId}`);
    fs.mkdirSync(hostRoot, { recursive: true });
    log(`[v2] workspace root=${root} swept=${swept.removed.length} kept=${swept.kept.length}`);
    return { root, hostRoot, swept };
  }

  /** Host 退出时删自己那一整棵树（§3.3 第一行）。 */
  function shutdown() {
    const result = removeHostTree({ root, hostPid, bootId });
    log(`[v2] shutdown removed=${result.removed} path=${result.path}`);
    return result;
  }

  function assertEnabled(sessionId) {
    if (!isCollabEnabled(config, sessionId)) {
      throw new Error(`会话 ${sessionId} 的协作开关是关的，不能启动任务`);
    }
  }

  /**
   * 开一个新任务（T1）：建目录、写 01/request.md、写任务 state.json。
   * 01 由 Host 写，是六目录里唯一 Host 直接落盘的文件（§6.2）。
   */
  /**
   * 该会话下一个可用的任务序号：扫会话目录下已有的 t-YYYY-MMDD-NN，
   * 取最大序号 +1。硬编码 seq=1 会让同会话的第 2 个任务撞进旧目录、覆盖旧产物。
   */
  function nextTaskSeq(sessionId) {
    const sessionRoot = path.join(root, `${hostPid}-${bootId}`, String(sessionId));
    let max = 0;
    try {
      for (const entry of fs.readdirSync(sessionRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const matched = /-(\d+)$/.exec(entry.name);
        if (matched) max = Math.max(max, Number(matched[1]));
      }
    } catch {
      // 目录还不存在（第一个任务）：从 1 开始
    }
    return max + 1;
  }

  function startTask({ sessionId, requestText, purpose = '', taskId, repoCwd = null } = {}) {
    assertEnabled(sessionId);
    const id = taskId ? String(taskId) : makeTaskId({ now: now(), seq: nextTaskSeq(sessionId) });
    const paths = createWorkspace({ root, hostPid, bootId, sessionId, taskId: id });
    const request = [
      '---',
      `task_id: ${id}`,
      'stage: request',
      'author: host',
      'round: 0',
      `written_at: ${new Date(stamp()).toISOString()}`,
      'raw_text: |',
      ...String(requestText ?? '').split('\n').map((line) => `  ${line}`),
      '---',
      '',
      '# 原始任务需求和目的',
      '',
      '## 用户原话',
      '',
      String(requestText ?? '').trim() || '（空）',
      '',
      '## 目的',
      '',
      String(purpose ?? '').trim() || '（未单独说明，以上面的原话为准）',
      '',
    ].join('\n');
    fs.writeFileSync(filePath(paths, 'request', 'request.md'), request, 'utf8');

    const task = createTaskState({
      taskId: id,
      executorSessionId: sessionId,
      repoCwd,
      now: stamp(),
    });

    state.paths = paths;
    state.task = writeTaskState(paths.taskRoot, task);
    state.lastRequirementIds = [];
    // 记下 Host 自己这份 state.json 的哈希：后面每次快照 diff 都拿它核 state.json 是否被角色动过。
    rememberHostStateSha();
    log(`[v2] task ${id} created at ${paths.taskRoot} repo=${repoCwd ?? '(未指定)'}`);
    return { taskId: id, paths, task: state.task };
  }

  /** 把状态机事件落到盘上。所有转移都经过这里，保证只有一个写方。 */
  function applyEvent(event, opts = {}) {
    if (!state.paths || !state.task) return { ok: false, error: '没有正在进行的任务' };
    const result = reduce(state.task, event, {
      now: stamp(),
      rejectionLimit: config.rejection_limit,
      collabEnabled: true,
      ...opts,
    });
    if (!result.ok) return result;
    state.task = writeTaskState(state.paths.taskRoot, result.state);
    rememberHostStateSha();
    return { ok: true, state: state.task };
  }

  /**
   * 角色调用前后各取快照，diff 只许出现本轮该写的文件（§6.4）。
   * 返回 fn 的结果，并附带 overreach（非空即越权）。
   */
  async function runWithSnapshot(allowedRel, fn) {
    const before = snapshotTree(state.paths.taskRoot);
    const repoBefore = repoStatus();
    const outcome = await fn();
    const after = snapshotTree(state.paths.taskRoot);
    const repoAfter = repoStatus();
    // state.json 的豁免要对着「Host 自己刚落盘的哈希」核，不能按文件名无条件放过：
    // 角色把 state.json 改成 done 时哈希对不上，照样进 extras。
    const delta = assertSnapshotDelta(before, after, allowedRel, {
      expectedHostStateSha256: state.lastHostStateSha,
    });
    const extras = [...delta.extras];
    if (repoBefore !== repoAfter) extras.push('仓库工作区（git status 变了）');
    if (extras.length > 0) {
      applyEvent('overreach', { note: `预期外变化：${extras.join('、')}` });
      return { ...outcome, overreach: extras };
    }
    return outcome;
  }

  /** 组装某个角色的工具处理器（进程内角色用）。 */
  function buildHandlers(role) {
    return {
      [TOOL_NAMES.write]: createCollabWriteHandler({
        getTask: () => state.task,
        getRole: () => role,
        getRoleBindingMode: () => config.role_binding_mode,
        getReviewerMode: () => config.reviewer_mode,
        getEstimateSubagents: () => config.estimate_subagents,
        getPaths: () => state.paths,
        getRequirementIds: () => state.lastRequirementIds,
        applyEvent,
        now,
        onWritten: (info) => {
          if (info.slot === 'tasks') {
            state.lastRequirementIds = info.requirementIds ?? [];
          }
          log(`[v2] ${role} wrote ${info.slot}/${info.fileName}`);
        },
      }),
      [TOOL_NAMES.submit]: createSubmitForReviewHandler({ getTask: () => state.task, applyEvent }),
      [TOOL_NAMES.blocked]: createMarkBlockedHandler({ getTask: () => state.task, applyEvent }),
      [TOOL_NAMES.abort]: createAbortHandler({ getTask: () => state.task, applyEvent }),
    };
  }

  /** Executor 的三个触发点（当前会话里可见）。 */
  function executorHandlers() {
    return {
      [TOOL_NAMES.submit]: createSubmitForReviewHandler({ getTask: () => state.task, applyEvent }),
      [TOOL_NAMES.blocked]: createMarkBlockedHandler({ getTask: () => state.task, applyEvent }),
      [TOOL_NAMES.abort]: createAbortHandler({ getTask: () => state.task, applyEvent }),
    };
  }

  /**
   * 起一个进程内角色、把提示词递进去、等它跑完、然后销毁（冷调用）。
   * @returns {Promise<{ ok: boolean, sessionId?: string, error?: string, allow?: string[] }>}
   */
  async function runRole({ role, round = state.task?.round ?? 1, message }) {
    if (!agents) return { ok: false, error: 'agents 服务不可用，进程内角色无法启动' };
    if (!state.paths) return { ok: false, error: '没有正在进行的任务' };

    const promptText = buildRolePrompt(role, {
      taskId: state.task.task_id,
      workspaceDir: state.paths.taskRoot,
      repoCwd: state.task.repo_cwd ?? null,
      round,
      reviewerMode: config.reviewer_mode,
      estimateSubagents: config.estimate_subagents,
      roleBindingMode: config.role_binding_mode,
    });

    // 角色能用的工具：collab_write（按角色可写 slot 自动收紧）+ collab_abort。
    // defineTool 由调用方注入；没有它时角色拿不到任何写通道，明确降级而不是静默成功。
    const handlers = buildHandlers(role);
    let roleTools = [];
    if (typeof deps.defineTool === 'function') {
      const wanted = [TOOL_NAMES.write, TOOL_NAMES.abort];
      const subset = {};
      for (const name of wanted) subset[name] = handlers[name];
      try {
        roleTools = buildToolDefinitions({ defineTool: deps.defineTool, handlers: subset });
      } catch (error) {
        return { ok: false, error: `角色工具装配失败：${error?.message ?? error}` };
      }
    } else {
      log('[v2] defineTool 未注入，进程内角色没有 collab_write 通道');
    }

    const spawned = await spawnInProcessRole({
      agents,
      role,
      taskId: state.task.task_id,
      workspaceDir: state.paths.taskRoot,
      agentOptions: config.roles?.[role]?.model ? { model: config.roles[role].model } : undefined,
      promptSection: {
        name: `agy-collab-${role}`,
        order: 5200,
        interpolate: false,
        text: promptText,
      },
      tools: roleTools,
      knownGlobalTools: currentKnownGlobalTools(),
      meta: {},
    });

    if (!spawned.ok) return { ok: false, error: spawned.error };
    if (spawned.sessionId) state.actorSessionIds.add(spawned.sessionId);

    // 冷调用是结构保证：每次角色调用都新建实例、用完立刻 dispose（§6.5）。
    // 双 agent 模式下 Planner 与 Reviewer 是同一个 actor，靠 actor_id 分不出新旧，
    // 所以这里显式记一次「审核是重新 create 出来的」，写进 history 而不是提示词自述（§7.2）。
    if (role === 'planner') {
      state.plannerInvocationId = spawned.sessionId ?? null;
    }
    if (role === 'reviewer') {
      if (config.role_binding_mode === 'dual' && state.plannerInvocationId) {
        log(`[v2] review_cold_restart planner=${state.plannerInvocationId} reviewer=${spawned.sessionId}`);
      }
      state.reviewerInvocationId = spawned.sessionId ?? null;
    }

    try {
      const agent = spawned.handle?.agent;
      if (agent && typeof agent.whenIdle === 'function') await agent.whenIdle();
      if (agent && message) deliver(agent, message);
      if (agent && typeof agent.whenIdle === 'function') await agent.whenIdle();
    } catch (error) {
      await disposeRole(spawned.handle, spawned.sessionId);
      return { ok: false, error: String(error?.message ?? error), sessionId: spawned.sessionId };
    }
    await disposeRole(spawned.handle, spawned.sessionId);
    return { ok: true, sessionId: spawned.sessionId, allow: spawned.allow };
  }

  /** 规划阶段：起 Planner 写 02 与 03，然后校验并推进到 ready（T3）。 */
  async function runDrafting() {
    if (!state.task) return { ok: false, error: '没有正在进行的任务' };
    if (state.task.state !== 'drafting') return { ok: false, error: `drafting 阶段才能规划，当前是 ${state.task.state}` };

    const allowedRel = [
      relKey(state.paths.taskRoot, filePath(state.paths, 'plan', 'plan.md')),
      relKey(state.paths.taskRoot, filePath(state.paths, 'tasks', 'tasks.md')),
    ];
    // 违约是「原地退回 Planner 重写」，不占驳回轮次；同一轮连续 3 次才升级人工（§4.3）。
    // 计数器由状态机维护（format_violation_count），这里只负责重试与收敛。
    let lastViolation = null;
    for (let attempt = 1; attempt <= FORMAT_VIOLATION_LIMIT; attempt += 1) {
      const message = makeUserMessage(
        [
          `请开始规划。任务 id ${state.task.task_id}。先读 01-原始任务需求和目的/request.md，然后写 02-执行方案/plan.md 与 03-任务清单/tasks.md。`,
          attempt > 1
            ? `上一次的 03-任务清单/tasks.md 违约（${lastViolation ?? '不合规'}）。这次请原地重写同一个文件：任务清单只写要达到什么，不写怎么实现。`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      const roleRun = await runWithSnapshot(allowedRel, () => runRole({ role: 'planner', round: 1, message }));
      if (!roleRun.ok) return roleRun;
      if (roleRun.overreach) return { ok: false, error: `规划阶段出现越权写入：${roleRun.overreach.join('、')}` };

      const planText = readArtifact(state.paths, 'plan', 'plan.md');
      const tasksText = readArtifact(state.paths, 'tasks', 'tasks.md');
      // 02 缺失是硬失败：没有方案就没有可执行的东西，退回 Planner 也补不出来。
      if (!planText) return { ok: false, error: 'Planner 没有写 02-执行方案/plan.md' };
      // 03 缺失算违约：被拒的写入本来就不会落盘，重试时文件仍不存在是正常现象，
      // 不该当成硬失败把重试环打断（否则第一次违约之后永远报「没写」）。
      // 计数器由 collab_write 的校验 3 独占维护 —— 这里只看结果、不重复记数。
      if (!tasksText) {
        lastViolation = '03-任务清单/tasks.md 不存在';
        if (state.task.state === 'escalated') {
          return { ok: false, error: `tasks.md 连续违约达上限，已升级人工：${lastViolation}`, state: 'escalated' };
        }
        continue;
      }

      const planVerdict = validateArtifact({
        slot: 'plan',
        text: planText,
        estimateSubagents: config.estimate_subagents,
      });
      if (!planVerdict.ok) return { ok: false, error: `plan.md 校验不通过：${planVerdict.errors.join('；')}` };

      const tasksVerdict = validateArtifact({ slot: 'tasks', text: tasksText });
      if (!tasksVerdict.ok) {
        // 磁盘上的内容不合规，但计数已经在写入那一刻记过了，这里只负责收敛。
        lastViolation = tasksVerdict.errors.join('；');
        if (state.task.state === 'escalated') {
          return { ok: false, error: `tasks.md 连续违约达上限，已升级人工：${lastViolation}`, state: 'escalated' };
        }
        continue;
      }

      state.lastRequirementIds = tasksVerdict.requirementIds ?? [];
      const advanced = applyEvent('plan-validated');
      return {
        ok: advanced.ok,
        state: state.task.state,
        requirementIds: state.lastRequirementIds,
        error: advanced.error,
        attempts: attempt,
      };
    }

    return { ok: false, error: `规划重试用尽：${lastViolation ?? '未知原因'}`, state: state.task.state };
  }

  /** 执行阶段由当前会话承担；Host 只负责把它推进到 running（T4）。 */
  function startRound() {
    const advanced = applyEvent('start-round');
    return { ok: advanced.ok, state: state.task?.state, error: advanced.error };
  }

  /**
   * 审核阶段：起 Reviewer（冷调用）写 04 或 06，然后按 verdict 推进。
   * @param {{ mode?: 'auto' | 'manual' }} [opts]
   */
  async function runReview() {
    if (!state.task) return { ok: false, error: '没有正在进行的任务' };
    const slot = reviewSlotFor(state.task.state, {
      round: state.task.round,
      rejectionLimit: config.rejection_limit,
    });
    if (!slot) return { ok: false, error: `当前状态 ${state.task.state} 不是审核阶段` };

    const fileName = slot === 'final' ? 'final.md' : `review-r${state.task.round}.md`;
    const allowedRel = [relKey(state.paths.taskRoot, filePath(state.paths, slot, fileName))];
    const round = Number(state.task.round);
    let lastProtocolFailure = null;

    // 协议违规是「原地重写同一文件」，不是驳回：同一轮最多再要 PROTOCOL_RETRY_LIMIT 次（§9.3）。
    // 计数器由状态机维护，达到上限时 bumpProtocolRetry 直接把任务推到 escalated。
    for (let attempt = 1; attempt <= PROTOCOL_RETRY_LIMIT + 1; attempt += 1) {
      const before = snapshotTree(state.paths.taskRoot);
      const repoBefore = repoStatus();
      const message = makeUserMessage(
        [
          `请审核。任务 id ${state.task.task_id}，第 ${round} 轮，审核档位 ${config.reviewer_mode}。`,
          '先读 03-任务清单/tasks.md 弄清需求与目的，再看仓库的客观产物判断是否达成。',
          `把结论写到 ${WORKSPACE_DIRS[slot]}/${fileName}。`,
          attempt > 1
            ? `上一次调用没有交出合法产物（${lastProtocolFailure ?? '产物不合规'}）。这次请原地重写同一个文件 ${WORKSPACE_DIRS[slot]}/${fileName}，不要新建别的文件。`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      const roleRun = await runRole({ role: 'reviewer', round, message });
      if (!roleRun.ok) return roleRun;

      const after = snapshotTree(state.paths.taskRoot);
      const repoAfter = repoStatus();
      const delta = assertSnapshotDelta(before, after, allowedRel, {
        expectedHostStateSha256: state.lastHostStateSha,
      });
      const extras = [...delta.extras];
      if (repoBefore !== repoAfter) extras.push('仓库工作区（git status 变了）');
      if (extras.length > 0) {
        applyEvent('overreach', { note: `审核阶段预期外变化：${extras.join('、')}` });
        return { ok: false, error: `审核阶段出现越权写入：${extras.join('、')}` };
      }

      const text = readArtifact(state.paths, slot, fileName);
      const verdict = text
        ? validateArtifact({
            slot,
            text,
            round,
            mode: config.reviewer_mode,
            requirementIds: state.lastRequirementIds,
          })
        : null;

      if (!text || !verdict?.ok) {
        lastProtocolFailure = text ? verdict.errors.join('；') : `${slot}/${fileName} 不存在`;
        const evt = applyEvent('protocol-violation', { note: lastProtocolFailure });
        if (state.task.state === 'escalated') {
          return { ok: false, error: `协议违规达上限，已升级人工：${lastProtocolFailure}`, state: 'escalated' };
        }
        if (evt && evt.ok === false) {
          return { ok: false, error: lastProtocolFailure, state: state.task.state };
        }
        continue;
      }

      const pass = verdict.data.verdict === 'pass';
      const event = slot === 'final'
        ? (pass ? 'final-pass' : 'final-needs-revision')
        : (pass ? 'review-pass' : 'review-needs-revision');
      const advanced = applyEvent(event);
      return {
        ok: advanced.ok,
        state: state.task.state,
        verdict: verdict.data.verdict,
        findings: verdict.data.findings ?? [],
        error: advanced.error,
        attempts: attempt,
      };
    }

    return { ok: false, error: `审核重试用尽：${lastProtocolFailure ?? '未知原因'}`, state: state.task.state };
  }

  /** 返工阶段的最多尝试次数：一次不成，原地重写一次，还不行就交回调用方中止。 */
  const REVISION_ATTEMPTS = 2;

  /**
   * 返工阶段：起 Planner 写 05/revision-r<N>.md，然后推进到 running（T10）。
   *
   * 05 缺失或不合规是「这一轮返工没交付」，不是越权：不记 overreach_count。
   * 但也不能直接返回让任务卡死在 revising，所以原地重试一次（最多 2 次），
   * 两次都失败才交回调用方（v2/index.js 会提示可以 collab_abort）。
   */
  async function runRevision() {
    if (!state.task) return { ok: false, error: '没有正在进行的任务' };
    if (state.task.state !== 'revising') return { ok: false, error: `当前状态 ${state.task.state} 不是返工阶段` };
    const round = Number(state.task.round);
    const fileName = `revision-r${round}.md`;
    const allowedRel = [relKey(state.paths.taskRoot, filePath(state.paths, 'revision', fileName))];

    let lastFailure = null;
    let lastReason = 'revision_missing';

    for (let attempt = 1; attempt <= REVISION_ATTEMPTS; attempt += 1) {
      const before = snapshotTree(state.paths.taskRoot);
      const repoBefore = repoStatus();
      const lines = [
        `请给出修改方案。任务 id ${state.task.task_id}，第 ${round} 轮被驳回。`,
        `读 04-审核结果/review-r${round}.md 里的 findings，把针对每条 required_fix 的修改方案写到 05-修改方案/${fileName}。`,
      ];
      if (attempt > 1) {
        lines.push(
          `上一次调用没有交出合法产物（${lastFailure ?? '未知原因'}）。请原地重写同一个文件 05-修改方案/${fileName}，不要换文件名、不要解释。`,
        );
      }
      const roleRun = await runRole({ role: 'planner', round, message: makeUserMessage(lines.join('\n')) });
      if (!roleRun.ok) return roleRun;

      const after = snapshotTree(state.paths.taskRoot);
      const repoAfter = repoStatus();
      const delta = assertSnapshotDelta(before, after, allowedRel, {
        expectedHostStateSha256: state.lastHostStateSha,
      });
      const extras = [...delta.extras];
      if (repoBefore !== repoAfter) extras.push('仓库工作区（git status 变了）');
      if (extras.length > 0) {
        applyEvent('overreach', { note: `返工阶段预期外变化：${extras.join('、')}` });
        return { ok: false, error: `返工阶段出现越权写入：${extras.join('、')}` };
      }

      const text = readArtifact(state.paths, 'revision', fileName);
      if (!text) {
        lastFailure = `没有写 05-修改方案/${fileName}`;
        lastReason = 'revision_missing';
        log(`[v2] 返工第 ${attempt} 次未交付：${lastFailure}`);
        continue;
      }
      const verdict = validateArtifact({ slot: 'revision', text, round });
      if (!verdict.ok) {
        lastFailure = `${fileName} 校验不通过：${verdict.errors.join('；')}`;
        lastReason = 'revision_invalid';
        log(`[v2] 返工第 ${attempt} 次未交付：${lastFailure}`);
        continue;
      }
      const advanced = applyEvent('revision-written');
      return {
        ok: advanced.ok,
        state: state.task.state,
        error: advanced.error,
        attempts: attempt,
        round: state.task.round,
      };
    }

    return {
      ok: false,
      error: `返工重试用尽：${lastFailure ?? '未知原因'}`,
      state: state.task.state,
      reason: lastReason,
      attempts: REVISION_ATTEMPTS,
    };
  }

  /** 给当前会话的执行者一句「读 05 并改」的提示（T10 之后由 Host 主动唤起）。 */
  function executorInstructionFor(round) {
    return [
      `第 ${round} 轮返工。`,
      `读 05-修改方案/revision-r${round - 1}.md，按里面的修改方案改仓库代码。`,
      '改完调 collab_submit_for_review 提交，或调 collab_mark_blocked 说明为什么做不下去。',
    ].join('\n');
  }

  /** 当前可写 slot（给 UI 与工具说明用）。 */
  function writableSlotsNow(role) {
    if (!state.task) return [];
    return writableSlots(role, state.task.state, { roleBindingMode: config.role_binding_mode });
  }

  /** 快照（运行台显示用）。 */
  function snapshot() {
    if (!state.paths || !state.task) return { active: false };
    return {
      active: true,
      task_id: state.task.task_id,
      state: state.task.state,
      round: state.task.round,
      rejection_count: state.task.rejection_count,
      rejection_limit: config.rejection_limit,
      overreach_count: state.task.overreach_count,
      format_violation_count: state.task.format_violation_count,
      protocol_retry_count: state.task.protocol_retry_count,
      terminal: isTerminal(state.task.state),
      task_root: state.paths.taskRoot,
      dirs: Object.fromEntries(SLOT_ORDER.map((slot) => [slot, WORKSPACE_DIRS[slot]])),
      actor_session_ids: [...state.actorSessionIds],
      requirement_ids: [...state.lastRequirementIds],
    };
  }

  return {
    root,
    bootId,
    boot,
    shutdown,
    startTask,
    applyEvent,
    runDrafting,
    startRound,
    runReview,
    runRevision,
    executorInstructionFor,
    executorHandlers,
    buildHandlers,
    writableSlotsNow,
    snapshot,
    getTask: () => state.task,
    getPaths: () => state.paths,
    runGit,
  };
}
