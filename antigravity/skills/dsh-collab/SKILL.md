---
name: dsh-collab
description: DeepSeek Harness (D) 与 Antigravity (A) 本地网络后台静默协作技能（D 转达任务 -> A 开局规划 -> D 执行/途中协商 -> A 审核结果，支持方案 A 批量唤醒与多 Subagent 并行处理）。仅在收到后台 [DSH_BACKEND_RELAY] / [DSH_BACKEND_RELAY_BATCH] 转达或管理本地协作监听时使用；用户直接与 A 对话时不限制 A 的正常功能。
---

# DeepSeek Harness (D) <-> Antigravity (A) 后台静默协作指南

## 核心规则
1. **前提条件隔离**：
   - **D 后台转达（`[DSH_BACKEND_RELAY]` 或 `[DSH_BACKEND_RELAY_BATCH]`）**：A 只做**全类型任务开局整体规划 (`Phase: plan`)**、**途中疑问/不确定选择协商 (`Phase: consult`)** 与 **最终结果审核 (`Phase: review`)**，不越俎代庖替 D 执行修改。
   - **用户直接与 A 对话**：不触发上述限制，完全按正常对话响应用户。
2. **A → D 回复极简四段式（Agent 间高效通信）**：
   - 严禁铺陈“为什么 / 原理背景”等冗余解释；所有 `PLAN_READY`、`CONSULT_ANSWERED`、`APPROVED`、`CHANGES_REQUESTED` 回复必须精准精炼，固定只包含四项：
     1. **结论 / 方案**：直接给出采用的方案或审核结论；
     2. **怎么做**：具体执行步骤 / 命令 / 文件路径；
     3. **注意什么**：仅列关键避坑与边界约束；
     4. **达到什么目的**：最终要实现的状态与验收标准。

## 常用后台命令
- **启动后台静默监听（等待 D 发来任务规划、途中协商或审核请求）**：
  ```powershell
  node "~/.dsh/agy-collab/wait-next-request.mjs"
  ```
  *(使用 `run_command` 调用，设置 `WaitMsBeforeAsync: 500`, `IsDaemon: false`。Broker 具备 `250ms` 微批聚合窗口：单请求输出 `[DSH_BACKEND_RELAY]`，多并发请求输出 `[DSH_BACKEND_RELAY_BATCH]` 后自动退出并唤醒 A！)*

- **向 D 提交任务规划方案、协商结论或审核结论**：
  ```powershell
  node "~/.dsh/agy-collab/reply-request.mjs" --id "<Request ID>" --verdict "<PLAN_READY|CONSULT_ANSWERED|APPROVED|CHANGES_REQUESTED>" --file "~/.dsh/agy-collab/last-reply.md"
  ```
  *(单请求固定复用 `last-reply.md`，提交完毕后立即重挂 `wait-next-request.mjs`。`broker.mjs` 会自动仅保留最近 3 次协作记录、`history.jsonl` 最近 6 行及最近 3 份 `*.md` 任务文档，其余自动清除。)*

## 方案 A：多并发批次并行处理（`[DSH_BACKEND_RELAY_BATCH]`）
1. **先重挂监听**：收到 `[DSH_BACKEND_RELAY_BATCH]` 后，可立即在后台重新启动 `wait-next-request.mjs`（当前批次已被 Broker 标记 `dispatched: true`，180s 内不会重复弹出），确保后续新波次请求不被漏接。
2. **并发启动 Subagent 处理每个 Request**：
   - 使用 `invoke_subagent`（`TypeName: "self"`）在同一 turn 为每个 `Request ID` 并发启动一个独立 Subagent（或在轻量场景并行执行只读调研与并发 `reply-request.mjs`）。
   - 每个 Subagent 的 Prompt 需明确：只读规划/审核（禁止修改业务代码、不主动翻阅历史无关文档）、对应 `Request ID` 与 `Workspace`、将回复写入独立路径 `~/.dsh/agy-collab/last-reply-<Request ID>.md` 后调用 `reply-request.mjs --id "<Request ID>"`。
