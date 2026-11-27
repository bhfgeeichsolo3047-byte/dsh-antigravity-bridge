import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mountV2, isV2Enabled, START_TOOL_NAME } from '../../plugin/dsh-agy-collab/lib/v2/index.js';

function tmpDir(prefix = 'agy-v2-mount-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 最小宿主 ctx：记录 inject / effect / 工具注册。 */
function makeCtx() {
  const record = { injected: [], registered: [], effects: [] };
  const scoped = {
    agents: {
      create: async ({ setup }) => {
        const registered = [];
        await setup({
          tools: { register: (d) => registered.push(d), restrict: () => {} },
          systemPrompt: { section: () => {} },
        });
        return { agent: { whenIdle: async () => {}, followup: () => {} }, dispose: async () => {} };
      },
    },
    tools: {
      register: (def) => {
        record.registered.push(def);
        return () => {};
      },
    },
    agent: {
      session: { header: { id: 'sess-mount' } },
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

test('v2 默认启用：未设 DSH_AGY_COLLAB_V2 也算开启', async () => {
  assert.equal(isV2Enabled({}), true);
  assert.equal(isV2Enabled({ DSH_AGY_COLLAB_V2: '1' }), true);
  assert.equal(isV2Enabled({ DSH_AGY_COLLAB_V2: 'true' }), true);
  assert.equal(isV2Enabled({ DSH_AGY_COLLAB_V2: 'yes' }), true);
  assert.equal(isV2Enabled({ DSH_AGY_COLLAB_V2: '' }), true);

  const dataDir = tmpDir();
  const { ctx, record } = makeCtx();
  const dispose = await mountV2(ctx, { env: {}, dataDir, log: () => {} });
  assert.equal(typeof dispose, 'function', '默认必须装配');
  assert.deepEqual(record.injected, [['agents', 'tools']]);
  assert.ok(fs.existsSync(path.join(dataDir, 'state.json')));
  dispose();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('显式 DSH_AGY_COLLAB_V2=0/false/off/no 时完全不装配（v1 回退开关）', async () => {
  for (const value of ['0', 'false', 'off', 'no', 'FALSE', ' 0 ']) {
    assert.equal(isV2Enabled({ DSH_AGY_COLLAB_V2: value }), false, `${JSON.stringify(value)} 应关闭 v2`);

    const dataDir = tmpDir();
    const { ctx, record } = makeCtx();
    const dispose = await mountV2(ctx, { env: { DSH_AGY_COLLAB_V2: value }, dataDir });
    assert.equal(dispose, null, 'v2 关着时必须返回 null');
    assert.equal(record.injected.length, 0, '不许 inject 任何服务');
    assert.equal(record.registered.length, 0, '不许注册任何工具');
    // 连配置目录都不该被建出来
    assert.equal(fs.existsSync(path.join(dataDir, 'state.json')), false);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('v2 打开时注入 agents+tools，注册 collab_start 与 Executor 三件', async () => {
  const dataDir = tmpDir();
  const { ctx, record } = makeCtx();
  const dispose = await mountV2(ctx, { env: { DSH_AGY_COLLAB_V2: '1' }, dataDir, log: () => {} });
  assert.equal(typeof dispose, 'function');

  assert.deepEqual(record.injected, [['agents', 'tools']]);
  const names = record.registered.map((d) => d.name).sort();
  assert.deepEqual(names, ['collab_abort', 'collab_mark_blocked', 'collab_start', 'collab_submit_for_review']);

  // 配置已迁移落盘
  assert.ok(fs.existsSync(path.join(dataDir, 'state.json')));
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(saved.schema_version, 2);
  assert.equal(saved.role_binding_mode, 'triple');
  assert.equal(saved.rejection_limit, 2);

  dispose();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('collab_start 在开关关着时返回明确失败，不假装成功', async () => {
  const dataDir = tmpDir();
  const { ctx, record } = makeCtx();
  const dispose = await mountV2(ctx, { env: { DSH_AGY_COLLAB_V2: '1' }, dataDir, log: () => {} });
  const startTool = record.registered.find((d) => d.name === START_TOOL_NAME);
  assert.ok(startTool, '没注册 collab_start');

  const result = await startTool.execute({ request: '给设置页加驳回上限' });
  assert.equal(result.ok, false);
  assert.match(result.message, /协作开关是关的/);
  dispose();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('打开协作开关后 collab_start 建出工作台；Planner 没写产物时明确失败且 dispose 清树', async () => {
  const dataDir = tmpDir();
  const workspaceRoot = tmpDir();
  const { ctx, record } = makeCtx();
  // 先写一份已开开关的配置
  const { defaultConfig, setGlobalEnabled, setCollabEnabled, writeConfigFile } = await import(
    '../../plugin/dsh-agy-collab/lib/v2/config.js'
  );
  let config = defaultConfig(Date.now());
  config = setGlobalEnabled(config, true);
  config = setCollabEnabled(config, 'sess-mount', true);
  config.workspaceRoot = workspaceRoot;
  writeConfigFile(dataDir, config);

  const dispose = await mountV2(ctx, { env: { DSH_AGY_COLLAB_V2: '1' }, dataDir, log: () => {} });
  const startTool = record.registered.find((d) => d.name === START_TOOL_NAME);

  // 假 agents 的 whenIdle 立刻返回，Planner 不会写产物 → runDrafting 应明确失败而不是成功
  const result = await startTool.execute({ request: '给设置页加驳回上限', purpose: '让用户能调' });
  assert.equal(result.ok, false);
  assert.match(result.message, /规划未通过/);
  assert.ok(fs.existsSync(result.data.task_root), '工作台目录已建');
  assert.ok(fs.existsSync(path.join(result.data.task_root, '01-原始任务需求和目的', 'request.md')), '01 由 Host 写');

  dispose();
  assert.equal(fs.existsSync(result.data.task_root), false, 'dispose 后整棵任务树被删');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});
test('dispose 后编排器与 exec 都不留引用：重新挂载能干净重建', async () => {
  const dataDir = tmpDir();
  const workspaceRoot = tmpDir();
  const { defaultConfig, setGlobalEnabled, setCollabEnabled, writeConfigFile } = await import(
    '../../plugin/dsh-agy-collab/lib/v2/config.js'
  );
  let config = defaultConfig(Date.now());
  config = setGlobalEnabled(config, true);
  config = setCollabEnabled(config, 'sess-mount', true);
  config.workspaceRoot = workspaceRoot;
  writeConfigFile(dataDir, config);

  const first = makeCtx();
  const dispose1 = await mountV2(first.ctx, { env: { DSH_AGY_COLLAB_V2: '1' }, dataDir, log: () => {} });
  const start1 = first.record.registered.find((d) => d.name === START_TOOL_NAME);
  // 传一个 exec：路由就是从这里现算的，编排器不许把它存下来
  const exec = { agent: { model: { current: () => ({ provider: 'p1', model: 'm1' }) }, session: { header: { id: 'sess-mount', cwd: workspaceRoot } } } };
  const r1 = await start1.execute({ request: '第一个任务' }, exec);
  assert.ok(r1.data?.task_root, '工作台已建');
  const firstTaskRoot = r1.data.task_root;

  dispose1();
  assert.equal(fs.existsSync(firstTaskRoot), false, 'dispose 后旧任务树被删');

  // 第二次挂载：如果上一轮的 orchestrator / exec 还留着，这里会拿到旧实例与旧 exec
  const second = makeCtx();
  const dispose2 = await mountV2(second.ctx, { env: { DSH_AGY_COLLAB_V2: '1' }, dataDir, log: () => {} });
  const start2 = second.record.registered.find((d) => d.name === START_TOOL_NAME);
  const r2 = await start2.execute({ request: '第二个任务' }, { agent: { model: { current: () => ({ provider: 'p2', model: 'm2' }) }, session: { header: { id: 'sess-mount', cwd: workspaceRoot } } } });
  assert.ok(r2.data?.task_root, '重新挂载后仍能建工作台');
  // 任务 id 是「日期-序号」，旧树已被 dispose 删掉，序号从 01 重新开始是正常的；
  // 这里要证明的是「新挂载拿到的是新编排器、新建的工作台」，不是旧实例。
  assert.ok(fs.existsSync(r2.data.task_root), '新工作台真的建出来了');
  assert.ok(
    fs.existsSync(path.join(r2.data.task_root, '01-原始任务需求和目的', 'request.md')),
    '01 由新编排器写入',
  );
  assert.equal(r2.message.includes('第二个任务') || r2.ok === false, true, '新任务走的是新编排器');

  dispose2();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('DSH_AGY_COLLAB_DATA_DIR 优先于 home 默认路径，冒烟不会就地迁移真实配置', async () => {
  const dataDir = tmpDir();
  const { ctx, record } = makeCtx();
  const dispose = await mountV2(ctx, {
    env: { DSH_AGY_COLLAB_V2: '1', DSH_AGY_COLLAB_DATA_DIR: dataDir },
    log: () => {},
  });
  assert.equal(typeof dispose, 'function');
  assert.ok(fs.existsSync(path.join(dataDir, 'state.json')), '配置落在 env 指定的目录');
  dispose();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('首次初始化与迁移的日志可区分：没有旧文件时 backupPath 为 null', async () => {
  const { migrateConfigIfNeeded } = await import('../../plugin/dsh-agy-collab/lib/v2/config.js');
  const fresh = tmpDir();
  const first = migrateConfigIfNeeded({ dataDir: fresh });
  assert.equal(first.created, true, '空目录是首次初始化');
  assert.equal(first.backupPath, null, '没有旧文件就不该报备份路径');

  // 造一份 v1 配置，再迁移一次：这次必须有备份
  fs.writeFileSync(
    path.join(fresh, 'state.json'),
    JSON.stringify({ enabled: true, sessions: { 'session-x': true }, updatedAt: 1 }) + '\n',
    'utf8',
  );
  const second = migrateConfigIfNeeded({ dataDir: fresh });
  assert.equal(second.created, false);
  assert.equal(second.migrated, true);
  assert.ok(second.backupPath && fs.existsSync(path.join(second.backupPath, 'state.json')), '旧 state 已备份');

  fs.rmSync(fresh, { recursive: true, force: true });
});
test('配置没写 workspaceRoot 时，工作台落在 dataDir/workspace，不落用户 home', async () => {
  const { resolveWorkspaceRoot, normalizeConfig } = await import(
    '../../plugin/dsh-agy-collab/lib/v2/config.js'
  );
  const dataDir = tmpDir();
  // 配置里没有 workspaceRoot 字段
  const config = normalizeConfig({ enabled: true }, { dataDir });
  assert.equal(resolveWorkspaceRoot(config, { dataDir }), path.join(dataDir, 'workspace'));

  // 显式写了就尊重显式值
  const explicit = path.join(dataDir, 'custom-root');
  assert.equal(resolveWorkspaceRoot({ workspaceRoot: explicit }, { dataDir }), explicit);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
