# 0001 — 角色隔离靠权限档与物理工具裁剪，不靠提示词

## 状态

已接受（2026-11-23，出自《界定规划 / 执行 / 审核三角色的权限契约与额外 Agent 接入边界》）

## 背景

插件的三个角色（Planner / Executor / Reviewer）在同一份代码里没有任何能力差异：`agy_collab_relay` 是一个工具，`phase` 只是它的参数；broker 的 `/listen` 长轮询没有角色过滤；`registerPromptSection` 里唯一的区分是 `origin === 'subagent'`。也就是说，当时"审核者不能动手"完全靠提示词文字。

一道题：提示词自律、工具白名单、协议层无写通道——三者可信度差一个数量级。

## 决定

1. **角色 = 权限档 × 载体的绑定**，不是名字。三个 actor 槽位，每槽绑定进程内或进程外适配器。Executor 槽位永远不允许绑只读档。
2. 强制顺序：**协议层无写通道为地基**，进程内辅以**物理工具裁剪**，提示词只作说明。
   - Reviewer 的契约里不包含"写 Workspace / 写仓库"这个动作，它只读并回结论；
   - 进程内承载时用 `ctx.agents.create()` 自建 Agent，在 `setup` 里 `agentCtx.tools.restrict({ allow })` 把写类工具物理删掉（契约 `dsh-tools/src/index.ts:164`）。
3. **越权判定由状态机做，不由 Reviewer 自报**：产物里出现对 Workspace 或仓库的写 → 整轮作废、不采纳、原样留档。
4. **不选 `agentPreset` 路线**：它要求改 profile 的 `cordis.patch.yml` 并重载，与"可视化设置页改完立即生效"冲突；而且官方明确 presets are not security sandboxes（`docs/research/dsh-host-capabilities.md:297`）。
5. **外部角色与进程内角色信任等级不等同**，且这一点要写进设置页可见文案。宿主对外部通道没有约束力（`docs/research/dsh-host-capabilities.md:298`），只能承诺"越权会被作废"，不能承诺"做不到越权"。

## 后果

- **必须处理 `origin` 判据**：插件自建的 Agent 没有 `origin === 'subagent'` 标记（`dsh-subagent/src/child-agent.ts:152`），会被当作普通用户会话注入协作提示词。判据改成插件自持的 actor sessionId 白名单，不再加特例分支。
- Reviewer 无法"顺手帮改一下"。这是设计意图：能改的审核者就不是审核者。
- 外部适配器接入时，安全性由状态机兜底，不由通道兜底。这决定了 broker 必须新增按角色订阅过滤，否则 Reviewer 会收到 Executor 的消息。
- 因为 Executor 固定绑当前会话，用户始终能看见"谁在改我的文件"。

## 备选与否决理由

- **仅用提示词**：否决。换个说法就能绕过，等于没有强制。
- **用 preset 做隔离**：否决。配置在插件外、需重载才生效；且 preset 执行 Host 代码，不是沙箱。
- **让 Reviewer 也拿写权限、靠事后审计**：否决。事后审计只记录损害，不阻止损害。
