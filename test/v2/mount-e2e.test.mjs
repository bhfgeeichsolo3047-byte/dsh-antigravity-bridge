import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mountV2, START_TOOL_NAME } from '../../plugin/dsh-agy-collab/lib/v2/index.js';
import { defaultConfig, setGlobalEnabled, setCollabEnabled, writeConfigFile } from '../../plugin/dsh-agy-collab/lib/v2/config.js';

function tmpDir(prefix = 'agy-v2-e2e-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function tasksDoc() {
  return [
    '---',
    'task_id: t-1',
    'stage: tasks',
    'author: planner',
    'round: 0',
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

function reviewDoc({ round, verdict }) {
  const findings = verdict === 'pass'
    ? []
    : ['findings:', '  - id: F1', '    requirement_ref: R1', '    severity: high', '    problem: 没有范围限制', '    required_fix: 加 min/max 校验'];
  return [
    '---',
    'task_id: t-1',
    'stage: review',
    'author: reviewer',
    `round: ${round}`,
    'written_at: 2026-11-25T19:52:04+08:00',
    `verdict: ${verdict}`,
    ...findings,
    '---',
    '',
    '审核正文。',
  ].join('\n');
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
 * 最小宿主 ctx：agents.create 会真的跑剧本（用 collab_write 落盘），
 * whenIdle 等剧本里排进来的工具调用全部完成，与真实宿主语义一致。
 */
function makeCtx({ script }) {
  const record = { injected: [], registered: [], effects: [], restrictCalls: [] };
  const scoped = {
    agents: {
      create: async ({ sessionId, meta, setup }) => {
        const registered = [];
        const agentCtx = {
          tools: {
            register: (def) => registered.push(def),
            restrict: (filter) => record.restrictCalls.push(filter),
          },
          systemPrompt: { section: () => {} },
        };
        await setup(agentCtx);
        const role = sessionId.includes('planner') ? 'planner' : 'reviewer';
        const inflight = [];
        return {
          agent: {
            whenIdle: async () => {
              while (inflight.length) await Promise.all(inflight.splice(0));
            },
            followup: () => {
              script({ role, registered, taskRoot: meta.cwd, pending: inflight, sessionId });
            },
          },
          dispose: async () => {},
        };
      },
    },
    tools: {
      register: (def) => {
        record.registered.push(def);
        return () => {};
      },
      view: () => ({ knownNames: ['read', 'grep', 'glob', 'bash', 'write'] }),
    },
    // 真实宿主的 agent 上一定有 model.current()；进程内角色的路由从这里读。
    agent: {
      session: { header: { id: 'sess-A' } },
      model: { current: () => ({ provider: 'test-provider', model: 'test-model' }) },
    },
    effect: (fn, label) => record.effects.push({ fn, label }),
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    inject: (names, fn) => {
      record.injected.push(names);
      fn(scoped);
    },
    effect: (fn, label) => record.effects.push({ fn, label }),
  };
  return { ctx, record, scoped };
}

function writeVia(registered, args, pending) {
  const tool = registered.find((d) => d.name === 'collab_write');
  assert.ok(tool, '角色没有拿到 collab_write');
  pending.push(tool.execute(args));
}

function execFor(sessionId, cwd = null) {
  return {
    agent: {
      session: { header: { id: sessionId, cwd } },
      model: { current: () => ({ provider: 'test-provider', model: 'test-model' }) },
    },
  };
}

function prepareConfig(dataDir, workspaceRoot, sessionIds) {
  let config = defaultConfig(Date.now());
  config = setGlobalEnabled(config, true);
  for (const sid of sessionIds) config = setCollabEnabled(config, sid, true);
  config.workspaceRoot = workspaceRoot;
  writeConfigFile(dataDir, config);
  return config;
}

test('端到端闭环：collab_start 直接进 running，提交后驳回自动出 05，再提交通过', async () => {
  const dataDir = tmpDir();
  const workspaceRoot = tmpDir();
  prepareConfig(dataDir, workspaceRoot, ['sess-A']);
  let plannerCalls = 0;
  let reviewerCalls = 0;
  const { ctx, record } = makeCtx({
    script: ({ role, registered, pending }) => {
      if (role === 'planner') {
        plannerCalls += 1;
        if (plannerCalls === 1) {
          writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, pending);
          writeVia(registered, { slot: 'tasks', filename: 'tasks.md', content: tasksDoc() }, pending);
        } else {
          writeVia(registered, { slot: 'revision', filename: 'revision-r1.md', content: revisionDoc(1) }, pending);
        }
        return;
      }
      reviewerCalls += 1;
      const round = reviewerCalls;
      const verdict = round === 1 ? 'needs_revision' : 'pass';
      writeVia(registered, { slot: 'review', filename: `review-r${round}.md`, content: reviewDoc({ round, verdict }) }, pending);
    },
  });
  const dispose = await mountV2(ctx, { env: { DSH_AGY_COLLAB_V2: '1' }, dataDir, log: () => {} });
  const startTool = record.registered.find((d) => d.name === START_TOOL_NAME);
  const submitTool = record.registered.find((d) => d.name === 'collab_submit_for_review');
  assert.ok(startTool && submitTool, '缺工具');

  const started = await startTool.execute({ request: '给设置页加驳回上限' }, execFor('sess-A'));
  assert.equal(started.ok, true, started.message);
  assert.equal(started.data.state, 'running', 'collab_start 必须推进到 running，不能停在 ready');
  assert.ok(fs.existsSync(started.data.plan_path), '02 已落盘');
  assert.ok(fs.existsSync(started.data.tasks_path), '03 已落盘');
  assert.deepEqual(started.data.requirements, ['R1']);

  const first = await submitTool.execute({ summary: '改了 2 个文件' }, execFor('sess-A'));
  assert.equal(first.ok, true, first.message);
  assert.equal(first.data.verdict, 'needs_revision');
  assert.equal(first.data.rejection_count, 1);
  assert.equal(first.data.round, 2, '返工后 round+1');
  assert.match(first.data.instruction, /revision-r1\.md/, '把返工指令还给 Executor');
  const taskRoot = first.data.task_root;
  assert.ok(fs.existsSync(path.join(taskRoot, '05-修改方案', 'revision-r1.md')), '驳回后 Planner 自动出 05');

  const second = await submitTool.execute({ summary: '按 05 改完' }, execFor('sess-A'));
  assert.equal(second.ok, true, second.message);
  assert.equal(second.data.verdict, 'pass');
  assert.equal(second.data.state, 'done');
  assert.equal(second.data.rejection_count, 1);

  dispose();
  assert.equal(fs.existsSync(taskRoot), false, 'dispose 后整棵任务树被删');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('双会话隔离：两个会话各自一份任务账本，互不覆盖', async () => {
  const dataDir = tmpDir();
  const workspaceRoot = tmpDir();
  prepareConfig(dataDir, workspaceRoot, ['sess-A', 'sess-B']);
  const { ctx, record } = makeCtx({
    script: ({ role, registered, pending }) => {
      if (role !== 'planner') return;
      writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, pending);
      writeVia(registered, { slot: 'tasks', filename: 'tasks.md', content: tasksDoc() }, pending);
    },
  });
  const dispose = await mountV2(ctx, { env: { DSH_AGY_COLLAB_V2: '1' }, dataDir, log: () => {} });
  const startTool = record.registered.find((d) => d.name === START_TOOL_NAME);

  const a = await startTool.execute({ request: 'A 的需求' }, execFor('sess-A'));
  const b = await startTool.execute({ request: 'B 的需求' }, execFor('sess-B'));
  assert.equal(a.ok, true, a.message);
  assert.equal(b.ok, true, b.message);
  assert.notEqual(a.data.task_root, b.data.task_root, '两个会话的工作台不能是同一个');
  assert.ok(a.data.task_root.includes('sess-A'));
  assert.ok(b.data.task_root.includes('sess-B'));

  // 各自的 01 里是自己那份需求，没有被另一个会话覆盖
  const aReq = fs.readFileSync(path.join(a.data.task_root, '01-原始任务需求和目的', 'request.md'), 'utf8');
  const bReq = fs.readFileSync(path.join(b.data.task_root, '01-原始任务需求和目的', 'request.md'), 'utf8');
  assert.match(aReq, /A 的需求/);
  assert.doesNotMatch(aReq, /B 的需求/);
  assert.match(bReq, /B 的需求/);

  dispose();
  assert.equal(fs.existsSync(a.data.task_root), false);
  assert.equal(fs.existsSync(b.data.task_root), false);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});
