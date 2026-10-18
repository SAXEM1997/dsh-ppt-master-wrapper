import { test } from 'node:test';
import assert from 'node:assert/strict';

// 访问形态钉死：本特性的新导出一律经命名空间访问，后续 Task 在同一文件追加导出时，
// 既有用例保持绿、追加用例先红，使「追加红/既有绿」在 test 文件粒度可观测。
import * as scope from '../lib/scope.js';

// ─── 常量与默认值（[Q2]：本插件默认 global，与 cherry 的 selected 默认相反）───

test('SCOPE_DEFAULT: 默认 global + 空名单，且整体冻结', () => {
  assert.equal(scope.SCOPE_DEFAULT.mode, 'global');
  assert.deepEqual([...scope.SCOPE_DEFAULT.workspaceIds], []);
  assert.equal(Object.isFrozen(scope.SCOPE_DEFAULT), true);
  assert.equal(Object.isFrozen(scope.SCOPE_DEFAULT.workspaceIds), true);
});

test('SCOPE_MODES: 恰为 global / selected 两个取值', () => {
  assert.deepEqual([...scope.SCOPE_MODES], ['global', 'selected']);
  assert.equal(Object.isFrozen(scope.SCOPE_MODES), true);
});

test('SCOPE_KEY: 配置顶层键为 scope', () => {
  assert.equal(scope.SCOPE_KEY, 'scope');
});

// ─── 配置归一化（design §5.2）────────────────────────────────────

test('readScopeConfig: undefined ⇒ 默认值且无 problem', () => {
  const read = scope.readScopeConfig(undefined);
  assert.equal(read.mode, 'global');
  assert.deepEqual(read.workspaceIds, []);
  assert.equal(read.problem, undefined);
});

test('readScopeConfig: 合法配置原样读取', () => {
  const read = scope.readScopeConfig({
    mode: 'selected',
    workspaceIds: ['b6ef89f7-74a6-4e4f-84eb-07581e390020'],
  });
  assert.equal(read.mode, 'selected');
  assert.deepEqual(read.workspaceIds, ['b6ef89f7-74a6-4e4f-84eb-07581e390020']);
  assert.equal(read.problem, undefined);
});

test('readScopeConfig: 名单逐项 trim、去空、去重、升序（比较归一化不改写存储语义）', () => {
  const read = scope.readScopeConfig({
    mode: 'selected',
    workspaceIds: ['b', ' a ', 'b', '', '   ', 'c', 'A'],
  });
  assert.deepEqual(read.workspaceIds, ['A', 'a', 'b', 'c']);
  assert.equal(read.problem, undefined);
});

test('readScopeConfig: 非字符串项经 String() 归一（不抛）', () => {
  const read = scope.readScopeConfig({ mode: 'selected', workspaceIds: [5, null] });
  assert.deepEqual(read.workspaceIds, ['5']);
});

test('readScopeConfig: mode 非枚举 ⇒ 落更严一侧（selected + 空名单）+ problem=invalid', () => {
  const read = scope.readScopeConfig({ mode: 'nope', workspaceIds: ['a'] });
  assert.equal(read.mode, 'selected', '非法配置不得静默放宽成 global');
  assert.deepEqual(read.workspaceIds, [], '非法配置下名单不可信，一并收紧');
  assert.equal(read.problem, 'invalid');
});

test('readScopeConfig: 缺 workspaceIds ⇒ problem=invalid 且落更严一侧', () => {
  const read = scope.readScopeConfig({ mode: 'selected' });
  assert.equal(read.mode, 'selected');
  assert.deepEqual(read.workspaceIds, []);
  assert.equal(read.problem, 'invalid');
});

test('readScopeConfig: workspaceIds 非数组 ⇒ problem=invalid 且落更严一侧', () => {
  const read = scope.readScopeConfig({ mode: 'selected', workspaceIds: 'a,b' });
  assert.equal(read.mode, 'selected');
  assert.deepEqual(read.workspaceIds, []);
  assert.equal(read.problem, 'invalid');
});

test('readScopeConfig: volatile 引用对象（.get()）在读取时解引用', () => {
  let mode = 'global';
  let ids = [];
  const raw = { mode: { get: () => mode }, workspaceIds: { get: () => ids } };
  assert.equal(scope.readScopeConfig(raw).mode, 'global');

  // 宿主 volatile 更新是**原地改引用**（design §4 步 2）：再次读取必须看到新值。
  mode = 'selected';
  ids = ['w1'];
  const read = scope.readScopeConfig(raw);
  assert.equal(read.mode, 'selected');
  assert.deepEqual(read.workspaceIds, ['w1']);
});

test('readScopeConfig: 引用对象 get() 抛错 ⇒ 落更严一侧 + problem=invalid（不冒泡）', () => {
  const read = scope.readScopeConfig({
    mode: {
      get() {
        throw new Error('boom');
      },
    },
    workspaceIds: { get: () => [] },
  });
  assert.equal(read.mode, 'selected');
  assert.equal(read.problem, 'invalid');
});

test('readScopeConfig: 两个键都没给 ⇒ 视为未配置（global，无 problem）', () => {
  const read = scope.readScopeConfig({});
  assert.equal(read.mode, 'global');
  assert.deepEqual(read.workspaceIds, []);
  assert.equal(read.problem, undefined);
});

// ─── 可见性严格序（design §5.2 / [Q2] fail-closed）──────────────

test('isVisible: global ⇒ 恒真（含 undefined 工作区）', () => {
  const config = { mode: 'global', workspaceIds: [] };
  assert.equal(scope.isVisible(config, undefined), true);
  assert.equal(scope.isVisible(config, 'anything'), true);
});

test('isVisible: selected ⇒ 只有命中名单为真', () => {
  const config = { mode: 'selected', workspaceIds: ['w1'] };
  assert.equal(scope.isVisible(config, 'w1'), true);
  assert.equal(scope.isVisible(config, 'w2'), false);
  assert.equal(scope.isVisible(config, undefined), false, '无归属会话在 selected 下不可见 [Q2]');
});

test('isVisible: selected + 空名单 ⇒ 谁都不给', () => {
  const config = { mode: 'selected', workspaceIds: [] };
  assert.equal(scope.isVisible(config, 'w1'), false);
  assert.equal(scope.isVisible(config, undefined), false);
});

test('isVisible: 两侧都经 trim 归一后比较', () => {
  const config = { mode: 'selected', workspaceIds: ['  w1  '] };
  assert.equal(scope.isVisible(config, 'w1'), true);
  assert.equal(scope.isVisible(config, ' W1 '), false, '不做大小写折叠');
});

// ─── 标签与投影 ────────────────────────────────────────────────

test('describeWorkspace: 有 title 用「title」(id)，无 title 用 id', () => {
  assert.equal(scope.describeWorkspace({ id: 'w1', title: 'ppt-master' }), '工作区「ppt-master」(w1)');
  assert.equal(scope.describeWorkspace({ id: 'w1', title: '' }), '工作区 w1');
});

test('projectAgent: 从活 agent 取 id 与 session.header.cwd', () => {
  assert.deepEqual(scope.projectAgent({ id: 'a', session: { header: { cwd: '/w' } } }), {
    id: 'a',
    cwd: '/w',
  });
  assert.deepEqual(scope.projectAgent({ id: 'a' }), { id: 'a' });
  assert.deepEqual(scope.projectAgent({ id: 'a', session: { header: {} } }), { id: 'a' });
  assert.equal(scope.projectAgent({}), undefined, '无 id 的 agent 不可投影');
  assert.equal(scope.projectAgent(undefined), undefined);
});

test('readWorkspaces: 归一化注册表项，丢弃无 id 的项', () => {
  const list = scope.readWorkspaces([
    { id: 'w1', title: 'T', path: '/w1', sessionIds: ['s1', 2] },
    { title: 'no id', path: '/x' },
    { id: 'w2', path: '/w2' },
    { id: 'w3', path: '/w3', sessionIds: 'not-an-array' },
  ]);
  assert.deepEqual(
    list.map((item) => item.id),
    ['w1', 'w2', 'w3'],
  );
  assert.deepEqual(list[0].sessionIds, ['s1', '2']);
  assert.deepEqual(list[2].sessionIds, [], 'sessionIds 非数组 ⇒ 空数组而非抛错');
  assert.equal(scope.readWorkspaces(undefined).length, 0);
  assert.equal(scope.readWorkspaces('nope').length, 0);
});

test('toolNamesOf: 按注册顺序取名字，跳过无名项', () => {
  const tools = [{ name: 'ppt_master_info' }, { name: 'ppt_master_check_env' }, {}, { name: 'x' }];
  assert.deepEqual(scope.toolNamesOf(tools), ['ppt_master_info', 'ppt_master_check_env', 'x']);
  assert.deepEqual(scope.toolNamesOf(undefined), []);
  assert.equal(Object.isFrozen(scope.toolNamesOf([{ name: 'a' }])), true);
});

// ─── 同步首判 resolveNow（design §5.4，给 agent/created 的窗口用）───

const WORKSPACES = scope.readWorkspaces([
  { id: 'w1', title: 'ppt-master', path: '/workspace/ppt-master', sessionIds: ['s-in-w1'] },
  { id: 'w2', title: 'hermes', path: '/workspace/hermes', sessionIds: [] },
]);
const PATH_MAP = new Map([
  ['/workspace/ppt-master', 'w1'],
  ['/workspace/hermes', 'w2'],
]);
const SELECTED_W1 = { mode: 'selected', workspaceIds: ['w1'] };

test('resolveNow: 规则一（会话成员）命中即 resolved', () => {
  const judgement = scope.resolveNow({
    config: SELECTED_W1,
    agent: { id: 's-in-w1', cwd: '/elsewhere' },
    workspaces: WORKSPACES,
    pathMap: PATH_MAP,
  });
  assert.equal(judgement.status, 'resolved');
  assert.equal(judgement.workspaceId, 'w1');
  assert.equal(judgement.visible, true);
  assert.match(judgement.reason, /ppt-master/);
});

test('resolveNow: 规则二命中路径表 ⇒ resolved', () => {
  const judgement = scope.resolveNow({
    config: SELECTED_W1,
    agent: { id: 'unknown', cwd: '/workspace/ppt-master' },
    workspaces: WORKSPACES,
    pathMap: PATH_MAP,
  });
  assert.equal(judgement.status, 'resolved');
  assert.equal(judgement.workspaceId, 'w1');
  assert.equal(judgement.visible, true);
});

test('resolveNow: 命中名单外的工作区 ⇒ resolved 但不可见', () => {
  const judgement = scope.resolveNow({
    config: SELECTED_W1,
    agent: { id: 'unknown', cwd: '/workspace/hermes' },
    workspaces: WORKSPACES,
    pathMap: PATH_MAP,
  });
  assert.equal(judgement.status, 'resolved');
  assert.equal(judgement.workspaceId, 'w2');
  assert.equal(judgement.visible, false);
});

test('resolveNow: 无 cwd ⇒ no-cwd，selected 下不可见', () => {
  const judgement = scope.resolveNow({
    config: SELECTED_W1,
    agent: { id: 'a' },
    workspaces: WORKSPACES,
    pathMap: PATH_MAP,
  });
  assert.equal(judgement.status, 'no-cwd');
  assert.equal(judgement.visible, false);
  assert.equal(Object.hasOwn(judgement, 'workspaceId'), false, '无工作区时省略字段而非置 undefined');
});

test('resolveNow: 路径未命中 ⇒ no-match，selected 下不可见', () => {
  const judgement = scope.resolveNow({
    config: SELECTED_W1,
    agent: { id: 'a', cwd: '/tmp/scratch' },
    workspaces: WORKSPACES,
    pathMap: PATH_MAP,
  });
  assert.equal(judgement.status, 'no-match');
  assert.equal(judgement.visible, false);
  assert.match(judgement.reason, /\/tmp\/scratch/);
});

test('resolveNow: global 模式下无归属也可见', () => {
  const judgement = scope.resolveNow({
    config: { mode: 'global', workspaceIds: [] },
    agent: { id: 'a', cwd: '/tmp/scratch' },
    workspaces: WORKSPACES,
    pathMap: PATH_MAP,
  });
  assert.equal(judgement.status, 'no-match');
  assert.equal(judgement.visible, true);
});

// ─── 异步精化 judgeAgent（design §5.4）──────────────────────────

test('judgeAgent: 规则一优先于路径（会话成员命中即止）', async () => {
  const judgement = await scope.judgeAgent({
    config: SELECTED_W1,
    agent: { id: 's-in-w1', cwd: '/workspace/hermes' },
    workspaces: WORKSPACES,
    pathMap: PATH_MAP,
    resolveByPath: async () => ({ id: 'w2', path: '/workspace/hermes' }),
  });
  assert.equal(judgement.workspaceId, 'w1');
  assert.equal(judgement.visible, true);
});

test('judgeAgent: resolveByPath 命中 ⇒ resolved（补符号链接/拼写差异）', async () => {
  const judgement = await scope.judgeAgent({
    config: SELECTED_W1,
    agent: { id: 'a', cwd: '/symlink/to/ppt-master' },
    workspaces: WORKSPACES,
    pathMap: PATH_MAP,
    resolveByPath: async (path) => {
      assert.equal(path, '/symlink/to/ppt-master');
      return { id: 'w1', title: 'ppt-master', path: '/workspace/ppt-master' };
    },
  });
  assert.equal(judgement.status, 'resolved');
  assert.equal(judgement.workspaceId, 'w1');
  assert.equal(judgement.visible, true);
});

test('judgeAgent: resolveByPath 返回 undefined ⇒ no-match（宿主不拥有该目录）', async () => {
  const judgement = await scope.judgeAgent({
    config: SELECTED_W1,
    agent: { id: 'a', cwd: '/tmp/scratch' },
    workspaces: WORKSPACES,
    pathMap: PATH_MAP,
    resolveByPath: async () => undefined,
  });
  assert.equal(judgement.status, 'no-match');
  assert.equal(judgement.visible, false);
});

test('judgeAgent: resolveByPath reject ⇒ unresolved（有界复检只对该态启动）', async () => {
  const judgement = await scope.judgeAgent({
    config: SELECTED_W1,
    agent: { id: 'a', cwd: '/gone' },
    workspaces: WORKSPACES,
    pathMap: PATH_MAP,
    resolveByPath: async () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(judgement.status, 'unresolved');
  assert.equal(judgement.visible, false);
});

test('judgeAgent: 宿主无 resolveByPath ⇒ 退化为路径字符串等价（不抛）', async () => {
  const hit = await scope.judgeAgent({
    config: SELECTED_W1,
    agent: { id: 'a', cwd: '/workspace/ppt-master' },
    workspaces: WORKSPACES,
    pathMap: PATH_MAP,
    resolveByPath: undefined,
  });
  assert.equal(hit.status, 'resolved');

  const miss = await scope.judgeAgent({
    config: SELECTED_W1,
    agent: { id: 'a', cwd: '/workspace/hermes/' },
    workspaces: WORKSPACES,
    pathMap: PATH_MAP,
    resolveByPath: undefined,
  });
  assert.equal(miss.status, 'no-match', '不做大小写/尾斜杠猜测');
});

test('judgeAgent: 实体缺可用 id ⇒ no-match（不把无 id 实体当命中）', async () => {
  const judgement = await scope.judgeAgent({
    config: SELECTED_W1,
    agent: { id: 'a', cwd: '/w' },
    workspaces: WORKSPACES,
    pathMap: PATH_MAP,
    resolveByPath: async () => ({ path: '/w' }),
  });
  assert.equal(judgement.status, 'no-match');
  assert.equal(judgement.visible, false);
});

test('judgeAgent: 无 cwd 时不调用 resolveByPath', async () => {
  let called = false;
  const judgement = await scope.judgeAgent({
    config: SELECTED_W1,
    agent: { id: 'a' },
    workspaces: WORKSPACES,
    pathMap: PATH_MAP,
    resolveByPath: async () => {
      called = true;
      return undefined;
    },
  });
  assert.equal(judgement.status, 'no-cwd');
  assert.equal(called, false);
});

test('judgeAgent: 判定结果带 agentId 与 cwd（供诊断与 guard 回显）', async () => {
  const judgement = await scope.judgeAgent({
    config: SELECTED_W1,
    agent: { id: 'agent-1', cwd: '/tmp/scratch' },
    workspaces: WORKSPACES,
    pathMap: PATH_MAP,
    resolveByPath: async () => undefined,
  });
  assert.equal(judgement.agentId, 'agent-1');
  assert.equal(judgement.cwd, '/tmp/scratch');
});
