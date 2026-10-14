# dsh-ppt-master-wrapper

将上游 [ppt-master](https://github.com/hugohe3/ppt-master) 技能集忠实封装为 DeepSeek Harness (DSH) 插件的包装层：上游 skill 目录**逐字节 vendor**（零改写，天然通过其 `attribution_guard.py` 完整性门），外加三个生命周期工具与一键同步脚本。

- **零改写**：vendor 的 `skills/ppt-master/` 与上游 release 完全一致，不修改任何上游文件；
- **零运行时 npm 依赖**：纯 Node 内置模块实现；
- **可更新**：`scripts/sync-upstream.mjs` 一键同步上游新版本（见下文）。

## 安装

前置要求：Node.js ≥ 20；`python3`（上游完整性门与脚本套件运行需要，建议 ≥ 3.10）。

方式一——本地路径 link（开发机 / 内网已 clone 场景）：

```bash
dsh plugin --profile <name> add link:/path/to/dsh-ppt-master-wrapper
```

方式二——GitLab URL 直接安装：

```bash
dsh plugin --profile <name> add https://gitlab.ai.isv.iridesc.cn:23000/zyx/dsh-ppt-master-wrapper.git
```

安装后重启会话，`ppt-master` 技能即对 agent 可见。DSH 通过 `resourceBase` 注入技能所在目录的绝对路径，由执行 agent 代入上游约定的 `${SKILL_DIR}`——机制等价满足上游 SKILL.md 的硬规则。

## 首次使用：环境自检、依赖与 `.env`

1. **环境自检**：调用 `ppt_master_check_env` 工具（或见下文工具说明），确认 python3 就绪、完整性门通过、Python 依赖已安装。
2. **安装 Python 依赖**：调用 `ppt_master_setup_deps`（幂等执行 `pip install -r "${SKILL_DIR}/requirements.txt"`），或手动 `pip install -r skills/ppt-master/requirements.txt`。
3. **配置 `.env`（按需）**：上游图像生成脚本需要图像后端配置。首次使用时从 vendor 的模板复制一份到**工作区根目录**：

   ```bash
   cp skills/ppt-master/.env.example .env
   ```

   然后按需填写图像后端 API key：设置 `IMAGE_BACKEND`（推荐核心后端 `openai` / `gemini` / `qwen` / `zhipu` / `volcengine`）并取消注释对应提供商的 key/model 行（如 `OPENAI_API_KEY`、`GEMINI_API_KEY` 等）。也可不写 `.env`，直接以进程环境变量提供同样配置。各项含义与全部可用后端见 `.env.example` 内注释。

   > `.env` 已列入 `.gitignore`，不会被提交；本插件工具不读取、不回显 `.env` 内容或任何密钥。

## 生命周期工具

插件经 `ctx.tools.register` 暴露三个工具（中英双语描述）。工作流本身（生成/重构/美化 PPT 等）由 skill 驱动，不封装为工具。

| 工具 | 参数 | 行为 |
|---|---|---|
| `ppt_master_info` | 无 | 返回插件版本、包裹的上游版本（解析 vendor `SKILL.md` 的 `metadata.version`）、`SKILL_DIR` 绝对路径（扫描 `skills/*/SKILL.md`，主目录按 `name: ppt-master` 锚定）与上游 repo/release 链接。纯读。 |
| `ppt_master_check_env` | 无 | 环境自检：python3 ≥ 3.10 就绪度；运行 vendor `attribution_guard.py` 并报告通过与否；解析 `requirements.txt` 顶层发行版名并以发行版元数据（`importlib.metadata`）为一等手段探测安装状态（dist→import 映射缺失的项记 UNKNOWN 而非 FAIL）；检查 `.env` 是否存在（仅提示）。输出结构化诊断，只读。 |
| `ppt_master_setup_deps` | `user?: boolean`、`breakSystemPackages?: boolean` | 幂等执行 `pip install -r "${SKILL_DIR}/requirements.txt"`（按参数附 `--user` / `--break-system-packages`）；完成后自动复跑环境自检并汇报。**唯一有副作用的工具**。 |

## 同步上游更新

```bash
node scripts/sync-upstream.mjs [选项]
```

| 选项 | 语义 |
|---|---|
| `--ref <tag\|branch\|commit>` | 指定上游 ref（默认：最新语义版本 release tag） |
| `--repo <url>` | 上游仓库 URL（默认 `https://github.com/hugohe3/ppt-master.git`；ls-remote 与 tarball 下载同源取值） |
| `--refresh` | 强制忽略 `.upstream/` 缓存重新下载 |
| `--confirm-structural` | 结构变化已人工确认，强制走自动路径（重跑固定上次检出的 ref） |
| `--skip-guard` | 跳过 `attribution_guard.py` 的执行（须与 `--no-push` 或 `--dry-run` 联用；verify-plugin 的 JS 等价校验仍会拦截，不构成完整性放行） |
| `--no-push` | 只本地 commit + tag，不推送 |
| `--dry-run` | 只输出将发生的变化，不替换/commit/tag/push |

流程：解析最新 release tag → 下载（或复用 `.upstream/` 缓存）→ staging → 完整性门（逐 skill 运行 guard）→ 结构变化检测 → 无结构变化（或已确认）时自动路径：verify-plugin 前置于替换 → 以 staging 替换 `skills/` → bump `package.json` version → 单次 commit + tag `v<version>` → push。

**结构变化 🔴**（skill 目录增删、skill 重命名、`metadata.version` 缺失等）时停下报告（退出码 2，写入仓库根 `sync-report.txt`）：人工评估并按需更新包装层后，以 `--confirm-structural` 重跑完成同步。

**版本策略**：`package.json` version 镜像上游版本（如 `6.7.0`）；仅包装层自身变更或同版本重同步时追加 `-rN` 后缀。

退出码速查：`0` 成功/已是最新；`1` 用法错误；`2` 结构变化待人工；`3` 完整性门失败；`4` verify-plugin 校验失败（vendor 树未触碰）；`5` 网络/来源失败；`6` 推送失败/tag 冲突；`7` 工具链缺失（python3）。

## 本地校验（开发）

```bash
# 完整性+provider/工具面校验（--root 缺省即包内 skills/；--upstream 必须显式传，
# 取 .upstream/ 缓存目录名 <ref>@<sha>）
node scripts/verify-plugin.mjs --upstream .upstream/refs/tags/v6.7.0@<sha>

# 对照已安装 DSH SDK 的契约检查（真实 SkillRegistry 挂载 + tools.register + rank）
node scripts/check-dsh-compat.mjs

# 全套测试
node --test tests/*.test.mjs
```

## 致谢与许可

- 上游项目：[hugohe3/ppt-master](https://github.com/hugohe3/ppt-master)（MIT）——本包装层的全部能力来自上游技能集，感谢作者的杰出工作。
- **双 LICENSE 归属**：插件根 [`LICENSE`](LICENSE) 为本项目 `dsh-ppt-master-wrapper` 自身的 MIT 许可；vendor `skills/ppt-master/LICENSE` 为**上游原文，逐字节保留**（受上游 `attribution_guard.py` 完整性门校验，不得改动）。两者独立共存。
- vendor 内的 `SPONSORS.md` / `SPONSORS_CN.md` 等归属文件同样逐字节保留，欢迎按上游指引赞助原作者。
