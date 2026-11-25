import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldInjectCollabPrompt } from '../../plugin/dsh-agy-collab/lib/index.js';
import { registerActorSession, resetActorSessions } from '../../plugin/dsh-agy-collab/lib/actor-sessions.js';

function ctxOf(sessionId, origin) {
  return { agent: { session: { header: { id: sessionId, ...(origin ? { origin } : {}) } } } };
}

test('插件自建角色不注入协作提示词（origin 不是 subagent，只能靠白名单）', () => {
  resetActorSessions();
  const enabled = () => true;
  const actor = 'agy-collab-planner-t-1-abcd1234';
  // 没有白名单时，它会被当成普通会话注入 —— 这正是规格 §6.9 要修的 bug
  assert.equal(shouldInjectCollabPrompt(ctxOf(actor), { enabledCheck: enabled }), true);
  registerActorSession(actor);
  assert.equal(shouldInjectCollabPrompt(ctxOf(actor), { enabledCheck: enabled }), false, '登记后必须跳过');
  // 普通用户会话照旧注入
  assert.equal(shouldInjectCollabPrompt(ctxOf('sess-1'), { enabledCheck: enabled }), true);
  resetActorSessions();
});

test('宿主子代理与关着的会话都不注入', () => {
  resetActorSessions();
  const enabled = () => true;
  assert.equal(shouldInjectCollabPrompt(ctxOf('sess-sub', 'subagent'), { enabledCheck: enabled }), false);
  assert.equal(shouldInjectCollabPrompt(ctxOf('sess-1'), { enabledCheck: () => false }), false);
  // 没有上下文时沿用 v1 语义：取不到 sessionId 就按全局开关决定（不改 v1 行为）。
  assert.equal(shouldInjectCollabPrompt(undefined, { enabledCheck: enabled }), true);
  assert.equal(shouldInjectCollabPrompt(undefined, { enabledCheck: () => false }), false);
  resetActorSessions();
});
