# dsh-agy-collab — DeepSeek Harness (D) ↔ Antigravity (A) 协作插件

## 默认行为：v2 三角色闭环

插件启动即装配 v2：Planner（进程内，只写 `02` / `03` / `05`）→ Executor（当前会话，唯一有仓库写权限）→ Reviewer（进程内只读，只写 `04` / `06`）。三者只通过六目录临时工作台交换结构化文件，任务状态由 Host 状态机独占写 `state.json`。

触发点是 `collab_start`，不是 `agy_collab_relay`。要退回下面描述的 v1 双智能体模式，把 `DSH_AGY_COLLAB_V2` 设成 `0` / `false` / `off` / `no`。

## 功能特性（v1 回退模式，`DSH_AGY_COLLAB_V2=0`）

1. **对话框外置控制栏（左下角外部）**
   - **`A↔D 协作: 开 / 关`**：一键开启或关闭后台协作。关闭时 `systemPrompt` 注入空字符串 `""`，对 D 原有功能及其他插件零干扰。
   - **`📊 任务看板`**：展开或收起右侧边栏协作看板，徽标实时显示当前轮次与协作阶段状态。

2. **右侧可收起任务看板**
   - **6 步实时闭环流程图**：直观展示 `D 接收任务 → D→A 提交规划 → A→D 返回规划 → D 执行/途中协商 → D→A 提交结果 → A→D 审核结论`（支持返工状态高亮）。
   - **双向通信记录卡片**：支持按 `全部 / 规划 Plan / 协商 Consult / 审核 Review` 筛选，查看 D 提交给 A 的任务、上下文、执行报告及 A 返回的方案与审核意见。

3. **严格三阶段纪律与工具 (`agy_collab_relay`)**
   - **`phase: "plan"`**：开关开启后，**所有任务**（含编码、只读验证、测试、审计、调研）在正式开始前必须先整理需求提交给 A 规划。
   - **`phase: "consult"`**：执行途中遇到疑问、边界歧义或不确定的技术/方案选择时，暂停并向 A 协商确认（`CONSULT_ANSWERED`）后再继续。
   - **`phase: "review"`**：任务执行完成后提交 `execution_report` 由 A 审核（`APPROVED` 可交付 / `CHANGES_REQUESTED` 修正后复审）。

4. **兼容性与热重载**
   - 系统提示词段落名采用 `xsdshpg-agy-collab`，兼容原生 DSH 与 `Xsdsh-purge`。
   - 数据接口优先走同源 `/api/agy-collab/*` 并自动回退/合并本地总线 `http://127.0.0.1:18765`。
