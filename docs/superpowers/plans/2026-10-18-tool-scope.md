# 实施计划：插件工具可见范围（2026-10-18）

> 输入：`docs/superpowers/specs/2026-10-18-tool-scope-design.md`（Gate 0 三份审查已并入 §11）+ `docs/superpowers/clarifications/2026-10-18-tool-scope.md`。
> `openspec` CLI 不可用 ⇒ Phase 1 走跳过路径（`.superpowers/.phase1-skipped`），本计划直接以 design doc 为输入。
> 切片：**A＝宿主半边**（验收 §7 人工①–③）、**B＝卡片**（验收 §7 人工④）。

## Global Constraints

- 零新增 npm 依赖、零构建链；宿主半边纯 ESM，`lib/client.js` 保持自包含单文件（require 白名单只有 react 系）。
- **不动** `skills/ppt-master/**`（vendor 红线）、**不动** `lib/venv.js`（`assembleInjectionBag` 已丢弃未知键，`opts.scope` 从原始 opts 读）。
- 默认 `global` 下：不注入、不装层、不装 guard、**不产生任何新日志**（既有 `apply.test.mjs` 的"能力齐全时不得输出降级日志"必须原样通过）。
- 工具名清单从 `createTools()` 产出派生，**不写第二份字面量**。
- 全量测试命令 `node --test tests/*.test.mjs`（Node 22 下目录参数失效）。

## Task 1 — 纯逻辑层（A）

文件：`lib/scope.js`、`tests/scope.test.mjs`（TDD：测试先红）。
内容：`SCOPE_KEY/SCOPE_MODES/SCOPE_DEFAULT`、`readScopeConfig`（惰性解引用；缺省⇒global；**非法⇒更严一侧 selected+[]**）、`isVisible` 严格序、`describeWorkspace`、`projectAgent`、`readWorkspaces`、`toolNamesOf`、`resolveNow`（同步）、`judgeAgent`（异步四态）。
验收：`node --test tests/scope.test.mjs` 全绿（35 条）。

## Task 2 — 宿主集成层（A）

文件：`lib/scope-host.js`、`tests/scope-host.test.mjs`（TDD）。
内容：能力探针；`global` **两层短路**（装配期无条件建探针 + `loader/volatile-update` 订阅，只短路注入/装层/guard/warn）；`ctx.inject(['agents','workspaceRegistry'])`；差异式装/卸 `agent.ctx.tools.restrict({deny})`；根 ctx `tools.guard`（缓存未命中时 `resolveNow` 同步重判）；`agent/created` 监听器**返回 promise 且绝不 reject**（宿主 await ⇒ 首轮即正确）；`agent/disposed`；`tools/change` 合并闸门；`loader/volatile-update` 双向切换；三类"判不了"的降级；拆除顺序与幂等；`resolveByPath` 1500ms 上界。
验收：`node --test tests/scope-host.test.mjs` 全绿（31 条）。

## Task 3 — 装配接线（A）

文件：`index.js`（Config 增 `scope` 两叶 + `mountToolScope` 接线 + `ctx.effect` 注册 dispose）、`tests/apply.test.mjs`（新增 selected 降级用例与"未配置 scope 零日志"用例）。
验收：`node --test tests/apply.test.mjs` 全绿（24 条）。

## Task 4 — 兼容面（A）

文件：`scripts/check-dsh-compat.mjs`（`VOLATILE_LEAF_COUNT` 3→5、注释口径）、`tests/compat.test.mjs`（替身 schemastery 补 `array`、计数断言 3→5）。
验收：`node scripts/check-dsh-compat.mjs` → `OK（warnings 0）`；`tests/compat.test.mjs` 全绿。

## Task 5 — 卡片（B）

文件：`lib/client.js`（`readScope`/`readBaseline`/`LEAF_SPECS` 路径对/`sameLeaf`/`SCOPE_RESET_OPS`/工作区 store/渲染节/字典 13 键/`workspaces` 回调式注入/CSS）、`tests/client-half.test.mjs`（新增 10 条 + `calls.injects` 断言更新）。
验收：`node --test tests/client-half.test.mjs` 全绿（60 条）。

## Task 6 — 发布面（A+B）

文件：`package.json`（`6.7.1-r1`）、`lib/client.js` 的 `PLUGIN_VERSION`、`README.md` / `README.en.md`（新一节 + patch 示例 + 版本历史行）、`cordis.patch.yml`（**仅注释示例**）。
验收：全量 `node --test tests/*.test.mjs` 全绿；`check-dsh-compat` OK。

## 验收期人工步骤（需活 GUI）

1. 默认 `global`：本会话工具表仍见 3 个 `ppt_master_*`。
2. 卡片切 `selected` 且只勾 `ppt-master` 工作区 → **保存后不重启**，本会话仍见这 3 个工具。
3. 在 `hermes` 工作区新开会话 → 工具表里没有这 3 个工具；直接调用会被 guard 拒绝并给出原因。
4. 切回 `global` → 工具立刻回来（无需重启）。

## 结果

| Task | 状态 | 证据 |
|---|---|---|
| 1 纯逻辑 | 完成 | 35/35 |
| 2 宿主集成 | 完成 | 43/43（Gate 3 返工后） |
| 3 装配接线 | 完成 | 24/24 |
| 4 兼容面 | 完成 | compat OK（warnings 0） |
| 5 卡片 | 完成 | 63/63（含 scope 13 条） |
| 6 发布面 | 完成 | 全量 670/670（时点；现 711） |

**Gate 3 记录**：四轮收敛——R1（12 项，含 P0 F1）→ R2（5 项，含 P1 GR2-1）→ R3（2 项，GR3-1 P1 / GR3-2 P2）→ R4（0 项，action=exit）。裁定全文见 design §11。
**交付**：PR #6 squash 合入 main（`c541199`），tag `v6.7.1-r1`。
