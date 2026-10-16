import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listSkillDirs } from '../lib/skill-provider.js';
import { createTools } from '../lib/tools.js';

/**
 * Task 5 契约：`ppt_master_info` 工具（八字段 info 对象 + 主目录锚定；`venv` 为 Task 7 追加）。
 *
 * 用例集按 brief Step 1 构造 **per-case 独立 tmp 树**（每例 `mkdtempSync`，`finally`
 * 中整体 `rmSync`）：不复用 Task 3 的 4 目录 fixture（其含 `.hidden/`、`broken/` 等
 * 无关目录，排序与 fail-loud 语义都会干扰本工具）。排序约定写死：**目录名字节序**
 * （UTF-16 code unit 比较，非 localeCompare）——与 provider 的排序约定同一实现。
 *
 * 锚定规则（brief Interfaces）：skill frontmatter `name === 'ppt-master'` 命中 →
 * 该目录即主目录且 `primaryIsFallback === false`；无命中 → 回退目录名字节序第一且
 * `primaryIsFallback === true`。无 skill 目录 → `execute` fail-loud throw（空 skills
 * 根不是合法运行态）。
 *
 * Task 7 增量：`info` payload 增 `venv` 小节，取值**唯一数据源**是一次
 * `effectiveInterpreter(venv)` 求值的 `path`/`exists`/`pythonPath`（本工具不另判）——
 * 逐行锁 spec §5.3 矩阵：off / invalid / invalid×disabled / on-missing / on-ready，
 * broken 子态**不增字段**、按推断式 `exists=true ∧ pythonPath=null` 可观测；工具
 * description 在 `venv.enabled=true` 时向**中文段**追加解释器提示语（英文段逐字不动、
 * 仍纯 ASCII）。负向判据：盘上的未标记孤儿 venv 目录不产生任何提示/告警字段
 * （spec §6 未标记孤儿行的保守口径）。
 */

/** 本任务唯一工具在 `createTools()` 中的位置（brief：数组第一项）。 */
const INFO_INDEX = 0;

/** 工具入参 schema：无参数（与 T4 stub 逐字相同）。 */
const EMPTY_PARAMETERS = { type: 'object', properties: {}, additionalProperties: false };

/** 八字段的逐字名单（output.schema 属性集 = info 对象字段集；`venv` 为 Task 7 追加）。 */
const INFO_FIELDS = [
  'pluginVersion',
  'upstreamVersion',
  'skillDirs',
  'primarySkillDir',
  'primarySkillName',
  'primaryIsFallback',
  'repository',
  'venv',
];

/**
 * `info.venv` 小节的逐字字段名单（spec §5.3）：恰四字段——broken 子态**不另增字段**，
 * 以 `exists=true ∧ pythonPath=null` 推断式可观测。
 */
const VENV_FIELDS = ['enabled', 'path', 'exists', 'pythonPath'];

/** 上游仓库 URL 常量：与同步脚本默认 `--repo` 同源（去 `.git` 后缀）。 */
const DEFAULT_REPOSITORY = 'https://github.com/hugohe3/ppt-master';

// ─── per-case tmp 树构造 ─────────────────────────────────────────

/** 建一个空的 skills 根（无任何 skill 目录）；调用方负责在 finally 中 rmSync。 */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'tools-info-'));
  const remove = () => rmSync(root, { recursive: true, force: true });
  return { root, remove };
}

/**
 * 在 `root` 下造一个 skill 目录。
 *
 * `name` 是 frontmatter 的 skill 名（与目录名解耦，用于构造「目录名 ≠ skill 名」的
 * 锚定场景）；`version` 省略时不写 `metadata`，用于锁 `upstreamVersion → null`。
 */
function makeSkill(root, dirName, name, version) {
  const directory = join(root, dirName);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${name} skill fixture for the info tool contract.`,
      ...(version === undefined ? [] : ['metadata:', `  version: "${version}"`]),
      '---',
      '',
      `# ${name}`,
      '',
      'Fixture body.',
      '',
    ].join('\n'),
  );
  return directory;
}

// ─── HOME 隔离（plan Global Constraints「fs 注入缝与 HOME 隔离」）──
//
// 凡路径含 `~`/`os.homedir()` 的用例，前置把 `process.env.HOME` 赋值为**非空 tmpdir**，
// teardown **赋回原值**（禁用 `delete` 还原：delete 落 `getpwuid` 回退，锚到宿主真实
// 家目录而非隔离）。本文件只用它观测 `~` 展开，不写任何文件。
const ORIGINAL_HOME = process.env.HOME;

/** 建一个按用例隔离的 HOME；调用方务必在 finally 中 restore()。 */
function useTmpHome() {
  assert.equal(typeof ORIGINAL_HOME, 'string', '测试前提：进程 HOME 已设置，赋值形态才能还原');
  const home = mkdtempSync(join(tmpdir(), 'tools-info-home-'));
  process.env.HOME = home;
  return {
    home,
    restore() {
      process.env.HOME = ORIGINAL_HOME;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

// ─── venv fixture 与执行辅助（Task 7） ──────────────────────────

/**
 * 每例独立 tmp 箱：`<box>/skills`（单 skill 扫描根）＋ `<box>/<名>` venv fixture 位，
 * 两者互不干扰；调用方负责在 finally 中 remove()。
 */
function makeBox() {
  const parent = mkdtempSync(join(tmpdir(), 'tools-info-venv-'));
  const skillsRoot = join(parent, 'skills');
  makeSkill(skillsRoot, 'alpha', 'alpha', '1.0.0');
  return { parent, skillsRoot, remove: () => rmSync(parent, { recursive: true, force: true }) };
}

/** 以指定 venv 配置执行 info（单 skill 注入根）并返回 payload。 */
function infoFor(skillsRoot, venv) {
  return createTools({ skillRoots: [skillsRoot], venv })[INFO_INDEX].execute({}, {});
}

/**
 * 造一个 stdlib venv fixture：`pyvenv.cfg` 恒在（`venvExists` 判据）；`interpreter`
 * 决定 `bin/python3` 是否存在（缺＝解释器面 broken）；`pip` 决定 `bin/pip3` 是否存在
 * （缺＝ensurepip 未跑完的半成品，同样落 broken 子态、`pythonPath=null`，R2 M2）；
 * `marker` 决定 wrapper 所有权标记是否写入（`marker: false` 即「未标记」）。
 */
function makeVenv(parent, name, { interpreter = true, pip = true, marker = true } = {}) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pyvenv.cfg'), 'home = /usr/bin\n');
  if (interpreter) {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'python3'), '');
    if (pip) writeFileSync(join(dir, 'bin', 'pip3'), '');
  }
  if (marker) {
    writeFileSync(
      join(dir, '.ppt-master-wrapper.json'),
      `${JSON.stringify({ createdAt: '2026-10-15T00:00:00.000Z', path: dir }, null, 2)}\n`,
    );
  }
  return dir;
}

// ─── 工具形态（八字段 schema + 注册面） ──────────────────────────

test('info: createTools()[0] name 逐字 ppt_master_info、parameters 与 stub 同形态', () => {
  const tool = createTools()[INFO_INDEX];
  assert.equal(tool.name, 'ppt_master_info');
  assert.deepEqual(tool.parameters, EMPTY_PARAMETERS);
});

test('info: description 为中英双语短句（一句中文 + 一句英文）', () => {
  const { description } = createTools()[INFO_INDEX];
  assert.equal(typeof description, 'string');
  const parts = description.split('/').map((part) => part.trim()).filter(Boolean);
  assert.equal(parts.length, 2, `description 恰为两段（中/英）：${description}`);
  assert.match(parts[0], /[\u4e00-\u9fff]/, '第一段为中文');
  assert.match(parts[1], /^[\x20-\x7e]+$/, '第二段为 ASCII 英文');
  const lowered = parts[1].toLowerCase();
  assert.ok(lowered.includes('ppt-master'), '英文段点明 ppt-master');
  assert.ok(lowered.includes('info'), '英文段点明 info');
});

test('info: description 的 venv 提示语切换——enabled=true 才追加、只进中文段、英文段逐字不动', () => {
  const baseDescription = createTools()[INFO_INDEX].description;
  const disabled = createTools({ venv: { enabled: false, path: '/tmp/venv-off' } })[INFO_INDEX].description;
  const enabled = createTools({ venv: { enabled: true, path: '/tmp/venv-on' } })[INFO_INDEX].description;

  assert.equal(disabled, baseDescription, 'enabled=false → 描述逐字不变');
  assert.notEqual(enabled, disabled, 'enabled=true → 追加解释器提示语');
  assert.ok(enabled.startsWith(baseDescription.split(' / ')[0]), '提示语追加在中文段尾部（中文段以原文为前缀）');

  const parts = enabled.split('/').map((part) => part.trim()).filter(Boolean);
  assert.equal(parts.length, 2, `追加后仍恰为两段（提示语不得含斜杠）：${enabled}`);
  assert.match(parts[0], /[\u4e00-\u9fff]/, '第一段为中文');
  assert.match(parts[1], /^[\x20-\x7e]+$/, '第二段仍为纯 ASCII 英文');
  assert.equal(
    parts[1],
    baseDescription.split('/').map((part) => part.trim()).filter(Boolean)[1],
    '英文段逐字不动（追加面只在中文段）',
  );
  assert.ok(parts[0].includes('ppt-master-env'), '提示语指向入口 skill（契约所在）');
  assert.match(parts[0], /解释器/, '提示语点明解释器契约');
  assert.ok(!parts[0].includes('/tmp/venv-on'), '提示语不复述配置路径（不泄漏配置值）');
});

test('info: output.schema 为 object-rooted、八字段属性集、显式 additionalProperties:false', () => {
  const { schema } = createTools()[INFO_INDEX].output;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.type === 'json', false, "不得用 type:'json'（SDK 静默降级为空契约）");
  assert.deepEqual(Object.keys(schema.properties), INFO_FIELDS, '属性集即 info 八字段');
  // 逐字段类型锁死：任何字段被改名/改型/漏掉都会在这里转红。
  assert.deepEqual(schema.properties.pluginVersion, { type: 'string' });
  assert.deepEqual(schema.properties.upstreamVersion, { oneOf: [{ type: 'string' }, { type: 'null' }] }, 'upstreamVersion 可空（缺 metadata → null）');
  assert.deepEqual(schema.properties.skillDirs, { type: 'array', items: { type: 'string' } });
  assert.deepEqual(schema.properties.primarySkillDir, { type: 'string' });
  assert.deepEqual(schema.properties.primarySkillName, { type: 'string' });
  assert.deepEqual(schema.properties.primaryIsFallback, { type: 'boolean' });
  assert.deepEqual(schema.properties.repository, { type: 'string' });
  // venv 小节（Task 7）：对象级同样显式闭合、四字段全 required、两个可空字段用 oneOf 拼写。
  assert.deepEqual(
    schema.properties.venv,
    {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        path: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        exists: { type: 'boolean' },
        pythonPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: VENV_FIELDS,
      additionalProperties: false,
    },
    'venv 小节：四字段全 required、对象级 AP:false、可空字段不得用 type 数组',
  );
});

test('info: output.render 为函数且返回含主目录信息的 text 内容块数组', async () => {
  const { root, remove } = makeRoot();
  try {
    makeSkill(root, 'alpha', 'alpha', '9.9.9');
    const tool = createTools({ skillRoots: [root] })[INFO_INDEX];
    assert.equal(typeof tool.output.render, 'function');
    const info = await tool.execute({}, {});
    const rendered = tool.output.render({}, info);
    // 宿主管线契约（dsh-tools createSuccessResult）：render 返回值原样成为
    // result.content，必须是内容块数组（首方参考 dsh-tool-todo）——返回
    // 字符串会让下游 content.some(...) 抛 "content.some is not a function"。
    assert.ok(Array.isArray(rendered), 'render 返回内容块数组');
    assert.equal(rendered.length, 1, '单个内容块');
    assert.equal(rendered[0].type, 'text', '块类型为 text');
    assert.equal(typeof rendered[0].text, 'string');
    const text = rendered[0].text;
    assert.ok(text.length > 0);
    assert.ok(text.includes(info.primarySkillDir), 'render 点出主目录');
    assert.ok(text.includes(info.pluginVersion), 'render 点出插件版本');
    assert.ok(text.includes('9.9.9'), 'render 点出上游版本');
  } finally {
    remove();
  }
});

// ─── 扫描辅助：listSkillDirs 谓词（同 Task 3） ───────────────────

test('info: listSkillDirs 只收录直接子级带 SKILL.md 的一级目录，按目录名字节序', () => {
  const { root, remove } = makeRoot();
  try {
    makeSkill(root, 'zeta', 'zeta');
    makeSkill(root, 'alpha', 'alpha');
    mkdirSync(join(root, 'no-skill-md')); // 无 SKILL.md → 跳过
    mkdirSync(join(root, 'nested', 'deep'), { recursive: true }); // 二级目录不算
    writeFileSync(join(root, 'nested', 'deep', 'SKILL.md'), '---\nname: deep\ndescription: d\n---\n');
    mkdirSync(join(root, '.hidden'));
    writeFileSync(join(root, '.hidden', 'SKILL.md'), '---\nname: hidden\ndescription: d\n---\n');

    assert.deepEqual(listSkillDirs(root), [join(root, '.hidden'), join(root, 'alpha'), join(root, 'zeta')]);
  } finally {
    remove();
  }
});

// ─── 单 skill：metadata.version → upstreamVersion ────────────────

test('info: 单 skill 树 → 主目录锚定自身、upstreamVersion 解析自 metadata.version', async () => {
  const { root, remove } = makeRoot();
  try {
    const alpha = makeSkill(root, 'alpha', 'alpha', '9.9.9');
    const info = await createTools()[INFO_INDEX].execute({}, { skillRoots: [root] });

    assert.equal(info.primarySkillDir, alpha);
    assert.equal(info.primarySkillName, 'alpha');
    assert.equal(info.upstreamVersion, '9.9.9', '解析主 skill SKILL.md 的 metadata.version');
    assert.deepEqual(info.skillDirs, [alpha]);
    assert.equal(info.primaryIsFallback, true, '单 skill 的 name 非 ppt-master → 无锚定，仍是回退轮换');
  } finally {
    remove();
  }
});

test('info: 主 skill 缺 metadata → upstreamVersion 为 null（不 throw）', async () => {
  const { root, remove } = makeRoot();
  try {
    makeSkill(root, 'alpha', 'alpha'); // 无 metadata 块
    const info = await createTools()[INFO_INDEX].execute({}, { skillRoots: [root] });
    assert.equal(info.upstreamVersion, null);
  } finally {
    remove();
  }
});

// ─── 双 skill：锚定命中 vs 回退 ──────────────────────────────────

test('info: 双 skill 且 zeta 的 name=ppt-master → primary=zeta、primaryIsFallback=false', async () => {
  const { root, remove } = makeRoot();
  try {
    const alpha = makeSkill(root, 'alpha', 'alpha', '1.0.0');
    const zeta = makeSkill(root, 'zeta', 'ppt-master', '6.7.0');
    const info = await createTools()[INFO_INDEX].execute({}, { skillRoots: [root] });

    assert.equal(info.primarySkillDir, zeta, '锚定 frontmatter name === ppt-master 的目录');
    assert.equal(info.primarySkillName, 'ppt-master');
    assert.equal(info.primaryIsFallback, false, '锚定命中 → 非回退');
    assert.equal(info.upstreamVersion, '6.7.0', 'upstreamVersion 取主 skill 的 metadata.version');
    assert.deepEqual(info.skillDirs, [alpha, zeta], 'skillDirs 为全部 skill 目录（目录名字节序）');
  } finally {
    remove();
  }
});

test('info: 双 skill 变体（zeta name≠ppt-master）→ 回退目录名字节序第一、primaryIsFallback=true', async () => {
  const { root, remove } = makeRoot();
  try {
    const alpha = makeSkill(root, 'alpha', 'alpha', '1.0.0');
    const zeta = makeSkill(root, 'zeta', 'zeta-skill', '2.0.0');
    const info = await createTools()[INFO_INDEX].execute({}, { skillRoots: [root] });

    assert.equal(info.primarySkillDir, alpha, '无锚定 → 目录名字节序第一');
    assert.equal(info.primarySkillName, 'alpha');
    assert.equal(info.primaryIsFallback, true, 'fallback 标注落 primaryIsFallback');
    assert.equal(info.upstreamVersion, '1.0.0', 'upstreamVersion 取回退主 skill 的 metadata.version');
    assert.deepEqual(info.skillDirs, [alpha, zeta]);
  } finally {
    remove();
  }
});

// ─── 无 skill 目录：fail-loud ────────────────────────────────────

test('info: 根下无 skill 目录 → execute throw（fail-loud，空 skills 根非法）', async () => {
  const { root, remove } = makeRoot();
  try {
    mkdirSync(join(root, 'not-a-skill')); // 有目录但无 SKILL.md
    await assert.rejects(
      () => createTools()[INFO_INDEX].execute({}, { skillRoots: [root] }),
      /no skill/i,
    );
  } finally {
    remove();
  }
});

test('info: 根不存在 → execute throw（fail-loud）', async () => {
  const { root, remove } = makeRoot();
  try {
    await assert.rejects(
      () => createTools()[INFO_INDEX].execute({}, { skillRoots: [join(root, 'missing')] }),
      /does not exist/,
    );
  } finally {
    remove();
  }
});

// ─── 常量字段与 exec 契约 ────────────────────────────────────────

test('info: pluginVersion 读包内 package.json、repository 为上游仓库常量', async () => {
  const { root, remove } = makeRoot();
  try {
    makeSkill(root, 'alpha', 'alpha', '9.9.9');
    const info = await createTools()[INFO_INDEX].execute({}, { skillRoots: [root] });

    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(info.pluginVersion, pkg.version, 'pluginVersion 来自本包 package.json');
    assert.equal(info.repository, DEFAULT_REPOSITORY, 'repository 为常量（与 sync 默认 --repo 一致）');
    assert.deepEqual(Object.keys(info), INFO_FIELDS, 'info 恰为八字段（顺序逐字）');
  } finally {
    remove();
  }
});

test('info: execute 尊重 exec.signal（已中止 → 不返回结果）', async () => {
  const { root, remove } = makeRoot();
  try {
    makeSkill(root, 'alpha', 'alpha', '9.9.9');
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    const signal = { throwIfAborted: () => { throw aborted; } };
    await assert.rejects(
      () => createTools()[INFO_INDEX].execute({}, { skillRoots: [root], signal }),
      /aborted/,
    );
  } finally {
    remove();
  }
});

test('info: exec 省略 → 回落包内 skills/ 根，定位到 ppt-master（T14 首灌后成功）', async () => {
  const info = await createTools()[INFO_INDEX].execute({});
  assert.equal(info.primarySkillName, 'ppt-master', 'name 锚定命中本体 skill');
  assert.equal(info.primaryIsFallback, false, '本体 skill 直接命中，非回退');
  assert.equal(info.skillDirs.length, 1, '包内 skills/ 为单 skill 面');
  assert.ok(
    info.primarySkillDir.endsWith(join('skills', 'ppt-master')),
    `SKILL_DIR 指向包内 vendor 目录: ${info.primarySkillDir}`,
  );
  assert.match(info.upstreamVersion ?? '', /^\d+\.\d+\.\d+$/, 'upstreamVersion 取自 vendor SKILL.md metadata');
});

// ─── Task 7：info.venv 小节（spec §5.3 矩阵逐行） ────────────────
//
// 取值唯一数据源＝一次 `effectiveInterpreter(venv)` 求值（本工具不自行解析路径、
// 不另判存在性、不直连 `probeVenvInterpreter`）。矩阵行与断言面：
//   off（含 disabled×invalid）→ `path` 按配置原样/无效判 null、`exists:false` 定值（不探测）；
//   invalid                   → `path:null` 定值；`enabled` 仍为配置值 true；
//   on-missing / on-ready     → `path`＝解析后绝对；`exists`/`pythonPath` 由同一次求值给出；
//   broken 子态               → `exists:true ∧ pythonPath:null`（不增字段，推断式可观测）。

test('info.venv: off 行——不探测（盘上是真 venv 也 exists=false）、path 原样、pythonPath=null', async () => {
  const box = makeBox();
  try {
    const real = makeVenv(box.parent, 'venv'); // 真 venv（pyvenv.cfg + bin/python3 + marker）
    const info = await infoFor(box.skillsRoot, { enabled: false, path: real, oldPathPolicy: 'keep' });

    assert.deepEqual(Object.keys(info.venv), VENV_FIELDS, 'venv 小节恰四字段');
    assert.deepEqual(
      info.venv,
      { enabled: false, path: real, exists: false, pythonPath: null },
      'off 行取定值：exists=false 不探测、path 按配置原样',
    );
  } finally {
    box.remove();
  }
});

test('info.venv: invalid 行——path=null 定值、enabled 如实；disabled×invalid 落 off 且 path=null', async () => {
  const box = makeBox();
  try {
    const relative = await infoFor(box.skillsRoot, { enabled: true, path: 'relative/venv', oldPathPolicy: 'keep' });
    assert.deepEqual(
      relative.venv,
      { enabled: true, path: null, exists: false, pythonPath: null },
      'invalid 行：enabled 为配置值 true，path=null 定值、不探测',
    );

    const unresolvable = await infoFor(box.skillsRoot, { enabled: true, path: '', oldPathPolicy: 'keep' });
    assert.deepEqual(
      unresolvable.venv,
      { enabled: true, path: null, exists: false, pythonPath: null },
      '不可解析（空串）同落 invalid',
    );

    const disabledInvalid = await infoFor(box.skillsRoot, { enabled: false, path: 'relative/venv', oldPathPolicy: 'keep' });
    assert.deepEqual(
      disabledInvalid.venv,
      { enabled: false, path: null, exists: false, pythonPath: null },
      'disabled×invalid 落 off（disabled 优先）、无效如实判 null',
    );
  } finally {
    box.remove();
  }
});

test('info.venv: on-missing 行——path=解析后绝对（`~` 展开）、exists=false、pythonPath=null', async () => {
  const box = makeBox();
  const tmpHome = useTmpHome();
  try {
    const configured = '~/.ppt-master/venv';
    const missing = await infoFor(box.skillsRoot, { enabled: true, path: configured, oldPathPolicy: 'keep' });
    assert.deepEqual(
      missing.venv,
      { enabled: true, path: join(tmpHome.home, '.ppt-master', 'venv'), exists: false, pythonPath: null },
      'on-missing：`~` 展开为绝对路径，venv 目录不存在 → exists=false、无解释器',
    );

    const absolute = join(box.parent, 'absent-venv');
    const absoluteCase = await infoFor(box.skillsRoot, { enabled: true, path: absolute, oldPathPolicy: 'keep' });
    assert.deepEqual(
      absoluteCase.venv,
      { enabled: true, path: absolute, exists: false, pythonPath: null },
      '绝对路径原样成为解析结果',
    );

    // 同一 `~` 配置、仅开关不同：off 行 path 原样不解析——解析面只发生在 on-* 行。
    const off = await infoFor(box.skillsRoot, { enabled: false, path: configured, oldPathPolicy: 'keep' });
    assert.deepEqual(
      off.venv,
      { enabled: false, path: configured, exists: false, pythonPath: null },
      'off 行不解析路径（与同配置的 on-missing 行成对照）',
    );
  } finally {
    tmpHome.restore();
    box.remove();
  }
});

test('info.venv: on-ready 行——path=解析后绝对、exists=true、pythonPath=<path>/bin/python3', async () => {
  const box = makeBox();
  try {
    const venvDir = makeVenv(box.parent, 'venv');
    const info = await infoFor(box.skillsRoot, { enabled: true, path: venvDir, oldPathPolicy: 'keep' });

    assert.deepEqual(Object.keys(info.venv), VENV_FIELDS, '恰四字段（不增 broken 等字段）');
    assert.deepEqual(info.venv, {
      enabled: true,
      path: venvDir,
      exists: true,
      pythonPath: join(venvDir, 'bin', 'python3'),
    });
  } finally {
    box.remove();
  }
});

test('info.venv: broken 子态——不增字段，按推断式 exists=true ∧ pythonPath=null 可观测', async () => {
  const box = makeBox();
  try {
    // pyvenv.cfg 在（venv 目录成立）但 bin/python3 缺 → exists-but-broken。
    const brokenDir = makeVenv(box.parent, 'broken-venv', { interpreter: false });
    const info = await infoFor(box.skillsRoot, { enabled: true, path: brokenDir, oldPathPolicy: 'keep' });

    assert.deepEqual(Object.keys(info.venv), VENV_FIELDS, 'broken 不另增字段（无 broken 键）');
    assert.deepEqual(info.venv, {
      enabled: true,
      path: brokenDir,
      exists: true,
      pythonPath: null,
    });
    assert.ok(
      info.venv.exists === true && info.venv.pythonPath === null,
      '推断式可观测：exists=true ∧ pythonPath=null ⇒ exists-but-broken',
    );
  } finally {
    box.remove();
  }
});

test('info.venv: 半成品（有 bin/python3、缺 bin/pip3）→ 与 broken 同口径 pythonPath=null（R2 M2）', async () => {
  const box = makeBox();
  try {
    // ensurepip 未跑完的半成品：解释器在、安装路径不在。就绪判据（解释器 ∧ 安装路径）不成立，
    // 故 info 面必须与 setup_deps 的收编拒绝口径一致：exists=true 但 pythonPath=null。
    const halfDir = makeVenv(box.parent, 'half-built-venv', { pip: false });
    assert.equal(existsSync(join(halfDir, 'bin', 'python3')), true, '前置：解释器存在');
    assert.equal(existsSync(join(halfDir, 'bin', 'pip3')), false, '前置：安装路径缺失');

    const info = await infoFor(box.skillsRoot, { enabled: true, path: halfDir, oldPathPolicy: 'keep' });

    assert.deepEqual(Object.keys(info.venv), VENV_FIELDS, '仍恰四字段（不增 broken 等字段）');
    assert.deepEqual(
      info.venv,
      { enabled: true, path: halfDir, exists: true, pythonPath: null },
      '半成品不得被宣告健康：pythonPath=null，与 broken 同一推断式',
    );
  } finally {
    box.remove();
  }
});

test('info.venv: venv 选项缺省（测试/嵌入形态）→ 四字段在场、关闭态、无提示语', async () => {
  const box = makeBox();
  try {
    const tool = createTools({ skillRoots: [box.skillsRoot] })[INFO_INDEX];
    const info = await tool.execute({}, {});

    assert.deepEqual(Object.keys(info.venv), VENV_FIELDS, 'venv 键恒在场');
    assert.deepEqual(
      info.venv,
      { enabled: false, path: null, exists: false, pythonPath: null },
      '缺省（无 venv 注入）＝未配置：单次求值给出的如实值，不猜默认路径',
    );
    assert.equal(tool.description.includes('ppt-master-env'), false, '未启用 → 描述不追加提示语');
  } finally {
    box.remove();
  }
});

test('info: 未标记孤儿 venv 目录 → 不增提示/告警字段、不进 payload/render/description（spec §6）', async () => {
  const box = makeBox();
  try {
    // 孤儿＝盘上存在、含 pyvenv.cfg + bin/python3、**无** wrapper 所有权标记，且不在配置路径上。
    const orphan = makeVenv(box.parent, 'orphan-venv', { marker: false });
    const configured = join(box.parent, 'configured-venv'); // 配置路径（不存在），与孤儿不同
    const tool = createTools({
      skillRoots: [box.skillsRoot],
      venv: { enabled: false, path: configured, oldPathPolicy: 'keep' },
    })[INFO_INDEX];
    const info = await tool.execute({}, {});

    assert.deepEqual(Object.keys(info), INFO_FIELDS, 'info 字段集不变（孤儿不新增提示/告警字段）');
    assert.deepEqual(Object.keys(info.venv), VENV_FIELDS, 'venv 字段集不变');
    assert.deepEqual(
      info.venv,
      { enabled: false, path: configured, exists: false, pythonPath: null },
      'venv 关闭时不发现、不探测盘上任何 venv 目录',
    );
    assert.equal(JSON.stringify(info).includes(orphan), false, 'payload 不得出现孤儿路径');
    const rendered = tool.output.render({}, info)[0].text;
    assert.equal(rendered.includes(orphan), false, 'render 不得提示孤儿');
    assert.equal(tool.description.includes(orphan), false, 'description 不得提示孤儿');
    assert.equal(
      tool.description,
      createTools()[INFO_INDEX].description,
      'venv 未启用 → 描述与基线逐字相同（孤儿不能把它打开）',
    );
  } finally {
    box.remove();
  }
});
