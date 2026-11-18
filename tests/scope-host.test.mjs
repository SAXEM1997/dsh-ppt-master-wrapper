import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertWhenCapable, mountToolScope } from '../lib/scope-host.js';

/**
 * 步骤级可见性（2026-11-18 迁移）：`mountToolScope` 产出的 `when(context)` 是唯一
 * 可见性判定面。宿主每步对每个工具调用一次，条件必须**同步、永不抛**，并把一切
 * 不确定收敛成 `false`（`selected`）或 `true`（`global`）。
 *
 * 本文件只测判定器本身：不需要 restrict/guard/agent 生命周期——那套机制已删除，
 * 「装在别人身上的层」不再存在，因此也没有可测的安装/拆卸时序。
 */

/** 可控注册表：`list()` 现取、`resolveByPath` 可选。 */
function makeRegistry({ workspaces = [], resolveByPath, listThrows = false } = {}) {
  const calls = { list: 0, resolveByPath: [] };
  return {
    calls,
    registry: {
      list() {
        calls.list += 1;
        if (listThrows) throw new Error('registry.list exploded');
        return workspaces;
      },
      ...(resolveByPath === undefined
        ? {}
        : {
            async resolveByPath(cwd) {
              calls.resolveByPath.push(cwd);
              return resolveByPath(cwd);
            },
          }),
    },
  };
}

/** 假根 ctx：`inject` 立即（或延迟）回调；返回句柄供测试手动驱动注入。 */
function makeCtx({ registry, defer = false } = {}) {
  const pending = [];
  const ctx = {
    inject(keys, callback) {
      assert.deepEqual(keys, ['workspaceRegistry']);
      if (defer) pending.push(callback);
      else callback({ workspaceRegistry: registry });
    },
  };
  return {
    ctx,
    flush() {
      const list = pending.splice(0);
      for (const callback of list) callback({ workspaceRegistry: registry });
      return list.length;
    },
  };
}

/** 一个进行中的 Promise 控制器（测代际竞态用）。 */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = () => new Promise((done) => setImmediate(done));
const agent = (id, cwd) => ({ id, session: { header: cwd === undefined ? {} : { cwd } } });

test('assertWhenCapable: 缺 tools.resolve 即抛命名错误（0.2.1 会静默忽略 when）', () => {
  assert.throws(() => assertWhenCapable({ register() {} }), /tools\.resolve/);
  assert.throws(() => assertWhenCapable(undefined), /DSH ≥ 0\.2\.2-rc\.1/);
  assert.doesNotThrow(() => assertWhenCapable({ resolve: async () => ({}) }));
});

test('global: when 恒 true，且完全不读注册表', () => {
  const { registry } = makeRegistry({ listThrows: true });
  const { ctx } = makeCtx({ registry });
  const handle = mountToolScope(ctx, { scopeConfig: { mode: 'global', workspaceIds: [] } });

  assert.equal(handle.when({ agent: agent('a1', '/x') }), true);
  assert.equal(handle.when({ agent: agent('a2') }), true);
  assert.equal(handle.when(undefined), true);
  assert.equal(handle.when({ agent: null }), true);
});

test('未配置 scope ⇒ global（与"没有该特性"同形）', () => {
  const { ctx } = makeCtx({});
  const handle = mountToolScope(ctx, {});
  assert.equal(handle.when({ agent: agent('a1', '/x') }), true);
});

test('selected: 会话成员命中 → 可见；名单为空 → 不可见', () => {
  const workspaces = [{ id: 'w1', path: '/repo/a', sessionIds: ['a1'] }];
  const { ctx } = makeCtx({ registry: makeRegistry({ workspaces }).registry });
  const handle = mountToolScope(ctx, {
    scopeConfig: { mode: 'selected', workspaceIds: ['w1'] },
  });
  assert.equal(handle.when({ agent: agent('a1', '/elsewhere') }), true, '成员优先于路径');

  const empty = mountToolScope(makeCtx({ registry: makeRegistry({ workspaces }).registry }).ctx, {
    scopeConfig: { mode: 'selected', workspaceIds: [] },
  });
  assert.equal(empty.when({ agent: agent('a1', '/repo/a') }), false, '空名单 fail-closed');
});

test('selected: 字符串路径命中且在工作区内 → 可见；界外 → 不可见', () => {
  const workspaces = [{ id: 'w1', path: '/repo/a', sessionIds: [] }];
  const { ctx } = makeCtx({ registry: makeRegistry({ workspaces }).registry });
  const handle = mountToolScope(ctx, {
    scopeConfig: { mode: 'selected', workspaceIds: ['w1'] },
  });
  assert.equal(handle.when({ agent: agent('a1', '/repo/a') }), true);
  assert.equal(handle.when({ agent: agent('a2', '/repo/b') }), false);
  assert.equal(handle.when({ agent: agent('a3') }), false, '无 cwd fail-closed');
});

test('selected: 路径相等但工作区不在名单 → 不可见（isVisible 严格序）', () => {
  const workspaces = [{ id: 'w1', path: '/repo/a', sessionIds: [] }];
  const { ctx } = makeCtx({ registry: makeRegistry({ workspaces }).registry });
  const handle = mountToolScope(ctx, {
    scopeConfig: { mode: 'selected', workspaceIds: ['w2'] },
  });
  assert.equal(handle.when({ agent: agent('a1', '/repo/a') }), false);
});

test('selected: 注册表注入未到 ⇒ fail-closed，且只告警一次', () => {
  const warnings = [];
  const { ctx } = makeCtx({ registry: undefined, defer: true });
  const handle = mountToolScope(ctx, {
    scopeConfig: { mode: 'selected', workspaceIds: ['w1'] },
    warn: (message) => warnings.push(message),
  });
  assert.equal(handle.when({ agent: agent('a1', '/repo/a') }), false);
  assert.equal(handle.when({ agent: agent('a1', '/repo/a') }), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /workspaceRegistry/);
});

test('selected: list() 抛错 ⇒ fail-closed，不升级成步骤失败', () => {
  const { ctx } = makeCtx({ registry: makeRegistry({ listThrows: true }).registry });
  const handle = mountToolScope(ctx, {
    scopeConfig: { mode: 'selected', workspaceIds: ['w1'] },
  });
  assert.equal(handle.when({ agent: agent('a1', '/repo/a') }), false);
});

test('异步精化：字符串未命中 → 首步不可见，resolveByPath 命中后下一步可见', async () => {
  const workspaces = [{ id: 'w1', path: '/repo/real', sessionIds: [] }];
  const { registry, calls } = makeRegistry({
    workspaces,
    resolveByPath: async () => ({ id: 'w1' }),
  });
  const { ctx } = makeCtx({ registry });
  const handle = mountToolScope(ctx, {
    scopeConfig: { mode: 'selected', workspaceIds: ['w1'] },
  });

  const user = agent('a1', '/repo/link');
  assert.equal(handle.when({ agent: user }), false, '精化前本步不可见');
  await tick();
  assert.equal(calls.resolveByPath.length, 1);
  assert.equal(handle.when({ agent: user }), true, '精化后下一步可见');
});

test('异步精化失败 ⇒ 保持不可见，且不抛', async () => {
  const workspaces = [{ id: 'w1', path: '/repo/real', sessionIds: [] }];
  const { registry } = makeRegistry({
    workspaces,
    resolveByPath: async () => {
      throw new Error('nope');
    },
  });
  const { ctx } = makeCtx({ registry });
  const handle = mountToolScope(ctx, {
    scopeConfig: { mode: 'selected', workspaceIds: ['w1'] },
  });
  const user = agent('a1', '/repo/link');
  assert.equal(handle.when({ agent: user }), false);
  await tick();
  assert.equal(handle.when({ agent: user }), false);
});

test('精化结果按 agent 节流：同一 agent 连续步不重复排精化', async () => {
  const workspaces = [{ id: 'w1', path: '/repo/real', sessionIds: [] }];
  const { registry, calls } = makeRegistry({
    workspaces,
    resolveByPath: async () => ({ id: 'w2' }),
  });
  const { ctx } = makeCtx({ registry });
  const handle = mountToolScope(ctx, {
    scopeConfig: { mode: 'selected', workspaceIds: ['w1'] },
    now: () => 1_000,
  });
  const user = agent('a1', '/repo/link');
  handle.when({ agent: user });
  handle.when({ agent: user });
  handle.when({ agent: user });
  await tick();
  assert.equal(calls.resolveByPath.length, 1);
});

test('配置热变更：同一 handle 下一步即按新配置判定', () => {
  const workspaces = [{ id: 'w1', path: '/repo/a', sessionIds: [] }];
  const { ctx } = makeCtx({ registry: makeRegistry({ workspaces }).registry });
  const config = { mode: 'global', workspaceIds: [] };
  const handle = mountToolScope(ctx, { scopeConfig: config });
  const user = agent('a1', '/repo/b');

  assert.equal(handle.when({ agent: user }), true);
  config.mode = 'selected';
  config.workspaceIds = ['w1'];
  assert.equal(handle.when({ agent: user }), false, 'selected 后立刻生效（volatile 现读）');
  config.mode = 'global';
  assert.equal(handle.when({ agent: user }), true);
});

test('代际：invalidate 后旧精化结果不得写回缓存', async () => {
  const workspaces = [{ id: 'w1', path: '/repo/real', sessionIds: [] }];
  const gate = deferred();
  const { registry } = makeRegistry({
    workspaces,
    resolveByPath: () => gate.promise,
  });
  const { ctx } = makeCtx({ registry });
  const handle = mountToolScope(ctx, {
    scopeConfig: { mode: 'selected', workspaceIds: ['w1'] },
  });
  const user = agent('a1', '/repo/link');
  assert.equal(handle.when({ agent: user }), false);
  handle.invalidate();
  gate.resolve({ id: 'w1' });
  await tick();
  assert.equal(handle.when({ agent: user }), false, '旧代际结果被丢弃');
});

test('dispose 后 when 恒 false，且不排精化', () => {
  const workspaces = [{ id: 'w1', path: '/repo/a', sessionIds: [] }];
  const { registry, calls } = makeRegistry({ workspaces });
  const { ctx } = makeCtx({ registry });
  const handle = mountToolScope(ctx, {
    scopeConfig: { mode: 'selected', workspaceIds: ['w1'] },
  });
  handle.dispose();
  assert.equal(handle.when({ agent: agent('a1', '/repo/a') }), false);
  assert.equal(calls.list, 0);
  assert.deepEqual(handle.hostState(), { state: 'unsupported', reason: '作用域已释放' });
});

test('when 永不抛：agent 的 id 取用抛错时按不可见处理', () => {
  const { ctx } = makeCtx({ registry: makeRegistry({ workspaces: [] }).registry });
  const handle = mountToolScope(ctx, {
    scopeConfig: { mode: 'selected', workspaceIds: ['w1'] },
  });
  const hostile = {
    get id() {
      throw new Error('boom');
    },
  };
  assert.equal(handle.when({ agent: hostile }), false);
  assert.equal(handle.when({ get agent() { throw new Error('boom'); } }), false);
});
