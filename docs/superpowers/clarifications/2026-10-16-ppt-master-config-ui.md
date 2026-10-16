# 2026-10-16-ppt-master-config-ui — 需求澄清（Phase 0）

> 主题：给 `dsh-ppt-master-wrapper` 补**客户端半边**，使 venv 三项配置 + 版本信息在 DSH 插件页以原生表单可读可写（中英双语）。
> 触发背景：验收期实测发现「纯宿主插件不出配置页」（spec 勘误 ㉗），原 G2「原生配置页自动出页」前提在本版 DSH 不成立。

## 1. 为什么做（用户原话要点）

> 「每个人的使用情况不一样，有些人像我一样用容器也无 venv 也没关系，但有些是直接安装的 dsh，那么可能就需要 venv，其 venv 位置也可能各不一样所以需要可配」

归纳：**这个配置页服务的是"别人"，不是本机操作者**。三类现实差异 → 一个页面：

1. 容器用户（依赖已齐）→ venv 关着就行，页面应让他一眼知道「这项跟我无关」；
2. 裸机 `dsh` 用户（PEP 668 外管系统 Python）→ 不隔离就得 `--break-system-packages` 且污染系统目录，需要 venv；
3. venv 放哪儿因机器而异（盘位/持久性/挂载卷）→ 路径必须可配，默认值只是兜底。

## 2. 卡片要素（用户主动列出）

| # | 要素 | 对应配置/数据 |
|---|---|---|
| 1 | 能配 venv 的**位置** | `venv.path` |
| 2 | **启用/禁用** | `venv.enabled` |
| 3 | **修改时是否保留原配置** | `venv.oldPathPolicy`（`keep` 默认保留待手动清理 / `delete` 下次环境准备成功后删带标记的旧 venv） |
| 4 | **显示相关版本信息**（含 ppt-master 上游版本等） | 插件版本、上游 skill 版本、SKILL_DIR（模块加载期烘焙进 `Config` schema description 的注解） |

## 3. Q&A 原始记录

- **Q1（用途场景）**：你打算在什么时刻用这个页面？
  **A1**：见 §1 原话——受众是插件的其他使用者，环境差异（有无 venv 需求、路径各异）是动机。
- **Q2（是否显示实时状态）**：这张卡要不要显示"这台机器当前的真实状态"（venv 目录是否已建、解释器是否就绪、19 个依赖装了几个）？
  **A2**：**不用显示当前状态**。
  - 影响：卡片停在宿主已有的配置通道内（页面把"当前值 + 写入口"交给卡片），**不新开宿主↔页面 RPC**；实时状态仍由 agent 侧 `ppt_master_info` / `ppt_master_check_env` 承担。
- **Q3（界面语言）**：卡片只做中文还是跟随用户界面语言（中英双语）？
  **A3**：**中英文都做**。
  - 影响：需注册宿主客户端 locale 字典（zh/en 两套文案），而非只写中文硬编码。

## 4. 代理侧勘察结论（事实，非用户陈述）

| 项 | 结论 | 证据 |
|---|---|---|
| 客户端半边声明 | `package.json` → `"dsh": { "client": { "platform": "web", "inject": [<宿主客户端包名>...], "external"?: [...], "immediately"?: bool } }` + `exports["./client"]` 指向单文件 | `@deepseek-ai/dsh-client-modules` 的 `parseDshClient`；本机 dsh-mnemon / dsh-model-sync / dsh-context 的 package.json |
| 客户端文件形态 | 自包含单文件，形如 `window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {...} })`；内部 `require("react")` / `require("react-dom")` / `require("react/jsx-runtime")` / `require("<inject 里的宿主包>")` | dsh-mnemon/lib/client.js 头部 |
| 卡片挂载点 | 插件页槽位 `plugins.bundle.config`（键＝**包名**）或 `plugins.row.config`（键＝`` `${包名}#${行id}` ``）；页面把 `form`（state + mutate）传给卡片 | `@deepseek-ai/dsh-client-ui-plugin-manager`（`rowConfigKey` / `renderSlot`） |
| 配置值读写 | 宿主 `dsh-settings.describe()` 按 volatile 投影出命名空间（`ns = 条目 id`）并附 `schema`/`value`/`revision`；客户端经 `configForms.get(ns)` 取表单、`configForms.describe()` 读原始 describe 视图 | `@deepseek-ai/dsh-settings`（describe）、`@deepseek-ai/dsh-client-ui-settings`（镜像 `view: response.value`） |
| 版本注解可取 | 注解在 `Config` schema 的 `description` 内，随命名空间 `schema` 一起下发 → 卡片无需新通道 | 同上 + 本包 `index.js` 的 `CONFIG_ANNOTATION` |
| 降级前提 | 宿主不认 `dsh.client` 时该字段只是惰性元数据 → 纯宿主半边行为不变 | 现有 bundle 契约（`dsh.bundle.patch`）与 `dsh.client` 解析为可选 |

## 5. 边界与隐含假设（标注来源）

- 〔用户〕不显示实时状态 ⇒ 卡片无"环境准备"按钮、无依赖计数、无解释器版本展示。
- 〔代理判断〕受众含"不读 README 的用户" ⇒ 卡片文案需自解释：三个字段的**后果**要说清（尤其 `oldPathPolicy=delete` 会删旧目录、`enabled=false` 不删任何东西）。
- 〔代理判断〕本包保持**零 npm 依赖** ⇒ 客户端文件手写、不引入构建链、不新增 runtime 依赖（`files` 白名单需收录该文件）。
- 〔代理判断〕发行面缺口顺带登记：`package.json` 现无 `repository` 字段（发行元数据）。
- 〔代理判断〕宿主版本差异：卡片须在宿主缺少所需客户端服务/槽位时**安静跳过注册**（不得让插件页整页崩），与 dsh-market 的 `missingPrimitives` 守卫同思路。
- 〔已实测〕本机 DSH rc.2 下 profile patch **手工编辑不热生效**；而 GUI 保存走 config-editor `edit()` → `reconcileProfilePatches` → Loader 重建，是否**热生效**需在验收期实测记录（spec 勘误 ㉘ 只否证了手工通道）。

## 6. 开放项（设计阶段处理，不阻塞）

1. 卡片挂载层级选择（bundle 级 vs row 级）——两者键都落在同一命名空间，属实现选择。
2. 版本注解在客户端表单快照中是否直接可达（`form.state.schema` vs 另取 `configForms.describe()`）——由 Phase 3 首个 task 实测钉死，取不到则以客户端常量 + compat 断言兜底。
3. 版本号递增（`6.7.0-r2` → `-r3`）随发布规则处理。
