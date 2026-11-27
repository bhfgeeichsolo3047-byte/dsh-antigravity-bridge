import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldInjectCollabPrompt } from '../../plugin/dsh-agy-collab/lib/index.js';
import { registerActorSession, resetActorSessions } from '../../plugin/dsh-agy-collab/lib/actor-sessions.js';

function ctxOf(sessionId, origin) {
  return { agent: { session: { header: { id: sessionId, ...(origin ? { origin } : {}) } } } };
}

// v2 默认开启，v1 提示词只在显式关掉 v2 时才注入。测 v1 语义的用例必须显式带上这个 env。
const V1_MODE = { env: { DSH_AGY_COLLAB_V2: '0' } };

test('插件自建角色不注入协作提示词（origin 不是 subagent，只能靠白名单）', () => {
  resetActorSessions();
  const enabled = () => true;
  const actor = 'agy-collab-planner-t-1-abcd1234';
  // 没有白名单时，它会被当成普通会话注入 —— 这正是规格 §6.9 要修的 bug
  assert.equal(shouldInjectCollabPrompt(ctxOf(actor), { enabledCheck: enabled, ...V1_MODE }), true);
  registerActorSession(actor);
  assert.equal(shouldInjectCollabPrompt(ctxOf(actor), { enabledCheck: enabled, ...V1_MODE }), false, '登记后必须跳过');
  // 普通用户会话照旧注入
  assert.equal(shouldInjectCollabPrompt(ctxOf('sess-1'), { enabledCheck: enabled, ...V1_MODE }), true);
  resetActorSessions();
});

test('v2 默认启用时 v1 协作提示词一律不注入；显式关掉才恢复 v1', () => {
  resetActorSessions();
  const enabled = () => true;
  // 默认（env 里没有该变量）：v2 是默认路径，v1 三铁律不注入
  assert.equal(shouldInjectCollabPrompt(ctxOf('sess-1'), { enabledCheck: enabled, env: {} }), false);
  // 显式写 1 也是 v2
  assert.equal(shouldInjectCollabPrompt(ctxOf('sess-1'), { enabledCheck: enabled, env: { DSH_AGY_COLLAB_V2: '1' } }), false);
  // 显式关掉（0/false/off/no）：v1 行为 100% 不变
  for (const value of ['0', 'false', 'off', 'no']) {
    assert.equal(
      shouldInjectCollabPrompt(ctxOf('sess-1'), { enabledCheck: enabled, env: { DSH_AGY_COLLAB_V2: value } }),
      true,
      `DSH_AGY_COLLAB_V2=${value} 应退回 v1`,
    );
  }
  resetActorSessions();
});

test('宿主子代理与关着的会话都不注入', () => {
  resetActorSessions();
  const enabled = () => true;
  assert.equal(shouldInjectCollabPrompt(ctxOf('sess-sub', 'subagent'), { enabledCheck: enabled, ...V1_MODE }), false);
  assert.equal(shouldInjectCollabPrompt(ctxOf('sess-1'), { enabledCheck: () => false, ...V1_MODE }), false);
  // 没有上下文时沿用 v1 语义：取不到 sessionId 就按全局开关决定（不改 v1 行为）。
  assert.equal(shouldInjectCollabPrompt(undefined, { enabledCheck: enabled, ...V1_MODE }), true);
  assert.equal(shouldInjectCollabPrompt(undefined, { enabledCheck: () => false, ...V1_MODE }), false);
  resetActorSessions();
});
