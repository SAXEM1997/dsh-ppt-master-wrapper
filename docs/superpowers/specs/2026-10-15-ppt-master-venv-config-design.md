# 设计：ppt-master venv 隔离 + 插件配置页（2026-10-15）

任务名：`2026-10-15-ppt-master-venv-config` · 模式：中等
需求真相源：`docs/superpowers/clarifications/2026-10-15-ppt-master-venv-config.md`

## 1. 概述与动机

本机实测：DSH 容器内 19 个 Python 依赖 0/19 已装，且系统 Python 为 PEP 668（EXTERNALLY-MANAGED），裸装需 `--break-system-packages` 且装入容器 rootfs（重建即丢）。本设计为包装层引入**可选 venv 隔离**（懒创建、可配置路径、旧路径清理策略）与**原生 schema 配置页**（cordis Config → DSH 设置自动出页，含模块加载期版本注解），并以**包装层自有的入口 skill**（`ppt-master-env`）承担解释器路由——不修改任何上游文件，方案A 字节级 vendor 约束（spec `2026-10-14-dsh-ppt-master-wrapper-design.md` §1.1/§3）继续成立。

## 2. 目标 / 非目标

**目标**
- G1 venv 隔离：`venv.enabled/path/oldPathPolicy` 三配置；懒创建（仅 `ppt_master_setup_deps`）；venv 内安装无 PEP 668 拦截。
- G2 原生配置页：Config schema 注解承载插件版本、上游版本、SKILL_DIR（模块加载期生成）；配置变更经 Loader 热重载即时生效。成立条件：Config 字段声明为 volatile 且宿主 config-editor 编辑通道可用（真实热重载机制见 §4.1/§6.1②）。**【勘误 ㉗/㉘（2026-10-16 验收期实测）】**：本版 DSH（0.2.0-rc.2 本机部署）对该 Config **不出页**——宿主侧 volatile 投影与 settings 命名空间均就绪，但插件页槽位无渲染者（§5.1 ㉗）；且 profile patch **手工编辑不热生效**（§4.1 ㉘）。⇒ 本特性的配置入口＝profile `cordis.patch.yml` 手工条目 ＋ **重启生效**；GUI 出页属**新特性**（须反转 §2 非目标，另立项）；→ **该新特性已立项交付**：`docs/superpowers/specs/2026-10-16-ppt-master-config-ui-design.md`（本包 `dsh.client` 客户端半边）。
- G3 入口 skill `ppt-master-env`：四态正文给出当前解释器契约（最近快照 + 实时工具指引）；description 声明"使用 ppt-master 前必读"。
- G4 工具 venv 感知：`info`/`check_env`/`setup_deps` payload 增量字段；`setup_deps` 独占 venv 创建/删除副作用。
- G5 旧 venv 生命周期：所有权标记 + `wrapper-state.json` 登记上次路径 + `oldPathPolicy`（默认 keep）；删除仅对满足 §5.4 前置（pyvenv.cfg 存在、带标记、路径≠当前且互不**段感知**前缀包含）的目录；条件①②按 **canonical 路径**判定（同一实体与包含关系都按内核语义：先解符号链接、`..` 在已解析的父目录上回退），另以 `dev+ino` 相等作额外正判据。

**非目标**
- 实时状态面板 / 自研前端页（`dsh.client` 范式明确不采用）。**〔勘误 ㉗（2026-10-16 验收期实测）〕** 实测证明"原生 Config 自动出页"在本版对纯宿主插件**不成立**（§5.1 ㉗）——要把 venv 表单做进 GUI，只能反转本条（引入 `dsh.client` 客户端半边或 companion 客户端包），属**新特性**，另行立项；→ **已立项交付**：`docs/superpowers/specs/2026-10-16-ppt-master-config-ui-design.md`（客户端半边反转本条非目标，宿主 config-editor 通道不变）。
- 修改任何上游文件或 served body（vendor 面字节不变）。
- venv 真迁移（stdlib venv 不可重定位——迁移≡新建+重装+可选删旧）。
- venv 内依赖版本锁定；禁用 venv 时的自动删除（纯手动 `rm -rf`）。
- 仅支持 POSIX 布局（`bin/`、`python3`/`pip3` 名）；Windows（`Scripts/`、`python.exe`）不在本特性范围（上游 SKILL.md 自带 python 回退说明）。

## 3. 架构

```
profile cordis.patch.yml（按 id config 整体替换语义）
        │ Loader 组合 → apply(ctx, config)
        ▼
index.js  ── export const Config = z.object({ venv: {enabled,path,oldPathPolicy} })
   │           （模块加载期生成版本注解：插件版本 ← package.json；上游版本 ← skills 扫描）
   ├─ createSkillProvider(roots?, { venv })   skill-provider.js
   │     ├─ vendor 技能（现状：skills/ 树字节原样）
   │     ├─ 合成入口 skill ppt-master-env（body 按四态渲染，内存合成，无文件）
   │     │      └─ lib/venv.js（生效解释器/四态判定原语，与 tools 共用）
   └─ createTools({ skillRoots?, venv?, testSeams? })   tools.js
         └─ lib/venv.js（纯函数 + 注入 run）
              resolveVenvPath / venvExists / marker 读写
              ensureVenv / cleanupOldVenv / wrapper-state 登记
```

组件职责：`lib/venv.js` 承载全部 venv 决策与副作用原语（只提供解释器/pip 路径解析原语，不组装命令——installCmd 的组装、含 venv pip 路径替换，归 `tools.js` 编排层）；`tools.js` 只做探测编排与 payload 组装（`setup_deps` 是唯一调用 ensureVenv/cleanupOldVenv 的地方）；`skill-provider.js` 新增合成入口 skill（四态渲染取 `lib/venv.js` 判定原语，与 tools 共用）；`index.js` 声明 Config 并下传。schemastery 引入通道=宿主 node_modules 定位 + 受控解析（createRequire 等价通道），**禁 ESM 裸导入**（插件以符号链接装载，裸导入在该路径下必然 ERR_MODULE_NOT_FOUND）；零 npm 依赖声明保持。

apply 第二参为**统一注入包**：loader 传入经校验的 config（含 venv 三字段，volatile 叶子为引用对象——apply 入口先按 §5.1 引用语义去引用快照为普通值），测试/嵌入方传 `{skillRoots}`，两键可共存于同一对象，venv 字段缺省=默认值。与**既有 12 处 ＋ 本特性新增（含 §7.7②/⑤ 两处挂载）共 20 处可执行 `apply` 调用**兼容（终态计数：tests 16 ＝ `tests/apply.test.mjs` 14 ＋ `tests/verify-plugin.test.mjs` 2；scripts 4 ＝ `scripts/check-dsh-compat.mjs` 3 ＋ `scripts/verify-plugin.mjs` 1；`tests/compat.test.mjs` 的命中为 fixture 字符串与注释、非调用）：**既有调用形态全部保持兼容**——显式 roots（字面 `{skillRoots}`）、裸 opts、变量形态（`toolOptions`）；skillRoots 键照旧生效，venv 缺省走默认（注入通道异常的降级见 §6.1③）。apply 期降级（配置无效→venv 视为关闭）是**行为层视图**：注入包/Config 保留原始值——入口 skill 渲染读原始配置 + invalidReason 判第四态，工具行为读降级值。

## 4. 数据流

- **4.1 配置变更**：设置页编辑 → 宿主 config-editor `edit()`（分层 profile patch 写入）→ reconcileProfilePatches → Loader 重建插件实例（配置变更**无条件热生效**，hmr 串行化）→ 入口 skill 正文与工具行为随实例重建换代（免 DSH 整体重启）；热重载失败兜底→下次 DSH 重启生效（§6.1②）。配置页注解随插件升级换代（注解于模块加载期烘焙进 schema description，模块缓存内不重求值——不随热重载换代）。机制修正：设置页 `applies:"live"` 标识为宿主 describe 固定输出，真正的可编辑性由字段 volatile 声明决定（§5.1）。**〔勘误 ㉘〕** 上述「无条件热生效」只覆盖 **config-editor `edit()`** 通道；本版无设置页渲染者（㉗），实际操作只能是**手工编辑 profile patch**——实测：写入 `id: dsh-ppt-master-wrapper` 条目后 10 分钟以上，live `ppt_master_check_env` 仍报 `venv: enabled=false`、日志无 reload 记录；宿主侧只读重组（`loadProfileDirectory` + `composeEntries`）确认该条目与 config 会被**下一次启动**装载。⇒ 手工通道＝**重启生效**（§6.1② 的兜底即本部署的常规路径）。**〔勘误 ㉙（2026-10-16 config-ui 特性回写）〕** 本行「reconcileProfilePatches → Loader 重建插件实例」的措辞对**本 Config 不成立**：三叶子全 volatile ⇒ config-editor `edit()` 保存走宿主 **volatile 快路径**（只写 `fiber._config` + `_commitVolatile()` → `loader/volatile-update`，**不 remount、不重跑 `apply`**）；入口 skill 正文/工具行为随 volatile 引用**原地换代**（免 DSH 整体重启）。**键名与 schema 不动**。（2026-10-16 config-ui 特性交付客户端半边后，config-editor 通道本机可用；㉘ 的手工通道结论对**手工编辑**仍成立。）
- **4.2 技能路由**：模型见目录中 `ppt-master-env`（description 声明前置）→ 读入口 → 按生效解释器跑上游脚本（含 SKILL.md 第 2 步 attribution_guard 的字面 `python3` 替换）→ 路由至 `ppt-master`。
- **4.3 环境准备**（`ppt_master_setup_deps`，唯一副作用点）：
   - venv 开：`ensureVenv`（创建/收编/体检前置见 §5.4；缺则 `python3 -m venv <path>` + 写标记；已有则体检通过后收编补标记）→ `<venv>/bin/pip3 install -r ${SKILL_DIR}/requirements.txt` → 成功后 `cleanupOldVenv`（比对 `wrapper-state.json` 登记的上次路径，按 `oldPathPolicy`）→ 更新登记 → 复跑 check_env。
   - venv 关：现行系统模式（`pip3` + 可选 `--user`/`--break-system-packages`）不变。

## 5. 接口

### 5.1 Config schema（index.js 导出；注解即配置页文案）

| 字段 | 类型/默认 | 说明 |
|---|---|---|
| `venv.enabled` | boolean，`false` | venv 隔离开关 |
| `venv.path` | string，`'~/.ppt-master/venv'` | `~` 于使用处按 DSH 宿主进程 HOME 展开；须绝对或 `~` 前缀 |
| `venv.oldPathPolicy` | `'keep' \| 'delete'`，`'keep'` | 路径变更后对旧标记 venv 的处理 |

- **volatile 前提**：三字段均须以 schemastery `.volatile()`（live-editable）标记——这是设置页可编辑投影的前提；未标 volatile 的叶子字段宿主不出页、写入被拒。**〔勘误 ㉗〕** 本版实测：投影侧成立（`dsh-settings.describe()` 为带 volatile 的 profile 条目产出 `ns = 条目 id`、`applies:"live"` 与 schema），但**没有客户端渲染者**——侧边栏「插件」页（`@deepseek-ai/dsh-client-ui-plugin-manager`）只渲染由插件**自带客户端半边**注册的槽位卡片（`plugins.bundle.config` 键＝包名 / `plugins.row.config` 键＝`<包名>#<行id>`；本机注册者仅 dsh-mnemon / dsh-market / dsh-model-sync / dsh-context 各自的自有卡片），官方条目由 companion 客户端包 `configForms.get(<固定命名空间>)` 渲染；纯宿主插件不带浏览器半边（`dsh-cordis-client-runner` 只服务"动态双半包"），故**不出页**。**引用语义（宿主实测）**：`.volatile()` 同时把解析值包装为须 `.get()` 读取的引用对象（叶子级或对象级标注均如此，直接属性读取拿到包装器/undefined），且不两层叠加标注（钉**叶子级**，宿主惯例如 dsh-agent-loop `maxParallelToolCalls`）；因此 **apply 边界统一去引用**——对三个 volatile 叶子各做一次 `.get()` 快照，组装为普通对象后下传 `createSkillProvider`/`createTools`/`lib/venv.js`（下游接口签名一律按普通值，不感知引用）。**落点具名**（`lib/venv.js`）：`snapshotVenvConfig(raw) → { enabled, path, oldPathPolicy }`（逐叶去引用快照）＋组合纯函数 `assembleInjectionBag(raw) → { skillRoots, venv }`（`skillRoots` 原样透传、`venv` 经前者快照，**缺省补默认在此完成**——三默认值 `enabled:false` / `path:'~/.ppt-master/venv'` / `oldPathPolicy:'keep'`）；`apply` 只调该组合函数后下传。
- **引入通道**：Config schema 依赖的 schemastery 经"宿主 node_modules 定位 + 受控解析（createRequire 等价通道）"获取，禁 ESM 裸导入（符号链接插件路径下必然 ERR_MODULE_NOT_FOUND）；插件零 npm 依赖声明保持（解析失败的 fail-loud 语义见 §6.1⓪）。
- **`~` 展开基准**：按 DSH 宿主进程 HOME 展开（Node `os.homedir()` 实测语义：**HOME 为空串时返回空串、不回退**——该输入下 `~` 展开判无效走 §6 配置无效降级；仅 HOME **未设置**才回退 passwd 目录/getpwuid）；"与上游 config.py 的 `Path.home()/.ppt-master` 同一基准"仅 HOME 非空时成立（空串边界 Node/Python 行为分叉：Python `Path.home()`→`'/'`）；降级分支在解析结果非法（空/相对/空串 HOME）时触发（走 §6 配置无效降级）；本机容器 HOME=/root → 默认路径解析为 `/root/.ppt-master/venv`。
- **默认路径理由**：`~/.ppt-master/venv` 兼顾非容器 DSH 用户的通用性，贴合上游 `~/.ppt-master/.env`（USER_ENV_FILE）目录惯例；容器用户宜显式配置到挂载卷（如 `/dsh-home/.ppt-master/venv`）。**挂载卷边界**：挂载只保证数据不丢；跨容器重建后 venv 可用性依赖镜像不变（venv 内符号链接指向容器内绝对路径）；损坏恢复=删除重建（§6「venv 存在但体检不通过」行）。
- **发现通道**：不调用 `ctx.settings.configure()`，沿用宿主 auto 出页默认策略——被发现的配置项按默认策略处置。**〔勘误 ㉗〕** 该 auto 出页在本版对纯宿主插件**无渲染者**（同上），配置入口以 profile patch 为准。
- **编辑期校验闭环**：路径形状约束（绝对或 `~` 前缀）不在 schema 层声明（schemastery 无法表达路径谓词），接受"可保存非法值"；可见反馈通道=入口 skill"配置无效"态 + check_env 的 `venv.path=null` 提示（不依赖宿主控制台 warn），warn 仅作日志补充。

配置页版本注解：插件版本（package.json）、上游 skill 版本（skills 扫描 `metadata.version`）、SKILL_DIR——模块加载期求值并烘焙进 Config schema description（模块缓存内不重求值），随插件升级（版本变化→模块重载）换代。

### 5.2 入口 skill `ppt-master-env`

- name：`ppt-master-env`；description：中英双语，声明"任何 ppt-master 路由前必须先读本入口：它给出当前生效解释器与准备状态"。
- body 四态（实例注册期按 config + 文件系统快照渲染。新鲜度定案：provider 工厂仅在注册期调用一次、技能数组注册期冻结——源码事实；故正文=插件实例生命周期的实例注册期快照，配置变更经热重载重建实例→正文随之换代；文件系统变化（如 venv 被外部删除）后正文可能陈旧→正文固定脚注指向 `ppt_master_info`/`ppt_master_check_env` 实时查询，`setup_deps` 执行后以工具输出为准）：
   1. venv 开+已建**且就绪**（就绪＝解释器 `<path>/bin/python3` 与安装路径 `<path>/bin/pip3` **两者都可用**，与 §5.4 收编体检同一两问判据；`<path>`＝解析后绝对路径）：解释器 = 该绝对路径，一切上游脚本调用一律以它替换字面 `python3`；给出 SKILL_DIR；读毕即路由 `ppt-master`。
   2. venv 开+未建：先调用 `ppt_master_setup_deps` 准备环境；在此之前不以系统 python3 跑业务脚本。
   3. venv 关：系统 `python3`（现状）。
   4. 配置无效（相对路径）：指明修正方式，按系统模式继续。
- 四态说明：第四态（配置无效）为 §6 无效配置降级在入口 skill 面的对应文案——超出澄清时的三态，但同源于已确认的错误处理决策；invalid×disabled 组合落态 3（disabled 优先，见 §5.3 组合细则）。**破损子态归属（`on-ready` + `broken`，即目录在而就绪判据不成立——解释器不可用，或为有 `bin/python3` 而缺 `bin/pip3` 的半成品，同一两问判据见 §5.3）**：本四态未单列该子态，正文按**态 2** 渲染（无可用解释器路径可替换，故不适用态 1 的替换契约；`ppt_master_setup_deps` 会以"手动删除该目录后重跑"的恢复指引 fail-loud，§6「venv 存在但体检不通过」行）。
- 注册形态：provider 技能列表 = vendor N + 入口 1；入口不落盘，不进 verify-plugin 字节比对面。**前提（决策A 收窄）**：入口**仅当 provider 以参数缺省创建**（无显式 scanRoots）时追加；任何**显式 roots**（含等于包内 `skills/` 者）一律不追加——零改动保护面（fixture 根不追加）据此成立。生产调用点经 `createSkillProvider(roots?, opts?)` 的**第二参** `opts = { venv }`（方案甲：roots 保持首参数组）传入已去引用的 venv 普通值。

### 5.3 工具 payload 增量（全部 additive；现有字段与系统模式语义不动）

- `ppt_master_info` += `venv: { enabled: boolean, path: string|null(解析后绝对), exists: boolean, pythonPath: string|null }`。基类型注记的**唯一例外**：`off` 行 `path` 按配置原样（未解析）——见矩阵与细则。**`enabled` 为配置值**（invalid 行为 `true`）。
- `ppt_master_check_env` += `venv: { enabled, path, exists, python: {found, version, meetsSkillRequirement}|{skipped} }`；顶层 `python` 小节保持系统探测；依赖探测与 guard 探测同走**生效解释器**（与 §4.2 使用契约一致）：venv 开且存在 → venv python；venv 关 → 系统 python；**venv 开但缺失或损坏 → 不回退系统探测**，依赖条目全 `'UNKNOWN'`/`source:'unknown'`。guard 载荷词汇=`{ran, exitCode}|{skipped}`：生效解释器缺失或损坏→guard=`{skipped}`（`UNKNOWN` 是依赖条目词汇，不得挪用于 guard）；guard 跳过判定基准由"系统 python 探测"切换为"生效解释器探测"（行为变更：现行实现挂 python.found）。
- `ppt_master_setup_deps`：venv 开 → `installCmd = [<venv>/bin/pip3, 'install', '-r', <req>]`（`user`/`breakSystemPackages` 参数仅系统模式生效，venv 模式忽略并在 payload 注明）；payload += `venv: { enabled, created, adopted, path, error?: string }`、`cleanup: { oldPath, action: 'none'|'kept'|'deleted'|'failed', error?: string }`；`action='kept'` 时 render 输出一行闲置提示（旧路径 + 建议手动清理或改回配置）。**字段语义澄清（两处 `enabled` 口径不同）**：本条 `venv.enabled` 为**生效态**——off/invalid 行均为 `false`；info/check_env 的 `venv.enabled` 为**配置值**（invalid 行为 `true`）。**`adopted`** 标识「复用既有有效 venv 并补写标记」的收编结果（签名见 §5.4）。
- **工具描述增量（交付项）**：venv 开时 `ppt_master_info`/`ppt_master_check_env` 的工具描述追加解释器提示语（指向入口 skill 的解释器契约）——模型未读入口时的兜底提示面（§6 软路由失效行）。

**字段×状态矩阵**（info/check_env 断言基准；`{skipped}`（venv 关时 python 小节）与依赖条目 `UNKNOWN`（venv 开缺失/损坏时）两种形状分开断言；guard 载荷词汇见上）：

| 状态 | venv.enabled | venv.path | venv.exists | venv.pythonPath | check_env venv.python | deps 探测解释器 | guard 载荷 |
|---|---|---|---|---|---|---|---|
| venv.off | false | 按配置原样（不解析）〔**仅路径合法的 disabled**；`invalid×disabled` 组合落 `off` 但诊断面 `path=null`，见下方细则〕 | false（定值：不探测） | null | `{skipped}` | 系统 python3 | `{ran,exitCode}`（系统 python3） |
| venv.invalid | true（配置值，行为按关闭） | null（定值） | false（定值：不探测） | null | `{skipped}` | 系统 python3（降级续行） | `{ran,exitCode}`（系统 python3） |
| venv.on-missing | true | 解析后绝对 | false | null | `{found:false, …}`（版本探测挂**候选** `<absPath>/bin/python3`） | 无生效解释器→条目全 UNKNOWN | `{skipped}` |
| venv.on-ready | true | 解析后绝对 | true | `<path>/bin/python3` | `{found, version, meets}` | venv python | `{ran,exitCode}`（venv python） |
| venv.on-ready 子态未就绪（broken；解释器不可用 **或** 有 `bin/python3` 缺 `bin/pip3` 的半成品） | true | 解析后绝对 | true | `null`（推断式口径：`exists=true ∧ pythonPath=null` ⇒ 本子态） | `{found:false, version:null, meetsSkillRequirement:null}`（**该行定值**；版本探测仍按挂载口径发往**候选** `<absPath>/bin/python3`，但其回答不得把半成品读成健康态） | 无生效解释器→条目全 UNKNOWN | `{skipped}` |

**组合与求值细则**：invalid×disabled 组合——行为按 off、诊断面 path 如实（无效→null）、入口 skill 落态 3（disabled 优先）；**off/invalid 行取定值，N/A 语义废除**（off：exists=false 不探测、path 按配置原样不解析；invalid：exists=false、path=null）。**未就绪（broken）子态定义**：`on-ready` 取值空间内**就绪判据不成立**者——就绪＝解释器 `bin/python3` 可用 **∧** 安装路径 `bin/pip3` 存在（与 §5.4 `ensureVenv` 收编体检**同一两问判据**）。故它含两种形态：① 解释器不可用；② 有 `bin/python3` 而缺 `bin/pip3`（`python3 -m venv` 在 ensurepip 阶段失败的半成品；Debian/Ubuntu 缺 `python3-venv` 时出现）。两形态在 **info / check_env / 入口正文三面口径一致**：`pythonPath=null`、`venv.python` 取 absent 三字段、deps 全 UNKNOWN、guard `{skipped}`、入口正文按态 2 给「先 `setup_deps` 准备环境」——不得出现「某面报健康、另一面报未就绪」的分叉。**矩阵注记（info 面可观测性）**：未就绪子态**不另增字段**，按推断式可观测——`venv.exists=true ∧ venv.pythonPath=null ⇒ 未就绪`（正常态给 `<path>/bin/python3`，未就绪时给 null；check_env 面同义形式：`exists=true ∧ venv.python.found=false`）。

### 5.4 lib/venv.js（纯函数 + 注入 run；风格同现有 spawnRun。入参一律作 `venv`——§5.1 去引用快照后的普通对象 `{ enabled, path, oldPathPolicy }`）

- `resolveVenvPath(venv) → { path: string|null, invalidReason: string|null }`（`~` 展开；相对路径判无效）。
- `effectiveInterpreter(venv, primitives = {}) → { state: 'off'|'invalid'|'on-missing'|'on-ready', path: string|null, exists: boolean, pythonPath: string|null, invalidReason: string|null, broken: boolean }`：生效解释器/四态判定原语，skill-provider 四态渲染与 tools 探测**共用**；on-ready 含**就绪体检**（未就绪子态判定，与 ensureVenv 收编体检共用**同一两问判据**：`bin/python3` **∧** `bin/pip3`）。**第二参为具名原语对象** `{ probeVenvInterpreter }`（design 原抽象写作"探测"），**且可整体缺省**（`primitives = {}` → 回退模块自身的同步原语；apply 降级视图等单参调用点依赖该回退）。**`path` / `exists` / `broken` 为返回增量**，且本原语是消费方 `path`/`exists` 的**唯一数据源**；逐行语义＝`off`→`path` 按配置原样（未解析）、`exists=false`；`invalid`→`path=null`、`exists=false`；`on-missing`→解析后绝对、`exists=false`；`on-ready`（含 broken 子态）→解析后绝对、`exists=true`；`broken` 仅 on-ready 且**就绪体检**不通过时为 `true`（含缺 `bin/pip3` 的半成品形态），其余行一律 `false`（payload 面据此推断式可观测 `exists=true ∧ pythonPath=null`，§5.3）。
- **命名原语与分工**：`probeVenvInterpreter(venvDir) → { found }`＝**同步 fs 存在性**探测，**入参为 venv 目录、内部拼 `bin/python3` 后探测**（dangling symlink → `found:false`），供 ensureVenv 体检 / `effectiveInterpreter` / 入口 skill body 三处共用；**就绪判据的第二问** `probeVenvPip(venvDir) → { found }`（`bin/pip3`，同上口径）**不入注入缝**——它是判定的一部分而非可替换的环境事实，`effectiveInterpreter` 直接调模块原语、与被注入的第一问在同一目录同一次求值内读取；与**现有 async 三字段版本探测** `probePython`（`{ found, version, meetsSkillRequirement }`，check_env 的 `venv.python` 用；`pythonPath=null` 的两行改挂**候选** `<absPath>/bin/python3`）是**两个不同接口**，不得混用。
- `venvExists(path)`：`pyvenv.cfg` 存在性。
- marker：`<venv>/.ppt-master-wrapper.json`（`{ createdAt, path }`），读写 + 收编（存在 venv 缺标记则补写）。
- `wrapper-state.json`：`<HOME>/.ppt-master/wrapper-state.json`。`readWrapperState() → { lastVenvPath: string|null, readError?: string }`——**「不存在」与「读失败」分离且均不抛**：不存在→无 `readError`（首次运行初始化语义）；读失败→附 `readError`（不知旧路径→跳过清理并注记，§6 同名行）。登记位置保持 `<HOME>` 单一；**持久性层级错配（显式承认）**：容器场景 HOME 易失而 venv 居持久卷，容器重建后登记丢失→旧 venv 成"有标记无登记"孤儿（§6）——取舍：不做多位置登记，README 明示手动清理（§8）。**不可解析 home 的登记位置守卫**：`os.homedir()` 非非空字符串（`HOME=''`，Node 不回退 passwd）时 `wrapperStatePath()` **抛错**——拒绝退化为相对路径（相对登记位置会落进宿主 cwd，破坏"单一登记位置"契约）；读面（`readWrapperState`）把该抛错折成 `readError`（与"不存在"分离，§6 同名行），写面（`writeWrapperState`）保持抛出交由调用方注记。
- `ensureVenv(run, path, { signal, probeVenvInterpreter, writeMarker }) → { created, adopted, error? }`：第三参收 options（`signal` 透传；`probeVenvInterpreter`/`writeMarker` 为可注入依赖，缺省即模块原语）；返回增 **`adopted`**（复用既有有效 venv 并补写标记的收编可观测）。形参命名口径：本条 `path` 即调用方传入的**去引用绝对路径**。**`@throws`（取消，never-rejects 契约的唯一例外）**：`signal` 转发进 runner，创建被取消时以 `signal.reason`（或 runner 拒绝的 `AbortError`；null 退出码 + 已 abort 同判）**reject**，绝不折成"环境故障"的 `{ created: false, error }` 值返回。**收编体检为两问**：解释器可用（`probeVenvInterpreter`，即 `bin/python3`）**且**安装路径可用（`probeVenvPip`，即 `bin/pip3`）——`python3 -m venv` 在 ensurepip 之前就写好 `pyvenv.cfg`/`bin/python3`，缺 `bin/pip3` 的半成品一律拒绝（`error='venv 内 pip3 缺失（安装不完整）——手动删除该目录后重跑；若系统缺 ensurepip，需先安装 python3-venv'`，不自动删、不置 `adopted`），否则 `<absPath>/bin/pip3` ENOENT 会被永久粘滞。**同一条判据也是 `effectiveInterpreter` 的就绪判据**（§5.3）：半成品在 info / check_env / 入口正文三面一律「未就绪」。
   - **创建/收编前置**：目标目录须为（不存在 | 为空 | 已含 `pyvenv.cfg`）方可创建或收编；存在且非空且无 `pyvenv.cfg` → fail-loud 拒绝（`error="目标目录非空且非 venv"`，不创建、不写标记）——实测 `python3 -m venv` 对非空目录 EXIT=0 成功且保留用户文件，前置判定是唯一防线。
   - **已存在 venv 的两问体检**：解释器不可用（损坏）→ 不自动删（保守），返回 error 提示「手动删除该目录后重跑」（恢复指引，§6）；有解释器而缺 `bin/pip3` 的半成品 → 同类拒绝，文案见上条（M7 起附「若系统缺 ensurepip，需先安装 `python3-venv`」）。
   - **复用语义**：重新启用 venv 且同路径已存在有效 venv → 直接复用（`venvExists` 判定，缺才建，不重建）。
   - error 直通 §5.3 payload 的 `venv.error`，创建失败呈现以 §6 对应行为准。
- `cleanupOldVenv(oldPath, policy, currentPath, { remove } = {}) → { action, error? }`（**`remove` 为可选删除注入缝**，缺省即 `rmSync` 递归——测试造删除失败用；删除仅当**前置四条件**：①路径≠当前、②新旧路径互不**段感知**前缀包含（方向性判定：任一方以另一方为路径**段**前缀即拒绝，防嵌套配置自毁；`/a/venv` **不**包含 `/a/venv-older`）、③`venvExists`、④带标记；`rmSync` 递归且**只收调用方原值**）。
  - **条件①②的判定口径（canonical）**：两侧先取 canonical 形式——**一律按调用方原始拼写逐段解析**（每段拼到已解析前缀上再 `realpathSync`，`..` 在**已解析的父目录**上回退，即内核语义：先解符号链接再退父目录；不存在的中段按文本拼接，等同「最深存在祖先的 realpath ＋ 其余段」；整条不可解析时退化 `path.resolve`），**刻意不设「整条 `realpathSync`」快路径**——理由是整条 realpath 对 `..` 走**文本折叠**（`realpathSync('<p>/link/../venv')` 得 `<p>/venv`），而内核实际打开的是 `<q>/venv`，两者在「文本折叠落点也存在」的诱饵形态上不同，照用会让包含面再次失守（与本文件下条「Node 的 `realpathSync` 自身按文本折叠 `..`」互证）。**同一实体**＝canonical 相等（文本 `resolve` 相等作更保守的前置拒绝，错误文案区分「相同」）；另以 `dev+ino` 相等作**额外正判据**（bind mount 这类 `realpath` 折不掉的别名），仅在两侧 `statSync` 成功**且两侧 `dev !== 0 && ino !== 0`** 时启用（退化 FS 上任意两目录都会「相等」，照用会把清理永久锁死——此时只按 canonical 比较，拒绝面只会更保守）。**包含关系**用 canonical 形式做段感知双向判定。`remove()` 收到的仍是调用方给的 `oldPath` 原值（删除目标语义不因判定形式而改变）。
- **tools 装配面（`lib/tools.js`）**：`createTools(opts)`，`opts = { skillRoots?, venv?, repoRoot?, testSeams? }`；其中 `testSeams = { writeMarker?, writeWrapperState?, readWrapperState?, remove? }` 为**测试面专用**桩通道（生产省略、测试注入，替代 fs stub 观测面）。`repoRoot?` 为 `check_env` **第三个 `.env` 探测点**（包根/仓库根）的装配期锚，生产省略＝本包根（`REPO_ROOT`），测试显式指向 fixture——本仓库工作区根＝插件根，README 又鼓励把 `.env` 放在工作区根，不锚定则该探测点会随开发机配置翻转。
  - **`normalizeVenvInput(venv)`（工厂入口归一化，`lib/venv.js` 导出）**：**`venv` 键在场时**（测试/嵌入方直呼 `createTools({venv:{path}})` / `createSkillProvider(undefined,{venv})`）补成三字段完整普通值——缺字段取 `VENV_DEFAULTS`，`enabled` **仅在字面 `true` 时计为开**（缺失/`undefined`/非布尔一律 `false`，故「键缺失」永不等于「venv 已开」、不产生创建副作用）；`venv` 键**整体缺省或 `null`** 时原样返回（「未配置」语义，落 `invalid` 行）。生产路径不经它（cordis 已按 Config schema 填好三叶子）。

**删除安全模型**：前置四条件缺一不删。条件①②按 **canonical 路径**判定（见上条）：**同一实体**（canonical 相等，或 `dev+ino` 额外正判据）与**互不段感知前缀包含**（含「祖先目录经符号链接抵达」与「`..` 作用在符号链接上」两种包含形态）都据此拒绝——纯文本/纯 `realpath` 的口径**不足以**覆盖这两种形态（`resolve` 不触文件系统；Node 的 `realpathSync` 自身按文本折叠 `..`）。**别名判定的可靠性边界（显式接受）**：该判定依赖 `realpath`/`st_ino` 的可靠性，在 `ino`/`dev` 退化为 0 的文件系统（部分 FAT/网络盘/合成 fs）上 `dev+ino` 判据自动停用，此时只按 canonical 路径比较，可能**额外拒绝**（保守方向）——**限定**：「不会误删」仅对 `realpath` 可解析的别名成立，若同时存在 canonical 折不掉的别名（如 bind mount），该保护不覆盖包含面。残留风险（显式接受）：① venv 建成后生命周期内混入的用户数据仍被递归删除（标记即授权，README 注明）；② 删除中途失败呈半删态——下轮 setup_deps 重试删除，`pyvenv.cfg` 仍在即仍符合删除条件；③ 孤儿目录（未标记）永不自动删。

## 6. 错误处理

| 情形 | 行为 |
|---|---|
| `python3 -m venv` 非零/spawn 失败（ensureVenv 失败） | 载荷定案：`installCmd` 如实给出、`installExit=-1`、`venv.created=false`、`venv.error`=原因（**stderr 摘要＝首行 ＋ 至多 4 行提示行**：命中 `ensurepip`/`python3-venv`/`apt\|dnf\|yum\|apk\|pacman install` 等关键字的行整行保留、` \| ` 连接、整体仍受 500 字符硬上限约束——Debian/Ubuntu 缺 ensurepip 时唯一可执行的 `apt install python3-venv` 落在 stderr 第 2-5 行，只留首行会让用户/模型拿不到根因、被「删除重建」指引误导成必然复现的循环）；guard=`{skipped}`（无生效解释器，§5.3 口径）；复跑 check_env 按 venv-缺失口径——python 小节保持系统探测，依赖条目全 UNKNOWN 不回退系统探测；不 throw |
| 目标目录非空且无 `pyvenv.cfg` | ensureVenv fail-loud 拒绝：`venv.created=false`、`venv.error="目标目录非空且非 venv"`，不创建、不写标记，载荷呈现同上行（installCmd 如实 + 注明未执行）；提示用户先处置该目录 |
| venv 存在但体检不通过（解释器不可用 / `bin/pip3` 缺失） | ensureVenv **两问体检**（`bin/python3` 可用 **且** `bin/pip3` 存在）任一不通过→不自动删（保守）；setup_deps fail-loud：`venv.error` 分两文案——解释器不可用＝"venv 解释器不可用（exists-but-broken）——手动删除该目录后重跑"、`bin/pip3` 缺失＝`venv 内 pip3 缺失（安装不完整）——手动删除该目录后重跑；若系统缺 ensurepip，需先安装 python3-venv`（`python3 -m venv` 在 ensurepip **之前**就写好 `pyvenv.cfg`/`bin/python3`，故半成品会被解释器探测放行；收编它等于把 `<absPath>/bin/pip3` ENOENT 永久粘滞，而**若根因是系统缺 ensurepip，删了重建照样失败**，故文案给出前置条件）；两文案均只给手动恢复指引；**未就绪（解释器不可用 / `bin/pip3` 缺失）两种形态**在 check_env 均按 §5.3 未就绪子态口径（venv.python 取 absent 三字段、deps 全 UNKNOWN、guard=`{skipped}`），info 面 `exists=true ∧ pythonPath=null`，入口正文落态 2 |
| venv 内 pip 安装失败 | 现行语义：非零记录不抛，复跑诊断 |
| cleanup 删除失败 | `cleanup.action='failed'` + error 字符串，不抛 |
| 配置 path 相对/无效（含 `~` 展开后仍非法；HOME 空串时 `~` 展开判无效——实测语义见 §5.1，不落根级路径） | apply 期 console.warn（日志补充；可见反馈通道见 §5.1 编辑期校验闭环），venv 视为关闭，入口 skill 写明修正方式 |
| check_env venv 探测 | 全程诊断性（缺 venv = 状态值非错误） |
| 解释器软路由失效（模型未读入口） | 入口 description 强引导 + 工具描述兜底提示（§5.3 工具描述增量）为缓解；不承诺硬保证（方案A 约束） |
| 设置页不可投影/写入被拒（volatile 未声明或宿主版本不支持） | 插件功能不受影响（配置仍可用 profile patch 手工编辑），README 注明诊断方式 |
| `wrapper-state.json` 不存在或读失败 | 不存在（首次运行）=初始化语义→无旧路径、不清理（`action='none'`）；读失败=不知旧路径→跳过清理，`cleanup.action='none'` + error 注记（不冒充删除失败），不抛。`readWrapperState()` 的返回面即按此分离：不存在→无 `readError`；读失败→附 `readError`（§5.4） |
| `wrapper-state.json` 写失败（登记失败） | 清理结果如实保留（action 不因登记失败改写）；登记失败单独 warn + payload 注记，不影响安装结果（与 §7 第 1 项单测对齐） |
| marker 写入/收编补写失败 | venv 仍可用（下次 setup_deps 重试补写），warn |
| 未标记的既有 venv 目录 | 清理永不触碰的孤儿（安全侧默认）；info/check_env 不提示（保守），README 注明手动处理方式 |
| 有标记无登记孤儿（容器重建后登记丢失，§5.4 层级错配） | 无登记即无清理依据，永不自动删；登记位置保持 `<HOME>` 单一（错配显式接受），README 明示手动清理 |
| 两路 setup_deps 并发 / 热重载重建 | 沿用前序设计 no locking：pip 幂等、ensureVenv 幂等（缺才建）——venv 创建非原子，双建竞态可能失败、复跑自愈（不承诺"最终一致"）；删除不变量=删除目标与任一在途安装目标（含热重载前旧实例）不相交；交叠窗口（新实例视为"旧"的路径恰为旧实例在途安装目标）接受为已知边界——可能损坏在途安装，复跑自愈；热重载重建时在途工具调用以旧实例状态完成（cordis fiber 语义） |

### 6.1 宿主契约风险与兜底

宿主依赖及降级语义（⓪–④）：

- ⓪ **schemastery 可解析**（宿主 node_modules 定位 + 受控解析，§3/§5.1）：解析失败=模块加载期故障→整插件不可加载（fail-loud，宿主 loader 记录该故障）——**vendor 技能面连带丢失**（技能 provider 与 Config 同处一个模块，不存在"无 Config 降级"形态）；README 注明诊断（宿主 node_modules 需存在该包）。**装载形态注记**：`scripts/check-dsh-compat.mjs` 对插件入口**不做顶层静态 import**——装载期 fail-loud 会抢先于 CLI 参数解析与 SDK 定位，使"无定位线索""未知参数"两例的断言语义失效；入口改在 **SDK 定位成功后**动态装载（机制见 §7.5）。
- ① SettingsForms volatile 投影不可用→配置仍可 profile patch 手工编辑。
- ② 宿主 config-editor 编辑通道：真实机制=`edit()`→reconcileProfilePatches→Loader 重建，配置变更**无条件热生效**（hmr 串行化）；通道不可用或热重载失败→配置变更于下次 DSH 重启时生效（兜底）。**〔勘误 ㉘〕**「无条件热生效」限 config-editor `edit()`；**手工 profile patch 编辑在本部署不热生效**（实测：无 watcher 应用、无 reload 日志，live 工具仍报旧值），按本行兜底＝**下次 DSH 重启生效**处理——本版无设置页渲染者（㉗），故这就是常规路径。**〔勘误 ㉙（2026-10-16 config-ui 特性回写）〕** 上述「`edit()`→reconcileProfilePatches→Loader 重建」的链路措辞对本 Config **不成立**：三叶子全 volatile ⇒ config-editor `edit()` 保存走宿主 **volatile 快路径**（只写 `fiber._config` + `_commitVolatile()` → `loader/volatile-update`，**不 remount、不重跑 `apply`**）；入口 skill 正文/工具行为随 volatile 引用**原地换代**。**键名与 schema 不动**；本行其余（通道不可用＝兜底重启生效、㉘ 的手工编辑不热生效）仍成立。
- ③ apply 第二参注入异常→venv 视为关闭 + warn。
- ④ 合成入口 skill 候选（无文件、按设计**不带 `resourceBase`**）经真实注册面的接受性：**该字段已凭宿主源码实证为条件透传的可选字段**（`@deepseek-ai/dsh-skill/lib/index.js:445`/`:501`，本机装包实测），故"接受性未验证"措辞升级为 **"不带 `resourceBase` 的候选已实证该字段可选，接受性由 compat §7.7⑤ 实跑复核"**；降级：宿主拒绝则入口技能缺失（vendor 技能不受影响），README 诊断。

schemastery 由宿主提供（peer 解析来源：宿主 profile node_modules 的 `@deepseek-ai/schemastery`），插件自身零 npm 依赖不变（不打包、不声明 runtime 依赖）。engines.dsh 门槛维持现状（0.1.1-rc.1，本特性不引入更高 API）。

> 作废记录：曾拟议"补 `patchReload` 前置检查"作为 G2/热重载成立前提——经查 `patchReload` 键在 dsh 代码 0 命中（键不存在），拟议作废；热重载前提改按 ② 真实机制表述。

## 7. 测试策略

1. **lib/venv.js 单测**：路径解析矩阵（`~`/绝对/相对）；exists；effectiveInterpreter 四态判定矩阵（含 exists-but-broken 子态与 invalid×disabled 组合）；ensureVenv（stub run：argv 断言、marker 写入、已存在收编、创建失败、目标目录三态前置——不存在/为空/含 `pyvenv.cfg` 放行、非空非 venv 拒绝、已存在 venv 解释器体检——损坏→拒绝且不删）；cleanup 决策矩阵（policy × 存在 × 标记 × 同/异路径 × 前缀包含（方向性） × **路径别名（文本/符号链接同实体）＋包含形态（祖先目录经符号链接抵达、`..` 作用在符号链接上）** × 删除失败注入）；wrapper-state 写入（成功更新 lastVenvPath；写失败不更新且不影响安装结果——对齐 §6 写失败行）。
2. **tools venv 分支**：tmpdir 假 venv（`pyvenv.cfg` + marker）；info/check_env/setup_deps 的 venv 分支与 payload 断言；schema 快照（新增字段）；`installCmd` 形态（venv pip 路径；flags 忽略注明）；系统模式回归——系统模式行为断言保持全绿；既有 schema 形状断言（逐字属性集 deepEqual）随 venv 增量同步修订，修订面限于形状断言，行为断言不改。
3. **入口 skill**：四态 body 内容断言（解释器路径、前置路由语、准备指引）；provider 数量 = vendor N + 1；不落盘断言；工具描述解释器提示语断言（venv 开时 `ppt_master_info`/`ppt_master_check_env` 描述含提示语——§5.3 交付项）。
4. **apply 集成**：Config 默认值；config 注入路径（loader 形态、opts 覆盖、两者共存、venv 缺省默认值）；**volatile 引用→普通值快照断言**（loader 形态下叶子为引用对象，apply 下传前已 `.get()` 去引用）；无效配置降级 warn。
5. **兼容面**：verify-plugin（入口 skill 不在 vendor 面——负向确认）；sync-upstream 零交互；check-dsh-compat 通过——验证面**扩展为 §7.7 六项全映射**（`ns.Config` volatile 声明 + apply 第二参注入通道 + bundle insert 层静态断言 + schemastery 受控解析通道 + 生产根形态经真实 SkillRegistry 读回入口技能 + 客户端半边 stub 装载与注册）（2026-10-16 config-ui 特性新增，见 `docs/superpowers/specs/2026-10-16-ppt-master-config-ui-design.md` §7.3）。**机制注记**：该脚本对插件入口**不做顶层静态 import**（装载期 schemastery fail-loud 会抢先于 CLI 参数解析与 SDK 定位，使"无定位线索""未知参数"两例的断言语义失效），入口改在 **SDK 定位成功后**动态 `import(PLUGIN_ENTRY)`、`apply` 取该动态命名空间的 `ns.apply`（`createTools` 仍为静态导入）。
6. **真实树 smoke（验收期）**：本机以 `/dsh-home/.ppt-master/venv` 实建 venv + 实装 19 依赖（用户触发；该路径为本机**显式配置值**而非 `~` 展开结果，与默认值 `~/.ppt-master/venv` 构成默认/显式覆盖关系）；前置＝profile `cordis.patch.yml` 手工条目（㉗）；**配置生效验证（㉘ 修订）**：本机改 profile patch → **重启 DSH** → 观察入口 skill 正文/工具行为换代（判据：`ppt_master_check_env` 的 `venv.enabled` 由 `false` 转 `true`、`path` 为所配值）。本版**无热重载通道**可验。
7. **设计成立性前置检查**（可执行验收项）：① Config volatile 声明存在；② apply 第二参注入通道可用；③ profile `cordis.patch.yml` 存在 `id: dsh-ppt-master-wrapper` 条目（**分层**：仅 bundle insert 层可静态断言——本包 `cordis.patch.yml` 的 `insert:` 段；profile 层条目由宿主 config-editor 在首次设置页编辑且 `index<0` 时 `add` 代建，归**验收期人工步骤**，bundle 层静态存在不替代之）；④ schemastery 可解析性（compat 脚本经 §3 同一受控解析通道验证）；⑤ 入口技能经真实注册面接受（compat 脚本经真实 SkillRegistry 读回列表断言在场）。

> 注记：本机 Node v22 下测试命令须用 glob 形态 `node --test tests/*.test.mjs`（目录形式 MODULE_NOT_FOUND）。

## 8. 文档与发布

README 交付核对表（散点义务合并于此）：

- venv 配置说明：容器挂载卷建议、PEP 668 说明、禁用后手动清理；入口 skill 用法、**配置指引（profile patch 手工条目 + 重启生效，㉗/㉘）**。
- 挂载卷/镜像不变边界：挂载只保证数据不丢；跨容器重建后 venv 可用性依赖镜像不变（符号链接指向容器内绝对路径）；损坏恢复=删除重建（§5.1/§6）。
- 标记即授权：已标记 venv 目录内混入的数据会被递归删除（§5.4 残留风险①）。
- 孤儿处理：未标记孤儿手动处理；有标记无登记（容器重建后登记丢失，§5.4）手动处理。
- 配置页诊断：本版对纯宿主插件**无渲染者**（㉗）——宿主侧 volatile 投影与命名空间就绪，缺的是客户端槽位注册者；配置一律走 profile patch 手工条目（§6.1①）。
- schemastery 解析失败诊断：宿主 node_modules 需存在该包（§6.1⓪）。
- 入口技能缺失诊断：宿主注册面拒绝**不带 `resourceBase`** 的合成候选时，vendor 技能不受影响（该字段已实证为条件透传的可选字段，接受性由 compat §7.7⑤ 实跑复核；§6.1④）。

版本历史行随下次 sync 规则③ `-r` 递增发布（本特性为包装层提交，不触碰上游）。

部署前置（㉗/㉘ 修订）：使用 venv 前需在 profile `cordis.patch.yml` **手工建立** `id: dsh-ppt-master-wrapper` 条目，并**重启 DSH** 生效（本版无设置页渲染者、无 patch 热应用；若宿主版本存在渲染者，设置页保存亦会代建同形条目）。config 为整体替换语义：插件升级新增字段后，已存在的 patch 条目需比对补全新字段（否则新字段回落默认值）。
