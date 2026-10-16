import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSkillProvider, SKILL_RANK } from '../lib/skill-provider.js';

/**
 * brief 钉死的 fixture：`tests/fixtures/skills-fixture/` 一个扫描根下四个一级目录
 * ——`alpha/`（合法 + metadata）、`.hidden/`（dotfile 且含 SKILL.md，应收录）、
 * `beta/`（无 SKILL.md，静默跳过）、`broken/`（含 SKILL.md 但缺 description，
 * 创建 provider 时必须 throw）。
 *
 * `broken/` 使**整根**创建必然 fail-loud（这正是契约），故正向用例（list/get/
 * 字段/metadata/signal）改在 `broken/` 被移除的副本根上跑：同一 alpha/.hidden/
 * beta 内容，仅隔离「创建即中止」的目录，让正向面可被观测。
 */
const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'skills-fixture');
const brokenRoot = fixtureRoot;

/** 逐字节读取 fixture 内某目录的 SKILL.md 原文，供 content 字节保真断言使用。 */
const fixtureFileText = (dir) => readFileSync(join(fixtureRoot, dir, 'SKILL.md'), 'utf8');

/**
 * 造一棵临时树：默认从 fixture 复制（可排除指定目录），或按 overrides 现造。
 * 返回 { root, cleanup }；测试结束务必 cleanup。
 */
async function makeRoot({ exclude = [], extra = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skill-provider-'));
  if (exclude.length > 0 || Object.keys(extra).length > 0 || arguments[0] === undefined) {
    await cp(fixtureRoot, root, {
      recursive: true,
      filter: (source) => !exclude.some((dir) => source === join(fixtureRoot, dir)),
    });
  }
  for (const [dir, content] of Object.entries(extra)) {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'SKILL.md'), content);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** 造一棵空临时根（只有给的目录名，无 SKILL.md）。 */
async function makeEmptyRoot(dirs = []) {
  const root = await mkdtemp(join(tmpdir(), 'skill-provider-'));
  for (const dir of dirs) await mkdir(join(root, dir), { recursive: true });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const LEGAL = (name, description = `${name} description`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

// ─── 导出契约与谓词 ──────────────────────────────────────────────

test('provider: SKILL_RANK 导出常量 = 550', () => {
  assert.equal(SKILL_RANK, 550);
});

test('provider: provider.name 为 dsh-ppt-master-wrapper', async () => {
  const { root, cleanup } = await makeRoot({ exclude: ['broken'] });
  try {
    assert.equal(createSkillProvider([root]).name, 'dsh-ppt-master-wrapper');
  } finally {
    await cleanup();
  }
});

test('provider: list() 收录含 SKILL.md 的一级目录（含 dotfile），跳过 beta', async () => {
  const { root, cleanup } = await makeRoot({ exclude: ['broken'] });
  try {
    // 前置防空断言：fixture 里 beta 目录确实存在、确实没有 SKILL.md；
    // .hidden 确实存在、确实有 SKILL.md。
    assert.ok(existsSync(join(fixtureRoot, 'beta')));
    assert.ok(!existsSync(join(fixtureRoot, 'beta', 'SKILL.md')));
    assert.ok(existsSync(join(fixtureRoot, '.hidden', 'SKILL.md')));

    const provider = createSkillProvider([root]);
    const list = await provider.list();
    assert.deepEqual(
      list.map((candidate) => candidate.name),
      ['alpha', 'hidden-skill'],
      'name 按字节序升序；.hidden 收录、beta 静默跳过',
    );
  } finally {
    await cleanup();
  }
});

test('provider: 候选字段精确值（invocation/provider/source/rank/resourceBase/locator/path）', async () => {
  const { root, cleanup } = await makeRoot({ exclude: ['broken'] });
  try {
    const provider = createSkillProvider([root]);
    const candidate = (await provider.list()).find((entry) => entry.name === 'alpha');

    assert.equal(
      candidate.description,
      'Alpha fixture skill used to lock the packaged skill provider contract.',
    );
    assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true });
    assert.equal(candidate.provider, 'dsh-ppt-master-wrapper');
    assert.equal(candidate.source, 'custom');
    assert.equal(candidate.rank, 550);
    assert.deepEqual(candidate.resourceBase, { kind: 'directory', path: join(root, 'alpha') });
    assert.equal(candidate.locator, join(root, 'alpha', 'SKILL.md'));
    assert.equal(candidate.path, join(root, 'alpha', 'SKILL.md'));
    assert.deepEqual(Object.keys(candidate).sort(), [
      'description',
      'invocation',
      'locator',
      'metadata',
      'name',
      'path',
      'provider',
      'rank',
      'resourceBase',
      'source',
    ]);
  } finally {
    await cleanup();
  }
});

test('provider: metadata 透传（version/license/copyright/sponsors）', async () => {
  const { root, cleanup } = await makeRoot({ exclude: ['broken'] });
  try {
    const provider = createSkillProvider([root]);
    const candidate = (await provider.list()).find((entry) => entry.name === 'alpha');

    assert.deepEqual(candidate.metadata, {
      version: '1.2.3',
      license: 'MIT',
      copyright: 'Copyright (c) 2026 Fixture Author',
      sponsors: ['SPONSORS.md', 'SPONSORS_CN.md'],
    });
  } finally {
    await cleanup();
  }
});

test('provider: 无 metadata 的 skill 候选不含 metadata 键', async () => {
  const { root, cleanup } = await makeEmptyRoot();
  try {
    await mkdir(join(root, 'plain'), { recursive: true });
    await writeFile(join(root, 'plain', 'SKILL.md'), LEGAL('plain'));
    const provider = createSkillProvider([root]);
    const [candidate] = await provider.list();
    assert.equal(candidate.name, 'plain');
    assert.ok(!('metadata' in candidate));
  } finally {
    await cleanup();
  }
});

test('provider: name ≠ 目录名不在本层判定（不 throw、不警告）', async () => {
  const { root, cleanup } = await makeEmptyRoot();
  try {
    // 目录名 dir-name 与 frontmatter name 不同：本层不处理，交由 verify 层警告。
    await mkdir(join(root, 'dir-name'), { recursive: true });
    await writeFile(join(root, 'dir-name', 'SKILL.md'), LEGAL('other-name'));
    const provider = createSkillProvider([root]);
    assert.deepEqual((await provider.list()).map((c) => c.name), ['other-name']);
  } finally {
    await cleanup();
  }
});

// ─── get() ──────────────────────────────────────────────────────

test('provider: get(alpha) 往返一致，content 为 frontmatter 之后的正文原样切片', async () => {
  const { root, cleanup } = await makeRoot({ exclude: ['broken'] });
  try {
    const provider = createSkillProvider([root]);
    const candidate = (await provider.list()).find((entry) => entry.name === 'alpha');
    const definition = await provider.get(candidate);

    assert.equal(definition.name, candidate.name);
    assert.equal(definition.description, candidate.description);
    assert.equal(definition.rank, candidate.rank);
    assert.equal(definition.path, candidate.path);
    assert.equal(definition.locator, candidate.locator);
    assert.deepEqual(definition.metadata, candidate.metadata);

    // 字节保真：content 是原文闭合分隔符之后的**未 trim** 切片（与 fixture 一致）。
    const raw = fixtureFileText('alpha');
    const closing = raw.indexOf('\n---\n') + '\n---\n'.length;
    assert.equal(definition.content, raw.slice(closing));
    assert.ok(definition.content.startsWith('\n# Alpha Skill\n'), 'content 不得被 trim');
    assert.ok(definition.content.endsWith('Alpha body line two.\n'));
  } finally {
    await cleanup();
  }
});

test('provider: get() 对 CRLF 正文同样字节保真（不 trim、不归一）', async () => {
  const { root, cleanup } = await makeEmptyRoot();
  try {
    await mkdir(join(root, 'crlf'), { recursive: true });
    await writeFile(
      join(root, 'crlf', 'SKILL.md'),
      '---\r\nname: crlf\r\ndescription: crlf body\r\n---\r\n\r\n# CRLF\r\n\r\nline two\r\n',
    );
    const provider = createSkillProvider([root]);
    const [candidate] = await provider.list();
    const definition = await provider.get(candidate);
    assert.equal(definition.content, '\r\n# CRLF\r\n\r\nline two\r\n');
  } finally {
    await cleanup();
  }
});

test('provider: get() 未找到候选 → undefined', async () => {
  const { root, cleanup } = await makeRoot({ exclude: ['broken'] });
  try {
    const provider = createSkillProvider([root]);
    assert.equal(await provider.get({ name: 'does-not-exist' }), undefined);
  } finally {
    await cleanup();
  }
});

// ─── fail-loud（创建即校验） ──────────────────────────────────────

test('provider: fixture 整根——含 SKILL.md 但缺 description → 创建时 throw（定位 broken/SKILL.md）', () => {
  assert.throws(
    () => createSkillProvider([brokenRoot]),
    (error) => {
      assert.match(error.message, /description/);
      assert.ok(
        error.message.includes(join(brokenRoot, 'broken', 'SKILL.md')),
        `错误信息应可定位到 broken/SKILL.md，实际：${error.message}`,
      );
      return true;
    },
  );
});

test('provider: list() 之前（创建时）即已校验——list 不是触发点', async () => {
  const { root, cleanup } = await makeRoot({ exclude: ['broken'] });
  try {
    // broken 不在树里时创建成功；
    const provider = createSkillProvider([root]);
    await provider.list();
    // 把 broken 放回来，创建立即失败——证明校验发生在 createSkillProvider，而非 list()。
    await mkdir(join(root, 'broken'), { recursive: true });
    await cp(
      join(fixtureRoot, 'broken', 'SKILL.md'),
      join(root, 'broken', 'SKILL.md'),
    );
    assert.throws(() => createSkillProvider([root]), /description/);
  } finally {
    await cleanup();
  }
});

test('provider: name 缺失 → 创建时 throw', async () => {
  const { root, cleanup } = await makeEmptyRoot();
  try {
    await mkdir(join(root, 'noname'), { recursive: true });
    await writeFile(join(root, 'noname', 'SKILL.md'), '---\ndescription: no name here\n---\nbody\n');
    assert.throws(
      () => createSkillProvider([root]),
      (error) => {
        assert.match(error.message, /name/);
        assert.ok(error.message.includes(join(root, 'noname', 'SKILL.md')));
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test('provider: name 非 kebab-case → 创建时 throw', async () => {
  for (const bad of ['Bad_Name', 'Bad-Name', 'bad--name', '-bad', 'bad-']) {
    const { root, cleanup } = await makeEmptyRoot();
    try {
      await mkdir(join(root, 'bad'), { recursive: true });
      await writeFile(join(root, 'bad', 'SKILL.md'), LEGAL(bad));
      assert.throws(
        () => createSkillProvider([root]),
        (error) => {
          assert.match(error.message, new RegExp(bad.replace(/[-]/g, '\\-')));
          assert.ok(error.message.includes(join(root, 'bad', 'SKILL.md')));
          return true;
        },
        `name "${bad}" 应被判非法`,
      );
    } finally {
      await cleanup();
    }
  }
});

test('provider: 缺 frontmatter 块 → 创建时 throw（不静默跳过）', async () => {
  const { root, cleanup } = await makeEmptyRoot();
  try {
    await mkdir(join(root, 'nofm'), { recursive: true });
    await writeFile(join(root, 'nofm', 'SKILL.md'), '# No frontmatter at all\n');
    assert.throws(
      () => createSkillProvider([root]),
      (error) => {
        assert.ok(error.message.includes(join(root, 'nofm', 'SKILL.md')));
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test('provider: roots 中某根路径不存在 → 创建时 throw（含该根路径）', () => {
  const missing = join(tmpdir(), 'skill-provider-missing-root-does-not-exist');
  assert.ok(!existsSync(missing), '前置：该路径确实不存在');
  assert.throws(
    () => createSkillProvider([fixtureRoot, missing]),
    (error) => {
      assert.ok(error.message.includes(missing), `错误信息应含缺失根路径，实际：${error.message}`);
      return true;
    },
  );
});

test('provider: 根存在但零 skill 目录 → 创建时 throw（「不存在或为空」两判据）', async () => {
  const { root, cleanup } = await makeEmptyRoot();
  try {
    // 空目录：存在但零 skill 目录。
    assert.throws(
      () => createSkillProvider([root]),
      (error) => {
        assert.ok(error.message.includes(root), `错误信息应含空根路径，实际：${error.message}`);
        assert.match(error.message, /不存在或为空/);
        return true;
      },
    );
    // 根存在但只有一个不含 SKILL.md 的目录 → 仍属空根。
    await mkdir(join(root, 'not-a-skill'), { recursive: true });
    assert.throws(() => createSkillProvider([root]), /不存在或为空/);
  } finally {
    await cleanup();
  }
});

test('provider: 所有 roots 合计零 skill 目录 → 创建时 throw', async () => {
  const first = await makeEmptyRoot();
  const second = await makeEmptyRoot(['also-not-a-skill']);
  try {
    assert.throws(
      () => createSkillProvider([first.root, second.root]),
      (error) => {
        assert.match(error.message, /不存在或为空/);
        assert.ok(error.message.includes(first.root));
        assert.ok(error.message.includes(second.root));
        return true;
      },
    );
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test('provider: 非法 roots 形态 → 创建时 throw（含可定位说明）', async () => {
  const { root, cleanup } = await makeEmptyRoot();
  try {
    assert.throws(() => createSkillProvider([]), /non-empty array/);
    assert.throws(() => createSkillProvider(['']), /invalid skill root/);
    assert.throws(() => createSkillProvider([42]), /invalid skill root/);

    // 根指向文件而非目录 → 明确报「不是目录」，不得泄漏裸 ENOTDIR。
    const file = join(root, 'not-a-dir.txt');
    await writeFile(file, 'x');
    assert.throws(
      () => createSkillProvider([file]),
      (error) => {
        assert.match(error.message, /not a directory/);
        assert.ok(error.message.includes(file));
        assert.equal(error.code, undefined, '不得是裸 fs 错误');
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test('provider: 默认 roots（不传参）指向包内 skills/，缺失时报出该绝对路径', async () => {
  const packagedSkills = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
  // T14 首灌前包内 skills/ 不存在；存在时本用例不适用（改为断言不抛）。
  if (existsSync(packagedSkills)) {
    assert.equal(createSkillProvider().name, 'dsh-ppt-master-wrapper');
    return;
  }
  assert.throws(
    () => createSkillProvider(),
    (error) => {
      assert.ok(
        error.message.includes(packagedSkills),
        `错误信息应含包内 skills/ 绝对路径，实际：${error.message}`,
      );
      return true;
    },
  );
});

// ─── 多根与 signal ───────────────────────────────────────────────

test('provider: 多根逐根扫描并按 name 字节序汇总', async () => {
  const extra = await makeEmptyRoot();
  const primary = await makeRoot({ exclude: ['broken'] });
  try {
    await mkdir(join(extra.root, 'zeta'), { recursive: true });
    await writeFile(join(extra.root, 'zeta', 'SKILL.md'), LEGAL('zeta'));
    const provider = createSkillProvider([extra.root, primary.root]);
    assert.deepEqual(
      (await provider.list()).map((candidate) => candidate.name),
      ['alpha', 'hidden-skill', 'zeta'],
    );
  } finally {
    await extra.cleanup();
    await primary.cleanup();
  }
});

test('provider: list()/get() 尊重 options.signal.throwIfAborted', async () => {
  const { root, cleanup } = await makeRoot({ exclude: ['broken'] });
  try {
    const provider = createSkillProvider([root]);
    const aborted = {
      signal: {
        throwIfAborted() {
          throw new Error('aborted by caller');
        },
      },
    };
    await assert.rejects(() => provider.list(aborted), /aborted by caller/);

    const candidate = (await provider.list()).find((entry) => entry.name === 'alpha');
    await assert.rejects(() => provider.get(candidate, aborted), /aborted by caller/);

    // 未 abort 的 options 与缺省 options 结果一致。
    const signal = { throwIfAborted() {} };
    assert.deepEqual(
      (await provider.list({ signal })).map((candidate) => candidate.name),
      (await provider.list()).map((candidate) => candidate.name),
    );
  } finally {
    await cleanup();
  }
});

// ─── 合成入口 skill `ppt-master-env`（Task 6）──────────────────────
//
// 决策A（brief Produces）：入口技能**仅当 provider 以参数缺省创建**（生产包内根）时
// 追加；任何**显式 roots**——包括等于包内 `skills/` 者——一律不追加。合成候选是**内存
// 对象**：不带 `resourceBase`（宿主 `@deepseek-ai/dsh-skill` 对该字段条件透传、可选），
// 不落盘、不进 verify-plugin 字节比对面。正文在**实例注册期**按 `opts.venv` 经
// `effectiveInterpreter` 的判定渲染一次（四态；broken 是 `on-ready` 子态，落「开但
// 未就绪」文案——不另立第五态）。
//
// 生产根断言以包内 `skills/ppt-master` 已首灌（T14）为前提。

const packagedSkillsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const packagedSkillDir = join(packagedSkillsRoot, 'ppt-master');
const ENTRY_SKILL_NAME = 'ppt-master-env';

/** 生产根形态：参数缺省（无显式 roots）+ opts.venv——决策A 下唯一追加入口技能的形态。 */
const productionProvider = (venv) => createSkillProvider(undefined, { venv });

/** 去引用普通值形态的 venv 配置（与 Task 5 注入袋下传形态一致）。 */
const venvConfig = (dir, enabled = true) => ({ enabled, path: dir, oldPathPolicy: 'keep' });

/** 假 venv 目录：`pyvenv.cfg` 恒在，`bin/python3` 存在与否决定 on-ready / broken。 */
async function makeFakeVenv({ interpreter = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'skill-provider-venv-'));
  await writeFile(join(dir, 'pyvenv.cfg'), 'home = /usr\n');
  if (interpreter) {
    await mkdir(join(dir, 'bin'), { recursive: true });
    await writeFile(join(dir, 'bin', 'python3'), '');
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** 生产根形态读回入口技能定义（缺失时为 undefined）。 */
const entryDefinition = (venv) => productionProvider(venv).get({ name: ENTRY_SKILL_NAME });

/** 入口技能正文；未合成时为 `''`（便于逐字符串断言直接命中差异）。 */
const entryContent = async (venv) => (await entryDefinition(venv))?.content ?? '';

/** 包内 skills/ 全量相对路径快照：任何新增写入（含新目录）都会改变该列表。 */
const treeListing = (root) => readdirSync(root, { recursive: true }).sort();

test('入口 skill: 决策A——参数缺省（生产包内根）列表 = vendor N + 1，字节序升序', async () => {
  assert.ok(existsSync(join(packagedSkillDir, 'SKILL.md')), '前置：包内 skills/ppt-master 已随首灌落地');
  const vendorNames = (await createSkillProvider([packagedSkillsRoot]).list()).map((c) => c.name);
  const listed = await productionProvider(venvConfig('~/.ppt-master/venv', false)).list();
  const names = listed.map((candidate) => candidate.name);

  assert.equal(names.length, vendorNames.length + 1, '生产根列表 = vendor N + 入口 1');
  assert.deepEqual(names, [...vendorNames, ENTRY_SKILL_NAME].sort(), '入口候选按 name 字节序并入，无重复无遗漏');
  assert.equal(names[0], 'ppt-master', "'ppt-master' 仍在首位（'ppt-master' < 'ppt-master-env'）");
});

test('入口 skill: 决策A 反向——注入 fixture 根 → 列表不含入口技能', async () => {
  const { root, cleanup } = await makeRoot({ exclude: ['broken'] });
  try {
    // 生产根形态确有入口技能（对照面成立），本根不得有——零改动保护归因即此条。
    const productionNames = (await productionProvider(venvConfig('~/.ppt-master/venv', false)).list()).map(
      (candidate) => candidate.name,
    );
    assert.ok(productionNames.includes(ENTRY_SKILL_NAME), '前置对照：生产根形态确实追加');
    const names = (await createSkillProvider([root]).list()).map((candidate) => candidate.name);
    assert.deepEqual(names, ['alpha', 'hidden-skill']);
    assert.ok(!names.includes(ENTRY_SKILL_NAME), 'fixture 根不得追加合成入口');
  } finally {
    await cleanup();
  }
});

test('入口 skill: 决策A 最强判别——显式 roots＝包内 skills/ → 同样不追加', async () => {
  const names = (await createSkillProvider([packagedSkillsRoot]).list()).map((c) => c.name);
  assert.ok(names.includes('ppt-master'), '前置：显式包内根确实扫到 vendor 技能');
  assert.ok(!names.includes(ENTRY_SKILL_NAME), '显式 roots 一律不追加，即使等于包内 skills/');
});

test('入口 skill: 候选形态——不带 resourceBase/path/locator（无文件绑定字段）', async () => {
  const candidate = (await productionProvider(venvConfig('~/.ppt-master/venv', false)).list()).find(
    (entry) => entry.name === ENTRY_SKILL_NAME,
  );
  assert.ok(candidate, '生产根列表应含入口候选');

  assert.ok(!('resourceBase' in candidate), '宿主对 resourceBase 条件透传、可选：合成候选钉死不携带');
  assert.ok(!('path' in candidate), '磁盘上无该文件，path 不得伪造');
  assert.ok(!('locator' in candidate), '磁盘上无该文件，locator 不得伪造');
  assert.ok(!('content' in candidate), 'content 只在 get() 的定义面出现');

  assert.deepEqual(Object.keys(candidate).sort(), [
    'description',
    'invocation',
    'name',
    'provider',
    'rank',
    'source',
  ]);
  assert.equal(candidate.provider, 'dsh-ppt-master-wrapper');
  assert.equal(candidate.source, 'custom');
  assert.equal(candidate.rank, SKILL_RANK);
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true });
});

test('入口 skill: description 中英双语，声明「任何 ppt-master 路由前必须先读本入口」', async () => {
  const definition = await entryDefinition(venvConfig('~/.ppt-master/venv', false));
  assert.ok(definition, '入口技能须可按名读回');
  assert.match(definition.description, /任何 ppt-master 路由前必须先读本入口/);
  assert.match(definition.description, /Read this entry before any ppt-master routing/);
});

test('入口 skill: 态1（venv 开+已建）——绝对解释器路径替换字面 python3（含 attribution_guard）', async () => {
  const { dir, cleanup } = await makeFakeVenv();
  try {
    const content = await entryContent(venvConfig(dir));
    assert.ok(
      content.includes(`生效解释器：\`${join(dir, 'bin', 'python3')}\``),
      `态1 须给出 <解析后绝对路径>/bin/python3，实际正文：${content}`,
    );
    assert.ok(content.includes('替换字面 `python3`'), '态1 须要求以该绝对路径替换字面 python3');
    assert.ok(content.includes('attribution_guard'), '态1 须点名 SKILL.md 第 2 步 attribution_guard');
    assert.ok(!content.includes('venv 未启用'));
    assert.ok(!content.includes('配置无效'));
    assert.ok(!content.includes('先调用 `ppt_master_setup_deps` 准备环境'));
  } finally {
    await cleanup();
  }
});

test('入口 skill: 态2（venv 开+未建）——先 setup_deps、之前不得跑系统 python3', async () => {
  const missing = join(tmpdir(), 'skill-provider-venv-not-created');
  assert.ok(!existsSync(missing), '前置：该 venv 路径确实不存在');
  const content = await entryContent(venvConfig(missing));
  assert.ok(content.includes('先调用 `ppt_master_setup_deps` 准备环境'), '态2 须前置路由到 setup_deps');
  assert.ok(
    content.includes('不要以系统 `python3` 运行任何上游业务脚本'),
    '态2 须禁止在准备前以系统 python3 跑业务脚本',
  );
  assert.ok(!content.includes('替换字面 `python3`'), '态2 无可用解释器，不得给出态1 契约');
  assert.ok(!content.includes('venv 未启用'));
  assert.ok(!content.includes('配置无效'));
});

test('入口 skill: 态2 同文案承载 broken 子态——broken 与 on-missing 正文逐字节相同', async () => {
  const { dir, cleanup } = await makeFakeVenv({ interpreter: false });
  try {
    const broken = await entryContent(venvConfig(dir)); // exists（pyvenv.cfg 在）但 bin/python3 缺失
    await rm(join(dir, 'pyvenv.cfg'));
    const missing = await entryContent(venvConfig(dir)); // 同一路径，venv 目录不存在 → on-missing

    assert.ok(broken.includes('先调用 `ppt_master_setup_deps` 准备环境'), 'broken 落「开但未就绪」文案');
    assert.ok(!broken.includes(`\`${join(dir, 'bin', 'python3')}\``), 'broken 无解析成功解释器，不得给路径');
    assert.equal(broken, missing, 'broken 是 on-ready 子态，取四态文案之一，不另立第五态');
  } finally {
    await cleanup();
  }
});

test('入口 skill: 态3（venv 关）——系统 python3；disabled×invalid 同落此态', async () => {
  const off = await entryContent(venvConfig('~/.ppt-master/venv', false));
  assert.ok(off.includes('venv 未启用：使用系统 `python3`（现状系统模式）。'));
  assert.ok(!off.includes('配置无效'), 'disabled 优先：路径合法与否都不落态4');
  assert.ok(!off.includes('替换字面 `python3`'));
  assert.ok(!off.includes('先调用 `ppt_master_setup_deps` 准备环境'));

  // disabled×invalid（enabled:false + 相对路径）按 effectiveInterpreter 落 off → 逐字节同文案。
  const disabledInvalid = await entryContent(venvConfig('relative/venv', false));
  assert.equal(disabledInvalid, off);
});

test('入口 skill: 态4（配置无效）——修正指引 + 按系统模式继续', async () => {
  const content = await entryContent(venvConfig('relative/venv'));
  assert.ok(content.includes('配置无效'), '态4 须显式声明配置无效');
  assert.ok(content.includes('绝对路径'), '态4 须给出修正方向（绝对路径 / ~/ 前缀）');
  assert.ok(content.includes('按系统模式继续'), '态4 须按系统模式继续');
  assert.ok(content.includes('系统 `python3`'));
  assert.ok(!content.includes('venv 未启用'), 'invalid≠off：态4 与态3 文案必须可区分');
  assert.ok(!content.includes('替换字面 `python3`'));
  assert.ok(!content.includes('先调用 `ppt_master_setup_deps` 准备环境'));
});

test('入口 skill: opts.venv 缺 enabled 键（测试/嵌入面直呼工厂）→ 归一为关闭（态3），不得静默开启（P2 G3-09）', async () => {
  const missing = join(tmpdir(), 'skill-provider-venv-no-enabled');
  assert.ok(!existsSync(missing), '前置：该路径确实不存在（未归一化时会落"开但未建"态2）');

  // 直呼工厂的部分对象：`{path}` 而无 `enabled`。工厂入口须把"缺失或非 true 的 enabled"
  // 归一为 false——否则 `effectiveInterpreter` 的 `venv?.enabled === false` 字面判定会把它
  // 当成已启用，入口正文给出态2 指引、`setup_deps` 还会真的去建目录。
  const content = await entryContent({ path: missing });

  assert.ok(
    content.includes('venv 未启用：使用系统 `python3`（现状系统模式）。'),
    `缺 enabled 键 ⇒ 态3（系统模式），实际正文：${content}`,
  );
  assert.ok(!content.includes('先调用 `ppt_master_setup_deps` 准备环境'), '不得落态2（未启用）');
  assert.ok(!content.includes('配置无效'), '归一化出的是"配置为关闭"，不是 invalid');
  assert.equal(
    content,
    await entryContent(venvConfig('~/.ppt-master/venv', false)),
    '与显式 enabled:false（路径合法）逐字节同文案',
  );
});

test('入口 skill: venv 键整体缺省（未配置）仍如实落态4——归一化不得把"未配置"改写成默认袋', async () => {
  const content = await entryContent(undefined);
  assert.ok(content.includes('配置无效'), '未配置 ⇒ 单次求值给出的 invalid（path=null），不猜默认路径');
});

test('入口 skill: 正文含 SKILL_DIR（provider 侧元数据锚定）、读毕路由与固定脚注', async () => {
  const content = await entryContent(venvConfig('~/.ppt-master/venv', false));
  assert.ok(
    content.includes(`SKILL_DIR: ${packagedSkillDir}`),
    `SKILL_DIR 须由 provider 自身已加载的元数据锚定（name==='ppt-master' 优先），实际正文：${content}`,
  );
  assert.ok(content.includes(`\`${packagedSkillDir}/SKILL.md\``), '须指明读哪个 SKILL.md');
  assert.ok(content.includes('路由 `ppt-master`'), '读毕须路由到 ppt-master');
  assert.ok(content.includes('ppt_master_info'));
  assert.ok(content.includes('ppt_master_check_env'), '固定脚注须指向实时查询工具');
  assert.ok(content.includes('快照'), '脚注须声明正文为实例注册期快照');
});

test('入口 skill: get() 按名读回，content 非空且为已渲染正文', async () => {
  const definition = await entryDefinition(venvConfig('~/.ppt-master/venv', false));
  assert.ok(definition, 'get() 须可按名读回入口候选');
  assert.equal(definition.name, ENTRY_SKILL_NAME);
  assert.equal(typeof definition.content, 'string');
  assert.ok(definition.content.length > 200, '正文须为完整渲染体而非空串');
  assert.ok(!('resourceBase' in definition), '定义面同样不携带 resourceBase');
});

test('入口 skill: 不落盘——创建/list/get 前后包内 skills/ 树逐项不变', async () => {
  const before = treeListing(packagedSkillsRoot);
  const { dir, cleanup } = await makeFakeVenv();
  try {
    const provider = productionProvider(venvConfig(dir));
    const candidates = await provider.list();
    const candidate = candidates.find((entry) => entry.name === ENTRY_SKILL_NAME);
    const definition = await provider.get(candidate);
    assert.ok(definition.content.includes(`\`${join(dir, 'bin', 'python3')}\``));
  } finally {
    await cleanup();
  }
  assert.deepEqual(treeListing(packagedSkillsRoot), before, '入口技能为内存合成，不得新增任何文件');
  assert.ok(!existsSync(join(packagedSkillsRoot, ENTRY_SKILL_NAME)), '入口技能目录绝不出现在磁盘上');
});
