# 设计：ppt-master venv 隔离 + 插件配置页（2026-10-15）

任务名：`2026-10-15-ppt-master-venv-config` · 模式：中等
需求真相源：`docs/superpowers/clarifications/2026-10-15-ppt-master-venv-config.md`

## 1. 概述与动机

本机实测：DSH 容器内 19 个 Python 依赖 0/19 已装，且系统 Python 为 PEP 668（EXTERNALLY-MANAGED），裸装需 `--break-system-packages` 且装入容器 rootfs（重建即丢）。本设计为包装层引入**可选 venv 隔离**（懒创建、可配置路径、旧路径清理策略）与**原生 schema 配置页**（cordis Config → DSH 设置自动出页，含模块加载期版本注解），并以**包装层自有的入口 skill**（`ppt-master-env`）承担解释器路由——不修改任何上游文件，方案A 字节级 vendor 约束（spec `2026-10-14-dsh-ppt-master-wrapper-design.md` §1.1/§3）继续成立。

## 2. 目标 / 非目标

**目标**
- G1 venv 隔离：`venv.enabled/path/oldPathPolicy` 三配置；懒创建（仅 `ppt_master_setup_deps`）；venv 内安装无 PEP 668 拦截。
- G2 原生配置页：Config schema 注解承载插件版本、上游版本、SKILL_DIR（模块加载期生成）；配置变更经 Loader 热重载即时生效。成立条件：Config 字段声明为 volatile 且宿主 config-editor 编辑通道可用（真实热重载机制见 §4.1/§6.1②）。
- G3 入口 skill `ppt-master-env`：四态正文给出当前解释器契约（最近快照 + 实时工具指引）；description 声明"使用 ppt-master 前必读"。
- G4 工具 venv 感知：`info`/`check_env`/`setup_deps` payload 增量字段；`setup_deps` 独占 venv 创建/删除副作用。
- G5 旧 venv 生命周期：所有权标记 + `wrapper-state.json` 登记上次路径 + `oldPathPolicy`（默认 keep）；删除仅对满足 §5.4 前置（pyvenv.cfg 存在、带标记、路径≠当前且互不前缀包含）的目录。

**非目标**
- 实时状态面板 / 自研前端页（`dsh.client` 范式明确不采用）。
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
   ├─ createSkillProvider(config)   skill-provider.js
   │     ├─ vendor 技能（现状：skills/ 树字节原样）
   │     ├─ 合成入口 skill ppt-master-env（body 按四态渲染，内存合成，无文件）
   │     │      └─ lib/venv.js（生效解释器/四态判定原语，与 tools 共用）
   └─ createTools(config)           tools.js
         └─ lib/venv.js（纯函数 + 注入 run）
              resolveVenvPath / venvExists / marker 读写
              ensureVenv / cleanupOldVenv / wrapper-state 登记
```

组件职责：`lib/venv.js` 承载全部 venv 决策与副作用原语（只提供解释器/pip 路径解析原语，不组装命令——installCmd 的组装、含 venv pip 路径替换，归 `tools.js` 编排层）；`tools.js` 只做探测编排与 payload 组装（`setup_deps` 是唯一调用 ensureVenv/cleanupOldVenv 的地方）；`skill-provider.js` 新增合成入口 skill（四态渲染取 `lib/venv.js` 判定原语，与 tools 共用）；`index.js` 声明 Config 并下传。schemastery 引入通道=宿主 node_modules 定位 + 受控解析（createRequire 等价通道），**禁 ESM 裸导入**（插件以符号链接装载，裸导入在该路径下必然 ERR_MODULE_NOT_FOUND）；零 npm 依赖声明保持。

apply 第二参为**统一注入包**：loader 传入经校验的 config（含 venv 三字段，volatile 叶子为引用对象——apply 入口先按 §5.1 引用语义去引用快照为普通值），测试/嵌入方传 `{skillRoots}`，两键可共存于同一对象，venv 字段缺省=默认值。与现有 **12 处可执行 `apply` 调用**兼容（= tests 10：字面 `{skillRoots}` 8 + 裸 opts 2，集中在 `tests/apply.test.mjs`、`tests/verify-plugin.test.mjs` **两文件**，`tests/compat.test.mjs` 的命中为 fixture 字符串非调用；+ scripts 2：`scripts/check-dsh-compat.mjs` 以变量形态传入 `toolOptions`、`scripts/verify-plugin.mjs`）：skillRoots 键照旧生效，venv 缺省走默认（注入通道异常的降级见 §6.1③）。apply 期降级（配置无效→venv 视为关闭）是**行为层视图**：注入包/Config 保留原始值——入口 skill 渲染读原始配置 + invalidReason 判第四态，工具行为读降级值。

## 4. 数据流

- **4.1 配置变更**：设置页编辑 → 宿主 config-editor `edit()`（分层 profile patch 写入）→ reconcileProfilePatches → Loader 重建插件实例（配置变更**无条件热生效**，hmr 串行化）→ 入口 skill 正文与工具行为随实例重建换代（免 DSH 整体重启）；热重载失败兜底→下次 DSH 重启生效（§6.1②）。配置页注解随插件升级换代（注解于模块加载期烘焙进 schema description，模块缓存内不重求值——不随热重载换代）。机制修正：设置页 `applies:"live"` 标识为宿主 describe 固定输出，真正的可编辑性由字段 volatile 声明决定（§5.1）。
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

- **volatile 前提**：三字段均须以 schemastery `.volatile()`（live-editable）标记——这是设置页可编辑投影的前提；未标 volatile 的叶子字段宿主不出页、写入被拒。**引用语义（宿主实测）**：`.volatile()` 同时把解析值包装为须 `.get()` 读取的引用对象（叶子级或对象级标注均如此，直接属性读取拿到包装器/undefined），且不两层叠加标注（钉**叶子级**，宿主惯例如 dsh-agent-loop `maxParallelToolCalls`）；因此 **apply 边界统一去引用**——对三个 volatile 叶子各做一次 `.get()` 快照，组装为普通对象后下传 `createSkillProvider`/`createTools`/`lib/venv.js`（下游接口签名一律按普通值，不感知引用）。
- **引入通道**：Config schema 依赖的 schemastery 经"宿主 node_modules 定位 + 受控解析（createRequire 等价通道）"获取，禁 ESM 裸导入（符号链接插件路径下必然 ERR_MODULE_NOT_FOUND）；插件零 npm 依赖声明保持（解析失败的 fail-loud 语义见 §6.1⓪）。
- **`~` 展开基准**：按 DSH 宿主进程 HOME 展开（Node `os.homedir()` 实测语义：**HOME 为空串时返回空串、不回退**——该输入下 `~` 展开判无效走 §6 配置无效降级；仅 HOME **未设置**才回退 passwd 目录/getpwuid）；"与上游 config.py 的 `Path.home()/.ppt-master` 同一基准"仅 HOME 非空时成立（空串边界 Node/Python 行为分叉：Python `Path.home()`→`'/'`）；降级分支在解析结果非法（空/相对/空串 HOME）时触发（走 §6 配置无效降级）；本机容器 HOME=/root → 默认路径解析为 `/root/.ppt-master/venv`。
- **默认路径理由**：`~/.ppt-master/venv` 兼顾非容器 DSH 用户的通用性，贴合上游 `~/.ppt-master/.env`（USER_ENV_FILE）目录惯例；容器用户宜显式配置到挂载卷（如 `/dsh-home/.ppt-master/venv`）。**挂载卷边界**：挂载只保证数据不丢；跨容器重建后 venv 可用性依赖镜像不变（venv 内符号链接指向容器内绝对路径）；损坏恢复=删除重建（§6 exists-but-broken 行）。
- **发现通道**：不调用 `ctx.settings.configure()`，沿用宿主 auto 出页默认策略——被发现的配置项按默认策略处置。
- **编辑期校验闭环**：路径形状约束（绝对或 `~` 前缀）不在 schema 层声明（schemastery 无法表达路径谓词），接受"可保存非法值"；可见反馈通道=入口 skill"配置无效"态 + check_env 的 `venv.path=null` 提示（不依赖宿主控制台 warn），warn 仅作日志补充。

配置页版本注解：插件版本（package.json）、上游 skill 版本（skills 扫描 `metadata.version`）、SKILL_DIR——模块加载期求值并烘焙进 Config schema description（模块缓存内不重求值），随插件升级（版本变化→模块重载）换代。

### 5.2 入口 skill `ppt-master-env`

- name：`ppt-master-env`；description：中英双语，声明"任何 ppt-master 路由前必须先读本入口：它给出当前生效解释器与准备状态"。
- body 四态（实例注册期按 config + 文件系统快照渲染。新鲜度定案：provider 工厂仅在注册期调用一次、技能数组注册期冻结——源码事实；故正文=插件实例生命周期的实例注册期快照，配置变更经热重载重建实例→正文随之换代；文件系统变化（如 venv 被外部删除）后正文可能陈旧→正文固定脚注指向 `ppt_master_info`/`ppt_master_check_env` 实时查询，`setup_deps` 执行后以工具输出为准）：
   1. venv 开+已建：解释器 = `<解析后绝对路径>/bin/python3`，一切上游脚本调用一律以它替换字面 `python3`；给出 SKILL_DIR；读毕即路由 `ppt-master`。
   2. venv 开+未建：先调用 `ppt_master_setup_deps` 准备环境；在此之前不以系统 python3 跑业务脚本。
   3. venv 关：系统 `python3`（现状）。
   4. 配置无效（相对路径）：指明修正方式，按系统模式继续。
- 四态说明：第四态（配置无效）为 §6 无效配置降级在入口 skill 面的对应文案——超出澄清时的三态，但同源于已确认的错误处理决策；invalid×disabled 组合落态 3（disabled 优先，见 §5.3 组合细则）。
- 注册形态：provider 技能列表 = vendor N + 入口 1；入口不落盘，不进 verify-plugin 字节比对面。

### 5.3 工具 payload 增量（全部 additive；现有字段与系统模式语义不动）

- `ppt_master_info` += `venv: { enabled: boolean, path: string|null(解析后绝对), exists: boolean, pythonPath: string|null }`。
- `ppt_master_check_env` += `venv: { enabled, path, exists, python: {found, version, meetsSkillRequirement}|{skipped} }`；顶层 `python` 小节保持系统探测；依赖探测与 guard 探测同走**生效解释器**（与 §4.2 使用契约一致）：venv 开且存在 → venv python；venv 关 → 系统 python；**venv 开但缺失或损坏 → 不回退系统探测**，依赖条目全 `'UNKNOWN'`/`source:'unknown'`。guard 载荷词汇=`{ran, exitCode}|{skipped}`：生效解释器缺失或损坏→guard=`{skipped}`（`UNKNOWN` 是依赖条目词汇，不得挪用于 guard）；guard 跳过判定基准由"系统 python 探测"切换为"生效解释器探测"（行为变更：现行实现挂 python.found）。
- `ppt_master_setup_deps`：venv 开 → `installCmd = [<venv>/bin/pip3, 'install', '-r', <req>]`（`user`/`breakSystemPackages` 参数仅系统模式生效，venv 模式忽略并在 payload 注明）；payload += `venv: { created, path, error?: string }`、`cleanup: { oldPath, action: 'none'|'kept'|'deleted'|'failed', error?: string }`；`action='kept'` 时 render 输出一行闲置提示（旧路径 + 建议手动清理或改回配置）。
- **工具描述增量（交付项）**：venv 开时 `ppt_master_info`/`ppt_master_check_env` 的工具描述追加解释器提示语（指向入口 skill 的解释器契约）——模型未读入口时的兜底提示面（§6 软路由失效行）。

**字段×状态矩阵**（info/check_env 断言基准；`{skipped}`（venv 关时 python 小节）与依赖条目 `UNKNOWN`（venv 开缺失/损坏时）两种形状分开断言；guard 载荷词汇见上）：

| 状态 | venv.enabled | venv.path | venv.exists | venv.pythonPath | check_env venv.python | deps 探测解释器 | guard 载荷 |
|---|---|---|---|---|---|---|---|
| venv.off | false | 按配置原样（不解析） | false（定值：不探测） | null | `{skipped}` | 系统 python3 | `{ran,exitCode}`（系统 python3） |
| venv.invalid | true（配置值，行为按关闭） | null（定值） | false（定值：不探测） | null | `{skipped}` | 系统 python3（降级续行） | `{ran,exitCode}`（系统 python3） |
| venv.on-missing | true | 解析后绝对 | false | null | `{found:false, …}` | 无生效解释器→条目全 UNKNOWN | `{skipped}` |
| venv.on-ready | true | 解析后绝对 | true | `<path>/bin/python3` | `{found, version, meets}` | venv python | `{ran,exitCode}`（venv python） |
| venv.on-ready 子态 exists-but-broken | true | 解析后绝对 | true | `<path>/bin/python3` | `{found:false, …}` | 无生效解释器→条目全 UNKNOWN | `{skipped}` |

**组合与求值细则**：invalid×disabled 组合——行为按 off、诊断面 path 如实（无效→null）、入口 skill 落态 3（disabled 优先）；**off/invalid 行取定值，N/A 语义废除**（off：exists=false 不探测、path 按配置原样不解析；invalid：exists=false、path=null）。exists-but-broken 定义：venv.exists=true 且 venv.python.found=false（on-ready 取值空间的显式子态）。**矩阵注记（info 面可观测性）**：exists-but-broken **不另增字段**，按推断式可观测——`venv.exists=true ∧ venv.pythonPath=null ⇒ exists-but-broken`（该子态 on-ready 正常态给 `<path>/bin/python3`，broken 时给 null）。

### 5.4 lib/venv.js（纯函数 + 注入 run；风格同现有 spawnRun。入参 `config` 为 §5.1 去引用快照后的普通对象）

- `resolveVenvPath(config) → { path: string|null, invalidReason: string|null }`（`~` 展开；相对路径判无效）。
- `effectiveInterpreter(config, 探测) → { state: 'off'|'invalid'|'on-missing'|'on-ready', pythonPath: string|null, invalidReason: string|null }`：生效解释器/四态判定原语，skill-provider 四态渲染与 tools 探测**共用**；on-ready 含解释器体检（exists-but-broken 子态判定，与 ensureVenv 体检共用同一探测）。
- `venvExists(path)`：`pyvenv.cfg` 存在性。
- marker：`<venv>/.ppt-master-wrapper.json`（`{ createdAt, path }`），读写 + 收编（存在 venv 缺标记则补写）。
- `wrapper-state.json`：`<HOME>/.ppt-master/wrapper-state.json`，`{ lastVenvPath }`。登记位置保持 `<HOME>` 单一；**持久性层级错配（显式承认）**：容器场景 HOME 易失而 venv 居持久卷，容器重建后登记丢失→旧 venv 成"有标记无登记"孤儿（§6）——取舍：不做多位置登记，README 明示手动清理（§8）。
- `ensureVenv(run, path, signal) → { created, error? }`：
   - **创建/收编前置**：目标目录须为（不存在 | 为空 | 已含 `pyvenv.cfg`）方可创建或收编；存在且非空且无 `pyvenv.cfg` → fail-loud 拒绝（`error="目标目录非空且非 venv"`，不创建、不写标记）——实测 `python3 -m venv` 对非空目录 EXIT=0 成功且保留用户文件，前置判定是唯一防线。
   - **已存在 venv 解释器体检**：损坏（exists-but-broken）→ 不自动删（保守），返回 error 提示"手动删除该 venv 目录后重跑"（恢复指引，§6）。
   - **复用语义**：重新启用 venv 且同路径已存在有效 venv → 直接复用（`venvExists` 判定，缺才建，不重建）。
   - error 直通 §5.3 payload 的 `venv.error`，创建失败呈现以 §6 对应行为准。
- `cleanupOldVenv(oldPath, policy, currentPath) → { action, error? }`（删除仅当**前置四条件**：路径≠当前、新旧路径互不前缀包含（方向性判定：任一方以另一方为路径前缀即拒绝，防嵌套配置自毁）、`venvExists`、带标记；`rmSync` 递归）。

**删除安全模型**：前置四条件缺一不删。残留风险（显式接受）：① venv 建成后生命周期内混入的用户数据仍被递归删除（标记即授权，README 注明）；② 删除中途失败呈半删态——下轮 setup_deps 重试删除，`pyvenv.cfg` 仍在即仍符合删除条件；③ 孤儿目录（未标记）永不自动删。

## 6. 错误处理

| 情形 | 行为 |
|---|---|
| `python3 -m venv` 非零/spawn 失败（ensureVenv 失败） | 载荷定案：`installCmd` 如实给出、`installExit=-1`、`venv.created=false`、`venv.error`=原因，render 注明未执行；guard=`{skipped}`（无生效解释器，§5.3 口径）；复跑 check_env 按 venv-缺失口径——python 小节保持系统探测，依赖条目全 UNKNOWN 不回退系统探测；不 throw |
| 目标目录非空且无 `pyvenv.cfg` | ensureVenv fail-loud 拒绝：`venv.created=false`、`venv.error="目标目录非空且非 venv"`，不创建、不写标记，载荷呈现同上行（installCmd 如实 + 注明未执行）；提示用户先处置该目录 |
| venv 存在但损坏（exists-but-broken） | ensureVenv 体检不通过→不自动删（保守）；setup_deps fail-loud：`venv.error` 提示"手动删除该 venv 目录后重跑"（恢复指引）；check_env 按 §5.3 on-ready 子态口径（venv.python `{found:false,…}`、deps 全 UNKNOWN、guard=`{skipped}`） |
| venv 内 pip 安装失败 | 现行语义：非零记录不抛，复跑诊断 |
| cleanup 删除失败 | `cleanup.action='failed'` + error 字符串，不抛 |
| 配置 path 相对/无效（含 `~` 展开后仍非法；HOME 空串时 `~` 展开判无效——实测语义见 §5.1，不落根级路径） | apply 期 console.warn（日志补充；可见反馈通道见 §5.1 编辑期校验闭环），venv 视为关闭，入口 skill 写明修正方式 |
| check_env venv 探测 | 全程诊断性（缺 venv = 状态值非错误） |
| 解释器软路由失效（模型未读入口） | 入口 description 强引导 + 工具描述兜底提示（§5.3 工具描述增量）为缓解；不承诺硬保证（方案A 约束） |
| 设置页不可投影/写入被拒（volatile 未声明或宿主版本不支持） | 插件功能不受影响（配置仍可用 profile patch 手工编辑），README 注明诊断方式 |
| `wrapper-state.json` 不存在或读失败 | 不存在（首次运行）=初始化语义→无旧路径、不清理（`action='none'`）；读失败=不知旧路径→跳过清理，`cleanup.action='none'` + error 注记（不冒充删除失败），不抛 |
| `wrapper-state.json` 写失败（登记失败） | 清理结果如实保留（action 不因登记失败改写）；登记失败单独 warn + payload 注记，不影响安装结果（与 §7 第 1 项单测对齐） |
| marker 写入/收编补写失败 | venv 仍可用（下次 setup_deps 重试补写），warn |
| 未标记的既有 venv 目录 | 清理永不触碰的孤儿（安全侧默认）；info/check_env 不提示（保守），README 注明手动处理方式 |
| 有标记无登记孤儿（容器重建后登记丢失，§5.4 层级错配） | 无登记即无清理依据，永不自动删；登记位置保持 `<HOME>` 单一（错配显式接受），README 明示手动清理 |
| 两路 setup_deps 并发 / 热重载重建 | 沿用前序设计 no locking：pip 幂等、ensureVenv 幂等（缺才建）——venv 创建非原子，双建竞态可能失败、复跑自愈（不承诺"最终一致"）；删除不变量=删除目标与任一在途安装目标（含热重载前旧实例）不相交；交叠窗口（新实例视为"旧"的路径恰为旧实例在途安装目标）接受为已知边界——可能损坏在途安装，复跑自愈；热重载重建时在途工具调用以旧实例状态完成（cordis fiber 语义） |

### 6.1 宿主契约风险与兜底

宿主依赖及降级语义（⓪–④）：

- ⓪ **schemastery 可解析**（宿主 node_modules 定位 + 受控解析，§3/§5.1）：解析失败=模块加载期故障→整插件不可加载（fail-loud，宿主 loader 记录该故障）；README 注明诊断（宿主 node_modules 需存在该包）。
- ① SettingsForms volatile 投影不可用→配置仍可 profile patch 手工编辑。
- ② 宿主 config-editor 编辑通道：真实机制=`edit()`→reconcileProfilePatches→Loader 重建，配置变更**无条件热生效**（hmr 串行化）；通道不可用或热重载失败→配置变更于下次 DSH 重启时生效（兜底）。
- ③ apply 第二参注入异常→venv 视为关闭 + warn。
- ④ 合成入口 skill 候选（无文件）经真实注册面的接受性未验证→降级：宿主拒绝则入口技能缺失（vendor 技能不受影响），README 诊断。

schemastery 由宿主提供（peer 解析来源：宿主 profile node_modules 的 `@deepseek-ai/schemastery`），插件自身零 npm 依赖不变（不打包、不声明 runtime 依赖）。engines.dsh 门槛维持现状（0.1.1-rc.1，本特性不引入更高 API）。

> 作废记录：曾拟议"补 `patchReload` 前置检查"作为 G2/热重载成立前提——经查 `patchReload` 键在 dsh 代码 0 命中（键不存在），拟议作废；热重载前提改按 ② 真实机制表述。

## 7. 测试策略

1. **lib/venv.js 单测**：路径解析矩阵（`~`/绝对/相对）；exists；effectiveInterpreter 四态判定矩阵（含 exists-but-broken 子态与 invalid×disabled 组合）；ensureVenv（stub run：argv 断言、marker 写入、已存在收编、创建失败、目标目录三态前置——不存在/为空/含 `pyvenv.cfg` 放行、非空非 venv 拒绝、已存在 venv 解释器体检——损坏→拒绝且不删）；cleanup 决策矩阵（policy × 存在 × 标记 × 同/异路径 × 前缀包含（方向性） × 删除失败注入）；wrapper-state 写入（成功更新 lastVenvPath；写失败不更新且不影响安装结果——对齐 §6 写失败行）。
2. **tools venv 分支**：tmpdir 假 venv（`pyvenv.cfg` + marker）；info/check_env/setup_deps 的 venv 分支与 payload 断言；schema 快照（新增字段）；`installCmd` 形态（venv pip 路径；flags 忽略注明）；系统模式回归——系统模式行为断言保持全绿；既有 schema 形状断言（逐字属性集 deepEqual）随 venv 增量同步修订，修订面限于形状断言，行为断言不改。
3. **入口 skill**：四态 body 内容断言（解释器路径、前置路由语、准备指引）；provider 数量 = vendor N + 1；不落盘断言；工具描述解释器提示语断言（venv 开时 `ppt_master_info`/`ppt_master_check_env` 描述含提示语——§5.3 交付项）。
4. **apply 集成**：Config 默认值；config 注入路径（loader 形态、opts 覆盖、两者共存、venv 缺省默认值）；**volatile 引用→普通值快照断言**（loader 形态下叶子为引用对象，apply 下传前已 `.get()` 去引用）；无效配置降级 warn。
5. **兼容面**：verify-plugin（入口 skill 不在 vendor 面——负向确认）；sync-upstream 零交互；check-dsh-compat 通过——验证面**需扩展**（当前脚本无此面）：新增 Config 挂载形态 + volatile 声明存在性检查，并经真实 SkillRegistry 读回技能列表断言入口技能在场。
6. **真实树 smoke（验收期）**：本机以 `/dsh-home/.ppt-master/venv` 实建 venv + 实装 19 依赖（用户触发；该路径为本机**显式配置值**而非 `~` 展开结果，与默认值 `~/.ppt-master/venv` 构成默认/显式覆盖关系）；热重载验证：本机改配置→观察入口 skill 正文/工具行为换代（依赖 Config volatile 声明与 apply 统一注入通道成立）。
7. **设计成立性前置检查**（可执行验收项）：① Config volatile 声明存在；② apply 第二参注入通道可用；③ profile `cordis.patch.yml` 存在 `id: dsh-ppt-master-wrapper` 条目；④ schemastery 可解析性（compat 脚本经 §3 同一受控解析通道验证）；⑤ 入口技能经真实注册面接受（compat 脚本经真实 SkillRegistry 读回列表断言在场）。

> 注记：本机 Node v22 下测试命令须用 glob 形态 `node --test tests/*.test.mjs`（目录形式 MODULE_NOT_FOUND）。

## 8. 文档与发布

README 交付核对表（散点义务合并于此）：

- venv 配置说明：容器挂载卷建议、PEP 668 说明、禁用后手动清理；入口 skill 用法、配置页指引。
- 挂载卷/镜像不变边界：挂载只保证数据不丢；跨容器重建后 venv 可用性依赖镜像不变（符号链接指向容器内绝对路径）；损坏恢复=删除重建（§5.1/§6）。
- 标记即授权：已标记 venv 目录内混入的数据会被递归删除（§5.4 残留风险①）。
- 孤儿处理：未标记孤儿手动处理；有标记无登记（容器重建后登记丢失，§5.4）手动处理。
- 设置页诊断：不可投影/写入被拒时的 profile patch 手工编辑路径（§6.1①）。
- schemastery 解析失败诊断：宿主 node_modules 需存在该包（§6.1⓪）。
- 入口技能缺失诊断：宿主注册面拒绝合成候选时 vendor 技能不受影响（§6.1④）。

版本历史行随下次 sync 规则③ `-r` 递增发布（本特性为包装层提交，不触碰上游）。

部署前置：首次使用配置页前需在 profile `cordis.patch.yml` 建立 `id: dsh-ppt-master-wrapper` 条目（宿主设置页编辑会代为建立 / 操作者手工建立，README 写明）。config 为整体替换语义：插件升级新增字段后，已存在的 patch 条目需比对补全新字段（否则新字段回落默认值）。
