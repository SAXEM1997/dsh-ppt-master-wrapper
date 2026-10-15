import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
 * Task 7 契约：`ppt_master_setup_deps` 工具（幂等安装 + 复跑自检）。
 *
 * 三块被测面：
 *
 * 1. **纯函数** `buildPipArgs(requirementsPath, opts)`——参数四组合（默认/
 *    `user`/`breakSystemPackages`/两者）；**不含** `pip3` 前缀、flags 顺序固定
 *    （`--user` 在前、`--break-system-packages` 在后）。
 * 2. **工具形态**——`parameters` 两可选布尔、`output.schema` 三字段且嵌套
 *    `checkEnv` 复用 T6 诊断形态（逐层 `AP:false`、无 `type:'json'`）。
 * 3. **执行序列与边界**（全部 stub exec，无网络、不依赖真实 pip/python3）：
 *    `install`（`pip3 install …`）→ `check_env` 子进程组；`installExit` 只记录
 *    退出码、**不 throw**；无 skill 目录 → **throw**（fail-loud）；`exec.signal`
 *    在入口即被检查。
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

/** 返回对象 / `output.schema` 的逐字字段集。 */
const SETUP_FIELDS = ['installCmd', 'installExit', 'checkEnv'];

/** T6 诊断对象的逐字字段集（嵌套 `checkEnv` 复用该形态）。 */
const DIAGNOSTIC_FIELDS = ['python', 'guard', 'deps', 'envFileExists'];

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

test('setup_deps: output.schema 属性集=三字段、嵌套 checkEnv 复用 T6 逐字形态', () => {
  const { schema } = toolNamed('ppt_master_setup_deps').output;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false, '根层 AP:false');
  assert.equal(schema.type === 'json', false, "不得用 type:'json'（SDK 静默降级为空契约）");
  assert.deepEqual(Object.keys(schema.properties), SETUP_FIELDS, '属性集即返回对象三字段');
  assert.deepEqual(schema.properties.installCmd, { type: 'array', items: { type: 'string' } });
  assert.deepEqual(schema.properties.installExit, { type: 'number' });

  // 嵌套 checkEnv：与 T6 工具 output.schema 同一形态（同一构造器产出），逐层 AP:false。
  const checkEnv = schema.properties.checkEnv;
  assert.equal(checkEnv.type, 'object');
  assert.equal(checkEnv.additionalProperties, false);
  assert.deepEqual(Object.keys(checkEnv.properties), DIAGNOSTIC_FIELDS, 'checkEnv 属性集=诊断四字段');
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

    assert.deepEqual(Object.keys(payload), SETUP_FIELDS, '返回对象恰为三字段');
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
