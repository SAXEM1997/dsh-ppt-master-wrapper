# 设计：ppt-master 插件配置页（客户端半边）（2026-10-16）

> 承接 2026-10-15 的 venv 特性。**触发**：验收期实测发现「纯宿主插件不出配置页」——宿主侧 volatile 投影与 settings 命名空间均已就绪，但插件页槽位无渲染者（见 `docs/superpowers/specs/2026-10-15-ppt-master-venv-config-design.md` §5.1 勘误 ㉗）。
> 澄清真相源：`docs/superpowers/clarifications/2026-10-16-ppt-master-config-ui.md`。
> **修订记录**：（1）builder check 后按宿主源码重写装载契约/写控件归属/注解可达性；D1、D2 经用户裁决。（2）Gate 0 R1 审查后补注册生命周期、写路径测试、重启交付物更正、依赖边说明。（3）**Gate 0 R2 审查后**：M13＝按官方 practice **不 require 任何 Harness 客户端包**（含 `ui-primitives`/`SettingsFormModel`）⇒ 控件自绘；M1/M14＝依赖边语义与 `external` 声明更正；M3＝`configForms` 回调式接入；M5＝volatile 快路径（不 remount）；M6＝保存失败**按可观测量分两类** + memory 模式提示 + 重置语义；M4＝版本断言拆分。（4）**M2 重审（用户 2026-10-16）**：因 `SettingsFormModel` 恰在禁 require 的 `ui-primitives` 内、其"扁平兼容"好处归零，而宿主 `applyPathOp`/`isVolatilePath` 实证支持**嵌套 volatile 路径** ⇒ **维持既有嵌套 schema**，改为"卡片自持暂存态 + 手写嵌套 `path` 的 ops"；上一特性交付的键名/测试/文档**零改动**，profile 条目无需迁移（详见 §5.5）。（5）**计划期勘误 V5′（2026-10-16）**：实测确认 `react` 系为平台种子词；监督者裁决**保留** `external: ["react"]` 声明（§5.1/§8）。另：计划期发现 `tests/skeleton.test.mjs` 的 exports 键集断言与 `exports["./client"]` 数学互斥，监督者批准其"四条目化（只增不删）"为"既有测试零改动"不变量的**唯一例外**（登记于计划 Global Constraints 与裁决记录）。

## 1. 概述与动机

插件 `dsh-ppt-master-wrapper` 装在不同环境里：容器用户依赖已齐、venv 关着即可；裸机 `dsh` 用户面对 PEP 668 外管的系统 Python，需要 venv 隔离；而 venv 该放哪儿（盘位、持久性、挂载卷）只有用户自己知道。**受众是插件的其他使用者，不是本机操作者**——他们多半不会读 README，所以"可配"必须落在插件页上：能改路径、能开关、能决定改路径后旧目录怎么办，并能看到版本信息。

宿主侧早已备好配置通道（volatile 投影 + settings 命名空间），缺的只是"渲染者"。本设计补上渲染者。

## 2. 目标 / 非目标

**目标**
- G1 插件页出现配置卡片，可读可写三个 venv 配置项（保存走宿主既有配置通道）。
- G2 卡片显示版本信息：**插件版本 + ppt-master 上游版本 + 固定相对尾部 `<包根>/skills/ppt-master`**（两版本号取客户端常量，以两条配对断言防漂移；**不显示绝对 SKILL_DIR**，见 §5.4）。
- G3 中英双语，跟随宿主界面语言。
- G4 零新增 npm 依赖、零构建链：浏览器半边为**手写自包含单文件**。
- G5 **槽位或可选能力**缺失时安静降级：纯宿主半边行为零变化，插件页不因本卡片崩。（**边界**：硬服务 `slots`/`locale` 缺失时 `apply` 根本不被调用、宿主以 `pending (waiting for service…)` 上报——那不是本插件能"安静降级"的形态，见 §5.2/§6。）

**非目标**
- venv 实时状态显示（是否已建/就绪/依赖计数）——用户明确不要；状态仍由 agent 侧 `ppt_master_info` / `ppt_master_check_env` 承担。
- 卡片内"准备环境"按钮或任何写副作用操作（venv 创建/删除仍**只**发生在 `ppt_master_setup_deps`）。
- 新宿主↔页面 RPC 面、typert remote、自研页面。
- 引入打包器/构建步骤，或把 React 打进产物。
- 发行元数据补全（`repository` 等）与版本号递增——归 §9「发行待办」，不属本特性交付面。
- **宿主半边行为与配置 schema 的任何改动**：`venv.{enabled,path,oldPathPolicy}` 的键名与层级、判定逻辑、副作用、工具 payload 全部保持不变（M2 重审后维持嵌套，见 §5.5）。

## 3. 架构

```
浏览器（插件页 @deepseek-ai/dsh-client-ui-plugin-manager）
  renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: 'dsh-ppt-master-wrapper' })
        │  bundle 槽【只发 view:'page'】且【不带 form】；form 由卡片自取
        ▼
  lib/client.js（本特性新增；被宿主 vendored cordis Loader 当插件装载）
        │  exports.inject = ['slots', 'locale']（硬服务）
        │  exports.apply(ctx)：
        │    1) ctx.inject(['configForms'], …) ← 可选能力，回调式，缺则卡片显示不可用
        │    2) ctx.effect(() => ctx.locale.register('dsh-ppt-master-config', { zh, en }))
        │    3) ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({name, key, locale}, Card))
        ▼
  卡片（自持暂存态；控件自绘，仅用 CSS token）
        → mutate([{op:'set', path:['venv','enabled'], value:…}], revision)  ← 嵌套 volatile 路径
        ▼
  宿主 settings RPC → dsh-settings → config-editor edit() → 写 profile cordis.patch.yml
                    → Loader：三叶子全 volatile ⇒ **volatile 快路径**（只写 fiber._config +
                      _commitVolatile() → loader/volatile-update，**不 remount**）
                    → 入口 skill 正文 / 工具行为随 volatile 引用换代
```

组件划分：

| 组件 | 职责 | 变更 |
|---|---|---|
| `lib/client.js` | 浏览器半边：导出 cordis 插件（`inject`/`apply`）、注册槽位与字典、渲染卡片、自持暂存与保存 | **新增** |
| `package.json` | `exports["./client"]` + `dsh.client` 声明（含 `external`，见 §5.1） | 修改 |
| `scripts/check-dsh-compat.mjs` | 新增 §7.7⑥ 客户端半边装载断言（+ 既有断言不回归） | 修改 |
| `tests/client-half.test.mjs` | 客户端半边单测 | 新增 |
| `README.md` | 配置入口补"插件页卡片"路径、重启边界、memory 模式提示 | 修改 |
| `index.js` / `lib/venv.js` / `lib/tools.js` / `lib/skill-provider.js`（宿主半边） | 提供 Config 与工具 | **冻结**（零改动；M2 重审后维持嵌套 schema） |
| `tests/*`（既有测试） | — | **零改动**（无 schema 变更） |

## 4. 数据流

1. **装载**：页面加载 → `dsh-client-modules` 按 `dsh.client` 声明把 `lib/client.js` 作为浏览器半 cordis 插件装载（`load({id})` 的 id **必须等于包名**）→ Loader 等 `inject` 服务就绪 → 调 `apply(ctx)`。
2. **注册**：`apply` 内三件事（见 §3 图）：`configForms` 回调式接入（可选能力）、`locale.register`（显式 `ctx.effect`）、槽位注册（`slots.inject` 等槽位声明，天然满足 G5）。
3. **读**：卡片经 `configForms.get('dsh-ppt-master-wrapper')`（命名空间＝loader 条目 id）取快照，**必读字段**：`status`（`loading`/`ready`/`unavailable`）、`value`、`revision`、`writable`、`mode`（`host`/`memory`）。
4. **写**：卡片自持暂存态 → 用户点保存 → 组 `ops`（`op:'set'`，`path` 为**嵌套键数组**，如 `['venv','enabled']`）→ `mutate(ops, revision)` → 以宿主回推值为准（不做乐观更新）。
5. **生效**：宿主写 patch → **volatile 快路径**（三叶子全 volatile）→ 只换代 volatile 引用，**不 remount、不重跑 apply**；非 volatile 字段变化才会 `restart()`。故"保存后插件实例重建"的说法**不成立**（V3 由此静态结案）。
6. **profile 层条目**：首次保存时若 profile 无该 id 条目，宿主 config-editor 代建（`index<0` → `document.add({id,name,config})`）；**本机 profile 已存在手工条目** ⇒ 该分支本轮**不可观测**（登记为未覆盖，§9）。`config` 为整体替换语义。
7. **重置**：宿主语义是**删除** `config` 键（全默认时连整行删除）⇒ 卡片"重置"＝把三个叶子 unset/回落继承层，文案须预告这一点。

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
      "@deepseek-ai/dsh-client-ui-plugin-manager"
    ],
    "external": ["react"]
  }
}
```

- **`dsh.client.inject` 的真实语义（Gate 0 R2 更正）**：官方定义为"informational package-name dependencies, **not** Cordis service injection"，**只用于装载排序**；宿主对图内不存在的名字**静默跳过**并照常装载本行（`dsh-client-modules/lib/client.js:656-660`）；强校验只作用于 `dsh.client.external`。⇒ **"依赖边缺失 ⇒ 本半边不被装载、且宿主不报 warn"是错的**，真实后果只是"无排序保证 + 宿主页可能缺席 ⇒ 槽位无人声明 ⇒ 卡片不出现"。保留 `plugin-manager` 这条边的理由＝与官方配置页同形 + 顺序保证（不再声称有"代价"）。
- **`external` 必须声明 `react`**：`require` 非基线模块需由 `external` 授权，否则到达被跳过、报 `missed the module table…` 并**冒泡出页**（`client.js:705`）。`react` 是否已在种子表由实现期实测确认；若实测为基线，则本条随之删除并在 §8 登记结论（V5）。〔勘误 V5′（2026-10-16 计划期实测＋监督者裁决）：本机六个已装客户端插件（dsh-context / dsh-mnemon / dshmarket / dsh-better-sidebar / dsh-mcp-connector / dsh-cherry-bridge）无一声明 `external`，而 `dsh-context`/`dsh-mnemon` 的 bundle 内确有 `require('react')` 系且正常装载 ⇒ `react` 系为平台种子词（基线）。裁决＝**保留 `external: ["react"]` 声明**（对种子词为无害显式冗余，兼防未来宿主种子表收缩；§7.2 的"声明存在"断言维持），本条"必须"降级为"防御性保留"。〕
- **不 require 任何 Harness 客户端包**：官方 `practices.md:35` 明令 *"Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module"*（理由：无类型检查、随时变更、组件抛错清空整个槽位）。⇒ 控件**自绘**，只使用 `--dsw-alias-*` CSS token 与自带样式。`configForms` 等服务经 **Cordis 服务**接入（不是 require）。

### 5.2 客户端文件契约（`lib/client.js`）

- 形态：自包含单文件，顶层 `window.__ModuleLoader__.load({ id: 'dsh-ppt-master-wrapper', factory: (require) => { … return module.exports } })`；`id` ＝包名。**无** `import`/`export` 语句。
- **require 白名单**：仅 `react`（及其 `react-dom` / `react/jsx-runtime`，若需要）。**不得 require 任何 `@deepseek-ai/dsh-client-*` 包**（§5.1）。元素构造用 `require('react').createElement`（不依赖 JSX 转换）。
- **被当作 cordis 插件装载**：`module.exports` 须导出 `inject`（**服务名**）与 `apply(ctx)`；`factory(require)` 本身拿不到 `ctx`。
  - 硬依赖（列入 `inject`）：`'slots'`、`'locale'`。
  - **可选能力**：`configForms` 走 **`ctx.inject(['configForms'], cb)` 回调式**接入（不得列入硬 `inject`）——硬注入会让"缺服务"时 `apply` 直接不执行、宿主以 `pending (waiting for service…)` 上报（不是安静降级），并让守卫成死代码。缺 `configForms` ⇒ **configForms 接入不注册**（槽位注册本身照常，卡片显示不可用态，§6）。
- **注册与生命周期**：
  - `slots.inject` / `slots.register` **内部已是 fiber 作用域**（宿主 renderer 侧实现），无需再包 `ctx.effect`；
  - 需**显式** `ctx.effect` 的只有：`locale.register`（返回 disposer；同名 `(ns, locale)` 重复注册**直接抛错**）与卡片对表单控制器的 `subscribe`；
  - 卡片由槽位渲染器实例化，**作用域来源**＝`apply` 闭包捕获的 `ctx`（`configForms` 为模块级单例服务），设计明写此点；
  - 异常隔离**收窄到单个注册点**（各自 try/catch + warn），不得在 `apply` 外层整体 try/catch；`apply` 与槽位渲染**各自**有边界兜底。
- 槽位键＝**包名**（`plugins.bundle.config` 的键语义）。**部署前提**：条目 id 必须＝包名（本包 `cordis.patch.yml` 已如此）；实现期以 `configForms.describe()` 的 served-namespace 目录解析 ns 兜底。
- locale 命名空间：`dsh-ppt-master-config`。

### 5.3 卡片 UI

| 区域 | 内容 | 语义要点（文案必须说清后果） |
|---|---|---|
| 启用开关 | `venv.enabled` | 关＝用系统 `python3`，**且不删除任何目录**（清理纯手动）；关闭态文案要让"依赖已就绪的容器用户"一眼判断"这项不需要开"；用 `role="switch"` + `aria-checked` |
| 路径 | `venv.path` 文本框 | 绝对路径或 `~` 前缀（`~` 按宿主进程 HOME 展开）；**非法路径不由 schema 拦**——宿主保存照常成功，插件侧按"配置无效"降级（venv 视为关闭并在应用期 `console.warn`），卡片文案须预告 |
| 旧路径处理 | `venv.oldPathPolicy` 选择器 | `keep`＝保留旧 venv 待手动清理（默认）；`delete`＝下次环境准备成功后删除**带所有权标记**的旧目录 |
| 版本信息 | 只读文本块 | 插件版本 / ppt-master 上游版本 / 固定相对尾部 `<包根>/skills/ppt-master`（两版本号＝客户端常量，两条配对断言防漂移） |
| 保存 / 重置 | **卡片自持**（bundle 槽不带 `form`，页面也无保存控件） | 控件**自绘**：按官方 practice **抄宿主 markup/CSS/行为**（类名加本插件前缀、只引用 `--dsw-alias-*` token、保留焦点与 Escape 等用户依赖行为），**不 require 任何 Harness 客户端包**；保存发 `mutate(ops, revision)`，`path` 用嵌套键数组；"重置"＝unset 三叶子（回落继承层），文案预告"宿主会删掉 config 键" |

### 5.4 版本信息的取数（V1 已闭：注解**不可达**）

宿主 `describe()` 下发的命名空间 `schema` 是 `volatileForm(Config).toJSON()`，该函数重建对象、只保留 volatile 叶子，根 description（版本三元组）被丢弃；`ConfigFormSnapshot` 亦无 schema ⇒ 版本信息只能来自**客户端常量**（随包发布），并以**两条配对断言**防漂移（Gate 0 R2 更正，原写法字面不成立）：

1. 插件版本常量 ≡ `package.json.version`（如 `6.7.0-r2`）；
2. 上游版本常量 ≡ `skills/ppt-master/SKILL.md` 的 `metadata.version`（如 `6.7.0`）；
3. 归一化规则：插件版本允许 `-rN` 后缀，比较时按"上游版本 + 可选 `-rN`"配对，不做三值相等。

**D1（已裁决 2026-10-16）**：显示 插件版本 + 上游版本 + 固定相对尾部 `<包根>/skills/ppt-master`；**不显示绝对 SKILL_DIR**（别的机器上必然错），**不新增下发通道**。

### 5.5 写路由：自绘控件 + 嵌套 volatile path（M2 重审结论，用户 2026-10-16）

**M2 暴露的事实（成立，保留；证据来源＝R2 落地视角对宿主前端产物 `dsh-web-frontend` 内 `ui-primitives` 实现的转述——本机未安装 `ui-primitives` 包，无法直接复核；但本行已非承重，结论由下段"禁 require"支撑）**：官方 `SettingsFormModel` 只能寻址**顶层键**（`sectionValue(field) = value[field]`、`plan()` 产出 `path:[field]`、`stored()` 亦按顶层），照它渲染嵌套 `{venv:{…}}` 会读恒空、写必被拒。**若走该模型，非拍平不可。**

**M2 重审的翻转依据**：`SettingsFormModel`（及 `SettingsForm`/`SettingsValueField`）**住在 `@deepseek-ai/dsh-client-ui-primitives` 内**（官方配置页 `dsh-client-ui-settings-agent-loop` 第 104 行即 `require("…dsh-client-ui-primitives").SettingsFormModel`），而官方 `practices.md` 明令 *"Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module"* ⇒ 该模型对本插件**不可用**，"扁平兼容"这条好处归零；控件两种方案都得自绘。

**裁决（用户 2026-10-16）**：**维持既有嵌套 schema**，改成"卡片自持暂存态 + 手写嵌套 path 的 ops"。宿主侧已实证支持：

- `applyPathOp(section, op, schema)` 把 `op.path` 当键数组逐层套用，并按 schema 节点逐层取 `meta.default`（`dsh-settings/lib/index.js:189-216`）；
- `isVolatilePath(schema, path)` 逐层递归 `schema.dict[key]`，**叶子 volatile 即放行**（同文件 `:153-158`）——本插件三叶子逐个 `.volatile()`，故 `path:['venv','enabled']` 合法；
- 读侧由卡片直接取 `value.venv.enabled` 等（快照 `value` 是普通对象）。

**因此本特性的改动面（取代拍平方案）**：

| 面 | 变动 |
|---|---|
| `lib/client.js` | 新增（卡片自持暂存；`ops.path` 用嵌套键数组） |
| `package.json` | 仅加 `exports["./client"]` + `dsh.client` |
| 宿主半边（`index.js`/`lib/venv.js`/`lib/tools.js`/`lib/skill-provider.js`） | **冻结** |
| 既有测试的形状与字段断言（`tests/*.test.mjs`，含 `venv` 形状者如 `apply` / `compat` / `skill-provider` / `tools-check-env` / `tools-info` / `tools-setup-deps`） | **零改动** |
| compat 脚本 | 仅**新增** §7.7⑥（既有断言不回归） |
| README | 补卡片路径、重启边界、memory 模式提示（配置写法与键名不变） |
| profile `cordis.patch.yml` 既有条目 | **无需迁移**（键名未变） |

**登记的取舍（偏离官方"扁平才好用官方表单"惯例）**：本插件的 Config 保持嵌套分组，理由是官方表单模型被禁 require 后该惯例失去工具支撑，而嵌套与插件内部语义单元（注入袋 `venv` 对象、三个纯函数签名、工具 payload）一致，且避免破坏性配置变更。代价＝卡片必须自写 ops 组装与读值路径（约十余行），已在 §7.1 立断言。

## 6. 错误处理与降级

| 情形 | 行为 |
|---|---|
| 宿主不认 `dsh.client`（老版本） | 该字段为惰性元数据，宿主半边照常；浏览器不加载任何东西 |
| `dsh.client.inject` 里某个包不在图内 | **不阻断装载**（静默跳过该边），仅失去排序保证；若宿主页缺席 ⇒ 槽位无人声明 ⇒ 卡片不出现（与"未装载"不同） |
| `dsh.client.external` 未声明 `react` | `require` 命中不了模块表 → 报 `missed the module table…` 并**冒泡出页**（§5.1 已声明；V5 实测确认） |
| 硬服务（`slots`/`locale`）缺失 | `apply` **不被调用**，宿主以 `pending (waiting for service…)` 上报——**不是**本插件能"安静降级"的形态（§5.2 已按此更正，不再声称"不报错"） |
| `configForms` 缺席（可选能力） | 回调不触发 ⇒ **该接入不注册**；槽位注册照常，卡片渲染为不可用态 |
| 单个注册点异常（字典/槽位/订阅） | 该点 try/catch → warn，**不影响其余注册点** |
| `apply` 二次执行 | 几乎不发生（volatile 保存**不 remount**）；真实触发只剩客户端 bundle HMR；回收顺序由宿主保证（`fiber.dispose → await inertia → entry.refresh()`） |
| 命名空间未就绪 | 快照 `status === 'unavailable'`（未暴露给本客户端）或 `'loading'`；二者不混用同一文案，卡片显示不可用态且不报错 |
| 保存失败（**按可观测量分两类**） | ① `mutate` resolve **false**（宿主拒绝、memory 模式、以及**被更高优先级 patch/CLI overlay 覆盖**——后者经网关折成 `{ok:false}`、控制器**丢弃 error**，卡片边界无法与普通拒绝区分）；② Promise **reject**（传输失败）。⇒ 卡片按这两类呈现，"被覆盖"只在文案里给一般化提示（"若保存未生效，可能存在更高优先级的配置层"），**不得**声称能分辨第三种成因 |
| `mode === 'memory'`（非回环浏览器） | 写**永不落盘**（`enqueue` 直接 false）⇒ 卡片必须显式提示"本次会话不会写入宿主配置"（受众多为远程 GUI，静默失效不可接受） |
| volatile 提交失败 | 宿主 warn，**沿用旧值**（不再有"Loader 重建失败"这一说法） |
| 版本常量与包版本不一致 | 依 §5.4 两条配对断言，测试期拦截 |

## 7. 测试策略

1. **客户端半边单测**（`tests/client-half.test.mjs`，新增）：
   - stub `globalThis.window.__ModuleLoader__` 收集 `{id, factory}`；以**假 `require`**（只提供 React stub）调用 `factory` → 断言 `typeof apply === 'function'`、`inject` 恰含 `slots`/`locale`（**不含** `configForms`）；**静态断言无 Harness 客户端包 require**。
   - 假 `ctx` 调 `apply(ctx)`：断言 `slots.register` 的槽位名/键/locale ns、字典 `zh`/`en` **键集合相等**、`configForms` 经 `ctx.inject` 回调接入。
   - 写路径：① `ops`/`revision` 透传；② 不做乐观更新；③ 两类可观测量各一例（resolve false / reject），并对"被更高优先级覆盖"断言只给一般化提示（不声称可分辨成因）。
   - **ops 形状（M2 重审面）**：改字段后断言 `mutate` 收到的 `path` 为**嵌套键数组**——`set` 用 `['venv','enabled']` / `['venv','path']` / `['venv','oldPathPolicy']`；**重置**用 `{op:'unset', path:['venv',<leaf>]}`（同一嵌套风险面，须各一条断言）。
   - `status`：`unavailable` 与 `loading` 两态各一例。
   - `mode === 'memory'`：断言出现"不写入宿主配置"提示。
   - 生命周期：断言 `locale.register` 与订阅的 disposer 被回收、dispose 后再 `apply` 不抛（**不断言**"三个注册点都经 ctx.effect"——`slots` 侧内部已 effect，该断言会误伤正确实现）。
   - 守卫路径：缺 `configForms` → 不注册、不抛。
   - 常量防漂移：两条配对断言（§5.4）+ `-rN` 归一化。
   - 文案断言：关闭态/路径无效/重置三项文案各一条渲染树文本断言。
2. **静态契约断言**：`lib/client.js` 无 `import`/`export`、require 白名单＝react 系（**无 Harness 客户端包**）、`package.json` 的 `exports["./client"]`/`dsh.client.platform === 'web'`/`external` 声明存在、`files` 覆盖 `lib/client.js`。
3. **compat 脚本扩展（spec §7.7⑥）**：按 §7.1 stub 形态装载 `lib/client.js` 并断言注册面成立（与既有 spec §7.7⑤ 同风格；编号属 2026-10-15 篇 §7 第 7 项，本设计沿用并登记该篇"五项→六项"字样回写）。
4. **渲染冒烟（R2 更正）**：元素树断言测不到渲染期异常（`SlotAssemblyError` 会冒泡出页、非该类才被吞成占位）⇒ 冒烟改为**真实 outlet 挂载一次**（种子表 + 最小 host），或断言"不产生 `SlotAssemblyError` 触发条件"。
5. **宿主半边零回归（§5.5）**：`index.js` / `lib/venv.js` / `lib/tools.js` / `lib/skill-provider.js` 与既有测试文件（含 `venv` 形状与字段断言者）**零改动**；全量 `node --test tests/*.test.mjs` 全绿；`check-dsh-compat` OK（既有断言不回归，仅新增 §7.7⑥）；`verify-plugin --upstream` OK（vendor `skills/` 字节零漂移）。
6. **手工验收**：见 §9。

## 8. 风险与未知

| # | 项 | 状态 / 处理 |
|---|---|---|
| D1 | 版本信息形态 | **已裁决**：常量两版本 + 相对尾部（§5.4） |
| D2 | 首次装载须重启宿主 | **已裁决**：实现后由用户重启容器一次。**实证更正**：宿主半边代码**已**在 2026-10-16 12:16:43 那次重启装载（`index.js` 09:38:34、`skill-provider.js` 09:39:31、`venv.js` 10:44:58、`tools.js` 11:06:06，均 **< 12:16:43**）；venv 配置条目为 2026-10-16 手工写入、**晚于**该次启动（内容至今未变，文件 mtime 后续有变动） ⇒ 下一次重启只交付：**venv 配置生效** + **客户端半边首次装载** |
| V1 | 版本注解可达性 | **已闭**：不可达（§5.4） |
| V2 | `inject` 是否需列 `ui-slots`/`ui-primitives` | **已闭**：二者为前端静态种子模块，且按官方 practice **不得 require**（§5.1） |
| V3 | 保存是否热生效 | **已静态结案**：volatile 快路径，不 remount；volatile 引用原地换代 |
| V4 | 手写半边能否被真实 Loader 接受 | 先 stub 断言（§7.1/§7.3），再真实页面装载验证（§9 步骤 1） |
| V5 | `react` 是否已在种子表（决定 `external` 是否必需） | 已实测＝**基线**（种子词）；裁决**保留声明**（见 §5.1 勘误 V5′） |
| R1 | 老宿主无该槽位 | G5 安静降级 + README 说明；**宿主下限**：客户端半边依赖 rc.2 契约，`dsh.engines.dsh` 仍写 `>=0.1.1-rc.1` ⇒ 由 §9 验收步骤 5 登记"实测通过版本＝0.2.0-rc.2" |
| R2 | 双语字典漂移 | 单测断言键集合相等 |
| R3 | 卡片影响插件页稳定性 | 守卫 + 单点 try/catch + 不注册优先；注意 `SlotAssemblyError` 会冒泡（§7.4） |
| R4 | 依赖宿主私有种子表/内部形态（CSS token、`configForms` 快照字段）的稳定性 | 官方 practice 已警示"随时变更" ⇒ 只依赖**公开服务与 CSS token**，不 require 其模块；变更只影响外观与卡片可用性，不影响配置协议 |
| R5 | 嵌套 schema 与官方"扁平才好用官方表单"惯例不一致 | **已裁决（M2 重审）**：官方表单模型因禁 require 不可用，故维持嵌套；代价＝卡片自写 ops/读值路径，由 §7.1 断言覆盖（§5.5） |

## 9. 文档与发布 / 验收期人工步骤

- README：配置指引**键名不变**（`venv.enabled` / `venv.path` / `venv.oldPathPolicy`）+ 新增"插件页卡片可用性"+ **重启边界**（改 `dsh.client`/`exports["./client"]` 需重启；仅改 `lib/client.js` 免重启，stat 轮询约 500ms）+ memory 模式提示。
- spec（2026-10-15 篇）：① ㉗ 的"GUI 出页属新特性"追加指向本篇链接；② **回写 §7.7"五项→六项"字样**；③ **回写机制措辞**：该篇 §4.1 与 §6.1② 的"配置变更经宿主 config-editor → **Loader 重建插件实例**（无条件热生效）"已被 volatile 快路径推翻（三叶子全 volatile ⇒ 只换代 volatile 引用、不 remount）——按 ㉘ 的写法补记该更正。键名与 schema 不变，无需改 §5.1 等。
- **发行待办（不在本特性范围，登记于此免遗漏）**：① `package.json` 缺 `repository`；② 无 npm 发布流程与发布前检查（`files` 已覆盖 `lib/client.js`）；③ 版本号递增随下次上游 sync（`-rN`）。
- 验收期人工步骤（**D2：实现完成后由用户重启容器一次**）：
  1. 重启后打开插件页 → 「已安装」→ `dsh-ppt-master-wrapper` → 包详情页出现配置卡片（三字段 + 版本信息块）；
  2. 界面语言中/英各看一次，文案随之切换；
  3. 改 `venv.enabled`（或 `venv.path`）保存 → 核对 `ppt_master_check_env` 的 `venv.enabled` 转 `true`、`path` 为所配值；观察是否**免重启**换代（预期：volatile 原地换代，无需重启）；记录 profile patch 写入形态（改 config / 删条目）；
  4. 降级验证：**"宿主页缺席"形态**（若可得）⇒ 卡片不出现但插件功能正常；本机不可得则登记**未覆盖**；
  5. **登记项**：① 未覆盖——"宿主代建 profile 条目"分支（本机已有手工条目 ⇒ 只会就地更新，不可观测）；② 未覆盖——"老宿主不认 `dsh.client`"（无旧宿主环境）；③ 已覆盖——"实测通过宿主版本＝0.2.0-rc.2"（对应 §8 R1 的宿主下限登记）。
- 迭代面：首次装载后，改 `lib/client.js` 走 stat 轮询热更新（免重启）；改 `dsh.client`/`exports` 需再重启。

## 10. 排除范围（明确不做）

- 实时状态面板、依赖计数、"准备环境"按钮。
- 任何新 RPC / remote 命名空间 / 宿主侧新导出面（"解冻宿主半边另开下发通道"已由 D1 否决）。
- **require 任何 Harness 客户端包**（含 `ui-primitives`/`ui-slots`/`ui-settings`）——官方 practice 明令禁止。
- 构建链（tsdown/rollup/esbuild）、TypeScript、JSX、`.d.ts` 产物。
- companion 客户端包、`plugins.item` 官方命名空间条目。
- venv 判定/副作用/工具 payload 的语义变更，以及**配置 schema 的键名与层级变更**（§5.5 维持嵌套）。
- 发行元数据补全与 npm 发布流程（§9 发行待办）。
