import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyVersionLinkage } from '../scripts/sync-upstream.mjs';

/**
 * applyVersionLinkage 契约（issue #3）：package.json bump 之外，lib/client.js 的
 * PLUGIN_VERSION / UPSTREAM_VERSION 必须联动改写——否则同步后 client-half 的
 * 配对断言（常量 ≡ package.json.version / ≡ vendor metadata.version）必然变红。
 *
 * 四态语义：rewritten / unchanged（幂等）/ missing（文件缺失，不判失败）/
 * problem（常量形态漂移或目标值非法——fail-loud，文件不写）。
 */

/** 生成一个含两个版本常量的最小 client.js 形态。 */
const clientText = (plugin, upstream) =>
  [
    '/** 卡片半边（测试替身形态，与真实 lib/client.js 的常量行同构）。 */',
    `const PLUGIN_VERSION = '${plugin}';`,
    `const UPSTREAM_VERSION = '${upstream}';`,
    "const UNRELATED = 'do-not-touch';",
    'export { PLUGIN_VERSION, UPSTREAM_VERSION, UNRELATED };',
    '',
  ].join('\n');

/** 临时仓库根 + lib/client.js。 */
function makeRoot(text) {
  const root = mkdtempSync(join(tmpdir(), 'sync-linkage-'));
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'client.js'), text);
  return root;
}

const CLIENT_PATH = (root) => join(root, 'lib', 'client.js');

test('linkage: 两个常量都漂移 → rewritten，其余字节逐行保留', () => {
  const root = makeRoot(clientText('6.7.1', '6.7.1'));
  try {
    const result = applyVersionLinkage(root, { pluginVersion: '6.8.0', upstreamVersion: '6.8.0' });
    assert.equal(result.status, 'rewritten');
    assert.deepEqual(
      result.changes.map((change) => [change.constant, change.from, change.to]),
      [
        ['PLUGIN_VERSION', '6.7.1', '6.8.0'],
        ['UPSTREAM_VERSION', '6.7.1', '6.8.0'],
      ],
    );
    assert.equal(readFileSync(CLIENT_PATH(root), 'utf8'), clientText('6.8.0', '6.8.0'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('linkage: 幂等——两常量已等于目标 → unchanged 且不写文件', () => {
  const root = makeRoot(clientText('6.8.0', '6.8.0'));
  try {
    const result = applyVersionLinkage(root, { pluginVersion: '6.8.0', upstreamVersion: '6.8.0' });
    assert.equal(result.status, 'unchanged');
    assert.equal(readFileSync(CLIENT_PATH(root), 'utf8'), clientText('6.8.0', '6.8.0'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('linkage: 仅 PLUGIN_VERSION 漂移（规则③ -rN+1 场景）→ 只改写该行', () => {
  const root = makeRoot(clientText('6.8.0', '6.8.0'));
  try {
    const result = applyVersionLinkage(root, { pluginVersion: '6.8.0-r1', upstreamVersion: '6.8.0' });
    assert.equal(result.status, 'rewritten');
    assert.deepEqual(
      result.changes.map((change) => change.constant),
      ['PLUGIN_VERSION'],
    );
    assert.equal(readFileSync(CLIENT_PATH(root), 'utf8'), clientText('6.8.0-r1', '6.8.0'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('linkage: lib/client.js 缺失 → missing（不判失败）', () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-linkage-'));
  try {
    const result = applyVersionLinkage(root, { pluginVersion: '6.8.0', upstreamVersion: '6.8.0' });
    assert.equal(result.status, 'missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('linkage: 常量缺失（形态漂移）→ problem 且文件不被写', () => {
  const original = clientText('6.7.1', '6.7.1').replace("const UPSTREAM_VERSION = '6.7.1';\n", '');
  const root = makeRoot(original);
  try {
    const result = applyVersionLinkage(root, { pluginVersion: '6.8.0', upstreamVersion: '6.8.0' });
    assert.equal(result.status, 'problem');
    assert.ok(result.problems.length >= 1, '至少一条 problem 明细');
    assert.ok(result.problems.some((problem) => problem.includes('UPSTREAM_VERSION')));
    assert.equal(readFileSync(CLIENT_PATH(root), 'utf8'), original, 'problem 时文件保持原样');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('linkage: 常量重复（≥2 处匹配）→ problem 且文件不被写', () => {
  const original = clientText('6.7.1', '6.7.1')
    + "const PLUGIN_VERSION = '6.7.1'; // 重复声明（形态漂移测试）\n";
  const root = makeRoot(original);
  try {
    const result = applyVersionLinkage(root, { pluginVersion: '6.8.0', upstreamVersion: '6.8.0' });
    assert.equal(result.status, 'problem');
    assert.ok(result.problems.some((problem) => problem.includes('PLUGIN_VERSION') && problem.includes('2')));
    assert.equal(readFileSync(CLIENT_PATH(root), 'utf8'), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('linkage: 目标值非法（空串/缺失）→ problem，不触碰文件', () => {
  const original = clientText('6.7.1', '6.7.1');
  const root = makeRoot(original);
  try {
    const empty = applyVersionLinkage(root, { pluginVersion: '', upstreamVersion: '6.8.0' });
    assert.equal(empty.status, 'problem');
    const missing = applyVersionLinkage(root, { upstreamVersion: '6.8.0' });
    assert.equal(missing.status, 'problem');
    assert.equal(readFileSync(CLIENT_PATH(root), 'utf8'), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('linkage: 目标值含引号/反斜杠 → problem（拒绝注入字符串字面量，Gate 3 P3-3）', () => {
  const original = clientText('6.7.1', '6.7.1');
  const root = makeRoot(original);
  try {
    const quote = applyVersionLinkage(root, { pluginVersion: "6.8.0'-x", upstreamVersion: '6.8.0' });
    assert.equal(quote.status, 'problem');
    assert.ok(quote.problems.some((problem) => problem.includes('引号')));
    const backslash = applyVersionLinkage(root, { pluginVersion: '6.8.0', upstreamVersion: '6.8.0\\9' });
    assert.equal(backslash.status, 'problem');
    assert.equal(readFileSync(CLIENT_PATH(root), 'utf8'), original, '文件不被写');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
