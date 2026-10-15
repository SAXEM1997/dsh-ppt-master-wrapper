import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { PLUGIN_ENTRY, resolveDshModules, runCompatCheck } from '../scripts/check-dsh-compat.mjs';
import { SKILL_RANK } from '../lib/skill-provider.js';

/**
 * Task 9 契约：check-dsh-compat.mjs（五级定位 + SDK 契约 + rank 漂移检出）。
 *
 * 覆盖面——
 * - resolveDshModules 有序五级（explicit > DSH_NODE_MODULES > DSH_PROFILE_DIR >
 *   DSH_HOME/profiles/$DSH_PROFILE > DSH_HOME/profiles）逐级断言；命中即用（前级
 *   命中不再探测后级、不报多候选）；第五级不存在时回落无序扫描
 *   $DSH_HOME/profiles/<star>/node_modules（>1 → throw 列候选；恰 1 → 用之；
 *   0 → 全失败 throw）；env 无 DSH_HOME（且无前级命中）→ throw。
 * - runCompatCheck 主流程经注入 stub SDK（临时 .mjs 文件：fake
 *   SkillRegistry/ToolRuntime/BUNDLED_SKILL_RANK=600 等）驱动全分支：基线全绿、
 *   rank 相对关系失败、漂移（注入期望 rank=550 + stub superpowers-dsh 常量 600 →
 *   告警且非零退出）、superpowers-dsh 读不到 → warning 降级、register 拒绝手写
 *   定义 → §3.5 defineTool 回退。
 * - 挂载入口 = 本插件根 index.js（显式断言路径含 /index.js 且非 lib/index.js）；
 *   驱动经 apply(ctx, { skillRoots: [fixture] }) 注入通道（T14 前 skills/ 不存在）。
 * - stub 的 registerProvider/register 断言方法形态调用（cordis traceable 层脱挂
 *   调用 this=undefined——真实 SDK 实测契约，防 index.js 提取式调用回归）。
 * - CLI：--dsh-modules/--skill-roots（逗号多根）、定位失败 exit 1、漂移 exit 1。
 *
 * Task 5 追加面（本文件为**回归面**，一律按测试名定位）：
 * - 插件入口装载期需宿主 `@deepseek-ai/schemastery`（index.js 受控解析）——stub 树
 *   内新增 schemastery 替身包（`SCHEMASTERY_STUB`，包形 `main→.cjs`，替身 4 层保真），
 *   三个 stub CLI 例向其子进程注入 `DSH_NODE_MODULES=<stub 树>/node_modules`
 *   （`resolveDshModules` 定位链第②级已支持）；两例保真例**保持 `{env:{}}` 不注入**
 *   （`CLI: 无 --dsh-modules 且 env 无定位线索 → exit 1 报无法定位` 断言取
 *   `error.stdout`；`CLI: 未知参数 → exit 1 usage 提示` 的装载期语义见 Task 5 报告）。
 * - 新增「可解析/不可解析」两态子进程观测量（Env 清空 + 仍传 `--dsh-modules` →
 *   装载期 fail-loud 命中 `@deepseek-ai/schemastery` 且非零退出）——fail-loud 语义的
 *   唯一可观测面（spec §6.1⓪）。
 */


const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const skillsFixtureRoot = join(fixturesDir, 'skills-fixture');
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-dsh-compat.mjs');
const execFileAsync = promisify(execFile);

const someProblem = (result, pattern) => result.problems.some((entry) => pattern.test(entry));
const someWarning = (result, pattern) => result.warnings.some((entry) => pattern.test(entry));

/** 造一个临时目录树骨架。 */
async function makeTree(prefix) {
  const base = await mkdtemp(join(tmpdir(), prefix));
  return { base, cleanup: () => rm(base, { recursive: true, force: true }) };
}

/**
 * T3 skills-fixture 的正例子集（剔除 broken——完整根含 broken/ 会触发 provider
 * fail-loud，不适合作 compat 全绿基线）：只拷贝 alpha 的临时树。
 */
async function makePositiveFixture() {
  const tree = await makeTree('compat-alpha-');
  const root = join(tree.base, 'skills');
  await cp(join(skillsFixtureRoot, 'alpha'), join(root, 'alpha'), { recursive: true });
  return { ...tree, root };
}

// ─── resolveDshModules：有序五级逐级断言 ─────────────────────────

test('resolveDshModules: ① explicit 参数命中 → via explicit（env 其余各级也存在仍让位）', async () => {
  const tree = await makeTree('compat-l1-');
  try {
    const explicit = join(tree.base, 'explicit-nm');
    const level2 = join(tree.base, 'env-nm');
    const profileDir = join(tree.base, 'profile');
    const home = join(tree.base, 'home');
    for (const dir of [explicit, level2, join(profileDir, 'node_modules'), join(home, 'profiles', 'web', 'node_modules'), join(home, 'profiles', 'node_modules')]) {
      await mkdir(dir, { recursive: true });
    }
    const resolved = resolveDshModules(explicit, {
      DSH_NODE_MODULES: level2,
      DSH_PROFILE_DIR: profileDir,
      DSH_HOME: home,
      DSH_PROFILE: 'web',
    });
    assert.equal(resolved.path, explicit);
    assert.equal(resolved.via, 'explicit');
  } finally {
    await tree.cleanup();
  }
});

test('resolveDshModules: ② DSH_NODE_MODULES 命中 → via DSH_NODE_MODULES（③④⑤存在仍让位，不报多候选）', async () => {
  const tree = await makeTree('compat-l2-');
  try {
    const level2 = join(tree.base, 'env-nm');
    const profileDir = join(tree.base, 'profile');
    const home = join(tree.base, 'home');
    for (const dir of [level2, join(profileDir, 'node_modules'), join(home, 'profiles', 'web', 'node_modules'), join(home, 'profiles', 'node_modules')]) {
      await mkdir(dir, { recursive: true });
    }
    const resolved = resolveDshModules(undefined, {
      DSH_NODE_MODULES: level2,
      DSH_PROFILE_DIR: profileDir,
      DSH_HOME: home,
      DSH_PROFILE: 'web',
    });
    assert.equal(resolved.path, level2);
    assert.equal(resolved.via, 'DSH_NODE_MODULES');
  } finally {
    await tree.cleanup();
  }
});

test('resolveDshModules: ② 空串或不存在 → 探测后级（env 空值视为未设置）', async () => {
  const tree = await makeTree('compat-l2miss-');
  try {
    const profileDir = join(tree.base, 'profile');
    await mkdir(join(profileDir, 'node_modules'), { recursive: true });
    for (const emptyish of ['', join(tree.base, 'no-such')]) {
      const resolved = resolveDshModules(undefined, {
        DSH_NODE_MODULES: emptyish,
        DSH_PROFILE_DIR: profileDir,
      });
      assert.equal(resolved.via, 'DSH_PROFILE_DIR', `DSH_NODE_MODULES=${JSON.stringify(emptyish)} 不构成命中`);
    }
  } finally {
    await tree.cleanup();
  }
});

test('resolveDshModules: ③ DSH_PROFILE_DIR/node_modules 命中 → via DSH_PROFILE_DIR', async () => {
  const tree = await makeTree('compat-l3-');
  try {
    const profileDir = join(tree.base, 'profile');
    await mkdir(join(profileDir, 'node_modules'), { recursive: true });
    const resolved = resolveDshModules(undefined, { DSH_PROFILE_DIR: profileDir });
    assert.equal(resolved.path, join(profileDir, 'node_modules'));
    assert.equal(resolved.via, 'DSH_PROFILE_DIR');
  } finally {
    await tree.cleanup();
  }
});

test('resolveDshModules: ④ DSH_HOME/profiles/$DSH_PROFILE/node_modules 命中 → via DSH_HOME/DSH_PROFILE', async () => {
  const tree = await makeTree('compat-l4-');
  try {
    const home = join(tree.base, 'home');
    await mkdir(join(home, 'profiles', 'web', 'node_modules'), { recursive: true });
    const resolved = resolveDshModules(undefined, { DSH_HOME: home, DSH_PROFILE: 'web' });
    assert.equal(resolved.path, join(home, 'profiles', 'web', 'node_modules'));
    assert.equal(resolved.via, 'DSH_HOME/DSH_PROFILE');
  } finally {
    await tree.cleanup();
  }
});

test('resolveDshModules: ④ DSH_PROFILE 缺失时该级跳过（不拼出 undefined 段）', async () => {
  const tree = await makeTree('compat-l4miss-');
  try {
    const home = join(tree.base, 'home');
    await mkdir(join(home, 'profiles', 'web', 'node_modules'), { recursive: true });
    await mkdir(join(home, 'profiles', 'node_modules'), { recursive: true });
    const resolved = resolveDshModules(undefined, { DSH_HOME: home });
    assert.equal(resolved.via, 'DSH_HOME/profiles', '无 DSH_PROFILE → 第④级不可构成，第⑤级命中');
  } finally {
    await tree.cleanup();
  }
});

test('resolveDshModules: ⑤ DSH_HOME/profiles/node_modules 命中 → via DSH_HOME/profiles（不再进入扫描）', async () => {
  const tree = await makeTree('compat-l5-');
  try {
    const home = join(tree.base, 'home');
    await mkdir(join(home, 'profiles', 'node_modules'), { recursive: true });
    // 一个孤立 profile 也存在——第五级命中即用，轮不到无序扫描报多候选
    await mkdir(join(home, 'profiles', 'p1', 'node_modules'), { recursive: true });
    const resolved = resolveDshModules(undefined, { DSH_HOME: home });
    assert.equal(resolved.path, join(home, 'profiles', 'node_modules'));
    assert.equal(resolved.via, 'DSH_HOME/profiles');
  } finally {
    await tree.cleanup();
  }
});

test('resolveDshModules: 有序命中即用——③④⑤同时存在时第③级胜出（优先级即消歧，不报多候选）', async () => {
  const tree = await makeTree('compat-order-');
  try {
    const profileDir = join(tree.base, 'profile');
    const home = join(tree.base, 'home');
    for (const dir of [join(profileDir, 'node_modules'), join(home, 'profiles', 'web', 'node_modules'), join(home, 'profiles', 'node_modules')]) {
      await mkdir(dir, { recursive: true });
    }
    const resolved = resolveDshModules(undefined, {
      DSH_PROFILE_DIR: profileDir,
      DSH_HOME: home,
      DSH_PROFILE: 'web',
    });
    assert.equal(resolved.via, 'DSH_PROFILE_DIR');
    assert.equal(resolved.path, join(profileDir, 'node_modules'));
  } finally {
    await tree.cleanup();
  }
});

// ─── resolveDshModules：无序扫描（第五级失败后唯一回落入口）──────

test('resolveDshModules: 无序扫描 >1 命中 → throw 列出全部候选要求显式指定', async () => {
  const tree = await makeTree('compat-scan-multi-');
  try {
    const home = join(tree.base, 'home');
    const first = join(home, 'profiles', 'p1', 'node_modules');
    const second = join(home, 'profiles', 'p2', 'node_modules');
    for (const dir of [first, second]) await mkdir(dir, { recursive: true });
    assert.throws(
      () => resolveDshModules(undefined, { DSH_HOME: home }),
      (error) => {
        assert.match(error.message, /多个|候选/);
        assert.ok(error.message.includes(first), '候选列表含 p1');
        assert.ok(error.message.includes(second), '候选列表含 p2');
        assert.match(error.message, /--dsh-modules|显式/);
        return true;
      },
    );
  } finally {
    await tree.cleanup();
  }
});

test('resolveDshModules: 无序扫描恰 1 命中 → 用之（via scan）', async () => {
  const tree = await makeTree('compat-scan-one-');
  try {
    const home = join(tree.base, 'home');
    const only = join(home, 'profiles', 'only-one', 'node_modules');
    await mkdir(only, { recursive: true });
    const resolved = resolveDshModules(undefined, { DSH_HOME: home });
    assert.equal(resolved.path, only);
    assert.equal(resolved.via, 'scan');
  } finally {
    await tree.cleanup();
  }
});

test('resolveDshModules: 五级全失败且扫描 0 命中 → throw（全失败报错）', async () => {
  const tree = await makeTree('compat-scan-zero-');
  try {
    const home = join(tree.base, 'home');
    await mkdir(join(home, 'profiles', 'empty-profile'), { recursive: true });
    assert.throws(() => resolveDshModules(undefined, { DSH_HOME: home }), /无法定位/);
  } finally {
    await tree.cleanup();
  }
});

test('resolveDshModules: env 无 DSH_HOME（且无前级命中）→ throw 指明缺 DSH_HOME', () => {
  assert.throws(() => resolveDshModules(undefined, {}), /DSH_HOME/);
});

test('resolveDshModules: env 无 DSH_HOME 但 explicit 命中 → 正常返回（前级命中无需 DSH_HOME）', async () => {
  const tree = await makeTree('compat-nohome-');
  try {
    const explicit = join(tree.base, 'nm');
    await mkdir(explicit, { recursive: true });
    const resolved = resolveDshModules(explicit, {});
    assert.equal(resolved.via, 'explicit');
  } finally {
    await tree.cleanup();
  }
});

// ─── 挂载入口断言：插件根 index.js，非参考实现的 lib/index.js ────

test('挂载入口 = 本插件根 index.js（路径含 /index.js、非 lib/index.js、真实存在）', () => {
  assert.ok(PLUGIN_ENTRY.endsWith('/index.js'), `入口以 /index.js 结尾: ${PLUGIN_ENTRY}`);
  assert.ok(!PLUGIN_ENTRY.includes('lib/index.js'), '不得挂载参考实现的 lib/index.js');
  // 期望入口自 scriptPath 推导（脚本目录的父目录 = 仓库根），零硬编码——任意
  // checkout 路径下同判（文件头的机器无关性声明）。
  const expectedEntry = join(dirname(dirname(scriptPath)), 'index.js');
  assert.equal(PLUGIN_ENTRY, expectedEntry, `入口必须位于本插件包根: ${PLUGIN_ENTRY} ≠ ${expectedEntry}`);
});

// ─── stub SDK 构造器 ─────────────────────────────────────────────

/**
 * `@deepseek-ai/schemastery` 替身源码（Task 5；替身 4 层保真，plan Task 5 Consumes）。
 *
 * 真实包本机实测形态：`type:'module'` + `main:'lib/index.cjs'`（故替身一律 `main→.cjs`；
 * 现有 stub 多为包根 `main:'index.mjs'`、superpowers-dsh stub 为 `lib/index.js`，
 * 两形态均非替身所需）；CJS 命名空间**可调用**（`module.exports = Schema`）且含
 * `object/string/boolean/union/const`，无 `z`/`default` 键；`.default()/.description()/
 * .volatile()` 链式；`.volatile()` 二次标注抛 `TypeError("volatile schema is already
 * wrapped")`；按 schema 校验（`schema({})`）产出的 volatile 叶为带 `.get()` 的引用对象；
 * `toJSON()` 返回 `{uid, refs}` 引用图（顶层无 dict，叶在 `refs` 内）。
 *
 * 只复刻本仓库消费面（index.js 的 Config 声明 + volatile 叶计数），不做完整校验语义。
 */
const SCHEMASTERY_STUB = [
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
  '});',
  '',
  'module.exports = Schema;',
  '',
].join('\n');

/**
 * 造一套注入用 stub SDK（tmp node_modules：cordis/dsh-system-prompt/dsh-skill/
 * dsh-tools + schemastery 替身 + 可选 superpowers-dsh）。各 stub 忠实复刻真实契约中
 * compat 依赖的形态：服务自挂 ctx、方法形态 this 绑定（cordis traceable 层脱挂调用
 * this=undefined——真实 SDK 实测）、SystemPrompt 需 config、ToolRuntime.register 校验
 * output { schema, render }、可选模拟「拒绝手写定义」以驱动 §3.5 回退分支。
 *
 * @returns {Promise<{base: string, modules: string, cleanup: () => Promise<void>}>}
 */
async function makeStubSdk({
  bundledRank = 600,
  omitBundledRankExport = false,
  superpowers = 'present', // 'present' | 'absent' | 'no-const'
  superpowersRank = 550,
  rejectBareTools = false,
  omit = [],
} = {}) {
  const tree = await makeTree('compat-sdk-');
  const modules = join(tree.base, 'node_modules');

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

  return { base: tree.base, modules, cleanup: tree.cleanup };
}

/**
 * CLI 子进程「装载期可解析」env：`DSH_NODE_MODULES` 指向 stub 树的 node_modules
 * （`resolveDshModules` 第②级；插件侧受控解析的 env 四级亦以本级为首）。
 *
 * 只服务 **index.js 装载期**的 schemastery 受控解析（该期插件无 explicit 参数可用），
 * 故三个已传 `--dsh-modules` 的 stub CLI 例仍须注入；`--dsh-modules` 只服务 CLI 期的
 * SDK 定位——两消费点各自独立，注入 env 不改变 stub 语义。前置断言替身确在树内，
 * 防「本机侥幸绿」（不得改写为指向真实 node_modules 或按 realpath 推导）。
 */
function stubLoadEnv(sdk) {
  const manifest = join(sdk.modules, '@deepseek-ai', 'schemastery', 'package.json');
  assert.ok(existsSync(manifest), `stub 树须含 schemastery 替身（装载期受控解析面）: ${manifest}`);
  return { DSH_NODE_MODULES: sdk.modules };
}

/** 读回 stub 模块的模块级日志（与脚本动态 import 同一 URL → 同一模块实例）。 */
const stubModule = (modules, name, main = 'index.mjs') =>
  import(pathToFileURL(join(modules, ...name.split('/'), main)).href);

// ─── schemastery 替身保真（Task 5：替身自身的契约测试）────────────
//
// 替身是 Task 10①「Config volatile 声明存在」的**判定实现**：若替身不保真（例如把
// 所有叶都标 volatile、或 toJSON 不产引用图），该断言会自我印证。故在此按真实包本机
// 实测形态锁定替身 ②③④ 三层（层① 包形由 `pkg(main→.cjs)` 构造面保证）。

test('stub schemastery 替身: 可调用 CJS 命名空间 + toJSON 引用图（volatile 恰 3 + 含非 volatile 叶）+ 二次 volatile 抛错 + 校验产 `.get()` 引用', async () => {
  const sdk = await makeStubSdk();
  try {
    const ns = await stubModule(sdk.modules, '@deepseek-ai/schemastery', 'lib/index.cjs');
    const z = ns.default;
    assert.equal(typeof z, 'function', '真实包 module.exports = Schema（可调用命名空间）');
    assert.equal('z' in z, false, '真实命名空间无 z 键（实测）');
    for (const key of ['object', 'string', 'boolean', 'union', 'const']) {
      assert.equal(typeof z[key], 'function', `命名空间须含 ${key}`);
    }

    // 与 index.js Config 同形：三叶子 volatile（含 union+const 枚举），另含非 volatile 叶。
    const schema = z.object({
      venv: z.object({
        enabled: z.boolean().default(false).description('enabled').volatile(),
        path: z.string().default('~/.ppt-master/venv').description('path').volatile(),
        oldPathPolicy: z
          .union([z.const('keep'), z.const('delete')])
          .default('keep')
          .description('policy')
          .volatile(),
      }).description('venv'),
    }).description('root');

    // 层④：按 schema 校验（schema({})）产出的 volatile 叶为带 .get() 的引用对象
    const parsed = schema({});
    assert.equal(typeof parsed.venv.enabled, 'object', 'volatile 叶为引用对象');
    assert.equal(parsed.venv.enabled.get(), false);
    assert.equal(parsed.venv.path.get(), '~/.ppt-master/venv');
    assert.equal(parsed.venv.oldPathPolicy.get(), 'keep', 'union+const 枚举经默认值校验');

    // 层③：toJSON() 返回 {uid, refs} 引用图；顶层无 dict；volatile 叶恰 3 且各带 meta.volatile
    const json = schema.toJSON();
    assert.deepEqual(Object.keys(json).sort(), ['refs', 'uid'], '顶层只有 {uid, refs}');
    assert.equal(json.refs[json.uid].dict !== undefined, true, '叶在 refs 内（顶层无属性对象）');
    const refs = Object.values(json.refs);
    const volatileRefs = refs.filter((node) => node.meta?.volatile === true);
    assert.equal(volatileRefs.length, 3, 'volatile 叶恰 3（三字段；多于 3 = 替身失真）');
    assert.ok(
      refs.some((node) => node.meta?.volatile !== true),
      '须另含 ≥1 非 volatile 叶（否则 volatile 检查自我印证）',
    );
    assert.deepEqual(
      volatileRefs.map((node) => node.meta.description).sort(),
      ['enabled', 'path', 'policy'],
      'volatile 叶即三字段本身',
    );

    // 层②/④：二次 .volatile() 抛 TypeError（真实实测文案）
    assert.throws(
      () => z.boolean().default(false).volatile().volatile(),
      (error) => {
        assert.equal(error.constructor, TypeError);
        assert.match(error.message, /volatile schema is already wrapped/);
        return true;
      },
    );
  } finally {
    await sdk.cleanup();
  }
});

// ─── runCompatCheck：stub SDK 驱动主流程全分支 ───────────────────

test('runCompatCheck 基线: stub SDK 全绿——三真实工具过 register、provider 读回、rank 关系、无漂移', async () => {
  const [sdk, fixture] = await Promise.all([makeStubSdk(), makePositiveFixture()]);
  try {
    const result = await runCompatCheck({
      dshModules: sdk.modules,
      skillRoots: [fixture.root],
      env: {},
    });
    assert.deepEqual(result.problems, [], `基线不得有问题项: ${result.problems.join(' | ')}`);
    assert.deepEqual(result.warnings, [], `基线不得有警告项: ${result.warnings.join(' | ')}`);
    assert.equal(result.resolved.via, 'explicit');
    assert.equal(result.entry, PLUGIN_ENTRY);

    // createTools() 真实三工具产物确实经过了（stub）ToolRuntime.register
    const toolsStub = await stubModule(sdk.modules, '@deepseek-ai/dsh-tools');
    for (const toolName of ['ppt_master_info', 'ppt_master_check_env', 'ppt_master_setup_deps']) {
      assert.ok(
        toolsStub.registerLog.includes(toolName),
        `${toolName} 须经 register（实际: ${toolsStub.registerLog.join(',')}）`,
      );
    }
    // provider 经（stub）SkillRegistry 挂载并读回 fixture 的 alpha
    const skillStub = await stubModule(sdk.modules, '@deepseek-ai/dsh-skill');
    assert.ok(
      skillStub.skillLog.some((names) => names.includes('alpha')),
      `registry list() 读回须含注入根的 alpha（实际: ${JSON.stringify(skillStub.skillLog)}）`,
    );
  } finally {
    await Promise.all([sdk.cleanup(), fixture.cleanup()]);
  }
});

test('runCompatCheck 基线: 方法形态绑定——stub 拒绝脱挂调用，index.js 须以方法形态驱动 registerProvider/register', async () => {
  // stub 的 registerProvider/register 在 this 非实例时 throw（复刻 cordis traceable
  // 层契约：提取成变量再调用 → this=undefined → TypeError）。当前 index.js 若以提取
  // 式调用驱动，apply 即抛 → problems 非空；方法形态则全绿。本用例即该回归的守卫。
  const [sdk, fixture] = await Promise.all([makeStubSdk(), makePositiveFixture()]);
  try {
    const result = await runCompatCheck({
      dshModules: sdk.modules,
      skillRoots: [fixture.root],
      env: {},
    });
    assert.deepEqual(result.problems, [], `方法形态调用须全绿: ${result.problems.join(' | ')}`);
  } finally {
    await Promise.all([sdk.cleanup(), fixture.cleanup()]);
  }
});

test('runCompatCheck: 注入通道——skillRoots 指向 fixture 正例子集（无 broken），经 apply(ctx,{skillRoots}) 驱动', async () => {
  const [sdk, fixture] = await makeStubSdk().then(async (sdk_) => [sdk_, await makePositiveFixture()]);
  try {
    const result = await runCompatCheck({
      dshModules: sdk.modules,
      skillRoots: [fixture.root],
      env: {},
    });
    assert.deepEqual(result.problems, []);
    assert.ok(result.notes.some((note) => /alpha/.test(note)), 'notes 记录读回的 skill 名（证明注入根生效）');
  } finally {
    await Promise.all([sdk.cleanup(), fixture.cleanup()]);
  }
});

test('runCompatCheck: rank 相对关系失败——stub BUNDLED_SKILL_RANK=500 < 本插件 550 → problems', async () => {
  const [sdk, fixture] = await Promise.all([
    makeStubSdk({ bundledRank: 500, superpowersRank: 550 }),
    makePositiveFixture(),
  ]);
  try {
    const result = await runCompatCheck({
      dshModules: sdk.modules,
      skillRoots: [fixture.root],
      env: {},
    });
    assert.equal(someProblem(result, /rank|BUNDLED/), true, '相对关系失败必须落入 problems');
    assert.ok(result.problems.length > 0, 'problems 非空 → CLI 非零退出');
  } finally {
    await Promise.all([sdk.cleanup(), fixture.cleanup()]);
  }
});

test('runCompatCheck: SDK 未导出数字型 BUNDLED_SKILL_RANK → problems（fail-loud）', async () => {
  const [sdk, fixture] = await Promise.all([
    makeStubSdk({ omitBundledRankExport: true }),
    makePositiveFixture(),
  ]);
  try {
    const result = await runCompatCheck({
      dshModules: sdk.modules,
      skillRoots: [fixture.root],
      env: {},
    });
    assert.equal(someProblem(result, /BUNDLED_SKILL_RANK/), true);
  } finally {
    await Promise.all([sdk.cleanup(), fixture.cleanup()]);
  }
});

test('runCompatCheck 漂移: 注入期望 rank=550 + stub superpowers-dsh 常量 600 → 告警且非零退出', async () => {
  assert.equal(SKILL_RANK, 550, '本插件 SKILL_RANK 当前为 550（漂移语义锚点）');
  const [sdk, fixture] = await Promise.all([
    makeStubSdk({ superpowersRank: 600 }),
    makePositiveFixture(),
  ]);
  try {
    const result = await runCompatCheck({
      dshModules: sdk.modules,
      skillRoots: [fixture.root],
      env: {},
      expectedRank: 550, // 注入期望常量（deps 模式）
    });
    assert.equal(someProblem(result, /漂移|superpowers-dsh/), true, '漂移必须落入 problems（非零退出）');
    assert.equal(someProblem(result, /600/), true, '问题项指明实际常量 600');
    assert.equal(someProblem(result, /550/), true, '问题项指明期望 550');
  } finally {
    await Promise.all([sdk.cleanup(), fixture.cleanup()]);
  }
});

test('runCompatCheck 漂移: 期望 600 与 stub 常量 600 一致 → 无漂移项', async () => {
  const [sdk, fixture] = await Promise.all([
    makeStubSdk({ superpowersRank: 600 }),
    makePositiveFixture(),
  ]);
  try {
    const result = await runCompatCheck({
      dshModules: sdk.modules,
      skillRoots: [fixture.root],
      env: {},
      expectedRank: 600,
    });
    assert.equal(someProblem(result, /漂移/), false, '一致时不得报漂移');
    // rank 相对关系仍按真实 SKILL_RANK 语义？——不：expectedRank 同时驱动两项，
    // 600<600 不成立 → rank 关系项应在。此处只断言无漂移。
  } finally {
    await Promise.all([sdk.cleanup(), fixture.cleanup()]);
  }
});

test('runCompatCheck: superpowers-dsh 包缺失 → warning 降级该项，不判失败', async () => {
  const [sdk, fixture] = await Promise.all([
    makeStubSdk({ superpowers: 'absent' }),
    makePositiveFixture(),
  ]);
  try {
    const result = await runCompatCheck({
      dshModules: sdk.modules,
      skillRoots: [fixture.root],
      env: {},
    });
    assert.deepEqual(result.problems, [], '读不到 superpowers-dsh 不判失败（跟随策略观测项）');
    assert.equal(someWarning(result, /superpowers-dsh/), true, '降级记入 warnings');
  } finally {
    await Promise.all([sdk.cleanup(), fixture.cleanup()]);
  }
});

test('runCompatCheck: superpowers-dsh 存在但常量不可解析 → warning 降级', async () => {
  const [sdk, fixture] = await Promise.all([
    makeStubSdk({ superpowers: 'no-const' }),
    makePositiveFixture(),
  ]);
  try {
    const result = await runCompatCheck({
      dshModules: sdk.modules,
      skillRoots: [fixture.root],
      env: {},
    });
    assert.deepEqual(result.problems, []);
    assert.equal(someWarning(result, /PACKAGED_SKILL_RANK|superpowers-dsh/), true);
  } finally {
    await Promise.all([sdk.cleanup(), fixture.cleanup()]);
  }
});

test('runCompatCheck: register 拒绝手写定义 → §3.5 回退 defineTool 重验并报告（problems 非空）', async () => {
  const [sdk, fixture] = await Promise.all([
    makeStubSdk({ rejectBareTools: true }),
    makePositiveFixture(),
  ]);
  try {
    const result = await runCompatCheck({
      dshModules: sdk.modules,
      skillRoots: [fixture.root],
      env: {},
    });
    assert.equal(someProblem(result, /register|拒绝/), true, '拒绝必须落入 problems（当前插件形态对该 SDK 不兼容）');
    assert.equal(someProblem(result, /defineTool/), true, '报告 §3.5 回退验证结果');
    assert.equal(someProblem(result, /peerDependency/), true, '报告须指出 peerDependency 补救');
    const toolsStub = await stubModule(sdk.modules, '@deepseek-ai/dsh-tools');
    assert.equal(toolsStub.defineLog.length > 0, true, '回退确实以 defineTool 重建了定义');
  } finally {
    await Promise.all([sdk.cleanup(), fixture.cleanup()]);
  }
});

test('runCompatCheck: SDK 包缺失（stub 不含 dsh-skill）→ problems 指名该包', async () => {
  const [sdk, fixture] = await Promise.all([
    makeStubSdk({ omit: ['@deepseek-ai/dsh-skill'] }),
    makePositiveFixture(),
  ]);
  try {
    const result = await runCompatCheck({
      dshModules: sdk.modules,
      skillRoots: [fixture.root],
      env: {},
    });
    assert.equal(someProblem(result, /dsh-skill/), true);
  } finally {
    await Promise.all([sdk.cleanup(), fixture.cleanup()]);
  }
});

test('runCompatCheck: provider fail-loud 透传——注入含 broken 的根 → problems 不静默', async () => {
  const tree = await makeTree('compat-broken-');
  const sdk = await makeStubSdk();
  try {
    const root = join(tree.base, 'skills');
    await cp(join(skillsFixtureRoot, 'broken'), join(root, 'broken'), { recursive: true });
    const result = await runCompatCheck({
      dshModules: sdk.modules,
      skillRoots: [root],
      env: {},
    });
    assert.equal(result.problems.length > 0, true, 'provider fail-loud 必须转为 problems');
    assert.equal(someProblem(result, /broken|description/), true);
  } finally {
    await Promise.all([tree.cleanup(), sdk.cleanup()]);
  }
});

// ─── CLI ─────────────────────────────────────────────────────────

test('CLI: --dsh-modules stub --skill-roots fixture → exit 0 且输出 OK', async () => {
  const [sdk, fixture] = await Promise.all([makeStubSdk(), makePositiveFixture()]);
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [scriptPath, '--dsh-modules', sdk.modules, '--skill-roots', fixture.root],
      { env: stubLoadEnv(sdk) },
    );
    assert.match(stdout, /OK/);
    assert.match(stdout, /alpha/);
  } finally {
    await Promise.all([sdk.cleanup(), fixture.cleanup()]);
  }
});

test('CLI: 漂移（stub superpowers-dsh 常量 600，期望默认 550）→ exit 1 且列漂移', async () => {
  const [sdk, fixture] = await Promise.all([
    makeStubSdk({ superpowersRank: 600 }),
    makePositiveFixture(),
  ]);
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [scriptPath, '--dsh-modules', sdk.modules, '--skill-roots', fixture.root],
        { env: stubLoadEnv(sdk) },
      ),
      (error) => {
        assert.equal(error.code, 1, '漂移 → 非零退出');
        assert.match(error.stdout, /漂移/);
        return true;
      },
    );
  } finally {
    await Promise.all([sdk.cleanup(), fixture.cleanup()]);
  }
});

test('CLI: 无 --dsh-modules 且 env 无定位线索 → exit 1 报无法定位', async () => {
  const fixture = await makePositiveFixture();
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath, '--skill-roots', fixture.root], { env: {} }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stdout, /无法定位|DSH_HOME/);
        return true;
      },
    );
  } finally {
    await fixture.cleanup();
  }
});

test('CLI: --skill-roots 逗号多根 → 两根的 skill 均读回', async () => {
  const [sdk, fixture] = await Promise.all([makeStubSdk(), makePositiveFixture()]);
  const tree = await makeTree('compat-second-');
  try {
    const secondRoot = join(tree.base, 'more-skills');
    await mkdir(join(secondRoot, 'second-skill'), { recursive: true });
    await writeFile(
      join(secondRoot, 'second-skill', 'SKILL.md'),
      '---\nname: second-skill\ndescription: second root skill\n---\n\nbody\n',
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        scriptPath,
        '--dsh-modules', sdk.modules,
        '--skill-roots', `${fixture.root},${secondRoot}`,
      ],
      { env: stubLoadEnv(sdk) },
    );
    assert.match(stdout, /OK/);
    assert.match(stdout, /alpha/);
    assert.match(stdout, /second-skill/);
  } finally {
    await Promise.all([sdk.cleanup(), fixture.cleanup(), tree.cleanup()]);
  }
});

test('CLI: 未知参数 → exit 1 usage 提示', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, '--bogus'], { env: {} }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout + error.stderr, /用法|unknown|未知/);
      return true;
    },
  );
});

test('T5⑧: schemastery 两态——可解析（注入 stub env）→ 装载成功；不可解析（env 清空 + --dsh-modules）→ fail-loud 命中包名且非零退出', async () => {
  const [sdk, fixture] = await Promise.all([makeStubSdk(), makePositiveFixture()]);
  try {
    const argv = [scriptPath, '--dsh-modules', sdk.modules, '--skill-roots', fixture.root];

    // 可解析态：DSH_NODE_MODULES=<stub 树>/node_modules（含 schemastery 替身）→ 装载成功
    const { stdout } = await execFileAsync(process.execPath, argv, { env: stubLoadEnv(sdk) });
    assert.match(stdout, /OK/, '可解析态：插件入口装载成功且契约全绿');

    // 不可解析态：清空 DSH_*（env:{}）＋仍传 --dsh-modules（越过 CLI 定位级，否则先以
    // 「无法定位」退出）→ 装载期 fail-loud。唯一正向标记＝错误消息含包名。
    await assert.rejects(
      execFileAsync(process.execPath, argv, { env: {} }),
      (error) => {
        assert.notEqual(error.code, 0, '装载期 fail-loud → 非零退出');
        assert.match(
          `${error.stdout ?? ''}${error.stderr ?? ''}`,
          /@deepseek-ai\/schemastery/,
          'fail-loud 必须点名不可解析的宿主包（唯一正向标记）',
        );
        return true;
      },
    );
  } finally {
    await Promise.all([sdk.cleanup(), fixture.cleanup()]);
  }
});
