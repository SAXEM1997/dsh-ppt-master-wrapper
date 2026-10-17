import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as host from '../lib/scope-host.js';

// ─── fake host（无 mock 框架：手写对象即可，design §7）─────────────
//
// 关键点：`tools.restrict` **只在 agent 作用域**存在（宿主实测：在插件根 ctx 调用会抛错），
// 所以假宿主把 restrict 挂在 `agent.ctx.tools` 上；根 ctx 的 `tools` 只有 `guard`。

const TOOL_NAMES = ['ppt_master_info', 'ppt_master_check_env', 'ppt_master_setup_deps'];
const W1 = { id: 'w1', title: 'ppt-master', path: '/workspace/ppt-master', sessionIds: ['member-1'] };
const W2 = { id: 'w2', title: 'hermes', path: '/workspace/hermes', sessionIds: [] };

function makeAgent({ id, cwd, restrictable = true }) {
  const record = { id, cwd, installed: 0, released: 0, filters: [] };
  const agent = {
    id,
    session: { header: cwd === undefined ? {} : { cwd } },
    ctx: { tools: {} },
  };
  /**
   * 假 `restrict` 逐条复刻真宿主的**三条前置条件**（Gate 3 F5）：
   * ① 必须在 agent 作用域调用（根 ctx 调用抛 "requires a scoped context"）；
   * ② filter 不能为空（`{}` 是 no-op 配置 bug）；
   * ③ 名字必须 ∈ 已知全局工具名（未知名字抛错）。
   * 少了这三条，"把 `this` 弄丢"或"名字漂移"这类改动会静默通过全部用例。
   */
  agent.ctx.tools.restrict = function restrict(filter) {
    if (this !== agent.ctx.tools) {
      throw new Error('tools.restrict() requires a scoped context (agent.ctx)');
    }
    const deny = filter?.deny ?? [];
    if (deny.length === 0 && (filter?.allow ?? []).length === 0) {
      throw new Error('tools.restrict({}) is a no-op');
    }
    const unknown = deny.filter((name) => !TOOL_NAMES.includes(name));
    if (unknown.length > 0) {
      throw new Error(`tools.restrict() names unknown global tool "${unknown[0]}"`);
    }
    record.installed += 1;
    record.filters.push(filter);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      record.released += 1;
    };
  };
  if (!restrictable) delete agent.ctx.tools.restrict;
  return { agent, record };
}

function makeHost(options = {}) {
  const {
    canInject = true,
    canGuard = true,
    canRestrict = true,
    canOn = true,
    injectNeverResolves = false,
    agents = [],
    workspaces = [W1, W2],
    listThrows = false,
    resolve = async (path) => workspaces.find((w) => w.path === path),
    restrictThrows = false,
  } = options;

  const events = new Map();
  const calls = { injectKeys: [], warnings: [], guards: [], listCalls: 0, resolveCalls: [] };

  const child = {
    agents: { list: () => agents.map((entry) => entry.agent) },
    workspaceRegistry: {
      list() {
        calls.listCalls += 1;
        if (listThrows) throw new Error('registry down');
        return workspaces;
      },
      resolveByPath(path) {
        calls.resolveCalls.push(path);
        return resolve(path);
      },
    },
    tools: {},
    on(event, cb) {
      const list = events.get(event) ?? [];
      list.push(cb);
      events.set(event, list);
      return () => {
        events.set(
          event,
          (events.get(event) ?? []).filter((item) => item !== cb),
        );
      };
    },
  };

  if (canGuard) {
    child.tools.guard = (fn) => {
      calls.guards.push(fn);
      // 精确摘除**自己这一条**：真宿主 guard 层每条 disposer 只回收自己（R3-2 复审证实）。
      // 若这里一刀 `length = 0`，"重复注册 guard"这类累积型泄漏会被静默掩盖。
      return () => {
        const index = calls.guards.indexOf(fn);
        if (index >= 0) calls.guards.splice(index, 1);
      };
    };
  }

  const ctx = {
    tools: {
      ...(canGuard ? { guard: (fn) => child.tools.guard(fn) } : {}),
      ...(canRestrict ? { restrict: () => () => {} } : {}),
    },
    ...(canInject
      ? {
          inject(keys, cb) {
            calls.injectKeys.push(keys);
            // 模拟"注入尚未到达"：登记了但回调永远不执行（宿主 pending 态）。
            if (injectNeverResolves) return undefined;
            return cb(child);
          },
        }
      : {}),
    ...(canOn ? { on(event, cb) { return child.on(event, cb); } } : {}),
  };

  if (!canRestrict) {
    // 宿主整体不支持 restrict ⇒ agent 作用域也没有（否则测的不是降级档位）
    for (const entry of agents) delete entry.agent.ctx.tools.restrict;
  }
  if (restrictThrows) {
    for (const entry of agents) {
      entry.agent.ctx.tools.restrict = () => {
        throw new Error('unknown global tool');
      };
    }
  }

  /** 事件派发：**返回 promise 并 await 监听器**——宿主对 agent/created 就是这么做的。 */
  const emit = async (event, payload) => {
    const results = [];
    // 先收集返回值再统一 await：宿主对 agent/created 是"拿到 promise 再等"，
    // 若这里先 await 就会把 promise 拍平，测不出"监听器是否返回 promise"。
    for (const cb of [...(events.get(event) ?? [])]) results.push(cb(payload));
    await Promise.all(results);
    return results;
  };

  return { ctx, child, calls, events, emit };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 起一个 scope host；`scopeConfig` 用可变容器模拟 volatile 引用。 */
function mount(hostCase, scopeConfig) {
  const handle = host.mountToolScope(hostCase.ctx, {
    scopeConfig,
    toolNames: TOOL_NAMES,
    warn: (message) => hostCase.calls.warnings.push(String(message)),
  });
  return handle;
}

const SELECTED_W1 = { mode: 'selected', workspaceIds: ['w1'] };
const GLOBAL = { mode: 'global', workspaceIds: [] };

// ─── global 默认：整段短路（澄清 C7 / design §6）────────────────

test('global 模式：不注入、不装层、不装 guard、不产生任何日志', async () => {
  const { agent, record } = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent, record }] });
  const handle = mount(hostCase, GLOBAL);
  await handle.whenIdle();

  assert.deepEqual(hostCase.calls.injectKeys, [], '不注入');
  assert.deepEqual(hostCase.calls.warnings, [], '不 warn');
  assert.deepEqual(hostCase.calls.guards, [], '不装 guard');
  assert.equal(record.installed, 0, '不装限制层');
  handle.dispose();
});

test('global 模式：dispose 幂等且不抛', () => {
  const hostCase = makeHost();
  const handle = mount(hostCase, GLOBAL);
  assert.doesNotThrow(() => handle.dispose());
  assert.doesNotThrow(() => handle.dispose());
});

// ─── selected：装配层移除（design §5.3）────────────────────────

test('selected：首轮给不可见 agent 装限制层，deny 名单＝工具名清单', async () => {
  const hermes = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const ppt = makeAgent({ id: 'b', cwd: '/workspace/ppt-master' });
  const hostCase = makeHost({ agents: [hermes, ppt] });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();

  assert.deepEqual(hostCase.calls.injectKeys, [['agents', 'workspaceRegistry']]);
  assert.equal(hermes.record.installed, 1, '名单外工作区被移除工具');
  assert.deepEqual(hermes.record.filters[0], { deny: TOOL_NAMES });
  assert.equal(ppt.record.installed, 0, '名单内工作区不受影响');
  handle.dispose();
});

test('selected + 空名单：所有 agent 都被移除工具（fail-closed）', async () => {
  const a = makeAgent({ id: 'a', cwd: '/workspace/ppt-master' });
  const hostCase = makeHost({ agents: [{ agent: a.agent, record: a.record }] });
  const handle = mount(hostCase, { mode: 'selected', workspaceIds: [] });
  await handle.whenIdle();
  assert.equal(a.record.installed, 1);
  handle.dispose();
});

test('selected：会话成员命中优先于 cwd（工作区 sessionIds 决定）', async () => {
  const member = makeAgent({ id: 'member-1', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent: member.agent, record: member.record }] });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();
  assert.equal(member.record.installed, 0, '规则一命中 w1 ⇒ 可见');
  handle.dispose();
});

test('selected：无 cwd 的会话不可见（fail-closed）', async () => {
  const a = makeAgent({ id: 'a', cwd: undefined });
  const hostCase = makeHost({ agents: [{ agent: a.agent, record: a.record }] });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();
  assert.equal(a.record.installed, 1);
  handle.dispose();
});

test('selected：路径不在注册表 ⇒ 不可见', async () => {
  const a = makeAgent({ id: 'a', cwd: '/tmp/scratch' });
  const hostCase = makeHost({
    agents: [{ agent: a.agent, record: a.record }],
    resolve: async () => undefined,
  });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();
  assert.equal(a.record.installed, 1);
  assert.deepEqual(hostCase.calls.resolveCalls, ['/tmp/scratch']);
  handle.dispose();
});

test('selected：符号链接等价的路径 ⇒ 可见且**从未装过层**（不做同步猜测，G8）', async () => {
  const a = makeAgent({ id: 'a', cwd: '/symlink/ppt' });
  const hostCase = makeHost({ agents: [{ agent: a.agent, record: a.record }], resolve: async () => W1 });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();
  assert.equal(a.record.installed, 0);
  assert.equal(a.record.released, 0, '没有"先藏后放"的抖动');
  handle.dispose();
});

// ─── 事件：agent/created 被 await、agent/disposed ─────────────

test('agent/created：监听器返回 promise，宿主 await 后该会话首轮即正确', async () => {
  const hostCase = makeHost({ agents: [] });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();

  const { agent, record } = makeAgent({ id: 'late', cwd: '/workspace/hermes' });
  hostCase.child.agents.list = () => [agent];
  const results = await hostCase.emit('agent/created', { agent });

  assert.equal(results.length, 1);
  assert.ok(results[0] instanceof Promise, 'created 监听器必须返回 promise 供宿主 await');
  await results[0];
  assert.equal(record.installed, 1, 'await 返回时层已装好 ⇒ 首轮工具表正确');
  handle.dispose();
});

test('agent/created：判定抛错时监听器**不 reject**（不得连累会话创建）', async () => {
  const hostCase = makeHost({
    agents: [],
    resolve: async () => {
      throw new Error('realpath 挂死');
    },
  });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();

  const { agent } = makeAgent({ id: 'boom', cwd: '/workspace/hermes' });
  hostCase.child.agents.list = () => [agent];
  const results = await hostCase.emit('agent/created', { agent });

  await assert.doesNotReject(() => results[0], 'created 监听器绝不能 reject');
  handle.dispose();
});

test('agent/disposed：释放该 agent 的限制层并丢弃判定', async () => {
  const { agent, record } = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent, record }] });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();
  assert.equal(record.installed, 1);

  hostCase.child.agents.list = () => [];
  await hostCase.emit('agent/disposed', { agent });
  await handle.whenIdle();

  assert.equal(record.released, 1, '层被释放');
  handle.dispose();
});

test('工具重新注册（tools/change）：重算但不重复装层', async () => {
  const { agent, record } = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent, record }] });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();
  const before = record.installed;

  await hostCase.emit('tools/change');
  await handle.whenIdle();
  await hostCase.emit('tools/change');
  await handle.whenIdle();

  assert.equal(record.installed, before, '幂等：已装层的 agent 不重复安装');
  assert.equal(record.released, 0, '也不做"先释放再重装"（否则合并闸门永久脏）');
  handle.dispose();
});

// ─── 配置变更：loader/volatile-update（design §4 步 7）─────────

test('volatile 配置从 global 切到 selected：就地激活并装层', async () => {
  const { agent, record } = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent, record }] });
  const config = { mode: { get: () => 'global' }, workspaceIds: { get: () => [] } };
  const handle = mount(hostCase, config);
  await handle.whenIdle();
  assert.equal(record.installed, 0);

  config.mode = { get: () => 'selected' };
  config.workspaceIds = { get: () => ['w1'] };
  await hostCase.emit('loader/volatile-update', [['scope', 'mode']]);
  await handle.whenIdle();

  assert.equal(record.installed, 1, '切到 selected 后立刻装层');
  handle.dispose();
});

test('volatile 配置从 selected 切回 global：释放全部限制层与 guard', async () => {
  const { agent, record } = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent, record }] });
  const config = { mode: { get: () => 'selected' }, workspaceIds: { get: () => ['w1'] } };
  const handle = mount(hostCase, config);
  await handle.whenIdle();
  assert.equal(record.installed, 1);
  assert.equal(hostCase.calls.guards.length, 1);

  config.mode = { get: () => 'global' };
  await hostCase.emit('loader/volatile-update', [['scope', 'mode']]);
  await handle.whenIdle();

  assert.equal(record.released, 1, '回到 global ⇒ 层释放');
  assert.equal(hostCase.calls.guards.length, 0, 'guard 也卸掉');
  handle.dispose();
});

test('volatile 配置非法：落更严一侧（selected + 空名单）+ warn', async () => {
  const { agent, record } = makeAgent({ id: 'a', cwd: '/workspace/ppt-master' });
  const hostCase = makeHost({ agents: [{ agent, record }] });
  const config = { mode: { get: () => 'nope' }, workspaceIds: { get: () => ['w1'] } };
  const handle = mount(hostCase, config);
  await handle.whenIdle();

  assert.ok(hostCase.calls.warnings.some((line) => /配置非法/.test(line)));
  assert.equal(record.installed, 1, '非法配置下连名单里的工作区也被收紧');
  handle.dispose();
});

// ─── 执行层兜底：tools.guard（design §5.3）────────────────────

test('guard：不可见 agent 调用本插件工具 ⇒ 返回拒绝原因', async () => {
  const { agent } = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent, record: {} }] });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();

  const verdict = hostCase.calls.guards[0]({ name: 'ppt_master_info', agent: { id: 'a' } });
  assert.equal(typeof verdict, 'string');
  assert.match(verdict, /不可见|工作区/);
  handle.dispose();
});

test('guard：可见 agent / 非本插件工具 / 无 agent ⇒ 放行', async () => {
  const { agent } = makeAgent({ id: 'b', cwd: '/workspace/ppt-master' });
  const hostCase = makeHost({ agents: [{ agent, record: {} }] });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();
  const guard = hostCase.calls.guards[0];

  assert.equal(guard({ name: 'ppt_master_info', agent: { id: 'b' } }), undefined, '可见 ⇒ 放行');
  assert.equal(guard({ name: 'bash', agent: { id: 'a' } }), undefined, '非本插件工具 ⇒ 放行');
  assert.equal(guard({ name: 'ppt_master_info' }), undefined, '无调用者身份 ⇒ 放行');
  handle.dispose();
});

test('guard：判定缓存未命中 ⇒ 就地同步重判（规则一命中即拒绝）', async () => {
  const hostCase = makeHost({ agents: [] });
  const handle = mount(hostCase, { mode: 'selected', workspaceIds: [] });
  await handle.whenIdle();

  const verdict = hostCase.calls.guards[0]({
    name: 'ppt_master_info',
    agent: { id: 'member-1', session: { header: { cwd: '/workspace/ppt-master' } } },
  });
  assert.equal(typeof verdict, 'string', '成员命中 w1（不在名单）⇒ 同步重判即拒绝');
  handle.dispose();
});

test('guard：同步重判认不出 realpath 等价 ⇒ 放行（交给异步轮次）', async () => {
  const hostCase = makeHost({ agents: [] });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();

  const verdict = hostCase.calls.guards[0]({
    name: 'ppt_master_info',
    agent: { id: 'unknown', session: { header: { cwd: '/symlink/ppt' } } },
  });
  assert.equal(verdict, undefined);
  handle.dispose();
});

test('guard：global 模式下不安装', async () => {
  const hostCase = makeHost({ agents: [] });
  const handle = mount(hostCase, GLOBAL);
  await handle.whenIdle();
  assert.equal(hostCase.calls.guards.length, 0);
  handle.dispose();
});

// ─── 降级矩阵（design §6 逐行）───────────────────────────────

test('selected + 缺 tools.restrict：只装 guard + 一条 warn', async () => {
  const a = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent: a.agent, record: a.record }], canRestrict: false });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();

  assert.equal(a.record.installed, 0);
  assert.equal(hostCase.calls.guards.length, 1, '执行层仍拦');
  assert.equal(hostCase.calls.warnings.length, 1);
  assert.match(hostCase.calls.warnings[0], /restrict/);
  handle.dispose();
});

test('selected + 缺 tools.guard：只装 restrict + 一条 warn', async () => {
  const a = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent: a.agent, record: a.record }], canGuard: false });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();

  assert.equal(a.record.installed, 1);
  assert.equal(hostCase.calls.warnings.length, 1);
  assert.match(hostCase.calls.warnings[0], /guard/);
  handle.dispose();
});

test('selected + 缺 ctx.inject：全拒 guard + 一条 warn，不装层', async () => {
  const a = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent: a.agent, record: a.record }], canInject: false });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();

  assert.equal(a.record.installed, 0);
  assert.equal(hostCase.calls.warnings.length, 1);
  assert.match(hostCase.calls.warnings[0], /inject/);
  const verdict = hostCase.calls.guards[0]({ name: 'ppt_master_info', agent: { id: 'a' } });
  assert.equal(typeof verdict, 'string', '能力缺失 ⇒ fail-closed 全拒');
  handle.dispose();
});

test('selected + registry.list() 抛错：本轮不产生新判定（无层）+ warn', async () => {
  const a = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent: a.agent, record: a.record }], listThrows: true });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();

  assert.equal(a.record.installed, 0, '一次读失败不得改写用户的工作区可见性');
  assert.ok(hostCase.calls.warnings.some((line) => /工作区注册表/.test(line)));
  handle.dispose();
});

test('selected + 注册表返回空表：权威回答"无工作区" ⇒ 全不可见', async () => {
  const a = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent: a.agent, record: a.record }], workspaces: [] });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();

  assert.equal(a.record.installed, 1);
  handle.dispose();
});

test('selected + restrict 抛错：warn、跳过该 agent，guard 仍兜底', async () => {
  const a = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent: a.agent, record: a.record }], restrictThrows: true });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();

  assert.equal(a.record.installed, 0);
  assert.ok(hostCase.calls.warnings.some((line) => /restrict/.test(line)));
  assert.equal(typeof hostCase.calls.guards[0]({ name: 'ppt_master_info', agent: { id: 'a' } }), 'string');
  handle.dispose();
});

test('selected + agent 缺 scoped restrict：warn 一次，不重复刷日志', async () => {
  const a = makeAgent({ id: 'a', cwd: '/workspace/hermes', restrictable: false });
  const hostCase = makeHost({ agents: [{ agent: a.agent, record: a.record }] });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();
  await hostCase.emit('tools/change');
  await handle.whenIdle();

  assert.equal(hostCase.calls.warnings.filter((line) => /restrict/.test(line)).length, 1);
  handle.dispose();
});

test('selected + 宿主无 ctx.on：仍完成首轮，不崩', async () => {
  const a = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent: a.agent, record: a.record }], canOn: false });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();
  assert.equal(a.record.installed, 1);
  handle.dispose();
});

// ─── 拆除（design §5.3 拆除顺序）──────────────────────────────

test('dispose：释放全部限制层并卸载 guard，重复调用不抛', async () => {
  const a = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const b = makeAgent({ id: 'b', cwd: '/workspace/other' });
  const hostCase = makeHost({
    agents: [a, b],
    resolve: async (path) => (path === '/workspace/hermes' ? W2 : undefined),
  });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();
  assert.equal(a.record.installed, 1);
  assert.equal(b.record.installed, 1);

  handle.dispose();
  assert.equal(a.record.released, 1);
  assert.equal(b.record.released, 1);
  assert.equal(hostCase.calls.guards.length, 0, 'guard 已卸载');
  assert.doesNotThrow(() => handle.dispose());
});

test('dispose 后到达的事件不再触发安装', async () => {
  const hostCase = makeHost({ agents: [] });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();
  handle.dispose();

  const { agent, record } = makeAgent({ id: 'late', cwd: '/workspace/hermes' });
  hostCase.child.agents.list = () => [agent];
  await hostCase.emit('agent/created', { agent });
  await handle.whenIdle();

  assert.equal(record.installed, 0, '拆除后不再装层');
});

// ─── Gate 3 审查回归（F1/F2/F3/F4/F6/F10）──────────────────────

test('F1: agents.list() 瞬时抛错不得拆掉已装层（区分"读失败"与"读空"）', async () => {
  const { agent, record } = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent, record }] });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();
  assert.equal(record.installed, 1);

  // 让 agents.list() 抛错后再触发重算
  hostCase.child.agents.list = () => {
    throw new Error('registry busy');
  };
  await hostCase.emit('tools/change');
  await handle.whenIdle();

  assert.equal(record.released, 0, '一次读失败不得拆层（否则工具重现但每次调用都被拒）');
  assert.equal(record.installed, 1, '也不得重复安装');
  handle.dispose();
});

test('F1b: agents.list() 读成功且为空 ⇒ 才释放（确实一个都没有）', async () => {
  const { agent, record } = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent, record }] });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();
  assert.equal(record.installed, 1);

  hostCase.child.agents.list = () => [];
  await hostCase.emit('tools/change');
  await handle.whenIdle();

  assert.equal(record.released, 1);
  handle.dispose();
});

test('F2: guard 同步重判——无 cwd 的 agent 必须拒绝（不是放行）', async () => {
  const hostCase = makeHost({ agents: [] });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();

  const verdict = hostCase.calls.guards[0]({
    name: 'ppt_master_info',
    agent: { id: 'never-judged', session: { header: {} } },
  });
  assert.equal(typeof verdict, 'string', 'no-cwd 是"明确回答无归属" ⇒ fail-closed');
  handle.dispose();
});

test('F3: selected + 缺 ctx.on ⇒ warn 点明只判定一次', async () => {
  const { agent, record } = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent, record }], canOn: false });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();

  assert.equal(record.installed, 1, '仍要完成装配期这一次判定');
  assert.ok(
    hostCase.calls.warnings.some((line) => /ctx\.on/.test(line)),
    `缺 ctx.on 须有一条点名告警，实际：${JSON.stringify(hostCase.calls.warnings)}`,
  );
  handle.dispose();
});

test('F6+R2-1: 能力缺失是粘性的——global 一圈回来仍是 fail-closed', async () => {
  const hostCase = makeHost({ agents: [] });
  hostCase.ctx.inject = () => {
    throw new Error('inject exploded');
  };
  const config = { mode: { get: () => 'selected' }, workspaceIds: { get: () => ['w1'] } };
  const handle = mount(hostCase, config);
  await handle.whenIdle();

  assert.ok(hostCase.calls.warnings.some((line) => /inject/.test(line)), '要有一条点名 inject 的 warn');
  assert.equal(hostCase.calls.guards.length, 1, 'selected 下必须留着 guard 才拦得住');
  assert.equal(
    typeof hostCase.calls.guards[0]({ name: 'ppt_master_info', agent: { id: 'x' } }),
    'string',
    '能力缺失 ⇒ fail-closed 全拒',
  );

  // 切回 global：guard 释放，工具应完全可用
  config.mode = { get: () => 'global' };
  await hostCase.emit('loader/volatile-update', [['scope', 'mode']]);
  await handle.whenIdle();
  assert.equal(hostCase.calls.guards.length, 0, 'global 下不得残留 guard');

  // 再切回 selected：能力缺失仍是粘性事实 ⇒ 必须重新全拒（R2-1 回归）
  config.mode = { get: () => 'selected' };
  await hostCase.emit('loader/volatile-update', [['scope', 'mode']]);
  await handle.whenIdle();
  assert.equal(hostCase.calls.guards.length, 1, '回到 selected 必须重新装 guard');
  assert.equal(
    typeof hostCase.calls.guards[0]({ name: 'ppt_master_info', agent: { id: 'x' } }),
    'string',
    'fail-closed 不得因 global 走一圈而丢失',
  );
  handle.dispose();
});

test('R2-1b: 注入到的服务不可用同样粘住 fail-closed', async () => {
  const hostCase = makeHost({ agents: [] });
  // 让注入回调拿到一个缺 agents 的 child
  hostCase.ctx.inject = (keys, cb) => {
    hostCase.calls.injectKeys.push(keys);
    return cb({ workspaceRegistry: hostCase.child.workspaceRegistry, tools: hostCase.child.tools, on: () => () => {} });
  };
  const config = { mode: { get: () => 'selected' }, workspaceIds: { get: () => ['w1'] } };
  const handle = mount(hostCase, config);
  await handle.whenIdle();
  assert.equal(typeof hostCase.calls.guards[0]({ name: 'ppt_master_info', agent: { id: 'x' } }), 'string');

  config.mode = { get: () => 'global' };
  await hostCase.emit('loader/volatile-update', [['scope', 'mode']]);
  config.mode = { get: () => 'selected' };
  await hostCase.emit('loader/volatile-update', [['scope', 'mode']]);
  await handle.whenIdle();

  assert.equal(typeof hostCase.calls.guards[0]({ name: 'ppt_master_info', agent: { id: 'x' } }), 'string');
  handle.dispose();
});

test('R2-3: 在飞轮次回来时若已切回 global，不得把层装回去', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { agent, record } = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({
    agents: [{ agent, record }],
    resolve: async () => {
      await gate; // 卡住 resolveByPath，制造"在飞轮次"
      return W2;
    },
  });
  const config = { mode: { get: () => 'selected' }, workspaceIds: { get: () => ['w1'] } };
  const handle = mount(hostCase, config);
  // 轮次停在 await resolveByPath
  await new Promise((resolve) => setImmediate(resolve));

  config.mode = { get: () => 'global' };
  await hostCase.emit('loader/volatile-update', [['scope', 'mode']]);
  release();
  await handle.whenIdle();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(record.installed, 0, 'global 下在飞轮次不得再装层');
  handle.dispose();
});

test('R2-2: 持续失败时复检有上限（不退化成 1Hz 轮询）', async () => {
  const { agent, record } = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  let calls = 0;
  const hostCase = makeHost({ agents: [{ agent, record }] });
  hostCase.child.workspaceRegistry.list = () => {
    calls += 1;
    throw new Error('registry down');
  };
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();

  // 观察 3.6s（够跑完 MAX_RETRIES=3 次复检），然后**再等 1.5s 看它是否停下**
  await new Promise((resolve) => setTimeout(resolve, 3600));
  await handle.whenIdle();
  const settled = calls;

  await new Promise((resolve) => setTimeout(resolve, 1500));
  await handle.whenIdle();

  assert.equal(calls, settled, `复检必须停下，但仍在增长：${settled} → ${calls}`);
  assert.ok(settled <= 12, `3.6s 内的 list() 调用应有上限，实际 ${settled} 次`);
  handle.dispose();
});

test('R3-1: 判定级 unresolved 的复检有界（多 agent 不指数放大）', async () => {
  // 场景：注册表与 agents.list 都健康，唯独 resolveByPath 持续抛错
  // （现实触发：cwd 被删 ⇒ realpath ENOENT；挂载点挂死 ⇒ 1500ms 超时）。
  // 修复前：整轮"成功"清零所有额度 ⇒ 每轮每个未决 agent 各排一个 timer，
  // 2 个 agent 实测 6s 内 list() 调 189 次、24s 达 478 万次（N^t 放大）。
  const a1 = makeAgent({ id: 'a1', cwd: '/gone/1' });
  const a2 = makeAgent({ id: 'a2', cwd: '/gone/2' });
  const hostCase = makeHost({
    agents: [a1, a2],
    resolve: async () => {
      throw new Error('ENOENT: realpath');
    },
  });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();

  // 复检波次 ~1s 一波，每 key 额度 MAX_RETRIES=3，~3.5s 内必须全部耗尽停下。
  await new Promise((resolve) => setTimeout(resolve, 4200));
  await handle.whenIdle();
  const settled = hostCase.calls.listCalls;

  await new Promise((resolve) => setTimeout(resolve, 1500));
  await handle.whenIdle();

  assert.equal(
    hostCase.calls.listCalls,
    settled,
    `复检必须停下，但仍在增长：${settled} → ${hostCase.calls.listCalls}`,
  );
  // 修复后上界：每轮 3 次 list()（roundOnce 1 + judgeOne×2），轮次 ≤ 初始 1 + 3 波 × 2 = 7 ⇒ ≤ 21；
  // 修复前 4.2s 时已 >48。40 给实现留裕量、同时远低于指数失控。
  assert.ok(settled <= 40, `2 个未决 agent 的复检应有界，实际 ${settled} 次 list()`);
  handle.dispose();
});

test('R3-1: unresolved 额度按判定清零——判定恢复后额度回来（外部事件自愈）', async () => {
  let broken = true;
  const { agent, record } = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({
    agents: [{ agent, record }],
    resolve: async (path) => {
      if (broken) throw new Error('ENOENT: realpath');
      return W1; // 恢复后解析到**已选**工作区 ⇒ 可见 ⇒ 释放层
    },
  });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();
  // 首轮 unresolved ⇒ 不可见 ⇒ 装层
  assert.equal(record.installed, 1, 'unresolved 按不可见处理，先装层');

  // resolve 恢复后靠外部事件（tools/change）重判：resolved 也是"判出来了" ⇒ 清额度。
  broken = false;
  await hostCase.emit('tools/change', []);
  await handle.whenIdle();
  assert.equal(record.released, 1, '重判可见 ⇒ 释放层');

  // 额度已清零 ⇒ 再出一次 unresolved 仍应有复检（不会因早前耗尽而永久哑掉）。
  broken = true;
  const before = hostCase.calls.listCalls;
  await hostCase.emit('tools/change', []);
  await handle.whenIdle();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await handle.whenIdle();
  assert.ok(
    hostCase.calls.listCalls > before + 1,
    `判定级失败后仍应有有界复检（额度按判定结果清零）：${before} → ${hostCase.calls.listCalls}`,
  );
  handle.dispose();
});

test('R3-2: inject 抛错期间反复 volatile 更新不得累积 guard', async () => {
  const { agent } = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent }] });
  hostCase.ctx.inject = () => {
    throw new Error('inject boom');
  };
  const config = { mode: { get: () => 'selected' }, workspaceIds: { get: () => ['w1'] } };
  const handle = mount(hostCase, config);
  await handle.whenIdle();
  assert.equal(hostCase.calls.guards.length, 1, 'inject 抛错 ⇒ fail-closed 装 guard');

  // selected→selected（只改 workspaceIds）：激活分支每次都会重走，guard 必须幂等。
  for (let i = 0; i < 3; i += 1) {
    await hostCase.emit('loader/volatile-update', [['scope', 'workspaceIds']]);
  }
  assert.equal(hostCase.calls.guards.length, 1, 'guard 不得累积（修复前 3 次更新后是 4 条）');

  config.mode = { get: () => 'global' };
  await hostCase.emit('loader/volatile-update', [['scope', 'mode']]);
  assert.equal(hostCase.calls.guards.length, 0, 'global 释放唯一的 guard，宿主 guard 层零残留');
  handle.dispose();
});

test('F10: 注入尚未到达（pending）⇒ 不 warn、不装层、不崩', async () => {
  const { agent, record } = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  const hostCase = makeHost({ agents: [{ agent, record }], injectNeverResolves: true });
  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();

  assert.deepEqual(hostCase.calls.injectKeys, [['agents', 'workspaceRegistry']], '确实去注入了');
  assert.deepEqual(hostCase.calls.warnings, [], 'pending 不是降级，不得 warn');
  assert.equal(record.installed, 0, '注入没到 ⇒ 不判定、不装层（工具暂时可见）');
  handle.dispose();
});

test('F4: registry.list() 抛错后自动复检（1000ms 内自愈，不必等外部事件）', async () => {
  const { agent, record } = makeAgent({ id: 'a', cwd: '/workspace/hermes' });
  let broken = true;
  const hostCase = makeHost({
    agents: [{ agent, record }],
    workspaces: [W1, W2],
  });
  const originalList = hostCase.child.workspaceRegistry.list;
  hostCase.child.workspaceRegistry.list = () => {
    if (broken) throw new Error('registry down');
    return originalList();
  };

  const handle = mount(hostCase, SELECTED_W1);
  await handle.whenIdle();
  assert.equal(record.installed, 0, '读失败 ⇒ 本轮不判定（可见）');

  broken = false;
  // 等有界复检（1000ms）触发
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await handle.whenIdle();

  assert.equal(record.installed, 1, '复检后应自愈装上限制层');
  handle.dispose();
});
