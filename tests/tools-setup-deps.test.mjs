import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPipArgs, createTools } from '../lib/tools.js';

/**
 * 本包**零 npm 依赖**（package.json 无 dependencies），所以 SDK 校验器只在本机
 * 恰好能解析到时才加载——解析不到就跳过该条断言，绝不让测试依赖宿主安装。
 *
 * 候选解析基点按「本包 → 环境变量 `DSH_HOME` 的 profiles/web」顺序尝试，全部失败
 * 即视为「本机未安装 SDK」（与 tests/tools-check-env.test.mjs 同手法）。
 */
function loadSdkSchemaValidator() {
  const bases = [
    import.meta.url,
    ...(process.env.DSH_HOME ? [join(process.env.DSH_HOME, 'profiles', 'web', 'lib', 'noop.js')] : []),
  ];
  for (const base of bases) {
    try {
      const { assertSupportedJsonSchema } = createRequire(base)('@deepseek-ai/dsh-tools');
      if (typeof assertSupportedJsonSchema === 'function') return assertSupportedJsonSchema;
    } catch {
      // 换下一个基点
    }
  }
  return null;
}

const assertSupportedJsonSchema = loadSdkSchemaValidator();

/**
 * Task 7 契约：`ppt_master_setup_deps` 工具（幂等安装 + 复跑自检）；
 * Task 9 扩面：**venv 分支编排**（唯一副作用点——创建/安装/清理/登记/复跑）。
 *
 * 被测面：
 *
 * 1. **纯函数** `buildPipArgs(requirementsPath, opts)`——参数四组合（默认/
 *    `user`/`breakSystemPackages`/两者）；**不含** `pip3` 前缀、flags 顺序固定
 *    （`--user` 在前、`--break-system-packages` 在后）。
 * 2. **工具形态**——`parameters` 两可选布尔、`output.schema` 五字段且嵌套
 *    `checkEnv` 复用 T6 诊断形态（逐层 `AP:false`、无 `type:'json'`）；
 *    `venv`/`cleanup` 两子对象逐字。
 * 3. **执行序列与边界**（全部 stub exec，无网络、不依赖真实 pip/python3）：
 *    `install`（`pip3 install …`）→ `check_env` 子进程组；`installExit` 只记录
 *    退出码、**不 throw**；无 skill 目录 → **throw**（fail-loud）；`exec.signal`
 *    在入口即被检查。
 * 4. **venv 分支（Task 9）**——状态门（仅 `on-missing`/`on-ready` 进分支；`off`/`invalid`
 *    纯系统模式且**零**副作用原语）、`ensureVenv` 三类未执行行（创建失败/收编拒绝/损坏）、
 *    venv 模式 installCmd 与调用期 flags 的忽略、两类时序（run argv 序 / fs 序经
 *    `testSeams` 函数桩）、`cleanup` 四 action 与三类注记拼接、`testSeams` 桩用例
 *    （写标记抛错 / 写登记抛错 / 读登记失败）、并发立场两场景（受控复用 / 双建竞态自愈）、
 *    abort 传播。凡触 `~`/wrapper-state 的用例前置把 `process.env.HOME` 赋非空 tmpdir、
 *    teardown **赋回原值**（禁 `delete` 还原）。
 *
 * 工具是**唯一有副作用的工具**（spec §3.5），因此这里断言的调用序列就是它的
 * 全部副作用面：先跑一条 pip，再把 T6 的同一套探测逻辑复跑一遍。
 */

/** 本任务唯一工具在 `createTools()` 中的位置（brief：数组第三项）。 */
const SETUP_DEPS_INDEX = 2;

/** 工具入参 schema：两参数均可选（无 `required`），逐层显式封闭。 */
const SETUP_PARAMETERS = {
  type: 'object',
  properties: {
    user: { type: 'boolean' },
    breakSystemPackages: { type: 'boolean' },
  },
  additionalProperties: false,
};

/**
 * 返回对象 / `output.schema` 的逐字字段集（**单常量**：schema 与载荷共用，不另立第二常量）。
 *
 * Task 9 由三键扩为五键：`venv` / `cleanup` 为 venv 编排面增量（载荷**无条件**输出两键，
 * 系统模式亦然）。
 */
const SETUP_FIELDS = ['installCmd', 'installExit', 'checkEnv', 'venv', 'cleanup'];

/** T6 诊断对象的逐字字段集（嵌套 `checkEnv` 复用该形态；`venv` 小节为 T8 增量）。 */
const DIAGNOSTIC_FIELDS = ['python', 'guard', 'deps', 'envFileExists', 'venv'];

/** fixture 的依赖真值（stub 下每个发行版都由元数据子进程回答）。 */
const FIXTURE_DISTS = ['pyyaml', 'python-pptx'];

/** stub 记录的固定观测值。 */
const STUB_PYTHON_VERSION = 'Python 3.11.2\n';
const STUB_GUARD_EXIT = 3;
const STUB_INSTALL_EXIT = 0;

/** `createTools()` 中某个工具定义，按 name 精确查找。 */
function toolNamed(name) {
  return createTools().find((tool) => tool.name === name);
}

// ─── exec stub ───────────────────────────────────────────────────

/** spawn 级失败（pip3/python3 不存在）：Node 抛出的 ENOENT 形态。 */
function enoentError(command) {
  const error = new Error(`spawn ${command} ENOENT`);
  error.code = 'ENOENT';
  return error;
}

/**
 * 造一个可注入的 `exec` 助手。
 *
 * `run(command, args, options)` 逐字对齐（命令, 参数, 选项）三元组——实现必须把
 * argv 与 signal 透传到这一层，所以 stub 既能断言「调了什么、什么顺序」，也能
 * 断言「怎么传信号」。
 */
function stubExec(run, extra = {}) {
  return { run, ...extra };
}

/**
 * 「环境齐全」的 exec stub：`pip3` 退出码 `installExit`；python3 存在
 * （3.11.2）；每个 `-c` 元数据查询成功；guard 退出码 3。
 *
 * `calls` 逐条记录 `{command, args, options}`——**数组顺序即调用顺序**，是本文件
 * 「先安装、后自检」断言的唯一事实来源。
 */
function recordingExec({ installExit = STUB_INSTALL_EXIT, onCall } = {}) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    onCall?.(command, args, options);
    if (command === 'pip3') {
      return { stdout: 'Successfully installed …\n', stderr: '', exitCode: installExit };
    }
    if (command !== 'python3') throw enoentError(command);
    if (args.includes('--version')) return { stdout: STUB_PYTHON_VERSION, stderr: '', exitCode: 0 };
    if (String(args.at(-1)).endsWith('.py')) {
      return { stdout: 'guard fixture\n', stderr: '', exitCode: STUB_GUARD_EXIT };
    }
    return { stdout: `${args.at(-1)}-1.0.0\n`, stderr: '', exitCode: 0 };
  };
  return { exec: stubExec(run), calls };
}

/** 调用分桶：安装调用（pip3）与探测调用（python3）。 */
function partitionCalls(calls) {
  return {
    install: calls.filter((call) => call.command === 'pip3'),
    probes: calls.filter((call) => call.command === 'python3'),
  };
}

/** 造一个临时 skill 目录树（`SKILL.md` + requirements.txt + guard 脚本）。 */
function makeSkillDir({ requirements = 'PyYAML==6.0.1\npython-pptx[image]>=0.6.21\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'setup-deps-'));
  const skill = join(root, 'ppt-master');
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, 'SKILL.md'),
    ['---', 'name: ppt-master', 'description: fixture skill', '---', '', '# fixture', ''].join('\n'),
  );
  mkdirSync(join(skill, 'scripts'), { recursive: true });
  writeFileSync(join(skill, 'scripts', 'attribution_guard.py'), 'print("guard fixture")\n');
  if (requirements !== null) writeFileSync(join(skill, 'requirements.txt'), requirements);
  return { root, skill, remove: () => rmSync(root, { recursive: true, force: true }) };
}

// ─── 纯函数：buildPipArgs（参数四组合） ──────────────────────────

test('buildPipArgs: 默认 → install/-r/路径，无任何 flag（且不含 pip3 前缀）', () => {
  const args = buildPipArgs('/skill/requirements.txt', {});
  assert.deepEqual(args, ['install', '-r', '/skill/requirements.txt']);
  assert.ok(!args.includes('pip3'), '纯函数只产出 pip 的参数数组，不含 pip3 前缀');
});

test('buildPipArgs: opts 省略 / 空对象 / 显式 false 与默认逐字同形', () => {
  const expected = ['install', '-r', '/skill/requirements.txt'];
  assert.deepEqual(buildPipArgs('/skill/requirements.txt'), expected, 'opts 省略');
  assert.deepEqual(buildPipArgs('/skill/requirements.txt', {}), expected, '空对象');
  assert.deepEqual(
    buildPipArgs('/skill/requirements.txt', { user: false, breakSystemPackages: false }),
    expected,
    '显式 false 不产出 flag',
  );
});

test('buildPipArgs: user → --user 收尾', () => {
  assert.deepEqual(buildPipArgs('/skill/requirements.txt', { user: true }), [
    'install',
    '-r',
    '/skill/requirements.txt',
    '--user',
  ]);
});

test('buildPipArgs: breakSystemPackages → --break-system-packages 收尾', () => {
  assert.deepEqual(buildPipArgs('/skill/requirements.txt', { breakSystemPackages: true }), [
    'install',
    '-r',
    '/skill/requirements.txt',
    '--break-system-packages',
  ]);
});

test('buildPipArgs: 两者同开 → flags 顺序固定（--user 在前、--break-system-packages 在后）', () => {
  assert.deepEqual(
    buildPipArgs('/skill/requirements.txt', { user: true, breakSystemPackages: true }),
    ['install', '-r', '/skill/requirements.txt', '--user', '--break-system-packages'],
  );
});

test('buildPipArgs: 路径原样使用（不做转义/拼接/相对化）', () => {
  for (const path of ['/abs path/requirements.txt', 'relative/requirements.txt', '']) {
    assert.equal(buildPipArgs(path, { user: true })[2], path, `路径逐字保留：${path}`);
  }
});

// ─── 工具形态（schema 逐字） ─────────────────────────────────────

test('setup_deps: createTools()[2] name 逐字 ppt_master_setup_deps', () => {
  assert.equal(createTools()[SETUP_DEPS_INDEX].name, 'ppt_master_setup_deps');
});

test('setup_deps: description 为中英双语短句（一句中文 + 一句英文）', () => {
  const { description } = toolNamed('ppt_master_setup_deps');
  assert.equal(typeof description, 'string');
  const parts = description.split('/').map((part) => part.trim()).filter(Boolean);
  assert.equal(parts.length, 2, `description 恰为两段（中/英）：${description}`);
  assert.match(parts[0], /[\u4e00-\u9fff]/, '第一段为中文');
  assert.match(parts[1], /^[\x20-\x7e]+$/, '第二段为 ASCII 英文');
  const lowered = parts[1].toLowerCase();
  assert.ok(lowered.includes('ppt-master'), '英文段点明 ppt-master');
  assert.ok(/depend|pip/.test(lowered), '英文段点明依赖安装');
});

test('setup_deps: parameters 两可选布尔、无 required、逐层 AP:false', () => {
  const { parameters } = toolNamed('ppt_master_setup_deps');
  assert.deepEqual(parameters, SETUP_PARAMETERS);
  assert.equal(parameters.required, undefined, '两参数均可选（无 required）');
  assert.deepEqual(Object.keys(parameters.properties), ['user', 'breakSystemPackages']);
});

test('setup_deps: output.schema 属性集=五字段、嵌套 checkEnv 复用 T6 逐字形态', () => {
  const { schema } = toolNamed('ppt_master_setup_deps').output;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false, '根层 AP:false');
  assert.equal(schema.type === 'json', false, "不得用 type:'json'（SDK 静默降级为空契约）");
  assert.deepEqual(Object.keys(schema.properties), SETUP_FIELDS, '属性集即返回对象五字段');
  assert.deepEqual(schema.properties.installCmd, { type: 'array', items: { type: 'string' } });
  assert.deepEqual(schema.properties.installExit, { type: 'number' });

  // Task 9 增量：`venv` / `cleanup` 两子对象逐字（对象级 AP:false、可空字段用 oneOf、
  // `error` 为可选注记、四 action 枚举带同级 type）。
  assert.deepEqual(schema.properties.venv, {
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      created: { type: 'boolean' },
      adopted: { type: 'boolean' },
      path: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      error: { type: 'string' },
    },
    required: ['enabled', 'created', 'adopted', 'path'],
    additionalProperties: false,
  });
  assert.deepEqual(schema.properties.cleanup, {
    type: 'object',
    properties: {
      oldPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      action: { type: 'string', enum: ['none', 'kept', 'deleted', 'failed'] },
      error: { type: 'string' },
    },
    required: ['oldPath', 'action'],
    additionalProperties: false,
  });

  // 嵌套 checkEnv：与 T6 工具 output.schema 同一形态（同一构造器产出），逐层 AP:false。
  const checkEnv = schema.properties.checkEnv;
  assert.equal(checkEnv.type, 'object');
  assert.equal(checkEnv.additionalProperties, false);
  assert.deepEqual(Object.keys(checkEnv.properties), DIAGNOSTIC_FIELDS, 'checkEnv 属性集=诊断五字段');
  assert.equal(checkEnv.properties.python.additionalProperties, false);
  assert.deepEqual(checkEnv.properties.python.properties.version, {
    oneOf: [{ type: 'string' }, { type: 'null' }],
  });
  assert.equal(checkEnv.properties.deps.items.additionalProperties, false);
  assert.deepEqual(checkEnv.properties.deps.items.properties.installed, {
    oneOf: [{ type: 'boolean' }, { type: 'string', const: 'UNKNOWN' }],
  });
  assert.deepEqual(checkEnv.properties.python, toolNamed('ppt_master_check_env').output.schema.properties.python);
  assert.deepEqual(
    checkEnv.properties.deps,
    toolNamed('ppt_master_check_env').output.schema.properties.deps,
  );
});

test('setup_deps: schema 通过 SDK 的 assertSupportedJsonSchema（可解析到 SDK 时）', (t) => {
  if (assertSupportedJsonSchema === null) {
    t.skip('@deepseek-ai/dsh-tools 不可解析（本包零依赖，非失败）');
    return;
  }
  // 关键回归点：`const`/`enum` 必须带同级 `type`，否则 SDK 报
  // "requires type or oneOf" 并拒收整个工具定义；嵌套 checkEnv 一并受检。
  assertSupportedJsonSchema(toolNamed('ppt_master_setup_deps').output.schema);
});

// ─── 执行序列：install → check_env ───────────────────────────────

test('setup_deps: 调用序列 = 一条 pip3 install 在前，check_env 子进程组在后', async () => {
  const { root, skill, remove } = makeSkillDir();
  try {
    const { exec, calls } = recordingExec();
    const payload = await toolNamed('ppt_master_setup_deps').execute({}, { skillRoots: [root], ...exec });

    assert.deepEqual(Object.keys(payload), SETUP_FIELDS, '返回对象恰为五字段');
    assert.deepEqual(
      payload.installCmd,
      ['pip3', 'install', '-r', join(skill, 'requirements.txt')],
      'installCmd = [pip3, ...buildPipArgs(<SKILL_DIR>/requirements.txt)]',
    );

    const { install, probes } = partitionCalls(calls);
    assert.equal(install.length, 1, '恰好一条安装命令');
    assert.deepEqual(install[0].args, payload.installCmd.slice(1), 'stub 收到的 argv 与 installCmd 同源');
    assert.equal(install[0].command, payload.installCmd[0]);

    // 探测组即 T6 复跑：python3 --version → guard → 逐 dist 一次元数据查询。
    const argvOf = (call) => call.args.join(' ');
    assert.equal(probes.length, 4, `--version + guard + 2 dist：${probes.map(argvOf).join(' | ')}`);
    assert.ok(probes[0].args.includes('--version'), '先探测解释器');
    assert.ok(String(probes[1].args.at(-1)).endsWith('attribution_guard.py'), '再跑 guard');
    assert.deepEqual(
      probes.slice(2).map((call) => call.args.at(-1)),
      FIXTURE_DISTS,
      '最后逐个发行版元数据查询（要求文件解析顺序）',
    );

    assert.equal(calls.indexOf(install[0]), 0, '安装是第一条子进程调用');
    assert.ok(
      calls.indexOf(install[0]) < calls.indexOf(probes[0]),
      '先安装、后自检——自检不得抢在安装之前',
    );
    assert.deepEqual(
      payload.checkEnv.deps.map((dep) => dep.dist),
      FIXTURE_DISTS,
      '复跑的诊断对象覆盖 requirements 全部发行版',
    );
  } finally {
    remove();
  }
});

test('setup_deps: 参数透传到 installCmd（user / breakSystemPackages / 两者）', async () => {
  const { root, skill, remove } = makeSkillDir();
  try {
    const base = ['pip3', 'install', '-r', join(skill, 'requirements.txt')];
    for (const [args, flags] of [
      [{}, []],
      [{ user: true }, ['--user']],
      [{ breakSystemPackages: true }, ['--break-system-packages']],
      [{ user: true, breakSystemPackages: true }, ['--user', '--break-system-packages']],
    ]) {
      const { exec } = recordingExec();
      const payload = await toolNamed('ppt_master_setup_deps').execute(args, { skillRoots: [root], ...exec });
      assert.deepEqual(payload.installCmd, [...base, ...flags], `参数 ${JSON.stringify(args)}`);
    }
  } finally {
    remove();
  }
});

test('setup_deps: 返回的 checkEnv 就是 T6 诊断对象（与 check_env 工具复跑结论一致）', async () => {
  const { root, remove } = makeSkillDir();
  try {
    const { exec } = recordingExec();
    const shared = { skillRoots: [root], ...exec };
    const payload = await toolNamed('ppt_master_setup_deps').execute({}, shared);
    const diagnostic = await toolNamed('ppt_master_check_env').execute({}, shared);

    assert.deepEqual(Object.keys(payload.checkEnv), DIAGNOSTIC_FIELDS);
    assert.deepEqual(payload.checkEnv.python, {
      found: true,
      version: '3.11.2',
      meetsSkillRequirement: true,
    });
    assert.deepEqual(payload.checkEnv.guard, { ran: true, exitCode: STUB_GUARD_EXIT }, 'guard 退出码仅记录');
    assert.deepEqual(payload.checkEnv.deps, [
      { dist: 'pyyaml', importName: 'yaml', installed: true, source: 'metadata' },
      { dist: 'python-pptx', importName: 'pptx', installed: true, source: 'metadata' },
    ]);
    assert.equal(payload.checkEnv.envFileExists, false);
    assert.deepEqual(payload.checkEnv, diagnostic, '同一路径下与 ppt_master_check_env 结论逐字一致');
  } finally {
    remove();
  }
});

// ─── installExit：只记录，不 throw ───────────────────────────────

test('setup_deps: installExit 记录非零退出码，不 throw，且照常复跑自检', async () => {
  const { root, remove } = makeSkillDir();
  try {
    const { exec, calls } = recordingExec({ installExit: 7 });
    const payload = await toolNamed('ppt_master_setup_deps').execute({}, { skillRoots: [root], ...exec });

    assert.equal(payload.installExit, 7, '退出码原样记录');
    assert.equal(partitionCalls(calls).install.length, 1);
    assert.ok(partitionCalls(calls).probes.length > 0, '安装失败仍复跑自检（诊断优先于失败判定）');
    assert.equal(payload.checkEnv.python.found, true, '自检结论不因安装失败而丢失');
  } finally {
    remove();
  }
});

test('setup_deps: installExit 未注入真实子进程失败（ENOENT：无 pip3）时也不 throw', async () => {
  const { root, remove } = makeSkillDir();
  try {
    const payload = await toolNamed('ppt_master_setup_deps').execute(
      {},
      {
        skillRoots: [root],
        run: async (command) => {
          // pip3 不存在；python3 正常——安装失败不得吞掉自检，也不得让工具抛错。
          if (command === 'pip3') throw enoentError(command);
          if (command !== 'python3') throw enoentError(command);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      },
    );
    assert.equal(typeof payload.installExit, 'number');
    assert.notEqual(payload.installExit, 0, 'spawn 级失败须以非零退出码记录');
    assert.equal(payload.installCmd[0], 'pip3');
    assert.deepEqual(Object.keys(payload.checkEnv), DIAGNOSTIC_FIELDS, '自检照常完成');
  } finally {
    remove();
  }
});

test('setup_deps: checkEnv 仍受 T6 契约约束（无 python3 → deps 全 UNKNOWN、不 throw）', async () => {
  const { root, remove } = makeSkillDir();
  try {
    const payload = await toolNamed('ppt_master_setup_deps').execute(
      {},
      {
        skillRoots: [root],
        ...recordingExec().exec,
        run: async (command) => {
          if (command === 'pip3') return { stdout: '', stderr: '', exitCode: 0 };
          throw enoentError(command);
        },
      },
    );
    assert.equal(payload.installExit, 0);
    assert.deepEqual(payload.checkEnv.python, { found: false, version: null, meetsSkillRequirement: null });
    assert.deepEqual(payload.checkEnv.guard, { skipped: true });
    assert.ok(payload.checkEnv.deps.every((dep) => dep.installed === 'UNKNOWN'));
  } finally {
    remove();
  }
});

// ─── 边界：无 skill 目录 / 无 requirements / signal ──────────────

test('setup_deps: 无 skill 目录 → throw（fail-loud，不安装、不自检）', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'setup-deps-empty-'));
  try {
    const { exec, calls } = recordingExec();
    await assert.rejects(
      () => toolNamed('ppt_master_setup_deps').execute({}, { skillRoots: [empty], ...exec }),
      /no skill directory found/,
      '无 SKILL_DIR 时不得静默无操作',
    );
    assert.deepEqual(calls, [], 'throw 之前不得跑任何子进程');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('setup_deps: 根不存在 → 同样 throw（定位复用 T5/T6 锚定）', async () => {
  const { exec } = recordingExec();
  await assert.rejects(
    () =>
      toolNamed('ppt_master_setup_deps').execute(
        {},
        { skillRoots: [join(tmpdir(), 'setup-deps-does-not-exist-xyz')], ...exec },
      ),
    /no skill directory found/,
  );
});

test('setup_deps: requirements.txt 缺失仍构造同一命令（幂等由 pip 自身保证，缺失留给 installExit）', async () => {
  const { root, skill, remove } = makeSkillDir({ requirements: null });
  try {
    const { exec } = recordingExec({ installExit: 1 });
    const payload = await toolNamed('ppt_master_setup_deps').execute({}, { skillRoots: [root], ...exec });
    assert.deepEqual(payload.installCmd, ['pip3', 'install', '-r', join(skill, 'requirements.txt')]);
    assert.equal(payload.installExit, 1, '文件缺失由 pip 以非零退出码表达，不 throw');
    assert.deepEqual(
      payload.checkEnv.deps,
      [],
      '无 requirements 文件 → 无发行版可探测（T6：不 throw）',
    );
  } finally {
    remove();
  }
});

test('setup_deps: output.render 返回含安装命令/退出码/自检结论的 text 内容块数组', async () => {
  const { root, remove } = makeSkillDir();
  try {
    const tool = toolNamed('ppt_master_setup_deps');
    assert.equal(typeof tool.output.render, 'function');
    const { exec } = recordingExec({ installExit: 0 });
    const payload = await tool.execute({}, { skillRoots: [root], ...exec });
    const rendered = tool.output.render({}, payload);
    // 宿主管线契约：render 返回内容块数组（同 tools-info 测试内注记）。
    assert.ok(Array.isArray(rendered), 'render 返回内容块数组');
    assert.equal(rendered.length, 1, '单个内容块');
    assert.equal(rendered[0].type, 'text', '块类型为 text');
    assert.equal(typeof rendered[0].text, 'string');
    const text = rendered[0].text;
    assert.ok(text.includes('pip3'), 'render 点出安装命令');
    assert.ok(text.includes('install'), 'render 点出 install 子命令');
    assert.ok(text.includes(String(payload.installExit)), 'render 点出退出码');
    assert.ok(text.includes('python3'), 'render 含复跑自检结论');
    assert.ok(text.includes('pyyaml'), 'render 逐项列出依赖');
  } finally {
    remove();
  }
});

// ─── exec 契约：signal 与 run 注入 ───────────────────────────────

test('setup_deps: execute 尊重 exec.signal（已中止 → 不安装、不返回结果）', async () => {
  const { root, remove } = makeSkillDir();
  try {
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    const signal = { throwIfAborted: () => { throw aborted; } };
    const { exec, calls } = recordingExec();
    await assert.rejects(
      () => toolNamed('ppt_master_setup_deps').execute({}, { skillRoots: [root], signal, ...exec }),
      /aborted/,
    );
    assert.deepEqual(calls, [], '入口即检查 signal：中止时不产生任何副作用');
  } finally {
    remove();
  }
});

test('setup_deps: signal 透传给每条子进程（安装与探测的 options.signal）', async () => {
  const { root, remove } = makeSkillDir();
  try {
    const signal = { aborted: false, throwIfAborted: () => {} };
    const { exec, calls } = recordingExec();
    await toolNamed('ppt_master_setup_deps').execute({}, { skillRoots: [root], signal, ...exec });
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.equal(call.options?.signal, signal, `signal 透传：${call.command} ${call.args.join(' ')}`);
    }
  } finally {
    remove();
  }
});

test('setup_deps: 无 exec.run 注入时退回内置 spawn 助手（真实 pip3 缺失/失败也不 throw）', async () => {
  // 密封性：本用例**故意**不注入 exec.run（测的就是内置 spawnRun 回退），因此必须
  // 让真实 pip3 无物可装、且不触网——fixture 不写 requirements.txt：
  //   · pip 在本地即失败（`Could not open requirements file`，exit 1），不发索引请求；
  //   · 若改用空文件，pip 仍会 `Looking in indexes: …` 触网（实测），不够密封。
  // 真实 spawn 依旧发生，用例目的（spawn 回退 + 失败不 throw）不变，且零污染零网络。
  const { root, remove } = makeSkillDir({ requirements: null });
  try {
    const payload = await toolNamed('ppt_master_setup_deps').execute({}, { skillRoots: [root] });
    assert.deepEqual(Object.keys(payload), SETUP_FIELDS);
    // 退出码是数字：本机无 pip3 时为 -1（spawn 级失败），有 pip3 时为其真实退出码
    // （缺失 requirements → 1）。两种都是「不 throw」，故断言不绑定到具体环境。
    assert.equal(typeof payload.installExit, 'number');
    assert.ok(
      payload.installExit === -1 || payload.installExit > 0,
      `内置 spawnRun 已执行/已尝试执行 pip3（实测 -1=无 pip3，1=本地路径缺失）：${payload.installExit}`,
    );
    assert.deepEqual(Object.keys(payload.checkEnv), DIAGNOSTIC_FIELDS);
  } finally {
    remove();
  }
});

test('setup_deps: per-call exec.skillRoots 注入通道生效（apply 与单测共用同一路径）', async () => {
  const { root, skill, remove } = makeSkillDir();
  try {
    const { exec } = recordingExec();
    const payload = await toolNamed('ppt_master_setup_deps').execute({}, { skillRoots: [root], ...exec });
    assert.equal(
      payload.installCmd[3],
      join(skill, 'requirements.txt'),
      '每调用注入的扫描根决定 SKILL_DIR（与 T5/T6 同一优先序）',
    );
  } finally {
    remove();
  }
});

// ─── Task 9：venv 分支编排（唯一副作用点） ───────────────────────
//
// 状态门＝同一次 `effectiveInterpreter(venv).state`：**仅** `on-missing`/`on-ready`（含 broken）
// 进 venv 分支；`off`/`invalid` 纯系统模式且**零**副作用原语（ensureVenv/cleanupOldVenv/
// writeWrapperState 一个不调）。venv 分支的时序断言分两类：①run argv 序（`python3 -m venv
// <path>` → `<path>/bin/pip3 install -r <req>`）；②fs 序（`writeMarker` → 清理 → `writeWrapperState`，
// 经注入袋的 `testSeams` 函数桩记录——不依赖 fs stub、不依赖只读目录）。

/**
 * venv 分支用例的 HOME 隔离（plan Global Constraints「fs 注入缝与 HOME 隔离」）：
 * 前置把 `process.env.HOME` 赋值为**非空 tmpdir**、teardown **赋回原值**——禁 `delete`
 * 还原（delete 会落 `getpwuid` 回退到宿主真实家目录，那不是隔离）。
 */
const ORIGINAL_HOME = process.env.HOME;

function useTmpHome(prefix = 'setup-deps-home-') {
  assert.equal(typeof ORIGINAL_HOME, 'string', '测试前提：进程 HOME 已设置，否则无法用赋值还原');
  const home = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = home;
  return {
    home,
    restore() {
      process.env.HOME = ORIGINAL_HOME;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 所有权标记文件名（`lib/venv.js` 的公开常量，此处按值复述以免测试倒挂模块内部）。 */
const VENV_MARKER = '.ppt-master-wrapper.json';

/** Task 5 定形的去引用普通值 venv 配置。 */
function venvConfig(path, { enabled = true, oldPathPolicy = 'keep' } = {}) {
  return { enabled, path, oldPathPolicy };
}

/** 造一个「真 venv」目录：`pyvenv.cfg` + `bin/python3` + `bin/pip3`（stub run 的落盘模拟）。 */
function makeVenvFixture(dir) {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'pyvenv.cfg'), 'home = /usr/bin\n');
  writeFileSync(join(dir, 'bin', 'python3'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'bin', 'pip3'), '#!/bin/sh\n');
  return dir;
}

/** 带所有权标记的旧 venv——`cleanupOldVenv` 前置③④（pyvenv.cfg + 标记）的落点。 */
function makeMarkedVenv(parent, name = 'old-venv') {
  const dir = makeVenvFixture(join(parent, name));
  writeFileSync(
    join(dir, VENV_MARKER),
    `${JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z', path: dir }, null, 2)}\n`,
  );
  return dir;
}

/**
 * venv 模式的 exec 桩（真实 spawn 语义的最小子集）。
 *
 * - `python3 -m venv <path>`：按 `create` 决定是否**如实落盘**（`makeVenvFixture`）——落盘使
 *   「第二次调用看到既有 venv → 收编」「双建竞态中对手建成 → 复跑自愈」两场景可观测；
 *   `createExit` 非零即创建失败行。
 * - 绝对路径解释器（`<venv>/bin/python3`、`<venv>/bin/pip3`）：文件不存在时**按真实 spawn
 *   抛 ENOENT**（否则缺口径会被桩谎报为可用）。
 * - guard / 元数据查询：与既有 `recordingExec` 同形回答。
 */
function venvExec({ create = true, createExit = 0, installExit = 0 } = {}) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'python3' && args[0] === '-m' && args[1] === 'venv') {
      if (create) makeVenvFixture(args[2]);
      return { stdout: '', stderr: createExit === 0 ? '' : 'race: 另一路已建成', exitCode: createExit };
    }
    if (command === 'pip3' || command.endsWith('/bin/pip3')) {
      return { stdout: 'Successfully installed …\n', stderr: '', exitCode: installExit };
    }
    if (command === 'python3' || command.endsWith('/bin/python3')) {
      if (command !== 'python3' && !existsSync(command)) throw enoentError(command);
      if (args.includes('--version')) return { stdout: STUB_PYTHON_VERSION, stderr: '', exitCode: 0 };
      if (String(args.at(-1)).endsWith('.py')) {
        return { stdout: 'guard fixture\n', stderr: '', exitCode: STUB_GUARD_EXIT };
      }
      return { stdout: `${args.at(-1)}-1.0.0\n`, stderr: '', exitCode: 0 };
    }
    throw enoentError(command);
  };
  return { exec: stubExec(run), calls };
}

/** 创建 argv（`python3 -m venv <path>`）调用表——并发两场景的「至多一次生效」观测面。 */
function createCalls(calls) {
  return calls.filter(
    (call) => call.command === 'python3' && call.args[0] === '-m' && call.args[1] === 'venv',
  );
}

/** 安装 argv（`pip3 …` / `<venv>/bin/pip3 …`）调用表。 */
function installCalls(calls) {
  return calls.filter((call) => call.command === 'pip3' || call.command.endsWith('/bin/pip3'));
}

/** `createTools(options)` 里的 setup_deps 定义（venv / testSeams 注入口）。 */
function setupDepsToolWith({ roots, venv, seams } = {}) {
  return createTools({ skillRoots: roots, venv, testSeams: seams })
    .find((tool) => tool.name === 'ppt_master_setup_deps');
}

/** 四个桩的缺省行为：写类为 no-op，读类给「首次运行」语义。 */
const SEAM_DEFAULTS = {
  writeMarker: () => {},
  readWrapperState: () => ({ lastVenvPath: null }),
  writeWrapperState: () => {},
  remove: () => {},
};

/**
 * `testSeams` 记录器：四个桩一律**记账**（`calls` 数组顺序＝调用顺序）后可覆盖行为。
 * 这是 fs 序与「零调用」两类断言的唯一观测面（不依赖 fs stub、不依赖只读目录）。
 */
function seamRecorder(overrides = {}) {
  const calls = [];
  const seams = {};
  for (const name of Object.keys(SEAM_DEFAULTS)) {
    const behaviour = overrides[name] ?? SEAM_DEFAULTS[name];
    seams[name] = (...args) => {
      calls.push({ name, args });
      return behaviour(...args);
    };
  }
  return {
    seams,
    calls,
    countOf: (name) => calls.filter((call) => call.name === name).length,
    order: () => calls.map((call) => call.name),
  };
}

/** 捕获 `console.warn`（异步版）：返回被 await 的返回值与逐行日志，finally 原样还原。 */
async function captureWarnAsync(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    return { value: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

/**
 * 基座：venv 模式的成功路径（首跑建 venv）——run argv 序 + installCmd 逐字 +
 * 载荷五键 + 复跑 check_env 的第 4 参透传（S8：`checkEnv.venv.enabled===true`）。
 */
test('setup_deps venv: run argv 序 = python3 -m venv 在前、<venv>/bin/pip3 install -r 在后，installCmd 逐字', async () => {
  const { home, restore } = useTmpHome();
  const { root, skill, remove } = makeSkillDir();
  try {
    const absPath = join(home, 'venvs', 'current');
    const requirementsPath = join(skill, 'requirements.txt');
    const tool = setupDepsToolWith({ roots: [root], venv: venvConfig(absPath) });
    const { exec, calls } = venvExec();

    const payload = await tool.execute({}, { skillRoots: [root], ...exec });

    assert.deepEqual(Object.keys(payload), SETUP_FIELDS, '返回对象恰为五字段');
    assert.deepEqual(
      payload.installCmd,
      [join(absPath, 'bin', 'pip3'), 'install', '-r', requirementsPath],
      'venv 模式 installCmd = [<venv>/bin/pip3, install, -r, <req>]',
    );

    const creates = createCalls(calls);
    assert.equal(creates.length, 1, '先建 venv');
    assert.equal(creates[0].command, 'python3');
    assert.deepEqual(creates[0].args, ['-m', 'venv', absPath], '创建 argv 逐字');
    const installs = installCalls(calls);
    assert.equal(installs.length, 1, '再安装');
    assert.equal(installs[0].command, payload.installCmd[0]);
    assert.deepEqual(installs[0].args, payload.installCmd.slice(1), 'stub 收到的 argv 与 installCmd 同源');
    assert.ok(calls.indexOf(creates[0]) < calls.indexOf(installs[0]), '创建先于安装');

    assert.deepEqual(
      payload.venv,
      { enabled: true, created: true, adopted: false, path: absPath },
      '首跑 created:true（enabled 为生效态）',
    );
    assert.deepEqual(payload.cleanup, { oldPath: null, action: 'none' }, '首次运行无登记旧路径');
    assert.equal(payload.installExit, 0);
    // S8 通道：复跑 check_env 的第 4 参确实透传（否则是 venv-off 的默认值）
    assert.equal(payload.checkEnv.venv.enabled, true, '复跑按 venv-on 输出，非 off 默认值');
    assert.equal(payload.checkEnv.venv.path, absPath);
    assert.equal(payload.checkEnv.venv.exists, true);
    assert.ok(
      payload.checkEnv.deps.every((dep) => dep.installed === true),
      '复跑的依赖探测走 venv 解释器',
    );
  } finally {
    remove();
    restore();
  }
});

test('setup_deps venv: 调用期 user/breakSystemPackages 被忽略（installCmd 无 flag），render 注明', async () => {
  const { home, restore } = useTmpHome();
  const { root, skill, remove } = makeSkillDir();
  try {
    const absPath = join(home, 'venvs', 'current');
    const requirementsPath = join(skill, 'requirements.txt');
    const tool = setupDepsToolWith({ roots: [root], venv: venvConfig(absPath) });
    const { exec } = venvExec();

    const payload = await tool.execute(
      { user: true, breakSystemPackages: true },
      { skillRoots: [root], ...exec },
    );

    assert.deepEqual(
      payload.installCmd,
      [join(absPath, 'bin', 'pip3'), 'install', '-r', requirementsPath],
      'venv 模式不产出 --user / --break-system-packages',
    );
    const text = tool.output.render({}, payload)[0].text;
    assert.ok(
      text.includes('忽略 user/breakSystemPackages'),
      `render 须注明 venv 模式忽略调用期 flags：${text}`,
    );
  } finally {
    remove();
    restore();
  }
});

test('setup_deps venv: fs 序 = writeMarker → 清理 → writeWrapperState（testSeams 桩记录）', async () => {
  const { home, restore } = useTmpHome();
  const { root, remove } = makeSkillDir();
  try {
    const absPath = join(home, 'venvs', 'current');
    const oldPath = makeMarkedVenv(join(home, 'venvs'), 'old');
    const seams = seamRecorder({ readWrapperState: () => ({ lastVenvPath: oldPath }) });
    const tool = setupDepsToolWith({
      roots: [root],
      venv: venvConfig(absPath, { oldPathPolicy: 'delete' }),
      seams: seams.seams,
    });
    const { exec } = venvExec();

    const payload = await tool.execute({}, { skillRoots: [root], ...exec });

    assert.deepEqual(
      seams.order(),
      ['writeMarker', 'readWrapperState', 'remove', 'writeWrapperState'],
      'fs 写入次序：建 venv 写标记 → 读旧路径 → 删旧 venv → 登记新路径',
    );
    assert.deepEqual(seams.calls[0].args, [absPath], '写标记的目录＝当前 venv');
    assert.deepEqual(seams.calls.at(-1).args, [absPath], '登记的路径＝当前 venv');
    assert.deepEqual(payload.cleanup, { oldPath, action: 'deleted' }, 'delete 策略 + 四前置齐备 → deleted');
    assert.equal(existsSync(oldPath), true, '删除经 testSeams 桩：只记账，不真删');
    assert.ok(
      tool.output.render({}, payload)[0].text.includes('已删除'),
      'deleted 行 render 覆盖',
    );
  } finally {
    remove();
    restore();
  }
});

test('setup_deps venv: 既有可用 venv → 收编（零创建 argv、adopted:true、装到 venv pip）', async () => {
  const { home, restore } = useTmpHome();
  const { root, skill, remove } = makeSkillDir();
  try {
    const absPath = makeVenvFixture(join(home, 'venvs', 'current'));
    const tool = setupDepsToolWith({ roots: [root], venv: venvConfig(absPath) });
    const { exec, calls } = venvExec();

    const payload = await tool.execute({}, { skillRoots: [root], ...exec });

    assert.deepEqual(
      payload.venv,
      { enabled: true, created: false, adopted: true, path: absPath },
      '既有 venv 缺才建：收编不重建',
    );
    assert.equal(createCalls(calls).length, 0, '收编行零创建 argv');
    assert.deepEqual(payload.installCmd, [
      join(absPath, 'bin', 'pip3'),
      'install',
      '-r',
      join(skill, 'requirements.txt'),
    ]);
    assert.equal(payload.installExit, 0);
  } finally {
    remove();
    restore();
  }
});

// ── 三类「安装未执行」分支（创建失败 / 收编拒绝 / 损坏） ──────────

test('setup_deps venv: 创建失败 → venv.error、installCmd 如实、installExit=-1、render 注明未执行、仍复跑', async () => {
  const { home, restore } = useTmpHome();
  const { root, skill, remove } = makeSkillDir();
  try {
    const absPath = join(home, 'venvs', 'current');
    const tool = setupDepsToolWith({ roots: [root], venv: venvConfig(absPath) });
    const { exec, calls } = venvExec({ create: false, createExit: 1 });

    const payload = await tool.execute({}, { skillRoots: [root], ...exec });

    assert.deepEqual(Object.keys(payload), SETUP_FIELDS, '完整载荷（不 throw）');
    assert.deepEqual(
      payload.installCmd,
      [join(absPath, 'bin', 'pip3'), 'install', '-r', join(skill, 'requirements.txt')],
      'installCmd 如实给出',
    );
    assert.equal(payload.installExit, -1, '未执行 → -1');
    assert.equal(installCalls(calls).length, 0, '安装未执行：零 pip 子进程');
    assert.equal(payload.venv.enabled, true);
    assert.equal(payload.venv.created, false);
    assert.equal(payload.venv.adopted, false);
    assert.equal(payload.venv.path, absPath);
    assert.match(payload.venv.error, /创建失败/, 'venv.error 携原因');
    assert.deepEqual(payload.cleanup, { oldPath: null, action: 'none' }, '未安装成功 ⇒ 不动旧 venv');
    assert.equal(payload.checkEnv.venv.enabled, true, '仍复跑 check_env（venv-on 口径）');
    assert.equal(payload.checkEnv.venv.exists, false);
    assert.ok(
      payload.checkEnv.deps.every((dep) => dep.installed === 'UNKNOWN'),
      'venv 缺失口径：依赖全 UNKNOWN',
    );
    assert.deepEqual(payload.checkEnv.guard, { skipped: true });
    const text = tool.output.render({}, payload)[0].text;
    assert.ok(text.includes('未执行'), `render 注明未执行：${text}`);
    assert.ok(text.includes(String(payload.installExit)), 'render 仍给退出码');
  } finally {
    remove();
    restore();
  }
});

test('setup_deps venv: 目标非空非 venv（收编拒绝）→ venv.error 逐字、不创建不写标记、仍复跑', async () => {
  const { home, restore } = useTmpHome();
  const { root, remove } = makeSkillDir();
  try {
    const absPath = join(home, 'venvs', 'occupied');
    mkdirSync(absPath, { recursive: true });
    writeFileSync(join(absPath, 'user-data.txt'), 'mine\n');
    const tool = setupDepsToolWith({ roots: [root], venv: venvConfig(absPath) });
    const { exec, calls } = venvExec();

    const payload = await tool.execute({}, { skillRoots: [root], ...exec });

    assert.equal(payload.venv.error, '目标目录非空且非 venv', 'fail-loud 拒绝文案逐字');
    assert.equal(payload.installExit, -1);
    assert.equal(createCalls(calls).length, 0, '前置拒绝：连创建 argv 都没有');
    assert.equal(installCalls(calls).length, 0);
    assert.equal(existsSync(join(absPath, 'user-data.txt')), true, '既有文件零触碰');
    assert.equal(existsSync(join(absPath, VENV_MARKER)), false, '拒绝行不写所有权标记');
    assert.equal(payload.checkEnv.venv.enabled, true);
    assert.equal(payload.checkEnv.venv.exists, false);
    assert.ok(payload.checkEnv.deps.every((dep) => dep.installed === 'UNKNOWN'));
    assert.ok(tool.output.render({}, payload)[0].text.includes('未执行'), 'render 注明未执行');
  } finally {
    remove();
    restore();
  }
});

test('setup_deps venv: exists-but-broken → venv.error 含恢复指引、不自动删、复跑按 on-ready 子态', async () => {
  const { home, restore } = useTmpHome();
  const { root, remove } = makeSkillDir();
  try {
    const absPath = join(home, 'venvs', 'broken');
    mkdirSync(absPath, { recursive: true });
    writeFileSync(join(absPath, 'pyvenv.cfg'), 'home = /usr/bin\n'); // 无 bin/ → 体检不通过
    const tool = setupDepsToolWith({ roots: [root], venv: venvConfig(absPath) });
    const { exec, calls } = venvExec();

    const payload = await tool.execute({}, { skillRoots: [root], ...exec });

    assert.match(payload.venv.error, /exists-but-broken/, '损坏子态指引');
    assert.match(payload.venv.error, /手动删除/, '含恢复指引（保守：不自动删）');
    assert.equal(existsSync(join(absPath, 'pyvenv.cfg')), true, '损坏目录原样保留');
    assert.equal(installCalls(calls).length, 0);
    assert.equal(payload.installExit, -1);
    assert.equal(payload.checkEnv.venv.enabled, true);
    assert.equal(payload.checkEnv.venv.exists, true, '复跑按 on-ready 子态口径');
    assert.equal(payload.checkEnv.venv.python.found, false, 'exists=true ∧ found=false ⇒ broken 推断式');
    assert.ok(payload.checkEnv.deps.every((dep) => dep.installed === 'UNKNOWN'));
    assert.deepEqual(payload.checkEnv.guard, { skipped: true });
    assert.ok(tool.output.render({}, payload)[0].text.includes('未执行'));
  } finally {
    remove();
    restore();
  }
});

test('setup_deps venv: pip 真失败保留真实退出码 7、render 不含「未执行」、同样复跑', async () => {
  const { home, restore } = useTmpHome();
  const { root, remove } = makeSkillDir();
  try {
    const absPath = join(home, 'venvs', 'current');
    const seams = seamRecorder();
    const tool = setupDepsToolWith({
      roots: [root],
      venv: venvConfig(absPath, { oldPathPolicy: 'delete' }),
      seams: seams.seams,
    });
    const { exec } = venvExec({ installExit: 7 });

    const payload = await tool.execute({}, { skillRoots: [root], ...exec });

    assert.equal(payload.installExit, 7, '真实非零退出码原样记录');
    assert.deepEqual(
      payload.venv,
      { enabled: true, created: true, adopted: false, path: absPath },
      '安装失败不是 venv 准备失败：不置 venv.error',
    );
    assert.deepEqual(payload.cleanup, { oldPath: null, action: 'none' }, '安装未成功 ⇒ 不动旧 venv');
    assert.equal(seams.countOf('readWrapperState'), 0, '安装未成功 ⇒ 不读登记');
    assert.equal(seams.countOf('writeWrapperState'), 0, '安装未成功 ⇒ 不改登记（旧路径留待下轮成功后再清理）');
    assert.equal(seams.countOf('remove'), 0, '安装未成功 ⇒ 不删旧 venv');
    assert.equal(payload.checkEnv.venv.enabled, true, '安装失败仍复跑自检');
    const text = tool.output.render({}, payload)[0].text;
    assert.ok(!text.includes('未执行'), `安装真失败不得谎称未执行：${text}`);
    assert.ok(text.includes('install exit: 7'));
  } finally {
    remove();
    restore();
  }
});

// ── cleanup 四 action 与三类注记拼接 ─────────────────────────────

test('setup_deps venv: policy=keep + 已标记旧 venv → kept，render 含旧路径 + 手动清理/改回建议', async () => {
  const { home, restore } = useTmpHome();
  const { root, remove } = makeSkillDir();
  try {
    const absPath = join(home, 'venvs', 'current');
    const oldPath = makeMarkedVenv(join(home, 'venvs'), 'old');
    const seams = seamRecorder({ readWrapperState: () => ({ lastVenvPath: oldPath }) });
    const tool = setupDepsToolWith({ roots: [root], venv: venvConfig(absPath), seams: seams.seams });
    const { exec } = venvExec();

    const payload = await tool.execute({}, { skillRoots: [root], ...exec });

    assert.deepEqual(payload.cleanup, { oldPath, action: 'kept' }, 'keep 策略 → kept（无 error 键）');
    assert.equal(seams.countOf('remove'), 0, 'keep 策略不调删除原语');
    assert.equal(existsSync(oldPath), true, '旧 venv 原样保留');

    const text = tool.output.render({}, payload)[0].text;
    assert.ok(text.includes(oldPath), `render 含旧路径：${text}`);
    assert.ok(text.includes('手动清理'), 'render 建议手动清理');
    assert.ok(text.includes('改回'), 'render 建议改回配置以复用');
  } finally {
    remove();
    restore();
  }
});

test('setup_deps venv: 删除原语抛错 → failed + error，不 throw，render 覆盖 failed 行', async () => {
  const { home, restore } = useTmpHome();
  const { root, remove } = makeSkillDir();
  try {
    const absPath = join(home, 'venvs', 'current');
    const oldPath = makeMarkedVenv(join(home, 'venvs'), 'old');
    const seams = seamRecorder({
      readWrapperState: () => ({ lastVenvPath: oldPath }),
      remove: () => {
        throw new Error('EACCES: 删除被拒');
      },
    });
    const tool = setupDepsToolWith({
      roots: [root],
      venv: venvConfig(absPath, { oldPathPolicy: 'delete' }),
      seams: seams.seams,
    });
    const { exec } = venvExec();

    const payload = await tool.execute({}, { skillRoots: [root], ...exec });

    assert.equal(payload.cleanup.action, 'failed', '删除失败如实记录，不抛');
    assert.equal(payload.cleanup.oldPath, oldPath);
    assert.match(payload.cleanup.error, /删除失败/, 'error 携失败原因');
    assert.equal(payload.installExit, 0, '删除失败不影响安装结论');
    const text = tool.output.render({}, payload)[0].text;
    assert.ok(text.includes('删除失败'), 'failed 行 render 覆盖');
    assert.ok(text.includes(oldPath));
  } finally {
    remove();
    restore();
  }
});

test('setup_deps venv: action=none 亦可携前置拒绝原因（第三类注记，非删除失败）', async () => {
  const { home, restore } = useTmpHome();
  const { root, remove } = makeSkillDir();
  try {
    const absPath = join(home, 'venvs', 'current');
    // 登记路径＝当前路径：cleanupOldVenv 条件①拒绝 → action:'none' + 原因
    const seams = seamRecorder({ readWrapperState: () => ({ lastVenvPath: absPath }) });
    const tool = setupDepsToolWith({ roots: [root], venv: venvConfig(absPath), seams: seams.seams });
    const { exec } = venvExec();

    const payload = await tool.execute({}, { skillRoots: [root], ...exec });

    assert.equal(payload.cleanup.action, 'none', '前置拒绝 → none（不冒充删除失败）');
    assert.equal(payload.cleanup.oldPath, absPath, 'oldPath 如实');
    assert.match(payload.cleanup.error, /相同/, 'none 行携前置拒绝原因');
    assert.equal(seams.countOf('remove'), 0);
    assert.ok(tool.output.render({}, payload)[0].text.includes(absPath), 'none+error 行 render 覆盖');
  } finally {
    remove();
    restore();
  }
});

// ── testSeams 桩用例（Review Focus #5） ──────────────────────────

test('setup_deps venv: 登记写入抛错 → action 不被改写 + 「登记失败（非删除失败）」注记，安装结论不变', async () => {
  const { home, restore } = useTmpHome();
  const { root, skill, remove } = makeSkillDir();
  try {
    const absPath = join(home, 'venvs', 'current');
    const oldPath = makeMarkedVenv(join(home, 'venvs'), 'old');
    const seams = seamRecorder({
      readWrapperState: () => ({ lastVenvPath: oldPath }),
      writeWrapperState: () => {
        throw new Error('ENOTDIR: <HOME>/.ppt-master 父路径被文件占用');
      },
    });
    const tool = setupDepsToolWith({
      roots: [root],
      venv: venvConfig(absPath, { oldPathPolicy: 'delete' }),
      seams: seams.seams,
    });
    const { exec } = venvExec();

    const payload = await tool.execute({}, { skillRoots: [root], ...exec });

    assert.equal(payload.cleanup.action, 'deleted', '登记失败**不改写**清理结论');
    assert.equal(payload.cleanup.oldPath, oldPath);
    assert.match(payload.cleanup.error, /登记失败（非删除失败）/, '注记标明是登记失败而非删除失败');
    assert.equal(seams.countOf('remove'), 1, '删除原语照常调用');
    assert.deepEqual(payload.installCmd, [
      join(absPath, 'bin', 'pip3'),
      'install',
      '-r',
      join(skill, 'requirements.txt'),
    ]);
    assert.equal(payload.installExit, 0, '登记失败不影响安装结果');
    assert.deepEqual(payload.venv, { enabled: true, created: true, adopted: false, path: absPath });
  } finally {
    remove();
    restore();
  }
});

test('setup_deps venv: marker 写入抛错 → venv 仍可用（created 不变）+ 走 warn 通道（含 marker 路径）', async () => {
  const { home, restore } = useTmpHome();
  const { root, remove } = makeSkillDir();
  try {
    const absPath = join(home, 'venvs', 'current');
    const seams = seamRecorder({
      writeMarker: () => {
        throw new Error('EISDIR: marker 名位被目录占用');
      },
    });
    const tool = setupDepsToolWith({ roots: [root], venv: venvConfig(absPath), seams: seams.seams });
    const { exec } = venvExec();

    const { value: payload, warnings } = await captureWarnAsync(() =>
      tool.execute({}, { skillRoots: [root], ...exec }),
    );

    assert.deepEqual(
      payload.venv,
      { enabled: true, created: true, adopted: false, path: absPath },
      'marker 写失败不改写创建结论、不置 venv.error',
    );
    assert.equal(payload.installExit, 0);
    assert.equal(seams.countOf('writeMarker'), 1);
    assert.equal(warnings.length, 1, '写失败恰一行 warn');
    assert.ok(
      warnings[0].includes(join(absPath, VENV_MARKER)),
      `warn 应含 marker 路径：${warnings[0]}`,
    );
  } finally {
    remove();
    restore();
  }
});

test('setup_deps venv: 登记读取失败 → action=none + 注记（不冒充 failed），登记照常进行', async () => {
  const { home, restore } = useTmpHome();
  const { root, remove } = makeSkillDir();
  try {
    const absPath = join(home, 'venvs', 'current');
    const seams = seamRecorder({
      readWrapperState: () => ({ lastVenvPath: null, readError: 'EACCES: 状态文件读取被拒' }),
    });
    const tool = setupDepsToolWith({ roots: [root], venv: venvConfig(absPath), seams: seams.seams });
    const { exec } = venvExec();

    const payload = await tool.execute({}, { skillRoots: [root], ...exec });

    assert.equal(payload.cleanup.action, 'none', '读失败跳过清理（不冒充 failed）');
    assert.equal(payload.cleanup.oldPath, null, '旧路径未知');
    assert.match(payload.cleanup.error, /EACCES: 状态文件读取被拒/, '注记携真实原因');
    assert.equal(seams.countOf('remove'), 0, '读失败 ⇒ 零删除原语');
    assert.equal(seams.countOf('writeWrapperState'), 1, '读与登记正交：登记照常');
    assert.ok(tool.output.render({}, payload)[0].text.includes('EACCES'), 'render 覆盖 none+error 行');
  } finally {
    remove();
    restore();
  }
});

test('setup_deps venv: 读失败 + 登记失败同次并现 → 两类注记拼接、互不覆盖', async () => {
  const { home, restore } = useTmpHome();
  const { root, remove } = makeSkillDir();
  try {
    const absPath = join(home, 'venvs', 'current');
    const seams = seamRecorder({
      readWrapperState: () => ({ lastVenvPath: null, readError: 'EACCES: 状态文件读取被拒' }),
      writeWrapperState: () => {
        throw new Error('ENOTDIR: 父路径被文件占用');
      },
    });
    const tool = setupDepsToolWith({ roots: [root], venv: venvConfig(absPath), seams: seams.seams });
    const { exec } = venvExec();

    const payload = await tool.execute({}, { skillRoots: [root], ...exec });

    assert.match(payload.cleanup.error, /EACCES: 状态文件读取被拒/, '读失败注记保留');
    assert.match(payload.cleanup.error, /登记失败（非删除失败）/, '登记失败注记追加');
    assert.equal(payload.cleanup.action, 'none', '两类注记都不改写 action');
    assert.equal(payload.installExit, 0);
  } finally {
    remove();
    restore();
  }
});

// ── 系统模式定值（off / invalid）与零副作用断言 ──────────────────

test('setup_deps: venv off（路径合法）→ 系统模式 + 两键定值 + 四桩零调用（含删除原语）', async () => {
  const { home, restore } = useTmpHome();
  const { root, skill, remove } = makeSkillDir();
  try {
    const configured = '~/.ppt-master/venv';
    const seams = seamRecorder();
    const tool = setupDepsToolWith({
      roots: [root],
      venv: venvConfig(configured, { enabled: false, oldPathPolicy: 'delete' }),
      seams: seams.seams,
    });
    const { exec, calls } = venvExec();

    const payload = await tool.execute({ user: true }, { skillRoots: [root], ...exec });

    assert.deepEqual(
      payload.installCmd,
      ['pip3', 'install', '-r', join(skill, 'requirements.txt'), '--user'],
      '系统模式：flags 照常生效',
    );
    assert.deepEqual(
      payload.venv,
      { enabled: false, created: false, adopted: false, path: configured },
      'off 行定值：path 按配置原样（不解析）',
    );
    assert.deepEqual(payload.cleanup, { oldPath: null, action: 'none' }, 'off 行 cleanup 定值');
    assert.deepEqual(seams.order(), [], 'off 行零副作用原语（标记/登记读写、删除一律不调）');
    assert.equal(createCalls(calls).length, 0, '零 venv 创建');
    assert.equal(installCalls(calls).length, 1);
    assert.equal(installCalls(calls)[0].command, 'pip3');
    // 系统模式同样透传第 4 参：无 venv 配置时 check_env 走的是 invalid 行（path=null），
    // 故 off 行的「配置原样」只有真透传才出现。
    assert.equal(payload.checkEnv.venv.enabled, false);
    assert.equal(payload.checkEnv.venv.path, configured, '复跑同样拿到装配期 venv 配置');

    const text = tool.output.render({}, payload)[0].text;
    assert.ok(!text.includes('venv 模式忽略'), '系统模式不给 venv 模式行');
    assert.ok(!text.includes('未执行'));
  } finally {
    remove();
    restore();
  }
});

test('setup_deps: venv invalid（enabled + 相对路径）→ 系统模式、定值、零删除原语、不 throw', async () => {
  const { home, restore } = useTmpHome();
  const { root, skill, remove } = makeSkillDir();
  try {
    const seams = seamRecorder();
    const tool = setupDepsToolWith({
      roots: [root],
      venv: venvConfig('relative/venv', { oldPathPolicy: 'delete' }),
      seams: seams.seams,
    });
    const { exec, calls } = venvExec();

    const payload = await tool.execute({}, { skillRoots: [root], ...exec });

    assert.deepEqual(
      payload.installCmd,
      ['pip3', 'install', '-r', join(skill, 'requirements.txt')],
      'invalid 降级续行：系统 pip3',
    );
    assert.deepEqual(
      payload.venv,
      { enabled: false, created: false, adopted: false, path: null },
      'invalid 定值：path=null、三布尔全 false',
    );
    assert.deepEqual(payload.cleanup, { oldPath: null, action: 'none' });
    assert.deepEqual(seams.order(), [], 'invalid 不调 ensure/cleanup/write（含删除原语零调用）');
    assert.equal(createCalls(calls).length, 0);
    // 偏差 ⑲ 的两处口径差异在此并现：setup_deps 的 `enabled` 是**生效态**（invalid ⇒ false），
    // 而复跑的 check_env 子对象沿用 T8 的**配置值**口径（invalid ⇒ true）——不得互改。
    assert.equal(payload.venv.enabled, false, 'setup_deps.venv.enabled = 生效态');
    assert.equal(payload.checkEnv.venv.enabled, true, 'checkEnv.venv.enabled = 配置值（T8 口径，勿动）');
    assert.equal(payload.checkEnv.venv.path, null, '复跑的诊断面同样如实报无效');
  } finally {
    remove();
    restore();
  }
});

// ── 并发立场（no locking）两场景 ─────────────────────────────────

test('setup_deps venv 并发①：受控时序复用——创建 argv 至多一次生效，两路均得可用结论', async () => {
  const { home, restore } = useTmpHome();
  const { root, remove } = makeSkillDir();
  try {
    const absPath = join(home, 'venvs', 'current');
    const tool = setupDepsToolWith({ roots: [root], venv: venvConfig(absPath) });
    const { exec, calls } = venvExec();

    const first = await tool.execute({}, { skillRoots: [root], ...exec });
    const second = await tool.execute({}, { skillRoots: [root], ...exec });

    assert.equal(createCalls(calls).length, 1, '同一路径的创建 argv 至多一次生效');
    assert.deepEqual(
      first.venv,
      { enabled: true, created: true, adopted: false, path: absPath },
      '第一路：创建',
    );
    assert.deepEqual(
      second.venv,
      { enabled: true, created: false, adopted: true, path: absPath },
      '第二路：复用（缺才建）',
    );
    for (const [label, payload] of [['第一路', first], ['第二路', second]]) {
      assert.equal(payload.installExit, 0, `${label}可用结论`);
      assert.equal(payload.checkEnv.venv.exists, true, `${label}复跑见既有 venv`);
      assert.ok(payload.checkEnv.deps.every((dep) => dep.installed === true), `${label}依赖已装`);
    }
    // 第二路读到第一路登记的路径：同路径 → 条件①拒绝（none + 原因，非删除失败）
    assert.equal(second.cleanup.oldPath, absPath, '第一路的登记确实落盘并被第二路读回');
    assert.equal(second.cleanup.action, 'none');
  } finally {
    remove();
    restore();
  }
});

test('setup_deps venv 并发②：双建竞态失败 → 复跑自愈（不承诺最终一致）', async () => {
  const { home, restore } = useTmpHome();
  const { root, remove } = makeSkillDir();
  try {
    const absPath = join(home, 'venvs', 'current');
    const tool = setupDepsToolWith({ roots: [root], venv: venvConfig(absPath) });
    // 竞态：本路的 `python3 -m venv` 非零退出，但对手已把 venv 建成（落盘照做）。
    const { exec, calls } = venvExec({ create: true, createExit: 1 });

    const raced = await tool.execute({}, { skillRoots: [root], ...exec });

    assert.match(raced.venv.error, /创建失败/, '竞态轮：创建失败如实记录');
    assert.equal(raced.installExit, -1, '竞态轮：安装未执行');
    assert.equal(raced.checkEnv.venv.exists, true, '复跑观察到对手建成的 venv');
    assert.ok(
      raced.checkEnv.deps.every((dep) => dep.installed === true),
      '复跑得可用结论',
    );

    const healed = await tool.execute({}, { skillRoots: [root], ...exec });

    assert.deepEqual(
      healed.venv,
      { enabled: true, created: false, adopted: true, path: absPath },
      '重跑自愈：收编既有 venv',
    );
    assert.equal(healed.installExit, 0, '重跑安装成功（不承诺最终一致，只断言复跑结论）');
    assert.equal(createCalls(calls).length, 1, '创建 argv 仍只有竞态那一轮');
  } finally {
    remove();
    restore();
  }
});

// ── abort 传播（ensureVenv 的唯一 never-rejects 例外） ────────────

test('setup_deps venv: ensureVenv 的 abort rejection 原样传播（不得折成 venv.error）', async () => {
  const { home, restore } = useTmpHome();
  const { root, remove } = makeSkillDir();
  try {
    const absPath = join(home, 'venvs', 'current');
    const tool = setupDepsToolWith({ roots: [root], venv: venvConfig(absPath) });

    // 变体 A：创建子进程以 AbortError reject（spawn 的 error 事件形态）
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const callsA = [];
    await assert.rejects(
      () =>
        tool.execute({}, {
          skillRoots: [root],
          run: async (command, args) => {
            callsA.push({ command, args });
            throw abortError;
          },
        }),
      (error) => error === abortError,
      '取消原样抛出，不得折叠成 venv.error',
    );
    assert.equal(installCalls(callsA).length, 0, '取消不得继续安装');

    // 变体 B：signal 被中止后创建 close(null) → 抛 signal.reason
    const reason = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const signal = { aborted: false, reason, throwIfAborted() {} };
    const callsB = [];
    await assert.rejects(
      () =>
        tool.execute({}, {
          skillRoots: [root],
          signal,
          run: async (command, args) => {
            callsB.push({ command, args });
            signal.aborted = true;
            return { stdout: '', stderr: '', exitCode: null };
          },
        }),
      (error) => error === reason,
      'null 退出码 + 已中止 signal → 传播 signal.reason',
    );
    assert.equal(installCalls(callsB).length, 0);
  } finally {
    remove();
    restore();
  }
});
