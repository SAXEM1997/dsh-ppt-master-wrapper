# 设计：插件工具可见范围——全局 / 指定工作区（2026-10-18）

> 任务名：`2026-10-18-tool-scope`（`Plan: medium`）。
> 澄清真相源：`docs/superpowers/clarifications/2026-10-18-tool-scope.md`（下文 `[Q1]`/`[Q2]`/`[B*]`/`[C*]` 均指该文件）。
> 参考实现：`SAXEM1997/dsh-cherry-bridge` 的 `src/toolScope.ts` / `src/toolScopeHost.ts`（复用语义，不复用代码与规模）。

## 1. 概述与动机

本插件把 3 个 `ppt_master_*` 工具注册成**全局工具**，于是本机每个会话（`hermes` / `oa` / `llm` …）的模型工具表里都有它们。用户要的是**降噪**：与 PPT 无关的工作区里不该出现这三条 [Q1]。

本特性给插件加一个"工具可见范围"配置：`global`（默认，现状）或 `selected`（只有名单里的工作区能看见）。收窄发生在**宿主装配层**（`tools.restrict` 真正把这 3 个名字从该 agent 的可见表里移除），不是前端假过滤；另挂一条全局 `tools.guard` 兜住"限制层还没装上的窗口"。

**非安全边界**：这不是权限系统。目的是让工具表干净；绕过（比如另一插件转调）不在防护范围内 [§10]。

## 2. 目标 / 非目标

**目标**
- G1 新增 `scope.mode`（`global`|`selected`，默认 `global`）+ `scope.workspaceIds`（字符串数组，默认 `[]`），写入插件 cordis `Config` [C5]。
- G2 判定：agent → 所属工作区（规则一 `sessionIds` 成员；规则二 `resolveByPath(cwd)` 规范路径），再按 `mode` + 名单决定可见性 [Q2]。
- G3 执行：不可见的 agent 上安装 `agent.ctx.tools.restrict({deny: TOOL_NAMES})`；全局 `tools.guard` 对不可见 agent 的调用返回拒绝原因。
- G4 插件页卡片新增"工具可见范围"一节：模式单选 + 工作区勾选列表（数据来自客户端 `workspaces` 服务）+ 说明 + 降级提示；保存走既有 `configForms` 通道，免重启生效 [B7]。
- G5 默认行为零变化：`mode=global` 时**不注入、不装层、不装 guard、不产生任何新日志**——插件日志与今天逐字一致。
- G6 零新增 npm 依赖、零构建链；宿主半边纯 ESM，客户端半边仍是手写自包含单文件 [B9]。
- G7 能力缺失安静降级且可诊断（warn + 卡片提示），插件不因此崩 [B8]。

**非目标**
- 独立设置页 / 自有 HTTP 面 / 设备类交互（cherry 那套为 14 工具 + 配对设计，本插件不需要）。
- 按会话（session）粒度开关；粒度只到工作区 [§10]。
- 收窄 **skill** 条目：宿主 `skills.registerProvider` 只有全局层与 preset 作用域层，无 per-agent 隐藏通道 [Q3][B6]。
- 改动 `venv.*` 三个键的键名/语义/行为。
- 修改上游 `skills/ppt-master/**`（仓库红线）。

## 3. 架构

```
                    ┌────────────────────────────── 宿主（Node）
 cordis Config ────►│ index.js  apply()
 (scope.mode/ids)   │   ├─ createTools()  ──► toolNames（唯一来源，C7）
                    │   ├─ skills.registerProvider / tools.register（既有）
                    │   └─ mountToolScope(ctx, {config, toolNames})   ← 新增
                    │          │
                    │          ├─ probe(ctx)：tools.restrict / tools.guard / ctx.inject / ctx.on
                    │          └─ ctx.inject(['agents','workspaceRegistry'], child => …)
                    │                 ├─ 首轮 round()：judgeAgent(...) → 安装/释放 restrict
                    │                 ├─ 订阅 agent/created、agent/disposed、tools/change（合并重算）
                    │                 ├─ 根 ctx tools.guard(...)（执行层兜底）
                    │                 └─ 返回 dispose（顺序：退订 → 清定时器 → 释放 restrict → 释放 guard）
                    └──────────────────────────────
                              ▲ 读写同一份配置
                    ┌────────────────────────────── 浏览器（插件页卡片）
                    │ lib/client.js：venv 三字段（既有） + 「工具可见范围」一节（新增）
                    │   ├─ configForms（既有可选能力，回调式）
                    │   └─ workspaces（新增可选能力，回调式）→ 勾选列表
                    └──────────────────────────────
```

新增文件：
- `lib/scope.js` — **纯逻辑**（无宿主依赖，可单测）：配置归一化、严格序 `isVisible`、`judgeAgent`、工作区标签、工具名派生。
- `lib/scope-host.js` — **宿主集成**：能力探针、注入、轮次合并、限制层安装/释放、guard、拆除顺序。

改动文件：`index.js`（Config + 装配）、`lib/client.js`（卡片一节 + 字典）、`cordis.patch.yml`（补 `scope` 键）、`README.md` / `README.en.md`、`package.json`（版本 `6.7.1-r1`）、`tests/client-half.test.mjs`（字典/控件/ops 断言）、新增 `tests/scope.test.mjs` / `tests/scope-host.test.mjs`。

`lib/venv.js` **不动**：`scope` 配置走自己的读取函数（`lib/scope.js` 的 `readScopeConfig`），避免把 venv 模块的注入包契约与既有 17 条测试一起改。

## 4. 数据流

1. **装载**：宿主校验 `Config`（非法值在装载期抛 `ValidationError`，与既有 venv 字段同形）→ `apply(ctx, opts)`。
2. **取配置（惰性）**：`opts.scope` 里是 **volatile 引用对象**，`mountToolScope` 保存**引用本身**，每一轮判定前调 `readScopeConfig(opts.scope)` 现取 `.get()`；任何非法形状 ⇒ `SCOPE_DEFAULT`（`global`）+ 一条 warn（不抛）。
   > **为什么不能 apply 期快照**（本设计的关键实测结论）：宿主 `cordis-plugin-loader` 对"只改 volatile 叶子"的配置变更走 `_commitVolatile()`——**原地更新引用、不重挂插件**（`lib/index.js:382-424`），随后在插件自己的 ctx 上 emit `loader/volatile-update`。apply 期拍平的普通值因此永远是旧的。`dsh-llm-pi-ai`、`dsh-plugin-market`、`dsh-client-product-analytics` 都是 `ctx.on('loader/volatile-update', …)` 后重读引用，本特性沿用同一范式。
3. **探针**：`ctx.tools.restrict` / `ctx.tools.guard` / `ctx.inject` / `ctx.on` 是否存在（决定降级档位，见 §6）。
4. **注入**：`ctx.inject(['agents','workspaceRegistry'], child => …)`；两个服务任一缺失 ⇒ 该回调永不执行 ⇒ 停留在"待注入"态（不报错，与既有 `configForms` 同形）。
5. **首轮**：`registry.list()` → 工作区快照；`agents.list()` → 逐 agent 判定（同步首判 + 异步精化）；对不可见者装 restrict。
6. **事件**：`agent/created`（同步首判立刻装层 + 排队异步精化）、`agent/disposed`（释放该 agent 的层）、`tools/change`（宿主在 register/restrict 两侧都会发，用**合并闸门**防自激：轮次进行中只置脏，结束后补跑一轮）。
7. **配置变更**：`loader/volatile-update`（只改 volatile 叶子时宿主不重挂）⇒ 重读引用 + 重跑一轮（与 `tools/change` 共用合并闸门）；配置从 `global` 切到 `selected` 时若 guard 尚未安装则就地补装，反向切换则先释放。**不依赖插件重挂**。
8. **卡片写面**：勾选/切换 → 暂存态 → `form.mutate(ops, revision)` → 宿主写入 → 快照回推 → 脏集自然清空（既有机制，不新增通道）。

## 5. 接口

### 5.1 Config schema（`index.js`）

```js
export const Config = z.object({
  venv: /* 既有，逐字不动 */,
  scope: z.object({
    mode: z.union([z.const('global'), z.const('selected')]).default('global')
      .description('工具可见范围：global（默认）＝所有工作区可见；selected＝仅下方名单内的工作区可见。').volatile(),
    workspaceIds: z.array(z.string()).default([])
      .description('selected 模式下可见的工作区 id 列表；不属于任何工作区的会话在 selected 下不可见。').volatile(),
  }).description('工具可见范围（仅影响 ppt_master_info / _check_env / _setup_deps 三个工具；技能条目不受影响）。'),
})
```

实测确认（本机 schemastery）：`z.union([z.const(...)])` + `.default()` + `.volatile()` 可组合；`.volatile()` 把叶子包成带 `.get()` 的引用对象；`mode:'nope'` 在**校验期**抛 `ValidationError $.scope.mode expected "global" | "selected"`。

⇒ 卡片写面必须只产出合法值（模式由单选保证、名单恒为字符串数组），因为非法值会让插件装载失败（与既有 `venv` 字段同一风险面，不新增风险类型）。

### 5.2 `lib/scope.js`（纯逻辑）

| 导出 | 契约 |
|---|---|
| `SCOPE_KEY` | `'scope'`（配置顶层键；`buildSetOps` 与 `readScopeConfig` 共用） |
| `SCOPE_MODES` | `['global','selected']`（冻结） |
| `SCOPE_DEFAULT` | `{ mode: 'global', workspaceIds: [] }`（冻结；**不是** cherry 的 `selected + []` [Q2]） |
| `readScopeConfig(raw)` | 入参为任意形状（含 volatile 引用对象）→ `{ mode, workspaceIds, problem? }`；`problem: 'invalid'` 时回落 `SCOPE_DEFAULT`。`workspaceIds` 逐项 `String().trim()`、去空、去重、升序排序（与 cherry 的 `normalizeScope` 同语义：比较归一化不改写存储字面量） |
| `isVisible(config, workspaceId)` | 严格序：`global` ⇒ 恒真（含 `undefined`）；`selected` ⇒ 仅命中名单为真，`undefined`/未命中/空名单为假 |
| `describeWorkspace(ws)` | `工作区「title」(id)`；无 title 时 `工作区 id` |
| `judgeAgent({config, agent, workspaces, pathMap, resolveByPath})` | `async` → `{ agentId, status:'resolved'|'no-cwd'|'no-match'|'unresolved', workspaceId?, visible, reason, cwd? }`；`visible` **只**由 `isVisible` 得出 |
| `resolveNow({config, agent, workspaces, pathMap})` | **同步**首判（规则一 + 缓存路径表），给 `agent/created` 的窗口用；不 `await`、不调宿主 |
| `toolNamesOf(tools)` | 从 `createTools()` 产出派生名字集合（C7），保持注册顺序 |

### 5.3 `lib/scope-host.js`（宿主集成）

```js
mountToolScope(ctx, { config, toolNames, log }) → dispose: () => void
```

- **能力探针**（在根 ctx 上，一次）：`canRestrict`（`typeof ctx.tools?.restrict === 'function'`）、`canGuard`、`canInject`（`typeof ctx.inject === 'function'`）、`canOn`。
- **`mode === 'global'` 时整段短路**：不注入、不装层、不装 guard、**不 warn**（默认配置下插件日志必须与今天逐字一致；既有 `tests/apply.test.mjs` 的「能力齐全时不得输出降级日志」断言因此继续成立）。降级告警只在 `selected` 模式下发生。
- **`selected` 且无 `canInject`**：整段不启用，warn 一次，返回 noop disposer。
- **注入体**（`child`）：持有 `child.agents`、`child.workspaceRegistry`；所有安装/订阅/guard 都在此作用域内建立，dispose 时按序释放。**注入尚未到达不算降级**（与既有 `configForms` 同形：pending 不 warn），故不产生噪音日志。
- **轮次合并闸门**：`requestRound()` —— 进行中只置 `dirty=true`；结束后若 `dirty` 再跑一轮（终止性由"每轮都重读快照"保证）。
- **限制层账本**：`Map<agentId, disposer>`；安装前先释放旧层（幂等）；释放失败只 warn，不阻塞。
- **guard**：`ctx.tools.guard((exec) => verdict(exec))`，`verdict` 同步：名字不在 `toolNames` ⇒ `undefined`；无 `exec.agent` ⇒ `undefined`；判定缓存未命中 ⇒ `undefined`（窗口放行，见 §6）；`visible` ⇒ `undefined`；否则返回中文拒绝原因（含模式与工作区标签）。
- **拆除顺序**（与 cherry 同序，理由同）：退订事件 → 清重试定时器 → 释放各 agent 的 restrict → 释放 guard（guard 释放不通知任何人，放最后）。

### 5.4 判定算法

```
judgeAgent(agent):
  if config.mode === 'global'            → resolved?/visible = true        （不装层）
  规则一：ws = workspaces.find(w => w.sessionIds.includes(agent.id))
    命中 → workspaceId = ws.id；visible = ids.includes(ws.id)
  规则二：cwd = agent.session?.header?.cwd
    无 cwd            → status 'no-cwd'，visible = false
    resolveByPath(cwd) reject → status 'unresolved'，visible = false（排一次 1000ms 重试，C3）
    返回 undefined     → status 'no-match'，visible = false   （宿主不拥有该目录）
    返回 entity        → workspaceId = entity.id；visible = ids.includes(workspaceId)
```

- **子 agent 跟随**：宿主 `dsh-subagent` 创建子会话时**复制父会话的 `cwd`**（实测 `lib/index.js:350`），因此子 agent 天然被同一规则判到同一工作区；子 agent 若被显式指定了不同 `cwd`，则按自己的 `cwd` 判——符合预期。`global` 模式下判定不参与，子 agent 不受影响。
- **同步首判**（`resolveNow`）：规则一 + `pathMap`（`registry.list()` 里每项的 `path → id`；注册表 `path` 在创建时已 realpath 规范化）直接命中；未命中判 `no-match`。异步轮次用 `resolveByPath` 精化（补符号链接/拼写差异）。
- **重试有界**：每个 agent 至多一次 1000ms 重试（C3），不无限自旋。
- `unresolved` 与 `no-match` 都不可见，但 `reason` 不同（前者"解析失败，可能瞬时"，后者"宿主不拥有该目录"），写进 guard 拒绝原因，便于排查。

### 5.5 卡片（`lib/client.js`）

新增一节，插在 venv 三字段之后、版本块之前：

| 控件 | id | 行为 |
|---|---|---|
| 模式单选（两枚 radio） | `ppt-master-config-scope-mode-global` / `-selected` | 写暂存 `scopeMode` |
| 工作区勾选列表（每个工作区一行：标题 + 路径 + 会话数） | `ppt-master-config-scope-ws-<workspaceId>` | 勾选 ⇒ 写暂存 `scopeWorkspaceIds`（增删该 id） |
| 说明块 | `.ppt-master-config-scope-hint` | 静态文案（含"技能条目不受影响"与"不属于任何工作区的会话也看不到"） |
| 降级提示 | `.ppt-master-config-scope-degraded` | `workspaces` 服务不可用 / 名单为空 / 快照缺 `scope` 基值时显示 |

- 数据源：`ctx.inject(['workspaces'], c => …)`，取 `c.workspaces.list.getSnapshot()` 的 `items`（`workspaceId`/`title`/`path`/`sessionIds`），并 `subscribe` 变化；沿用既有 `createFormHolder` 的"模块级 store + `useState`"范式。
- **服务不可用 ⇒ 不给手输 ID 退路**（C6）：列表区显示降级提示，模式单选仍可改。
- 写面：`LEAF_SPECS` 从"三个 venv 叶子"扩为"五个叶子"（`enabled/path/oldPathPolicy` + `scopeMode/scopeWorkspaceIds`），`buildSetOps` 按固定顺序产 op；数组叶子用值比较（长度 + 逐项）判脏，其余沿用 `!==`。
- **重置语义扩展**：`RESET_OPS` 由 3 条 `unset` 变为 5 条（`venv.*` 三条 + `scope.*` 两条）——"重置"＝把本卡片全部叶子交回继承层。这是对既有 `client-half` 断言（"重置 ops 恰好三条"）的**有意变更**，随本特性一并更新测试与文案。
- 字典：`zh`/`en` 键集必须相等（既有断言），新增约 12 键。

### 5.6 工具名单一来源（C7）

`index.js` 里 `const tools = createTools({...})`，`toolNames = toolNamesOf(tools)`，同一数组既用于 `tools.register` 循环，也传给 `mountToolScope`。**不写第二份字面量**；一条测试断言 `toolNamesOf(createTools())` 与宿主动态注册的名字一致。

## 6. 错误处理与降级

| 情形 | 行为 | 可见性结果 |
|---|---|---|
| `mode=global`（默认） | 整段短路：不注入、不装层、不装 guard、不 warn | 与今天逐字一致 |
| `selected` + 缺 `tools.restrict` | 只装 guard（**guard-only** 档），warn + 卡片降级提示 [C2] | 工具仍列出；调用被拒（不可见者） |
| `selected` + 缺 `tools.guard` | 只装 restrict，warn | 窗口期（created→轮次完成）可能漏判，记录为已知限制 |
| `selected` + 缺 `ctx.inject` / 无 `agents` / 无 `workspaceRegistry` | 不判定，warn 一次 | **fail-open**：工具照常可见（C1：宿主答不出来 ≠ 宿主答"无归属"） |
| `registry.list()` 抛错 | 本轮跳过，warn；维持上一轮判定 | 上一轮结果 |
| `resolveByPath` reject | 该 agent 判 `unresolved` ⇒ 不可见，排一次 1000ms 重试 | 不可见（可能瞬时） |
| `agent.ctx.tools.restrict` 抛错（未知工具名/非作用域） | warn，跳过该 agent，guard 仍兜底 | 工具仍列出、调用被拒 |
| 释放 restrict 抛错 | warn，不阻塞拆除 | 残留层需重启 DSH 清除（记录在 README 已知限制） |
| 配置非法（`mode` 非枚举） | 宿主装载期 `ValidationError`（既有风险面） | 插件不装载 |

**"答不出来 vs 答无归属"的区分是本设计的核心判断（C1）**：本特性目的是降噪；把 PPT 工具从用户自己的 PPT 工作区里藏掉是**功能损坏**，而降噪失效只是噪音。因此只有"宿主明确回答该会话不属于任何已选工作区"时才隐藏。

## 7. 测试策略

| 层 | 文件 | 覆盖 |
|---|---|---|
| 纯逻辑单测 | `tests/scope.test.mjs`（新） | `readScopeConfig` 归一化/去重/排序/非法回落；`isVisible` 严格序（含 `undefined` 与空名单）；`judgeAgent` 四态（resolved 命中/未命中、no-cwd、no-match、unresolved）；`resolveNow` 同步首判；`describeWorkspace`；`toolNamesOf` |
| 宿主集成（fake host） | `tests/scope-host.test.mjs`（新） | 首轮安装/释放 restrict；`agent/created` 同步装层；`agent/disposed` 释放；`tools/change` 合并（不重叠、补跑一轮）；`loader/volatile-update` 后重读引用并重算（含 global↔selected 双向切换时 guard 的补装/释放）；guard 判定五分支；`global` 下零安装零拒绝；四档降级（缺 restrict / 缺 guard / 缺注入 / list 抛错）；拆除顺序与幂等（dispose 两次不抛） |
| 客户端静态契约 | `tests/client-half.test.mjs`（改） | 字典 zh/en 键集相等；新控件 id 存在；`buildSetOps` 五叶子顺序与数组值比较；`RESET_OPS` 五条；`var()` 兜底与无硬编码颜色（既有断言继续通过）；模式单选与勾选列表的渲染/降级 |
| 装配回归 | `tests/apply.test.mjs`（改） | `apply` 在缺 `restrict/guard/agents` 的 ctx 上仍成功；`makeCtx` 增加一个**永不回调**的 `inject`（模拟注入未到达 ⇒ pending 不 warn），既有「能力齐全时不得输出降级日志」断言原样通过；新增：`mode='selected'` 时 `mountToolScope` 真的去探针并在缺能力时 warn 一次 |
| 版本/骨架 | `tests/skeleton.test.mjs`（既有） | `6.7.1-r1` 满足 `upstream + -rN`；`PLUGIN_VERSION` ≡ `package.json.version` |

全量命令：`node --test tests/*.test.mjs`（本机 Node 22 下目录参数失效）。

**人工验收（写进 README/PR）**：① 默认 `global` 下本会话仍见 3 工具；② 切 `selected` 并只勾 `ppt-master` 工作区 → 本会话仍见；③ 在 `hermes` 工作区新开会话 → 工具表无这 3 条；④ 卡片在勾选/保存后不重启即生效。

## 8. 风险与未知

| # | 风险 | 缓解 |
|---|---|---|
| R1 | ~~宿主热重载是否对 `scope` 叶子触发重挂~~ **已实测否定**：volatile-only 变更不重挂（`cordis-plugin-loader/lib/index.js:382-424`） | 改为惰性读引用 + `loader/volatile-update` 触发重算（§4 步 7），不依赖重挂 |
| R2 | `tools/change` 在 restrict 两侧都会发 ⇒ 自激 | 合并闸门（§5.3）+ 幂等装层；集成测试锁死"不重叠、最多补跑一轮" |
| R3 | `agent/created` 与首轮之间的窗口 | 同步首判（`resolveNow`）+ guard 兜底；窗口内 guard 未命中放行，记录为已知限制 |
| R4 | 名单里含已删除的工作区 id | 忽略（不影响判定）；卡片把"名单里有但注册表没有"的 id 标为灰色不可勾选 |
| R5 | 客户端 `workspaces` 服务名/形状变更 | 回调式接入 + 类型化读取 + 降级提示；不硬依赖 |
| R6 | `restrict` 只接受**已知全局工具名**，注册顺序敏感 | 只在 `tools.register` 成功之后 mount；工具名从注册产出派生（C7） |
| R7 | 判定基于会话 header 的 `cwd`；会话中途切换工作目录（`working-directory/change`）不重判 | 记录为已知限制；后续迭代可接该事件重判（本版不接，避免再引一个宿主服务） |
| R8 | **既有缺陷（不属本特性，只登记）**：`venv` 三叶子的 apply 期快照 `assembleInjectionBag` 同样拿不到 volatile 更新 ⇒ 卡片改 venv 后工具侧可能仍读旧值，直到重启 | 本特性不动 venv 路径；另开 issue 登记（惰性读引用是同一处修法） |

## 9. 文档与发布

- 版本 `6.7.1 → 6.7.1-r1`（包装层自有特性，`CONTRIBUTING.md` 版本策略 C4）；同步 `package.json`、`lib/client.js` 的 `PLUGIN_VERSION`（`UPSTREAM_VERSION` 仍 `6.7.1`）、双语 README 版本表与版本历史行。
- 双语 README 各补一节「工具可见范围 / Tool visibility scope」：三个键、两种模式、判定规则、已知限制（技能不收窄、窗口期、残留层需重启）。
- `cordis.patch.yml` 补 `scope` 两键（与 `venv` 同形，含"缺键回落默认"的注记）。
- 走 GitHub Flow：issue → `feat/tool-scope` 分支 → PR（squash）→ 合并后同步内网镜像；tag `v6.7.1-r1` 在合并后打。

## 10. 排除范围（明确不做）

- 不做权限/安全边界：不防"另一插件转调"、不防 CLI 直调。
- 不做按会话、按模型、按 preset 的粒度。
- 不做工作区的新增/重命名/删除（只读取注册表）。
- 不做 skill 收窄（宿主无通道）[B6]。
- 不做"实时显示每个 agent 当前判定"的调试面板（无宿主→客户端通道，需自建 HTTP 面，收益低于成本）。
- 不改 `venv` 行为，不改上游 vendor 树。
