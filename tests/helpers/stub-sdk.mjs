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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  await rm(modules, { recursive: true, force: true });

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
    'index.mjs': 'export class Context {\n  constructor() {}\n}\n',
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
      '  restrict() {',
      '    throw new Error("tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent");',
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
