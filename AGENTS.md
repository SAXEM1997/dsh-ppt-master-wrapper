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
- 工具名清单**只从 `createTools()` 派生**（`toolNamesOf`），不得写第二份字面量。
- 零 npm 依赖（`package.json` 无 `dependencies`/`devDependencies`），测试与脚本只用
  Node 内置模块。
- `main` 受保护：issue → 分支 → PR → squash merge，严禁直推（实测 `GH006` 拒绝）。

## 2. 入口技能四态路由（ppt-master-env）

任何 `ppt-master` 路由前先读内存合成的 `ppt-master-env`（不落盘，权威源
`lib/skill-provider.js` 合成正文）。四态：

1. **venv 开、已建且就绪**（`<path>/bin/python3` 与 `<path>/bin/pip3` **两者**可用）
   → 上游脚本一律用 `<path>/bin/python3` 替换字面 `python3`（含 `SKILL.md` 第 2 步
   guard 调用），并代入 `SKILL_DIR`；
2. **venv 开但未建** → 先调 `ppt_master_setup_deps`，此前不用系统 python3 跑业务脚本；
3. **venv 关** → 系统 `python3`；
4. **配置无效** → 按正文修正后走系统模式。

**未就绪子态**（有 `bin/python3` 缺 `bin/pip3` 的半成品）按②处理；恢复＝删除重建
（缺 ensurepip 时先装 `python3-venv`）。三面口径一致原则：`info` / `check_env` /
入口正文对同一形态不得分叉；正文是注册期快照，实时以两个工具的输出为准。

## 3. DSH 宿主机制备忘（改插件前必读）

- **volatile 语义**：cordis-plugin-loader 对只改 volatile 叶子的配置变更走
  `_commitVolatile()`（`lib/index.js:395`，`updateVolatile()` 在 :415 原地换代后直接
  `return`）——**原地改引用、不重挂插件、不重跑 apply**，随后 emit `loader/volatile-update`。
  插件必须持有引用容器、每轮 `ref.get()` 现读，并在该事件上重算。两处既有实现：
  `scope` 走 `lib/scope-host.js`（每轮现读 + 事件重算），`venv` 走 `lib/venv.js` 的
  `createVenvReader()`（每次调用现读，`index.js` 传**原始** `opts.venv` 而非装配期快照）。
- **工具 `description` 可以是 getter**：宿主 `register()` 按引用存定义对象，模型侧投影
  `schemaOf()` 在**每次投影**时解构 `definition.description`（`dsh-tools/lib/index.js:3136`），
  故 `get description()` 能跟上 volatile 换代（`ppt_master_info` / `ppt_master_check_env` 即此写法）。
- **`agent/created` 监听器会被宿主 await**：reject ⇒ 会话创建失败。放权威判定时必须
  `.catch()` + 超时上界（scope 的 `RESOLVE_TIMEOUT_MS=1500`）。
- **`tools.restrict()` 只能在 agent 作用域调用**（根 ctx 调用抛
  "requires a scoped context"），且**安装与释放两侧都 emit `tools/change`**——重算必须
  差异式装层，否则自激；`tools.guard()` 装在根 ctx，返回 disposer。
- **schemastery 受控解析**：`index.js` 在模块加载期经「定位宿主 node_modules +
  `createRequire`」取 `@deepseek-ai/schemastery`（禁 ESM 裸导入；锚点必须是定位到的
  node_modules 内路径，锚在 index.js 本身必 `MODULE_NOT_FOUND`）。解析失败＝整插件
  不可加载。定位链**两侧不同，勿混**：脚本侧（`scripts/check-dsh-compat.mjs` 的
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
| `node --test tests/*.test.mjs` | 全套（目录参数在 Node 22 失效，必须 glob） | 720 tests / 718 pass / 0 fail / 2 skip（无宿主 SDK、以默认 stub 树补齐依赖时；CI 即此形态——skip 判据是 stub 未导出 assertSupportedJsonSchema）；本机真实 SDK 环境 720/720 |
| `node scripts/check-dsh-compat.mjs` | 对照已装 DSH SDK 的契约检查（§7.7 六项 + §7.7⑦ 工具可见范围契约） | OK、warnings 0 |
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
  `process.env`），洁净环境 **36 例中 7 红**，可辨识签名是 `schemastery 定位失败 …
  定位链四级均未命中`；CLI 子进程用例自带 stub 树不受影响。
- 测试文件地图：`sync-*.test.mjs`（同步脚本纯函数/编排，编排用真实临时 git 仓库）、
  `scope*.test.mjs`（工具可见范围纯逻辑/宿主集成）、`client-half.test.mjs`（卡片）、
  `compat.test.mjs`（SDK 契约 + stub 保真）、`apply/verify-plugin/venv/tools-*/skill-provider/
  frontmatter/skeleton`（各对应模块）。

## 5. 版本与同步记账

版本规则：`base` 镜像上游 release；包装层自身变更追加 `-rN`（无后缀视为 r0）。
同步时 `sync-upstream.mjs` 自动联动改写 `lib/client.js` 的 `PLUGIN_VERSION` /
`UPSTREAM_VERSION`（`applyVersionLinkage`，改写进同步 commit）；README 版本表仍是人工。

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
  日志」用例守护）；默认配置行为与"没有该特性"逐字一致。
- 默认 `venv` 配置（`enabled=false` + 合法默认路径）下同样**零日志**：`loader/volatile-update`
  订阅只在 `invalidReason` **变化且非 null** 时报一条（同一原因重放不刷）——由
  `apply.test.mjs`「配置改成非法路径 → 保存后立即 warn；同一原因不重复刷」用例守护。
- `createTools()` **无参**时 `venv` 仍是"未配置"（判定落 `invalid`、`path=null`），不得被
  `createVenvReader` 补成默认三字段——那是 `apply` 装配面才有的"空袋→off 行"语义。

## 8. 设计文档索引

`docs/superpowers/specs|plans|clarifications/` 按特性归档（OpenSpec CLI 缺席，Phase 1 走
跳过路径，`.superpowers/.phase1-skipped` 为证）。

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
