# dsh-ppt-master-wrapper 设计文档

- **日期**: 2026-10-14
- **状态**: 已获用户批准（分节呈现，两批均通过）
- **路径**: 本文档位于仓库根 `docs/superpowers/specs/`

## 1. 背景与目标

[hugohe3/ppt-master](https://github.com/hugohe3/ppt-master)（MIT，v6.7.0，核实时点 2026-10-14）是一个 AI 演示文稿生成技能：skill 指挥 agent 运行其 Python 脚本套件，产出原生可编辑 PPTX。它原生面向 Claude Code 生态（`.claude-plugin/`），不能直接被 DeepSeek Harness (DSH) 消费。

已有参考实现 [pn1024/dsh-ppt-master](https://github.com/pn1024/dsh-ppt-master) 把它包装为 DSH 插件，但：

1. 停留在上游 v6.1.0，已落后 6 个 minor 版本（6.1.0→6.7.0）；
2. **没有同步机制**——每次上游更新都要手工复制 13,000+ 文件；
3. 只注册 skill，不提供任何工具。

**本项目**在 `/workspace/ppt-master` 开发 `dsh-ppt-master-wrapper`：

- 把上游 skill 忠实封装为 DSH skill（`ctx.skills.registerProvider`）；
- 提供 3 个生命周期工具（`ctx.tools.register`）；
- 提供一键更新脚本同步上游（默认最新 release tag，支持 `--ref`）；
- 检测结构变化（skill/工具增删、架构变更）时停下报告，人工介入后发新版本；
- git main 分支管理，推送到 `https://github.com/SAXEM1997/dsh-ppt-master-wrapper.git`（公开主地址）。

### 1.1 已确认的决策（用户逐项批准）

| 决策点 | 结论 |
|---|---|
| 工具范围 | 仅生命周期工具（env 自检/依赖安装/info），工作流由 skill 驱动 |
| 同步来源 | 默认最新 release tag，`--ref` 可指定任意 ref |
| 版本策略 | version 镜像上游版本；包装层变更或同版本重同步时追加 `-rN` 后缀（如 `6.7.0` → `6.7.0-r1`） |
| 自动化 | 无结构变化时全自动（同步→校验→bump→commit→tag→push）；结构变化时停下等人工 |
| 架构 | 方案 A：忠实 vendor + 零改写（上游文件逐字节原样，完整性门天然通过） |

## 2. 关键上游事实（设计依据）

- skill 本体在 `skills/ppt-master/`：`SKILL.md` + `workflows/` + `references/` + `scripts/`（实测 301 个 `.py` 脚本）+ `templates/`（12,167 个 SVG 图标、186 个 wav 等，约 64MB；`skills/ppt-master/` 子树合计约 78MB，其中 `scripts/` 约 11MB）+ 自带 `requirements.txt`（111 行）与 `.env.example`。
- `SKILL.md` 硬规则：宿主注入技能所在目录绝对路径为 `SKILL_DIR`，所有脚本/模板引用 `${SKILL_DIR}/...`。DSH 的 skill provider 通过 `resourceBase: { kind: 'directory', path }` 注入文案 "Base directory for this skill: <path>"，由执行 agent 将该路径代入 `${SKILL_DIR}`，**机制等价满足**该约定；上游完整性门不校验注入文案本身。
- `scripts/attribution_guard.py` 是 fail-closed 完整性门：校验 LICENSE 的 SHA256、SKILL.md frontmatter 中 `copyright`/`license`/`official_repository` 的逐字精确值、`LICENSE`/`SPONSORS.md`/`SPONSORS_CN.md` 存在、9 个门文件存在、SKILL.md 中的门标记字符串。**因此任何对上游文件的改写都不可取**（方案 B/C 被排除）。守卫面为固定清单（metadata 精确值/LICENSE 摘要/门文件/标记），其余文件的完整性依赖 vendor 逐字节复制纪律与 §6 的全量比对，而非 guard 本身。
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
├── .gitignore                  # .env、.upstream/、.skills-staging/、sync-report.txt、__pycache__/、*.pyc、.mnemon/、.superpowers/（同 §5 清单）
├── LICENSE                     # 插件自身 MIT 许可（vendor 内另有上游原文 LICENSE，见 §3.2 归属说明）
└── README.md                   # 安装/使用/更新/致谢；说明用户首次使用时从 vendor skills/ppt-master/.env.example 复制为工作区 .env 并按需填写图像后端 API key（.env 已入 .gitignore，见 §5）
```

### 3.2 package.json 要点

- `"name": "dsh-ppt-master-wrapper"`，`"type": "module"`，`"main": "index.js"`；
- `version` 镜像上游版本；包装层变更或同版本重同步时追加 `-rN` 后缀（判定规则见 4.3；如 `6.7.0` → `6.7.0-r1`）；
- `dsh` 字段：`{ engines: { dsh: ">=0.1.1-rc.1" }, bundle: { patch: "./cordis.patch.yml" } }`；
- `engines: { node: ">=20.0.0" }`；
- **零运行时 npm 依赖**；`files` 覆盖 index.js/lib/skills/scripts/cordis.patch.yml/README.md/LICENSE。
- 归属说明：插件根 `LICENSE` 为本插件自身 MIT 许可（README 致谢上游）；vendor `skills/ppt-master/LICENSE` 为上游原文，两者独立共存（同 pn1024 参考实现做法）。
- `exports` 暴露 `.`、`./cordis.patch.yml`、`./package.json`（与参考实现一致）。

### 3.3 cordis.patch.yml

```yaml
- insert:
    - id: dsh-ppt-master-wrapper
      name: dsh-ppt-master-wrapper
```

设计意图：该 insert 行把插件挂载到宿主 bundle 层（作用于 dsh-base 层之上），后续层（profile 自身 cordis.patch.yml 与 --patch 覆盖）仍可按 id 寻址本行。

### 3.4 Skill Provider（lib/skill-provider.js）

- provider 模块不声明 inject；index.js 统一 `export const inject = ['skills', 'tools']`（见 §3.5）。provider 协议 `list(options)` / `get(candidate, options)`，与 `@deepseek-ai/dsh-skill-filesystem` 及 superpowers-dsh 的实现对齐。
- **泛化扫描**：枚举 `skills/` 下每个含 `SKILL.md` 的目录——上游未来增删 skill 目录，provider 代码零改动；扫描根以构造参数注入（provider 工厂函数接受可选 roots 参数，默认取包内 `skills/`；verify-plugin 以 staging 路径参数化驱动时重定向扫描根，与 §4.1 步骤 6 / §6 呼应）；注入的根不存在或为空 → fail-loud 报错（verify-plugin 依赖此契约对 staging 复现 provider 行为）。
- **扫描与解析失败契约**：`skills/` 下**不含 `SKILL.md` 的目录（无论是否 dotfile）**一律跳过（不进入 provider 可见面）；含 `SKILL.md` 但 frontmatter 缺失、或 `name` 缺失/非 kebab-case、或 `description` 缺失 → **fail-loud**（provider 注册时报错中止；与 §6 verify 两级判据一致——`name` 与目录名不一致为警告级、不中止），不静默跳过。
- frontmatter 解析用内置轻量 YAML 解析器（解析能力——嵌套对象/数组/`>`与`|` block scalar——以 **pn1024 实现**为基准：上游 SKILL.md 的 `metadata:` 嵌套与 `description: >` block scalar 需要它；superpowers-dsh 仅作 provider 协议参考，其解析器只处理标量，不满足本需求），校验 `name`（kebab-case）与 `description` 必填，透传 `metadata`（含 version/copyright/license/sponsors）。
- 候选项携带 `resourceBase: { kind: 'directory', path }`、`rank: PACKAGED_SKILL_RANK`（取 550，与 superpowers-dsh 一致，低于本地 bundled root；跟随策略：550 跟随 superpowers-dsh 本地常量而非 SDK 导出，上游范例变更时人工复核）、`source: 'custom'`、`locator`/`path`。
- `get()` 返回完整定义（content = frontmatter 之后的正文）。

### 3.5 生命周期工具（lib/tools.js）

全部为 DSH 特有资产，不触碰上游文件；描述采用中英双语短句；`execute(args, exec)` 尊重 `exec.signal`；不读取、不回显 `.env` 内容或任何密钥。

| 工具 | 参数 | 行为 |
|---|---|---|
| `ppt_master_info` | 无 | 返回插件版本、包裹的上游版本（解析 vendor SKILL.md metadata）、SKILL_DIR 绝对路径（确定性定位规则：扫描 `skills/*/SKILL.md`，跳过不含 `SKILL.md` 的目录（无论是否 dotfile，与 §3.4 权威谓词一致），主目录锚定 `ppt-master`（按 name/metadata 匹配本体 skill；若无匹配则回退目录名排序第一并标注）；存在多个 skill 目录时返回全部目录并标注主目录）、上游 repo 链接。纯读。 |
| `ppt_master_check_env` | 无 | 检测 python3 ≥3.10（该版本线是上游 skill 套件的就绪度要求，属本工具探测项并单独报告；退出码 7 判据**不做版本号嗅探**、仅看 guard 能否运行成功——python3 过老导致 guard 无法运行时自然落入退出码 7，与本探测项互不替代）；运行 `attribution_guard.py` 并报告通过与否；解析 vendor `requirements.txt` 的顶层发行版名，以**查询发行版元数据**（如 `importlib.metadata`）为一等手段探测已安装状态；import 探测仅作辅助，且必须经 dist→import 映射表转换后执行（已知发行版名与 import 名不一致：PyYAML→yaml、Pillow→PIL、python-pptx→pptx 等），映射缺失时该项标记 UNKNOWN（非 FAIL）；检查 `.env` 是否存在（仅提示）。注：同步流程不校验 python3 版本——低版本 python3 下 guard 大概率仍可运行（纯标准库），版本就绪度由 check_env 在使用期报告。输出结构化诊断，只读。 |
| `ppt_master_setup_deps` | `user?: boolean`、`breakSystemPackages?: boolean` | 幂等执行 `pip3 install -r "${SKILL_DIR}/requirements.txt"`（按参数附 `--user` / `--break-system-packages`）；完成后自动复跑环境自检并汇报。**唯一有副作用的工具**。 |

**实现风险与兜底**：`ctx.tools.register` 的输入契约以 `@deepseek-ai/dsh-tools` 的 `defineTool` 产物为准。首选零依赖手写等价定义；若实现期发现不被接受，回退为声明 `@deepseek-ai/dsh-tools` 为 peerDependency 并 import `defineTool`（宿主必带该包）。`check-dsh-compat.mjs` 负责兜底验证。`inject` 设计期即定死：index.js 显式声明 `inject = ['skills', 'tools']`；apply 内对 `ctx.tools` 做存在性探测（缺失或不可注册时降级为仅注册 skill provider，并在启动日志声明降级）；compat 脚本持续验证该契约（注：该做法的实装参考证据未独立复核，但与宿主 register 契约一致）。

## 4. 一键更新脚本（scripts/sync-upstream.mjs）

```
用法: node scripts/sync-upstream.mjs [选项]
  --ref <tag|branch|commit>   指定上游 ref（默认：最新语义版本 release tag）
  --repo <url>                上游仓库 URL（默认：https://github.com/hugohe3/ppt-master.git；同步源与 ls-remote/codeload 均取此值）
  --refresh                   强制忽略 .upstream/ 缓存重新下载
  --confirm-structural        结构变化已人工确认，强制走自动路径
  --skip-guard                跳过步骤 4 attribution_guard 的执行（省一次 guard 运行、免 python 依赖；verify-plugin 的 JS 等价校验（digest/metadata/归属文件）仍会拦截，不构成完整性放行）。真实用途：python3 缺失时的本地调试同步路径（配合 --no-push --skip-guard，verify 的 JS 校验不依赖 python）。联用约束：须至少与 --no-push 或 --dry-run 之一联用；只要该次运行最终会执行推送（含默认推送）即属非法组合，usage 错误（退出码 1）
  --no-push                   只本地 commit，不推送
  --dry-run                   只输出将发生的变化
```

### 4.1 流程

1. **解析来源**：`git ls-remote --tags <repo>`（`<repo>` 取 `--repo` 值，默认 `https://github.com/hugohe3/ppt-master.git`）取最高语义版本——仅考虑匹配 `^v?\d+\.\d+\.\d+$` 的 tag（排除 pre-release/rc 与 `^{}` 松散行），`v` 前缀不参与比较；比较算法采用数字元组逐段比较（剥离 `v` 前缀后按 `.` 分段转数字），避免字符串比较把 `6.10.0` 排在 `6.7.0` 之下；`--ref` 覆盖。**tag 提取规则**：从 `ls-remote --tags` 行取 `refs/tags/` 之后的部分为「远端原名」（如 `v6.7.0`），步骤 2 拼装时按该原名构造 `refs/tags/<远端原名>`（避免 `refs/tags/refs/tags/…` 双前缀）。**缓存键 sha 取行规则**：取该 tag 的 `^{}` 行（存在时——annotated tag 指向的 commit sha），否则取 tag 行本身；防御性支持 annotated 与 lightweight 两种 tag 形态（本地克隆仅观察到 lightweight，不假设上游永远如此）。**无匹配 release tag**：仓库无 `^v?\d+\.\d+\.\d+$` 形态 tag（`ls-remote --tags` 无任何匹配行）→ 报错退出（归入退出码 5 网络/来源失败；报告「上游无可用 release tag」，指引用 `--ref` 显式指定）。
2. **拉取**：先将用户/默认解析出的 ref 规范化（构造 codeload URL 前）：tag → `refs/tags/<远端原名>`、branch → `refs/heads/<名>`、40 位 commit sha → 原样；tag 名是否带 `v` 前缀由远端原样驱动（实测无 `v` 前缀 tag 名直接拼装会 404、裸 tag 不稳定，不得拼装猜测形态）。随后下载 codeload tarball（codeload URL 由同一 `--repo` 值推导，ls-remote 与 codeload 同源取值）→ 解压到 `.upstream/<ref>@<sha>/`（gitignored 缓存；缓存键纳入 ref 解析出的 commit sha——来自 `git ls-remote` 结果，同名 tag 重推（sha 变化）时重新下载，sha 不变才复用；`--refresh` 强制忽略缓存重新下载）。`.upstream/` 生命周期为**可留存缓存**（gitignored、跨次复用、`--refresh` 强刷）；其下置轻量状态文件 `.upstream/last-sync.json`（记录上次同步的 `ref`、`sha`、`version`、`head` 与 `at`），供步骤 8 幂等 ref 比对与步骤 7 `--confirm-structural` 重跑时固定 ref 使用。**字段语义**：`ref`/`sha`/`version` 分别为上次同步的规范化 ref、上游 commit sha（缓存键）与写入时的 `package.json` version；`head`（可选字符串）为**包装层 HEAD 基线**——无 `@{u}` 回退分支下 `wrapperPending` 判定的锚点（待发布 = `anchor..HEAD` 区间内涉及包装层文件的提交；`head` 缺失时视作 false，即无已发布基线）；`at` 为写入时刻的 ISO 时间戳（仅记录写入时间，不参与任何判定）。同目录另置 `.upstream/last-aux-dirs.json`（结构 `{"auxDirs":[...]}`）：§4.2 行 7 aux-dir 🟡 的**上次记录基准**，用于比对上游 `skills/` 一级辅助目录增删；该记录丢失（首灌或缓存被清）时下次同步将当前全部辅助目录重报为新增（🟡 知悉，不阻塞自动路径；`--dry-run` 下只分类不写盘，不消费该一次性信号）。
3. **staging**：复制源为上游 `skills/` 下每个含 `SKILL.md` 的目录（一级目录且直接子级存在 `SKILL.md`，dotfile 同判——§3.4 权威谓词），逐字节复制到 `.skills-staging/`；`skills/` 一级不含 `SKILL.md` 的目录（如 `skills/.claude-plugin/`——Claude 插件清单 plugin.json，DSH 不消费，完整性门不要求）不进入 staging；校验全过之前不动现有树。本阶段基于解压后的 `.upstream/<ref>@<sha>/` 全树执行上游仓库根 `.claude-plugin/marketplace.json` 一致性校验（该文件位于上游仓库根、不在 vendor 子树内，与 staging 丢弃对象 `skills/.claude-plugin/plugin.json` 是两个不同路径，不得共用一个称谓；上游未来删除/移动该文件时记警告并豁免该子校验——同 §6 链接越界豁免逻辑，不判失败；`.upstream/` 缓存不向仓库分发（gitignored 缓存，跨次复用），vendor 树仍只含 `skills/` 下的 skill 目录面、不含上游仓库根文件）。
4. **完整性门**：以 staging 根为基准，对其下**每个** skill 目录运行该目录自带的 guard：`python3 .skills-staging/<skill>/scripts/attribution_guard.py`（逐目录执行；当前上游仅 `ppt-master` 一个 skill，实际即单次运行）。**退出码 3/7 判定细则**：解释器级失败（python3 不存在、spawn 失败、语法错误类崩溃）判 7（工具链缺失）；guard 业务判定失败（guard 自身完整运行后返回非零，实测退出码 78 一类）判 3。任一 guard 非零 → 完整性门判定失败，终止（退出码 3）；python3 不存在或无法运行 guard 脚本等解释器级失败 → 工具链缺失，除非 `--skip-guard` 否则终止（退出码 7；guard 实测纯标准库，python3 ≥3.10 是上游 skill 套件的就绪度要求，属 check_env 探测项、不参与退出码 7 判定，见 §3.5）。
5. **结构变化检测**（当前 vendor 树 vs staging，见 4.2）。
6. **自动路径**（🟢 或已 `--confirm-structural`）：先在 staging 树上运行 `verify-plugin.mjs`（**校验前置于替换**，对 staging 路径参数化；其内含与 guard 等价的完整性校验，职责见 §6；guard 与 verify 各跑一次，不重复执行 guard）→ 全部通过后才以 staging 替换 vendor `skills/` 的整个 skill 面（全部含 `SKILL.md` 的目录）→ 按规则更新 `package.json` version → 输出 🟡 提示汇总（若 4.2 检出 🟡 项：依赖变更 → 提醒重跑 `ppt_master_setup_deps`；description 变更 → 知悉提示；辅助目录增删（§4.2 行 7）→ 知悉提示。🟡 提示不改变退出码 0，仅打印与写入同步报告；同步报告落盘为仓库根 `sync-report.txt`（gitignored 不入库，见 §5 清单；每次运行覆盖上一次报告），同时打印到 stdout）→ `git add/commit` → `git tag v<version>`（创建 tag 前**先行检测**冲突：本地 `git rev-parse -q --verify refs/tags/<version>`、远端从 ls-remote 结果预判；tag 已存在——如 `--ref` 回滚到旧版本重同步——→ fail-loud 报错退出，由该先行检测直接映射退出码 6，不依赖 git 原始退出码 128；`--no-push` 在本环节仍创建本地 tag，只是不推送；tag 冲突的指引为人工处理：拒绝回滚同步，或人工评估后改版本号——「可 `--no-push` 重试」仅适用于远端推送被拒场景，不适用于 tag 冲突；绝不覆盖已有 tag）→ push `main` 与 tag → 清理 staging。verify-plugin 校验失败**不触碰现有 vendor 树**，退出码 4。
7. **结构变化路径**（🔴 且未确认）：打印中文报告（变化清单 + 🟡 提示清单（若同批次检出 🟡 项）+ 对 provider/工具的影响评估 + 后续指引），结构变化报告同时写入仓库根 `sync-report.txt`（与自动路径同一落盘位置，下次运行覆盖），退出码 2。人工流程顺序：**先**按需人工更新包装层代码并本地 commit，**再**以 `--confirm-structural` 重跑同步走自动路径（重跑时**固定上次检出的 ref**（取自 `.upstream/last-sync.json`），除非用户显式改 `--ref`——避免人工介入期间上游发布新 tag 导致重跑对象与人工评估对象不一致）；版本归属按 4.3 优先级判定——上游版本变化吸收包装层变更，仅包装层单独变更才 `-r` +1（如 `6.7.0` → `6.7.0-r1`）。
8. **幂等**：ref 未变且树无 diff → "already up to date"，退出码 0，不产生空提交。「树无 diff」的范围 = **vendor 树 + 包装层待发布状态**：工作区相对 HEAD 存在包装层 diff、或存在未推送的包装层提交时**禁用幂等短路**（尚有变更待发布，继续走 bump 流程，由 §4.3 判定版本）。幂等判定实际在拉取与 staging 完成后尽早执行（字面步骤编号仅为描述顺序；幂等场景不跑 guard/verify/结构检测即返回）。成本下界：幂等命中仍发生下载（或缓存复用）、解压与 staging 复制，省的只是 guard/verify/结构检测；建议实现先比对 ref sha（ls-remote 结果 vs `.upstream/last-sync.json` 记录）再决定是否下载。`--dry-run` 语义 = 完成幂等检查 + 结构变化检测后输出将发生的变化，不做替换/commit/push。**补推记载**：幂等短路前，若本地存在上次发布版本的 tag 而远端缺失，脚本先经推送目标（同 PAT 解析顺序）预判并补推 `main` + tag（backPush）；`--no-push`/`--dry-run` 不补推；预判通道不可达时输出警告后照常短路（补推属尽力而为，失败不改变短路退出码 0，下次运行重试）。

**退出码**（单表：语义分组列 + 失败模式处置速查合并）：

| 语义分组 | 退出码 | 含义与处置 |
|---|---|---|
| 成功 | `0` | 成功或已是最新。 |
| 用法错误 | `1` | 参数组合非法（如 `--skip-guard` 未与 `--no-push`/`--dry-run` 联用，权威语义见用法块）。 |
| 流程停止（待人工） | `2` | 检测到结构变化待人工确认；人工路径（见步骤 7）。 |
| 校验失败 | `4` | verify-plugin 校验失败（校验明细见 §6 verify-plugin 行：frontmatter 两级判据、guard 逐项等价清单、全量逐字节比对等，任一失败即本码）；vendor 树未触碰。 |
| 完整性判定失败 | `3` | 完整性门判定失败（guard 非零，实测退出码 78 一类）。 |
| 环境失败 | `5` | 网络/拉取/来源失败（含上游无可用 release tag，见步骤 1）。 |
| 环境失败 | `7` | 工具链缺失（python3/git/tar 不可用，或无法运行 guard 脚本）。含 `git`/`tar` 不可用——**spawn 级失败**，与 `lib/tools.js` 的 `SPAWN_FAILURE_CODES`（`ENOENT`/`EACCES`/`EPERM`/`ENOTDIR`/`EISDIR`）同源判定，与命令运行业务失败相区分。 |
| 推送失败 | `6` | 推送失败与 tag 冲突（本地 commit 保留。远端推送被拒（non-fast-forward）——指引 `git pull --rebase origin main` 解决后重试，「可 `--no-push` 重试或手动推送」仅适用此类远端推送场景；tag 冲突（tag 已存在，如 `--ref` 回滚到旧版本重同步）——脚本在 `git tag` 前**先行检测**（`git rev-parse -q --verify refs/tags/<version>` 或从 ls-remote 结果预判）并直接映射本退出码，不依赖 git 原始退出码 128；绝不覆盖已有 tag，指引人工处理（拒绝回滚同步或评估改版本号），`--no-push` 不适用于 tag 冲突——其仍会创建本地 tag；脚本绝不自动 force push；见步骤 6）。 |

附注：`--skip-guard` 的联用约束与 usage 错误（退出码 1）判定，权威说明集中在用法块；其语义为仅豁免步骤 4 的 guard **执行**（省运行、免 python 依赖）——verify-plugin 的 JS 等价校验（digest/metadata/归属文件）仍会拦截，故不构成完整性放行；真实用途是 python3 缺失时的本地调试同步路径（`--no-push --skip-guard`，verify 的 JS 校验不依赖 python）。保留该标志的理由：为无 python 环境保留一条仍经 JS 校验的本地调试同步路径。启用 `--skip-guard` 时 verify-plugin 输出记录「guard 未运行」标记。

附注：磁盘预检分两段。① 启动预检：可用空间按**保守固定阈值 ≥260MB** 判定（依据实测「tarball + `.upstream/` 解压全树 + staging 副本」三项之和 ≈240MB（约 114MB + 78MB + tarball）加余量取整；此前的 220MB 阈值修正为**下界参考值**，仅作文档记录、不作为启动判据），不足时启动即报错退出。② 二次预检：tarball 下载完成后依响应 **Content-Length 实际值**复检（解压前按 tarball 实际大小 + 解压全树 + staging 副本重估三项之和），不足则报错退出且不解压。

### 4.2 结构变化分类

| 检测项 | 数据源 | 分类 | 理由 |
|---|---|---|---|
| `skills/` 一级 skill 目录增删 | vendor 树 vs staging | 🔴 结构变化 | skill 面变化，需人工评估插件可见面；比对为单向（上游→vendor）——vendor 侧人工新增 skill 目录属包装层变更，由 §4.3 规则 ③ 处理 |
| SKILL.md frontmatter `name` 变更 | vendor 树 vs staging | 🔴 结构变化 | 技能重命名，影响调用方式 |
| SKILL.md frontmatter `metadata.version` 缺失或不可解析 | vendor 树 vs staging | 🔴 结构变化 | 版本 bump 无法执行，需人工确认 |
| workflows/scripts/templates/references 一级条目增删 | vendor 树 vs staging | 🔴 结构变化 | 架构级变化信号 |
| requirements.txt 依赖行增删 | vendor 树 vs staging | 🟡 提示 | 需重跑 `ppt_master_setup_deps`（不阻塞自动路径，报告提示） |
| SKILL.md frontmatter `description` 显著变更 | vendor 树 vs staging | 🟡 提示 | 技能展示/路由描述变化，提示人工知悉（不阻塞自动路径） |
| `skills/` 一级非 skill 辅助目录（不含 `SKILL.md` 的目录，无论是否 dotfile，如 `skills/.claude-plugin/`——其内为 Claude 插件清单 plugin.json，即 staging 丢弃对象；与上游仓库根 `.claude-plugin/marketplace.json`（版本一致性校验数据源）为两个不同路径）增删 | **`.upstream/<ref>@<sha>/` 全树**（上游 `skills/` 一级） | 🟡 提示 | 上游辅助目录变化，知悉提示；不影响 vendor 面（已按策略丢弃，不进入 staging） |
| 其余文件内容常规更新 | vendor 树 vs staging | 🟢 自动 | 纯内容同步 |

注：🔴 表示需人工评估插件可见面，不代表包装层必然需要改代码——§3.4 泛化扫描使多数结构变化无需改码即可被 provider 自动纳入。**frontmatter 相关 🔴 项（行 2 name 变更、行 3 metadata.version 缺失）**经人工修复后，verify-plugin 的 frontmatter 校验会在替换前二次拦截（§3.4 fail-loud 契约优先于 provider 注册）；**行 1（skill 目录增删）**无需修复，经 `--confirm-structural` 确认后由步骤 6 的 skill 面替换直接落地（新目录自身的 frontmatter 合法性仍受 verify 扫描约束）。两阶段判定互补。

### 4.3 版本 bump 规则

版本 bump 按以下优先级**互斥判定**（自上而下，命中即止）：

1. 上游版本变化 → `version = 上游版本`、`-r` 后缀归零（形如 `6.8.0`）；该规则**吸收**其余两条——同版本 diff 与包装层变更不再另行追加 `-r`；命中时输出提示「包装层此前有 N 次修订已被归零」（不改变判定）。
   - 补充分支（兜底规则④）：上游版本变化但 vendor 树无 diff（如新 tag 仅改未 vendor 的 docs）→ 仍 `version = 上游版本` 并打该版本 tag（保持镜像语义）。
2. 否则，同上游版本但文件有 diff（如 tag 重推） → `-r` +1（`6.7.0` → `6.7.0-r1`）。
3. 否则，仅包装层自身变更 → `-r` +1（`6.7.0-r1` → `6.7.0-r2`）。前置判据：**包装层确有变更**——`--ref` 指向 docs-only commit（上游版本未变、vendor 树无 diff、包装层亦无变更）时不落本规则，按兜底规则④精神保持镜像版本不 bump（避免误标版本）。执行主体：规则③由**同步脚本自动执行**——脚本以未推送的包装层提交为判据（复用 §4.1 步骤 8 幂等范围的探测结果），命中时自动 `-r`+1、commit、tag 并按 `--no-push` 约束推送（Gate 3 用户裁决 2026-10-15：认可 plan T12/T13 审批接线的一键自动化语义，替代本节早先「bump 由人工完成」的表述）。开发者提交包装层变更后跑一次同步即完成发版；如需人工复核版本号，先以 `--no-push` 运行确认。

规则②③同时命中时按②处理（同一 `-r` 递增覆盖两类变更）。`-rN` 后缀仅供内部追踪，不承诺 semver pre-release 排序语义；无后缀视为 `r0`，新后缀 = 当前 N+1。

上游版本取自 staging `SKILL.md` frontmatter `metadata.version`；与上游仓库根 `.claude-plugin/marketplace.json` 的一致性校验（数据源与双路径区分见 §4.1 步骤 3）——不一致时以 SKILL.md 为准并提示。

## 5. Git、推送与安全

- 仓库初始化于 `/workspace/ppt-master`，**main 分支**；公开主地址 = `https://github.com/SAXEM1997/dsh-ppt-master-wrapper.git`（**URL 不含任何凭据**）。
- **PAT 解析顺序**（推送时）：环境变量 `DSH_PPT_GITLAB_PAT` → `git credential fill`（系统 credential helper）→ 失败并输出指引。经 credential helper 路径时 PAT 完全不经由本插件脚本参数/环境，仅在 git 进程内流转，安全边界不变。推送使用一次性 URL（`https://oauth2:<PAT>@…`——不落盘、不进 git 历史、不回显于日志；经 git argv 传递时同主机同用户理论上可经 `/proc` 短暂观测，故优先 credential helper 路径）。**PAT 绝不写入任何被提交的文件、绝不出现在日志与 git 历史中。**
- **授权边界**：`--confirm-structural` 仅表示人工已确认结构变化，其后的推送授权与自动路径**一致**（仍受 `--no-push` 控制、PAT 解析顺序相同）——结构确认不额外要求推送审批（与 4.1 步骤 7 的人工流程顺序呼应）。
- 首次交付时由开发者会话完成初始 commit/tag/push（PAT 通过环境变量注入）。
- `.gitignore`：`.env`、`.upstream/`、`.skills-staging/`、`sync-report.txt`、`__pycache__/`、`*.pyc`、`.mnemon/`、`.superpowers/`。
- 归属：vendor 内 LICENSE/SPONSORS* 逐字节保留；插件 README 显著致谢并链接上游。

## 6. 校验与测试

| 脚本 | 验证内容 | 失败行为 |
|---|---|---|
| `scripts/verify-plugin.mjs` | import index.js + mock ctx 驱动真实 provider：list/get 往返一致、frontmatter 合法（`name` 缺失或非 kebab-case → **仍 fail-loud 非零退出**，与 §3.4 权威判据一致、不软化；仅 `name` 与目录名不一致 → **降为警告**（提示级、不判失败——避免上游合法但 name≠dirname 的 skill 被 exit 4 阻断且 §4.2 无此分类）；`description` 非空）、与 guard **逐项等价**的完整性校验清单——① LICENSE SHA256 归一化摘要：与**被验目标树（参数化根）内**的 `attribution_guard.py` 声明的期望摘要一致（staging 模式取被验树自身 digest，上游合法更新 digest 时不误报退出码 4）（用正则从该脚本解析 `_LICENSE_DIGEST` 常量，Node `crypto` 自算比对，比对前复刻 guard 的 `_normalized_bytes()` 归一化（BOM 拒绝、CRLF/CR→LF）后再 sha256——与 guard 同一摘要算法，CRLF 签出环境不误报；摘要来源是上游自身，随每次同步自动更新，不依赖 Python；**正则无匹配 → 校验失败**，fail-loud 非零退出，不得静默跳过）、② frontmatter 逐字精确值校验（`copyright`/`license`/`official_repository`）、③ 归属文件存在（`LICENSE`/`SPONSORS.md`/`SPONSORS_CN.md`）、④ 9 个门文件存在、⑤ 门标记计数；**另补 guard 未覆盖面**：被验树（vendor 或 staging）与 `.upstream/` 解压树做**全量逐字节比对**（guard 守卫面为固定清单，实测追加非门文件内容 guard 不检测，靠此比对兜底）、SKILL.md 相对链接全部可解析（解析限于被验 skill 目录子树内（当前即 `skills/ppt-master/`）；链接目标越出被验 skill 子树——如指向上游仓库根的未 vendor 文件——记为**警告并豁免**：上游结构使然，非本插件缺陷，不判失败）、`${SKILL_DIR}` 门标记存在、mock ctx 断言 3 个生命周期工具（`ppt_master_info`/`ppt_master_check_env`/`ppt_master_setup_deps`）注册成功且 schema 合法（工具面本地校验，与 provider 面对齐） | 非零退出并列出全部问题 |
| `scripts/check-dsh-compat.mjs` | 定位已安装 DSH，按顺序探测：`--dsh-modules` 参数 > `$DSH_NODE_MODULES`（参考实现 superpowers-dsh 同款环境变量，作为等效入口并入探测顺序）> `$DSH_PROFILE_DIR` > `$DSH_HOME/profiles/$DSH_PROFILE/node_modules` > `$DSH_HOME/profiles/node_modules`；找到多个候选 profile 时要求显式指定并列出候选（消歧方式 = 用同一参数/环境变量显式指定；环境变量天然唯一，多候选仅发生在目录探测时）；定位全部失败时报错退出而非静默跳过（注明：superpowers-dsh 同款脚本默认取 `profiles/node_modules`，本环境实际安装于 `profiles/web/node_modules`，默认值选错会校验到错误副本）。定位成功后：SkillRegistry 真实挂载 provider 并读回；验证 `ctx.tools.register` 接受工具定义（兜底 3.5 的风险项）；比对 rank 取值（550）与已装 SDK `BUNDLED_SKILL_RANK`（600）的相对关系（低于本地 bundled root）；读回同环境已安装 superpowers-dsh 的实际 rank 常量并比对（550 跟随策略的自动检出——上游范例变更时告警而非静默漂移） | 非零退出 |

注：推送前置门由 sync-upstream 串接上述两脚本：attribution_guard（§4.1 步骤 4）与 verify-plugin（§4.1 步骤 6，**对 staging 路径参数化运行、先于 vendor 树替换**；内含与 guard **逐项等价**的完整性校验，等价清单与全量逐字节比对兜底见上表 verify-plugin 行）各跑一次，不重复执行 guard；任一失败即阻止 commit/push。

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
| `inject` 声明/`ctx.tools` 能力探测在宿主升级后失效 | apply 内存在性探测自动降级为仅注册 skill provider 并日志声明；compat 脚本持续验证该契约 |
| 上游完整性门未来收紧（如全树哈希） | 同步脚本的 attribution_guard 前置门会第一时间失败暴露，不会带病推送 |
| vendor 体积（78MB）导致仓库膨胀 | SVG/wav 少变；git 文本压缩良好；staging 全量替换只对变化 blob 产生增量 |
| GitHub 不可达 | 明确报错并支持 `--repo` 切换可达镜像 + `.upstream/` 缓存复用 |
| PAT 泄露 | 仅环境变量/credential helper 注入；一次性 URL；不落盘不进历史 |
