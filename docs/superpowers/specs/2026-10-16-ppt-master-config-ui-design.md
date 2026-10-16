# 设计：ppt-master 插件配置页（客户端半边）（2026-10-16）

> 承接 2026-10-15 的 venv 特性。**触发**：验收期实测发现「纯宿主插件不出配置页」——宿主侧 volatile 投影与 settings 命名空间均已就绪，但插件页槽位无渲染者（见 `docs/superpowers/specs/2026-10-15-ppt-master-venv-config-design.md` §5.1 勘误 ㉗）。本设计为该 Config 补一个**浏览器半边**，把 venv 三项配置与版本信息做成插件页上的原生表单。
> 澄清真相源：`docs/superpowers/clarifications/2026-10-16-ppt-master-config-ui.md`。

## 1. 概述与动机

插件 `dsh-ppt-master-wrapper` 装在不同环境里：容器用户依赖已齐、venv 关着即可；裸机 `dsh` 用户面对 PEP 668 外管的系统 Python，需要 venv 隔离；而 venv 该放哪儿（盘位、持久性、挂载卷）只有用户自己知道。**受众是插件的其他使用者，不是本机操作者**——他们多半不会读 README，所以"可配"必须落在插件页上：能改路径、能开关、能决定改路径后旧目录怎么办，并能看到版本信息（插件版本 / ppt-master 上游版本 / SKILL_DIR）。

宿主侧早已备好一切（`Config` 三叶子 volatile + schema description 版本注解 + `dsh-settings` 命名空间投影），缺的只是"渲染者"。本设计补上渲染者，**不改宿主半边行为**。

## 2. 目标 / 非目标

**目标**
- G1 插件页出现配置卡片，可读可写 `venv.enabled` / `venv.path` / `venv.oldPathPolicy` 三项（保存走宿主既有配置通道）。
- G2 卡片显示版本信息（插件版本、ppt-master 上游版本、SKILL_DIR），数据取自既有的 schema 注解，**不新开 RPC 通道**。
- G3 中英双语，跟随宿主界面语言。
- G4 全链路零新增 npm 依赖、零构建链：浏览器半边为**手写自包含单文件**。
- G5 宿主不支持/服务缺失时**安静降级**：纯宿主半边行为零变化，插件页不因本卡片崩。

**非目标**
- venv 实时状态显示（是否已建/就绪/依赖计数）——用户明确不要；状态仍由 agent 侧 `ppt_master_info` / `ppt_master_check_env` 承担。
- 卡片内"准备环境"按钮或任何写副作用操作（venv 创建/删除仍**只**发生在 `ppt_master_setup_deps`）。
- 新宿主↔页面 RPC 面、typert remote、自研页面。
- 引入打包器/构建步骤，或把 React 等打进产物。
- 改动 `index.js` / `lib/venv.js` / `lib/tools.js` / `lib/skill-provider.js` 的既有行为（宿主半边行为冻结）。
- 本特性内做发行元数据补全（`repository` 字段等）与版本号递增（沿用规则：随下次上游 sync 递增 `-r`）。

## 3. 架构

```
浏览器（插件页 @deepseek-ai/dsh-client-ui-plugin-manager）
  renderSlot('plugins.bundle.config', { view, form }, { entryKey: 'dsh-ppt-master-wrapper' })
        │  form = configForms.get('dsh-ppt-master-wrapper')  ← 命名空间＝loader 条目 id
        ▼
  lib/client.js（本特性新增；window.__ModuleLoader__.load({id, factory})）
        │  factory 内 require：react / @deepseek-ai/dsh-client-ui-settings / …-locale / …-plugin-manager
        │  注册：slots.register({name:'plugins.bundle.config', key:'dsh-ppt-master-wrapper'}, Card)
        │        locale.register('dsh-ppt-master-config', { zh, en })
        ▼
  configForms.get(ns) → { state: {值, revision, …}, mutate(ops, revision) }
        ▼
  宿主 settings RPC → dsh-settings → config-editor edit() → 写 profile cordis.patch.yml
                    → reconcileProfilePatches → Loader 重建插件实例
                    → 入口 skill 正文 / 工具行为换代（是否热生效＝验收期实测项，见 §8）
```

组件划分：

| 组件 | 职责 | 变更 |
|---|---|---|
| `lib/client.js` | 浏览器半边：注册槽位与字典、渲染卡片、读写表单 | **新增** |
| `package.json` | `exports["./client"]` + `dsh.client` 声明 | 修改（两处键；`files` 已含 `lib`，无需改） |
| `index.js` / `lib/*.js`（宿主半边） | 提供 Config 与工具 | **冻结**（零改动） |
| `tests/client-half.test.mjs` | 客户端半边单测（stub 装载 + 契约断言 + 注解解析矩阵） | 新增 |
| `scripts/check-dsh-compat.mjs` | 扩一项"客户端半边可被 stub 装载并注册" | 修改 |
| `README.md` | 配置入口一节改回"插件页卡片可用"，保留 profile patch 手工通道 | 修改 |

## 4. 数据流

1. **读**：卡片挂载时读 `form.state`（宿主镜像里的当前值 + revision）。`view === 'summary'` 时只渲染一行摘要（例如"venv：已启用 · /path"或"venv：未启用"），`view === 'page'` 时渲染完整表单。
2. **改**：用户改字段 → 卡片构造 `ops` → `form.mutate(ops, revision)` → 宿主写入。**不做本地乐观更新**：以宿主回推的值为准（页面与卡片共用同一镜像）。
3. **版本信息**：从命名空间 view 的 `schema.description`（模块加载期烘焙的注解）解析出版本三元组；取不到则显示"未知"并保留表单可用（取数路径见 §5.4）。
4. **生效**：宿主保存后经 config-editor → profile patch → Loader 重建。是否免重启，验收期实测（§8）。
5. **profile 层条目自动建立**：若 profile `cordis.patch.yml` 尚无 `id: dsh-ppt-master-wrapper` 条目，首次保存时由宿主 config-editor 代建（`index<0` → `document.add({id,name,config})`）——即上一特性「验收期人工步骤 ③」的手工动作在卡片可用后变为自动；手工条目与本通道等价，先写者为准（`config` 整体替换语义）。

## 5. 接口

### 5.1 `package.json`

```json
"exports": {
  ".": "./index.js",
  "./client": "./lib/client.js",
  "./cordis.patch.yml": "./cordis.patch.yml",
  "./package.json": "./package.json"
},
"dsh": {
  "engines": { "dsh": ">=0.1.1-rc.1" },
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "inject": [
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-plugin-manager"
    ]
  }
}
```

`inject` 照抄官方配置页（`@deepseek-ai/dsh-client-ui-settings-agent-loop`）的形态：列**运行期必须存在的宿主客户端包**；`react` / `react-dom` / `react/jsx-runtime` 由宿主模块表隐式提供，不列入。**待实现期核对**（V2）：是否需要显式列入 `@deepseek-ai/dsh-client-ui-slots`（槽位服务提供方）。

### 5.2 客户端文件契约（`lib/client.js`）

- 形态：自包含单文件，顶层 `window.__ModuleLoader__.load({ id: 'dsh-ppt-master-wrapper', factory: (require) => { ... } })`；**无** `import`/`export` 语句、**无**外部依赖。
- 元素构造用 `require('react').createElement`（不依赖 JSX 转换，不 require `react/jsx-runtime`）。
- 注册面（在 `factory` 内、`ctx.slots.inject` 之后）：
  - `slots.register({ name: 'plugins.bundle.config', key: 'dsh-ppt-master-wrapper', locale: <ns>, inject: () => ({ t }) }, Card)`
  - `locale.register(<ns>, { zh, en })`
- 槽位键：**包名**（`plugins.bundle.config` 的键语义＝bundle 的包名）。命名空间同名（`dsh-ppt-master-wrapper`），故页面 `formFor(pkg.name)` 可直接命中本插件的 settings 命名空间。
- locale 命名空间：`dsh-ppt-master-config`（不与宿主既有命名空间冲突）。
- 守卫：所需服务或槽位缺失 → **不注册**并 `console.warn` 一行（含包名与缺失项）；`factory` 全程 try/catch，任何异常只 warn，不向外抛。

### 5.3 卡片 UI

| 区域 | 内容 | 语义要点（文案必须说清后果） |
|---|---|---|
| 启用开关 | `venv.enabled` | 关＝用系统 `python3`，**且不删除任何目录**（清理纯手动） |
| 路径 | `venv.path` 文本框 | 绝对路径或 `~` 前缀（`~` 按宿主进程 HOME 展开）；相对路径判无效 → venv 视为关闭 + 警告 |
| 旧路径处理 | `venv.oldPathPolicy` 下拉 | `keep`＝保留旧 venv 待手动清理（默认）；`delete`＝下次环境准备成功后删除**带所有权标记**的旧目录 |
| 版本信息 | 只读文本块 | 插件版本 / ppt-master 上游版本 / SKILL_DIR（来自注解；缺失则显示"未知"） |
| 保存/重置 | 由页面提供的表单控件承担（卡片不自造写按钮） | 保存失败/被更高优先级覆盖 → 沿用页面既有呈现 |

### 5.4 版本注解取数与解析

- 取数：优先 `form.state` 内的 schema（若宿主镜像暴露）；否则经注入的 `configForms.describe().getSnapshot().view.namespaces.find(ns === 'dsh-ppt-master-wrapper').schema`。**待实现期实测**（V1），两条路径的取舍在 Phase 3 第一个 task 内钉死。
- 解析：把注解文本解析为 `{ pluginVersion, upstreamVersion, skillDir }` 三元组，规则为逐行/逐段匹配既有注解格式；解析失败任一字段 → 该字段显示"未知"，**不影响表单**。
- 兜底（仅当 V1 两条路径都不可达时启用）：客户端内常量 + compat 脚本断言其与 `package.json` / `skills/` 元数据一致（防漂移）。

## 6. 错误处理与降级

| 情形 | 行为 |
|---|---|
| 宿主不认 `dsh.client`（老版本） | 该字段为惰性元数据，宿主半边照常；浏览器不加载任何东西，插件页与现状一致 |
| 所需服务/槽位缺失 | 不注册 + 一行 warn（G5） |
| `factory` 内任何异常 | try/catch → warn，不外抛（不得让插件页整页崩） |
| 命名空间未就绪（宿主未投影出该条目） | 卡片不渲染（槽位由页面按键派发，无 form 即无卡片），不报错 |
| 版本注解缺失/格式变化 | 对应字段显示"未知" |
| 保存被拒绝 / 被更高优先级 patch 覆盖 | 沿用宿主页面既有呈现（overridden 提示），卡片不自造错误通道 |
| 保存成功但 Loader 重建失败 | 属宿主面；下一次重启生效（与既有兜底一致） |

## 7. 测试策略

1. **客户端半边单测**（`tests/client-half.test.mjs`，新增）：
   - stub `globalThis.window.__ModuleLoader__` 收集 `{id, factory}`；以假 `ctx`（记录 `slots.register` / `locale.register` 调用、`slots.inject` 立即回调、`locale.bind` 返回 `t`）调用 `factory`，断言：id 正确、槽位名与键正确、字典 `zh`/`en` **键集合相等**（防单语漏配）。
   - 渲染冒烟：以 `view='summary'` 与 `view='page'` 各渲染一次（React 元素树断言，不做 DOM 渲染），`form` 缺省时不抛。
   - 注解解析矩阵：正常注解 / 缺字段 / 空串 / 无 description → 期望三元组与"未知"降级。
   - 守卫路径：缺 `slots` 或缺 `locale` → 不注册、warn 一次、不抛。
2. **静态契约断言**（并入 compat 脚本或单测）：`lib/client.js` 无 `import`/`export`、无第三方包名 require（白名单＝react 系 + 三个 inject 包）、`package.json` 的 `exports["./client"]` 与 `dsh.client.platform==='web'` 存在、`files` 覆盖 `lib/client.js`。
3. **compat 脚本扩展（§7.7⑥）**：以 stub 装载 `lib/client.js` 并断言注册面成立（与既有 §7.7⑤ 同风格）。
4. **回归**：既有 527 用例全绿；`check-dsh-compat` OK；`verify-plugin --upstream` OK（vendor `skills/` 字节零漂移）。
5. **手工验收**（§9）：本机插件页可见卡片、中英切换、保存后配置生效（热生效或重启）、禁用后工具回到系统模式。

## 8. 风险与未知（实现期须钉死）

| # | 项 | 处理 |
|---|---|---|
| V1 | 版本注解在客户端是否直接可达 | Phase 3 首个 task 实测；两路径择一，兜底见 §5.4 |
| V2 | `inject` 是否需列 `…ui-slots` | 装载期以真实宿主验证；缺失则补列 |
| V3 | 保存是否**热生效**（config-editor `edit()` 通道在无 watcher 的本部署是否仍重建实例） | 验收期实测并记录（手工 patch 通道已否证，GUI 通道未测） |
| V4 | 手写 factory 能否被真实 client loader 接受（官方产物经构建链） | 先以 stub 断言格式，再以真实页面装载验证；失败则退回"最小可加载形态"并按 loader 报错修正 |
| R1 | 老宿主无该槽位 | G5 安静降级 + README 说明 |
| R2 | 双语字典漂移 | 单测断言键集合相等 |
| R3 | 卡片影响插件页稳定性 | 守卫 + try/catch + 不注册优先 |

## 9. 文档与发布 / 验收期人工步骤

- README：配置入口一节改为"插件页卡片（推荐）+ profile patch 手工条目（无客户端渲染者或禁用页面时）"，保留 ㉗/㉘ 的实测结论与重启说明——GUI 保存是否热生效按 V3 实测结果改写。
- spec（2026-10-15 篇）：㉗ 的"GUI 出页属新特性"一句追加指向本篇的链接；不改其结论。
- 版本号：**不递增**（沿用规则，随下次上游 sync 递增 `-r`）。
- 验收期人工步骤：① 本机插件页出现卡片且中英随界面语言切换；② 改 `venv.enabled` 保存 → 观察入口 skill 正文/工具行为是否换代（记录热生效与否）；③ 记录 profile patch 的写入形态（config-editor 是否整体替换该条目）；④ 卡片在"宿主无该槽位"环境下安静降级（可用旧版本宿主或 stub 页面验证，若不可得则记录为未覆盖）。

## 10. 排除范围（明确不做）

- 实时状态面板、依赖计数、"准备环境"按钮。
- 任何新 RPC / remote 命名空间 / 宿主侧新导出面。
- 构建链（tsdown/rollup/esbuild）、TypeScript、JSX、`.d.ts` 产物。
- companion 客户端包、`plugins.item` 官方命名空间条目。
- 宿主半边任何行为改动（含 `Config` schema 与注解格式）。
- 发行元数据补全（`repository` 等）与 npm 发布流程。
