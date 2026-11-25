import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultConfig, setCollabEnabled, setGlobalEnabled } from '../../plugin/dsh-agy-collab/lib/v2/config.js';
import { createOrchestrator, readTaskState, readArtifact } from '../../plugin/dsh-agy-collab/lib/v2/orchestrator.js';
import { WORKSPACE_DIRS, filePath } from '../../plugin/dsh-agy-collab/lib/v2/workspace.js';

const NOW = 1700000000000;

function tmpDir(prefix = 'agy-v2-orch-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tasksDoc(round = 0) {
  return [
    '---',
    'task_id: t-1',
    'stage: tasks',
    'author: planner',
    `round: ${round}`,
    'written_at: 2026-11-25T19:52:04+08:00',
    'requirements:',
    '  - id: R1',
    '    text: 设置页能改驳回上限',
    '---',
    '',
    '## R1',
    '要能在设置页改，范围 1-5。',
  ].join('\n');
}

function planDoc() {
  return [
    '---',
    'task_id: t-1',
    'stage: plan',
    'author: planner',
    'round: 0',
    'written_at: 2026-11-25T19:52:04+08:00',
    'steps:',
    '  - id: S1',
    '    purpose: 读现有设置页代码',
    '    tools: [read, grep]',
    '---',
    '',
    '先读，再改。',
  ].join('\n');
}

function reviewDoc({ round = 1, verdict = 'needs_revision', ref = 'R1' } = {}) {
  const findings = verdict === 'pass'
    ? ''
    : ['findings:', '  - id: F1', `    requirement_ref: ${ref}`, '    severity: high', '    problem: 没有范围限制', '    required_fix: 加 min/max 校验'].join('\n');
  return [
    '---',
    'task_id: t-1',
    'stage: review',
    'author: reviewer',
    `round: ${round}`,
    'written_at: 2026-11-25T19:52:04+08:00',
    `verdict: ${verdict}`,
    findings,
    '---',
    '',
    '审核正文。',
  ].filter((l) => l !== '').join('\n');
}

function finalDoc({ verdict = 'pass' } = {}) {
  const findings = verdict === 'pass'
    ? ''
    : ['findings:', '  - id: F1', '    requirement_ref: R1', '    problem: 还是没做', '    required_fix: 补上'].join('\n');
  return [
    '---',
    'task_id: t-1',
    'stage: final',
    'author: reviewer',
    'round: 3',
    'written_at: 2026-11-25T19:52:04+08:00',
    `verdict: ${verdict}`,
    findings,
    '---',
    '',
    '终审正文。',
  ].filter((l) => l !== '').join('\n');
}

function revisionDoc(round) {
  return [
    '---',
    'task_id: t-1',
    'stage: revision',
    'author: planner',
    `round: ${round}`,
    'written_at: 2026-11-25T19:52:04+08:00',
    '---',
    '',
    '按 findings 改：加 min/max 校验。',
  ].join('\n');
}

/**
 * 假 agents 服务：create 时跑 setup（注册工具 + restrict），
 * followup 时执行剧本（用 collab_write 写文件），whenIdle 立刻返回。
 */
function makeFakeAgents(script) {
  const record = { created: [], restrictCalls: [], registered: [], promptSections: [] };
  const agents = {
    create: async ({ sessionId, meta, setup }) => {
      record.created.push({ sessionId, meta });
      const registered = [];
      const agentCtx = {
        tools: {
          register: (def) => registered.push(def),
          restrict: (filter) => record.restrictCalls.push(filter),
        },
        systemPrompt: {
          section: (spec) => record.promptSections.push(spec),
        },
      };
      await setup(agentCtx);
      record.registered.push(registered.map((d) => d.name));
      const role = sessionId.includes('planner') ? 'planner' : 'reviewer';
      // 剧本里的工具调用会在 followup 之后、whenIdle resolve 之前完成 —— 与真实宿主一致。
      const inflight = [];
      const agent = {
        whenIdle: async () => {
          while (inflight.length) await Promise.all(inflight.splice(0));
        },
        followup: () => {
          script({ role, registered, taskRoot: meta.cwd, pending: inflight });
        },
      };
      return { agent, dispose: async () => {} };
    },
  };
  return { agents, record };
}

function makeDefineTool() {
  return (spec) => ({ name: spec.name, execute: spec.execute, description: spec.description });
}

/** 让剧本能同步调用异步的 collab_write：promise 进 inflight，由 whenIdle 统一等待。 */
function writeVia(registered, args, pending) {
  const tool = registered.find((d) => d.name === 'collab_write');
  assert.ok(tool, '角色没有拿到 collab_write');
  pending.push(tool.execute(args));
}

function makeOrchestrator({ script, config, dataDir, root, runGit = null }) {
  const { agents, record } = makeFakeAgents(script);
  const orch = createOrchestrator({
    dataDir,
    config,
    agents,
    defineTool: makeDefineTool(),
    knownGlobalTools: ['read', 'grep', 'glob', 'bash', 'write'],
    now: () => NOW,
    runGit,
    log: () => {},
  });
  // 把 workspaceRoot 指到临时目录，避免碰到真实 home
  config.workspaceRoot = root;
  return { orch, record };
}

function enabledConfig(root) {
  let config = defaultConfig(NOW);
  config = setGlobalEnabled(config, true);
  config = setCollabEnabled(config, 'sess-1', true);
  config.workspaceRoot = root;
  return config;
}

test('Planner 什么都没写时 runDrafting 明确失败，不假装成功', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const { orch } = makeOrchestrator({
    config: enabledConfig(root),
    dataDir,
    root,
    script: () => {},
  });
  orch.boot();
  const started = orch.startTask({ sessionId: 'sess-1', requestText: '需求' });
  assert.ok(fs.existsSync(filePath(started.paths, 'request', 'request.md')), '01 由 Host 写');
  const drafting = await orch.runDrafting();
  assert.equal(drafting.ok, false);
  assert.match(drafting.error, /没有写 02-执行方案\/plan\.md/);
  assert.equal(orch.getTask().state, 'drafting', '失败不推进状态');
  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('全流程离线闭环：Planner 写产物 → 首发 pass 直接 done，跳过 05 与 06', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const pending = [];
  const { orch } = makeOrchestrator({
    config: enabledConfig(root),
    dataDir,
    root,
    script: ({ role, registered }) => {
      if (role === 'planner') {
        writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, pending);
        writeVia(registered, { slot: 'tasks', filename: 'tasks.md', content: tasksDoc() }, pending);
      } else {
        writeVia(registered, { slot: 'review', filename: 'review-r1.md', content: reviewDoc({ verdict: 'pass' }) }, pending);
      }
    },
  });

  orch.boot();
  const started = orch.startTask({ sessionId: 'sess-1', requestText: '给设置页加驳回上限', purpose: '让用户能调' });
  assert.equal(started.task.state, 'drafting');

  const drafting = await orch.runDrafting();
  assert.equal(drafting.ok, true, drafting.error);
  assert.equal(orch.getTask().state, 'ready');
  assert.deepEqual(drafting.requirementIds, ['R1']);

  assert.equal(orch.startRound().ok, true);
  assert.equal(orch.getTask().state, 'running');
  const submit = await orch.executorHandlers().collab_submit_for_review({ summary: '改了 2 个文件' });
  assert.equal(submit.ok, true, submit.message);
  assert.equal(orch.getTask().state, 'reviewing');

  const review = await orch.runReview();
  assert.equal(review.ok, true, review.error);
  assert.equal(review.verdict, 'pass');
  assert.equal(orch.getTask().state, 'done');
  assert.equal(orch.getTask().rejection_count, 0);
  assert.equal(fs.existsSync(filePath(started.paths, 'revision', 'revision-r1.md')), false, '05 跳过');
  assert.equal(fs.existsSync(filePath(started.paths, 'final', 'final.md')), false, '06 跳过');
  // 02 里 findings 为空，review 文件确实落盘
  assert.ok(fs.existsSync(filePath(started.paths, 'review', 'review-r1.md')));

  orch.shutdown();
  assert.equal(fs.existsSync(started.paths.taskRoot), false, '退出后整棵任务树被删');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('全流程离线闭环（正确时序）：规划→执行→首发 pass→done', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const pending = [];
  let phase = 'drafting';
  const { orch } = makeOrchestrator({
    config: enabledConfig(root),
    dataDir,
    root,
    script: ({ role, registered }) => {
      if (role === 'planner' && phase === 'drafting') {
        writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, pending);
        writeVia(registered, { slot: 'tasks', filename: 'tasks.md', content: tasksDoc() }, pending);
      } else if (role === 'reviewer') {
        writeVia(registered, { slot: 'review', filename: 'review-r1.md', content: reviewDoc({ verdict: 'pass' }) }, pending);
      }
    },
  });

  orch.boot();
  const started = orch.startTask({ sessionId: 'sess-1', requestText: '给设置页加驳回上限' });
  // 手动先把产物写进盘，模拟角色已完成（避开剧本与校验的时序问题）
  fs.writeFileSync(filePath(started.paths, 'plan', 'plan.md'), planDoc());
  fs.writeFileSync(filePath(started.paths, 'tasks', 'tasks.md'), tasksDoc());
  // 用 orchestrator 的校验路径推进：直接调 applyEvent 前的校验在 runDrafting 里，这里改用只读校验
  const advanced = orch.applyEvent('plan-validated');
  assert.equal(advanced.ok, true, advanced.error);
  assert.equal(orch.getTask().state, 'ready');

  assert.equal(orch.startRound().ok, true);
  assert.equal(orch.getTask().state, 'running');

  // 执行者提交
  const submit = await orch.executorHandlers().collab_submit_for_review({ summary: '改了 3 个文件' });
  assert.equal(submit.ok, true, submit.message);
  assert.equal(orch.getTask().state, 'reviewing');

  // 审核：先写 04 再走 runReview 的校验路径
  fs.writeFileSync(filePath(started.paths, 'review', 'review-r1.md'), reviewDoc({ verdict: 'pass' }));
  const task = orch.getTask();
  assert.equal(task.round, 1);
  const pass = orch.applyEvent('review-pass');
  assert.equal(pass.ok, true, pass.error);
  assert.equal(orch.getTask().state, 'done');
  assert.equal(orch.getTask().rejection_count, 0);
  // 05 与 06 都没生成
  assert.equal(fs.existsSync(filePath(started.paths, 'revision', 'revision-r1.md')), false);
  assert.equal(fs.existsSync(filePath(started.paths, 'final', 'final.md')), false);

  orch.shutdown();
  assert.equal(fs.existsSync(started.paths.taskRoot), false, '退出后整棵任务树被删');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('驳回一轮后通过：04→05→round+1→04→done', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const { orch } = makeOrchestrator({
    config: enabledConfig(root),
    dataDir,
    root,
    script: () => {},
  });
  orch.boot();
  const started = orch.startTask({ sessionId: 'sess-1', requestText: '需求' });
  fs.writeFileSync(filePath(started.paths, 'plan', 'plan.md'), planDoc());
  fs.writeFileSync(filePath(started.paths, 'tasks', 'tasks.md'), tasksDoc());
  orch.applyEvent('plan-validated');
  orch.startRound();
  await orch.executorHandlers().collab_submit_for_review({});

  // 第 1 轮驳回
  fs.writeFileSync(filePath(started.paths, 'review', 'review-r1.md'), reviewDoc({ round: 1, verdict: 'needs_revision' }));
  const revised = orch.applyEvent('review-needs-revision');
  assert.equal(revised.ok, true, revised.error);
  assert.equal(orch.getTask().state, 'revising');
  assert.equal(orch.getTask().rejection_count, 1);

  // Planner 写 05，Host 推进到 running 且 round=2
  fs.writeFileSync(filePath(started.paths, 'revision', 'revision-r1.md'), revisionDoc(1));
  const next = orch.applyEvent('revision-written');
  assert.equal(next.ok, true, next.error);
  assert.equal(orch.getTask().state, 'running');
  assert.equal(orch.getTask().round, 2);

  // 第 2 轮通过
  await orch.executorHandlers().collab_submit_for_review({});
  assert.equal(orch.getTask().state, 'reviewing');
  fs.writeFileSync(filePath(started.paths, 'review', 'review-r2.md'), reviewDoc({ round: 2, verdict: 'pass' }));
  orch.applyEvent('review-pass');
  assert.equal(orch.getTask().state, 'done');
  assert.equal(orch.getTask().rejection_count, 1);

  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('满 2 轮驳回后进终审：pass→done / needs_revision→escalated', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const { orch } = makeOrchestrator({ config: enabledConfig(root), dataDir, root, script: () => {} });
  orch.boot();
  const started = orch.startTask({ sessionId: 'sess-1', requestText: '需求' });
  fs.writeFileSync(filePath(started.paths, 'plan', 'plan.md'), planDoc());
  fs.writeFileSync(filePath(started.paths, 'tasks', 'tasks.md'), tasksDoc());
  orch.applyEvent('plan-validated');
  orch.startRound();

  // 第 1 轮驳回
  await orch.executorHandlers().collab_submit_for_review({});
  orch.applyEvent('review-needs-revision');
  fs.writeFileSync(filePath(started.paths, 'revision', 'revision-r1.md'), revisionDoc(1));
  orch.applyEvent('revision-written');

  // 第 2 轮驳回
  await orch.executorHandlers().collab_submit_for_review({});
  orch.applyEvent('review-needs-revision');
  assert.equal(orch.getTask().rejection_count, 2);
  fs.writeFileSync(filePath(started.paths, 'revision', 'revision-r2.md'), revisionDoc(2));
  orch.applyEvent('revision-written');
  assert.equal(orch.getTask().round, 3);

  // 第 3 轮：round 3 > 上限 2 → 直接进 final-review
  await orch.executorHandlers().collab_submit_for_review({});
  assert.equal(orch.getTask().state, 'final-review');

  fs.writeFileSync(filePath(started.paths, 'final', 'final.md'), finalDoc({ verdict: 'pass' }));
  orch.applyEvent('final-pass');
  assert.equal(orch.getTask().state, 'done');

  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('终审不通过 → escalated', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const { orch } = makeOrchestrator({ config: enabledConfig(root), dataDir, root, script: () => {} });
  orch.boot();
  const started = orch.startTask({ sessionId: 'sess-1', requestText: '需求' });
  fs.writeFileSync(filePath(started.paths, 'plan', 'plan.md'), planDoc());
  fs.writeFileSync(filePath(started.paths, 'tasks', 'tasks.md'), tasksDoc());
  orch.applyEvent('plan-validated');
  orch.startRound();
  await orch.executorHandlers().collab_submit_for_review({});
  orch.applyEvent('review-needs-revision');
  fs.writeFileSync(filePath(started.paths, 'revision', 'revision-r1.md'), revisionDoc(1));
  orch.applyEvent('revision-written');
  await orch.executorHandlers().collab_submit_for_review({});
  orch.applyEvent('review-needs-revision');
  fs.writeFileSync(filePath(started.paths, 'revision', 'revision-r2.md'), revisionDoc(2));
  orch.applyEvent('revision-written');
  await orch.executorHandlers().collab_submit_for_review({});

  fs.writeFileSync(filePath(started.paths, 'final', 'final.md'), finalDoc({ verdict: 'needs_revision' }));
  orch.applyEvent('final-needs-revision');
  assert.equal(orch.getTask().state, 'escalated');

  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('T13 交回与 T14 中止', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const { orch } = makeOrchestrator({ config: enabledConfig(root), dataDir, root, script: () => {} });
  orch.boot();
  orch.startTask({ sessionId: 'sess-1', requestText: '需求' });
  orch.applyEvent('plan-validated');
  orch.startRound();

  const blocked = await orch.executorHandlers().collab_mark_blocked({ reason: '需求不清' });
  assert.equal(blocked.ok, true, blocked.message);
  assert.equal(orch.getTask().state, 'blocked');
  assert.match(orch.getTask().last_event, /需求不清/);

  const back = orch.applyEvent('unblock');
  assert.equal(back.ok, true);
  assert.equal(orch.getTask().state, 'drafting');
  assert.equal(orch.getTask().round, 1);

  const aborted = await orch.executorHandlers().collab_abort({ reason: '不要了' });
  assert.equal(aborted.ok, true);
  assert.equal(orch.getTask().state, 'aborted');

  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('开关关闭时不许启动任务', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const config = enabledConfig(root);
  config.sessions['sess-off'] = false;
  const { orch } = makeOrchestrator({ config, dataDir, root, script: () => {} });
  orch.boot();
  assert.throws(() => orch.startTask({ sessionId: 'sess-off', requestText: 'x' }), /协作开关是关的/);
  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('mock ctx 集成：restrict 只传已注册只读工具，collab_write 不进 allow', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const pending = [];
  const { orch, record } = makeOrchestrator({
    config: enabledConfig(root),
    dataDir,
    root,
    script: ({ role, registered }) => {
      if (role === 'planner') {
        writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, pending);
        writeVia(registered, { slot: 'tasks', filename: 'tasks.md', content: tasksDoc() }, pending);
      }
    },
  });
  orch.boot();
  orch.startTask({ sessionId: 'sess-1', requestText: '需求' });
  await orch.runDrafting();
  await Promise.all(pending);

  assert.ok(record.restrictCalls.length >= 1, '角色创建时必须调 restrict');
  for (const call of record.restrictCalls) {
    assert.deepEqual(call.allow, ['read', 'glob', 'grep'], 'allow 只能是已知只读工具');
    assert.equal(call.allow.includes('collab_write'), false, 'collab_write 绝不能进 allow');
    assert.equal(call.allow.includes('bash'), false, '仓库写工具必须被裁掉');
    assert.equal(call.allow.includes('write'), false);
  }
  // collab_write 通过 register 进入，不受 restrict 影响
  assert.ok(record.registered.some((names) => names.includes('collab_write')));
  // 提示词 section 已注册
  assert.ok(record.promptSections.some((s) => s.name === 'agy-collab-planner'));

  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('actorSessionIds 只收插件自建实例，用于跳过提示词注入', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const pending = [];
  const { orch } = makeOrchestrator({
    config: enabledConfig(root),
    dataDir,
    root,
    script: ({ registered }) => {
      writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, pending);
      writeVia(registered, { slot: 'tasks', filename: 'tasks.md', content: tasksDoc() }, pending);
    },
  });
  orch.boot();
  orch.startTask({ sessionId: 'sess-1', requestText: '需求' });
  await orch.runDrafting();
  await Promise.all(pending);
  const snap = orch.snapshot();
  assert.equal(snap.actor_session_ids.length, 1);
  assert.match(snap.actor_session_ids[0], /^agy-collab-planner-/);
  assert.equal(snap.actor_session_ids.includes('sess-1'), false, '当前会话不是插件自建实例');

  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('Executor 工具在非 running 状态一律拒回', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const { orch } = makeOrchestrator({ config: enabledConfig(root), dataDir, root, script: () => {} });
  orch.boot();
  orch.startTask({ sessionId: 'sess-1', requestText: '需求' });
  const handlers = orch.executorHandlers();
  assert.equal((await handlers.collab_submit_for_review({})).ok, false);
  assert.equal((await handlers.collab_mark_blocked({ reason: 'x' })).ok, false);
  // abort 在任何非终态可用
  assert.equal((await handlers.collab_abort({})).ok, true);
  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('越权写入被快照 diff 抓到并记 overreach_count', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const { orch } = makeOrchestrator({
    config: enabledConfig(root),
    dataDir,
    root,
    script: ({ role, registered, taskRoot }) => {
      if (role !== 'planner') return;
      // 正常写两份
      writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, []);
      writeVia(registered, { slot: 'tasks', filename: 'tasks.md', content: tasksDoc() }, []);
      // 越权：偷偷往 01 里塞文件
      fs.writeFileSync(path.join(taskRoot, WORKSPACE_DIRS.request, 'evil.md'), 'evil');
    },
  });
  orch.boot();
  orch.startTask({ sessionId: 'sess-1', requestText: '需求' });
  const result = await orch.runDrafting();
  assert.equal(result.ok, false);
  assert.match(result.error, /越权/);
  assert.equal(orch.getTask().overreach_count, 1);
  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('snapshot 给出运行台需要的字段', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const { orch } = makeOrchestrator({ config: enabledConfig(root), dataDir, root, script: () => {} });
  orch.boot();
  assert.deepEqual(orch.snapshot(), { active: false });
  orch.startTask({ sessionId: 'sess-1', requestText: '需求' });
  const snap = orch.snapshot();
  assert.equal(snap.active, true);
  assert.equal(snap.state, 'drafting');
  assert.equal(snap.round, 1);
  assert.equal(snap.rejection_limit, 2);
  assert.equal(snap.terminal, false);
  assert.equal(Object.keys(snap.dirs).length, 6);
  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('readTaskState / readArtifact 读得回来，缺文件返回 null', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const { orch } = makeOrchestrator({ config: enabledConfig(root), dataDir, root, script: () => {} });
  orch.boot();
  const { paths } = orch.startTask({ sessionId: 'sess-1', requestText: '需求' });
  assert.equal(readTaskState(paths.taskRoot).state, 'drafting');
  assert.equal(readArtifact(paths, 'plan', 'plan.md'), null);
  fs.writeFileSync(filePath(paths, 'plan', 'plan.md'), 'x');
  assert.equal(readArtifact(paths, 'plan', 'plan.md'), 'x');
  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('协议违规原地重试：第一次没写、第二次写对，round 与 rejection_count 都不动', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const pending = [];
  let reviewCalls = 0;
  const { orch } = makeOrchestrator({
    config: enabledConfig(root),
    dataDir,
    root,
    script: ({ role, registered }) => {
      if (role === 'planner') {
        writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, pending);
        writeVia(registered, { slot: 'tasks', filename: 'tasks.md', content: tasksDoc() }, pending);
        return;
      }
      reviewCalls += 1;
      // 第一次故意不写产物（协议违规），第二次才写合法的
      if (reviewCalls >= 2) {
        writeVia(registered, { slot: 'review', filename: 'review-r1.md', content: reviewDoc({ verdict: 'pass' }) }, pending);
      }
    },
  });
  orch.boot();
  const started = orch.startTask({ sessionId: 'sess-1', requestText: '需求' });
  const drafting = await orch.runDrafting();
  assert.equal(drafting.ok, true, drafting.error);
  orch.startRound();
  await orch.executorHandlers().collab_submit_for_review({});

  const review = await orch.runReview();
  assert.equal(review.ok, true, review.error);
  assert.equal(review.verdict, 'pass');
  assert.equal(review.attempts, 2, '第二轮才交出合法产物');
  assert.equal(orch.getTask().state, 'done');
  assert.equal(orch.getTask().protocol_retry_count, 1, '协议违规记数 +1');
  assert.equal(orch.getTask().rejection_count, 0, '协议违规不占驳回轮次');
  assert.equal(orch.getTask().round, 1, 'round 不递增');
  assert.ok(fs.existsSync(filePath(started.paths, 'review', 'review-r1.md')));
  assert.equal(fs.existsSync(filePath(started.paths, 'review', 'review-r2.md')), false, '不追加 review-r2.md');

  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('tasks.md 违约原地重写：第 2 次合规就推进到 ready，rejection_count 不动', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const pending = [];
  let plannerCalls = 0;
  const badTasks = tasksDoc().replace('## R1', '```js\nconsole.log(1)\n```\n\n## R1');
  const { orch } = makeOrchestrator({
    config: enabledConfig(root),
    dataDir,
    root,
    script: ({ role, registered, pending: inflight }) => {
      if (role !== 'planner') return;
      plannerCalls += 1;
      writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, inflight);
      writeVia(
        registered,
        { slot: 'tasks', filename: 'tasks.md', content: plannerCalls === 1 ? badTasks : tasksDoc() },
        inflight,
      );
    },
  });
  orch.boot();
  orch.startTask({ sessionId: 'sess-1', requestText: '需求' });

  const drafting = await orch.runDrafting();
  assert.equal(drafting.ok, true, drafting.error);
  assert.equal(drafting.attempts, 2, '第二次才交出合规的任务清单');
  assert.equal(orch.getTask().state, 'ready');
  // format_violation_count 数的是「连续」违约：通过校验即归零（§4.3）。
  // 违约发生过这件事只能从 attempts=2 与 Planner 被叫两次看出来，计数本身不残留。
  assert.equal(orch.getTask().format_violation_count, 0, '通过后连续违约计数归零');
  assert.equal(orch.getTask().rejection_count, 0, '违约不占驳回轮次');
  assert.equal(plannerCalls, 2);
  assert.deepEqual(drafting.requirementIds, ['R1']);

  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('tasks.md 连续违约 3 次 → escalated，不再重试', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const pending = [];
  let plannerCalls = 0;
  const badTasks = tasksDoc().replace('## R1', '| a | b |\n| - | - |\n\n## R1');
  const { orch } = makeOrchestrator({
    config: enabledConfig(root),
    dataDir,
    root,
    script: ({ role, registered, pending: inflight }) => {
      if (role !== 'planner') return;
      plannerCalls += 1;
      writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, inflight);
      writeVia(registered, { slot: 'tasks', filename: 'tasks.md', content: badTasks }, inflight);
    },
  });
  orch.boot();
  orch.startTask({ sessionId: 'sess-1', requestText: '需求' });

  const drafting = await orch.runDrafting();
  assert.equal(drafting.ok, false);
  assert.match(drafting.error, /连续违约达上限/);
  assert.equal(orch.getTask().state, 'escalated');
  assert.equal(orch.getTask().format_violation_count, 3);
  assert.equal(orch.getTask().rejection_count, 0, '升级人工不占驳回轮次');
  assert.equal(plannerCalls, 3, '达上限立刻停，不做第四次');

  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});


test('协议违规连续 2 次 → escalated，不再重试', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const pending = [];
  let reviewCalls = 0;
  const { orch } = makeOrchestrator({
    config: enabledConfig(root),
    dataDir,
    root,
    script: ({ role, registered }) => {
      if (role === 'planner') {
        writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, pending);
        writeVia(registered, { slot: 'tasks', filename: 'tasks.md', content: tasksDoc() }, pending);
        return;
      }
      reviewCalls += 1;
      // 一直写不合法的产物（findings 缺 required_fix）
      const bad = [
        '---',
        'task_id: t-1',
        'stage: review',
        'author: reviewer',
        'round: 1',
        'written_at: 2026-11-25T19:52:04+08:00',
        'verdict: needs_revision',
        'findings:',
        '  - id: F1',
        '    requirement_ref: R1',
        '    problem: 没有范围限制',
        '---',
        '',
        '正文。',
      ].join('\n');
      writeVia(registered, { slot: 'review', filename: 'review-r1.md', content: bad }, pending);
    },
  });
  orch.boot();
  orch.startTask({ sessionId: 'sess-1', requestText: '需求' });
  await orch.runDrafting();
  orch.startRound();
  await orch.executorHandlers().collab_submit_for_review({});

  const review = await orch.runReview();
  assert.equal(review.ok, false);
  assert.match(review.error, /协议违规达上限/);
  assert.equal(orch.getTask().state, 'escalated');
  assert.equal(orch.getTask().protocol_retry_count, 2);
  assert.equal(orch.getTask().rejection_count, 0, '升级人工不占驳回轮次');
  assert.equal(reviewCalls, 2, '达上限立刻停，不做第三次');

  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('同一会话连开两个任务：task_id 与 task_root 各自独立，旧任务产物不被覆盖', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const { orch } = makeOrchestrator({ config: enabledConfig(root), dataDir, root, script: () => {} });
  orch.boot();

  const first = orch.startTask({ sessionId: 'sess-1', requestText: '第一个需求' });
  fs.writeFileSync(filePath(first.paths, 'plan', 'plan.md'), planDoc());

  const second = orch.startTask({ sessionId: 'sess-1', requestText: '第二个需求' });
  assert.notEqual(second.taskId, first.taskId, '第二个任务必须拿到新 id，不能覆盖第一个');
  assert.notEqual(second.paths.taskRoot, first.paths.taskRoot);
  assert.match(second.taskId, /-02$/, '同会话第二个任务的序号要递增到 02');

  // 第一个任务的东西都还在
  assert.ok(fs.existsSync(filePath(first.paths, 'request', 'request.md')));
  assert.ok(fs.existsSync(filePath(first.paths, 'plan', 'plan.md')), '旧任务的 02 不能被新任务清掉');
  assert.equal(readArtifact(first.paths, 'plan', 'plan.md'), planDoc());

  // 第二个任务是干净的：只有 Host 写的 01
  assert.ok(fs.existsSync(filePath(second.paths, 'request', 'request.md')));
  assert.equal(readArtifact(second.paths, 'plan', 'plan.md'), null);
  assert.match(readArtifact(second.paths, 'request', 'request.md'), /第二个需求/);

  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('返工第一次没写 05 时原地重试一次，第二次写成即推进回 running', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  let plannerCalls = 0;
  const { orch, record } = makeOrchestrator({
    config: enabledConfig(root),
    dataDir,
    root,
    script: ({ role, registered, pending }) => {
      if (role !== 'planner') return;
      plannerCalls += 1;
      // 第一次返工故意什么都不写；第二次才写 05
      if (plannerCalls >= 2) {
        writeVia(registered, { slot: 'revision', filename: 'revision-r1.md', content: revisionDoc(1) }, pending);
      }
    },
  });
  orch.boot();
  const started = orch.startTask({ sessionId: 'sess-1', requestText: '需求' });
  fs.writeFileSync(filePath(started.paths, 'plan', 'plan.md'), planDoc());
  fs.writeFileSync(filePath(started.paths, 'tasks', 'tasks.md'), tasksDoc());
  orch.applyEvent('plan-validated');
  orch.startRound();
  await orch.executorHandlers().collab_submit_for_review({});
  fs.writeFileSync(filePath(started.paths, 'review', 'review-r1.md'), reviewDoc({ round: 1, verdict: 'needs_revision' }));
  assert.equal(orch.applyEvent('review-needs-revision').ok, true);
  assert.equal(orch.getTask().state, 'revising');

  const revised = await orch.runRevision();
  assert.equal(revised.ok, true, revised.error);
  assert.equal(revised.attempts, 2, '第一次没交付，第二次才成');
  assert.equal(orch.getTask().state, 'running');
  assert.equal(orch.getTask().round, 2);
  assert.equal(orch.getTask().rejection_count, 1);
  // 返工没交付不算越权，overreach_count 必须还是 0
  assert.equal(orch.getTask().overreach_count, 0);
  assert.equal(readArtifact(started.paths, 'revision', 'revision-r1.md'), revisionDoc(1));
  // 05 只能落在 05 目录，没有追加 revision-r2.md 之类的东西
  const revisionDir = path.join(started.paths.taskRoot, WORKSPACE_DIRS.revision);
  assert.deepEqual(fs.readdirSync(revisionDir), ['revision-r1.md']);
  assert.equal(record.created.filter((c) => String(c.sessionId).includes('planner')).length, 2, '重试要重新起一次 Planner，不是复用旧实例');

  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('返工两次都没交付 05：明确失败交回调用方，状态停在 revising 且不记越权', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const { orch } = makeOrchestrator({ config: enabledConfig(root), dataDir, root, script: () => {} });
  orch.boot();
  const started = orch.startTask({ sessionId: 'sess-1', requestText: '需求' });
  fs.writeFileSync(filePath(started.paths, 'plan', 'plan.md'), planDoc());
  fs.writeFileSync(filePath(started.paths, 'tasks', 'tasks.md'), tasksDoc());
  orch.applyEvent('plan-validated');
  orch.startRound();
  await orch.executorHandlers().collab_submit_for_review({});
  fs.writeFileSync(filePath(started.paths, 'review', 'review-r1.md'), reviewDoc({ round: 1, verdict: 'needs_revision' }));
  orch.applyEvent('review-needs-revision');

  const revised = await orch.runRevision();
  assert.equal(revised.ok, false);
  assert.match(revised.error, /返工重试用尽/);
  assert.equal(revised.reason, 'revision_missing');
  assert.equal(revised.attempts, 2);
  assert.equal(orch.getTask().state, 'revising', '交回调用方，不擅自换状态');
  assert.equal(orch.getTask().overreach_count, 0, '没交付不是越权');
  assert.equal(orch.getTask().rejection_count, 1);

  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

