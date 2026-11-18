# 工具可见范围改用步骤级 `when`（2026-11-18）

状态：已实现（PR #58；方案 1：全量迁移，引擎下限抬到顶部 `engines.dsh >=0.2.2-rc.1`）。

## 1. 为什么改

现实现（`lib/scope-host.js`，820 行）把可见范围实现为**装在别人身上的一层**：逐个
agent 在 `agent.ctx.tools` 上 `restrict()`、在根 ctx 上装 `guard()`、订阅
`agent/created`、靠 30s 注入看门狗与有界复检兜住 boot 期竞态，并用差异式装层避免
`tools/change` 自激。

这套机制的正确性依赖三个外部时序假设（注入何时到、agent 何时销毁、工作区投影何时
稳定），issue #33 的两类现场问题（看门狗误报、已销毁会话装层被拒）都出自这里。

宿主自 dsh-tools 0.2.2-alpha.2 起提供**步骤级可见性**：

```js
tools.register(definition, { when(context) { /* context = { agent, signal } */ } })
```

每个模型步骤，宿主调 `tools.resolve({ agent, signal })`，逐个 `await when(...)`；
只有 `true` 的注册进入本步可见集（投影与执行都按它过滤，隐藏工具的调用按
`UNKNOWN_TOOL` 失败）。条件抛错会让**步骤准备**失败（`TOOL_ACTIVATION_FAILED`），
因此条件内部必须自吞异常并返回 `false`。

于是「装层」整个消失：没有 per-agent 限制层、没有根 guard、没有 agent 生命周期
订阅、没有复检定时器，配置保存下一步生效。参考实现：`dsh-cherry-bridge` 的
`src/toolScopeHost.ts`（#345 起只保留这一条路径）。

## 2. 决策与代价

- **全量迁移**：删掉 restrict/guard/看门狗/生命周期机制，不保留双轨。
- **引擎下限**：顶部 `engines.dsh` 从 `>=0.1.1-rc.1` 抬到 **`>=0.2.2-rc.1`**（`dsh.engines`
  不是宿主兼容门读取的字段——`dsh-app-boot` 与插件市场都只读顶部 `engines.dsh`）。
  0.2.1 的 dsh-tools **没有** `when`/`resolve`（npm 实测 0.2.1-rc.5 内 0 处），
  第二参会被静默忽略 ⇒ `selected` 失效且无报错。这是最坏的失败方式，故不允许
  「带 when 但宿主不认」的形态存在。
- **自证兜底**：兼容门只挡得住「安装/清单」路径；link: 形态或跳过校验的宿主仍可能把
  0.2.1 拉起来，因此 `apply` 仍自检 `typeof ctx.tools.resolve === 'function'`；缺失即
  **fail-loud 抛错**（整插件不激活，命名「需要 DSH ≥ 0.2.2（tools.resolve）」），
  不静默放行。

## 3. 目标语义（与现状等价的部分）

1. `global` 恒可见（含无 cwd、无归属会话）——默认配置与「没有该特性」逐字等价。
2. `selected` fail-closed：无 cwd、路径不属任何已登记工作区、名单为空、判定未完成，
   一律不可见。
3. 判定两条规则不变：会话成员（`workspace.sessionIds` 含 agent id）→ 规范化路径
   （`resolveByPath`，不可用时退化为大小写敏感的字符串等价）。
4. 配置读取仍是 volatile 现读：`when` 每次调用解引用，保存后下一步生效。

## 4. 新结构

`lib/scope.js`（纯逻辑，保留）：`readScopeConfig` / `isVisible` / `projectAgent` /
`readWorkspaces` / `resolveNow`（同步：成员 + 字符串路径）/ `judgeAgent`（异步：成员 +
`resolveByPath`）。

`lib/scope-host.js`（重写，约 320 行）导出 `mountToolScope(ctx, options)`：

- `options`: `{ scopeConfig, warn, now }`；返回 `{ when, invalidate, dispose, hostState }`。
- `when(context)`：**同步**、**永不抛**，按下述顺序回答：
  1. 读配置（现读 volatile）；`mode=global` ⇒ `true`（不碰注册表）。
  2. `projectAgent(context?.agent)` 无 id ⇒ `false`。
  3. `registry.list()` 现读 → `readWorkspaces` + `pathMap`；`resolveNow` 命中 ⇒
     `isVisible(config, workspaceId)`。
  4. 未命中且有 cwd ⇒ 触发一次**异步精化**（`judgeAgent` + `resolveByPath`，按
     **agent 对象**单飞 + 2s 节流 + 代际），本步返回 `false`；后续步骤读缓存。
  5. `context.signal.aborted` ⇒ `false`（宿主已取消本步）。
  6. 任何异常（list/resolveByPath/配置解引用）⇒ `false`。
- 异步精化只提升符号链接/拼写差异的命中率，不参与 fail-open：没跑完就按不可见。
- 缓存：**按 agent 对象**（WeakMap）记账，不用 agent id——宿主会跨 clear/压缩/resume
  复用 id，按 id 会让曾精化命中的会话在 cwd 移出工作区后仍可见。正缓存存
  `{workspaceId, cwd, basis, fingerprint}`：cwd 必须相同，路径依据还要求注册表指纹不变，
  成员依据还要求该会话仍在该工作区名单里（被移出后不沿用旧结论）。负缓存中 `no-match`
  与**注册表指纹**（工作区 id+路径的有序快照）绑定：指纹不变不重试，变了才重排；
  `unresolved` 最多重试 3 次。代际在 mount、
  注入到达、`loader/volatile-update` 与 `invalidate()` 时递增；落败代际不写缓存。
  无 cwd 时不读任何缓存。
- 一步一结论：宿主对同一次 `resolve()` 的所有工具复用同一个 `context` 对象，故按
  context（WeakMap）缓存本步答案，避免精化在微任务里落定后同一步出现部分可见。
- 注入：只用 `ctx.inject(['workspaceRegistry'], cb)`；注入未到 ⇒ `selected` 全部
  fail-closed（无定时器）。

## 5. 删除面

- `lib/scope-host.js` 的：`restrict` 安装/释放与差异式装层、根 `guard` 与拒绝文案、
  `agent/created` / `agent/disposed` 订阅、注入看门狗、有界复检定时器、判定轮次合并、
  `toolNamesOf` 驱动的名字清单（注册不再需要名字）。
- `check-dsh-compat.mjs` §7.7⑦ 的 restrict/guard 探针与 guard 拒绝语义（连同
  executor 端到端观察通道中的 guard 部分），改为验证 `when` 契约。
- 对应测试：`tests/scope-host.test.mjs` 整体重写；`tests/scope.test.mjs` 纯逻辑用例保留。

## 6. 行为差异与边界

| 项 | 现状 | 迁移后 |
|---|---|---|
| 隐藏工具被调用 | 我们的 guard 返回中文解释 | 宿主 `UNKNOWN_TOOL`（不再有自定义解释；README 的「已知限制」说明成因） |
| 0.2.1 及更早 | 可用（走 restrict/guard） | 拒绝装载（引擎下限 + apply 自检） |
| 首轮可见性 | `agent/created` 被 await，首轮前判定 | 同步快路径（成员/字符串路径）即命中；符号链接 cwd 的首轮、或 `workspaceRegistry` 注入晚到的整段启动期可能不可见，异步精化/注入后恢复 |
| 判定成本 | 事件驱动 | 每步每工具一次：global 常量返回；selected 走一次 `list()` + 字符串比较 |

## 7. 测试计划

- 纯逻辑（`tests/scope.test.mjs`）：不变，补 `resolveNow` 的边界。
- 宿主集成（重写 `tests/scope-host.test.mjs`）：
  1. global：`when` 恒 true，不读注册表（list 抛错也不影响）；
  2. selected 命中/未命中/无 cwd/名单为空；
  3. 注入未到 ⇒ fail-closed；到达后命中；
  4. `when` 内异常 ⇒ false，不抛；
  5. 异步精化：`resolveByPath` 命中后下一步可见；抛错保持不可见；
  6. 配置热变更 ⇒ 下一步生效（volatile 现读）；
  7. 代际：mount/invalidate 后旧精化结果不写缓存；volatile 事件使负缓存作废；
  8. 能力自检：`tools.resolve` 缺失 ⇒ `assertWhenCapable` 抛命名错误（`apply` 调用）；
  9. 缓存键：同 id 的新 agent 对象不继承旧精化结论；cwd 消失后不得读缓存；
  10. 负缓存：no-match 与注册表指纹绑定（清单变化后重排），瞬时失败最多 3 次；
  11. 一步一结论：同一 context 对象内精化落定不改变本步答案；
  12. global 明确零注册表读取；注入晚到 flush 后命中；非法配置告警一次。
- compat：新 §7.7⑦ 断言 `resolve` 在场，并用 `when: false` 的探针工具验证被排除、
  `when: true` 被纳入，并断言 when 收到的 context 就是 resolve 的 `{agent, signal}`；
  stub 宿主缺 `resolve` 时记 **problem**（引擎下限押在它上面），不降级为 note。
  该探针证明的是**宿主契约**；本插件自己的接线（三个工具都带 `when`）由
  `verify-plugin` 对 `register(tool, options)` 的断言与 `scope-host` 集成测试覆盖。

## 8. 迁移顺序（一个 PR）

1. 红：新测试到位（能力自检、global/selected、注入、精化）。
2. 绿：重写 `scope-host`；`index.js` 先 `mount` 再 `register(tool, { when })`；
   `package.json` 抬下限。
3. 删旧测试与 compat 探针，补新探针。
4. 文档：AGENTS §3/§4、本文件、README 版本表留到发版时补。
