import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { name, inject, apply } from '../index.js';
import { createTools } from '../lib/tools.js';

/**
 * Task 4 契约：插件入口装配与能力探测降级。
 *
 * `apply(ctx, opts)` 三分支——
 * ① `ctx.skills.registerProvider` 缺失 → throw（provider 是硬依赖）；
 * ② `ctx.tools.register` 为函数 → 注册 3 工具（**逐个** `register(tool)`，3 次调用）；
 * ③ `ctx.tools` 缺失或 `.register` 非函数 → 降级：仅注册 provider + 单行 `console.warn`。
 *
 * 扫描根注入通道：`apply(ctx, { skillRoots: [root] })` 透传 `createSkillProvider(roots)`，
 * 使 T14 之前真实 `skills/` 尚不存在时仍可驱动整条链路。
 */

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'skills-fixture');

/** 记录注册调用的 mock ctx；`skills` 缺省存在，`tools` 由参数决定是否携带。 */
function makeCtx({ skills = true, tools = true } = {}) {
  const calls = { providers: [], tools: [] };
  const ctx = {};
  if (skills) ctx.skills = { registerProvider: (factory) => calls.providers.push(factory) };
  if (tools) ctx.tools = { register: (tool) => calls.tools.push(tool) };
  return { ctx, calls };
}

/** 捕获 `console.warn` 的降级日志，逐字断言后原样还原。 */
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

/** 复制 fixture 并剔除 `broken/`：整根含它时创建 provider 必然 fail-loud（T3 契约）。 */
async function makePositiveRoot() {
  const root = await mkdtemp(join(tmpdir(), 'apply-positive-'));
  await cp(fixtureRoot, root, {
    recursive: true,
    filter: (source) => source !== join(fixtureRoot, 'broken'),
  });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// ─── 导出契约 ────────────────────────────────────────────────────

test('apply: name 逐字为 dsh-ppt-master-wrapper', () => {
  assert.equal(name, 'dsh-ppt-master-wrapper');
});

test('apply: inject 逐字为 [skills, tools]', () => {
  assert.deepEqual(inject, ['skills', 'tools']);
});

// ─── 分支一：硬依赖缺失 → throw ──────────────────────────────────

test('apply: ctx.skills.registerProvider 缺失时 throw', () => {
  const { ctx } = makeCtx({ skills: false });
  assert.throws(() => apply(ctx), /registerProvider/);
});

test('apply: ctx.skills.registerProvider 非函数时也 throw（不静默跳过）', () => {
  const ctx = { skills: { registerProvider: 'not-a-function' }, tools: { register: () => {} } };
  assert.throws(() => apply(ctx, { skillRoots: [fixtureRoot] }), /registerProvider/);
});

// ─── 分支二：skills + tools 均可用 ───────────────────────────────

test('apply: skills+tools 齐全 → provider 注册一次且 tools.register 恰好 3 次', async () => {
  const { root, cleanup } = await makePositiveRoot();
  try {
    const { ctx, calls } = makeCtx();
    const warnings = captureWarn(() => apply(ctx, { skillRoots: [root] }));

    assert.equal(calls.providers.length, 1, 'registerProvider 被调用一次');
    assert.equal(typeof calls.providers[0], 'function', 'registerProvider 收工厂函数（对齐参考实现形态）');
    assert.equal(calls.tools.length, 3, 'tools.register 逐个调用恰好 3 次（非数组一次性注册）');
    assert.deepEqual(
      calls.tools.map((tool) => tool.name),
      ['ppt_master_info', 'ppt_master_check_env', 'ppt_master_setup_deps'],
    );
    assert.deepEqual(warnings, [], '能力齐全时不得输出降级日志');

    const provider = calls.providers[0]();
    assert.equal(provider.name, 'dsh-ppt-master-wrapper');
    const listed = await provider.list();
    assert.deepEqual(
      listed.map((candidate) => candidate.name),
      ['alpha', 'hidden-skill'],
      '注入根确为传入的 skillRoots（alpha 收录、beta 无 SKILL.md 静默跳过）',
    );
  } finally {
    await cleanup();
  }
});

// ─── 分支三：tools 不可用 → 降级 ─────────────────────────────────

test('apply: 仅 ctx.skills → 不 throw、provider 注册、单行降级日志', async () => {
  const { root, cleanup } = await makePositiveRoot();
  try {
    const ctx = { skills: { registerProvider: (factory) => calls.push(factory) } };
    const calls = [];
    const warnings = captureWarn(() => apply(ctx, { skillRoots: [root] }));

    assert.equal(calls.length, 1, '降级路径仍注册 provider');
    assert.equal(warnings.length, 1, '恰好一行 console.warn');
    assert.match(warnings[0], /tools 不可用，降级仅注册 skill provider/);

    const listed = await calls[0]().list();
    assert.deepEqual(listed.map((candidate) => candidate.name), ['alpha', 'hidden-skill']);
  } finally {
    await cleanup();
  }
});

test('apply: ctx.tools.register 非函数 → 同样降级（能力探测而非存在性判断）', async () => {
  const { root, cleanup } = await makePositiveRoot();
  try {
    const { ctx, calls } = makeCtx();
    ctx.tools = { register: 'not-a-function' };
    const warnings = captureWarn(() => apply(ctx, { skillRoots: [root] }));

    assert.equal(calls.providers.length, 1);
    assert.equal(calls.tools.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /tools 不可用，降级仅注册 skill provider/);
  } finally {
    await cleanup();
  }
});

// ─── 扫描根注入通道 ──────────────────────────────────────────────

test('apply: opts.skillRoots 正例子集注入 → 不 throw，provider 可 list', async () => {
  const { root, cleanup } = await makePositiveRoot();
  try {
    assert.ok(existsSync(join(fixtureRoot, 'broken', 'SKILL.md')), 'fixture 前置：broken/ 确实存在');
    const { ctx, calls } = makeCtx();
    apply(ctx, { skillRoots: [root] });
    const provider = calls.providers[0]();
    assert.equal((await provider.get({ name: 'alpha' })).description.startsWith('Alpha fixture'), true);
  } finally {
    await cleanup();
  }
});

test('apply: 省略 opts → 透传 undefined，由 provider 自取包内 skills/（T14 前 fail-loud）', () => {
  const { ctx } = makeCtx();
  assert.throws(() => apply(ctx), /skill root does not exist|no skill directory found/);
});

// ─── lib/tools.js 契约（T5-7 逐个替换 stub 为真实实现） ──────────
//
// `ppt_master_info`（T5）与 `ppt_master_check_env`（T6）已是真实定义（各自的
// 完整契约由 tests/tools-info.test.mjs、tests/tools-check-env.test.mjs 锁定），
// 故下面只对它们断言「注册面仍成立」；最后一个仍为占位的工具（T7 替换）保留
// 逐字 deepEqual 的 stub 形态断言。

/** T5 之前的占位工具；T6/T7 逐个从这里移除并换成各自的真实定义断言。 */
const PLACEHOLDER_TOOLS = ['ppt_master_setup_deps'];

test('tools stub: createTools() 恰好 3 项，name 三键逐字', () => {
  const tools = createTools();
  assert.equal(tools.length, 3);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['ppt_master_info', 'ppt_master_check_env', 'ppt_master_setup_deps'],
  );
});

test('tools stub: 每项 parameters 为 object-rooted 且显式 additionalProperties:false', () => {
  for (const tool of createTools()) {
    assert.deepEqual(
      tool.parameters,
      { type: 'object', properties: {}, additionalProperties: false },
      `${tool.name} parameters 形态`,
    );
  }
});

test('tools stub: 每项 output.schema 为 object-rooted 且显式 AP:false、render 为函数', () => {
  for (const tool of createTools()) {
    assert.equal(tool.output.schema.type, 'object', `${tool.name} schema object-rooted`);
    assert.equal(tool.output.schema.additionalProperties, false, `${tool.name} schema 显式 AP:false`);
    assert.equal(tool.output.schema.type === 'json', false, `${tool.name} 不得用 type:'json'`);
    assert.equal(typeof tool.output.render, 'function', `${tool.name} output.render`);
  }
});

test('tools stub: 占位工具 output.schema 为最小合法形态（逐字）', () => {
  for (const name of PLACEHOLDER_TOOLS) {
    const tool = createTools().find((entry) => entry.name === name);
    assert.deepEqual(
      tool.output.schema,
      { type: 'object', properties: { placeholder: { type: 'string' } }, additionalProperties: false },
      `${name} 占位 schema`,
    );
  }
});

test('tools stub: 占位工具 description 非空双语短句、execute 为异步占位返回空对象', async () => {
  for (const name of PLACEHOLDER_TOOLS) {
    const tool = createTools().find((entry) => entry.name === name);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0, `${name} description 非空`);
    assert.equal(typeof tool.output.render({}, {}), 'string', `${name} render 返回字符串`);
    assert.equal(typeof tool.execute, 'function');
    assert.deepEqual(await tool.execute({}, {}), {}, `${name} 仍为占位实现`);
  }
});
