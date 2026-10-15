# ppt-master venv 隔离 + 配置页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 dsh-ppt-master-wrapper 引入可选 venv 隔离（懒创建、可配路径、旧路径清理策略）、原生 cordis Config 配置页（volatile + apply 去引用快照），以及承担解释器路由的合成入口 skill `ppt-master-env`。

**Architecture:** 四模块分层——`index.js`（Config 声明 + apply 统一注入包/去引用/降级视图）→ `lib/venv.js`（纯函数 + 注入 run 的全部 venv 决策与副作用原语）→ `lib/tools.js`（探测编排与 payload 组装，`setup_deps` 唯一副作用点）→ `lib/skill-provider.js`（vendor 技能 + 内存合成入口 skill）。配置经宿主 config-editor→Loader 重建热生效；不触碰上游文件。

**Tech Stack:** Node ≥20 ESM、零 npm 依赖（schemastery 经受控解析取自宿主）、node:test、Python 3 stdlib venv（仅 POSIX）。

**Spec:** `docs/superpowers/specs/2026-10-15-ppt-master-venv-config-design.md`（181 行，Gate 0 两轮审查后版本）；需求真相源 `docs/superpowers/clarifications/2026-10-15-ppt-master-venv-config.md`

## Global Constraints

- 零 npm 依赖：不打包、不声明 dependencies/peerDependencies/devDependencies；schemastery 经"宿主 node_modules 定位 + createRequire 等价受控解析"获取，**禁 ESM 裸导入**（spec §5.1/§6.1⓪）。
- 方案A 字节级 vendor：`skills/` 树与上游逐字节一致；入口 skill 内存合成、不落盘、不进 verify-plugin 比对面（spec §5.2/§7.5）。
- POSIX-only：一律 `bin/`、`python3`/`pip3` 拼写；Windows 出范围（spec §2 非目标）。
- Config 三字段**叶子级** `.volatile()`，不两层叠加；apply 入口统一 `.get()` 去引用快照为普通对象后下传（spec §5.1 引用语义）。
- 懒创建：venv 的创建/删除**只**发生在 `ppt_master_setup_deps`；配置保存/修改零副作用（spec §4.3，Q1/Q5）。
- 删除安全四条件：路径≠当前、互不前缀包含、`pyvenv.cfg` 存在、带标记——缺一不删（spec §5.4）。
- 测试命令一律 glob 形态：`node --test tests/*.test.mjs`（目录形式本机 MODULE_NOT_FOUND）。
- 回归基线：现有 382 用例的**行为断言**保持全绿；**形状断言**随 venv 增量同步修订——依 spec §7.2 **通用授权**：凡逐字属性集 `deepEqual` 类断言均可随增量修订，修订面限于形状（下列清单是已探明面，不是授权上界）。逐文件清单与归属：`tools-info:105-113`/`:263`（T7）；`tools-check-env:208-224`（T8）；`tools-setup-deps:242/341/394/544` + 常量 `DIAGNOSTIC_FIELDS:71`（**T8 连带面**——经 `setupDepsOutputSchema` 内嵌诊断四字段引用）与 `tools-setup-deps:234/276/536` + 常量 `SETUP_FIELDS:68`（**T9 载荷面**，两者分属不同 Task，勿互占）；`skeleton:37-47`（files 白名单）/`:50-59`（exports 三条目，T5 条件项见其 Step 3）；`apply.test:194-198`（T6，见下行）；`compat.test` 既有基线**按测试名定位**（T10 **追加+既有基线联动修订**，非仅追加）：`runCompatCheck 基线: stub SDK 全绿` 的 `problems` 空集断言、`CLI: --dsh-modules stub --skill-roots fixture → exit 0 且输出 OK` 与 `CLI: --skill-roots 逗号多根 → 两根的 skill 均读回` 的 stdout 断言。
- 预期行为变更登记（区别于"修订授权扩面"）：入口 skill 仅当 scanRoots 缺省（生产包内根）时追加，故 `tests/apply.test.mjs:194-198` 的生产根列表 deepEqual 将含 `ppt-master-env`——这是本特性预期行为变更，随 Task 6 同步修订。
- fs 注入缝与 HOME 隔离：凡路径含 `~`/`os.homedir()` 的原语（`resolveVenvPath`/`wrapperStatePath`/`readMarker`/`writeMarker`/`readWrapperState`/`writeWrapperState`）其测试**必须**把 `process.env.HOME` **赋值为非空 tmpdir 路径**，teardown **赋回原值（禁 `delete` 还原）**——POSIX `os.homedir()` 遵循 env（本机 Node v22.23.3 实测），否则测试一跑即在真实 `/root/.ppt-master` 造文件（该路径当前不存在）。两种误用已实测排除：`delete process.env.HOME` → 落 `getpwuid` 回退（本机返 `/root`），**不是隔离手段**；`HOME=''`（空串）→ `os.homedir()===''` 且**不回退 passwd**，属"配置无效降级"的输入而非回落。删除失败注入经 `cleanupOldVenv` 的可选 `{remove}` 依赖（默认 `rmSync`）；marker/state 写失败注入一律经**函数桩**、无第二条通道（`lib/venv.js` 直测面替换模块函数引用；tools.js 编排面经 `createTools` 的 `testSeams` 注入同名替身；root 下 `chmod` 无效已实测，只读目录与 fs stub 两条均不采用）。
- 配置发现通道（负约束）：不调用 `ctx.settings.configure()`，沿用宿主 auto 出页默认策略（spec §5.1 发现通道）；实现出现 `configure(` 调用即偏离。
- 非目标与门槛锚定（勿顺手动）：不做 venv 移动/重定位（stdlib venv 不可重定位，迁移≡新建+重装+可选删旧，实现面无任何 rename/copy 路径）、不引入依赖版本锁定（不装 pip-tools/lockfile，`requirements.txt` 仍上游原样）、`enabled=false` 分支不触任何删除原语（禁用后清理纯手动 `rm -rf`）；`engines.node` 与 `dsh.engines.dsh` 两处版本门槛维持现状（spec §6.1 尾句 `0.1.1-rc.1`，本特性不上调）——保护面已由 `skeleton:13-29`（顶层 `engines` 深比较）与 `skeleton:62-66`（`pkg.dsh.engines.dsh` 字面 + `bundle.patch`）锁定，**不另补用例**。
- 并发立场（no-locking，沿用 spec §6 末行）：不加锁、不排队、不新增锁原语；同路径并发 `ensureVenv` 依赖"缺才建"幂等，双建竞态可能失败但复跑自愈——不承诺最终一致（用例见 Task 9 Step 1）。
- 每 Task 一个 commit（main 直推，本仓库既有惯例）。

## Review Focus

以下失败模式源自 spec，但不在任何单 task 的主干路径测试里显式覆盖——每条已在归属 task 的步骤中以测试钉住：

1. **非空非 venv 目标目录**（误配指向含数据目录）→ 必须拒绝创建且不写标记（Task 3 Step 1）。
2. **exists-but-broken**（容器重建后符号链接失效）→ 体检识别、不自动删、恢复指引（Task 2/3/9）。
3. **loader 形态 volatile 引用未去引用** → apply 边界经纯函数 `snapshotVenvConfig(raw)`（**Task 5 落 `lib/venv.js`**）快照为普通值，下游不得感知引用；Task 5 Step 1① 直测该函数，注入袋形态由 Step 1②③ 直测同批落地的组合纯函数 `assembleInjectionBag(raw)` 观测——**探针 provider 捕获方案作废**。直测载体选择理由：二者皆无宿主依赖的纯边界函数，是"引用对象→普通值"形态差与注入袋键集的唯一可直接观测面，较经 provider 回读少一层装配耦合。
4. **嵌套路径**（旧路径是新路径前缀）→ cleanup 拒绝（Task 4 Step 1）。
5. **wrapper-state 写失败** → 清理结果如实保留、登记失败单独上报（Task 1/9）。

---

### Task 1: lib/venv.js 基础原语（路径解析 / 存在性 / marker / wrapper-state）

**Files:**
- Create: `lib/venv.js`
- Test: `tests/venv.test.mjs`

**Interfaces:**
- Produces（后续 Task 2/3/4/5/6/8/9 全部消费；入参 `venv` 一律为**去引用后的普通对象** `{ enabled: boolean, path: string, oldPathPolicy: 'keep'|'delete' }`）:
  - `resolveVenvPath(venv) -> { path: string|null, invalidReason: string|null }`：`~` 按 `os.homedir()` 展开；**`os.homedir()` 返回空串（HOME='' 实测不回退 passwd）→ `~` 展开判无效，即 `{path:null, invalidReason:'unresolvable'}`，交 §6 配置无效降级消费——严禁拼出 `'/.ppt-master/…'` 之类根级路径**；相对路径→`{path:null, invalidReason:'relative-path'}`；其余空/非法→`invalidReason:'unresolvable'`；`enabled=false` 不在此判定（纯路径语义）。
  - `venvExists(dirPath) -> boolean`：`<dirPath>/pyvenv.cfg` 存在性。
  - `MARKER_FILENAME = '.ppt-master-wrapper.json'`；`readMarker(dirPath) -> {createdAt:string, path:string}|null`；`writeMarker(dirPath) -> void`（写 `{createdAt: ISO, path: dirPath}`）。
  - `wrapperStatePath() -> string`（`<homedir()>/.ppt-master/wrapper-state.json`）；`readWrapperState() -> {lastVenvPath: string|null}`（不存在/读失败→`{lastVenvPath:null}` 且不抛）；`writeWrapperState(lastVenvPath) -> void`（失败抛错由调用方处理）。

- [ ] **Step 1: 写失败测试** — `tests/venv.test.mjs`：**用例前置把 `process.env.HOME` 赋值为非空 tmpdir 并在 teardown 赋回原值（禁 `delete`——delete 落 `getpwuid` 回退本机 `/root`，Global Constraints fs 缝）**；`resolveVenvPath` 矩阵（`~`/绝对/相对/空串，`~` 行断言展开到该 tmpdir 而非真实 homedir）；**HOME 边界两用例**：① `HOME=''`（显式赋空串）→ `resolveVenvPath` 判无效 `invalidReason:'unresolvable'`（`os.homedir()` 实测返空串、不回退 passwd）；② `delete process.env.HOME` → `os.homedir()` 落 `getpwuid` 回退值，按本机实测（`/root`）如实写入断言并注明该值随宿主用户而变、非隔离手段；`venvExists` 真/假；marker 写读回环 + 收编语义（已存在 venv 缺标记→`readMarker` null→`writeMarker` 后可读）；`wrapper-state` 不存在→null、写入→读回；**写失败注入**：以**函数桩**（替换 `writeWrapperState` 实现）使其抛错且可被捕获（root 下 chmod 无效，只读目录与 fs stub 两条均不采用）。

- [ ] **Step 2: 运行确认失败** — `node --test tests/venv.test.mjs` → FAIL（模块不存在）。

- [ ] **Step 3: 实现** — 新建 `lib/venv.js` 上述 **7 个函数 + 1 个常量**（`MARKER_FILENAME`）导出（纯 fs/os，无副作用承诺：本文件此部分只读写 marker 与 wrapper-state 两位置；`snapshotVenvConfig` 与 `assembleInjectionBag` 由 Task 5 追加进本文件，本 Task 不含）。

- [ ] **Step 4: 运行确认通过** — `node --test tests/venv.test.mjs` → PASS；`node --test tests/*.test.mjs` → 382+新增 全绿。

- [ ] **Step 5: Commit** — `git add lib/venv.js tests/venv.test.mjs && git commit -m "feat(venv): 路径/marker/wrapper-state 原语（spec §5.4）"`

### Task 2: effectiveInterpreter 四态判定原语

**Files:**
- Modify: `lib/venv.js`
- Test: `tests/venv.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1 的 `resolveVenvPath`、`venvExists`。
- Produces: `effectiveInterpreter(venv, { probeVenvInterpreter }) -> { state: 'off'|'invalid'|'on-missing'|'on-ready', pythonPath: string|null, invalidReason: string|null, broken: boolean }`（第二参为**具名原语对象** `{ probeVenvInterpreter }`——design §5.4 抽象写作"探测"，本形参面固化见"spec 偏差登记"）。**双原语定名**（消除同名四形）：`probeVenvInterpreter(venvDir) -> {found}`＝**同步 fs 存在性**探测，**入参为 venv 目录绝对路径，实现内部拼 `bin/python3` 后再探测存在性**（消费方不再自带该拼接；dangling symlink→`found:false`），供 ensureVenv 体检 / effectiveInterpreter / 入口 skill body 三处共用（Task 2/3/6）；与现有 **async 三字段版本探测**（`{found, version, meetsSkillRequirement}`，Task 8 的 `check_env` `venv.python` 用，挂在 venv `pythonPath` 上；`pythonPath=null` 两行——`on-missing` 与 broken 子态——改挂候选 `<absPath>/bin/python3`）是两个不同接口，各 Task 引用对应者。判定序：`enabled=false`→`off`（`pythonPath=null`，行为按系统模式；**`invalid×disabled` 组合落 `off`——disabled 优先，但诊断面 `path` 定值＝null（无效如实，依 spec §5.3 组合细则与 §5.1 可见反馈通道；off 行"按配置原样不解析"仅适用路径合法的 disabled）**，`exists=false` 不探测、`pythonPath=null`、deps/guard 按系统模式）；enabled 且 `resolveVenvPath` 无效→`invalid`；`on-missing`=`!venvExists`；`on-ready` 且 `probeVenvInterpreter(absPath).found=false`→`on-ready`+`broken:true`+**`pythonPath:null`**（exists-but-broken；版本探测候选由消费方按 `<absPath>/bin/python3` 拼接供 Task 8；payload 面即以此实现推断式可观测 `exists=true ∧ pythonPath=null`，见 Task 6/7）。

- [ ] **Step 1: 写失败测试** — spec §5.3 矩阵逐行：off/invalid/on-missing/on-ready(on-ready 含 broken 子态)×(pythonPath/broken)取值；disabled+无效路径→`state:'off'` 且**诊断面 `path=null`（无效如实，非配置原样）**；`probeVenvInterpreter` 用例入参给 venv 目录（断言内部拼 `bin/python3`，目录内建假 `bin/python3` 符号链接→found:true、悬空链接→found:false）；用例前置 HOME 赋非空 tmpdir（同 Task 1，禁 `delete`）。
- [ ] **Step 2: 运行确认失败** — `node --test tests/venv.test.mjs` → FAIL：仅本 Task 追加用例红（`effectiveInterpreter is not a function`），Task 1 既有用例保持绿。
- [ ] **Step 3: 实现** — 追加导出，组合 Task 1 原语 + 注入 `probeVenvInterpreter`（本 Task 一并产出该同步原语，供 Task 3/6 复用）。
- [ ] **Step 4: 运行确认通过** — `node --test tests/venv.test.mjs` → PASS；`node --test tests/*.test.mjs` → 全量全绿（382+新增，无红）。
- [ ] **Step 5: Commit** — `feat(venv): effectiveInterpreter 四态判定（矩阵断言基准）`

### Task 3: ensureVenv（创建/收编前置 + 体检 + 复用）

**Files:**
- Modify: `lib/venv.js`
- Test: `tests/venv.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1/2 全部（体检用 Task 2 定名的**同步** `probeVenvInterpreter`）+ 注入 `run(command, args, options)`（同 tools.js spawnRun 形态，返回 `{exitCode}`）。
- Produces: `ensureVenv(run, absPath, { signal, probeVenvInterpreter, writeMarker }) -> { created: boolean, adopted: boolean, error?: string }`（第三参 options 收依赖；`writeMarker` 缺省即 Task 1 模块函数，测试换桩——写失败注入用**函数形态**，只读目录不可用）。语义（spec §5.4）：目标（不存在→`run('python3',['-m','venv',absPath])` 创建+`writeMarker`，`created:true`）|（空目录→同创建）|（含 `pyvenv.cfg`→体检 `probeVenvInterpreter(absPath)`（Task 2 定名口径：传 venv 目录、内部拼 `bin/python3`，本处不得自带拼接）：可用→缺标记则补写、`created:false,adopted:true` 复用；不可用→`{created:false, error:'venv 解释器不可用（exists-but-broken）——手动删除该目录后重跑'}`，**不自动删**）|（存在且非空且无 pyvenv.cfg→**fail-loud 拒绝** `{error:'目标目录非空且非 venv'}`，不创建不写标记）|（创建 run 非零/spawn 失败→`{error:…}`）。

- [ ] **Step 1: 写失败测试**（Review Focus #1/#2/#5 之一）— **五类结果矩阵**（与 Interfaces 五分支一一对应，含"复用行标记补写失败仍复用"）+ **非空非 venv 拒绝且目录文件原样保留、无 marker** + broken 拒绝不删 + 创建 argv 逐字断言（`['-m','venv',absPath]`）+ 桩 `writeMarker` 抛错路径断言（写失败不改写 `created`/`adopted` 结论，仅上报）。
- [ ] **Step 2: 运行确认失败** — `node --test tests/venv.test.mjs` → FAIL：追加用例红（`ensureVenv is not a function`），Task 1/2 用例仍绿。
- [ ] **Step 3: 实现** — 追加 `ensureVenv`。
- [ ] **Step 4: 运行确认通过** — `node --test tests/venv.test.mjs` → PASS；`node --test tests/*.test.mjs` → 全量全绿。
- [ ] **Step 5: Commit** — `feat(venv): ensureVenv 前置三态/拒绝/体检/复用（P0-3 收编前置）`

### Task 4: cleanupOldVenv（四条件删除）

**Files:**
- Modify: `lib/venv.js`
- Test: `tests/venv.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1（`venvExists`/`readMarker`）。
- Produces: `cleanupOldVenv(oldPath, policy, currentPath, { remove } = {}) -> { action: 'none'|'kept'|'deleted'|'failed', error?: string }`（`remove` 缺省即 `rmSync(dir,{recursive:true,force:true})`，测试注入桩以造删除失败——Global Constraints fs 缝）。前置四条件缺一即 `action:'none'`（附原因不抛）：oldPath≠currentPath、**互不前缀包含**（`isPathPrefix` 方向性判定，任一为另一前缀→'none'，Review Focus #4）、`venvExists(oldPath)`、`readMarker(oldPath)` 非 null；四条件全真且 `policy='delete'` → `remove(oldPath)`（抛错→`'failed'`+error，不抛）；`policy='keep'` → `'kept'`。
- [ ] **Step 1: 写失败测试** — 决策矩阵（policy × 存在 × 标记 × 同/异路径 × **前缀包含（双向）** × **注入桩 `remove` 抛错**→`'failed'`）；**半删态重试行**（spec §5.4 残留风险②）：桩 `remove` 抛错制造部分删除后，只要 `pyvenv.cfg` 仍存在且标记仍在，**下一轮调用仍满足四条件并再次尝试删除**（断言第二轮 `action` 不为 `'none'`）；用例前置 HOME 赋非空 tmpdir（同 Task 1，marker 读经 `~` 路径时）。
- [ ] **Step 2: 运行确认失败** — `node --test tests/venv.test.mjs` → FAIL：追加用例红（`cleanupOldVenv is not a function`），Task 1/2/3 用例仍绿。
- [ ] **Step 3: 实现** — 追加 `cleanupOldVenv` + 私有 `isPathPrefix`。
- [ ] **Step 4: 运行确认通过** — `node --test tests/venv.test.mjs` → PASS；`node --test tests/*.test.mjs` → 全量全绿。
- [ ] **Step 5: Commit** — `feat(venv): cleanupOldVenv 四条件删除安全模型`

### Task 5: index.js — Config schema + 统一注入包 + 去引用快照 + 降级视图

**Files:**
- Modify: `index.js`；`lib/venv.js`（追加 `snapshotVenvConfig` 与组合纯函数 `assembleInjectionBag`）
- Test: `tests/apply.test.mjs`（追加）+ `tests/skeleton.test.mjs:37-47`（files 白名单）/`:50-59`（exports 三条目，条件项见 Step 3）（形状随 `package.json` 增补联动修订）+ `tests/compat.test.mjs` **CLI 子进程用例四处**（回归面，一律按测试名定位：`CLI: --dsh-modules stub --skill-roots fixture → exit 0 且输出 OK`／`CLI: 漂移（stub superpowers-dsh 常量 600，期望默认 550）→ exit 1 且列漂移`／`CLI: --skill-roots 逗号多根 → 两根的 skill 均读回`／`CLI: 未知参数 → exit 1 usage 提示`——四处现以 `{ env: {} }` 起子进程，Config 落地后 index.js 装载期 fail-loud 会拦在断言之前；修复＝子进程 env **显式注入可解析定位变量 `DSH_NODE_MODULES` 指真实 node_modules**（`resolveDshModules` 定位链第②级已支持），使四用例仍可达绿并消除"本机侥幸绿"的移植隐患）

**Interfaces:**
- Consumes: **Task 1 原语为前提**（`resolveVenvPath`/`wrapperStatePath` 系列是注入袋与降级视图的判定基础；Task 2 `effectiveInterpreter` 由消费方 Task 6/7/8 调用，本 Task 只装配、不判定）。宿主 schemastery 经**受控解析**：定位器读 `process.env`（`DSH_NODE_MODULES`/`DSH_PROFILE_DIR`/`DSH_HOME`+`DSH_PROFILE`/`DSH_HOME/profiles` 五级，与 `scripts/check-dsh-compat.mjs` 的 `resolveDshModules` 同源——按函数名定位，勿锚行号）后 `createRequire` 同步解析（`@deepseek-ai/schemastery` 为 CJS，main=`lib/index.cjs`，同步解析可行）；不可解析即模块加载期 fail-loud——**整插件不可加载，vendor 技能面连带丢失**（spec §6.1⓪：index.js 不捕获、不降级为无 Config 导出，宿主 loader 记录该故障，README 注明诊断）。测试侧复用 `tests/compat.test.mjs` 的 `makeStubSdk` stub node_modules 范式（按函数名定位）造"可解析/不可解析"两态；**schemastery 替身须单独构造**——真实包为 `type:'module'` + `main:'lib/index.cjs'`（本机实测），故 stub 的 `package.json` 的 `main` 一并指向 `.cjs` 文件，不沿用现有 ESM stub 的 `lib/index.js` 写法。
- Produces: `export const Config`（叶子级 volatile 三字段 + §5.1 注解文案，含模块加载期求值的插件版本/上游版本/SKILL_DIR）；`lib/venv.js` 同批追加两个纯函数——**`snapshotVenvConfig(raw) -> {enabled, path, oldPathPolicy}`**（检测各叶子是否带 `.get()` 引用对象→取普通值）与组合纯函数 **`assembleInjectionBag(raw) -> {skillRoots, venv}`**（`skillRoots` 原样透传 + `venv` 经 `snapshotVenvConfig` 快照，缺省补默认在此完成）；`apply` 只调 `assembleInjectionBag` 后下传。注入袋与 opts **字段定形**（泛称已删，一律以字段名指代）：`createSkillProvider(roots?, opts?)` 第二参取子集 `{venv}`（**方案甲形态**：roots 保持首参数组、`lib/skill-provider.js:338` 校验不动；见 Task 6），`createTools(opts)` 的 opts 为 **`{skillRoots?, venv?, testSeams?}`**——**`testSeams?: {writeMarker?, writeWrapperState?, readWrapperState?, remove?}`** 即 tools.js 桩通道（生产省略、测试注入，替代 fs stub 观测面；由 Task 9 消费）。注入袋**不含** `invalidReason`——无效/生效判定唯一经 Task 2 `effectiveInterpreter`，由各消费方自行求值。降级视图：路径无效→注入包保留原值（apply 不改写 venv 值），无效时 console.warn 仅作日志补充。缺省补默认的分层事实（不作对称表述）：**缺省补默认有两个提供者（cordis 校验填默认 vs apply 自填）；loader 路径永不带 skillRoots，两键共存只在测试路径成立**。

- [ ] **Step 1: 写失败测试**（Review Focus #3）— ①**直测 `snapshotVenvConfig`**：入参给带 `.get()` 的引用对象 → 返回 `{enabled,path,oldPathPolicy}` 三普通值（`typeof` 级"引用对象→普通值"断言；探针 provider 捕获方案作废）；②**直测 `assembleInjectionBag`**：入参缺 `venv` 键（loader 形态缺省）→ 返回袋内 `venv` 三字段为自填默认值；③**直测 `assembleInjectionBag`**：入参 `{skillRoots:[root], venv:<引用对象袋>}` → 两键共存互不干扰（`skillRoots` 原样透传、`venv` 已是普通值；仅测试路径成立）；④相对路径 venv → 注入包原值保留 + warn 触发断言；⑤既有 **12 处可执行 `apply` 调用**行为不回归：tests 10（字面 `{skillRoots}` 8 + 裸 opts 2，集中在 `tests/apply.test.mjs`、`tests/verify-plugin.test.mjs` **两文件**；`tests/compat.test.mjs` 的命中为 fixture 字符串非调用）+ scripts 2（`scripts/check-dsh-compat.mjs:367` `toolOptions` 变量形态、`scripts/verify-plugin.mjs:265`）——scripts 两处列入本 Task 回归面；⑥**compat CLI 四用例**（Files 列名）断言其子进程 env 含 `DSH_NODE_MODULES` 指向真实 node_modules 且退出码/stdout 结论不变（index.js 装载期 fail-loud 与四用例可达绿并存）。
- [ ] **Step 2: 运行确认失败** — `node --test tests/apply.test.mjs` → FAIL：追加用例红（`snapshotVenvConfig`/`assembleInjectionBag` 未导出 / 注入袋无 `venv` 键），既有 apply 用例仍绿。
- [ ] **Step 3: 实现** — `index.js` 增 Config（受控解析 schemastery + 叶子 volatile + 注解）与 apply 装配改造（经 `assembleInjectionBag`）；`lib/venv.js` 增 `snapshotVenvConfig` 与 `assembleInjectionBag`；`package.json` 的 `exports` 增补内部模块为**条件项**——触发条件仅一条：`tests/`、`scripts/` 任一处需以**包名路径**导入 `lib/venv.js`（现测试一律走相对路径 `../lib/venv.js`，故默认**不触发**）；若触发则在本 Task 追加 `skeleton` exports 用例的 RED→GREEN 两步并扩 `skeleton:50-59` 三条目深比较，未触发则该面零改动、不修订 skeleton。
- [ ] **Step 4: 运行确认通过** — `node --test tests/apply.test.mjs` → PASS；`node --test tests/compat.test.mjs` → PASS（含本 Task 修复的 CLI 四用例）；`node --test tests/*.test.mjs` → 全量全绿（含 tests 10 处旧调用）；`node scripts/check-dsh-compat.mjs` 与 `node scripts/verify-plugin.mjs` 实跑不回归（scripts 2 处调用点）。
- [ ] **Step 5: Commit** — `feat(plugin): Config 叶子 volatile + apply 统一注入包与去引用快照（P0-1/P0-1'）`

### Task 6: skill-provider 合成入口 skill `ppt-master-env`

**Files:**
- Modify: `lib/skill-provider.js`
- Test: `tests/skill-provider.test.mjs`（追加）+ `tests/apply.test.mjs:194-198`（生产根列表 deepEqual——本特性预期变更，随本 Task 修订，见 Global Constraints；追加后**字节序仍升序**：`'ppt-master' < 'ppt-master-env'`，故新期望列表为 `['ppt-master','ppt-master-env']`，前项位置不动）

**Interfaces:**
- Consumes: Task 5 注入袋 `{skillRoots, venv}`，venv 经 `createSkillProvider(roots?, opts?)` **第二参** `opts`（定形 `{venv}`，见 Task 5 Produces）传入（方案甲：**roots 保持首参数组形态**，`lib/skill-provider.js:338` 的 fail-loud 根校验不动，**既有 25 处位置型 + 2 处缺省型调用零改动**）+ Task 2 `effectiveInterpreter`（体检用 Task 2 定名的**同步** `probeVenvInterpreter`）。**路径解析数据源边**：本 Task 不自行调 `resolveVenvPath`——`~` 展开唯一发生在注入袋（Task 5 `assembleInjectionBag` 产出普通值）之后、由各消费方经 `effectiveInterpreter` 统一求值一次。
- Produces: **入口注入范围（决策A）**——合成入口技能**仅当 `scanRoots` 缺省（生产包内根）时追加**；测试注入 fixture 根**不追加**（零改动保护归因＝**"fixture 根不追加"**这一条，而非调用次数：25 处位置型调用与 `list()` 内容型断言面据此不动，另 2 处缺省型调用因断言不含列表内容同零改动）；唯一受影响的生产形态断言 = `tests/apply.test.mjs:194-198`。provider 技能列表 = vendor N + 入口 1（合成对象，**不落盘**）；name `ppt-master-env`；**合成候选形态钉死：候选不带 `resourceBase` 字段**（宿主 `@deepseek-ai/dsh-skill/lib/index.js:445`/`:501` 实证该字段为 `!== void 0` 条件透传、可选；实跑复核归 Task 10 的 ⑤ 项）；中英双语 description 含"任何 ppt-master 路由前必须先读本入口"；body 四态渲染（spec §5.2：1 开+已建→`<绝对路径>/bin/python3` 替换字面 python3 含 attribution_guard + SKILL_DIR + 读毕路由；2 开+未建→先 setup_deps；3 关→系统 python3；4 无效→修正指引按系统模式；disabled×invalid 落态 3）；broken 子态在 body 侧由 Task 2 `effectiveInterpreter`（体检=同步 `probeVenvInterpreter`）给出，payload 侧对外可观测仍是 Task 7 的推断式 `exists=true ∧ pythonPath=null`（同一事实的两个面，不另增字段）；**SKILL_DIR 产出方**：body 的 SKILL_DIR 由 provider 自身已加载的 skills 元数据锚定（`name==='ppt-master'` 优先，回退 `list()` 字节序首目录），**不经 `lib/tools.js` 私有 `locateSkillDir`**；固定脚注（陈旧语义指向 info/check_env 实时）。

- [ ] **Step 1: 写失败测试** — 四态 body 内容断言（解释器路径/前置路由语/准备指引/修正方式逐字符串），载体为**生产根形态**（`roots` 缺省 + `opts.venv` 注入状态，本机 `skills/` 已首灌）；**注入 fixture 根的 provider 列表不含 `ppt-master-env`**（决策A 的反向断言——零改动保护归因＝**fixture 根不追加**，覆盖 25 处位置型调用与 fixture 根 `list()` 内容型断言面；2 处缺省型调用断言不含列表内容，同零改动）；数量 vendor N+1（生产根）；合成候选**无 `resourceBase` 键**的形态断言（`!('resourceBase' in candidate)`）；断言无新增 fs 写入（比对面不变）；description 双语断言。
- [ ] **Step 2: 运行确认失败** — `node --test tests/skill-provider.test.mjs` → FAIL：追加用例红（生产根列表无 `ppt-master-env` / body 缺解释器契约），既有位置型与缺省型调用用例仍绿。
- [ ] **Step 3: 实现** — provider 工厂体内追加合成技能（实例注册期快照渲染，spec §5.2 新鲜度定案）。
- [ ] **Step 4: 运行确认通过** — `node --test tests/skill-provider.test.mjs` + `node --test tests/apply.test.mjs` → PASS；`node --test tests/*.test.mjs` → 全量全绿。
- [ ] **Step 5: Commit** — `feat(skill): 合成入口 skill ppt-master-env（四态解释器契约路由）`

### Task 7: tools.js — info venv 字段 + 描述增量

**Files:**
- Modify: `lib/tools.js`
- Test: `tests/tools-info.test.mjs`（追加 + 形状修订 `:105-113`/`:263`）

**Interfaces:**
- Consumes: Task 5 注入袋 `{venv}` + Task 2 `effectiveInterpreter`（存在性体检走同步 `probeVenvInterpreter`）。**路径解析数据源边**：本 Task 不自行调 `resolveVenvPath`，注入袋为普通值后统一经 `effectiveInterpreter` 求值一次。
- Produces: `ppt_master_info` payload += `venv: {enabled, path(string|null), exists, pythonPath(string|null)}`（取值按 spec §5.3 矩阵：**off/invalid 定值；on-missing/on-ready/broken 行 `path`=解析后绝对（定值）**；`invalid×disabled` 组合按 Task 2 落 `off` 且 `path=null`（无效如实））；**broken 子态不增字段**——声明为**推断式可观测**：`venv.exists=true ∧ venv.pythonPath=null ⇒ exists-but-broken`（故 broken 时 `pythonPath=null`；spec §5.3 broken 行单元格与该式的出入入"spec 偏差登记"，归 Task 10 勘误面）；工具 description 在 `venv.enabled=true` 时追加解释器提示语（指向入口 skill 契约，spec §5.3 交付项）——**追加语只进中文段，英文段保持纯 ASCII**（现测试断言恰两段、第二段 `/^[\x20-\x7e]+$/`，见 `tools-info:92-98`）。

- [ ] **Step 1: 写失败测试** — 矩阵 venv.off/invalid/on-missing/on-ready(×broken) 的 info.venv 字段取值（off/invalid 定值；broken 行按 `exists=true ∧ pythonPath=null` 推断式断言）；描述含/不含提示语切换断言 + 提示语落中文段、英文段仍纯 ASCII；形状修订（`INFO_FIELDS` 增 `venv`，`:105-113`/`:263` 两处 deepEqual 同步）。
- [ ] **Step 2: 运行确认失败** — `node --test tests/tools-info.test.mjs` → FAIL：追加用例红（payload/schema 无 `venv` 键），已修订的形状用例同红即为 RED 表现。
- [ ] **Step 3: 实现** — infoTool 增 venv 小节（经 effectiveInterpreter）+ 描述拼接（中文段追加）。
- [ ] **Step 4: 运行确认通过** — `node --test tests/tools-info.test.mjs` → PASS；`node --test tests/*.test.mjs` → 全量全绿。
- [ ] **Step 5: Commit** — `feat(tools): info venv 状态字段与描述提示语`

### Task 8: tools.js — check_env venv 小节 + 生效解释器探测

**Files:**
- Modify: `lib/tools.js`
- Test: `tests/tools-check-env.test.mjs`（追加 + 形状修订 `:208-224`）；**连带** `tests/tools-setup-deps.test.mjs:242/341/394/544` + 常量 `DIAGNOSTIC_FIELDS:71`（经 `setupDepsOutputSchema` 内嵌诊断四字段引用，属本 Task 形状面；**同文件 `:234/276/536` + 常量 `SETUP_FIELDS:68` 属 Task 9 载荷面，本 Task 不动**）

**Interfaces:**
- Consumes: Task 5 注入袋 `{venv}` + Task 2 原语（`effectiveInterpreter`）+ 现有 `run` 注入通道。**路径解析数据源边**：同 Task 6/7，本 Task 不自行调 `resolveVenvPath`。**探测分工**：`venv.python` 小节用**现有 async 三字段版本探测**——具名锚 `probePython(run, signal)`（`lib/tools.js:597`，现状返回 `{found, version, meetsSkillRequirement}` 的 async 函数），挂在 Task 2 给出的 venv `pythonPath` 上；**`pythonPath=null` 的两行（`on-missing` 与 broken 子态）改挂候选 `<absPath>/bin/python3`**（Task 2 定名的拼接口径，本 Task 不另立拼接式），与 Task 2/3/6 的同步 `probeVenvInterpreter` 为两接口，勿混用。
- Produces: check_env payload += `venv: {enabled, path, exists, python: {found,version,meetsSkillRequirement}|{skipped}}`（off/invalid 两行取定值：不探测、`path` 按规则；`invalid×disabled` 组合按 Task 2 落 off 且 `path=null`）；顶层 `python` 保持系统探测；**deps 与 guard 探测同走生效解释器**：`on-ready`→venv python；`off/invalid`→系统 python（invalid 为降级续行）；`on-missing`/`broken`→deps 全 `'UNKNOWN'`/`source:'unknown'`、guard=`{skipped}`（不回退系统探测；两行的版本探测候选挂载见 Consumes 分工；guard 词汇不挪用 UNKNOWN，spec §5.3）；broken 按推断式（不增字段，同 Task 7）；guard 跳过判定基准切换为生效解释器（行为变更声明）；描述追加提示语**只进中文段、英文段保持纯 ASCII**（现测试 `:195-201` 恰两段/第二段 ASCII）。

- [ ] **Step 1: 写失败测试** — spec §5.3 矩阵逐行对 check_env（off/invalid 行按定值求值）；guard `{skipped}` 与 deps UNKNOWN 两形状分开断言；**候选挂载两类行（on-missing/broken）各一例**断言版本探测目标为 `<absPath>/bin/python3`；系统模式回归（off 态 = 现行行为逐字节等价）；形状修订（诊断四字段→五字段 + 嵌套 venv 小节，`:208-224`）+ 连带面 `tools-setup-deps` 四处 `DIAGNOSTIC_FIELDS` 深比较与常量 `:71` 同步（**不动 `SETUP_FIELDS` 面**）。
- [ ] **Step 2: 运行确认失败** — `node --test tests/tools-check-env.test.mjs tests/tools-setup-deps.test.mjs` → FAIL：追加用例与已修订形状用例红（无 `venv` 小节 / 属性集不含 `venv`），行为断言仍绿。
- [ ] **Step 3: 实现** — checkEnvTool 编排改造（探测解释器统一由 effectiveInterpreter 决定）。
- [ ] **Step 4: 运行确认通过** — `node --test tests/tools-check-env.test.mjs tests/tools-setup-deps.test.mjs` → PASS；`node --test tests/*.test.mjs` → 全量全绿。
- [ ] **Step 5: Commit** — `feat(tools): check_env venv 感知——deps/guard 走生效解释器`

### Task 9: tools.js — setup_deps venv 分支（唯一副作用点编排）

**Files:**
- Modify: `lib/tools.js`
- Test: `tests/tools-setup-deps.test.mjs`（追加；本 Task 载荷形状面 `:234/276/536` + 常量 `SETUP_FIELDS:68` 同步修订；**`:242/341/394/544` + 常量 `:71` 属 Task 8 连带面，本 Task 不动**）

**Interfaces:**
- Consumes: Task 1/3/4 全部 + Task 8 的 runCheckEnv + Task 5 注入袋 `{venv}`。**分层（参数契约不动）**：`user`/`breakSystemPackages` 属**调用期** flags（`parameters` schema 面不改，venv 模式下被忽略并在 render 注明），`venv` 属**装配期**配置——同经 Task 5 通道但语义层不同。**桩通道**：marker/wrapper-state 写失败与删除失败注入一律经 `createTools(opts)` 的 `opts.testSeams {writeMarker?, writeWrapperState?, readWrapperState?, remove?}`（生产省略、测试注入；Task 5 Produces 定形；本 Task 不依赖 fs stub、不依赖只读目录）。
- Produces: venv 开→`ensureVenv`（拒绝/损坏→按 spec §6 载荷：`venv.error`、installCmd 如实、`installExit=-1`、render 注明未执行、复跑 check_env 按缺失口径、不 throw）；成功→`installCmd=[<venv>/bin/pip3,'install','-r',req]`（**render 行注明"venv 模式忽略 `user`/`breakSystemPackages`"**）→ `readWrapperState` 读旧路径→安装成功后 `cleanupOldVenv`（删除走默认 `rmSync`；读失败 action='none'；写失败清理结果如实+单独上报，Review Focus #5）→`writeWrapperState(absPath)`→复跑 check_env；payload += `venv:{created, adopted, path, error?}`（`path` 系 spec §5.3 原载字段非计划补回、`adopted` 为计划侧增量，见"spec 偏差登记"）、`cleanup:{oldPath,action,error?}`；`action='kept'` render 闲置提示行（spec §5.3）。

- [ ] **Step 1: 写失败测试** — **两类时序断言分开**：①**run-argv 序**（stub run 记录 argv：`python3 -m venv <path>` → `<path>/bin/pip3 install -r <req>`，installCmd 逐字）；②**fs 序**（`writeMarker` → `cleanupOldVenv` → `writeWrapperState` 的写入次序经 **`testSeams` 函数桩**记录）；用例前置 HOME 赋非空 tmpdir（wrapper-state 落 tmpdir，不触真实 `/root/.ppt-master`）；拒绝/损坏/安装失败三早退路径载荷形状；kept/deleted/none/failed 四 action 的 render + **断言"venv 模式忽略 user/breakSystemPackages" render 行**；**并发立场用例（no-locking，Global Constraints）**：两路 `setup_deps` 同路径并发 → `ensureVenv` 缺才建幂等（断言创建 argv 至多一次生效、两路均得可用结论），且注入桩模拟双建竞态失败后**复跑自愈**；系统模式（venv 关）现行行为零回归——**并断言 off 分支不调用任何删除原语**（`testSeams.remove` 桩零调用，非目标锚定）。
- [ ] **Step 2: 运行确认失败** — `node --test tests/tools-setup-deps.test.mjs` → FAIL：追加用例红（payload 无 `venv`/`cleanup` 键、render 缺 flags 注明行）。
- [ ] **Step 3: 实现** — setupDepsTool venv 分支编排（installCmd 组装归 tools.js，spec §3）。
- [ ] **Step 4: 运行确认通过** — `node --test tests/tools-setup-deps.test.mjs` → PASS；`node --test tests/*.test.mjs` → 全量全绿。
- [ ] **Step 5: Commit** — `feat(tools): setup_deps venv 编排——ensure/安装/cleanup/登记/复跑`

### Task 10: compat 扩展 + verify 负向 + README + 收尾

**Files:**
- Modify: `scripts/check-dsh-compat.mjs`, `README.md`, `docs/superpowers/specs/2026-10-15-ppt-master-venv-config-design.md`（勘误面：§3:46 计数、§5.3 off/invalid 行与细则句、§5.3 矩阵注记——**Gate 2 修订已落，勿重复回写**；本 Task 只回写"spec 偏差登记"的剩余澄清项，其中含 **§5.1 L68 与 §6 L130 的 HOME 空串表述两处**、§5.3 候选挂载注记、§5.2 决策A 前提、§6.1④ 接受性措辞）
- Test: `tests/compat.test.mjs`（追加静态断言 **+ 既有基线联动修订，一律按测试名定位**：`runCompatCheck 基线: stub SDK 全绿` 的 `problems` 空集断言、`CLI: --dsh-modules stub --skill-roots fixture → exit 0 且输出 OK` 的 stdout 断言，**再加 `CLI: --skill-roots 逗号多根 → 两根的 skill 均读回` 的 stdout 断言**（验证面扩展后其期望输出若含新增五项断言行则随之更新）——三处均为"追加+既有基线联动"，不是仅追加）

**Interfaces:**
- Consumes: 前 9 个 Task 全部产物。
- Produces: compat 脚本验证面与 spec §7.7 **五项全映射**——① Config volatile 声明存在（`runtime.Config` 可达 + toJSON meta 三叶子检查）；② apply 第二参注入通道可用（**与 Task 5 断言联动登记**：Task 5 Step 1②③即 `assembleInjectionBag` 直测证据，compat 侧再以 `apply(ctx, toolOptions)` 实跑驱动注册面，两面不断裂）；③ profile `cordis.patch.yml` 的 `id: dsh-ppt-master-wrapper` 条目——**分层**：bundle insert 层已在本包 `cordis.patch.yml`（→静态断言即足）；profile 层条目由宿主 config-editor `edit()` 在 `index<0` 时 `document.add({id,name,config})` 代建（`dsh-config-editor:105-109` 实证）→ 归 compat/实跑验证路径，不写成 bundle 面静态断言；④ schemastery 可解析性经 §3/Task 5 **同一受控解析通道**断言（不另立通道）；⑤ 入口技能经真实 SkillRegistry 读回列表含 `ppt-master-env`（生产根形态，与 Task 6 决策A 联动）——**入口候选豁免规则**：compat 逐候选目录谓词（`check-dsh-compat.mjs` 中 `loaded.resourceBase?.kind !== 'directory'` 那条，按代码文本定位）对**入口候选 `ppt-master-env` 免 `resourceBase.kind==='directory'` 判定**（候选不带该字段，Task 6 形态钉死），其余 vendor 候选判定不变，并联动其 `problems` 基线；spec §6.1④ 的"接受性未验证"措辞据此升级为**"不带 `resourceBase` 的候选已经宿主源码实证该字段可选（`dsh-skill/lib/index.js:445`/`:501` 条件透传），接受性由本项实跑复核"**。本 Task 钉死该入口装载形态改为**定位成功后的动态 `import(PLUGIN_ENTRY)`**（现为 `check-dsh-compat.mjs` 顶部对 `../index.js` 的静态 import，按代码文本定位）——否则 `CLI: 无 --dsh-modules 且 env 无定位线索 → exit 1 报无法定位` 的报错会被插件装载期 fail-loud 抢先、用例语义失效；改动落本 Task 自有面并登记进既有基线联动。README 增 spec §8 核对表全部条目（venv 配置/挂载卷与镜像边界/标记即授权/两类孤儿/设置页诊断/schemastery 诊断含 vendor 技能连带丢失/入口技能诊断），**再加两条**：首次使用前 profile `cordis.patch.yml` 条目建立说明（宿主设置页代建 / 操作者手工建立两种途径）、config **整体替换语义**的升级补全说明（插件升级新增字段后已存在 patch 条目须比对补全，否则新字段回落默认值）；两类孤儿的**层级错配**行补成因叙述（登记位置固定 `<HOME>/.ppt-master`，容器场景 HOME 易失而 venv 居持久卷 → 重建后登记丢失、旧 venv 成"有标记无登记"孤儿，手动清理，spec §5.4/§8）；verify-plugin 负向确认（入口 skill 不落盘→比对面不变，实跑）；全量回归 + 版本历史行随下次 sync 规则③处理（**本 Task 不手动 bump**）。
- [ ] **Step 1: 写失败测试** — compat 脚本输出含 §7.7 五项断言的静态/实跑校验（`tests/compat.test.mjs` 以源码文本或子进程方式断言，沿用既有风格）；同文件既有基线按**测试名**联动修订（`runCompatCheck 基线: stub SDK 全绿` 的 `problems` 空集、两条 CLI 用例的 stdout——见 Files 行三处清单）。
- [ ] **Step 2: 运行确认失败** — `node --test tests/compat.test.mjs` → FAIL：追加用例红（compat 输出缺五项断言行），已修订的既有基线用例同红即为 RED 表现。
- [ ] **Step 3: 实现** — 扩 compat 脚本 + README 核对表 + spec 回写（**仅"spec 偏差登记"剩余澄清项**；Gate 2 已落的四处勘误不重复改）+ 实跑 `node scripts/verify-plugin.mjs --upstream .upstream/refs/tags/v6.7.0@b4efe3ddf237a97a42880164759162f8e2412f2f` 与 `node scripts/check-dsh-compat.mjs`。
- [ ] **Step 4: 运行确认通过** — `node --test tests/*.test.mjs` 全绿；verify-plugin OK；compat OK（五项断言行全部出现）。
- [ ] **Step 5: Commit + push** — `git commit` 后 `git push origin main`；PAT 取 env `DSH_PPT_GITLAB_PAT`（一次性 URL 注入，输出脱敏）；**push 失败不阻塞本 Task 完成**——保留本地提交待下次推送，未推送包装层提交由下次 sync 按规则③自动处理（不手动 bump）。

---

## spec 偏差登记（全部澄清级，归 Task 10 勘误回写面）

- §5.3 setup_deps payload **无偏离**（原文已含 `venv.path`）——Gate 2 首版登记系误读，撤回"补回 path"说法；本特性在该 payload 的真增量只有 `adopted`，已由下条 §5.4 签名项覆盖，不回写 spec（本条仅留溯源）。
- §5.4 签名与返回：`ensureVenv(run, path, signal)` → 第三参收 options（`{signal, probeVenvInterpreter, writeMarker}`）；返回增 `adopted`（收编可观测）；`cleanupOldVenv` 增可选 `{remove}` 删除注入缝（Task 4 RED 所需）。**同节形参层面变更一并登记**：`effectiveInterpreter(config, 探测)` 的第二参由 design 的抽象"探测"固化为**具名原语对象** `{ probeVenvInterpreter }`（Task 2）——回写 §5.4 该行为具名签名。
- 命名原语：`probeVenvInterpreter`（同步 fs 存在性；**入参为 venv 目录、内部拼 `bin/python3`**）与 `snapshotVenvConfig`（去引用快照）为计划层新增具名，spec 未命名——回写 §5.4/§5.1 措辞并声明与现有 async 三字段版本探测的分工。
- §5.3 on-ready 子态（exists-but-broken）行的 `pythonPath` 单元格与推断式可观测式（Task 6/7：`exists=true ∧ pythonPath=null`）取值不一致——**裁决：统一为 null 并在该行注明推断式口径**（不再二选一）。**拆两半登记**：〔已落，勿重复改〕推断式注记句（§5.3"矩阵注记（info 面可观测性）"）与 off/invalid 定值句（§5.3 细则"off/invalid 行取定值，N/A 语义废除"）已随 Gate 2 修订进 spec；〔待回写〕broken 行单元格仍写作 `<path>/bin/python3`（spec 现文 L101）须改为 `null`，以及 §5.3 off 行"按配置原样（不解析）"须加限定（**仅路径合法的 disabled**）——`invalid×disabled` 组合的"行为按 off + 诊断面 path=null"已由 Task 2 钉为定值，回写时把该组合从 off 行措辞里显式拆出，避免与 off 行原样表述互斥。
- **§5.1 L68 / §6 L130 的 HOME 空串表述经监督实测为假**——两处现文称"`os.homedir()` 在 HOME 为空串时回退 passwd 目录、解析结果仍非空合法"，本机 Node v22.23.3 实测：**`HOME=''` → `os.homedir()===''`（不回退 passwd）**；仅"HOME 未设置"才落 `getpwuid` 回退（本机 `/root`）。故空串输入按 Task 1 判无效 `unresolvable` 走 §6 配置无效降级（不再声称"通常仍合法"）；Task 10 回写该两处。**Python 分叉句保留**（实测 `Path.home()` 在 `HOME=''` 时返 `'/'`，Node/Python 于该边界确为分叉，§5.1 该半句不动）。
- §5.3 矩阵**候选挂载为计划侧机制补充**（design 矩阵未载）：`pythonPath=null` 两行（`on-missing` 与 exists-but-broken）的 async 版本探测目标改挂候选 `<absPath>/bin/python3`——Task 8 已按此实现，Task 10 回写时在矩阵该两行 `check_env venv.python` 单元格注明候选口径。
- §5.2 注册形态"vendor N + 入口 1"原文为**无条件**——**决策A 收窄：入口仅当 scanRoots 缺省（生产包内根）时追加**，理由＝零改动保护面（归因**不是调用次数而是"fixture 根不追加"**）：25 处位置型 + 2 处缺省型 `createSkillProvider` 调用（缺省型断言不含列表内容，同零改动）；fixture 根 `list()` 面 = 全列表深比较 4 处（`skill-provider:83-85`/`:418-420`、`apply:101-104`/`:124`，另 `skill-provider:164` 单元素同形状深比较）+ 长度断言 1 处（`verify-plugin.test:131`），可执行 `list()` 调用共 17 处（13+3+1）。Gate 2 收敛性修正；唯一生产形态断言 `apply.test:194-198` 已入 Task 6 预期变更面。回写 §5.2 使原文带此前提。
- §6.1⓪ 后果面：schemastery 解析失败除整插件不可加载外，**vendor 技能面连带丢失**（Task 5 已声明）——回写 §6.1⓪ 加半句连带评估。
- §6.1④ 接受性措辞：原文称合成入口候选（无文件）经真实注册面的接受性"**未验证**"——Task 6 已凭宿主源码实证 `resourceBase` 为条件透传的可选字段（`@deepseek-ai/dsh-skill/lib/index.js:445`/`:501`，本机装包实测），故回写为"**不带 `resourceBase` 的候选已实证该字段可选，接受性由 compat ⑤ 实跑复核**"；§8"入口技能缺失诊断"行随之同口径更新。
- §5.1/§6 附带：compat 脚本对插件入口的**静态 import** 使"无定位线索"用例语义受装载期 fail-loud 影响（Task 10 钉为定位成功后动态装载）——属脚本自有面机制补充，spec 未载，回写时在 §6.1⓪/§7.5 注一句。

## 验收期人工步骤（spec §7.6 真实树 smoke；用户触发，不入自动化测试面）

- [ ] 本机以 `/dsh-home/.ppt-master/venv` 实建 venv + 实装 19 依赖（该路径是**显式配置值**，非 `~` 展开结果）；如实记录 `ppt_master_setup_deps` 的 installCmd/installExit/venv/cleanup 输出。
- [ ] 热重载换代观察：设置页改 `venv.path` → 读回入口 skill 正文与 info/check_env 行为随之换代（前提＝§7.7①②成立）。

---

## Self-Review 记录（修订后复核）

1. **Spec 覆盖**：§5.1→Task 5；§5.2→Task 6；§5.3→Task 7/8/9（矩阵逐行入测试；off/invalid 取定值、broken 走推断式、组合态 path=null 已钉）；§5.4→Task 1-4；§6→各 Task 早退路径测试；§6.1⓪/④→Task 5 装载期 fail-loud + Task 10 compat ④⑤（含 compat CLI 子进程回归面与候选豁免规则）；§7.1→Task 1-4；§7.2→Global Constraints 形状清单；§7.3→Task 6/7/8；§7.4→Task 5；§7.5→Task 10；§7.6→"验收期人工步骤"；§7.7①–⑤→Task 10 全映射；§8→Task 10；§4.3 时序→Task 9 两类时序断言；§2 非目标→GC 非目标锚定行 + Task 9 零删除断言。无缺口。
2. **步骤可单决**：每步一动作；签名/矩阵/argv 逐字给出；Task 2-9 每步含**确认命令 + 失败判据**（append 型 RED 写明"追加用例红、既有绿"）；实现体留给签名+测试可推导处；条件项仅 exports 一处，已写死触发条件与触发后的 RED/GREEN 步。
3. **类型一致**：`ensureVenv` 返回含 `adopted`（Task 9 payload 消费）；`effectiveInterpreter.broken`（Task 2 产、Task 3/6/7/8 消）；`cleanupOldVenv.action` 四枚举全任务统一；探测双原语（同步 `probeVenvInterpreter`＝venv 目录入参 / async 三字段版本探测 `probePython`）各 Task 引用不混名；注入袋形态 `{skillRoots, venv}` 与 opts 定形 `{skillRoots?, venv?, testSeams?}`（Task 5 产，Task 6/7/8/9 消）一致。
4. **Review Focus**：5 条全部落测试（Task 3/2-3-9/5/4/1-9）。
5. **比例**：计划与 spec（181 行）同量级，条目均为任务级指令、无转写代码。
6. **计数权威**：可执行 `apply` 调用 12 = tests 10（字面 `{skillRoots}` 8 + 裸 opts 2，两文件）+ scripts 2；`createSkillProvider` 既有调用 = **25 处位置型 + 2 处缺省型**（两者均零改动，缺省型因断言不含列表内容）；fixture 根 `list()` 面 = 全列表深比较 4 处 + 长度断言 1 处（可执行 `list()` 调用 17 处＝13+3+1）；零改动归因一律写"fixture 根不追加"，不写调用次数；无 TBD 占位。
