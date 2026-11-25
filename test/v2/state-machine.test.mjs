import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATES,
  TERMINAL_STATES,
  PHASES,
  OVERREACH_LIMIT,
  FORMAT_VIOLATION_LIMIT,
  PROTOCOL_RETRY_LIMIT,
  createTaskState,
  reduce,
  isTerminal,
  phaseOf,
  writableSlots,
  reviewSlotFor,
  allowedEvents,
} from '../../plugin/dsh-agy-collab/lib/v2/state-machine.js';

const NOW = 1700000000000;

function fresh(extra = {}) {
  return { ...createTaskState({ taskId: 't-1', executorSessionId: 'sess-1', now: NOW }), ...extra };
}

function toReady(task = fresh()) {
  const a = reduce(task, 'plan-validated', { now: NOW });
  assert.equal(a.ok, true, a.error);
  return a.state;
}

function toRunning() {
  const ready = toReady();
  const b = reduce(ready, 'start-round', { now: NOW });
  assert.equal(b.ok, true, b.error);
  return b.state;
}

test('十个状态与五个阶段映射齐全', () => {
  assert.equal(STATES.length, 10);
  for (const s of STATES) assert.ok(PHASES[s], `缺阶段映射：${s}`);
  assert.deepEqual([...TERMINAL_STATES].sort(), ['aborted', 'blocked', 'done', 'escalated']);
});

test('新任务从 drafting 开始，round=1，四个计数器归零', () => {
  const task = fresh();
  assert.equal(task.state, 'drafting');
  assert.equal(task.round, 1);
  for (const key of ['rejection_count', 'overreach_count', 'format_violation_count', 'protocol_retry_count']) {
    assert.equal(task[key], 0);
  }
});

test('T3 → T4 → T5 主线：drafting→ready→running→reviewing', () => {
  const ready = toReady();
  assert.equal(ready.state, 'ready');
  const running = reduce(ready, 'start-round', { now: NOW }).state;
  assert.equal(running.state, 'running');
  const reviewing = reduce(running, 'executor-submit', { now: NOW, rejectionLimit: 2 }).state;
  assert.equal(reviewing.state, 'reviewing');
});

test('T8 首发通过：reviewing→done，跳过 05 与 06', () => {
  const running = toRunning();
  const reviewing = reduce(running, 'executor-submit', { now: NOW, rejectionLimit: 2 }).state;
  const done = reduce(reviewing, 'review-pass', { now: NOW }).state;
  assert.equal(done.state, 'done');
  assert.equal(done.rejection_count, 0);
  assert.match(done.last_event, /跳过 05 与 06/);
});

test('T9 驳回一次 → revising，rejection_count=1', () => {
  const running = toRunning();
  const reviewing = reduce(running, 'executor-submit', { now: NOW, rejectionLimit: 2 }).state;
  const revising = reduce(reviewing, 'review-needs-revision', { now: NOW, rejectionLimit: 2 }).state;
  assert.equal(revising.state, 'revising');
  assert.equal(revising.rejection_count, 1);
});

test('T10 返工写完 → running 且 round+1', () => {
  let task = toRunning();
  task = reduce(task, 'executor-submit', { now: NOW, rejectionLimit: 2 }).state;
  task = reduce(task, 'review-needs-revision', { now: NOW, rejectionLimit: 2 }).state;
  const next = reduce(task, 'revision-written', { now: NOW, rejectionLimit: 2 }).state;
  assert.equal(next.state, 'running');
  assert.equal(next.round, 2);
});

test('驳回次数超上限不许再进 revising（应走终审）', () => {
  const reviewing = reduce(toRunning(), 'executor-submit', { now: NOW, rejectionLimit: 2 }).state;
  const full = { ...reviewing, rejection_count: 2 };
  const result = reduce(full, 'review-needs-revision', { now: NOW, rejectionLimit: 2 });
  assert.equal(result.ok, false);
  assert.match(result.error, /上限/);
});

test('T6 round 超过上限时 executor-submit 直接进 final-review', () => {
  const running = { ...toRunning(), round: 3 };
  const next = reduce(running, 'executor-submit', { now: NOW, rejectionLimit: 2 }).state;
  assert.equal(next.state, 'final-review');
});

test('T11 / T12：终审通过 → done，终审驳回 → escalated', () => {
  const finalReview = { ...toRunning(), state: 'final-review', round: 3 };
  assert.equal(reduce(finalReview, 'final-pass', { now: NOW }).state.state, 'done');
  assert.equal(reduce(finalReview, 'final-needs-revision', { now: NOW }).state.state, 'escalated');
});

test('T7 / T13：blocked 与交回后 round 归 1', () => {
  const running = { ...toRunning(), round: 2, rejection_count: 1 };
  const blocked = reduce(running, 'executor-blocked', { now: NOW, note: '需求不清' }).state;
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.last_event, /需求不清/);
  const back = reduce(blocked, 'unblock', { now: NOW }).state;
  assert.equal(back.state, 'drafting');
  assert.equal(back.round, 1);
  assert.equal(back.rejection_count, 0);
});

test('T14 中止：非终态可中止，终态拒绝', () => {
  assert.equal(reduce(fresh(), 'abort', { now: NOW }).state.state, 'aborted');
  const done = { ...fresh(), state: 'done' };
  assert.equal(reduce(done, 'abort', { now: NOW }).ok, false);
});

test('格式违约连续 3 次 → escalated，且 rejection_count 不动', () => {
  let task = fresh();
  for (let i = 1; i < FORMAT_VIOLATION_LIMIT; i += 1) {
    const r = reduce(task, 'format-violation', { now: NOW });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.state.state, 'drafting', `第 ${i} 次违约仍应停在 drafting`);
    assert.equal(r.state.rejection_count, 0);
    task = r.state;
  }
  const third = reduce(task, 'format-violation', { now: NOW });
  assert.equal(third.state.state, 'escalated');
  assert.equal(third.state.format_violation_count, FORMAT_VIOLATION_LIMIT);
  assert.equal(third.state.rejection_count, 0, '违约不占驳回轮次');
});

test('违约计数在进入 ready 时清零', () => {
  const once = reduce(fresh(), 'format-violation', { now: NOW }).state;
  assert.equal(once.format_violation_count, 1);
  const ready = reduce(once, 'plan-validated', { now: NOW }).state;
  assert.equal(ready.format_violation_count, 0);
});

test('越权累计 2 次 → escalated', () => {
  let task = toRunning();
  const first = reduce(task, 'overreach', { now: NOW });
  assert.equal(first.ok, true);
  assert.equal(first.state.state, 'running', '第一次越权不升级');
  assert.equal(first.state.overreach_count, 1);
  const second = reduce(first.state, 'overreach', { now: NOW });
  assert.equal(second.state.state, 'escalated');
  assert.equal(second.state.overreach_count, OVERREACH_LIMIT);
});

test('协议违规同轮 2 次 → escalated；只在审核阶段有意义', () => {
  const reviewing = reduce(toRunning(), 'executor-submit', { now: NOW, rejectionLimit: 2 }).state;
  const first = reduce(reviewing, 'protocol-violation', { now: NOW });
  assert.equal(first.ok, true);
  assert.equal(first.state.state, 'reviewing', '第一次违规原地重写，状态不变');
  assert.equal(first.state.protocol_retry_count, 1);
  const second = reduce(first.state, 'protocol-violation', { now: NOW });
  assert.equal(second.state.state, 'escalated');
  assert.equal(second.state.protocol_retry_count, PROTOCOL_RETRY_LIMIT);

  assert.equal(reduce(fresh(), 'protocol-violation', { now: NOW }).ok, false);
});

test('协作开关关闭时不许启新任务 / 重启旧任务', () => {
  const result = reduce(toReady(), 'start-round', { now: NOW, collabEnabled: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /协作开关已关/);

  // 但在跑的允许走到终态
  const running = toRunning();
  const submit = reduce(running, 'executor-submit', { now: NOW, rejectionLimit: 2, collabEnabled: false });
  assert.equal(submit.ok, true);
  assert.equal(submit.state.state, 'reviewing');
});

test('非法事件与非法状态都报错，不静默通过', () => {
  assert.equal(reduce(fresh(), 'not-an-event', { now: NOW }).ok, false);
  assert.equal(reduce({ state: 'nonsense' }, 'submit', { now: NOW }).ok, false);
});

test('可写 slot 随角色与状态变化（§6.2）', () => {
  assert.deepEqual(writableSlots('planner', 'drafting').sort(), ['plan', 'tasks']);
  assert.deepEqual(writableSlots('planner', 'revising'), ['revision']);
  assert.deepEqual(writableSlots('reviewer', 'reviewing'), ['review']);
  assert.deepEqual(writableSlots('reviewer', 'final-review'), ['final']);
  assert.deepEqual(writableSlots('planner', 'running'), []);
  assert.deepEqual(writableSlots('executor', 'drafting'), []);
  // dual 模式下同一 actor 两槽合一
  assert.deepEqual(writableSlots('planner-or-reviewer', 'reviewing', { roleBindingMode: 'dual' }), ['review']);
  assert.deepEqual(writableSlots('planner-or-reviewer', 'reviewing', { roleBindingMode: 'triple' }), []);
});

test('reviewSlotFor 按 round 与上限决定写 04 还是 06', () => {
  assert.equal(reviewSlotFor('reviewing', { round: 1, rejectionLimit: 2 }), 'review');
  assert.equal(reviewSlotFor('running', { round: 2, rejectionLimit: 2 }), 'review');
  assert.equal(reviewSlotFor('running', { round: 3, rejectionLimit: 2 }), 'final');
  assert.equal(reviewSlotFor('final-review', { round: 3, rejectionLimit: 2 }), 'final');
  assert.equal(reviewSlotFor('drafting', { round: 1, rejectionLimit: 2 }), null);
});

test('allowedEvents 与状态一致，终态无事件', () => {
  assert.deepEqual(allowedEvents('done'), []);
  assert.deepEqual(allowedEvents('running').sort(), ['abort', 'escalate', 'executor-blocked', 'executor-submit', 'overreach'].sort());
  const disabled = allowedEvents('ready', { collabEnabled: false });
  assert.equal(disabled.includes('start-round'), false);
});

test('isTerminal / phaseOf', () => {
  assert.equal(isTerminal('done'), true);
  assert.equal(isTerminal('running'), false);
  assert.equal(phaseOf('revising'), '返工');
  assert.equal(phaseOf('unknown'), '未知');
});
