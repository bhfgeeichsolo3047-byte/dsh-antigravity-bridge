# DSH ↔ Antigravity Bridge (`dsh-antigravity-bridge`)

**DeepSeek Harness (D) ↔ Google Antigravity (A)** 的本地网络后台静默多智能体协作桥梁与可视化看板系统。

在开启协作开关后，系统自动形成**「D 接单 → A 开局整体规划 → D 执行（遇疑与 A 协商） → A 审核结论」**的双智能体闭环，同时保证在开关关闭或用户直接与 A 对话时**完全零干扰**。

---

## 当前状态：仓库代码是 v1，v2 只有设计

本仓库正在从 v1（双 agent + 三阶段 + 四段式回执）升级到 v2（三角色 + 临时工作台 + 状态机）。**两个版本的边界要说清楚：**

| | v1（当前代码） | v2（设计已定，代码未写） |
|---|---|---|
| 角色 | D 与 A 两个 | Planner / Executor / Reviewer 三个 |
| 角色间传什么 | 四段式散文回执 | Workspace 里的结构化文件 |
| 谁记状态 | `records.json`（broker 侧） | `state.json`（Host 独占写） |
| broker | 必需 | 可选，只在有角色绑到进程外时才需要 |
| 设置页 | 无 | 右侧看板第二分页「设置与运行台」 |

**v2 的完整规格在 [`docs/specs/dsh-agy-collab-v2-spec.md`](./docs/specs/dsh-agy-collab-v2-spec.md)**，汇总了八张设计票的全部结论，是实现工作的唯一依据。设置页的可交互原型在 [`docs/prototypes/collab-settings.html`](./docs/prototypes/collab-settings.html)，用浏览器直接打开即可。

下面「核心特性」等章节描述的都是 **v1 现状**，不是 v2 的目标形态。

---

## 核心特性（v1 现状）

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
│       ├── lib/index.js            # Host 端：条件 Prompt、agy_collab_relay 工具、Web 路由
│       └── client.js               # Client 端：外置控制条与右侧任务看板 UI
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

### 2. 在 Antigravity (A) 启动静默监听

在 Antigravity 打开一个（或专门新建的）协作会话窗口，直接发送：

> **开启 DSH 协作监听**

A 会启动后台长轮询任务：

```powershell
node "~/.dsh/agy-collab/wait-next-request.mjs"
```

（若消息总线 `broker.mjs` 尚未启动，该脚本会自动拉起它。）

> **注意**：当前设计为**不自动抢占**旧会话监听。切换到新协作窗口前，请先在旧窗口停止监听任务。

### 3. 在 DeepSeek Harness (D) 开启协作

1. 点击 D 对话框左下角外侧的 **`A↔D 协作`** 开关使其处于 **开启** 状态；
2. 点击右侧的 **`📊 任务看板`** 可展开查看 6 步实时流程图与双向通信记录；
3. 向 D 下达任意任务，D 会自动完成 `plan → 执行 (consult) → review` 全闭环。

---

## 本地总线 API 一览 (`127.0.0.1:18765`)

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
