import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  defaultConfig,
  isCollabEnabled,
  migrateConfigIfNeeded,
  needsMigration,
  normalizeConfig,
  readConfigFile,
  resolveBrokerPort,
  resolveBootId,
  setCollabEnabled,
  setGlobalEnabled,
  setRejectionLimit,
  setRoleBinding,
  setRoleBindingMode,
  validateRoleBindings,
  externalRoles,
  writeConfigFile,
  CONFIG_SCHEMA_VERSION,
} from '../../plugin/dsh-agy-collab/lib/v2/config.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v2-config-'));
}

test('默认配置是 v2 且协作开关关闭', () => {
  const config = defaultConfig(1700000000000);
  assert.equal(config.schema_version, CONFIG_SCHEMA_VERSION);
  assert.equal(config.enabled, false);
  assert.equal(config.role_binding_mode, 'triple');
  assert.equal(config.rejection_limit, 2);
  assert.equal(config.estimate_subagents, false);
  assert.equal(config.roles.executor.carrier, 'session');
});

test('迁移闸：v1 配置迁到 v2，旧字段原位保留并冷备份', () => {
  const dir = tmpDir();
  const v1 = { enabled: true, sessions: { s1: true, s2: false }, updatedAt: 123 };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(v1));
  fs.writeFileSync(path.join(dir, 'records.json'), JSON.stringify([{ id: 1 }]));
  fs.writeFileSync(path.join(dir, 'history.jsonl'), '{"a":1}\n');

  const raw = readConfigFile(dir);
  assert.equal(needsMigration(raw), true);

  const { migrated, config, backupPath } = migrateConfigIfNeeded({ dataDir: dir, now: 1700000000000 });
  assert.equal(migrated, true);
  assert.ok(backupPath);
  assert.ok(fs.existsSync(path.join(backupPath, 'state.json')));
  assert.ok(fs.existsSync(path.join(backupPath, 'records.json')));
  assert.ok(fs.existsSync(path.join(backupPath, 'history.jsonl')));

  // 旧字段不搬家
  assert.equal(config.enabled, true);
  assert.deepEqual(config.sessions, { s1: true, s2: false });
  assert.equal(config.schema_version, 2);

  // 再跑一次不重复迁移
  const again = migrateConfigIfNeeded({ dataDir: dir, now: 1700000001000 });
  assert.equal(again.migrated, false);
});

test('单会话开关只动自己那一格，不影响其他会话', () => {
  const dir = tmpDir();
  let config = writeConfigFile(dir, defaultConfig(), { now: 1 });
  config = setGlobalEnabled(config, true);
  config = setCollabEnabled(config, 's1', true);
  config = setCollabEnabled(config, 's2', false);
  config = writeConfigFile(dir, config, { now: 2 });

  const back = readConfigFile(dir);
  assert.equal(back.enabled, true);
  assert.equal(back.sessions.s1, true);
  assert.equal(back.sessions.s2, false);
  assert.equal(isCollabEnabled(back, 's1'), true);
  assert.equal(isCollabEnabled(back, 's2'), false);
  // 没有显式覆盖的会话回退全局默认
  assert.equal(isCollabEnabled(back, 's3'), true);
});

test('单会话开关不再污染其他会话（修 v1 缺陷）', () => {
  let config = normalizeConfig({ enabled: false, sessions: { a: true, b: true } });
  config = setCollabEnabled(config, 'a', false);
  assert.equal(config.sessions.a, false);
  assert.equal(config.sessions.b, true, 'b 不该被 a 的操作改掉');
});

test('Executor 载体固定 session，任何写法都归位', () => {
  const config = normalizeConfig({ roles: { executor: { carrier: 'external' } } });
  assert.equal(config.roles.executor.carrier, 'session');
  let next = setRoleBinding(defaultConfig(), 'executor', { carrier: 'in-process' });
  assert.equal(next.roles.executor.carrier, 'session');
});

test('triple 模式下同一 actor 占两槽会被校验拦下，dual 模式允许', () => {
  let config = setRoleBindingMode(defaultConfig(), 'triple');
  config = setRoleBinding(config, 'planner', { actor_id: 'A' });
  config = setRoleBinding(config, 'reviewer', { actor_id: 'A' });
  const triple = validateRoleBindings(config);
  assert.equal(triple.ok, false);
  assert.match(triple.errors.join(' '), /同时出现在/);

  const dualConfig = setRoleBindingMode(config, 'dual');
  const dual = validateRoleBindings(dualConfig);
  assert.equal(dual.ok, true, dual.errors.join('；'));
});

test('驳回上限只能在 drafting 改，范围 1-5', () => {
  const config = defaultConfig();
  assert.equal(setRejectionLimit(config, 3, { stage: 'drafting' }).ok, true);
  assert.equal(setRejectionLimit(config, 3, { stage: 'running' }).ok, false);
  assert.equal(setRejectionLimit(config, 0, { stage: 'drafting' }).ok, false);
  assert.equal(setRejectionLimit(config, 6, { stage: 'drafting' }).ok, false);
});

test('端口优先级：env > 配置 > 18765', () => {
  const config = normalizeConfig({ brokerPort: 20000 });
  assert.equal(resolveBrokerPort(config, { DSH_AGY_COLLAB_PORT: '30000' }), 30000);
  assert.equal(resolveBrokerPort(config, {}), 20000);
  assert.equal(resolveBrokerPort(defaultConfig(), {}), 18765);
  assert.equal(resolveBrokerPort(defaultConfig(), { DSH_AGY_COLLAB_PORT: 'bad' }), 18765);
});

test('boot-id 同一开机稳定、不同开机变化', () => {
  const now = 1700000000000;
  const a = resolveBootId({ now, uptime: 3600, salt: 'x' });
  const b = resolveBootId({ now: now + 5000, uptime: 3605, salt: 'x' });
  const c = resolveBootId({ now, uptime: 100, salt: 'x' });
  assert.match(a, /^[0-9a-f]{6}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('只有绑到进程外的角色才需要 broker', () => {
  let config = defaultConfig();
  assert.deepEqual(externalRoles(config), []);
  config = setRoleBinding(config, 'reviewer', { carrier: 'external' });
  assert.deepEqual(externalRoles(config), ['reviewer']);
});
