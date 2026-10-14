# dsh-ppt-master-wrapper 设计文档

- **日期**: 2026-10-14
- **状态**: 已获用户批准（分节呈现，两批均通过）
- **路径**: 本文档位于仓库根 `docs/superpowers/specs/`

## 1. 背景与目标

[hugohe3/ppt-master](https://github.com/hugohe3/ppt-master)（MIT，当前 v6.7.0）是一个 AI 演示文稿生成技能：skill 指挥 agent 运行其 Python 脚本套件，产出原生可编辑 PPTX。它原生面向 Claude Code 生态（`.claude-plugin/`），不能直接被 DeepSeek Harness (DSH) 消费。

已有参考实现 [pn1024/dsh-ppt-master](https://github.com/pn1024/dsh-ppt-master) 把它包装为 DSH 插件，但：

1. 停留在上游 v6.1.0，已过时两个 minor 版本；
2. **没有同步机制**——每次上游更新都要手工复制 13,000+ 文件；
3. 只注册 skill，不提供任何工具。

**本项目**在 `/workspace/ppt-master` 开发 `dsh-ppt-master-wrapper`：

- 把上游 skill 忠实封装为 DSH skill（`ctx.skills.registerProvider`）；
- 提供 3 个生命周期工具（`ctx.tools.register`）；
- 提供一键更新脚本同步上游（默认最新 release tag，支持 `--ref`）；
- 检测结构变化（skill/工具增删、架构变更）时停下报告，人工介入后发新版本；
- git main 分支管理，推送到 `https://gitlab.ai.isv.iridesc.cn:23000/zyx/dsh-ppt-master-wrapper.git`。

### 1.1 已确认的决策（用户逐项批准）

| 决策点 | 结论 |
|---|---|
| 工具范围 | 仅生命周期工具（env 自检/依赖安装/info），工作流由 skill 驱动 |
| 同步来源 | 默认最新 release tag，`--ref` 可指定任意 ref |
| 版本策略 | 镜像上游版本 + `-r` 后缀（包装层变更时递增） |
| 自动化 | 无结构变化时全自动（同步→校验→bump→commit→tag→push）；结构变化时停下等人工 |
| 架构 | 方案 A：忠实 vendor + 零改写（上游文件逐字节原样，完整性门天然通过） |

## 2. 关键上游事实（设计依据）

- skill 本体在 `skills/ppt-master/`：`SKILL.md` + `workflows/` + `references/` + `scripts/`（约 50 个 Python 脚本）+ `templates/`（12,000+ SVG 图标等，共约 78MB）+ 自带 `requirements.txt`（111 行）与 `.env.example`。
- `SKILL.md` 硬规则：宿主注入技能所在目录绝对路径为 `SKILL_DIR`，所有脚本/模板引用 `${SKILL_DIR}/...`。DSH 的 skill provider 通过 `resourceBase: { kind: 'directory', path }` 自动注入 "Base directory for this skill"，**天然满足**该约定。
- `scripts/attribution_guard.py` 是 fail-closed 完整性门：校验 LICENSE 的 SHA256、SKILL.md frontmatter 中 `copyright`/`license`/`official_repository` 的逐字精确值、`LICENSE`/`SPONSORS.md`/`SPONSORS_CN.md` 存在、9 个门文件存在、SKILL.md 中的门标记字符串。**因此任何对上游文件的改写都不可取**（方案 B/C 被排除）。
- 上游根目录 `requirements.txt`（13 行）是技能目录版本的子集；本插件只 vendor `skills/ppt-master/`。

## 3. 插件架构（方案 A：忠实 vendor + 零改写）

### 3.1 仓库布局

```
/workspace/ppt-master/          # 仓库根 = 插件根
├── package.json                # name: dsh-ppt-master-wrapper; version 镜像上游; dsh.bundle.patch
├── cordis.patch.yml            # - insert: [id/name 挂载行]
├── index.js                    # export apply(ctx)：注册 skill provider + 3 个工具
├── lib/
│   ├── skill-provider.js       # ctx.skills.registerProvider
│   └── tools.js                # ctx.tools.register × 3
├── skills/
│   └── ppt-master/             # 上游逐字节 vendor（含 LICENSE/SPONSORS*）
├── scripts/
│   ├── sync-upstream.mjs       # 一键更新
│   ├── verify-plugin.mjs       # 驱动真实 provider 的本地校验
│   └── check-dsh-compat.mjs    # 对照已安装 DSH SDK 的契约检查
├── docs/superpowers/specs/     # 本设计文档
├── .gitignore                  # .env、.upstream/、.skills-staging/、__pycache__/、*.pyc
└── README.md                   # 安装/使用/更新/致谢
```

### 3.2 package.json 要点

- `"name": "dsh-ppt-master-wrapper"`，`"type": "module"`，`"main": "index.js"`；
- `dsh` 字段：`{ engines: { dsh: ">=0.1.1-rc.1" }, bundle: { patch: "./cordis.patch.yml" } }`；
- `engines: { node: ">=20.0.0" }`；
- **零运行时 npm 依赖**；`files` 覆盖 index.js/lib/skills/scripts/cordis.patch.yml/README/LICENSE。
- `exports` 暴露 `.`、`./cordis.patch.yml`、`./package.json`（与参考实现一致）。

### 3.3 cordis.patch.yml

```yaml
- insert:
    - id: dsh-ppt-master-wrapper
      name: dsh-ppt-master-wrapper
```

### 3.4 Skill Provider（lib/skill-provider.js）

- `export const inject = ['skills']`（在 index.js 聚合）；provider 协议 `list(options)` / `get(candidate, options)`，与 `@deepseek-ai/dsh-skill-filesystem` 及 superpowers-dsh 的实现对齐。
- **泛化扫描**：枚举 `skills/` 下每个含 `SKILL.md` 的目录——上游未来增删 skill 目录，provider 代码零改动。
- frontmatter 解析用内置轻量 YAML 解析器（借鉴 pn1024 实现：标量/嵌套对象/数组/`>`与`|` block scalar），校验 `name`（kebab-case）与 `description` 必填，透传 `metadata`（含 version/copyright/license/sponsors）。
- 候选项携带 `resourceBase: { kind: 'directory', path }`、`rank: PACKAGED_SKILL_RANK`（取 550，与 superpowers-dsh 一致，低于本地 bundled root）、`source: 'custom'`、`locator`/`path`。
- `get()` 返回完整定义（content = frontmatter 之后的正文）。

### 3.5 生命周期工具（lib/tools.js）

全部为 DSH 特有资产，不触碰上游文件；描述采用中英双语短句；`execute(args, exec)` 尊重 `exec.signal`；不读取、不回显 `.env` 内容或任何密钥。

| 工具 | 参数 | 行为 |
|---|---|---|
| `ppt_master_info` | 无 | 返回插件版本、包裹的上游版本（解析 vendor SKILL.md metadata）、SKILL_DIR 绝对路径（扫描 `skills/*/SKILL.md` 定位）、上游 repo/release 链接。纯读。 |
| `ppt_master_check_env` | 无 | 检测 python3 ≥3.10；运行 `attribution_guard.py` 并报告通过与否；解析 vendor `requirements.txt` 的顶层发行版名并逐个 `python3 -c "import ..."` 探测；检查 `.env` 是否存在（仅提示）。输出结构化诊断，只读。 |
| `ppt_master_setup_deps` | `user?: boolean`、`breakSystemPackages?: boolean` | 幂等执行 `pip install -r "${SKILL_DIR}/requirements.txt"`（按参数附 `--user` / `--break-system-packages`）；完成后自动复跑环境自检并汇报。**唯一有副作用的工具**。 |

**实现风险与兜底**：`ctx.tools.register` 的输入契约以 `@deepseek-ai/dsh-tools` 的 `defineTool` 产物为准。首选零依赖手写等价定义；若实现期发现不被接受，回退为声明 `@deepseek-ai/dsh-tools` 为 peerDependency 并 import `defineTool`（宿主必带该包）。`check-dsh-compat.mjs` 负责兜底验证。`inject` 是否需要声明 `'tools'` 同样在实现期由 compat 脚本验证。

## 4. 一键更新脚本（scripts/sync-upstream.mjs）

```
用法: node scripts/sync-upstream.mjs [选项]
  --ref <tag|branch|commit>   指定上游 ref（默认：最新语义版本 release tag）
  --confirm-structural        结构变化已人工确认，强制走自动路径
  --skip-guard                跳过 attribution_guard（仅限本地调试；不允许配合推送）
  --no-push                   只本地 commit，不推送
  --dry-run                   只输出将发生的变化
```

### 4.1 流程

1. **解析来源**：`git ls-remote --tags https://github.com/hugohe3/ppt-master.git` 取最高语义版本——仅考虑匹配 `^v?\d+\.\d+\.\d+$` 的 tag（排除 pre-release/rc 与 `^{}` 松散行），`v` 前缀不参与比较；`--ref` 覆盖。
2. **拉取**：下载 `codeload.github.com` tarball → 解压到 `.upstream/<ref>/`（gitignored 缓存；同一 ref 已存在则复用）。
3. **staging**：`skills/ppt-master/**` → `.skills-staging/` 逐字节复制；校验全过之前不动现有树。
4. **完整性门**：对 staging 运行 `python3 .skills-staging/ppt-master/scripts/attribution_guard.py`。fail → 终止；python3 缺失 → 除非 `--skip-guard` 否则终止，且 `--skip-guard` 与推送互斥。
5. **结构变化检测**（当前 vendor 树 vs staging，见 4.2）。
6. **自动路径**（🟢 或已 `--confirm-structural`）：替换 `skills/ppt-master` → 按规则更新 `package.json` version → 运行 `verify-plugin.mjs` → `git add/commit` → `git tag v<version>` → push `main` 与 tag → 清理 staging。
7. **结构变化路径**（🔴 且未确认）：打印中文报告（变化清单 + 对 provider/工具的影响评估 + 后续指引），退出码 2。人工确认后 `--confirm-structural` 重跑。
8. **幂等**：ref 未变且树无 diff → "already up to date"，退出码 0，不产生空提交。

**退出码**：`0` 成功或已是最新；`2` 检测到结构变化待人工确认；`3` 完整性门失败（attribution_guard 非零或 python3 缺失且未 `--skip-guard`）；`4` verify-plugin 校验失败；`5` 网络/拉取失败；`6` 推送失败（本地 commit 保留，可 `--no-push` 重试或手动推送）。

### 4.2 结构变化分类

| 检测项 | 分类 | 理由 |
|---|---|---|
| `skills/` 一级 skill 目录增删 | 🔴 结构变化 | skill 面变化，需人工评估插件可见面 |
| SKILL.md frontmatter `name` 变更 | 🔴 结构变化 | 技能重命名，影响调用方式 |
| workflows/scripts/templates/references 一级条目增删 | 🔴 结构变化 | 架构级变化信号 |
| requirements.txt 依赖行增删 | 🟡 提示 | 需重跑 `ppt_master_setup_deps`（不阻塞自动路径，报告提示） |
| 其余文件内容常规更新 | 🟢 自动 | 纯内容同步 |

### 4.3 版本 bump 规则

- 上游版本变了 → `version = 上游版本`（`-r` 后缀归零；形如 `6.8.0`）；
- 同上游版本但文件有 diff（如 tag 重推） → `-r` +1（`6.7.0-1`）；
- 仅包装层自身变更 → `-r` +1。

上游版本取自 staging `SKILL.md` frontmatter `metadata.version`（与 `.claude-plugin/marketplace.json` 一致性校验，不一致时以 SKILL.md 为准并提示）。

## 5. Git、推送与安全

- 仓库初始化于 `/workspace/ppt-master`，**main 分支**；`origin` = `https://gitlab.ai.isv.iridesc.cn:23000/zyx/dsh-ppt-master-wrapper.git`（**URL 不含任何凭据**）。
- **PAT 解析顺序**（推送时）：环境变量 `DSH_PPT_GITLAB_PAT` → `git credential fill`（系统 credential helper）→ 失败并输出指引。推送使用一次性 URL（`https://oauth2:<PAT>@…`，仅存在于当次进程内存）。**PAT 绝不写入任何被提交的文件、绝不出现在日志与 git 历史中。**
- 首次交付时由开发者会话完成初始 commit/tag/push（PAT 通过环境变量注入）。
- `.gitignore`：`.env`、`.upstream/`、`.skills-staging/`、`__pycache__/`、`*.pyc`、`.mnemon/`。
- 归属：vendor 内 LICENSE/SPONSORS* 逐字节保留；插件 README 显著致谢并链接上游。

## 6. 校验与测试

| 脚本 | 验证内容 | 失败行为 |
|---|---|---|
| `scripts/verify-plugin.mjs` | import index.js + mock ctx 驱动真实 provider：list/get 往返一致、frontmatter 合法（name=目录名、description 非空）、归属文件齐全、LICENSE SHA256 与 vendor 内 `attribution_guard.py` 声明的期望摘要一致（用正则从该脚本解析 `_LICENSE_DIGEST` 常量，Node `crypto` 自算比对——摘要来源是上游自身，随每次同步自动更新，不依赖 Python）、SKILL.md 相对链接全部可解析、`${SKILL_DIR}` 门标记存在 | 非零退出并列出全部问题 |
| `scripts/check-dsh-compat.mjs` | 定位已安装 DSH（`$DSH_HOME` 或参数指定 node_modules）：SkillRegistry 真实挂载 provider 并读回；验证 `ctx.tools.register` 接受工具定义（兜底 3.5 的风险项）；比对 `PACKAGED_SKILL_RANK` 与 SDK 常量 | 非零退出 |
| `scripts/sync-upstream.mjs` 内置 | 每次同步自动运行 verify-plugin + attribution_guard，作为推送前置门 | 阻止 commit/push |

实现期遵循 TDD（细节由实施计划定义）；交付标准：三个脚本全部绿色 + 完成一次真实推送。

## 7. 范围外（YAGNI）

- 不改写任何上游文件（受完整性门约束，也是本设计的立场）；
- 不封装上游 Python 脚本为结构化工具（CLI 非稳定 API，维护成本高，用户已确认放弃）；
- 不做 GitLab CI 配置（verify 脚本可在本地与将来 CI 复用）；
- 不做 npm 发布（内部 GitLab 分发 + `dsh plugin add` 即可）。

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| `ctx.tools.register` 手写定义不被宿主接受 | 回退 peerDependency + `defineTool`；compat 脚本持续验证 |
| 上游完整性门未来收紧（如全树哈希） | 同步脚本的 attribution_guard 前置门会第一时间失败暴露，不会带病推送 |
| vendor 体积（78MB）导致仓库膨胀 | SVG/wav 少变；git 文本压缩良好；staging 全量替换只对变化 blob 产生增量 |
| GitHub 不可达 | 明确报错并支持 `--ref` 指向本地可达镜像 tag |
| PAT 泄露 | 仅环境变量/credential helper 注入；一次性 URL；不落盘不进历史 |
