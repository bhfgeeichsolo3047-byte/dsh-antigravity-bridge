import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isActorSession,
  listActorSessions,
  registerActorSession,
  resetActorSessions,
  unregisterActorSession,
} from '../../plugin/dsh-agy-collab/lib/actor-sessions.js';
import { disposeRole, spawnInProcessRole } from '../../plugin/dsh-agy-collab/lib/v2/roles.js';

function makeAgents() {
  return {
    create: async ({ setup }) => {
      await setup({
        tools: { register: () => {}, restrict: () => {} },
        systemPrompt: { section: () => {} },
      });
      return { agent: { whenIdle: async () => {}, followup: () => {} }, dispose: async () => {} };
    },
  };
}

test('登记表只认自己写进去的 sessionId', () => {
  resetActorSessions();
  assert.equal(isActorSession('sess-1'), false, '普通会话不是插件角色');
  assert.equal(registerActorSession('agy-collab-planner-t-1-abcd1234'), true);
  assert.equal(isActorSession('agy-collab-planner-t-1-abcd1234'), true);
  assert.equal(isActorSession('  agy-collab-planner-t-1-abcd1234  '), true, '空白不影响判定');
  assert.equal(registerActorSession(''), false, '空串不收');
  assert.equal(registerActorSession(null), false);
  assert.deepEqual(listActorSessions(), ['agy-collab-planner-t-1-abcd1234']);
  assert.equal(unregisterActorSession('agy-collab-planner-t-1-abcd1234'), true);
  assert.equal(isActorSession('agy-collab-planner-t-1-abcd1234'), false);
  assert.deepEqual(listActorSessions(), []);
  resetActorSessions();
});

test('spawnInProcessRole 成功即登记，disposeRole 后撤销（避免集合无限增长）', async () => {
  resetActorSessions();
  const spawned = await spawnInProcessRole({
    agents: makeAgents(),
    role: 'planner',
    taskId: 't-9',
    workspaceDir: '/w',
    knownGlobalTools: ['read'],
  });
  assert.equal(spawned.ok, true, spawned.error);
  assert.equal(isActorSession(spawned.sessionId), true, '起起来就在白名单里，v1 提示词段据此跳过');
  assert.deepEqual(listActorSessions(), [spawned.sessionId]);

  await disposeRole(spawned.handle, spawned.sessionId);
  assert.equal(isActorSession(spawned.sessionId), false, '角色结束后必须撤销登记');
  assert.deepEqual(listActorSessions(), []);
  resetActorSessions();
});

test('spawn 失败不登记，不会留下幽灵 sessionId', async () => {
  resetActorSessions();
  const agents = {
    create: async ({ setup }) => {
      await setup({ tools: { register: () => {}, restrict: () => { throw new Error('boom'); } } });
      return { agent: {}, dispose: async () => {} };
    },
  };
  const spawned = await spawnInProcessRole({ agents, role: 'reviewer', taskId: 't-9', workspaceDir: '/w', knownGlobalTools: ['read'] });
  assert.equal(spawned.ok, false);
  assert.deepEqual(listActorSessions(), [], 'create 回滚后不许留在白名单');
  resetActorSessions();
});
