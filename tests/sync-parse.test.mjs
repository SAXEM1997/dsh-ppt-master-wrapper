import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCodeloadUrl,
  cacheKey,
  diskBudget,
  main,
  normalizeRef,
  parseArgs,
  parseLsRemote,
  pickLatestTag,
  readLastSync,
  writeLastSync,
} from '../scripts/sync-upstream.mjs';

/**
 * Task 10 契约：sync 解析层（repo/ref/tag/缓存/预检）。
 *
 * 全部用例为**自造 fixture 字符串**（`git ls-remote --tags` 文本、repo URL），
 * 零网络、零 npm 依赖。覆盖面——
 * - parseLsRemote：无序输出（v2.13.0 出现在 v2.2.0 之前）+ `^{}` 松散行 +
 *   轻量 tag 行 → 剥除松散行后的**主行单一返回数组**，annotated 信息以
 *   `isAnnotated` 布尔并入同一返回（无第二返回值/旁路映射）。
 * - pickLatestTag：`^v?\d+\.\d+\.\d+$` 过滤（排除 rc/pre-release）+ **数字元组
 *   逐段比较**（6.10.0 > 6.7.0；2.13.0 > 2.2.0）+ **保留远端原名（带 v 前缀）**；
 *   无匹配 → null。
 * - normalizeRef：tag → `refs/tags/<远端原名>`（保留 v；**绝不双前缀**）；
 *   branch → `refs/heads/<名>`；40 位 hex sha 原样；短 sha → usageError throw。
 * - cacheKey：`<ref>@<sha>`；tag 重推（sha 变）→ 键不同（Review Focus #4）。
 * - diskBudget：无参 = 260MB 固定；有参 = tarball + 114MB + 78MB 三项和。
 * - parseArgs：`--skip-guard` 联用约束（usageError 字段，不 throw）与各字段解析。
 * - last-sync 读写往返：`{ref, sha, version, at}`，无文件/损坏 → null，cwd 无关。
 */

// ─── fixture：ls-remote --tags 文本 ──────────────────────────────

/**
 * 无序输出（v2.13.0 出现在 v2.2.0 之前——字符串比较会把 2.13.0 排在 2.2.0 之下）
 * + annotated tag 的 `^{}` 松散行 + 轻量 tag 行 + rc/pre-release 干扰项。
 */
const LS_REMOTE_FIXTURE = [
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v2.13.0',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/v2.13.0^{}',
  'cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v2.2.0',
  'dddddddddddddddddddddddddddddddddddddddd\trefs/tags/v6.7.0-rc1',
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\trefs/tags/v2.9.0',
  'ffffffffffffffffffffffffffffffffffffffff\trefs/tags/v2.9.0^{}',
  '1111111111111111111111111111111111111111\trefs/tags/v2.10.0',
].join('\n');

const SHA_V2130_TAG = 'a'.repeat(40);
const SHA_V2130_PEELED = 'b'.repeat(40);

const findEntry = (entries, ref) => entries.find((entry) => entry.ref === ref);

// ─── parseLsRemote ───────────────────────────────────────────────

test('parseLsRemote: 剥除 ^{} 松散行——主行单一返回数组，无松散行残留', () => {
  const entries = parseLsRemote(LS_REMOTE_FIXTURE);

  assert.equal(entries.length, 5, `期望 5 个主行条目，实际 ${entries.length}: ${JSON.stringify(entries)}`);
  assert.equal(
    entries.some((entry) => entry.ref.endsWith('^{}')),
    false,
    '松散行必须被剥离，不得作为独立条目残留',
  );
  assert.deepEqual(
    entries.map((entry) => entry.ref),
    ['refs/tags/v2.13.0', 'refs/tags/v2.2.0', 'refs/tags/v6.7.0-rc1', 'refs/tags/v2.9.0', 'refs/tags/v2.10.0'],
    '主行条目（顺序保持 ls-remote 输出序，剥离 ^{} 行）',
  );
});

test('parseLsRemote: tagName = refs/tags/ 之后部分（远端原名）', () => {
  const entries = parseLsRemote(LS_REMOTE_FIXTURE);
  assert.equal(findEntry(entries, 'refs/tags/v2.13.0').tagName, 'v2.13.0');
  assert.equal(findEntry(entries, 'refs/tags/v6.7.0-rc1').tagName, 'v6.7.0-rc1');
});

test('parseLsRemote: annotated 信息以 isAnnotated 布尔并入同一返回（无第二返回值/旁路映射）', () => {
  const entries = parseLsRemote(LS_REMOTE_FIXTURE);

  // annotated：主行 + 其 ^{} 行 → isAnnotated=true；sha 保留主行自身 sha
  // （commit sha 的取行规则由调用方/pickLatestTag 依 isAnnotated 处理）。
  const annotated = findEntry(entries, 'refs/tags/v2.13.0');
  assert.equal(annotated.isAnnotated, true);
  assert.equal(annotated.sha, SHA_V2130_TAG);

  // 轻量 tag（无 ^{} 行）→ isAnnotated=false
  assert.equal(findEntry(entries, 'refs/tags/v2.2.0').isAnnotated, false);
  assert.equal(findEntry(entries, 'refs/tags/v2.10.0').isAnnotated, false);

  // 单一返回数组：不存在第二返回通道，annotated 的 commit sha 必须以条目字段
  // 形态可取（peeledSha）——旁路映射会使其在数组上无处安放。
  assert.equal(annotated.peeledSha, SHA_V2130_PEELED);
  assert.equal(findEntry(entries, 'refs/tags/v2.2.0').peeledSha, null);
});

// ─── pickLatestTag ───────────────────────────────────────────────

test('pickLatestTag: 取 v2.13.0（元组比较 > 2.2.0）且保留远端原名带 v', () => {
  const latest = pickLatestTag(parseLsRemote(LS_REMOTE_FIXTURE));
  assert.notEqual(latest, null);
  assert.equal(latest.name, 'v2.13.0');
  assert.equal(latest.sha, SHA_V2130_PEELED, 'annotated tag 的 commit sha 取 ^{} 行');
});

test('pickLatestTag: 元组逐段比较——6.10.0 > 6.7.0（字符串比较会判反）', () => {
  const text = [
    `1111111111111111111111111111111111111111\trefs/tags/v6.7.0`,
    `2222222222222222222222222222222222222222\trefs/tags/v6.10.0`,
    `3333333333333333333333333333333333333333\trefs/tags/v6.9.0`,
  ].join('\n');
  assert.equal(pickLatestTag(parseLsRemote(text)).name, 'v6.10.0');
});

test('pickLatestTag: 2.13.0 > 2.2.0（无序输入亦按元组取值）', () => {
  const text = [
    `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v2.13.0`,
    `cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v2.2.0`,
  ].join('\n');
  const latest = pickLatestTag(parseLsRemote(text));
  assert.equal(latest.name, 'v2.13.0');
  assert.equal(latest.sha, 'a'.repeat(40), '轻量 tag 取 tag 行 sha');
});

test('pickLatestTag: 仅匹配 ^v?\\d+\\.\\d+\\.\\d+$——rc/pre-release 被排除', () => {
  const text = [
    `dddddddddddddddddddddddddddddddddddddddd\trefs/tags/v6.8.0-rc1`,
    `eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\trefs/tags/v6.8.0-beta.2`,
    `ffffffffffffffffffffffffffffffffffffffff\trefs/tags/v6.7.0`,
  ].join('\n');
  assert.equal(pickLatestTag(parseLsRemote(text)).name, 'v6.7.0');
});

test('pickLatestTag: 无 semver 匹配 → null（不 throw）', () => {
  const text = [
    `dddddddddddddddddddddddddddddddddddddddd\trefs/tags/v6.8.0-rc1`,
    `eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\trefs/tags/nightly`,
  ].join('\n');
  assert.equal(pickLatestTag(parseLsRemote(text)), null);
  assert.equal(pickLatestTag([]), null);
});

test('pickLatestTag: 无 v 前缀 semver 亦可匹配，且保留远端原名（不带 v）', () => {
  const text = `7777777777777777777777777777777777777777\trefs/tags/6.7.0`;
  const latest = pickLatestTag(parseLsRemote(text));
  assert.equal(latest.name, '6.7.0');
  assert.equal(latest.sha, '7'.repeat(40));
});

// ─── normalizeRef ────────────────────────────────────────────────

test('normalizeRef: tag v6.7.0 → refs/tags/v6.7.0（保留远端原名 v 前缀）', () => {
  assert.equal(normalizeRef('v6.7.0'), 'refs/tags/v6.7.0');
});

test('normalizeRef: 无 v 前缀 tag 名照常拼 refs/tags/<原名>（防御性分支）', () => {
  assert.equal(normalizeRef('6.7.0'), 'refs/tags/6.7.0');
});

test('normalizeRef: 双前缀防御——已含 refs/tags/ 的输入不产出 refs/tags/refs/tags/…', () => {
  assert.equal(normalizeRef('refs/tags/v6.7.0'), 'refs/tags/v6.7.0');
  assert.equal(normalizeRef('refs/tags/6.7.0'), 'refs/tags/6.7.0');
  assert.equal(normalizeRef('refs/heads/main'), 'refs/heads/main');
});

test('normalizeRef: branch → refs/heads/<名>', () => {
  assert.equal(normalizeRef('main'), 'refs/heads/main');
  assert.equal(normalizeRef('feature/x'), 'refs/heads/feature/x');
});

test('normalizeRef: 40 位 hex sha 原样返回', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(normalizeRef(sha), sha);
  assert.equal(normalizeRef(sha.toUpperCase()), sha.toUpperCase(), '40 位 hex 原样（大小写不改造）');
});

test('normalizeRef: 短 sha abc123 → throw（usageError 明确报错）', () => {
  assert.throws(
    () => normalizeRef('abc123'),
    (error) => {
      assert.equal(error.usageError, true, '必须以 usageError 标记抛出，供调用方区分');
      assert.match(error.message, /40/);
      assert.match(error.message, /abc123/);
      return true;
    },
  );
});

test('normalizeRef: 短 sha 形态边界（39/41 位 hex、短 hex）→ throw', () => {
  assert.throws(() => normalizeRef('a'.repeat(39)), (error) => error.usageError === true);
  assert.throws(() => normalizeRef('a'.repeat(41)), (error) => error.usageError === true);
  assert.throws(() => normalizeRef('deadbeef'), (error) => error.usageError === true);
});

test('normalizeRef: 非 hex 的名字按 branch 处置（40 字符非 hex 是合法 branch 名）', () => {
  assert.equal(normalizeRef('z'.repeat(40)), `refs/heads/${'z'.repeat(40)}`);
  assert.equal(normalizeRef('my-branch'), 'refs/heads/my-branch');
});

test('normalizeRef: 空值/非法 ref → throw（usageError）', () => {
  assert.throws(() => normalizeRef(''), (error) => error.usageError === true);
  assert.throws(() => normalizeRef('  '), (error) => error.usageError === true);
  assert.throws(() => normalizeRef(undefined), (error) => error.usageError === true);
});

// ─── buildCodeloadUrl ────────────────────────────────────────────

test('buildCodeloadUrl: 从 repo URL 推导 codeload（剥 .git 后缀）', () => {
  assert.equal(
    buildCodeloadUrl('https://github.com/hugohe3/ppt-master.git', 'refs/tags/v6.7.0'),
    'https://codeload.github.com/hugohe3/ppt-master/tar.gz/refs/tags/v6.7.0',
  );
});

test('buildCodeloadUrl: 无 .git 后缀 / 尾斜杠 / 末段 ref 原样保留', () => {
  assert.equal(
    buildCodeloadUrl('https://github.com/hugohe3/ppt-master', 'refs/heads/main'),
    'https://codeload.github.com/hugohe3/ppt-master/tar.gz/refs/heads/main',
  );
  assert.equal(
    buildCodeloadUrl('https://github.com/hugohe3/ppt-master.git/', 'refs/tags/v6.7.0'),
    'https://codeload.github.com/hugohe3/ppt-master/tar.gz/refs/tags/v6.7.0',
  );
});

test('buildCodeloadUrl: 40 位 sha ref 原样拼入', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(
    buildCodeloadUrl('https://github.com/hugohe3/ppt-master.git', sha),
    `https://codeload.github.com/hugohe3/ppt-master/tar.gz/${sha}`,
  );
});

test('buildCodeloadUrl: 非 github 形 repo → throw（usageError）', () => {
  assert.throws(() => buildCodeloadUrl('', 'refs/tags/v6.7.0'), (error) => error.usageError === true);
  assert.throws(() => buildCodeloadUrl('https://github.com/only-owner.git', 'refs/tags/v6.7.0'), (error) => error.usageError === true);
});

// ─── cacheKey ────────────────────────────────────────────────────

test('cacheKey: <ref>@<sha> 拼接形态', () => {
  assert.equal(
    cacheKey('refs/tags/v6.7.0', '0123456789abcdef0123456789abcdef01234567'),
    'refs/tags/v6.7.0@0123456789abcdef0123456789abcdef01234567',
  );
});

test('cacheKey: tag 重推 sha 变 → 缓存键不同（Review Focus #4）', () => {
  const before = cacheKey('refs/tags/v6.7.0', '0'.repeat(40));
  const after = cacheKey('refs/tags/v6.7.0', '1'.repeat(40));
  assert.notEqual(before, after, '同名 tag 重推（sha 变化）必须失效缓存键');
  assert.equal(cacheKey('refs/tags/v6.7.0', '0'.repeat(40)), before, 'sha 不变 → 键稳定（缓存复用）');
});

test('cacheKey: ref 变 → 缓存键不同', () => {
  const sha = '0'.repeat(40);
  assert.notEqual(cacheKey('refs/tags/v6.7.0', sha), cacheKey('refs/tags/v6.8.0', sha));
});

// ─── diskBudget ──────────────────────────────────────────────────

test('diskBudget: 无参 → 启动保守固定 260MB', () => {
  assert.equal(diskBudget(), 260 * 1024 * 1024);
});

test('diskBudget: 有参 → tarball 实际字节 + 解压全树 114MB + staging 副本 78MB', () => {
  assert.equal(diskBudget(50969212), 50969212 + 114 * 1024 * 1024 + 78 * 1024 * 1024);
});

test('diskBudget: 0 与任意 Content-Length 均按三项和（不回落固定阈值）', () => {
  assert.equal(diskBudget(0), 114 * 1024 * 1024 + 78 * 1024 * 1024);
  assert.equal(diskBudget(1), 1 + 114 * 1024 * 1024 + 78 * 1024 * 1024);
});

// ─── parseArgs ───────────────────────────────────────────────────

test('parseArgs: 空 argv → 全字段缺省（无 usageError）', () => {
  const options = parseArgs([]);
  assert.equal(options.usageError, undefined);
  assert.equal(options.repo, undefined);
  assert.equal(options.ref, undefined);
  assert.equal(options.refresh, undefined);
  assert.equal(options.confirmStructural, undefined);
  assert.equal(options.skipGuard, undefined);
  assert.equal(options.noPush, undefined);
  assert.equal(options.dryRun, undefined);
});

test('parseArgs: --ref x --repo y --refresh --confirm-structural 各字段', () => {
  const options = parseArgs([
    '--ref', 'v6.7.0',
    '--repo', 'https://github.com/hugohe3/ppt-master.git',
    '--refresh',
    '--confirm-structural',
  ]);
  assert.equal(options.usageError, undefined);
  assert.equal(options.ref, 'v6.7.0');
  assert.equal(options.repo, 'https://github.com/hugohe3/ppt-master.git');
  assert.equal(options.refresh, true);
  assert.equal(options.confirmStructural, true);
  assert.equal(options.skipGuard, undefined);
  assert.equal(options.noPush, undefined);
  assert.equal(options.dryRun, undefined);
});

test('parseArgs: --skip-guard 单独使用（默认推送）→ usageError（不 throw）', () => {
  const options = parseArgs(['--skip-guard']);
  assert.equal(options.usageError, true, '契约：以 usageError 字段区分，不 throw');
  assert.equal(options.skipGuard, true, '其余字段照常解析');
});

test('parseArgs: --skip-guard --no-push → 合法', () => {
  const options = parseArgs(['--skip-guard', '--no-push']);
  assert.equal(options.usageError, undefined);
  assert.equal(options.skipGuard, true);
  assert.equal(options.noPush, true);
});

test('parseArgs: --skip-guard --dry-run → 合法', () => {
  const options = parseArgs(['--skip-guard', '--dry-run']);
  assert.equal(options.usageError, undefined);
  assert.equal(options.skipGuard, true);
  assert.equal(options.dryRun, true);
});

test('parseArgs: --skip-guard --no-push --dry-run 顺序无关 → 合法', () => {
  const options = parseArgs(['--dry-run', '--skip-guard', '--no-push']);
  assert.equal(options.usageError, undefined);
  assert.equal(options.skipGuard, true);
  assert.equal(options.noPush, true);
  assert.equal(options.dryRun, true);
});

test('parseArgs: --skip-guard --skip-guard --no-push → 合法（幂等标志）', () => {
  const options = parseArgs(['--skip-guard', '--skip-guard', '--no-push']);
  assert.equal(options.usageError, undefined);
});

test('parseArgs: 未知参数 → usageError', () => {
  assert.equal(parseArgs(['--unknown']).usageError, true);
  assert.equal(parseArgs(['-x']).usageError, true);
  assert.equal(parseArgs(['positional']).usageError, true);
});

test('parseArgs: 缺值（--ref/--repo 末尾无取值 / 后接另一标志）→ usageError', () => {
  assert.equal(parseArgs(['--ref']).usageError, true);
  assert.equal(parseArgs(['--repo']).usageError, true);
  assert.equal(parseArgs(['--ref', '--refresh']).usageError, true);
  assert.equal(parseArgs(['--repo', '--dry-run']).usageError, true);
});

test('parseArgs: 标志与取值混排（--refresh 在 --ref 前）→ 合法且解析正确', () => {
  const options = parseArgs(['--no-push', '--refresh', '--ref', 'main']);
  assert.equal(options.usageError, undefined);
  assert.equal(options.ref, 'main');
  assert.equal(options.refresh, true);
  assert.equal(options.noPush, true);
});

// ─── main 编排入口（T13 已实现）───────────────────────────────────

test('main: T13 编排已替换占位——不再 throw TODO（usageError → 退出码 1）', async () => {
  // 占位时代的「调用即 throw」契约已被 T13 替换：最轻的调用路径（usage 错误）直接
  // 返回退出码 1。完整编排序列与退出码全集由 tests/sync-orchestrate.test.mjs 固定。
  const code = await main({ usageError: true }, {});
  assert.equal(code, 1);
});

// ─── last-sync 状态文件读写 ──────────────────────────────────────

/** 每个用例独立的 tmp 根，finally 整体删除。 */
function withTmpRoot(prefix, fn) {
  const base = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('readLastSync: 无文件 → null', () => {
  withTmpRoot('sync-state-', (root) => {
    assert.equal(readLastSync(root), null);
  });
});

test('writeLastSync/readLastSync: 往返（建目录 + 原子写 + at ISO 时间）', () => {
  withTmpRoot('sync-state-', (root) => {
    const data = {
      ref: 'refs/tags/v6.7.0',
      sha: '0123456789abcdef0123456789abcdef01234567',
      version: '6.7.0',
    };
    writeLastSync(data, root);

    const statePath = join(root, '.upstream', 'last-sync.json');
    const raw = readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);

    assert.equal(parsed.ref, data.ref);
    assert.equal(parsed.sha, data.sha);
    assert.equal(parsed.version, data.version);
    assert.equal(typeof parsed.at, 'string');
    assert.equal(
      Number.isNaN(Date.parse(parsed.at)),
      false,
      `at 必须是可解析的 ISO 时间，实际 ${JSON.stringify(parsed.at)}`,
    );
    assert.match(parsed.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    const readBack = readLastSync(root);
    assert.equal(readBack.ref, data.ref);
    assert.equal(readBack.sha, data.sha);
    assert.equal(readBack.version, data.version);
    assert.equal(readBack.at, parsed.at);
  });
});

test('writeLastSync: 覆写既有状态（每次覆盖，不追加）', () => {
  withTmpRoot('sync-state-', (root) => {
    writeLastSync({ ref: 'refs/tags/v6.7.0', sha: '0'.repeat(40), version: '6.7.0' }, root);
    writeLastSync({ ref: 'refs/tags/v6.8.0', sha: '1'.repeat(40), version: '6.8.0' }, root);
    const state = readLastSync(root);
    assert.equal(state.ref, 'refs/tags/v6.8.0');
    assert.equal(state.sha, '1'.repeat(40));
    assert.equal(state.version, '6.8.0');
  });
});

test('writeLastSync: 写入目录不存在时自建 .upstream/', () => {
  withTmpRoot('sync-state-', (root) => {
    const nested = join(root, 'fresh-root');
    writeLastSync({ ref: 'refs/tags/v6.7.0', sha: '0'.repeat(40), version: '6.7.0' }, nested);
    assert.equal(readLastSync(nested).ref, 'refs/tags/v6.7.0');
  });
});

test('readLastSync: 损坏 JSON → null（不 throw）', () => {
  withTmpRoot('sync-state-', (root) => {
    mkdirSync(join(root, '.upstream'), { recursive: true });
    writeFileSync(join(root, '.upstream', 'last-sync.json'), '{ not json', 'utf8');
    assert.equal(readLastSync(root), null);
  });
});

test('readLastSync: JSON 合法但非状态对象（数组/字符串/缺字段）→ null', () => {
  withTmpRoot('sync-state-', (root) => {
    mkdirSync(join(root, '.upstream'), { recursive: true });
    const statePath = join(root, '.upstream', 'last-sync.json');
    writeFileSync(statePath, '[1,2,3]', 'utf8');
    assert.equal(readLastSync(root), null);

    writeFileSync(statePath, '"refs/tags/v6.7.0"', 'utf8');
    assert.equal(readLastSync(root), null);

    writeFileSync(statePath, JSON.stringify({ ref: 'refs/tags/v6.7.0' }), 'utf8');
    assert.equal(readLastSync(root), null);
  });
});

// ─── last-sync：branch ref（sha 不可得）记录必须可读 ─────────────
//
// `--ref <branch>` 时编排的 refSha 恒为 null（branch 名的 sha 不经 ls-remote
// --tags 解析），writeLastSync 于是写 `sha: ''`。此前 readLastSync 要求 sha
// **必填且非空**，整条记录因此被判 null——`--confirm-structural` 对 branch 的
// 「固定上次检出 ref」承诺（spec §4.1 步骤 7）静默失效，回落最新 tag。
// 修复：`sha` 降为可选（空串/缺失 → 保留记录、sha 字段为 null）；`ref`/`version`/`at`
// 仍是必填判据。

test('writeLastSync/readLastSync: branch ref（sha 空串）→ 读回非 null 且 ref 正确', () => {
  withTmpRoot('sync-state-', (root) => {
    const written = writeLastSync(
      { ref: 'refs/heads/main', sha: '', version: '6.8.0' },
      root,
    );
    // 落盘 shape 不变（sha 仍写空串，写入侧语义未动）。
    assert.equal(written.sha, '');
    assert.equal(
      JSON.parse(readFileSync(join(root, '.upstream', 'last-sync.json'), 'utf8')).sha,
      '',
      '落盘 sha 仍是空串——修复只在读取侧放宽',
    );

    const readBack = readLastSync(root);
    assert.notEqual(readBack, null, 'branch ref 记录必须可读（否则 --confirm-structural 固定 ref 失效）');
    assert.equal(readBack.ref, 'refs/heads/main');
    assert.equal(readBack.version, '6.8.0');
    assert.equal(readBack.sha, null, 'sha 不可得 → null（不再吞掉整条记录）');
    assert.equal(typeof readBack.at, 'string');
  });
});

test('readLastSync: sha 缺失（旧记录/无该字段）→ 保留记录、sha 为 null', () => {
  withTmpRoot('sync-state-', (root) => {
    mkdirSync(join(root, '.upstream'), { recursive: true });
    const statePath = join(root, '.upstream', 'last-sync.json');
    writeFileSync(
      statePath,
      JSON.stringify({ ref: 'refs/heads/main', version: '6.8.0', at: '2026-10-14T00:00:00.000Z' }),
      'utf8',
    );
    const readBack = readLastSync(root);
    assert.notEqual(readBack, null, '缺 sha 字段不得吞掉整条记录');
    assert.equal(readBack.ref, 'refs/heads/main');
    assert.equal(readBack.sha, null);
  });
});

test('readLastSync: ref/version/at 仍为必填判据（任一缺失或空 → null）', () => {
  withTmpRoot('sync-state-', (root) => {
    mkdirSync(join(root, '.upstream'), { recursive: true });
    const statePath = join(root, '.upstream', 'last-sync.json');
    const full = { ref: 'refs/heads/main', sha: '', version: '6.8.0', at: '2026-10-14T00:00:00.000Z' };
    for (const key of ['ref', 'version', 'at']) {
      writeFileSync(statePath, JSON.stringify({ ...full, [key]: '' }), 'utf8');
      assert.equal(readLastSync(root), null, `${key} 为空串 → null（判据不放宽）`);
      const without = { ...full };
      delete without[key];
      writeFileSync(statePath, JSON.stringify(without), 'utf8');
      assert.equal(readLastSync(root), null, `${key} 缺失 → null（判据不放宽）`);
    }
    // 非字符串 sha（畸形记录）同样归 null —— 只有「缺失/空串」才是「不可得」。
    writeFileSync(statePath, JSON.stringify({ ...full, sha: 12345 }), 'utf8');
    assert.equal(readLastSync(root), null, '非字符串 sha → null');
  });
});

test('readLastSync: tag ref 的 sha 行为不回归（非空 sha 原样读回）', () => {
  withTmpRoot('sync-state-', (root) => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    writeLastSync({ ref: 'refs/tags/v6.7.0', sha, version: '6.7.0' }, root);
    const readBack = readLastSync(root);
    assert.equal(readBack.ref, 'refs/tags/v6.7.0');
    assert.equal(readBack.sha, sha, 'tag ref 的 sha 仍是字符串原值');
  });
});

test('readLastSync/writeLastSync: 缺省 root 锚定仓库根，与 cwd 无关', () => {
  const original = process.cwd();
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

  // 本用例**绝不写仓库根 `.upstream/`**（T11/T13/T14 起那里是真实缓存，探针写入
  // 会无备份地覆盖真实 last-sync.json，`rmSync(recursive)` 更会把整个真实缓存
  // 目录删掉且不抛错——force 对非空目录同样生效）。因此：
  //  ① 缺省 root 的锚定由**只读**断言验证（不落盘）；
  //  ② 写/读往返在独立 tmp root 上驱动（顺带覆盖 root 参数路径）。
  try {
    process.chdir(tmpdir());

    // ① 只读：缺省 root 必须锚定仓库根。cwd 切到 tmpdir 后，若实现误用 cwd，
    // 读到的是 tmpdir 下的路径；此处断言其行为与显式 repoRoot 完全一致。
    assert.deepEqual(readLastSync(), readLastSync(repoRoot), '缺省 root 必须等价于显式仓库根');

    // ② tmp root 往返：root 参数路径被写/读两侧一致驱动。
    withTmpRoot('sync-state-default-', (root) => {
      writeLastSync({ ref: 'refs/tags/v9.9.9-cwd-probe', sha: '9'.repeat(40), version: '9.9.9' }, root);
      process.chdir(tmpdir());
      assert.equal(readLastSync(root).ref, 'refs/tags/v9.9.9-cwd-probe');
      assert.equal(readLastSync(root).sha, '9'.repeat(40));

      // 反向：tmp root 下的状态不得被缺省 root 读到（两处 root 彼此独立）。
      const viaDefault = readLastSync();
      assert.equal(
        viaDefault === null || viaDefault.ref !== 'refs/tags/v9.9.9-cwd-probe',
        true,
        '缺省 root 不得读到 tmp root 的状态——证明锚定的是仓库根而非 cwd',
      );
    });

    // ③ 缺省 root 的**写**语义由下一用例（带备份/恢复）单独证明——本用例刻意
    // 只读，避免触碰仓库根 `.upstream/`。
  } finally {
    process.chdir(original);
  }
});

test('writeLastSync/readLastSync: 缺省 root 写入的是仓库根 .upstream（备份/恢复真实状态）', () => {
  // 缺省 root 的**写**语义必须被证明（否则「cwd 无关」只覆盖了读）。为不破坏
  // T11/T13/T14 的真实缓存，这里对真实 last-sync.json 做备份/恢复，且只删探针
  // 文件本身——绝不 rmSync 目录。
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const statePath = join(repoRoot, '.upstream', 'last-sync.json');
  const upstreamDir = join(repoRoot, '.upstream');

  const hadDir = existsSync(upstreamDir);
  const hadState = existsSync(statePath);
  const backup = hadState ? readFileSync(statePath, 'utf8') : null;
  const createdDir = !hadDir;

  const original = process.cwd();
  try {
    process.chdir(tmpdir());
    writeLastSync({ ref: 'refs/tags/v9.9.9-probe', sha: '9'.repeat(40), version: '9.9.9' });

    // 缺省 root 落到仓库根，而非 cwd。
    assert.equal(readFileSync(statePath, 'utf8').includes('refs/tags/v9.9.9-probe'), true);
    assert.equal(existsSync(join(tmpdir(), '.upstream', 'last-sync.json')), false, '不得写到 cwd');
    assert.equal(readLastSync().ref, 'refs/tags/v9.9.9-probe');
  } finally {
    process.chdir(original);
    // 恢复：有备份则还原原内容，否则只删探针文件本身。
    if (backup !== null) writeFileSync(statePath, backup, 'utf8');
    else rmSync(statePath, { force: true });
    // 仅当本次新建了 .upstream/ 时才尝试移除该目录，且必须用 `rmdirSync`（空目录
    // 语义）：`rmSync` 即便 recursive:false 也对目录抛 EISDIR（force 只抑制
    // ENOENT），非空时 rmdirSync 抛 ENOTEMPTY 被捕获——该目录因此受保护，真实的
    // `.upstream/` 缓存（T11/T13/T14 起为真）绝不可能被删。
    if (createdDir) {
      // 前置守卫：只有目录确为空时才尝试移除（他人在本机上并发创建了缓存则跳过）。
      if (existsSync(upstreamDir) && readdirSync(upstreamDir).length > 0) return;
      try {
        rmdirSync(upstreamDir);
      } catch {
        /* 非空（真实缓存已出现或他人在用）——保留，绝不递归删除 */
      }
    }
  }
});
