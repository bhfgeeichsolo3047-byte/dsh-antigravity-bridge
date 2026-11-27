/**
 * dsh-agy-collab — 浏览器客户端
 *
 * 两大界面能力：
 *   1. 对话框左侧下方（超出对话栏外侧）的外置控制条：
 *      - 「A↔D 协作: 开 / 关」自主开关按钮
 *      - 「A↔D 看板: 展开 / 收起」右侧边栏看板触发按钮（带实时状态徽标）
 *   2. 右侧边栏可收起 / 展开的「A↔D 协作任务看板」：
 *      - 上半部分：A↔D 协作实时流程图（D 接收任务 → D→A 提交规划 → A→D 返回方案 → D 执行 → D→A 提交结果 → A→D 审核结论 / 返工闭环）
 *      - 下半部分：D 提交给 A 与 A 返回给 D 的完整双向通信卡片列表（支持阶段筛选、长文展开/折叠、一键复制、刷新与清空）
 */

window.__ModuleLoader__.load({
  id: 'dsh-agy-collab',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useMemo } = React;

    const name = 'dsh-agy-collab';
    const inject = ['slots'];

    const HOST_STATE_API = '/api/agy-collab/state';
    const HOST_CLEAR_API = '/api/agy-collab/clear';
    // 设置页（§12）：GET 拿配置 + 运行台快照，POST 只发「要改哪几项」。
    const HOST_CONFIG_API = '/api/agy-collab/config';
    // 直连 broker 的兜底通道：端口不再硬编码（§10.6）。Host 侧 /state 响应会下发
    // brokerPort（env > state.json.brokerPort > 18765），这里只保留一个初始猜测。
    const DEFAULT_BROKER_PORT = 18765;
    const directStateApi = (port) => `http://127.0.0.1:${port || DEFAULT_BROKER_PORT}/state`;
    const directClearApi = (port) => `http://127.0.0.1:${port || DEFAULT_BROKER_PORT}/records/clear`;
    const DRAWER_STORAGE_KEY = 'dsh.agy.collab.drawerOpen';

    const COLLAB_CSS = `
/* ── 左下角外置控制条（紧贴对话框外侧左下角） ── */
.dsh-agy-ext-bar {
  position: fixed;
  z-index: 9980;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  pointer-events: auto;
  transition: opacity 0.15s ease;
}
.dsh-agy-ext-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,127,0.28)) 88%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #ffffff) 92%, transparent);
  backdrop-filter: blur(8px);
  color: var(--dsw-alias-label-secondary, #555);
  font: 500 11.5px/1 var(--ds-font-sans, system-ui, -apple-system, sans-serif);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  transition: all 0.16s ease;
}
body[data-ds-dark-theme] .dsh-agy-ext-btn {
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #262522) 92%, transparent);
  color: var(--dsw-alias-label-secondary, #c7c2b8);
  box-shadow: 0 2px 10px rgba(0,0,0,0.35);
}
.dsh-agy-ext-btn:hover {
  border-color: var(--dsw-alias-border-l2, rgba(127,127,127,0.45));
  color: var(--dsw-alias-label-primary, #111);
  transform: translateY(-0.5px);
}
body[data-ds-dark-theme] .dsh-agy-ext-btn:hover {
  color: var(--dsw-alias-label-primary, #f3efe6);
}
.dsh-agy-ext-btn[aria-checked="true"],
.dsh-agy-ext-btn.is-active {
  color: var(--dsw-alias-brand-primary, #10b981);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #10b981) 52%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #10b981) 14%, var(--dsw-alias-bg-layer-2, #ffffff));
  font-weight: 600;
}
body[data-ds-dark-theme] .dsh-agy-ext-btn[aria-checked="true"],
body[data-ds-dark-theme] .dsh-agy-ext-btn.is-active {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #10b981) 18%, var(--dsw-alias-bg-layer-2, #262522));
}
.dsh-agy-ext-btn[aria-busy="true"] {
  opacity: 0.65;
  pointer-events: none;
}
.dsh-agy-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  box-sizing: border-box;
  border: 1.5px solid color-mix(in srgb, currentColor 60%, transparent);
  background: transparent;
}
.dsh-agy-ext-btn[aria-checked="true"] .dsh-agy-dot {
  background: currentColor;
  border-color: currentColor;
  box-shadow: 0 0 6px color-mix(in srgb, currentColor 75%, transparent);
}
.dsh-agy-mini-pill {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  background: color-mix(in srgb, currentColor 14%, transparent);
}
.dsh-agy-mini-pill.ok { color: #10b981; }
.dsh-agy-mini-pill.warn { color: #f59e0b; }
.dsh-agy-mini-pill.run { color: #3b82f6; }

/* ── 隐形定位探针（不占输入框宽度） ── */
.dsh-agy-probe-zero {
  display: inline-block;
  width: 0;
  height: 0;
  overflow: hidden;
  pointer-events: none;
  position: absolute;
}

/* ── 右侧收起态悬浮耳标 ── */
.dsh-agy-edge-tab {
  position: fixed;
  right: 0;
  top: 46%;
  transform: translateY(-50%);
  z-index: 9985;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 10px 6px;
  border-radius: 10px 0 0 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28));
  border-right: none;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #ffffff) 94%, transparent);
  backdrop-filter: blur(10px);
  color: var(--dsw-alias-label-secondary, #444);
  font: 600 11px/1.2 var(--ds-font-sans, system-ui, sans-serif);
  cursor: pointer;
  box-shadow: -3px 2px 12px rgba(0,0,0,0.12);
  transition: all 0.16s ease;
}
body[data-ds-dark-theme] .dsh-agy-edge-tab {
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #252420) 94%, transparent);
  color: var(--dsw-alias-label-secondary, #d8d3c8);
  box-shadow: -4px 2px 14px rgba(0,0,0,0.45);
}
.dsh-agy-edge-tab:hover {
  padding-right: 9px;
  color: var(--dsw-alias-brand-primary, #10b981);
}
.dsh-agy-edge-tab-v {
  writing-mode: vertical-rl;
  letter-spacing: 1px;
}

/* ── 右侧侧边栏任务看板抽屉 ── */
.dsh-agy-kanban-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(460px, 94vw);
  z-index: 9990;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-layer-1, #f9f9f8);
  color: var(--dsw-alias-label-primary, #1a1a1a);
  border-left: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22));
  box-shadow: -8px 0 28px rgba(0,0,0,0.14);
  font-family: var(--ds-font-sans, system-ui, -apple-system, sans-serif);
  transform: translateX(0);
  transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1), visibility 0.22s;
}
body[data-ds-dark-theme] .dsh-agy-kanban-drawer {
  background: var(--dsw-alias-bg-layer-1, #1e1d1a);
  color: var(--dsw-alias-label-primary, #ece8df);
  border-left-color: var(--dsw-alias-border-l1, rgba(255,255,255,0.12));
  box-shadow: -10px 0 32px rgba(0,0,0,0.52);
}
.dsh-agy-kanban-drawer[data-open="false"] {
  transform: translateX(104%);
  visibility: hidden;
  pointer-events: none;
}

/* 看板头部 */
.dsh-agy-kb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.18));
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  flex: none;
}
body[data-ds-dark-theme] .dsh-agy-kb-head {
  background: var(--dsw-alias-bg-layer-2, #262420);
}
.dsh-agy-kb-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.dsh-agy-kb-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13.5px;
  font-weight: 700;
  margin: 0;
}
.dsh-agy-kb-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #777);
}
.dsh-agy-kb-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.dsh-agy-kb-iconbtn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  padding: 0 8px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22));
  background: transparent;
  color: var(--dsw-alias-label-secondary, #555);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
}
body[data-ds-dark-theme] .dsh-agy-kb-iconbtn {
  color: var(--dsw-alias-label-secondary, #c7c2b8);
}
.dsh-agy-kb-iconbtn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12));
  color: var(--dsw-alias-label-primary, #111);
}
body[data-ds-dark-theme] .dsh-agy-kb-iconbtn:hover {
  color: #fff;
}
.dsh-agy-kb-iconbtn.danger:hover {
  color: #ef4444;
  border-color: rgba(239,68,68,0.4);
}

/* 看板主内容滚动区 */
.dsh-agy-kb-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ── 上半部分：实时流程图 ── */
.dsh-agy-flow-card {
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2));
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
body[data-ds-dark-theme] .dsh-agy-flow-card {
  background: var(--dsw-alias-bg-layer-2, #25231f);
}
.dsh-agy-section-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dsh-agy-section-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--dsw-alias-label-primary, #222);
  display: flex;
  align-items: center;
  gap: 6px;
}
body[data-ds-dark-theme] .dsh-agy-section-title {
  color: #f0ece1;
}
.dsh-agy-flow-status-tag {
  font-size: 10.5px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(127,127,127,0.12);
  color: var(--dsw-alias-label-secondary, #666);
}
.dsh-agy-flow-status-tag.done { background: rgba(16,185,129,0.14); color: #10b981; }
.dsh-agy-flow-status-tag.active { background: rgba(59,130,246,0.15); color: #3b82f6; }
.dsh-agy-flow-status-tag.warn { background: rgba(245,158,11,0.16); color: #f59e0b; }

.dsh-agy-flow-grid {
  display: grid;
  grid-template-columns: 1fr 18px 1fr 18px 1fr;
  align-items: center;
  row-gap: 8px;
  column-gap: 2px;
}
.dsh-agy-flow-node {
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22));
  background: var(--dsw-alias-bg-layer-1, #f6f6f5);
  padding: 7px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  transition: all 0.2s ease;
}
body[data-ds-dark-theme] .dsh-agy-flow-node {
  background: var(--dsw-alias-bg-layer-1, #1b1a17);
}
.dsh-agy-flow-node.is-done {
  border-color: rgba(16,185,129,0.45);
  background: color-mix(in srgb, #10b981 9%, var(--dsw-alias-bg-layer-1, #f6f6f5));
}
.dsh-agy-flow-node.is-active {
  border-color: #3b82f6;
  background: color-mix(in srgb, #3b82f6 12%, var(--dsw-alias-bg-layer-1, #f6f6f5));
  box-shadow: 0 0 0 2px rgba(59,130,246,0.18);
}
.dsh-agy-flow-node.is-warn {
  border-color: rgba(245,158,11,0.6);
  background: color-mix(in srgb, #f59e0b 12%, var(--dsw-alias-bg-layer-1, #f6f6f5));
}
.dsh-agy-flow-step {
  font-size: 10px;
  font-weight: 700;
  color: var(--dsw-alias-label-tertiary, #888);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}
.dsh-agy-flow-node.is-done .dsh-agy-flow-step { color: #10b981; }
.dsh-agy-flow-node.is-active .dsh-agy-flow-step { color: #3b82f6; }
.dsh-agy-flow-node.is-warn .dsh-agy-flow-step { color: #f59e0b; }

.dsh-agy-flow-name {
  font-size: 11px;
  font-weight: 600;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-agy-flow-desc {
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, #777);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-agy-flow-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-label-tertiary, #999);
  font-size: 12px;
  font-weight: 700;
}
.dsh-agy-flow-arrow.is-done { color: #10b981; }
.dsh-agy-flow-arrow.is-active { color: #3b82f6; }
.dsh-agy-flow-arrow.is-warn { color: #f59e0b; }

.dsh-agy-flow-rowlink {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, #888);
}
.dsh-agy-flow-loop-note {
  font-size: 10.5px;
  padding: 5px 8px;
  border-radius: 7px;
  background: rgba(245,158,11,0.12);
  border: 1px dashed rgba(245,158,11,0.45);
  color: #d97706;
}
body[data-ds-dark-theme] .dsh-agy-flow-loop-note {
  color: #fbbf24;
}

/* ── 下半部分：筛选条与双向通信卡片 ── */
.dsh-agy-filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.dsh-agy-filter-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,127,0.16)) 45%, transparent);
}
.dsh-agy-filter-tab {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #666);
  font-size: 11px;
  font-weight: 500;
  padding: 4px 9px;
  border-radius: 6px;
  cursor: pointer;
}
body[data-ds-dark-theme] .dsh-agy-filter-tab {
  color: #b7b2a8;
}
.dsh-agy-filter-tab.is-on {
  background: var(--dsw-alias-bg-layer-2, #fff);
  color: var(--dsw-alias-label-primary, #111);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
}
body[data-ds-dark-theme] .dsh-agy-filter-tab.is-on {
  background: var(--dsw-alias-bg-layer-2, #2d2b26);
  color: #fff;
}

.dsh-agy-rec-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dsh-agy-rec-card {
  border-radius: 11px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2));
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  overflow: hidden;
  transition: border-color 0.15s ease;
}
body[data-ds-dark-theme] .dsh-agy-rec-card {
  background: var(--dsw-alias-bg-layer-2, #25231f);
}
.dsh-agy-rec-card.is-selected {
  border-color: var(--dsw-alias-brand-primary, #10b981);
}
.dsh-agy-rec-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 11px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #f5f5f4) 65%, transparent);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.14));
  cursor: pointer;
}
body[data-ds-dark-theme] .dsh-agy-rec-hd {
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #1c1b18) 65%, transparent);
}
.dsh-agy-rec-hd-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-wrap: wrap;
}
.dsh-agy-round-num {
  font-size: 10.5px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 5px;
  background: rgba(127,127,127,0.15);
}
.dsh-agy-phase-tag {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 6px;
}
.dsh-agy-phase-tag.plan {
  background: rgba(59,130,246,0.14);
  color: #2563eb;
}
body[data-ds-dark-theme] .dsh-agy-phase-tag.plan {
  color: #60a5fa;
}
.dsh-agy-phase-tag.review {
  background: rgba(139,92,246,0.14);
  color: #7c3aed;
}
body[data-ds-dark-theme] .dsh-agy-phase-tag.review {
  color: #a78bfa;
}
.dsh-agy-phase-tag.consult {
  background: rgba(139,92,246,0.14);
  color: #8b5cf6;
}
body[data-ds-dark-theme] .dsh-agy-phase-tag.consult {
  color: #c4b5fd;
}
.dsh-agy-rec-meta {
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, #888);
  white-space: nowrap;
}

.dsh-agy-verdict {
  font-size: 10.5px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 999px;
  white-space: nowrap;
}
.dsh-agy-verdict.approved { background: rgba(16,185,129,0.16); color: #10b981; }
.dsh-agy-verdict.plan_ready { background: rgba(59,130,246,0.16); color: #3b82f6; }
.dsh-agy-verdict.consult_answered { background: rgba(139,92,246,0.14); color: #8b5cf6; }
.dsh-agy-verdict.changes { background: rgba(245,158,11,0.18); color: #d97706; }
.dsh-agy-verdict.waiting { background: rgba(127,127,127,0.16); color: var(--dsw-alias-label-secondary, #666); }

/* 双向消息块 */
.dsh-agy-msg-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 11px;
}
.dsh-agy-msg-box {
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.16));
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dsh-agy-msg-box.d2a {
  background: color-mix(in srgb, #3b82f6 5%, var(--dsw-alias-bg-layer-1, #fafaf9));
  border-left: 3px solid #3b82f6;
}
.dsh-agy-msg-box.a2d {
  background: color-mix(in srgb, #10b981 5%, var(--dsw-alias-bg-layer-1, #fafaf9));
  border-left: 3px solid #10b981;
}
.dsh-agy-msg-box.a2d.changes {
  background: color-mix(in srgb, #f59e0b 7%, var(--dsw-alias-bg-layer-1, #fafaf9));
  border-left-color: #f59e0b;
}
body[data-ds-dark-theme] .dsh-agy-msg-box.d2a {
  background: color-mix(in srgb, #3b82f6 8%, var(--dsw-alias-bg-layer-1, #1c1b18));
}
body[data-ds-dark-theme] .dsh-agy-msg-box.a2d {
  background: color-mix(in srgb, #10b981 8%, var(--dsw-alias-bg-layer-1, #1c1b18));
}
body[data-ds-dark-theme] .dsh-agy-msg-box.a2d.changes {
  background: color-mix(in srgb, #f59e0b 9%, var(--dsw-alias-bg-layer-1, #1c1b18));
}

.dsh-agy-msg-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  font-weight: 700;
}
.dsh-agy-field-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dsh-agy-field-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--dsw-alias-label-tertiary, #888);
}
.dsh-agy-pre {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-primary, #222);
}
body[data-ds-dark-theme] .dsh-agy-pre {
  color: #e6e2d8;
}
.dsh-agy-text-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
.dsh-agy-tiny-btn {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22));
  background: transparent;
  color: var(--dsw-alias-label-secondary, #666);
  border-radius: 5px;
  font-size: 10px;
  padding: 2px 7px;
  cursor: pointer;
}
body[data-ds-dark-theme] .dsh-agy-tiny-btn {
  color: #c2bdb2;
}
.dsh-agy-tiny-btn:hover {
  background: rgba(127,127,127,0.12);
}
.dsh-agy-empty {
  padding: 26px 14px;
  text-align: center;
  border-radius: 10px;
  border: 1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,0.28));
  color: var(--dsw-alias-label-tertiary, #888);
  font-size: 12px;
  line-height: 1.6;
}
/* ── 分页（任务看板 / 设置与运行台）───────────────────────────── */
.dsh-agy-kb-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 14px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22));
}
body[data-ds-dark-theme] .dsh-agy-kb-tabs {
  border-bottom-color: rgba(255,255,255,0.1);
}
.dsh-agy-kb-tab {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #888);
  font-size: 11.5px;
  font-weight: 600;
  padding: 6px 10px 8px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
body[data-ds-dark-theme] .dsh-agy-kb-tab {
  color: #a9a49a;
}
.dsh-agy-kb-tab:hover {
  color: var(--dsw-alias-label-primary, #222);
}
.dsh-agy-kb-tab.is-on {
  color: var(--dsw-alias-label-primary, #222);
  border-bottom-color: #10b981;
}
body[data-ds-dark-theme] .dsh-agy-kb-tab.is-on {
  color: #f0ece2;
}
/* ── 设置页：卡片 / 行 / 开关 / 分段 / 步进器 ───────────────── */
.dsh-agy-set-card {
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22));
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
body[data-ds-dark-theme] .dsh-agy-set-card {
  border-color: rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.02);
}
.dsh-agy-set-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.dsh-agy-set-row-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dsh-agy-set-name {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #222);
}
body[data-ds-dark-theme] .dsh-agy-set-name {
  color: #ece7dc;
}
.dsh-agy-set-hint {
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, #888);
  line-height: 1.45;
}
.dsh-agy-sw {
  appearance: none;
  flex: none;
  width: 34px;
  height: 19px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35));
  background: rgba(127,127,127,0.22);
  position: relative;
  cursor: pointer;
  transition: background 120ms ease;
}
.dsh-agy-sw::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #fff;
  transition: transform 120ms ease;
}
.dsh-agy-sw[aria-checked="true"] {
  background: #10b981;
  border-color: #10b981;
}
.dsh-agy-sw[aria-checked="true"]::after {
  transform: translateX(15px);
}
.dsh-agy-sw:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.dsh-agy-seg {
  display: inline-flex;
  flex: none;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28));
  overflow: hidden;
}
.dsh-agy-seg button {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #666);
  font-size: 10.5px;
  padding: 4px 9px;
  cursor: pointer;
}
body[data-ds-dark-theme] .dsh-agy-seg button {
  color: #b8b3a8;
}
.dsh-agy-seg button.is-on {
  background: rgba(16,185,129,0.16);
  color: #0f9d6f;
  font-weight: 600;
}
body[data-ds-dark-theme] .dsh-agy-seg button.is-on {
  color: #5fe0b4;
}
.dsh-agy-stepper {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 2px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28));
  padding: 1px;
}
.dsh-agy-stepper button {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #666);
  width: 20px;
  height: 18px;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  border-radius: 5px;
}
.dsh-agy-stepper button:hover:not(:disabled) {
  background: rgba(127,127,127,0.14);
}
.dsh-agy-stepper button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.dsh-agy-stepper-v {
  min-width: 20px;
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #222);
}
body[data-ds-dark-theme] .dsh-agy-stepper-v {
  color: #ece7dc;
}
.dsh-agy-input {
  appearance: none;
  flex: 1;
  min-width: 0;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28));
  background: transparent;
  color: var(--dsw-alias-label-primary, #222);
  border-radius: 7px;
  font-size: 10.5px;
  padding: 4px 7px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
body[data-ds-dark-theme] .dsh-agy-input {
  color: #ece7dc;
  border-color: rgba(255,255,255,0.14);
}
.dsh-agy-btnrow {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.dsh-agy-btn {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28));
  background: transparent;
  color: var(--dsw-alias-label-secondary, #555);
  border-radius: 7px;
  font-size: 10.5px;
  padding: 4px 9px;
  cursor: pointer;
}
body[data-ds-dark-theme] .dsh-agy-btn {
  color: #c2bdb2;
  border-color: rgba(255,255,255,0.14);
}
.dsh-agy-btn:hover:not(:disabled) {
  background: rgba(127,127,127,0.12);
}
.dsh-agy-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.dsh-agy-btn.primary {
  border-color: rgba(16,185,129,0.5);
  color: #0f9d6f;
  font-weight: 600;
}
body[data-ds-dark-theme] .dsh-agy-btn.primary {
  color: #5fe0b4;
}
.dsh-agy-btn.danger:hover:not(:disabled) {
  background: rgba(217,119,6,0.14);
  border-color: rgba(217,119,6,0.45);
  color: #b45309;
}
/* ── 角色绑定折叠行 ─────────────────────────────────────────── */
.dsh-agy-role-row {
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22));
  padding: 0;
  overflow: hidden;
}
body[data-ds-dark-theme] .dsh-agy-role-row {
  border-color: rgba(255,255,255,0.1);
}
.dsh-agy-role-line {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  cursor: pointer;
  list-style: none;
  font-size: 11px;
}
.dsh-agy-role-line::-webkit-details-marker {
  display: none;
}
.dsh-agy-role-line:hover {
  background: rgba(127,127,127,0.08);
}
.dsh-agy-role-title {
  font-weight: 700;
  flex: none;
  color: var(--dsw-alias-label-primary, #222);
}
body[data-ds-dark-theme] .dsh-agy-role-title {
  color: #ece7dc;
}
.dsh-agy-role-brief {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, #888);
  font-size: 10px;
}
.dsh-agy-role-chev {
  flex: none;
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, #888);
}
.dsh-agy-role-row[open] .dsh-agy-role-chev::after {
  content: '收起';
}
.dsh-agy-role-row:not([open]) .dsh-agy-role-chev::after {
  content: '展开';
}
.dsh-agy-role-body {
  padding: 2px 9px 9px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsh-agy-role-fields {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dsh-agy-field {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10.5px;
  color: var(--dsw-alias-label-secondary, #666);
}
body[data-ds-dark-theme] .dsh-agy-field {
  color: #b8b3a8;
}
.dsh-agy-field-k {
  flex: none;
  width: 42px;
}
.dsh-agy-select {
  appearance: none;
  flex: 1;
  min-width: 0;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28));
  background: transparent;
  color: var(--dsw-alias-label-primary, #222);
  border-radius: 7px;
  font-size: 10.5px;
  padding: 3px 6px;
}
body[data-ds-dark-theme] .dsh-agy-select {
  color: #ece7dc;
  border-color: rgba(255,255,255,0.14);
  background: #1c1c1a;
}
/* ── 已定项（绿左边框）/ 待定项（灰虚线）─────────────────── */
.dsh-agy-settled {
  border-left: 2px solid rgba(16,185,129,0.55);
  padding: 5px 0 5px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dsh-agy-sh-line {
  font-size: 10px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #666);
}
body[data-ds-dark-theme] .dsh-agy-sh-line {
  color: #b8b3a8;
}
.dsh-agy-sh-label {
  font-weight: 700;
  color: var(--dsw-alias-label-primary, #222);
}
body[data-ds-dark-theme] .dsh-agy-sh-label {
  color: #ece7dc;
}
.dsh-agy-badge-s {
  display: inline-block;
  margin-left: 5px;
  font-size: 9px;
  font-weight: 600;
  padding: 0 4px;
  border-radius: 4px;
  background: rgba(16,185,129,0.16);
  color: #0f9d6f;
  vertical-align: 1px;
}
body[data-ds-dark-theme] .dsh-agy-badge-s {
  color: #5fe0b4;
}
/* ── 置顶常驻状态条 ─────────────────────────────────────────── */
.dsh-agy-pinbar {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 9px;
  border-radius: 9px;
  background: rgba(127,127,127,0.09);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2));
  font-size: 10.5px;
  overflow: hidden;
}
body[data-ds-dark-theme] .dsh-agy-pinbar {
  border-color: rgba(255,255,255,0.1);
}
.dsh-agy-pdot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #10b981;
}
.dsh-agy-pdot.idle {
  background: #9ca3af;
}
.dsh-agy-ptask {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #222);
}
body[data-ds-dark-theme] .dsh-agy-ptask {
  color: #ece7dc;
}
.dsh-agy-pstate {
  flex: none;
  font-weight: 600;
  color: #2563eb;
}
.dsh-agy-pcount {
  flex: none;
  color: #b45309;
}
.dsh-agy-pwhere {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, #888);
}
/* ── 分隔线：以上为配置 · 以下为现状 ──────────────────────── */
.dsh-agy-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, #888);
}
.dsh-agy-divider::before,
.dsh-agy-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--dsw-alias-border-l1, rgba(127,127,127,0.22));
}
body[data-ds-dark-theme] .dsh-agy-divider::before,
body[data-ds-dark-theme] .dsh-agy-divider::after {
  background: rgba(255,255,255,0.1);
}
/* ── 当前任务 6 格 ─────────────────────────────────────────── */
.dsh-agy-grid6 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}
.dsh-agy-cell {
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22));
  padding: 5px 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
body[data-ds-dark-theme] .dsh-agy-cell {
  border-color: rgba(255,255,255,0.1);
}
.dsh-agy-cell.is-on {
  border-color: rgba(16,185,129,0.45);
  background: rgba(16,185,129,0.07);
}
.dsh-agy-cell.is-pending {
  opacity: 0.55;
}
.dsh-agy-cname {
  font-size: 9px;
  color: var(--dsw-alias-label-tertiary, #888);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-agy-cmeta {
  font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--dsw-alias-label-primary, #222);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
body[data-ds-dark-theme] .dsh-agy-cmeta {
  color: #ece7dc;
}
/* ── 工作台文件表 ─────────────────────────────────────────── */
.dsh-agy-files {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.dsh-agy-frow {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  padding: 3px 0;
  border-bottom: 1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,0.16));
}
.dsh-agy-frow:last-child {
  border-bottom: 0;
}
.dsh-agy-fpath {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--dsw-alias-label-primary, #222);
}
body[data-ds-dark-theme] .dsh-agy-fpath {
  color: #ece7dc;
}
.dsh-agy-ftag {
  flex: none;
  font-size: 9px;
  color: var(--dsw-alias-label-tertiary, #888);
}
.dsh-agy-fstate {
  flex: none;
  font-size: 9px;
  font-weight: 600;
}
.dsh-agy-fstate.on {
  color: #0f9d6f;
}
.dsh-agy-fstate.off {
  color: var(--dsw-alias-label-tertiary, #999);
}
/* 长值行（actor session id / 路径）：不省略，折行显示，右侧对齐 */
.dsh-agy-frow.wrap {
  align-items: flex-start;
}
.dsh-agy-frow.wrap .dsh-agy-ftag {
  flex: 1;
  min-width: 0;
  text-align: right;
  word-break: break-all;
  line-height: 1.45;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
body[data-ds-dark-theme] .dsh-agy-fstate.on {
  color: #5fe0b4;
}
.dsh-agy-warn-note {
  border-radius: 7px;
  border: 1px dashed rgba(217,119,6,0.45);
  background: rgba(217,119,6,0.07);
  padding: 5px 7px;
  font-size: 10px;
  line-height: 1.5;
  color: #b45309;
}
body[data-ds-dark-theme] .dsh-agy-warn-note {
  color: #f0b866;
}
.dsh-agy-save-note {
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, #888);
}
.dsh-agy-save-note.err {
  color: #b91c1c;
}
body[data-ds-dark-theme] .dsh-agy-save-note.err {
  color: #f87171;
}
`;

    function readDrawerOpenPref() {
      try {
        return window.localStorage.getItem(DRAWER_STORAGE_KEY) === '1';
      } catch {
        return false;
      }
    }

    function saveDrawerOpenPref(open) {
      try {
        window.localStorage.setItem(DRAWER_STORAGE_KEY, open ? '1' : '0');
      } catch {
        // ignore
      }
    }

    // 全局共享状态总线：左下方外置控制条、右侧耳标与看板抽屉实时同步
    const store = {
      enabled: false,
      brokerOnline: false,
      aListening: false,
      pendingCount: 0,
      // broker 端口与四态（§12.4）：由 Host 侧 /state 响应下发，不在客户端写死。
      brokerPort: DEFAULT_BROKER_PORT,
      brokerState: null,
      brokerMessage: null,
      brokerPid: null,
      records: [],
      drawerOpen: readDrawerOpenPref(),
      sessionId: '',
      composerBoxEl: null,
      // 设置页快照（config / runtime / templates / broker）与最近一次保存的结果
      settings: null,
      settingsError: null,
      settingsSaving: false,
      listeners: new Set(),
    };

    function notifyStore() {
      const snap = {
        enabled: store.enabled,
        brokerOnline: store.brokerOnline,
        aListening: store.aListening,
        pendingCount: store.pendingCount,
        brokerPort: store.brokerPort,
        brokerState: store.brokerState,
        brokerMessage: store.brokerMessage,
        brokerPid: store.brokerPid,
        records: store.records,
        drawerOpen: store.drawerOpen,
        sessionId: store.sessionId,
        composerBoxEl: store.composerBoxEl,
        settings: store.settings,
        settingsError: store.settingsError,
        settingsSaving: store.settingsSaving,
      };
      for (const fn of [...store.listeners]) {
        try { fn(snap); } catch { /* ignore */ }
      }
    }

    function setDrawerOpen(next) {
      const val = Boolean(next);
      const changed = store.drawerOpen !== val;
      if (changed) {
        store.drawerOpen = val;
        saveDrawerOpenPref(val);
        notifyStore();
      }
      if (val) {
        refreshAll(store.sessionId);
      }
    }

    async function fetchJsonWithTimeout(url, init) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2500);
        const res = await fetch(url, { ...init, signal: ctrl.signal });
        clearTimeout(timer);
        if (res && res.ok) {
          const data = await res.json();
          if (data && data.ok) return data;
        }
      } catch {
        // ignore network or CSP error on individual endpoint
      }
      return null;
    }

    async function callEndpoint(hostUrl, directUrl, method, sessionId, bodyObj) {
      const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
      const init = {
        method,
        headers: bodyObj ? { 'content-type': 'application/json' } : undefined,
        body: bodyObj ? JSON.stringify(bodyObj) : undefined,
        cache: 'no-store',
      };

      if (method !== 'GET') {
        const [hostRes, directRes] = await Promise.all([
          fetchJsonWithTimeout(hostUrl + qs, init),
          fetchJsonWithTimeout(directUrl + qs, init),
        ]);
        const primary = hostRes || directRes;
        if (!primary) return null;
        if (!Array.isArray(primary.records) && directRes && Array.isArray(directRes.records)) {
          return { ...primary, records: directRes.records };
        }
        return primary;
      }

      const hostData = await fetchJsonWithTimeout(hostUrl + qs, init);
      const hostRecs = Array.isArray(hostData?.records) ? hostData.records : null;
      if (hostData && hostRecs && hostRecs.length > 0) {
        return hostData;
      }

      const directData = await fetchJsonWithTimeout(directUrl + qs, init);
      if (!hostData) return directData;
      if (!directData) return hostData;

      const directRecs = Array.isArray(directData.records) ? directData.records : [];
      const bestRecs =
        hostRecs && hostRecs.length >= directRecs.length ? hostRecs : directRecs;
      return {
        ...directData,
        ...hostData,
        records: bestRecs,
      };
    }

    function applyServerSnapshot(data) {
      if (!data || !data.ok) return;
      store.enabled = Boolean(data.enabled);
      store.brokerOnline = Boolean(data.brokerOnline);
      store.aListening = Boolean(data.aListening);
      store.pendingCount = Number(data.pendingCount || 0);
      if (Number.isInteger(Number(data.brokerPort)) && Number(data.brokerPort) > 0) {
        store.brokerPort = Number(data.brokerPort);
      }
      store.brokerState = typeof data.brokerState === 'string' ? data.brokerState : null;
      store.brokerMessage = typeof data.brokerMessage === 'string' ? data.brokerMessage : null;
      store.brokerPid = Number.isInteger(Number(data.brokerPid)) ? Number(data.brokerPid) : null;
      if (Array.isArray(data.records)) {
        store.records = data.records;
      }
      notifyStore();
    }

    async function refreshAll(sessionId) {
      const sid = typeof sessionId === 'string' ? sessionId : store.sessionId;
      const data = await callEndpoint(HOST_STATE_API, directStateApi(store.brokerPort), 'GET', sid, null);
      if (data && data.ok) applyServerSnapshot(data);
      return data;
    }

    async function toggleCollab(sessionId) {
      const sid = typeof sessionId === 'string' ? sessionId : store.sessionId;
      const prev = store.enabled;
      const want = !prev;
      store.enabled = want;
      notifyStore();

      const data = await callEndpoint(HOST_STATE_API, directStateApi(store.brokerPort), 'POST', sid, {
        sessionId: sid || '',
        enabled: want,
      });
      if (data && data.ok) {
        applyServerSnapshot(data);
      } else {
        store.enabled = prev;
        notifyStore();
      }
      return data;
    }

    /** 读设置页快照（配置 + 运行台 + 模板三态 + 总线四态）。 */
    async function refreshSettings(sessionId) {
      const sid = typeof sessionId === 'string' ? sessionId : store.sessionId;
      const qs = sid ? `?sessionId=${encodeURIComponent(sid)}` : '';
      const data = await fetchJsonWithTimeout(HOST_CONFIG_API + qs, { cache: 'no-store' });
      if (data && data.ok) {
        store.settings = data;
        store.settingsError = null;
        notifyStore();
      }
      return data;
    }

    /**
     * 提交一份配置 patch。客户端只发「要改哪几项」，落盘前的一切校验都在 Host 侧，
     * 失败时把 Host 返回的错误原样显示（不猜、不改写成友好文案）。
     */
    async function saveSettingsPatch(patch) {
      store.settingsSaving = true;
      store.settingsError = null;
      notifyStore();
      const qs = store.sessionId ? `?sessionId=${encodeURIComponent(store.sessionId)}` : '';
      let data = null;
      try {
        const res = await fetch(HOST_CONFIG_API + qs, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({ sessionId: store.sessionId || '', patch }),
        });
        data = await res.json();
      } catch (error) {
        data = { ok: false, error: String(error?.message || error) };
      }
      store.settingsSaving = false;
      if (data && data.ok) {
        store.settings = data;
        store.settingsError = null;
        // 协作开关与总线端口会随配置一起变，顺手把主看板也刷新一遍。
        applyServerSnapshot({
          ok: true,
          enabled: data.enabled,
          brokerPort: data.broker?.port,
          brokerState: data.broker?.state,
          brokerMessage: data.broker?.message,
          brokerPid: data.broker?.pid,
        });
      } else {
        store.settingsError = String(data?.error || '保存失败');
        notifyStore();
      }
      return data;
    }

    async function clearAllRecords() {
      const data = await callEndpoint(HOST_CLEAR_API, directClearApi(store.brokerPort), 'POST', store.sessionId, {});
      if (data && data.ok) {
        store.records = Array.isArray(data.records) ? data.records : [];
        notifyStore();
      }
      return data;
    }

    function useCollabStore() {
      const [snap, setSnap] = useState(() => ({
        enabled: store.enabled,
        brokerOnline: store.brokerOnline,
        aListening: store.aListening,
        pendingCount: store.pendingCount,
        brokerPort: store.brokerPort,
        brokerState: store.brokerState,
        brokerMessage: store.brokerMessage,
        brokerPid: store.brokerPid,
        records: store.records,
        drawerOpen: store.drawerOpen,
        sessionId: store.sessionId,
        composerBoxEl: store.composerBoxEl,
        settings: store.settings,
        settingsError: store.settingsError,
        settingsSaving: store.settingsSaving,
      }));
      useEffect(() => {
        const listener = (next) => setSnap(next);
        store.listeners.add(listener);
        return () => {
          store.listeners.delete(listener);
        };
      }, []);
      return snap;
    }

    /** 查找当前对话框外框 DOM 元素 */
    function findComposerBoxFromNode(node) {
      if (node && typeof node.closest === 'function') {
        const direct = node.closest('[data-composer-card], [data-composer-seat]');
        if (direct) return direct;
        let cur = node.parentElement;
        let depth = 0;
        let fallback = null;
        while (cur && cur !== document.body && depth < 12) {
          const hasInput = Boolean(cur.querySelector('textarea, [contenteditable="true"]'));
          const rect = cur.getBoundingClientRect();
          if (hasInput && rect.width >= 260 && rect.height >= 44 && rect.height <= 460) {
            // 优先取带圆角/边框的对话框外框，或最接近外层但不过大的卡片
            const style = window.getComputedStyle(cur);
            const hasBorderOrBg =
              (parseFloat(style.borderRadius) || 0) >= 8 ||
              (style.boxShadow && style.boxShadow !== 'none') ||
              (parseFloat(style.borderTopWidth) || 0) > 0;
            fallback = cur;
            if (hasBorderOrBg) return cur;
          }
          cur = cur.parentElement;
          depth += 1;
        }
        if (fallback) return fallback;
      }
      if (typeof document !== 'undefined') {
        const globalCard = document.querySelector('[data-composer-card], [data-composer-seat]');
        if (globalCard) return globalCard;
        const ta = document.querySelector('main textarea, [role="main"] textarea, textarea');
        if (ta) {
          let cur = ta.parentElement;
          let depth = 0;
          while (cur && cur !== document.body && depth < 8) {
            const rect = cur.getBoundingClientRect();
            const style = window.getComputedStyle(cur);
            if (rect.width >= 260 && rect.height >= 44 && rect.height <= 460 && (parseFloat(style.borderRadius) || 0) >= 8) {
              return cur;
            }
            cur = cur.parentElement;
            depth += 1;
          }
        }
      }
      return null;
    }

    /**
     * 挂载于 conversation.input.right 的隐形锚点探针：
     * 不占用对话框内部空间，仅用于定位对话框外框 DOM 与同步当前 sessionId。
     */
    function ComposerAnchorProbe(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
      const probeRef = useRef(null);

      useEffect(() => {
        store.sessionId = sessionId;
        refreshAll(sessionId);
      }, [sessionId]);

      useEffect(() => {
        let rafId = 0;
        const syncBox = () => {
          const box = findComposerBoxFromNode(probeRef.current);
          if (store.composerBoxEl !== box) {
            store.composerBoxEl = box;
            notifyStore();
          }
        };
        rafId = window.requestAnimationFrame(syncBox);
        const timer = window.setInterval(syncBox, 1000);
        return () => {
          window.cancelAnimationFrame(rafId);
          window.clearInterval(timer);
          if (store.composerBoxEl) {
            store.composerBoxEl = null;
            notifyStore();
          }
        };
      }, [sessionId]);

      return h('span', {
        ref: probeRef,
        className: 'dsh-agy-probe-zero',
        'aria-hidden': 'true',
      });
    }

    /** 格式化时间 HH:MM:SS */
    function fmtTime(ts) {
      if (!ts) return '';
      try {
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      } catch {
        return '';
      }
    }

    function fmtDuration(start, end) {
      if (!start || !end || end < start) return '';
      const sec = Math.round((end - start) / 1000);
      if (sec < 60) return `${sec}s`;
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${m}m ${s}s`;
    }

    /** 记录的 role：新协议直接给 role；旧记录只有 phase，按 phase 推断（review→reviewer，其余→planner）。 */
    function roleOf(rec) {
      const role = String(rec?.role || '').toLowerCase();
      if (role === 'planner' || role === 'reviewer') return role;
      return String(rec?.phase || '').toLowerCase() === 'review' ? 'reviewer' : 'planner';
    }

    /**
     * 把一次往返回执归一成三档：pending（还没回）/ pass / needs_revision。
     * 新协议回执只带 verdict: pass | needs_revision；旧词表（APPROVED / PLAN_READY …）
     * 只做兼容映射，不再往界面上输出 —— §9.2 定的是删除而不是翻译。
     */
    function verdictOf(rec) {
      if (!rec || rec.status !== 'replied') return 'pending';
      const raw = String(rec.aToD?.verdict || '').trim().toLowerCase();
      if (raw === 'pass' || raw === 'approved') return 'pass';
      if (raw === 'needs_revision' || raw === 'changes_requested') return 'needs_revision';
      // 旧协议里 plan / consult 阶段的回执本来就不是审核结论，一律当作「已回复」处理。
      return 'pass';
    }

    /**
     * 计算某组（或最新）记录在 6 步流程图上的状态。
     *
     * 六个节点按角色分工切，不再按旧 phase：
     *   0 D 接收任务 / 1 D → 规划 agent 提交需求 / 2 规划 agent 回 02 与 03
     *   3 D 执行任务 / 4 D → 审核 agent 送审 / 5 审核 agent 回 verdict
     */
    function computeFlowSteps(records, focusRecord) {
      const list = Array.isArray(records) ? records : [];
      if (!list.length) {
        return {
          states: ['idle', 'idle', 'idle', 'idle', 'idle', 'idle'],
          badgeText: '等待任务转达',
          badgeTone: '',
          reworkNote: '',
        };
      }

      // 取焦点记录所属的近期任务循环（若有选中则看选中所在轮次，否则看最新几条）
      const target = focusRecord || list[list.length - 1];
      const idx = list.findIndex((r) => r.requestId === target.requestId);
      const slice = idx >= 0 ? list.slice(0, idx + 1) : list;

      // 同一任务流里找最近的一次 planner 请求与最近的一次 reviewer 请求。
      let latestPlanner = null;
      let latestReviewer = null;
      for (let i = slice.length - 1; i >= 0; i--) {
        const r = slice[i];
        const role = roleOf(r);
        if (role === 'reviewer') {
          if (!latestReviewer) latestReviewer = r;
        } else if (!latestPlanner) {
          latestPlanner = r;
        }
      }
      // 选中的就是某一轮的请求：以它为准，不看它之后的轮次。
      const focusRole = roleOf(target);
      if (focusRole === 'reviewer') latestReviewer = target;
      else latestPlanner = target;
      if (target.status !== 'replied') {
        if (focusRole === 'reviewer') latestReviewer = target;
        else latestPlanner = target;
      }

      // 6 个节点（按角色分工，不再按旧 phase）：
      // 0: D 接收任务
      // 1: D → 规划 agent 提交需求
      // 2: 规划 agent 写 02 plan.md + 03 tasks.md
      // 3: D 按 03 执行
      // 4: D → 审核 agent 送审
      // 5: 审核 agent 写 04 verdict
      const states = ['done', 'idle', 'idle', 'idle', 'idle', 'idle'];
      let badgeText = '待命';
      let badgeTone = '';
      let reworkNote = '';

      if (!latestReviewer) {
        // 只有规划轮：要么在等规划 agent，要么方案已回、D 正在执行。
        if (latestPlanner && latestPlanner.status !== 'replied') {
          states[1] = 'active';
          badgeText = '规划 agent 正在拆解任务…';
          badgeTone = 'active';
        } else if (latestPlanner) {
          states[1] = 'done';
          states[2] = 'done';
          states[3] = 'active';
          badgeText = 'D 按 03-任务清单 执行中';
          badgeTone = 'active';
        }
      } else {
        states[1] = 'done';
        states[2] = 'done';
        states[3] = 'done';
        const v = verdictOf(latestReviewer);
        if (v === 'pending') {
          states[4] = 'active';
          badgeText = '审核 agent 正在核对需求…';
          badgeTone = 'active';
        } else if (v === 'pass') {
          states[4] = 'done';
          states[5] = 'done';
          badgeText = '审核通过 · 需求已达成';
          badgeTone = 'done';
        } else {
          states[4] = 'done';
          states[5] = 'warn';
          // 驳回不是直接丢回 Executor：先由规划 agent 出 05-修改方案，D 才能改。
          states[2] = 'active';
          badgeText = '已驳回 · 等规划 agent 出 05-修改方案';
          badgeTone = 'warn';
          reworkNote = '审核 agent 写了 needs_revision。返工路径是：规划 agent 读 04 的 findings → 写 05/revision-r<N>.md → D 按它改 → 重新送审。D 与审核 agent 之间没有直接通道。';
        }
      }

      return { states, badgeText, badgeTone, reworkNote };
    }

    function copyTextToClipboard(text) {
      const str = String(text || '');
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(str).then(() => true, () => false);
      }
      try {
        const ta = document.createElement('textarea');
        ta.value = str;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return Promise.resolve(ok);
      } catch {
        return Promise.resolve(false);
      }
    }

    /** 可折叠长文本展示块 */
    function CollapsibleField({ label, text, defaultExpanded = false }) {
      const [expanded, setExpanded] = useState(defaultExpanded);
      const [copied, setCopied] = useState(false);
      const str = String(text || '').trim();
      if (!str) return null;
      const isLong = str.length > 260 || str.split('\n').length > 6;

      const shown = !isLong || expanded ? str : str.slice(0, 260) + '…';

      return h(
        'div',
        { className: 'dsh-agy-field-block' },
        h('div', { className: 'dsh-agy-field-label' }, label),
        h('pre', { className: 'dsh-agy-pre' }, shown),
        h(
          'div',
          { className: 'dsh-agy-text-actions' },
          isLong
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-agy-tiny-btn',
                  onClick: () => setExpanded((v) => !v),
                },
                expanded ? '收起全文' : `展开全文 (${str.length} 字)`,
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-agy-tiny-btn',
              onClick: () => {
                copyTextToClipboard(str).then((ok) => {
                  if (!ok) return;
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1400);
                });
              },
            },
            copied ? '已复制 ✓' : '复制',
          ),
        ),
      );
    }

    /** 对话框左侧下方外置控制栏（超出对话栏外部） */
    function ExternalBottomBar({ snap }) {
      const [busyToggle, setBusyToggle] = useState(false);
      const [pos, setPos] = useState(null);

      useEffect(() => {
        const box = snap.composerBoxEl || findComposerBoxFromNode(null);
        let prevMargin = '';
        let appliedEl = null;

        const updatePosition = () => {
          const target = snap.composerBoxEl && document.contains(snap.composerBoxEl)
            ? snap.composerBoxEl
            : findComposerBoxFromNode(null);
          if (target) {
            const rect = target.getBoundingClientRect();
            if (rect.width > 100 && rect.height > 20) {
              const top = Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 32));
              const left = Math.max(8, rect.left);
              setPos({ left, top, docked: true });
              return;
            }
          }
          setPos({ left: 276, top: Math.max(8, window.innerHeight - 36), docked: false });
        };

        if (box && document.contains(box)) {
          appliedEl = box;
          prevMargin = box.style.marginBottom;
          const curMb = parseFloat(window.getComputedStyle(box).marginBottom) || 0;
          if (curMb < 34) {
            box.style.marginBottom = '34px';
          }
        }

        updatePosition();
        let ro = null;
        if (typeof ResizeObserver === 'function' && appliedEl) {
          ro = new ResizeObserver(() => updatePosition());
          ro.observe(appliedEl);
        }
        window.addEventListener('resize', updatePosition);
        const timer = window.setInterval(updatePosition, 500);

        return () => {
          if (ro) ro.disconnect();
          window.removeEventListener('resize', updatePosition);
          window.clearInterval(timer);
          if (appliedEl) {
            appliedEl.style.marginBottom = prevMargin;
          }
        };
      }, [snap.composerBoxEl, snap.sessionId, snap.drawerOpen]);

      const onToggleCollab = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (busyToggle) return;
        setBusyToggle(true);
        try {
          await toggleCollab(snap.sessionId);
        } finally {
          setBusyToggle(false);
        }
      };

      const flowInfo = useMemo(() => computeFlowSteps(snap.records, null), [snap.records]);
      const latestCount = Array.isArray(snap.records) ? snap.records.length : 0;

      const style = pos
        ? { left: `${Math.round(pos.left)}px`, top: `${Math.round(pos.top)}px` }
        : { left: '276px', bottom: '10px' };

      return h(
        'div',
        { className: 'dsh-agy-ext-bar', style },
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            className: 'dsh-agy-ext-btn',
            'aria-checked': snap.enabled ? 'true' : 'false',
            'aria-busy': busyToggle ? 'true' : undefined,
            title: snap.enabled
              ? 'A↔D 协作已开启：D 后台转达任务 → A 负责开局规划与结果审核'
              : '点击开启 A↔D 智能体后台协作',
            onMouseDown: (e) => e.preventDefault(),
            onClick: onToggleCollab,
          },
          h('span', { className: 'dsh-agy-dot', 'aria-hidden': 'true' }),
          h('span', null, snap.enabled ? 'A↔D 协作: 开' : 'A↔D 协作: 关'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-agy-ext-btn' + (snap.drawerOpen ? ' is-active' : ''),
            'aria-expanded': snap.drawerOpen ? 'true' : 'false',
            title: '在右侧边栏展开或收起 A↔D 协作任务流程图与双向通信看板',
            onMouseDown: (e) => e.preventDefault(),
            onClick: (e) => {
              e.preventDefault();
              e.stopPropagation();
              setDrawerOpen(!snap.drawerOpen);
            },
          },
          h('span', null, snap.drawerOpen ? '📊 收起看板' : '📊 任务看板'),
          latestCount > 0
            ? h(
                'span',
                {
                  className:
                    'dsh-agy-mini-pill ' +
                    (flowInfo.badgeTone === 'done'
                      ? 'ok'
                      : flowInfo.badgeTone === 'warn'
                        ? 'warn'
                        : flowInfo.badgeTone === 'active'
                          ? 'run'
                          : ''),
                },
                `${latestCount}轮 · ${flowInfo.badgeTone === 'done' ? '✓ 通过' : flowInfo.badgeTone === 'warn' ? '需修改' : flowInfo.badgeTone === 'active' ? '进行中' : '记录'}`,
              )
            : null,
        ),
      );
    }

    /* ───────────────────────── 设置页（§12） ───────────────────────── */

    /** 开关（aria-checked 驱动样式，disabled 时只读）。 */
    function SetSwitch({ checked, disabled, onChange }) {
      return h('button', {
        type: 'button',
        className: 'dsh-agy-sw',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        disabled: Boolean(disabled),
        onClick: () => {
          if (!disabled) onChange(!checked);
        },
      });
    }

    /** 分段选择器（两三个互斥值）。 */
    function SetSeg({ value, options, disabled, onChange }) {
      return h(
        'div',
        { className: 'dsh-agy-seg' },
        options.map((o) =>
          h(
            'button',
            {
              key: o.id,
              type: 'button',
              className: value === o.id ? 'is-on' : '',
              disabled: Boolean(disabled),
              onClick: () => {
                if (!disabled && value !== o.id) onChange(o.id);
              },
            },
            o.label,
          ),
        ),
      );
    }

    /** 配置行：左边名字 + 提示，右边控件。 */
    function SetRow({ name, hint, children }) {
      return h(
        'div',
        { className: 'dsh-agy-set-row' },
        h(
          'div',
          { className: 'dsh-agy-set-row-label' },
          h('span', { className: 'dsh-agy-set-name' }, name),
          hint ? h('span', { className: 'dsh-agy-set-hint' }, hint) : null,
        ),
        children,
      );
    }

    /** 已定项的绿框说明（左边框 2px，内容只读）。 */
    function Settled({ label, badge, lines }) {
      return h(
        'div',
        { className: 'dsh-agy-settled' },
        h(
          'div',
          { className: 'dsh-agy-sh-line' },
          h('span', { className: 'dsh-agy-sh-label' }, label),
          badge ? h('span', { className: 'dsh-agy-badge-s' }, badge) : null,
        ),
        ...lines.map((t, i) => h('div', { key: i, className: 'dsh-agy-sh-line' }, t)),
      );
    }

    const STATE_WAITING = {
      drafting: '等规划 agent 写 02 / 03',
      ready: '等 D 开工',
      running: '等 D 交付',
      reviewing: '等审核 agent 判定',
      revising: '等规划 agent 写 05 修改方案',
      'final-review': '等审核 agent 终审',
      done: '已收尾',
      blocked: '已阻塞 · 等人类处理',
      escalated: '已升级 · 等人类处理',
      aborted: '已中止',
    };

    const TEMPLATE_STATE_TEXT = {
      not_installed: '未安装 · 外部角色不可用，只能跑进程内三角色',
      installed: '已安装且哈希一致',
      drifted: '与安装记录不一致 · A 侧可能仍在按旧协议回传',
    };

    const BROKER_STATE_TEXT = {
      attached: '在线（复用已有实例）',
      spawned: '在线（本次拉起）',
      foreign: '端口被其他程序占用',
      unreachable: '进程在但 /health 未就绪',
      missing_script: '找不到 broker.mjs（未安装）',
      offline: '未启动',
      unknown: '未知',
    };

    /**
     * 设置与运行台（§12）。
     *
     * 上半是配置（改了就落盘，Host 侧校验），中间一条「以上为配置 · 以下为现状」，
     * 下半是运行台（只读，数据全部来自 Host 的 /config 快照）。
     * 只读的边界是刻意的：越权判定靠 Workspace 全树快照 diff，
     * 人从 UI 写进六目录与角色越权在快照里长得一样，会判废误伤（§12.5）。
     */
    function SettingsBody({ snap }) {
      const settings = snap.settings;
      const cfg = settings?.config || null;
      const runtime = settings?.runtime || null;
      const templates = settings?.templates || null;
      const broker = settings?.broker || null;

      const [rootDraft, setRootDraft] = useState('');
      const [portDraft, setPortDraft] = useState('');
      const [models, setModels] = useState({});
      const [actors, setActors] = useState({});

      useEffect(() => {
        if (!cfg) return;
        setRootDraft(String(cfg.workspaceRoot || ''));
        setPortDraft(String(cfg.brokerPort || ''));
        const nextModels = {};
        const nextActors = {};
        for (const role of ['planner', 'executor', 'reviewer']) {
          nextModels[role] = String(cfg.roles?.[role]?.model || '');
          nextActors[role] = String(cfg.roles?.[role]?.actor_id || '');
        }
        setModels(nextModels);
        setActors(nextActors);
      }, [cfg?.updatedAt, cfg?.workspaceRoot, cfg?.brokerPort]);

      if (!settings || !cfg) {
        return h(
          'div',
          { className: 'dsh-agy-kb-body' },
          h(
            'div',
            { className: 'dsh-agy-empty' },
            '正在读取配置…',
            h('br'),
            '若长时间停在这里，点上面的「刷新」。',
          ),
        );
      }

      const patch = (p) => saveSettingsPatch(p);
      const roles = settings.roles || {};
      const enums = settings.enums || {};
      const enabled = Boolean(settings.enabled);
      const saving = Boolean(snap.settingsSaving);

      const stage = runtime?.active ? String(runtime.state || '') : '';
      const rejectionLimit = Number(cfg.rejection_limit || 2);

      return h(
        'div',
        { className: 'dsh-agy-kb-body' },
        // 置顶常驻状态条：460px 下不显示任务 id（太窄会挤掉「在等谁」）
        h(
          'div',
          { className: 'dsh-agy-pinbar' },
          h('span', { className: 'dsh-agy-pdot' + (runtime?.active ? '' : ' idle') }),
          runtime?.active ? h('span', { className: 'dsh-agy-ptask' }, runtime.task_id) : null,
          h(
            'span',
            { className: 'dsh-agy-pstate' },
            runtime?.active ? String(runtime.state) : '没有在跑的任务',
          ),
          runtime?.active
            ? h(
                'span',
                { className: 'dsh-agy-pcount' },
                `驳回 ${runtime.rejection_count}/${runtime.rejection_limit}`,
              )
            : null,
          h(
            'span',
            { className: 'dsh-agy-pwhere' },
            runtime?.active
              ? STATE_WAITING[String(runtime.state)] || ''
              : '启动一个任务后这里显示它在等谁',
          ),
        ),

        // A 卡：角色绑定
        h(
          'section',
          { className: 'dsh-agy-set-card' },
          h(
            'div',
            { className: 'dsh-agy-section-hd' },
            h('div', { className: 'dsh-agy-section-title' }, '角色绑定'),
            h(
              'span',
              { className: 'dsh-agy-flow-status-tag' + (settings.validation?.ok ? ' done' : ' warn') },
              settings.validation?.ok ? '绑定自洽' : '绑定有冲突',
            ),
          ),
          ...['planner', 'executor', 'reviewer'].map((role) => {
            const meta = roles[role] || {};
            const cur = cfg.roles?.[role] || {};
            const isExecutor = role === 'executor';
            return h(
              'details',
              { key: role, className: 'dsh-agy-role-row' },
              h(
                'summary',
                { className: 'dsh-agy-role-line' },
                h('span', { className: 'dsh-agy-role-title' }, meta.title || role),
                h('span', { className: 'dsh-agy-role-brief' }, meta.brief || ''),
                h('span', { className: 'dsh-agy-role-chev' }),
              ),
              h(
                'div',
                { className: 'dsh-agy-role-body' },
                h(
                  'div',
                  { className: 'dsh-agy-role-fields' },
                  h(
                    'div',
                    { className: 'dsh-agy-field' },
                    h('span', { className: 'dsh-agy-field-k' }, '载体'),
                    h(
                      'select',
                      {
                        className: 'dsh-agy-select',
                        value: cur.carrier || 'in-process',
                        disabled: isExecutor || saving,
                        onChange: (e) =>
                          patch({ roles: { [role]: { carrier: e.target.value } } }),
                      },
                      (enums.carriers || ['in-process', 'session', 'external']).map((c) =>
                        h(
                          'option',
                          { key: c, value: c },
                          c === 'in-process'
                            ? 'in-process（进程内）'
                            : c === 'session'
                              ? 'session（当前 DSH 会话）'
                              : 'external（Antigravity 侧）',
                        ),
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dsh-agy-field' },
                    h('span', { className: 'dsh-agy-field-k' }, '模型'),
                    h('input', {
                      className: 'dsh-agy-input',
                      value: models[role] ?? '',
                      placeholder: '留空 = 继承会话默认',
                      disabled: saving,
                      onChange: (e) => setModels({ ...models, [role]: e.target.value }),
                      onBlur: () => {
                        const want = String(models[role] ?? '').trim();
                        if (want === String(cur.model || '')) return;
                        patch({ roles: { [role]: { model: want || null } } });
                      },
                    }),
                  ),
                  h(
                    'div',
                    { className: 'dsh-agy-field' },
                    h('span', { className: 'dsh-agy-field-k' }, 'Actor'),
                    h('input', {
                      className: 'dsh-agy-input',
                      value: actors[role] ?? '',
                      placeholder: '留空 = 由 Host 分配',
                      disabled: saving,
                      onChange: (e) => setActors({ ...actors, [role]: e.target.value }),
                      onBlur: () => {
                        const want = String(actors[role] ?? '').trim();
                        if (want === String(cur.actor_id || '')) return;
                        patch({ roles: { [role]: { actor_id: want || null } } });
                      },
                    }),
                  ),
                ),
                h(Settled, {
                  label: '读写边界',
                  badge: '#5 B6 已定',
                  lines: [
                    `读：${meta.read || ''}`,
                    `写：${meta.write || ''}`,
                    meta.note || '',
                  ],
                }),
              ),
            );
          }),
          settings.validation?.ok
            ? null
            : h(
                'div',
                { className: 'dsh-agy-warn-note' },
                (settings.validation?.errors || []).join('；'),
              ),
        ),

        // B 卡：协作与工作台
        h(
          'section',
          { className: 'dsh-agy-set-card' },
          h(
            'div',
            { className: 'dsh-agy-section-hd' },
            h('div', { className: 'dsh-agy-section-title' }, '协作与工作台'),
          ),
          h(SetRow, {
            name: '协作总开关',
            hint: '只作用于当前会话（§12.6：开关按会话，角色绑定按机器）',
            children: h(SetSwitch, {
              checked: enabled,
              disabled: saving || !snap.sessionId,
              onChange: (v) => patch({ enabled: v }),
            }),
          }),
          h(SetRow, {
            name: '角色绑定模式',
            hint:
              cfg.role_binding_mode === 'dual'
                ? 'dual：规划与审核可同一 agent，审核阶段强制冷调用'
                : 'triple：三个角色三个 agent，同 actor 占两槽会被拒启',
            children: h(SetSeg, {
              value: cfg.role_binding_mode,
              disabled: saving,
              options: [
                { id: 'triple', label: 'triple' },
                { id: 'dual', label: 'dual' },
              ],
              onChange: (v) => patch({ role_binding_mode: v }),
            }),
          }),
          h(SetRow, {
            name: '预估子 agent 数量',
            hint: '关掉后规划 agent 不填 subagent_count（也不要求 D 生成子 agent）',
            children: h(SetSwitch, {
              checked: Boolean(cfg.estimate_subagents),
              disabled: saving,
              onChange: (v) => patch({ estimate_subagents: v }),
            }),
          }),
          h(SetRow, {
            name: '审核档位',
            hint:
              cfg.reviewer_mode === 'strict'
                ? 'strict：findings 的 requirement_ref 必须命中 03 里的真实 id'
                : 'loose：不校验 requirement_ref',
            children: h(SetSeg, {
              value: cfg.reviewer_mode,
              disabled: saving,
              options: [
                { id: 'strict', label: '严格' },
                { id: 'loose', label: '宽松' },
              ],
              onChange: (v) => patch({ reviewer_mode: v }),
            }),
          }),
          h(SetRow, {
            name: '驳回上限',
            hint:
              stage && stage !== 'drafting'
                ? `当前阶段是 ${stage}，只能在 drafting 改`
                : '驳回达到上限后下一轮进 06/final.md 终审',
            children: h(
              'div',
              { className: 'dsh-agy-stepper' },
              h(
                'button',
                {
                  type: 'button',
                  disabled: saving || rejectionLimit <= (enums.rejection_limit?.min ?? 1),
                  onClick: () => patch({ rejection_limit: rejectionLimit - 1 }),
                },
                '−',
              ),
              h('span', { className: 'dsh-agy-stepper-v' }, rejectionLimit),
              h(
                'button',
                {
                  type: 'button',
                  disabled: saving || rejectionLimit >= (enums.rejection_limit?.max ?? 5),
                  onClick: () => patch({ rejection_limit: rejectionLimit + 1 }),
                },
                '+',
              ),
            ),
          }),
          h(SetRow, {
            name: '临时工作台根路径',
            hint: '改完只影响新任务；已在跑的树不搬家',
            children: h('input', {
              className: 'dsh-agy-input',
              value: rootDraft,
              disabled: saving,
              onChange: (e) => setRootDraft(e.target.value),
              onBlur: () => {
                if (rootDraft === String(cfg.workspaceRoot || '')) return;
                patch({ workspaceRoot: rootDraft });
              },
            }),
          }),
          h(SetRow, {
            name: '总线端口',
            hint: 'env DSH_AGY_COLLAB_PORT 优先于这里的值',
            children: h('input', {
              className: 'dsh-agy-input',
              style: { maxWidth: '84px' },
              value: portDraft,
              disabled: saving,
              onChange: (e) => setPortDraft(e.target.value.replace(/[^0-9]/g, '')),
              onBlur: () => {
                const n = Number(portDraft);
                if (!Number.isInteger(n) || n < 1 || n > 65535) {
                  setPortDraft(String(cfg.brokerPort || ''));
                  return;
                }
                if (n === Number(cfg.brokerPort)) return;
                patch({ brokerPort: n });
              },
            }),
          }),
          h(Settled, {
            label: '实际目录层级',
            badge: '#4 Q3 已定',
            lines: [
              '<root>/<host-pid>-<boot-id>/<session-id>/<task-id>/01-06',
              '每一级都带身份，多个会话并发天然不互踩，不需要额外的锁。',
            ],
          }),
          h(Settled, {
            label: '下次启动会清扫',
            badge: '#4 Q4 已定',
            lines: [
              '判据一：目录名里的 pid 已不存在',
              '判据二：boot-id 与本次开机不匹配（是上一次开机留下的）',
              '只清 Host 自己按命名规则建的那棵，不碰别人放的东西。',
            ],
          }),
          h(Settled, {
            label: 'A 侧模板',
            badge: templates?.status || 'unknown',
            lines: [
              TEMPLATE_STATE_TEXT[templates?.status] || '未知',
              ...(templates?.items || []).map(
                (it) => `${it.relPath} · ${it.state}${it.templateVersion ? ` · v${it.templateVersion}` : ''}`,
              ),
              ...(templates?.legacyPresent || []).length
                ? [`⚠ 仍有 v1 遗留：${(templates.legacyPresent || []).join('、')}`]
                : [],
            ],
          }),
          h(Settled, {
            label: '协作总线',
            badge: broker?.state || 'unknown',
            lines: [
              `${BROKER_STATE_TEXT[broker?.state] || broker?.state || '未知'} · 127.0.0.1:${broker?.port ?? cfg.brokerPort}${broker?.pid ? ` · pid ${broker.pid}` : ''}`,
              broker?.message || '',
              '总线只在有外部角色时才需要；进程内三角色不经过它。',
            ].filter(Boolean),
          }),
          h(
            'div',
            { className: 'dsh-agy-btnrow' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-agy-btn primary',
                disabled: saving,
                onClick: () => refreshSettings(snap.sessionId),
              },
              '重新读取',
            ),
            snap.settingsError
              ? h('span', { className: 'dsh-agy-save-note err' }, snap.settingsError)
              : h(
                  'span',
                  { className: 'dsh-agy-save-note' },
                  saving ? '保存中…' : '改动即时落盘，Host 侧校验不通过会原样报错',
                ),
          ),
        ),

        // 分界：以上为配置 · 以下为现状
        h('div', { className: 'dsh-agy-divider' }, '以上为配置 · 以下为现状'),

        // C 卡：当前任务
        h(
          'section',
          { className: 'dsh-agy-set-card' },
          h(
            'div',
            { className: 'dsh-agy-section-hd' },
            h('div', { className: 'dsh-agy-section-title' }, '当前任务'),
            h(
              'span',
              { className: 'dsh-agy-flow-status-tag' + (runtime?.active ? ' active' : '') },
              runtime?.active
                ? `${runtime.state} · 第 ${runtime.round} 轮 · 驳回 ${runtime.rejection_count}/${runtime.rejection_limit}`
                : '没有在跑的任务',
            ),
          ),
          runtime?.active
            ? h(
                'div',
                { className: 'dsh-agy-grid6' },
                ...(runtime.files || []).map((f2) =>
                  h(
                    'div',
                    {
                      key: f2.slot,
                      className: 'dsh-agy-cell' + (f2.exists ? ' is-on' : ' is-pending'),
                      title: `${f2.dir}/${f2.fileName}`,
                    },
                    h('div', { className: 'dsh-agy-cname' }, f2.dir),
                    h('div', { className: 'dsh-agy-cmeta' }, f2.fileName),
                    h('div', { className: 'dsh-agy-ftag' }, `${f2.semantic} · ${f2.exists ? '有' : '未生成'}`),
                  ),
                ),
              )
            : h(
                'div',
                { className: 'dsh-agy-empty' },
                '当前会话还没有在跑的任务。',
                h('br'),
                '在对话框里让 D 调 collab_start 开始一个任务，这里就会显示六个目录的实际文件。',
              ),
          runtime?.active
            ? h(
                'div',
                { className: 'dsh-agy-warn-note' },
                STATE_WAITING[String(runtime.state)] || '',
              )
            : null,
        ),

        // D 卡：本次任务的角色实例（真实数据只有 actor session id 与需求 id）
        h(
          'section',
          { className: 'dsh-agy-set-card' },
          h(
            'div',
            { className: 'dsh-agy-section-hd' },
            h('div', { className: 'dsh-agy-section-title' }, '角色实例'),
          ),
          runtime?.active
            ? h(
                'div',
                { className: 'dsh-agy-files' },
                h(
                  'div',
                  { className: 'dsh-agy-frow wrap' },
                  h('span', { className: 'dsh-agy-fpath' }, 'actor session'),
                  h(
                    'span',
                    { className: 'dsh-agy-ftag' },
                    (runtime.actor_session_ids || []).join('、') || '（尚未起过角色实例）',
                  ),
                ),
                h(
                  'div',
                  { className: 'dsh-agy-frow wrap' },
                  h('span', { className: 'dsh-agy-fpath' }, '03 需求 id'),
                  h(
                    'span',
                    { className: 'dsh-agy-ftag' },
                    (runtime.requirement_ids || []).join('、') || '（03 还没写）',
                  ),
                ),
                h(
                  'div',
                  { className: 'dsh-agy-frow wrap' },
                  h('span', { className: 'dsh-agy-fpath' }, '工作台根'),
                  h('span', { className: 'dsh-agy-ftag' }, runtime.task_root || ''),
                ),
              )
            : h('div', { className: 'dsh-agy-set-hint' }, '没有在跑的任务时没有角色实例。'),
        ),

        // E 卡：工作台文件表（六行，语义标签照 §4.1）
        h(
          'section',
          { className: 'dsh-agy-set-card' },
          h(
            'div',
            { className: 'dsh-agy-section-hd' },
            h('div', { className: 'dsh-agy-section-title' }, '工作台文件'),
          ),
          h(
            'div',
            { className: 'dsh-agy-files' },
            ...(runtime?.active && Array.isArray(runtime.files)
              ? runtime.files
              : [
                  { slot: 'request', dir: '01-原始任务需求和目的', fileName: 'request.md', exists: false, semantic: '不可变' },
                  { slot: 'plan', dir: '02-执行方案', fileName: 'plan.md', exists: false, semantic: '可覆盖' },
                  { slot: 'tasks', dir: '03-任务清单', fileName: 'tasks.md', exists: false, semantic: '已冻结' },
                  { slot: 'review', dir: '04-审核结果', fileName: 'review-r<N>.md', exists: false, semantic: '只增不改' },
                  { slot: 'revision', dir: '05-修改方案', fileName: 'revision-r<N>.md', exists: false, semantic: '只增不改' },
                  { slot: 'final', dir: '06-最终审核', fileName: 'final.md', exists: false, semantic: '终审' },
                ]
            ).map((f2) =>
              h(
                'div',
                { key: f2.slot, className: 'dsh-agy-frow' },
                h('span', { className: 'dsh-agy-fpath' }, `${f2.dir}/${f2.fileName}`),
                h('span', { className: 'dsh-agy-ftag' }, f2.semantic),
                h(
                  'span',
                  { className: 'dsh-agy-fstate ' + (f2.exists ? 'on' : 'off') },
                  f2.exists ? '有' : '—',
                ),
              ),
            ),
          ),
          h(Settled, {
            label: '这里只读，不给编辑框',
            badge: '#12.5',
            lines: [
              '越权判定靠 Workspace 全树快照 diff（§6.4）。',
              '人从 UI 写进去的内容与角色越权在快照里长得一样，会判废误伤。',
            ],
          }),
        ),
      );
    }

    /** 右侧收起/展开的 A↔D 协作任务看板 */
    function KanbanDrawer({ snap }) {
      const [filterPhase, setFilterPhase] = useState('all');
      const [selectedId, setSelectedId] = useState(null);
      const [confirmClear, setConfirmClear] = useState(false);
      // §12.1：右侧看板分两页 —— 任务看板 / 设置与运行台。
      const [tab, setTab] = useState('board');

      const records = Array.isArray(snap.records) ? snap.records : [];
      const focusRecord = useMemo(() => {
        if (selectedId) {
          const hit = records.find((r) => r.requestId === selectedId);
          if (hit) return hit;
        }
        return records.length ? records[records.length - 1] : null;
      }, [records, selectedId]);

      const flow = useMemo(() => computeFlowSteps(records, focusRecord), [records, focusRecord]);

      const filteredRecords = useMemo(() => {
        const withIndex = records.map((r, i) => ({ ...r, roundNumber: i + 1 }));
        const sub =
          filterPhase === 'all' ? withIndex : withIndex.filter((r) => roleOf(r) === filterPhase);
        return sub.slice().reverse();
      }, [records, filterPhase]);

      const stateCls = (st) =>
        st === 'done'
          ? ' is-done'
          : st === 'active'
            ? ' is-active'
            : st === 'warn'
              ? ' is-warn'
              : '';

      const stepIcon = (st) =>
        st === 'done' ? '✓' : st === 'active' ? '●' : st === 'warn' ? '!' : '○';

      const nodeMeta = [
        { step: 'STEP 1', name: 'D 接收任务', desc: '用户在 D 下达指令' },
        { step: 'STEP 2', name: 'D → 规划 agent', desc: '提交 01 原始需求与目的' },
        { step: 'STEP 3', name: '规划 agent 交付', desc: '02 方案 + 03 任务清单（冻结）' },
        { step: 'STEP 4', name: 'D 执行任务', desc: '按 03 清单执行，写仓库' },
        { step: 'STEP 5', name: 'D → 审核 agent', desc: '送审：读 03 + 仓库产物' },
        { step: 'STEP 6', name: '审核 agent 判定', desc: 'pass / needs_revision' },
      ];

      return h(
        React.Fragment,
        null,
        // 收起时右侧边缘悬浮小耳标
        !snap.drawerOpen
          ? h(
              'button',
              {
                type: 'button',
                className: 'dsh-agy-edge-tab',
                title: '展开 A↔D 协作任务看板',
                onClick: () => setDrawerOpen(true),
              },
              h('span', null, '«'),
              h('span', { className: 'dsh-agy-edge-tab-v' }, 'A↔D 看板'),
              records.length > 0
                ? h('span', { style: { fontSize: '10px', opacity: 0.8 } }, records.length)
                : null,
            )
          : null,
        // 右侧边栏抽屉本体
        h(
          'aside',
          {
            className: 'dsh-agy-kanban-drawer',
            'data-open': snap.drawerOpen ? 'true' : 'false',
            'aria-label': 'A↔D 协作任务看板',
          },
          // 头部
          h(
            'div',
            { className: 'dsh-agy-kb-head' },
            h(
              'div',
              { className: 'dsh-agy-kb-title-wrap' },
              h(
                'h3',
                { className: 'dsh-agy-kb-title' },
                h('span', null, 'A↔D 协作任务看板'),
                h(
                  'span',
                  {
                    className:
                      'dsh-agy-mini-pill ' + (snap.enabled ? 'ok' : ''),
                  },
                  snap.enabled ? '协作已开' : '协作已关',
                ),
              ),
              h(
                'div',
                { className: 'dsh-agy-kb-sub' },
                h(
                  'span',
                  null,
                  snap.brokerOnline
                    ? `总线 127.0.0.1:${snap.brokerPort || DEFAULT_BROKER_PORT} 在线`
                    : snap.brokerState === 'foreign'
                      ? `总线端口 ${snap.brokerPort || DEFAULT_BROKER_PORT} 被其他程序占用`
                      : `总线离线（127.0.0.1:${snap.brokerPort || DEFAULT_BROKER_PORT}）`,
                ),
                h('span', null, '·'),
                h('span', null, snap.aListening ? 'Agent A 待命' : 'Agent A 离线/处理中'),
              ),
            ),
            h(
              'div',
              { className: 'dsh-agy-kb-head-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-agy-kb-iconbtn',
                  onClick: () => refreshAll(snap.sessionId),
                },
                '刷新',
              ),
              confirmClear
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-agy-kb-iconbtn danger',
                      onClick: async () => {
                        await clearAllRecords();
                        setSelectedId(null);
                        setConfirmClear(false);
                      },
                    },
                    '确认清空?',
                  )
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-agy-kb-iconbtn danger',
                      onClick: () => {
                        setConfirmClear(true);
                        setTimeout(() => setConfirmClear(false), 3000);
                      },
                    },
                    '清空',
                  ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-agy-kb-iconbtn',
                  onClick: () => setDrawerOpen(false),
                },
                '收起 »',
              ),
            ),
          ),
          // 分页（§12.1）：设置页放这里而不是全局设置页 —— 协作开关按会话，
          // 四个全局挂载点的 standardProps 都没有 sessionId，放过去会改到别的会话。
          h(
            'nav',
            { className: 'dsh-agy-kb-tabs' },
            [
              { id: 'board', label: '任务看板' },
              { id: 'settings', label: '设置与运行台' },
            ].map((t) =>
              h(
                'button',
                {
                  key: t.id,
                  type: 'button',
                  className: 'dsh-agy-kb-tab' + (tab === t.id ? ' is-on' : ''),
                  onClick: () => {
                    setTab(t.id);
                    if (t.id === 'settings') refreshSettings(snap.sessionId);
                  },
                },
                t.label,
              ),
            ),
          ),
          // 滚动主体
          tab === 'settings'
            ? h(SettingsBody, { snap })
            : h(
            'div',
            { className: 'dsh-agy-kb-body' },
            // 上半部分：实时流程图
            h(
              'section',
              { className: 'dsh-agy-flow-card' },
              h(
                'div',
                { className: 'dsh-agy-section-hd' },
                h('div', { className: 'dsh-agy-section-title' }, '🔄 协作闭环流程图'),
                h(
                  'span',
                  { className: 'dsh-agy-flow-status-tag ' + flow.badgeTone },
                  flow.badgeText,
                ),
              ),
              h(
                'div',
                { className: 'dsh-agy-flow-grid' },
                // 第一行：Step 1 -> Step 2 -> Step 3
                h(
                  'div',
                  { className: 'dsh-agy-flow-node' + stateCls(flow.states[0]) },
                  h('div', { className: 'dsh-agy-flow-step' }, nodeMeta[0].step, h('span', null, stepIcon(flow.states[0]))),
                  h('div', { className: 'dsh-agy-flow-name', title: nodeMeta[0].name }, nodeMeta[0].name),
                  h('div', { className: 'dsh-agy-flow-desc', title: nodeMeta[0].desc }, nodeMeta[0].desc),
                ),
                h('div', { className: 'dsh-agy-flow-arrow' + stateCls(flow.states[1]) }, '→'),
                h(
                  'div',
                  { className: 'dsh-agy-flow-node' + stateCls(flow.states[1]) },
                  h('div', { className: 'dsh-agy-flow-step' }, nodeMeta[1].step, h('span', null, stepIcon(flow.states[1]))),
                  h('div', { className: 'dsh-agy-flow-name', title: nodeMeta[1].name }, nodeMeta[1].name),
                  h('div', { className: 'dsh-agy-flow-desc', title: nodeMeta[1].desc }, nodeMeta[1].desc),
                ),
                h('div', { className: 'dsh-agy-flow-arrow' + stateCls(flow.states[2]) }, '→'),
                h(
                  'div',
                  { className: 'dsh-agy-flow-node' + stateCls(flow.states[2]) },
                  h('div', { className: 'dsh-agy-flow-step' }, nodeMeta[2].step, h('span', null, stepIcon(flow.states[2]))),
                  h('div', { className: 'dsh-agy-flow-name', title: nodeMeta[2].name }, nodeMeta[2].name),
                  h('div', { className: 'dsh-agy-flow-desc', title: nodeMeta[2].desc }, nodeMeta[2].desc),
                ),
                // 中间换行引导
                h(
                  'div',
                  { className: 'dsh-agy-flow-rowlink' },
                  h('span', null, '↳ A 提交方案后交由 D 落地执行'),
                  h('span', null, '↓'),
                ),
                // 第二行：Step 4 -> Step 5 -> Step 6
                h(
                  'div',
                  { className: 'dsh-agy-flow-node' + stateCls(flow.states[3]) },
                  h('div', { className: 'dsh-agy-flow-step' }, nodeMeta[3].step, h('span', null, stepIcon(flow.states[3]))),
                  h('div', { className: 'dsh-agy-flow-name', title: nodeMeta[3].name }, nodeMeta[3].name),
                  h('div', { className: 'dsh-agy-flow-desc', title: nodeMeta[3].desc }, nodeMeta[3].desc),
                ),
                h('div', { className: 'dsh-agy-flow-arrow' + stateCls(flow.states[4]) }, '→'),
                h(
                  'div',
                  { className: 'dsh-agy-flow-node' + stateCls(flow.states[4]) },
                  h('div', { className: 'dsh-agy-flow-step' }, nodeMeta[4].step, h('span', null, stepIcon(flow.states[4]))),
                  h('div', { className: 'dsh-agy-flow-name', title: nodeMeta[4].name }, nodeMeta[4].name),
                  h('div', { className: 'dsh-agy-flow-desc', title: nodeMeta[4].desc }, nodeMeta[4].desc),
                ),
                h('div', { className: 'dsh-agy-flow-arrow' + stateCls(flow.states[5]) }, '→'),
                h(
                  'div',
                  { className: 'dsh-agy-flow-node' + stateCls(flow.states[5]) },
                  h('div', { className: 'dsh-agy-flow-step' }, nodeMeta[5].step, h('span', null, stepIcon(flow.states[5]))),
                  h('div', { className: 'dsh-agy-flow-name', title: nodeMeta[5].name }, nodeMeta[5].name),
                  h('div', { className: 'dsh-agy-flow-desc', title: nodeMeta[5].desc }, nodeMeta[5].desc),
                ),
              ),
              flow.reworkNote
                ? h('div', { className: 'dsh-agy-flow-loop-note' }, '↩ 返工闭环：' + flow.reworkNote)
                : null,
            ),
            // 下半部分：筛选条
            h(
              'div',
              { className: 'dsh-agy-filter-bar' },
              h('div', { className: 'dsh-agy-section-title' }, `📨 往返通信记录 (${filteredRecords.length})`),
              h(
                'div',
                { className: 'dsh-agy-filter-tabs' },
                [
                  { id: 'all', label: '全部' },
                  { id: 'planner', label: '规划 agent' },
                  { id: 'reviewer', label: '审核 agent' },
                ].map((tab) =>
                  h(
                    'button',
                    {
                      key: tab.id,
                      type: 'button',
                      className: 'dsh-agy-filter-tab' + (filterPhase === tab.id ? ' is-on' : ''),
                      onClick: () => setFilterPhase(tab.id),
                    },
                    tab.label,
                  ),
                ),
              ),
            ),
            // 卡片列表
            filteredRecords.length === 0
              ? h(
                  'div',
                  { className: 'dsh-agy-empty' },
                  '暂无 A↔D 协作通信记录。',
                  h('br'),
                  '请先点击对话框左下角的「A↔D 协作」开关开启协作，并向 D 发送一个任务。',
                )
              : h(
                  'div',
                  { className: 'dsh-agy-rec-list' },
                  filteredRecords.map((rec) => {
                    const role = roleOf(rec);
                    const isPlanner = role === 'planner';
                    const isReplied = rec.status === 'replied' && rec.aToD;
                    const v = verdictOf(rec);
                    const verdictCls =
                      v === 'pending' ? 'waiting' : v === 'pass' ? 'approved' : 'changes';
                    const verdictLabel =
                      v === 'pending'
                        ? isPlanner
                          ? '⏳ 等规划 agent 交付'
                          : '⏳ 等审核 agent 判定'
                        : v === 'pass'
                          ? isPlanner
                            ? '✅ 已交付 02 / 03'
                            : '✅ pass（需求已达成）'
                          : '⚠️ needs_revision（需修改）';
                    const duration = fmtDuration(rec.createdAt, rec.repliedAt);
                    const isSel = focusRecord && focusRecord.requestId === rec.requestId;

                    return h(
                      'article',
                      {
                        key: rec.requestId,
                        className: 'dsh-agy-rec-card' + (isSel ? ' is-selected' : ''),
                      },
                      h(
                        'div',
                        {
                          className: 'dsh-agy-rec-hd',
                          onClick: () => setSelectedId(rec.requestId),
                          title: '点击可在上方流程图定位该轮次状态',
                        },
                        h(
                          'div',
                          { className: 'dsh-agy-rec-hd-left' },
                          h('span', { className: 'dsh-agy-round-num' }, `#${rec.roundNumber}`),
                          h(
                            'span',
                            { className: 'dsh-agy-phase-tag ' + (isPlanner ? 'plan' : 'review') },
                            isPlanner ? '规划 · Planner' : '审核 · Reviewer',
                          ),
                          rec.round
                            ? h('span', { className: 'dsh-agy-rec-meta' }, `第 ${rec.round} 轮`)
                            : null,
                          h(
                            'span',
                            { className: 'dsh-agy-rec-meta' },
                            `${fmtTime(rec.createdAt)}${duration ? ` · 耗时 ${duration}` : ''}`,
                          ),
                        ),
                        h('span', { className: 'dsh-agy-verdict ' + verdictCls }, verdictLabel),
                      ),
                      h(
                        'div',
                        { className: 'dsh-agy-msg-stack' },
                        // D -> A 区块
                        h(
                          'div',
                          { className: 'dsh-agy-msg-box d2a' },
                          h(
                            'div',
                            { className: 'dsh-agy-msg-hd' },
                            h('span', null, '📤 D 提交给 A 的内容 (D → A)'),
                            rec.workspace
                              ? h('span', { className: 'dsh-agy-rec-meta' }, rec.workspace)
                              : null,
                          ),
                          h(CollapsibleField, {
                            label: '任务需求 (Task)',
                            text: rec.dToA?.task || '',
                            defaultExpanded: false,
                          }),
                          h(CollapsibleField, {
                            label: '补充上下文 (Context)',
                            text: rec.dToA?.context || '',
                            defaultExpanded: false,
                          }),
                          h(CollapsibleField, {
                            label: 'D 的执行结果报告 (Execution Report)',
                            text: rec.dToA?.executionReport || '',
                            defaultExpanded: !isPlanner,
                          }),
                        ),
                        // A -> D 区块
                        h(
                          'div',
                          {
                            className:
                              'dsh-agy-msg-box a2d' + (v === 'needs_revision' ? ' changes' : ''),
                          },
                          h(
                            'div',
                            { className: 'dsh-agy-msg-hd' },
                            h('span', null, '📥 A 返回给 D 的内容 (A → D)'),
                            rec.repliedAt
                              ? h('span', { className: 'dsh-agy-rec-meta' }, fmtTime(rec.repliedAt))
                              : null,
                          ),
                          isReplied
                            ? h(CollapsibleField, {
                                label: isPlanner ? '规划 agent 的 02 / 03 交付说明' : '审核 agent 的判定与 findings',
                                text: rec.aToD?.content || '',
                                defaultExpanded: true,
                              })
                            : h(
                                'div',
                                { className: 'dsh-agy-rec-meta' },
                                isPlanner
                                  ? '规划 agent 正在拆解任务，交付后在此显示说明…'
                                  : '审核 agent 正在核对需求与仓库产物，判定后在此显示…',
                              ),
                        ),
                      ),
                    );
                  }),
                ),
          ),
        ),
      );
    }

    /** Shell Overlay 根容器 */
    function CollabOverlayRoot() {
      const snap = useCollabStore();

      useEffect(() => {
        refreshAll(store.sessionId);
        const pollMs = snap.drawerOpen || snap.pendingCount > 0 ? 2000 : 4000;
        const timer = window.setInterval(() => {
          refreshAll(store.sessionId);
        }, pollMs);
        return () => window.clearInterval(timer);
      }, [snap.drawerOpen, snap.pendingCount]);

      return h(
        React.Fragment,
        null,
        h('style', null, COLLAB_CSS),
        h(ExternalBottomBar, { snap }),
        h(KanbanDrawer, { snap }),
      );
    }

    function apply(ctx) {
      const slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : ctx?.slots;
      if (!slots || typeof slots.inject !== 'function') return;

      const disposers = [];

      // 1. 挂载定位探针到 conversation.input.right（零宽度，仅用于捕捉对话框外框位置与 sessionId）
      disposers.push(
        slots.inject('conversation.input.right', () =>
          slots.register(
            {
              name: 'conversation.input.right',
              id: 'dsh-agy-collab-anchor-probe',
              order: 25,
              inject: (sessionId) => ({ sessionId }),
            },
            ComposerAnchorProbe,
          ),
        ),
      );

      // 2. 挂载外置控制栏与右侧侧边栏任务看板到 shell.overlay
      disposers.push(
        slots.inject('shell.overlay', () =>
          slots.register(
            {
              name: 'shell.overlay',
              id: 'dsh-agy-collab-overlay',
              order: 75,
              label: 'A↔D 协作面板',
            },
            CollabOverlayRoot,
          ),
        ),
      );

      return () => {
        for (const d of disposers.splice(0).reverse()) {
          try { if (typeof d === 'function') d(); } catch { /* ignore */ }
        }
      };
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
