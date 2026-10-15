# 设计：ppt-master venv 隔离 + 插件配置页（2026-10-15）

任务名：`2026-10-15-ppt-master-venv-config` · 模式：中等
需求真相源：`docs/superpowers/clarifications/2026-10-15-ppt-master-venv-config.md`

## 1. 概述与动机

本机实测：DSH 容器内 19 个 Python 依赖 0/19 已装，且系统 Python 为 PEP 668（EXTERNALLY-MANAGED），裸装需 `--break-system-packages` 且装入容器 rootfs（重建即丢）。本设计为包装层引入**可选 venv 隔离**（懒创建、可配置路径、旧路径清理策略）与**原生 schema 配置页**（cordis Config → DSH 设置自动出页，含加载期版本注解），并以**包装层自有的入口 skill**（`ppt-master-env`）承担解释器路由——不修改任何上游文件，方案A 字节级 vendor 约束（spec `2026-10-14-dsh-ppt-master-wrapper-design.md` §4）继续成立。

## 2. 目标 / 非目标

**目标**
- G1 venv 隔离：`venv.enabled/path/oldPathPolicy` 三配置；懒创建（仅 `ppt_master_setup_deps`）；venv 内安装无 PEP 668 拦截。
- G2 原生配置页：Config schema 注解承载插件版本、上游版本、SKILL_DIR（加载期生成）；配置变更经 Loader 热重载即时生效。
- G3 入口 skill `ppt-master-env`：四态正文给出当前解释器契约；description 声明"使用 ppt-master 前必读"。
- G4 工具 venv 感知：`info`/`check_env`/`setup_deps` payload 增量字段；`setup_deps` 独占 venv 创建/删除副作用。
- G5 旧 venv 生命周期：所有权标记 + `wrapper-state.json` 登记上次路径 + `oldPathPolicy`（默认 keep）；删除仅对"pyvenv.cfg 存在 + 带标记"目录。

**非目标**
- 实时状态面板 / 自研前端页（`dsh.client` 范式明确不采用）。
- 修改任何上游文件或 served body（vendor 面字节不变）。
- venv 真迁移（stdlib venv 不可重定位——迁移≡新建+重装+可选删旧）。
- venv 内依赖版本锁定；禁用 venv 时的自动删除（纯手动 `rm -rf`）。

## 3. 架构

```
profile cordis.patch.yml（按 id config 整体替换语义）
        │ Loader 组合 → apply(ctx, config)
        ▼
index.js  ── export const Config = z.object({ venv: {enabled,path,oldPathPolicy} })
   │           （模块加载期生成版本注解：插件版本 ← package.json；上游版本 ← skills 扫描）
   ├─ createSkillProvider(config)   skill-provider.js
   │     ├─ vendor 技能（现状：skills/ 树字节原样）
   │     └─ 合成入口技能 ppt-master-env（body 按四态渲染，内存合成，无文件）
   └─ createTools(config)           tools.js
         └─ lib/venv.js（纯函数 + 注入 run）
              resolveVenvPath / venvExists / marker 读写
              ensureVenv / cleanupOldVenv / wrapper-state 登记
```

组件职责：`lib/venv.js` 承载全部 venv 决策与副作用原语；`tools.js` 只做探测编排与 payload 组装（`setup_deps` 是唯一调用 ensureVenv/cleanupOldVenv 的地方）；`skill-provider.js` 新增合成入口技能；`index.js` 声明 Config 并下传。零 npm 依赖不变。

## 4. 数据流

1. **配置变更**：设置页编辑 → `ctx.settings`（SettingsForms）分层 profile patch + 修订冲突检测 → Loader 热重载 → 插件实例带新 config 重建 → 入口 skill 正文、工具行为、配置页注解同步换代（免 DSH 整体重启）。
2. **技能路由**：模型见目录中 `ppt-master-env`（description 声明前置）→ 读入口 → 按约定解释器跑上游脚本（含 SKILL.md 第 2 步 attribution_guard 的字面 `python3` 替换）→ 路由至 `ppt-master`。
3. **环境准备**（`ppt_master_setup_deps`，唯一副作用点）：
   - venv 开：`ensureVenv`（缺则 `python3 -m venv <path>` + 写标记；已有则收编补标记）→ `<venv>/bin/pip3 install -r ${SKILL_DIR}/requirements.txt` → 成功后 `cleanupOldVenv`（比对 `wrapper-state.json` 登记的上次路径，按 `oldPathPolicy`）→ 更新登记 → 复跑 check_env。
   - venv 关：现行系统模式（`pip3` + 可选 `--user`/`--break-system-packages`）不变。

## 5. 接口

### 5.1 Config schema（index.js 导出；注解即配置页文案）

| 字段 | 类型/默认 | 说明 |
|---|---|---|
| `venv.enabled` | boolean，`false` | venv 隔离开关 |
| `venv.path` | string，`'~/.ppt-master/venv'` | `~` 于使用处按 DSH 宿主进程 HOME 展开；须绝对或 `~` 前缀 |
| `venv.oldPathPolicy` | `'keep' \| 'delete'`，`'keep'` | 路径变更后对旧标记 venv 的处理 |

配置页版本注解（加载期生成，热重载刷新）：插件版本（package.json）、上游 skill 版本（skills 扫描 `metadata.version`）、SKILL_DIR。

### 5.2 入口 skill `ppt-master-env`

- name：`ppt-master-env`；description：中英双语，声明"任何 ppt-master 路由前必须先读本入口：它给出当前生效解释器与准备状态"。
- body 四态（加载期按 config + 文件系统快照渲染；若 provider 工厂按目录访问调用则天然新鲜，实现期验证，否则正文注明以 `ppt_master_info`/`check_env` 实时为准）：
  1. venv 开+已建：解释器 = `<解析后绝对路径>/bin/python3`，一切上游脚本调用一律以它替换字面 `python3`；给出 SKILL_DIR；读毕即路由 `ppt-master`。
  2. venv 开+未建：先调用 `ppt_master_setup_deps` 准备环境；在此之前不以系统 python3 跑业务脚本。
  3. venv 关：系统 `python3`（现状）。
  4. 配置无效（相对路径）：指明修正方式，按系统模式继续。
- 注册形态：provider 技能列表 = vendor N + 入口 1；入口不落盘，不进 verify-plugin 字节比对面。

### 5.3 工具 payload 增量（全部 additive；现有字段与系统模式语义不动）

- `ppt_master_info` += `venv: { enabled: boolean, path: string|null(解析后绝对), exists: boolean, pythonPath: string|null }`。
- `ppt_master_check_env` += `venv: { enabled, path, exists, python: {found, version, meetsSkillRequirement}|{skipped} }`；`python` 小节保持系统探测；依赖探测走**生效解释器**：venv 开且存在 → venv python；venv 关 → 系统 python；**venv 开但缺失 → 不回退系统探测**，全部依赖条目为 `'UNKNOWN'`/`source:'unknown'`（生效解释器缺失，装没装无从谈起——不以系统态谎报）。
- `ppt_master_setup_deps`：venv 开 → `installCmd = [<venv>/bin/pip3, 'install', '-r', <req>]`（`user`/`breakSystemPackages` 参数仅系统模式生效，venv 模式忽略并在 payload 注明）；payload += `venv: { created: boolean, path }`、`cleanup: { oldPath, action: 'none'|'kept'|'deleted'|'failed', error?: string }`。

### 5.4 lib/venv.js（纯函数 + 注入 run；风格同现有 spawnRun）

- `resolveVenvPath(config) → { path: string|null, invalidReason: string|null }`（`~` 展开；相对路径判无效）。
- `venvExists(path)`：`pyvenv.cfg` 存在性。
- marker：`<venv>/.ppt-master-wrapper.json`（`{ createdAt, path }`），读写 + 收编（存在 venv 缺标记则补写）。
- `wrapper-state.json`：`<HOME>/.ppt-master/wrapper-state.json`，`{ lastVenvPath }`。
- `ensureVenv(run, path, signal) → { created, error? }`；`cleanupOldVenv(oldPath, policy, currentPath) → { action, error? }`（删除仅当：路径≠当前、`venvExists`、带标记；`rmSync` 递归）。

## 6. 错误处理

| 情形 | 行为 |
|---|---|
| `python3 -m venv` 非零/spawn 失败 | 记入 `installExit`（spawn 级为 -1），check_env 照跑（系统态），不 throw |
| venv 内 pip 安装失败 | 现行语义：非零记录不抛，复跑诊断 |
| cleanup 删除失败 | `cleanup.action='failed'` + error 字符串，不抛 |
| 配置 path 相对/无效 | apply 期 console.warn，venv 视为关闭，入口 skill 写明修正方式 |
| check_env venv 探测 | 全程诊断性（缺 venv = 状态值非错误） |
| 解释器软路由失效（模型未读入口） | 入口 description 强引导 + 工具描述兜底提示为缓解；不承诺硬保证（方案A 约束） |

## 7. 测试策略

1. **lib/venv.js 单测**：路径解析矩阵（`~`/绝对/相对）；exists；ensureVenv（stub run：argv 断言、marker 写入、已存在收编、创建失败）；cleanup 决策矩阵（policy × 存在 × 标记 × 同/异路径 × 删除失败注入）。
2. **tools venv 分支**：tmpdir 假 venv（`pyvenv.cfg` + marker）；info/check_env/setup_deps 的 venv 分支与 payload 断言；schema 快照（新增字段）；`installCmd` 形态（venv pip 路径；flags 忽略注明）；系统模式回归——现有 382 用例全绿不动。
3. **入口 skill**：四态 body 内容断言（解释器路径、前置路由语、准备指引）；provider 数量 = vendor N + 1；不落盘断言。
4. **apply 集成**：Config 默认值；config 注入路径（Loader 形态与 opts 覆盖共存）；无效配置降级 warn。
5. **兼容面**：verify-plugin（入口技能不在 vendor 面——负向确认）；sync-upstream 零交互；check-dsh-compat 通过。
6. **真实树 smoke（验收期）**：本机以 `/dsh-home/.ppt-master/venv` 实建 venv + 实装 19 依赖（用户触发）。

## 8. 文档与发布

README：venv 配置说明（含容器挂载卷建议、PEP 668 说明、禁用后手动清理）、入口 skill 用法、配置页指引；版本历史行随下次 sync 规则③ `-r` 递增发布（本特性为包装层提交，不触碰上游）。
