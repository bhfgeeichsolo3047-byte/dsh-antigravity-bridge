# 勘察：DSH 宿主能力（设置页挂载点 / 退出清理钩子 / 多 Agent 路由）

> 为什么放这里：仓库 `docs/` 下当前只有 `docs/agents/{domain,issue-tracker,triage-labels}.md` 三份协作规范，没有任何勘察类笔记目录；因此新建 `docs/research/` 作为「一次性只读勘察」的落点，与 `docs/agents/` 的长期规范分开，避免规范文件被调研内容淹没。
>
> 用途：本笔记是 issue #2 的交付物，给 issue #6（临时工作台）与后续设计票提供事实基础。**不含设计决定**，只列事实、证据与由此产生的硬约束。
>
> 勘察方式：只读。DSH 实现树取自本机 Electron 解包 asar（`G:/鱼塘/resources/app.asar` 内 `dsh/node_modules/@deepseek-ai/*`，338 个包，多数带 `src/*.ts`），桌面外壳取自散装目录 `G:/鱼塘/resources/app/`；本仓库代码为工作区原件。未修改任何源码。

## 结论速览

| 问题 | 一句话结论 |
| --- | --- |
| 设置页能挂在哪 | **四处可用**：① `settings.section`（设置面板内一页，官方一等公民）；② `settings.plugins.tab`（设置 → Plugins 里的一个 tab）；③ `plugins.item`（插件页里的官方插件卡片）；④ `main` + `sidebar.panellist`（独立整页）。另有会话内的 `sidebar.right.pane.tab`（右侧栏 tab）与现在用的 `shell.overlay` 浮层。**全部是「会话内 / 应用内渲染」，没有任何独立 OS 窗口**；也没有 URL 路由能直接打开某页。 |
| 退出清理钩子 | `ctx.effect` 是纯 cordis 进程内语义，**只对「优雅卸载」可靠**（桌面正常关窗 / CLI 的 SIGINT、SIGTERM / profile dispose），窗口 **5 秒**；崩溃、SIGKILL、断电、Windows 关机**一律不执行**。「删除」最多承诺到：正常退出删干净 → 崩溃留残骸 → **下次启动按 pid + mtime 清扫**（第二道闸必须自带）。 |
| 多 Agent 接入 | 现成的子代理体系（`ctx.subagents` + spawn/fork provider）已在本机 profile 挂好，**插件内也能用 `ctx.agents.create()` 起一个完全私有 Agent**。「不带上下文」「只读工具集」「指定模型」三项，**只有 `ctx.agents.create()` 一条路三项全满足**；`subagents` 路径的工具集限制只能靠 preset；外部 CLI/ACP 路径三项里「指定模型」明确不行。 |

---

## 1. 可视化设置页能挂在哪

### 1.1 现状：插件现在挂的是浮层，不是设置页

`plugin/dsh-agy-collab/client.js` 目前只有两个槽位注册：

- `client.js:1671` `slots.inject('conversation.input.right', () => slots.register({ name: 'conversation.input.right', id: 'dsh-agy-collab-anchor-probe', order: 25, inject: (sessionId) => ({ sessionId }) }, ComposerAnchorProbe))` —— 输入框右侧的探测器（`conversation.input.right` 是 `scope: 'session'` 的列表槽，见 `@deepseek-ai/dsh-client-ui-conversation/src/client/contract/slots.ts:327`）。
- `client.js:1686` `slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'dsh-agy-collab-overlay', order: 75, label: 'A↔D 协作面板' }, CollabOverlayRoot))` —— 全框浮层。

`shell.overlay` 在权威槽位目录里的描述是「Frame-wide floating layer, above every column and outside their scroll containers」+「This is the additive seat for a frame-wide surface of your own」（`@deepseek-ai/dsh-cordis-client-runner/src/client/slot-catalog.ts:4011`）。**这是官方认可的自有浮层座位，但它没有设置页语义**：不进设置面板、不参与设置导航、没有持久化的「用户设置」约定。

### 1.2 官方设置页注册点（契约原文）

契约文件：`@deepseek-ai/dsh-client-ui-settings/src/client/contract/slots.ts`

| 槽位 | 行 | kind / scope | owner props |
| --- | --- | --- | --- |
| `settings.section` | `:59` | list / root | `SettingsSectionOwnerProps { close: () => void }`（`:136`） |
| `settings.section.icon` | `:67` | list / root / inline | `SettingsSectionIconOwnerProps { size, active }` |
| `settings.plugins.tab` | `:76` | list / root | `SettingsPluginsTabOwnerProps { children?: never }` |
| `settings.general.item` | `:102` | list / root | `SettingsGeneralItemOwnerProps` |
| `settings.launcher` | `:19` | single / root | `SettingsLauncherOwnerProps`（`:162`，含 `wide` / `settingsOpen` / `openSettings(sectionId?)` / `openOnboarding(id)`） |
| `settings.header` / `settings.action` / `settings.close` | `:35` / `:41` / `:47` | single / list / single | 设置面板的头部、动作区、关闭按钮 |
| `settings.onboarding` | `:87` | list / root | `SettingsOnboardingOwnerProps`（`stepId` / `explicit?` / `complete` / `openSection`） |

`settings.section` 的权威说明（`slot-catalog.ts:3805`）原文：「One settings page per list entry. Registrant options carry the nav identity: `id` (section key, drives `only` filtering), `order` (nav position), `label` …Sections render inside the panel content column.」，`declaredBy` 是「an entry in `sidebar.settings` (client-ui-settings-general), so it exists while that entry is mounted」。

设置页 README（`dsh-client-ui-settings/README.md:46`）原文：「A settings surface registers into the slot types this package declares. The shell (`sidebar.settings` occupant, navigation, chrome) lives in ui-settings-general; feature pages register `settings.section` contributions; the Plugins section hosts `settings.plugins.tab` pages; onboarding steps register `settings.onboarding`.」

**能拿到什么（每个挂载点）**

| 挂载点 | 路由 | 会话上下文 | 持久化 |
| --- | --- | --- | --- |
| `settings.section` | 无 URL；靠 `id` 做 `only` 过滤与导航记忆 | **无 sessionId**（standardProps 只有 `useRemoteAccess / useResource / useWorkspaces / usePanelInfo / useSessions / useSessionStatus / useSessionAccess / useWorkspaceAccess`，见 `slot-catalog.ts:3805`） | 官方两选一：`configForms`（须把 Config 字段标 `.volatile()`），或自带 Host 路由 + 自己落盘 |
| `settings.plugins.tab` | 同上，tab 内 | 无 sessionId | 同上 |
| `plugins.item` | 无 | 无 sessionId（ownerProps 只有 `view: 'summary' \| 'page'` 与可选 `form`） | 同上 |
| `main`（keyed）+ `sidebar.panellist` | 无 URL；`ctx.layout.selectPanel(id)` 切换 | **无**（`slot-catalog.ts:2669`：「The reserved `conversation` key hosts the Conversation; other keys receive no Session binding.」） | 自理 |
| `sidebar.right.pane.tab` | 无 URL；`openTab(kind, options?)` 打开 | **有**（scope `session`，`dsh-client-ui-sidebar-right/src/client/contract/slots.ts:61`） | 自理 |

### 1.3 真实范例（可直接抄）

**① 官方 `settings.section` 注册，5 处：**

- `dsh-client-ui-settings-general/src/client/index.ts:268` —— `ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'general', order: 0, label: () => t('general.nav'), locale: NS, children: { 'settings.general.item': { kind: 'list', scope: 'root' } } }, GeneralSection))`（同文件 `:255` header、`:259` action、`:265` close、`:273` `shell.overlay`）
- `dsh-client-ui-settings-models/src/client/index.ts:138`
- `dsh-client-ui-settings-account/src/client/index.ts:320`（外层用 `ctx.remoteAccess.whenAccess('account/watch', ...)` 包住 —— 需要 Host 侧鉴权能力时抄这个）
- `dsh-client-ui-agent-preset/src/client/index.ts:284`
- `dsh-client-ui-settings-plugins/src/client/index.ts:78`

**② 第三方插件真实写法（最贴近本仓库处境，不依赖 `configForms`）：**

- `dsh-see-now/client.js:885`：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'see-now', order: 43, label: () => t('nav'), locale: NS }, () => h(SettingsPage)))` —— 直接在 `apply` 里注册，页面自己管状态。
- 数据面走自己的同源路由：`dsh-see-now/client.js:39` `const API = '/api/see-now';`，Host 侧 `src/index.js:557` `ctx.inject(['webServer'], (scoped) => { scoped.effect(() => scoped.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }), '...') })`，并在 `:542-544` 注释「webServer **刻意不写进 inject**：它是可选能力，写进去会让没有它的部署连插件都起不来」。
- 同源校验自己实现：`src/settings-trust.js:63` `function structuralReason(req)`（host 必须 loopback、`sec-fetch-site === 'cross-site'` 拒、Origin/Referer 必须同源）。
- 其他第三方：`dsh-remote/lib/client.js:7677-7678`（`settings.section`）+ `:7680-7682`（同 id 的 `settings.section.icon`）；`dsh-windows-mcp/lib/client.js:36` 常量、`:1966` `registerSettingsSection(ctx)`。

**③ `settings.plugins.tab` 的非配置型范例（「插件自带设置 tab」的最短模板）：**

- `@deepseek-ai/dsh-client-ui-settings-plugin-inventory/src/client/index.ts`：`export const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory', 'modules']`；`ctx.effect(() => ctx.locale.register(NS, { ... }), '...dictionaries')`；末尾 `ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ name: 'settings.plugins.tab', id: 'all', order: 10, label: () => t('tab'), locale: NS, inject: injected }, PluginInventorySettingsTab))`（`:58`）。
- 渲染侧：`dsh-client-ui-settings-plugins/src/client/index.ts:48` `getVersion`、`:53` `entries`、`:65` `subscribe`、`:85` `children` 声明；`PluginsSettingsSection.tsx:60` `renderSlot('settings.plugins.tab', {}, { only: single.id })`。
- README（`dsh-client-ui-settings-plugins/README.md:31`）原文：「To contribute a tab, register into `settings.plugins.tab` with an `id`, an `order`, and a localized `label`; the section renders the entries in order and mounts a tab on its first selection.」；`:41`「a lone contribution renders as the page itself」。

**④ 独立整页（无会话绑定的全局页）：**

- `dsh-client-ui-plugin-manager/src/client/index.ts:85` `export const PANEL_ID = 'plugins' as MainPanelId`；`:131` `yield ctx.slots.inject('main', function* () { ... })`（`:136` `key: PANEL_ID`）；`:169` `yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 0, label: () => t('panel'), locale: NS }, PluginsPanelIcon))`；切换面板 `ctx.layout.selectPanel(PANEL_ID)`，panellist 点击链见 `dsh-client-ui-sidebar/src/client/SidebarRoot.tsx:90` → `dsh-client-ui-sidebar/src/client/index.ts:84`。
- README（`dsh-client-ui-plugin-manager/README.md:138`）原文：「The browser plugin registers the `plugins` sidebar entry and its `main` panel through `ctx.slots.inject()`, so both follow late slot declaration, locale changes and teardown. **The page is global and belongs to no Session.**」

**⑤ 右侧栏 tab（有会话上下文）：**

- 契约 `dsh-client-ui-sidebar-right/src/client/contract/slots.ts:45` `rightbar.session`、`:61` `sidebar.right.pane.tab`（keyed、scope session、`TabHookContext`）、`:130` `export type SidebarRightDestination = 'sidebar' | 'float'`。
- 范例 `dsh-client-ui-plan/src/client/index.ts:111`（tab）与 `:115`（同 key 的 `.title`）；另有 `dsh-client-ui-sidebar-files/src/client/index.ts:176`、`dsh-client-ui-subagent/src/client/sidebar-chat/index.tsx:193`。
- 打开入口只有 `openResource(address, options?)` / `openTab(kind, options?)`（`dsh-client-ui-sidebar-right/README.md:96`），二者都接受 `destination: 'sidebar' | 'float'`（`:102`）。**float 是页内浮动面板（不挤占栏宽），不是独立 OS 窗口。**

### 1.4 局限：能不能独立开窗 / 能不能用 URL 直达

**都不能，已逐条核实：**

- 客户端包内**没有** hash / history / pushState / popstate 路由：在 `dsh-client` 与全部 `dsh-client-ui-*` 包内 grep `location.hash|pushState|history.replaceState` 与 `hashchange|popstate` → **0 命中**；`window.location` 仅 2 处取 `origin`（`dsh-client-ui-settings-account/src/client/index.ts:236`、`dsh-client-ui-sidebar-browser/src/client/view/BrowserBody.tsx:66`）。⇒ 没有「一个 URL 直接打开某个插件页面」这回事，所有挂载点都靠 `ctx.slots` 在既有壳里渲染。
- 客户端 `window.open` 只有 5 处，**全是跳外部 http(s) URL**（`dsh-client-ui-chat/src/client/apply.ts:288`、`dsh-client-ui-open-in-app/src/client/context-menus.tsx:197`、`dsh-client-ui-settings-account/src/client/browser-login.ts:35`（about:blank 弹窗做登录）、`dsh-client-ui-settings-account/src/client/index.ts:198`、`dsh-client-ui-sidebar-browser/src/client/view/BrowserBody.tsx:102`）。⇒ 不可能用 `window.open` 开第二个应用窗口装插件页。
- 桌面端把新窗口**硬关掉**：`G:/鱼塘/resources/app/lib/main.js:20323` —— `window.webContents.setWindowOpenHandler(({ url }) => { if (["http:", "https:"].includes(new URL(url).protocol)) shell.openExternal(url); return { action: "deny" }; })`；其余窗口一律 `setWindowOpenHandler(() => ({ action: "deny" }))`（`:16178`、`:17446`、`:17805`、`:18102`、`:19899`）。⇒ 唯一「独立窗口」出路是用系统浏览器打开一个 http(s) URL。
- 桌面端页面 origin 是 `dsh-app://app` 而不是 `http://127.0.0.1`（`main.js:1478` `const SCHEME = "dsh-app";`、`:20231` `protocol.registerSchemesAsPrivileged`）。第三方插件 dsh-see-now 已实测这条转发链：`src/settings-trust.js:40` `function isDesktopRelay(value)` 判定 `url.protocol === 'dsh-app:' && url.hostname === 'app' && url.port === ''`，注释「桌面版把页面从 `dsh-app://app` 转发到 loopback 时会留下这个 Referer」。⇒ 插件路由在桌面端**能**被 IPC 中转打到，但「开独立浏览器窗」时 origin / 同源判定会变，鉴权逻辑要按这条实测重写（dsh-see-now 的 `structuralReason` 就是范本）。

### 1.5 结论

**能挂在哪几处：** 设置面板（`settings.section` / `settings.plugins.tab` / `settings.general.item`）、插件页（`plugins.item`）、独立整页（`main` + `sidebar.panellist`）、右侧栏 tab（`sidebar.right.pane.tab`，可 float）、以及现在用的全框浮层（`shell.overlay`）。

**哪里拿不到会话：** 除 `sidebar.right.pane.tab` / `conversation.input.right` / `rightbar.session` 这类 `scope: 'session'` 槽位外，**设置面板与全局页一律没有 sessionId**。现有插件是靠 `client.js` 里的 anchor-probe 把 sessionId 从输入框槽位捞出来再共享给浮层的 —— 这条路在正式设置页里不通用（设置页是 root 作用域，与具体会话无关）。

**能不能独立开窗：** 不能。只有「系统浏览器打开一个 http(s) URL」这一种窗，且桌面端 origin 是 `dsh-app://app`、需按 dsh-see-now 的 IPC 中转判据做鉴权。

**设置状态怎么存（两条官方路，都已核实）：**

1. 走 `configForms`：`dsh-settings/README.md:13` 原文「Edit fields that plugins declare with `.volatile()` and inspect their effective values. Forms identify each plugin by its profile entry id, preserve secret values, and refuse stale writes. Changes persist through the active profile's Cordis patch.」；`dsh-settings/src/index.ts:303` `describe()` 只收 `fiber.state === ACTIVE` 且 `volatileForm(schema)` 非空的条目（schema 过滤器见 `dsh-settings/src/schema.ts:39`）。**想把字段放进设置表单，Config 必须标 `.volatile()`。**
2. 自带页面：`dsh-settings/README.md:40` 原文「A plugin that ships its own page registers `configure({ auto: false }, ctx.fiber)` as an effect inside an optional `ctx.inject(['settings'], ...)` child from `apply`」，实现 `dsh-settings/src/index.ts:267`。之后配置读写自己负责（dsh-see-now 就是写 `~/.dsh/watch-window.json`）。

注意 `dsh-client-ui-settings/README.md:112` 的限制：「**Host preferences are shared across authenticated entries** — browsers accessing the same settings document share its persisted preferences, rather than retaining per-browser choices.」⇒ 设置项是「这台机器一份」，不是「每个浏览器/每个会话一份」。

---

## 2. Host 进程启停生命周期钩子

### 2.1 插件侧现在有什么

`plugin/dsh-agy-collab/lib/index.js` 全文检索：**没有任何** `process.on('exit' | 'SIGINT' | 'SIGTERM' | 'beforeExit' | 'uncaughtException')`，也没有 `atexit` 之类。清理只有一处：

- `lib/index.js:539-545`：`if (typeof ctx.effect === 'function') { ctx.effect(() => () => { for (const d of disposers.splice(0).reverse()) { try { d?.(); } catch {} } }, 'dsh-agy-collab: cleanup') }`
- `lib/index.js:553-557`：`apply` 末尾再 return 一份同样的清理闭包。

而 broker 是**故意脱离父进程**的：`ensureBrokerProcess()`（`:106-132`）内 `spawn(process.execPath, [BROKER_SCRIPT], { detached: true, stdio: 'ignore', windowsHide: true })` + `child.unref()`。所以**即使插件 disposer 正常执行，broker 进程也不会被带走** —— 它现在就是「插件退出后继续活着」的。

### 2.2 cordis 的 effect / dispose 到底是什么语义

`@deepseek-ai/cordis/src/fiber.ts`：

- `:73` 注释：「Disposers run in reverse registration order when the owning fiber unloads; they may be async, in which case unloading awaits them.」
- `:423` / `:425` 两个重载，`:426` 实现 `effect(execute: () => Effect, label = 'anonymous'): any`。
- effect 的 JSDoc：「`execute` runs immediately; the disposers it produces are collected and run (in reverse order) either when the returned disposer is called or when the fiber unloads, whichever comes first. Calling the disposer twice is a no-op. Throws `CordisError('INACTIVE_EFFECT')` if the fiber is already disposed」。
- fiber 卸载时逐个 runDisposable，**单个 disposer 抛错只 `ctx.logger.error`，不中断其它**。

**关键判断：`ctx.effect` 是纯进程内框架语义，不挂任何 OS 进程事件。** cordis README 原文：「Effects, event listeners, and services are removed when their owning fiber is disposed.」进程被 SIGKILL / 断电 / 宿主崩溃时，disposer 一律不执行。

### 2.3 宿主给插件留的执行窗口

DSH 宿主（不是插件）确实装了信号处理：

- `@deepseek-ai/dsh/src/profile-boot.ts:284` `export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }>`
- `:298` `const dispose = (): Promise<void> => disposal ??= (async () => { ... })` —— 内部遍历 `[() => app.current?.fiber.dispose(), disposeProxy]`，逐个 try/catch，多个失败聚合成 `'dsh: profile cleanup failed'`。
- `:311` `const shutdown = createProcessShutdown(dispose)`
- `:322` `process.on('SIGTERM', () => { interrupt(0) })`
- `:323` `process.on('SIGINT', () => { interrupt(130) })`
- `@deepseek-ai/dsh/src/process-shutdown.ts:6` `export const PROCESS_SHUTDOWN_TIMEOUT_MS = 5_000`；`:54` `const start = (code, forceAfterDispose)`；`:56` `timeout = setTimeout(() => { forceExitOnce(code) }, timeoutMs)`；`:71` `interrupt(code)` —— 已有 pending 时**立即硬退**（连按两次 Ctrl+C 等于强杀）。

桌面端（Electron）正常关窗也走这条路：

- `G:/鱼塘/resources/app/lib/main.js:21687` `app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); })`
- `:21723` `app.on("before-quit", (event) => { ...})`：`:21740` `event.preventDefault();`、`:21744` `quitConfirmation.confirm()`。
- `:21692` `const finishQuit = () =>`：置 `quitting` / `shuttingDown` → dispose 各 UI → `Promise.all([stopOperationReports(), ...backend.close()..., platformView.dispose(), disposeFileDrag()])` → `app.quit()`。
- `:20562` `const backend = new DesktopBackendController((onFailure) =>`，其 `backend.close()` 即让 Host 子进程优雅 dispose。
- 清理预算同样秒级：`waitForOperationReports()` 内 `setTimeout(() => { resolve(false); }, 500)`，超时只 `console.error('... continuing shutdown')`。
- `:21690` 区域 `if (process.platform !== "win32") powerMonitor.on("shutdown", () => { sessionEnding = true; })` —— **Windows 关机 / 重启不走这条优雅路**。

崩溃路径：

- `@deepseek-ai/dsh-app-boot/src/index.ts:809` `FailLoudEvent = 'unhandledRejection' | 'uncaughtException'`；`:901` `export function installFailLoud(`；`:948` `proc.on('uncaughtException', onException)`；`:859` `FAIL_LOUD_RELEASE_TIMEOUT_MS = 2_000`。行为：打印 fatal → `proc.exit(1)`。**不顺带做全量 fiber 优雅 dispose**（只在调用方给了 release 钩子时尽力等 2 秒）。

### 2.4 Node 官方口径（哪些事件在什么情况下不触发）

来源：https://raw.githubusercontent.com/nodejs/node/main/doc/api/process.md

- `'exit'`：「emitted when the Node.js process is about to exit as a result of either: The `process.exit()` method being called explicitly; The Node.js event loop no longer having any additional work to perform」；「Listener functions **must** only perform **synchronous** operations」。
- `'beforeExit'`：「**not** emitted for conditions causing explicit termination, such as calling `process.exit()` or uncaught exceptions」。
- 信号事件：「`'SIGKILL'` cannot have a listener installed, it will unconditionally terminate Node.js on all platforms」；「`'SIGSTOP'` cannot have a listener installed」；「`'SIGTERM'` is not supported on Windows, it can be listened on」；「`'SIGINT'` from the terminal is supported on all platforms」；「`'SIGHUP'` ... Node.js will be unconditionally terminated by Windows about 10 seconds later」。
- `'uncaughtException'`：默认打印栈并以 code 1 退出；恢复运行是「不安全」的。

### 2.5 结论：可靠 / 不可靠，与「删除」能承诺到哪一步

| 场景 | disposer 执行？ | 依据 |
| --- | --- | --- |
| 桌面端正常关窗（确认退出） | **会**（约 5s 预算） | `main.js:21692 finishQuit` → `backend.close()` → `profile-boot.ts:298 dispose` |
| CLI / web 端 Ctrl+C、SIGTERM | **会**（约 5s；第二次信号立即硬退） | `profile-boot.ts:322` / `:323` + `process-shutdown.ts:6` / `:54` / `:71` |
| profile dispose（插件被禁用 / 热重载） | **会** | `fiber.ts` 卸载 → 逆序 runDisposable |
| 未捕获异常 / 未处理 rejection | **不会**（宿主 `proc.exit(1)`） | `dsh-app-boot/src/index.ts:901` / `:948` |
| 任务管理器结束进程 / SIGKILL | **不会** | Node 文档：SIGKILL 不可监听 |
| Windows 关机 / 重启 | **不会** | `main.js:21690` 的 powerMonitor 分支排除 win32 |
| 拔电 / 蓝屏 | **不会** | 无任何机会 |

因此「临时工作台随插件启动创建、关闭客户端时删除」**最多能承诺的是**：

1. **正常退出必删**（桌面关窗 / CLI 信号 / profile 卸载），窗口 5 秒，且插件自己的清理是「逆序 + 单点失败不影响其它」；
2. **崩溃与强杀留残骸** —— 任何只靠 disposer 的方案都这样，没有例外；
3. **把「下次启动清理」作为第二道闸**：插件启动时扫已知目录前缀（例如 `~/.dsh/<plugin>/workbenches/*`），按 pid + mtime 判定孤儿并删除。只有这样才覆盖强杀 / 断电 / 蓝屏。

补充一条能力对比：用 `ctx.get('subprocess').spawn()` 起的子进程**会**被连带清理（`@deepseek-ai/dsh-subprocess/src/index.ts:118` 注释「Disposal of the service terminates all still-running managed processes and awaits their exit」；实现 `dsh-subprocess-local/src/index.ts:212`；README:13「disposal terminates and joins every selected range or session」），服务行已在 base patch（`dsh-base/cordis.patch.yml:235-236`）。但现有 broker 用的是裸 `child_process.spawn({ detached: true })`，**不在此列**，这解释了它为什么现在能活过宿主退出。

---

## 3. 多 Agent 接入方式

### 3.1 现有唯一一条外部通道（A / Antigravity）

`broker/broker.mjs` + `antigravity/` 模板 + `agy_collab_relay` 工具（`lib/index.js:33` `TOOL_NAME = 'agy_collab_relay'`）。特征是：**进程外、detached、只通过 HTTP（`127.0.0.1:18765`）与文件（`~/.dsh/agy-collab/{state,records}.json`）交互**，对 DSH 内部一无所知。这条通道「不带会话上下文」天然成立（A 只看 broker 里的请求），「只读工具集」取决于 A 自己的配置，「指定模型」也由 A 决定 —— **宿主无法约束**。

### 3.2 路径 ①：`ctx.subagents.startActivation()` —— 用宿主现成的子代理

- 服务：`@deepseek-ai/dsh-subagent/src/index.ts`，`:524` `registerProvider(provider: SubagentProvider): () => void`；`:269` `async startActivation(spec: SubagentActivationSpec)`。
- provider 已在 base patch 挂好：`@deepseek-ai/dsh-base/cordis.patch.yml:375-376` `- id: subagent-spawn-in-process` / `name: '@deepseek-ai/dsh-subagent-spawn-in-process'`；`:392` `- id: tool-subagent`（`provider: spawn`）；fork 在 `:402`；`:387` `tool-subagent-control`。**插件不需要自己造进程。**
- 两个内置 provider 的上下文语义：`dsh-subagent-spawn-in-process/src/index.ts:47` `readonly inheritsParentContext = false`（fresh，看不到父会话，注释原文「a spawned child starts fresh — it never sees the parent conversation」）；`dsh-subagent-fork-in-process/src/index.ts:69` `readonly inheritsParentContext = true`（带已完成轮次）。
- 能力位：`dsh-subagent/src/types.ts:327` `readonly capabilities: SubagentCapabilities`（`agentOptions` / `agentPreset` / `outputSchema` / `depthLimit`），`:333` `readonly inheritsParentContext: boolean`。**没有 `toolFilter` 能力位。**
- 启动参数：`types.ts:154` `readonly agentPreset?: string`、`:179` `readonly agentOptions?: AgentOptions`（注释「Requires SubagentCapabilities.agentOptions; in-process providers merge them over the parent Agent's options」）。
- 子会话身份：`dsh-subagent/src/child-agent.ts:152` `origin: 'subagent'`（在 `childSessionMeta()` 里，注释「Durable: the recursion budget must survive persistence and resume.」）。**这正是本插件 `lib/index.js:244-246` 判断的那一位**：`const origin = context?.agent?.session?.header?.origin; if (origin === 'subagent') return '';`
- 权限天花板：`child-agent.ts:173` `SUBAGENT_DELEGATION_CONTEXT` 原文「You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically.」（`:211` 以 `text: SUBAGENT_DELEGATION_CONTEXT` 注入）。`DelegatedPolicyOverrides` 里子代理恒为 `approvalPolicy: 'never'`。

**三条目标能不能达成：**

| 需求 | 能否 | 方式与证据 |
| --- | --- | --- |
| 不带会话上下文 | **能** | 选 `spawn` provider（`inheritsParentContext = false`） |
| 只读工具集 | **能，但只能通过 preset** | `ChildComposition.toolFilter`（`child-agent.ts:165`）在 `:220` `if (composition.toolFilter !== undefined) childCtx.tools.restrict(composition.toolFilter)` 生效，但该字段是**历史 descriptor 冷恢复专用**（`:161-164` 注释「Historical descriptor tool restriction reapplied only during cold resume」），常规调用传不进去；`dsh-tool-subagent` 已把 `persona` / `toolFilter` 配置项移除（`src/index.ts:151` 抛「... is no longer supported; configure persona and tool plugins in an Agent Preset and select it with agentPreset (spawn only)」）。**唯一正路是 `agentPreset`**（README:53「Default independent child preset id; requires in-process spawn」） |
| 指定模型 | **能** | `agentOptions`（provider / model / reasoningEffort / maxTokens）；用工具时要 `modelSelection: true`（README:78）。README 原文「Route fields require a backend that advertises `agentOptions`; in-process Spawn and Fork and DSH SDK qualify, while ACP, Codex, and Claude Code fail the mount.」 |

### 3.3 路径 ②：`ctx.agents.create()` —— 插件内起一个完全私有的 Agent（推荐给 B）

- `@deepseek-ai/dsh-agent/src/index.ts:262` `super(ctx, 'agents')`（服务名 `ctx.agents`）；`:412` `async create(options: CreateAgentOptions): Promise<AgentHandle>`；`:162` `export interface AgentHandle {`（`{ agent, dispose() }`）。
- `CreateAgentOptions`（`:68`）：`sessionId`（调用方自造）、`:82` `readonly meta?: {` `cwd?` / `parentSession?` / `isSeeded?` / `origin?: 'subagent'` / `delegationDepth?` / `agentPreset?` `}`、`seed`、`agentOptions`、`signal`、`setup?: AgentSetup`。`setup` 的文档原文：「Everything registered through agentCtx (scoped tools, prompt sections/variables, `restrict()`, listeners, awaited child plugins) exists before `agent/created`, and the first prompt assembly」。
- 模型：`@deepseek-ai/dsh-agent/src/runtime-types.ts:35` `provider?: string`（`AgentOptions`）。
- 官方范例（可直接抄）：`@deepseek-ai/dsh-acp/src/session.ts:84` `async function composeAgent(agentCtx: Context, options: AcpSessionBuildOptions): Promise<void>`；`:121` `const handle = await ctx.agents.create({ sessionId: options.sessionId, meta: { cwd: options.cwd }, agentOptions: options.agentOptions, signal: options.signal, setup: agentCtx => composeAgent(agentCtx, options) })`；sessionId 造法 `dsh-acp/src/index.ts:204` `const sessionId = brandString<SessionId>(randomUUID())`。

**三条目标：**

| 需求 | 能否 | 方式与证据 |
| --- | --- | --- |
| 不带会话上下文 | **能（且最强）** | 不传 `meta.parentSession`、不传 `origin: 'subagent'` 即全新顶层会话；不传 `seed` 就没有历史事件 |
| 只读工具集 | **能（最精确）** | `setup` 里 `agentCtx.tools.restrict({ allow: [...] })`；契约 `dsh-tools/src/index.ts:164` `restrict(filter: ToolRestriction): () => void`，`:167` 错误原文「tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent」，`:172`「tools.restrict({}) is a no-op: pass `allow` and/or `deny`」；类型见 `dsh-tools/src/contracts.ts:397` |
| 指定模型 | **能** | `agentOptions: { provider, model, reasoningEffort, maxTokens }` |

额外好处：B 的生命周期由插件持有（`AgentHandle.dispose` 是能力），不需要 preset 写盘、不需要重启 profile。
额外代价：**B 不是「subagent」身份**，因此不会被 `lib/index.js:245` 的 `origin === 'subagent'` 跳过 —— **插件必须自己决定要不要给它注入协作提示词**（现有 `registerPromptSection` 的过滤条件对这条路径不生效）。

### 3.4 路径 ③：自定义 preset

- 声明者是一个普通 Cordis 行：`@deepseek-ai/dsh-agent-preset/src/index.ts`（`static Config = z.object({ id: required, name, description, order, plugins: z.array(z.any()).required() })`，`Service.init` 里 `yield await this.ctx.agentPresets.register(this.config)`）。
- 注册表：`@deepseek-ai/dsh-agent-preset-registry/src/index.ts:99` `async register(definition: PresetDefinition): Promise<() => Promise<void>>`，`:102` 重复 id 抛 `Duplicate agent preset`；`:299` `async mount(ctx: Context, id?: string)`；`:315` `composeFrom(ctx: Context, parent: Context)`；挂载实现 `src/mount.ts:205` `export async function mountPreset(ctx, id, plugins)`（内部 `ctx.effect(() => () => { tree.root.stop() }, 'agent-preset.tree')`）。
- 官方口径（`dsh-agent-preset-registry/README.md:49`）：「A new preset or an override of a shipped one is a bundle patch: an `insert` of a `@deepseek-ai/dsh-agent-preset` row, or a patch keyed by that row's id, installed into the profile with `plugin_manager`」；`:100`「**Presets are not security sandboxes**: YAML and plugins can execute Host code.」
- 运行期 `ctx.agentPresets.register()` 技术上可调（服务是 root 级 Service），但注册项随插件 fiber 卸载消失，且会进入用户可见的 preset 名册 —— **是否可接受需设计票拍板（未实测，标未确认；要确认需要一次最小实验：插件里 register 一个 preset，看 Agent Presets 设置页是否出现、插件卸载后是否消失）**。

### 3.5 路径 ④：外部 CLI 子进程 / 另一个 HTTP 端点

- **HTTP 端点**：已在本仓库验证过 —— `lib/index.js:289-382` `installWebRoutes`。契约 `@deepseek-ai/dsh-host-webserver/src/index.ts:53` `export interface WebRoute {`（`kind: 'exact' | 'prefix'`、`path`、`handler`）、`:446` `register(route): () => void`。注意 README:133 无服务级鉴权（「**No server-wide authentication or origin policy** — route owners such as `dsh-client-connection` enforce their own request policy」），且 Electron 端不走这个 server 供页面而是 IPC 中转。
- **CLI 子进程**：契约 `@deepseek-ai/dsh-subprocess/src/index.ts:126` `export abstract class SubprocessRuntime extends Service`（服务名 `subprocess`，`:162` `abstract spawn(spec)`），spec 的 `argv: readonly string[]` 注释「Never shell-interpreted here」+ 洗净的环境变量。**用它起的子进程会被 Host 优雅 dispose 连带终止**，比现有裸 `spawn({ detached: true })` 安全。
- **外部 ACP / Codex / Claude 子代理**：DSH 的 subagent 体系把这类当一等公民（`dsh-subagent/README.md:13`「Local spawn and fork children retain durable sessions for later messages; ACP, DSH SDK, Codex, and Claude Code execute once.」>「external children expose one execution and reject continuation」），但**客户端包不在本机 asar 里**（338 个 `@deepseek-ai` 包中没有 `dsh-subagent-acp`；`dsh-acp/README.md:13` 提到「use `dsh-subagent-acp` as the repository client」，`:130` 指向 `../../subagent/subagent-acp/README.md`）。**未确认是否有 npm 发布物**；要确认需查 npm registry 的 `dsh-subagent-acp` 或 monorepo 的 `packages/subagent/subagent-acp`。这条路上 `agentOptions` / `agentPreset` 都被拒（README:78），工具集限制由外部 CLI 自己管。

### 3.6 四条路横向对照

| 路径 | 不带上下文 | 只读工具集 | 指定模型 | 生命周期归属 |
| --- | --- | --- | --- | --- |
| A：broker + HTTP（现状） | 天然（外部进程） | 由 A 自己决定，宿主不可约束 | 由 A 决定 | detached，插件退出不回收 |
| `ctx.subagents.startActivation`（spawn） | 能 | 只能靠 `agentPreset` | 能（`agentOptions`） | 归 activation manager，插件 dispose 可回收 |
| `ctx.agents.create`（插件私有 Agent） | 能（不传 parent / origin） | 能（`agentCtx.tools.restrict({ allow })`） | 能 | 归插件（`AgentHandle.dispose`） |
| 自定义 preset | 取决于 preset 里的插件 | 能（preset 的 `plugins` 列表就是工具集） | 取决于 preset 行 | 写盘、需重启 / 重载 profile |
| 外部 CLI / ACP | 能 | 外部自理 | **不能**（route 字段被拒） | 外部自理 |

---

## 4. 对设计票的约束

> 这一节不是设计决定，而是「如果只能这样做，设计票必须接受什么」。每条都能追到上面某一节的证据。

### 4.1 由「设置页挂载点」产生的约束

| 编号 | 约束 | 依据 |
| --- | --- | --- |
| C1 | **不能承诺「独立窗口 / 独立页面 URL」**。所有可视化挂载点都是应用内渲染，桌面端连 `window.open` 都被 deny。设计票只能选「设置面板一页 / 插件页一张卡 / 独立整页（`main`）/ 右侧栏 tab / 全框浮层」这五种形态之一或组合。 | 1.4 节全部条目；`main.js:20323` |
| C2 | **设置面板与全局页拿不到 sessionId**。若某处 UI 需要「当前会话」的协作状态，只能继续挂在 `scope: 'session'` 的槽位（`sidebar.right.pane.tab` / `conversation.input.right`），或由客户端自己在会话切换事件里记录「最后活跃会话」。设置页只能展示**全局/跨会话**的协作配置。 | 1.2 节表格 standardProps；`slot-catalog.ts:2669` / `:3805` |
| C3 | **设置项是机器级共享，不是每浏览器 / 每会话一份**。设计票若需要「每个用户各自一套设置」，官方 `configForms` 路线做不到。 | `dsh-client-ui-settings/README.md:112` |
| C4 | **走官方表单就要把 Config 字段标 `.volatile()`**，否则不进设置表单。反之若用自带页面，必须显式 `configure({ auto: false }, ctx.fiber)`，否则会额外长出一张自动生成的表单。 | `dsh-settings/src/schema.ts:39`；`dsh-settings/README.md:40` |
| C5 | **设置页读写要么走 `configForms`（落 profile 的 Cordis patch），要么自带 Host 路由 + 自己落盘**。现有插件的 `/api/agy-collab/*` 就是后者，且**只有 `sec-fetch-site` 同源判定、无 token**；桌面端 origin 是 `dsh-app://app`，设计票若要「安全设置接口」，必须补 dsh-see-now `structuralReason` 级别的同源判据，并覆盖 IPC 中转那条路径。 | 1.3 节 dsh-see-now 条目；`dsh-host-webserver/README.md:133` |
| C6 | **侧栏 tab 的 `'float'` 不是独立窗口**。若设计票写「浮动窗口」，只能理解为页内浮层（不挤占栏宽）。 | `dsh-client-ui-sidebar-right/src/client/contract/slots.ts:130` |

### 4.2 由「退出清理钩子」产生的约束

| 编号 | 约束 | 依据 |
| --- | --- | --- |
| C7 | **不得承诺「关闭即删干净」**。设计票必须把「删除」拆成三段承诺：正常退出即删（5s 内）、崩溃/强杀留残骸、**下次启动清扫**。第三段是必需项，不是可选项。 | 2.5 节表格 |
| C8 | **清扫判据不能只靠"目录存在"**。必须能区分「活着的另一实例的临时工作台」与「孤儿」。至少需要 pid + 启动时间或 mtime，且要处理「pid 已被别的进程复用」。设计票要选一套判据并写清冲突时的行为。 | 2.5 节第 3 条 |
| C9 | **清理逻辑预算 ≤ 5 秒（桌面端另有 500ms 级子预算）**，且**单点失败不得中断其它清理**（cordis 已保证，但插件自己的循环也要 try/catch）。删除大目录时要评估 5 秒够不够，不够就改成「标记待删 + 启动时删」。 | `process-shutdown.ts:6` / `:56`；`main.js` 的 `waitForOperationReports` |
| C10 | **broker 现状与「随插件启动创建、关闭时删除」自相矛盾**。broker 是 `detached + unref`，现在**故意活过宿主退出**。设计票必须显式回答：broker 是否也纳入「临时工作台」范畴？若要纳入，就得改成 `ctx.get('subprocess').spawn()` 或自己加会话级 pid 记录 + 启动清扫。 | 2.1 节；`lib/index.js:106-132` |
| C11 | **不能靠 `process.on('exit')` 兜底**。Node 文档明确其监听器只能做同步操作，且 `beforeExit` 对 `process.exit()` 与未捕获异常都不触发。设计票里出现「用 exit 钩子删目录」就是不成立的方案。 | 2.4 节 |
| C12 | **Windows 是最大盲区**。`SIGTERM` 在 Windows 上不被「支持」（只能监听），关机/重启不走 `powerMonitor` 分支。所以「关机时清理」在 Windows 上等于「下次启动清理」。 | 2.4 节；`main.js:21690` |

### 4.3 由「多 Agent 路由」产生的约束

| 编号 | 约束 | 依据 |
| --- | --- | --- |
| C13 | **若 B 必须「不带 D 的会话上下文」，只能用 spawn provider 或 `ctx.agents.create()`**，fork 一定带父上下文，直接排除。 | 3.2 / 3.3 节；`inheritsParentContext` 两处实现 |
| C14 | **若 B 必须「只读工具集」，只有两条路**：给 B 定一个 `agentPreset`（需写 `cordis.patch.yml` + 重载 profile），或插件用 `ctx.agents.create()` 自建并在 `setup` 里 `tools.restrict({ allow })`。**通过 `subagent` 工具调用传 toolFilter 是不可行的**（字段已移除，只剩冷恢复）。 | 3.2 / 3.3；`dsh-tool-subagent/src/index.ts:151` |
| C15 | **若 B 要「指定模型」，外部 CLI/ACP 路径明确不行**（README：「ACP, Codex, and Claude Code fail the mount」）。要独立模型只能 in-process（spawn/fork 的 `agentOptions` 或自建 Agent 的 `agentOptions`）。 | 3.2 节「指定模型」行；3.5 节最后一条 |
| C16 | **子代理身份判据是 `session.header.origin === 'subagent'`，且它是持久化的**。设计票若要新增「B 也要收到/不收到协作提示词」的规则，必须决定：自建 Agent（无 origin）算不算「内部 agent」，以及 `registerPromptSection` 的过滤条件怎么改。**这是本笔记发现的最容易踩的坑**：现在的过滤只挡 subagent，自建 Agent 会被当成用户会话注入提示词。 | 3.3 节「额外代价」；`lib/index.js:244-246` |
| C17 | **设计票不得假设「子代理能自提权限」**。`SUBAGENT_DELEGATION_CONTEXT` 与 `approvalPolicy: 'never'` 决定了子代理的权限天花板在启动时就钉死。想让 B 写文件，必须在启动时就给足 sandbox，不能指望它在运行中申请。 | 3.2 节「权限天花板」 |
| C18 | **preset 不是安全边界**（「Presets are not security sandboxes: YAML and plugins can execute Host code」）。用 preset 限制工具集只解决「B 看见什么工具」，不解决「B 能不能执行任意 Host 代码」。设计票若把 preset 当隔离手段，必须承认这个上限。 | 3.4 节官方口径 |
| C19 | **A 那条通道上宿主没有约束力**。B 若要和 A 同等可信度，不能简单复用 broker；要么给 B 一条宿主内通道（`ctx.agents` / `subagents`），要么接受「B 的能力边界由 B 自己声明」。设计票应显式写清「B 与 A 的信任等级是否相同」。 | 3.1 节；3.6 节对照表 |

### 4.4 未确认项（需要额外证据才能定论）

| 项 | 现状 | 需要什么证据 |
| --- | --- | --- |
| U1 | 运行时 `ctx.agentPresets.register()` 是否可在插件里安全使用 | 一次最小实验：插件 register 一个 preset → 看 Agent Presets 设置页是否出现、插件卸载后是否消失、是否污染用户配置 |
| U2 | `dsh-subagent-acp`（以及 codex / claude 客户端包）是否有 npm 发布物 | 查 npm registry 或 monorepo `packages/subagent/subagent-acp` 的 package.json |
| U3 | 桌面端「关窗」是否在所有配置下都等于 Host 进程退出 | 读 `G:/鱼塘/resources/app/lib/main.js` 中 `tray` / `backgroundNotice` 相关分支，确认「最小化到托盘」时 backend 是否仍存活 |
| U4 | `settings.section` 内能否安全地按会话读状态（跨槽位通信） | 需实测：在 `settings.section` 组件里通过 `useSessions` 拿到会话列表后订阅某会话状态是否可靠、是否随设置面板常驻 |
| U5 | 断电/蓝屏后残留目录在下次启动时是否一定可判定为孤儿（pid 复用问题） | 需实测：Windows 上 `process.kill(pid, 0)` 的判活边界，与「pid 被新进程占用」的误判概率 |

---

## 5. 证据索引（按文件）

| 证据来源 | 用途 |
| --- | --- |
| `plugin/dsh-agy-collab/lib/index.js:24, 33, 106-132, 238-250, 244-246, 289-382, 539-545, 553-557` | 插件现状：inject、工具名、broker detached、提示词过滤、web 路由、清理 |
| `plugin/dsh-agy-collab/client.js:25, 1671, 1675, 1686, 1690` | 客户端现状：inject、两个槽位注册 |
| `@deepseek-ai/dsh-client-ui-settings/src/client/contract/slots.ts:19, 35, 41, 47, 59, 67, 76, 87, 102, 136, 162` | 设置页槽位契约 |
| `@deepseek-ai/dsh-cordis-client-runner/src/client/slot-catalog.ts:2669, 3048, 3752, 3805, 4011` | 槽位权威目录（main / plugins.item / settings.plugins.tab / settings.section / shell.overlay） |
| `@deepseek-ai/dsh-client-ui-settings-general/src/client/index.ts:255, 259, 265, 268, 273` | 官方设置页注册范例（含 header / action / close / overlay） |
| `@deepseek-ai/dsh-client-ui-settings-plugin-inventory/src/client/index.ts:58` | `settings.plugins.tab` 最短模板 |
| `@deepseek-ai/dsh-client-ui-plugin-manager/src/client/index.ts:85, 131, 136, 169` | 独立整页范例（main + sidebar.panellist） |
| `@deepseek-ai/dsh-client-ui-sidebar-right/src/client/contract/slots.ts:45, 61, 130` | 右侧栏契约与 float 语义 |
| `@deepseek-ai/dsh-client-ui-conversation/src/client/contract/slots.ts:327` | `conversation.input.right` 是 session 作用域 |
| `dsh-see-now/client.js:39, 885` + `src/index.js:542-544, 557` + `src/settings-trust.js:40, 63` | 第三方插件「设置页 + 自有 Host 路由 + 同源校验」完整样例 |
| `@deepseek-ai/cordis/src/fiber.ts:73, 423, 425, 426` | effect / disposer 语义 |
| `@deepseek-ai/dsh/src/profile-boot.ts:284, 298, 311, 322, 323` | runProfile 与信号处理 |
| `@deepseek-ai/dsh/src/process-shutdown.ts:6, 28, 54, 56, 71` | 5 秒优雅退出预算与二次信号硬退 |
| `@deepseek-ai/dsh-app-boot/src/index.ts:809, 859, 901, 948` | 崩溃路径 fail-loud（exit 1） |
| `G:/鱼塘/resources/app/lib/main.js:1478, 20231, 20323, 20562, 21687, 21690, 21692, 21723, 21740, 21744` | 桌面端退出链、dsh-app scheme、窗口 deny |
| `@deepseek-ai/dsh-subagent/src/index.ts:269, 524` + `src/types.ts:154, 179, 327, 333` + `src/child-agent.ts:152, 159, 165, 173, 189, 207, 220` | 子代理体系与身份判据 |
| `@deepseek-ai/dsh-subagent-spawn-in-process/src/index.ts:47` / `@deepseek-ai/dsh-subagent-fork-in-process/src/index.ts:69` | spawn / fork 的上下文继承差异 |
| `@deepseek-ai/dsh-agent/src/index.ts:68, 82, 162, 262, 412` + `src/runtime-types.ts:35` | 插件自建 Agent 的入口与模型字段 |
| `@deepseek-ai/dsh-acp/src/session.ts:84, 121` + `src/index.ts:204` | 自建 Agent 的官方范例 |
| `@deepseek-ai/dsh-tools/src/index.ts:164, 167, 172` + `src/contracts.ts:397` | tools.restrict 契约 |
| `@deepseek-ai/dsh-agent-preset-registry/src/index.ts:99, 102, 299, 315` + `README.md:49, 100` | preset 注册与「非安全沙箱」口径 |
| `@deepseek-ai/dsh-tool-subagent/README.md:50, 52, 53, 54, 70, 72, 78` + `src/index.ts:151` | 工具级 subagent 的 route / preset / modelSelection 字段 |
| `@deepseek-ai/dsh-base/cordis.patch.yml:235-236, 364-406` | profile 已挂的 subprocess / subagent 全家桶 |
| `@deepseek-ai/dsh-host-webserver/src/index.ts:53, 446` + `README.md:133` | 自有 HTTP 路由契约与无鉴权事实 |
| `@deepseek-ai/dsh-settings/src/index.ts:267, 303, 313` + `src/schema.ts:39` + `README.md:13, 40` | 设置服务与 `.volatile()` 门槛 |
| https://raw.githubusercontent.com/nodejs/node/main/doc/api/process.md | `exit` / `beforeExit` / 信号 / `uncaughtException` 的官方语义 |

---

*本笔记为只读勘察结果，不含设计决定。设计取舍请在 issue #6 及后续设计票中明确。*
