# ppt-master 配置页（客户端半边）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `dsh-ppt-master-wrapper` 补上客户端半边 `lib/client.js`——在 DSH 插件页 `plugins.bundle.config` 槽位渲染一张自绘卡片，读写既有嵌套 `venv.{enabled,path,oldPathPolicy}` 配置（走宿主既有 `configForms` 通道），显示插件版本 / 上游版本 / 固定相对技能目录，中英双语，槽位与可选能力缺失时安静降级。

**Architecture:** 单文件手写浏览器半边（无构建链、无 Harness 客户端包 require）：`window.__ModuleLoader__.load({id, factory})` 把 `{name, inject:['slots','locale'], apply}` 交给宿主 vendored cordis Loader；`apply` 内三个**互相隔离**的注册点——`ctx.effect(ctx.locale.register)` 字典、`ctx.inject(['configForms'], cb)` 可选能力接入（内部 `ctx.effect` 建表单订阅并发布到 holder）、`ctx.slots.inject/register` 槽位；卡片经 holder 读快照、自持暂存态，保存时手写**嵌套 `path`** 的 `ops` 交给 `mutate(ops, revision)`，以宿主回推值为准。

**Tech Stack:** 浏览器经典脚本（ES2020，无 `import`/`export`/JSX/TS）、`require('react')` 仅为 `createElement`/`useState`/`useEffect`、`--dsw-alias-*` CSS token、`node:test` + `new Function` stub 装载（零新增 npm 依赖）。

**Spec:** `docs/superpowers/specs/2026-10-16-ppt-master-config-ui-design.md`（239 行，Gate 0 两轮 + M2 重审后版本）；需求真相源 `docs/superpowers/clarifications/2026-10-16-ppt-master-config-ui.md`

## Global Constraints

- **交付面（增量与冻结）**：只新增 `lib/client.js`；`package.json` 只加 `exports["./client"] === "./lib/client.js"` 与 `dsh.client = { platform: "web", inject: ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-plugin-manager"], external: ["react"] }`（`files` 已含 `lib`，覆盖新文件，**不改**）；`index.js` / `lib/venv.js` / `lib/tools.js` / `lib/skill-provider.js` **零改动**；既有测试**零改动**——**唯一例外**（数学上不可同时成立，见"存疑点①"）：`tests/skeleton.test.mjs` 的 `package.json: exports 三条目` 用例，其 `Object.keys(pkg.exports).sort()` 逐字深比较必须加入 `'./client'`。**处置**：该用例改名为 `package.json: exports 四条目`，保留原三条目断言不动，**追加** `assert.equal(pkg.exports['./client'], './lib/client.js')`，并把期望数组补成 `['.', './client', './cordis.patch.yml', './package.json']`；除这一处外任何既有用例、任何既有断言不得改动或放宽。该例外是 T1 Step 2 红灯面（四条目化先于实现、届时该用例转红）与 T6 Step 4 文件清单（`tests/skeleton.test.mjs` 在列）的组成部分。
- **配置 schema 维持嵌套** `venv.{enabled, path, oldPathPolicy}`（键名与层级一律不变）。卡片写路由＝**自持暂存态 + 手写嵌套 path 的 ops**：`mutate([{op:'set', path:['venv','enabled'], value}], revision)`；**重置**＝ `mutate([{op:'unset', path:['venv','enabled']}, {op:'unset', path:['venv','path']}, {op:'unset', path:['venv','oldPathPolicy']}], revision)`（**一次调用、三个 op、顺序固定**）。
- **不得 require 任何 Harness 客户端包**（含 `@deepseek-ai/dsh-client-ui-primitives` / `ui-settings` / `ui-slots` / `dsh-client-locale` / `dsh-client-ui-plugin-manager`）。`require` 白名单**仅** `react` / `react-dom` / `react/jsx-runtime`（且必须至少出现 `react`）；`configForms`/`slots`/`locale` 一律经 **Cordis 服务**取得。控件**自绘**：类名一律加前缀 `ppt-master-config-`、颜色只用 `--dsw-alias-*` token（禁硬编码颜色字面量）、保留 `role="switch"` + `aria-checked`、原生可聚焦控件（禁 `tabIndex=-1`）、保留 Escape 行为。
- **客户端半边是 cordis 插件**：`window.__ModuleLoader__.load({ id: 'dsh-ppt-master-wrapper', factory })`（`id` 逐字＝包名）；factory 的返回值（宿主眼中的 `module.exports`）导出 `name` / `inject = ['slots', 'locale']` / `apply(ctx)`——`configForms` **不得**列入硬 `inject`。`configForms` 走 `ctx.inject(['configForms'], cb)` **回调式**；`locale.register` 与表单订阅用 `ctx.effect` 包裹；`slots.inject`/`slots.register` **不再**包 `ctx.effect`（宿主 renderer 侧已是 fiber 作用域）；异常隔离**收窄到单个注册点**（各自 try/catch + warn），**不得**在 `apply` 外层整体 try/catch。
- **保存结果只有两类可观测量**：① `mutate` resolve `false`（宿主拒绝 / memory 模式 / **被更高优先级 patch 覆盖**——后者经网关折成 `{ok:false}` 且控制器丢弃 error，卡片边界**无法分辨**）；② Promise **reject**（传输失败）。卡片按这两类呈现；"被覆盖"只在文案里给**一般化**提示，**不得**声称能分辨第三种成因，测试也不得断言这种分辨能力。
- **`mode === 'memory'`（非回环浏览器）⇒ 卡片必须显式提示"本次会话不会写入宿主配置"**（常显，不依赖点击）。实测（宿主 `dsh-client-ui-settings` 客户端产物）：memory 持久化下控制器快照恒为 `{status:'unavailable', writable:false, mode:'memory'}` ⇒ 写门（`status==='ready' && writable===true`）自然关闭，卡片另需**文案**区分"通道不可用"与"不会写入"。
- **写门＝`status === 'ready' && writable === true`**；Escape 使**该字段**暂存值回落宿主基值；**不做乐观更新**——保存后等待宿主回推快照，卡片不自行改写基值、不自行 bump `revision`。
- **版本信息＝客户端常量**（`PLUGIN_VERSION` / `UPSTREAM_VERSION` / `SKILL_DIR_TAIL`），以**两条配对断言**防漂移：① 插件版本常量 ≡ `package.json.version`（`6.7.0-r2`）；② 上游版本常量 ≡ `skills/ppt-master/SKILL.md` 的 `metadata.version`（`6.7.0`）；归一化规则＝插件版本允许 `-rN` 后缀，按"上游版本 + 可选 `-rN`"配对，**不做三值相等**。卡片只显示固定相对尾部 `<包根>/skills/ppt-master`，**不显示绝对 SKILL_DIR**、**不读宿主 schema 注解**（宿主 `volatileForm` 重建 schema 丢弃根 description，注解不可达）。
- **三叶子全 volatile ⇒ 保存走 volatile 快路径**（只写 `fiber._config` + `_commitVolatile()` → `loader/volatile-update`），**不 remount、不重跑 `apply`**。计划正文、代码注释、README 文案**不得**出现"保存后插件实例重建 / 保存需重启才生效"；重启边界只在**声明面**：改 `dsh.client` / `exports["./client"]` 需重启宿主，仅改 `lib/client.js` 免重启（宿主 stat 轮询热更新）。
- **测试命令一律 glob 形态**：`node --test tests/*.test.mjs`（目录形态在本机失效）。**基线＝既有 527 用例全绿**；`node scripts/check-dsh-compat.mjs` 与 `node scripts/verify-plugin.mjs --upstream .upstream/refs/tags/v6.7.0@b4efe3ddf237a97a42880164759162f8e2412f2f` 保持通过。每个 Task Step 4 至少复跑全量一次。
- **compat 脚本只新增 §7.7⑥**（客户端半边可被 stub 装载并注册）（含脚本内三处"五项"→"六项"注释同步改写）。既有断言（①–⑤、默认值交叉锚定、rank 关系、漂移观测、CLI 五用例、`problems`/`warnings` 空集基线）**零弱化**；`tests/compat.test.mjs` **零改动**（其 `runCompatCheck 基线: stub SDK 全绿` 的 `problems` 空集断言即 §7.7⑥ 的正向集成守卫；机理见 T4"接线验证方式"段）。
- **零新增 npm 依赖、零构建链**：单文件手写、无 TypeScript / JSX / `.d.ts` / 打包器；`lib/client.js` 内**无 `import`/`export` 语句**（含动态 `import(`）；元素构造只用 `createElement`；卡片**只渲染原生元素**（不定义子组件、不用 Fragment、不声明 `children` 插槽）。
- **卡片只用 `useState` 与 `useEffect` 两种 hook**（调用数上限：`useState` 至多 3 处、`useEffect` 至多 2 处）（无 `useMemo`/`useCallback`/`useRef`/`useSyncExternalStore`）——测试侧最小 hook 运行时即以此为准。
- **locale 命名空间逐字＝`dsh-ppt-master-config`**；槽位名逐字＝`plugins.bundle.config`；槽位 `key` 逐字＝包名 `dsh-ppt-master-wrapper`（宿主插件页以 `ledger.bundles.has(pkg.name)` 决定是否渲染该 section：`key` 不等于包名⇒卡片根本不出现）；`zh`/`en` 两套字典**键集合必须相等**。
- **不新增宿主↔页面 RPC / typert remote / 自研页面**；不动 `dsh.engines.dsh`（维持 `>=0.1.1-rc.1`）与 `engines.node`；不补发行元数据（`repository` 等）；**不递增版本号**；发行待办三项（`repository`／发布流程／版本递增）已在设计 §9 登记，本计划不重复登记、亦不执行。
- **每 Task 一个 commit**（main 直推，本仓库既有惯例）。提交前 `git status` 确认改动面仅限本 Task 的 Files 行所列文件。

## Objective 与总任务表

| Task | 交付物（可独立审查） | 依赖 |
|---|---|---|
| T1 | `lib/client.js` 装载契约与注册面（loader 面 / `inject` / `apply` 三注册点 / 双语字典 / 命名空间解析兜底 / 表单 holder 与生命周期 / 单点隔离）+ `package.json` 声明 + 最小 document 样式注入 + 卡片**状态壳**；`tests/client-half.test.mjs` 夹具与静态契约断言 | — |
| T2 | 卡片**读面**：版本信息块（两条配对常量）、三字段控件（switch/文本/选择器）+ 关闭态 / 路径无效 / 重置三处文案、Escape 回退、readOnly 与 memory 提示、敌意快照容错、渲染冒烟（`SlotAssemblyError` 触发条件规避） | T1 |
| T3 | 卡片**写面**：暂存态与脏字段计算、嵌套 path 的 `set` ops（三叶子各一条）、重置三 `unset` ops、`revision` 透传、两类可观测量文案、无乐观更新、写门 | T1、T2 |
| T4 | compat 脚本 §7.7⑥（`checkClientHalf` 客户端半边 stub 装载与注册断言）+ 其正/负用例 | T1（读 `lib/client.js`；**须串行**——T4 与 T2/T3 共用 `tests/client-half.test.mjs` 追加面，不得并行） |
| T5 | README 配置入口更新（插件页卡片路径 / 重启边界 / memory 提示 / 配置页诊断分层 / compat「六项」字样）+ 文档契约断言 | T1–T4（含 T4 串行序） |
| T6 | 2026-10-15 spec 勘误回写（㉗ 指针、§7.7「五项→六项」、volatile 快路径机制更正）+ 文档契约断言 + 全量回归收尾 | T1–T5（含 T4 串行序） |

## Review Focus

以下失败模式源自设计，但不在任何一个 Task 的主干断言里天然暴露——每条已在归属 Task 的 Step 1 以测试钉住：

1. **宿主快照敌意/缺字段**（`status` 非枚举值、`value` 为 `null`、`value.venv` 缺失、`revision` 为 `undefined`）→ 卡片必须仍渲染、不抛、不误报可写，缺基值的叶子控件禁用且不入 ops（T2 Step 1⑧ 敌意快照容错 ＋ T3 Step 1⑨ 的**等价观测**：禁用 ⇒ 不可暂存 ⇒ 脏集为空 ⇒ 不产出 op——该性质另由 T3 Produces 的 `buildSetOps` 规格 `baseline[leaf] !== undefined` 守卫结构性保证）。
2. **命名空间目录与快照不同步**（`configForms.describe()` 目录未列出本 ns、目录不可读、或列出多个非本插件 ns）→ 不得崩、不得误 address 他人命名空间（T1 Step 1⑩）。
3. **`revision` 时效**（快照换代后再保存）→ 必须以**最新**快照 `revision` 透传，不缓存旧值、不自行 bump（T3 Step 1⑦）。
4. **保存被否 vs 传输失败** → 两类文案互不混用、暂存编辑保留、不抛，且保存成功也不乐观更新（T3 Step 1⑤⑥⑧）。
5. **单注册点异常与渲染期异常** → 一个注册点抛错不拖垮其余注册点且不冒泡出页（T1 Step 1⑫）；卡片在全部快照形态下渲染不抛，且注册项不声明 `children`/session 子槽以规避 `SlotAssemblyError` 冒泡条件（T1 Step 1⑧⑫、T2 Step 1⑨）。

---

### Task 1: 客户端半边装载契约与注册面

**Files:**
- Create: `lib/client.js`
- Modify: `package.json`（仅 `exports["./client"]` 与 `dsh.client`）
- Modify: `tests/skeleton.test.mjs`（**仅** `package.json: exports 三条目` 一条用例的四条目化，见 Global Constraints）
- Test: Create: `tests/client-half.test.mjs`（含 `package.json` 声明面断言——用例 16）

**Interfaces:**
- Consumes: 宿主契约（已按本机装包实证，只依赖公开服务与 `window.__ModuleLoader__`）：`window.__ModuleLoader__.load({id, factory})`；`ctx.slots.inject(slotName, register)` / `ctx.slots.register({name, key, locale}, Component)`；`ctx.locale.register(ns, {zh, en})`（返回 disposer）/ `ctx.locale.bind(ns) -> (key, params) => string`；`ctx.inject(deps, cb)`；`ctx.effect(fn, label)`；`configForms.get(entryId)` → `{getSnapshot(), subscribe(listener), mutate(ops, expectedRevision)}`；`configForms.describe()` → 快照源（`getSnapshot().view.namespaces[]`）。
- Produces（T2/T3/T4/T5 消费）:
  - 装载面：`window.__ModuleLoader__.load({ id: 'dsh-ppt-master-wrapper', factory })`；`factory(require) -> { name: 'dsh-ppt-master-wrapper', inject: ['slots','locale'], apply(ctx) }`。
  - 常量：`NS = 'dsh-ppt-master-wrapper'`、`LOCALE_NS = 'dsh-ppt-master-config'`、`SLOT_NAME = 'plugins.bundle.config'`、`REGISTER_OPTIONS = { name: SLOT_NAME, key: NS, locale: LOCALE_NS }`、`STYLE_ID = 'ppt-master-config-styles'`。
  - `DICT = { zh: {…26 键…}, en: {…同键集…} }`——键集固定为：`title`、`intro`、`version.plugin`、`version.upstream`、`version.skillDir`、`version.skillDirValue`、`field.enabled.label`、`field.enabled.hint`、`field.path.label`、`field.path.hint`、`field.oldPathPolicy.label`、`field.oldPathPolicy.hint`、`option.keep`、`option.delete`、`action.save`、`action.reset`、`reset.hint`、`state.loading`、`state.unavailable`、`state.unconfigured`、`state.readOnly`、`state.memory`、`notice.pending`、`notice.saved`、`notice.rejected`、`notice.transportError`。
  - `resolveNamespace(forms) -> string`（默认 `NS`；目录可读且含 `NS` → `NS`；否则目录内 `value` 为普通对象且含顶层 `venv` 键的 ns 恰一个 → 该 ns；其余 → `NS`；任何读取异常 → `NS`）。
  - `createFormHolder() -> { get(): form|undefined, set(form): void, notify(): void, subscribe(fn): () => void }`（`set`/`notify` 均广播）。
  - `readSnapshot(form) -> Snapshot|undefined`：`Snapshot = { status: 'loading'|'ready'|'unavailable', value: object|undefined, revision: any, writable: boolean, mode: 'host'|'memory' }`；`form` 缺失/`getSnapshot` 非函数/抛错 → `undefined`（＝未接入）；`status` 非三枚举值 → `'loading'`；`value` 非普通对象 → `undefined`；`writable` 仅字面 `true` 为真；`mode` 仅字面 `'memory'` 为 memory，其余 `'host'`。
  - `ensureStyles()`：`typeof document === 'undefined' || !document?.head` → 静默返回；已存在 `STYLE_ID` 元素 → 不重复注入；否则 `document.createElement('style')` + `document.head.appendChild`；任何异常 → 单行 `console.warn`，不抛。
  - `Card`（**本 Task 仅状态壳**）：渲染 `title` + `intro` + 三态文案之一——`state.unconfigured`（快照 `undefined`）/ `state.loading` / `state.unavailable`；全部为原生元素，`type` 均为字符串。

- [ ] **Step 1: 写失败测试** — 新建 `tests/client-half.test.mjs`，先落**测试夹具**（本 Task 的测试基础设施，T2/T3 复用）：

  夹具 API 与语义（钉死，避免歧义）：
  ```js
  // 装载（当前 realm 求值：vm.runInNewContext 产出的对象跨 realm，deepStrictEqual 会因
  // 原型不同而失败，故一律用 new Function 注入 window）
  function loadEntry(source = readFileSync(CLIENT_ENTRY, 'utf8')) // -> { id, factory }；断言载荷恰一次
  function makeRequire({ document } = {})   // -> require 桩：仅 react 系可解析，其余抛错
  // 假 ctx：记录注册面并驱动 apply
  function makeCtx({ configForms = true, namespaces, activeLocale = 'zh', document } = {})
  //   -> { ctx, calls, disposeAll }
  //   ctx.inject(deps, cb)：记录 deps；configForms 在场才同步回调（实参＝同一 ctx）
  //   ctx.effect(fn, label)：立刻执行 fn 并把返回的 disposer 收集（label 记录）
  //   ctx.locale.register(ns, dicts)：记录并返回置 disposed 的 disposer
  //   ctx.locale.bind(ns)：返回 t(key)，按 activeLocale 现读字典（缺键回退 key）
  //   ctx.slots.inject(name, cb)：记录后立刻调用 cb 并返回其结果
  //   ctx.slots.register(options, Component)：记录；返回 disposer
  //   calls: { injects, effectLabels, localeRegisters, slotInjects, slotRegisters, mutates,
  //            formsGet, formUnsubscribed, warns }
  // 最小 hook 运行时（仅 createElement/useState/useEffect；其余 hook 不存在）
  function installHookRuntime()  // 供 makeRequire 的 react 桩转发
  function renderCard(Component, props = { view: 'page' })
  //   -> { tree, text, settle(), unmount() }；render 后立即执行挂起 effect；
  //      setState 触发的重渲染由 settle() 收敛（上限 20 次，超出抛错）；
  //      unmount() 逆序跑 cleanup；createElement 遇函数 type 立即抛错（卡片禁子组件）（允许返回**已 `createElement` 结果**的本地辅助函数——如 T2 Step 5 的 `renderField`；仅禁止把组件函数直接作为 `type` 传入）
  function textOf(tree)                     // 递归拼接字符串/数字子节点
  function escapeRe(s)  // 正则字面量转义（T2① 版本配对断言用）
  function find(tree, pred) / findAll(tree, pred)
  ```

  **夹具硬规则**：`loadEntry()` 必须在各用例体内调用（默认参在调用时求值）；**禁止**模块级/顶层读取 `CLIENT_ENTRY`——否则单条 `ENOENT` 会使整文件加载期夭折（`# tests 1` 单条红），Step 2 的逐例红不可复现。

  断言（用例名 → 断言）：
  1. `装载契约: stub ModuleLoader 收到 id=包名与 factory`：`loadEntry().id === 'dsh-ppt-master-wrapper'`；`typeof factory === 'function'`；**无 `document` 环境**下 `assert.doesNotThrow(() => factory(makeRequire()))`（该 `doesNotThrow` 仅验 **factory 期零副作用**——`ensureStyles` 在 `apply` 内、factory 阶段不触 document；document 两态由用例 14 覆盖）。
  2. `装载契约: factory 返回值即插件面`：`face.name === 'dsh-ppt-master-wrapper'`；`assert.deepEqual(face.inject, ['slots', 'locale'])`；`typeof face.apply === 'function'`。
  3. `静态契约: 无 import/export 语句`：源码 `assert.doesNotMatch(src, /^\s*(?:import|export)\b/m)`；`assert.doesNotMatch(src, /\bimport\s*\(/)`。
  4. `静态契约: require 白名单仅 react 系且至少 require('react')`：正则抓全部 `require('…')` 字面量 → 每个都在 `['react','react-dom','react/jsx-runtime']`；集合含 `'react'`；无任何以 `@deepseek-ai/` 开头的 spec（**禁 require Harness 客户端包**）。
  5. `静态契约: 只用 useState/useEffect`：`src.match(/\buse[A-Z]\w*/g)` 的集合 ⊆ `{'useState','useEffect'}`。
  6. `静态契约: 无硬编码颜色字面量`：`assert.doesNotMatch(src, /:\s*#[0-9a-fA-F]{3,8}\b/)`、`/\brgba?\(/`、`/\bhsla?\(/` 均不匹配。
  7. `注册面: locale 字典 ns 逐字 + zh/en 键集合相等 + 必含子集`：`calls.localeRegisters[0].ns === 'dsh-ppt-master-config'`；`assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())`；两侧均含 `['title','intro','version.plugin','field.enabled.hint','field.path.hint','reset.hint','state.memory','action.save','action.reset']`（子集断言防"两边都空"的自我印证）。
  8. `注册面: 槽位 options 逐字 + 卡片为函数组件 + 不声明 children`：`calls.slotInjects` 深比较 `['plugins.bundle.config']`；`calls.slotRegisters[0].options` 深比较 `{name:'plugins.bundle.config', key:'dsh-ppt-master-wrapper', locale:'dsh-ppt-master-config'}`；`typeof Component === 'function'`；`assert.equal('children' in options, false)`（规避 `SlotAssemblyError` 的 session 子槽触发条件）。
  9. `注册面: configForms 经 ctx.inject 回调式接入，不入硬 inject`：`calls.injects` 深比较 `[['configForms']]`；`face.inject` 不含 `'configForms'`；`calls.formsGet` 深比较 `['dsh-ppt-master-wrapper']`；`calls.effectLabels` 同时含 locale 与 configForms 两条。
  10. `命名空间兜底四例`：`namespaces` 目录分别为 ①含 `NS` → `NS`；②不含 `NS`、恰一个 `{ns:'other', value:{venv:{}}}` → `'other'`；③`describe` 抛错/无 `view` → `NS`；④不含 `NS` 且两个含 `venv` 的 ns → `NS`。断言逐例 `calls.formsGet` 的末元素。
  11. `守卫: configForms 缺席 → 该接入不注册、槽位照常、不抛、零 warn`：`makeCtx({configForms:false})` → `assert.doesNotThrow(() => apply(ctx))`；`calls.formsGet` 为空；`calls.slotRegisters.length === 1`；`calls.warns` 为空。
  12. `异常隔离: 单注册点抛错不拖垮其余`：①让 `locale.register` 抛（该抛错即模拟宿主同名 `(ns, locale)` 重复注册直接抛错的真实行为）→ `slotRegisters.length === 1` 且 `formsGet` 非空、`warns` 恰 1 条且含 `locale`；②让 `slots.register` 抛 → `localeRegisters.length === 1` 且 `formsGet` 非空、`warns` 恰 1 条且含 `slot`。
  13. `生命周期: dispose 回收两处 disposer；dispose 后再 apply 不抛`：`disposeAll()` 后 `calls.localeRegisters[0].disposed === true` 且 `calls.formUnsubscribed === true`；对新 `makeCtx()` 再 `apply` 不抛且注册面成立。
  14. `样式注入: 无 document 不抛；有 document 恰注入一次且含 token 与插件前缀类名`：最小 document 桩＝`{ head: { appendChild(el){ appended.push(el); } }, createElement: (tag) => ({ tag, id: '', textContent: '' }), getElementById: (id) => appended.find((el) => el.id === id) ?? null }`；同一桩下连续两次 apply（两个 ctx）→ `appended.length === 1`（幂等）；`appended[0].id === 'ppt-master-config-styles'`；`appended[0].textContent` 含 `--dsw-alias-` 与 `.ppt-master-config-`。
  15. `渲染冒烟: 三态壳各渲染一次不抛且文案互不相同`：`installHookRuntime()`；三态（快照 `undefined` / `loading` / `unavailable`）各 `renderCard(Component)` → `textOf` 分别命中对应字典值，三者互不相等；遍历 `tree` 断言每个元素 `typeof type === 'string'`。
  16. `package.json 声明面`：`exports['./client'] === './lib/client.js'`；`dsh.client.platform === 'web'`；`dsh.client.inject` 深比较 `['@deepseek-ai/dsh-client-locale','@deepseek-ai/dsh-client-ui-plugin-manager']`；`dsh.client.external` 深比较 `['react']`；`files` 覆盖（`files.includes('lib') || files.includes('lib/client.js')`）；既有三条 `exports` 条目仍在（**首条断言必须是 `exports['./client']` 且不得重排**——其 `files` 覆盖与"既有三条 `exports` 条目仍在"两条子断言在 Step 2 时刻即绿，用例红灯由 exports 断言承担）。

- [ ] **Step 2: 运行确认失败** — `node --test tests/client-half.test.mjs` → FAIL（用例 1–15 因 `lib/client.js` 不存在 → `ENOENT` 逐例转红；**用例 16 因 `package.json` 尚未增 `exports["./client"]`/`dsh.client` 而红——非 ENOENT**（其 `files`/既有条目两条子断言此时即绿）；合计 16 例红）；`node --test tests/skeleton.test.mjs` → FAIL：仅 `package.json: exports 三条目` 一条红（`'./client'` 缺于期望数组），其余全绿。

- [ ] **Step 3: 实现** — 建 `lib/client.js`（下述骨架为**必须满足的契约**，非逐字全文）：
  ```js
  window.__ModuleLoader__.load({ id: 'dsh-ppt-master-wrapper', factory: (require) => {
    const React = require('react');                       // 唯一 require；白名单内
    const { createElement, useState, useEffect } = React; // 只用这两个 hook
    // …常量 / DICT / resolveNamespace / createFormHolder / readSnapshot / ensureStyles / CSS…
    const Card = () => { /* 状态壳：title + intro + 三态文案 */ };
    function apply(ctx) {
      const holder = createFormHolder();
      const isolate = (label, fn) => { try { fn(); } catch (e) { console.warn(`${NS}: ${label} 注册失败：${e?.message ?? e}`); } };
      isolate('locale', () => ctx.effect(() => ctx.locale.register(LOCALE_NS, DICT), `${LOCALE_NS}: dictionaries`));
      ctx.inject(['configForms'], (c) => isolate('configForms', () => {
        const forms = c?.configForms;
        if (typeof forms?.get !== 'function') return;      // 缺可选能力 → 该接入不注册
        c.effect(() => {
          const form = forms.get(resolveNamespace(forms));
          const off = typeof form?.subscribe === 'function' ? form.subscribe(() => holder.notify()) : undefined;
          holder.set(form);
          return () => { off?.(); holder.set(undefined); };
        }, `${LOCALE_NS}: config form`);
      }));
      isolate('slot', () => ctx.slots.inject(SLOT_NAME, () => ctx.slots.register(REGISTER_OPTIONS, Card)));
      ensureStyles();
    }
    return { name: 'dsh-ppt-master-wrapper', inject: ['slots', 'locale'], apply };
  }});
  ```
  要点：`isolate` 是**三个独立** try/catch 的具名化（禁止把 `apply` 整体包进 try/catch）；`ctx.effect` 只包裹 locale 与表单订阅两处；`resolveNamespace` 的读取一律 `try/catch` 包裹并回落 `NS`；CSS 文本含 `.ppt-master-config-*` 选择器与 `--dsw-alias-*` token（无硬编码色）。`package.json` 按 Global Constraints 增量；`tests/skeleton.test.mjs` 按 Global Constraints 的唯一例外处置。

- [ ] **Step 4: 运行确认通过** — `node --test tests/client-half.test.mjs` → PASS（16 例全绿）；`node --test tests/skeleton.test.mjs` → PASS；`node --test tests/*.test.mjs` → 全量全绿（`# tests` 计数＝527＋本文件新增用例数）；`node scripts/check-dsh-compat.mjs` → OK（此时 §7.7⑥ 尚未新增，输出与基线同形）；`node scripts/verify-plugin.mjs --upstream .upstream/refs/tags/v6.7.0@b4efe3ddf237a97a42880164759162f8e2412f2f` → OK。

- [ ] **Step 5: Refactor（可选）** — 若 `isolate` 的三个调用点出现重复的 warn 文案拼装，把文案收敛为 `isolate` 内唯一一处（保持注册点名可辨）；若 `CSS` 常量超过 60 行，按"卡片容器 / 控件 / switch / 提示"四段加注释分隔，不拆分文件。

- [ ] **Step 6: Commit** — `git add lib/client.js package.json tests/skeleton.test.mjs tests/client-half.test.mjs && git commit -m "feat(client): 客户端半边装载契约与三个隔离注册点（设计 §5.1/§5.2）"`

### Task 2: 卡片读面（版本块 / 三字段控件 / 文案 / Escape）

**Files:**
- Modify: `lib/client.js`
- Test: `tests/client-half.test.mjs`（追加）

**Interfaces:**
- Consumes: T1 的 `loadEntry` / `makeCtx` / `installHookRuntime` / `renderCard` / `textOf` / `escapeRe` / `find`、`readSnapshot`、`DICT`、`Card`。
- Produces: `readVenv(snapshot) -> { enabled: boolean|undefined, path: string|undefined, oldPathPolicy: 'keep'|'delete'|undefined }`（**只做类型化读取、不注入默认值**：`value?.venv?.[leaf]` 类型不符即 `undefined`）；常量 `PLUGIN_VERSION = '6.7.0-r2'`、`UPSTREAM_VERSION = '6.7.0'`、`SKILL_DIR_TAIL = '<包根>/skills/ppt-master'`（**逐字含尖括号**的展示串——`<包根>` 是卡片显示的符号占位、非模板变量）；测试侧定义 `PACKAGE_ROOT_ABS = dirname(CLIENT_ENTRY)`（包根绝对路径，供 T2①⑤ 的不泄漏断言）。卡片读面 DOM 契约（**T3 依赖的元素定位锚**）：
  - 根元素 `<div className="ppt-master-config-card">`；
  - 版本块 `<div className="ppt-master-config-versions">`，内含 `version.plugin` + `PLUGIN_VERSION`、`version.upstream` + `UPSTREAM_VERSION`、`version.skillDir` + `version.skillDirValue`；版本块内**不得出现**其它版本类串（如宿主版本 `0.2.0`——T2①③ 的 `every()` 以此为前提）；
  - 开关 `<button type="button" role="switch" aria-checked={enabled === true} className="ppt-master-config-switch">`（可访问名＝`field.enabled.label` 文本；`disabled` 当 `baseline.enabled === undefined`）；
  - 路径 `<label htmlFor="ppt-master-config-path">` + `<input id="ppt-master-config-path" type="text" className="ppt-master-config-input" value={staged.path ?? ''}>`（`onChange` 读 `event?.target?.value`；`onKeyDown` 见 Escape 契约；`disabled` 当 `baseline.path === undefined`）；
  - 策略 `<label htmlFor="ppt-master-config-policy">` + `<select id="ppt-master-config-policy" className="ppt-master-config-select">`，两个 `<option value="keep"|"delete">`（文本＝`option.keep`/`option.delete`；`disabled` 当 `baseline.oldPathPolicy === undefined`）；
  - 三个提示 `<p className="ppt-master-config-hint">`（`field.enabled.hint` / `field.path.hint` / `reset.hint`）；两处状态提示 `<p className="ppt-master-config-status" role="status">`（readOnly / memory）；
  - Escape 契约：路径框 `onKeyDown` 收到 `event?.key === 'Escape'` → 该字段暂存值回落 `baseline.path`（其余字段不动）。
  - **暂存态（本 Task 落地，T3 消费）**：`staged = { leaves: { enabled, path, oldPathPolicy }, baseRevision }`（`useState` 第二槽）；`baseRevision === undefined` 时由第二个 `useEffect` 在首个 `ready` 快照上初始化为该快照的基值与 `revision`；此后暂存态**不因快照换代而丢弃**（脏判定按当前基值现算）；开关 `onClick`、输入 `onChange`、选择器 `onChange` 只改暂存态，**不发**任何宿主写。**hook 计数钉死：2 个 `useState`（snapshot、staged）＋ 2 个 `useEffect`（holder 订阅；暂存态初始化）。**

- [ ] **Step 1: 写失败测试**（Review Focus #1、#5）— 追加：
  1. `版本块: 两条配对断言 + 相对尾部 + 不泄漏绝对路径`：读 `package.json.version`（`pkgVersion`）与 `skills/ppt-master/SKILL.md` 的 `metadata.version`（`upstreamVersion`，复用 `../lib/skill-provider.js` 的 `parseFrontmatter`）；令 `tokens = textOf(tree).match(/\b\d+\.\d+\.\d+(?:-r\d+)?\b/g) ?? []`，断言 ① `tokens.includes(pkgVersion)`（插件版本常量 ≡ `package.json.version`）；② `tokens.includes(upstreamVersion)`（上游版本常量 ≡ SKILL.md `metadata.version`）；③ 归一化配对（**不做三值相等**）：`tokens.every((t) => new RegExp('^' + escapeRe(upstreamVersion) + '(-r\\d+)?$').test(t))`；③′ 常量间显式配对：`assert.match(pkgVersion, new RegExp('^' + escapeRe(upstreamVersion) + '(-r\\d+)?$'))`——不依赖渲染面 token（上游版本串缺席时 `every()` 仍成立，此断言直接钉住"插件版本＝上游版本＋可选 `-rN`"）；④ 文本含 `'<包根>/skills/ppt-master'`；⑤ `textOf(tree).includes(PACKAGE_ROOT_ABS) === false`（不泄漏绝对 SKILL_DIR）。
  2. `开关: role/aria-checked/点击改暂存态不改宿主`：初始 `role === 'switch'`、`aria-checked === false`；调用其 `props.onClick()` 后 `settle()` → `aria-checked === true`；`calls.mutates.length === 0`。
  3. `开关契约文案（关闭态，双语）`：zh 下 `field.enabled.hint` 文本含 `'不删除任何目录'`、`'容器'`、`'python3'`；切 `activeLocale = 'en'` 后 `settle()`，文本切换且含 `'no directory'`、`'container'`、`'python3'`（同一用例内两段断言：既验证文案正确、又验证跟随界面语言）。
  4. `路径文案（非法路径）`：zh 下 `field.path.hint` 文本含 `'配置无效'` 与 `'保存'`（预告"保存照常成功、插件侧按配置无效降级"）。
  5. `重置文案`：zh 下 `reset.hint` 文本含 `'config 键'`（预告宿主会删掉 config 键、三字段回落继承层）。
  6. `控件焦点与 Escape`：`input`/`select`/`button` 均原生元素且 `props.tabIndex === undefined`；标签关联成立（`label.props.htmlFor === input.props.id`）；在路径框暂存 `'B'` 后触发 `onKeyDown({key:'Escape'})` → `settle()` → 该 input `value` 回落到基值、另一字段的暂存值不变。
  7. `readOnly 与 memory 提示`：`{status:'ready', writable:false}` → 渲染 `state.readOnly` 文案且控件 `disabled`；`{status:'unavailable', writable:false, mode:'memory'}` → 渲染 `state.memory` 文案且文本含 `'不会写入宿主配置'`；两文案**不同时**出现于同一行（分别 `text.includes` 断言互斥）。
  8. `敌意快照容错（Review Focus #1）`：逐例渲染不抛——①`{status:'weird'}`（落 loading 文案）；②`{status:'ready', value:null}`；③`{status:'ready', value:{}}`（`venv` 缺失 → 三控件 `disabled`、`value` 为空串、`aria-checked === false`）；④`{status:'ready', value:{venv:{enabled:'yes', path:42, oldPathPolicy:'nope'}}}`（类型不符 → 三控件 `disabled`）。
  9. `渲染冒烟（设计 §7.4，SlotAssemblyError 触发条件规避）`：`status==='ready'` 且三叶子齐备时遍历整棵树，断言 ①每个元素 `type` 为字符串（无子组件、无 Fragment）；②根元素 `className === 'ppt-master-config-card'`（卡片唯一定位锚）；③渲染全程无异常（`assert.doesNotThrow`；`SlotAssemblyError` 的装配期触发条件已由 T1⑧/T1⑪ 的注册面断言与本条渲染面断言双向覆盖）。

- [ ] **Step 2: 运行确认失败** — `node --test tests/client-half.test.mjs` → FAIL：追加 9 例红（版本块缺失 → `textOf` 不含版本串；`role="switch"` 不存在；三处文案未渲染；Escape 无效），T1 的 16 例保持绿。

- [ ] **Step 3: 实现** — 在 `Card` 内加读面：`const snapshot = readSnapshot(holder.get())`；三态壳分支（`unconfigured`/`loading`/`unavailable`）之外的 `ready` 分支渲染版本块 + 三字段 + 提示；`readVenv` 供 T3 复用（本 Task 即落地，字段渲染消费它）；`PLUGIN_VERSION`/`UPSTREAM_VERSION`/`SKILL_DIR_TAIL` 为**手写字面量常量**（与 `package.json`/`SKILL.md` 的一致性由本 Task 的两条配对断言守护）。26 键字典的**键集由 T1⑦ 钉死**；**被后续断言的值子串由 T2③④⑤、T3⑤⑥ 钉死**（DICT 值在 T1 随实现落地后即不可移；本 Task 只渲染与断言），文案须覆盖三项后果——关＝用系统 `python3` 且不删除任何目录（容器用户一眼判定"不需要开"）、路径非法不由 schema 拦（保存照常成功、插件侧按"配置无效"降级）、重置会删宿主 config 键（三字段回落继承层）。

- [ ] **Step 4: 运行确认通过** — `node --test tests/client-half.test.mjs` → PASS（25 例）；`node --test tests/*.test.mjs` → 全量全绿；`node scripts/check-dsh-compat.mjs` → OK。

- [ ] **Step 5: Refactor（可选）** — 三个字段的"label + 控件 + hint"结构若重复三遍，抽 `renderField(id, labelKey, hintKey, control)` 一个只返回元素的本地函数（仍只用 `createElement`，不新增 hook）。

- [ ] **Step 6: Commit** — `git add lib/client.js tests/client-half.test.mjs && git commit -m "feat(client): 卡片读面——版本块、三字段控件与后果文案（设计 §5.3/§5.4）"`

### Task 3: 卡片写面（暂存态 / 嵌套 path ops / 保存与重置 / 两类可观测量）

**Files:**
- Modify: `lib/client.js`
- Test: `tests/client-half.test.mjs`（追加）

**Interfaces:**
- Consumes: T1 的 `holder` / `readSnapshot`、T2 的 `readVenv` 与读面 DOM 契约。
- Produces: `buildSetOps(baseline, staged) -> Array<{op:'set', path:['venv',string], value:any}>`（**固定叶子顺序** `enabled → path → oldPathPolicy`；仅当 `baseline[leaf] !== undefined && staged[leaf] !== baseline[leaf]` 产出一条）；`baseline` **取自当前快照**（非 `staged` 内冻结值——`staged.baseRevision` 仅用于暂存态初始化，脏判定恒按当前基值现算）；`RESET_OPS = [{op:'unset',path:['venv','enabled']}, {op:'unset',path:['venv','path']}, {op:'unset',path:['venv','oldPathPolicy']}]`（模块级冻结常量）；卡片动作元素：`<button type="button" className="ppt-master-config-button">`（保存）与同形（重置），保存 `disabled = !(status==='ready' && writable===true) || ops.length === 0`，重置 `disabled = !(status==='ready' && writable===true)`；两按钮 `props.onClick` **返回 Promise**（可测性契约，React 事件处理器返回值无副作用）；notice 元素 `<p className="ppt-master-config-notice" role="status">`，文案＝`notice.pending` / `notice.saved` / `notice.rejected` / `notice.transportError` + 追加的错误消息；hook 计数在 T2 的 2 `useState` / 2 `useEffect` 之上**只增加第 3 个 `useState`（notice）**。
- 写路由契约：`commit(ops)` → `form.mutate(ops, revision)`（**方法形态**调用；`revision` 取**当前**快照的 `revision`，可为 `undefined`）；`outcome === true` → `notice.saved`，否则 `notice.rejected`；`throw` → `notice.transportError` + `String(error?.message ?? error)`；**不改写**任何本地基值、**不**自行 bump revision；`ops.length === 0` 或 `form` 未接入 → 返回 `false` 且**不发** `mutate`。

- [ ] **Step 1: 写失败测试**（Review Focus #3、#4）— 追加（假表单：`mutate` 以 `this` 自校验方法形态、记录 `structuredClone(ops)` 与 `revision`、按用例设定 resolve/reject；`subscribe` 记录退订）：
  1. `set ops: enabled`：点开关（暂存 true）→ 点保存 → `calls.mutates` 恰 1 条，`ops` 深比较 `[{op:'set', path:['venv','enabled'], value:true}]`，`revision === 7`（假快照 revision）。
  2. `set ops: path`：路径框 `onChange({target:{value:'/srv/venv'}})` → `settle()` → 保存 → `ops` 深比较 `[{op:'set', path:['venv','path'], value:'/srv/venv'}]`。
  3. `set ops: oldPathPolicy`：选择器 `onChange({target:{value:'delete'}})` → `settle()` → 保存 → `ops` 深比较 `[{op:'set', path:['venv','oldPathPolicy'], value:'delete'}]`。
  4. `重置：一次调用三个 unset、嵌套 path、顺序固定`：点重置 → `calls.mutates.length === 1`，`ops` 深比较 `RESET_OPS` 三元素（顺序 `enabled/path/oldPathPolicy`），`revision === 7`。
  5. `两类可观测量①（resolve false）`：`mutate` resolve `false` → `await button.props.onClick()` 不抛；`textOf` 含 `notice.rejected` 全文与一般化提示子串 `'更高优先级'`；`assert.equal(text.includes(DICT.zh['notice.saved']), false)`；路径框仍显示暂存值。
  6. `两类可观测量②（reject）`：`mutate` reject `new Error('boom')` → 不抛；`textOf` 含 `notice.transportError` 与 `'boom'`；`assert.equal(text.includes(DICT.zh['notice.rejected']), false)`（两类不混用）。
  7. `revision 时效（Review Focus #3）`：rev 7 保存一次 → 假快照换代 rev 8 并广播 → 再改字段保存 → 第二次 `mutate` 的 `revision === 8`，且第一条 `ops` 记录未被后续调用改写（`structuredClone` 记录的深比较仍成立）。
  8. `无乐观更新`：`mutate` resolve `true` 但**不**广播新快照 → 保存按钮 `disabled === false`（仍为脏）；随后广播新快照（值＝暂存值）→ `settle()` 后保存按钮 `disabled === true`。
  9. `空脏集与写门（Review Focus #1/#4）`：①未改动即点保存 → `calls.mutates.length === 0` 且按钮 `disabled === true`；②`{status:'loading'}` 与 `{status:'ready', writable:false}` 两行 → 两按钮 `disabled === true`、点击不发 `mutate`；③`{status:'unavailable', writable:false, mode:'memory'}` → `state.memory` 提示在场、两按钮禁用；④`{status:'ready', writable:true, revision:undefined}` → 渲染不抛、改字段后可保存、`mutate` 收到的第二参为 `undefined`（Review Focus #1 的 `revision` 缺失形态，子例形式入 ⑨ 不另计用例数）。
  10. `pending 态`：`mutate` 返回未决 Promise（用手工可控的 deferred）；点击保存**不 await**（拿到该 Promise 存起来）→ `settle()` → `textOf` 含 `notice.pending` 且不含 `notice.saved`；随后 resolve deferred → `await` 该 Promise → `settle()` → 含 `notice.saved`。

- [ ] **Step 2: 运行确认失败** — `node --test tests/client-half.test.mjs` → FAIL：追加 10 例红（无保存/重置按钮、无 `mutate` 调用），T1/T2 的 25 例保持绿。

- [ ] **Step 3: 实现** — 在 `Card` 内加写面：notice 态（第 3 个 `useState`）、`buildSetOps` / `RESET_OPS` / `commit`、两按钮与 notice 元素（暂存态与 holder 订阅已由 T2 落地，本 Task 不新增 `useEffect`，也不新增除 notice 外的 hook 槽）。**注意**：实现里不得出现"保存后自行清理暂存值"的乐观路径——脏判定只按当前基值现算。

- [ ] **Step 4: 运行确认通过** — `node --test tests/client-half.test.mjs` → PASS（35 例）；`node --test tests/*.test.mjs` → 全量全绿；`node scripts/check-dsh-compat.mjs` → OK；`node scripts/verify-plugin.mjs --upstream .upstream/refs/tags/v6.7.0@b4efe3ddf237a97a42880164759162f8e2412f2f` → OK。

- [ ] **Step 5: Refactor（可选）** — 保存与重置共有 `commit` 与按钮渲染；若两按钮的 props 组装重复，抽 `actionButton(labelKey, ops, enabled)` 一个本地函数（保持 `onClick` 直接传 `commit` 绑定以保证返回 Promise）。

- [ ] **Step 6: Commit** — `git add lib/client.js tests/client-half.test.mjs && git commit -m "feat(client): 卡片写面——嵌套 volatile path ops 与两类失败可观测量（设计 §5.5/§6）"`

### Task 4: compat 脚本 §7.7⑥（客户端半边 stub 装载与注册）

**Files:**
- Modify: `scripts/check-dsh-compat.mjs`（新增⑥判断体与接线，并**同步改写脚本内三处"五项"→"六项"注释**（:43 文件头、:105 判据锚分节、:603 主流程分节；Step 3）；既有 ①–⑤ 判据、默认值交叉锚定、rank、漂移、CLI 行为一律不动）
- Test: `tests/client-half.test.mjs`（追加）

**Interfaces:**
- Consumes: T1 的 `loadEntry` 形态（`window.__ModuleLoader__.load({id, factory})` + 假 `require` + 假 `ctx`）。
- Produces（compat 脚本新增导出面）:
  - `export const PLUGIN_CLIENT_ENTRY = fileURLToPath(new URL('../lib/client.js', import.meta.url))`；
  - `export function checkClientHalf({ clientEntry = PLUGIN_CLIENT_ENTRY } = {}) -> { problems: string[], note: string|null }`——用 `new Function('window', source)(stubWindow)` 装载（**当前 realm** 求值：`vm.runInNewContext` 产出的对象跨 realm，`deepStrictEqual`/字符串比较虽可用但对象面不必要地跨界，统一取当前 realm），假 `require` 仅解析 `react` 系，假 `ctx` 记录 `inject`/`effect`/`locale.register`/`slots.inject`/`slots.register`，随后断言四要素：① 载荷 `id === BUNDLE_INSERT_ID`（`dsh-ppt-master-wrapper`）；② 插件面 `inject` 恰含 `slots`/`locale`（不含 `configForms`）且 `apply` 为函数；③ `ctx.inject` 收到 `['configForms']`；④ `slots.register` 的 options 为 `{name:'plugins.bundle.config', key: BUNDLE_INSERT_ID, locale:'dsh-ppt-master-config'}`。任一失败 → `problems` 前缀逐字 `§7.7⑥ `；全通过 → `note` 前缀逐字 `§7.7⑥ 客户端半边`，且 `note` 须逐字列出**四个证据串**——loader `id`（＝包名 `dsh-ppt-master-wrapper`）、槽位名 `plugins.bundle.config`、locale ns `dsh-ppt-master-config`、接入方式 `configForms`（供 T4 用例 1 的三标记断言证明非空跑）。
  - 接线：⑥判断体**并入 `reportStaticChecks` 函数体**（落在既有 ③④ 判断之后）；该函数在 `runCompatCheck` 内有**两个调用点**（装载失败路 `pluginNamespace === null` 分支、约 :660；装载成功路、约 :754），各执行一次 ⇒ ⑥ 随之**两路各出现一次**（装载失败路径同样给出⑥结论，与③④同纪律）；**不新增独立调用点**。`clientEntry` 由 `runCompatCheck` 的 deps 透传（测试注入缝，生产缺省＝真实文件）。

- [ ] **Step 1: 写失败测试** — 追加：
  1. `§7.7⑥: checkClientHalf 对真实 lib/client.js 全绿`：`import { checkClientHalf, PLUGIN_CLIENT_ENTRY } from '../scripts/check-dsh-compat.mjs'`；`assert.equal(PLUGIN_CLIENT_ENTRY.endsWith('/lib/client.js'), true)`；`const r = checkClientHalf()`；`assert.deepEqual(r.problems, [])`；`assert.match(r.note, /^§7\.7⑥ 客户端半边/)`；`note` 同时命中 `dsh-ppt-master-wrapper`、`plugins.bundle.config`、`configForms` 三个标记（证明 ①–④ 四项检查与 note 证据串非空跑）（note 的第 4 串 locale ns 不在用例 1 断言内——由 ①–④ 要素断言覆盖，不重复断言）。
  **负向改写基准＝T1 Step 3 骨架的逐字文本**：先把真实 `lib/client.js` 复制到 tmpdir，再按下列各用例的唯一定位规则做文本替换；若某锚点在实现中出现多次，以 T1 契约指定处为准并在替换前断言唯一匹配。
  2. `§7.7⑥ 负向: inject 缺 locale → problems 指名`：把真实源复制到 tmpdir 并把 `inject: ['slots', 'locale']`（face 返回对象行内）文本替换为 `inject: ['slots']` → `checkClientHalf({clientEntry})` 的 `problems` 有且仅有含 `§7.7⑥` 的条目。
  3. `§7.7⑥ 负向: loader id 非包名`：把 `id: 'dsh-ppt-master-wrapper'` 替换为 `id: 'other-plugin'`（以 `id: '` 前缀消歧后唯一——实现文件内包名字符串另有 NS/name 等多处，全局不唯一）→ `problems` 含 `§7.7⑥` 且文本含包名与 `other-plugin`。
  4. `§7.7⑥ 负向: 无 apply / apply 空转`：①删 `apply` 导出＝移除 face 返回对象中的 `apply` 键值对 → `problems` 含 `§7.7⑥`；②`apply` 体置空＝保留签名、体内仅 `/* noop */`（不动其余）→ `problems` 含 `§7.7⑥`（槽位未注册）。
  5. `§7.7⑥ 负向: require Harness 客户端包 / 含 import 语句`：①把 `require('react')` 替换为 `require('@deepseek-ai/dsh-client-ui-primitives')`（定位＝`const React = require('react')` 的**字符串字面量**恰一处；仅替换该字面量，**不得触碰** `factory: (require) =>` 形参）→ `problems` 含 `§7.7⑥`（假 require 拒绝并如实转 problems，不抛）；②在文件首行前插入 `import 'x';` → `new Function` 抛 `SyntaxError` → `problems` 含 `§7.7⑥` 且不冒泡。

  **接线验证方式（不写 hermetic 集成用例）**：`runCompatCheck` 在 SDK 定位失败时提前返回、不进入第 7 步报告段，故不能用"缺 `dshModules`"的调用来断言⑥行在场；重建 `tests/compat.test.mjs:398` 起的 `makeStubSdk`（函数体约 :398–:541、约 144 行）代价过高（见偏差登记 10）。故⑥的**全流程行在场**由 Step 4 的两条命令守卫：`node scripts/check-dsh-compat.mjs` 实跑断言 stdout 含 `§7.7⑥ 客户端半边` 行；`node --test tests/compat.test.mjs` 的既有 `runCompatCheck 基线: stub SDK 全绿`（`problems` 空集）与 `CLI: §7.7 五项断言行 … → exit 0` 保持绿（⑥ 若在真实文件上失败，该 `problems` 空集用例即转红）。

  **守卫机理与既有用例名登记**：① `problems` 空集用例对⑥的守卫力来自——该桩跑调用形为 `runCompatCheck({ dshModules, env })` **不传 `clientEntry`** ⇒ ⑥ 以缺省真实 `lib/client.js` 运行；且该用例断言 `problems` **空集** ⇒ 装载失败路会向 `problems` 压入『§7.7①/②/⑤ 无法判定：插件入口装载失败』⇒ 空集即证该桩跑必走约 `:754` 装载成功路（行号按当前版本；⑥判断体插入后该行及后续行号自然下移，定位一律以代码文本为准）（`reportStaticChecks` 两调用点之一）⇒ ⑥ 在该用例内于真实文件上执行。② 既有两条用例名含"五项"字样（`runCompatCheck §7.7 五项…` 与 `CLI: §7.7 五项断言行…`）在 stdout 变六行后**名实不符但保持字面不动**（`tests/compat.test.mjs` 零改动约束优先；二者只断言 ①–⑤ 在场、不排斥 ⑥，不会转红）——此名实不符已知并接受，不改名。（另注：`tests/compat.test.mjs` 内共 5 处"五项"字样——两条用例名＋3 处注释——一律随零改动约束**保持不动**；"三处注释改写"仅指 `scripts/check-dsh-compat.mjs` 内的 :43/:105/:603。）

- [ ] **Step 2: 运行确认失败** — `node --test tests/client-half.test.mjs` → **整文件加载期失败**：静态 `import { checkClientHalf, PLUGIN_CLIENT_ENTRY } from '../scripts/check-dsh-compat.mjs'` 在两导出尚不存在时于模块加载期抛 `SyntaxError: The requested module … does not provide an export named 'checkClientHalf'`，node --test 报 `# tests 1 / # fail 1`（**单条红＝整文件**；静态 import 属模块级依赖，无法逐例隔离）；T1–T3 的既有例在本步**不可观测**，待 Step 3 落两导出后于 Step 4 复验 40 例全绿。

- [ ] **Step 3: 实现** — 追加 `PLUGIN_CLIENT_ENTRY`、`checkClientHalf`、`reportStaticChecks` 内的接线与 `runCompatCheck` 的 `clientEntry` 透传；脚本内三处"五项"注释（:43 文件头、:105 判据锚分节、:603 主流程分节）改为"六项"，并在 :43 文件头处补⑥一行说明（按代码文本定位）。**不得**改动 ①–⑤ 任何判据、不得放宽 `problems` 判定。

- [ ] **Step 4: 运行确认通过** — `node --test tests/client-half.test.mjs` → PASS（40 例）；`node --test tests/compat.test.mjs` → 全绿（**既有基线不回归**：`problems` 空集用例即⑥的正向集成守卫）；`node --test tests/*.test.mjs` → 全量全绿；**实跑** `node scripts/check-dsh-compat.mjs` → exit 0 且 stdout 出现 `§7.7⑥ 客户端半边` 行，并与 ①–⑤ 五行并存（缺一即未完成）。

- [ ] **Step 5: Refactor（可选）** — `checkClientHalf` 与 `tests/client-half.test.mjs` 的 `loadEntry`/假 `require` 夹具逻辑同形；**不合并**（测试不得依赖被测脚本的测试替身），仅在两处注释中互相指认，避免日后单边漂移。

- [ ] **Step 6: Commit** — `git add scripts/check-dsh-compat.mjs tests/client-half.test.mjs && git commit -m "feat(compat): §7.7⑥ 客户端半边 stub 装载与注册断言（既有①–⑤不弱化）"`

### Task 5: README 配置入口与诊断更新

**Files:**
- Modify: `README.md`（「### venv 配置说明」段、「### 诊断」段（含其下"配置页诊断"条目）、「## 本地校验（开发）」的 compat 注释行三处；当前约在 57–108 与 141–144 行，行号仅作定位辅助，一律按引用文本定位）
- Test: `tests/client-half.test.mjs`（追加文档契约断言）

**Interfaces:**
- Consumes: T1–T4 的产物（声明面、卡片、compat⑥）。
- Produces: README 中四段可断言文本：①「插件页卡片（本版可用）」bullet（含"插件页 → 已安装 → `dsh-ppt-master-wrapper`"路径、三字段 + 版本信息块、保存走 volatile 快路径**免重启生效**、中英双语跟随界面语言、**memory 模式提示**"本次会话不会写入宿主配置"）（"三字段＋版本信息块、双语跟随界面语言"为叙述性内容，不入 Step 1 断言——由 T2③ 运行时用例守卫）；②「重启边界」bullet（改 `dsh.client` / `exports["./client"]` 需重启；仅改 `lib/client.js` 免重启，stat 轮询热更新； profile patch 手工编辑仍不热生效、需重启）；③「配置页诊断」改写（卡片不出现时的四层排查：声明面是否生效（改后需重启）→ 宿主页 `dsh-client-ui-plugin-manager` 是否在（槽位无人声明 ⇒ 卡片不出现）→ `configForms` 服务缺失 ⇒ 卡片显示"配置通道不可用" → 老宿主不认 `dsh.client` ⇒ 安静降级、插件功能不受影响；硬服务 `slots`/`locale` 缺失 ⇒ `apply` 不被调用、宿主上报 `pending (waiting for service…)`）；④ compat 说明行"spec §7.7 五项设计成立性前置检查" → "六项"并补"客户端半边 stub 装载与注册"。

- [ ] **Step 1: 写失败测试** — 追加文档契约用例（读 `../README.md` 文本）：①含复合子串 `插件页`、`已安装`、`dsh-ppt-master-wrapper`、`免重启生效`（**防改前即绿**：现 README 已含"插件」页"与"Python 依赖已安装"等语义无关命中 ⇒ `插件页`/`已安装` 均不构成红灯，本条唯一有效红灯承担者＝`免重启生效`）；②含 `不会写入宿主配置`；③含 `dsh.client` 与 `exports\["\.\/client"\]|exports\['\.\/client'\]` 两种拼写之一 + `重启`（**防改前即绿**：`重启` 在现 README 已有（"重启 DSH"等）不构成红灯，本条红灯承担者＝`dsh.client`/`exports` 拼写）；④含 `§7.7` 与 `六项`；⑤负向断言（与 GC 禁语一一对应）：不含 `保存后插件实例重建`、`保存后需重启`、`保存需重启` 三类被推翻措辞（三类为 GC 禁语的**子串覆盖**——`保存需重启` 覆盖 GC 的"保存需重启才生效"）；**保护另一通道语义**——README 既有"patch 手工编辑→重启 DSH 生效"（现约 L75、加粗形态）属 profile 手工通道、仍然为真，改写时**不得删除**，并加正向断言：README 仍含 `重启 DSH`。
- [ ] **Step 2: 运行确认失败** — `node --test tests/client-half.test.mjs` → FAIL（追加 5 条红：README 无卡片路径/无六项字样），T1–T4 用例保持绿。
- [ ] **Step 3: 实现** — 按 Produces 四段改写 README（**键名与配置写法不变**：`venv.enabled` / `venv.path` / `venv.oldPathPolicy`；不得写"保存后插件实例重建"）。
- [ ] **Step 4: 运行确认通过** — `node --test tests/client-half.test.mjs` → PASS（45 例）；`node --test tests/*.test.mjs` → 全量全绿；`node scripts/check-dsh-compat.mjs` → OK。
- [ ] **Step 5: Refactor（可选）** — 若「配置入口」段与「诊断」段出现重复的排查叙述，抽为一条"分层排查"清单，两处引用同一清单文本。
- [ ] **Step 6: Commit** — `git add README.md tests/client-half.test.mjs && git commit -m "docs(readme): 插件页卡片入口、重启边界与 memory 模式提示"`

### Task 6: 2026-10-15 spec 勘误回写与全量收尾

**Files:**
- Modify: `docs/superpowers/specs/2026-10-15-ppt-master-venv-config-design.md`（设计 §9 要求的三处回写；**行号仅作定位辅助**——以引用文本为准）
- Test: `tests/client-half.test.mjs`（追加文档契约断言）

**Interfaces:**
- Consumes: T1–T5 全部产物；设计 §9 的回写清单。
- Produces: 该 spec 内三处可断言文本——① **㉗ 指针**：「GUI 出页属**新特性**（须反转 §2 非目标，另立项）」（现约第 14 行）与「属**新特性**，另行立项」（现约第 20 行）两处各追加同一指针句（指向 `docs/superpowers/specs/2026-10-16-ppt-master-config-ui-design.md`，并注明"已立项交付"）；② **§7.7 六项**：「验证面**扩展为 §7.7 五项全映射**」（现约第 165 行）改为「验证面**扩展为 §7.7 六项全映射**」并在括注清单末尾补 `+ 客户端半边 stub 装载与注册`；③ **机制更正**：`- **4.1 配置变更**：…` 与 `- ② 宿主 config-editor 编辑通道：…` 两行各追加一条 `〔勘误 ㉙（2026-10-16 config-ui 特性回写）〕`：三叶子全 volatile ⇒ config-editor `edit()` 保存走宿主 **volatile 快路径**（只写 `fiber._config` + `_commitVolatile()` → `loader/volatile-update`，**不 remount、不重跑 `apply`**），原「Loader 重建插件实例」措辞对本 Config 不成立；入口 skill 正文/工具行为随 volatile 引用原地换代。**键名与 schema 不动**。

- [ ] **Step 1: 写失败测试** — 追加文档契约用例（读该 spec 文本，令 `spec` 为该文件全文）：① 取 `spec.split('\n').filter((line) => line.includes('新特性'))`，断言该集合非空且每行都含 `2026-10-16-ppt-master-config-ui-design.md`（至少两行，即「须反转 §2 非目标，另立项」与「另行立项」两处）；② `assert.match(spec, /§7\.7 六项全映射/)` 且同一行含 `客户端半边`；③ ㉙**按行定位**：`const eLines = spec.split('\n').filter((l) => l.includes('㉙'))` → `eLines.length === 2` 且其中恰一行含 `4.1 配置变更`、恰一行含 `② 宿主 config-editor 编辑通道`（**必须带 `②` 前缀**——L50 行内另有无前缀的"宿主 config-editor"描述，裸串会双命中致断言永红；两锚点行各得一条 ㉙，`②` 前缀即用于区别）；且 `spec` 含 `volatile 快路径` 与 `不 remount`。
- [ ] **Step 2: 运行确认失败** — `node --test tests/client-half.test.mjs` → FAIL（追加 3 条红），T1–T5 用例保持绿。
- [ ] **Step 3: 实现** — 按 Produces 逐处回写（逐条勾销，缺一即未完成）。此步**不动**任何代码路径。
- [ ] **Step 4: 运行确认通过（收尾）** — `node --test tests/client-half.test.mjs` → PASS（48 例）；`node --test tests/*.test.mjs` → **全量全绿**（`# tests` 计数＝527＋48＝575，`# fail 0`）；`node scripts/check-dsh-compat.mjs` → exit 0 且 §7.7①–⑥ 六行齐；`node scripts/verify-plugin.mjs --upstream .upstream/refs/tags/v6.7.0@b4efe3ddf237a97a42880164759162f8e2412f2f` → OK（vendor `skills/` 字节零漂移）；`git status --porcelain` → 仅本特性的五个文件（`lib/client.js`、`package.json`、`tests/skeleton.test.mjs`、`tests/client-half.test.mjs`、`scripts/check-dsh-compat.mjs`）与两个文档（`README.md`、2026-10-15 spec）。
- [ ] **Step 5: Refactor（可选）** — 文档无重复可提取：本 Task 只做三处定点回写，不重排他节。
- [ ] **Step 6: Commit** — `git add docs/superpowers/specs/2026-10-15-ppt-master-venv-config-design.md tests/client-half.test.mjs && git commit -m "docs(spec): ㉗ 指针、§7.7 六项与 volatile 快路径机制更正（设计 §9 回写）"`

---

## 计划侧增量与偏差登记（供审查逐条裁决）

1. **`tests/skeleton.test.mjs` 的 exports 键集修订**：Global Constraints 已声明——`exports["./client"]` 与该用例的 `Object.keys(pkg.exports).sort()` 逐字深比较**数学上互斥**，故唯一的既有测试改动是这一条用例（追加一条断言 + 期望数组补一项），不弱化任何既有断言。已在"存疑点①"上报。
2. **第三条不可用文案 `state.unconfigured`**：设计只硬性要求 `loading` 与 `unavailable` **不混用文案**；"`configForms` 缺席 ⇒ 卡片渲染为不可用态"未指定是否复用 `unavailable`。本计划拆出第三条（服务缺失 vs 命名空间未暴露），便于 README 分层诊断。
3. **`dsh.client.external: ["react"]` 的实测反证**：本机六个已装客户端插件（`dsh-context` / `dsh-mnemon` / `dshmarket` / `dsh-better-sidebar` / `dsh-mcp-connector` / `dsh-cherry-bridge`）**无一**声明 `external`，而 `dsh-context`/`dsh-mnemon` 的 bundle 均 `require("react")`/`react-dom`/`react/jsx-runtime`；`@deepseek-ai/dsh-client-modules` 的 `arriveGraphRow` 对 seed 词直接 `continue` ⇒ 强烈指向 react 已是平台种子词（设计 §8 V5 的"若实测为基线则删除该字段"**曾被触发，但经监督者裁决不执行**——见"存疑点与裁决记录"②）。**处置**：按硬事实与设计 §5.1 保留 `external: ["react"]`（对 seed 词为无害显式声明），把实测结论登记回写 §8 V5（已按勘误 V5′ 落实，监督者裁决：保留声明，见下"存疑点与裁决记录"②）。
4. **`resolveNamespace` 兜底判定**：设计 §5.2 只写"以 `configForms.describe()` 的 served-namespace 目录解析 ns 兜底"；本计划把判定钉为四例（见 T1 Produces），并**不**引入第三种卡片状态（目录只用于选 ns，状态仍只看快照 `status`）。
5. **`SlotAssemblyError` 触发条件规避**：注册项不声明 `children`、不声明 session 子槽、`locale` 走硬 inject ⇒ **服务本身必在场**（故不构成 `SlotAssemblyError` 的缺失触发条件）；其**方法级失败**（如 `locale.register` 抛错）另由 T1⑫ 覆盖——T1⑧/T2⑨ 断言；卡片渲染全程不抛（T2⑨）。
6. **`onClick` 返回 Promise**：仅为让测试可 `await` 结算；React 事件处理器返回值无副作用，生产行为不变。
7. **Escape 语义**：设计仅要求"保留焦点与 Escape"；本计划钉为"Escape 使该字段暂存值回落基值"。
8. **写门不读 `mode`**：`mode==='memory'` 走"常显提示"，写门仍严格取 `status==='ready' && writable===true`（与设计"必读 writeable/mode"两字段各自用途一致；实测 memory 持久化下 `status` 恒 `'unavailable'`、`writable` 恒 `false`，按钮自然禁用）。
9. **卡片只渲染原生元素 / 只用两种 hook（`useState` 至多 3 处、`useEffect` 至多 2 处调用）**：为本特性测试策略（元素树文案断言 + 最小 hook 运行时）所必需的实现约束，非外部契约。
10. **§7.7⑥ 全流程行在场的验证方式**：不重建 `tests/compat.test.mjs:398` 起的 `makeStubSdk`（函数体约 :398–:541、约 144 行，重复代价过高）；改以"Step 4 实跑命令断言 ⑥ 行出现"＋"既有 `runCompatCheck 基线: stub SDK 全绿`（`problems` 空集）作为正向集成守卫"（守卫机理见 T4"接线验证方式"段）。

## 验收期人工步骤（设计 §9 照搬；用户触发，不入自动化测试面）

- [ ] **前置（D2 已裁决）：实现完成后由用户重启容器一次**——该次重启同时交付：venv 配置 patch 生效 ＋ 客户端半边首次装载（宿主半边代码已在 2026-10-16 12:16:43 那次重启装载）。
- [ ] 1. 重启后打开插件页 →「已安装」→ `dsh-ppt-master-wrapper` → 包详情页出现配置卡片（三字段 + 版本信息块）。
- [ ] 2. 界面语言中/英各看一次，文案随之切换。
- [ ] 3. 改 `venv.enabled`（或 `venv.path`）保存 → 核对 `ppt_master_check_env` 的 `venv.enabled` 转 `true`、`path` 为所配值；观察是否**免重启**换代（预期：volatile 原地换代，无需重启）；记录 profile patch 写入形态（改 config / 删条目）。
- [ ] 4. 降级验证：**"宿主页缺席"形态**（若可得）⇒ 卡片不出现但插件功能正常；本机不可得则登记**未覆盖**。
- [ ] 5. **登记项**：① **未覆盖**——"宿主代建 profile 条目"分支（本机已有手工条目 ⇒ 只会就地更新，不可观测）；② **未覆盖**——"老宿主不认 `dsh.client`"（无旧宿主环境）；③ **已覆盖**——"实测通过宿主版本＝`0.2.0-rc.2`"（对应设计 §8 R1 的宿主下限登记）。
- [ ] 6. 迭代面：首次装载后，改 `lib/client.js` 走 stat 轮询热更新（免重启）；改 `dsh.client` / `exports` 需再重启。

---

## Self-Review 记录

1. **设计覆盖度逐条映射**：§5.1（`package.json` 声明面、`inject` 语义、`external`、禁 require Harness 包）→ T1（用例 3–6、16）；§5.2（客户端文件契约、require 白名单、cordis 插件面、硬/可选依赖、注册与生命周期、槽位键与 ns、locale ns）→ T1（用例 1–2、7–14），其中每注册点隔离 → T1⑫、订阅回收 → T1⑬、ns 兜底 → T1⑩；§5.3（卡片 UI 五区域（保存/重置计一）、自绘控件、role/aria/Escape、保存/重置自持、文案后果）→ T2（用例 1–9）+ T3（用例 1–4、9）；§5.4（版本取数、两条配对断言、`-rN` 归一化、D1 相对尾部）→ T2 用例 1；§5.5（维持嵌套 schema、自持暂存 + 嵌套 path ops、重置 unset、改动面）→ GC 第 2 条 + T3 用例 1–4；§6（降级表 12 行：老宿主/`inject` 缺包/`external`/硬服务缺失/`configForms` 缺席/单点异常/`apply` 二次执行/命名空间未就绪/两类保存失败/memory/volatile 提交失败/版本常量漂移）→ T1⑪⑫⑬、T2⑦⑧、T3⑤⑥⑨⑩、T4①②③④⑤、T5①③、T6③；§7.1（客户端单测十一类）→ T1/T2/T3 全部用例；§7.2（静态契约）→ T1 用例 2–6、16；§7.3（compat §7.7⑥）→ T4；§7.4（渲染冒烟与 `SlotAssemblyError`）→ T2⑨ + 偏差登记 5；§7.5（宿主半边零回归）→ 各 Task Step 4 的全量/compat/verify 命令；§7.6（手工验收）→ "验收期人工步骤"；§8（风险 D1/D2/V1–V5/R1–R5）→ D1→T2①、D2→验收步骤前置、V1→T2①（不读注解）、V2→T1 用例 2/4、V3→GC 第 9 条 + T3⑧、V4→T1/T4、V5→偏差登记 3、R1→T5③、R2→T1⑦、R3→T1⑫ + T2⑨、R4→T1 只依赖公开服务与 token、R5→GC 第 2 条 + T3 用例 1–4；§9（README、spec 回写、发行待办、人工步骤、迭代面）→ T5、T6、验收期人工步骤末行（发行待办仍在范围外，README 不承诺）。**无缺口。**
2. **步骤可单决**：每步一动作；每条断言给出用例名 + 具体值（ops 数组、revision、文案子串、四例 ns 判定）；夹具 API 与 hook 运行时语义在 T1 Step 1 钉死，后续 Task 只引用不重述；无 TBD/TODO/"处理边界情况"式表述；唯一条件式内容（`external:["react"]`）已在偏差登记 3 给出确定处置，不留"或"式分支。
3. **命名与类型一致**：全计划统一 `NS` / `LOCALE_NS` / `SLOT_NAME` / `REGISTER_OPTIONS` / `DICT` / `resolveNamespace` / `createFormHolder` / `readSnapshot` / `readVenv` / `buildSetOps` / `RESET_OPS` / `ensureStyles` / `checkClientHalf` / `PLUGIN_CLIENT_ENTRY`；`Snapshot` 五字段在 T1 定义、T2/T3 消费；`mutate(ops, revision)` 的第二参在 T3 用例 1/4/7 一致取"当前快照 revision（可 `undefined`）"。
4. **Review Focus 五条全部落测试**：①→T2⑧ ＋ T3⑨（等价观测链，措辞与 Review Focus #1 一致）；②→T1⑩；③→T3⑦；④→T3⑤⑥（两类可观测量与"不抛"）＋T3⑧（不乐观更新）；⑤→T1⑧⑫ ＋ T2⑨（引用集合与 Review Focus #5 一致）。
5. **比例**：计划与设计（239 行）同量级偏长（6 个 Task × 6 步），代码块只出现在契约骨架、夹具 API 与断言处，无实现转写。
6. **命令可复制执行**：全部命令以 `node --test tests/*.test.mjs` glob 形态给出；基线三条（527 用例 / `node scripts/check-dsh-compat.mjs` / `node scripts/verify-plugin.mjs --upstream .upstream/refs/tags/v6.7.0@b4efe3ddf237a97a42880164759162f8e2412f2f`）在 T1/T3/T4/T6 的 Step 4 复跑。

## 存疑点与裁决记录（监督者已于 2026-10-16 全部裁决；Gate 2 审查输入快照）

1. **"既有测试零改动"与 `exports["./client"]` 互斥**（最高优先）：`tests/skeleton.test.mjs` 的 `package.json: exports 三条目` 断言 `Object.keys(pkg.exports).sort()` 逐字等于三条目；本特性硬性要求新增 `exports["./client"]` ⇒ 该用例必然转红。计划按"最小形状同步 + 不弱化"处置（追加一条断言、期望数组补一项、用例名改四条目），并已在 Global Constraints 显式登记为唯一例外。**请确认此例外**，否则该特性无法在不改这一条断言的前提下交付。→ **裁决：批准**为唯一例外——设计自身要求的 `exports["./client"]` 新增与该逐字断言数学互斥、"零改动"不变量的立法意图是防弱化防回归，而本处置只增不删（原三条断言原样保留、追加一条、期望数组同步形状），符合意图；设计修订记录（5）同步登记。
2. **`external: ["react"]` 与实测证据冲突**：设计 §5.1 声明"`external` 必须声明 `react`"，但 V5 又授权"若实测为基线则删除"，而实测证据（六个已装客户端插件无一声明、其中两个在 bundle 内 require react；loader 对 seed 词直接跳过）指向 react 已是种子词。计划按硬事实保留该字段（无害），但设计 §8 V5 的结论文本需相应回写——**是保留并回写"实测为基线但保留声明"，还是按 V5 删除该字段？** → **裁决：保留 `external: ["react"]`**——与设计 §7.2 静态断言一致、对种子词无害且防未来宿主种子表收缩；实测结论已按勘误 V5′ 回写设计（§5.1/§8/修订记录（5））。
3. **`mode === 'memory'` 的写门**：设计只要求"显式提示"，未说是否禁用按钮。计划让提示常显、写门仍只取 `status`/`writable`（实测 memory 下二者分别恒为 `'unavailable'`/`false`，按钮自然禁用）——若意图是"memory 下仍允许点击并由宿主返回 `{ok:false}` 呈现第一类可观测量"，需明确，因为该路径在实测形态下不可达。→ **裁决：维持计划处置**——提示常显、写门只取 `status`/`writable`，为设计"两字段各自用途"的自然读法；memory 实测形态下按钮自然禁用、第一类可观测量在该形态不可达为既定事实，不为其构造不可达路径的测试。
4. **§7.7⑥ 的集成验证方式**：计划的⑥全流程行在场只用"实跑命令 + 既有 `problems` 空集基线"守卫（不重建 `makeStubSdk`，避免约 144 行重复）。若要求⑥也拥有 hermetic 的集成用例（stub SDK 全流程），需放宽"`tests/compat.test.mjs` 零改动"以导出其夹具。→ **裁决：维持计划处置**——不重建 `makeStubSdk`（约 144 行重复代价过高）；实跑 CLI 断言 ⑥ 行在场 ＋ 既有 `problems` 空集基线充当⑥的正向集成守卫已足。
5. **spec 回写范围**：设计 §9 要求回写 2026-10-15 spec（㉗ 指针、§7.7 六项、volatile 快路径机制更正），本计划落在 T6。该文件属另一特性的规范文档，改动为纯文档、不影响任何代码或断言——若跨特性回写需另走流程，请指示。→ **裁决：T6 直接回写，无需另走流程**——纯文档改动，仓库既有跨文档勘误先例（2026-10-15 篇的 ㉗/㉘ 即跨特性澄清期写入）。
