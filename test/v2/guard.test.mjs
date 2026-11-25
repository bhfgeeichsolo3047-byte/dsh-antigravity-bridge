import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultConfig, setCollabEnabled, setGlobalEnabled } from '../../plugin/dsh-agy-collab/lib/v2/config.js';
import { createOrchestrator } from '../../plugin/dsh-agy-collab/lib/v2/orchestrator.js';
import { WORKSPACE_DIRS, filePath } from '../../plugin/dsh-agy-collab/lib/v2/workspace.js';

const NOW = 1700000000000;

function tmpDir(prefix = 'agy-v2-guard-') {
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

function makeFakeAgents(script) {
  const agents = {
    create: async ({ sessionId, meta, setup }) => {
      const registered = [];
      const agentCtx = {
        tools: { register: (def) => registered.push(def), restrict: () => {} },
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
            script({ role, registered, taskRoot: meta.cwd, pending: inflight });
          },
        },
        dispose: async () => {},
      };
    },
  };
  return agents;
}

function writeVia(registered, args, pending) {
  const tool = registered.find((d) => d.name === 'collab_write');
  assert.ok(tool, '角色没有拿到 collab_write');
  pending.push(tool.execute(args));
}

function makeOrchestrator({ script, config, dataDir, root, runGit = null }) {
  const orch = createOrchestrator({
    dataDir,
    config,
    agents: makeFakeAgents(script),
    defineTool: (spec) => ({ name: spec.name, execute: spec.execute, description: spec.description }),
    knownGlobalTools: ['read', 'grep', 'glob', 'bash', 'write'],
    now: () => NOW,
    runGit,
    log: () => {},
  });
  config.workspaceRoot = root;
  return orch;
}

function enabledConfig(root) {
  let config = defaultConfig(NOW);
  config = setGlobalEnabled(config, true);
  config = setCollabEnabled(config, 'sess-1', true);
  config.workspaceRoot = root;
  return config;
}

test('角色篡改 state.json 会被哈希核验抓到（不能按文件名豁免）', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const pending = [];
  const orch = makeOrchestrator({
    config: enabledConfig(root),
    dataDir,
    root,
    script: ({ role, registered, taskRoot }) => {
      if (role !== 'planner') return;
      writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, pending);
      writeVia(registered, { slot: 'tasks', filename: 'tasks.md', content: tasksDoc() }, pending);
      // 越权：直接把任务账本改成 done，冒充 Host
      const stateFile = path.join(taskRoot, 'state.json');
      const forged = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      forged.state = 'done';
      fs.writeFileSync(stateFile, JSON.stringify(forged, null, 2) + '\n');
    },
  });
  orch.boot();
  orch.startTask({ sessionId: 'sess-1', requestText: '需求' });
  const result = await orch.runDrafting();
  assert.equal(result.ok, false);
  assert.match(result.error, /越权/);
  assert.match(result.error, /state\.json/);
  assert.equal(orch.getTask().overreach_count, 1);
  assert.notEqual(orch.getTask().state, 'done', '伪造的 done 不生效');
  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('角色删除 state.json 同样算越权', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const pending = [];
  const orch = makeOrchestrator({
    config: enabledConfig(root),
    dataDir,
    root,
    script: ({ role, registered, taskRoot }) => {
      if (role !== 'planner') return;
      writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, pending);
      writeVia(registered, { slot: 'tasks', filename: 'tasks.md', content: tasksDoc() }, pending);
      fs.rmSync(path.join(taskRoot, 'state.json'), { force: true });
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

test('Host 自己写 state.json 不被误判为越权', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const pending = [];
  const orch = makeOrchestrator({
    config: enabledConfig(root),
    dataDir,
    root,
    script: ({ role, registered }) => {
      if (role !== 'planner') return;
      writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, pending);
      writeVia(registered, { slot: 'tasks', filename: 'tasks.md', content: tasksDoc() }, pending);
    },
  });
  orch.boot();
  const started = orch.startTask({ sessionId: 'sess-1', requestText: '需求' });
  const drafting = await orch.runDrafting();
  assert.equal(drafting.ok, true, drafting.error);
  assert.equal(orch.getTask().overreach_count, 0, 'Host 的 plan-validated 写盘不算越权');
  assert.ok(fs.existsSync(filePath(started.paths, 'plan', 'plan.md')));
  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('角色在 repoCwd 改仓库文件会被 git status 抓到', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const repoCwd = tmpDir('agy-v2-repo-');
  const pending = [];
  // 用「仓库里有没有脏标记文件」模拟 git status --porcelain 的输出变化。
  const runGit = (cwd) => (fs.existsSync(path.join(cwd, '.dirty')) ? ' M src/a.js\n' : '');
  const orch = makeOrchestrator({
    config: enabledConfig(root),
    dataDir,
    root,
    runGit,
    script: ({ role, registered }) => {
      if (role !== 'planner') return;
      writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, pending);
      writeVia(registered, { slot: 'tasks', filename: 'tasks.md', content: tasksDoc() }, pending);
      // 越权：规划角色跑去改目标仓库
      fs.writeFileSync(path.join(repoCwd, '.dirty'), 'x');
    },
  });
  orch.boot();
  orch.startTask({ sessionId: 'sess-1', requestText: '需求', repoCwd });
  assert.equal(orch.getTask().repo_cwd, repoCwd, 'repoCwd 落到任务账本');
  const result = await orch.runDrafting();
  assert.equal(result.ok, false);
  assert.match(result.error, /越权/);
  assert.match(result.error, /仓库工作区/);
  assert.equal(orch.getTask().overreach_count, 1);
  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(repoCwd, { recursive: true, force: true });
});

test('repoCwd 干净时前后一致，不误报越权', async () => {
  const dataDir = tmpDir();
  const root = tmpDir();
  const repoCwd = tmpDir('agy-v2-repo-');
  const pending = [];
  const runGit = (cwd) => (fs.existsSync(path.join(cwd, '.dirty')) ? ' M src/a.js\n' : '');
  const orch = makeOrchestrator({
    config: enabledConfig(root),
    dataDir,
    root,
    runGit,
    script: ({ role, registered }) => {
      if (role !== 'planner') return;
      writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, pending);
      writeVia(registered, { slot: 'tasks', filename: 'tasks.md', content: tasksDoc() }, pending);
    },
  });
  orch.boot();
  orch.startTask({ sessionId: 'sess-1', requestText: '需求', repoCwd });
  const result = await orch.runDrafting();
  assert.equal(result.ok, true, result.error);
  assert.equal(orch.getTask().overreach_count, 0);
  orch.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(repoCwd, { recursive: true, force: true });
});
