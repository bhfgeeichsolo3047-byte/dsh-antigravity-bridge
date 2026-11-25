/**
 * 插件自建角色的 sessionId 白名单（规格 §6.9）。
 *
 * 宿主判断「这是不是我起的子代理」靠 `session.header.origin === 'subagent'`
 * （`dsh-subagent/src/child-agent.ts:152`），但插件自己 `ctx.agents.create()` 出来的
 * Agent 没有这个标记，会被当成普通用户会话注入协作提示词。
 *
 * 所以判据改成这里：只有真正由插件创建、且还在跑的角色会话才跳过注入。
 * 这个模块零依赖，v1 的提示词段落与 v2 的编排层共用同一份登记表。
 */

const actorSessionIds = new Set();

/** 登记一个插件自建的角色会话。 */
export function registerActorSession(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return false;
  actorSessionIds.add(id);
  return true;
}

/** 角色会话结束后撤销登记（dispose 时调，避免集合无限增长）。 */
export function unregisterActorSession(sessionId) {
  return actorSessionIds.delete(typeof sessionId === 'string' ? sessionId.trim() : '');
}

/** 这个 sessionId 是不是插件自建角色。 */
export function isActorSession(sessionId) {
  return actorSessionIds.has(typeof sessionId === 'string' ? sessionId.trim() : '');
}

/** 当前在跑的角色会话（诊断与测试用）。 */
export function listActorSessions() {
  return [...actorSessionIds];
}

/** 清空登记表（只在测试里用）。 */
export function resetActorSessions() {
  actorSessionIds.clear();
}
