import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { name, inject, apply } from '../index.js';
import { createTools } from '../lib/tools.js';
// 追加导出一律经**命名空间**访问（同 tests/venv.test.mjs 约定）：Task 5 的
// `snapshotVenvConfig`/`assembleInjectionBag` 未落地时，本文件既有用例保持绿、
// 追加用例逐个先红（而非整文件 import 期链接失败）。
import * as venv from '../lib/venv.js';

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

test('apply: scope.mode=selected 且宿主缺 ctx.inject ⇒ 降级日志且不崩（工具仍注册）', async () => {
  const { root, cleanup } = await makePositiveRoot();
  try {
    const registered = [];
    const ctx = {
      skills: { registerProvider: () => {} },
      tools: { register: (tool) => registered.push(tool.name) },
    };
    const warnings = captureWarn(() =>
      apply(ctx, { skillRoots: [root], scope: { mode: 'selected', workspaceIds: [] } }),
    );

    assert.equal(registered.length, 3, '工具注册不受 scope 降级影响');
    assert.ok(
      warnings.some((line) => /inject/.test(line)),
      `缺 ctx.inject 时须有一条点名 inject 的降级日志，实际：${JSON.stringify(warnings)}`,
    );
  } finally {
    await cleanup();
  }
});

test('apply: 未配置 scope ⇒ 零降级日志（默认 global 整段短路）', async () => {
  const { root, cleanup } = await makePositiveRoot();
  try {
    const { ctx } = makeCtx();
    const warnings = captureWarn(() => apply(ctx, { skillRoots: [root] }));
    assert.deepEqual(warnings, []);
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

test('apply: opts.skillRoots 同时透传给 tools（注册面 SKILL_DIR 与 provider 同根）', async () => {
  const { root, cleanup } = await makePositiveRoot();
  try {
    const { ctx, calls } = makeCtx();
    apply(ctx, { skillRoots: [root] });
    const setupDeps = calls.tools.find((tool) => tool.name === 'ppt_master_setup_deps');

    // 接线回归：apply 必须把扫描根同时交给 createTools，否则 setup_deps 会退回
    // 包内 skills/（T14 前不存在）并在无 skill 目录时 fail-loud——即「注册成功但
    // 一调用就炸」。注入根存在时命令里必须出现该根下的 SKILL_DIR。
    const payload = await setupDeps.execute({}, {
      run: async (command, args) => {
        if (command === 'pip3') return { stdout: '', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    assert.equal(payload.installCmd[0], 'pip3');
    assert.equal(payload.installExit, 0);
    assert.ok(
      payload.installCmd[3].startsWith(root),
      `installCmd 指向注入根下的 SKILL_DIR，而非包内 skills/：${payload.installCmd[3]}`,
    );
    assert.ok(payload.installCmd[3].endsWith('requirements.txt'));
  } finally {
    await cleanup();
  }
});

test('apply: 省略 opts → 透传 undefined，由 provider 自取包内 skills/（T14 首灌后成功）', async () => {
  const { ctx, calls } = makeCtx();
  apply(ctx);
  assert.equal(calls.providers.length, 1, 'provider 注册成功（包内 skills/ 已随首灌落地）');
  const listed = await calls.providers[0]().list();
  assert.deepEqual(
    listed.map((candidate) => candidate.name),
    ['ppt-master', 'ppt-master-env'],
    '省略 opts 时扫描根确为包内 skills/（vendor 单 skill + 合成入口，字节序升序）',
  );
});

// ─── lib/tools.js 契约（T5-7 逐个替换 stub 为真实实现） ──────────
//
// `ppt_master_info`（T5）、`ppt_master_check_env`（T6）与 `ppt_master_setup_deps`
// （T7）三工具已全部是真实定义（各自的完整契约由 tests/tools-info.test.mjs、
// tests/tools-check-env.test.mjs、tests/tools-setup-deps.test.mjs 锁定），T4 的
// 占位机制（PLACEHOLDER_TOOLS / PLACEHOLDER_TASKS）随之清空。下面保留的是**通用
// 注册面**断言——不随任一工具的实现细节变动，故对三个真实工具一视同仁。

test('tools: createTools() 恰好 3 项，name 三键逐字', () => {
  const tools = createTools();
  assert.equal(tools.length, 3);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['ppt_master_info', 'ppt_master_check_env', 'ppt_master_setup_deps'],
  );
});

test('tools: 每项 parameters 为 object-rooted 且显式 additionalProperties:false', () => {
  for (const tool of createTools()) {
    assert.equal(tool.parameters.type, 'object', `${tool.name} parameters object-rooted`);
    assert.equal(
      typeof tool.parameters.properties,
      'object',
      `${tool.name} parameters 显式声明 properties`,
    );
    assert.equal(
      tool.parameters.additionalProperties,
      false,
      `${tool.name} parameters 显式 AP:false`,
    );
    assert.equal(tool.parameters.type === 'json', false, `${tool.name} 不得用 type:'json'`);
  }
});

test('tools: 每项 output.schema 为 object-rooted 且显式 AP:false、render 为函数', () => {
  for (const tool of createTools()) {
    assert.equal(tool.output.schema.type, 'object', `${tool.name} schema object-rooted`);
    assert.equal(tool.output.schema.additionalProperties, false, `${tool.name} schema 显式 AP:false`);
    assert.equal(tool.output.schema.type === 'json', false, `${tool.name} 不得用 type:'json'`);
    assert.equal(typeof tool.output.render, 'function', `${tool.name} output.render`);
  }
});

test('tools: 三工具 description 均为非空双语短句，execute 均为异步函数', () => {
  for (const tool of createTools()) {
    assert.equal(typeof tool.description, 'string', `${tool.name} description`);
    assert.ok(tool.description.length > 0, `${tool.name} description 非空`);
    assert.match(tool.description, /[\u4e00-\u9fff]/, `${tool.name} description 含中文段`);
    assert.equal(typeof tool.execute, 'function', `${tool.name} execute`);
    assert.equal(tool.execute.constructor.name, 'AsyncFunction', `${tool.name} execute 为异步`);
  }
});

// ─── Task 5：Config 边界纯函数（统一注入包 + 去引用快照）────────
//
// 观测面选择（plan Task 5 Step 1 直测载体理由）：`snapshotVenvConfig` 与
// `assembleInjectionBag` 皆无宿主依赖的纯边界函数，是「引用对象 → 普通值」形态差与
// 注入袋键集的**唯一可直接观测面**（探针 provider 捕获方案作废——多一层装配耦合）。
//
// 两形态事实（spec §5.1）：loader 传入的 config 经 cordis 校验，三叶子必为 `.volatile()`
// 引用对象（`{ get() }`，cosmokit `createVolatile`）；测试/嵌入形态（`{ skillRoots }`
// 或省略 opts）才缺 `venv` 键，缺省补默认由 `assembleInjectionBag` 自填。

/** 宿主 `.volatile()` 的解析值形态：带 `.get()` 的引用对象。 */
const volatileRef = (value) => ({ get: () => value });

test('T5①: snapshotVenvConfig——引用对象袋 → 三普通值（typeof 级去引用）', () => {
  const raw = {
    enabled: volatileRef(true),
    path: volatileRef('/tmp/venv-snapshot'),
    oldPathPolicy: volatileRef('delete'),
  };
  assert.equal(typeof raw.enabled, 'object', '前置：入参叶子确为引用对象（非普通值）');

  const snapshot = venv.snapshotVenvConfig(raw);

  assert.deepEqual(snapshot, {
    enabled: true,
    path: '/tmp/venv-snapshot',
    oldPathPolicy: 'delete',
  });
  assert.equal(typeof snapshot.enabled, 'boolean', 'enabled 已是普通值');
  assert.equal(typeof snapshot.path, 'string', 'path 已是普通值');
  assert.equal(typeof snapshot.oldPathPolicy, 'string', 'oldPathPolicy 已是普通值');
  assert.deepEqual(
    Object.keys(snapshot).sort(),
    ['enabled', 'oldPathPolicy', 'path'],
    '恰好三字段（不夹带引用包装器）',
  );

  // 普通值输入同样原样通过（下游接口一律按普通值，不感知引用）
  assert.deepEqual(
    venv.snapshotVenvConfig({ enabled: false, path: '~/.ppt-master/venv', oldPathPolicy: 'keep' }),
    { enabled: false, path: '~/.ppt-master/venv', oldPathPolicy: 'keep' },
  );
});

test('T5②: assembleInjectionBag——测试/嵌入形态（缺 venv 键）→ venv 三字段为自填默认值（逐字）', () => {
  const fromEmpty = venv.assembleInjectionBag({});
  const defaults = { enabled: false, path: '~/.ppt-master/venv', oldPathPolicy: 'keep' };

  assert.deepEqual(fromEmpty.venv, defaults, '缺 venv 键 → 三默认值逐字自填');
  assert.deepEqual(Object.keys(fromEmpty).sort(), ['skillRoots', 'venv'], '注入袋恰两键');
  assert.equal(fromEmpty.skillRoots, undefined, '无 skillRoots 时原样（undefined）透传');

  assert.deepEqual(venv.assembleInjectionBag(undefined).venv, defaults, '省略 opts 同判');
  assert.deepEqual(venv.assembleInjectionBag({ skillRoots: [] }).venv, defaults, '只有 skillRoots 同判');
});

test('T5③: assembleInjectionBag——{skillRoots, venv:<引用袋>} 两键共存互不干扰', () => {
  const roots = ['/tmp/skills-a', '/tmp/skills-b'];
  const bag = venv.assembleInjectionBag({
    skillRoots: roots,
    venv: {
      enabled: volatileRef(true),
      path: volatileRef('/tmp/venv-ref'),
      oldPathPolicy: volatileRef('keep'),
    },
  });

  assert.equal(bag.skillRoots, roots, 'skillRoots 原样透传（同一引用，不复制不改写）');
  assert.deepEqual(bag.venv, { enabled: true, path: '/tmp/venv-ref', oldPathPolicy: 'keep' });
  assert.equal(typeof bag.venv.path, 'string');
  // 两键共存只在测试路径成立：loader 路径永不带 skillRoots（缺省为 undefined）
  assert.deepEqual(Object.keys(bag).sort(), ['skillRoots', 'venv']);
});

test('T5④: 相对路径 venv → 注入包保留原值 + warn 触发（invalid 与 disabled×invalid 两行同判）', async () => {
  const { root, cleanup } = await makePositiveRoot();
  try {
    // (a) 纯函数面：apply 不改写 venv 值——无效路径原样保留在注入袋内（行为层降级另计）
    const raw = { enabled: true, path: 'relative/venv', oldPathPolicy: 'keep' };
    assert.deepEqual(
      venv.assembleInjectionBag({ venv: raw }).venv,
      raw,
      '注入包保留原值（不改写为默认值、不置 null）',
    );

    // (b) enabled:true + 相对路径 → invalid → warn 恰一次（warn 判定点＝同一 effectiveInterpreter 求值）
    const enabledCase = makeCtx();
    const enabledWarnings = captureWarn(() =>
      apply(enabledCase.ctx, { skillRoots: [root], venv: { enabled: true, path: 'relative/venv' } }),
    );
    assert.equal(enabledWarnings.length, 1, 'invalid 行必须 warn 恰一次（能力齐全时无其它降级日志）');
    assert.match(enabledWarnings[0], /relative-path/, 'warn 携带 invalidReason');
    assert.match(enabledWarnings[0], /relative\/venv/, 'warn 携带原值以便定位修正');
    assert.equal(enabledCase.calls.providers.length, 1, '降级视图不改写注册面');

    // (c) disabled×invalid（enabled:false + 相对路径）→ invalidReason 沿用 resolveVenvPath 原因 → warn 照常
    const disabledCase = makeCtx();
    const disabledWarnings = captureWarn(() =>
      apply(disabledCase.ctx, { skillRoots: [root], venv: { enabled: false, path: 'relative/venv' } }),
    );
    assert.equal(disabledWarnings.length, 1, 'disabled×invalid 组合下 warn 照常触发（不因 disabled 静默）');
    assert.match(disabledWarnings[0], /relative-path/);
  } finally {
    await cleanup();
  }
});

test('G3-12: 注入包装配异常 → 不抛、回落 VENV_DEFAULTS（系统模式）、warn 一次、skillRoots 透传保留（spec §6.1③）', async () => {
  const { root, cleanup } = await makePositiveRoot();
  try {
    const { ctx, calls } = makeCtx();
    const warnings = captureWarn(() =>
      apply(ctx, {
        skillRoots: [root],
        // 异常形态的 venv 袋：叶子 `.get()` 抛错（宿主/嵌入方给的非预期形状）。
        venv: {
          enabled: {
            get: () => {
              throw new Error('bag 装配异常：volatile get 抛错');
            },
          },
          path: volatileRef('/tmp/never-created'),
          oldPathPolicy: volatileRef('keep'),
        },
      }),
    );

    assert.equal(calls.providers.length, 1, '装配异常不得阻断注册（降级续行，而非抛出）');
    assert.equal(calls.tools.length, 3, '三工具照常注册');
    assert.equal(warnings.length, 1, '恰一行 warn（回落值合法且关闭 → 无第二条 invalid warn）');
    assert.match(warnings[0], /注入/, 'warn 须说明是注入/装配异常');
    assert.match(warnings[0], /bag 装配异常/, 'warn 须携带原因，便于定位');

    // 回落＝VENV_DEFAULTS：venv **视为关闭**（不是 invalid、更不是开启），故 path 按 off 行语义
    // 取配置原样（默认路径字符串），exists=false、pythonPath=null。
    const info = calls.tools.find((tool) => tool.name === 'ppt_master_info');
    const payload = await info.execute({}, {});
    assert.deepEqual(
      payload.venv,
      { enabled: false, path: '~/.ppt-master/venv', exists: false, pythonPath: null },
      '回落默认值：关闭 + 默认路径（不落 invalid 的 path=null，也不猜盘上路径）',
    );

    // skillRoots 透传语义不因回落丢失：provider 列表仍是注入根的内容。
    const listed = await calls.providers[0]().list();
    assert.deepEqual(
      listed.map((candidate) => candidate.name),
      ['alpha', 'hidden-skill'],
      'skillRoots 原样透传（回落只替换 venv 一支）',
    );
  } finally {
    await cleanup();
  }
});

test('T5⑤: 既有注入通道不回归——{skillRoots} 缺省 venv 走默认、零降级日志、fixture 根不追加', async () => {
  const { root, cleanup } = await makePositiveRoot();
  try {
    const { ctx, calls } = makeCtx();
    const warnings = captureWarn(() => apply(ctx, { skillRoots: [root] }));

    assert.deepEqual(warnings, [], 'venv 缺省＝默认（path 合法 + enabled:false）→ 不得有任何降级日志');
    assert.equal(calls.providers.length, 1);
    assert.equal(calls.tools.length, 3);
    const listed = await calls.providers[0]().list();
    assert.deepEqual(
      listed.map((candidate) => candidate.name),
      ['alpha', 'hidden-skill'],
      'fixture 根场景不追加入口技能（决策A：仅生产包内根追加）',
    );
  } finally {
    await cleanup();
  }
});

// ─── Task 7 ⑨：apply → 消费方注入边端到端观测（跨 Task 唯一观测例）──
//
// 通则 H：跨 Task 观测例写在**最晚转绿**的 Task 7。观测面＝apply 的注入边——
// `createTools({skillRoots, venv})` 与 `createSkillProvider(roots?, {venv})` 两个消费方
// 是否拿到同一份 venv 注入值并各自如实反映。载体＝本文件既有 mock ctx（`calls.tools`/
// `calls.providers` 捕获真实注册对象）＋ tmpdir 真 venv fixture，全程零生产面改动。
//
// 三部分：(a) 生产根形态（无 skillRoots）下**两半边**同源——payload `venv.path`＝fixture
// 绝对路径、入口正文解释器＝`<fixture>/bin/python3`（正文半边 Task 6 已绿，payload 半边
// 由 Task 7 转绿）；(b) 同一捕获 tool 的多根 per-call 注入下 name-锚定优先，且
// `info.primarySkillDir` 与入口正文 `SKILL_DIR` 同源（tools 侧两份拷贝收敛为单一共享
// 判定后的等价面）；(c) 收敛本身由 check_env/setup_deps 既有断言在共享判定上继续全绿
// 作证——不另立观测例、不新增测试专用工厂缝。

/** 合成入口技能名（provider 私有常量，测试侧按名读回）。 */
const ENTRY_SKILL_NAME = 'ppt-master-env';

/** 包内 vendor skills/ 根与 ppt-master 本体目录（生产根形态下的唯一 skill 面）。 */
const packagedSkillsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const packagedSkillDir = join(packagedSkillsRoot, 'ppt-master');

/**
 * 真 venv fixture：`pyvenv.cfg` + `bin/python3` + `bin/pip3`（就绪判据两问齐备，R2 M2）
 * + wrapper 所有权标记。
 */
async function makeVenvFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'apply-venv-'));
  await mkdir(join(dir, 'bin'), { recursive: true });
  await writeFile(join(dir, 'pyvenv.cfg'), 'home = /usr/bin\n');
  await writeFile(join(dir, 'bin', 'python3'), '');
  await writeFile(join(dir, 'bin', 'pip3'), '');
  await writeFile(
    join(dir, '.ppt-master-wrapper.json'),
    `${JSON.stringify({ createdAt: new Date().toISOString(), path: dir }, null, 2)}\n`,
  );
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** 多根 fixture：临时注入根，内含一个**非** `ppt-master` 命名的 skill。 */
async function makeExtraRoot() {
  const root = await mkdtemp(join(tmpdir(), 'apply-extra-root-'));
  await mkdir(join(root, 'alpha'), { recursive: true });
  await writeFile(
    join(root, 'alpha', 'SKILL.md'),
    ['---', 'name: alpha', 'description: extra root fixture skill.', '---', '', '# alpha', ''].join('\n'),
  );
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('⑨: apply→消费方注入边端到端（payload 半边＋入口正文半边＋多根 SKILL_DIR 同源）', async () => {
  const fixture = await makeVenvFixture();
  const extra = await makeExtraRoot();
  try {
    const { ctx, calls } = makeCtx();
    // 生产根形态：不带 skillRoots（决策A 下唯一合成入口技能的形态）。
    const warnings = captureWarn(() =>
      apply(ctx, { venv: { enabled: true, path: fixture.dir, oldPathPolicy: 'keep' } }),
    );
    assert.deepEqual(warnings, [], '合法 venv 配置：无任何降级日志');
    const infoTool = calls.tools.find((tool) => tool.name === 'ppt_master_info');
    assert.ok(infoTool, '注册面捕获到 ppt_master_info');

    // ── (a) 正文半边（Task 6 已绿）：入口正文解释器＝<fixture>/bin/python3 ──
    const expectedInterpreter = join(fixture.dir, 'bin', 'python3');
    const entry = await calls.providers[0]().get({ name: ENTRY_SKILL_NAME });
    assert.ok(entry, '生产根形态捕获到合成入口技能');
    const bodyInterpreter = /生效解释器：`([^`]+)`/.exec(entry.content)?.[1];
    assert.equal(
      bodyInterpreter,
      expectedInterpreter,
      `(a) 正文半边：入口解释器＝<fixture>/bin/python3，实际正文：${entry.content}`,
    );
    const bodySkillDir = /^SKILL_DIR: (.+)$/m.exec(entry.content)?.[1];
    assert.ok(bodySkillDir, '入口正文含 SKILL_DIR 行（(b) 的同源基准）');

    // ── (a) payload 半边（本 Task 转绿）：venv.path＝fixture 绝对路径、解释器就绪 ──
    const payload = await infoTool.execute({}, {});
    assert.deepEqual(
      payload.venv,
      {
        enabled: true,
        path: fixture.dir,
        exists: true,
        pythonPath: expectedInterpreter,
      },
      '(a) payload 半边：venv 注入值抵达 info 且与正文同源',
    );

    // ── (b) 同一捕获 tool：多根 per-call 注入 → name 锚定优先、SKILL_DIR 与 provider 同源 ──
    const multi = await infoTool.execute({}, { skillRoots: [packagedSkillsRoot, extra.root] });
    assert.deepEqual(
      multi.skillDirs,
      [packagedSkillDir, join(extra.root, 'alpha')],
      '(b) 两根确被展开扫描（额外根不含 ppt-master 命名技能）',
    );
    assert.equal(multi.primarySkillName, 'ppt-master', '(b) name===ppt-master 锚定压过根顺序/目录序');
    assert.equal(multi.primaryIsFallback, false, '(b) 锚定命中：非回退');
    assert.equal(multi.primarySkillDir, packagedSkillDir, '(b) 主目录仍为包内 vendor ppt-master');
    assert.equal(
      multi.primarySkillDir,
      bodySkillDir,
      '(b) tools 侧 SKILL_DIR 与入口正文 SKILL_DIR 同源（两份拷贝收敛为单一共享判定）',
    );
  } finally {
    await fixture.cleanup();
    await extra.cleanup();
  }
});

/**
 * G3-13（spec §7.4 补面）：loader 形态**引用袋**经 `apply` 的端到端去引用断言。
 *
 * 既有面只有两块：`snapshotVenvConfig`/`assembleInjectionBag` 的**纯函数直测**（T5①③）与
 * `apply` + **普通值** venv 的端到端例（⑨）。缺的是"三叶子都是 `.get()` 引用对象"的**loader
 * 形态**经 `apply` 走完全程——即生产路径真正会遇到的形态。本用例把两者接起来：去引用发生在
 * `apply` 边界，正文（provider 侧）与 payload（tools 侧）两半边都必须反映同一个 venv。
 * 观测面全部沿用本文件既有捕获通道（`calls.providers`/`calls.tools` + tmpdir 真 venv fixture），
 * **不新增生产侧测试专用导出缝**。
 */
test('G3-13: loader 形态引用袋经 apply 端到端去引用——正文与 info payload 同源反映该 venv', async () => {
  const fixture = await makeVenvFixture();
  try {
    const { ctx, calls } = makeCtx();
    const warnings = captureWarn(() =>
      apply(ctx, {
        // loader 形态：cordis 校验后三叶子必为 `.volatile()` 的引用对象（`{ get() }`）。
        venv: {
          enabled: volatileRef(true),
          path: volatileRef(fixture.dir),
          oldPathPolicy: volatileRef('keep'),
        },
      }),
    );

    assert.deepEqual(warnings, [], '引用袋去引用后是合法配置：零降级日志');
    const expectedInterpreter = join(fixture.dir, 'bin', 'python3');

    // ── 正文半边：入口 skill 的解释器契约＝该 venv 的解释器 ──
    const entry = await calls.providers[0]().get({ name: ENTRY_SKILL_NAME });
    assert.ok(entry, '生产根形态捕获到合成入口技能');
    assert.equal(
      /生效解释器：`([^`]+)`/.exec(entry.content)?.[1],
      expectedInterpreter,
      `引用袋的 path 须经 apply 去引用后抵达入口正文：${entry.content}`,
    );

    // ── payload 半边：info.venv 三字段＋pythonPath 同源 ──
    const infoTool = calls.tools.find((tool) => tool.name === 'ppt_master_info');
    const payload = await infoTool.execute({}, {});
    assert.deepEqual(
      payload.venv,
      {
        enabled: true,
        path: fixture.dir,
        exists: true,
        pythonPath: expectedInterpreter,
      },
      '引用袋的 enabled/path 须经 apply 去引用后抵达 tools payload（非 invalid、非默认值）',
    );
  } finally {
    await fixture.cleanup();
  }
});
