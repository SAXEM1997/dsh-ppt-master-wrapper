# dsh-ppt-master-wrapper 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把上游 ppt-master v6.7.0 忠实封装为 DSH 插件（1 个 skill provider + 3 个生命周期工具），并提供一键同步/推送 GitLab 的更新脚本。

**Architecture:** 方案 A——上游 `skills/` 经谓词过滤的 skill 目录逐字节 vendor（零改写，attribution_guard 完整性门 + 全量逐字节比对双保险）；包装层零 npm 依赖（Node ≥20 + `node:test`）；同步脚本分层（解析/检测/版本规则/编排，纯函数可测、编排可注入依赖）。

**Tech Stack:** Node.js ≥20（ESM、`node:test`、`node:crypto`、`node:fs/promises`）；Python 3（上游 guard 与 pip，运行时探测）；git（ls-remote/codeload tag/push）。

**Spec:** `docs/superpowers/specs/2026-10-14-dsh-ppt-master-wrapper-design.md`（212 行终态，3 轮审查 + 最终通读 PASS——执行者必须同时读 spec）

## Global Constraints

- 零运行时 npm 依赖：`package.json` 无 `dependencies`/`devDependencies`；测试用内置 `node:test`（spec §3.2）
- 上游文件**逐字节零改写**（方案 A，spec §1.1/§2）：vendor 内容与 `.upstream/` 解压树全量逐字节一致
- `version` 镜像上游 + `-rN` 后缀；无后缀视为 `r0`，新后缀 = 当前 N+1；`-rN` 不承诺 semver pre-release 排序（spec §4.3）
- rank=550、`source: 'custom'`、`resourceBase: {kind:'directory'}`、index.js `inject = ['skills','tools']`（spec §3.4/§3.5）
- PAT 仅经环境变量 `DSH_PPT_GITLAB_PAT` 或 `git credential fill`；一次性 URL 不落盘/不进历史/不回显；**绝不写入任何被提交文件**（spec §5）
- main 分支；origin = `https://gitlab.ai.isv.iridesc.cn:23000/zyx/dsh-ppt-master-wrapper.git`（URL 无凭据）（spec §5）
- `.gitignore`：`.env`、`.upstream/`、`.skills-staging/`、`__pycache__/`、`*.pyc`、`.mnemon/`、`sync-report.txt`（spec §5）
- 完整性门资产不可动：SKILL.md 门标记、frontmatter 逐字精确值（copyright/license/official_repository）、LICENSE/SPONSORS*、9 个门文件（spec §2）
- 测试 fixtures 是**自造 mini 树**，绝不复制上游 78MB 资产进仓库（tests/ 不入 npm `files`）

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

- [ ] **Step 1: 写失败测试** `tests/skeleton.test.mjs`：断言 package.json 解析后 name/零依赖/files 含 LICENSE/exports 含 `./cordis.patch.yml`；cordis.patch.yml 含 `- id: dsh-ppt-master-wrapper` 与 `name:` 行；.gitignore 逐项含七条目；LICENSE 首行含 "MIT License"
- [ ] **Step 2: 运行确认失败** `node --test tests/skeleton.test.mjs` → FAIL（文件不存在）
- [ ] **Step 3: 创建四个文件**——cordis.patch.yml 按 spec §3.3 原文（insert 行）；LICENSE 为本插件自身 MIT（版权行 `dsh-ppt-master-wrapper contributors`，README 将致谢上游）；README.md 仅骨架标题+TODO 指向 spec
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
- [ ] **Step 3: 实现**——借鉴 pn1024 参考实现（`/tmp/ref/dsh-ppt-master/index.js` 的 parseSimpleYaml/findClosingFrontmatter 思路，逐行缩进解析；算法由测试确定）
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat: frontmatter 解析器（标量/嵌套/数组/block scalar）`

### Task 3: Skill Provider（list/get + 失败契约）

**Files:**
- Modify: `lib/skill-provider.js`（追加 provider）
- Test: `tests/skill-provider.test.mjs`、fixture `tests/fixtures/skills-fixture/`（自造：`alpha/SKILL.md` 合法、`beta/` 无 SKILL.md、`.hidden/SKILL.md` dotfile 且含 SKILL.md **应收录**、`broken/SKILL.md` 缺 description）

**Interfaces:**
- Consumes: Task 2 的 `parseFrontmatter`
- Produces: `createSkillProvider(roots?: string[]) → { name, list(options?), get(candidate, options?) }`；候选字段含 `name/description/metadata/invocation{modelInvocable:true,userInvocable:true}/provider/source:'custom'/resourceBase{kind:'directory',path}/rank:550/locator/path`；`get` 返回含 `content`（frontmatter 后正文）；`SKILL_RANK=550` 导出

- [ ] **Step 1: 写失败测试**：fixture 上 `list()` 收录 alpha 与 .hidden、跳过 beta；`get(alpha)` 往返一致且 content 正确；`broken`（含 SKILL.md 但 description 缺失）→ `list()` **throw**（fail-loud）；name 非 kebab-case → throw；`roots` 参数指向 fixture（扫描根注入）；roots 不存在 → throw（空根 fail-loud，spec X21）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——谓词=「`skills/` 一级目录且直接子级存在 `SKILL.md`（无论是否 dotfile）」；dotfile 含 SKILL.md 收录；缺 name/description 或 name 非 kebab → 注册时 throw（spec §3.4 权威谓词与两级判据：仅 name≠目录名为警告级，不在 provider 判定）
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat: skill provider（泛化扫描+fail-loud 契约）`

### Task 4: index.js 装配与能力探测降级

**Files:**
- Create: `index.js`
- Test: `tests/apply.test.mjs`

**Interfaces:**
- Consumes: `createSkillProvider`（Task 3）；Task 5-7 的 `createTools()`（本任务先以空数组占位接口 `createTools() → []`，后续任务填充——或本任务在 createTools 存在后接入，见执行顺序说明：Task 4 的测试用 stub tools 数组验证装配逻辑，Task 7 完成后跑一次全链）
- Produces: `export const name='dsh-ppt-master-wrapper'`、`export const inject=['skills','tools']`、`export function apply(ctx)`——ctx.skills.registerProvider 必存在否则 throw；ctx.tools 存在且 .register 为函数 → 注册 3 工具，否则降级仅注册 provider（日志声明降级）

- [ ] **Step 1: 写失败测试**：mock ctx（skills+tools）→ provider 注册且 tools.register 被调 3 次或以数组注册一次（按实现契约断言）；mock ctx（仅 skills）→ provider 注册、不 throw、有降级日志；apply 幂等性不要求
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**（≤40 行；tools.js 尚未存在时 `import { createTools } from './lib/tools.js'` 先建 `lib/tools.js` 导出空数组 stub，Task 5 起填充）
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat: 插件入口（inject 声明+能力探测降级）`

### Task 5: 工具 ppt_master_info

**Files:**
- Modify: `lib/tools.js`
- Test: `tests/tools-info.test.mjs`（复用 Task 3 fixture + 追加 `zeta/SKILL.md` 制造多目录）

**Interfaces:**
- Produces（`createTools()` 数组第一项）: `{ name:'ppt_master_info', description: 双语短句, parameters:{}, output:{schema:{type:'json'},render}, execute: async (args, exec) => info`；info 对象含 `pluginVersion/upstreamVersion/skillDirs:string[]/primarySkillDir/primarySkillName/repository`；主目录锚定 `ppt-master`（name 匹配；无匹配回退目录名排序第一并标注 `fallback:true`）；SKILL_DIR 定位谓词同 Task 3

- [ ] **Step 1: 写失败测试**：单 skill fixture → primarySkillDir 正确、upstreamVersion 解析自 metadata；双 skill（alpha+zeta）→ primary=zeta 若其 name=ppt-master，否则标注 fallback；无 skill 目录 → throw（fail-loud）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——读 package.json version、扫描定位（复用 provider 谓词逻辑，可从 lib/skill-provider.js 导出 `listSkillDirs(root)` 辅助）
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat: ppt_master_info 工具`

### Task 6: 工具 ppt_master_check_env（依赖探测元数据一等）

**Files:**
- Modify: `lib/tools.js`
- Test: `tests/tools-check-env.test.mjs`、fixture `tests/fixtures/requirements-fixture.txt`（含 PyYAML、python-pptx、skia-pathops、Pillow、flask 等混合）

**Interfaces:**
- Produces: `execute` 返回诊断对象 `{ python: {found, version, meetsSkillRequirement≥3.10 informational}, guard: {ran, exitCode}|{skipped}, deps: [{dist, importName|'UNKNOWN', installed: boolean|'UNKNOWN', source:'metadata'|'import'|'unknown'}], envFileExists: boolean }`；内置 `DIST_TO_IMPORT` 映射表（PyYAML→yaml、Pillow→PIL、python-pptx→pptx、beautifulsoup4→bs4、PyMuPDF→fitz、skia-pathops→pathops、XlsxWriter→xlsxwriter、google-genai→google.genai、edge-tts→edge_tts…）；元数据查询经 `python3 -c "import importlib.metadata..."` 子进程；**不读 .env 内容**
- 纯函数导出（供测试）：`parseRequirements(text) → string[]`（顶层发行版名，剥版本钉扎/extras/注释/`-r` 行）、`mapDistToImport(dist) → string|'UNKNOWN'`

- [ ] **Step 1: 写失败测试**：`parseRequirements` 对 fixture 输出正确发行版名列表；`mapDistToImport('PyYAML')==='yaml'`、`('skia-pathops')==='pathops'`、`('not-a-real-dist')==='UNKNOWN'`；无 python3 环境（stub run 抛 ENOENT）→ python.found=false 且 deps 全 UNKNOWN 而非 FAIL（整体不 throw）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——子进程调用统一经可注入 `exec` 助手（尊重 `exec.signal`）；≥3.10 仅 informational（spec X13：不参与退出码体系）
- [ ] **Step 4: 运行通过**（本机有 python3 时顺带跑一次真实验证但不依赖其存在）
- [ ] **Step 5: Commit** `feat: ppt_master_check_env（元数据一等+映射表+UNKNOWN）`

### Task 7: 工具 ppt_master_setup_deps

**Files:**
- Modify: `lib/tools.js`、`index.js` 无需改（createTools 已接入）
- Test: `tests/tools-setup-deps.test.mjs`

**Interfaces:**
- Produces: `{ name:'ppt_master_setup_deps', parameters:{ user:{type:'boolean'}, breakSystemPackages:{type:'boolean'} }, execute }`——构造 `pip install -r <SKILL_DIR>/requirements.txt`（按参数附 `--user`/`--break-system-packages`）；装完复跑 check_env 逻辑汇报；命令构造为纯函数导出 `buildPipArgs(requirementsPath, opts) → string[]`

- [ ] **Step 1: 写失败测试**：`buildPipArgs` 参数组合 4 例（默认/user/break/both）；execute 在 stub exec 下调用序列=install→check_env
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**（SKILL_DIR 定位复用 Task 5）
- [ ] **Step 4: 运行通过 + 全链验证**：`node --test tests/apply.test.mjs`（Task 4 断言的 3 工具注册现在为真实实现）
- [ ] **Step 5: Commit** `feat: ppt_master_setup_deps（幂等安装+复跑自检）`

### Task 8: verify-plugin.mjs

**Files:**
- Create: `scripts/verify-plugin.mjs`
- Test: `tests/verify-plugin.test.mjs`、fixture `tests/fixtures/mini-vendor/`（自造含 SKILL.md 门标记/LICENSE/SPONSORS×2/9 个门文件占位/requirements/一个 workflows 链接文件/一个越界链接）、fixture `tests/fixtures/mini-upstream/`（=mini-vendor 完整拷贝）

**Interfaces:**
- Consumes: `index.js` apply（真实 provider 驱动）
- Produces: `node scripts/verify-plugin.mjs [--root <dir>] [--upstream <dir>] [--skip-guard-marker note]`；导出纯函数 `normalizedSha256(bytes: Uint8Array) → string`（BOM 拒绝→UTF-8 解码→CRLF/CR→LF→sha256 hex）、`parseExpectedDigest(guardSource: string) → string`（正则 `_LICENSE_DIGEST = "..."`；无匹配 → throw）、`runVerify(root, opts) → { problems: string[], warnings: string[] }`

- [ ] **Step 1: 写失败测试**：
  - `normalizedSha256`：LF 版与 CRLF 版同内容 → 同摘要；带 BOM → throw
  - `parseExpectedDigest`：正常源 → 摘要；无常量 → throw（fail-loud）
  - `runVerify` fixture 全绿：problems 空、warnings 空；list/get 往返（驱动真实 index.js）；mock ctx 断言 3 工具注册（工具面）
  - 篡改用例①：mini-vendor 副本改 LICENSE 一字节 → guard 等价清单拦截（digest 不匹配）
  - 篡改用例②：改某非门文件 1 字节 + `--upstream` 指向干净树 → **全量逐字节比对拦截**（Review Focus #6）
  - frontmatter 两级：name≠目录名 → warnings 含之不进 problems；name 缺失 → problems
  - 链接：越界链接（`../../../docs/x.md`）→ warnings；子树内死链 → problems
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——检查清单=spec §6 verify 行逐项（①归一化摘要取**被验目标树**内 guard 的期望值 ②frontmatter 逐字精确值三键 ③归属文件 ④9 门文件 ⑤门标记计数 ⑥全量比对 ⑦链接 ⑧门标记存在 ⑨3 工具注册）；problems 非空 → exit 1 列出全部
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat: verify-plugin（guard 逐项等价+全量比对+两级判据）`

### Task 9: check-dsh-compat.mjs

**Files:**
- Create: `scripts/check-dsh-compat.mjs`
- Test: `tests/compat.test.mjs`

**Interfaces:**
- Produces: 导出 `resolveDshModules(explicit?: string, env: object) → { path: string, via: string }`（顺序：参数 > `$DSH_NODE_MODULES` > `$DSH_PROFILE_DIR` > `$DSH_HOME/profiles/$DSH_PROFILE/node_modules` > `$DSH_HOME/profiles/node_modules`；多候选 → 报错列出候选并退出；全失败 → 报错退出）；`node scripts/check-dsh-compat.mjs [modulesDir]` 主流程：定位→动态 import dsh-skill SkillRegistry 挂载 provider 读回→验证 ToolRuntime register 接受手写工具定义（缺 `output` 会 TypeError 的契约核实）→ rank 550 < BUNDLED_SKILL_RANK 600 相对关系→读回 superpowers-dsh 实际常量比对（漂移告警）

- [ ] **Step 1: 写失败测试**：`resolveDshModules` 用 fake env 五级优先级逐一断言；多候选（两个 profile 目录均存在，tmp 构造）→ throw 列出；env 无 DSH_HOME → throw
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**（本机 `$DSH_PROFILE_DIR=/dsh-home/profiles/web` 真实可跑，作为 Step 4 验证）
- [ ] **Step 4: 运行通过 + 真实环境 smoke**：`node scripts/check-dsh-compat.mjs` → 本机真实 SDK 上全绿
- [ ] **Step 5: Commit** `feat: check-dsh-compat（五级定位+契约+rank 漂移检出）`

### Task 10: sync 解析层（repo/ref/tag/缓存/预检）

**Files:**
- Create: `scripts/sync-upstream.mjs`（本任务：参数解析 + 纯函数层；`main` 占位）
- Test: `tests/sync-parse.test.mjs`

**Interfaces:**
- Produces 纯函数导出：
  - `parseArgs(argv) → Options{repo?, ref?, refresh?, confirmStructural?, skipGuard?, noPush?, dryRun?}`（非法组合 `--skip-guard` 未与 `--no-push`/`--dry-run` 联用 → `{ usageError: true }`）
  - `parseLsRemote(text) → Array<{sha, ref, tagName?}>`（剥 `^{}` 松散行成对逻辑单独返回 annotated 映射）
  - `pickLatestTag(entries) → { name, sha } | null`（`^v?\d+\.\d+\.\d+$` 过滤 + 数字元组逐段比较；null=无匹配）
  - `normalizeRef(ref) → string`（tag→`refs/tags/<远端原名>`、branch→`refs/heads/`、40 位 sha 原样；**不得产生 `refs/tags/refs/tags/…`**）
  - `buildCodeloadUrl(repo, normalizedRef) → string`
  - `cacheKey(ref, sha) → string`（`<ref>@<sha>`；sha 取该 tag 的 `^{}` 行 commit sha，否则 tag 行）
  - `diskBudget(tarballBytes?) → number`（无参=启动保守 260MB；有参=实际三项和）
- 状态文件契约：`.upstream/last-sync.json` `{ref, sha, version, at}` 读写助手

- [ ] **Step 1: 写失败测试**：ls-remote fixture（含 v2.13.0 在 v2.2.0 之前的无序输出 + `^{}` 行）→ pickLatest 正确取 v2.13.0；`6.7.0`（无 v）normalize 后 URL 为 `refs/tags/6.7.0` 形态；tag 重推 sha 变 → cacheKey 不同（Review Focus #4）；`parseArgs(['--skip-guard'])` → usageError；`parseArgs(['--skip-guard','--no-push'])` → 合法；diskBudget(50969212) ≈ 114MB+78MB+50MB 量级
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat: sync 解析层（tag 元组比较/ref 规范化/缓存键/usage 校验）`

### Task 11: sync 检测层（staging 复制/结构分类/marketplace 校验）

**Files:**
- Modify: `scripts/sync-upstream.mjs`（追加）
- Test: `tests/sync-detect.test.mjs`、fixtures `tests/fixtures/upstream-tree/`（多 skill：`skills/ppt-master/` mini + `skills/second-skill/SKILL.md` + `skills/.claude-plugin/plugin.json` + 根 `.claude-plugin/marketplace.json`）与 `tests/fixtures/vendor-tree/`（仅旧版 ppt-master）

**Interfaces:**
- Produces: `stageSkills(upstreamRoot, stagingRoot) → string[]`（复制源=谓词过滤的全部 skill 目录；**不进入** staging：`skills/` 一级不含 SKILL.md 的目录）；`classifyChanges(vendorSkillsRoot, stagingRoot, upstreamRoot) → { red: Change[], yellow: Change[], green: boolean, hasVendorDiff }`（Change 含 `kind`（skill-dir/name/metadata.version/top-level-entries/requirements/description/aux-dir）、`detail`；数据源：vendor vs staging 为主、辅助目录与 marketplace 用 `.upstream` 全树）；`checkMarketplaceVersion(upstreamRoot, skillVersion) → { ok: boolean, note }`（文件缺失 → `{ok:true, note:'豁免'}` 警告语义）

- [ ] **Step 1: 写失败测试**：
  - fixture 上游比 vendor 多 `second-skill` → **red 含 skill-dir 变更**（Review Focus #3）
  - `skills/.claude-plugin/` 存在 → staging **不包含**它；classify 的 yellow 含 aux-dir（数据源=upstream 全树）
  - SKILL.md name 变更 → red(kind=name)；metadata.version 缺失 → red；description 变更 → yellow；requirements 行增删 → yellow；仅正文文件变更 → green 路径
  - marketplace.json version 与 skillVersion 不一致 → ok:false；文件缺失 → 豁免
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

- [ ] **Step 1: 写失败测试**：六分支 + 边界（current=`6.7.0-r3` 上游升 `6.8.0` → `6.8.0` + 归零 note；current=`6.7.0` 同版本 tag 重推 diff → `6.7.0-r1`；`6.7.0-r1` 再重推 → `6.7.0-r2`；docs-only → no-change；②③同时命中按②）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**（优先级互斥、命中即止）
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** `feat: sync 版本规则（①④②③互斥+r0 基数+归零观测）`

### Task 13: sync 流程编排（门/verify 前置/替换/tag/幂等/push/退出码）

**Files:**
- Modify: `scripts/sync-upstream.mjs`（`main(options, deps?)`——deps 可注入 `{ fetchTarball, runGit, runPython, now }` 供测试）
- Test: `tests/sync-orchestrate.test.mjs`

**Interfaces:**
- Consumes: Task 10-12 全部纯函数；`scripts/verify-plugin.mjs` 的 `runVerify`
- Produces: `main(options, deps) → Promise<number>`（退出码）；编排序列=spec §4.1 步骤 1-8（解析→拉取[缓存键/两段预检]→staging[marketplace 校验]→guard[逐 skill；3/7 细则：解释器级=7、guard 业务=3]→结构检测→自动路径[verify 前置 staging→替换 skill 面→bump→🟡 汇总→commit→tag 先行检测映射 6→push]→结构路径[报告+sync-report.txt 落盘，码 2]→幂等[范围=vendor+包装层待发布；短路前 ref sha 先比]）；PAT 解析顺序 env→credential fill→指引；push 一次性 URL；无匹配 tag → 5；网络失败 → 5；绝不 force push、绝不覆盖 tag
- 退出码全集：0/1/2/3/4/5/6/7（spec §4.1 单表）

- [ ] **Step 1: 写失败测试**（全部用 stub deps，无网络）：
  - usage：`--skip-guard` 默认推送 → 1（Review Focus #5）
  - 幂等：ref sha 相同 + 树无 diff + 无包装层待发布 → 0 且未跑 guard/verify；有未推送包装层提交 → 不短路
  - guard stub 返回 78 → 3；stub python ENOENT → 7（不 --skip-guard）
  - verify stub problems 非空 → 4 且 **vendor 树未变**（断言替换未发生）
  - 结构变化（inject 上游多 skill fixture）→ 2 + sync-report.txt 写入
  - tag 冲突：stub git rev-parse 已存在 → 6 且未 push
  - push 失败 → 6；`--no-push` → 本地 commit+tag、无 push 调用
  - `--dry-run` → 只报告，无替换/commit/push
  - PAT：env 提供 → push URL 含 oauth2: 且不落任何文件；env 缺失且 credential stub 失败 → 指引错误（不崩）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**（编排按 spec 单表顺序；每个退出码路径单一 return；sync-report.txt 写仓库根）
- [ ] **Step 4: 运行通过 + 全套回归**：`node --test tests/`（全部任务测试绿）
- [ ] **Step 5: Commit** `feat: sync 编排（双门+自动/人工路径+退出码闭环）`

### Task 14: 首次 bootstrap（真实 vendor + 推送 GitLab + README）

**Files:**
- Modify: `README.md`（完整化）、`package.json`（version 定 `6.7.0`）
- Test: 手动验证步骤（本任务为交付任务，测试=三个脚本真实运行）

**Interfaces:**
- Consumes: 全部前序任务

- [ ] **Step 1: 运行首次同步** `node scripts/sync-upstream.mjs --no-push` → 真实拉取 v6.7.0、guard EXIT=0、verify 全绿；首次运行 vendor 基线为空，结构检测 🔴 全量命中属**预期**（退出码 2）→ 按既定人工路径以 `--confirm-structural --no-push` 重跑完成首灌，version=6.7.0（空基线不需要脚本特判）
- [ ] **Step 2: 三脚本真实验证**：`node scripts/verify-plugin.mjs`（真实 78MB 树）+ `node scripts/check-dsh-compat.mjs`（本机 SDK）全绿；`node -e "import('./index.js')"` 装配无错
- [ ] **Step 3: README 完整化**：安装（`dsh plugin --profile <name> add link:<path>` / GitLab URL）、三工具说明、`.env` 首次使用指引（spec R11）、同步脚本用法（含 `--repo/--refresh/--confirm-structural/--skip-guard/--no-push/--dry-run`）、致谢上游与 MIT 归属说明（双 LICENSE）
- [ ] **Step 4: git 远端配置与推送**：`git remote add origin <GitLab URL>`（无凭据）；PAT 经 `DSH_PPT_GITLAB_PAT` 环境变量（**用户提供，绝不写入文件**）；`git push origin main --tags`（一次性 URL）；验证 GitLab 上 tag `v6.7.0` 存在
- [ ] **Step 5: Commit** `feat: 首次 bootstrap（vendor v6.7.0 + README + 定版）` 并推送
