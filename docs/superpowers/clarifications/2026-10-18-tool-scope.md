# 需求澄清：插件工具可见范围（全局 / 指定工作区）（2026-10-18）

> 任务名：`2026-10-18-tool-scope`。本文件是 Phase 0-4 的需求真相源：后续 design/spec/plan 与它冲突时以本文件为准。
> 触发：用户要求「参考我 github 的 dsh-cherry-bridge 插件，提支持配置全局还是指定工作区列表内可见插件工具的 feature，并尝试完成」。

## 0. 参考实现（事实，非用户选择）

`SAXEM1997/dsh-cherry-bridge`（已 clone 至 `/tmp/cherry-probe` 通读）把"哪些工作区看得见 14 个 `cherry_*` 工具"做成独立子系统：

- `src/toolScope.ts`（1043 行）：作用域文档 `{version, revision, updatedAt?, mode:'global'|'selected', workspaceIds[]}`、可见性严格序、原子写、降级注记集合（5 个固定来源）、判定缓存。
- `src/toolScopeHost.ts`（1083 行）：宿主集成——能力三态探针、`ctx.inject(['agents','workspaceRegistry'])`、逐 agent 安装 `agent.ctx.tools.restrict({deny})`、全局 `tools.guard` 兜底、`tools/change` 事件合并重算、拆除顺序。
- 判定两条规则（§4）：① 工作区 `sessionIds` 含该 agent ⇒ 命中；② 否则用 `workspaceRegistry.resolveByPath(session.header.cwd)` 的**规范路径**匹配。
- 默认值 `DEFAULT_SCOPE = {mode:'selected', workspaceIds:[]}`（谁都不给），且**任何读不出/非法文档都落到更严一侧**。

本插件不复刻其规模：它是 14 个工具 + 独立设置页 + 自有 HTTP API；本插件只有 3 个工具，且已有插件页配置卡片与 `configForms` 写通道。复用的是**语义**（mode/workspaceIds、两条判定规则、装配层移除 + 执行层兜底、fail-closed），不是代码。

## 1. 用户问答

### Q1（我提）这个开关你第一次会拿它挡掉哪类会话——是某个跟 PPT 完全无关的工作区，还是那些临时目录、没登记成工作区的会话？

**A（用户，2026-10-18）**：「减少的 ppt 无关的工作区的工具列表干扰」

⇒ **意图是降噪，不是安全隔离**：让 `hermes` / `oa` / `llm` 这类与 PPT 无关的工作区里，模型看到的工具表不再出现 `ppt_master_info` / `ppt_master_check_env` / `ppt_master_setup_deps`。
⇒ 由此确定：这是"按工作区收窄工具表"的需求，主用例是**长期存在的无关工作区**，不是"临时目录"。

### Q2（我提）不属于任何工作区的会话（临时目录里新开的、或目录没登记成工作区）在 `selected` 模式下算哪边？

**A（用户，2026-10-18）**：「和 cherry 插件一致，但默认值不一样，本插件默认全局」

⇒ 两件事：
1. **边界与 cherry 一致**：`selected` 模式下，不属于任何已登记工作区的会话**不可见**（fail-closed）。含 `session.header.cwd` 缺失、`resolveByPath` 返回 `undefined`（宿主不拥有该目录）两种情形。
2. **默认值与 cherry 相反**：本插件缺省 `mode = 'global'`（谁都能看见，与今天行为逐字一致），而不是 cherry 的 `selected + []`（谁都不给）。

### Q3（我提，已声明为限制，用户未反对）技能条目是否也跟着收窄？

我告知：宿主对 **skill** 没有等价的 per-agent 隐藏通道（`skills.registerProvider` 只分全局层与 preset 作用域层），本版只收窄**工具**。
**用户未提出异议**（其原话为"插件工具"）。⇒ 本特性范围＝3 个工具；技能条目在任何工作区仍可见，写入 README 与卡片说明。

## 2. 边界条件与隐含假设

| # | 项 | 结论 | 来源 |
|---|---|---|---|
| B1 | 缺省配置 | `{mode:'global', workspaceIds:[]}` ⇒ 行为与今天一致 | 用户（Q2） |
| B2 | `selected` 且名单为空 | 谁都不给（含名单内不存在时）——严格序最严一侧 | 用户（Q2 与 cherry 一致） |
| B3 | 会话 `cwd` 缺失 | 不可见（`selected` 下） | 用户（Q2 与 cherry 一致） |
| B4 | `cwd` 不属任何已登记工作区 | 不可见（`selected` 下） | 用户（Q2） |
| B5 | 名单里的工作区 | 可见；与今天行为一致 | 用户（Q1 降噪目标） |
| B6 | 收窄对象 | 仅 3 个 `ppt_master_*` 工具；技能条目不受影响 | 用户（Q3 未反对）+ 宿主能力限制 |
| B7 | 生效时延 | 保存配置即生效，不需重启 DSH（宿主对配置变更热重载插件） | 既有 config-ui 特性已确立 |
| B8 | 降级形态 | 宿主缺 `tools.restrict` / `tools.guard` / `agents` / `workspaceRegistry` 时不得崩，且必须留下可诊断痕迹 | 本插件既有约定（安静降级 + warn） |
| B9 | 零新增依赖 | 不引入 npm 依赖、不引入构建链；宿主半边纯 ESM、客户端半边手写自包含单文件 | 仓库既有硬约束 |

## 3. 用户明确不要 / 明确排除

- 不做独立设置页 / 自有 HTTP API（cherry 那套是为 14 个工具 + 设备配对设计的）。
- 不做"每个会话单独开关"（粒度只到工作区）。
- 不改 `venv` 三个键的键名、语义与卡片既有行为。
- 不为了本特性去改上游 `skills/ppt-master/**`（红线）。

## 4. 待我（实现者）裁决、已标注为「我的判断」的点

以下用户未表态，由我裁决并写入 design doc，审批时可推翻：

- **C1** "宿主答不出来"与"宿主答：无归属"要分开：前者（服务未注入 / `list()` 抛错）**fail-open + 显式降级提示**；后者（`no-cwd` / `no-match`）**fail-closed**。理由：本特性目的是降噪，把 PPT 工具从用户自己的 PPT 工作区里藏掉是功能损坏，而降噪失效只是噪音。
- **C2** `tools.restrict` 装不上时退化为 **guard-only**（工具仍列出、调用被拒）并提示；不静默放行。
- **C3** `resolveByPath` reject（`unresolved`）排队一次 1000ms 重试，之后维持不可见。
- **C4** 版本号按 `CONTRIBUTING.md` 版本策略递增为 `6.7.1-r1`（上游 6.7.1 未变，属包装层自有特性）。
- **C5** 配置面放在插件 cordis `Config`（`scope.*`），不引入独立 JSON 文档：与既有卡片/`configForms` 写通道同源，省掉第二套原子写与文件锁。
- **C6** 卡片的工作区勾选列表依赖客户端 `workspaces` 服务；该服务不可用时**不给手输 ID 的退路**（手输 UUID 拼错＝静默失效），改为只读展示当前名单 + 提示走 profile 配置。
- **C7** 工具名清单从 `createTools()` 的产出派生，不写第二份字面量，并由一条测试锁定。

## 5. 修订（Gate 0 审查 + builder check 之后，2026-10-18）

### C1 → C1′（**已改判**）

原 C1：「宿主答不出来 ⇒ fail-open」。Gate 0 对齐审查指出它与 [Q2]「和 cherry 插件一致」冲突（cherry 连读不出/非法都落更严一侧）。**改判为三类分离**：

- **能力缺失**（宿主永远做不到，如无 `ctx.inject`）⇒ **fail-closed**：全局 guard 全拒本插件工具 + warn；
- **瞬时读失败**（`registry.list()` 抛错）⇒ 本轮不产生新判定：已有判定保留、无判定者放行 + warn + 1s 重试（不拿一次读失败去改写用户的工作区可见性）；
- **明确回答"无归属"**（无 cwd / `resolveByPath` 返回 undefined）⇒ fail-closed 不可见（即 [Q2]）。

### C6 补全（后半）

服务不可用时不只是"不给手输 ID"，还要**只读回显当前名单**并提示去 profile 配置改——否则降级态用户既看不见也改不了。

### 新增 C8 / C9

- **C8**（builder check Q4）：`cordis.patch.yml` 只加**注释示例**，不写真实 `config` 块——patch 的 `config` 是整体替换而非深合并，写进去等于替所有使用者钉死一份配置。
- **C9**（builder check Q3 / 结构审查）：市场截图 `assets/screenshot-1-config-card.png` 因卡片新增一节而过时，**不在本特性重制**（需活 GUI），登记为发布后续项。

### 事实补充（实测，非用户选择）

- **volatile-only 配置变更不重挂插件**（`cordis-plugin-loader/lib/index.js:382-424`）⇒ 配置必须惰性读取 + 监听 `loader/volatile-update`。
- **`agent/created` 监听器会被宿主 await** ⇒ 在监听器里做权威 `resolveByPath` 可保证"首轮工具表即正确"。
- **`tools.restrict` 在安装与释放两侧都 emit `tools/change`** ⇒ 必须差异式安装，否则合并闸门永久脏。
- **`venv` 三叶子存在同类陈旧问题**（apply 期快照）：属既有缺陷，本特性不夹带修（设计 R8）。
