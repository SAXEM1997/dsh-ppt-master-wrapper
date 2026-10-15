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
- 回归基线：现有 382 用例的**行为断言**保持全绿；**形状断言**（`tests/tools-info.test.mjs:105-113`、`tests/tools-check-env.test.mjs:207-209` 的逐字属性集 deepEqual）随 venv 增量同步修订，修订面限于形状（spec §7.2）。
- 每 Task 一个 commit（main 直推，本仓库既有惯例）。

## Review Focus

以下失败模式源自 spec，但不在任何单 task 的主干路径测试里显式覆盖——每条已在归属 task 的步骤中以测试钉住：

1. **非空非 venv 目标目录**（误配指向含数据目录）→ 必须拒绝创建且不写标记（Task 3 Step 1）。
2. **exists-but-broken**（容器重建后符号链接失效）→ 体检识别、不自动删、恢复指引（Task 2/3/9）。
3. **loader 形态 volatile 引用未去引用** → apply 边界快照断言，下游不得感知引用（Task 5 Step 1）。
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

- [ ] **Step 1: 写失败测试** — `tests/venv.test.mjs`：`resolveVenvPath` 矩阵（`~`/绝对/相对/空串）；`venvExists` 真/假；marker 写读回环 + 收编语义（已存在 venv 缺标记→`readMarker` null→`writeMarker` 后可读）；`wrapper-state` 不存在→null、写入→读回、目录不可写→`writeWrapperState` 抛错可被捕获。

- [ ] **Step 2: 运行确认失败** — `node --test tests/venv.test.mjs` → FAIL（模块不存在）。

- [ ] **Step 3: 实现** — 新建 `lib/venv.js` 上述 7 个导出（纯 fs/os，无副作用承诺：本文件此部分只读写 marker 与 wrapper-state 两位置）。

- [ ] **Step 4: 运行确认通过** — `node --test tests/venv.test.mjs` → PASS；`node --test tests/*.test.mjs` → 382+新增 全绿。

- [ ] **Step 5: Commit** — `git add lib/venv.js tests/venv.test.mjs && git commit -m "feat(venv): 路径/marker/wrapper-state 原语（spec §5.4）"`

### Task 2: effectiveInterpreter 四态判定原语

**Files:**
- Modify: `lib/venv.js`
- Test: `tests/venv.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1 的 `resolveVenvPath`、`venvExists`。
- Produces: `effectiveInterpreter(venv, { probePython }) -> { state: 'off'|'invalid'|'on-missing'|'on-ready', pythonPath: string|null, invalidReason: string|null, broken: boolean }`。`probePython(absPath) -> {found: boolean}` 由调用方注入（venv python 探测回调）。判定序：`enabled=false`→`off`（`pythonPath=null`，行为按系统模式；`invalid×disabled` 组合落 `off`——disabled 优先，spec §5.3 细则）；enabled 且 `resolveVenvPath` 无效→`invalid`；`on-missing`=`!venvExists`；`on-ready` 且 `probePython.found=false`→`on-ready`+`broken:true`（exists-but-broken 子态）。

- [ ] **Step 1: 写失败测试** — spec §5.3 矩阵逐行：off/invalid/on-missing/on-ready(on-ready 含 broken 子态)×(pythonPath/broken)取值；disabled+无效路径→state='off'。
- [ ] **Step 2: 运行确认失败** — FAIL。
- [ ] **Step 3: 实现** — 追加导出，组合 Task 1 原语 + 注入 probePython。
- [ ] **Step 4: 运行确认通过** — 全绿。
- [ ] **Step 5: Commit** — `feat(venv): effectiveInterpreter 四态判定（矩阵断言基准）`

### Task 3: ensureVenv（创建/收编前置 + 体检 + 复用）

**Files:**
- Modify: `lib/venv.js`
- Test: `tests/venv.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1/2 全部 + 注入 `run(command, args, options)`（同 tools.js spawnRun 形态，返回 `{exitCode}`）。
- Produces: `ensureVenv(run, absPath, { signal, probePython }) -> { created: boolean, adopted: boolean, error?: string }`。语义（spec §5.4）：目标（不存在→`run('python3',['-m','venv',absPath])` 创建+`writeMarker`，`created:true`）|（空目录→同创建）|（含 `pyvenv.cfg`→体检 `probePython(absPath+'/bin/python3')`：可用→缺标记则补写、`created:false,adopted:true` 复用；不可用→`{created:false, error:'venv 解释器不可用（exists-but-broken）——手动删除该目录后重跑'}`，**不自动删**）|（存在且非空且无 pyvenv.cfg→**fail-loud 拒绝** `{error:'目标目录非空且非 venv'}`，不创建不写标记）|（创建 run 非零/spawn 失败→`{error:…}`）。

- [ ] **Step 1: 写失败测试**（Review Focus #1/#2/#5 之一）— 四分支决策矩阵 + **非空非 venv 拒绝且目录文件原样保留、无 marker** + broken 拒绝不删 + 创建 argv 逐字断言（`['-m','venv',absPath]`）。
- [ ] **Step 2: 运行确认失败** — FAIL。
- [ ] **Step 3: 实现** — 追加 `ensureVenv`。
- [ ] **Step 4: 运行确认通过** — 全绿。
- [ ] **Step 5: Commit** — `feat(venv): ensureVenv 前置三态/拒绝/体检/复用（P0-3 收编前置）`

### Task 4: cleanupOldVenv（四条件删除）

**Files:**
- Modify: `lib/venv.js`
- Test: `tests/venv.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1（`venvExists`/`readMarker`）。
- Produces: `cleanupOldVenv(oldPath, policy, currentPath) -> { action: 'none'|'kept'|'deleted'|'failed', error?: string }`。前置四条件缺一即 `action:'none'`（附原因不抛）：oldPath≠currentPath、**互不前缀包含**（`isPathPrefix` 方向性判定，任一为另一前缀→'none'，Review Focus #4）、`venvExists(oldPath)`、`readMarker(oldPath)` 非 null；四条件全真且 `policy='delete'` → `rmSync(oldPath,{recursive:true,force:true})`（失败→`'failed'`+error，不抛）；`policy='keep'` → `'kept'`。

- [ ] **Step 1: 写失败测试** — 决策矩阵（policy × 存在 × 标记 × 同/异路径 × **前缀包含（双向）** × rmSync 抛错注入）。
- [ ] **Step 2: 运行确认失败** — FAIL。
- [ ] **Step 3: 实现** — 追加 `cleanupOldVenv` + 私有 `isPathPrefix`。
- [ ] **Step 4: 运行确认通过** — 全绿。
- [ ] **Step 5: Commit** — `feat(venv): cleanupOldVenv 四条件删除安全模型`

### Task 5: index.js — Config schema + 统一注入包 + 去引用快照 + 降级视图

**Files:**
- Modify: `index.js`
- Test: `tests/apply.test.mjs`（追加）

**Interfaces:**
- Consumes: `lib/venv.js` 原语（Task 2 判定经 Task 6/9 消费；本 Task 只做装配）。宿主 schemastery 经**受控解析**（复用 `scripts/check-dsh-compat.mjs` 的 node_modules 定位范式：候选路径 `createRequire(...)` 解析；不可解析时按 spec §6.1⓪——但 index.js 加载期抛错会砖化插件，故 Config 构建失败→console.error + 降级为无 Config 导出加载？**否**：spec §6.1⓪ 定为 fail-loud 整插件不可加载——实现即直接抛，宿主 loader 记录）。
- Produces: `export const Config`（叶子级 volatile 三字段 + §5.1 注解文案，含模块加载期求值的插件版本/上游版本/SKILL_DIR）；`apply(ctx, opts)` 第二参统一注入包：入口检测 `opts.venv` 各叶子是否带 `.get()`（引用对象）→ 快照为普通 `{enabled,path,oldPathPolicy}`（缺省补默认）→ 组装 `{skillRoots, venv, invalidReason}` 下传 `createSkillProvider(...)`/`createTools(...)`；降级视图：`venv` 路径无效→**注入包保留原值**、行为层 effective state 由消费方经 Task 2 原语判定（apply 不改写 venv 值），无效时 console.warn（日志补充）。

- [ ] **Step 1: 写失败测试**（Review Focus #3）— ①构造含 `.get()` 引用叶子的 venv → `apply` 后 `createTools` 收到的 `venv` 为普通值断言（用探针 provider 捕获）；②loader 形态缺 venv 键→默认值；③skillRoots 与 venv 共存互不干扰；④相对路径 venv→注入包原值保留 + warn 触发断言；⑤现有 10 处 `apply(ctx,{skillRoots})` 调用行为不回归。
- [ ] **Step 2: 运行确认失败** — FAIL。
- [ ] **Step 3: 实现** — `index.js` 增 Config（受控解析 schemastery + 叶子 volatile + 注解）与 apply 装配改造；`package.json` 的 `exports` 增补内部模块如需（不破坏 `files` 面）。
- [ ] **Step 4: 运行确认通过** — 全绿（含 10 处旧调用）。
- [ ] **Step 5: Commit** — `feat(plugin): Config 叶子 volatile + apply 统一注入包与去引用快照（P0-1/P0-1'）`

### Task 6: skill-provider 合成入口 skill `ppt-master-env`

**Files:**
- Modify: `lib/skill-provider.js`
- Test: `tests/skill-provider.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 5 下传的 `{skillRoots, venv}` + Task 2 `effectiveInterpreter`（probePython 用同步轻量探测）。
- Produces: provider 技能列表 = vendor N + 入口 1（合成对象，**不落盘**）；name `ppt-master-env`；中英双语 description 含"任何 ppt-master 路由前必须先读本入口"；body 四态渲染（spec §5.2：1 开+已建→`<绝对路径>/bin/python3` 替换字面 python3 含 attribution_guard + SKILL_DIR + 读毕路由；2 开+未建→先 setup_deps；3 关→系统 python3；4 无效→修正指引按系统模式；disabled×invalid 落态 3）；固定脚注（陈旧语义指向 info/check_env 实时）。

- [ ] **Step 1: 写失败测试** — 四态 body 内容断言（解释器路径/前置路由语/准备指引/修正方式逐字符串）；数量 vendor N+1；断言无新增 fs 写入（比对面不变）；description 双语断言。
- [ ] **Step 2: 运行确认失败** — FAIL。
- [ ] **Step 3: 实现** — provider 工厂体内追加合成技能（实例注册期快照渲染，spec §5.2 新鲜度定案）。
- [ ] **Step 4: 运行确认通过** — 全绿。
- [ ] **Step 5: Commit** — `feat(skill): 合成入口 skill ppt-master-env（四态解释器契约路由）`

### Task 7: tools.js — info venv 字段 + 描述增量

**Files:**
- Modify: `lib/tools.js`
- Test: `tests/tools-info.test.mjs`（追加+形状修订）

**Interfaces:**
- Consumes: Task 5 下传 `{venv}` + Task 2 `effectiveInterpreter`。
- Produces: `ppt_master_info` payload += `venv: {enabled, path(string|null), exists, pythonPath(string|null)}`（取值按 spec §5.3 矩阵）；工具 description 在 `venv.enabled=true` 时追加解释器提示语（指向入口 skill 契约，spec §5.3 交付项）。

- [ ] **Step 1: 写失败测试** — 矩阵 venv.off/invalid/on-missing/on-ready(×broken) 的 info.venv 字段取值；描述含/不含提示语切换断言；形状断言修订（`INFO_FIELDS` 增 `venv`）。
- [ ] **Step 2: 运行确认失败** — FAIL。
- [ ] **Step 3: 实现** — infoTool 增 venv 小节（经 effectiveInterpreter）+ 描述拼接。
- [ ] **Step 4: 运行确认通过** — 全绿。
- [ ] **Step 5: Commit** — `feat(tools): info venv 状态字段与描述提示语`

### Task 8: tools.js — check_env venv 小节 + 生效解释器探测

**Files:**
- Modify: `lib/tools.js`
- Test: `tests/tools-check-env.test.mjs`（追加+形状修订）

**Interfaces:**
- Consumes: Task 2 原语 + 现有 `run` 注入通道。
- Produces: check_env payload += `venv: {enabled, path, exists, python: {found,version,meetsSkillRequirement}|{skipped}}`；顶层 `python` 保持系统探测；**deps 与 guard 探测同走生效解释器**：`on-ready`→venv python；`off/invalid`→系统 python（invalid 为降级续行）；`on-missing`/`broken`→deps 全 `'UNKNOWN'`/`source:'unknown'`、guard=`{skipped}`（不回退系统探测；guard 词汇不挪用 UNKNOWN，spec §5.3）；guard 跳过判定基准切换为生效解释器（行为变更声明）。

- [ ] **Step 1: 写失败测试** — spec §5.3 矩阵逐行对 check_env；guard `{skipped}` 与 deps UNKNOWN 两形状分开断言；系统模式回归（off 态 = 现行行为逐字节等价）；形状断言修订（诊断四字段→五字段 + 嵌套 venv 小节）。
- [ ] **Step 2: 运行确认失败** — FAIL。
- [ ] **Step 3: 实现** — checkEnvTool 编排改造（探测解释器统一由 effectiveInterpreter 决定）。
- [ ] **Step 4: 运行确认通过** — 全绿。
- [ ] **Step 5: Commit** — `feat(tools): check_env venv 感知——deps/guard 走生效解释器`

### Task 9: tools.js — setup_deps venv 分支（唯一副作用点编排）

**Files:**
- Modify: `lib/tools.js`
- Test: `tests/tools-setup-deps.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1/3/4 全部 + Task 8 的 runCheckEnv。
- Produces: venv 开→`ensureVenv`（拒绝/损坏→按 spec §6 载荷：`venv.error`、installCmd 如实、`installExit=-1`、render 注明未执行、复跑 check_env 按缺失口径、不 throw）；成功→`installCmd=[<venv>/bin/pip3,'install','-r',req]`（flags 忽略并注明）→ `readWrapperState` 读旧路径→安装成功后 `cleanupOldVenv`（读失败 action='none'；写失败清理结果如实+单独上报，Review Focus #5）→`writeWrapperState(absPath)`→复跑 check_env；payload += `venv:{created,adopted,error?}`、`cleanup:{oldPath,action,error?}`；`action='kept'` render 闲置提示行（spec §5.3）。

- [ ] **Step 1: 写失败测试** — 全链时序断言（stub run 记录 argv 顺序：venv 创建→pip 安装→登记更新）；拒绝/损坏/安装失败三早退路径载荷形状；kept/deleted/none/failed 四 action 的 render；系统模式（venv 关）现行行为零回归。
- [ ] **Step 2: 运行确认失败** — FAIL。
- [ ] **Step 3: 实现** — setupDepsTool venv 分支编排（installCmd 组装归 tools.js，spec §3）。
- [ ] **Step 4: 运行确认通过** — 全绿。
- [ ] **Step 5: Commit** — `feat(tools): setup_deps venv 编排——ensure/安装/cleanup/登记/复跑`

### Task 10: compat 扩展 + verify 负向 + README + 收尾

**Files:**
- Modify: `scripts/check-dsh-compat.mjs`, `README.md`, `docs/superpowers/specs/…-design.md`（如有勘误）
- Test: `tests/compat.test.mjs`（追加静态断言）

**Interfaces:**
- Consumes: 前 9 个 Task 全部产物。
- Produces: compat 脚本验证面扩展（spec §7.5/§7.7）：①Config 挂载形态（`runtime.Config` 可达）②三叶子 volatile 存在性（toJSON 检查 meta）③经真实 SkillRegistry 读回列表含 `ppt-master-env`；README 增 spec §8 核对表全部条目（venv 配置/挂载卷与镜像边界/标记即授权/两类孤儿/设置页诊断/schemastery 诊断/入口技能诊断）；verify-plugin 负向确认（入口 skill 不落盘→比对面不变，实跑）；全量回归 + 版本历史行随下次 sync 规则③处理（**本 Task 不手动 bump**）。

- [ ] **Step 1: 写失败测试** — compat 脚本输出含三项新断言的静态/实跑校验（tests/compat.test.mjs 以源码文本或子进程方式断言，沿用该文件既有风格）。
- [ ] **Step 2: 运行确认失败** — FAIL。
- [ ] **Step 3: 实现** — 扩 compat 脚本 + README 核对表 + 实跑 `node scripts/verify-plugin.mjs --upstream .upstream/refs/tags/v6.7.0@…` 与 `node scripts/check-dsh-compat.mjs`。
- [ ] **Step 4: 运行确认通过** — `node --test tests/*.test.mjs` 全绿；verify-plugin OK；compat OK。
- [ ] **Step 5: Commit + push** — `git push origin main`（PAT 经一次性 URL，输出脱敏；规则③：不手动 bump，未推送包装层提交由下次 sync 自动处理）。

---

## Self-Review 记录（写作时执行）

1. **Spec 覆盖**：§5.1→Task 5；§5.2→Task 6；§5.3→Task 7/8/9（矩阵逐行入测试）；§5.4→Task 1-4；§6→各 Task 早退路径测试；§7.5/§7.7→Task 10；§8→Task 10；§4.3 时序→Task 9 argv 顺序断言。无缺口。
2. **步骤可单决**：每步一动作；签名/矩阵/argv 逐字给出；实现体留给签名+测试可推导处。
3. **类型一致**：`ensureVenv` 返回含 `adopted`（Task 9 payload 消费）；`effectiveInterpreter.broken`（Task 2 产、Task 3/8 消）；`cleanupOldVenv.action` 四枚举全任务统一。
4. **Review Focus**：5 条全部落测试（Task 3/2-3-9/5/4/1-4-9）。
5. **比例**：计划 ≈ spec 一半长度，无转写代码。
