# dsh-agy-collab v2 升级规格

> 状态：**设计已定，代码未写**。本文汇总 wayfinder 地图 #1 下八张子票（#2 勘察 / #3 角色契约 / #4 单一事实源 / #5 六目录与状态机 / #6 设置页原型 / #7 兼容迁移 / #8 A 侧模板分发 / #9 broker 端口归属）的全部结论，作为实现票的唯一依据。
> 
> 仓库当前 `main` 上的代码仍是 **v1**（三阶段 plan/consult/review + 四段式散文回执 + records.json 当真相）。读完本文不要以为它已经实现。

---

## 0. 一句话说清 v2 要变成什么

v1 是「两个 agent 隔着一条总线互相喊话」：D 发 `phase: plan|consult|review`，A 回四段式散文，结论存在 broker 的 `records.json` 里，看板读那个 JSON。

v2 是「三个角色围绕一个临时工作台轮流干活」：

- 角色从 2 个变 3 个：**Planner**（拆任务）、**Executor**（干活）、**Reviewer**（只验是否达成）。
- 角色之间不再靠对话传结论，靠 **Workspace 里的文件**。每个角色被调用时是冷的（无历史），唯一输入是文件，唯一输出也是文件。
- broker 从「真相存放处」降级为**可选传输管道**，只在有角色绑到进程外时才需要；进程内三角色完全不经过它。
- 状态不再靠数文件推断，由 Host 的**状态机**写在任务 `state.json` 里。

三条不变的东西：Host 仍是唯一写任务 `state.json` 的角色；用户仍是唯一能改配置的人；外部角色（Antigravity）的信任等级与进程内角色不等同，这一点必须让用户看得见。

---

## 1. 术语

| 术语 | 定义 | 停用的旧说法 |
| --- | --- | --- |
| **Host** | DSH 宿主进程，插件跑在里面。持有状态机、写任务 `state.json`、清理 Workspace | — |
| **Planner** | 规划角色。读需求与既有产物，产出执行方案与任务清单 | 规划 agent / 规划者 |
| **Executor** | 执行角色。固定绑当前 DSH 会话，唯一有仓库写权限的角色 | 主 agent / 执行 agent |
| **Reviewer** | 审核角色。只判「是否达成需求」，不自主做额外动作 | 审核 agent / 审核者 |
| **Workspace** | 随 Host 启动创建、随 Host 退出删除的临时工作台，内含 6 个子目录 | 临时文件夹 / 草稿纸 |
| **broker** | HTTP 总线，v2 里是可选的进程外传输通道 | — |

术语表落在 `plugin/dsh-agy-collab/GLOSSARY.md`，根 `GLOSSARY-MAP.md` 是索引。改术语先改那里。

### 1.1 两个 `state.json` 必须分开叫

v2 里有两份都叫 `state.json` 的文件，混用会让实现直接错。**本文以下一律带限定词，不再出现裸名**：

| 全称 | 路径 | 装什么 | 唯一写方 | 生命周期 |
| --- | --- | --- | --- | --- |
| **配置 `state.json`** | `~/.dsh/agy-collab/state.json` | 协作开关、角色绑定、审核档位、驳回上限、`brokerPort`、`schema_version` | 用户经设置页 | 跨 Host 重启长期存在 |
| **任务 `state.json`** | `<workspace>/<pid>-<boot>/<sid>/<task>/state.json` | `state` / `round` / `rejection_count` / 各计数器 | Host 状态机 | 随 Host 退出被删 |

一句话记：**配置侧管「要不要跑」，任务侧管「跑到哪了」。** 迁移时 `schema_version` 只写在配置侧；状态机游标只写在任务侧，两者不共用一个文件。

---

## 2. 总体架构

```
                    ┌──────────────────────────────┐
                    │  Host 进程（状态机 + 快照 + 清扫）│
                    └───────────┬──────────────────┘
                                │ 只通过文件交换信息
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
   ┌────▼────┐            ┌─────▼─────┐          ┌──────▼─────┐
   │ Planner │            │ Executor  │          │  Reviewer  │
   └────┬────┘            └─────┬─────┘          └──────┬─────┘
        │ 写 02/03/05            │ 只写仓库产物           │ 写 04/06
        └───────────────────────┴───────────────────────┘
                                │
                    ┌───────────▼──────────────────┐
                    │ Workspace/<pid>-<boot>/<sid>/<task>/ │
                    │  01 原始任务需求和目的                │
                    │  02 执行方案                        │
                    │  03 任务清单（冻结）                 │
                    │  04 审核结果                        │
                    │  05 修改方案                        │
                    │  06 最终审核                        │
                    │  state.json（Host 独占写）            │
                    └──────────────────────────────┘
```

信息流（用户描述的原始逻辑，逐条落成可执行约束）：

1. 用户提需求 → Host 写 `01/request.md`（写一次，不可变）。
2. Planner 读 01 → 写 `02/plan.md`（方案）+ `03/tasks.md`（任务清单）。**03 只写一次，写完冻结**，里面只有「要达到什么」不含「怎么做」。
3. Executor 读 01/02/03 → 干活（改仓库）。它不写 Workspace 任何文件。
4. Reviewer 读 01/03 + 仓库客观产物 → 写 `04/review-r<N>.md`。它读不到 Executor 的任何主观叙述，也读不到 02（避免被方案带偏）。
5. `verdict: pass` → 直接 `done`，**跳过 05 与 06**。
6. `verdict: needs_revision` → Host 把 findings 交给 Planner，Planner 写 `05/revision-r<N>.md`（修改方案）→ Executor 改 → Reviewer 复审，落 `04/review-r<N+1>.md`。
7. 轮次到上限后还有一轮终审，落 `06/final.md`。通过 → `done`；仍不通过 → `escalated`（交人）。

「每个 agent 只跟一个 agent 交互」这条落成了：所有角色只跟 Host 交互（被 Host 调用、向 Host 交产物），彼此之间没有直接通道。需要知道别人干了什么时，去读 Workspace 的对应文件。

---

## 3. 单一事实源（票 #4）

### 3.1 状态归属表

| 状态 | 归谁 | 唯一写方 | 为什么 |
| --- | --- | --- | --- |
| 协作开关、角色绑定、审核档位、驳回上限 | 配置 `state.json` | 用户经设置页 | 决定「要不要跑」，是配置不是过程 |
| 任务状态机游标（state/round/rejection_count…） | 任务 `state.json` | Host 状态机 | 决定「跑到哪了」，必须只有一个写方 |
| 6 目录产物 | Workspace | 对应角色（Host 只写 01） | 是角色间唯一的信息载体 |
| 角色间请求 / 回复 / 历史 | broker | broker 自己 | 「谁跟谁说了话」，是传输不是结论 |
| 进程身份（host-pid / boot-id / session-id / task-id） | 目录名本身 | Host | 写进路径就不用再存一份 |

判据三条，遇到新东西时照这个归类：

- 能决定「要不要跑」的 → 配置 `state.json`。
- 能决定「跑到哪了」的 → Workspace（过程侧）。
- 只记录「谁跟谁说了话」的 → broker（传输侧），**永远不是真相**。

### 3.2 目录层级

```
<root>/
  <host-pid>-<boot-id>/
    <session-id>/
      <task-id>/
        01-原始任务需求和目的/
        02-执行方案/
        03-任务清单/
        04-审核结果/
        05-修改方案/
        06-最终审核/
        state.json      # 任务状态机，Host 独占写
```

`<root>` 默认 `~/.dsh/agy-collab/workspace/`，可在设置页改。每一级都带身份，多个会话并发天然不互踩，**不需要额外的锁**。

### 3.3 生命周期与删除

「关闭客户端时删除」在 DSH 里只能承诺三段，因为宿主无法拦截崩溃与断电：

| 情形 | 行为 |
| --- | --- |
| Host 正常退出（关窗、SIGINT/SIGTERM、profile dispose） | 删整棵 `<pid>-<boot-id>` 树 |
| 关窗但留托盘（进程还活着） | **不删**，生命周期跟着进程走，不跟窗口 |
| 崩溃 / SIGKILL / 断电 / 关机 | 残骸留下，**下次启动静默清扫**，不续跑 |
| 同进程内任务到终态 | 不删，保留到 Host 退出（用户可能还要看） |
| 存活期用户直接改文件 | 允许，下游按最新文件生效 |
| 想留档 | 显式「导出 / 复制」到用户指定目录 |

下次启动的清扫判据（**不能只靠目录存在**）：扫 `<root>` 下所有 `<pid>-<boot-id>` 目录，pid 已不存在 **或** boot-id 与当前开机不匹配 → 整段删。两者都命中才算「上次的残骸」，单看 pid 会把「刚好被复用的 pid」误删。

这条的现成范例在 `broker/broker.mjs:17` 与 `:693`：`PID_FILE` 写了但全仓没有读取方也没有清理方 —— v2 要把它补上读方（见 §10）。

---

## 4. Workspace 文件契约（票 #5 A1 / A2）

### 4.1 文件清单与可变性

| 文件 | 写方 | 可变性 | 说明 |
| --- | --- | --- | --- |
| `01-原始任务需求和目的/request.md` | Host | **不可变** | 用户需求原文 + 目的，写一次 |
| `02-执行方案/plan.md` | Planner | 可覆盖，不留旧版 | 因为 Planner 严格无状态，旧方案没有引用价值 |
| `03-任务清单/tasks.md` | Planner | **全流程只写一次，写完冻结** | 隔离机制的支点 |
| `04-审核结果/review-r<N>.md` | Reviewer | 一轮一个，只增不改 | N = 1,2,3… |
| `05-修改方案/revision-r<N>.md` | Planner | 一轮一个 | N 与被驳回的那轮对应 |
| `06-最终审核/final.md` | Reviewer | 一份 | 只收「不能再循环的那一次」 |
| 任务 `state.json` | **Host 独占** | 每次状态转移覆写 | 任何角色都不可写 |

**「03 冻结」为什么是整个设计的支点**：Reviewer 每一轮拿到的需求必须逐字相同。如果 Planner 能在返工时偷偷改需求，Reviewer 就永远无法判断「Executor 是不是真的达成了最初那个需求」——审核会退化成「你是不是达成了你最新说的那个」。

### 4.2 front-matter schema

通用五字段，每个文件都有：

```yaml
---
task_id: t-2026-1125-01
stage: request | plan | tasks | review | revision | final
author: host | planner | executor | reviewer
round: 0            # review / revision / final 才有意义，其余填 0
written_at: 2026-11-25T19:52:04+08:00
---
```

各文件的额外字段：

- `request.md`：`raw_text`（用户原话，逐字）。
- `plan.md`：`steps: [{ id, purpose, tools[], subagent_count? }]`。`subagent_count` 只在「预估子 agent 数量」开关打开时出现。
- `tasks.md`：`requirements: [{ id, text }]`。**这是全局锚**，后面所有 `requirement_ref` 都指这里。
- `review-r<N>.md` / `final.md`：`verdict: pass | needs_revision`，`findings: [{ id, requirement_ref, severity, problem, required_fix }]`。严格档下 `requirement_ref` 必填，且必须命中 `tasks.md` 里真实存在的 id（不命中 = 幻觉引用 = 协议违规）。

### 4.3 `tasks.md` 的三条机器硬检查

用户要求「任务清单不涉及具体实现过程只有任务目的和需求」，这条不能只靠提示词自觉，必须机器可查：

1. front-matter 只许有 `requirements[]`。出现 `steps` / `files` / `commands` / `tools` 任一字段 → 违约。
2. 正文禁止代码围栏（三个反引号）。
3. 正文禁止表格与复选框（`- [ ]` / `- [x]`）。

命中任一条 → 立即停止 `drafting`，退回 Planner 重写，**不占驳回轮次**（`rejection_count` 不动，`round` 不动）。同一轮连续 3 次 → `escalated`。这个计数器叫 `format_violation_count`，与 §9 的 `protocol_retry_count` 并列。

---

## 5. 状态机（票 #5 B1–B5）

### 5.1 十个状态

`drafting` `ready` `running` `reviewing` `revising` `final-review` `done` `blocked` `escalated` `aborted`

映射到用户能看懂的五个阶段：

| 阶段 | 状态 |
| --- | --- |
| 准备 | `drafting` `ready` |
| 执行 | `running` |
| 审核 | `reviewing` `final-review` |
| 返工 | `revising` |
| 收尾 | `done` `blocked` `escalated` `aborted` |

### 5.2 任务 `state.json` 字段

```json
{
  "task_id": "t-2026-1125-01",
  "state": "revising",
  "round": 1,
  "rejection_count": 1,
  "overreach_count": 0,
  "format_violation_count": 0,
  "protocol_retry_count": 0,
  "executor_session_id": "...",
  "created_at": 1795584910302,
  "updated_at": 1795584999999,
  "last_event": "T9 reviewing->revising (verdict=needs_revision, 3 findings)"
}
```

**唯一写方是 Host 的状态机组件**。任何角色、任何 UI、任何外部进程都不写这个文件。

### 5.3 转移表 T1–T15

| ID | 从 | 到 | 条件 |
| --- | --- | --- | --- |
| T1 | ∅ | `drafting` | 协作开关开，用户提交需求 |
| T2 | `drafting` | `drafting` | Planner 产物违约（§4.3），原地重来 |
| T3 | `drafting` | `ready` | 02 与 03 均通过校验 |
| T4 | `ready` | `running` | `round = 1` |
| T5 | `running` | `reviewing` | `round <= rejection_limit` |
| T6 | `running` | `final-review` | `round > rejection_limit` |
| T7 | `running` | `blocked` | Executor 判定无法完成（需求不清 / 外部依赖不可用） |
| T8 | `reviewing` | `done` | `verdict: pass`，**跳过 05 与 06** |
| T9 | `reviewing` | `revising` | `verdict: needs_revision` 且 `rejection_count + 1 <= rejection_limit` |
| T10 | `revising` | `running` | Planner 写完 `05/revision-r<N>.md`，`round += 1` |
| T11 | `final-review` | `done` | `verdict: pass` |
| T12 | `final-review` | `escalated` | `verdict: needs_revision` |
| T13 | `blocked` | `drafting` | 用户交回，`round` 归 1 |
| T14 | 任意非终态 | `aborted` | 用户中止 |
| T15 | 任意非终态 | `escalated` | 越权累计 2 次 / 违约连续 3 次 / 协议违规同轮 2 次 |

### 5.4 `06/final.md` 是什么

**「不能再循环的那一次审核」，不是「第 2 次审核」。** 默认 `rejection_limit = 2` 时：

- 第 1 轮 `04/review-r1.md` → 驳回 → `05/revision-r1.md`
- 第 2 轮 `04/review-r2.md` → 驳回 → `05/revision-r2.md`
- 第 3 轮 = `06/final.md` → 通过 `done` / 不通过 `escalated`

首发通过则 `05` 与 `06` 都不存在。

### 5.5 关掉协作开关的语义

不启新任务；在跑的走到终态；只允许向终态或 `blocked` 转移。**不做「立即中断」**——中断会让角色产物停在半个状态，比多跑完一轮更糟。

---

## 6. 角色契约与权限（票 #3 + #5 A4/A5/B6）

### 6.1 角色 = 权限档 × 载体

角色不是一个名字，是「它能做什么」和「它跑在哪里」两件事的组合：

| 角色 | 权限档 | 默认载体 | 可换载体吗 |
| --- | --- | --- | --- |
| Planner | 只读仓库 + 写 02/03/05 | 进程内（`ctx.agents.create()`） | 可以，可换进程外 |
| Executor | 读写仓库 + **不写 Workspace** | **固定当前 DSH 会话** | **不可以** |
| Reviewer | 只读仓库 + 写 04/06 | 进程内 | 可以，可换进程外 |

Executor 永远不绑只读档，Planner / Reviewer 永远不绑仓库写档。

### 6.2 能力边界表（票 #5 B6）

| 角色 | 读 | 写 |
| --- | --- | --- |
| Host | 全部 | `01/request.md`、任务 `state.json`、整树清扫 |
| Planner | `01` `03` `04` `05` | `02/plan.md`、`03/tasks.md`、`05/revision-r<N>.md` |
| Executor | 全部（含仓库） | **不写任何六目录文件**，只写仓库产物 |
| Reviewer | `01` `03` `04` `06` + 仓库客观产物 | `04/review-r<N>.md`、`06/final.md` |

两条容易忽略的边界：

- **Reviewer 不读 02**。读了 02 就会被 Planner 的方案带偏，审核会变成「你是否按这个方案做了」而不是「你是否达成了需求」。
- **Reviewer 不读 Executor 的任何主观叙述**。它只拿仓库客观产物（`git status` / `git diff` / 文件树 / 命令输出）。六目录里**不设执行记录**，因为那会变成 Executor 的自我辩护。

### 6.3 强制顺序：三层，缺一不可

```
协议层没有写通道  →  tools.restrict({allow}) 物理裁剪  →  提示词只做说明
   （broker 不给写接口）      （契约 dsh-tools/src/index.ts:164）    （最弱的一层）
```

只靠提示词要求「你是只读的」是不够的 —— 提示词是建议，`tools.restrict` 是物理限制。顺序不能颠倒。

### 6.4 越权判定

**越权由状态机判，不由 Reviewer 自报。**

机制：每次角色调用前后各取一次快照（Workspace 全树 `path,mtime,size,sha256` + `git status --porcelain`），差集只允许出现「本轮该写的那个文件」。多出任何东西 → `overreach_count += 1`，累计 2 次 → `escalated`。

**任务 `state.json` 按哈希豁免，不按文件名豁免**：它是 Host 状态机的账本，住在任务根目录下，而角色的每一次事件推进（`format-violation`、`protocol-violation`、`overreach`）都会让 Host 写它。若不处理，任何一次违约记数都会在下一轮快照里被读成「角色多写了一个文件」，把违约误判成越权、并让重试环永远收敛不了。

但**不能按文件名无条件放过**：那样角色直接篡改任务 `state.json`（例如伪造 `state: done`）就完全失明。判据是**写入方 + 内容**两段：Host 每次落盘任务 `state.json` 之后记下它的 `sha256`；快照 diff 时，只有当 `after['state.json'].sha256` 等于这个「Host 自己刚落盘的哈希」才豁免；哈希对不上（被改写）或文件被删，一律计入差集触发 `overreach`。

这条也解释了为什么设置页**不给文件编辑框**：人从 UI 写进去的内容，在快照 diff 里与角色越权长得一模一样，会判废误伤。

### 6.5 冷调用（D3）

Planner 与 Reviewer **每次被调用都是冷的**：新建实例、没有历史、输入只有 Workspace 文件、用完即弃。

理由：`docs/research/dsh-host-capabilities.md:297-298` 明确 presets are not security sandboxes，宿主对外部通道没有约束力。既然不能保证外部 CLI 清空上下文，那就在设计上不依赖上下文 —— 需要的信息全在文件里。

### 6.6 多 Agent 的唯一可行路径

DSH 提供四条多 Agent 路径，只有 `ctx.agents.create()` 同时满足三个条件：不带会话上下文、可指定只读工具集、可指定模型。所以进程内角色全部走这条路，不走 `agentPreset`。

否决 `agentPreset` 的两个理由：①它要改 profile 的 `cordis.patch.yml` 再重载，与「设置页改完立即生效」直接冲突；②presets are not security sandboxes，它给不了隔离保证。

### 6.7 进程内角色的落盘通道（实现接口）

`tools.restrict({ allow })` 把仓库写工具裁掉之后，Planner 与 Reviewer **怎么把文件写出来**？这是规格里必须钉死的一处接口，否则实现时会各写一套。

两条通道，二选一，**不能混用**：

| 通道 | 机制 | 何时用 |
| --- | --- | --- |
| **A · 受限写工具**（推荐） | Host 注册一个 `collab_write` 工具，参数只有 `{ slot, filename, content }`；Host 侧校验 `slot` 与当前阶段匹配、`filename` 在本阶段允许的清单里，然后由 **Host 落盘** | Planner 写 02/03/05、Reviewer 写 04/06 全部走这条 |
| B · 捕获结构化输出 | 角色把 front-matter + 正文作为工具调用的返回值，Host 从返回值里取 | 仅当角色载体无法调用工具时（例如纯文本外部通道） |

**选 A 的理由**：写权限始终在 Host 手里，角色只是「提交内容」。这样 §6.4 的越权判定才有意义 —— 如果角色自己就能写文件，快照 diff 只能事后发现，而通道 A 是事前拦截。同时通道 A 天然满足「不许写 01」：`slot` 枚举里根本没有 `01` 这一项。

`collab_write` 的校验清单（实现时必须逐条做）：

1. `slot` ∈ 当前角色的可写集合（§6.2 那张表），否则拒绝并计 `overreach_count`。
2. `filename` ∈ 本阶段允许的清单：Planner 在 `drafting` 只许 `plan.md` / `tasks.md`，在 `revising` 只许 `revision-r<N>.md`（N 必须等于任务 `state.json` 的 `round`）；Reviewer 在 `reviewing` 只许 `review-r<N>.md`，在 `final-review` 只许 `final.md`。
3. `content` 通过 §4.2 的 front-matter 校验与 §4.3 的三条硬检查（对 `tasks.md`）。
4. 校验通过才写；写之前取一次快照、写之后取一次快照，差集必须恰好是这一个文件。

### 6.8 Executor 与状态机的触发点

Executor 是「当前 DSH 会话」，它不会自己调状态机。T5（`running → reviewing`）与 T7（`running → blocked`）必须由 Host 提供的显式工具触发：

| 工具 | 谁调 | 触发 | 参数 |
| --- | --- | --- | --- |
| `collab_submit_for_review` | Executor | T5 | `{ summary }`（可选的一句话说明，**不进 Reviewer 输入**，只写进任务 `state.json` 的 `last_event`） |
| `collab_mark_blocked` | Executor | T7 | `{ reason }`（必填，写进 `last_event`，UI 上显示为「在等你」） |

这两个工具只在 `running` 状态可见（`tools.restrict` 按状态动态给），其他状态调用直接拒绝。

T10（`revising → running`）由 Host 主动推进：Planner 写完 `05/revision-r<N>.md` 并通过校验后，Host 自己把状态推到 `running` 并**唤起 Executor 的下一轮**（同一会话、带一句「读 05/revision-r<N>.md 并按 findings 修改」）。这一步不需要 Executor 调任何工具。

用户中止走 `collab_abort`（T14），任何非终态可见。

### 6.9 必修的既有 bug

宿主判断「这是不是我起的子代理」靠 `session.header.origin === 'subagent'`（`dsh-subagent/src/child-agent.ts:152`）。插件自己 `ctx.agents.create()` 出来的 Agent **没有这个标记**，会被当成普通用户会话注入提示词（`plugin/dsh-agy-collab/lib/index.js:244-246` 现在正是这么写的）。

修法：判据改成插件自持的 actor sessionId 白名单。

---

## 7. 角色绑定模式（票 #7）

### 7.1 两种模式

| 模式 | 含义 | 约束 |
| --- | --- | --- |
| `triple`（默认） | 三个角色绑三个不同 actor | 同一 actor 出现在两槽 → `drafting` 之前拒启 |
| `dual` | 允许 Planner 与 Reviewer 是同一个 actor | 权限取并集（可写 02/03/05 与 04/06），仍**不可写 01**、不写仓库；Review 阶段必须冷调用 |

### 7.2 dual 模式的冷调用怎么保证

外部 CLI 的上下文宿主清不掉，所以只能靠「显式自述 + 违规判定」：

1. Host 在 Planner 调用结束时记下 `planner_invocation_id`。
2. 进入 Review 阶段，若复用同一会话句柄 → Host 拒绝，重新 `ctx.agents.create()`，写 history 记 `review_cold_restart`。
3. 进程外角色：wake 消息带 `cold: true`，回执必须带 `handled_in: main | subagent`；回 `main` 判协议违规。

**判据是进程内实例身份，不看提示词、也不看 `actor_id`** —— dual 下两槽 `actor_id` 本来就相同，靠它无从判断。

第 3 步是「显式自述字段」不是硬保证：宿主看不见外部 CLI 的进程，无法验证它到底有没有新开实例。但它把「忘了冷启」从一次无意疏忽变成一次需要主动撒谎的行为。这与 D7 的既有姿态一致：只承诺「越权会被状态机作废」，不承诺「外部角色做不到越权」。

---

## 8. 配置项（配置 `state.json`）

```json
{
  "schema_version": 2,
  "enabled": false,
  "sessions": { "<sid>": false },
  "brokerPort": 18765,
  "workspaceRoot": "~/.dsh/agy-collab/workspace",
  "role_binding_mode": "triple",
  "roles": {
    "planner":  { "carrier": "in-process", "model": null, "actor_id": null },
    "executor": { "carrier": "session",     "model": null, "actor_id": null },
    "reviewer": { "carrier": "in-process", "model": null, "actor_id": null }
  },
  "reviewer_mode": "strict",
  "rejection_limit": 2,
  "estimate_subagents": false,
  "updatedAt": 1795584910302
}

默认值（票 #3 D6）：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| 协作总开关 | **关** | 按会话（`isCollabEnabled(sid)`），不是全局 |
| Executor 载体 | 固定当前会话 | 不可换 |
| Planner / Reviewer 载体 | 进程内 | 可换进程外 |
| 预估子 agent 数量 | **关** | 关时 `plan.steps[].subagent_count` 不出现 |
| 审核档位 | `strict` | 严格档要求 `requirement_ref` 必填且命中 |
| 驳回上限 | 2 | 可改范围 1–5，且只在 `drafting` 阶段可改 |
| `role_binding_mode` | `triple` | |

旧字段 `enabled` / `sessions` / `updatedAt` **原位保留**，不搬家 —— 避免迁移时把用户已有配置弄丢。

---

## 9. 兼容迁移（票 #7）

### 9.1 传输层不动，语义层换

`/relay` `/listen` `/reply` 三个端点的**消息形状不变**，变的只有路由依据：

| v1 | v2 |
| --- | --- |
| `phase: plan \| consult \| review` | `role: planner \| reviewer` |
| `phase` 决定走哪条逻辑 | `phase` 降级为**被忽略的别名**，收到时记一条 history 警告 |

### 9.2 旧词表：不是翻译，是删除

| 旧物 | 去向 |
| --- | --- |
| `PLAN_READY` / `CONSULT_ANSWERED` | 删。v2 里没有「规划完成」这个信号，Planner 的完成信号是「02 与 03 两个文件写完了」 |
| `APPROVED` | 删。结论改由 `04` / `06` 文件的 `verdict: pass` 承载 |
| `CHANGES_REQUESTED` | 删。改为 `verdict: needs_revision` + `findings[]` |
| 四段式散文回执 | 降为纯回执（「本轮结束」），不再是结论载体 |
| `consult` 阶段 | 删。需求不清 → `blocked`；方案不可行 → 走驳回 |

为什么是删除而不是映射：旧词表的载体是 `content` 里的四段式散文（`broker/broker.mjs:619`），它承载不了 `findings[]` 这种结构化数据（严格档要求每条 finding 带 `requirement_ref` 且命中 `tasks.md` 真实 id）。产物改落文件后，旧词表自然失去意义。

### 9.3 `/reply` 的新语义

`/reply` 只剩「本轮结束」这一个信号，**不解析 `content`、不看 `verdict` 取值**。真正的结论从文件读。六步路由：

1. 校验 `requestId` 存在，且 `role` 与当前在等的槽位一致。
2. 定位 `04/review-r{round}.md`（`round` 必须等于任务 `state.json` 的 `round`）。
3. 解析 front-matter：`verdict` 枚举合法、`findings` 每项五字段齐全。
4. 严格档：每个 `requirement_ref` 必须命中 `03` 已冻结的 id 集合。
5. 任一步失败 = 协议违规 → `protocol_retry_count += 1`，**原地重写同一文件**（不追加 `review-r{N+1}.md`）、不占 `rejection_count`、`round` 不递增；同轮连续 2 次 → `escalated`。
6. 全部通过 → 只读 `verdict` 路由：`pass` → T8 / T11；`needs_revision` → 查 `rejection_count`。

### 9.4 存量数据不迁

实测 `~/.dsh/agy-collab/` 现状：`records.json` 3 条、`history.jsonl` 6 行，时间戳全在 2026-11-24 15:41–15:58，是自用调试数据；配置 `state.json` 的 `enabled` 与 4 个 session 全是 `false`。

所以不迁：冷备份到 `~/.dsh/agy-collab/archive-20261125/`，然后 `POST /records/clear`。

`records.json` 从此是**派生缓存**，不是真相。看板 8 处读取（`plugin/dsh-agy-collab/client.js:668 / 736 / 743 / 752 / 758 / 768 / 804 / 816`）全部改读 Workspace。

### 9.5 升级闸

不做灰度开关。用 `schema_version: 2` 一次性升级：读到 `schema_version !== 2` 时执行一次迁移（补默认字段 + 冷备份 + 清 records），成功后写回 2。

### 9.6 兼容期退出判据（四条，grep 可验）

1. 配置 `state.json` 全部样本 `schema_version === 2`。
2. `grep -rn "phase\s*[:=]" plugin/ broker/` 在路由处零命中。
3. `grep -rn "PLAN_READY\|CONSULT_ANSWERED\|APPROVED\|CHANGES_REQUESTED"` 只剩迁移文档里的引用。
4. 一次完整闭环实跑：`drafting → ready → running → reviewing → revising → running → final-review → done`。

### 9.7 用户会失去什么

| 失去 | 补偿 |
| --- | --- |
| 「A 规划 + 审核合一」的默认用法 | `dual` 模式下仍然可以，但需遵守冷调用规则 |
| `consult` 阶段 | 需求不清走 `blocked`，方案不可行走驳回 —— 交互更慢但结论更硬 |
| 看板里的旧 records 历史 | 冷备份目录里还能看，UI 不再展示 |
| 四段式散文回执 | 回执变短，信息改看 Workspace 文件 |

---

## 10. broker（票 #4 Q2 + #9）

### 10.1 降级为可选管道

进程内三角色**完全不经过 broker**。只有角色绑到进程外（Antigravity）时才需要它。

### 10.2 端口归属：单机单实例共享

`ensureBrokerProcess`（`plugin/dsh-agy-collab/lib/index.js:106-132`）改成四步判定：

1. `GET /health`，1000ms 超时。
2. 返回 `{ ok: true, service: "dsh-agy-collab-broker" }` → **自家签名，attach 复用**，不 spawn。
3. 端口通但签名不符 → **异己占用，报错上抛不重试**。文案：「端口 18765 被其他程序占用，请在设置页改端口或关闭占用它的程序」。
4. 连不上 → spawn 自己的一份，**spawn 后重新探一次 `/health` 确认真起来了**才 resolve。

第 4 步是必须修的现成 bug：现在 spawn 后 `setTimeout(400)` 直接 `resolve(true)`，无论成没成都返回成功。

### 10.3 降级两层

- 进程内三角色：broker 挂了照跑。
- 配了外部角色但总线不可用：**在 `drafting` 之前拒启**，给出原因与修复动作。

**不做静默回落到进程内**。静默回落会悄悄改变审核严格度 —— 用户以为还是外部 A 在审，实际是本地另一个实例，审查看起来发生了但审查者不是他以为的那个。

### 10.4 `broker.pid` 升级为 JSON 归属记录

```json
{
  "service": "dsh-agy-collab-broker",
  "schemaVersion": 1,
  "pid": 4524,
  "port": 18765,
  "startedAt": 1795584910302,
  "bootId": "3f9a1c"
}
```

三个用途：复用判据（`/health` 不通但 pid 文件在且 pid 存在、`startedAt` 吻合 → 认为正在启动中，等一会再探）/ 残留清理（pid 不存在或 `bootId` 不匹配 → 上次开机遗留，删）/ 设置页显示。

`bootId` + `startedAt` 组合是防 pid 复用的关键：单看 pid 存在无法区分「就是它」和「pid 被别的进程复用了」。

### 10.5 生命周期：机器级服务

**不随首个 Host 退出而死。** 如果 broker 跟着第一个退出的 Host 死，其他会话的外部角色会瞬间断线。

这与 §3.3 的「关闭客户端即删除」不冲突 —— 那里的删除承诺只约束 Workspace，不约束 broker。

回收：最后一个监听者断开且 `pendingCount === 0` → 开始计空闲 → 满 30 分钟自退。设置页给显式「关闭总线」按钮（二次确认，提示「正在使用外部角色的会话会断线」）。

现状的 `detached: true` + `child.unref()`（`plugin/dsh-agy-collab/lib/index.js:116`、`:120`）在这个模型下是对的，不用改。

### 10.6 端口配置

优先级：`env DSH_AGY_COLLAB_PORT` > 配置 `state.json` 的 `brokerPort` > `18765`。env 最高，因为它是运维 / CI 的逃生口。

端口现在硬编码在 6 处，实现时全部要改：`broker/broker.mjs:11`、`plugin/dsh-agy-collab/lib/index.js:27`、`broker/reply-request.mjs:9`、`broker/wait-next-request.mjs:16`、`plugin/dsh-agy-collab/client.js:29` 与 `:30`。

**client 的两处必须改成从 `/api/agy-collab/state` 的响应里拿端口**，不能自己拼字符串 —— 否则用户改了端口，看板还在戳 18765。

---

## 11. A 侧模板分发（票 #8）

### 11.1 恒定两份

`planner.md` 与 `reviewer.md`，放在 `~/.gemini/config/rules/dsh-collab/` 下（不再放 `rules/` 根目录，避免与其他规则文件混在一起无法按目录清理）。

**Executor 没有 A 侧模板** —— 它绑的是 DSH 当前会话，Antigravity 侧从不扮演这个角色。分发一份只会制造「Executor 也能外置」的错误预期。

现行 `antigravity/rules/dsh-collab-protocol.md` 与 `antigravity/skills/dsh-collab/SKILL.md` 两个文件**合并重写**为这两份角色模板。

### 11.2 份数不随绑定模式联动

`dual` 下同一 actor 占两槽，但它每次被唤醒时收到的请求里带 `role` 字段，按这个字段只加载对应那一份。两份文件都在磁盘上，**模式切换是零文件变更**，只是一次配置写入。

### 11.3 install 改成 manifest 声明式同步

```json
// ~/.gemini/config/.dsh-collab-manifest.json
{ "schemaVersion": 1, "files": [{ "path": "rules/dsh-collab/planner.md", "sha256": "..." }] }
```

三条规则：

1. 本次要分发的文件 → 覆盖写，写入 manifest。
2. manifest 里记过、本次不再分发 → 删除，从 manifest 移除。
3. **不在 manifest 里的一律不碰**（用户自己放的文件不动）。

现状 `scripts/install.mjs:34-50` 只覆盖写、没有任何删除分支。迁移到 v2 时旧的 `dsh-collab-protocol.md` 与 `skills/dsh-collab/` 必须能被清掉，否则两套规则同时生效 —— A 会按旧规则回传 `PLAN_READY`，而 v2 的 Host 已经不认识它。

#### 11.3.1 首次迁移的清理规则（manifest 的空表陷阱）

上面三条规则有一个洞：**v1 从来没写过 manifest**。首次装 v2 时 manifest 不存在，等于空表，第 2 条「manifest 里记过、本次不再分发 → 删除」什么都匹配不上 —— 旧的 `dsh-collab-protocol.md` 与 `skills/dsh-collab/` 会原地留着，两套规则同时生效。

所以 `install.mjs` 必须补第 4 条：**首次建 manifest 时（文件不存在或 `schemaVersion` 不认识），显式探测并清理 v1 遗留路径**：

```js
// 仅在 manifest 不存在时执行一次
const LEGACY_V1_PATHS = [
  'rules/dsh-collab-protocol.md',      // v1 全局规则
  'skills/dsh-collab/SKILL.md',        // v1 技能
];
```

处理方式与常规删除一致（先判存在、再删、父目录空了就一并删），但**不写进 manifest**——它们不是本次分发的东西，写进去会让下次运行误以为「这是我装的」。

三个约束：

1. 只在这两个**精确路径**上动手，不做 `rules/` 或 `skills/` 目录级扫描。用户可能在同一目录下放了自己的规则文件。
2. `--dry-run` 必须把「将删除哪些遗留路径」打出来，让人能先看一眼。
3. 清理完成后立刻写 `{ schemaVersion: 1, files: [...本次分发的...] }`，让下一次运行走正常路径。

反过来的情形也要处理：v1 用户跑过一次 `install.mjs` 之后又升级到 v2，`~/.gemini/config/rules/dsh-collab-protocol.md` 已经存在且内容是 v1 的 —— 这正是上面 `LEGACY_V1_PATHS` 覆盖的场景，不区分「谁装的」，只按路径清。

### 11.4 版本判据：sha256，不是版本号

| 判什么 | 用什么 | 存在哪 |
| --- | --- | --- |
| 用户机器上的模板是不是仓库里这一版 | `sha256(bundled) vs sha256(installed)` | manifest |
| 给人看的版本标识 | front-matter 里的 `template_version` | 模板文件自身 |
| 数据形状要不要迁移 | `schema_version` | 配置 `state.json` |

为什么不用版本号：版本号会漂。用户手改一个字节、或某次安装中断留下半份文件，版本号还是原来那个数，但内容已经不是了。哈希是唯一不会撒谎的判据。

### 11.5 设置页三态提示位

| 状态 | 显示 |
| --- | --- |
| 未安装 | 灰，「外部角色不可用，仅能跑进程内三角色」 |
| 已安装且哈希一致 | 绿，显示 `template_version` |
| 已安装但哈希不符 | 琥珀，附「重新安装」按钮，「A 侧仍在按旧协议回传」 |

这是唯一一处「代码升级了但用户机器上还是旧行为」的地方。没有这个提示位，用户会以为已经升级，实际 A 还在回传 `PLAN_READY`。

### 11.6 顺序约束（第一条必须遵守的）

两个源模板 + `scripts/install.mjs` + `scripts/sync-plugin.mjs` **必须同一次提交**。用户只要跑一次 `npm run install:bridge`，旧协议就被写回去。

已实地确认两份模板就在用户机器上：`~/.gemini/config/rules/dsh-collab-protocol.md`（6648 bytes）与 `~/.gemini/config/skills/dsh-collab/` 都存在。

---

## 12. 可视化设置页（票 #6）

### 12.1 承载位置：右侧看板的第二分页

**不是** DSH 的全局设置面板，而是现有任务看板抽屉里加第二个分页：

| 分页 | 内容 |
| --- | --- |
| 任务看板 | 现有的运行态视图（v1 已有） |
| **设置与运行台** | 上半是配置，下半是运行态，中间一条分隔线「以上为配置 · 以下为现状」 |

三个理由（都有证据）：

1. 四个全局挂载点（`settings.section` / `settings.plugins.tab` / `plugins.item` / `main`）的 `standardProps` 全都没有 `sessionId`（`slot-catalog.ts:2669`、`:3805`）。而协作开关是**按会话**的，放全局页就拿不到会话身份。
2. 客户端没有路由，`window.open` 一律 deny，做不了独立设置窗口。
3. 现用的左下角控制条按钮只有 26px（`plugin/dsh-agy-collab/client.js:49`），塞不进更多入口。

原型：`docs/prototypes/collab-settings.html`（46654 bytes）+ `docs/prototypes/collab-settings.md`（18144 bytes）。

### 12.2 九个配置项，分两张卡

**A 卡 · 角色绑定**（三个折叠行）：

- Planner / Executor / Reviewer 各一行，静息态一行摘要，点开才展开。
- 460px 抽屉宽度装不下三行完整绑定，折叠是必须的，不是风格选择。
- 每行底部有一块绿色「已定」说明读写边界（来自 §6.2），让人在配置页就能看到角色能干什么。

**B 卡 · 协作与工作台**：

| 配置 | 控件 |
| --- | --- |
| 协作总开关 | 开关（按会话） |
| 角色绑定模式 | 分段控件 `triple` / `dual` |
| 预估子 agent 数量 | 开关 |
| 审核档位 | 分段控件 `strict` / `loose` |
| 驳回上限 | 步进器 1–5 |
| 临时工作台根路径 | 输入框 |
| 下次启动会清扫 | 只读说明（`#4 Q4` 已定） |
| A 侧模板状态 | 三态提示位（§11.5） |
| 总线状态 | 四态（§12.4） |

### 12.3 运行台（下半）

**置顶常驻状态条**：`任务 id / 当前状态 / 驳回 N/M / 在等谁`。这条在 460px 下会隐藏任务 id，只留状态与等待方。

**C 卡 · 当前任务**：6 格对应 6 个目录，格内显示真实文件名与状态（`request.md` / `plan.md` / `tasks.md · 冻结` / `review-r1.md` / `revision-r1.md` / `final.md`），未到的那格显示「未到」。下方一个黄框说明「在等谁」。

**D 卡 · 角色最近动作**：四行（Planner / Executor / Reviewer / 人类），各显示该角色最后一次动作摘要与相对时间戳（按 Workspace mtime 判，不读文件内容）。

**E 卡 · 工作台文件**：六行表格，第四列是语义标签（不可变 / 可覆盖 / 已冻结 / 只增不改 / 在写 / 终审）。

### 12.4 总线四态

| 状态 | 显示 |
| --- | --- |
| 在线且外部角色可用 | 绿，`pid · port · 已运行时长` |
| 在线但外部监听未就绪 | 琥珀，「A 侧未挂监听」 |
| 端口被异己占用 | 红，附改端口入口 |
| 未启动 | 灰 |

**不能静默 `exit(0)`** —— 现状 `broker/broker.mjs:683-689` 在 `EADDRINUSE` 时静默退出，UI 上完全看不出来。

### 12.5 只读，不给编辑框

设置页能改**配置**（配置 `state.json`），不能改 **Workspace 文件**。

理由：越权判定靠 Workspace 全树快照 diff（§6.4）。人从 UI 写进去的内容与角色越权在快照里长得一模一样，会判废误伤。想改需求就重新提一次任务，想留档就用「导出」。

### 12.6 一处已知裂缝

配置写配置 `state.json` 是**机器级共享**（`dsh-client-ui-settings/README.md:112`），而协作开关是**会话级**的。把会话粒度开关放进会话抽屉里改，会改到别的会话。

真正的解法是让「会话粒度开关」与「机器粒度角色绑定」分两处落库 —— 这需要一张实现票，本文只记录约束：**开关读写的键必须带 sessionId，角色绑定与全局配置不带。**

---

## 13. 建议的实现顺序

依赖关系决定了顺序，不能跳：

| 步 | 做什么 | 为什么必须先做 |
| --- | --- | --- |
| 1 | 配置 `state.json` schema v2 + 迁移闸 + `broker.pid` JSON | 后面所有东西都读它，格式定不下来就没法并行 |
| 2 | Workspace 创建 / 清扫 / 目录层级 | 状态机要有地方落文件 |
| 3 | 状态机 T1–T15 + 快照 diff 越权判定 | 角色调用的前置条件 |
| 4 | 三角色进程内载体（`ctx.agents.create()` + `tools.restrict`）+ `collab_write` 落盘通道（§6.7） | 核心流程；写通道不定死，5 的校验无处落地 |
| 5 | 6 目录产物校验（front-matter / 三条硬检查 / 幻觉引用）+ Executor 的 `collab_submit_for_review` / `collab_mark_blocked`（§6.8） | 没有校验的三角色只是三个能写文件的 agent |
| 6 | broker 端口归属 + 降级 + `/health` 签名 | 进程外角色才需要，可以晚 |
| 7 | A 侧两份模板 + install manifest（含首次迁移清理，§11.3.1，同一次提交） | 与 6 同批，否则重装会回退 |
| 8 | 设置页（先配置，后运行台） | 最后，因为它只读前面的状态 |

第 1–5 步做完就是一个能跑的最小闭环，6–8 是可用的外围。

### 13.1 第 1–5 步的实现状态

第 1–5 步已实现，落在 `plugin/dsh-agy-collab/lib/v2/`，**默认启用**：插件启动即装配三角色闭环。要退回 v1 双智能体行为，把 `DSH_AGY_COLLAB_V2` 显式设成 `0` / `false` / `off` / `no`（忽略大小写与首尾空白）；此时不注册 `agy_collab_relay`、不注入 v1 三铁律提示词、不迁移配置。开关判据的全局唯一来源是 `lib/v2/index.js` 导出的 `isV2Enabled(env)`。

| 文件 | 承担 |
| --- | --- |
| `lib/v2/config.js` | 配置 schema v2 默认值、`normalizeConfig`、迁移闸 `migrateConfigIfNeeded`、`resolveBootId`、按会话的开关读写 |
| `lib/v2/workspace.js` | 6 目录创建、分级隔离路径、孤儿清扫、快照 diff、哈希核验的越权判定、`gitStatusPorcelain` |
| `lib/v2/artifacts.js` | front-matter 解析（自写 YAML 子集）、6 目录各自的字段校验、`tasks.md` 三条机器硬检查、`requirement_ref` 幻觉校验 |
| `lib/v2/state-machine.js` | 十状态 / 五阶段、T1–T15、四个计数器、`writableSlots`、`reviewSlotFor` |
| `lib/v2/roles.js` | 进程内角色载体（`ctx.agents.create` + `tools.restrict`）、角色提示词、actor sessionId 生成 |
| `lib/v2/tools.js` | `collab_write` 四条校验、Executor 三个触发点、工具定义装配 |
| `lib/v2/orchestrator.js` | 薄编排：任务开立、事件落盘、规划 / 审核 / 返工三个阶段的重试环、快照越权 |
| `lib/v2/index.js` | 装配层：开关判据 `isV2Enabled`、按会话隔离的编排器、`collab_start` 与 Executor 三件的闭环 |
| `lib/actor-sessions.js` | 插件自建实例的 sessionId 白名单，替代 `origin === 'subagent'` 判据（§6.9） |

实现期与本表原文的三处偏离，都是被实测逼出来的：

1. **配置目录多了一个 `DSH_AGY_COLLAB_DATA_DIR` 逃生口**（优先级：显式参数 > 该环境变量 > `~/.dsh/agy-collab`）。没有它，冒烟与测试会就地迁移用户真实的配置 `state.json`。
2. **任务 `state.json` 的豁免改成哈希核验**（§6.4 已同步改）。按文件名无条件豁免会让角色伪造 `done` 完全失明。
3. **`runReview` / `runDrafting` 带原地重试环**。§9.3 第 5 步的「原地重写同一文件」若只写一句提示词、不在编排层真的重试，协议违规就永远收敛不到 `escalated`。

第 4 处偏离出现在「v2 转默认」这次改动里，属于同一类被实测逼出来的问题：

4. **v1 与 broker 两处读写 `state.json` 都必须以盘上原始对象为底合并。** `lib/index.js` 的 `readLocalState` 原先只返回 `{ enabled, sessions, updatedAt }` 三个键、`writeLocalState` 直接整文件覆盖，`broker/broker.mjs` 的 `loadState` / `saveState` 是同一个写法。v2 一旦成为默认路径，用户在 UI 点一下协作开关就会把 `schema_version` / `roles` / `workspaceRoot` / `rejection_limit` 全部抹掉。现在两处都改成「读原始对象 → 合并本次改动的键 → 原子落盘」，并各有一条丢键回归测试（`test/v2/state-merge.test.mjs`、`test/broker/dispatch.test.mjs` 的 `POST /state` 用例）。顺带修掉 v1 的 `setCollabEnabled` 把 `sessions` 里所有键写成同一个值的缺陷——只写本会话自己的键。

测试：`npm test` 跑 `test/v2/*.test.mjs` 与 `test/broker/*.test.mjs`，覆盖配置迁移、Workspace 清扫、产物校验、状态机、角色隔离、编排闭环、越权三道判据（篡改 / 删除任务 `state.json`、改目标仓库）、开关默认值、`state.json` 丢键回归、broker 派发死锁回归。

### 13.2 第 6 步的实现状态

第 6 步已实现。新增一个零业务依赖的模块，把「端口归属」这件事从散在三个文件里的硬编码收成一处：

| 文件 | 承担 |
| --- | --- |
| `lib/broker-client.js` | `probeHealth`（`/health` 1000ms 探测，按 `service` 字段判 ok / foreign / offline）、`readPidRecord`（`broker.pid` 归属记录四态）、`clearPidRecord`、`isPidAlive`、`ensureBroker`（四步判定 + spawn 后轮询确认）、`foreignPortMessage` |

`broker/broker.mjs` 侧：`/health` 响应带 `service` / `schemaVersion` / `bootId` / `startedAt` / `uptimeMs` / `idleExitMs`；`broker.pid` 写 JSON 五字段归属记录（`service` / `schemaVersion` / `pid` / `port` / `startedAt` / `bootId`）；`EADDRINUSE` 先探占用者再分流（自家 → exit 0 静默复用；异己 → exit 2 + 可诊断文案；其他错误 → exit 1），不再一律 `exit(0)`；空闲 30 分钟自退（`DSH_AGY_IDLE_EXIT_MS` 可覆盖）；`shutdown` 只删自己那份 pid 记录。

六处端口硬编码全部改掉（§10.6）：`broker/broker.mjs`、`lib/index.js`、`broker/reply-request.mjs`、`broker/wait-next-request.mjs` 读 `DSH_AGY_COLLAB_PORT` > 配置 `brokerPort` > 18765；`client.js` 两处改为从 `/api/agy-collab/state` 响应的 `brokerPort` 取。

实现期偏离三处：

1. **`bootId` 在 broker 侧本地重写了一份。** broker 被 `scripts/install.mjs` 单独复制到 `~/.dsh/agy-collab/`，不能 import 插件模块，所以 `resolveBootId()` 在 `broker/broker.mjs` 里复制了 `lib/v2/config.js` 的同算法实现（sha256(开机分钟) 前 6 位）。两处必须同步改，否则 Host 与 broker 对「同一次开机」的判断会分叉。
2. **`ensureBrokerProcess` 失败后带 15s 冷却。** `/state` 是看板每次刷新都会打的接口，总线不可用时如果每次刷新都真去 spawn 一遍，会变成每几秒起一个必然失败的子进程。冷却期内的调用直接返回上次的失败结论。
3. **看板副标题从单态改成四态**（在线 / 异己占用 / 离线 / 未知）。§12.4 要求总线四态在 UI 上可分辨，原来的硬编码文案只有「在线」一种。

测试：`test/broker/ownership.test.mjs` 15 个用例，覆盖 `readPidRecord` 四态、`isPidAlive` 边界、`ensureBroker` 五分支（全注入假件，不真起进程）、以及三次真起 broker 的端到端（`/health` 签名与 `broker.pid` 五字段一致、异己占用 exit 2 + stderr 文案 + 不写归属记录、同端口第二实例 exit 0 且不删第一实例的归属记录）。

### 13.3 第 7 步的实现状态

第 7 步已实现。它同时覆盖两件事：**A 侧模板换词表**，和**安装变成声明式**。两者必须同一次提交（§11.6）—— 否则用户跑一次 `npm run install:bridge` 就把旧协议写回去。

**A 侧模板（§11.1 / §11.2）**

| 文件 | 承担 |
| --- | --- |
| `antigravity/rules/dsh-collab/planner.md` | 规划者契约：读 01 / 03 / 04 / 05，写 02 `plan.md`、03 `tasks.md`、05 `revision-r<N>.md`；03 三条硬检查；无仓库写通道 |
| `antigravity/rules/dsh-collab/reviewer.md` | 审核者契约：先读 03 需求锚，再读仓库客观产物；**明令不读 02**、不看执行者自述；写 04 `review-r<N>.md` 或 06 `final.md` |

v1 的 `antigravity/rules/dsh-collab-protocol.md` 与 `antigravity/skills/dsh-collab/SKILL.md` 已从仓库删除（`git rm`）—— 它们是旧词表的载体，留着就有第二条被安装的路径。两份新模板的 front-matter 带 `role` 与 `template_version: 2.0.0`，正文里 `~/.dsh/agy-collab` 是占位符，由 `install.mjs` 按实际 `DSH_HOME` 替换。

**声明式同步（§11.3 / §11.3.1 / §11.4 / §11.5）**

| 文件 | 承担 |
| --- | --- |
| `scripts/template-sync.mjs` | `planTemplateSync`（算但不落盘）/ `applyTemplateSync`（落盘）/ `inspectTemplates`（三态）/ `readManifest`（四态）/ `sha256Of` / `templateVersionOf` |
| `scripts/install.mjs` | 第 3 步改为调 `planTemplateSync` + `applyTemplateSync`，并在装完自检 `inspectTemplates`，非 `installed` 则以非零退出码报出 |

manifest 落 `~/.gemini/config/.dsh-collab-manifest.json`，`{ schemaVersion: 1, files: [{ path, sha256 }] }`。`readManifest` 的四个返回值直接对应四种处置：`absent` / `unrecognized` → 首次迁移（清 `LEGACY_V1_PATHS`，且不写进 manifest）；`current` → 按三条规则正常同步。删除 v1 skill 后若 `skills/dsh-collab/` 变空则一并 `rmdir`，非空则留着（不清别人的文件）。

**语义层迁移（§9.1 / §9.3）**

| 位置 | 改动 |
| --- | --- |
| `broker/broker.mjs` `/relay` | 路由依据改为 `role: planner\|reviewer`；`phase` 降级为别名（`plan`→planner、`consult`→planner、`review`→reviewer）；新增 `round` / `stage` / `cold` / `roleBinding` / `estimateSubagents` 与 `legacyPhase` 标记 |
| `broker/broker.mjs` `/reply` | 不再按 phase 编造 verdict（旧词表全删）；`content` 可选；新增 `handledIn` 透传 |
| `broker/wait-next-request.mjs` | 输出 `Role` / `Round` / `Stage` / `Cold` / `Role Binding` / `Estimate`，并按 role 打印该载哪份模板；回传命令不再带 `--verdict`，cold 时自动带 `--handled-in subagent` |
| `broker/reply-request.mjs` | 新增 `--handled-in main\|subagent`（校验取值）；`--content` / `--file` 变可选；`--id` 变必填（不再靠 broker 猜最旧请求） |
| `lib/v2/roles.js` `externalWakePayload` | 字段名对齐 broker 读法：`workspace` / `taskId` / `role` / `round` / `stage` / `cold` / `roleBinding` / `estimateSubagents` / `task` / `sessionId`；原来的 `workspace_dir` / `task_id` 是死字段（broker 不认，且不会报错，属静默失效） |

测试：`test/broker/template-sync.test.mjs` 28 个用例（manifest 四态、首次迁移清理与「不写进 manifest」、三条规则、dry-run 不改盘、路径替换、三态判定含 `outdated` 与 `drifted` 的区分、两份源模板自身的契约）；`test/broker/role-protocol.test.mjs` 10 个用例（role 路由、旧 phase 回落、consult 已删、非法 role 回落、`/reply` 不编 verdict、`handledIn` 透传、A 侧 CLI 输出无旧词表）；`test/v2/roles-tools.test.mjs` 新增 2 个用例钉住唤醒载荷的字段名。

实现期偏离一处：**`install.mjs` 增加了装后自检与非零退出码**。§11.6 只要求「三者同一次提交」，但实测「装了一半」在终端里看不出来（每个文件都打印了 wrote），所以补一个 `inspectTemplates` 回读，状态不对就报错退出。

---

## 14. 三条贯穿全篇的硬前提

1. **任务 `state.json` 必须先于角色调用落地。** 任何角色被调用时，任务 `state.json` 里的 `round` / `rejection_count` 必须已经是本轮的值。先调角色再写状态，会让角色读到上一轮的轮次。

2. **UI 从任务 `state.json` 读 `round` 与 `rejection_count`，不推文件数。** 数 `04/` 里有几个文件来推轮次是错的 —— 首发通过时 `04/` 只有 1 个文件但 `round` 是 1，返工两轮后 `04/` 有 2 个文件但 `round` 是 3。文件数是副产品，不是游标。

3. **驳回上限只在 `drafting` 阶段可改。** 任务跑到 `revising` 时改上限，会让「还能驳几次」在同一个任务里前后不一致。

---

## 15. 明确不做的事

| 不做 | 理由 |
| --- | --- |
| 用 `agentPreset` 实现角色隔离 | 要重载 profile 与设置页立即生效冲突；presets are not security sandboxes |
| 静默回落到进程内角色 | 会悄悄改变审核严格度 |
| 六目录里放「执行记录」 | 会变成 Executor 的自我辩护，污染 Reviewer 输入 |
| 设置页给文件编辑框 | 与快照 diff 越权判定冲突 |
| Workspace 崩溃快照 / 续跑 | 一次性草稿纸语义，续跑会让「这一轮的输入」变得不可知 |
| 把 `records.json` 继续当真相 | 双写期会与「看板读 Workspace」冲突 |
| 灰度「旧协议模式」开关 | 判断依据是回滚成本；v1 通道靠 git 回退即可，多一个模式等于多一条要维护的路径 |

---

## 16. 证据行号索引

写实现时按这张表去代码里定位，不要凭记忆。

### `broker/broker.mjs`

- `:11` `PORT = Number(process.env.DSH_AGY_COLLAB_PORT || 18765)`
- `:17` `PID_FILE = path.join(DATA_DIR, 'broker.pid')`
- `:18-20` `MAX_RECORDS = 3` / `MAX_HISTORY_LINES = 6` / `MAX_DOC_FILES = 3`
- `:81` `pruneHistoryFile`；`:100` `pruneOldTaskDocs`；`:130` `appendHistory`
- `:178` `requests = new Map()`（纯内存）；`:180` `pruneRequestsMap`
- `:230` `serializeRequestForA` 已带 `sessionId`
- `:331` `/health` 与 `/status` 同一分支
- `:415` `/records/clear` POST
- `:442` phase 只认三值；`:447` timeoutMs 夹 10s–600s
- `:619` `content = body.content || body.reply`
- `:683-689` `server.on('error')`：`EADDRINUSE → process.exit(0)`，其余 `exit(1)`
- `:693` 写 `PID_FILE`

### `plugin/dsh-agy-collab/lib/index.js`

- `:27` `BROKER_PORT`
- `:29` `STATE_FILE`
- `:83-89` `isCollabEnabled`
- `:91-104` `setCollabEnabled` —— **缺陷**：`:98-100` 把 `enabled` 写进所有 session
- `:106-132` `ensureBrokerProcess` —— **缺陷**：spawn 后无条件 `resolve(true)`
- `:116` `detached: true`；`:120` `child.unref()`
- `:215-236` `buildCollabPrompt`（三段铁律，v2 要换成三角色契约）
- `:244-246` 子代理判据写法（`origin === 'subagent'` 问题）
- `:387` `apply` 首行 `ensureBrokerProcess().catch(()=>{})`
- `:449` phase 归一化
- `:482-487` verdict 缺省映射；`:513` `approved = verdict === 'APPROVED'`
- `:539-540` `ctx.effect(() => () => {...})` —— 只析构 tools 与路由，**不参与进程退出**，v2 的删除钩子要另挂

### `plugin/dsh-agy-collab/client.js`

- `:29` `DIRECT_STATE_API = 'http://127.0.0.1:18765/state'`
- `:30` `DIRECT_CLEAR_API = 'http://127.0.0.1:18765/records/clear'`
- `:49` 控制条按钮 26px
- `:668 / 736 / 743 / 752 / 758 / 768 / 804 / 816` 八处读 `/records`
- `:941-1049` / `:1286-1289` 六步流程图
- `:1033-1034` `verdict === 'APPROVED'` 分支
- `:1344` 文案里写死 18765
- `:1522-1540` 旧词表文案映射；`:1610` `CHANGES_REQUESTED` class 切换

### 其他

- `scripts/install.mjs:34-50` 分发 A 侧模板（只覆盖写、无删除分支）
- `scripts/sync-plugin.mjs` 把插件复制进三个 profile 的 `node_modules/dsh-agy-collab`
- `broker/reply-request.mjs:9`、`broker/wait-next-request.mjs:16` 各有一份端口常量
- `docs/research/dsh-host-capabilities.md:297-298` presets are not security sandboxes；宿主对外部通道无约束力
- `dsh-tools/src/index.ts:164` `tools.restrict` 契约
- `dsh-subagent/src/child-agent.ts:152` `session.header.origin === 'subagent'`
---

## 17. 文档关系

| 文档 | 作用 |
| --- | --- |
| 本文 | 八票决议的汇总，实现的唯一依据 |
| `docs/research/dsh-host-capabilities.md` | 宿主能力的原始勘察，约束 19 条与未确认项 U1–U5 |
| `plugin/dsh-agy-collab/docs/adr/0001-role-isolation-by-permission-tier.md` | 角色隔离为什么选权限档 + `tools.restrict` |
| `docs/prototypes/collab-settings.html` | 设置页的可交互原型（可直接在浏览器打开） |
| `docs/prototypes/collab-settings.md` | 原型逐块对照表与视觉令牌出处 |
| `plugin/dsh-agy-collab/GLOSSARY.md` | 术语表 |

单票的完整推理过程在 GitHub issue 的 resolution 评论里（#2–#9），本文只留结论。需要「为什么」时去看票。
