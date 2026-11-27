import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  READONLY_GLOBAL_TOOLS,
  ROLE_TITLES,
  actorSessionId,
  applyRoleIsolation,
  buildRolePrompt,
  coldStartDecision,
  computeReadonlyAllow,
  disposeRole,
  externalWakePayload,
  knownGlobalToolNames,
  makeTaskId,
  spawnInProcessRole,
} from '../../plugin/dsh-agy-collab/lib/v2/roles.js';

import {
  TOOL_NAMES,
  TOOL_SPECS,
  buildToolDefinitions,
  createAbortHandler,
  createCollabWriteHandler,
  createMarkBlockedHandler,
  createSubmitForReviewHandler,
  RENDER_DATA_MAX_CHARS,
  renderToolResult,
} from '../../plugin/dsh-agy-collab/lib/v2/tools.js';

import { createTaskState, reduce } from '../../plugin/dsh-agy-collab/lib/v2/state-machine.js';
import { createWorkspace, filePath } from '../../plugin/dsh-agy-collab/lib/v2/workspace.js';

const NOW = 1700000000000;

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v2-tools-'));
}

test('只读 allow 只取「已知 ∩ 白名单」，未知名绝不进 allow', () => {
  assert.deepEqual(computeReadonlyAllow(['read', 'glob', 'bash', 'write']), ['read', 'glob']);
  assert.deepEqual(computeReadonlyAllow([]), []);
  assert.deepEqual(computeReadonlyAllow(['bash']), []);
  // read_file 不是实名，不能出现在 allow 里（传进去会让 restrict 抛错）
  assert.deepEqual(computeReadonlyAllow(['read_file']), []);
  assert.equal(READONLY_GLOBAL_TOOLS.includes('read'), true);
  assert.equal(READONLY_GLOBAL_TOOLS.includes('read_file'), false);
});

test('applyRoleIsolation 先注册 collab_write 再 restrict，且 collab_write 不进 allow', () => {
  const calls = [];
  const agentCtx = {
    tools: {
      register: (def) => calls.push(['register', def?.name]),
      restrict: (filter) => calls.push(['restrict', filter]),
    },
  };
  const result = applyRoleIsolation(agentCtx, {
    role: 'planner',
    collabWriteTool: { name: TOOL_NAMES.write },
    knownGlobalTools: ['read', 'grep', 'bash'],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.allow, ['read', 'grep']);
  assert.deepEqual(calls[0], ['register', 'collab_write']);
  assert.deepEqual(calls[1], ['restrict', { allow: ['read', 'grep'] }]);
  assert.equal(calls[1][1].allow.includes('collab_write'), false);
});

test('applyRoleIsolation 在 restrict 抛错时返回 ok=false 而不是静默通过', () => {
  const agentCtx = {
    tools: {
      register: () => {},
      restrict: () => {
        throw new Error('tools.restrict() names unknown global tool(s) "read"');
      },
    },
  };
  const result = applyRoleIsolation(agentCtx, { role: 'planner', knownGlobalTools: ['read'] });
  assert.equal(result.ok, false);
  assert.match(result.error, /names unknown/);
});

test('knownGlobalToolNames 拿不到视图时返回空表（明确降级）', () => {
  assert.deepEqual(knownGlobalToolNames(null), []);
  assert.deepEqual(knownGlobalToolNames({ view: () => ({ knownNames: new Set(['read', 'bash']) }) }), ['read', 'bash']);
  assert.deepEqual(knownGlobalToolNames({ view: () => ({ restrictableNames: new Set(['read']) }) }), ['read']);
});

test('角色提示词：三种角色内容不同，且都讲清「不写 01 / 不写仓库」', () => {
  const base = { taskId: 't-1', workspaceDir: '/w', round: 1 };
  const planner = buildRolePrompt('planner', base);
  const reviewer = buildRolePrompt('reviewer', base);
  assert.match(planner, /03-任务清单/);
  assert.match(planner, /全流程只写一次/);
  assert.match(reviewer, /不要读 02-执行方案/);
  assert.match(reviewer, /主观叙述/);
  for (const text of [planner, reviewer]) {
    assert.match(text, /不写仓库文件/);
    assert.match(text, /collab_write/);
  }
  // 开关关闭时不提 subagent_count
  assert.equal(planner.includes('不要填 subagent_count'), true);
  const withEstimate = buildRolePrompt('planner', { ...base, estimateSubagents: true });
  assert.match(withEstimate, /预估主 agent 需要生成几个子 agent/);
  // 返工轮次提示
  const revising = buildRolePrompt('planner', { ...base, round: 2 });
  assert.match(revising, /review-r1\.md/);
  assert.match(revising, /revision-r1\.md/);
  // dual 模式提醒
  assert.match(buildRolePrompt('reviewer', { ...base, roleBindingMode: 'dual' }), /双 agent 模式/);
});

test('角色标题齐全（设置页要用）', () => {
  assert.deepEqual(Object.keys(ROLE_TITLES).sort(), ['executor', 'planner', 'reviewer']);
});

test('actorSessionId 带角色前缀且每次不同', () => {
  const a = actorSessionId('planner', 't-1');
  const b = actorSessionId('planner', 't-1');
  assert.match(a, /^agy-collab-planner-t-1-/);
  assert.notEqual(a, b);
});

test('makeTaskId 形态 t-YYYY-MMDD-NN', () => {
  const id = makeTaskId({ now: new Date('2026-11-25T10:00:00Z').getTime(), seq: 3 });
  assert.match(id, /^t-2026-11\d{2}-03$/);
});

test('spawnInProcessRole 在没有 agents 服务时明确报错', async () => {
  const result = await spawnInProcessRole({ role: 'planner', taskId: 't', workspaceDir: '/w' });
  assert.equal(result.ok, false);
  assert.match(result.error, /agents 服务不可用/);
});

test('spawnInProcessRole 拒绝非 planner/reviewer 角色', async () => {
  const result = await spawnInProcessRole({ agents: { create: async () => ({}) }, role: 'executor', taskId: 't', workspaceDir: '/w' });
  assert.equal(result.ok, false);
  assert.match(result.error, /只能是 planner 或 reviewer/);
});

test('spawnInProcessRole 走 setup 组合、create 之后才驱动', async () => {
  const order = [];
  const agents = {
    create: async ({ sessionId, meta, setup }) => {
      order.push('create');
      const agentCtx = {
        tools: {
          register: () => order.push('register'),
          restrict: (filter) => order.push(['restrict', filter.allow]),
        },
        systemPrompt: { section: () => order.push('prompt') },
      };
      await setup(agentCtx);
      return { agent: { whenIdle: async () => {}, followup: () => {} }, dispose: async () => {} };
    },
  };
  const result = await spawnInProcessRole({
    agents,
    role: 'planner',
    taskId: 't-1',
    workspaceDir: '/w',
    promptSection: { name: 'x', order: 1, text: 'p' },
    collabWriteTool: { name: TOOL_NAMES.write },
    knownGlobalTools: ['read'],
  });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(order[0], 'create');
  assert.ok(order.includes('register'));
  assert.ok(order.includes('prompt'));
  assert.deepEqual(result.allow, ['read']);
  assert.match(result.sessionId, /^agy-collab-planner-t-1-/);
});

test('spawnInProcessRole 在 setup 抛错时返回 ok=false', async () => {
  const agents = {
    create: async ({ setup }) => {
      await setup({ tools: { register: () => {}, restrict: () => { throw new Error('boom'); } } });
      return { agent: {}, dispose: async () => {} };
    },
  };
  const result = await spawnInProcessRole({ agents, role: 'reviewer', taskId: 't', workspaceDir: '/w', knownGlobalTools: ['read'] });
  assert.equal(result.ok, false);
  assert.match(result.error, /boom/);
});

test('disposeRole 幂等', async () => {
  assert.equal((await disposeRole(null)).ok, true);
  let disposed = 0;
  assert.equal((await disposeRole({ dispose: async () => { disposed += 1; } })).ok, true);
  assert.equal(disposed, 1);
});

test('冷启动判据看实例身份，不看 actor_id', () => {
  const shared = { id: 1 };
  assert.equal(coldStartDecision({ role: 'reviewer', plannerHandle: shared, reviewerHandle: shared }).cold, false);
  assert.equal(coldStartDecision({ role: 'reviewer', plannerHandle: { id: 1 }, reviewerHandle: { id: 2 } }).cold, true);
  assert.equal(coldStartDecision({ role: 'planner' }).cold, true);
});

test('进程外唤醒载荷带 cold 与 handled_in 要求', () => {
  const payload = externalWakePayload({ role: 'reviewer', taskId: 't', workspaceDir: '/w', round: 2, cold: true });
  assert.equal(payload.cold, true);
  assert.equal(payload.must_report_handled_in, true);
  assert.equal(payload.round, 2);
});

test('工具描述齐全且名字固定', () => {
  assert.equal(TOOL_SPECS.length, 4);
  const names = TOOL_SPECS.map((s) => s.name).sort();
  assert.deepEqual(names, ['collab_abort', 'collab_mark_blocked', 'collab_submit_for_review', 'collab_write'].sort());
  const write = TOOL_SPECS.find((s) => s.name === TOOL_NAMES.write);
  assert.deepEqual(write.parameters.required, ['slot', 'filename', 'content']);
  assert.equal(write.parameters.properties.slot.enum.includes('request'), false, 'slot 枚举里根本没有 01');
});

// ── collab_write 四条校验 ──────────────────────────────────────────

function makeWriteFixture({ state = 'drafting', role = 'planner', roleBindingMode = 'triple', reviewerMode = 'strict' } = {}) {
  const root = tmpRoot();
  const paths = createWorkspace({ root, hostPid: 1, bootId: 'abcdef', sessionId: 's', taskId: 't-1' });
  let task = createTaskState({ taskId: 't-1', now: NOW });
  if (state !== 'drafting') task = { ...task, state };
  const events = [];
  const handler = createCollabWriteHandler({
    getTask: () => task,
    getRole: () => role,
    getRoleBindingMode: () => roleBindingMode,
    getReviewerMode: () => reviewerMode,
    getPaths: () => paths,
    getRequirementIds: () => ['R1'],
    applyEvent: (event, opts) => {
      events.push([event, opts]);
      const r = reduce(task, event, { now: NOW, rejectionLimit: 2 });
      if (r.ok) task = r.state;
      return r;
    },
    now: () => NOW,
  });
  return { root, paths, handler, events, getTask: () => task };
}

const GOOD_TASKS = [
  '---',
  'task_id: t-1',
  'stage: tasks',
  'author: planner',
  'round: 0',
  'written_at: 2026-11-25T19:52:04+08:00',
  'requirements:',
  '  - id: R1',
  '    text: 第一条需求',
  '---',
  '',
  '## R1',
  '要做到这个。',
].join('\n');

test('collab_write 校验 1：slot 不在角色可写集合 → 越权记数', async () => {
  const fx = makeWriteFixture({ state: 'drafting', role: 'reviewer' });
  const result = await fx.handler({ slot: 'tasks', filename: 'tasks.md', content: GOOD_TASKS });
  assert.equal(result.ok, false);
  assert.match(result.message, /不能写 slot/);
  assert.equal(fx.events[0][0], 'overreach');
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('collab_write 校验 1：request 永远不在可写集合里', async () => {
  const fx = makeWriteFixture({ state: 'drafting', role: 'planner' });
  const result = await fx.handler({ slot: 'request', filename: 'request.md', content: 'x' });
  assert.equal(result.ok, false);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('collab_write 校验 2：文件名必须在本阶段允许清单', async () => {
  const fx = makeWriteFixture({ state: 'drafting', role: 'planner' });
  const result = await fx.handler({ slot: 'tasks', filename: 'tasks-r2.md', content: GOOD_TASKS });
  assert.equal(result.ok, false);
  assert.match(result.message, /不在本阶段允许清单/);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('collab_write 校验 3：tasks.md 违约走 format-violation 且不占驳回轮次', async () => {
  const fx = makeWriteFixture({ state: 'drafting', role: 'planner' });
  const bad = GOOD_TASKS.replace('requirements:', 'steps:\n  - id: S1\n    purpose: x\nrequirements:');
  const result = await fx.handler({ slot: 'tasks', filename: 'tasks.md', content: bad });
  assert.equal(result.ok, false);
  assert.equal(result.data.formatViolation, true);
  assert.equal(fx.events[0][0], 'format-violation');
  assert.equal(fx.getTask().rejection_count, 0);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('collab_write 校验 4：写成功后快照 diff 恰好一个文件', async () => {
  const fx = makeWriteFixture({ state: 'drafting', role: 'planner' });
  const result = await fx.handler({ slot: 'tasks', filename: 'tasks.md', content: GOOD_TASKS });
  assert.equal(result.ok, true, result.message);
  assert.ok(fs.existsSync(filePath(fx.paths, 'tasks', 'tasks.md')));
  assert.equal(fx.events.length, 0, '干净写入不该触发越权');
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('collab_write 校验 3：review 的 requirement_ref 幻觉被拦下', async () => {
  const fx = makeWriteFixture({ state: 'reviewing', role: 'reviewer' });
  const doc = [
    '---',
    'task_id: t-1',
    'stage: review',
    'author: reviewer',
    'round: 1',
    'written_at: 2026-11-25T19:52:04+08:00',
    'verdict: needs_revision',
    'findings:',
    '  - id: F1',
    '    requirement_ref: R9',
    '    problem: 没做',
    '    required_fix: 补上',
    '---',
    '',
    '正文。',
  ].join('\n');
  const result = await fx.handler({ slot: 'review', filename: 'review-r1.md', content: doc });
  assert.equal(result.ok, false);
  assert.match(result.message, /幻觉引用/);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('collab_write 在 revision 阶段只许 revision-r<round>', async () => {
  const fx = makeWriteFixture({ state: 'revising', role: 'planner' });
  const task = { ...fx.getTask(), round: 2 };
  const handler = createCollabWriteHandler({
    getTask: () => task,
    getRole: () => 'planner',
    getPaths: () => fx.paths,
    applyEvent: () => ({ ok: true }),
  });
  const wrong = await handler({ slot: 'revision', filename: 'revision-r1.md', content: '---\ntask_id: t-1\nstage: revision\nauthor: planner\nround: 2\nwritten_at: x\n---\n正文' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /不在本阶段允许清单/);
  const right = await handler({ slot: 'revision', filename: 'revision-r2.md', content: '---\ntask_id: t-1\nstage: revision\nauthor: planner\nround: 2\nwritten_at: x\n---\n正文' });
  assert.equal(right.ok, true, right.message);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

// ── Executor 触发点 ────────────────────────────────────────────────

test('collab_submit_for_review 只在 running 可用', async () => {
  let task = createTaskState({ taskId: 't', now: NOW });
  const applyEvent = (event, opts) => {
    const r = reduce(task, event, { now: NOW, rejectionLimit: 2, ...opts });
    if (r.ok) task = r.state;
    return r;
  };
  const handler = createSubmitForReviewHandler({ getTask: () => task, applyEvent });
  const early = await handler({ summary: 'x' });
  assert.equal(early.ok, false);
  assert.match(early.message, /只在 running/);

  task = { ...task, state: 'running' };
  const ok = await handler({ summary: '改了 3 个文件' });
  assert.equal(ok.ok, true);
  assert.equal(task.state, 'reviewing');
  assert.match(task.last_event, /改了 3 个文件/);
});

test('collab_mark_blocked 的 reason 必填', async () => {
  let task = { ...createTaskState({ taskId: 't', now: NOW }), state: 'running' };
  const applyEvent = (event, opts) => {
    const r = reduce(task, event, { now: NOW, rejectionLimit: 2, ...opts });
    if (r.ok) task = r.state;
    return r;
  };
  const handler = createMarkBlockedHandler({ getTask: () => task, applyEvent });
  assert.equal((await handler({})).ok, false);
  const ok = await handler({ reason: '需求不清' });
  assert.equal(ok.ok, true);
  assert.equal(task.state, 'blocked');
});

test('collab_abort 在终态被拒绝', async () => {
  const task = { ...createTaskState({ taskId: 't', now: NOW }), state: 'done' };
  const handler = createAbortHandler({ getTask: () => task, applyEvent: (e, o) => reduce(task, e, { now: NOW, ...o }) });
  const result = await handler({});
  assert.equal(result.ok, false);
});

test('buildToolDefinitions 用注入的 defineTool 包出四个工具', () => {
  const seen = [];
  const defineTool = (spec) => {
    seen.push(spec.name);
    return spec;
  };
  const handlers = {
    [TOOL_NAMES.write]: async () => ({ ok: true, message: 'w' }),
    [TOOL_NAMES.submit]: async () => ({ ok: true, message: 's' }),
    [TOOL_NAMES.blocked]: async () => ({ ok: true, message: 'b' }),
    [TOOL_NAMES.abort]: async () => ({ ok: true, message: 'a' }),
  };
  const defs = buildToolDefinitions({ defineTool, handlers });
  assert.equal(defs.length, 4);
  assert.deepEqual(seen.sort(), ['collab_abort', 'collab_mark_blocked', 'collab_submit_for_review', 'collab_write']);
  // 只给部分处理器时只装配那一部分（不同角色拿到不同子集）
  const subset = buildToolDefinitions({ defineTool, handlers: { [TOOL_NAMES.write]: handlers[TOOL_NAMES.write] } });
  assert.deepEqual(subset.map((d) => d.name), [TOOL_NAMES.write]);
  assert.throws(() => buildToolDefinitions({ defineTool, handlers: {} }), /至少需要一个处理器/);
});

test('renderToolResult 成功与失败两种前缀', () => {
  assert.match(renderToolResult({ ok: true, message: '好的' }), /^✅ 好的$/);
  assert.match(renderToolResult({ ok: false, message: '不行' }), /^❌ 不行$/);
  assert.equal(renderToolResult(null), '');
});

test('renderToolResult 把 data 一并渲染给模型（否则 instruction / task_root 全丢）', () => {
  const text = renderToolResult({
    ok: true,
    message: '审核驳回，请按下面这段返工。',
    data: {
      task_root: 'C:/ws/t-1',
      plan_path: 'C:/ws/t-1/02-执行方案/plan.md',
      tasks_path: 'C:/ws/t-1/03-任务清单/tasks.md',
      findings: [{ id: 'F1', required_fix: '加 min/max 校验' }],
      instruction: '第 2 轮返工。',
    },
  });
  const lines = text.split('\n');
  assert.equal(lines[0], '✅ 审核驳回，请按下面这段返工。', '首行仍是状态行');
  const json = JSON.parse(lines.slice(1).join('\n'));
  assert.equal(json.task_root, 'C:/ws/t-1');
  assert.equal(json.plan_path, 'C:/ws/t-1/02-执行方案/plan.md');
  assert.equal(json.tasks_path, 'C:/ws/t-1/03-任务清单/tasks.md');
  assert.equal(json.findings[0].required_fix, '加 min/max 校验');
  assert.equal(json.instruction, '第 2 轮返工。');
});

test('renderToolResult 的 data 为空时不追加，超长时截断并注明', () => {
  assert.match(renderToolResult({ ok: true, message: 'x', data: {} }), /^✅ x$/);
  assert.match(renderToolResult({ ok: true, message: 'x', data: [] }), /^✅ x$/);

  const huge = renderToolResult({ ok: true, message: 'x', data: { blob: 'a'.repeat(RENDER_DATA_MAX_CHARS * 2) } });
  assert.ok(huge.length < RENDER_DATA_MAX_CHARS * 2, '必须截断');
  assert.match(huge, /data 已截断/);
  // 截断后不该留下半截 JSON 还能被当成完整对象解析 —— 这里只要求带明确说明
  assert.ok(huge.startsWith('✅ x\n'));
});
