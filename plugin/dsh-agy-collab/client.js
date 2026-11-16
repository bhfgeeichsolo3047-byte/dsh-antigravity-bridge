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
    const DIRECT_STATE_API = 'http://127.0.0.1:18765/state';
    const DIRECT_CLEAR_API = 'http://127.0.0.1:18765/records/clear';
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
      records: [],
      drawerOpen: readDrawerOpenPref(),
      sessionId: '',
      composerBoxEl: null,
      listeners: new Set(),
    };

    function notifyStore() {
      const snap = {
        enabled: store.enabled,
        brokerOnline: store.brokerOnline,
        aListening: store.aListening,
        pendingCount: store.pendingCount,
        records: store.records,
        drawerOpen: store.drawerOpen,
        sessionId: store.sessionId,
        composerBoxEl: store.composerBoxEl,
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
      if (Array.isArray(data.records)) {
        store.records = data.records;
      }
      notifyStore();
    }

    async function refreshAll(sessionId) {
      const sid = typeof sessionId === 'string' ? sessionId : store.sessionId;
      const data = await callEndpoint(HOST_STATE_API, DIRECT_STATE_API, 'GET', sid, null);
      if (data && data.ok) applyServerSnapshot(data);
      return data;
    }

    async function toggleCollab(sessionId) {
      const sid = typeof sessionId === 'string' ? sessionId : store.sessionId;
      const prev = store.enabled;
      const want = !prev;
      store.enabled = want;
      notifyStore();

      const data = await callEndpoint(HOST_STATE_API, DIRECT_STATE_API, 'POST', sid, {
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

    async function clearAllRecords() {
      const data = await callEndpoint(HOST_CLEAR_API, DIRECT_CLEAR_API, 'POST', store.sessionId, {});
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
        records: store.records,
        drawerOpen: store.drawerOpen,
        sessionId: store.sessionId,
        composerBoxEl: store.composerBoxEl,
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

    /** 计算某组（或最新）记录在 6 步流程图上的状态 */
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

      // 找到离 target 最近的 plan、consult 和 review（同一任务流）
      let latestPlan = null;
      let latestReview = null;
      let latestConsult = null;
      for (let i = slice.length - 1; i >= 0; i--) {
        const r = slice[i];
        if (!latestReview && r.phase === 'review') latestReview = r;
        if (!latestConsult && r.phase === 'consult') latestConsult = r;
        if (!latestPlan && r.phase === 'plan') {
          latestPlan = r;
          break;
        }
      }
      if (target.phase === 'plan') {
        latestPlan = target;
        latestReview = null;
        latestConsult = null;
      }

      // 6 个节点：
      // 0: D 接收任务
      // 1: D->A 提交任务 (Plan)
      // 2: A->D 返回规划方案
      // 3: D 按方案执行 / 遇疑协商 (Consult)
      // 4: D->A 提交结果 (Review)
      // 5: A->D 审核结论
      const states = ['done', 'idle', 'idle', 'idle', 'idle', 'idle'];
      let badgeText = '待命';
      let badgeTone = '';
      let reworkNote = '';

      if (latestPlan && !latestReview) {
        if (latestPlan.status !== 'replied') {
          states[1] = 'active';
          badgeText = 'A 正在规划中…';
          badgeTone = 'active';
        } else if (latestConsult && latestConsult.status !== 'replied') {
          states[1] = 'done';
          states[2] = 'done';
          states[3] = 'active';
          badgeText = 'A↔D 途中协商中…';
          badgeTone = 'active';
        } else if (latestConsult) {
          states[1] = 'done';
          states[2] = 'done';
          states[3] = 'active';
          badgeText = '协商已定 · D 继续执行';
          badgeTone = 'active';
        } else {
          states[1] = 'done';
          states[2] = 'done';
          states[3] = 'active';
          badgeText = 'D 按方案执行中';
          badgeTone = 'active';
        }
      } else if (latestConsult && !latestReview) {
        states[1] = 'done';
        states[2] = 'done';
        states[3] = 'active';
        if (latestConsult.status !== 'replied') {
          badgeText = 'A↔D 途中协商中…';
          badgeTone = 'active';
        } else {
          badgeText = '协商已定 · D 继续执行';
          badgeTone = 'active';
        }
      } else if (latestReview) {
        states[1] = 'done';
        states[2] = 'done';
        states[3] = 'done';
        if (latestReview.status !== 'replied') {
          states[4] = 'active';
          badgeText = 'A 正在审核结果…';
          badgeTone = 'active';
        } else {
          states[4] = 'done';
          const verdict = String(latestReview.aToD?.verdict || '').toUpperCase();
          if (verdict === 'APPROVED') {
            states[5] = 'done';
            badgeText = '审核通过 · 可直接使用';
            badgeTone = 'done';
          } else {
            states[5] = 'warn';
            states[3] = 'active';
            badgeText = '需要修改 · 返工中';
            badgeTone = 'warn';
            reworkNote = 'A 指出了需要修改之处，D 需修改后重新提交第 5 步审核 (Review)。';
          }
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

    /** 右侧收起/展开的 A↔D 协作任务看板 */
    function KanbanDrawer({ snap }) {
      const [filterPhase, setFilterPhase] = useState('all');
      const [selectedId, setSelectedId] = useState(null);
      const [confirmClear, setConfirmClear] = useState(false);

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
          filterPhase === 'all' ? withIndex : withIndex.filter((r) => r.phase === filterPhase);
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
        { step: 'STEP 2', name: 'D → A 提交任务', desc: 'phase: plan 转达' },
        { step: 'STEP 3', name: 'A → D 返回规划', desc: '提交整体任务方案' },
        { step: 'STEP 4', name: 'D 执行任务', desc: '按方案执行 / 遇疑向 A 协商' },
        { step: 'STEP 5', name: 'D → A 提交结果', desc: 'phase: review 送审' },
        { step: 'STEP 6', name: 'A → D 审核结论', desc: '可用 / 需修改意见' },
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
                h('span', null, snap.brokerOnline ? '总线 127.0.0.1:18765 在线' : '总线离线'),
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
          // 滚动主体
          h(
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
                  { id: 'plan', label: '规划 Plan' },
                  { id: 'consult', label: '协商 Consult' },
                  { id: 'review', label: '审核 Review' },
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
                    const isPlan = rec.phase === 'plan';
                    const isConsult = rec.phase === 'consult';
                    const isReplied = rec.status === 'replied' && rec.aToD;
                    const verdict = String(rec.aToD?.verdict || '').toUpperCase();
                    const verdictCls = !isReplied
                      ? 'waiting'
                      : verdict === 'APPROVED'
                        ? 'approved'
                        : verdict === 'PLAN_READY'
                          ? 'plan_ready'
                          : verdict === 'CONSULT_ANSWERED'
                            ? 'consult_answered'
                            : 'changes';
                    const verdictLabel = !isReplied
                      ? '⏳ 等待 A 响应…'
                      : verdict === 'APPROVED'
                        ? '✅ APPROVED (审核通过)'
                        : verdict === 'PLAN_READY'
                          ? '📋 PLAN_READY (规划已提交)'
                          : verdict === 'CONSULT_ANSWERED'
                            ? '💬 CONSULT_ANSWERED (已协商确定)'
                            : `⚠️ ${verdict || 'CHANGES_REQUESTED'} (需修改)`;
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
                            { className: 'dsh-agy-phase-tag ' + (isPlan ? 'plan' : isConsult ? 'consult' : 'review') },
                            isPlan ? '开局规划 · Plan' : isConsult ? '途中协商 · Consult' : '结果审核 · Review',
                          ),
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
                            defaultExpanded: !isPlan,
                          }),
                        ),
                        // A -> D 区块
                        h(
                          'div',
                          {
                            className:
                              'dsh-agy-msg-box a2d' + (verdict === 'CHANGES_REQUESTED' ? ' changes' : ''),
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
                                label: isPlan ? 'A 提交的任务规划方案' : isConsult ? 'A 的途中协商解答与决策建议' : 'A 的最终审核结论与修改建议',
                                text: rec.aToD?.content || '',
                                defaultExpanded: true,
                              })
                            : h(
                                'div',
                                { className: 'dsh-agy-rec-meta' },
                                'Agent A 正在后台处理该请求，完成后回复内容将实时显示在此处…',
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
