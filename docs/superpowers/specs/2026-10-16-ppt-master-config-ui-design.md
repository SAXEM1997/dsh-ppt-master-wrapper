# 设计：ppt-master 插件配置页（客户端半边）（2026-10-16）

> 承接 2026-10-15 的 venv 特性。**触发**：验收期实测发现「纯宿主插件不出配置页」——宿主侧 volatile 投影与 settings 命名空间均已就绪，但插件页槽位无渲染者（见 `docs/superpowers/specs/2026-10-15-ppt-master-venv-config-design.md` §5.1 勘误 ㉗）。本设计为该 Config 补一个**浏览器半边**，把 venv 三项配置与版本信息做成插件页上的原生表单。
> 澄清真相源：`docs/superpowers/clarifications/2026-10-16-ppt-master-config-ui.md`。
> **修订记录**：（1）2026-10-16 builder check 后——§5.2 的装载契约、§4.1/§5.3 的写控件归属、§5.4 的注解可达性、§8 的未知项均按宿主源码实证重写；**D1/D2 已于同日经用户裁决**（D1＝版本信息取常量两版本＋相对尾部；D2＝实现完成后由用户重启容器一次验收）。（2）2026-10-16 Gate 0 审查后——补注册生命周期与写路径测试、修 §8/§9 陈旧的"重启交付物"表述、`dsh.client.inject` 依赖边失败面登记、发行待办归位。

## 1. 概述与动机

插件 `dsh-ppt-master-wrapper` 装在不同环境里：容器用户依赖已齐、venv 关着即可；裸机 `dsh` 用户面对 PEP 668 外管的系统 Python，需要 venv 隔离；而 venv 该放哪儿（盘位、持久性、挂载卷）只有用户自己知道。**受众是插件的其他使用者，不是本机操作者**——他们多半不会读 README，所以"可配"必须落在插件页上：能改路径、能开关、能决定改路径后旧目录怎么办，并能看到版本信息。

宿主侧早已备好配置通道（`Config` 三叶子 volatile + `dsh-settings` 命名空间投影），缺的只是"渲染者"。本设计补上渲染者，**不改宿主半边行为**。

## 2. 目标 / 非目标

**目标**
- G1 插件页出现配置卡片，可读可写 `venv.enabled` / `venv.path` / `venv.oldPathPolicy`（保存走宿主既有配置通道）。
- G2 卡片显示版本信息：**插件版本 + ppt-master 上游版本 + 固定相对尾部 `<包根>/skills/ppt-master`**（两版本号取客户端常量，以断言与 `package.json.version` / `skills/` 元数据对齐；**不显示绝对 SKILL_DIR**——见 §5.4 D1 裁决）。
- G3 中英双语，跟随宿主界面语言。
- G4 全链路零新增 npm 依赖、零构建链：浏览器半边为**手写自包含单文件**（宿主种子模块可 require，不计入 npm 依赖）。
- G5 宿主不支持/服务缺失时**安静降级**：纯宿主半边行为零变化，插件页不因本卡片崩。

**非目标**
- venv 实时状态显示（是否已建/就绪/依赖计数）——用户明确不要；状态仍由 agent 侧 `ppt_master_info` / `ppt_master_check_env` 承担。
- 卡片内"准备环境"按钮或任何写副作用操作（venv 创建/删除仍**只**发生在 `ppt_master_setup_deps`）。
- 新宿主↔页面 RPC 面、typert remote、自研页面。
- 引入打包器/构建步骤，或把 React 打进产物。
- 改动 `index.js` / `lib/venv.js` / `lib/tools.js` / `lib/skill-provider.js` 的既有行为（宿主半边行为冻结）。
- 本特性内做发行元数据补全（`repository` 等）与版本号递增（沿用规则：随下次上游 sync 递增 `-r`）。

## 3. 架构

```
浏览器（插件页 @deepseek-ai/dsh-client-ui-plugin-manager）
  renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: 'dsh-ppt-master-wrapper' })
        │  注意：bundle 槽【只发 view:'page'】且【不带 form】，form 由卡片自取
        ▼
  lib/client.js（本特性新增；被宿主 vendored cordis Loader 当插件装载）
        │  exports.inject = ['slots', 'locale', 'configForms']；exports.apply(ctx)
        │  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({name, key, locale}, Card))
        │  ctx.locale.register('dsh-ppt-master-config', { zh, en })
        ▼
  卡片内：configForms.get('dsh-ppt-master-wrapper') → ConfigFormController（自持 save/discard 控件）
        ▼
  宿主 settings RPC → dsh-settings → config-editor edit() → 写 profile cordis.patch.yml
                    → reconcileProfilePatches → Loader 重建插件实例
                    → 入口 skill 正文 / 工具行为换代（是否热生效＝验收期实测项，V3）
```

组件划分：

| 组件 | 职责 | 变更 |
|---|---|---|
| `lib/client.js` | 浏览器半边：导出 cordis 插件（`inject`/`apply`），注册槽位与字典、渲染卡片、自持保存/重置 | **新增** |
| `package.json` | `exports["./client"]` + `dsh.client` 声明 | 修改（`files` 已含 `lib`，无需改） |
| `index.js` / `lib/*.js`（宿主半边） | 提供 Config 与工具 | **冻结**（零改动） |
| `tests/client-half.test.mjs` | 客户端半边单测（stub 装载 + 契约断言 + 文案键集合） | 新增 |
| `scripts/check-dsh-compat.mjs` | 扩一项"客户端半边可被 stub 装载并注册" | 修改 |
| `README.md` | 配置入口一节补"插件页卡片"路径与首次装载需重启的说明 | 修改 |

## 4. 数据流

1. **装载**：页面加载 → `dsh-client-modules` 按 `dsh.client` 声明把 `lib/client.js` 作为浏览器半 cordis 插件装载（`load({id})` 的 id **必须等于包名**，否则报 "loaded without registering"）→ Loader 等 `inject` 的三个服务就绪 → 调 `apply(ctx)`。
2. **注册**：`apply` 内 `ctx.slots.inject('plugins.bundle.config', …)`（等槽位声明，天然满足 G5：宿主无此槽位则不注册、不报错）；`locale.register` 注册双语字典。槽位注册项带 `locale` 选项，宿主渲染时自动把 `t` 注入卡片 props（无需 `inject: () => ({t})`）。
3. **读**：卡片挂载时 `configForms.get('dsh-ppt-master-wrapper')` 取表单控制器（命名空间＝loader 条目 id），读其快照（值 + revision + writable/mode）填充控件。
4. **写**：卡片自持保存/重置控件（见 §5.3）→ `mutate(ops, revision)` → 宿主写入 → 以宿主回推值为准（不做本地乐观更新）。
5. **生效**：宿主保存后经 config-editor → profile patch → Loader 重建；是否免重启见 V3。
6. **profile 层条目自动建立**：若 profile `cordis.patch.yml` 尚无 `id: dsh-ppt-master-wrapper`，首次保存时由宿主 config-editor 代建（`index<0` → `document.add({id,name,config})`）——上一特性「验收期人工步骤 ③」的手工动作在此变为自动；手工条目与该通道等价，先写者为准（`config` 整体替换语义）。

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

`dsh.client.inject` 是**包图边**（运行期必须存在的宿主客户端包），与模块自身的 `inject`（**服务名**）是两回事。实证（V2 已闭）：`@deepseek-ai/dsh-client-ui-slots` 与 `…-ui-primitives` 属前端**静态种子模块**（`dsh-web-frontend` 的 `staticModules`），require 即可、**不必**列入 `inject`，也不进 npm 依赖。`@deepseek-ai/dsh-client-ui-plugin-manager` 这条边保留的理由＝与官方配置页（`…-settings-agent-loop`）同形态，确保宿主页在场；代价是**依赖边缺失时本半边不会被装载、且宿主不报 warn**（见 §6）。

### 5.2 客户端文件契约（`lib/client.js`）

- 形态：自包含单文件，顶层 `window.__ModuleLoader__.load({ id: 'dsh-ppt-master-wrapper', factory: (require) => { … return module.exports } })`；`id` ＝包名。**无** `import`/`export` 语句、**无**第三方包名 require（白名单见 §7.2）。
- **被当作 cordis 插件装载**（不是"factory 内直接注册"）：`factory` 返回的 `module.exports` 必须导出 `inject`（服务名数组，含 `'slots'`、`'locale'`、`'configForms'`）与 `apply(ctx)`；`factory(require)` 只拿 `require`，`ctx` 由 Loader 在服务就绪后传入。宿主 bootstrap 断言 `typeof exports.apply === 'function'`。
- 元素构造：`require('react').createElement`（不依赖 JSX 转换）。样式/控件优先用种子模块 `require('@deepseek-ai/dsh-client-ui-primitives')`（宿主设计语言一致；不进 npm 依赖）。
- 注册面（`apply` 内）：
  - `ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-ppt-master-wrapper', locale: 'dsh-ppt-master-config' }, Card))`
  - `ctx.locale.register('dsh-ppt-master-config', { zh, en })`（任意 ns，仅校验 BCP-47 标签）
- **注册生命周期（Gate 0 补）**：`slots.register`、`locale.register` 与卡片对表单控制器的订阅都返回 disposer ⇒ **一律用 `ctx.effect(...)` 绑定到 fiber 作用域**，随宿主卸载/重载一并回收；`locale.register` 对重复的 `(ns, locale)` **直接抛错** ⇒ `apply` 二次执行（宿主重载/热更新）必须靠 effect 回收后的干净状态注册，不得依赖"重复注册幂等"。
- **try/catch 粒度（Gate 0 补）**：异常隔离**收窄到单个注册点**（每个 register/subscribe 各自 try/catch + warn），不得在 `apply` 外层包一个整体 try/catch——否则一次字典注册失败会连带跳过其后的槽位注册，表现为"卡片整块消失、只留一行 warn"。
- 槽位键＝**包名**（`plugins.bundle.config` 的键语义），与 settings 命名空间同串（条目 id = 包名）。
- locale 命名空间：`dsh-ppt-master-config`。
- 守卫：服务/槽位缺失 → 不注册 + 一行 `console.warn`；`apply` 与渲染全程 try/catch，异常只 warn 不外抛。

### 5.3 卡片 UI

| 区域 | 内容 | 语义要点（文案必须说清后果） |
|---|---|---|
| 启用开关 | `venv.enabled` | 关＝用系统 `python3`，**且不删除任何目录**（清理纯手动）；**关闭态文案要让"依赖已就绪的容器用户"一眼判断"这项不需要开"**，而不是只写"false/关闭" |
| 路径 | `venv.path` 文本框 | 绝对路径或 `~` 前缀（`~` 按宿主进程 HOME 展开）；**非法路径不由 schema 拦**——宿主保存照常成功，插件侧按"配置无效"降级（venv 视为关闭并在应用期 `console.warn`），卡片文案须预告这一后果 |
| 旧路径处理 | `venv.oldPathPolicy` 选择器 | `keep`＝保留旧 venv 待手动清理（默认）；`delete`＝下次环境准备成功后删除**带所有权标记**的旧目录 |
| 版本信息 | 只读文本块 | 插件版本 / ppt-master 上游版本 / 固定相对尾部 `<包根>/skills/ppt-master`（两版本号＝客户端常量，断言防漂移；不显示绝对路径） |
| 保存 / 重置 | **卡片自持**（bundle 槽不带 `form`，也没有页面级保存控件） | 官方范式＝`SettingsFormModel(configForms.get(ns), fields)` + `SettingsForm`/`SettingsValueField`；`enabled`(boolean) 与 `oldPathPolicy`(enum) 无现成控件，需自绘或自定义 field spec |

### 5.4 版本信息的取数（V1 已闭：注解**不可达**）

实证：宿主 `describe` 下发的命名空间 `schema` 是 `volatileForm(Config).toJSON()`，而 `volatileForm` 会**重建**对象、只保留 volatile 叶子——根 description（`CONFIG_ANNOTATION`，含版本三元组）与 venv 层 description **都被丢弃**；`ConfigFormSnapshot` 也不含 schema。⇒ 卡片**无法**从宿主拿到注解。

因此版本信息只能来自客户端常量（随包发布，与包版本同生命周期），并以断言防漂移：单测/compat 断言客户端常量 ≡ `package.json.version` 与 `skills/ppt-master` 元数据的上游版本。**SKILL_DIR 是本机绝对路径，写成常量对"别的使用者"就是错的** → 形态由 D1 裁决（见下）。

**D1（已裁决 2026-10-16）**：卡片显示 **插件版本 + ppt-master 上游版本 + 固定相对尾部 `<包根>/skills/ppt-master`**。两个版本号取客户端常量，由单测/compat 断言与 `package.json.version` / `skills/ppt-master` 元数据的上游版本保持一致（漂移＝测试红，不留到运行期）。**不显示绝对 SKILL_DIR**（它在别的机器上必然错），**不新增下发通道**（选项 (c) 被否，§2/§10 的"宿主半边冻结"保持封闭）。

## 6. 错误处理与降级

| 情形 | 行为 |
|---|---|
| 宿主不认 `dsh.client`（老版本） | 该字段为惰性元数据，宿主半边照常；浏览器不加载任何东西 |
| `dsh.client.inject` 依赖边缺失（如宿主未装 plugin-manager） | 本半边**不被装载**，宿主**不报 warn**（宿主行为，非本插件可拦截）；README 的验收④与 §9 以该形态做降级验证 |
| 所需服务/槽位缺失 | `slots.inject` 不触发 + 不注册（G5），不报错 |
| 单个注册点异常（字典/槽位/订阅） | 该点 try/catch → warn，**不影响其余注册点**（§5.2 粒度约束） |
| `apply` 二次执行（宿主重载/热更新） | 依赖 `ctx.effect` 回收后的干净状态；`locale.register` 同名重复会抛错，须靠回收而非幂等 |
| 命名空间未就绪 | `configForms.get(ns)` 快照处于未 serve 态（无值）→ 卡片显示不可用态，不报错（与"loading"态区分，二者不混用同一文案） |
| 保存被拒绝 / 被更高优先级 patch 覆盖 | 卡片依表单控制器的 `writable`/`mode`/错误态自行呈现（页面不代劳） |
| 版本常量与包版本不一致 | 单测/compat 断言拦截（构建期问题，不留到运行期） |
| 保存成功但 Loader 重建失败 | 属宿主面；下一次重启生效（与既有兜底一致） |

## 7. 测试策略

1. **客户端半边单测**（`tests/client-half.test.mjs`，新增）：
   - stub `globalThis.window.__ModuleLoader__` 收集 `{id, factory}`；以**假 `require`**（返回 React stub 与 primitives stub）调用 `factory` → 得到 `module.exports`；断言 `typeof apply === 'function'`、`inject` 含三服务名。
   - 以**假 `ctx`**（`slots.inject` 立即回调并记录 `register` 参数、`locale.register` 记录字典、`configForms.get` 返回假控制器）调用 `apply(ctx)`；断言槽位名/键/locale ns、字典 `zh`/`en` **键集合相等**。
   - 渲染冒烟：以 `view='page'` 渲染一次（React 元素树断言，不做 DOM 渲染）；`configForms.get` 返回空快照时不抛。
   - **写路径（Gate 0 补，G1 核心）**：① 改字段后调用 `mutate(ops, revision)` 并断言收到的 `ops` 形态与 `revision` 透传；② 断言**不做乐观更新**（宿主未回推前不改变显示值）；③ 保存被拒（`writable=false`/错误态）与被更高优先级 patch 覆盖（overridden）两种呈现各一例。
   - **注册生命周期（Gate 0 补）**：① 断言三个注册点都经 `ctx.effect` 绑定（fake ctx 记录 effect 调用）且 disposer 被调用后不再残留；② 模拟 `locale.register` 抛错 → 断言槽位注册**仍然完成**（try/catch 粒度）；③ 二次 `apply` 幂等：先 dispose 再 apply 不抛错。
   - 守卫路径：缺 `slots` 或缺 `locale` → 不注册、warn、不抛。
   - 常量防漂移：客户端常量 ≡ `package.json.version` ≡ skills 元数据上游版本。
2. **静态契约断言**（并入 compat 脚本或单测）：`lib/client.js` 无 `import`/`export`、require 白名单（react 系 + primitives + 种子模块）、`package.json` 的 `exports["./client"]` 与 `dsh.client.platform === 'web'` 存在、`files` 覆盖 `lib/client.js`。
3. **compat 脚本扩展（§7.7⑥）**：按 §7.1 的 stub 形态装载 `lib/client.js` 并断言注册面成立（与既有 §7.7⑤ 同风格）。
4. **回归**：既有 527 用例全绿；`check-dsh-compat` OK；`verify-plugin --upstream` OK（vendor `skills/` 字节零漂移）。
5. **手工验收**（§9）：见 D2（首次装载须重启宿主）。

## 8. 风险与未知（实现期须钉死）

| # | 项 | 处理 |
|---|---|---|
| D1 | 版本信息形态（注解不可达、SKILL_DIR 不可为绝对路径） | **已裁决**：常量两版本 + 相对尾部，见 §5.4 |
| D2 | 首次装载须重启宿主，而当前 GUI/会话就在同一进程 | **已裁决**：实现完成后由**用户重启容器一次**。**注意（Gate 0 实证更正）**：宿主半边的新代码**已**在 2026-10-16 12:16:43 的那次容器重启中装载（代码文件最后改动 10:45 < 启动时刻），而 venv 配置 patch 写于 12:26:52、**晚于**该次启动 ⇒ 下一次重启实际只交付两件事：**venv 配置生效** + **客户端半边首次装载**。此后改 `lib/client.js` 走 stat 轮询热更新，无需再重启 |
| V3 | 保存是否**热生效**（config-editor `edit()` 通道在本部署是否重建实例） | 验收期实测并记录（手工 patch 通道已否证） |
| V4 | 手写半边能否被真实 Loader 接受（官方产物经构建链） | 先 stub 断言，再真实页面装载验证；失败按 Loader 报错修正（stub 形态已按宿主源码钉死，残余风险＝未知校验） |
| 已闭 | V1 注解可达性（不可达，见 §5.4）；V2 inject 是否需列 ui-slots（不需要） | — |
| R1 | 老宿主无该槽位 | G5 安静降级 + README 说明 |
| R2 | 双语字典漂移 | 单测断言键集合相等 |
| R3 | 卡片影响插件页稳定性 | 守卫 + try/catch + 不注册优先 |

## 9. 文档与发布 / 验收期人工步骤

- README：配置入口一节补"插件页卡片（有客户端渲染者时）+ profile patch 手工条目（兜底）"，并写明**首次装载该半边需重启 DSH**（此后改动 `lib/client.js` 走 stat 轮询热更新）；GUI 保存是否热生效按 V3 实测结果改写。
- spec（2026-10-15 篇）：㉗ 的"GUI 出页属新特性"一句追加指向本篇链接；不改其结论。
- **发行待办（不在本特性范围，登记于此免遗漏）**：① `package.json` 缺 `repository` 字段；② 无 npm 发布流程/发布前检查（`files` 白名单已覆盖 `lib/client.js`，无需改）；③ 版本号递增按规则随下次上游 sync 处理。
- 版本号：**不递增**（随下次上游 sync 递增 `-r`）。
- 验收期人工步骤（**D2 裁决：实现完成后由用户重启容器一次**；该次重启交付 venv 配置生效 + 客户端半边首次装载——宿主半边代码已于 12:16:43 装载，不必再等）：
  1. 重启后打开插件页 → 「已安装」→ `dsh-ppt-master-wrapper` → 包详情页出现配置卡片（含三字段与版本信息块）；
  2. 界面语言中/英各看一次，文案随之切换；
  3. 改 `venv.enabled`（或路径）保存 → 观察入口 skill 正文 / `ppt_master_check_env` 是否**免重启换代**（记录 V3 结论）；并记录 profile `cordis.patch.yml` 的写入形态（是否为该条目整体替换）；
  4. 卡片在"宿主无该槽位"环境下安静降级（旧宿主或 stub 页面；不可得则记为**未覆盖**并在报告里明说）。
- 迭代面：首次装载后，宿主侧 JS 改动仍**不**热替换（既有实测），但 `lib/client.js` 走 stat 轮询热更新——卡片文案/布局调整无需再重启。

## 10. 排除范围（明确不做）

- 实时状态面板、依赖计数、"准备环境"按钮。
- 任何新 RPC / remote 命名空间 / 宿主侧新导出面（§5.4 的候选方案"解冻宿主半边另开下发通道"已由 D1 裁决否决，此处一并排除）。
- 构建链（tsdown/rollup/esbuild）、TypeScript、JSX、`.d.ts` 产物。
- companion 客户端包、`plugins.item` 官方命名空间条目。
- 宿主半边任何行为改动（含 `Config` schema 与注解格式）。
- 发行元数据补全（`repository` 等）与 npm 发布流程。
