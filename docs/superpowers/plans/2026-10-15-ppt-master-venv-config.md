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
- 回归基线：现有 382 用例的**行为断言**保持全绿；**形状断言**随 venv 增量同步修订——依 spec §7.2 **通用授权**：凡逐字属性集 `deepEqual` 类断言均可随增量修订，修订面限于形状（下列清单是已探明面，不是授权上界）。逐文件清单与归属：`tools-info:105-113`/`:263`（T7）；`tools-check-env:207-224`（T8）；`tools-setup-deps:234/242/276/341/394/536/544`（T8 经 `setupDepsOutputSchema` 内嵌诊断四字段引用连带 + T9 载荷）；`skeleton:34-42`/`:50-58`（T5 exports/包面）；`apply.test:194-198`（T6，见下行）；`compat.test:600`/`:671-672`（T10 **追加+既有基线联动修订**，非仅追加）。
- 预期行为变更登记（区别于"修订授权扩面"）：入口 skill 仅当 scanRoots 缺省（生产包内根）时追加，故 `tests/apply.test.mjs:194-198` 的生产根列表 deepEqual 将含 `ppt-master-env`——这是本特性预期行为变更，随 Task 6 同步修订。
- fs 注入缝与 HOME 隔离：凡路径含 `~`/`os.homedir()` 的原语（`wrapperStatePath`/`readMarker`/`writeMarker`/`readWrapperState`/`writeWrapperState`）其测试**必须**把 `process.env.HOME` 重定向至 tmpdir——POSIX `os.homedir()` 遵循 env（本机实测），否则测试一跑即在真实 `/root/.ppt-master` 造文件（该路径当前不存在）。删除失败注入经 `cleanupOldVenv` 的可选 `{remove}` 依赖（默认 `rmSync`）；marker/state 写失败注入经函数桩或 fs stub（root 下 `chmod` 无效已实测，只读目录方案不可用）。
- 每 Task 一个 commit（main 直推，本仓库既有惯例）。

## Review Focus

以下失败模式源自 spec，但不在任何单 task 的主干路径测试里显式覆盖——每条已在归属 task 的步骤中以测试钉住：

1. **非空非 venv 目标目录**（误配指向含数据目录）→ 必须拒绝创建且不写标记（Task 3 Step 1）。
2. **exists-but-broken**（容器重建后符号链接失效）→ 体检识别、不自动删、恢复指引（Task 2/3/9）。
3. **loader 形态 volatile 引用未去引用** → apply 边界经纯函数 `snapshotVenvConfig(raw)`（落 `lib/venv.js`，Task 1/5 交界）快照为普通值，下游不得感知引用；Task 5 Step 1① 直测该函数，探针 provider 捕获方案作废。
4. **嵌套路径**（旧路径是新路径前缀）→ cleanup 拒绝（Task 4 Step 1）。
5. **wrapper-state 写失败** → 清理结果如实保留、登记失败单独上报（Task 1/9）。

---

### Task 1: lib/venv.js 基础原语（路径解析 / 存在性 / marker / wrapper-state）

**Files:**
- Create: `lib/venv.js`
- Test: `tests/venv.test.mjs`

**Interfaces:**
- Produces（后续 Task 2/3/4/5/6/8/9 全部消费；入参 `venv` 一律为**去引用后的普通对象** `{ enabled: boolean, path: string, oldPathPolicy: 'keep'|'delete' }`）:
  - `resolveVenvPath(venv) -> { path: string|null, invalidReason: string|null }`：`~` 按 `os.homedir()` 展开；相对路径→`{path:null, invalidReason:'relative-path'}`；空/非法→`invalidReason:'unresolvable'`；`enabled=false` 不在此判定（纯路径语义）。
  - `venvExists(dirPath) -> boolean`：`<dirPath>/pyvenv.cfg` 存在性。
  - `MARKER_FILENAME = '.ppt-master-wrapper.json'`；`readMarker(dirPath) -> {createdAt:string, path:string}|null`；`writeMarker(dirPath) -> void`（写 `{createdAt: ISO, path: dirPath}`）。
  - `wrapperStatePath() -> string`（`<homedir()>/.ppt-master/wrapper-state.json`）；`readWrapperState() -> {lastVenvPath: string|null}`（不存在/读失败→`{lastVenvPath:null}` 且不抛）；`writeWrapperState(lastVenvPath) -> void`（失败抛错由调用方处理）。

- [ ] **Step 1: 写失败测试** — `tests/venv.test.mjs`：**用例前置把 `process.env.HOME` 指向 tmpdir 并在 teardown 还原**（Global Constraints fs 缝）；`resolveVenvPath` 矩阵（`~`/绝对/相对/空串，`~` 行断言展开到该 tmpdir 而非真实 homedir）；`venvExists` 真/假；marker 写读回环 + 收编语义（已存在 venv 缺标记→`readMarker` null→`writeMarker` 后可读）；`wrapper-state` 不存在→null、写入→读回；**写失败注入**：以函数桩/fs stub 使 `writeWrapperState` 抛错且可被捕获（不用只读目录——root 下 chmod 无效）。

- [ ] **Step 2: 运行确认失败** — `node --test tests/venv.test.mjs` → FAIL（模块不存在）。

- [ ] **Step 3: 实现** — 新建 `lib/venv.js` 上述 7 个导出（纯 fs/os，无副作用承诺：本文件此部分只读写 marker 与 wrapper-state 两位置；`snapshotVenvConfig` 由 Task 5 追加进本文件，本 Task 不含）。

- [ ] **Step 4: 运行确认通过** — `node --test tests/venv.test.mjs` → PASS；`node --test tests/*.test.mjs` → 382+新增 全绿。

- [ ] **Step 5: Commit** — `git add lib/venv.js tests/venv.test.mjs && git commit -m "feat(venv): 路径/marker/wrapper-state 原语（spec §5.4）"`

### Task 2: effectiveInterpreter 四态判定原语

**Files:**
- Modify: `lib/venv.js`
- Test: `tests/venv.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1 的 `resolveVenvPath`、`venvExists`。
- Produces: `effectiveInterpreter(venv, { probeVenvInterpreter }) -> { state: 'off'|'invalid'|'on-missing'|'on-ready', pythonPath: string|null, invalidReason: string|null, broken: boolean }`。**双原语定名**（消除同名四形）：`probeVenvInterpreter(absPath) -> {found}`＝**同步 fs 存在性**探测（dangling symlink→`found:false`），供 ensureVenv 体检 / effectiveInterpreter / 入口 skill body 三处共用（Task 2/3/6）；与现有 **async 三字段版本探测**（`{found, version, meetsSkillRequirement}`，Task 8 的 `check_env` `venv.python` 用，挂在 venv `pythonPath` 上；broken 态 `pythonPath=null` 时改挂候选路径 `<absPath>/bin/python3`）是两个不同接口，各 Task 引用对应者。判定序：`enabled=false`→`off`（`pythonPath=null`，行为按系统模式；`invalid×disabled` 组合落 `off`——disabled 优先，spec §5.3 细则）；enabled 且 `resolveVenvPath` 无效→`invalid`；`on-missing`=`!venvExists`；`on-ready` 且 `probeVenvInterpreter(absPath).found=false`→`on-ready`+`broken:true`+**`pythonPath:null`**（exists-but-broken；候选路径由消费方按 `<absPath>/bin/python3` 自行拼接供 Task 8 版本探测；payload 面即以此实现推断式可观测 `exists=true ∧ pythonPath=null`，见 Task 6/7）。

- [ ] **Step 1: 写失败测试** — spec §5.3 矩阵逐行：off/invalid/on-missing/on-ready(on-ready 含 broken 子态)×(pythonPath/broken)取值；disabled+无效路径→state='off'；用例前置 HOME 重定向（同 Task 1）。
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
- Produces: `ensureVenv(run, absPath, { signal, probeVenvInterpreter, writeMarker }) -> { created: boolean, adopted: boolean, error?: string }`（第三参 options 收依赖；`writeMarker` 缺省即 Task 1 模块函数，测试换桩——写失败注入用**函数形态**，只读目录不可用）。语义（spec §5.4）：目标（不存在→`run('python3',['-m','venv',absPath])` 创建+`writeMarker`，`created:true`）|（空目录→同创建）|（含 `pyvenv.cfg`→体检 `probeVenvInterpreter(absPath+'/bin/python3')`：可用→缺标记则补写、`created:false,adopted:true` 复用；不可用→`{created:false, error:'venv 解释器不可用（exists-but-broken）——手动删除该目录后重跑'}`，**不自动删**）|（存在且非空且无 pyvenv.cfg→**fail-loud 拒绝** `{error:'目标目录非空且非 venv'}`，不创建不写标记）|（创建 run 非零/spawn 失败→`{error:…}`）。

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
- [ ] **Step 1: 写失败测试** — 决策矩阵（policy × 存在 × 标记 × 同/异路径 × **前缀包含（双向）** × **注入桩 `remove` 抛错**→`'failed'`）；用例前置 HOME 重定向（同 Task 1，marker 读经 `~` 路径时）。
- [ ] **Step 2: 运行确认失败** — `node --test tests/venv.test.mjs` → FAIL：追加用例红（`cleanupOldVenv is not a function`），Task 1/2/3 用例仍绿。
- [ ] **Step 3: 实现** — 追加 `cleanupOldVenv` + 私有 `isPathPrefix`。
- [ ] **Step 4: 运行确认通过** — `node --test tests/venv.test.mjs` → PASS；`node --test tests/*.test.mjs` → 全量全绿。
- [ ] **Step 5: Commit** — `feat(venv): cleanupOldVenv 四条件删除安全模型`

### Task 5: index.js — Config schema + 统一注入包 + 去引用快照 + 降级视图

**Files:**
- Modify: `index.js`；`lib/venv.js`（追加 `snapshotVenvConfig`）
- Test: `tests/apply.test.mjs`（追加）+ `tests/skeleton.test.mjs:34-42`/`:50-58`（exports/包面形状随 `package.json` 增补联动修订）

**Interfaces:**
- Consumes: **Task 1 原语为前提**（`resolveVenvPath`/`wrapperStatePath` 系列是注入袋与降级视图的判定基础；Task 2 `effectiveInterpreter` 由消费方 Task 6/7/8 调用，本 Task 只装配、不判定）。宿主 schemastery 经**受控解析**：定位器读 `process.env`（`DSH_NODE_MODULES`/`DSH_PROFILE_DIR`/`DSH_HOME`+`DSH_PROFILE`/`DSH_HOME/profiles` 五级，与 `scripts/check-dsh-compat.mjs:141` 的 `resolveDshModules` 同源）后 `createRequire` 同步解析（`@deepseek-ai/schemastery` 为 CJS，main=`lib/index.cjs`，同步解析可行）；不可解析即模块加载期 fail-loud——**整插件不可加载，vendor 技能面连带丢失**（spec §6.1⓪：index.js 不捕获、不降级为无 Config 导出，宿主 loader 记录该故障，README 注明诊断）。测试侧复用 `tests/compat.test.mjs:400-420` 的 stub node_modules 范式造"可解析/不可解析"两态。
- Produces: `export const Config`（叶子级 volatile 三字段 + §5.1 注解文案，含模块加载期求值的插件版本/上游版本/SKILL_DIR）；`apply(ctx, opts)` 第二参统一注入包：入口调 **`snapshotVenvConfig(raw) -> {enabled, path, oldPathPolicy}`**（`lib/venv.js` 纯函数：检测各叶子是否带 `.get()` 引用对象→取普通值）→ 组装注入袋 **`{skillRoots, venv}`** 下传 `createSkillProvider(roots?, opts?)`（**方案甲形态**：roots 保持首参数组、`lib/skill-provider.js:338` 校验不动，venv/入口选项走第二参；见 Task 6）与 `createTools(opts)`。注入袋**不含** `invalidReason`——无效/生效判定唯一经 Task 2 `effectiveInterpreter`，由各消费方自行求值。降级视图：路径无效→注入包保留原值（apply 不改写 venv 值），无效时 console.warn 仅作日志补充。缺省补默认的分层事实（不作对称表述）：**缺省补默认有两个提供者（cordis 校验填默认 vs apply 自填）；loader 路径永不带 skillRoots，两键共存只在测试路径成立**。

- [ ] **Step 1: 写失败测试**（Review Focus #3）— ①**直测 `snapshotVenvConfig`**：入参给带 `.get()` 的引用对象 → 返回 `{enabled,path,oldPathPolicy}` 三普通值（`typeof` 级"引用对象→普通值"断言；探针 provider 捕获方案作废）；②loader 形态缺 venv 键 → 注入袋为 apply 自填的默认值；③测试形态 `{skillRoots, venv}` 两键共存互不干扰（仅测试路径成立）；④相对路径 venv → 注入包原值保留 + warn 触发断言；⑤既有 **12 处可执行 `apply` 调用**行为不回归：tests 10（字面 `{skillRoots}` 8 + 裸 opts 2，集中在 `tests/apply.test.mjs`、`tests/verify-plugin.test.mjs` **两文件**；`tests/compat.test.mjs` 的命中为 fixture 字符串非调用）+ scripts 2（`scripts/check-dsh-compat.mjs:367` `toolOptions` 变量形态、`scripts/verify-plugin.mjs:265`）——scripts 两处列入本 Task 回归面。
- [ ] **Step 2: 运行确认失败** — `node --test tests/apply.test.mjs` → FAIL：追加用例红（`snapshotVenvConfig` 未导出 / 注入袋无 `venv` 键），既有 apply 用例仍绿。
- [ ] **Step 3: 实现** — `index.js` 增 Config（受控解析 schemastery + 叶子 volatile + 注解）与 apply 装配改造；`lib/venv.js` 增 `snapshotVenvConfig`；`package.json` 的 `exports` 增补内部模块如需（不破坏 `files` 面，随 `skeleton` 形状断言同步修订）。
- [ ] **Step 4: 运行确认通过** — `node --test tests/apply.test.mjs` → PASS；`node --test tests/*.test.mjs` → 全量全绿（含 tests 10 处旧调用）；`node scripts/check-dsh-compat.mjs` 与 `node scripts/verify-plugin.mjs` 实跑不回归（scripts 2 处调用点）。
- [ ] **Step 5: Commit** — `feat(plugin): Config 叶子 volatile + apply 统一注入包与去引用快照（P0-1/P0-1'）`

### Task 6: skill-provider 合成入口 skill `ppt-master-env`

**Files:**
- Modify: `lib/skill-provider.js`
- Test: `tests/skill-provider.test.mjs`（追加）+ `tests/apply.test.mjs:194-198`（生产根列表 deepEqual——本特性预期变更，随本 Task 修订，见 Global Constraints）

**Interfaces:**
- Consumes: Task 5 注入袋 `{skillRoots, venv}`，venv/入口选项经 `createSkillProvider(roots?, opts?)` **第二参** `opts` 传入（方案甲：**roots 保持首参数组形态**，`lib/skill-provider.js:338` 的 fail-loud 根校验不动，**既有 27 处位置型调用零改动**）+ Task 2 `effectiveInterpreter`（体检用 Task 2 定名的**同步** `probeVenvInterpreter`）。
- Produces: **入口注入范围（决策A）**——合成入口技能**仅当 `scanRoots` 缺省（生产包内根）时追加**；测试注入 fixture 根**不追加**（27 处位置型调用与 `list()` 内容断言据此零改动）；唯一受影响的生产形态断言 = `tests/apply.test.mjs:194-198`。provider 技能列表 = vendor N + 入口 1（合成对象，**不落盘**）；name `ppt-master-env`；中英双语 description 含"任何 ppt-master 路由前必须先读本入口"；body 四态渲染（spec §5.2：1 开+已建→`<绝对路径>/bin/python3` 替换字面 python3 含 attribution_guard + SKILL_DIR + 读毕路由；2 开+未建→先 setup_deps；3 关→系统 python3；4 无效→修正指引按系统模式；disabled×invalid 落态 3）；broken 子态在 body 侧由 Task 2 `effectiveInterpreter`（体检=同步 `probeVenvInterpreter`）给出，payload 侧对外可观测仍是 Task 7 的推断式 `exists=true ∧ pythonPath=null`（同一事实的两个面，不另增字段）；**SKILL_DIR 产出方**：body 的 SKILL_DIR 由 provider 自身已加载的 skills 元数据锚定（`name==='ppt-master'` 优先，回退 `list()` 字节序首目录），**不经 `lib/tools.js` 私有 `locateSkillDir`**；固定脚注（陈旧语义指向 info/check_env 实时）。

- [ ] **Step 1: 写失败测试** — 四态 body 内容断言（解释器路径/前置路由语/准备指引/修正方式逐字符串），载体为**生产根形态**（`roots` 缺省 + `opts` 注入 venv 状态，本机 `skills/` 已首灌）；**注入 fixture 根的 provider 列表不含 `ppt-master-env`**（决策A 的反向断言）；数量 vendor N+1（生产根）；断言无新增 fs 写入（比对面不变）；description 双语断言。
- [ ] **Step 2: 运行确认失败** — `node --test tests/skill-provider.test.mjs` → FAIL：追加用例红（生产根列表无 `ppt-master-env` / body 缺解释器契约），既有位置型调用用例仍绿。
- [ ] **Step 3: 实现** — provider 工厂体内追加合成技能（实例注册期快照渲染，spec §5.2 新鲜度定案）。
- [ ] **Step 4: 运行确认通过** — `node --test tests/skill-provider.test.mjs` + `node --test tests/apply.test.mjs` → PASS；`node --test tests/*.test.mjs` → 全量全绿。
- [ ] **Step 5: Commit** — `feat(skill): 合成入口 skill ppt-master-env（四态解释器契约路由）`

### Task 7: tools.js — info venv 字段 + 描述增量

**Files:**
- Modify: `lib/tools.js`
- Test: `tests/tools-info.test.mjs`（追加 + 形状修订 `:105-113`/`:263`）

**Interfaces:**
- Consumes: Task 5 注入袋 `{venv}` + Task 2 `effectiveInterpreter`（存在性体检走同步 `probeVenvInterpreter`）。
- Produces: `ppt_master_info` payload += `venv: {enabled, path(string|null), exists, pythonPath(string|null)}`（取值按 spec §5.3 矩阵，off/invalid 两行取定值）；**broken 子态不增字段**——声明为**推断式可观测**：`venv.exists=true ∧ venv.pythonPath=null ⇒ exists-but-broken`（故 broken 时 `pythonPath=null`；spec §5.3 broken 行单元格与该式的出入入"spec 偏差登记"，归 Task 10 勘误面）；工具 description 在 `venv.enabled=true` 时追加解释器提示语（指向入口 skill 契约，spec §5.3 交付项）——**追加语只进中文段，英文段保持纯 ASCII**（现测试断言恰两段、第二段 `/^[\x20-\x7e]+$/`，见 `tools-info:92-98`）。

- [ ] **Step 1: 写失败测试** — 矩阵 venv.off/invalid/on-missing/on-ready(×broken) 的 info.venv 字段取值（off/invalid 定值；broken 行按 `exists=true ∧ pythonPath=null` 推断式断言）；描述含/不含提示语切换断言 + 提示语落中文段、英文段仍纯 ASCII；形状修订（`INFO_FIELDS` 增 `venv`，`:105-113`/`:263` 两处 deepEqual 同步）。
- [ ] **Step 2: 运行确认失败** — `node --test tests/tools-info.test.mjs` → FAIL：追加用例红（payload/schema 无 `venv` 键），已修订的形状用例同红即为 RED 表现。
- [ ] **Step 3: 实现** — infoTool 增 venv 小节（经 effectiveInterpreter）+ 描述拼接（中文段追加）。
- [ ] **Step 4: 运行确认通过** — `node --test tests/tools-info.test.mjs` → PASS；`node --test tests/*.test.mjs` → 全量全绿。
- [ ] **Step 5: Commit** — `feat(tools): info venv 状态字段与描述提示语`

### Task 8: tools.js — check_env venv 小节 + 生效解释器探测

**Files:**
- Modify: `lib/tools.js`
- Test: `tests/tools-check-env.test.mjs`（追加 + 形状修订 `:207-224`）；**连带** `tests/tools-setup-deps.test.mjs:234/242/276/341/394/536/544`（经 `setupDepsOutputSchema` 内嵌诊断四字段引用，属本 Task 形状面；T9 载荷面另计）

**Interfaces:**
- Consumes: Task 5 注入袋 `{venv}` + Task 2 原语（`effectiveInterpreter`）+ 现有 `run` 注入通道。**探测分工**：`venv.python` 小节用**现有 async 三字段版本探测**（`{found,version,meetsSkillRequirement}`，挂在 Task 2 给出的 venv `pythonPath` 上；broken 态 `pythonPath=null` 时按 Task 2 约定改挂候选路径 `<absPath>/bin/python3`），与 Task 2/3/6 的同步 `probeVenvInterpreter` 为两接口，勿混用。
- Produces: check_env payload += `venv: {enabled, path, exists, python: {found,version,meetsSkillRequirement}|{skipped}}`（off/invalid 两行取定值：不探测、`path` 按规则）；顶层 `python` 保持系统探测；**deps 与 guard 探测同走生效解释器**：`on-ready`→venv python；`off/invalid`→系统 python（invalid 为降级续行）；`on-missing`/`broken`→deps 全 `'UNKNOWN'`/`source:'unknown'`、guard=`{skipped}`（不回退系统探测；guard 词汇不挪用 UNKNOWN，spec §5.3）；broken 按推断式（不增字段，同 Task 7）；guard 跳过判定基准切换为生效解释器（行为变更声明）；描述追加提示语**只进中文段、英文段保持纯 ASCII**（现测试 `:195-201` 恰两段/第二段 ASCII）。

- [ ] **Step 1: 写失败测试** — spec §5.3 矩阵逐行对 check_env（off/invalid 行按定值求值）；guard `{skipped}` 与 deps UNKNOWN 两形状分开断言；系统模式回归（off 态 = 现行行为逐字节等价）；形状修订（诊断四字段→五字段 + 嵌套 venv 小节，`:207-224`）+ 连带面 `tools-setup-deps` 七处 deepEqual 同步。
- [ ] **Step 2: 运行确认失败** — `node --test tests/tools-check-env.test.mjs tests/tools-setup-deps.test.mjs` → FAIL：追加用例与已修订形状用例红（无 `venv` 小节 / 属性集不含 `venv`），行为断言仍绿。
- [ ] **Step 3: 实现** — checkEnvTool 编排改造（探测解释器统一由 effectiveInterpreter 决定）。
- [ ] **Step 4: 运行确认通过** — `node --test tests/tools-check-env.test.mjs tests/tools-setup-deps.test.mjs` → PASS；`node --test tests/*.test.mjs` → 全量全绿。
- [ ] **Step 5: Commit** — `feat(tools): check_env venv 感知——deps/guard 走生效解释器`

### Task 9: tools.js — setup_deps venv 分支（唯一副作用点编排）

**Files:**
- Modify: `lib/tools.js`
- Test: `tests/tools-setup-deps.test.mjs`（追加；本 Task 载荷形状面 `:234/276/341/394/536/544` 同步修订，`:242` 属 T8 连带面）

**Interfaces:**
- Consumes: Task 1/3/4 全部 + Task 8 的 runCheckEnv + Task 5 注入袋 `{venv}`（flags 与 venv 判定同经此通道）。
- Produces: venv 开→`ensureVenv`（拒绝/损坏→按 spec §6 载荷：`venv.error`、installCmd 如实、`installExit=-1`、render 注明未执行、复跑 check_env 按缺失口径、不 throw）；成功→`installCmd=[<venv>/bin/pip3,'install','-r',req]`（**render 行注明"venv 模式忽略 `user`/`breakSystemPackages`"**）→ `readWrapperState` 读旧路径→安装成功后 `cleanupOldVenv`（删除走默认 `rmSync`；读失败 action='none'；写失败清理结果如实+单独上报，Review Focus #5）→`writeWrapperState(absPath)`→复跑 check_env；payload += `venv:{created, adopted, path, error?}`（`path` 按 spec §5.3 补回、`adopted` 为计划侧增量，见"spec 偏差登记"）、`cleanup:{oldPath,action,error?}`；`action='kept'` render 闲置提示行（spec §5.3）。

- [ ] **Step 1: 写失败测试** — **两类时序断言分开**：①**run-argv 序**（stub run 记录 argv：`python3 -m venv <path>` → `<path>/bin/pip3 install -r <req>`，installCmd 逐字）；②**fs 序**（`writeMarker` → `cleanupOldVenv` → `writeWrapperState` 的写入次序经注入桩记录）；用例前置 HOME 重定向（wrapper-state 落 tmpdir，不触真实 `/root/.ppt-master`）；拒绝/损坏/安装失败三早退路径载荷形状；kept/deleted/none/failed 四 action 的 render + **断言"venv 模式忽略 user/breakSystemPackages" render 行**；系统模式（venv 关）现行行为零回归。
- [ ] **Step 2: 运行确认失败** — `node --test tests/tools-setup-deps.test.mjs` → FAIL：追加用例红（payload 无 `venv`/`cleanup` 键、render 缺 flags 注明行）。
- [ ] **Step 3: 实现** — setupDepsTool venv 分支编排（installCmd 组装归 tools.js，spec §3）。
- [ ] **Step 4: 运行确认通过** — `node --test tests/tools-setup-deps.test.mjs` → PASS；`node --test tests/*.test.mjs` → 全量全绿。
- [ ] **Step 5: Commit** — `feat(tools): setup_deps venv 编排——ensure/安装/cleanup/登记/复跑`

### Task 10: compat 扩展 + verify 负向 + README + 收尾

**Files:**
- Modify: `scripts/check-dsh-compat.mjs`, `README.md`, `docs/superpowers/specs/2026-10-15-ppt-master-venv-config-design.md`（勘误面：§3:46 计数、§5.3 off/invalid 行与细则句、§5.3 矩阵注记——**Gate 2 修订已落，勿重复回写**；本 Task 只回写"spec 偏差登记"的剩余澄清项）
- Test: `tests/compat.test.mjs`（追加静态断言 **+ 既有基线联动修订 `:600`/`:671-672`**——验证面扩展后这两处 `problems`/`stdout` 断言随之更新，不是"仅追加"）

**Interfaces:**
- Consumes: 前 9 个 Task 全部产物。
- Produces: compat 脚本验证面与 spec §7.7 **五项全映射**——① Config volatile 声明存在（`runtime.Config` 可达 + toJSON meta 三叶子检查）；② apply 第二参注入通道可用（**与 Task 5 断言联动登记**：Task 5 Step 1②③即该通道证据，compat 侧再以 `apply(ctx, toolOptions)` 实跑驱动注册面，两面不断裂）；③ profile `cordis.patch.yml` 的 `id: dsh-ppt-master-wrapper` 条目——**分层**：bundle insert 层已在本包 `cordis.patch.yml`（→静态断言即足）；profile 层条目由宿主 config-editor `edit()` 在 `index<0` 时 `document.add({id,name,config})` 代建（`dsh-config-editor:105-109` 实证）→ 归 compat/实跑验证路径，不写成 bundle 面静态断言；④ schemastery 可解析性经 §3/Task 5 **同一受控解析通道**断言（不另立通道）；⑤ 入口技能经真实 SkillRegistry 读回列表含 `ppt-master-env`（生产根形态，与 Task 6 决策A 联动）。README 增 spec §8 核对表全部条目（venv 配置/挂载卷与镜像边界/标记即授权/两类孤儿/设置页诊断/schemastery 诊断含 vendor 技能连带丢失/入口技能诊断）；verify-plugin 负向确认（入口 skill 不落盘→比对面不变，实跑）；全量回归 + 版本历史行随下次 sync 规则③处理（**本 Task 不手动 bump**）。
- [ ] **Step 1: 写失败测试** — compat 脚本输出含 §7.7 五项断言的静态/实跑校验（`tests/compat.test.mjs` 以源码文本或子进程方式断言，沿用既有风格）；同文件既有基线 `:600`（`problems` 空集）与 `:671-672`（stdout `OK`/`alpha`）随验证面扩展联动修订。
- [ ] **Step 2: 运行确认失败** — `node --test tests/compat.test.mjs` → FAIL：追加用例红（compat 输出缺五项断言行），已修订的既有基线用例同红即为 RED 表现。
- [ ] **Step 3: 实现** — 扩 compat 脚本 + README 核对表 + spec 回写（**仅"spec 偏差登记"剩余澄清项**；Gate 2 已落的四处勘误不重复改）+ 实跑 `node scripts/verify-plugin.mjs --upstream .upstream/refs/tags/v6.7.0@…` 与 `node scripts/check-dsh-compat.mjs`。
- [ ] **Step 4: 运行确认通过** — `node --test tests/*.test.mjs` 全绿；verify-plugin OK；compat OK（五项断言行全部出现）。
- [ ] **Step 5: Commit + push** — `git commit` 后 `git push origin main`；PAT 取 env `DSH_PPT_GITLAB_PAT`（一次性 URL 注入，输出脱敏）；**push 失败不阻塞本 Task 完成**——保留本地提交待下次推送，未推送包装层提交由下次 sync 按规则③自动处理（不手动 bump）。

---

## spec 偏差登记（全部澄清级，归 Task 10 勘误回写面）

- §5.3 setup_deps payload `venv.path`：计划侧曾丢，**裁决=补回 path 字段**（Task 9 产 `venv:{created,adopted,path,error?}`）。
- §5.4 签名与返回：`ensureVenv(run, path, signal)` → 第三参收 options（`{signal, probeVenvInterpreter, writeMarker}`）；返回增 `adopted`（收编可观测）；`cleanupOldVenv` 增可选 `{remove}` 删除注入缝（Task 4 RED 所需）。
- 命名原语：`probeVenvInterpreter`（同步 fs 存在性）与 `snapshotVenvConfig`（去引用快照）为计划层新增具名，spec 未命名——回写 §5.4/§5.1 措辞并声明与现有 async 三字段版本探测的分工。
- §5.3 on-ready 子态（exists-but-broken）行的 `pythonPath` 单元格与推断式可观测式（Task 6/7：`exists=true ∧ pythonPath=null`）取值不一致——回写时统一，或在该行注明取值口径；同节"invalid×disabled 诊断面 path 如实（无效→null）"与 off 行"按配置原样（不解析）"的定值措辞也需一并对齐。
- §6.1⓪ 后果面：schemastery 解析失败除整插件不可加载外，**vendor 技能面连带丢失**（Task 5 已声明）——回写 §6.1⓪ 加半句连带评估。

## 验收期人工步骤（spec §7.6 真实树 smoke；用户触发，不入自动化测试面）

- [ ] 本机以 `/dsh-home/.ppt-master/venv` 实建 venv + 实装 19 依赖（该路径是**显式配置值**，非 `~` 展开结果）；如实记录 `ppt_master_setup_deps` 的 installCmd/installExit/venv/cleanup 输出。
- [ ] 热重载换代观察：设置页改 `venv.path` → 读回入口 skill 正文与 info/check_env 行为随之换代（前提＝§7.7①②成立）。

---

## Self-Review 记录（修订后复核）

1. **Spec 覆盖**：§5.1→Task 5；§5.2→Task 6；§5.3→Task 7/8/9（矩阵逐行入测试；off/invalid 取定值、broken 走推断式）；§5.4→Task 1-4；§6→各 Task 早退路径测试；§7.1→Task 1-4；§7.2→Global Constraints 形状清单；§7.3→Task 6/7/8；§7.4→Task 5；§7.5→Task 10；§7.6→"验收期人工步骤"；§7.7①–⑤→Task 10 全映射；§8→Task 10；§4.3 时序→Task 9 两类时序断言。无缺口。
2. **步骤可单决**：每步一动作；签名/矩阵/argv 逐字给出；Task 2-9 每步含**确认命令 + 失败判据**（append 型 RED 写明"追加用例红、既有绿"）；实现体留给签名+测试可推导处。
3. **类型一致**：`ensureVenv` 返回含 `adopted`（Task 9 payload 消费）；`effectiveInterpreter.broken`（Task 2 产、Task 3/6/7/8 消）；`cleanupOldVenv.action` 四枚举全任务统一；探测双原语（同步 `probeVenvInterpreter` / async 三字段版本探测）各 Task 引用不混名。
4. **Review Focus**：5 条全部落测试（Task 3/2-3-9/5/4/1-4-9）。
5. **比例**：计划与 spec（181 行）同量级，条目均为任务级指令、无转写代码。
6. **计数权威**：可执行 `apply` 调用 12 = tests 10（字面 `{skillRoots}` 8 + 裸 opts 2，两文件）+ scripts 2；`createSkillProvider` 既有调用 27 处零改动；无 TBD 占位。
