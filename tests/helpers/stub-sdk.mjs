#!/usr/bin/env node
/**
 * 共享 stub SDK 构造器（issue #4：CI 在无宿主 DSH SDK 的环境跑全套测试）。
 *
 * 三种用法共用同一构造实现（单一事实源）：
 *  1. 测试内 `makeStubSdk({ …knobs })`——mkdtemp 临时树 + cleanup（compat.test.mjs
 *     原内联版整体迁出，knob 集不变）；
 *  2. 底层 `buildStubSdk(modules, { …knobs })`——写入**显式给定**的 node_modules 目录
 *     （不建临时目录、不清理，幂等：先 rm 再建）；
 *  3. CLI `node tests/helpers/stub-sdk.mjs <dest-base>`——在 `<dest-base>/node_modules`
 *     建**默认形态**树（CI 用；exit 0 输出 modules 路径）。
 *
 * 各 stub 忠实复刻真实契约中本仓库消费面依赖的形态（详见 tests/compat.test.mjs
 * 头注与各用例）：服务自挂 ctx、方法形态 this 绑定、SystemPrompt 需 config、
 * ToolRuntime.register 校验 output、restrict 仅 agent 作用域、guard 返回 disposer。
 *
 * 零 npm 依赖；文件名不匹配 tests/*.test.mjs，不会被 node --test 误当用例文件。
 *
 * @module dsh-ppt-master-wrapper/tests/helpers/stub-sdk
 */

import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 所有权标记（M1「所有权标记法」）：构建成功后写入目标 modules 目录，rm 前凭它
 * 判定「这棵树是不是本工具自己建的」。内容与 `lib/venv.js` 的 `.ppt-master-wrapper.json`
 * 同思路（删除只对带所有权标记的目录生效），但属**另一套标记**（面不同：venv 目录 vs
 * node_modules 目录），文件名与载荷各自独立、不互认。
 */
const OWNERSHIP_MARKER = '.ppt-master-stub-sdk';
const OWNERSHIP_MARKER_PAYLOAD = '{"owner":"ppt-master-stub-sdk","format":1}';

/**
 * M1：rm 前的目标判定（病态路径守卫的第二道门）。
 *
 * 根形态守卫（上方 basename/dirname）只挡住 `/`、`/node_modules` 这类拼写，挡不住
 * `buildStubSdk('node_modules')` 解析到 `<cwd>/node_modules`——该路径形态合法，但
 * 指向的是**真实依赖树**，整树 rm 会把真包删掉（已实测复现）。故 rm 之前必须先确认
 * 目标要么不存在（首次构建）、要么是本工具上一轮建出来的 stub 树（带所有权标记）。
 *
 * @param {string} resolvedModules 已 resolve 的目标路径。
 * @returns {Promise<void>} 允许 rm 时静默返回；否则抛出点名绝对路径的拒绝。
 */
async function assertStubTreeOwned(resolvedModules) {
  let stats;
  try {
    stats = await lstat(resolvedModules);
  } catch (error) {
    if (error?.code === 'ENOENT') return; // 不存在 → 首次构建，允许。
    throw error;
  }
  if (stats.isSymbolicLink()) {
    // 防御性拒绝：fs.rm 只删链接本身（无穿透风险），但「指向别处的链接」绝不属于
    // 本工具建出的形态，不该替它做删除决定。
    throw new Error(`拒绝构造 stub 树: 目标是符号链接，不属于本工具创建的 stub 树，拒绝覆盖: ${resolvedModules}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`拒绝构造 stub 树: 目标已存在且不是目录，不属于本工具创建的 stub 树，拒绝覆盖: ${resolvedModules}`);
  }
  let payload;
  try {
    payload = await readFile(join(resolvedModules, OWNERSHIP_MARKER), 'utf8');
  } catch {
    payload = undefined;
  }
  if (payload === undefined || payload.trim() !== OWNERSHIP_MARKER_PAYLOAD) {
    throw new Error(`拒绝构造 stub 树: 目标目录不是本工具创建的 stub 树（缺所有权标记或标记不符），拒绝覆盖: ${resolvedModules}`);
  }
}

/** schemastery 最小替身（仅本仓库消费面；层①-④ 见 tests/compat.test.mjs）。 */
export const SCHEMASTERY_STUB = [
  "'use strict';",
  '// stub: @deepseek-ai/schemastery 最小替身（仅本仓库消费面；层①-④ 见 tests/compat.test.mjs）。',
  'let nextUid = 0;',
  '',
  '/** 引用图收集：父节点 dict/list 内嵌子节点 → 子节点只留 uid（真实 toJSON 同形）。 */',
  'function collectRefs(schema, refs) {',
  '  if (refs[schema.uid] !== undefined) return schema.uid;',
  '  const node = { type: schema.type, meta: { ...schema.meta } };',
  '  refs[schema.uid] = node;',
  '  if (schema.dict !== undefined) {',
  '    node.dict = {};',
  '    for (const [key, child] of Object.entries(schema.dict)) node.dict[key] = collectRefs(child, refs);',
  '  }',
  '  if (schema.list !== undefined) node.list = schema.list.map((child) => collectRefs(child, refs));',
  '  if (schema.value !== undefined) node.value = schema.value;',
  '  return schema.uid;',
  '}',
  '',
  '/** 校验＋填默认＋volatile 包装（顺序同真实包：先解析值，再 createVolatile）。 */',
  'function parse(schema, data) {',
  '  let value = data;',
  "  if (value === undefined && 'default' in schema.meta) value = schema.meta.default;",
  "  if (schema.type === 'object') {",
  '    const source = value === undefined ? {} : value;',
  "    if (typeof source !== 'object' || source === null || Array.isArray(source)) {",
  "      throw new TypeError('stub schemastery: object expected');",
  '    }',
  '    const result = {};',
  '    for (const [key, child] of Object.entries(schema.dict)) {',
  '      const resolved = parse(child, source[key]);',
  '      if (resolved !== undefined) result[key] = resolved;',
  '    }',
  '    value = result;',
  "  } else if (schema.type === 'union') {",
  "    if (!schema.list.some((child) => child.type === 'const' && child.value === value)) {",
  "      throw new TypeError('stub schemastery: union 不接受 ' + JSON.stringify(value));",
  '    }',
  "  } else if (schema.type === 'boolean') {",
  "    if (typeof value !== 'boolean') throw new TypeError('stub schemastery: boolean expected');",
  "  } else if (schema.type === 'string') {",
  "    if (typeof value !== 'string') throw new TypeError('stub schemastery: string expected');",
  "  } else if (schema.type === 'array') {",
  "    if (!Array.isArray(value)) throw new TypeError('stub schemastery: array expected');",
  '    // 逐项按元素 schema 校验（元素不标 volatile，故不产生引用对象）。',
  '    for (const item of value) parse(schema.list[0], item);',
  '  }',
  '  return schema.meta.volatile === true ? { get: () => value } : value;',
  '}',
  '',
  'function Schema(type, options = {}) {',
  '  const schema = function (data) { return parse(schema, data === undefined ? {} : data); };',
  '  schema.type = type;',
  '  schema.meta = {};',
  '  if (options.dict !== undefined) schema.dict = options.dict;',
  '  if (options.list !== undefined) schema.list = options.list;',
  '  if (options.value !== undefined) schema.value = options.value;',
  "  Object.defineProperty(schema, 'uid', { value: nextUid++ });",
  '  schema.default = (value) => { schema.meta.default = value; return schema; };',
  '  schema.description = (text) => { schema.meta.description = text; return schema; };',
  '  schema.volatile = () => {',
  "    if (schema.meta.volatile === true) throw new TypeError('volatile schema is already wrapped');",
  '    schema.meta.volatile = true;',
  '    return schema;',
  '  };',
  '  schema.toJSON = () => { const refs = {}; const uid = collectRefs(schema, refs); return { uid, refs }; };',
  '  return schema;',
  '}',
  '',
  '// 命名空间＝可调用函数本体（真实包 module.exports = Schema；无 z/default 键）。',
  'Object.assign(Schema, {',
  "  object: (dict) => Schema('object', { dict }),",
  "  string: () => Schema('string'),",
  "  boolean: () => Schema('boolean'),",
  "  union: (list) => Schema('union', { list }),",
  "  const: (value) => Schema('const', { value }),",
  "  array: (item) => Schema('array', { list: [item] }),",
  '});',
  '',
  'module.exports = Schema;',
  '',
].join('\n');

/**
 * 把默认+可调形态的 stub SDK 写入**显式给定**的 node_modules 目录。
 *
 * 幂等：先整树 rm 再建（重复构造同一目录不留旧文件）。knob 集与 compat.test.mjs
 * 原内联 makeStubSdk 逐字一致（bundledRank/omitBundledRankExport/superpowers/
 * superpowersRank/rejectBareTools/omit）。
 *
 * @param {string} modules 目标 node_modules 绝对或相对路径。
 * @param {object} [options] 同 makeStubSdk 的 knobs。
 */
export async function buildStubSdk(modules, {
  bundledRank = 600,
  omitBundledRankExport = false,
  superpowers = 'present', // 'present' | 'absent' | 'no-const'
  superpowersRank = 550,
  rejectBareTools = false,
  omit = [],
} = {}) {
  // 病态路径守卫（Gate 3 P3-2）：本函数对目标**先 rm 再建**（幂等语义），必须在动手前
  // 拒绝可疑路径——modules 须形如 <非根>/node_modules（basename 匹配且父目录不是 `/`），
  // 否则 `buildStubSdk('/')` 一类的手误会 rm -rf /node_modules。
  const resolvedModules = resolve(String(modules));
  if (basename(resolvedModules) !== 'node_modules' || dirname(resolvedModules) === '/') {
    throw new Error(
      `拒绝在可疑路径构造 stub 树: ${resolvedModules}（modules 必须形如 <非根>/node_modules）`,
    );
  }
  // 第二道门（M1 所有权标记法）：根形态挡不住 `buildStubSdk('node_modules')` 解析到
  // `<cwd>/node_modules` 这类**形态合法但指向真实依赖树**的路径——rm 之前先判目标
  // 是不是本工具自己建的（不存在 / 带标记才放行，详见 assertStubTreeOwned 头注）。
  await assertStubTreeOwned(resolvedModules);
  await rm(resolvedModules, { recursive: true, force: true });
  // 先落所有权标记再建包：构建中途失败留下的半成品树仍带标记，下轮重建可正常
  // 通过「自己建的树」判定（幂等性不因失败中断而丧失）。
  await mkdir(resolvedModules, { recursive: true });
  await writeFile(join(resolvedModules, OWNERSHIP_MARKER), `${OWNERSHIP_MARKER_PAYLOAD}\n`);

  const pkg = async (name, main, files) => {
    if (omit.includes(name)) return;
    const dir = join(modules, ...name.split('/'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), `${JSON.stringify({ name, version: '0.0.0-stub', type: 'module', main })}\n`);
    for (const [file, source] of Object.entries(files)) {
      await mkdir(join(dir, dirname(file)), { recursive: true });
      await writeFile(join(dir, file), source);
    }
  };

  await pkg('@deepseek-ai/cordis', 'index.mjs', {
    // M8：从空壳补到「最小可用」。三条方法签名逐字对齐真实 cordis
    // （node_modules/@deepseek-ai/cordis/lib/index.js）：
    //  - `inject(deps, cb)`＝`this.plugin({inject, apply})`——缺任一服务则**永不回调**
    //    （cordis 对永不可用服务不回调，这正是 scope-host 注入看门狗依赖的语义），
    //    齐全时同步回调并以该 ctx 自身充当注入视图（`cb(ctx)`，cordis 给的是绑好
    //    服务的 fiber ctx）；返回 disposer（真实为可 await 的 fiber，stub 不模拟异步装载）。
    //  - `on(name, listener)` 登记处理器并返回取消函数（真实返回 disposer）。
    //  - `effect(fn)` 立即执行，返回其返回值（真实对「返回 disposer 的 fn」返回
    //    包装 disposer——`() => fn()` 的返回值恰是它，语义等价）。
    //
    // **traceable 服务代理（最小复刻）**：真实 cordis 的每次服务读取都经
    // `getTraceable` 返回**新的**代理，方法调用时代理把 `this` 绑回**原服务实例**
    // （所以 `ctx.tools.register(...)` 在真实宿主上拿到 `this === ToolRuntime 实例`，
    // 而脱挂调用拿到 `this === undefined`——stub 的 dsh-skill/dsh-tools 替身各有一条
    // 「必须方法形态调用」断言锁的正是这层语义）。替身以按访问生成代理复刻之：
    // 每次 `ctx.tools` 读取都得到新 Proxy，`proxy.register()` 以 `this === proxy`
    // 进入 get 捕获后转发 `Reflect.apply(fn, rawService, args)`。这一层还有第二个
    // 消费者：`@deepseek-ai/dsh-scope` 替身的 `Object.create(ctx)` 作用域继承——
    // scoped child 上的 `ctx.tools.register/restrict` 必须仍落在**同一**服务实例上
    // （否则 child 注册的层对根不可见、restrict 的 scoped 判定也拿不到 ctx）。
    'index.mjs': [
      '// 服务键白名单：三个替身包构造期自挂的服务（`ctx.tools = this` 等）。',
      'const SERVICE_KEYS = new Set(["tools", "skills", "systemPrompt"]);',
      '// 服务原值容器键（symbol）：raw 存进 this[SERVICES][key] 而非 this[key]，',
      '// 这样 Object.create 出的 scoped child ctx 沿原型链继承到**同一只**容器——',
      '// 与真实 cordis 的服务注册表（root 派生 symbol 键、沿链解析）同语义。',
      'const SERVICES = Symbol("stub-cordis-services");',
      '',
      '/**',
      ' * 按访问复刻 cordis 的 traceable 服务代理。真实 cordis 的方法调用把 this 绑回',
      ' * 原服务实例（脱挂调用则 this=undefined——dsh-skill/dsh-tools 替身的「必须方法',
      ' * 形态」断言锁的正是这层语义，**不得**用闭包包装转发，否则脱挂也能跑）；此处',
      ' * 只复刻其中一件 scoped 必需的事：把调用方 ctx 的 `__dshScopeKey` 缝到代理',
      ' * **对象**上（数据属性），`restrict` 内经 `this.__dshScopeKey`（原型链穿透到',
      ' * 代理）读出——替代真实实现 `scopeOf(this.ctx)` 对 cordis extend 元数据的解析',
      ' * （替身的 `ToolRuntime.ctx` 存根 ctx，作用域键只长在 Object.create 的 child 上）。',
      ' * 真实实现里代理同样携元数据（symbols 键），故此偏差不改变可见行为面。',
      ' */',
      'function traceable(service, callerCtx) {',
      '  const proxy = Object.create(service);',
      '  if (callerCtx !== undefined && callerCtx.__dshScopeKey !== undefined) {',
      '    Object.defineProperty(proxy, "__dshScopeKey", { value: callerCtx.__dshScopeKey });',
      '  }',
      '  return proxy;',
      '}',
      '',
      'export class Context {',
      '  constructor() {',
      '    this._listeners = new Map();',
      '    this[SERVICES] = {};',
      '  }',
      '  inject(deps, callback) {',
      '    const names = Array.isArray(deps) ? deps : Object.keys(deps ?? {});',
      '    if (names.every((name) => this[name] !== undefined)) callback?.(this);',
      '    return () => {};',
      '  }',
      '  on(name, listener) {',
      '    if (typeof listener !== "function") throw new TypeError("stub: ctx.on expects a function listener");',
      '    const hooks = this._listeners.get(name) ?? [];',
      '    hooks.push(listener);',
      '    this._listeners.set(name, hooks);',
      '    return () => {',
      '      const current = this._listeners.get(name);',
      '      if (current === undefined) return;',
      '      this._listeners.set(name, current.filter((item) => item !== listener));',
      '    };',
      '  }',
      '  effect(execute) {',
      '    return execute();',
      '  }',
      '}',
      '',
      '// 类外拦截（自身属性读写在类外拦截不到，必须挂在原型读取上）：白名单服务键的',
      '// 读取返回 traceable 代理；写入（`ctx.tools = this`）落进 SERVICES 容器。',
      'for (const key of SERVICE_KEYS) {',
      '  Object.defineProperty(Context.prototype, key, {',
      '    configurable: true,',
      '    get() {',
      '      const raw = this[SERVICES]?.[key];',
      '      return raw === undefined ? undefined : traceable(raw, this);',
      '    },',
      '    set(value) {',
      '      if (this[SERVICES] === undefined) {',
      '        Object.defineProperty(this, SERVICES, { value: {}, writable: true, configurable: true });',
      '      }',
      '      this[SERVICES][key] = value;',
      '    },',
      '  });',
      '}',
      '',
    ].join('\n'),
  });

  await pkg('@deepseek-ai/dsh-system-prompt', 'index.mjs', {
    'index.mjs': [
      'export class SystemPrompt {',
      '  constructor(ctx, config) {',
      '    if (config === undefined) throw new TypeError("stub: SystemPrompt 需要 config 对象（真实 SDK 同款要求）");',
      '    ctx.systemPrompt = this;',
      '  }',
      '  tools() {}',
      '  section() {}',
      '  getSectionOrder(name) { return name; }',
      '}',
      '',
    ].join('\n'),
  });

  await pkg('@deepseek-ai/dsh-skill', 'index.mjs', {
    'index.mjs': [
      ...(omitBundledRankExport ? [] : [`export const BUNDLED_SKILL_RANK = ${bundledRank};`]),
      'export const skillLog = [];',
      'export class SkillRegistry {',
      '  constructor(ctx, config = {}) {',
      '    ctx.skills = this;',
      '    this.providers = [];',
      '  }',
      '  registerProvider(create) {',
      '    if (!(this instanceof SkillRegistry)) {',
      '      throw new TypeError("stub: ctx.skills.registerProvider 必须以方法形态调用（cordis traceable 层脱挂调用 this=undefined）");',
      '    }',
      '    const provider = create({ signal: null, invalidate() {} });',
      '    if (typeof provider?.list !== "function" || typeof provider?.get !== "function") {',
      '      throw new TypeError("stub: provider 必须暴露 list/get");',
      '    }',
      '    this.providers.push(provider);',
      '    return () => {};',
      '  }',
      '  async list(options) {',
      '    const candidates = [];',
      '    for (const provider of this.providers) candidates.push(...(await provider.list(options)));',
      '    skillLog.push(candidates.map((candidate) => candidate.name));',
      '    return candidates;',
      '  }',
      '  async get(name, options) {',
      '    for (const provider of this.providers) {',
      '      for (const candidate of await provider.list(options)) {',
      '        if (candidate.name === name) return provider.get(candidate, options);',
      '      }',
      '    }',
      '    return undefined;',
      '  }',
      '}',
      '',
    ].join('\n'),
  });

  await pkg('@deepseek-ai/dsh-tools', 'index.mjs', {
    'index.mjs': [
      'export const registerLog = [];',
      'export const defineLog = [];',
      'export function defineTool(definition) {',
      '  defineLog.push(definition?.name);',
      '  return { ...definition, builtWith: "defineTool" };',
      '}',
      'export class ToolRuntime {',
      '  constructor(ctx, config = {}) {',
      '    ctx.tools = this;',
      '    // 该实例挂在哪个 ctx 上（scoped 判定的唯一依据，与真实实现的 scopeOf(this.ctx) 同语义）。',
      '    this.ctx = ctx;',
      '  }',
      '  register(definition) {',
      '    if (!(this instanceof ToolRuntime)) {',
      '      throw new TypeError("stub: ctx.tools.register 必须以方法形态调用（cordis traceable 层脱挂调用 this=undefined）");',
      '    }',
      '    const output = definition?.output;',
      '    if (output === undefined || typeof output !== "object" || typeof output.render !== "function") {',
      '      throw new TypeError(`tool "${definition?.name}" must declare output { schema, render, presentationMeta? }`);',
      '    }',
      ...(rejectBareTools
        ? [
            '    if (definition.builtWith !== "defineTool") {',
            '      throw new TypeError(`stub 模拟 SDK 拒绝手写定义: tool "${definition.name}"`);',
            '    }',
          ]
        : []),
      '    registerLog.push(definition.name);',
      '    return () => {};',
      '  }',
      '  // 工具可见范围（2026-10-18）依赖的两条契约，逐字复刻真宿主：',
      '  // ① restrict 只能在 agent 作用域调用（根 ctx 调用抛错）；② guard 在普通 ctx 可装、返回 disposer。',
      '  // M2a/M8 补强：scoped 半面——经 @deepseek-ai/dsh-scope 的 createScope 产出的 child ctx',
      '  // 带 `__dshScopeKey`（见下方 dsh-scope 替身），此时不再抛错而是安装一层掩码并返回',
      '  // 提升该层的 disposer（真实实现在 dsh-tools 里按 scopeOf(this.ctx) 判定，此处同语义、',
      '  // 不导入 dsh-scope 替身，靠 ctx 上的范围键做判定）。',
      '  restrict(filter) {',
      '    // traceable 代理把调用方 ctx 的作用域键携入 this（继承视图，见 cordis 替身头注）；',
      '    // 裸实例调用（测试内直接构造）退而读 this.ctx。两者都取不到 ⇒ 根 ctx 调用，抛错。',
      '    if (this.__dshScopeKey === undefined && this.ctx?.__dshScopeKey === undefined) {',
      '      throw new Error("tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent");',
      '    }',
      '    if (filter?.allow === undefined && filter?.deny === undefined) {',
      '      throw new Error("tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)");',
      '    }',
      '    this.restrictions = this.restrictions ?? [];',
      '    const layer = { allow: filter.allow, deny: filter.deny };',
      '    this.restrictions.push(layer);',
      '    return () => { this.restrictions = this.restrictions.filter((item) => item !== layer); };',
      '  }',
      '  guard(fn) {',
      '    if (typeof fn !== "function") throw new TypeError("stub: guard expects a function");',
      '    this.guards = this.guards ?? [];',
      '    this.guards.push(fn);',
      '    return () => { this.guards = this.guards.filter((item) => item !== fn); };',
      '  }',
      '}',
      '',
    ].join('\n'),
  });

  // M2a：最小 @deepseek-ai/dsh-scope 替身——真实导出面的唯一消费点是 `createScope`
  // （scripts/check-dsh-compat.mjs §7.7⑦ 正向路径：compat 在 stub 上运行时，没有它则
  // 「正向路径未验证」恒成立、scoped restrict 半面成死代码）。
  // 真实签名（node_modules/@deepseek-ai/dsh-scope/lib/index.js）：
  // `createScope(ctx, key, options)` → `{ ctx: <child>, rawDispose, dispose }`，child 带
  // 范围键（真实用 Symbol；stub 用同名字符串属性 `__dshScopeKey`），`ctx.extend` 的真实
  // 行为是 child 沿原型链继承父服务（dsh-tools 的 restrict 即经它拿到同一 ToolRuntime
  // 实例再按范围键判定），替身以 `Object.create(ctx)` 复刻这一继承语义。
  await pkg('@deepseek-ai/dsh-scope', 'index.mjs', {
    'index.mjs': [
      'export function createScope(ctx, key, options) {',
      '  const scoped = Object.create(ctx);',
      '  Object.defineProperty(scoped, "__dshScopeKey", { value: key, enumerable: true, configurable: true });',
      '  let disposed = false;',
      '  const rawDispose = () => { disposed = true; };',
      '  return {',
      '    ctx: scoped,',
      '    rawDispose,',
      '    dispose() {',
      '      if (disposed) return undefined;',
      '      rawDispose();',
      '      return undefined;',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
  });

  if (superpowers === 'present' || superpowers === 'no-const') {
    const dir = join(modules, 'superpowers-dsh');
    await mkdir(join(dir, 'lib'), { recursive: true });
    await writeFile(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: 'superpowers-dsh', version: '0.2.0-stub', type: 'module', main: 'lib/index.js' })}\n`,
    );
    await writeFile(
      join(dir, 'lib', 'index.js'),
      [
        'export const name = "superpowers-dsh";',
        'export const inject = ["skills"];',
        ...(superpowers === 'present' ? [`const PACKAGED_SKILL_RANK = ${superpowersRank};`] : []),
        'export function apply(ctx) {',
        '  ctx.skills.registerProvider(() => ({ name, list: async () => [], get: async () => undefined }));',
        '}',
        '',
      ].join('\n'),
    );
  }

  // schemastery 替身（Task 5）：index.js 装载期受控解析的对象。包形 main→.cjs 与真实
  // 包一致（`pkg` 恒写 type:'module'，.cjs 扩展名即 CJS）；替身随 `omit` 可整体缺席。
  await pkg('@deepseek-ai/schemastery', 'lib/index.cjs', {
    'lib/index.cjs': SCHEMASTERY_STUB,
  });

  return modules;
}

/**
 * mkdtemp 临时树版（测试内使用；形态与 knobs 同 {@link buildStubSdk}）。
 *
 * @returns {Promise<{base: string, modules: string, cleanup: () => Promise<void>}>}
 */
export async function makeStubSdk(options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'compat-sdk-'));
  const modules = join(base, 'node_modules');
  await buildStubSdk(modules, options);
  return { base, modules, cleanup: () => rm(base, { recursive: true, force: true }) };
}

// ─── CLI 入口（CI 用：node tests/helpers/stub-sdk.mjs <dest-base>）────

const invokedDirectly = (() => {
  if (typeof process.argv[1] !== 'string') return false;
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const base = process.argv[2];
  if (base === undefined || base === '') {
    console.error('用法: node tests/helpers/stub-sdk.mjs <dest-base>  （在 <dest-base>/node_modules 建默认形态 stub SDK 树）');
    process.exit(1);
  }
  buildStubSdk(join(resolve(base), 'node_modules'))
    .then((modules) => {
      console.log(modules);
    })
    .catch((error) => {
      console.error(`stub-sdk: 构造失败: ${error?.stack ?? error}`);
      process.exit(1);
    });
}
