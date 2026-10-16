import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Task 1 契约：客户端半边（`lib/client.js`）的装载面、静态契约、三个隔离注册点、
 * 命名空间兜底、表单 holder 生命周期、样式注入与卡片状态壳。
 *
 * 装载方式＝**当前 realm** 求值（`new Function('window', source)`）：`vm.runInNewContext`
 * 产出的对象跨 realm，`deepStrictEqual` 会因原型不同而失败。
 *
 * **夹具硬规则**：`loadEntry()` 必须在各用例体内调用（默认参在调用时求值）；**禁止**在
 * 模块级/顶层读取 `CLIENT_ENTRY`——否则单条 `ENOENT` 会使整文件加载期夭折，
 * Step 2 的"逐例红"不可复现。
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_ENTRY = join(repoRoot, 'lib', 'client.js');
const readPkg = () => JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

// ─── 装载 ─────────────────────────────────────────────────────────

/**
 * 以 stub `window.__ModuleLoader__` 装载客户端半边，返回 `{ id, factory }`。
 * 载荷必须恰被 `load` 一次（多/少都说明契约面漂移）。
 */
function loadEntry(source = readFileSync(CLIENT_ENTRY, 'utf8')) {
  const loads = [];
  const window = {
    __ModuleLoader__: { load: (payload) => loads.push(payload) },
  };
  new Function('window', source)(window);
  assert.equal(loads.length, 1, `window.__ModuleLoader__.load 应恰好调用一次（实际 ${loads.length}）`);
  const payload = loads[0];
  return { id: payload?.id, factory: payload?.factory };
}

// ─── 最小 hook 运行时（仅 createElement/useState/useEffect）───────────

let hookRuntime = null;

/**
 * 最小 hook 运行时：只有 `createElement`/`useState`/`useEffect` 三个成员——
 * 卡片若调用其它 hook 会在渲染期抛 TypeError（比静态断言更硬）。
 *
 * 语义：render 后立即执行挂起 effect；`setState` 置脏、由 settle() 收敛重渲染
 * （上限 20 轮，超出抛错）；`unmount()` 按槽位逆序跑 cleanup。
 */
function installHookRuntime() {
  let cursor = 0; // 本渲染的 hook 槽位游标
  let slots = []; // hook 槽位（跨重渲染保持）
  let pendingEffects = []; // 本渲染挂起的 effect
  let dirty = false; // setState 置脏
  let mounted = false;
  let current = { Component: null, props: undefined };

  const runtime = {
    createElement: (type, props, ...children) => {
      if (typeof type === 'function') {
        throw new Error(`卡片禁子组件：createElement 收到函数 type（${type.name || 'anonymous'}）`);
      }
      return {
        type,
        props: props ?? {},
        children: children
          .flat(Infinity)
          .filter((child) => child !== null && child !== undefined && child !== false),
      };
    },
    useState: (initial) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slots[index]) : next;
        if (Object.is(value, slots[index])) return;
        slots[index] = value;
        dirty = true;
      };
      return [slots[index], setState];
    },
    useEffect: (fn) => {
      pendingEffects.push({ index: cursor++, fn });
    },
  };

  /** 跑一遍组件函数（游标归零），返回本帧的树与挂起 effect。 */
  function paint() {
    cursor = 0;
    pendingEffects = [];
    const tree = current.Component(current.props);
    const effects = pendingEffects;
    pendingEffects = [];
    return { tree, effects };
  }

  /** 结算：跑挂起 effect（每槽位先跑上一轮 cleanup），再收敛 setState 触发的重渲染。 */
  function settle() {
    let frame = lastFrame ?? paint();
    lastFrame = frame;
    for (let rounds = 0; ; rounds += 1) {
      for (const { index, fn } of frame.effects) {
        if (typeof slots[index] === 'function') slots[index](); // 上一轮 cleanup
        const result = fn();
        slots[index] = typeof result === 'function' ? result : null;
      }
      if (!dirty) {
        mounted = true;
        return frame.tree;
      }
      if (rounds >= 20) throw new Error('settle: 重渲染未在 20 轮内收敛');
      dirty = false;
      frame = paint();
      lastFrame = frame;
    }
  }

  let lastFrame = null;

  const render = (Component, props) => {
    current = { Component, props };
    dirty = false;
    mounted = false;
    slots = [];
    lastFrame = paint();
    return settle();
  };

  const unmount = () => {
    if (!current.Component) return;
    for (const slot of [...slots].reverse()) {
      if (typeof slot === 'function') slot();
    }
    slots = [];
    mounted = false;
    current = { Component: null, props: undefined };
  };

  hookRuntime = { runtime, render, settle, unmount, isMounted: () => mounted };
  return runtime;
}

/**
 * react 桩：仅转发最小 hook 运行时。未安装运行时时返回**空对象**——factory 期只解构
 * `createElement`/`useState`/`useEffect`（不调用），不需要运行时；真正渲染前必须调
 * `installHookRuntime()`，否则解构出的 hook 为 `undefined`、渲染期即抛错。
 */
function reactStub() {
  if (hookRuntime === null) return {};
  return hookRuntime.runtime;
}

/**
 * `require` 桩：仅 react 系可解析，其余抛错——Harness 客户端包与任何白名单外 spec
 * 一律拒绝（与 `dsh.client.external` 白名单同判据）。
 */
function makeRequire() {
  return (spec) => {
    if (spec !== 'react') throw new Error(`require 桩拒绝模块表外的 spec：${spec}`);
    return reactStub();
  };
}

// ─── 假 ctx ───────────────────────────────────────────────────────

/**
 * 记录注册面并驱动 `apply` 的假 ctx。
 *
 * - `ctx.inject(deps, cb)`：记录 deps；`configForms` 在场才同步回调（实参＝同一 ctx）
 * - `ctx.effect(fn, label)`：立刻执行 fn 并把返回的 disposer 收集（label 记录）
 * - `ctx.locale.register(ns, dicts)`：记录并返回置 disposed 的 disposer
 * - `ctx.locale.bind(ns)`：返回 t(key)，按 activeLocale **现读**字典（缺键回退 key）
 * - `ctx.slots.inject(name, cb)`：记录后立刻调用 cb 并返回其结果
 * - `ctx.slots.register(options, Component)`：记录；返回 disposer
 */
function makeCtx({ configForms = true, namespaces, activeLocale = 'zh', form } = {}) {
  const calls = {
    injects: [],
    effectLabels: [],
    localeRegisters: [],
    slotInjects: [],
    slotRegisters: [],
    mutates: [],
    formsGet: [],
    formUnsubscribed: false,
    warns: [],
  };
  const disposers = [];
  const dictionaries = new Map();

  // 缺省假表单：落 loading 快照、订阅退订被记录（用例 13 的生命周期观测锚）。
  const stubForm = form ?? {
    getSnapshot: () => ({ status: 'loading' }),
    subscribe: () => () => {
      calls.formUnsubscribed = true;
    },
    mutate: (...args) => {
      calls.mutates.push(args);
      return Promise.resolve(true);
    },
  };

  const formsService = {
    get: (ns) => {
      calls.formsGet.push(ns);
      return stubForm;
    },
    describe: () => {
      if (namespaces === 'throw') throw new Error('describe 不可用');
      if (namespaces === undefined) return { view: {} };
      return { view: { namespaces } };
    },
  };

  // `form: null` ⇒ `get()` 返回 undefined（未接入形态，供用例 15① 的 unconfigured 态）。
  if (form === null) formsService.get = (ns) => {
    calls.formsGet.push(ns);
    return undefined;
  };

  const ctx = {
    inject: (deps, cb) => {
      calls.injects.push(deps);
      if (configForms) cb?.(ctx);
    },
    effect: (fn, label) => {
      calls.effectLabels.push(label);
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
    },
    locale: {
      register: (ns, dicts) => {
        const record = { ns, dicts, disposed: false };
        calls.localeRegisters.push(record);
        dictionaries.set(ns, dicts);
        const disposer = () => {
          record.disposed = true;
        };
        disposers.push(disposer);
        return disposer;
      },
      bind: (ns) => (key, params) => {
        const dict = dictionaries.get(ns) ?? {};
        const table = dict[activeLocale] ?? {};
        const template = table[key] ?? key;
        if (params === undefined) return template;
        return String(template).replace(/\{(\w+)\}/g, (match, name) =>
          name in params ? String(params[name]) : match,
        );
      },
    },
    slots: {
      inject: (name, cb) => {
        calls.slotInjects.push(name);
        return cb();
      },
      register: (options, Component) => {
        calls.slotRegisters.push({ options, Component });
        return () => {
          calls.slotUnregistered = true;
        };
      },
    },
  };

  if (configForms) ctx.configForms = formsService;

  const disposeAll = () => {
    while (disposers.length > 0) disposers.pop()();
  };

  return { ctx, calls, disposeAll, formsService, stubForm };
}

// ─── 渲染与树查询 ──────────────────────────────────────────────────

/** 递归拼接字符串/数字子节点。 */
function textOf(tree) {
  if (tree === null || tree === undefined || tree === false || tree === true) return '';
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (typeof tree === 'object' && Array.isArray(tree.children)) return tree.children.map(textOf).join('');
  return '';
}

/** 正则字面量转义。 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 深度优先查找首个满足 pred 的元素。 */
function find(tree, pred) {
  if (tree === null || typeof tree !== 'object') return undefined;
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const hit = find(child, pred);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (pred(tree)) return tree;
  for (const child of tree.children ?? []) {
    const hit = find(child, pred);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** 深度优先收集全部满足 pred 的元素。 */
function findAll(tree, pred) {
  const hits = [];
  if (tree === null || typeof tree !== 'object') return hits;
  if (Array.isArray(tree)) {
    for (const child of tree) hits.push(...findAll(child, pred));
    return hits;
  }
  if (pred(tree)) hits.push(tree);
  for (const child of tree.children ?? []) hits.push(...findAll(child, pred));
  return hits;
}

/**
 * 渲染卡片：render 后立即结算挂起 effect；`settle()` 收敛 setState 触发的重渲染
 * （上限 20 轮，超出抛错）；`unmount()` 逆序跑 cleanup。
 */
function renderCard(Component, props = { view: 'page' }) {
  const runtime = hookRuntime ?? installHookRuntime();
  runtime.render(Component, props);
  return {
    get tree() {
      return runtime.settle();
    },
    get text() {
      return textOf(runtime.settle());
    },
    settle: () => runtime.settle(),
    unmount: () => runtime.unmount(),
  };
}

/** 假表单快照（供 holder 订阅面驱动）。 */
function makeFakeForm({ snapshot, subscribe } = {}) {
  const listeners = [];
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.push(listener);
      const off = () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
      if (subscribe) subscribe(off);
      return off;
    },
    listeners,
    mutate: () => Promise.resolve(true),
  };
}

/** 捕获 `console.warn`，逐字断言后原样还原。 */
function captureWarn(run) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.map(String).join(' '));
  try {
    run();
  } finally {
    console.warn = original;
  }
  return lines;
}

// ─── 用例 1–2：装载契约 ────────────────────────────────────────────

test('装载契约: stub ModuleLoader 收到 id=包名与 factory', () => {
  const { id, factory } = loadEntry();
  assert.equal(id, 'dsh-ppt-master-wrapper');
  assert.equal(typeof factory, 'function');
  // factory 期零副作用：ensureStyles 在 apply 内，factory 阶段不触 document。
  assert.doesNotThrow(() => factory(makeRequire()));
});

test('装载契约: factory 返回值即插件面', () => {
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  assert.equal(face.name, 'dsh-ppt-master-wrapper');
  assert.deepEqual(face.inject, ['slots', 'locale']);
  assert.equal(typeof face.apply, 'function');
});

// ─── 用例 3–6：静态契约 ────────────────────────────────────────────

test('静态契约: 无 import/export 语句', () => {
  const src = readFileSync(CLIENT_ENTRY, 'utf8');
  assert.doesNotMatch(src, /^\s*(?:import|export)\b/m);
  assert.doesNotMatch(src, /\bimport\s*\(/);
});

test('静态契约: require 白名单仅 react 系且至少 require(\'react\')', () => {
  const src = readFileSync(CLIENT_ENTRY, 'utf8');
  const specs = [...src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const whitelist = ['react', 'react-dom', 'react/jsx-runtime'];
  for (const spec of specs) {
    assert.ok(whitelist.includes(spec), `require 白名单外的 spec：${spec}`);
    assert.equal(spec.startsWith('@deepseek-ai/'), false, `禁 require Harness 客户端包：${spec}`);
  }
  assert.ok(specs.includes('react'), '至少一次 require(\'react\')');
});

test('静态契约: 只用 useState/useEffect', () => {
  const src = readFileSync(CLIENT_ENTRY, 'utf8');
  const used = new Set(src.match(/\buse[A-Z]\w*/g) ?? []);
  for (const hook of used) {
    assert.ok(['useState', 'useEffect'].includes(hook), `卡片不得使用 hook：${hook}`);
  }
});

test('静态契约: 无硬编码颜色字面量', () => {
  const src = readFileSync(CLIENT_ENTRY, 'utf8');
  assert.doesNotMatch(src, /:\s*#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(src, /\brgba?\(/);
  assert.doesNotMatch(src, /\bhsla?\(/);
});

// ─── 用例 7–9：注册面 ──────────────────────────────────────────────

test('注册面: locale 字典 ns 逐字 + zh/en 键集合相等 + 必含子集', () => {
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const { ctx, calls } = makeCtx();
  face.apply(ctx);

  assert.equal(calls.localeRegisters.length, 1);
  assert.equal(calls.localeRegisters[0].ns, 'dsh-ppt-master-config');
  const { zh, en } = calls.localeRegisters[0].dicts;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  const required = [
    'title',
    'intro',
    'version.plugin',
    'field.enabled.hint',
    'field.path.hint',
    'reset.hint',
    'state.memory',
    'action.save',
    'action.reset',
  ];
  for (const key of required) {
    assert.ok(key in zh, `zh 缺键：${key}`);
    assert.ok(key in en, `en 缺键：${key}`);
  }
});

test('注册面: 槽位 options 逐字 + 卡片为函数组件 + 不声明 children', () => {
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const { ctx, calls } = makeCtx();
  face.apply(ctx);

  assert.deepEqual(calls.slotInjects, ['plugins.bundle.config']);
  assert.equal(calls.slotRegisters.length, 1);
  const { options, Component } = calls.slotRegisters[0];
  assert.deepEqual(options, {
    name: 'plugins.bundle.config',
    key: 'dsh-ppt-master-wrapper',
    locale: 'dsh-ppt-master-config',
  });
  assert.equal(typeof Component, 'function');
  assert.equal('children' in options, false);
});

test('注册面: configForms 经 ctx.inject 回调式接入，不入硬 inject', () => {
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const { ctx, calls } = makeCtx();
  face.apply(ctx);

  assert.deepEqual(calls.injects, [['configForms']]);
  assert.equal(face.inject.includes('configForms'), false);
  assert.deepEqual(calls.formsGet, ['dsh-ppt-master-wrapper']);
  assert.ok(calls.effectLabels.some((label) => String(label).includes('dsh-ppt-master-config')));
  assert.ok(calls.effectLabels.some((label) => String(label).includes('config form')));
});

// ─── 用例 10：命名空间兜底 ─────────────────────────────────────────

test('命名空间兜底四例', () => {
  const { factory } = loadEntry();
  const face = factory(makeRequire());

  const cases = [
    { label: '①目录含 NS', namespaces: [{ ns: 'dsh-ppt-master-wrapper', value: {} }], expect: 'dsh-ppt-master-wrapper' },
    {
      label: '②恰一个含 venv 的 other',
      namespaces: [{ ns: 'other', value: { venv: {} } }],
      expect: 'other',
    },
    { label: '③describe 抛错', namespaces: 'throw', expect: 'dsh-ppt-master-wrapper' },
    {
      label: '④两个含 venv 的 ns',
      namespaces: [
        { ns: 'a', value: { venv: {} } },
        { ns: 'b', value: { venv: {} } },
      ],
      expect: 'dsh-ppt-master-wrapper',
    },
  ];

  for (const item of cases) {
    const { ctx, calls } = makeCtx({ namespaces: item.namespaces });
    face.apply(ctx);
    assert.deepEqual(calls.formsGet.at(-1), item.expect, `兜底用例失败：${item.label}`);
  }
});

// ─── 用例 11：守卫 ────────────────────────────────────────────────

test('守卫: configForms 缺席 → 该接入不注册、槽位照常、不抛、零 warn', () => {
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const { ctx, calls } = makeCtx({ configForms: false });
  const warns = captureWarn(() => {
    assert.doesNotThrow(() => face.apply(ctx));
  });

  assert.deepEqual(calls.formsGet, []);
  assert.equal(calls.slotRegisters.length, 1);
  assert.deepEqual(warns, []);
  assert.deepEqual(calls.warns, []);
});

// ─── 用例 12：异常隔离 ────────────────────────────────────────────

test('异常隔离: 单注册点抛错不拖垮其余', () => {
  const { factory } = loadEntry();
  const face = factory(makeRequire());

  // ① locale.register 抛错（模拟宿主同名 (ns, locale) 重复注册直接抛错）
  {
    const { ctx, calls } = makeCtx();
    const original = ctx.locale.register;
    ctx.locale.register = () => {
      throw new Error('duplicate locale registration');
    };
    const warns = captureWarn(() => face.apply(ctx));
    ctx.locale.register = original;
    assert.equal(calls.slotRegisters.length, 1, 'locale 抛错不得拖垮槽位注册');
    assert.ok(calls.formsGet.length > 0, 'locale 抛错不得拖垮 configForms 接入');
    assert.equal(warns.length, 1, `warn 应恰 1 条（实际 ${warns.length}）`);
    assert.match(warns[0], /locale/);
  }

  // ② slots.register 抛错
  {
    const { ctx, calls } = makeCtx();
    ctx.slots.register = () => {
      throw new Error('slot registration refused');
    };
    const warns = captureWarn(() => face.apply(ctx));
    assert.equal(calls.localeRegisters.length, 1, 'slot 抛错不得拖垮字典注册');
    assert.ok(calls.formsGet.length > 0, 'slot 抛错不得拖垮 configForms 接入');
    assert.equal(warns.length, 1, `warn 应恰 1 条（实际 ${warns.length}）`);
    assert.match(warns[0], /slot/);
  }
});

// ─── 用例 13：生命周期 ────────────────────────────────────────────

test('生命周期: dispose 回收两处 disposer；dispose 后再 apply 不抛', () => {
  const { factory } = loadEntry();
  const face = factory(makeRequire());

  const first = makeCtx();
  face.apply(first.ctx);
  first.disposeAll();
  assert.equal(first.calls.localeRegisters[0].disposed, true);
  assert.equal(first.calls.formUnsubscribed, true);

  const second = makeCtx();
  assert.doesNotThrow(() => face.apply(second.ctx));
  assert.equal(second.calls.localeRegisters.length, 1);
  assert.equal(second.calls.slotRegisters.length, 1);
  assert.ok(second.calls.formsGet.length > 0);
});

// ─── 用例 14：样式注入 ────────────────────────────────────────────

test('样式注入: 无 document 不抛；有 document 恰注入一次且含 token 与插件前缀类名', () => {
  const { factory } = loadEntry();
  const face = factory(makeRequire());

  const noDoc = makeCtx();
  assert.doesNotThrow(() => face.apply(noDoc.ctx));

  const appended = [];
  const document = {
    head: {
      appendChild(el) {
        appended.push(el);
      },
    },
    createElement: (tag) => ({ tag, id: '', textContent: '' }),
    getElementById: (id) => appended.find((el) => el.id === id) ?? null,
  };

  const before = globalThis.document;
  globalThis.document = document;
  try {
    face.apply(makeCtx().ctx);
    face.apply(makeCtx().ctx);
  } finally {
    if (before === undefined) delete globalThis.document;
    else globalThis.document = before;
  }

  assert.equal(appended.length, 1, '同一 document 下样式应恰注入一次（幂等）');
  assert.equal(appended[0].id, 'ppt-master-config-styles');
  assert.match(appended[0].textContent, /--dsw-alias-/);
  assert.match(appended[0].textContent, /\.ppt-master-config-/);
});

// ─── 用例 15：渲染冒烟 ────────────────────────────────────────────

test('渲染冒烟: 三态壳各渲染一次不抛且文案互不相同', () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());

  // ① 未接入形态：configForms 在场但命名空间未列出本插件 ⇒ holder 无表单 ⇒ undefined 快照。
  // 其余两态直接给定假表单快照。
  const states = [
    { label: 'unconfigured（未接入）', ctxOpts: { namespaces: [], form: null } },
    { label: 'loading', ctxOpts: { form: makeFakeForm({ snapshot: { status: 'loading' } }) } },
    { label: 'unavailable', ctxOpts: { form: makeFakeForm({ snapshot: { status: 'unavailable' } }) } },
  ];

  const texts = [];
  for (const state of states) {
    const { ctx, calls } = makeCtx(state.ctxOpts);
    face.apply(ctx);
    const Card = calls.slotRegisters[0].Component;

    let rendered;
    assert.doesNotThrow(() => {
      rendered = renderCard(Card);
    }, `${state.label} 渲染不得抛错`);
    texts.push(rendered.text);
    for (const element of findAll(rendered.tree, () => true)) {
      assert.equal(typeof element.type, 'string', '卡片只渲染原生元素');
    }
  }

  assert.equal(new Set(texts).size, 3, `三态文案应互不相同：${JSON.stringify(texts)}`);

  const dictCalls = makeCtx();
  face.apply(dictCalls.ctx);
  const { zh } = dictCalls.calls.localeRegisters[0].dicts;
  assert.ok(texts[0].includes(zh['state.unconfigured']), `未渲染 state.unconfigured：${texts[0]}`);
  assert.ok(texts[1].includes(zh['state.loading']), `未渲染 state.loading：${texts[1]}`);
  assert.ok(texts[2].includes(zh['state.unavailable']), `未渲染 state.unavailable：${texts[2]}`);

  // 独立的**字面量**锚（不再取 DICT）：上三条两侧同源，只改字典值会一起漂移而假绿。
  // 锚串须**该态独有**——intro 也含"宿主配置"，故它不能当 loading 锚。
  assert.ok(texts[0].includes('configForms'), `unconfigured 文案应点名 configForms：${texts[0]}`);
  assert.ok(texts[1].includes('正在读取'), `loading 文案异常：${texts[1]}`);
  assert.ok(texts[2].includes('配置通道不可用'), `unavailable 文案异常：${texts[2]}`);
});

// ─── 用例 16：package.json 声明面 ─────────────────────────────────

test('package.json 声明面', () => {
  const pkg = readPkg();
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-plugin-manager',
  ]);
  assert.deepEqual(pkg.dsh.client.external, ['react']);
  assert.ok(pkg.files.includes('lib') || pkg.files.includes('lib/client.js'));
  // 既有三条 exports 条目仍在（本 Task 只增不删）。
  assert.equal(pkg.exports['.'], './index.js');
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml');
  assert.equal(pkg.exports['./package.json'], './package.json');
});
