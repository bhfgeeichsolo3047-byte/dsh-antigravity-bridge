# DSH ↔ Antigravity Bridge (`dsh-antigravity-bridge`)

**DeepSeek Harness (D) ↔ Google Antigravity (A)** 的本地网络后台静默多智能体协作桥梁与可视化看板系统。

开启协作后，系统形成**「Planner 拆解需求 → Executor 执行 → Reviewer 只读审核」**的三角色闭环：三个角色只通过一个随宿主启动、随宿主退出删除的临时工作台交换结构化文件，谁都不靠记忆传话。双智能体（D 直接与 Antigravity 通信）的旧模式作为回退路径保留。

---

## 当前状态：默认跑 v2 三角色闭环，v1 是显式回退

**默认行为就是 v2。** 插件启动即装配三角色闭环：Planner（进程内，只写方案与清单）、Executor（当前会话，唯一有仓库写权限）、Reviewer（进程内，只读需求与仓库产物、只写审核结论），任务状态由 Host 状态机独占写入 `state.json`，角色之间通过六目录临时工作台传结构化产物。

**要恢复旧的 v1 双智能体通道（`agy_collab_relay` + `plan/consult/review` 三阶段），把环境变量设成 0：**

```bash
DSH_AGY_COLLAB_V2=0     # 也可写 false / off / no
```

| | v1（显式回退：`DSH_AGY_COLLAB_V2=0`） | v2（默认） |
|---|---|---|
| 角色 | D 与 A 两个 | Planner / Executor / Reviewer 三个 |
| 角色间传什么 | 四段式散文回执 | 工作台里的结构化文件 |
| 谁记状态 | `records.json`（broker 侧） | `state.json`（Host 独占写） |
| broker | 必需 | 可选，只在有角色绑到进程外时才需要 |
| 设置页 | 无 | 右侧看板第二分页「设置与运行台」（原型已交付） |
| 触发方式 | `agy_collab_relay(phase=...)` | `collab_start` + 四个角色侧工具 |

两种模式互斥：v2 开启时不注册 `agy_collab_relay`，也不注入 v1 的三铁律提示词，避免同一会话出现两套协议诱发误调。

> **从 v1 升级过来的人请注意**：以前靠 `DSH_AGY_COLLAB_V2=1` 才启用的三角色闭环，现在是默认路径；原来一直在跑的 A↔D `agy_collab_relay` 通道变成了需要显式设置 `DSH_AGY_COLLAB_V2=0` 才恢复的回退模式。

**v2 的完整规格在 [`docs/specs/dsh-agy-collab-v2-spec.md`](./docs/specs/dsh-agy-collab-v2-spec.md)**，汇总了八张设计票的全部结论，是实现工作的唯一依据。设置页的可交互原型在 [`docs/prototypes/collab-settings.html`](./docs/prototypes/collab-settings.html)，用浏览器直接打开即可。

---

## 核心特性（v2 默认路径）

1. **三角色职责隔离，靠物理裁剪而不是靠提示词自觉**
   - Planner 进程内运行，只写 `02 执行方案` / `03 任务清单` / `05 修改方案`，无 bash、无仓库写通道。
   - Executor 就是当前会话本身，是唯一能改仓库的角色；它对六目录零写入，想改需求的唯一合法路径是判阻塞。
   - Reviewer 进程内运行、只读：输入是冻结的 `03 任务清单` 加仓库客观产物，不含 Executor 的任何主观叙述；只写 `04 审核结果` / `06 最终审核`。
   - 隔离手段是 `agentCtx.tools.restrict({ allow })` 的物理裁剪，提示词只负责说明，越权由状态机判、不由角色自报。

2. **六目录临时工作台：除 Executor 外谁都不保留上下文**
   - 工作台随宿主启动创建、随宿主进程退出删除（关窗留托盘不删）；崩溃残留按 `pid + boot-id` 在下次启动时清扫。
   - 固定六个子目录：原始任务需求与目的 / 执行方案 / 任务清单 / 审核结果 / 修改方案 / 最终审核。
   - 需求锚点是 `03 任务清单`：Planner 写一次就冻结，Reviewer 审核前必须先读它；审核发现问题写进 `04 审核结果` 退回 Planner 出 `05 修改方案`，通过则跳过 `05`、`06`。

3. **十状态机 + 驳回回路**
   - `drafting → ready → running → reviewing → revising → final-review → done`，另有 `blocked` / `escalated` / `aborted` 三个旁路。
   - 驳回上限默认 2 轮（`rejection_limit`，1–5）；写文件违约（缺字段、`requirement_ref` 幻觉等）走独立的 `protocol_retry_count`，不占驳回轮次。

4. **角色绑定双模式**
   - `triple`（默认）：Planner / Executor / Reviewer 必须是三个不同 actor。
   - `dual`：Planner 与 Reviewer 可绑同一个 actor，但进入审核阶段必须冷启动新会话，否则审核会带着规划记忆自查自批。

---

## 回退模式（`DSH_AGY_COLLAB_V2=0`）的 v1 行为

设了回退开关后，插件注册 `agy_collab_relay` 工具并注入三铁律提示词，行为与旧版完全一致：

1. **严格条件触发与零干扰隔离**
   - **仅对 D 后台转达生效**：只有当 A 收到来自本地总线（`127.0.0.1:18765`）的 `[DSH_BACKEND_RELAY]` / `[DSH_BACKEND_RELAY_BATCH]` 唤醒信号时，A 才进入「只规划、协商与最终审核，不直接动手修改业务代码」的协作角色。用户直接在 Antigravity 对话框交流时不受任何限制。
   - **D 端按开关物理隔离**：当 D 对话框的 `A↔D 协作` 按钮处于关闭状态时，插件的 `systemPrompt` 段落返回空字符串 `""`，工具调用直接返回未开启提示，不影响 D 原有功能或其他插件。
   - **兼容 `Xsdsh-purge` 与原生 DSH**：提示词段名使用 `xsdshpg-agy-collab`，通过白名单过滤并在加载时兼容注册。

2. **三阶段强制协作闭环 (`plan` → `consult` → `review`)**
   - **`phase: "plan"`（全类型任务开局必规划）**：无论编写/修改代码还是只读验证、测试、审计、排查、调研，D 在正式执行前必须整理用户需求发送给 A 完成规划后才可执行。
   - **`phase: "consult"`（途中疑问必协商）**：D 在执行途中遇到疑问、歧义、异常或不确定技术选择时暂停猜测，提交 `consult` 与 A 协商确认（`CONSULT_ANSWERED`）后继续。
   - **`phase: "review"`（最终结果必审核）**：执行完成后提交 `execution_report` 给 A 审核，通过（`APPROVED`）后才向用户汇报，未通过（`CHANGES_REQUESTED`）则按修改意见修正复审。

3. **方案 A：微批聚合唤醒与多 Subagent 并行处理**
   - `broker.mjs` 内置 `250ms` 微批聚合窗口与派发防重状态，D 并发发起多个协作请求时，`GET /listen` 一次返回完整批次（`[DSH_BACKEND_RELAY_BATCH]`），重挂监听不会重复触发在途任务。
   - A 接收到并发批次后立即重挂监听，并通过并发 `self` Subagent 或并行工具调用同时处理所有请求。

4. **D 客户端外置控制条与右侧实时任务看板**
   - **左下角外置控制条**（紧贴对话框外侧下方，不占输入区空间）：`A↔D 协作: 开/关` 开关 + `📊 任务看板` 抽屉触发器。
   - **右侧可收起任务看板**：包含 **6 步实时闭环流程图**，以及完整的 `D → A`、`A → D` 双向通信记录卡片（支持阶段筛选、长文折叠、一键复制、刷新与清空）。

5. **极简 Agent 间通信与自动上下文裁剪**
   - A → D 回复默认采用**极简四段式**（结论/方案 → 怎么做 → 注意什么 → 达到什么目的），减少冗余推理文本。
   - `broker.mjs` 自动将持久化记录控制在**最近 3 次协作**（`records.json` 最多 3 条、`history.jsonl` 最多 6 行、`*.md` 临时回复文档最多 3 份），避免上下文膨胀。

---

## 仓库目录结构

```text
dsh-antigravity-bridge/
├── docs/
│   ├── specs/
│   │   └── dsh-agy-collab-v2-spec.md   # v2 升级规格（三角色 / 工作台 / 状态机 / 迁移）
│   ├── prototypes/
│   │   ├── collab-settings.html    # 设置页可交互原型（浏览器直接打开）
│   │   └── collab-settings.md      # 原型逐块对照表与视觉令牌出处
│   ├── research/
│   │   └── dsh-host-capabilities.md  # DSH 宿主能力勘察（19 条约束 + 未确认项）
│   └── agents/                     # issue 跟踪、分类标签、领域文档约定
├── broker/
│   ├── broker.mjs                  # 本地 HTTP 消息总线 (127.0.0.1:18765)
│   ├── wait-next-request.mjs       # Antigravity 后台长轮询静默监听脚本
│   └── reply-request.mjs           # Antigravity 回传规划/协商/审核结论 CLI
├── plugin/
│   └── dsh-agy-collab/             # DeepSeek Harness (D) 插件本体
│       ├── package.json            # 插件清单与 dsh.client 声明
│       ├── cordis.patch.yml        # Cordis 插件挂载补丁
│       ├── README.md               # 插件说明
│       ├── lib/
│       │   ├── index.js            # Host 端入口：v2 装配开关、v1 回退工具、Web 路由
│       │   ├── actor-sessions.js   # 插件自建角色的会话白名单（宿主没有 origin=subagent 标记）
│       │   └── v2/                 # v2 三角色闭环：config / workspace / artifacts / state-machine / roles / tools / orchestrator / index
│       └── client.js               # Client 端：外置控制条与右侧任务看板 UI
├── test/
│   ├── v2/                         # v2 单元与端到端测试（13 个文件）
│   └── broker/                     # 本地总线派发、作废、断连回收测试
├── antigravity/
│   ├── rules/
│   │   └── dsh-collab-protocol.md  # Antigravity (A) 全局协作协议规则模板
│   └── skills/
│       └── dsh-collab/
│           └── SKILL.md            # Antigravity (A) 协作技能模板
├── scripts/
│   ├── install.mjs                 # 一键部署到 ~/.dsh/agy-collab、DSH profiles 与 ~/.gemini/config
│   └── sync-plugin.mjs             # 仅同步 DSH 插件并触发 HMR 热重载
├── package.json
├── .gitignore
└── LICENSE
```

---

## 快速安装与使用

### 1. 一键部署（需 Node.js >= 18）

```bash
git clone https://github.com/bhfgeeichsolo3047-byte/dsh-antigravity-bridge.git
cd dsh-antigravity-bridge

# 预览将写入的路径（可选）
npm run install:dry

# 安装并同步至 ~/.dsh/agy-collab、DSH 各 profile 以及 ~/.gemini/config
npm run install:bridge
```

> 若 DSH Desktop 正在运行，`scripts/sync-plugin.mjs` 会自动更新 `cordis.patch.yml` 的时间戳以触发服务端与前端热重载；如宿主机未能热载完整模块，重启一次 DSH Desktop 即可。

### 2. 在 DeepSeek Harness (D) 开启协作（v2 默认路径）

1. 点击 D 对话框左下角外侧的 **`A↔D 协作`** 开关使其处于 **开启** 状态；
2. 点击右侧的 **`📊 任务看板`** 可展开查看实时流程图与双向通信记录；
3. 向 D 下达任务，D 调 `collab_start` 建工作台、写 `01 原始需求`，随后 Planner 冷启动写方案与清单 → Executor 执行 → Reviewer 只读审核；驳回则回 Planner 出修改方案再执行复审，直到 `done` 或 `escalated`。

v2 默认路径**不需要**在 Antigravity 里挂监听：三个角色都在 D 进程内或当前会话里。

### 3. 可选：回退到 v1 双智能体模式

要恢复「D ↔ A」外部协作，先设回退开关再启动：

```bash
export DSH_AGY_COLLAB_V2=0      # Windows PowerShell: $env:DSH_AGY_COLLAB_V2="0"
```

然后在 Antigravity 打开一个（或专门新建的）协作会话窗口，发送：

> **开启 DSH 协作监听**

A 会启动后台长轮询任务：

```powershell
node "~/.dsh/agy-collab/wait-next-request.mjs"
```

（若消息总线 `broker.mjs` 尚未启动，该脚本会自动拉起它。）

> **注意**：当前设计为**不自动抢占**旧会话监听。切换到新协作窗口前，请先在旧窗口停止监听任务。

---

## 本地总线 API 一览 (`127.0.0.1:18765`)

broker 在 v2 默认路径下退化为**可选传输管道**（只有角色绑到进程外时才需要），但看板与 `/state` 仍由它承载，所以插件启动时仍会拉起它。下表全部端点保持可用；`/relay` `/listen` `/reply` 只服务 v1 回退模式。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/health` `/status` | `GET` | 查询 Broker 状态、监听者状态、`enabled` 开关与待处理请求数 |
| `/state` | `GET` / `POST` | 获取或切换会话/全局协作开关，同时返回最近 3 条记录 |
| `/records` | `GET` | 获取当前保留的协作记录（最多 3 条） |
| `/records/clear` | `POST` | 清空协作记录、事件流水及 `~/.dsh/agy-collab/*.md` 任务文档 |
| `/relay` | `POST` | D 提交 `plan` / `consult` / `review` 请求并阻塞等待 A 回复 |
| `/listen` | `GET` | A 长轮询获取单个或微批聚合请求（默认 `batchWindowMs=250`） |
| `/reply` | `POST` | A 回传 `PLAN_READY` / `CONSULT_ANSWERED` / `APPROVED` / `CHANGES_REQUESTED` |
| `/history` | `GET` | 获取最近事件流水（最多 6 条） |

---

## 设计文档

| 文档 | 作用 |
|---|---|
| [`docs/specs/dsh-agy-collab-v2-spec.md`](./docs/specs/dsh-agy-collab-v2-spec.md) | v2 升级规格：三角色契约、Workspace 文件契约、十状态机、兼容迁移、broker 归属、A 侧模板分发、设置页 |
| [`docs/research/dsh-host-capabilities.md`](./docs/research/dsh-host-capabilities.md) | DSH 宿主能力的原始勘察，含 19 条约束与未确认项 |
| [`plugin/dsh-agy-collab/docs/adr/0001-role-isolation-by-permission-tier.md`](./plugin/dsh-agy-collab/docs/adr/0001-role-isolation-by-permission-tier.md) | ADR：角色隔离为什么选「权限档 + 物理工具裁剪」而不是 agentPreset |
| [`docs/prototypes/collab-settings.html`](./docs/prototypes/collab-settings.html) | 设置页可交互原型 |
| [`plugin/dsh-agy-collab/GLOSSARY.md`](./plugin/dsh-agy-collab/GLOSSARY.md) | 术语表（Planner / Executor / Reviewer / Workspace / Host） |

---

## 许可证

[MIT](./LICENSE)
