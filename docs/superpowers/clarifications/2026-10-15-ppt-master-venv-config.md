# 需求澄清：ppt-master venv 隔离 + 插件配置页（2026-10-15）

任务名：`2026-10-15-ppt-master-venv-config`（模式：中等）

## 缘起

本机（Docker 容器内 DSH）安装 dsh-ppt-master-wrapper 后 `ppt_master_check_env` 实测：python3 3.11.2 ✓、attribution_guard exit 0 ✓、**19 个依赖 0/19 已装**。用户问"装依赖是否在 venv？能否持久化到宿主机？"，遂决定开发 venv 支持与插件配置页。

## 问答记录（原始决策）

### Q1 venv 创建时机（用户答）
- **懒创建**：只在"准备 ppt-master 环境"（即执行 `ppt_master_setup_deps`）时创建；保存/修改配置不建。

### Q2 技能脚本的解释器路由（用户答）
- **入口 skill**：包装层自有一个入口 skill，每次触发 ppt-master skill 前必须先触发它；入口 skill 正文写明当前 venv 环境（python 路径等）。
- 不修改任何上游文件（方案A 字节级 vendor 约束继续成立）。

### Q3 venv 默认路径（用户答）
- 默认 `~/.ppt-master/venv`（通用性：不是所有 DSH 用户都是容器安装；贴合上游 `~/.ppt-master/.env` 惯例）。
- 本机显式配置 `/dsh-home/.ppt-master/venv`（挂载卷内，容器重建保留）。

### Q4 配置页形态（用户答）
- **原生 schema 配置页**（cordis Config schema → DSH 设置自动出页）。
- 版本/信息以**加载期注解**展示（插件版本、上游版本、SKILL_DIR）；**暂无实时状态**需求（明确非目标）。

### Q5 路径变更/启停时的旧 venv 数据处理（用户问，设计确认"可以"）
- 硬事实：stdlib venv **不可真迁移**（pyvenv.cfg、bin 脚本 shebang、activate 全部硬编码绝对路径）→"迁移"= 新路径全新创建+重装（幂等）+ 可选删旧。
- **配置变更本身永不删数据**；删除只发生在 `ppt_master_setup_deps` 执行时。
- **所有权标记**：创建 venv 时写 `<venv>/.ppt-master-wrapper.json`（创建时间、当时路径）；删除只对带标记目录执行（防配置误填任意路径被 rm）。
- 新配置项 `venv.oldPathPolicy: keep | delete`，**默认 keep**（用户确认）：下次 setup_deps 新路径成功建好后，发现旧路径有标记 venv → delete 则删旧、keep 则保留并提示闲置。
- **禁用 venv 永不自动删**（用户确认）：想要空间手动 `rm -rf`；重新启用同路径 venv 复用。

## 回放确认的整体设计（用户过目后仅补 Q5）

- 配置面：`venv.enabled`（默认 false）+ `venv.path`（默认 `~/.ppt-master/venv`）+ `venv.oldPathPolicy`（默认 keep）。
- 入口 skill 拟名 `ppt-master-env`（未被否决）：常驻目录，内容随配置生成；三态正文（venv 开+已建 → 写明用 `<venv>/bin/python3` 跑一切脚本含 attribution_guard；开+未建 → 先准备环境；关 → 系统 python3）。description 写明"使用 ppt-master 前必须先读本入口"。**软路由**（依赖描述引导模型）——方案A 下唯一不越权的信道。
- 工具感知（工程判断）：`check_env` 增 venv 小节（enabled/path/exists/venv python 版本），依赖探测经 venv python；`info` 增 venv 状态字段；`setup_deps` 的 `installCmd` 如实反映 venv pip；venv 内安装**无 PEP 668 拦截**（不需要 break-system-packages，该参数仅系统模式生效）。
- 非目标：实时状态面板、自研前端页、修改上游文件、venv 内依赖版本锁定、禁用时自动删除。

## 环境事实（探测证据，2026-10-15）

- 本机：Debian 12 容器（`/.dockerenv`），`/dsh-home`、`/workspace` 为宿主机 bind mount（host `/home/saxem1997/repo/dsh/` 下）；pip 目标目录在容器 rootfs（重建即丢）。
- `python3 -m venv` + ensurepip **均可用**（python3.11.2）；系统 Python 为 PEP 668（EXTERNALLY-MANAGED）。
- DSH 原生配置设施（重要发现）：插件声明 cordis `Config` schema → `ctx.settings`（SettingsForms）自动投影为配置页（按 profile entry id），`ctx.settings.configure()` 可调页面策略；写入走分层 profile patch + 修订冲突检测 + **Loader 热重载**（配置变更免重启重载插件实例）。配置整体替换语义（profile patch 按 id）。
- 客户端自研页范式存在（dsh-skills-manager：`dsh.client` + slots 注册 settings section + 预构建 bundle）——本任务不采用。
- 上游 SKILL.md 硬性指令：`python3 "${SKILL_DIR}/scripts/attribution_guard.py"`（PATH 解释器）——venv 路由必须绕行入口 skill。

## 隐含假设与边界

- 入口 skill 由 provider 动态合成（非 skills/ 树内静态文件），不进 verify-plugin 字节比对面（vendor 面不含它）。
- 配置热重载会重启插件实例：入口 skill 正文与工具行为随新配置生效（免 DSH 整体重启）。
- venv 跨容器重建的可用性依赖镜像不变（venv 内符号链接指向容器内绝对路径）——挂载卷只保证数据不丢。
- `~` 指 DSH 宿主进程的 HOME（容器内 /root；非容器用户为其真实 home）。
