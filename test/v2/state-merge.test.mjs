import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readLocalState, setCollabEnabled, isCollabEnabled } from '../../plugin/dsh-agy-collab/lib/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-state-merge-'));
}

/** v2 默认开启后 state.json 里会长出这些字段，v1 的三个开关键必须与它们共存。 */
const V2_FIELDS = {
  schema_version: 2,
  brokerPort: 18765,
  workspaceRoot: 'C:/tmp/ws',
  role_binding_mode: 'triple',
  reviewer_mode: 'strict',
  rejection_limit: 2,
  estimate_subagents: false,
  roles: {
    planner: { carrier: 'in-process', model: null, actor_id: null },
    executor: { carrier: 'session', model: null, actor_id: null },
    reviewer: { carrier: 'in-process', model: null, actor_id: null },
  },
};

function seed(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'state.json'),
    JSON.stringify({ ...V2_FIELDS, enabled: false, sessions: {}, updatedAt: 1 }, null, 2),
  );
}

function readBack(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
}

test('setCollabEnabled 不丢 state.json 里的 v2 字段', () => {
  const dataDir = tmpDir();
  seed(dataDir);

  setCollabEnabled('sess-a', true, { dataDir });
  const after = readBack(dataDir);

  for (const [k, v] of Object.entries(V2_FIELDS)) {
    assert.deepEqual(after[k], v, `字段 ${k} 被抹掉了`);
  }
  assert.equal(after.enabled, true);
  assert.equal(after.sessions['sess-a'], true);
  assert.ok(after.updatedAt > 1);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('setCollabEnabled 只写本会话键，不再把所有会话一起改掉', () => {
  const dataDir = tmpDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'state.json'),
    JSON.stringify({ ...V2_FIELDS, enabled: true, sessions: { 'sess-a': true, 'sess-b': true }, updatedAt: 1 }),
  );

  setCollabEnabled('sess-a', false, { dataDir });
  const after = readBack(dataDir);

  assert.equal(after.sessions['sess-a'], false);
  assert.equal(after.sessions['sess-b'], true, '别的会话不该被牵连');
  assert.equal(isCollabEnabled('sess-b', { dataDir }), true);
  assert.equal(isCollabEnabled('sess-a', { dataDir }), false);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('readLocalState 把未知键原样带出', () => {
  const dataDir = tmpDir();
  seed(dataDir);
  const st = readLocalState({ dataDir });
  assert.equal(st.schema_version, 2);
  assert.deepEqual(st.roles, V2_FIELDS.roles);
  assert.equal(st.enabled, false);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('state.json 不存在时读写不抛错，且首次写入不产生多余键', () => {
  const dataDir = tmpDir();
  const st = readLocalState({ dataDir });
  assert.equal(st.enabled, false);
  assert.deepEqual(st.sessions, {});

  setCollabEnabled('sess-x', true, { dataDir });
  const after = readBack(dataDir);
  assert.deepEqual(Object.keys(after).sort(), ['enabled', 'sessions', 'updatedAt']);
  assert.equal(after.sessions['sess-x'], true);

  fs.rmSync(dataDir, { recursive: true, force: true });
});
