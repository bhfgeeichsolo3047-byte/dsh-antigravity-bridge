/**
 * dsh-agy-collab v2 — 任务状态机
 *
 * 规格 §5。唯一写方是 Host；任何角色、UI、外部进程都不写任务 state.json。
 *
 * 本文件是纯 reducer：进 (state, event, opts) 出 (next state | error)。
 * 落盘由 workspace.js 的路径 + 调用方负责，reducer 自己不做 IO。
 */

export const STATES = Object.freeze([
  'drafting',
  'ready',
  'running',
  'reviewing',
  'revising',
  'final-review',
  'done',
  'blocked',
  'escalated',
  'aborted',
]);

export const TERMINAL_STATES = Object.freeze(['done', 'blocked', 'escalated', 'aborted']);

/** 十个状态归并成用户能看懂的五个阶段（§5.1）。 */
export const PHASES = Object.freeze({
  drafting: '准备',
  ready: '准备',
  running: '执行',
  reviewing: '审核',
  'final-review': '审核',
  revising: '返工',
  done: '收尾',
  blocked: '收尾',
  escalated: '收尾',
  aborted: '收尾',
});

/** 计数器名（§5.2）。 */
export const COUNTERS = Object.freeze([
  'rejection_count',
  'overreach_count',
  'format_violation_count',
  'protocol_retry_count',
]);

/** 越权累计上限、违约连续上限、协议违规同轮上限（§6.4 / §4.3 / §9.3）。 */
export const OVERREACH_LIMIT = 2;
export const FORMAT_VIOLATION_LIMIT = 3;
export const PROTOCOL_RETRY_LIMIT = 2;

/** 一次新任务的初始 state.json（§5.2 字段）。 */
export function createTaskState({ taskId, executorSessionId = null, repoCwd = null, now = Date.now() } = {}) {
  if (!taskId) throw new Error('createTaskState 需要 taskId');
  return {
    task_id: String(taskId),
    state: 'drafting',
    // 目标仓库目录：越权判定的另一半（角色不许动仓库），也是 Reviewer 的客观产物来源。
    repo_cwd: repoCwd ? String(repoCwd) : null,
    round: 1,
    rejection_count: 0,
    overreach_count: 0,
    format_violation_count: 0,
    protocol_retry_count: 0,
    executor_session_id: executorSessionId ? String(executorSessionId) : null,
    created_at: Number(now) || Date.now(),
    updated_at: Number(now) || Date.now(),
    last_event: 'T1 -> drafting（协作开关已开，用户提交需求）',
  };
}

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

export function phaseOf(state) {
  return PHASES[state] ?? '未知';
}

/**
 * 某个角色在某个状态下能写的 slot 集合（§6.2 + §6.7 校验清单第 1、2 条）。
 * Host 不在表里 —— Host 写 01 与 state.json 不走 collab_write。
 */
export function writableSlots(role, state, { roleBindingMode = 'triple' } = {}) {
  const planner = new Set();
  const reviewer = new Set();
  if (state === 'drafting') {
    planner.add('plan');
    planner.add('tasks');
  } else if (state === 'revising') {
    planner.add('revision');
  } else if (state === 'reviewing') {
    reviewer.add('review');
  } else if (state === 'final-review') {
    reviewer.add('final');
  }
  if (role === 'planner') return [...planner];
  if (role === 'reviewer') return [...reviewer];
  if (role === 'planner-or-reviewer' && roleBindingMode === 'dual') {
    return [...new Set([...planner, ...reviewer])];
  }
  return [];
}

/**
 * 当前状态下 Reviewer 该写的 slot（review 还是 final）。
 * running 时按 round 与 rejection_limit 预判（§5.3 T5/T6）。
 */
export function reviewSlotFor(state, { round, rejectionLimit }) {
  if (state === 'final-review') return 'final';
  if (state !== 'running' && state !== 'reviewing') return null;
  return Number(round) > Number(rejectionLimit) ? 'final' : 'review';
}

function bumpFormatViolation(task) {
  const next = { ...task, format_violation_count: (task.format_violation_count ?? 0) + 1 };
  if (next.format_violation_count >= FORMAT_VIOLATION_LIMIT) {
    return {
      ...next,
      state: 'escalated',
      last_event: `T15 drafting -> escalated（同一轮违约连续 ${next.format_violation_count} 次）`,
    };
  }
  return {
    ...next,
    state: 'drafting',
    last_event: `T2 drafting -> drafting（违约第 ${next.format_violation_count} 次，原地重写，不占驳回轮次）`,
  };
}

function bumpProtocolRetry(task) {
  const next = { ...task, protocol_retry_count: (task.protocol_retry_count ?? 0) + 1 };
  if (next.protocol_retry_count >= PROTOCOL_RETRY_LIMIT) {
    return {
      ...next,
      state: 'escalated',
      last_event: `T15 ${task.state} -> escalated（同一轮协议违规 ${next.protocol_retry_count} 次）`,
    };
  }
  return {
    ...next,
    last_event: `协议违规第 ${next.protocol_retry_count} 次，要求原地重写同一文件（round 与 rejection_count 不动）`,
  };
}

function bumpOverreach(task) {
  const next = { ...task, overreach_count: (task.overreach_count ?? 0) + 1 };
  if (next.overreach_count >= OVERREACH_LIMIT) {
    return {
      ...next,
      state: 'escalated',
      last_event: `T15 ${task.state} -> escalated（越权累计 ${next.overreach_count} 次）`,
    };
  }
  return { ...next, last_event: `越权第 ${next.overreach_count} 次（未达上限，记数后继续）` };
}

const EVENTS = Object.freeze([
  'submit',
  'format-violation',
  'plan-validated',
  'start-round',
  'executor-submit',
  'executor-blocked',
  'review-pass',
  'review-needs-revision',
  'revision-written',
  'final-pass',
  'final-needs-revision',
  'unblock',
  'abort',
  'escalate',
  'overreach',
  'protocol-violation',
]);

export const EVENT_NAMES = EVENTS;

/** 关掉协作开关时不允许的转移（§5.5：不启新任务、不重启旧任务）。 */
const BLOCKED_WHEN_DISABLED = Object.freeze(['submit', 'start-round', 'revision-written', 'unblock']);

/**
 * 状态转移。
 * @param {object} task 当前任务 state
 * @param {string} event 事件名
 * @param {object} opts { now, rejectionLimit, collabEnabled, note }
 * @returns {{ ok: boolean, state: object, error?: string }}
 */
export function reduce(task, event, { now = Date.now(), rejectionLimit = 2, collabEnabled = true, note } = {}) {
  const stamp = (next) => ({ ...next, updated_at: Number(now) || Date.now() });
  const fail = (error) => ({ ok: false, state: task, error });

  if (!task || !STATES.includes(task.state)) return fail(`任务状态非法：${String(task?.state)}`);
  if (!EVENTS.includes(event)) return fail(`unknown event "${event}"`);

  const from = task.state;
  const terminal = isTerminal(from);

  if (collabEnabled === false && BLOCKED_WHEN_DISABLED.includes(event)) {
    return fail(`协作开关已关，不允许 ${event}（不启新任务、不重启旧任务；在跑的只许走到终态）`);
  }

  switch (event) {
    case 'submit': {
      if (from !== 'drafting') return fail(`submit 只能从 drafting 出发，当前是 ${from}`);
      return { ok: true, state: stamp({ ...task, last_event: 'T1 drafting（用户提交需求）' }) };
    }

    case 'format-violation': {
      if (from !== 'drafting') return fail(`format-violation 只在 drafting 有意义，当前是 ${from}`);
      return { ok: true, state: stamp(bumpFormatViolation(task)) };
    }

    case 'plan-validated': {
      if (from !== 'drafting') return fail(`plan-validated 只能从 drafting 出发，当前是 ${from}`);
      if ((task.format_violation_count ?? 0) >= FORMAT_VIOLATION_LIMIT) {
        return fail('违约次数已达上限，不能进入 ready');
      }
      return {
        ok: true,
        state: stamp({
          ...task,
          state: 'ready',
          format_violation_count: 0,
          last_event: 'T3 drafting -> ready（02 与 03 均通过校验）',
        }),
      };
    }

    case 'start-round': {
      if (from !== 'ready') return fail(`start-round 只能从 ready 出发，当前是 ${from}`);
      if (Number(task.round) !== 1) {
        return fail(`T4 只把 round=1 的任务推进到 running，当前 round=${task.round}`);
      }
      return {
        ok: true,
        state: stamp({
          ...task,
          state: 'running',
          format_violation_count: 0,
          protocol_retry_count: 0,
          last_event: 'T4 ready -> running（round=1）',
        }),
      };
    }

    case 'executor-submit': {
      if (from !== 'running') return fail(`executor-submit 只能从 running 出发，当前是 ${from}`);
      const round = Number(task.round);
      const limit = Number(rejectionLimit);
      // summary 只进 last_event，绝不进 Reviewer 输入（§6.8）。
      const tail = note ? `｜${note}` : '';
      if (round > limit) {
        return {
          ok: true,
          state: stamp({
            ...task,
            state: 'final-review',
            protocol_retry_count: 0,
            last_event: `T6 running -> final-review（round ${round} > 上限 ${limit}）${tail}`,
          }),
        };
      }
      return {
        ok: true,
        state: stamp({
          ...task,
          state: 'reviewing',
          protocol_retry_count: 0,
          last_event: `T5 running -> reviewing（round ${round} <= 上限 ${limit}）${tail}`,
        }),
      };
    }

    case 'executor-blocked': {
      if (from !== 'running') return fail(`executor-blocked 只能从 running 出发，当前是 ${from}`);
      return {
        ok: true,
        state: stamp({
          ...task,
          state: 'blocked',
          last_event: `T7 running -> blocked${note ? `（${note}）` : ''}`,
        }),
      };
    }

    case 'review-pass': {
      if (from !== 'reviewing') return fail(`review-pass 只能从 reviewing 出发，当前是 ${from}`);
      return {
        ok: true,
        state: stamp({ ...task, state: 'done', last_event: 'T8 reviewing -> done（verdict=pass，跳过 05 与 06）' }),
      };
    }

    case 'review-needs-revision': {
      if (from !== 'reviewing') return fail(`review-needs-revision 只能从 reviewing 出发，当前是 ${from}`);
      const rejection = (task.rejection_count ?? 0) + 1;
      if (rejection > Number(rejectionLimit)) {
        return fail(`驳回次数已达上限 ${rejectionLimit}，应走 final-review 而不是 revising`);
      }
      return {
        ok: true,
        state: stamp({
          ...task,
          state: 'revising',
          rejection_count: rejection,
          protocol_retry_count: 0,
          last_event: `T9 reviewing -> revising（verdict=needs_revision，第 ${rejection} 次驳回）`,
        }),
      };
    }

    case 'revision-written': {
      if (from !== 'revising') return fail(`revision-written 只能从 revising 出发，当前是 ${from}`);
      return {
        ok: true,
        state: stamp({
          ...task,
          state: 'running',
          round: Number(task.round) + 1,
          format_violation_count: 0,
          protocol_retry_count: 0,
          last_event: `T10 revising -> running（05 已写，round -> ${Number(task.round) + 1}）`,
        }),
      };
    }

    case 'final-pass': {
      if (from !== 'final-review') return fail(`final-pass 只能从 final-review 出发，当前是 ${from}`);
      return {
        ok: true,
        state: stamp({ ...task, state: 'done', last_event: 'T11 final-review -> done（终审通过）' }),
      };
    }

    case 'final-needs-revision': {
      if (from !== 'final-review') return fail(`final-needs-revision 只能从 final-review 出发，当前是 ${from}`);
      return {
        ok: true,
        state: stamp({ ...task, state: 'escalated', last_event: 'T12 final-review -> escalated（终审仍未通过）' }),
      };
    }

    case 'unblock': {
      if (from !== 'blocked') return fail(`unblock 只能从 blocked 出发，当前是 ${from}`);
      return {
        ok: true,
        state: stamp({
          ...task,
          state: 'drafting',
          round: 1,
          rejection_count: 0,
          format_violation_count: 0,
          protocol_retry_count: 0,
          last_event: 'T13 blocked -> drafting（用户交回，round 归 1）',
        }),
      };
    }

    case 'abort': {
      if (terminal) return fail(`任务已在终态 ${from}，不能再 abort`);
      return {
        ok: true,
        state: stamp({ ...task, state: 'aborted', last_event: `T14 ${from} -> aborted（用户中止）` }),
      };
    }

    case 'escalate': {
      if (terminal) return fail(`任务已在终态 ${from}，不能再 escalate`);
      return {
        ok: true,
        state: stamp({ ...task, state: 'escalated', last_event: `T15 ${from} -> escalated${note ? `（${note}）` : ''}` }),
      };
    }

    case 'overreach': {
      if (terminal) return fail(`任务已在终态 ${from}，越权记数无意义`);
      return { ok: true, state: stamp(bumpOverreach(task)) };
    }

    case 'protocol-violation': {
      if (terminal) return fail(`任务已在终态 ${from}，协议违规记数无意义`);
      if (from !== 'reviewing' && from !== 'final-review') {
        return fail(`protocol-violation 只在审核阶段有意义，当前是 ${from}`);
      }
      return { ok: true, state: stamp(bumpProtocolRetry(task)) };
    }

    default:
      return fail(`unknown event "${event}"`);
  }
}

/** 当前状态允许的事件（UI 与工具用它决定按钮可见性）。 */
export function allowedEvents(state, { collabEnabled = true } = {}) {
  const map = {
    drafting: ['format-violation', 'plan-validated'],
    ready: ['start-round'],
    running: ['executor-submit', 'executor-blocked'],
    reviewing: ['review-pass', 'review-needs-revision', 'protocol-violation'],
    revising: ['revision-written'],
    'final-review': ['final-pass', 'final-needs-revision', 'protocol-violation'],
    done: [],
    blocked: ['unblock'],
    escalated: [],
    aborted: [],
  };
  const base = map[state] ?? [];
  const tail = isTerminal(state) ? [] : ['abort', 'escalate', 'overreach'];
  const events = [...base, ...tail];
  if (collabEnabled === false) return events.filter((e) => !BLOCKED_WHEN_DISABLED.includes(e));
  return events;
}
