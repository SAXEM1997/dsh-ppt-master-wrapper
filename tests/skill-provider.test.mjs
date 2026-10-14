import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
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
