import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { normalizedSha256, parseExpectedDigest, runVerify } from '../scripts/verify-plugin.mjs';
import { apply } from '../index.js';

/**
 * Task 8 契约：verify-plugin.mjs（guard 逐项等价 + 全量比对 + 两级判据）。
 *
 * 检查清单①-⑨逐项对应——
 * ① LICENSE 归一化摘要（期望值解析自被验树 guard）② frontmatter 三键逐字精确值
 * （SKILL.md 当前值与 guard `_EXACT_METADATA_VALUES` 互证）③ 归属文件存在
 * ④ 9 门文件存在 ⑤ 门标记计数==1 ⑥ 方向性 skill 面全量逐字节比对
 * （upstream 多余内容豁免；缺省 upstream fail-loud）⑦ SKILL.md 相对链接
 * （子树内死链→problems；越界→warnings）⑧ 门标记存在（`${SKILL_DIR}` 独立判据，
 * 不依赖⑤计数）⑨ mock ctx 驱动真实 index.js：3 工具注册
 * 且各 output.schema 为 object-rooted + additionalProperties:false。
 *
 * 另：frontmatter 两级判据（name≠目录名→warnings；name 缺失/非 kebab、
 * description 缺失→problems，provider throw 被捕获转 problems 不逃逸）；
 * skipGuard=true → warnings 含「guard 未运行」标记；problems 非空 → CLI exit 1。
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const miniVendorRoot = join(fixturesDir, 'mini-vendor'); // skills 根形态：其下直接是 ppt-master/
const miniUpstreamRoot = join(fixturesDir, 'mini-upstream'); // 解压仓库根形态：skills/ppt-master/
const SKILL_REL = 'ppt-master';
const execFileAsync = promisify(execFile);
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'verify-plugin.mjs');

const GATE_MARKER = 'python3 "${SKILL_DIR}/scripts/attribution_guard.py"';
const KEBAB_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** problems/warnings 中是否存在匹配项。 */
const someProblem = (result, pattern) => result.problems.some((entry) => pattern.test(entry));
const someWarning = (result, pattern) => result.warnings.some((entry) => pattern.test(entry));

/**
 * 构造一对临时树：`<tmp>/root`（skills 根）+ `<tmp>/upstream`（解压仓库根）。
 * 两树初始互为 mini fixture 拷贝，⑥ 全量比对天然通过。
 */
async function makePair() {
  const base = await mkdtemp(join(tmpdir(), 'verify-pair-'));
  const root = join(base, 'root');
  const upstream = join(base, 'upstream');
  await cp(miniVendorRoot, root, { recursive: true });
  await cp(miniUpstreamRoot, upstream, { recursive: true });
  const pair = {
    base,
    root,
    upstream,
    rootSkill: join(root, SKILL_REL),
    upstreamSkill: join(upstream, 'skills', SKILL_REL),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
  pair.editRoot = (relPath, transform) => editFile(join(pair.rootSkill, relPath), transform);
  /** 同一改动镜像到两树的同一相对文件——⑥ 保持通过，判定归于被测检查项。 */
  pair.mirror = (relPath, transform) =>
    Promise.all(
      [join(pair.rootSkill, relPath), join(pair.upstreamSkill, relPath)].map((file) =>
        editFile(file, transform),
      ),
    );
  /** 两树同时删除同一相对文件。 */
  pair.mirrorDelete = (relPath) =>
    Promise.all([
      rm(join(pair.rootSkill, relPath), { force: true }),
      rm(join(pair.upstreamSkill, relPath), { force: true }),
    ]);
  return pair;
}

async function editFile(file, transform) {
  await writeFile(file, transform(await readFile(file, 'utf8')));
}

// ─── normalizedSha256：guard `_normalized_bytes` 的 JS 复刻 ──────

test('normalizedSha256: LF 与 CRLF/CR 版同内容 → 同摘要（CRLF 签出环境不误报）', () => {
  const lf = new TextEncoder().encode('line one\nline two\n');
  const crlf = new TextEncoder().encode('line one\r\nline two\r\n');
  const cr = new TextEncoder().encode('line one\rline two\r');
  const expected = createHash('sha256').update('line one\nline two\n', 'utf8').digest('hex');

  assert.equal(normalizedSha256(lf), expected, 'LF 版摘要与独立计算的归一化 sha256 一致');
  assert.equal(normalizedSha256(crlf), expected, 'CRLF 版归一化后与 LF 版同摘要');
  assert.equal(normalizedSha256(cr), expected, '孤立 CR 版归一化后与 LF 版同摘要');
});

test('normalizedSha256: 带 UTF-8 BOM → throw（guard 同款拒绝，非静默剥离）', () => {
  const bom = new TextEncoder().encode('\uFEFFline one\n');
  assert.throws(() => normalizedSha256(bom), /BOM/i);
});

// ─── parseExpectedDigest：① 的期望值来源 ─────────────────────────

test('parseExpectedDigest: 正常 guard 源 → 摘要常量', async () => {
  const source = await readFile(join(miniVendorRoot, SKILL_REL, 'scripts', 'attribution_guard.py'), 'utf8');
  assert.equal(
    parseExpectedDigest(source),
    'd277531d50833ed39cac5e65e614317fcd548a1c6151bde6ef8d226a2ddd70c9',
  );
});

test('parseExpectedDigest: 无常量源 → throw（fail-loud，不静默跳过）', () => {
  assert.throws(() => parseExpectedDigest('def main():\n    pass\n'), /_LICENSE_DIGEST/);
});

// ─── 基线全绿：problems 空、warnings 空 ─────────────────────────

test('runVerify: mini fixture 基线全绿（problems 空、warnings 空，须传 upstream）', async () => {
  const result = await runVerify(miniVendorRoot, { upstream: miniUpstreamRoot });
  assert.deepEqual(result.problems, [], `基线不得有问题项: ${result.problems.join(' | ')}`);
  assert.deepEqual(result.warnings, [], `基线不得有警告项: ${result.warnings.join(' | ')}`);
});

test('runVerify 基线: list/get 往返一致（经 apply(ctx,{skillRoots}) 驱动真实 index.js）', async () => {
  const providers = [];
  const ctx = { skills: { registerProvider: (factory) => providers.push(factory) } };
  apply(ctx, { skillRoots: [miniVendorRoot] });

  const provider = providers[0]();
  const listed = await provider.list();
  assert.equal(listed.length, 1, 'mini-vendor 恰一个 skill 目录');
  assert.equal(listed[0].name, 'ppt-master');
  assert.equal(listed[0].description.includes('Mini fixture skill'), true);

  const definition = await provider.get({ name: 'ppt-master' });
  assert.notEqual(definition, undefined, 'get() 必须返回完整定义');
  assert.equal(definition.name, 'ppt-master');
  assert.equal(typeof definition.content, 'string', 'get() 返回 frontmatter 后正文 content');
  assert.equal(definition.content.startsWith('\n# Mini PPT Master'), true);
  assert.equal(definition.metadata.version, '6.7.0', 'metadata 透传（本 fixture 携带）');
});

test('runVerify 基线: mock ctx 断言 3 工具注册且 output.schema 为 object-rooted + AP:false（⑨）', async () => {
  const tools = [];
  const ctx = {
    skills: { registerProvider: () => {} },
    tools: { register: (tool) => tools.push(tool) },
  };
  apply(ctx, { skillRoots: [miniVendorRoot] });

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['ppt_master_info', 'ppt_master_check_env', 'ppt_master_setup_deps'],
    '恰好 3 个生命周期工具，名字逐字',
  );
  for (const tool of tools) {
    const schema = tool.output.schema;
    assert.equal(schema.type, 'object', `${tool.name} schema object-rooted`);
    assert.equal(schema.type === 'json', false, `${tool.name} 不得用 type:'json'（SDK 静默降级）`);
    assert.equal(
      typeof schema.properties,
      'object',
      `${tool.name} schema 显式字段定义（非空 properties）`,
    );
    assert.ok(Object.keys(schema.properties).length > 0, `${tool.name} properties 非空`);
    assert.equal(schema.additionalProperties, false, `${tool.name} schema 显式 AP:false`);
    assert.equal(typeof tool.output.render, 'function', `${tool.name} output.render 为函数`);
  }
});

// ─── skipGuard：标记归属 warnings（Review Focus #5）─────────────

test('runVerify: skipGuard=true → warnings 含「guard 未运行」标记，problems 仍空', async () => {
  const result = await runVerify(miniVendorRoot, { skipGuard: true, upstream: miniUpstreamRoot });
  assert.equal(someWarning(result, /guard 未运行/), true, '标记必须在 warnings——它不是缺陷');
  assert.deepEqual(result.problems, [], 'skipGuard 不产生问题项（JS 等价校验照常运行）');
});

// ─── ⑥ 缺省 upstream：fail-loud，不静默跳 ───────────────────────

test('runVerify: 未传 upstream → problems 含「需提供 --upstream 比对树」提示', async () => {
  const result = await runVerify(miniVendorRoot);
  assert.equal(someProblem(result, /需提供 --upstream 比对树/), true, '缺省语义 fail-loud');
  assert.ok(result.problems.length >= 1);
});

test('runVerify: upstream 路径不存在 → problems 指明不可用', async () => {
  const result = await runVerify(miniVendorRoot, { upstream: join(tmpdir(), 'no-such-upstream') });
  assert.equal(someProblem(result, /--upstream 路径不可用/), true);
});

// ─── 篡改①：LICENSE 一字节 → guard 等价清单拦截（digest 不匹配）──

test('runVerify: LICENSE 改一字节 → problems 含归一化摘要不匹配（guard 等价①拦截）', async () => {
  const pair = await makePair();
  try {
    await pair.editRoot('LICENSE', (text) => text.replace('WITHOUT WARRANTY', 'WITHOUT WARRAHTY'));
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.equal(someProblem(result, /归一化摘要不匹配/), true, 'digest 不匹配必须落入 problems');
    assert.equal(someProblem(result, /逐字节不一致/), true, '⑥ 同时也拦（LICENSE 与 upstream 不同）');
  } finally {
    await pair.cleanup();
  }
});

// ─── 篡改②：非门文件一字节 + 干净 upstream → ⑥ 全量比对拦截 ─────

test('runVerify: 非门文件改一字节 → 全量逐字节比对拦截，guard 等价清单不误报（Review Focus #6）', async () => {
  const pair = await makePair();
  try {
    // references/notes.md 非门文件、非归属文件、非 SKILL.md——guard 固定清单守不到
    await pair.editRoot('references/notes.md', (text) => text.replace('Mini reference notes', 'Mini reference noted'));
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.equal(someProblem(result, /逐字节不一致/), true, '⑥ 必须拦截');
    assert.equal(
      someProblem(result, /references\/notes\.md/),
      true,
      '问题项指名分歧文件',
    );
    assert.equal(someProblem(result, /归一化摘要不匹配/), false, 'guard 等价清单（①）不检测该文件');
    assert.equal(someProblem(result, /门文件缺失/), false);
  } finally {
    await pair.cleanup();
  }
});

test('runVerify: 被验树多出 upstream 没有的文件 → problems 拦截（skill 面内双向）', async () => {
  const pair = await makePair();
  try {
    await writeFile(join(pair.rootSkill, 'references', 'extra.md'), 'extra file\n');
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.equal(someProblem(result, /仅存在于被验树/), true);
    assert.equal(someProblem(result, /references\/extra\.md/), true);
  } finally {
    await pair.cleanup();
  }
});

test('runVerify: upstream 缺整个同名 skill 目录 → problems 指明', async () => {
  const pair = await makePair();
  try {
    await rm(pair.upstreamSkill, { recursive: true, force: true });
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.equal(someProblem(result, /缺少对应 skill 目录/), true);
  } finally {
    await pair.cleanup();
  }
});

// ─── 不对称 upstream：根文件/辅助目录/多余 skill 目录豁免 ─────────

test('runVerify: upstream 多出根文件、skills/ 辅助目录与多余 skill 目录 → 不产生 problems（方向性 skill 面）', async () => {
  const pair = await makePair();
  try {
    await writeFile(join(pair.upstream, 'README.md'), 'upstream root file, not vendored\n');
    await mkdir(join(pair.upstream, 'skills', '.claude-plugin'), { recursive: true });
    await writeFile(
      join(pair.upstream, 'skills', '.claude-plugin', 'plugin.json'),
      '{"name": "upstream-plugin"}\n',
    );
    await mkdir(join(pair.upstream, 'skills', 'second-skill'), { recursive: true });
    await writeFile(
      join(pair.upstream, 'skills', 'second-skill', 'SKILL.md'),
      '---\nname: second-skill\ndescription: Upstream-only skill outside the vendored face.\n---\n\nBody.\n',
    );
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.deepEqual(result.problems, [], `上游根文件/辅助目录/多余 skill 目录均不在 vendor 面: ${result.problems.join(' | ')}`);
    assert.deepEqual(result.warnings, []);
  } finally {
    await pair.cleanup();
  }
});

// ─── frontmatter 两级判据 ────────────────────────────────────────

test('runVerify: name≠目录名 → warnings 含之，不进 problems（两级判据）', async () => {
  const pair = await makePair();
  try {
    await pair.mirror('SKILL.md', (text) => text.replace('name: ppt-master', 'name: renamed-skill'));
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.deepEqual(result.problems, [], 'name≠目录名不判失败');
    assert.equal(someWarning(result, /renamed-skill/), true, '警告指明 frontmatter name');
    assert.equal(someWarning(result, /目录名/), true);
  } finally {
    await pair.cleanup();
  }
});

test('runVerify: name 缺失 → problems 含 name 项，provider throw 被捕获不逃逸', async () => {
  const pair = await makePair();
  try {
    await pair.mirror('SKILL.md', (text) => text.replace('name: ppt-master\n', ''));
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.equal(someProblem(result, /name 缺失/), true);
    assert.equal(someProblem(result, /requires a name|注册失败/), true, 'provider fail-loud 也转 problems');
  } finally {
    await pair.cleanup();
  }
});

test('runVerify: name 非 kebab-case → problems（T13 预埋 fixture 用例）', async () => {
  const pair = await makePair();
  try {
    await pair.mirror('SKILL.md', (text) => text.replace('name: ppt-master', 'name: PPT Master'));
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.equal(someProblem(result, /非 kebab-case/), true);
    assert.ok(KEBAB_PATTERN.test('ppt-master') && !KEBAB_PATTERN.test('PPT Master'));
  } finally {
    await pair.cleanup();
  }
});

test('runVerify: description 缺失 → problems 含 description 项（spec §6 verify 行判据）', async () => {
  const pair = await makePair();
  try {
    await pair.mirror(
      'SKILL.md',
      (text) =>
        text.replace(
          'description: >\n  Mini fixture skill standing in for the vendored ppt-master tree during\n  verify-plugin tests; mirrors the upstream SKILL.md frontmatter shape.\n',
          '',
        ),
    );
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.equal(someProblem(result, /description 缺失/), true);
  } finally {
    await pair.cleanup();
  }
});

// ─── ⑦ 链接：越界 warnings / 子树死链 problems ──────────────────

test('runVerify: 越界链接（../../../docs/x.md）→ warnings 含之（豁免语义），problems 空', async () => {
  const pair = await makePair();
  try {
    await pair.mirror('SKILL.md', (text) => `${text}\nUpstream docs live at [external docs](../../../docs/x.md).\n`);
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.deepEqual(result.problems, [], '越界链接不判失败（上游结构使然）');
    assert.equal(someWarning(result, /越出 skill 子树|越界/), true);
    assert.equal(someWarning(result, /docs\/x\.md/), true);
  } finally {
    await pair.cleanup();
  }
});

test('runVerify: 子树内死链 → problems 含之，warnings 空', async () => {
  const pair = await makePair();
  try {
    await pair.mirror('SKILL.md', (text) => `${text}\nMissing target: [missing notes](references/missing.md).\n`);
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.equal(someProblem(result, /死链/), true);
    assert.equal(someProblem(result, /references\/missing\.md/), true);
    assert.deepEqual(result.warnings, [], '死链不是豁免场景');
  } finally {
    await pair.cleanup();
  }
});

// ─── ①② 期望值解析自被验树：guard 文件本身 ─────────────────────

test('runVerify: attribution_guard.py 缺失 → problems 含解析失败（fail-loud 不静默跳）', async () => {
  const pair = await makePair();
  try {
    await pair.mirrorDelete('scripts/attribution_guard.py');
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.equal(someProblem(result, /_LICENSE_DIGEST/), true, '① 的期望值来源不可达必须显式失败');
    assert.equal(someProblem(result, /_EXACT_METADATA_VALUES|attribution_guard\.py/), true);
  } finally {
    await pair.cleanup();
  }
});

test('runVerify: SKILL.md copyright 值被改（guard 常量未动）→ ② 双重核对拦截', async () => {
  const pair = await makePair();
  try {
    // 只改 SKILL.md（两树镜像，⑥ 通过）；guard 常量未动 → guard 常量与当前值互证失败
    await pair.mirror(
      'SKILL.md',
      (text) => text.replace('copyright: "Copyright (c) 2025-2026 Hugo He"', 'copyright: "Copyright (c) 2025-2026 Someone Else"'),
    );
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.equal(someProblem(result, /copyright/), true);
    assert.equal(someProblem(result, /不一致/), true, 'frontmatter 值与 guard 常量不一致');
  } finally {
    await pair.cleanup();
  }
});

test('runVerify: frontmatter 缺 metadata.sponsors 行 → problems（guard _REQUIRED_METADATA_FIELDS 存在性）', async () => {
  const pair = await makePair();
  try {
    await pair.mirror('SKILL.md', (text) =>
      text.replace('  sponsors:\n    - "SPONSORS.md"\n    - "SPONSORS_CN.md"\n', ''),
    );
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.equal(someProblem(result, /sponsors/), true);
  } finally {
    await pair.cleanup();
  }
});

// ─── ③④⑤：归属文件 / 门文件 / 门标记计数（⑤蕴含⑧）────────────

test('runVerify: SPONSORS.md 缺失 → problems 含归属文件项（③）', async () => {
  const pair = await makePair();
  try {
    await pair.mirrorDelete('SPONSORS.md');
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.equal(someProblem(result, /归属文件缺失/), true);
    assert.equal(someProblem(result, /SPONSORS\.md/), true);
  } finally {
    await pair.cleanup();
  }
});

test('runVerify: 门文件缺失 → problems 含门文件项（④）', async () => {
  const pair = await makePair();
  try {
    await pair.mirrorDelete('scripts/register_template.py');
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.equal(someProblem(result, /门文件缺失/), true);
    assert.equal(someProblem(result, /register_template\.py/), true);
  } finally {
    await pair.cleanup();
  }
});

test('runVerify: SKILL.md 门标记被移除 → problems 含计数项（⑤计数≠1 蕴含⑧缺失）', async () => {
  const pair = await makePair();
  try {
    await pair.mirror('SKILL.md', (text) => text.split(GATE_MARKER).join('python3 "attribution_guard.py"'));
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.equal(someProblem(result, /门标记计数 0/), true);
  } finally {
    await pair.cleanup();
  }
});

test('runVerify: SKILL.md 全文无 ${SKILL_DIR} → problems 含独立存在性项（⑧不依赖⑤计数）', async () => {
  const pair = await makePair();
  try {
    // 计数标记常量仍可被 guard 正则解析，且⑤计数仍==1（仅字面量换成不含 ${SKILL_DIR} 的
    // 等长语义替代）——独立判据必须自行发现存在性缺失，不得由⑤传递蕴含。
    await pair.mirror('scripts/attribution_guard.py', (text) =>
      text.replace(/_SKILL_GATE_MARKER\s*=\s*'[^']*'/, "_SKILL_GATE_MARKER = 'python3 \\\"attribution_guard.py\\\"'"),
    );
    await pair.mirror('SKILL.md', (text) =>
      text.split(GATE_MARKER).join('python3 "attribution_guard.py"'),
    );
    const result = await runVerify(pair.root, { upstream: pair.upstream });
    assert.equal(someProblem(result, /门标记计数 1/), false, '⑤计数仍为 1，不得记计数项');
    assert.equal(someProblem(result, /\$\{SKILL_DIR\}.*缺失|缺失.*\$\{SKILL_DIR\}/), true);
  } finally {
    await pair.cleanup();
  }
});

// ─── 路径形态：相对 root 不得误报（resolve 归一）────────────────

test('runVerify: 相对路径 root/upstream 也不误报链接越界（含 ⑥ 配对）', async () => {
  const relativeRoot = relative(process.cwd(), miniVendorRoot);
  const relativeUpstream = relative(process.cwd(), miniUpstreamRoot);
  const result = await runVerify(relativeRoot, { upstream: relativeUpstream });
  assert.deepEqual(result.problems, [], `相对路径必须与绝对路径同判: ${result.problems.join(' | ')}`);
  assert.deepEqual(result.warnings, [], `相对 root 下链接解析不得误报越界: ${result.warnings.join(' | ')}`);
});

// ─── CLI：exit 0 / exit 1 / --skip-guard 标记 ───────────────────

test('CLI: --root mini-vendor --upstream mini-upstream → exit 0', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    scriptPath, '--root', miniVendorRoot, '--upstream', miniUpstreamRoot,
  ]);
  assert.match(stdout, /problems 0/);
});

test('CLI: 未传 --upstream → exit 1 且列出全部 problems', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, '--root', miniVendorRoot]),
    (error) => {
      assert.equal(error.code, 1, 'problems 非空 → verify-plugin 自身 exit 1');
      assert.match(error.stdout, /需提供 --upstream 比对树/);
      return true;
    },
  );
});

test('CLI: --skip-guard → exit 0 且输出含「guard 未运行」标记', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    scriptPath, '--root', miniVendorRoot, '--upstream', miniUpstreamRoot, '--skip-guard',
  ]);
  assert.match(stdout, /guard 未运行/);
});
