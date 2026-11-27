# AGENTS.md — 面向在本仓库工作的 AI agent

> 本文件是**给 agent 看的**：机制备忘、红线、测试地图与版本记账。人类向文档见
> [README.md](README.md)（中文）/ [README.en.md](README.en.md)（English）；协作流程见
> [CONTRIBUTING.md](CONTRIBUTING.md)。机制细节的**权威源是代码**，本文件只做索引与摘录。

## 1. 红线（先读，违反即返工）

- **`skills/` 是 vendor 面**：与上游 release **逐字节一致**，受上游 `attribution_guard.py`
  完整性门校验。任何改动（哪怕一行注释）都会破坏同步与校验链——上游更新只能经
  `scripts/sync-upstream.mjs` 进入。
- **`venv` 三叶子必须一起现读**（R8，issue #16 已修）：`venv.enabled` / `path` /
  `oldPathPolicy` 共享同一语义（`effectiveInterpreter` 一次性吃三个），故任何一处改动都要
  三处同步、且都经 `lib/venv.js` 的 `createVenvReader()` 现读——**不得**在 apply 期拍平成
  闭包常量（宿主对 volatile-only 变更不重跑 apply，拍平即永久陈旧）。R8 的原始登记面在
  `docs/superpowers/specs/2026-10-18-tool-scope-design.md`（§8 表 R8 行，:239；该行的
  「不夹带修」是 scope 那个 PR 的历史结论，**不要改写**；现行状态见该表后的追加注记）。
  唯一仍为注册期快照的是合成入口技能 `ppt-master-env` 的**正文**（宿主技能目录无更新钩子，
  正文自带脚注指向两个实时工具）。venv 设计文档
  （`2026-10-15-ppt-master-venv-config-design.md`）未登记 R8——其 R# 序列（R3–R12）属另一套编号。
- 工具清单**只从 `createTools()` 的产出注册**，不得写第二份名字字面量（`when` 判定不再需要名单）。
- 零 npm 依赖（`package.json` 无 `dependencies`/`devDependencies`），测试与脚本只用
  Node 内置模块。
- `main` 受保护：issue → 分支 → PR → squash merge，严禁直推（实测 `GH006` 拒绝）。

## 2. 入口技能四态路由（ppt-master-env）

任何 `ppt-master` 路由前先读内存合成的 `ppt-master-env`（不落盘，权威源
`lib/skill-provider.js` 合成正文）。四态：

1. **venv 开、已建且就绪**（`<path>/bin/python3` 与 `<path>/bin/pip3` **两者**可用）
   → 上游脚本一律用 `<path>/bin/python3` 替换字面 `python3`（含 `SKILL.md` 第 2 步
   guard 调用），并代入 `SKILL_DIR`；
2. **venv 开但未建** → 先调 `ppt_master_setup_deps`，此前不用系统解释器（`python3`；Windows 上可能只有 `python`）跑业务脚本；
3. **venv 关** → 系统解释器：`python3` 达标时用它；缺失或低于 3.10 时改用达标的 `python`
   （实际命中的命令以 `ppt_master_check_env` 的 `python:` 行为准）；
4. **配置无效** → 按正文修正后走系统模式。

**未就绪子态**（有 `bin/python3` 缺 `bin/pip3` 的半成品）按②处理；恢复＝删除重建
（缺 ensurepip 时先装 `python3-venv`）。三面口径一致原则：`info` / `check_env` /
入口正文对同一形态不得分叉；正文是注册期快照，实时以两个工具的输出为准。

## 3. DSH 宿主机制备忘（改插件前必读）

- **volatile 语义**：cordis-plugin-loader 对只改 volatile 叶子的配置变更走
  `_commitVolatile()`（内部以 `updateVolatile()` 原地换代后直接 `return`）——
  **原地改引用、不重挂插件、不重跑 apply**，随后 emit `loader/volatile-update`。
  （该包版本随宿主走：0.2.1 锁 `~1.0.6`、0.2.2 锁 `~1.1.0`——两版语义逐字节相同，
  故不钉行号，改版后按方法名检索。）
  插件必须持有引用容器、每轮现读。两处既有实现：`scope` 走 `lib/scope-host.js` 的
  `when()`（宿主每步调用一次，每次现读 `opts.scope`），`venv` 走 `lib/venv.js` 的
  `createVenvReader()`（每次调用现读，`index.js` 传**原始** `opts.venv` 而非装配期快照）。
- **工具 `description` 可以是 getter**：宿主 `register()` 按引用存定义对象，模型侧投影在
  **每次投影**时解构 `definition.description`——0.2.2+ 是 `projectToolSchema()`，0.2.1 及
  更早是 `schemaOf()`，两代均实测；故 `get description()` 能跟上 volatile 换代
  （`ppt_master_info` / `ppt_master_check_env` 即此写法）。
- **步骤级可见性 `when`（0.2.2-alpha.2+，本插件 scope 的唯一机制）**：
  `tools.register(def, { when })` 后，宿主每步（`preStep`）调一次
  `tools.resolve({agent, modelSelection, signal})`，对每个已注册工具 `await when(context)`；
  真才进本步可见集。**同一步所有工具复用同一个 context 对象**（故判定器可按 context 记忆
  本步结论），`toolSet` 在工具批结束后 `dispose()`。执行侧 `tools.executable(name, scope,
  toolSet)` 只看本步准入集：**带 `when` 的工具在「步外」（无 `toolSet`）一律不可执行**，
  模型侧调用隐藏工具按 `UNKNOWN_TOOL` 失败（README 已如此描述）；条件抛错则包成
  `ToolActivationError`。故 `when` 必须同步、永不抛、一切不确定收敛成 `false`。**0.2.1 及更早没有 `when`/`resolve`**
  （npm 0.2.1-rc.5 实测 0 处），第二参会被静默忽略 ⇒ `selected` 失效且无报错；本插件
  因此把 `engines.dsh` 抬到 `>=0.2.2-rc.1`，并在 `apply` 用 `assertWhenCapable()`
  自检 `tools.resolve`（缺失即 fail-loud）。`when` 里不要 `await`：异步精化（
  `judgeAgent` + `resolveByPath`）只排到后台，本步按不可见处理。
- **schemastery 受控解析**：`index.js` 在模块加载期**先裸导入**
  `import('@deepseek-ai/schemastery')`——装好的插件由 Node 从 profile 的 `node_modules`
  解析（与官方插件、与 `@wenaixi/dsh-ponytail` 同一条路径），**零环境变量依赖**；未命中才
  落回「定位宿主 node_modules + `createRequire`」的兜底通道（锚点必须是定位到的
  node_modules 内路径，锚在 index.js 本身必 `MODULE_NOT_FOUND`）。**别指望那四个环境变量**：
  `DSH_HOME` / `DSH_PROFILE` / `DSH_PROFILE_DIR` 只由 `dsh-shell-env` 在**每次 shell 调用时
  现造**（宿主 asar 内 `process.env.DSH_PROFILE` 出现 0 次），`dsh-app-boot` 的 `.env` 分层
  又把 `DSH_*` 前缀列为 bootstrap-only 直接拒绝——四级 env 链在正常安装形态下**必然全落空**
  （v6.9.0-r2 之前 Desktop 直启与普通终端起 `dsh` 的装载失败即此，报错签名「无任何级别可
  探测」）。解析失败＝整插件不可加载。**装载期是异步的（顶层 `await`）**：兜底通道在 `require` 之前先 `await import()` 预热
  schemastery 的 ESM-only 依赖 `@deepseek-ai/cosmokit`——宿主 loader 并行创建插件条目，
  不预热则 `require(esm)` 会撞上正在加载的 cosmokit 并抛 `ERR_REQUIRE_ESM_RACE_CONDITION`，
  整个插件不装载（issue #36）。预热的**解析锚点必须是 schemastery 入口**（`cosmokit` 是它的
  依赖，profile 根的副本只是提升布局的巧合；锚在根上则 pnpm 严格布局下静默退化）。预热
  失败被吞、落回原 `require` 路径，真失败仍由同一条点名诊断报出。定位链**两侧不同，勿混**：脚本侧（`scripts/check-dsh-compat.mjs` 的
  `resolveDshModules`）五级——`--dsh-modules` 参数 > `DSH_NODE_MODULES` >
  `DSH_PROFILE_DIR/node_modules` > `DSH_HOME/profiles/$DSH_PROFILE/node_modules` >
  `DSH_HOME/profiles/node_modules`（末级未命中再无序扫描 profiles/*）；**插件装载侧**
  （`index.js` 的 `locateDshModules`）有意收窄为 **env 四级**——无 explicit 参数级、
  无扫描回落，未命中即 fail-loud（§4 的红灯签名「定位链四级均未命中」即出此侧）。
- **客户端卡片**：槽位 `plugins.bundle.config`；`configForms` 等可选服务必须
  `ctx.inject([...], cb)` 回调式接入（硬注入会让 apply 挂起 pending）；CSS 设计令牌是
  `--dsw-*`，一律写 `var(--token, 兜底)`（令牌名写错且无兜底 ⇒ 整条声明被静默丢弃）。
- **`ctx.tools.register` 的 `output.render` 必须返回内容块数组** `[{type:'text',text}]`，
  返回字符串会 `content.some is not a function`。

## 4. 测试与校验地图

| 命令 | 用途 | 基线 |
|---|---|---|
| `node --test tests/*.test.mjs` | 全套（目录参数在 Node 22 失效，必须 glob） | 733 tests / 731 pass / 0 fail / 2 skip（无宿主 SDK、以默认 stub 树补齐依赖时；CI 即此形态——skip 判据是 stub 未导出 assertSupportedJsonSchema）；本机真实 SDK 环境 730 pass / 1 fail（同上 `envFileExists`）。**例外**：本机存在 `~/.ppt-master/.env` 时 `setup_deps` 的 `envFileExists` 用例会额外红一条（与 SDK 无关，CI 无该文件） |
| `node scripts/check-dsh-compat.mjs` | 对照已装 DSH SDK 的契约检查（§7.7 六项 + §7.7⑦ 工具可见范围契约） | OK、warnings 0。**profile 树缺 peer 依赖时本机会失败**（实测 `dsh-llm` 的 peerDependency `@deepseek-ai/dsh-error` 未提升 ⇒ `SDK 包 @deepseek-ai/dsh-tools 动态导入失败`）；那是环境问题不是回归，改用宿主自带树 `--dsh-modules /npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules`（该树缺 `superpowers-dsh`，故 warnings 1） |
| `node scripts/verify-plugin.mjs --upstream .upstream/refs/tags/<ref>@<sha>` | 完整性 + provider/工具面校验 | 需显式 `--upstream`（缺省 fail-loud exit 1） |

- **2 条 skip 的原因**：`@deepseek-ai/dsh-tools` 经**包自身**解析不可达（本包零依赖，
  stub 树不经包解析链）——skip 是显式声明，非失败。
- **干净机器（无宿主 SDK / CI）**：`node tests/helpers/stub-sdk.mjs <dir>` 建默认 stub
  node_modules，再以 `DSH_NODE_MODULES=<dir>/node_modules` 跑上表前两条。构造器三层：
  `buildStubSdk(modules, knobs)`（显式目录、幂等 rm+建）/ `makeStubSdk(knobs)`（mkdtemp，
  compat.test.mjs 消费，knob 集见其签名）/ CLI。CI 工作流 `.github/workflows/ci.yml`
  即此两条；`verify-plugin` 不入 CI（第⑥项需真实上游比对树）。
- **schemastery 前置的红灯形态（实测签名）**：`tests/apply.test.mjs`、
  `tests/verify-plugin.test.mjs` 静态 import 入口——干净机器上**文件级**失败；而
  `tests/compat.test.mjs` 的 13 处 in-process `runCompatCheck` 走真实动态 import（封不住
  `process.env`），洁净环境 **41 例中 9 红**，可辨识签名是 `schemastery 定位失败 …
  定位链四级均未命中`；CLI 子进程用例自带 stub 树不受影响。
- 测试文件地图：`sync-*.test.mjs`（同步脚本纯函数/编排，编排用真实临时 git 仓库）、
  `scope*.test.mjs`（工具可见范围纯逻辑/宿主集成）、`client-half.test.mjs`（卡片）、
  `compat.test.mjs`（SDK 契约 + stub 保真）、`loader.test.mjs`（装载期宿主包解析：
  裸导入优先 / env 链兜底）、`apply/verify-plugin/venv/tools-*/skill-provider/
  frontmatter/skeleton`（各对应模块）。

## 5. 版本与同步记账

版本规则：`base` 镜像上游 release；包装层自身变更追加 `-rN`（无后缀视为 r0）。
同步时 `sync-upstream.mjs` 自动联动改写 `lib/client.js` 的 `PLUGIN_VERSION` /
`UPSTREAM_VERSION`（`applyVersionLinkage`，改写进同步 commit）；README 版本表仍是人工。

Release 说明**中英双语各一份**，结构＝「一段严谨口吻的总结 + **每个 PR 一行**的变更列表」；
机制细节归 issue/PR，不塞进 release body。从下一个发布起（首个带 `docs/releases/` 的版本），说明文件放
`docs/releases/v<version>.md`，随 release PR 一起评审——它同时是 GitHub Release 的正文。
格式细则见 `docs/agents/maintainer-ops.md` §5。

npm 是**第二条发布渠道**（插件市场据此解析版本与更新）：推 `v<version>` tag 触发
`.github/workflows/release.yml`——门禁（tag 与 manifest 一致、notes 存在、版本记账四处齐、
stub 树全套、`npm pack`）→ `npm publish --provenance`（仓库 secret `NPM_TOKEN`，版本已存在则
跳过）→ 本地打包与 registry 产物**逐文件比对**（一致才建 Release；不按字节比，tar 元数据会随环境变化）→ `gh release create --notes-file`。移除 2FA
人工闸门后，**坏 tag 会立刻进 registry**，门禁是唯一防线。若 `NPM_TOKEN` 受 npm「限制绕过 2FA
的 token」新政影响，兜底是 `publish.yml` 的 `npm stage publish` + 维护者 `npm stage approve`。
`publishConfig.registry` 钉死 npmjs（本机默认 registry 是镜像站；`npm stage list|approve` 不读
publishConfig，须显式 `--registry`）。**上传在 CI 侧做**——本机出口上行 ~23 KB/s，17.7 MB 传不完。
两条硬约束不变：checkout `refs/tags/v<version>` 并断言 manifest 一致、`--provenance` +
`id-token: write`。修订版在 semver 里是**预发布**，故每次必须显式 `--tag latest`，且 `^6.9.0`
不含它。细则见 `docs/agents/maintainer-ops.md` §6。

| 版本（tag） | 详细说明 |
|---|---|
| `v6.7.0` | 首次交付：vendor 上游 v6.7.0（约 78 MiB，逐字节）+ skill provider + 三生命周期工具 + verify/compat/sync 三脚本 |
| `v6.7.0-r1` | 规则③自动 bump 首跑：Gate 3 审查修复——`mapDistToImport` 原型键防护、branch-ref last-sync 可读性、`envFileExists` 三处探测、规则③执行主体修订 |
| `v6.7.0-r2` | UltraReview 两轮修复：规则③自触发锚定排除、push 部分失败 tag 补推、branch sha 缓存、git/tar 工具链缺失归 7、marketplace 版本校验层级修正、`env` 第 4 探测位置、依赖映射 19/19、`${SKILL_DIR}` 独立判据、`.gitignore` 卫生、dry-run 状态写门控 |
| `v6.7.0-r3` | venv 解释器隔离 + 插件页配置卡片（客户端半边）+ GitHub 发布面（双语 README/NOTICE/logo） |
| `v6.7.1` | 上游同步（规则①）：vendor v6.7.1 逐字节 |
| `v6.7.1-r1` | 工具可见范围（`scope.mode`/`scope.workspaceIds`，默认 global）：per-agent `tools.restrict` 装配层移除 + 根 ctx `tools.guard` 兜底；有界复检（额度按 key 记账）+ guard 幂等 + 代际令牌；Gate 3 四轮收敛（F1-F12 / GR2-1..5 / GR3-1..2，裁定表见 design §11）；670/670（r1 时点；现 720） |
| `v6.7.1-r2` | 审查修复波（#12/PR #13）：P0 stub-sdk 所有权标记守卫（原可删 cwd 真实依赖树）；scope 运行时加固（`safeString` 防装载失败 / 注入看门狗 / disposed 清理 / 每轮单次刷新）；卡片勾选框基值缺失禁用 + `.is-readonly` 样式；compat §7.7⑦ 补 `dsh-scope`/`execute`/`guardReason` 三面与 guard 拒绝语义断言；M10 单轮严格判据；M25 覆盖 1000/1500/5000 三类 timer unref。同时含 #8 常量联动 / #9 CI+stub SDK / #11 README+AGENTS 三批工具链与文档变更 |
| `v6.7.1-r3` | venv 配置**现读**（#16/PR #17，设计 R8 由「登记未修」转「已修」）：`lib/venv.js` 新增 `createVenvReader()`（每次现 `.get()`、total、不改「未配置」语义）；`lib/tools.js` 三个 builder 改经 accessor、`info`/`check_env` 的 description 改 getter；`index.js` 传原始 `opts.venv` 并订阅 `loader/volatile-update` 使配置无效保存即报；入口技能正文仍为注册期快照（脚注补明配置变化亦可能陈旧）。测试 711 → **720** |
| `v6.7.3` | 上游同步（规则①）：vendor v6.7.3 逐字节（refs/tags/v6.7.3@622bf0148bca4f697b0184322c7e2aa2a04520a2），`lib/client.js` 两常量随 `applyVersionLinkage` 改写为 `6.7.3`／`6.7.3`；包装层 `v6.7.1-r1..r3` 三次修订按规则①归零。附带包装层修复：`scripts/verify-plugin.mjs` 的 `baseName` 同时切 `/` 与 `\`（旧实现只切 `/`，Windows 绝对路径下 `upstream/skills/<name>` 拼成整条路径，第⑥项误报并以退出码 4 中断同步） |
| `v6.8.0` | 上游同步（规则①）：vendor v6.8.0 逐字节（refs/tags/v6.8.0@5e8856be0da8e6bc85c4aa28acc614478f7b7137），`lib/client.js` 两常量随 `applyVersionLinkage` 改写为 `6.8.0`／`6.8.0`，`package.json.version` 同为 `6.8.0`；结构分类 🔴 0 项、走自动路径。`requirements.txt` 相对 v6.7.3 **无变化**（仍 19 条依赖，本机 venv 无需重建）；上游支持的 Python 上限改为 3.14（本机 venv 3.11.2 在范围内），`ppt_master_check_env` 仍按 vendor 文件现读。测试保持 720/720 |
| `v6.8.0-r1` | 包装层修订（#31，无运行时行为变更）：`check-dsh-compat` 的 guard 探针适配 DSH 0.2.2 的「执行外置」契约——`executionModelOf()` 按 `tools.setExecutor` 存在性分流，batch 侧自挂 `@deepseek-ai/dsh-tool-executor-native` 并按 `{calls:[…]}` 调用、结果经 `firstToolResult()` 取 `results[i].result`；single 侧保持 0.2.1 单调用。stub SDK 新增 `executorModel: 'batch'` 形态（`setExecutor` + executor 替身 + `executorLog`/`batchCalls`），新增 4 例（2 纯函数 + 2 端到端/降级，含批量入参形状自证与降级 warning），测试 720 → **724**。同时清 `schemaOf`/loader 行号等陈旧坐标，并在 §3 登记两代执行契约。真机 0.2.1-rc.5 与 npm 0.2.2-rc.1 树双绿；vendor 树仍 v6.8.0 逐字节 |
| `v6.8.0-r2` | scope 运行时两处收口（#33，运行时行为有变）：① **注入看门狗 5s → 30s**——boot 期 `dsh-workspace` 要开 storageDomain 再扫 session 头，注入回调常在 5s 后才到（本机 33 次启动、跨 0.2.1-rc.5/0.2.2-rc.1 两代），旧值把正常启动写成「判定未生效 ⇒ 工具处处可见」且永不撤回；② **装层前判活**——`cannot create effect on inactive context` 的真含义是「会话已销毁」（cordis `assertActive()` 只在 `fiber.uid === null` 时抛，`uid` 仅 dispose 时置空），mnemon idle review 的短命子会话不再刷 `restrict 安装被宿主拒绝`（本机 701 条 / 670 个 id 中 545 条紧随 mnemon 失败行，属抽样归因、非全量；**重启后真机实测归零**）；`judgeOne` 同时不把已销毁会话的判定写进缓存，且同 id 换代时旧判定作废；③ 新增一条 `scope 已激活（注入等待 Nms）：判定 N 个会话，隐藏 M 个`。`watchdogMs` 选项**仅供测试与排障**覆盖默认值（M25 spy 守护默认 30s）。重启后真机实测：注入等待 **14331ms**（旧 5s 阈值必误报），该次启动 8 条 mnemon idle review 失败对应 **0** 条 `restrict 安装被宿主拒绝`（改前为 1:1）。新增 8 例（M26×3：晚到不告警 / `watchdogMs` 阈值上界 / 轮次中切 global 不得记摘要；M27×5：判定期销毁、restrict 瞬间销毁、存活仍被拒须告警、判活 fallback、同 id 换代旧判定作废），测试 724 → **732**；默认 `global` 仍零新增日志 |
| `v6.8.0-r3` | 装载期竞态修复（#36/PR #38，运行时行为有变）：`schemastery@3.19.0` 的 CJS 构建首行同步 `require()` ESM-only 的 `cosmokit`，而宿主 loader 用 `Promise.all` 并行创建插件条目；同批另有插件正在经 ESM 加载 cosmokit 时，该 require 抛 `ERR_REQUIRE_ESM_RACE_CONDITION`，**整个插件不装载**（三工具 + vendored skill 全不可用，启动只留一行 `did not activate`）。修法（采纳 @knsew 的 #37，PR #38 接管）：`loadSchemastery()` 改 async，在同步 `require` 之前先 `await import()` 预热 cosmokit，随后 require 必命中已加载态；入口模块因此带**顶层 await**。相对 #37 补三处：① 预热解析锚点由 profile 根改为 **schemastery 入口**（cosmokit 是它的依赖，根上副本只是 npm 提升布局的巧合；pnpm 严格布局下根锚点解析失败会被 `catch` 吞掉、预热静默退化）；② 新增 T5⑨ 与 stub knob `schemasteryCosmokit: absent|hoisted|nested`（ESM-only cosmokit 替身 + schemastery 替身的顺序守卫，表达「require 前 cosmokit 必须已由 ESM 加载完毕」而不依赖 `require(esm)`；默认 `absent` 下既有用例零变化）；③ AGENTS §3 装载期口径与 §4 基线。红→绿三态实测：`main` 两布局皆红、#37 补丁在 nested 布局红、本版两布局皆绿。**本机复现不出真实竞态**（profile 里 117 个宿主模块在 boot 期已把 cosmokit 加载完；plain `Promise.all`、微任务错峰、fs 队列灌满、pass-through ESM hook、真 cordis loader 并发消费者全部试过，均绿）⇒ 这条用例证明的是「预热先于 require」这条契约，不是「在报告者 profile 上不再复现」，后者由报告者真机验证。测试 732 → **733**；vendor 树仍 v6.8.0 逐字节。**另记**：`engines.node` 原为 `>=20.0.0`，与真实链路不符（需 `require(esm)`，即 Node ≥22.12）——由 #40 处理 |
| `v6.8.0-r4` | 环境声明与仓库约定修订（#41 / #39 / #42，**无运行时行为变更**）：① `engines.node` 由 `>=20.0.0` 校正为 **`>=22.12.0`**——装载链路 `index.js → require(schemastery) → schemastery 的 CJS 构建首行 require(ESM-only cosmokit)` 是 Node 的 `require(esm)`，22.12.0 起才默认开启；取插件自身下限而非宿主 `>=24.9.0`（0.2.1 宿主未声明 engines，照抄会无谓拦住 0.2.1 用户）。② CI 兼容 job `node20-compat` → **`node22-compat`**，`node-version` 钉死 `22.12.0`——上方 `test` job 跑 Node 22 最新版，与声明下限重复则发现不了「用了比 22.12 更新的 API」；原 `node20-compat` 常年绿但跑的是无 cosmokit 的 stub 树，永远走不到 `require(esm)` 一跳，属虚假安全感。job 名变更不影响分支保护（必需检查只有 `test`，已实读确认）。③ release 说明格式固化为「严谨口吻总结 + **每个 PR 一行**的变更列表 + 中英双语」，细则见 `docs/agents/maintainer-ops.md` §5。④ skeleton 用例断言同步 `>=22.12.0`；README 双语表格的 Node 版本要求同步。测试仍 733/733 |
| `v6.9.0` | 上游同步（规则①）：vendor v6.9.0 逐字节（refs/tags/v6.9.0@ce92fb43e4ade9c701f4c869e286f13fce743c72），`lib/client.js` 两常量随 `applyVersionLinkage` 改写为 `6.9.0`／`6.9.0`，`package.json.version` 同为 `6.9.0`；包装层 `v6.8.0-r1..r4` 四次修订按规则①归零。结构变化 1 项经人工确认后走 `--confirm-structural`：`skills/ppt-master/scripts/` 新增 `image_ocr.py`／`image_layers.py`／`image_normalization.py`（三者在上下游 workflows、references、scripts/README 内均有引用），删除 6.8.0 误入 vendor 的 `__pycache__`（`tts_backends/`、`image_backends/` 下的 `.pyc`）。`requirements.txt` 19 条**逐字不变** ⇒ `DIST_TO_IMPORT` 19/19 仍成立、本机 venv 无需重建；`MINIMUM_PYTHON`（硬编码 3.10）与上游声明一致、未动；`SKILL.md` 第 2 步仍是 `python3 "${SKILL_DIR}/scripts/attribution_guard.py"` ⇒ 入口技能正文的 `${SKILL_DIR}` 替换规则仍成立。测试 733 例：732 pass / 1 fail（`tools-setup-deps` 的 `envFileExists`，因本机存在 `~/.ppt-master/.env`；已在 main 的干净 worktree 上复现同一红，与本次同步无关）/ 0 skip；`verify-plugin --upstream .upstream/refs/tags/v6.9.0@ce92…` OK（problems 0、warnings 0）、`check-dsh-compat` warnings 0 |
| `v6.9.0-r1` | npm 发布渠道（#48/#50/#51）：`package.json` 增 `publishConfig{access:public,registry:https://registry.npmjs.org}`；双语 README 安装段把 npm 提为方式一（semver 提示：`6.9.0-r1` 属预发布，`^6.9.0` 不含它）；新增 `.github/workflows/publish.yml` 在 CI 侧 `npm stage publish`（本机出口上行 ~23 KB/s，17.7 MB 传不出；Node 24 因 `npm stage` 需 npm≥11），维护者 2FA `npm stage approve`。workflow 按必填 `version` 检出 `refs/tags/v<version>` 并断言 manifest 版本一致——旧版从触发时的 main 取码，故已发布的 6.9.0 与 tag `v6.9.0` 不同树（出货文件差 README 双语与 package.json）；`id-token: write` + `--provenance` 由 npm 签发绑定 commit/workflow 的证明。另 `execSync` 的 `maxBuffer` 提到 64 MB（13107 文件清单超 1 MB 默认值，首次运行即踩到）。**无运行时行为变更**；npm `6.9.0` 是本规则生效前发布的包，无 provenance、不对应任何 tag |
| `v6.9.0-r2` | 装载期解析回到正路（**运行时行为有变**）：`DSH_HOME` / `DSH_PROFILE` / `DSH_PROFILE_DIR` 在宿主进程里**恒为空**——只由 `dsh-shell-env` 在每次 shell 调用时现造，`dsh-app-boot` 的 `.env` 分层又把 `DSH_*` 前缀列为 bootstrap-only 直接拒绝；原实现只认这几个变量，故 Desktop 直启、或从普通终端起 `dsh` 都在 import 期抛「定位链四级均未命中」，整插件 `did not activate`。改法：`loadSchemastery()` 先**裸导入** `@deepseek-ai/schemastery`（装好的插件由 Node 从 profile 的 `node_modules` 解析，与官方插件、与 `@wenaixi/dsh-ponytail` 同一条路径），未命中才落回 env 四级链 + `createRequire`——那条链现在只服务 `link:` 的符号链接开发形态；返回 `.default` 对 ESM 构建与 CJS 替身都成立，故兜底通道的 cosmokit 预热（#36）原样保留。装载失败文案补「裸导入未命中」与「正常安装下即表示 profile 未提升该包」。新增 `tests/loader.test.mjs` 1 例：把插件按**已安装**形态落进 stub profile、子进程剔除全部 `DSH_*` 后装载必须成功（改前正是截图那句报错）。测试 733 → **734**；vendor 树仍 v6.9.0 逐字节 |
| `v6.9.0-r3` | 工具可见范围迁移到宿主步骤级 `when`（#57 的验收面，PR #58/#59/#60/#61/#62/#63；**运行时行为有变**）：删 per-agent `tools.restrict`、根 ctx `tools.guard`、`agent/created` 订阅、注入看门狗、复检定时器，净删约 2100 行；三个工具 `tools.register(def,{when})`，宿主 `preStep` 每步 `resolve` 一次、同一步复用同一 context。`when` 同步永不抛（抛错会让整步准备失败 `ToolActivationError`）；`global` 零注册表读取、零新增日志；`selected` fail-closed。判定两级：`resolveNow`（成员 + 字符串路径）+ 异步精化（`judgeAgent`/`resolveByPath`，单飞 + 2s 节流 + 代际）。缓存按 **agent 对象** WeakMap：正缓存 `{workspaceId,cwd,basis,fingerprint}`——cwd 必须相同，`member` 依据还要求会话仍在名单、`path` 依据要求注册表指纹不变；负缓存 `no-match` 绑指纹（清单变化才重排）、`unresolved` 最多 3 次；按 context 记忆本步结论（宿主同一步三工具复用同一 context）。`engines.dsh` 抬到 `>=0.2.2-rc.1`（0.2.1 静默忽略 `when` 第二参 ⇒ selected 失效且无报错），`apply` 用 `assertWhenCapable()` 自检 `tools.resolve`。compat §7.7⑦ 改为 when 契约探针（真实 ToolRuntime 上 false 排除 / true 纳入 + context 形状），`verify-plugin` 断言三个工具都带 `when`。宿主侧实读核对：`preStep` → `resolve({agent,modelSelection,signal})`；`executable()` 无 `toolSet` 时对带 `when` 的工具返回 `undefined` ⇒ 隐藏工具调用为 `UNKNOWN_TOOL`。测试 734 → **702**（删旧机制用例、补 when 语义与缓存失效）；真机 `selected` 端到端已于 2026-11-19 在 0.2.2-rc.4 宿主上跑通（装载 r3 后跑一轮；随后升级到 v6.10.0 复跑）：成员工作区可见且可执行，配置外的工作区不可见（调用报 `UNKNOWN_TOOL`），改名单保存后**无需重启**即生效——容器启动时刻未变，仅 `when` 被按新配置重算，说明 volatile 热路径与步骤级重算在真机上成立 |
| `v6.10.0` | 上游同步（规则①）：vendor v6.10.0 逐字节（refs/tags/v6.10.0@d8f704bc8c1552d53a8769b55d1eecd22c782042），`lib/client.js` 两常量随 `applyVersionLinkage` 改写为 `6.10.0`／`6.10.0`，`package.json.version` 同为 `6.10.0`；包装层 `v6.9.0-r1..r3` 三次修订按规则①归零。结构变化 **0 项**（vendor 49 files, +2146 −344；新增 7 个上游测试文件，无删除、无目录增删）；`requirements.txt` **逐字未变** ⇒ `DIST_TO_IMPORT` 19/19 仍成立、本机 venv 无需重建；`SKILL.md` 只改 `metadata.version`，第 2 步 guard 调用未动 ⇒ 入口技能正文的 `${SKILL_DIR}` 替换规则仍成立。**本版引入一个新的 vendor 面外溢路径**：上游把「个人模板库」定在 `skills/ppt-master/templates/local/<kind_dir>/`，并在自家 `.gitignore` 里忽略它（release 里从不出现），`update_repo.py` 承诺它跨更新保留。包装层据此做四处适配：① `scripts/sync-upstream.mjs` 新增导出的 `installSkills()`，替换 vendor 面前把 `templates/local/` 暂存到 `.upstream/` 再还原（原 `rmSync` 全树删除会静默毁掉用户数据），并输出保留条目数；暂存走 `movePath()`（`rename` 优先、`EXDEV` 退化复制），**复制失败也 `finally` 归位**、上次崩溃遗留的暂存**先归位再继续**（不能当缓存删）；`classifyChanges()` 同步排除该路径——否则用户一旦有个人模板，每次同步都会被判成 `templates/` 一级条目被删除的 🔴 结构变化；② `scripts/verify-plugin.mjs` 的第⑥项把 `templates/local/**` 列为**唯一面内豁免**（该路径是运行时用户数据，判成「仅存在于被验树」是误报），其余多出文件仍照旧拦截；豁免判据同时接受 `/` 与 `\`——`node:path` 的 `relative()` 在 Windows 上返回反斜杠，只认 `/` 会让豁免在 Windows 静默失效；③ 根 `.gitignore` 忽略该路径，防止本机生成的个人模板被误提交进 vendor 面；④ `scripts/check-pack.mjs` 作为 `prepack` 哨兵——`.npmignore` **不管用**（实测：`files` 白名单含 `skills` 时 npm 不会用根 `.npmignore` 剔除其中文件，`npm pack --dry-run` 仍列出用户模板），故改为发布前 fail-loud 拦截。新增 13 例（`installSkills` 保留/无库/遗留暂存归位/复制失败仍归位/遗留与现场并存时合并 5 例 + `classifyChanges` 不误报 1 例 + ⑥ 豁免且相邻非豁免路径仍拦 1 例 + 分隔符双形态 1 例 + `check-pack` 目录/保留路径上的普通文件/CLI 放行/CLI 拦截/参数用法 5 例），测试 702 → **715**；README 双语补「升级前备份个人模板」提示（该目录在插件包内，`dsh plugin add` 会随包替换）|
| `v6.10.0-r1` | 系统解释器与个人模板库的收口（**运行时行为有变**）：`check_env` 在 `python3` 缺失/低于 3.10 时回退 `python`（达标优先、低版本只兜底），payload 增顶层 `pythonCommand`，渲染改写命中命令；`setup_deps` 系统模式解析 `pip3` → 解释器 `-m pip` → `pip`，并以「未报 Python 2 + minor 与 `check_env`/guard 解释器一致」为准决定是否采用 `pip3`；`python3` 缺失时也走 `python -m pip`。个人模板库：`installSkills()` 暂存还原（遗留先归位、并存合并）、`verify-plugin` ⑥ 豁免、`check-pack` 作 `prepack` 哨兵（`.npmignore` 实测无效）。README 补 Windows 沙箱宿主 `--daemon` 替代；订正 0.2.1 用户应停留 `v6.9.0-r2`。测试 715 → 733 |
| `v6.10.0-r2` | 发版流程改为 tag 驱动（**无运行时行为变更**）：`release.yml` 在 tag push 时完成门禁 → `npm publish --provenance --tag latest` → 本地打包与 registry 产物逐文件比对（#90；本版发布当时是 shasum 比对）→ `gh release create --notes-file --verify-tag`；门禁含 manifest、notes、README/AGENTS 版本行、`lib/client.js` 的 `PLUGIN_VERSION`、附注 tag 且指向 main、vendor 文件数、stub 树全套与 `npm pack`。`publish.yml` 保留为 2FA 兜底；dry-run 的 `source_ref` 可在 main 上预演。初版流水线里同义反复的 shasum 校验已修正。 |

同步退出码：`0` 成功/最新；`1` 用法；`2` 结构变化待人工（🔴 含 skill 目录增删、改名、
`metadata.version` 缺失）；`3` 完整性门失败；`4` verify 失败（vendor 未触碰）；`5` 网络/
来源失败；`6` 推送失败/tag 冲突；`7` 工具链缺失。

## 6. 删除安全实现判据（改 `lib/venv.js` 前须知）

自动删除只对**带所有权标记**（`<venv>/.ppt-master-wrapper.json`）且四条件全满足的目录
生效：路径≠当前、新旧路径互不**段感知**前缀包含（`/a/venv` 不包含 `/a/venv-older`）、
`pyvenv.cfg` 存在、带标记。①②按 **canonical 路径**判定（`realpath` 化到内核语义后比
较；`dev+ino` 相等作额外正判据，`st_ino`/`st_dev` 为 0 的退化 FS 上自动停用）。删除原语
收到的是配置**原值**。限定：canonical 折不掉的别名（bind mount）不在保护面内。孤儿两类
（未标记 / 有标记无登记）均**永不自动删**；登记位置 `<HOME>/.ppt-master/wrapper-state.json`
与 venv 常居持久卷存在层级错配（容器重建后登记丢失 ⇒ 有标记孤儿），取舍为保持单一登记。

## 7. 兼容面负向确认（改动后须保持的"零"）

- 合成入口 `ppt-master-env` **不落盘**——`verify-plugin.mjs` 字节比对面零变化；
- `sync-upstream.mjs` 不读取本插件产物（scope/venv 与同步零交互面）；
- 默认 `scope.mode=global` 下**零新增日志**（`apply.test.mjs`「能力齐全时不得输出降级
  日志」用例守护）；在 ≥0.2.2 宿主上，默认配置行为与"没有该特性"逐字一致（<0.2.2
  会在装载期 fail-loud，这是有意的兼容门，不是降级）。
- 默认 `venv` 配置（`enabled=false` + 合法默认路径）下同样**零日志**：`loader/volatile-update`
  订阅只在 `invalidReason` **变化且非 null** 时报一条（同一原因重放不刷）——由
  `apply.test.mjs`「配置改成非法路径 → 保存后立即 warn；同一原因不重复刷」用例守护。
- `createTools()` **无参**时 `venv` 仍是"未配置"（判定落 `invalid`、`path=null`），不得被
  `createVenvReader` 补成默认三字段——那是 `apply` 装配面才有的"空袋→off 行"语义。

## 8. 设计文档索引

`docs/superpowers/specs|plans|clarifications/` 按特性归档（OpenSpec CLI 缺席，Phase 1 走
跳过路径，`.superpowers/.phase1-skipped` 为证）。

工具可见范围机制已在 2026-11-18 改为步骤级 `when`：现行设计见
`docs/superpowers/specs/2026-11-18-tool-scope-when-design.md`；`2026-10-18-tool-scope-design.md`
只保留「为什么当初那样做」的历史，其 §5/§6 的 restrict/guard 实现描述已过时。

§11 审查裁定表**只有一篇 design 有**——`2026-10-18-tool-scope-design.md` §11「审查裁决记录」
（:260 起），内含 Gate 3 三轮分节裁决；实测 `grep -c '^## 11' docs/superpowers/specs/*.md`
对其余三篇均为 0，且 `2026-10-16-ppt-master-config-ui-design.md`、venv、base wrapper 三篇
design 都没有 §11 节。其余三篇的审查记录分散在这些位置，没有统一编号：

- **`2026-10-14-dsh-ppt-master-wrapper`**：`.superpowers/sdd/2026-10-14-dsh-ppt-master-wrapper/`
  下 `ultra-merged-table.md`（R1）、`ultra-r2-merged-table.md`（R2）是合并判断表，
  `ultra-raw-findings.md` / `ultra-r2-raw-findings.md` 是原始条目，`progress.md` 是单行小结；
  其中没有「§11」命名，也没有统一裁定表。
- **`2026-10-15-ppt-master-venv-config`**：裁定散在
  `.superpowers/sdd/2026-10-15-ppt-master-venv-config/progress.md`（Gate 3 round=1/2、
  `Ruling:` 行、`[GATE_PASSED]`）与 `docs/superpowers/plans/2026-10-15-ppt-master-venv-config.md`
  「spec 偏差登记」（:214 起，标 Gate 3 编号 G3-*）；同目录还有 `gate3-fix-report.md`、
  `gate3r2-fix-report.md`、`gate3-step1-digest.md`、`gate3r2-digest.md`。没有集中裁定表。
- **`2026-10-16-ppt-master-config-ui`**：`.superpowers/sdd/2026-10-16-ppt-master-config-ui/progress.md`
  里有一行 Gate 3 结论（`Gate 3: PASS —`，含 P2/P3 处置），
  `docs/superpowers/plans/2026-10-16-ppt-master-config-ui.md` 有「存疑点与裁决记录」节
  （:339，Gate 2 输入），`clarifications/2026-10-16-ppt-master-config-ui.md` 有 1 处终裁。
  没有集中裁定表。

## Agent skills

### Issue tracker

GitHub Issues（`gh` CLI）。See `docs/agents/issue-tracker.md`.

### Triage labels

默认五角色：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。See `docs/agents/triage-labels.md`.

### Domain docs

single-context：根目录一份 `GLOSSARY.md`、`docs/adr/`，均按需创建。See `docs/agents/domain.md`.

### Maintainer ops

外部贡献者 PR 的 CI 批准（fork run 停在 `action_required`，需手动批准一次）、
`.upstream/<ref>@<sha>` 比对树构建、宿主 SDK 跨版本 tarball diff、合并收尾清单。
See `docs/agents/maintainer-ops.md`.
