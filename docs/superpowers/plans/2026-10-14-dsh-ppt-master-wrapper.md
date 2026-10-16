# dsh-ppt-master-wrapper 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把上游 ppt-master v6.7.0 忠实封装为 DSH 插件（1 个 skill provider + 3 个生命周期工具），并提供一键同步/推送 GitLab 的更新脚本。

**Architecture:** 方案 A——上游 `skills/` 经谓词过滤的 skill 目录逐字节 vendor（零改写，attribution_guard 完整性门 + 全量逐字节比对双保险）；包装层零 npm 依赖（Node ≥20 + `node:test`）；同步脚本分层（解析/检测/版本规则/编排，纯函数可测、编排可注入依赖）。

**Tech Stack:** Node.js ≥20（ESM、`node:test`、`node:crypto`、`node:fs/promises`）；Python 3（上游 guard 与 pip，运行时探测）；git（ls-remote/codeload tag/push）。

**Spec:** `docs/superpowers/specs/2026-10-14-dsh-ppt-master-wrapper-design.md`（212 行终态，3 轮审查 + 最终通读 PASS——执行者必须同时读 spec）

**环境前置**：git 仓库已 init 于 main 分支；参考实现克隆位于 /tmp/ref/dsh-ppt-master（T2 借鉴解析器思路，非硬依赖——「算法由测试确定」兜底）；上游克隆 /tmp/ref/ppt-master（事实核对用；注意该克隆位于 v6.7.0 之后 15 个 commit 的工作树——核对 v6.7.0 事实请先 git checkout v6.7.0）

## Global Constraints

- 零运行时 npm 依赖：`package.json` 无 `dependencies`/`devDependencies`；测试用内置 `node:test`（spec §3.2）
- 上游文件**逐字节零改写**（方案 A，spec §1.1/§2）：vendor 内容与 `.upstream/` 解压树全量逐字节一致
- `version` 镜像上游 + `-rN` 后缀；无后缀视为 `r0`，新后缀 = 当前 N+1；`-rN` 不承诺 semver pre-release 排序（spec §4.3）
- rank=550、`source: 'custom'`、`resourceBase: {kind:'directory'}`、index.js `inject = ['skills','tools']`（spec §3.4/§3.5）
- PAT 仅经环境变量 `DSH_PPT_GITLAB_PAT` 或 `git credential fill`；一次性 URL 不落盘/不进历史/不回显；**绝不写入任何被提交文件**（spec §5）
- main 分支；公开主地址 = `https://github.com/SAXEM1997/dsh-ppt-master-wrapper.git`（URL 无凭据）（spec §5）
- `.gitignore`：`.env`、`.upstream/`、`.skills-staging/`、`__pycache__/`、`*.pyc`、`.mnemon/`、`sync-report.txt`（spec §5）
- 完整性门资产不可动：SKILL.md 门标记、frontmatter 逐字精确值（copyright/license/official_repository）、LICENSE/SPONSORS*、9 个门文件（spec §2）
- 测试 fixtures 是**自造 mini 树**，绝不复制上游 78MB 资产进仓库（tests/ 不入 npm `files`）
- 测试命令统一显式 `tests/` 路径参数（裸 `node --test` 扫全 cwd，vendor 树含上游 pytest 文件——理由详见 Task 13 Step 4）

## Review Focus

1. **dist 名 ≠ import 名**（PyYAML→yaml、skia-pathops 非法标识符）：check_env 以 `importlib.metadata` 查询为一等，import 仅辅助经映射表，映射缺失标 UNKNOWN 非 FAIL → Task 6 测试固定
2. **CRLF/autocrlf 签出环境**：LICENSE 摘要须复刻 guard `_normalized_bytes()`（BOM 拒绝、CRLF/CR→LF）后再 sha256，原始字节直算必误报 → Task 8 测试固定（CRLF 版 LICENSE 与归一化摘要一致）
3. **上游新增 skill 目录**：§4.2 行 1 🔴 必须触发（字面实现曾成死检测），不得静默放行 → Task 11 测试固定（fixture 上游树多一个 skill 目录 → red 含该行）
4. **同名 tag 重推（sha 变化）**：缓存键含 sha 必须失效重下；版本走规则②（`6.7.0`→`6.7.0-r1`）→ Task 10/12 测试固定
5. **`--skip-guard` 与推送组合**：usage 错误退出码 1（含未显式 `--no-push` 的默认推送）；skip 时 verify 记录「guard 未运行」标记 → Task 13 测试固定
6. **vendor 非门文件篡改**（guard 实测不检测追加内容）：verify 的全量逐字节比对必须拦截 → Task 8 测试固定（被验树改动 1 字节 → fail）

---

### Task 1: 仓库骨架与插件清单

**Files:**
- Create: `package.json`、`cordis.patch.yml`、`.gitignore`、`LICENSE`、`README.md`（骨架）、`tests/skeleton.test.mjs`

**Interfaces:**
- Produces: `package.json`（name=`dsh-ppt-master-wrapper`、version=`0.0.0` 占位待 Task 14 定版、type=module、main=index.js、engines.node>=20、dsh.engines.dsh=">=0.1.1-rc.1"、dsh.bundle.patch="./cordis.patch.yml"、files=[index.js,lib,skills,scripts,cordis.patch.yml,README.md,LICENSE]、exports 三条目）；`.gitignore` 七项（Global Constraints 清单）

- [ ] **Step 1: 写失败测试** `tests/skeleton.test.mjs`：断言 package.json 解析后 name/零依赖/files 含 LICENSE/exports 含 `./cordis.patch.yml`/`dsh.engines.dsh=">=0.1.1-rc.1"`/`dsh.bundle.patch="./cordis.patch.yml"`/`type: "module"`/`main: "index.js"`；cordis.patch.yml 含 `- id: dsh-ppt-master-wrapper` 与 `name:` 行；.gitignore 逐项含七条目；LICENSE 首行含 "MIT License"
- [ ] **Step 2: 运行确认失败** `node --test tests/skeleton.test.mjs` → FAIL（文件不存在）
- [ ] **Step 3: 创建五个文件**（package.json/.gitignore/cordis.patch.yml/LICENSE/README.md——package.json 字段清单见本任务 Interfaces，.gitignore 七项见 Global Constraints）——cordis.patch.yml 文件内容 = spec §3.3 代码块原文（4 行，无额外注释；spec 的设计意图说明段属文档正文、不写入文件）；LICENSE 为本插件自身 MIT（版权行 `dsh-ppt-master-wrapper contributors`，README 将致谢上游）；README.md 仅骨架标题+TODO 指向 spec
- [ ] **Step 4: 运行测试通过**
- [ ] **Step 5: Commit** `feat: 插件骨架（清单/patch/gitignore/LICENSE）`

### Task 2: frontmatter 解析器（lib/skill-provider.js 第一部分）

**Files:**
- Create: `lib/skill-provider.js`（本任务仅导出 `parseFrontmatter`/`parseSimpleYaml`）
- Test: `tests/frontmatter.test.mjs`

**Interfaces:**
- Produces: `parseFrontmatter(raw: string) → { data: object, body: string } | null`（无 `---` 块返回 null）；`parseSimpleYaml(text: string) → object`（标量/嵌套对象/`- item` 数组/`>` 折叠/`|` 字面 block scalar/引号剥离）

- [ ] **Step 1: 写失败测试**：上游真实形态用例——嵌套 `metadata:`（version/copyright/license/official_repository）、`sponsors:` 数组、`description: >` 折叠为单行、`|` 保留换行、引号值剥离、无 frontmatter → null、未闭合 frontmatter → null
- [ ] **Step 2: 运行确认失败**（导出不存在）
- [ ] **Step 3: 实现**——借鉴 pn1024 参考实现（`/tmp/ref/dsh-ppt-master/index.js` 的 parseSimpleYaml/findClosingFrontmatter 思路，逐行缩进解析；算法由测试确定）；实现须将无块情形归一化为 **null**（契约与测试保持返回 null——无 frontmatter/未闭合 → null），不照抄参考实现的 undefined
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat: frontmatter 解析器（标量/嵌套/数组/block scalar）`

### Task 3: Skill Provider（list/get + 失败契约）

**Files:**
- Modify: `lib/skill-provider.js`（追加 provider）
- Test: `tests/skill-provider.test.mjs`、fixture `tests/fixtures/skills-fixture/`（自造：`alpha/SKILL.md` 合法、`beta/` 无 SKILL.md、`.hidden/SKILL.md` dotfile 且含 SKILL.md **应收录**、`broken/SKILL.md` 缺 description）

**Interfaces:**
- Consumes: Task 2 的 `parseFrontmatter`
- Produces: `createSkillProvider(roots?: string[]) → { name, list(options?), get(candidate, options?) }`；候选字段含 `name/description/metadata/invocation{modelInvocable:true,userInvocable:true}/provider/source:'custom'/resourceBase{kind:'directory',path}/rank:550/locator/path`；`get` 返回含 `content`（frontmatter 后正文）；`SKILL_RANK=550` 导出

- [ ] **Step 1: 写失败测试**：fixture 上 `list()` 收录 alpha 与 .hidden、跳过 beta；`get(alpha)` 往返一致且 content 正确；`broken`（含 SKILL.md 但 description 缺失）→ **注册时 throw**（provider 注册阶段对含 SKILL.md 但 frontmatter 非法的目录 fail-loud；list() 触发同一注册校验）；name 非 kebab-case → throw；`roots` 参数指向 fixture（扫描根注入）；roots 不存在 → throw（空根 fail-loud，spec §3.4 扫描根注入契约）；roots 指向存在但零 skill 目录的空目录 → 注册时 throw（空根 fail-loud 含"不存在或为空"两判据，spec §3.4）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——谓词=「`skills/` 一级目录且直接子级存在 `SKILL.md`（无论是否 dotfile）」；dotfile 含 SKILL.md 收录；缺 name/description 或 name 非 kebab → 注册时 throw（spec §3.4 权威谓词与两级判据：仅 name≠目录名为警告级，不在 provider 判定）；**不沿用**参考实现的 readFile 直读（其对无 SKILL.md 目录实测抛 ENOENT）——本实现先做 SKILL.md 存在性判定再读取，此为 spec §3.4 权威谓词要求的必要偏离
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat: skill provider（泛化扫描+fail-loud 契约）`

### Task 4: index.js 装配与能力探测降级

**Files:**
- Create: `index.js`
- Create: lib/tools.js（stub——3 个最小合法契约占位定义，见 Interfaces）
- Test: `tests/apply.test.mjs`

**Interfaces:**
- Consumes: `createSkillProvider`（Task 3）；Task 5-7 的 `createTools()`（本任务同步创建 `lib/tools.js` stub：导出 **3 个满足 SDK 最小合法契约的占位工具定义**——`parameters: { type: 'object', properties: {}, additionalProperties: false }` + 最小 output/execute 占位（实测空 schema/缺 output 会被真实 register 拒绝：JsonSchemaError/TypeError；stub 阶段仅经 mock ctx 校验，T7 替换完成前不接触真实 register），Task 5-7 逐个替换为真实实现；如此 T4 断言「注册 3 工具」自 T4 起全程成立，Task 7 完成后跑一次全链）
- Produces: `export const name='dsh-ppt-master-wrapper'`、`export const inject=['skills','tools']`、`export function apply(ctx, opts?: { skillRoots?: string[] })`——ctx.skills.registerProvider 必存在否则 throw；ctx.tools 存在且 .register 为函数 → 注册 3 工具，否则降级仅注册 provider（日志声明降级）；第二参为扫描根注入通道：index.js 将 `opts?.skillRoots` 透传 `createSkillProvider(roots)`（Task 3 契约），省略时默认取包内 `skills/`——生产路径零改动

- [ ] **Step 1: 写失败测试**：mock ctx（skills+tools）→ provider 注册且 tools.register 被调 3 次或以数组注册一次（按实现契约断言）；mock ctx（仅 skills）→ provider 注册、不 throw、有降级日志；经 `apply(ctx, { skillRoots: [fixture 根] })` 注入 fixture 根（复用 Task 3 的 `tests/fixtures/skills-fixture/`）→ provider 注册成功不 throw——扫描根注入通道，解决 T14 前真实 `skills/` 目录不存在的断链；apply 幂等性不要求
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**（≤40 行；index.js 将 `opts?.skillRoots` 透传 `createSkillProvider`——未传时 provider 默认取包内 `skills/`；同步创建 `lib/tools.js`：`createTools()` 返回 3 个满足 SDK 最小合法契约的占位工具定义（`parameters: { type: 'object', properties: {}, additionalProperties: false }` + 最小 output/execute 占位），Task 5-7 逐个替换为真实实现——使「注册 3 工具」断言全程成立）
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat: 插件入口（inject 声明+能力探测降级）`

### Task 5: 工具 ppt_master_info

**Files:**
- Modify: `lib/tools.js`
- Modify: lib/skill-provider.js（可选：导出 listSkillDirs(root) 辅助，供 SKILL_DIR 定位复用）
- Test: `tests/tools-info.test.mjs`（per-case 独立 tmp 树构造：单/双/无 skill 三形态各自建树，不复用 Task 3 的 4 目录 fixture——见 Step 1）

**Interfaces:**
- Produces（`createTools()` 数组第一项）: `{ name:'ppt_master_info', description: 双语短句, parameters:{}, output:{ schema: object-rooted JSON Schema（显式字段定义 + `additionalProperties: false`）, render }, execute: async (args, exec) => info`；info 对象含 `pluginVersion/upstreamVersion/skillDirs:string[]/primarySkillDir/primarySkillName/primaryIsFallback:boolean/repository`（七字段——primaryIsFallback：主目录锚定命中=false、无匹配回退=true，fallback 标注落此字段）——该字段集即 output.schema 的属性集（**不得用 `type:'json'`**：实测被 SDK 静默降级为空契约；additionalProperties 归因修正：**defineTool 的 valueSchemaSpec 路径**实测强制显式 additionalProperties——register() 裸路径实测不强制（同一无 AP schema 经 assertSupportedJsonSchema ACCEPTED）；本计划统一写显式 `additionalProperties: false` 作为编码规范，为 defineTool 路径与未来收紧预留）；主目录锚定 `ppt-master`（按 name（无 name 时 metadata）匹配本体 skill；无匹配回退目录名字节序第一并置 `primaryIsFallback=true`）；SKILL_DIR 定位谓词同 Task 3；`execute(args, exec)` 尊重 `exec.signal`（spec §3.5 三工具统一要求）

- [ ] **Step 1: 写失败测试**（per-case 树构造：单 skill / 双 skill（alpha+zeta，zeta 的 name=ppt-master）/ 无 skill 三种形态分别用独立 tmp 树构造——不复用 Task 3 的 4 目录 fixture（其含 .hidden/broken 等无关目录且排序歧义）；排序约定写死：目录名字节序）：单 skill（alpha 的 metadata.version 预设 "9.9.9"）→ primarySkillDir 正确、upstreamVersion 解析自 metadata；双 skill → primary=zeta 且 `primaryIsFallback===false`（zeta 的 name=ppt-master 锚定命中）；双 skill 变体（zeta name≠ppt-master，无锚定）→ 回退目录名字节序第一且 `primaryIsFallback===true`（fallback 标注落此字段）；无 skill 目录 → throw（fail-loud）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——读 package.json version、扫描定位（复用 provider 谓词逻辑，可从 lib/skill-provider.js 导出 `listSkillDirs(root)` 辅助）
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat: ppt_master_info 工具`

### Task 6: 工具 ppt_master_check_env（依赖探测元数据一等）

**Files:**
- Modify: `lib/tools.js`
- Test: `tests/tools-check-env.test.mjs`、fixture `tests/fixtures/requirements-fixture.txt`（含 PyYAML、python-pptx、skia-pathops、Pillow、flask 等混合）

**Interfaces:**
- Produces: 工具定义含 description: 双语短句（同 Task 5 约定，spec §3.5 三工具统一要求）；`execute` 返回诊断对象 `{ python: {found, version, meetsSkillRequirement≥3.10 informational}, guard: {ran, exitCode}|{skipped}（skipped 触发条件=python3 缺失（spawn 失败）时 guard 未运行；python3 存在则为 ran 形态）, deps: [{dist, importName|'UNKNOWN', installed: boolean|'UNKNOWN', source:'metadata'|'import'|'unknown'}], envFileExists: boolean }`——output.schema 属性集=上述字段（同 Task 5 句式：object-rooted + `additionalProperties: false`）；内置 `DIST_TO_IMPORT` 映射表（PyYAML→yaml、Pillow→PIL、python-pptx→pptx、beautifulsoup4→bs4、PyMuPDF→fitz、skia-pathops→pathops、XlsxWriter→xlsxwriter、google-genai→google.genai、edge-tts→edge_tts…）；元数据查询经 `python3 -c "import importlib.metadata..."` 子进程，退出码解析定死：**PackageNotFoundError（python 退出码 1 + 该异常名）→ `installed: false`**；python 子进程**非零退出且非 PackageNotFoundError**（如 ImportError/MemoryError 等 python 级失败）→ 该项 `UNKNOWN`（source:'unknown'，注明 python 子进程异常）——探测失败≠未安装，不误报 false；仅 spawn 级失败（ENOENT 等）→ 该项 UNKNOWN；**不读 .env 内容**；`execute(args, exec)` 尊重 `exec.signal`（spec §3.5 三工具统一要求）
- 纯函数导出（供测试）：`parseRequirements(text) → string[]`（顶层发行版名，剥版本钉扎/extras/注释/`-r` 行）、`mapDistToImport(dist) → string|'UNKNOWN'`

- [ ] **Step 1: 写失败测试**：`parseRequirements` 对 fixture 输出正确发行版名列表；`mapDistToImport('PyYAML')==='yaml'`、`('skia-pathops')==='pathops'`、`('not-a-real-dist')==='UNKNOWN'`；元数据子进程边界（stub exec）：退出码 1 且 stderr 含 `PackageNotFoundError` → `installed: false`、python 子进程非零退出且非 PackageNotFoundError（如 ImportError/MemoryError 等 python 级失败）→ 该项 `UNKNOWN`（source:'unknown'，注明 python 子进程异常）——不误报 false、仅 spawn 级失败（ENOENT 等）→ 该项 UNKNOWN；无 python3 环境（stub run 抛 ENOENT）→ python.found=false 且 guard.skipped===true 且 deps 全 UNKNOWN 而非 FAIL（整体不 throw）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——子进程调用统一经可注入 `exec` 助手（尊重 `exec.signal`）；≥3.10 仅 informational（spec §3.5 与 §4.1 步骤 4：≥3.10 属 check_env 探测项、不参与退出码体系）
- [ ] **Step 4: 运行通过**（本机有 python3 时顺带跑一次真实验证但不依赖其存在）
- [ ] **Step 5: Commit** `feat: ppt_master_check_env（元数据一等+映射表+UNKNOWN）`

### Task 7: 工具 ppt_master_setup_deps

**Files:**
- Modify: `lib/tools.js`、`index.js` 无需改（createTools 已接入）
- Test: `tests/tools-setup-deps.test.mjs`

**Interfaces:**
- Produces: `{ name:'ppt_master_setup_deps', description: 双语短句（同 Task 5 约定，spec §3.5 三工具统一要求）, parameters:{ user:{type:'boolean'}, breakSystemPackages:{type:'boolean'} }, execute }`——构造 `pip install -r <SKILL_DIR>/requirements.txt`（按参数附 `--user`/`--break-system-packages`）；装完复跑 check_env 逻辑汇报——execute 返回结构 `{ installCmd: string[], installExit: number, checkEnv: <Task 6 诊断对象> }`，output.schema 属性集=上述字段（同 Task 5 句式：object-rooted + `additionalProperties: false`）；命令构造为纯函数导出 `buildPipArgs(requirementsPath, opts) → string[]`；`execute(args, exec)` 尊重 `exec.signal`（spec §3.5 三工具统一要求，与 T5/T6 同）

- [ ] **Step 1: 写失败测试**：`buildPipArgs` 参数组合 4 例（默认/user/break/both）；execute 在 stub exec 下调用序列=install→check_env
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**（SKILL_DIR 定位复用 Task 5）
- [ ] **Step 4: 运行通过 + 全链验证**：`node --test tests/apply.test.mjs`（apply.test.mjs 的 3 工具断言自 T4 占位 stub 起即成立，T7 替换为真实实现后无需改动断言）
- [ ] **Step 5: Commit** `feat: ppt_master_setup_deps（幂等安装+复跑自检）`

### Task 8: verify-plugin.mjs

**Files:**
- Create: `scripts/verify-plugin.mjs`
- Test: `tests/verify-plugin.test.mjs`、fixture `tests/fixtures/mini-vendor/`（自造含 SKILL.md 门标记/LICENSE/SPONSORS×2/9 个门文件占位/requirements/一个 workflows 链接文件/attribution_guard.py 占位文件（含可解析的 `_LICENSE_DIGEST = "<fixture 摘要>"` 与 `_EXACT_METADATA_VALUES` 字面量——检查项①②需从**被验树内**该文件解析期望值，spec §6 ① 来源逻辑）——**基线树不含越界链接**，否则与基线用例「warnings 空」互斥；越界链接断言用独立构造树或篡改副本承载）、fixture `tests/fixtures/mini-upstream/`（=mini-vendor 完整拷贝）

**Interfaces:**
- Consumes: `index.js` apply（真实 provider 驱动）
- Produces: `node scripts/verify-plugin.mjs [--root <dir>] [--upstream <dir>] [--skip-guard]`（`--skip-guard` 仅向 runVerify 透传 skipGuard；**无 `[--skip-guard-marker note]` 参数**）；导出纯函数 `normalizedSha256(bytes: Uint8Array) → string`（BOM 拒绝→UTF-8 解码→CRLF/CR→LF→sha256 hex）、`parseExpectedDigest(guardSource: string) → string`（正则 `_LICENSE_DIGEST = "..."`；无匹配 → throw）、`runVerify(root, opts?: { skipGuard?: boolean, upstream?: string }) → { problems: string[], warnings: string[] }`（skipGuard=true → **warnings** 含「guard 未运行」标记（标记归属 warnings——它不是缺陷），Review Focus #5）；`--upstream <dir>` 缺省语义：缺省时第⑥项（全量逐字节比对）fail-loud 报 problems 提示「需提供 --upstream 比对树」（与脚本推送前置门定位一致，不静默跳过）

- [ ] **Step 1: 写失败测试**：
  - `normalizedSha256`：LF 版与 CRLF 版同内容 → 同摘要；带 BOM → throw（解释性事实，非测试依据：真实上游 LICENSE 无 CRLF 故两摘要相同——因此测试必须构造 CRLF 副本，与真实文件无关）
  - `parseExpectedDigest`：正常源 → 摘要；无常量 → throw（fail-loud）
  - `runVerify` fixture 全绿：problems 空、warnings 空（基线用例须传 `--upstream` 指向 mini-upstream fixture——缺省语义下 problems 必非空，见 Interfaces 缺省说明）；list/get 往返（驱动真实 index.js——经 `apply(ctx, { skillRoots: [mini-vendor fixture 根] })` 注入扫描根：同一注入通道，T14 前真实 `skills/` 不存在）；mock ctx 断言 3 工具注册、且各工具 `output.schema` 为 object-rooted JSON Schema（显式字段定义 + `additionalProperties: false`——断言检查 **schema 形态符合计划规范**而非「缺 AP 必抛」：**defineTool 的 valueSchemaSpec 路径**实测强制显式 additionalProperties，register() 裸路径实测不强制（同一无 AP schema 经 assertSupportedJsonSchema ACCEPTED），显式 AP:false 为计划编码规范；实测 `type:'json'` 被 SDK 静默降级为空契约）（工具面）
  - `runVerify(root, { skipGuard: true })` → **warnings** 含「guard 未运行」标记（Review Focus #5）
  - 篡改用例①：mini-vendor 副本改 LICENSE 一字节 → guard 等价清单拦截（digest 不匹配）
  - 篡改用例②：改某非门文件 1 字节 + `--upstream` 指向干净树 → **全量逐字节比对拦截**（Review Focus #6）
  - 不对称用例：upstream 树含 vendor 没有的根文件与辅助目录 → 不产生 problems（方向性 skill 面比对天然豁免——比对范围见 Step 3 第⑥项）
  - frontmatter 两级：name≠目录名 → warnings 含之不进 problems；name 缺失 → problems
  - description 缺失 → problems 含该项（spec §6 verify 行「description 非空」判据）
  - 链接：越界链接（`../../../docs/x.md`）→ warnings（**用独立构造树或 mini-vendor 篡改副本断言 warnings 含之**——fixture 基线树不含越界链接，基线用例保持 problems 空、warnings 空）；子树内死链 → problems
  - name 非 kebab → problems（fixture 用例）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——检查清单=spec §6 verify 行逐项（①归一化摘要取**被验目标树**内 guard 的期望值 ②frontmatter 逐字精确值三键（copyright/license/official_repository 期望值取**被验树自身 SKILL.md 当前值**与 guard `_EXACT_METADATA_VALUES` 常量双重核对——guard 常量用正则从被验树 attribution_guard.py 解析（同 ① 的来源逻辑），不硬编码） ③归属文件 ④9 门文件 ⑤门标记计数 ⑥全量比对（比对范围写死：**方向性 skill 面比对**——以被验树（vendor 或 staging）的每个 skill 目录为基准，与 upstream 解压树中**对应同名 skill 目录**逐一比对，不比较上游根文件与 skills/ 一级非 skill 目录——它们不在 vendor 面，spec §4.1 步骤 3 自证） ⑦链接 ⑧门标记存在 ⑨3 工具注册且各工具 output.schema 为 object-rooted JSON Schema（显式字段 + `additionalProperties: false`））；problems 非空 → **exit 1**（verify-plugin 自身退出码，spec §6 仅要求非零）列出全部——sync-upstream 编排内该失败**映射为退出码 4**（spec §4.1 单表；两层退出码勿混用）
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat: verify-plugin（guard 逐项等价+全量比对+两级判据）`

### Task 9: check-dsh-compat.mjs

**Files:**
- Create: `scripts/check-dsh-compat.mjs`
- Test: `tests/compat.test.mjs`

**Interfaces:**
- Produces: 导出 `resolveDshModules(explicit?: string, env: object) → { path: string, via: string }`（顺序：参数 > `$DSH_NODE_MODULES` > `$DSH_PROFILE_DIR/node_modules` > `$DSH_HOME/profiles/$DSH_PROFILE/node_modules` > `$DSH_HOME/profiles/node_modules`；**按序探测、命中即用——有序优先级即消歧**；第五级（`$DSH_HOME/profiles/node_modules`）不存在时，回落**扫描** `$DSH_HOME/profiles/*/node_modules`（>1 命中 → throw 列出候选要求显式指定）——此即「无序扫描」场景的唯一入口；「多候选 → 报错列出候选」仅适用于**无序扫描**场景（不带环境变量的目录扫描发现多个 profile 时）；全失败 → 报错退出）；`node scripts/check-dsh-compat.mjs --dsh-modules <dir>` 主流程（CLI 形态对齐 spec §6）：定位→动态 import dsh-skill SkillRegistry 挂载 provider 读回→验证 ToolRuntime register 接受手写工具定义（缺 `output` 会 TypeError 的契约核实；compat 验证注册的是 `createTools()` 真实三工具产物（非临时最小定义）——生产 schema 在真实 SDK 上验证（Y3 契约链第三传导点））→ rank 550 < BUNDLED_SKILL_RANK 600 相对关系→读回 superpowers-dsh 实际常量比对（漂移告警）；主流程接受可注入依赖（动态 import 函数与期望 rank 常量，参照 Task 13 的 deps 模式）

- [ ] **Step 1: 写失败测试**：`resolveDshModules` 用 fake env 五级优先级逐一断言；有序优先级命中即用（前级命中不再探测后级、不报多候选）；无序扫描场景（不带环境变量的目录扫描发现多个 profile，tmp 构造；用例经「五级全失败后回落扫描」路径驱动——五级均未命中才进入 `$DSH_HOME/profiles/*/node_modules` 扫描，此为无序扫描唯一入口）→ throw 列出候选；env 无 DSH_HOME → throw；注入期望 rank=550 与 stub superpowers-dsh 常量 600 不一致 → 告警且非零退出（漂移检出分支可触发）；compat 挂载入口=本插件根 index.js（非参考实现的 lib/index.js——显式断言入口路径防照抄）；驱动 index.js 时经 `apply(ctx, { skillRoots: [fixture 根] })` 注入扫描根（同一注入通道，T14 前真实 `skills/` 不存在）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**（本机 `$DSH_PROFILE_DIR=/dsh-home/profiles/web`——该变量为 profile 根、其下无 @deepseek-ai，SDK 实际位于 `$DSH_PROFILE_DIR/node_modules`——真实可跑，作为 Step 4 验证）
- [ ] **Step 4: 运行通过 + 真实环境 smoke**：`node scripts/check-dsh-compat.mjs` → 本机真实 SDK 上全绿；若 register 拒绝手写工具定义 → 按 spec §3.5 回退声明 `@deepseek-ai/dsh-tools` 为 peerDependency 并 import defineTool，重跑本验证（peerDependency 不违反 Global Constraints 的零 dependencies 约束——该约束禁运行时依赖，peerDep 仅声明宿主必带包的兼容范围，且仅在 compat 验证失败时启用）
- [ ] **Step 5: Commit** `feat: check-dsh-compat（五级定位+契约+rank 漂移检出）`

### Task 10: sync 解析层（repo/ref/tag/缓存/预检）

**Files:**
- Create: `scripts/sync-upstream.mjs`（本任务：参数解析 + 纯函数层；`main` 占位）
- Test: `tests/sync-parse.test.mjs`

**Interfaces:**
- Produces 纯函数导出：
  - `parseArgs(argv) → Options{repo?, ref?, refresh?, confirmStructural?, skipGuard?, noPush?, dryRun?}`（非法组合 `--skip-guard` 未与 `--no-push`/`--dry-run` 联用 → `{ usageError: true }`）
  - `parseLsRemote(text) → Array<{sha, ref, tagName?, isAnnotated}>`（松散行剥除后按主行返回；annotated 信息以 isAnnotated 布尔并入同一返回——不设第二返回值/旁路映射）
  - `pickLatestTag(entries) → { name, sha } | null`（`^v?\d+\.\d+\.\d+$` 过滤 + 数字元组逐段比较；null=无匹配）
  - `normalizeRef(ref) → string`（tag→`refs/tags/<远端原名>`、branch→`refs/heads/`、40 位 sha 原样；**不得产生 `refs/tags/refs/tags/…`**；commit ref 必须为 40 位全长 sha（codeload 对短 sha 接受性未验证且不假设）；非 40 位且不匹配 tag/branch 形态 → usageError 明确报错）
  - `buildCodeloadUrl(repo, normalizedRef) → string`
  - `cacheKey(ref, sha) → string`（`<ref>@<sha>`；sha 取该 tag 的 `^{}` 行 commit sha，否则 tag 行）
  - `diskBudget(tarballBytes?) → number`（无参=启动保守 260MB；有参=实际三项和——三项口径定死：①codeload **全仓库** tarball 实际字节（Content-Length；实测 ≈48.6MB，注意非 skills 子树 tarball ≈17.5MB）②解压后 `.upstream` 全树（实测 ≈114MB）③staging 副本（≈78MB））
- 状态文件契约：`.upstream/last-sync.json` `{ref, sha, version, at}` 读写助手

- [ ] **Step 1: 写失败测试**：ls-remote fixture（含 v2.13.0 在 v2.2.0 之前的无序输出 + `^{}` 行）→ parseLsRemote 返回剥除 `^{}` 松散行后的主行数组且 annotated 信息以 `isAnnotated` 布尔并入同一返回（对齐 Interfaces 契约——无第二返回值/旁路映射）；pickLatest 正确取 v2.13.0 且 **pickLatestTag 保留远端原名（带 v）**；`v6.7.0` → normalizeRef 产出 `refs/tags/v6.7.0`（远端原名保留 v 前缀；实测 41 个 semver tag 全部 v 前缀，`refs/tags/6.7.0` 实测 404）；无 v 前缀 tag 仅作 normalizeRef 防御性分支断言（不与 codeload 真实性绑定）；normalizeRef 边界用例：短 sha（如 `abc123`——非 40 位且不匹配 tag/branch 形态）→ usageError 明确报错（commit ref 必须 40 位全长 sha；codeload 对短 sha 接受性未验证且不假设）；tag 重推 sha 变 → cacheKey 不同（Review Focus #4）；`parseArgs(['--skip-guard'])` → usageError；`parseArgs(['--skip-guard','--no-push'])` → 合法；diskBudget(50969212)  // 50969212 B ≈ 48.6MB（全仓库 tarball 实测值）→ 返回三项之和 ≈240MB（48.6+114+78）；diskBudget 两段测试：无参 → 260MB 固定值；有参 → 三项实际之和
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat: sync 解析层（tag 元组比较/ref 规范化/缓存键/usage 校验）`

### Task 11: sync 检测层（staging 复制/结构分类/marketplace 校验）

**Files:**
- Modify: `scripts/sync-upstream.mjs`（追加）
- Test: `tests/sync-detect.test.mjs`、fixtures `tests/fixtures/upstream-tree/`（多 skill：`skills/ppt-master/` mini + `skills/second-skill/SKILL.md` + `skills/.claude-plugin/plugin.json` + 根 `.claude-plugin/marketplace.json`）与 `tests/fixtures/vendor-tree/`（仅旧版 ppt-master）

**Interfaces:**
- Produces: `stageSkills(upstreamRoot, stagingRoot) → string[]`（复制源=谓词过滤的全部 skill 目录；**不进入** staging：`skills/` 一级不含 SKILL.md 的目录；复制面=**含目录内隐藏文件**的逐字节复制，dotfile 不排除——如 `.env.example`（实测被上游 git 跟踪、README 指引依赖它，不得被复制面排除））；`classifyChanges(vendorSkillsRoot, stagingRoot, upstreamRoot) → { red: Change[], yellow: Change[], green: boolean, vendorDiff }`（vendorDiff 命名与 Task 12 decideVersion 输入一致，Task 13 桥接零转换；vendorDiff 推导语义=vendor skill 面与 staging 之间存在**任何**字节差异（含红/黄类变更涉及的文件与常规文件）——供 T12 规则①/④判别；Change 含 `kind`（skill-dir/name/metadata.version/top-level-entries/requirements/description/aux-dir）、`detail`；skill 目录**根级**其余文件（LICENSE/SKILL.md/SPONSORS*/requirements.txt/.env.example 等）内容变更 → 🟢 green（常规同步；含 .env.example）——消除分类空白；数据源：vendor vs staging 为主、辅助目录与 marketplace 用 `.upstream` 全树）；行 1（skill-dir）比对为**单向（上游→vendor）**——vendor 侧多出的 skill 目录属包装层变更（规则③），不入 red；`checkMarketplaceVersion(upstreamRoot, skillVersion) → { ok: boolean, note }`（文件缺失 → `{ok:true, note:'豁免'}` 警告语义）（该校验的**调用点在 T13 编排的 staging 步**——T11 仅提供纯函数；'豁免 note 并入 🟡 汇总'同样由 T13 编排执行）；🟡 汇总含 marketplace.json 豁免 note（checkMarketplaceVersion 返回豁免时并入，供步骤 6 输出——并入动作由 T13 编排执行）

- [ ] **Step 1: 写失败测试**：
  - fixture 上游比 vendor 多 `second-skill` → **red 含 skill-dir 变更**（Review Focus #3）
  - vendor 树比 staging 多一个 skill 目录 → 不产生 red（行 1 单向比对：上游→vendor）
  - `skills/.claude-plugin/` 存在 → staging **不包含**它（**前置 existsSync 断言 fixture 中 `skills/.claude-plugin/plugin.json` 确实存在，防空断言假绿**）；classify 的 yellow 含 aux-dir（数据源=upstream 全树）
  - fixture skill 目录含隐藏文件（如 `skills/ppt-master/.env.example`）→ staging 保留该 dotfile（前置 existsSync 防空断言；vendor 侧经编排替换后同样保留——复制面含隐藏文件）
  - SKILL.md name 变更 → red(kind=name)；metadata.version 缺失 → red；description 变更 → yellow；requirements 行增删 → yellow；仅正文文件变更 → green 路径；仅常规文件变更 → vendorDiff=true（green 路径同时 vendorDiff=true——vendorDiff 含任何字节差异）
  - marketplace.json version 与 skillVersion 不一致 → ok:false；文件缺失 → 豁免
  - §4.2 行 4：fixture 上游树某 skill 的 `scripts/` 下增删一级子目录 → red 含 `kind=top-level-entries`
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**（比对用逐文件字节比较——复用 verify 的比对思路可抽 `commonBytesEqual` 本地助手）
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat: sync 检测层（谓词 staging+🔴🟡🟢 分类+marketplace 校验）`

### Task 12: sync 版本规则（decideVersion 纯函数）

**Files:**
- Modify: `scripts/sync-upstream.mjs`（追加）
- Test: `tests/sync-version.test.mjs`

**Interfaces:**
- Produces: `decideVersion(input: { current: string, upstreamVersion: string|null, vendorDiff: boolean, wrapperPending: boolean }) → { version: string, rule: '①'|'④'|'②'|'③'|'no-change', notes: string[] }`
  - ①上游版本变（含 vendorDiff）→ `version=上游版本`、r 归零、notes 含「包装层此前有 N 次修订已被归零」（当 current 带 rN）
  - ④上游版本变但 vendorDiff=false → 同①版本、tag 该版本（镜像语义）
  - ②上游版本未变 + vendorDiff → `-r`+1（`6.7.0`→`6.7.0-r1`；`6.7.0-r1`→`6.7.0-r2`）
  - ③仅包装层变更（vendorDiff=false 且 wrapperPending）→ `-r`+1；**docs-only（两者皆无）→ no-change**（不落③）
  - 解析助手 `parseRSuffix(version) → { base, n }`（无后缀 n=0）

- [ ] **Step 1: 写失败测试**：五分支五枚举值（①④②③/no-change）+ 边界组合（current=`6.7.0-r3` 上游升 `6.8.0` → `6.8.0` + 归零 note；current=`6.7.0` 同版本 tag 重推 diff → `6.7.0-r1`；`6.7.0-r1` 再重推 → `6.7.0-r2`；docs-only → no-change；②③同时命中按②；纯③（仅 wrapperPending=true，vendorDiff=false）→ `6.7.0`→`6.7.0-r1`；纯④（上游版本变+vendorDiff=false）→ rule=④、version=`6.8.0`；upstreamVersion: null（理论上由 §4.2 行 3 🔴 前置拦截，纯函数契约仍需自洽）→ 返回 no-change（不 throw））
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**（优先级互斥、命中即止）
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat: sync 版本规则（①④②③互斥+r0 基数+归零观测）`

### Task 13: sync 流程编排（门/verify 前置/替换/tag/幂等/push/退出码）

**Files:**
- Modify: `scripts/sync-upstream.mjs`（`main(options, deps?)`——deps 可注入 `{ fetchTarball, runGit, runPython, now, runVerify, freeSpace }` 供测试；fetchTarball 注入契约：`deps.fetchTarball(url, dest) → Promise<{ bytesPath: string, contentLength: number }>`——下载与解压**分离**（返回 tarball 落盘路径与 Content-Length，解压由编排执行——使二次预检可在解压前经 stub 驱动）；runVerify 为注入位——编排不直接 import verify-plugin，经 deps 调用）
- Test: `tests/sync-orchestrate.test.mjs`

**Interfaces:**
- Consumes: Task 10-12 全部纯函数；`scripts/verify-plugin.mjs` 的 `runVerify`
- Produces: `main(options, deps) → Promise<number>`（退出码）；编排序列=spec §4.1 步骤 1-8（解析[`--confirm-structural` 且未显式传 `--ref` 时，ref 取 `.upstream/last-sync.json` 记录值（固定上次检出的 ref）]→拉取[缓存键/两段预检；last-sync.json 写入时机：拉取成功即写 ref/sha（`git checkout` 前落盘），version 字段于 bump 后更新，退出码 2（结构变化）也先写 ref/sha——保证 `--confirm-structural` 重跑固定 ref 有值可取]→staging[marketplace 校验]→guard[逐 skill；3/7 细则：解释器级=7、guard 业务=3]→结构检测→自动路径[verify 前置 staging——以 `runVerify(stagingRoot, { skipGuard, upstream: <解压树路径> })` 调用（编排必须显式传 upstream，否则按 T8 缺省 fail-loud 语义第⑥项恒 exit 4）→替换 skill 面→bump→🟡 汇总（三类指引来源 spec §4.1 步骤 6：依赖变更→提醒重跑 ppt_master_setup_deps；description 变更→知悉；辅助目录增删→知悉）→commit→tag 先行检测映射 6→写 sync-report.txt（仓库根，每次覆盖）→push→清理 staging（spec §4.1 步骤 6 末尾动作）]→结构路径[报告+sync-report.txt 落盘，码 2]→幂等[范围=vendor+包装层待发布；短路前 ref sha 先比——ref sha 先比是**可选优化**（命中可省下载；省略亦正确——幂等判定本身在 staging 完成后执行，spec 允许）；短路禁用有**两个**触发条件（spec §4.1 步骤 8）——①工作区相对 HEAD 存在包装层 diff；②存在未推送的包装层提交；任一命中即禁用短路（继续走 bump 流程）——「工作区未提交的内容级变更不参与」限定语仅适用于 wrapperPending 取值（规则③判定），**不适用于幂等禁用**，两处语义分开表述]）；PAT 解析顺序 env→credential fill→指引；PAT 解析全链失败（env 缺失且 credential fill 失败）→ 退出码 6（推送失败组——推送环节的前置依赖不可用归推送失败，报告指引配置 PAT）；push 一次性 URL；无匹配 tag → 5；网络失败 → 5；绝不 force push、绝不覆盖 tag；wrapperPending 取值语义：编排内仅以**未推送的包装层提交**作为 wrapperPending=true 的依据——探测序列：先 `git rev-parse --abbrev-ref @{u}` 安全探测 upstream 存在（实测无 upstream/空仓库时 `@{u}` 直接 exit 128 fatal，不得裸跑 `git log @{u}..HEAD`）；探测成功 → 以 `git log @{u}..HEAD` 范围内有涉及包装层文件的提交判定；探测失败 → 走回退分支（无 upstream 时以 `.upstream/last-sync.json` 的 sha 为锚——`git log --oneline | grep <last-sync.sha>`（或等价 rev-parse 判定该 sha 是否为 HEAD 祖先）：是祖先且 HEAD≠该 sha → 存在未推送提交（wrapperPending=true）；HEAD=该 sha → wrapperPending=false）；工作区未提交的内容级变更不参与 wrapperPending 取值（与 spec 规则③「开发者手动执行 bump」对齐——该限定仅约束 wrapperPending 取值，不约束幂等禁用）
- 退出码全集：0/1/2/3/4/5/6/7（spec §4.1 单表）；磁盘预检不足（两段任一）→ 退出码 5（环境失败组）

- [ ] **Step 1: 写失败测试**（全部用 stub deps，无网络）：
  - usage：`--skip-guard` 默认推送 → 1（Review Focus #5）
  - `--skip-guard --no-push` 编排路径下 verify 收到 skipGuard 标记（runVerify 以 `{ skipGuard: true }` 被调用且 warnings 含「guard 未运行」，Task 8 契约联动）
  - verify stub 断言收到 upstream 参数：runVerify 以 `{ skipGuard, upstream: <解压树路径> }` 被调用（漏传 upstream → verify 报 problems（verify-plugin 自身退出码 1）→ **sync 编排映射为退出码 4**——编排接线必须显式传参，stub 断言之；两层退出码见 Task 8 Step 3 注）
  - marketplace 校验豁免时（T11 纯函数 stub 返回豁免）→ 🟡 汇总含豁免 note（staging 步调用点与并入动作均在编排内——Task 11 契约注）
  - 幂等：ref sha 相同 + 树无 diff + 无包装层待发布 → 0 且未跑 guard/verify；有未推送包装层提交 → 不短路
  - 幂等补充①：工作区相对 HEAD 有包装层 diff（未提交）→ **不短路**（spec §4.1 步骤 8 明文防吞场景：未提交包装层变更不得被幂等短路吞掉）
  - 幂等补充②：无 remote 裸仓库（`git rev-parse --abbrev-ref @{u}` exit 128 fatal）→ 走回退分支不崩（T14 首灌场景：空仓库/无 upstream）；并补回退分支取值断言——last-sync.sha=HEAD → wrapperPending=false；last-sync.sha 为 HEAD 祖先且其后另有提交 → wrapperPending=true（锚定取值语义见 Interfaces 回退分支）
  - 幂等补充③：vendorDiff=false 且 wrapperPending=false（no-change）→ 编排出口=无 commit/无 tag、退出 0 并报告 already up to date
  - guard stub 返回 78 → 3；stub python ENOENT → 7（不 --skip-guard）
  - verify stub problems 非空 → 4 且 **vendor 树未变**（断言替换未发生）
  - 结构变化（inject 上游多 skill fixture）→ 2 + sync-report.txt 写入
  - tag 冲突：stub git rev-parse 已存在 → 6 且未 push（前提注明：rev-parse 检测依赖仓库已有 commit，实测空仓库对已存在 tag 也返回 1——fixture 需先创建初始 commit）
  - push 失败 → 6；`--no-push` → 本地 commit+tag、无 push 调用；成功路径断言 sync-report.txt 已写入
  - `--dry-run` → 只报告，无替换/commit/push
  - ref 缺省回退（补前提标志）：上次 last-sync 记录 ref=X，带 `--confirm-structural` 且不传 `--ref` 重跑 → fetchTarball 收到 X（回退仅在「`--confirm-structural` 且未显式传 `--ref`」前提下生效）；对照用例：不带 `--confirm-structural` 重跑不传 `--ref` → 不走 last-sync 回退、正常解析最新 tag（fetchTarball 收到最新 tag 的 ref）
  - `--confirm-structural` 强制走自动路径：结构检测 🔴 存在时不再退 2 → 强制进入自动路径（替换/bump/commit/tag）→ exit 0
  - last-sync.json 写入时机：拉取成功即写 ref/sha（`git checkout` 前落盘）；version 字段于 bump 后更新；结构变化退出码 2 路径也先写 ref/sha（`--confirm-structural` 重跑固定 ref 有值可取）
  - PAT：env 提供 → push URL 含 oauth2: 且不落任何文件；env 缺失且 credential stub 失败 → 退出码 6 且指引配置 PAT
  - 无匹配 tag：ls-remote stub 结果无 `^v?\d+\.\d+\.\d+$` 匹配 → 退出码 5 且错误指引用 `--ref`
  - 网络失败：fetchTarball stub 抛网络错误 → 退出码 5
  - 磁盘两段预检（freeSpace 注入 stub）：启动预检不足 → 退出码 5（下载前拦截）；二次预检不足（拉取后、解压前）→ 退出码 5 且**不解压**（断言解压未发生）
  - 声明未测合集（补测，五条；③落在 Task 8 Step 1 链接用例后，非 T13）：
    - ① `--refresh` 绕过缓存（stub fetchTarball 被调用即使缓存目录存在）
    - ② tag 冲突远端预判（ls-remote stub 结果含同名 tag → 不依赖本地 rev-parse 也拦截 → 6）
    - ③ T8 补「name 非 kebab → problems」fixture 用例（在 Task 8 Step 1，非 T13）
    - ④ staging 清理断言（成功路径末尾 `.skills-staging/` 不存在）
    - ⑤ PAT credential helper 成功路径（env 缺失但 credential stub 返回 PAT → 推送成功且 URL 不含 env 来源标注）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**（编排按 spec 单表顺序；每个退出码路径单一 return；sync-report.txt 写仓库根）
- [ ] **Step 4: 运行通过 + 全套回归**：`node --test tests/`（全部任务测试绿）——保持显式 `tests/` 参数：裸 `node --test` 会扫全 cwd，vendor 树 `scripts/tests/` 含上游 pytest 文件（实测 56 个，虽无 .js/.mjs 不致误收，仍显式指定以防上游未来添加 .mjs 测试）
- [ ] **Step 5: Commit** `feat: sync 编排（双门+自动/人工路径+退出码闭环）`

### Task 14: 首次 bootstrap（真实 vendor + 推送 GitLab + README）

**Files:**
- Modify: `README.md`（完整化）、`package.json`（version `6.7.0` 由首次同步 bump 定版，非手动编辑）
- Test: 手动验证步骤（本任务为交付任务，测试=三个脚本真实运行）

**Interfaces:**
- Consumes: 全部前序任务

- [ ] **Step 1: README 完整化**：安装（`dsh plugin --profile <name> add link:<path>` / GitLab URL）、三工具说明、`.env` 首次使用指引（spec §3.1 布局注释与 §5）、同步脚本用法（含 `--repo/--refresh/--confirm-structural/--skip-guard/--no-push/--dry-run`）、致谢上游与 MIT 归属说明（双 LICENSE）——先于首次同步完成，使首灌 commit/tag 树内已含 README（消除「tag v6.7.0 不含 README/version 定版」问题）
- [ ] **Step 2: 运行首次同步** `node scripts/sync-upstream.mjs --no-push` → 真实拉取 v6.7.0、guard EXIT=0、verify 全绿；首次运行 vendor 基线为空，结构检测 🔴 全量命中属**预期**（退出码 2）→ 按既定人工路径以 `--confirm-structural --no-push` 重跑完成首灌，version=6.7.0（空基线不需要脚本特判）；**定版/commit/tag 随首灌一次完成**：version=6.7.0 由本次同步 bump 产生（package.json 无手动定版，消除定版与 bump 冗余），commit 与 tag `v6.7.0` 一次产生且树内已含 Step 1 的 README（README 变更已在工作树中，随首灌 commit 入库）；首灌的 sync-report.txt 为**首份基线**（其内容在下次运行时被覆盖属预期——「留档」指首灌报告作为人工核对基线用，不是持久归档；如需留存由人工在确认前复制）
- [ ] **Step 3: 三脚本真实验证**：`node scripts/verify-plugin.mjs --upstream .upstream/<ref>@<sha>/…`（真实 78MB 树；`--upstream` 取实际路径——从 `.upstream/last-sync.json` 记录或缓存目录名 `<ref>@<sha>` 拼出；裸跑不传按 T8 缺省语义第⑥项 fail-loud 恒 exit 1，必须显式传）+ `node scripts/check-dsh-compat.mjs`（本机 SDK）全绿；`node -e "import('./index.js')"` 装配无错
- [ ] **Step 4: git 远端配置与单次推送（定版/commit/tag 已由 Step 2 一次完成）**：`git remote add origin <GitLab URL>`（无凭据）；PAT 经 `DSH_PPT_GITLAB_PAT` 环境变量（**用户提供，绝不写入文件**）；`git push origin main --tags`（一次性 URL，**单 tag 单推送**——README/定版已在 tag 树内，无第二次 commit/推送）；验证 GitLab 上 tag `v6.7.0` 存在且指向含 README 与 version=6.7.0 的树
