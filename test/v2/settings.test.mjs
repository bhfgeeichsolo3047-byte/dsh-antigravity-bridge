import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  LEGACY_TEMPLATE_PATHS,
  PATCHABLE_KEYS,
  TEMPLATE_MANIFEST_NAME,
  TEMPLATE_MANIFEST_SCHEMA_VERSION,
  TEMPLATE_SUBDIR,
  applyConfigPatch,
  buildSettingsSnapshot,
  inspectInstalledTemplates,
  persistConfig,
  resolveGeminiConfigDir,
} from '../../plugin/dsh-agy-collab/lib/v2/settings.js';
import {
  defaultConfig,
  readConfigFile,
  writeConfigFile,
} from '../../plugin/dsh-agy-collab/lib/v2/config.js';

function tmpDir(prefix = 'agy-settings-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freshConfig(overrides = {}) {
  return { ...defaultConfig(1_700_000_000_000, {}), ...overrides };
}

function writeTemplate(geminiConfigDir, name, version = '2.0.0', body = '正文') {
  const dir = path.join(geminiConfigDir, TEMPLATE_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const text = `---\nname: x\ntemplate_version: ${version}\n---\n${body}\n`;
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function writeManifest(geminiConfigDir, files, schemaVersion = TEMPLATE_MANIFEST_SCHEMA_VERSION) {
  const file = path.join(geminiConfigDir, TEMPLATE_MANIFEST_NAME);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion, files }, null, 2), 'utf8');
  return file;
}

test('resolveGeminiConfigDir：env 优先，否则 ~/.gemini/config', () => {
  assert.equal(resolveGeminiConfigDir({ GEMINI_CONFIG_DIR: '/tmp/x' }), path.resolve('/tmp/x'));
  assert.equal(resolveGeminiConfigDir({}), path.join(os.homedir(), '.gemini', 'config'));
});

test('inspectInstalledTemplates：manifest 与两份模板都不在 → not_installed', () => {
  const dir = tmpDir();
  const got = inspectInstalledTemplates({ geminiConfigDir: dir });
  assert.equal(got.status, 'not_installed');
  assert.equal(got.manifestKind, 'absent');
  assert.equal(got.items.length, 2);
  assert.deepEqual(got.items.map((i) => i.state), ['missing', 'missing']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inspectInstalledTemplates：两份都在且哈希一致 → installed，带 template_version', () => {
  const dir = tmpDir();
  const items = ['planner.md', 'reviewer.md'].map((name) => {
    const file = writeTemplate(dir, name);
    const sha256 = (() => {
      // 用 inspectInstalledTemplates 拿不到「记录值」时判 drifted，所以先写 manifest 再核一次
      return null;
    })();
    void sha256;
    return { path: path.join(TEMPLATE_SUBDIR, name), sha256: 'placeholder', file };
  });
  // 先读一次算出真实 sha256，再写进 manifest
  const first = inspectInstalledTemplates({ geminiConfigDir: dir });
  writeManifest(
    dir,
    first.items.map((it) => ({ path: it.relPath, sha256: it.sha256 })),
  );
  const got = inspectInstalledTemplates({ geminiConfigDir: dir });
  assert.equal(got.status, 'installed');
  assert.equal(got.manifestKind, 'current');
  assert.deepEqual(got.items.map((i) => i.state), ['in_sync', 'in_sync']);
  assert.equal(got.items[0].templateVersion, '2.0.0');
  assert.deepEqual(got.legacyPresent, []);
  void items;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inspectInstalledTemplates：磁盘内容被改过 → drifted', () => {
  const dir = tmpDir();
  writeTemplate(dir, 'planner.md');
  writeTemplate(dir, 'reviewer.md');
  const first = inspectInstalledTemplates({ geminiConfigDir: dir });
  writeManifest(dir, first.items.map((it) => ({ path: it.relPath, sha256: it.sha256 })));
  // 改掉其中一份
  writeTemplate(dir, 'planner.md', '2.0.0', '被人改过的正文');
  const got = inspectInstalledTemplates({ geminiConfigDir: dir });
  assert.equal(got.status, 'drifted');
  assert.equal(got.items.find((i) => i.name === 'planner.md').state, 'drifted');
  assert.equal(got.items.find((i) => i.name === 'reviewer.md').state, 'in_sync');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inspectInstalledTemplates：v1 遗留物还在 → drifted 并列出 legacyPresent', () => {
  const dir = tmpDir();
  writeTemplate(dir, 'planner.md');
  writeTemplate(dir, 'reviewer.md');
  const first = inspectInstalledTemplates({ geminiConfigDir: dir });
  writeManifest(dir, first.items.map((it) => ({ path: it.relPath, sha256: it.sha256 })));
  const legacy = path.join(dir, LEGACY_TEMPLATE_PATHS[0]);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, 'v1 旧协议', 'utf8');
  const got = inspectInstalledTemplates({ geminiConfigDir: dir });
  assert.equal(got.status, 'drifted');
  assert.deepEqual(got.legacyPresent, [LEGACY_TEMPLATE_PATHS[0]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inspectInstalledTemplates：manifest 的 schemaVersion 不认识 → unrecognized', () => {
  const dir = tmpDir();
  writeTemplate(dir, 'planner.md');
  writeTemplate(dir, 'reviewer.md');
  writeManifest(dir, [], 99);
  const got = inspectInstalledTemplates({ geminiConfigDir: dir });
  assert.equal(got.manifestKind, 'unrecognized');
  assert.equal(got.status, 'drifted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyConfigPatch：不认识的键被拒收', () => {
  const got = applyConfigPatch({ config: freshConfig(), patch: { nope: 1 } });
  assert.equal(got.ok, false);
  assert.match(got.error, /不认识的配置项/);
  assert.match(got.error, /nope/);
});

test('applyConfigPatch：空 patch 被拒收', () => {
  const got = applyConfigPatch({ config: freshConfig(), patch: {} });
  assert.equal(got.ok, false);
  assert.match(got.error, /patch 是空的/);
});

test('applyConfigPatch：PATCHABLE_KEYS 覆盖规格 §12.2 的九项', () => {
  assert.deepEqual([...PATCHABLE_KEYS].sort(), [
    'brokerPort',
    'enabled',
    'estimate_subagents',
    'globalEnabled',
    'rejection_limit',
    'reviewer_mode',
    'role_binding_mode',
    'roles',
    'workspaceRoot',
  ]);
});

test('applyConfigPatch：协作开关必须带 sessionId（§12.6 会话粒度）', () => {
  const got = applyConfigPatch({ config: freshConfig(), patch: { enabled: true }, sessionId: '' });
  assert.equal(got.ok, false);
  assert.match(got.error, /按会话的/);
});

test('applyConfigPatch：带 sessionId 时只写该会话，不动全局 enabled', () => {
  const got = applyConfigPatch({
    config: freshConfig(),
    patch: { enabled: true },
    sessionId: 'sess-1',
  });
  assert.equal(got.ok, true);
  assert.equal(got.config.sessions['sess-1'], true);
  assert.equal(got.config.enabled, false);
});

test('applyConfigPatch：驳回上限只在 drafting 可改', () => {
  const blocked = applyConfigPatch({
    config: freshConfig(),
    patch: { rejection_limit: 3 },
    stage: 'running',
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /drafting/);

  const ok = applyConfigPatch({
    config: freshConfig(),
    patch: { rejection_limit: 3 },
    stage: 'drafting',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.config.rejection_limit, 3);
});

test('applyConfigPatch：驳回上限超范围被拒', () => {
  const got = applyConfigPatch({ config: freshConfig(), patch: { rejection_limit: 9 }, stage: 'drafting' });
  assert.equal(got.ok, false);
  assert.match(got.error, /1-5/);
});

test('applyConfigPatch：triple 下同一 actor 占两槽 → 校验失败', () => {
  const got = applyConfigPatch({
    config: freshConfig(),
    patch: {
      roles: {
        planner: { actor_id: 'actor-x' },
        reviewer: { actor_id: 'actor-x' },
      },
    },
  });
  assert.equal(got.ok, false);
  assert.match(got.error, /triple/);
});

test('applyConfigPatch：dual 下同一 actor 占两槽是允许的', () => {
  const got = applyConfigPatch({
    config: freshConfig(),
    patch: {
      role_binding_mode: 'dual',
      roles: {
        planner: { actor_id: 'actor-x' },
        reviewer: { actor_id: 'actor-x' },
      },
    },
  });
  assert.equal(got.ok, true);
  assert.equal(got.config.role_binding_mode, 'dual');
});

test('applyConfigPatch：executor 载体永远被强制成 session', () => {
  const got = applyConfigPatch({
    config: freshConfig(),
    patch: { roles: { executor: { carrier: 'in-process' } } },
  });
  assert.equal(got.ok, true);
  assert.equal(got.config.roles.executor.carrier, 'session');
});

test('applyConfigPatch：不认识的角色被拒', () => {
  const got = applyConfigPatch({ config: freshConfig(), patch: { roles: { developer: {} } } });
  assert.equal(got.ok, false);
  assert.match(got.error, /不认识的角色/);
});

test('applyConfigPatch：审核档位与绑定模式非法值被拒', () => {
  assert.equal(applyConfigPatch({ config: freshConfig(), patch: { reviewer_mode: 'x' } }).ok, false);
  assert.equal(applyConfigPatch({ config: freshConfig(), patch: { role_binding_mode: 'x' } }).ok, false);
});

test('applyConfigPatch：brokerPort 越界被拒，合法值写入', () => {
  assert.equal(applyConfigPatch({ config: freshConfig(), patch: { brokerPort: 0 } }).ok, false);
  assert.equal(applyConfigPatch({ config: freshConfig(), patch: { brokerPort: 70000 } }).ok, false);
  const ok = applyConfigPatch({ config: freshConfig(), patch: { brokerPort: 19000 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.config.brokerPort, 19000);
});

test('applyConfigPatch：workspaceRoot 空串回落默认值', () => {
  const dataDir = tmpDir();
  const got = applyConfigPatch({
    config: freshConfig(),
    patch: { workspaceRoot: '' },
    dataDir,
  });
  assert.equal(got.ok, true);
  assert.equal(got.config.workspaceRoot, path.join(dataDir, 'workspace'));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('applyConfigPatch：estimate_subagents 与 reviewer_mode 正常写入', () => {
  const got = applyConfigPatch({
    config: freshConfig(),
    patch: { estimate_subagents: true, reviewer_mode: 'loose' },
  });
  assert.equal(got.ok, true);
  assert.equal(got.config.estimate_subagents, true);
  assert.equal(got.config.reviewer_mode, 'loose');
});

test('persistConfig 真的落盘，且回读一致', () => {
  const dataDir = tmpDir();
  const applied = applyConfigPatch({
    config: readConfigFile(dataDir),
    patch: { rejection_limit: 4, reviewer_mode: 'loose' },
    stage: 'drafting',
  });
  assert.equal(applied.ok, true);
  persistConfig(dataDir, applied.config);
  const back = readConfigFile(dataDir);
  assert.equal(back.rejection_limit, 4);
  assert.equal(back.reviewer_mode, 'loose');
  assert.equal(back.schema_version, 2);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('writeConfigFile 之后 readConfigFile 保留未知键（升级不丢用户手写字段）', () => {
  const dataDir = tmpDir();
  const cfg = freshConfig({ myCustomKey: 'keep-me' });
  writeConfigFile(dataDir, cfg);
  assert.equal(readConfigFile(dataDir).myCustomKey, 'keep-me');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('buildSettingsSnapshot：形状覆盖配置 / 枚举 / 角色说明 / 模板 / 总线 / 运行台', () => {
  const dir = tmpDir();
  const got = buildSettingsSnapshot({
    config: freshConfig({ sessions: { 'sess-1': true } }),
    sessionId: 'sess-1',
    runtime: { active: false },
    broker: { state: 'attached', port: 18765, pid: 123, message: null },
    env: { GEMINI_CONFIG_DIR: dir },
  });
  assert.equal(got.sessionId, 'sess-1');
  assert.equal(got.enabled, true);
  assert.equal(got.validation.ok, true);
  assert.deepEqual(Object.keys(got.roles).sort(), ['executor', 'planner', 'reviewer']);
  assert.deepEqual(got.enums.role_binding_mode, ['triple', 'dual']);
  assert.deepEqual(got.enums.reviewer_mode, ['strict', 'loose']);
  assert.deepEqual(got.enums.carriers, ['in-process', 'session', 'external']);
  assert.deepEqual(got.enums.rejection_limit, { min: 1, max: 5 });
  assert.equal(got.templates.status, 'not_installed');
  assert.equal(got.broker.state, 'attached');
  assert.equal(got.broker.pid, 123);
  assert.equal(got.runtime.active, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildSettingsSnapshot：没传 runtime 时给 active:false，不伪造任务', () => {
  const dir = tmpDir();
  const got = buildSettingsSnapshot({ config: freshConfig(), env: { GEMINI_CONFIG_DIR: dir } });
  assert.deepEqual(got.runtime, { active: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildSettingsSnapshot：会话没有显式键时回落到全局 enabled', () => {
  const dir = tmpDir();
  const got = buildSettingsSnapshot({
    config: freshConfig({ enabled: true, sessions: {} }),
    sessionId: 'sess-x',
    env: { GEMINI_CONFIG_DIR: dir },
  });
  assert.equal(got.enabled, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('角色说明覆盖三角色的读写边界（照 §6.2）', () => {
  const dir = tmpDir();
  const got = buildSettingsSnapshot({ config: freshConfig(), env: { GEMINI_CONFIG_DIR: dir } });
  assert.match(got.roles.planner.write, /02 plan\.md/);
  assert.match(got.roles.planner.write, /03 tasks\.md/);
  assert.match(got.roles.executor.write, /不写任何六目录文件/);
  assert.match(got.roles.reviewer.write, /04 review-r<N>\.md/);
  assert.match(got.roles.reviewer.note, /不读 02/);
  fs.rmSync(dir, { recursive: true, force: true });
});
