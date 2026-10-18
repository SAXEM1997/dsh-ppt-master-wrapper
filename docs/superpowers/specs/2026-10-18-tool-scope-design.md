# 设计：插件工具可见范围——全局 / 指定工作区（2026-10-18）

> 任务名：`2026-10-18-tool-scope`（`Plan: medium`）。
> 澄清真相源：`docs/superpowers/clarifications/2026-10-18-tool-scope.md`（下文 `[Q1]`/`[Q2]`/`[B*]`/`[C*]` 均指该文件）。
> 参考实现：`SAXEM1997/dsh-cherry-bridge` 的 `src/toolScope.ts` / `src/toolScopeHost.ts`（复用语义，不复用代码与规模）。
> **修订记录**：（1）Gate 0 对齐审查 F1–F9 全部采纳（详见 §11 裁决表）；（2）builder check 的四个问题全部裁决（§11）；（3）关键实测结论：volatile-only 配置变更**不重挂插件**（§4 步 2）、`agent/created` 监听器**会被 await**（§5.4）。

## 1. 概述与动机

本插件把 3 个 `ppt_master_*` 工具注册成**全局工具**，于是本机每个会话（`hermes` / `oa` / `llm` …）的模型工具表里都有它们。用户要的是**降噪**：与 PPT 无关的工作区里不该出现这三条 [Q1]。

本特性给插件加一个"工具可见范围"配置：`global`（默认，现状）或 `selected`（只有名单里的工作区能看见）。收窄发生在**宿主装配层**（`tools.restrict` 真正把这 3 个名字从该 agent 的可见表里移除），不是前端假过滤；另挂一条全局 `tools.guard` 兜执行层。

**非安全边界**：这不是权限系统。目的是让工具表干净；绕过（比如另一插件转调）不在防护范围内 [§10]。

## 2. 目标 / 非目标

**目标**
- G1 新增 `scope.mode`（`global`|`selected`，默认 `global`）+ `scope.workspaceIds`（字符串数组，默认 `[]`），写入插件 cordis `Config` [C5]。
- G2 判定：agent → 所属工作区（规则一 `sessionIds` 成员；规则二 `resolveByPath(cwd)` 规范路径），再按 `mode` + 名单决定可见性 [Q2]。
- G3 执行：不可见的 agent 上安装 `agent.ctx.tools.restrict({deny: TOOL_NAMES})`；全局 `tools.guard` 对不可见 agent 的调用返回拒绝原因。
- G4 插件页卡片新增"工具可见范围"一节：模式单选 + 工作区勾选列表（数据来自客户端 `workspaces` 服务）+ 说明 + 降级提示；保存走既有 `configForms` 通道，**免重启生效**（靠惰性读引用 + `loader/volatile-update`，见 §4）。
- G5 默认行为零变化：`mode=global` 时**不注入、不装层、不装 guard、不产生任何新日志**。
- G6 零新增 npm 依赖、零构建链；宿主半边纯 ESM，客户端半边仍是手写自包含单文件 [B9]。
- G7 能力缺失安静降级且可诊断（warn + 卡片提示），插件不因此崩 [B8]。
- G8 **首轮即正确**：`agent/created` 的判定必须在该会话的第一轮之前完成，不允许"先猜错、下一轮纠正"（§5.4）。

**非目标**
- 独立设置页 / 自有 HTTP 面 / 设备类交互。
- 按会话（session）粒度开关；粒度只到工作区 [§10]。
- 收窄 **skill** 条目：宿主 `skills.registerProvider` 只有全局层与 preset 作用域层，无 per-agent 隐藏通道 [Q3][B6]。
- 改动 `venv.*` 三个键的键名/语义/行为（含其既有的 apply 期快照陈旧问题，见 R8）。
- 修改上游 `skills/ppt-master/**`（仓库红线）。

## 3. 架构

```
                    ┌────────────────────────────── 宿主（Node）
 cordis Config ────►│ index.js  apply()
 (scope.mode/ids)   │   ├─ createTools()  ──► toolNames（唯一来源，C7）
                    │   ├─ skills.registerProvider / tools.register（既有）
                    │   └─ mountToolScope(ctx, {config: opts.scope, toolNames})   ← 新增
                    │          │  返回 { dispose, whenIdle }
                    │          ├─ probe(ctx)：tools.restrict / tools.guard / ctx.inject / ctx.on
                    │          ├─ 订阅 loader/volatile-update（激活前就挂：global→selected 只有这一个信号）
                    │          └─ ctx.inject(['agents','workspaceRegistry'], child => …)
                    │                 ├─ 首轮 round()：逐 agent judgeAgent → 差异式装/卸 restrict
                    │                 ├─ agent/created（**返回 promise，宿主会 await**）→ 该 agent 权威判定
                    │                 ├─ agent/disposed → 释放该 agent 的层
                    │                 ├─ tools/change → 合并重算（脏标记）
                    │                 └─ child.tools.guard(...) 执行层兜底
                    └──────────────────────────────
                              ▲ 读写同一份配置
                    ┌────────────────────────────── 浏览器（插件页卡片）
                    │ lib/client.js：venv 三字段（既有） + 「工具可见范围」一节（新增）
                    │   ├─ configForms（既有可选能力，回调式）
                    │   └─ workspaces（新增可选能力，回调式）→ 勾选列表；不可用则只读回显
                    └──────────────────────────────
```

新增文件：`lib/scope.js`（纯逻辑）、`lib/scope-host.js`（宿主集成）。
改动文件：`index.js`（Config + 装配）、`lib/client.js`（卡片一节 + 字典）、`cordis.patch.yml`（**仅注释示例**，见 §9）、`README.md` / `README.en.md`、`package.json`（版本 `6.7.1-r1`）、`tests/client-half.test.mjs`（字典/控件/ops 断言）、`tests/apply.test.mjs`（fake ctx 增加永不回调的 `inject`）、新增 `tests/scope.test.mjs` / `tests/scope-host.test.mjs`。

**交付切片**（两块只经 `scope` 配置键耦合，可独立验收）：
- **A＝宿主半边**：`lib/scope.js` + `lib/scope-host.js` + `index.js` + 两个新测试文件。验收＝§7 人工①–③。
- **B＝卡片**：`lib/client.js` + `tests/client-half.test.mjs`。验收＝§7 人工④。B 依赖 A 已把 `scope` 两键写进 `Config`。

**guard 的安装位置**：一律装在**根 ctx**（`ctx.tools.guard`），由根 `dispose()` 释放——它必须在 `ctx.inject` 之前就可能存在（缺 `ctx.inject` 时的 fail-closed 档位就是"只有 guard"）。注入 child 只负责 `agents`/`workspaceRegistry` 与事件订阅。

`lib/venv.js` **不动**（builder check 已确认 `assembleInjectionBag` 会丢弃未知键，故 `opts.scope` 从原始 opts 读取即可；`apply.test.mjs` 断言注入包恰为两键）。

## 4. 数据流

1. **装载**：宿主校验 `Config`（非法值在装载期抛 `ValidationError`，与既有 venv 字段同形）→ `apply(ctx, opts)`。
2. **取配置（惰性）**：`mountToolScope` 保存 `opts.scope`（**volatile 引用容器**），每轮判定前 `readScopeConfig(opts.scope)` 现取 `.get()`。`index.js` 现有注释里的不变量"唯一形态差转换点……下游只见普通值"据此收窄为"**除 `scope` 外**下游只见普通值"，实现时同步改该注释。
   > **实测**：`cordis-plugin-loader` 对"只改 volatile 叶子"的配置变更走 `_commitVolatile()`——原地更新引用、**不重挂插件**（`lib/index.js:382-424`），随后在插件 ctx 上 emit `loader/volatile-update`。`dsh-llm-pi-ai`、`dsh-plugin-market`、`dsh-client-product-analytics` 都是 `ctx.on('loader/volatile-update', …)` 后重读引用。
3. **探针**：`ctx.tools.restrict` / `ctx.tools.guard` / `ctx.inject` / `ctx.on` 是否存在（决定降级档位，§6）。
4. **激活**：`mode === 'selected'` 才 `ctx.inject(['agents','workspaceRegistry'], child => …)`；`global` 下整段短路。
5. **首轮**：`registry.list()` → 工作区快照 + `path → id` 表；`agents.list()` → 逐 agent **异步**权威判定（`judgeAgent`）→ 差异式装/卸层。
6. **事件**：`agent/created`（**返回 promise**：宿主 await 该监听器后才让会话进入第一轮 ⇒ 首轮工具表即正确，G8）、`agent/disposed`（释放该 agent 的层）、`tools/change`（合并闸门）。
7. **配置变更**：`loader/volatile-update` ⇒ `ensureActive()` + 重算；`global↔selected` 双向切换都在运行期就地完成（装层/卸层），不依赖重挂。
8. **卡片写面**：勾选/切换 → 暂存态 → `form.mutate(ops, revision)` → 宿主写入 → 快照回推 → 脏集自然清空（既有机制）。

## 5. 接口

### 5.1 Config schema（`index.js`）

```js
export const Config = z.object({
  venv: /* 既有，逐字不动 */,
  scope: z.object({
    mode: z.union([z.const('global'), z.const('selected')]).default('global')
      .description('工具可见范围：global（默认）＝所有工作区可见；selected＝仅下方名单内的工作区可见。').volatile(),
    workspaceIds: z.array(z.string()).default([])
      .description('selected 模式下可见的工作区 id 列表。').volatile(),
  }).description('工具可见范围（仅影响 ppt_master_info / _check_env / _setup_deps 三个工具；技能条目不受影响）。'),
})
```

实测：`z.union([z.const(...)])` + `.default()` + `.volatile()` 可组合；`.volatile()` 包成带 `.get()` 的引用对象；`mode:'nope'` 在**校验期**抛 `ValidationError`。卡片写面只产出合法值（模式单选、名单恒为字符串数组），故装载期拒绝只是纵深防御。

### 5.2 `lib/scope.js`（纯逻辑，已实现并有 40 条单测）

| 导出 | 契约 |
|---|---|
| `SCOPE_KEY` / `SCOPE_MODES` / `SCOPE_DEFAULT` | `'scope'` / 两模式冻结数组 / `{mode:'global', workspaceIds:[]}` 冻结 |
| `readScopeConfig(raw)` | 惰性解引用；**缺省** ⇒ global（无 problem）；**非法**（任一键在场但类型/取值不对）⇒ **更严一侧 `selected + []` + `problem:'invalid'`**；合法 ⇒ 逐项 trim/去空/去重/升序 |
| `isVisible(config, workspaceId)` | 严格序：global 恒真；selected 仅命中名单为真（`undefined`/空名单为假） |
| `describeWorkspace(ws)` | `工作区「title」(id)` / `工作区 id` |
| `projectAgent(agent)` | 活 agent → `{id, cwd?}`；无 id ⇒ `undefined` |
| `readWorkspaces(list)` | 边界归一化（无 id 项丢弃、`sessionIds` 非数组退化为 `[]`） |
| `toolNamesOf(tools)` | 从 `createTools()` 产出派生名字（冻结数组，保序） |
| `resolveNow({config, agent, workspaces, pathMap})` | **同步**判定（规则一 + 缓存路径表）；只用于 guard 的同步裁决 |
| `judgeAgent({config, agent, workspaces, pathMap, resolveByPath})` | **异步权威**判定：resolved / no-cwd / no-match / unresolved |

### 5.3 `lib/scope-host.js`（宿主集成）

```js
mountToolScope(ctx, { scopeConfig, toolNames, warn = console.warn })
  → { dispose: () => void, whenIdle: () => Promise<void> }
```

`scopeConfig` 是**原始 volatile 引用容器**（不是归一化值，也不叫 `config` 以免与 zod `Config` 混淆），每轮由 `readScopeConfig` 现取；`warn` 默认 `console.warn`（既有 `apply.test.mjs` 直接捕获 console.warn）。

- **探针**（根 ctx，一次）：`canInject` / `canOn` / `canRestrict` / `canGuard`。
- **`global` 短路是两层的**（结构审查 F1）：装配期**无条件**建立 (a) 能力探针 + 根 ctx 的 `loader/volatile-update` 订阅（零日志、零副作用）；(b) `global` 只短路"注入 + 装层 + 降级 warn"这一层。切到 `selected` 才注入并装层，切回时按拆除顺序释放——否则 volatile-only 变更不重挂，`global→selected` 永远感知不到。
- **判定缓存**：`Map<agentId, {status, workspaceId?, visible, reason, cwd?}>`，每轮/每 agent 判定后写入，`agent/disposed` 删除，guard 只读它（拒绝原因就取自 `reason`）。
- **差异式安装**（builder check 脚注）：`restrict` 在**安装与释放两侧都会 emit `tools/change`**，所以"每轮先释放再重装"会让合并闸门永久脏。实现必须"目标可见性 ≠ 当前已装状态才动宿主"，这也正是"最多补跑一轮"的终止性来源。
- **guard 同步裁决**：命中缓存即用；缓存未命中时用 `resolveNow` **就地同步重判**（不 await、不写缓存）；仍判不出（`no-match`）则放行——`agent/created` 已 await 权威判定，缓存未命中是罕见窗口。
- **拆除顺序**：退订（根 + 子）→ 清定时器 → 释放各 agent 的 restrict → 释放 guard（guard 释放不通知任何人，放最后）。`dispose` 幂等。
- **`whenIdle()`**：等当前轮次（含补跑）结束，供宿主与测试观测。

### 5.4 判定算法（G8：首轮即正确）

```js
// judgeAgent 只在 selected 下被调用（global 的激活门在 §4 步 4）；伪码即 selected 路径。
// 每个分支都以 `visible = isVisible(config, workspaceId)` 收尾——判定函数不自行决定可见性。
ws = workspaces.find(w => w.sessionIds.includes(agent.id))
if (ws) return judged(agent, 'resolved', ws.id, `会话成员命中 ${describeWorkspace(ws)}`)

cwd = agent.session?.header?.cwd
if (cwd === undefined) return judged(agent, 'no-cwd', undefined, '…')

try { entity = await resolveByPath(cwd) }
catch { return judged(agent, 'unresolved', undefined, '…') }   // 排一次 1000ms 重试

if (entity === undefined) return judged(agent, 'no-match', undefined, '…')
return judged(agent, 'resolved', entity.id, `规范化路径命中 …`)

// judged(...) = { agentId, status, workspaceId?, visible: isVisible(config, workspaceId), reason, cwd? }
```

- **不再有"同步首判先装层"**：`header.cwd` 只保证绝对路径，`Workspace.path` 是 realpath，同步猜错会**先藏掉**用户自己 PPT 工作区的工具（对齐审查 F6 的实质）。改为：
  - `agent/created` 的监听器**返回 promise**（宿主 await 后才让该会话进第一轮），在监听器里跑 `judgeAgent` 权威判定 ⇒ **首轮工具表即正确**；
  - 装配时的首轮同样是异步判定（不在关键路径上）。
- **子 agent 跟随**：宿主 `dsh-subagent` 创建子会话时复制父会话 `cwd`（实测 `lib/index.js:350`），故子 agent 天然同判；显式指定不同 `cwd` 的子 agent 按自己的 `cwd` 判。
- `unresolved` 与 `no-match` 都不可见，但 `reason` 不同（前者"这次答不上来"，后者"宿主不拥有该目录"），写进 guard 拒绝原因便于排查。

### 5.5 卡片（`lib/client.js`）

新增一节，插在**重置说明（`reset.hint`）之后、状态行之前**（实际渲染序：title → intro → 版本块 → venv 三字段 → reset.hint → **本节点** → 状态/提示行），与 venv 区互不影响；venv 字段的 `ready` 门控不适用于本节——本节只需"宿主给了 scope 基值"即在 `loading`/`unavailable`/只读形态下渲染：模式单选按写门 `disabled`（悬停可见、点不动）。但**无 `ready` 快照基值时（`baseline === undefined`，连表单值都读不到）整节隐藏**（不是逐控件禁用）：用户在此态看不到 scope 控件，也就不会误操作 [M21 勘误：原措辞为"禁用即可"，实现与测试均为整节隐藏]。

| 控件 | id | 行为 |
|---|---|---|
| 模式单选（两枚 radio） | `ppt-master-config-scope-mode-global` / `-selected` | 写暂存 `scopeMode` |
| 工作区勾选列表（标题 + 路径 + 会话数） | `ppt-master-config-scope-ws-<workspaceId>` | 勾选 ⇒ 暂存 `scopeWorkspaceIds` 增删该 id |
| 说明块 | `.ppt-master-config-scope-hint` | 静态文案（含"技能条目不受影响""不属于任何工作区的会话也看不到"） |
| 失效 id 行 | `ppt-master-config-scope-ws-<workspaceId>`（同一 id 规则） | 名单里有、但注册表已无此工作区：显示为 `已不存在的工作区 <id>`，**可勾掉移除、不可新增**（结构审查 F15） |
| 降级/空态提示 | `.ppt-master-config-scope-note` | 两种：`workspaces` 服务不可用（**只读回显当前名单 + 指向 profile 配置**，C6 后半）、名单为空（合法态，不是降级） |

- 数据源：`ctx.inject(['workspaces'], c => …)` 取 `c.workspaces.list.getSnapshot().items`（`workspaceId`/`title`/`path`/`sessionIds`）并 `subscribe`；沿用既有 `createFormHolder` 的"模块级 store + `useState`"范式。
- **`dsh.client.inject` 不新增任何包**（builder check 已确认：把 workspace-controller 声明进 `inject` 会让整张卡片在缺该包时硬失败，违背 B8；`ctx.inject` 本身会安静降级）。
- **`SCOPE_KEY` 是卡片自有字面量**（`'scope'`，与既有 `VENV_KEY` 同形）：`client.js` 是自包含单文件、require 白名单只有 react 系，不可能 import `lib/scope.js`。两侧一致性由 `client-half` 断言锁死：**ops 路径首段 ≡ 宿主 `Config` 顶层键**。
- 写面：既有 `LEAF_ORDER`（`['enabled','path','oldPathPolicy']`）改为**路径对**形式 `[['venv','enabled'],['venv','path'],['venv','oldPathPolicy'],['scope','mode'],['scope','workspaceIds']]`，`buildSetOps` 从它派生 op 路径；基值由 `{...readVenv(snapshot), ...readScope(snapshot)}` 合成；数组叶子按值比较判脏（长度 + 逐项），其余沿用 `!==`。
- **必须同步扩展的三处**（漏改会让"只改 scope"的写回被判成没变）：`readVenv` 旁新增 `readScope`、`stagedLeaves`/`setLeaf`/`valueOf` 的叶子集合、**`sameSnapshot`**（现只比 status/revision/writable/mode + 三个 venv 叶）。
- **`RESET_OPS` 保持 3 条不变**（venv 三叶）：不得让既有"重置"顺带清空 scope（对齐审查 F4）。scope 区自带一枚"恢复默认（global）"链接，单独发两条 `unset`（`scope.mode` / `scope.workspaceIds`）。
- 字典：`zh`/`en` 键集必须相等（既有断言），新增约 14 键。

### 5.6 工具名单一来源（C7）

`index.js` 里 `const tools = createTools({...})`，`toolNames = toolNamesOf(tools)`，同一数组既用于 `tools.register` 循环，也传给 `mountToolScope`。既有 `tests/apply.test.mjs` 已断言注册恰好 3 项且名字固定，本设计不新增第二份字面量。

## 6. 错误处理与降级

**总原则**：区分三类"判不了"，处置不同（结构审查 F3/F4 + 对齐审查 F1 的合并裁决）：

| 类别 | 例子 | 处置 |
|---|---|---|
| **能力缺失**（宿主永远做不到） | 无 `ctx.inject`、注入到的服务形状不可用 | **fail-closed**：装全局 guard 全拒本插件工具 + warn |
| **瞬时读失败**（宿主这次没答上来） | `registry.list()` 抛错 | **本轮不产生新判定**：已有判定保留；没有判定的 agent 按"答不出来"放行（可见）+ warn + 1000ms 重试 |
| **明确回答"无归属"** | 无 cwd、`resolveByPath` 返回 undefined | **fail-closed**：不可见 |

**注入尚未到达（pending）不算降级**：不 warn、不判定、工具照常可见——那是装配期的一瞬，与"宿主缺能力"是两件事。

| 情形 | 行为 | 可见性结果 |
|---|---|---|
| `mode=global`（默认） | 装配期只建探针 + volatile 订阅；不注入、不装层、不装 guard、不 warn | 与今天逐字一致 |
| 配置非法（`readScopeConfig` 判 invalid） | 落更严一侧 `selected + []` + warn | 不可见 |
| `selected` + 无 `ctx.inject` | 根 ctx 装**全局 guard 全拒** + warn | 工具仍列出；调用被拒 |
| `selected` + 注入到达但 `agents`/`workspaceRegistry` 形状不可用 | 同上 | 工具仍列出；调用被拒 |
| `selected` + 注入尚未到达 | 不 warn、不判定 | 可见（装配期的一瞬） |
| `selected` + `registry.list()` 抛错 | 维持已有判定；无判定者可见 + warn + 重试 | 上一轮结果 / 可见 |
| `selected` + `registry.list()` 返回空表 | 视为"注册表确无工作区" ⇒ 全不可见（装层） | 不可见 |
| `selected` + `agents.list()` 抛错 | **本轮不产生新判定**：不改层、不做"已消失 agent"清理、不重复装层；warn + 1000ms 复检 | 上一轮结果 |
| `selected` + 缺 `tools.restrict` | guard-only（按判定拒绝）+ warn | 工具仍列出；调用被拒 |
| `selected` + 缺 `tools.guard` | 只装 restrict + warn | 装配层已收窄（G8 使窗口≈0） |
| `selected` + 缺 `ctx.on` | 只在装配时判定一次 + warn（新会话不判定、配置改动需重启 DSH） | 静态快照 |
| `agent.ctx.tools.restrict` 缺失/抛错 | warn（每 agent 一次），跳过该 agent，guard 仍兜底 | 工具仍列出；调用被拒 |
| 释放 restrict 抛错 | warn，不阻塞拆除 | 残留层需重启 DSH 清除（README 已知限制） |

> **卡片只能显示客户端可观测量**（结构审查 F5）：宿主能力状态没有回传通道，故 `warn` 与 README 是宿主侧降级的**唯一**可见面，卡片只负责"`workspaces` 服务不可用 / 名单为空 / 失效 id"这三类。G7 的"卡片提示"据此收窄为"客户端可观测的降级"。

## 7. 测试策略

| 层 | 文件 | 覆盖 |
|---|---|---|
| 纯逻辑单测 | `tests/scope.test.mjs`（新，40 条，已绿） | 归一化（缺省/非法/引用解引用/去重排序）、严格序、四态判定、投影与边界归一化、工具名派生 |
| 宿主集成（fake host） | `tests/scope-host.test.mjs`（新） | 首轮差异式装/卸；`agent/created` **监听器返回 promise** 且首轮即正确；`agent/disposed`；`tools/change` 幂等（不重复装层）；`loader/volatile-update` 双向切换；guard 四分支 + 同步重判；`global` 零安装零日志；**§6 表逐行一条用例**（含 restrict 安装抛错、释放抛错两条独立行为）；拆除顺序与幂等 |
| 客户端静态契约 | `tests/client-half.test.mjs`（改） | 字典 zh/en 键集相等；新控件 id；`buildSetOps` 五叶子顺序与数组值比较；`RESET_OPS` **仍为 3 条**；scope 区"恢复默认"两条 unset；ops 路径首段 ≡ 宿主 `Config` 顶层键；**只改 scope 的快照换代必须触发重渲染/清脏**（`sameSnapshot`）；`var()` 兜底与无硬编码颜色；降级/空态/失效 id 渲染 |
| 装配回归 | `tests/apply.test.mjs`（改） | `makeCtx` 增加一个**永不回调**的 `inject`（模拟注入未到达 ⇒ 不 warn），既有"能力齐全时不得输出降级日志"原样通过；新增：`mode='selected'` 时缺能力会 warn 一次 |
| 版本/骨架 | `tests/skeleton.test.mjs`（既有） | `6.7.1-r1` 满足 `upstream + -rN`（既有断言） |
| 版本一致性 | `tests/client-half.test.mjs`（既有断言） | 卡片 `PLUGIN_VERSION` ≡ `package.json.version`、`UPSTREAM_VERSION` ≡ vendor `SKILL.md`（既有，无需新增） |

全量命令：`node --test tests/*.test.mjs`（本机 Node 22 下目录参数失效）。基线 577/577（17s，**设计时点快照**；当前 711/711，CI 等价环境 711/709——2 条 skip 是显式声明）。

**人工验收**：① 默认 `global` 下本会话仍见 3 工具；② 切 `selected` 且只勾 `ppt-master` 工作区 → 本会话仍见（**首轮即见**）；③ 在 `hermes` 工作区新开会话 → 工具表无这 3 条；④ 卡片勾选保存后不重启即生效。

## 8. 风险与未知

| # | 风险 | 缓解 |
|---|---|---|
| R1 | ~~宿主热重载是否对 `scope` 叶子触发重挂~~ **已实测否定**（volatile-only 不重挂） | 惰性读引用 + `loader/volatile-update`（§4 步 7） |
| R2 | `tools/change` 在 restrict 两侧都会发 ⇒ 自激 | 差异式安装 + 合并闸门；集成测试锁死幂等 |
| R3 | ~~created→轮次之间的窗口~~ **已消除**（监听器被 await） | G8 + 集成测试断言 |
| R4 | 名单里含已删除的工作区 id | 忽略即可（不影响判定）；卡片给一行文字提示，不做灰态控件 |
| R5 | 客户端 `workspaces` 服务名/形状变更 | 回调式接入 + 类型化读取 + 只读回显降级 |
| R6 | `restrict` 只接受**已知全局工具名**，注册顺序敏感 | 只在 `tools.register` 之后 mount；名字从注册产出派生（C7） |
| R7 | 判定基于会话 header 的 `cwd`；会话中途切工作目录不重判 | README 已知限制；后续可接 `working-directory/change` |
| R8 | **既有缺陷（不属本特性）**：`venv` 三叶子在 apply 期被拍平，卡片改 venv 后工具侧可能仍读旧值（与 R1 同源） | 本特性不动 venv 路径；在交付报告里登记，不夹带修改 |
| R9 | 市场截图 `assets/screenshot-1-config-card.png` 因卡片新增一节而过时 | **本特性不重制**（需活 GUI），登记为发布后续项（§9） |

> **R8 后续（issue #16，2026-10-18）**：R8 已修——`venv` 三叶子改经 `lib/venv.js` 的
> `createVenvReader()` **每次现读**，`index.js` 传**原始** `opts.venv` 而非装配期快照，并补
> `loader/volatile-update` 订阅使「配置无效」在保存时即报。上表 R8 行的「不夹带修」是 scope
> 那个 PR 的历史结论，**保留不改**。唯一仍为注册期快照的是合成入口技能正文
> （`lib/skill-provider.js`：宿主技能目录无更新钩子，正文脚注指向两个实时工具）。

## 9. 文档与发布

- 版本 `6.7.1 → 6.7.1-r1`（`CONTRIBUTING.md`「版本与发布」：仅包装层自身修订 ⇒ 追加 `-rN`；对应澄清 C4）；同步 `package.json`、`lib/client.js` 的 `PLUGIN_VERSION`（`UPSTREAM_VERSION` 仍 `6.7.1`）、双语 README 版本表与版本历史行。
- 双语 README 各补一节「工具可见范围 / Tool visibility scope」：三个键、两种模式、判定规则、已知限制（技能不收窄、中途切目录不重判、残留层需重启、截图待重制）。
- `cordis.patch.yml`：**只加注释示例，不写真实 `config` 块**（builder check Q4）。理由：patch 的 `config` 是整体替换而非深合并，写进去等于替所有使用者钉死一份配置；配置的正确编辑器是插件页卡片。
- 市场截图重制**不在本特性范围**（R9），登记为发布后续项。
- GitHub Flow：issue → `feat/tool-scope` 分支 → PR（squash）→ 合并后同步内网镜像；tag `v6.7.1-r1` 在合并后打。

## 10. 排除范围（明确不做）

- 不做权限/安全边界：不防"另一插件转调"、不防 CLI 直调。
- 不做按会话、按模型、按 preset 的粒度。
- 不做工作区的新增/重命名/删除（只读取注册表）。
- 不做 skill 收窄（宿主无通道）[B6]。
- 不做"实时显示每个 agent 当前判定"的调试面板（无宿主→客户端通道）。
- 不改 `venv` 行为（含 R8 的陈旧问题），不改上游 vendor 树。
- 不重制市场截图（R9）。

## 11. 审查裁决记录

> 注：本节表内 `F#` 属**对齐审查**序列；正文与各轮记录中出现的 `结构审查 F5`、`SF5`/`RF5`/`GF5` 分属结构/落地/工具面各自的编号序列，与表内 `F5` 不同源，勿混。

| 编号 | 来源 | 裁决 |
|---|---|---|
| F1 | Gate0 对齐（P0） | **采纳**：C1 的"答不出来 ⇒ fail-open"与 [Q2]「和 cherry 一致」冲突。改为 §6 的总原则：无法判定即落更严一侧；仅"上一轮已有判定 + 本轮瞬时读取失败"维持上一轮。C1 在澄清文档里同步改写为 C1′ |
| F2 | Gate0 对齐（P0） | **采纳**：补 `ctx.on` 缺失档位；guard 缓存未命中改为**同步重判**（`resolveNow`）而非直接放行 |
| F3 | Gate0 对齐（P1） | **采纳**：C6 补全后半——服务不可用时**只读回显当前名单 + 指向 profile 配置** |
| F4 | Gate0 对齐（P1） | **采纳**：`RESET_OPS` 保持 3 条；scope 区自带"恢复默认"两条 unset |
| F5 | Gate0 对齐（P1） | **采纳**：非法配置统一落更严一侧（`selected + []`），与 §0 记载的 cherry 行为一致；装载期 `ValidationError` 是宿主的更早一道闸，两者不再矛盾 |
| F6 | Gate0 对齐（P1） | **采纳**：取消"同步首判先装层"；`agent/created` 返回 promise（宿主 await）⇒ 首轮即正确（G8） |
| F7 | Gate0 对齐（P2） | **采纳**：§5.6 引用既有 `apply.test.mjs` 的"恰好 3 项"断言 |
| F8 | Gate0 对齐（P2） | **采纳**：空名单是合法态，不显示为降级 |
| F9 | Gate0 对齐（P2） | **采纳**：去掉灰态控件；R8 只登记不夹带 |
| BQ1 | builder check（阻塞） | **已按 (a) live 实现**：惰性读引用 + `loader/volatile-update` + 运行期双向切换；venv 的同类陈旧**不在本特性修**（R8） |
| BQ2 | builder check | **选 await 方案**：`agent/created` 监听器内做权威 `resolveByPath`（G8） |
| BQ3 | builder check | **不在本特性重制截图**（R9） |
| BQ4 | builder check | **只加注释示例**，不写真实 `config` 块 |
| BQ5 | builder check（脚注） | **采纳**：差异式安装，禁止"每轮先释放再重装" |
| SF1 | Gate0 结构（P0） | **采纳**：`global` 短路拆两层——装配期无条件建探针 + `loader/volatile-update` 订阅，只短路"注入 + 装层 + warn"（§5.3） |
| SF2 | Gate0 结构（P1） | **采纳**：§5.3 补判定缓存结构与生命周期 |
| SF3 | Gate0 结构（P1） | **采纳**：§6 拆开"能力缺失 / 瞬时读失败 / 明确无归属"三类，pending 不 warn |
| SF4 | Gate0 结构（P1） | **采纳**：瞬时读失败维持已有判定，无判定者放行 + warn + 重试 |
| SF5 | Gate0 结构（P1） | **采纳**：卡片降级面收窄为客户端可观测量，宿主侧降级只走 warn + README |
| SF6 | Gate0 结构（P1） | **采纳**：插入点改为 `reset.hint` 之后 |
| SF7 | Gate0 结构（P1） | **采纳**：卡片保留自有 `SCOPE_KEY` 字面量，一致性由断言锁死 |
| SF8 | Gate0 结构（P1） | **采纳**：`LEAF_ORDER` 改路径对形式，两函数从它派生 |
| SF9 | Gate0 结构（P1） | **采纳**：补 `readScope` / staged 叶子集合 / `sameSnapshot` 三处漏改 |
| SF10–SF14 | Gate0 结构（P2） | **采纳**：伪码去掉占位符并统一走 `isVisible`；`工作区 ${id}` 写法；测试表按 §6 逐行；版本一致性断言归到 `client-half` |
| SF15 | Gate0 结构（P2） | **采纳**：失效 id 行可勾掉移除、不可新增 |
| SF16–SF19 | Gate0 结构（P2） | **采纳**：文件清单补 `apply.test.mjs`；签名统一为 `{scopeConfig, toolNames, warn}`；CONTRIBUTING 引用改正；guard 写死装在根 ctx、由根 disposer 释放 |
| SF20 | Gate0 结构（P2） | **采纳**：§3 增交付切片 A/B |
| SF21 | Gate0 结构（P2） | **采纳**：§4 步 2 注明 `index.js` 不变量注释需同步收窄 |
| RF1 | Gate0 落地（P0） | **采纳**：`scope` 两个 volatile 叶会打红 `check-dsh-compat` 的 `VOLATILE_LEAF_COUNT=3`；改动清单补 `scripts/check-dsh-compat.mjs`（3→5）与 `tests/compat.test.mjs`（替身 schemastery 补 `array` + 计数断言 3→5） |
| RF2 | Gate0 落地（P1） | **采纳**：`agent/created` 监听器 `.catch()` 兜住——宿主把监听器 reject 当成会话创建失败，判定失败最多"本轮没隐藏"，不得连累开会话 |
| RF3 | Gate0 落地（P1） | **采纳**：`resolveByPath` 加 1500ms 上界（`Promise.race`），超时按 `unresolved` 处理，避免慢盘挂住建会话 |
| RF4 | Gate0 落地（P1） | **采纳**：`dispose` 经 `ctx.effect` 注册进 cordis 生命周期（`typeof ctx.effect === 'function'` 守卫，既有 `makeCtx` 无 `effect` 时跳过） |
| RF5 | Gate0 落地（P2） | **采纳**：卡片把 `WorkspaceSnapshot.state/phase` 纳入判定，loading 首帧显示"正在读取"，不误报"宿主没有工作区" |
| RF6 | Gate0 落地（P2） | **采纳**：`tests/client-half.test.mjs` 的 `calls.injects` 精确断言改为 `[['configForms'], ['workspaces']]` |
| RF7 | Gate0 落地（P2） | **记录**：guard 的同步重判依赖 workspaces/pathMap 快照，而 guard 在注入之前安装——此时 `listAvailable=false`，verdict 直接放行；round 起来后快照才生效（代码即注释） |
| RF8 | Gate0 落地（P2） | **记录**：层随 agent ctx 卸载自动解除，"残留层需重启"只覆盖 `dispose` 抛错这一路径（README 已按此措辞） |
| RF9 | Gate0 落地（P2） | **采纳**：非法配置的 warn 用 `warnOnce`（每进程一条），不随轮次刷屏 |
### Gate 3（代码审查）裁决

| 编号 | 严重度 | 裁决 |
|---|---|---|
| GF1 | P0 | **采纳**：`agents.list()` 读失败与"读成功但为空"必须分开——否则一次瞬时失败会拆掉所有限制层（工具重现、调用全被拒、且无路径装回）。`readLiveAgents()` 改返回 `{ok, list}`；`!ok` ⇒ 本轮不产生新判定 + 复检 |
| GF2 | P1 | **采纳**：guard 同步重判只对 `no-match` 放行；`no-cwd` / `unresolved` 是有结论的不可见，必须拒绝 |
| GF3 | P1 | **采纳**：`selected` + 缺 `ctx.on` 补 warn（此前只落地"只判定一次"，可诊断性落空） |
| GF4 | P1 | **采纳**：`registry.list()` 失败补 1000ms 复检；且复检计数每轮结束后重置（否则一次瞬时失败永久失去自愈） |
| GF5 | P1 | **采纳**：假宿主 `restrict` 补齐真宿主三条前置条件（scoped ctx / 非空 filter / 已知工具名）；`check-dsh-compat` 增 §7.7⑦ 对**真实 ToolRuntime** 实跑 `restrict`（根 ctx 必抛 "scoped context"）与 `guard`（返回 disposer） |
| GF6 | P1 | **采纳**：`ctx.inject` 抛错时立即撤掉 guard 与 `denyAll`；`global` 分支改为**无条件**清理（此前 `!activated` 直接短路，会让默认 global 下三个工具永久不可调用） |
| GF7 | P2 | **采纳**：`resolveNow` 的 docstring 改为"只服务 guard 的同步裁决" |
| GF8 | P2 | **采纳**：`workspaceHolder` getter 改为返回**同一代稳定**的函数引用（否则每次渲染都退订重订） |
| GF9 | P2 | **采纳**：双语 README「已知限制」补齐"残留层需重启清除""截图待重制"两条 |
| GF10 | P2 | **采纳**：补"注入尚未到达 ⇒ 不 warn、不判定"用例 |
| GF11 | P2 | **采纳**：`Promise.race` 的超时定时器在正常返回时 `clearTimeout` |
| GF12 | P2 | **采纳**：`WorkspaceSnapshot.state === 'error'` 归到 error 态，不再被显示成"宿主没有工作区" |
### Gate 3 第 2 轮（复审修复波）裁决

| 编号 | 严重度 | 裁决 |
|---|---|---|
| GR2-1 | P1 | **采纳**：`denyAll` 不得在 global 分支清零——它承载"能力缺失"这一**粘性**事实，清零会让 `global → selected` 一圈把 fail-closed 反转成 fail-open。改为 `state.capabilityLost`（粘性结论）+ 每次进入 selected 时 `denyAll = capabilityLost`；global 分支只挂起与释放层/guard（`verdict` 已被 `suspended` 短路）。`ctx.inject` 抛错改为**保持 guard + 全拒**，与"宿主无 `ctx.inject`"同口径 |
| GR2-2 | P2 | **采纳**：复检必须"有界且可自愈"——`MAX_RETRIES = 3`，且只有**完整成功**的一轮（注册表读成功 + agent 列表读成功）才清零计数。此前每轮清零会退化成 1Hz 轮询。**（第 3 轮 GR3-1 修正：轮级清零口径仍漏判定级，见下表）** |
| GR2-3 | P2 | **采纳**：加代际令牌 `state.epoch`（`syncMode` 挂起与 `dispose` 时自增），`judgeOne` 在 `await` 回来后校验——否则在飞轮次会把刚释放的层装回去（global 下该会话继续被隐藏；`dispose` 后留下永不释放的层） |
| GR2-4 | P2 | **采纳**：§7.7⑦ 探针补两个盲点——`guard()` 返回 `undefined` 必须报 problem（此前静默通过）；新增**正向路径**：在真 `agent` 作用域里实跑 `tools.restrict({deny})` 并断言返回可调用 disposer（依赖可选包 `@deepseek-ai/dsh-scope`，缺失只记 note） |
| GR2-5 | P2 | **采纳**：客户端 F8/F12 补回归用例（`state:'error'` 文案分支、`workspaceHolder` 同代引用稳定 + 换代换引用） |
### Gate 3 第 3 轮裁决

| 编号 | 严重度 | 裁决 |
|---|---|---|
| GR3-1 | P1 | **采纳（GR2-2 的修正案）**：复检额度改为**按 key 记账、按该 key 自己的结果清零**——`agents-list` 在读成功的一轮清零；agent 额度只在判定**不再是 `unresolved`** 时清零（`judgeOne`）。GR2-2 的"整轮成功才清零"只覆盖轮级失败（`registry.list` / `agents.list` 抛错），判定级 `unresolved`（cwd 被删 ⇒ realpath ENOENT；挂载点挂死 ⇒ 1500ms 超时）下整轮照样"成功"，额度每轮归零 ⇒ 无界轮询，且每个未决 agent 每轮各排一个 timer ⇒ N 个 agent 轮次按 N^t 放大（实测 2 agent 24s 内 `list()` 调 478 万次）。配套：`scheduleRetry` 同 key 去重（`pendingRetries`，同一波只排一个 timer）。修复后同场景实测 21 次（3 次/轮 × 7 轮）后完全停住；额度耗尽后靠外部事件自愈（`tools/change` / `loader/volatile-update` / `agent/created`，均实测装回层）。**不做指数退避**：去重 + 每 key 上界已把失控增长消灭，退避只改变 3 次复检的间隔分布，却拉长回归测试的收敛窗口，收益不成比例 |
| GR3-2 | P2 | **采纳**：`installGuard` 自身幂等（`state.releaseGuard !== undefined` 即返回）。GR2-1 把 `ctx.inject` 抛错改为"保持 guard + 全拒"后，激活分支每次 volatile 更新都会重走，若不判重，旧 disposer 被覆盖丢失、宿主 guard 层每次配置编辑 +1 条（实测 3 次更新后 4 条、切 global 仍残留 3 条且每次工具调用都被执行）。修复后实测：3 次 volatile 更新 guard 恒为 1，`inject` 每次仍被重试（自愈语义保留），切 global 归零。测试侧配套把假宿主 guard disposer 从"一刀清空"改为**精确摘除自己**——否则累积型泄漏被静默掩盖 |
