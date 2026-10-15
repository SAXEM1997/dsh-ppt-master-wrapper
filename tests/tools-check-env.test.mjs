import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTools, mapDistToImport, parseRequirements } from '../lib/tools.js';

/**
 * 本包**零 npm 依赖**（package.json 无 dependencies），所以 SDK 校验器只在本机
 * 恰好能解析到时才加载——解析不到就跳过该条断言，绝不让测试依赖宿主安装。
 *
 * 候选解析基点按「本包 → 环境变量 `DSH_HOME` 的 profiles/web」顺序尝试，全部失败
 * 即视为「本机未安装 SDK」。
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

let assertSupportedJsonSchema = loadSdkSchemaValidator();

/**
 * Task 6 契约：`ppt_master_check_env` 工具（依赖探测元数据一等）。
 *
 * 三块被测面：
 *
 * 1. **纯函数** `parseRequirements` / `mapDistToImport`——fixture 驱动的解析边界
 *    （钉扎/extras/注释/`-r`/`--`/空行/大小写）与 DIST_TO_IMPORT 映射表查询。
 * 2. **诊断对象形态**——`python` / `guard` / `deps` / `envFileExists` 四字段，以及
 *    `deps[].dist === deps[].importName` 的字面形态回显。
 * 3. **子进程边界语义**（全部 stub exec，无网络、不依赖真实 python3）：
 *    - 退出码 1 + stderr 含 `PackageNotFoundError` → `installed: false`
 *    - 非零退出且**非** PackageNotFoundError（ImportError/MemoryError…）→ `'UNKNOWN'`
 *    - spawn 级失败（ENOENT）→ `python.found === false`、`guard.skipped === true`、
 *      deps 全 `'UNKNOWN'`，且**整体不 throw**
 *
 * `guard.ran.exitCode` 只记录不映射工具级失败（本文件用退出码 3 锁这一点）。
 */

/** 本任务唯一工具在 `createTools()` 中的位置（brief：数组第二项）。 */
const CHECK_ENV_INDEX = 1;

/** 工具入参 schema：无参数（与 T4 stub 逐字相同）。 */
const EMPTY_PARAMETERS = { type: 'object', properties: {}, additionalProperties: false };

/** 诊断对象四字段的逐字名单（output.schema 属性集 = 返回对象字段集）。 */
const DIAGNOSTIC_FIELDS = ['python', 'guard', 'deps', 'envFileExists'];

/** fixture 的依赖真值（诊断对象里的 `deps[].dist`，`envFileExists` 用例已写盘）。 */
const FIXTURE_DIST_ALL = [
  'pyyaml',
  'python-pptx',
  'skia-pathops',
  'pillow',
  'flask',
  'beautifulsoup4',
  'xlsxwriter',
  'google-genai',
  'edge-tts',
];

/** fixture 的解析真值（已归一化小写，首次出现顺序，去重）。 */
const FIXTURE_DISTS = [
  'pyyaml',
  'python-pptx',
  'skia-pathops',
  'pillow',
  'flask',
  'beautifulsoup4',
  'xlsxwriter',
  'google-genai',
  'edge-tts',
];

const REQUIREMENTS_FIXTURE = new URL('./fixtures/requirements-fixture.txt', import.meta.url);

/** `createTools()` 中某个工具定义，按 name 精确查找。 */
function toolNamed(name) {
  return createTools().find((tool) => tool.name === name);
}

// ─── exec stub ───────────────────────────────────────────────────

/** spawn 级失败（python3 不存在）：Node 抛出的 ENOENT 形态。 */
function enoentError(command) {
  const error = new Error(`spawn ${command} ENOENT`);
  error.code = 'ENOENT';
  return error;
}

/**
 * 造一个可注入的 `exec` 助手。
 *
 * `run(command, args, options)` 逐字对齐（命令, 参数, 选项）三元组——实现里必须把
 * argv 与 signal 透传给这一层，所以 stub 能同时对「调了什么」和「怎么传信号」做断言。
 */
function stubExec(run, extra = {}) {
  return { run, ...extra };
}

/**
 * 「环境齐全」的 exec stub：python3 存在（3.11.2）、每个 `-c` 查询成功、
 * 每个 `--version` 成功、guard 退出码 3。
 *
 * `metadataAnswer(dist)` 决定该发行版的元数据子进程返回什么。
 */
function healthyExec({ metadataAnswer, onCall } = {}) {
  return stubExec(async (command, args, options) => {
    onCall?.(command, args, options);
    if (command !== 'python3') throw enoentError(command);
    if (args.includes('--version')) return { stdout: 'Python 3.11.2\n', stderr: '', exitCode: 0 };
    if (String(args.at(-1)).endsWith('.py')) {
      return { stdout: 'guard fixture\n', stderr: '', exitCode: 3 };
    }
    const dist = metadataDists(args).at(-1);
    const answer = metadataAnswer?.(dist) ?? { found: true, version: `${dist}-1.0.0` };
    if (answer.raw) return answer.raw;
    if (answer.spawnFailure) throw enoentError('python3');
    if (answer.found) {
      return { stdout: `${answer.version}\n`, stderr: '', exitCode: 0 };
    }
    return {
      stdout: '',
      stderr: 'Traceback (most recent call last):\nimportlib.metadata.PackageNotFoundError: No package metadata was found for X\n',
      exitCode: 1,
    };
  });
}

/**
 * 从一条 `python3 -c …` 调用里取回实现问到的发行版名。
 *
 * 实现把脚本放在 `-c` 之后、发行版名放在**最后一个参数**（`python3 -c <script> <dist>`），
 * 因此这里取 `args.at(-1)` 的裸 token；`version("…")` 形态只作为回退匹配，两种
 * argv 布局都能被这个 stub 识别。
 */
function metadataDists(args) {
  const last = String(args.at(-1) ?? '');
  const script = String(args[1] ?? '');
  // 裸 token 尾参（`python3 -c <script> <dist>`）优先；否则回退到脚本里的字面量形态。
  if (last !== '' && last !== script && !last.endsWith(')')) return [last];
  return [...script.matchAll(/version\("([^"]+)"\)/g)].map((match) => match[1]);
}

/** 造一个临时 skill 目录树（含 `scripts/attribution_guard.py`、可选 `.env`）。 */
function makeSkillRoot({ withGuard = true, withEnvFile = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'check-env-'));
  const skill = join(root, 'ppt-master');
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, 'SKILL.md'),
    ['---', 'name: ppt-master', 'description: fixture skill', '---', '', '# fixture', ''].join('\n'),
  );
  if (withGuard) {
    mkdirSync(join(skill, 'scripts'), { recursive: true });
    writeFileSync(join(skill, 'scripts', 'attribution_guard.py'), 'print("guard fixture")\n');
  }
  if (withEnvFile) writeFileSync(join(skill, '.env'), 'SECRET=do-not-read\n');
  return { root, skill, remove: () => rmSync(root, { recursive: true, force: true }) };
}

/** 造一个临时 requirements.txt 并返回其路径（写盘以锁「实现 self-parse」这一路径）。 */
function makeRequirementsFile(lines) {
  const directory = mkdtempSync(join(tmpdir(), 'check-env-req-'));
  const file = join(directory, 'requirements.txt');
  writeFileSync(file, lines.join('\n'));
  return { file, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

// ─── 工具形态（schema 逐字） ─────────────────────────────────────

test('check_env: createTools()[1] name 逐字 ppt_master_check_env、parameters 与 stub 同形态', () => {
  const tool = createTools()[CHECK_ENV_INDEX];
  assert.equal(tool.name, 'ppt_master_check_env');
  assert.deepEqual(tool.parameters, EMPTY_PARAMETERS);
});

test('check_env: description 为中英双语短句（一句中文 + 一句英文）', () => {
  const { description } = toolNamed('ppt_master_check_env');
  assert.equal(typeof description, 'string');
  const parts = description.split('/').map((part) => part.trim()).filter(Boolean);
  assert.equal(parts.length, 2, `description 恰为两段（中/英）：${description}`);
  assert.match(parts[0], /[\u4e00-\u9fff]/, '第一段为中文');
  assert.match(parts[1], /^[\x20-\x7e]+$/, '第二段为 ASCII 英文');
  const lowered = parts[1].toLowerCase();
  assert.ok(lowered.includes('ppt-master'), '英文段点明 ppt-master');
  assert.ok(/env|depend/.test(lowered), '英文段点明环境/依赖探测');
});

test('check_env: output.schema 嵌套逐字（python/guard/deps/envFileExists，每层 AP:false）', () => {
  const { schema } = toolNamed('ppt_master_check_env').output;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.type === 'json', false, "不得用 type:'json'（SDK 静默降级为空契约）");
  assert.deepEqual(Object.keys(schema.properties), DIAGNOSTIC_FIELDS, '属性集即诊断四字段');

  // python：version 可空（oneOf 形态）、meetsSkillRequirement 三态可空布尔。
  assert.equal(schema.properties.python.type, 'object');
  assert.deepEqual(Object.keys(schema.properties.python.properties), [
    'found',
    'version',
    'meetsSkillRequirement',
  ]);
  assert.equal(schema.properties.python.additionalProperties, false);
  assert.deepEqual(schema.properties.python.properties.found, { type: 'boolean' });
  assert.deepEqual(schema.properties.python.properties.version, {
    oneOf: [{ type: 'string' }, { type: 'null' }],
  });
  assert.deepEqual(schema.properties.python.properties.meetsSkillRequirement, {
    oneOf: [{ type: 'boolean' }, { type: 'null' }],
  });

  // guard：ran 形态（ran/exitCode）与 skipped 形态的二选一。
  // `const` 必须带同级 `type`——SDK 的 assertSupportedJsonSchema 拒绝裸 const
  // （`requires type or oneOf`），故写法为 `{type:'boolean', const:true}`。
  assert.deepEqual(schema.properties.guard, {
    oneOf: [
      {
        type: 'object',
        properties: { ran: { type: 'boolean', const: true }, exitCode: { type: 'number' } },
        required: ['ran', 'exitCode'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { skipped: { type: 'boolean', const: true } },
        required: ['skipped'],
        additionalProperties: false,
      },
    ],
  });

  // deps：数组元素 object-rooted、逐字段声明、元素层同样 AP:false。
  assert.equal(schema.properties.deps.type, 'array');
  assert.equal(schema.properties.deps.items.type, 'object');
  assert.deepEqual(Object.keys(schema.properties.deps.items.properties), [
    'dist',
    'importName',
    'installed',
    'source',
  ]);
  assert.equal(schema.properties.deps.items.additionalProperties, false);
  assert.deepEqual(schema.properties.deps.items.properties.dist, { type: 'string' });
  assert.deepEqual(schema.properties.deps.items.properties.importName, { type: 'string' });
  assert.deepEqual(schema.properties.deps.items.properties.installed, {
    oneOf: [{ type: 'boolean' }, { type: 'string', const: 'UNKNOWN' }],
  });
  assert.deepEqual(schema.properties.deps.items.properties.source, {
    type: 'string',
    enum: ['metadata', 'import', 'unknown'],
  });

  assert.deepEqual(schema.properties.envFileExists, { type: 'boolean' });
});

test('check_env: schema 通过 SDK 的 assertSupportedJsonSchema（可解析到 SDK 时）', (t) => {
  if (assertSupportedJsonSchema === null) {
    t.skip('@deepseek-ai/dsh-tools 不可解析（本包零依赖，非失败）');
    return;
  }
  // 关键回归点：`const`/`enum` 必须带同级 `type`，否则 SDK 报
  // "requires type or oneOf" 并拒收整个工具定义。
  assertSupportedJsonSchema(toolNamed('ppt_master_check_env').output.schema);
});

test('check_env: output.render 为函数且返回含探测结论的 text 内容块数组', async () => {
  const { root, skill, remove } = makeSkillRoot({ withEnvFile: true });
  try {
    writeFileSync(join(skill, 'requirements.txt'), 'PyYAML\nflask\n');
    const tool = toolNamed('ppt_master_check_env');
    assert.equal(typeof tool.output.render, 'function');
    const payload = await tool.execute({}, { skillRoots: [root], ...healthyExec() });
    const rendered = tool.output.render({}, payload);
    // 宿主管线契约：render 返回内容块数组（同 tools-info 测试内注记）。
    assert.ok(Array.isArray(rendered), 'render 返回内容块数组');
    assert.equal(rendered.length, 1, '单个内容块');
    assert.equal(rendered[0].type, 'text', '块类型为 text');
    assert.equal(typeof rendered[0].text, 'string');
    const text = rendered[0].text;
    assert.ok(text.includes('python3'), 'render 点出 python3');
    assert.ok(text.includes('guard'), 'render 点出 guard 结论');
    assert.ok(text.includes('pyyaml'), 'render 逐项列出依赖');
    assert.ok(text.includes(String(payload.guard.exitCode)), 'render 点出 guard 退出码');
  } finally {
    remove();
  }
});

// ─── 纯函数：mapDistToImport ─────────────────────────────────────

test('mapDistToImport: 映射表命中（大小写不敏感）', () => {
  assert.equal(mapDistToImport('PyYAML'), 'yaml');
  assert.equal(mapDistToImport('skia-pathops'), 'pathops');
  assert.equal(mapDistToImport('PILLOW'), 'PIL');
  assert.equal(mapDistToImport('python-pptx'), 'pptx');
  assert.equal(mapDistToImport('beautifulsoup4'), 'bs4');
  assert.equal(mapDistToImport('PyMuPDF'), 'fitz');
  assert.equal(mapDistToImport('XlsxWriter'), 'xlsxwriter');
  assert.equal(mapDistToImport('google-genai'), 'google.genai');
  assert.equal(mapDistToImport('edge-tts'), 'edge_tts');
});

test('mapDistToImport: vendor requirements 缺失的 10 项补齐（dist 名=import 名，逐项核实）', () => {
  // 依据：vendor 树自身脚本的 import 语句（最强证据，非猜测）——
  //   import uharfbuzz / import mammoth / from markdownify … / from ebooklib …
  //   from nbconvert … / import openpyxl / import numpy / import requests
  //   from curl_cffi … / from flask …
  // 十项的发行版名与 import 根名逐一核实一致（PyPI 惯例同判：如 EbookLib 的
  // 规范化 dist 名即 ebooklib，curl-cffi 的 import 根即 curl_cffi）。
  const directMappings = {
    uharfbuzz: 'uharfbuzz',
    mammoth: 'mammoth',
    markdownify: 'markdownify',
    ebooklib: 'ebooklib',
    nbconvert: 'nbconvert',
    openpyxl: 'openpyxl',
    numpy: 'numpy',
    requests: 'requests',
    curl_cffi: 'curl_cffi',
    flask: 'flask',
  };
  for (const [dist, importName] of Object.entries(directMappings)) {
    assert.equal(mapDistToImport(dist), importName, `${dist} → ${importName}`);
    assert.equal(
      mapDistToImport(dist.toUpperCase()),
      importName,
      `${dist.toUpperCase()}（大小写归一后）→ ${importName}`,
    );
  }
});

/** vendor 真实 requirements.txt 的 19 项清单（fixture 化，勿依赖 vendor 树本体）。 */
const VENDOR_REQUIREMENTS_TEXT = [
  'PyYAML>=6.0',
  'python-pptx>=0.6.21',
  'XlsxWriter>=3.0.0',
  'skia-pathops>=0.9.2',
  'uharfbuzz>=0.50.0',
  'edge-tts>=7.2.8',
  'PyMuPDF>=1.23.0',
  'mammoth>=1.6.0',
  'markdownify>=0.11.6',
  'ebooklib>=0.18',
  'nbconvert>=7.0.0',
  'openpyxl>=3.1.0',
  'Pillow>=9.0.0',
  'numpy>=1.20.0',
  'requests>=2.31.0',
  'beautifulsoup4>=4.12.0',
  'curl_cffi>=0.7.0',
  'google-genai>=1.0.0',
  'flask>=3.0.0',
].join('\n');

test('mapDistToImport: 覆盖度回归——vendor 真实 requirements.txt 19 项逐项非 UNKNOWN（19/19）', () => {
  const dists = parseRequirements(VENDOR_REQUIREMENTS_TEXT);
  assert.equal(dists.length, 19, 'fixture 化清单恰为 vendor 的 19 项');
  for (const dist of dists) {
    assert.notEqual(
      mapDistToImport(dist),
      'UNKNOWN',
      `${dist} 必须有映射：vendor requirements 不得再产出 UNKNOWN`,
    );
  }
});

test('mapDistToImport: 未收录发行版 → 逐字 UNKNOWN', () => {
  assert.equal(mapDistToImport('not-a-real-dist'), 'UNKNOWN');
  assert.equal(mapDistToImport('pandas'), 'UNKNOWN', 'pandas 不在映射表内（表外仍 UNKNOWN）');
  assert.equal(mapDistToImport(''), 'UNKNOWN');
  assert.equal(mapDistToImport(undefined), 'UNKNOWN');
});

test('mapDistToImport: 原型链键 → 逐字 UNKNOWN（不得泄漏 Object.prototype 成员）', () => {
  // 裸 `TABLE[key]` 查表会沿原型链命中 Object.prototype：'__proto__' 返回对象、
  // 'constructor' 返回函数——两者都不是字符串，会污染 deps[].importName 的字面
  // 契约（output.schema 声明 string）。own-property 查表把它们归入 UNKNOWN。
  assert.equal(mapDistToImport('__proto__'), 'UNKNOWN', '__proto__ 必须归 UNKNOWN');
  assert.equal(mapDistToImport('constructor'), 'UNKNOWN', 'constructor 必须归 UNKNOWN');
  assert.equal(mapDistToImport('toString'), 'UNKNOWN');
  assert.equal(mapDistToImport('hasOwnProperty'), 'UNKNOWN');
  assert.equal(mapDistToImport('valueOf'), 'UNKNOWN');
  assert.equal(mapDistToImport('__PROTO__'), 'UNKNOWN', '大小写归一后仍须 own 判定');
  assert.equal(mapDistToImport('CONSTRUCTOR'), 'UNKNOWN');
  // 逐字串契约：任何不在表内的键都必须是字符串 UNKNOWN，绝非对象/函数。
  for (const key of ['__proto__', 'constructor', 'toString', 'prototype']) {
    assert.equal(typeof mapDistToImport(key), 'string', `${key} 必须返回字符串`);
  }
});

test('mapDistToImport: 原型键防护不回归合法键', () => {
  assert.equal(mapDistToImport('pyyaml'), 'yaml');
  assert.equal(mapDistToImport('python-pptx'), 'pptx');
  assert.equal(mapDistToImport('edge-tts'), 'edge_tts');
});

// ─── 纯函数：parseRequirements ───────────────────────────────────

test('parseRequirements: fixture 输出正确的发行版列表（含边界形态）', () => {
  const text = readFileSync(REQUIREMENTS_FIXTURE, 'utf8');
  const parsed = parseRequirements(text);
  assert.deepEqual(parsed, FIXTURE_DISTS, 'fixture 解析真值（小写、去重、保序）');
  for (const dist of parsed) {
    assert.doesNotMatch(dist, /[#>=<~\[\]\s]/, `剥净钉扎/extras/注释：${dist}`);
  }
  assert.equal(
    parsed.filter((dist) => dist === 'pyyaml').length,
    1,
    '大小写变体 pyyaml/PyYAML 合并为一项',
  );
  assert.ok(!parsed.some((dist) => dist.startsWith('-')), '`-r`/`--` 行不产出条目');
});

test('parseRequirements: 钉扎/extras/注释/空行/`-r`/大小写逐项断言', () => {
  const text = [
    '# 全行注释',
    '',
    '   ',
    'PyYAML==6.0.1',
    'python-pptx[image]>=0.6.21',
    'Pillow >= 10.0, < 11   # 行内注释',
    '-r requirements-dev.txt',
    '--index-url https://pypi.org/simple',
    '-e .',
    'pyyaml',
    '  Flask  ',
    'beautifulsoup4~=4.12',
    'PyMuPDF',
  ].join('\n');
  assert.deepEqual(parseRequirements(text), [
    'pyyaml',
    'python-pptx',
    'pillow',
    'flask',
    'beautifulsoup4',
    'pymupdf',
  ]);
});

test('parseRequirements: 空文本/无有效行 → 空数组（不 throw）', () => {
  assert.deepEqual(parseRequirements(''), []);
  assert.deepEqual(parseRequirements('\n\n# only a comment\n-r a.txt\n'), []);
  assert.deepEqual(parseRequirements(undefined), []);
});

// ─── 真实子进程（无 stub；不依赖具体发行版存在） ─────────────────

test('check_env: fixture requirements 走真实 python3（子进程 argv 布局可用，结论自洽）', async () => {
  const { root, skill, remove } = makeSkillRoot();
  try {
    writeFileSync(join(skill, 'requirements.txt'), readFileSync(REQUIREMENTS_FIXTURE, 'utf8'));
    const payload = await toolNamed('ppt_master_check_env').execute(
      { requirementsPath: join(skill, 'requirements.txt') },
      { skillRoots: [root] },
    );
    assert.deepEqual(
      payload.deps.map((dep) => dep.dist),
      FIXTURE_DIST_ALL,
      'fixture 全量发行版逐个探测',
    );
    assert.ok(
      ['setuptools', 'pip'].every((name) => !FIXTURE_DIST_ALL.includes(name)),
      'fixture 本身不含必然存在的发行版（本断言只锁 fixture 口径）',
    );
    for (const dep of payload.deps) {
      assert.ok(
        dep.installed === true || dep.installed === false || dep.installed === 'UNKNOWN',
        'installed 为三态之一',
      );
      if (payload.python.found === false) {
        assert.equal(dep.installed, 'UNKNOWN', '无 python3 时不产出任何 false');
        assert.equal(dep.source, 'unknown');
      }
    }
    if (payload.python.found) {
      assert.deepEqual(payload.guard, { ran: true, exitCode: 0 }, 'fixture guard 正常退出');
      // 元数据一等：任何 true/false 结论都来自 metadata（不是 import 侧写）。
      for (const dep of payload.deps) {
        if (dep.installed !== 'UNKNOWN') assert.equal(dep.source, 'metadata');
      }
    }
  } finally {
    remove();
  }
});

// ─── 诊断对象：环境齐全（exec stub 元数据一等） ───────────────────

test('check_env: python 元数据 hit → installed:true、source:metadata、importName 映射、≥3.10 informational', async () => {
  const { root, skill, remove } = makeSkillRoot({ withGuard: true, withEnvFile: true });
  try {
    const { file, remove: removeReq } = makeRequirementsFile(['PyYAML', 'python-pptx', 'flask']);
    try {
      const payload = await toolNamed('ppt_master_check_env').execute(
        { requirementsPath: file },
        { skillRoots: [root], ...healthyExec() },
      );

      assert.deepEqual(Object.keys(payload), DIAGNOSTIC_FIELDS, '返回对象恰为诊断四字段');
      assert.deepEqual(payload.python, {
        found: true,
        version: '3.11.2',
        meetsSkillRequirement: true,
      });
      assert.deepEqual(payload.guard, { ran: true, exitCode: 3 }, 'guard 退出码仅记录');
      assert.deepEqual(payload.deps, [
        { dist: 'pyyaml', importName: 'yaml', installed: true, source: 'metadata' },
        { dist: 'python-pptx', importName: 'pptx', installed: true, source: 'metadata' },
        { dist: 'flask', importName: 'flask', installed: true, source: 'metadata' },
      ]);
      assert.equal(payload.envFileExists, true, '存在性检查：<SKILL_DIR>/.env');
      assert.equal(skill, join(root, 'ppt-master'));
    } finally {
      removeReq();
    }
  } finally {
    remove();
  }
});

test('check_env: 缺 requirementsPath → 回落 SKILL_DIR/requirements.txt（<3.10 仅 informational）', async () => {
  const restoreHome = isolateHome().restore;
  const { root, skill, remove } = makeSkillRoot();
  try {
    writeFileSync(join(skill, 'requirements.txt'), 'PyYAML\nflask\n');
    const payload = await toolNamed('ppt_master_check_env').execute({}, {
      skillRoots: [root],
      run: async (command, args) => {
        if (command !== 'python3') throw enoentError(command);
        // 低于技能下限的解释器：只影响 informational 结论，不影响 deps。
        if (args.includes('--version')) return { stdout: 'Python 3.9.18\n', stderr: '', exitCode: 0 };
        if (String(args.at(-1)).endsWith('.py')) return { stdout: '', stderr: '', exitCode: 0 };
        return { stdout: '1.0.0\n', stderr: '', exitCode: 0 };
      },
    });
    assert.deepEqual(payload.python.version, '3.9.18');
    assert.equal(payload.python.meetsSkillRequirement, false, '≥3.10 仅 informational');
    assert.deepEqual(
      payload.deps.map((dep) => dep.dist),
      ['pyyaml', 'flask'],
      '回落 SKILL_DIR/requirements.txt',
    );
    assert.equal(payload.deps[0].installed, true, '低于下限不阻断依赖探测');
    assert.equal(payload.envFileExists, false, '无 .env → false（不读其内容）');
  } finally {
    restoreHome();
    remove();
  }
});

test('check_env: python --version stdout 为空串 → 回退解析 stderr（version/found 不丢）', async () => {
  const { root, remove } = makeSkillRoot();
  try {
    const { file, remove: removeReq } = makeRequirementsFile(['PyYAML']);
    try {
      const payload = await toolNamed('ppt_master_check_env').execute(
        { requirementsPath: file },
        {
          skillRoots: [root],
          run: async (command, args) => {
            if (command !== 'python3') throw enoentError(command);
            // stdout 为**空串**（非 undefined）：?? 不会回退到 stderr，版本信息
            // 只出现在 stderr（如某些构建/管道场景下的真实 spawn 形态）。
            if (args.includes('--version')) return { stdout: '', stderr: 'Python 3.11.2\n', exitCode: 0 };
            if (String(args.at(-1)).endsWith('.py')) return { stdout: '', stderr: '', exitCode: 0 };
            return { stdout: '1.0.0\n', stderr: '', exitCode: 0 };
          },
        },
      );
      assert.deepEqual(payload.python, {
        found: true,
        version: '3.11.2',
        meetsSkillRequirement: true,
      }, '空串 stdout 必须回退 stderr 解析版本');
    } finally {
      removeReq();
    }
  } finally {
    remove();
  }
});

// ─── 诊断对象：三类退出码边界（stub exec） ───────────────────────

test('check_env: python 退出码 1 + stderr PackageNotFoundError → installed:false、source:metadata', async () => {
  const { root, remove } = makeSkillRoot();
  try {
    const { file, remove: removeReq } = makeRequirementsFile(['PyYAML', 'flask']);
    try {
      const payload = await toolNamed('ppt_master_check_env').execute(
        { requirementsPath: file },
        {
          skillRoots: [root],
          ...healthyExec({
            metadataAnswer: (dist) =>
              dist === 'pyyaml' ? { found: false } : { found: true, version: '3.0.1' },
          }),
        },
      );
      assert.deepEqual(payload.deps[0], {
        dist: 'pyyaml',
        importName: 'yaml',
        installed: false,
        source: 'metadata',
      });
      assert.deepEqual(payload.deps[1], {
        dist: 'flask',
        importName: 'flask',
        installed: true,
        source: 'metadata',
      });
    } finally {
      removeReq();
    }
  } finally {
    remove();
  }
});

test('check_env: python 非零退出且非 PackageNotFoundError（ImportError/MemoryError）→ UNKNOWN、source:unknown（不误报 false）', async () => {
  const { root, remove } = makeSkillRoot();
  try {
    for (const stderr of [
      'ImportError: cannot import name importlib\n',
      'MemoryError\n',
      'Traceback (most recent call last):\nModuleNotFoundError: No module named importlib.metadata\n',
    ]) {
      const { file, remove: removeReq } = makeRequirementsFile(['PyYAML']);
      try {
        const payload = await toolNamed('ppt_master_check_env').execute(
          { requirementsPath: file },
          {
            skillRoots: [root],
            ...healthyExec({
              metadataAnswer: () => ({ raw: { stdout: '', stderr, exitCode: 2 } }),
            }),
          },
        );
        assert.deepEqual(
          payload.deps[0],
          { dist: 'pyyaml', importName: 'yaml', installed: 'UNKNOWN', source: 'unknown' },
          `python 级失败必须 UNKNOWN 而非 false：${stderr.split('\n')[0]}`,
        );
      } finally {
        removeReq();
      }
    }
  } finally {
    remove();
  }
});

test('check_env: python 退出码 0 但 stdout 为空 → UNKNOWN、source:unknown（探测失败≠未安装）', async () => {
  const { root, remove } = makeSkillRoot();
  try {
    const { file, remove: removeReq } = makeRequirementsFile(['PyYAML']);
    try {
      const payload = await toolNamed('ppt_master_check_env').execute(
        { requirementsPath: file },
        {
          skillRoots: [root],
          ...healthyExec({ metadataAnswer: () => ({ raw: { stdout: '', stderr: '', exitCode: 0 } }) }),
        },
      );
      assert.deepEqual(payload.deps[0], {
        dist: 'pyyaml',
        importName: 'yaml',
        installed: 'UNKNOWN',
        source: 'unknown',
      });
    } finally {
      removeReq();
    }
  } finally {
    remove();
  }
});

// ─── import 辅助探测（元数据 UNKNOWN 时的第二意见，spec §3.5） ────
//
// spec §3.5：import 探测仅作**辅助**，且必须经 dist→import 映射表转换后执行；
// 映射缺失时该项标记 UNKNOWN（非 FAIL）。触发时机=元数据查询 python 级失败
// （非 PNFE 非零退出）且 python.found 且映射存在；退出码语义与元数据通道对齐：
// 0 → true；1+ModuleNotFoundError → false；其他 → 维持 UNKNOWN。

/**
 * 「元数据 python 级失败」的 exec stub：`--version` 成功（python.found=true）、
 * guard 正常退出、元数据查询一律 ImportError 形态的非零退出（exit 2）。
 *
 * 辅助探测（`python3 -c "import <mod>"`）的返回由 `importAnswer()` 决定；
 * 每次调用按序记入 `calls`（`metadata:<dist>` / `import:<script>`），供调用序断言。
 */
function metadataBrokenExec({ importAnswer, calls } = {}) {
  return stubExec(async (command, args) => {
    if (command !== 'python3') throw enoentError(command);
    if (args.includes('--version')) return { stdout: 'Python 3.11.2\n', stderr: '', exitCode: 0 };
    if (String(args.at(-1)).endsWith('.py')) return { stdout: '', stderr: '', exitCode: 0 };
    const script = String(args[1] ?? '');
    if (script.includes('importlib.metadata')) {
      calls?.push(`metadata:${args.at(-1)}`);
      return { stdout: '', stderr: 'ImportError: cannot import name importlib\n', exitCode: 2 };
    }
    calls?.push(`import:${script}`);
    return importAnswer?.() ?? { stdout: '', stderr: '', exitCode: 0 };
  });
}

test('check_env: 元数据 python 级失败 + 映射存在 + import 成功 → installed:true、source:import（调用序 metadata→import）', async () => {
  const { root, remove } = makeSkillRoot();
  try {
    const { file, remove: removeReq } = makeRequirementsFile(['PyYAML']);
    try {
      const calls = [];
      const payload = await toolNamed('ppt_master_check_env').execute(
        { requirementsPath: file },
        {
          skillRoots: [root],
          ...metadataBrokenExec({
            importAnswer: () => ({ stdout: '', stderr: '', exitCode: 0 }),
            calls,
          }),
        },
      );
      assert.deepEqual(
        calls,
        ['metadata:pyyaml', 'import:import yaml'],
        '先元数据查询、UNKNOWN 后追加 import 辅助探测（经映射表转换，非 dist 名）',
      );
      assert.deepEqual(payload.deps[0], {
        dist: 'pyyaml',
        importName: 'yaml',
        installed: true,
        source: 'import',
      });
    } finally {
      removeReq();
    }
  } finally {
    remove();
  }
});

test('check_env: import 辅助探测退出码 1 + stderr ModuleNotFoundError → installed:false、source:import', async () => {
  const { root, remove } = makeSkillRoot();
  try {
    const { file, remove: removeReq } = makeRequirementsFile(['PyYAML']);
    try {
      const payload = await toolNamed('ppt_master_check_env').execute(
        { requirementsPath: file },
        {
          skillRoots: [root],
          ...metadataBrokenExec({
            importAnswer: () => ({
              stdout: '',
              stderr: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'yaml'\n",
              exitCode: 1,
            }),
          }),
        },
      );
      assert.deepEqual(payload.deps[0], {
        dist: 'pyyaml',
        importName: 'yaml',
        installed: false,
        source: 'import',
      });
    } finally {
      removeReq();
    }
  } finally {
    remove();
  }
});

test('check_env: import 辅助探测其他结局（exit 2 / exit 1 无 MNFE）→ 维持 UNKNOWN、source:unknown', async () => {
  const { root, remove } = makeSkillRoot();
  try {
    for (const answer of [
      { stdout: '', stderr: 'SyntaxError: invalid syntax\n', exitCode: 2 },
      { stdout: '', stderr: 'Traceback (most recent call last):\nRuntimeError\n', exitCode: 1 },
    ]) {
      const { file, remove: removeReq } = makeRequirementsFile(['PyYAML']);
      try {
        const calls = [];
        const payload = await toolNamed('ppt_master_check_env').execute(
          { requirementsPath: file },
          {
            skillRoots: [root],
            ...metadataBrokenExec({ importAnswer: () => answer, calls }),
          },
        );
        assert.equal(calls.length, 2, 'import 探测确实发生（探测失败≠未探测）');
        assert.deepEqual(
          payload.deps[0],
          { dist: 'pyyaml', importName: 'yaml', installed: 'UNKNOWN', source: 'unknown' },
          `import 侧无定论 → UNKNOWN：stderr=${answer.stderr.split('\n')[0]}`,
        );
      } finally {
        removeReq();
      }
    }
  } finally {
    remove();
  }
});

test('check_env: 元数据失败但映射缺失（pandas）→ UNKNOWN 且不追加 import 探测（仅一次调用）', async () => {
  const { root, remove } = makeSkillRoot();
  try {
    const { file, remove: removeReq } = makeRequirementsFile(['pandas']);
    try {
      const calls = [];
      const payload = await toolNamed('ppt_master_check_env').execute(
        { requirementsPath: file },
        { skillRoots: [root], ...metadataBrokenExec({ calls }) },
      );
      assert.deepEqual(calls, ['metadata:pandas'], '映射缺失绝不猜测 import 名（spec §3.5）');
      assert.deepEqual(payload.deps[0], {
        dist: 'pandas',
        importName: 'UNKNOWN',
        installed: 'UNKNOWN',
        source: 'unknown',
      });
    } finally {
      removeReq();
    }
  } finally {
    remove();
  }
});

test('check_env: python.found=false → deps 全 UNKNOWN，绝不发起任何 import 探测', async () => {
  const { root, remove } = makeSkillRoot({ withGuard: true });
  try {
    const { file, remove: removeReq } = makeRequirementsFile(['PyYAML', 'python-pptx']);
    try {
      const probedScripts = [];
      const payload = await toolNamed('ppt_master_check_env').execute(
        { requirementsPath: file },
        {
          skillRoots: [root],
          run: async (command, args) => {
            if (args?.[0] === '-c') probedScripts.push(String(args[1]));
            throw enoentError(command);
          },
        },
      );
      assert.equal(payload.python.found, false);
      assert.deepEqual(
        payload.deps,
        [
          { dist: 'pyyaml', importName: 'yaml', installed: 'UNKNOWN', source: 'unknown' },
          { dist: 'python-pptx', importName: 'pptx', installed: 'UNKNOWN', source: 'unknown' },
        ],
      );
      assert.deepEqual(probedScripts, [], '无 python3 时不发起任何 -c 查询（含 import 辅助探测）');
    } finally {
      removeReq();
    }
  } finally {
    remove();
  }
});

test('check_env: PNFE（元数据已定论）→ installed:false、source:metadata，不追加 import 探测', async () => {
  const { root, remove } = makeSkillRoot();
  try {
    const { file, remove: removeReq } = makeRequirementsFile(['PyYAML']);
    try {
      const probedScripts = [];
      const payload = await toolNamed('ppt_master_check_env').execute(
        { requirementsPath: file },
        {
          skillRoots: [root],
          ...healthyExec({
            metadataAnswer: (dist) => (dist === 'pyyaml' ? { found: false } : { found: true }),
            onCall: (command, args) => {
              if (command === 'python3' && args[0] === '-c') probedScripts.push(String(args[1]));
            },
          }),
        },
      );
      assert.equal(probedScripts.length, 1, 'PNFE 后不再追加 import 辅助探测');
      assert.match(probedScripts[0], /importlib\.metadata/);
      assert.deepEqual(payload.deps[0], {
        dist: 'pyyaml',
        importName: 'yaml',
        installed: false,
        source: 'metadata',
      });
    } finally {
      removeReq();
    }
  } finally {
    remove();
  }
});

// ─── 诊断对象：spawn 级失败（无 python3 / 无 guard） ──────────────

test('check_env: 无 python3（spawn ENOENT）→ found=false、guard.skipped、deps 全 UNKNOWN，整体不 throw', async () => {
  const restoreHome = isolateHome().restore;
  const { root, remove } = makeSkillRoot({ withGuard: true });
  try {
    const { file, remove: removeReq } = makeRequirementsFile(['PyYAML', 'python-pptx']);
    try {
      const tool = toolNamed('ppt_master_check_env');
      const payload = await tool.execute(
        { requirementsPath: file },
        {
          skillRoots: [root],
          run: async (command) => {
            throw enoentError(command);
          },
        },
      );

      assert.deepEqual(payload.python, {
        found: false,
        version: null,
        meetsSkillRequirement: null,
      });
      assert.deepEqual(payload.guard, { skipped: true }, 'python3 缺失 → guard 未运行');
      assert.deepEqual(payload.deps, [
        { dist: 'pyyaml', importName: 'yaml', installed: 'UNKNOWN', source: 'unknown' },
        { dist: 'python-pptx', importName: 'pptx', installed: 'UNKNOWN', source: 'unknown' },
      ]);
      assert.equal(payload.envFileExists, false);
    } finally {
      removeReq();
    }
  } finally {
    restoreHome();
    remove();
  }
});

test('check_env: guard 脚本缺失或退出码非 0 → ran 形态记录退出码，不映射工具级失败', async () => {
  const { root, remove } = makeSkillRoot({ withGuard: false });
  try {
    const { file, remove: removeReq } = makeRequirementsFile(['PyYAML']);
    try {
      const payload = await toolNamed('ppt_master_check_env').execute(
        { requirementsPath: file },
        {
          skillRoots: [root],
          run: async (command, args) => {
            if (command !== 'python3') throw enoentError(command);
            if (args[0] === '--version') return { stdout: 'Python 3.11.2\n', stderr: '', exitCode: 0 };
            if (String(args[0]).endsWith('attribution_guard.py')) {
              // 无 guard 脚本时真实 python3 也会非零退出：这里锁「非零 ≠ 工具失败」。
              return { stdout: '', stderr: "can't open file\n", exitCode: 2 };
            }
            return { stdout: '1.0.0\n', stderr: '', exitCode: 0 };
          },
        },
      );
      assert.deepEqual(payload.guard, { ran: true, exitCode: 2 });
      assert.equal(payload.deps[0].installed, true, 'guard 非零不影响 deps 结论');
    } finally {
      removeReq();
    }
  } finally {
    remove();
  }
});

// ─── deps 口径 ───────────────────────────────────────────────────

test('check_env: deps 顺序 = requirements 顺序、大小写变体去重', async () => {
  const { root, remove } = makeSkillRoot();
  try {
    const { file, remove: removeReq } = makeRequirementsFile([
      'PyYAML==6.0.1',
      'flask',
      'pyyaml',
      'python-pptx[image]',
    ]);
    try {
      const payload = await toolNamed('ppt_master_check_env').execute(
        { requirementsPath: file },
        {
          skillRoots: [root],
          ...healthyExec({
            onCall: (command, args, options) => {
              if (command === 'python3' && args[0] === '-c') {
                assert.ok(options !== undefined, '选项对象须透传（signal 通道）');
              }
            },
          }),
        },
      );
      assert.deepEqual(
        payload.deps.map((dep) => dep.dist),
        ['pyyaml', 'flask', 'python-pptx'],
      );
      assert.deepEqual(payload.deps.map((dep) => dep.importName), ['yaml', 'flask', 'pptx']);
    } finally {
      removeReq();
    }
  } finally {
    remove();
  }
});

test('check_env: 每个 dist 独立子进程查询（不合并为一个 -c）', async () => {
  const { root, remove } = makeSkillRoot();
  try {
    const { file, remove: removeReq } = makeRequirementsFile(['PyYAML', 'flask', 'python-pptx']);
    try {
      const scripts = [];
      const distPerQuery = [];
      await toolNamed('ppt_master_check_env').execute(
        { requirementsPath: file },
        {
          skillRoots: [root],
          ...healthyExec({
            onCall: (command, args) => {
              if (command === 'python3' && args[0] === '-c') {
                scripts.push(args[1]);
                distPerQuery.push(args.at(-1));
              }
            },
          }),
        },
      );
      assert.equal(scripts.length, 3, '逐 dist 一次 python3 -c');
      for (const [index, script] of scripts.entries()) {
        assert.match(script, /importlib\.metadata/, '经 importlib.metadata 查询版本');
        assert.match(script, /version\(/, '调用 version()');
        assert.ok(
          script.includes(`version("${distPerQuery[index]}")`),
          `脚本内可见所查发行版名（可读性锚点）：${script}`,
        );
      }
      assert.deepEqual(distPerQuery, ['pyyaml', 'flask', 'python-pptx'], '逐个发行版独立查询');
    } finally {
      removeReq();
    }
  } finally {
    remove();
  }
});

// ─── env 文件：只做存在性检查 ────────────────────────────────────

test('check_env: envFileExists 只做存在性检查——.env 不可读也不 throw', async () => {
  const { root, skill, remove } = makeSkillRoot();
  try {
    const { file, remove: removeReq } = makeRequirementsFile(['PyYAML']);
    try {
      // 目录占用 `.env` 名字：existsSync 为 true，任何读内容的实现都会翻车。
      mkdirSync(join(skill, '.env'));
      const payload = await toolNamed('ppt_master_check_env').execute(
        { requirementsPath: file },
        { skillRoots: [root], ...healthyExec() },
      );
      assert.equal(payload.envFileExists, true);
    } finally {
      removeReq();
    }
  } finally {
    remove();
  }
});

test('check_env: 无 skill 目录 → deps 仍可探测、guard.skipped（不 throw）', async () => {
  const restoreHome = isolateHome().restore;
  const empty = mkdtempSync(join(tmpdir(), 'check-env-empty-'));
  try {
    const { file, remove: removeReq } = makeRequirementsFile(['PyYAML']);
    try {
      const payload = await toolNamed('ppt_master_check_env').execute(
        { requirementsPath: file },
        { skillRoots: [empty], ...healthyExec() },
      );
      assert.deepEqual(payload.guard, { skipped: true });
      assert.equal(payload.envFileExists, false);
      assert.equal(payload.deps[0].installed, true, 'SKILL_DIR 缺失不阻断元数据探测');
      assert.equal(payload.python.found, true);
    } finally {
      removeReq();
    }
  } finally {
    restoreHome();
    rmSync(empty, { recursive: true, force: true });
  }
});

// ─── env 文件：四处探测（cwd / SKILL_DIR / 包根 / ~/.ppt-master） ──
//
// README 指引把 `.env.example` 复制到**工作区根目录**，上游 config.py 的查找序为
// cwd → PROJECT_ROOT → REPO_ROOT → USER_ENV_FILE（~/.ppt-master/.env）；包装层按
// 同一顺序探四处（第 3 项为包装层包根，仅包内布局下等价于上游 REPO_ROOT）。
// 四处任一存在即 true；**始终只 existsSync，绝不读内容**。

/**
 * 把 `$HOME`（连同 win32 形态 `$USERPROFILE`）指到空的隔离 tmp 目录，返回
 * `{ home, restore }`。第 4 探测点 `~/.ppt-master/.env` 经 `os.homedir()` 解析，
 * POSIX 下读 `$HOME`——不隔离时，断言 false 的用例会被真实家目录里恰好存在的
 * `~/.ppt-master/.env` 翻车（本方式零生产侵入：真实代码路径原样跑）。
 */
function isolateHome() {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const homeRoot = mkdtempSync(join(tmpdir(), 'check-env-home-'));
  process.env.HOME = homeRoot;
  process.env.USERPROFILE = homeRoot;
  return {
    home: homeRoot,
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(homeRoot, { recursive: true, force: true });
    },
  };
}

/** `os.homedir()` 是否跟随 `$HOME`（POSIX 语义）——不跟随的平台上无法经 env 隔离第 4 探测点。 */
function homedirFollowsHomeEnv() {
  const { home, restore } = isolateHome();
  try {
    return homedir() === home;
  } finally {
    restore();
  }
}

/**
 * 在隔离的 cwd 下跑一次 check_env（cwd 是探测点之一，用 chdir 驱动）。
 * `cwdEnv` 为 true 时在隔离 cwd 写一个 `.env`；`withSkillEnv` 透传给 skill 树；
 * `homeEnv` 为 true 时在隔离 HOME 下写 `~/.ppt-master/.env`（第 4 探测点）。
 */
async function checkEnvFromCwd({ cwdEnv = false, withSkillEnv = false, homeEnv = false } = {}) {
  const savedCwd = process.cwd();
  const cwdRoot = mkdtempSync(join(tmpdir(), 'check-env-cwd-'));
  const isolatedHome = isolateHome();
  const { root, skill, remove } = makeSkillRoot({ withEnvFile: withSkillEnv });
  try {
    if (cwdEnv) writeFileSync(join(cwdRoot, '.env'), 'SECRET=do-not-read\n');
    if (homeEnv) {
      mkdirSync(join(isolatedHome.home, '.ppt-master'), { recursive: true });
      writeFileSync(join(isolatedHome.home, '.ppt-master', '.env'), 'SECRET=do-not-read\n');
    }
    process.chdir(cwdRoot);
    const { file, remove: removeReq } = makeRequirementsFile(['PyYAML']);
    try {
      const payload = await toolNamed('ppt_master_check_env').execute(
        { requirementsPath: file },
        { skillRoots: [root], ...healthyExec() },
      );
      return { payload, skill };
    } finally {
      removeReq();
    }
  } finally {
    process.chdir(savedCwd);
    isolatedHome.restore();
    remove();
    rmSync(cwdRoot, { recursive: true, force: true });
  }
}

test('check_env: envFileExists — 仅 cwd 有 .env → true（README 指引：复制到工作区根）', async () => {
  const { payload } = await checkEnvFromCwd({ cwdEnv: true });
  assert.equal(payload.envFileExists, true, '工作区根 .env 必须被探测到');
});

test('check_env: envFileExists — 仅 SKILL_DIR 有 .env → true', async () => {
  const { payload } = await checkEnvFromCwd({ withSkillEnv: true });
  assert.equal(payload.envFileExists, true, 'SKILL_DIR/.env 仍须被探测到');
});

test('check_env: envFileExists — 仅 ~/.ppt-master/.env（隔离 HOME）→ true（第 4 探测点）', async (t) => {
  if (!homedirFollowsHomeEnv()) {
    t.skip('os.homedir() 不随 $HOME（非 POSIX 语义），第 4 探测点无法经 env 隔离');
    return;
  }
  const { payload } = await checkEnvFromCwd({ homeEnv: true });
  assert.equal(
    payload.envFileExists,
    true,
    '~/.ppt-master/.env 必须被探测到（上游 config.py 的 USER_ENV_FILE）',
  );
});

test('check_env: envFileExists — cwd/SKILL_DIR/包根/HOME 四处皆无 → false', async () => {
  const { payload } = await checkEnvFromCwd();
  assert.equal(payload.envFileExists, false);
});

test('check_env: envFileExists — 四处都无且 SKILL_DIR 有 .env.example → false（example 不算）', async () => {
  const savedCwd = process.cwd();
  const cwdRoot = mkdtempSync(join(tmpdir(), 'check-env-cwd-'));
  const restoreHome = isolateHome().restore;
  const { root, skill, remove } = makeSkillRoot();
  try {
    // `.env.example` 是模板而非配置：既非 `.env` 名，也不得被当作存在证据。
    writeFileSync(join(skill, '.env.example'), 'IMAGE_BACKEND=openai\n');
    process.chdir(cwdRoot);
    const { file, remove: removeReq } = makeRequirementsFile(['PyYAML']);
    try {
      const payload = await toolNamed('ppt_master_check_env').execute(
        { requirementsPath: file },
        { skillRoots: [root], ...healthyExec() },
      );
      assert.equal(payload.envFileExists, false, '.env.example 不得算作 .env 存在');
    } finally {
      removeReq();
    }
  } finally {
    process.chdir(savedCwd);
    restoreHome();
    remove();
    rmSync(cwdRoot, { recursive: true, force: true });
  }
});

test('check_env: envFileExists — 四处探测仍只做存在性检查（目录占名不 throw）', async () => {
  const savedCwd = process.cwd();
  const cwdRoot = mkdtempSync(join(tmpdir(), 'check-env-cwd-'));
  const { root, remove } = makeSkillRoot();
  try {
    // 隔离 cwd 里用**目录**占用 `.env` 名：existsSync 为 true，任何读内容的实现翻车。
    mkdirSync(join(cwdRoot, '.env'));
    process.chdir(cwdRoot);
    const { file, remove: removeReq } = makeRequirementsFile(['PyYAML']);
    try {
      const payload = await toolNamed('ppt_master_check_env').execute(
        { requirementsPath: file },
        { skillRoots: [root], ...healthyExec() },
      );
      assert.equal(payload.envFileExists, true, 'cwd/.env 目录形态同样只判存在');
    } finally {
      removeReq();
    }
  } finally {
    process.chdir(savedCwd);
    remove();
    rmSync(cwdRoot, { recursive: true, force: true });
  }
});

// ─── exec 契约 ───────────────────────────────────────────────────

test('check_env: execute 尊重 exec.signal（已中止 → 不返回结果）', async () => {
  const { root, remove } = makeSkillRoot();
  try {
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    const signal = { throwIfAborted: () => { throw aborted; } };
    await assert.rejects(
      () =>
        toolNamed('ppt_master_check_env').execute({}, { skillRoots: [root], signal, ...healthyExec() }),
      /aborted/,
    );
  } finally {
    remove();
  }
});

test('check_env: 无 exec.run 注入时退回内置 spawn 助手（本机有 python3 则 found=true，无则 false，均不 throw）', async () => {
  const restoreHome = isolateHome().restore;
  try {
    const payload = await toolNamed('ppt_master_check_env').execute({}, {});
    assert.equal(typeof payload.python.found, 'boolean');
    if (payload.python.found) {
      // T14 首灌后包内 skills/ 存在：SKILL_DIR 可解析，guard 经真实 spawn 助手运行且通过。
      assert.deepEqual(payload.guard, { ran: true, exitCode: 0 }, '包内 vendor 树 → guard 实跑且通过');
    } else {
      assert.deepEqual(payload.guard, { skipped: true });
      assert.deepEqual(payload.python.version, null);
    }
    assert.equal(payload.envFileExists, false);
  } finally {
    restoreHome();
  }
});
