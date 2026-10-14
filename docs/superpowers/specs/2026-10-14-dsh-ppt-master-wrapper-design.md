# dsh-ppt-master-wrapper 设计文档

- **日期**: 2026-10-14
- **状态**: 已获用户批准（分节呈现，两批均通过）
- **路径**: 本文档位于仓库根 `docs/superpowers/specs/`

## 1. 背景与目标

[hugohe3/ppt-master](https://github.com/hugohe3/ppt-master)（MIT，v6.7.0，核实时点 2026-10-14）是一个 AI 演示文稿生成技能：skill 指挥 agent 运行其 Python 脚本套件，产出原生可编辑 PPTX。它原生面向 Claude Code 生态（`.claude-plugin/`），不能直接被 DeepSeek Harness (DSH) 消费。

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
| 版本策略 | version 镜像上游版本；包装层变更或同版本重同步时追加 `-rN` 后缀 |
| 自动化 | 无结构变化时全自动（同步→校验→bump→commit→tag→push）；结构变化时停下等人工 |
| 架构 | 方案 A：忠实 vendor + 零改写（上游文件逐字节原样，完整性门天然通过） |

## 2. 关键上游事实（设计依据）

- skill 本体在 `skills/ppt-master/`：`SKILL.md` + `workflows/` + `references/` + `scripts/`（实测 301 个 `.py` 脚本）+ `templates/`（12,193 个 SVG 图标、186 个 wav 等，约 64MB；`skills/ppt-master/` 子树合计约 78MB，其中 `scripts/` 约 11MB）+ 自带 `requirements.txt`（111 行）与 `.env.example`。
- `SKILL.md` 硬规则：宿主注入技能所在目录绝对路径为 `SKILL_DIR`，所有脚本/模板引用 `${SKILL_DIR}/...`。DSH 的 skill provider 通过 `resourceBase: { kind: 'directory', path }` 注入文案 "Base directory for this skill: <path>"，由执行 agent 将该路径代入 `${SKILL_DIR}`，**机制等价满足**该约定；上游完整性门不校验注入文案本身。
- `scripts/attribution_guard.py` 是 fail-closed 完整性门：校验 LICENSE 的 SHA256、SKILL.md frontmatter 中 `copyright`/`license`/`official_repository` 的逐字精确值、`LICENSE`/`SPONSORS.md`/`SPONSORS_CN.md` 存在、9 个门文件存在、SKILL.md 中的门标记字符串。**因此任何对上游文件的改写都不可取**（方案 B/C 被排除）。
- 上游根目录 `requirements.txt`（13 行）仅是一行 `-r skills/ppt-master/requirements.txt` include（其余为注释），并非独立依赖清单；本插件只 vendor `skills/ppt-master/`。

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
├── .gitignore                  # .env、.upstream/、.skills-staging/、__pycache__/、*.pyc、.mnemon/（同 §5 清单）
└── README.md                   # 安装/使用/更新/致谢
```

### 3.2 package.json 要点

- `"name": "dsh-ppt-master-wrapper"`，`"type": "module"`，`"main": "index.js"`；
- `version` 镜像上游版本；包装层变更或同版本重同步时追加 `-rN` 后缀（判定规则见 4.3）；
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

设计意图：该 insert 行把插件挂载到宿主 bundle 层（作用于 dsh-base 层之上），后续层（profile 自身 cordis.patch.yml 与 --patch 覆盖）仍可按 id 寻址本行。

### 3.4 Skill Provider（lib/skill-provider.js）

- `export const inject = ['skills']`（在 index.js 聚合）；provider 协议 `list(options)` / `get(candidate, options)`，与 `@deepseek-ai/dsh-skill-filesystem` 及 superpowers-dsh 的实现对齐。
- **泛化扫描**：枚举 `skills/` 下每个含 `SKILL.md` 的目录——上游未来增删 skill 目录，provider 代码零改动。
- **扫描与解析失败契约**：`skills/` 下 dotfile 目录与不含 `SKILL.md` 的目录一律跳过（不进入 provider 可见面）；含 `SKILL.md` 但 frontmatter 缺失、或 `name`/`description` 缺失/不合法 → **fail-loud**（provider 注册时报错中止），不静默跳过。
- frontmatter 解析用内置轻量 YAML 解析器（借鉴 pn1024 实现：标量/嵌套对象/数组/`>`与`|` block scalar），校验 `name`（kebab-case）与 `description` 必填，透传 `metadata`（含 version/copyright/license/sponsors）。
- 候选项携带 `resourceBase: { kind: 'directory', path }`、`rank: PACKAGED_SKILL_RANK`（取 550，与 superpowers-dsh 一致，低于本地 bundled root；跟随策略：550 跟随 superpowers-dsh 本地常量而非 SDK 导出，上游范例变更时人工复核）、`source: 'custom'`、`locator`/`path`。
- `get()` 返回完整定义（content = frontmatter 之后的正文）。

### 3.5 生命周期工具（lib/tools.js）

全部为 DSH 特有资产，不触碰上游文件；描述采用中英双语短句；`execute(args, exec)` 尊重 `exec.signal`；不读取、不回显 `.env` 内容或任何密钥。

| 工具 | 参数 | 行为 |
|---|---|---|
| `ppt_master_info` | 无 | 返回插件版本、包裹的上游版本（解析 vendor SKILL.md metadata）、SKILL_DIR 绝对路径（确定性定位规则：扫描 `skills/*/SKILL.md`，跳过 dotfile，按目录名排序取第一个为主目录；存在多个 skill 目录时返回全部目录并标注主目录）、上游 repo/release 链接。纯读。 |
| `ppt_master_check_env` | 无 | 检测 python3 ≥3.10；运行 `attribution_guard.py` 并报告通过与否；解析 vendor `requirements.txt` 的顶层发行版名，以**查询发行版元数据**（如 `importlib.metadata`）为一等手段探测已安装状态；import 探测仅作辅助，且必须经 dist→import 映射表转换后执行（已知发行版名与 import 名不一致：PyYAML→yaml、Pillow→PIL、python-pptx→pptx 等），映射缺失时该项标记 UNKNOWN（非 FAIL）；检查 `.env` 是否存在（仅提示）。输出结构化诊断，只读。 |
| `ppt_master_setup_deps` | `user?: boolean`、`breakSystemPackages?: boolean` | 幂等执行 `pip install -r "${SKILL_DIR}/requirements.txt"`（按参数附 `--user` / `--break-system-packages`）；完成后自动复跑环境自检并汇报。**唯一有副作用的工具**。 |

**实现风险与兜底**：`ctx.tools.register` 的输入契约以 `@deepseek-ai/dsh-tools` 的 `defineTool` 产物为准。首选零依赖手写等价定义；若实现期发现不被接受，回退为声明 `@deepseek-ai/dsh-tools` 为 peerDependency 并 import `defineTool`（宿主必带该包）。`check-dsh-compat.mjs` 负责兜底验证。`inject` 设计期即定死：index.js 显式声明 `inject = ['skills', 'tools']`；apply 内对 `ctx.tools` 做存在性探测（缺失或不可注册时降级为仅注册 skill provider，并在启动日志声明降级）；compat 脚本持续验证该契约（注：该做法的实装参考证据未独立复核，但与宿主 register 契约一致）。

## 4. 一键更新脚本（scripts/sync-upstream.mjs）

```
用法: node scripts/sync-upstream.mjs [选项]
  --ref <tag|branch|commit>   指定上游 ref（默认：最新语义版本 release tag）
  --refresh                   强制忽略 .upstream/ 缓存重新下载
  --confirm-structural        结构变化已人工确认，强制走自动路径
  --skip-guard                跳过 attribution_guard（仅限本地调试；与推送组合视为 usage 错误直接拒绝；启用时 verify-plugin 输出记录「guard 未运行」标记）
  --no-push                   只本地 commit，不推送
  --dry-run                   只输出将发生的变化
```

### 4.1 流程

1. **解析来源**：`git ls-remote --tags https://github.com/hugohe3/ppt-master.git` 取最高语义版本——仅考虑匹配 `^v?\d+\.\d+\.\d+$` 的 tag（排除 pre-release/rc 与 `^{}` 松散行），`v` 前缀不参与比较；比较算法采用数字元组逐段比较（剥离 `v` 前缀后按 `.` 分段转数字），避免字符串比较把 `6.10.0` 排在 `6.7.0` 之下；`--ref` 覆盖。
2. **拉取**：先将用户/默认解析出的 ref 规范化（构造 codeload URL 前）：tag → `refs/tags/<远端原名>`、branch → `refs/heads/<名>`、40 位 commit sha → 原样；tag 名是否带 `v` 前缀由远端原样驱动（实测无 `v` 前缀 tag 名直接拼装会 404、裸 tag 不稳定，不得拼装猜测形态）。随后下载 `codeload.github.com` tarball → 解压到 `.upstream/<ref>@<sha>/`（gitignored 缓存；缓存键纳入 ref 解析出的 commit sha——来自 `git ls-remote` 结果，同名 tag 重推（sha 变化）时重新下载，sha 不变才复用；`--refresh` 强制忽略缓存重新下载）。
3. **staging**：`skills/ppt-master/**` → `.skills-staging/` 逐字节复制；校验全过之前不动现有树。本阶段基于解压后的 `.upstream/<ref>@<sha>/` 全树执行 `.claude-plugin/marketplace.json` 一致性校验（该文件位于上游仓库根、不在 vendor 子树内；`.upstream/` 缓存用后即弃，vendor 树仍只含 `skills/ppt-master/` 子树）。
4. **完整性门**：对 staging 运行 `python3 .skills-staging/ppt-master/scripts/attribution_guard.py`。guard 非零 → 完整性门判定失败，终止（退出码 3，实测 guard 失败退出码为 78 一类）；python3 不存在或版本过老 → 工具链缺失，除非 `--skip-guard` 否则终止（退出码 7）。`--skip-guard` 与推送组合在启动时即按 usage 错误直接拒绝，不进入流程退出码体系；`--skip-guard` 时 verify-plugin 输出记录「guard 未运行」标记。
5. **结构变化检测**（当前 vendor 树 vs staging，见 4.2）。
6. **自动路径**（🟢 或已 `--confirm-structural`）：先在 staging 树上运行 `verify-plugin.mjs`（**校验前置于替换**，对 staging 路径参数化）→ 全部通过后才替换 `skills/ppt-master` → 按规则更新 `package.json` version → 输出 🟡 提示汇总（若 4.2 检出 🟡 项：依赖变更 → 提醒重跑 `ppt_master_setup_deps`；description 变更 → 知悉提示。🟡 提示不改变退出码 0，仅打印与写入同步报告）→ `git add/commit` → `git tag v<version>` → push `main` 与 tag → 清理 staging。verify-plugin 校验失败**不触碰现有 vendor 树**，退出码 4。
7. **结构变化路径**（🔴 且未确认）：打印中文报告（变化清单 + 对 provider/工具的影响评估 + 后续指引），退出码 2。人工流程顺序：**先**按需人工更新包装层代码并本地 commit，**再**以 `--confirm-structural` 重跑同步走自动路径；版本归属按 4.3 优先级判定——上游版本变化吸收包装层变更，仅包装层单独变更才 `-r` +1。
8. **幂等**：ref 未变且树无 diff → "already up to date"，退出码 0，不产生空提交。

**退出码**（按语义分组）：

- **成功**：`0` 成功或已是最新。
- **流程停止（待人工）**：`2` 检测到结构变化待人工确认。
- **环境失败**：`3` 完整性门判定失败（guard 非零，实测退出码 78 一类）；`4` verify-plugin 校验失败；`5` 网络/拉取失败；`7` 工具链缺失（python3 不存在或版本过老）。
- **推送失败**：`6` 推送失败（本地 commit 保留，可 `--no-push` 重试或手动推送；推送被拒（non-fast-forward）同属退出码 6——指引 `git pull --rebase origin main` 解决后重试；脚本绝不自动 force push）。

附注：`--skip-guard` 与推送组合 → usage 错误直接拒绝（不进入上述流程退出码体系）；`--skip-guard` 时 verify-plugin 输出记录「guard 未运行」标记。

**失败模式速查**：

| 失败模式 | 退出码与处置 |
|---|---|
| guard 判定失败 | 3 |
| 工具链缺失 | 7 |
| verify 失败 | 4（vendor 树未触碰） |
| 网络失败 | 5 |
| 推送失败 / non-fast-forward | 6（本地 commit 保留 / rebase 重试） |
| 结构变化 | 2（人工路径） |

附注：同步全程磁盘占用峰值约 160MB（`.upstream/` 解压全树 + staging 副本），脚本启动时预检可用空间。

### 4.2 结构变化分类

| 检测项 | 分类 | 理由 |
|---|---|---|
| `skills/` 一级 skill 目录增删 | 🔴 结构变化 | skill 面变化，需人工评估插件可见面 |
| SKILL.md frontmatter `name` 变更 | 🔴 结构变化 | 技能重命名，影响调用方式 |
| SKILL.md frontmatter `metadata.version` 缺失或不可解析 | 🔴 结构变化 | 版本 bump 无法执行，需人工确认 |
| workflows/scripts/templates/references 一级条目增删 | 🔴 结构变化 | 架构级变化信号 |
| requirements.txt 依赖行增删 | 🟡 提示 | 需重跑 `ppt_master_setup_deps`（不阻塞自动路径，报告提示） |
| SKILL.md frontmatter `description` 显著变更 | 🟡 提示 | 技能展示/路由描述变化，提示人工知悉（不阻塞自动路径） |
| `skills/` 一级非 skill 辅助目录（无 `SKILL.md`，如 `.claude-plugin/`）增删 | 🟡 提示 | 扫描规则已跳过此类目录，不进入 provider 可见面，仅报告提示 |
| 其余文件内容常规更新 | 🟢 自动 | 纯内容同步 |

注：🔴 表示需人工评估插件可见面，不代表包装层必然需要改代码——§3.4 泛化扫描使多数结构变化无需改码即可被 provider 自动纳入。

### 4.3 版本 bump 规则

版本 bump 按以下优先级**互斥判定**（自上而下，命中即止）：

1. 上游版本变化 → `version = 上游版本`、`-r` 后缀归零（形如 `6.8.0`）；该规则**吸收**其余两条——同版本 diff 与包装层变更不再另行追加 `-r`；
2. 否则，同上游版本但文件有 diff（如 tag 重推） → `-r` +1（`6.7.0-1`）；
3. 否则，仅包装层自身变更 → `-r` +1。

`-rN` 后缀仅供内部追踪，不承诺 semver pre-release 排序语义。

上游版本取自 staging `SKILL.md` frontmatter `metadata.version`；与 `.claude-plugin/marketplace.json` 的一致性校验，数据源为同步流程中解压后的 `.upstream/<ref>@<sha>/` 全树（该文件位于上游仓库根，不在 vendor 子树内）——校验在 staging 阶段执行，`.upstream/` 缓存用后即弃，vendor 树仍只含 `skills/ppt-master/` 子树；不一致时以 SKILL.md 为准并提示。

## 5. Git、推送与安全

- 仓库初始化于 `/workspace/ppt-master`，**main 分支**；`origin` = `https://gitlab.ai.isv.iridesc.cn:23000/zyx/dsh-ppt-master-wrapper.git`（**URL 不含任何凭据**）。
- **PAT 解析顺序**（推送时）：环境变量 `DSH_PPT_GITLAB_PAT` → `git credential fill`（系统 credential helper）→ 失败并输出指引。经 credential helper 路径时 PAT 完全不经由本插件脚本参数/环境，仅在 git 进程内流转，安全边界不变。推送使用一次性 URL（`https://oauth2:<PAT>@…`，仅存在于当次进程内存）。**PAT 绝不写入任何被提交的文件、绝不出现在日志与 git 历史中。**
- **授权边界**：`--confirm-structural` 仅表示人工已确认结构变化，其后的推送授权与自动路径**一致**（仍受 `--no-push` 控制、PAT 解析顺序相同）——结构确认不额外要求推送审批（与 4.1 步骤 7 的人工流程顺序呼应）。
- 首次交付时由开发者会话完成初始 commit/tag/push（PAT 通过环境变量注入）。
- `.gitignore`：`.env`、`.upstream/`、`.skills-staging/`、`__pycache__/`、`*.pyc`、`.mnemon/`。
- 归属：vendor 内 LICENSE/SPONSORS* 逐字节保留；插件 README 显著致谢并链接上游。

## 6. 校验与测试

| 脚本 | 验证内容 | 失败行为 |
|---|---|---|
| `scripts/verify-plugin.mjs` | import index.js + mock ctx 驱动真实 provider：list/get 往返一致、frontmatter 合法（name=目录名、description 非空）、归属文件齐全、LICENSE SHA256 与 vendor 内 `attribution_guard.py` 声明的期望摘要一致（用正则从该脚本解析 `_LICENSE_DIGEST` 常量，Node `crypto` 自算比对——摘要来源是上游自身，随每次同步自动更新，不依赖 Python；**正则无匹配 → 校验失败**，fail-loud 非零退出，不得静默跳过）、SKILL.md 相对链接全部可解析（解析限于 vendor 子树 `skills/ppt-master/` 内；链接目标越出 vendor 子树——如指向上游仓库根的未 vendor 文件——记为**警告并豁免**：上游结构使然，非本插件缺陷，不判失败）、`${SKILL_DIR}` 门标记存在 | 非零退出并列出全部问题 |
| `scripts/check-dsh-compat.mjs` | 定位已安装 DSH，按顺序探测：`--dsh-modules` 参数 > `$DSH_PROFILE_DIR` > `$DSH_HOME/profiles/$DSH_PROFILE/node_modules` > `$DSH_HOME/profiles/node_modules`；找到多个候选 profile 时要求显式指定并列出候选；定位全部失败时报错退出而非静默跳过（注明：superpowers-dsh 同款脚本默认取 `profiles/node_modules`，本环境实际安装于 `profiles/web/node_modules`，默认值选错会校验到错误副本）。定位成功后：SkillRegistry 真实挂载 provider 并读回；验证 `ctx.tools.register` 接受工具定义（兜底 3.5 的风险项）；比对 rank 取值（550）与已装 SDK `BUNDLED_SKILL_RANK`（600）的相对关系（低于本地 bundled root） | 非零退出 |
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
