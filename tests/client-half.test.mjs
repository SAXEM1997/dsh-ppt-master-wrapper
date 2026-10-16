import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseFrontmatter } from '../lib/skill-provider.js';

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
/**
 * 包根**绝对**路径：供 T2①⑤ 的"不泄漏绝对 SKILL_DIR"断言（卡片只显示相对尾部）。
 * 由 `CLIENT_ENTRY` 派生（`client.js` 在 `<包根>/lib/` 下）——与实现侧
 * `PACKAGE_ROOT_ABS = dirname(CLIENT_ENTRY)` 取同一路径。
 */
const PACKAGE_ROOT_ABS = dirname(dirname(CLIENT_ENTRY));

/** SKILL.md frontmatter 的上游版本（`metadata.version`，如 `6.7.0`）。 */
function readUpstreamVersion() {
  const raw = readFileSync(join(repoRoot, 'skills', 'ppt-master', 'SKILL.md'), 'utf8');
  const parsed = parseFrontmatter(raw);
  assert.ok(parsed !== null, 'SKILL.md 应有可解析的 frontmatter');
  const version = parsed.data?.metadata?.version;
  assert.equal(typeof version, 'string', 'SKILL.md 的 metadata.version 应为字符串');
  return version;
}

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
  const effectDeps = new Map(); // effect 槽位 → 最近一次传入的依赖数组（T2 增量）
  let cursor = 0; // 本渲染的 hook 槽位游标
  let slots = []; // hook 槽位（跨重渲染保持）
  let pendingEffects = []; // 本渲染挂起的 effect
  let dirty = false; // setState 置脏
  let mounted = false;
  let current = { Component: null, props: undefined };

  const runtime = {
    /**
     * 外部（非 setState）变更后的**重渲染**请求：宿主语言切换不属于组件自身状态变更，
     * 但真实 React 会因 locale 上下文更新而重渲染本卡片。测试侧以"置脏一次"建模，
     * 下次 `settle()` 即重跑组件函数（T2③ 的同一用例内切语言断言依赖此语义）。
     */
    invalidate: () => {
      dirty = true;
    },
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
    useEffect: (fn, deps) => {
      // T2 增量：记录依赖数组。夹具不实现依赖比较（真实 React 的职责），但把 deps 暴露
      // 出来，使"订阅 effect 以 holder 身份为依赖"（T1 审查裁定②）可被观测而非只靠约定。
      pendingEffects.push({ index: cursor++, fn, deps });
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
      for (const { index, fn, deps } of frame.effects) {
        if (typeof slots[index] === 'function') slots[index](); // 上一轮 cleanup
        const result = fn();
        slots[index] = typeof result === 'function' ? result : null;
        effectDeps.set(index, deps);
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

  hookRuntime = {
    runtime,
    render,
    settle,
    unmount,
    isMounted: () => mounted,
    /** 某 effect 槽位最近一次的依赖数组（未传 ⇒ `undefined`）。 */
    depsOf: (index) => effectDeps.get(index),
  };
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
  // `activeLocale` 用**持有器**而非裸参数：`setActiveLocale` 要能改到 `bind` 现读的那个变量
  // （模块级/参数级解构都改不到），宿主语言切换形态即此。
  const localeState = { current: activeLocale };
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
      /**
       * T2 增量：界面语言可**运行时**切换（宿主语言切换形态）。`bind` 已按调用现读，
       * 故只改此变量——T2③ 在**同一用例内**先断 zh、再切 en 断切换生效。
       */
      setActiveLocale: (next) => {
        localeState.current = next;
        hookRuntime?.runtime?.invalidate?.(); // 宿主语境变化 ⇒ 卡片随之重渲染
      },
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
        const table = dict[localeState.current] ?? {};
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

// ─── Task 2：卡片读面 ──────────────────────────────────────────────
//
// 复用 T1 夹具：`makeCtx({ form })` 驱动 holder，`renderCard/settle/textOf/find/findAll`
// 驱动渲染树。**硬规则不变**：`loadEntry()` 一律在各用例体内调用。
//
// 本组用例的 DOM 锚即 T3 的消费面（根 `.ppt-master-config-card`、版本块
// `.ppt-master-config-versions`、`#ppt-master-config-path` / `#ppt-master-config-policy`）。

/** 渲染卡片的公共前缀：apply 后取注册的组件并渲染，返回 `{ tree, text, settle, ... }`。 */
function renderApplied(face, ctxOpts) {
  const { ctx, calls } = makeCtx(ctxOpts);
  face.apply(ctx);
  const Card = calls.slotRegisters[0].Component;
  return { ctx, calls, Card, rendered: renderCard(Card) };
}

/** 齐备快照（三叶子均为正确类型）的假表单快照值。 */
function fullSnapshot(overrides = {}) {
  return { status: 'ready', value: { venv: { enabled: true, path: '/srv/venv', oldPathPolicy: 'delete' } }, ...overrides };
}

// ─── 用例 17：版本块 ──────────────────────────────────────────────

test('版本块: 两条配对断言 + 相对尾部 + 不泄漏绝对路径', () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());

  const pkgVersion = readPkg().version;
  const upstreamVersion = readUpstreamVersion();
  const { ctx, rendered } = renderApplied(face, { form: makeFakeForm({ snapshot: fullSnapshot() }) });
  const text = rendered.text;
  const tokens = text.match(/\b\d+\.\d+\.\d+(?:-r\d+)?\b/g) ?? [];

  // ① 插件版本常量 ≡ package.json.version；② 上游版本常量 ≡ SKILL.md metadata.version。
  assert.ok(tokens.includes(pkgVersion), `版本块缺插件版本 ${pkgVersion}：${text}`);
  assert.ok(tokens.includes(upstreamVersion), `版本块缺上游版本 ${upstreamVersion}：${text}`);
  // ③ 归一化配对（不做三值相等）：版本块内每个版本类串都是"上游版本 + 可选 -rN"。
  const paired = new RegExp('^' + escapeRe(upstreamVersion) + '(-r\\d+)?$');
  assert.ok(tokens.length > 0, '版本块应至少含一个版本类串');
  assert.ok(
    tokens.every((token) => paired.test(token)),
    `版本块出现非配对版本串：${JSON.stringify(tokens)}`,
  );
  // ③′ 常量间显式配对：插件版本 = 上游版本 + 可选 -rN（不依赖渲染面 token）。
  assert.match(pkgVersion, new RegExp('^' + escapeRe(upstreamVersion) + '(-r\\d+)?$'));
  // ④ 固定相对尾部逐字（含尖括号占位）；⑤ 不泄漏绝对 SKILL_DIR / 包根。
  assert.ok(text.includes('<包根>/skills/ppt-master'), `版本块缺相对尾部：${text}`);
  assert.equal(text.includes(PACKAGE_ROOT_ABS), false, `卡片泄漏绝对路径：${text}`);

  // ⑥ 相对尾部走**字典键**（T2 审查 Important-1 回归）：硬编码 zh 形态常量会让英文界面
  // 显示中文占位串、并使 `version.skillDirValue` 成死键——故断言 en 下取到 en 值。
  ctx.locale.setActiveLocale('en');
  const en = rendered.text;
  assert.ok(en.includes('<package root>/skills/ppt-master'), `en 版本块缺相对尾部：${en}`);
  assert.equal(en.includes('<包根>'), false, `en 下不应残留 zh 占位串：${en}`);
});

// ─── 用例 18：开关读写面 ──────────────────────────────────────────

test('开关: role/aria-checked/点击改暂存态不改宿主', () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const { calls, rendered } = renderApplied(face, {
    form: makeFakeForm({ snapshot: { status: 'ready', value: { venv: { enabled: false, path: '/srv/venv', oldPathPolicy: 'keep' } } } }),
  });

  const switchOf = (tree) => find(tree, (el) => el.props?.role === 'switch');
  assert.equal(find(rendered.tree, (el) => el.props?.className === 'ppt-master-config-switch')?.type, 'button');

  const before = switchOf(rendered.tree);
  assert.ok(before !== undefined, '卡片应渲染 role="switch" 控件');
  assert.equal(before.props['aria-checked'], false);

  before.props.onClick();
  const after = switchOf(rendered.settle());
  assert.equal(after.props['aria-checked'], true, '点击后开关应转 true');
  assert.equal(calls.mutates.length, 0, '读面不得发任何宿主写');
});

// ─── 用例 19：关闭态文案（双语）───────────────────────────────────

test('开关契约文案（关闭态，双语）', () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const { ctx, calls } = makeCtx({
    form: makeFakeForm({ snapshot: { status: 'ready', value: { venv: { enabled: false, path: '/srv/venv', oldPathPolicy: 'keep' } } } }),
  });
  face.apply(ctx);
  const rendered = renderCard(calls.slotRegisters[0].Component);

  const zh = rendered.text;
  for (const needle of ['不删除任何目录', '容器', 'python3']) {
    assert.ok(zh.includes(needle), `zh 关闭态提示缺 ${needle}：${zh}`);
  }

  // 同一用例内切界面语言：字典 bind 现读，settle 后文案应随之切换。
  ctx.locale.setActiveLocale('en');
  const en = rendered.settle() && rendered.text;
  for (const needle of ['no directory', 'container', 'python3']) {
    assert.ok(en.includes(needle), `en 关闭态提示缺 ${needle}：${en}`);
  }
  assert.equal(en.includes('不删除任何目录'), false, 'en 下不应残留 zh 文案');
});

// ─── 用例 20：路径文案 ────────────────────────────────────────────

test('路径文案（非法路径）', () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const { rendered } = renderApplied(face, { form: makeFakeForm({ snapshot: fullSnapshot() }) });

  const text = rendered.text;
  assert.ok(text.includes('配置无效'), `路径提示缺"配置无效"：${text}`);
  assert.ok(text.includes('保存'), `路径提示缺"保存照常成功"预告：${text}`);
});

// ─── 用例 21：重置文案 ────────────────────────────────────────────

test('重置文案', () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const { rendered } = renderApplied(face, { form: makeFakeForm({ snapshot: fullSnapshot() }) });
  assert.ok(rendered.text.includes('config 键'), `重置提示缺"config 键"：${rendered.text}`);
});

// ─── 用例 22：焦点与 Escape ───────────────────────────────────────

test('控件焦点与 Escape', () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const { rendered } = renderApplied(face, {
    form: makeFakeForm({ snapshot: { status: 'ready', value: { venv: { enabled: false, path: '/base', oldPathPolicy: 'keep' } } } }),
  });

  const inputOf = (tree) => find(tree, (el) => el.props?.id === 'ppt-master-config-path');
  const selectOf = (tree) => find(tree, (el) => el.props?.id === 'ppt-master-config-policy');
  const switchOf = (tree) => find(tree, (el) => el.props?.role === 'switch');

  for (const [name, el] of [['input', inputOf(rendered.tree)], ['select', selectOf(rendered.tree)], ['switch', switchOf(rendered.tree)]]) {
    assert.ok(el !== undefined, `卡片应渲染 ${name}`);
    assert.equal(el.props.tabIndex, undefined, `${name} 不得设 tabIndex（原生可聚焦）`);
  }
  assert.equal(inputOf(rendered.tree).type, 'input');
  assert.equal(selectOf(rendered.tree).type, 'select');

  // 标签关联成立：每个字段行内的 `<label>` 的 htmlFor 逐字指向该行控件的 id。
  const fieldOf = (tree, id) =>
    find(tree, (el) => el.props?.className === 'ppt-master-config-field' &&
      findAll(el, (node) => node.props?.id === id).length > 0);
  for (const id of ['ppt-master-config-enabled', 'ppt-master-config-path', 'ppt-master-config-policy']) {
    const field = fieldOf(rendered.tree, id);
    assert.ok(field !== undefined, `应有承载 ${id} 的字段行`);
    const label = find(field, (el) => el.props?.htmlFor !== undefined);
    assert.ok(label !== undefined, `字段 ${id} 应有 <label htmlFor>`);
    assert.equal(label.props.htmlFor, id, 'label htmlFor 应逐字指向控件 id');
    assert.equal(label.type, 'label');
  }

  // 暂存：路径框设为 'B'，开关与选择器也各改一次（验证 Escape 只回落本字段）。
  inputOf(rendered.tree).props.onChange({ target: { value: 'B' } });
  switchOf(rendered.settle()).props.onClick();
  selectOf(rendered.settle()).props.onChange({ target: { value: 'delete' } });
  const staged = rendered.settle();
  assert.equal(inputOf(staged).props.value, 'B');
  assert.equal(selectOf(staged).props.value, 'delete');

  inputOf(staged).props.onKeyDown({ key: 'Escape' });
  const after = rendered.settle();
  assert.equal(inputOf(after).props.value, '/base', 'Escape 后路径框应回落宿主基值');
  assert.equal(selectOf(after).props.value, 'delete', 'Escape 只回落本字段，其余字段不动');
  assert.equal(switchOf(after).props['aria-checked'], true, 'Escape 只回落本字段，开关不动');
});

// ─── 用例 23：readOnly 与 memory 提示 ─────────────────────────────

test('readOnly 与 memory 提示', () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const dict = (() => {
    const { ctx, calls } = makeCtx();
    face.apply(ctx);
    return calls.localeRegisters[0].dicts.zh;
  })();

  const readOnly = renderApplied(face, { form: makeFakeForm({ snapshot: { status: 'ready', writable: false, value: { venv: {} } } }) });
  const readOnlyText = readOnly.rendered.text;
  assert.ok(readOnlyText.includes(dict['state.readOnly']), `缺 readOnly 文案：${readOnlyText}`);
  assert.equal(readOnlyText.includes(dict['state.memory']), false, '两状态文案不得同时出现');
  const disabledCount = findAll(readOnly.rendered.tree, (el) => el.props?.disabled === true).length;
  assert.ok(disabledCount >= 3, `readOnly 下三控件应禁用（实际 ${disabledCount}）`);

  const memory = renderApplied(face, { form: makeFakeForm({ snapshot: { status: 'unavailable', writable: false, mode: 'memory' } }) });
  const memoryText = memory.rendered.text;
  assert.ok(memoryText.includes(dict['state.memory']), `缺 memory 文案：${memoryText}`);
  assert.ok(memoryText.includes('不会写入宿主配置'), `memory 文案应说清后果：${memoryText}`);
  assert.equal(memoryText.includes(dict['state.readOnly']), false, '两状态文案不得同时出现');
});

// ─── 用例 24：敌意快照容错 ────────────────────────────────────────

test('敌意快照容错', () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());

  const cases = [
    { label: '① status 非枚举值', snapshot: { status: 'weird' } },
    { label: '② value 为 null', snapshot: { status: 'ready', value: null } },
    { label: '③ venv 缺失', snapshot: { status: 'ready', value: {} } },
    { label: '④ 三叶子类型不符', snapshot: { status: 'ready', value: { venv: { enabled: 'yes', path: 42, oldPathPolicy: 'nope' } } } },
  ];

  const texts = [];
  for (const item of cases) {
    const { rendered } = renderApplied(face, { form: makeFakeForm({ snapshot: item.snapshot }) });
    let tree;
    assert.doesNotThrow(() => {
      tree = rendered.settle();
    }, `${item.label} 渲染不得抛错`);
    texts.push(textOf(tree));
  }

  // ① 非枚举 status → 归一化为 loading 文案（不动「不可用」文案）。
  const { ctx: dictCtx, calls: dictCalls } = makeCtx();
  face.apply(dictCtx);
  const zh = dictCalls.localeRegisters[0].dicts.zh;
  assert.ok(texts[0].includes(zh['state.loading']), `非枚举 status 应落 loading：${texts[0]}`);
  assert.equal(texts[0].includes(zh['state.unavailable']), false);

  // ②③④ 缺基值/类型不符 → 三控件禁用、路径框为空串、开关 false。
  for (const index of [1, 2, 3]) {
    const { rendered } = renderApplied(face, { form: makeFakeForm({ snapshot: cases[index].snapshot }) });
    const tree = rendered.settle();
    const input = find(tree, (el) => el.props?.id === 'ppt-master-config-path');
    const select = find(tree, (el) => el.props?.id === 'ppt-master-config-policy');
    const toggle = find(tree, (el) => el.props?.role === 'switch');
    assert.equal(input.props.value, '', `${cases[index].label}：路径应为空串`);
    assert.equal(input.props.disabled, true, `${cases[index].label}：路径框应禁用`);
    assert.equal(select.props.disabled, true, `${cases[index].label}：选择器应禁用`);
    assert.equal(toggle.props.disabled, true, `${cases[index].label}：开关应禁用`);
    assert.equal(toggle.props['aria-checked'], false, `${cases[index].label}：开关应为 false`);
  }
});

// ─── 用例 25：渲染冒烟 ────────────────────────────────────────────

test('渲染冒烟（设计 §7.4，SlotAssemblyError 触发条件规避）', () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const { rendered } = renderApplied(face, { form: makeFakeForm({ snapshot: fullSnapshot() }) });

  let tree;
  assert.doesNotThrow(() => {
    tree = rendered.settle();
  }, '齐备快照渲染全程不得抛错');
  for (const element of findAll(tree, () => true)) {
    assert.equal(typeof element.type, 'string', '卡片只渲染原生元素（无子组件/Fragment）');
  }
  assert.equal(tree.props?.className, 'ppt-master-config-card', '根元素即卡片唯一定位锚');
  assert.ok(find(tree, (el) => el.props?.className === 'ppt-master-config-versions') !== undefined, '应有版本块');

  // 重挂载子断言（T1 审查裁定）：disposeAll 后旧 holder 已清空，新 apply 必须**刷新**
  // Card 对 holder/t 的静态引用（或改用稳定转发器），否则重挂载的卡片死在"未接入"。
  const first = makeCtx({ form: makeFakeForm({ snapshot: fullSnapshot() }) });
  face.apply(first.ctx);
  const FirstCard = first.calls.slotRegisters[0].Component;
  const firstRender = renderCard(FirstCard);
  firstRender.unmount();
  first.disposeAll();

  const second = makeCtx({ form: makeFakeForm({ snapshot: fullSnapshot() }) });
  face.apply(second.ctx);
  const SecondCard = second.calls.slotRegisters[0].Component;
  const remounted = renderCard(SecondCard);
  const remountedText = remounted.text;
  assert.ok(
    find(remounted.tree, (el) => el.props?.className === 'ppt-master-config-versions') !== undefined,
    `重挂载后应读到新 holder 的 ready 态（不得卡"未接入"）：${remountedText}`,
  );
  assert.equal(remountedText.includes('configForms'), false, '重挂载后不应落 unconfigured 文案');
  assert.equal(find(remounted.tree, (el) => el.props?.id === 'ppt-master-config-path').props.value, '/srv/venv');

  // 裁定②的**依赖**观测：订阅 effect 不得用 `[]`（空依赖永不重订阅），且依赖项必须随
  // holder **换代**而换身份——否则 holder 换代后卡片仍订阅旧 holder（旧 holder 已清空）。
  const depsAt = (index) => hookRuntime.depsOf(index);
  // 槽位编号＝hook **调用序**（2 个 useState 占 0/1，两个 useEffect 占 2/3）。
  const SUBSCRIBE_SLOT = 2;
  const INIT_SLOT = 3;
  const beforeApply = [depsAt(SUBSCRIBE_SLOT), depsAt(INIT_SLOT)].map((deps) => deps?.[0]);
  assert.ok(
    Array.isArray(depsAt(SUBSCRIBE_SLOT)) && depsAt(SUBSCRIBE_SLOT).length === 1,
    `订阅 effect 应恰依赖一项（空依赖＝永不重订阅）：${JSON.stringify(depsAt(SUBSCRIBE_SLOT))}`,
  );
  assert.ok(
    Array.isArray(depsAt(INIT_SLOT)) && depsAt(INIT_SLOT).length === 1,
    `初始化 effect 应恰依赖一项：${JSON.stringify(depsAt(INIT_SLOT))}`,
  );

  const fifth = makeCtx({ form: makeFakeForm({ snapshot: fullSnapshot() }) });
  face.apply(fifth.ctx);
  renderCard(fifth.calls.slotRegisters[0].Component);
  const afterApply = [depsAt(SUBSCRIBE_SLOT), depsAt(INIT_SLOT)].map((deps) => deps?.[0]);
  assert.ok(
    afterApply.every((item, index) => item !== beforeApply[index]),
    'apply 换代后新渲染的卡片应把依赖指向**新** holder 身份（依赖必须跟随 holder）',
  );
});

// ─── Task 3：卡片写面 ──────────────────────────────────────────────
//
// 复用 T1/T2 夹具与读面 DOM 契约（`renderApplied` / `fullSnapshot` / `find` / `textOf`）。
// **硬规则不变**：`loadEntry()` 一律在各用例体内调用。
//
// 写面 DOM 锚（T3 落地）：
// - 保存/重置：`<button type="button" className="ppt-master-config-button">`，
//   `props.onClick` **返回 Promise**（可测性契约；React 事件处理器返回值无副作用）；
// - notice：`<p className="ppt-master-config-notice" role="status">`。
//
// 按钮定位采用**结构锚**（动作行内按文案区分、并按 `disabled` 归类），不依赖实现另设 id：
// 类名 `ppt-master-config-button` 是 T3 Produces 钉死的**唯一** button 锚。

/** 保存按钮的文案＝字典 `action.save`；返回该按钮元素（找不到即 `undefined`）。 */
function buttonByLabel(tree, label) {
  return find(
    tree,
    (el) =>
      el.type === 'button' &&
      el.props?.className === 'ppt-master-config-button' &&
      textOf(el) === label,
  );
}

/** 卡片字典（zh）：apply 一次后从 `localeRegisters` 取，避免测试侧复制文案。 */
function zhDictOf(face) {
  const { ctx, calls } = makeCtx();
  face.apply(ctx);
  return calls.localeRegisters[0].dicts.zh;
}

/**
 * 写面假表单：**记录 `structuredClone(ops)` 与 `revision`**，`mutate` 用**方法形态**
 * 调用（以 `this` 自校验——宿主控制器是对象方法；若卡片把 `mutate` 解构出来裸调，
 * `this` 即为 `undefined`，此处立刻抛错，比断言更硬）。
 *
 * `outcome` 可为：`true`/`false`（resolve 该字面量）、`Error` 实例（reject）、
 * Promise（原样返回，供 pending 用例的 deferred）。默认 resolve `true`。
 */
function makeWriteForm({ snapshot, outcome = true } = {}) {
  const calls = { mutates: [], unsubscribed: false };
  const form = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {
      calls.unsubscribed = true;
    },
    mutate(ops, revision) {
      if (this !== form) throw new Error('mutate 必须以方法形态调用（this 应为表单对象）');
      calls.mutates.push({ ops: structuredClone(ops), revision });
      if (outcome instanceof Error) return Promise.reject(outcome);
      if (outcome instanceof Promise) return outcome;
      return Promise.resolve(outcome);
    },
  };
  return { form, calls };
}

/** 手工可控 deferred（`pending 态` 用例的未决 Promise 锚）。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 齐备且**可写**的写面快照（revision 7；三叶子类型齐备）。 */
function writableSnapshot(overrides = {}) {
  return {
    status: 'ready',
    writable: true,
    revision: 7,
    value: { venv: { enabled: false, path: '/base', oldPathPolicy: 'keep' } },
    ...overrides,
  };
}

/** 开关/路径/选择器的定位器（与 T2 用例 22 同形）。 */
const switchIn = (tree) => find(tree, (el) => el.props?.role === 'switch');
const pathIn = (tree) => find(tree, (el) => el.props?.id === 'ppt-master-config-path');
const policyIn = (tree) => find(tree, (el) => el.props?.id === 'ppt-master-config-policy');
const noticeIn = (tree) => find(tree, (el) => el.props?.className === 'ppt-master-config-notice');

/** 渲染一张可写卡片，返回 { calls, rendered, zh, form }（保存/重置按钮的公共前缀）。 */
function renderWritable(face, { snapshot, outcome } = {}) {
  // 字典**先取**：`apply` 会重装 `Card.forwarder`（稳定对象、成员按代取值），若在卡片
  // 渲染后再 apply 一次，卡片会改读后一个 holder。故字典／渲染严格分两次 apply、字典在前。
  const zh = zhDictOf(face);
  const { form, calls } = makeWriteForm({ snapshot: snapshot ?? writableSnapshot(), outcome });
  const { ctx, calls: ctxCalls } = makeCtx({ form });
  face.apply(ctx);
  const Card = ctxCalls.slotRegisters[0].Component;
  return { form, calls, ctxCalls, zh, rendered: renderCard(Card) };
}
// ─── 用例 26：set ops — enabled ───────────────────────────────────

test('写面 set ops: enabled', async () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const { calls, rendered, zh } = renderWritable(face);

  // 点开关（基值 false → 暂存 true）后点保存。
  switchIn(rendered.tree).props.onClick();
  const save = buttonByLabel(rendered.settle(), zh['action.save']);
  assert.ok(save !== undefined, '卡片应渲染保存按钮');
  assert.equal(save.props.type, 'button');
  await save.props.onClick();
  rendered.settle();

  assert.equal(calls.mutates.length, 1, '保存应恰发一次 mutate');
  assert.deepEqual(calls.mutates[0].ops, [{ op: 'set', path: ['venv', 'enabled'], value: true }]);
  assert.equal(calls.mutates[0].revision, 7, 'revision 应透传假快照的 7');
});

// ─── 用例 27：set ops — path ──────────────────────────────────────

test('写面 set ops: path', async () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const { calls, rendered, zh } = renderWritable(face);

  pathIn(rendered.tree).props.onChange({ target: { value: '/srv/venv' } });
  const save = buttonByLabel(rendered.settle(), zh['action.save']);
  await save.props.onClick();
  rendered.settle();

  assert.equal(calls.mutates.length, 1);
  assert.deepEqual(calls.mutates[0].ops, [{ op: 'set', path: ['venv', 'path'], value: '/srv/venv' }]);
});

// ─── 用例 28：set ops — oldPathPolicy ─────────────────────────────

test('写面 set ops: oldPathPolicy', async () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const { calls, rendered, zh } = renderWritable(face);

  policyIn(rendered.tree).props.onChange({ target: { value: 'delete' } });
  const save = buttonByLabel(rendered.settle(), zh['action.save']);
  await save.props.onClick();
  rendered.settle();

  assert.equal(calls.mutates.length, 1);
  assert.deepEqual(calls.mutates[0].ops, [
    { op: 'set', path: ['venv', 'oldPathPolicy'], value: 'delete' },
  ]);
});

// ─── 用例 29：重置 ────────────────────────────────────────────────

test('重置: 一次调用三个 unset、嵌套 path、顺序固定', async () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const { calls, rendered, zh } = renderWritable(face);

  const reset = buttonByLabel(rendered.tree, zh['action.reset']);
  assert.ok(reset !== undefined, '卡片应渲染重置按钮');
  assert.equal(reset.props.type, 'button');
  await reset.props.onClick();
  rendered.settle();

  assert.equal(calls.mutates.length, 1, '重置应恰一次 mutate（不是三次）');
  assert.deepEqual(calls.mutates[0].ops, [
    { op: 'unset', path: ['venv', 'enabled'] },
    { op: 'unset', path: ['venv', 'path'] },
    { op: 'unset', path: ['venv', 'oldPathPolicy'] },
  ]);
  assert.equal(calls.mutates[0].revision, 7);
});

// ─── 用例 30：两类可观测量①（resolve false）──────────────────────

test('两类可观测量①: resolve false → rejected 文案、不抛、暂存值保留', async () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const { rendered, zh } = renderWritable(face, { outcome: false });

  pathIn(rendered.tree).props.onChange({ target: { value: '/staged' } });
  const save = buttonByLabel(rendered.settle(), zh['action.save']);
  await assert.doesNotReject(() => save.props.onClick(), '保存被否不得抛');
  const text = rendered.text;

  assert.ok(text.includes(zh['notice.rejected']), `缺 rejected 文案：${text}`);
  assert.ok(text.includes('更高优先级'), `缺一般化提示子串：${text}`);
  assert.equal(text.includes(zh['notice.saved']), false, '两类文案不得混用（saved）');
  assert.equal(pathIn(rendered.settle()).props.value, '/staged', '被否后暂存值应保留');
});

// ─── 用例 31：两类可观测量②（reject）─────────────────────────────

test('两类可观测量②: reject → transportError 文案携消息、不抛、两类不混用', async () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const { rendered, zh } = renderWritable(face, { outcome: new Error('boom') });

  switchIn(rendered.tree).props.onClick();
  const save = buttonByLabel(rendered.settle(), zh['action.save']);
  await assert.doesNotReject(() => save.props.onClick(), '传输失败不得冒泡出卡片');
  const text = rendered.text;

  assert.ok(text.includes(zh['notice.transportError']), `缺 transportError 文案：${text}`);
  assert.ok(text.includes('boom'), `传输失败应携错误消息：${text}`);
  assert.equal(text.includes(zh['notice.rejected']), false, '两类不混用（rejected 不得出现）');
});

// ─── 用例 32：revision 时效（Review Focus #3）─────────────────────

test('revision 时效: 换代后以最新 revision 透传，且旧记录不被改写', async () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());

  // 快照**持有器**：广播即让 `getSnapshot` 返回新对象（rev 7 → 8），模拟宿主换代。
  const snapshotState = { current: writableSnapshot({ revision: 7 }) };
  const listeners = [];
  const { form, calls } = (() => {
    const inner = makeWriteForm({ snapshot: undefined });
    inner.form.getSnapshot = () => snapshotState.current;
    inner.form.subscribe = (listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    };
    return inner;
  })();

  // 字典**先取**（apply 会重装 `Card.forwarder`，渲染后再 apply 会让卡片改读后一个 holder）。
  const zh = zhDictOf(face);
  const { ctx, calls: ctxCalls } = makeCtx({ form });
  face.apply(ctx);
  const rendered = renderCard(ctxCalls.slotRegisters[0].Component);

  // 第一次保存：rev 7。
  switchIn(rendered.tree).props.onClick();
  await buttonByLabel(rendered.settle(), zh['action.save']).props.onClick();
  rendered.settle();
  assert.equal(calls.mutates.length, 1);
  assert.equal(calls.mutates[0].revision, 7);
  const firstOps = calls.mutates[0].ops;

  // 宿主换代：rev 8 且已含上次提交的值 → 广播。
  snapshotState.current = {
    status: 'ready',
    writable: true,
    revision: 8,
    value: { venv: { enabled: true, path: '/base', oldPathPolicy: 'keep' } },
  };
  for (const listener of [...listeners]) listener();
  rendered.settle();

  // 第二次保存：改路径 → 必须以**最新** revision 8 透传，不自 bump、不用缓存值。
  pathIn(rendered.settle()).props.onChange({ target: { value: '/next' } });
  await buttonByLabel(rendered.settle(), zh['action.save']).props.onClick();
  rendered.settle();

  assert.equal(calls.mutates.length, 2);
  assert.equal(calls.mutates[1].revision, 8, '第二次保存应透传换代后的 revision 8');
  // 每条记录都是 `structuredClone` 快照：第一条不得被后续调用改写（别名回归）。
  assert.deepEqual(firstOps, [{ op: 'set', path: ['venv', 'enabled'], value: true }]);
  assert.deepEqual(calls.mutates[0].ops, [{ op: 'set', path: ['venv', 'enabled'], value: true }]);
  assert.deepEqual(calls.mutates[1].ops, [{ op: 'set', path: ['venv', 'path'], value: '/next' }]);
});

// ─── 用例 33：无乐观更新 ──────────────────────────────────────────

test('无乐观更新: 保存成功但未回推 → 仍为脏；回推暂存值后才干净', async () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());

  const snapshotState = { current: writableSnapshot() };
  const listeners = [];
  const { form } = makeWriteForm({ snapshot: undefined });
  form.getSnapshot = () => snapshotState.current;
  form.subscribe = (listener) => {
    listeners.push(listener);
    return () => listeners.splice(listeners.indexOf(listener), 1);
  };

  // 字典**先取**（同用例 32：渲染后再 apply 会让卡片改读后一个 holder）。
  const zh = zhDictOf(face);
  const { ctx, calls: ctxCalls } = makeCtx({ form });
  face.apply(ctx);
  const rendered = renderCard(ctxCalls.slotRegisters[0].Component);

  switchIn(rendered.tree).props.onClick();
  await buttonByLabel(rendered.settle(), zh['action.save']).props.onClick();
  const afterSave = rendered.settle();
  assert.equal(
    buttonByLabel(afterSave, zh['action.save']).props.disabled,
    false,
    '未回推时仍为脏：保存按钮应保持可用（不得乐观清理暂存值/自行改基值）',
  );

  // 宿主回推新快照（值＝暂存值）→ 脏集变空 → 保存按钮禁用。
  snapshotState.current = {
    status: 'ready',
    writable: true,
    revision: 8,
    value: { venv: { enabled: true, path: '/base', oldPathPolicy: 'keep' } },
  };
  for (const listener of [...listeners]) listener();
  assert.equal(
    buttonByLabel(rendered.settle(), zh['action.save']).props.disabled,
    true,
    '宿主回推暂存值后应转为干净（脏判定按当前基值现算）',
  );
});

// ─── 用例 34：空脏集与写门（Review Focus #1/#4）──────────────────

test('空脏集与写门', async () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());
  const zh = zhDictOf(face);

  // ① 未改动即点保存：脏集为空 ⇒ 按钮禁用且点击不发 mutate。
  {
    const { calls, rendered } = renderWritable(face);
    const save = buttonByLabel(rendered.tree, zh['action.save']);
    assert.equal(save.props.disabled, true, '空脏集时保存按钮应禁用');
    await assert.doesNotReject(() => save.props.onClick());
    rendered.settle();
    assert.equal(calls.mutates.length, 0, '空脏集不得发 mutate');
  }

  // ② 未就绪 / 只读两行：两按钮均禁用、点击不发 mutate。
  const gated = [
    { label: 'loading', snapshot: { status: 'loading' } },
    { label: 'ready 但 writable=false', snapshot: { status: 'ready', writable: false, revision: 7, value: { venv: { enabled: false, path: '/base', oldPathPolicy: 'keep' } } } },
  ];
  for (const item of gated) {
    const { calls, rendered } = renderWritable(face, { snapshot: item.snapshot });
    const tree = rendered.tree;
    for (const label of [zh['action.save'], zh['action.reset']]) {
      const button = buttonByLabel(tree, label);
      assert.ok(button !== undefined, `${item.label}：应仍渲染按钮（${label}）`);
      assert.equal(button.props.disabled, true, `${item.label}：按钮应禁用（${label}）`);
      await assert.doesNotReject(() => button.props.onClick());
    }
    rendered.settle();
    assert.equal(calls.mutates.length, 0, `${item.label}：写门关闭时不得发 mutate`);
  }

  // ③ memory 模式（不可用 + 只读）：state.memory 提示在场、两按钮禁用。
  {
    const { calls, rendered } = renderWritable(face, {
      snapshot: { status: 'unavailable', writable: false, mode: 'memory' },
    });
    const tree = rendered.tree;
    assert.ok(textOf(tree).includes(zh['state.memory']), `memory 提示应在场：${textOf(tree)}`);
    for (const label of [zh['action.save'], zh['action.reset']]) {
      assert.equal(buttonByLabel(tree, label).props.disabled, true, `memory：按钮应禁用（${label}）`);
    }
    assert.equal(calls.mutates.length, 0);
  }

  // ④ Review Focus #1 的缺失形态：`revision === undefined` ⇒ 渲染不抛、改字段后可保存、
  //    第二参原样为 `undefined`（**不得**自行补 0/null）。
  {
    const { calls, rendered } = renderWritable(face, {
      snapshot: writableSnapshot({ revision: undefined }),
    });
    let tree;
    assert.doesNotThrow(() => {
      tree = rendered.settle();
    }, 'revision:undefined 形态渲染不得抛错');
    assert.equal(buttonByLabel(tree, zh['action.save']).props.disabled, true, '未改动即禁用');
    pathIn(tree).props.onChange({ target: { value: '/srv/venv' } });
    const save = buttonByLabel(rendered.settle(), zh['action.save']);
    await save.props.onClick();
    rendered.settle();
    assert.equal(calls.mutates.length, 1, '改字段后应可保存');
    assert.equal(calls.mutates[0].revision, undefined, 'revision 缺失形态应原样透传 undefined');
    assert.deepEqual(calls.mutates[0].ops, [
      { op: 'set', path: ['venv', 'path'], value: '/srv/venv' },
    ]);
  }
});

// ─── 用例 35：pending 态 ──────────────────────────────────────────

test('pending 态: 未决时显示 saving、resolve 后转 saved', async () => {
  installHookRuntime();
  const { factory } = loadEntry();
  const face = factory(makeRequire());

  const gate = deferred();
  const { calls, rendered, zh } = renderWritable(face, { outcome: gate.promise });

  switchIn(rendered.tree).props.onClick();
  // **不 await**：先拿到 onClick 返回的 Promise（可测性契约），让 pending 态停在屏上。
  const inflight = buttonByLabel(rendered.settle(), zh['action.save']).props.onClick();
  assert.ok(inflight instanceof Promise, 'onClick 应返回 Promise（可测性契约）');

  const pendingText = rendered.settle() && rendered.text;
  assert.ok(pendingText.includes(zh['notice.pending']), `缺 pending 文案：${pendingText}`);
  assert.equal(pendingText.includes(zh['notice.saved']), false, '未决时不得预告已保存');
  assert.equal(noticeIn(rendered.settle()).props.role, 'status', 'notice 应为 role="status"');

  gate.resolve(true);
  await inflight;
  const savedText = rendered.settle() && rendered.text;
  assert.ok(savedText.includes(zh['notice.saved']), `resolve true 后应显示 saved：${savedText}`);
  assert.equal(savedText.includes(zh['notice.pending']), false, '已决后不得残留 pending 文案');
  assert.equal(calls.mutates.length, 1);
});
