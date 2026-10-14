import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listSkillDirs } from '../lib/skill-provider.js';
import { createTools } from '../lib/tools.js';

/**
 * Task 5 契约：`ppt_master_info` 工具（七字段 info 对象 + 主目录锚定）。
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
 */

/** 本任务唯一工具在 `createTools()` 中的位置（brief：数组第一项）。 */
const INFO_INDEX = 0;

/** 工具入参 schema：无参数（与 T4 stub 逐字相同）。 */
const EMPTY_PARAMETERS = { type: 'object', properties: {}, additionalProperties: false };

/** 七字段的逐字名单（output.schema 属性集 = info 对象字段集）。 */
const INFO_FIELDS = [
  'pluginVersion',
  'upstreamVersion',
  'skillDirs',
  'primarySkillDir',
  'primarySkillName',
  'primaryIsFallback',
  'repository',
];

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

// ─── 工具形态（七字段 schema + 注册面） ──────────────────────────

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

test('info: output.schema 为 object-rooted、七字段属性集、显式 additionalProperties:false', () => {
  const { schema } = createTools()[INFO_INDEX].output;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.type === 'json', false, "不得用 type:'json'（SDK 静默降级为空契约）");
  assert.deepEqual(Object.keys(schema.properties), INFO_FIELDS, '属性集即 info 七字段');
  // 逐字段类型锁死：任何字段被改名/改型/漏掉都会在这里转红。
  assert.deepEqual(schema.properties.pluginVersion, { type: 'string' });
  assert.deepEqual(schema.properties.upstreamVersion, { oneOf: [{ type: 'string' }, { type: 'null' }] }, 'upstreamVersion 可空（缺 metadata → null）');
  assert.deepEqual(schema.properties.skillDirs, { type: 'array', items: { type: 'string' } });
  assert.deepEqual(schema.properties.primarySkillDir, { type: 'string' });
  assert.deepEqual(schema.properties.primarySkillName, { type: 'string' });
  assert.deepEqual(schema.properties.primaryIsFallback, { type: 'boolean' });
  assert.deepEqual(schema.properties.repository, { type: 'string' });
});

test('info: output.render 为函数且返回含主目录信息的字符串', async () => {
  const { root, remove } = makeRoot();
  try {
    makeSkill(root, 'alpha', 'alpha', '9.9.9');
    const tool = createTools({ skillRoots: [root] })[INFO_INDEX];
    assert.equal(typeof tool.output.render, 'function');
    const info = await tool.execute({}, {});
    const rendered = tool.output.render({}, info);
    assert.equal(typeof rendered, 'string');
    assert.ok(rendered.length > 0);
    assert.ok(rendered.includes(info.primarySkillDir), 'render 点出主目录');
    assert.ok(rendered.includes(info.pluginVersion), 'render 点出插件版本');
    assert.ok(rendered.includes('9.9.9'), 'render 点出上游版本');
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
    assert.deepEqual(Object.keys(info), INFO_FIELDS, 'info 恰为七字段（顺序逐字）');
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
