import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mountV2, START_TOOL_NAME } from '../../plugin/dsh-agy-collab/lib/v2/index.js';
import { defaultConfig, setCollabEnabled, setGlobalEnabled, writeConfigFile } from '../../plugin/dsh-agy-collab/lib/v2/config.js';

function tmpDir(prefix = 'agy-v2-late-') {
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
    '    purpose: 读现有代码',
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

/**
 * 最小宿主 ctx：tools 一开始什么都不知道（模拟 dsh-tool-fs / dsh-tool-bash 还没注册），
 * 挂载完成之后调用方再 registerLate() 把全局工具补上。
 */
function makeLateCtx({ script }) {
  const record = { injected: [], registered: [], restrictCalls: [], effects: [] };
  const lateNames = [];
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
            followup: () => script({ role, registered, taskRoot: meta.cwd, pending: inflight }),
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
      // 挂载时一律空表：真实宿主里 dsh-tool-fs / dsh-tool-bash 可能晚于插件注册
      view: () => ({ knownNames: [...lateNames], restrictableNames: [...lateNames] }),
      definitions: () => lateNames.map((name) => ({ name })),
    },
    agent: {
    session: { header: { id: 'sess-late' } },
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
  const registerLate = (names) => lateNames.push(...names);
  return { ctx, record, scoped, registerLate };
}

function writeVia(registered, args, pending) {
  const tool = registered.find((d) => d.name === 'collab_write');
  assert.ok(tool, '角色没有拿到 collab_write');
  pending.push(tool.execute(args));
}

function execFor(sessionId) {
  return {
    agent: {
      session: { header: { id: sessionId, cwd: null } },
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

test('全局工具晚于插件注册时，restrict 仍然拿到只读白名单，而不是降级空集', async () => {
  const dataDir = tmpDir();
  const workspaceRoot = tmpDir();
  prepareConfig(dataDir, workspaceRoot, ['sess-late']);
  const { ctx, record, registerLate } = makeLateCtx({
    script: ({ role, registered, pending }) => {
      if (role !== 'planner') return;
      writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, pending);
      writeVia(registered, { slot: 'tasks', filename: 'tasks.md', content: tasksDoc() }, pending);
    },
  });
  const dispose = await mountV2(ctx, { env: { DSH_AGY_COLLAB_V2: '1' }, dataDir, log: () => {} });
  assert.equal(typeof dispose, 'function');
  // 挂载那一刻，宿主还不知道任何全局工具
  assert.equal(record.restrictCalls.length, 0);

  // 挂载之后才把全局工具注册进来（真实宿主的加载顺序）
  registerLate(['read', 'grep', 'glob', 'write', 'bash']);

  const startTool = record.registered.find((d) => d.name === START_TOOL_NAME);
  assert.ok(startTool, '没注册 collab_start');
  const started = await startTool.execute({ request: '给设置页加驳回上限' }, execFor('sess-late'));
  assert.equal(started.ok, true, started.message);

  assert.equal(record.restrictCalls.length > 0, true, '起角色时必须调过 restrict');
  const allow = record.restrictCalls.at(-1)?.allow;
  // computeReadonlyAllow 的输出顺序跟 READONLY_GLOBAL_TOOLS 走，不是输入顺序
  assert.deepEqual(allow, ['read', 'glob', 'grep'], '只读白名单要按动态清单算出来，写/执行工具被挡在外面');
  assert.equal(Object.hasOwn(record.restrictCalls.at(-1), 'deny'), false, 'allow 非空时不该退化成 deny 兜底');

  dispose();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('挂载时完全没有全局工具、之后也没有：明确降级，不静默放开', async () => {
  const dataDir = tmpDir();
  const workspaceRoot = tmpDir();
  prepareConfig(dataDir, workspaceRoot, ['sess-late']);
  const { ctx, record } = makeLateCtx({
    script: ({ role, registered, pending }) => {
      if (role !== 'planner') return;
      writeVia(registered, { slot: 'plan', filename: 'plan.md', content: planDoc() }, pending);
      writeVia(registered, { slot: 'tasks', filename: 'tasks.md', content: tasksDoc() }, pending);
    },
  });
  const dispose = await mountV2(ctx, { env: { DSH_AGY_COLLAB_V2: '1' }, dataDir, log: () => {} });
  const startTool = record.registered.find((d) => d.name === START_TOOL_NAME);
  const started = await startTool.execute({ request: '需求' }, execFor('sess-late'));
  assert.equal(started.ok, true, started.message);
  // 一个名字都不知道时既算不出 allow 也算不出 deny：连 restrict 都不该调（会抛 unknown name）
  assert.equal(record.restrictCalls.length, 0, '拿不到清单时不能瞎调 restrict');
  dispose();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});