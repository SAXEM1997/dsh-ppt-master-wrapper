import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { buildStubSdk, makeStubSdk } from './helpers/stub-sdk.mjs';

/**
 * tests/helpers/stub-sdk.mjs 契约（issue #4：CI 在无宿主 DSH SDK 的环境跑全套测试）。
 *
 * 迁移保真：compat.test.mjs 的 100+ 条用例已通过共享 makeStubSdk 覆盖替身的行为面；
 * 本文件只锁「共享层自身」的三个增量契约——显式目录构造的幂等、knob 透传、
 * CLI 形态（CI 直接消费的入口）。
 */

const execFileAsync = promisify(execFile);

test('stub-sdk: makeStubSdk 返回 {base, modules, cleanup} 且树含六包（迁移保真）', async () => {
  const sdk = await makeStubSdk();
  try {
    assert.equal(typeof sdk.base, 'string');
    assert.ok(sdk.modules.endsWith('node_modules'));
    for (const name of [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-skill',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/schemastery',
      'superpowers-dsh',
    ]) {
      assert.ok(existsSync(join(sdk.modules, ...name.split('/'), 'package.json')), `${name} 在树内`);
    }
  } finally {
    await sdk.cleanup();
    assert.equal(existsSync(sdk.base), false, 'cleanup 整树删除');
  }
});

test('stub-sdk: buildStubSdk 显式目录幂等——重建清除旧文件（knob 变更不留残留）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'stub-sdk-explicit-'));
  try {
    const modules = join(base, 'node_modules');
    await buildStubSdk(modules); // 默认形态
    const marker = join(modules, 'superpowers-dsh', 'lib', 'index.js');
    assert.ok(existsSync(marker));
    // 重建为 superpowers:'absent' —— 旧 superpowers-dsh 目录必须消失（先 rm 再建）。
    await buildStubSdk(modules, { superpowers: 'absent' });
    assert.equal(existsSync(marker), false, '重建清除旧包（幂等，无残留）');
    assert.ok(existsSync(join(modules, '@deepseek-ai', 'schemastery', 'lib', 'index.cjs')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stub-sdk: CLI 形态——node tests/helpers/stub-sdk.mjs <dest> 建默认树（CI 入口）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'stub-sdk-cli-'));
  try {
    const { stdout } = await execFileAsync(process.execPath, [join('tests', 'helpers', 'stub-sdk.mjs'), base]);
    const modules = stdout.trim().split('\n').pop();
    assert.equal(modules, join(base, 'node_modules'), 'stdout 末行输出 modules 路径');
    const manifest = join(modules, '@deepseek-ai', 'schemastery', 'lib', 'index.cjs');
    assert.ok(existsSync(manifest), 'schemastery 替身在 CLI 产物树内');
    // 替身可加载（CJS require 形态与真实包一致）。
    const Schema = (await import('node:module')).createRequire(join(process.cwd(), 'index.js'))(manifest);
    assert.equal(typeof Schema.object, 'function', '替身 CJS 命名空间可调用');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stub-sdk: CLI 缺参 → exit 1 且输出用法', async () => {
  const base = mkdtempSync(join(tmpdir(), 'stub-sdk-cli-'));
  try {
    // 占位文件防止「文件已存在」类歧义；本用例只验证缺参分支。
    writeFileSync(join(base, 'placeholder'), '');
    let code = 0;
    let stderr = '';
    try {
      await execFileAsync(process.execPath, [join('tests', 'helpers', 'stub-sdk.mjs')]);
    } catch (error) {
      code = error.code ?? 1;
      stderr = String(error.stderr ?? '');
    }
    assert.equal(code, 1);
    assert.match(stderr, /用法: node tests\/helpers\/stub-sdk\.mjs/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stub-sdk: 病态路径守卫——非 <非根>/node_modules 形态拒收（Gate 3 P3-2）', async () => {
  for (const bad of ['/', '/node_modules', process.cwd()]) {
    await assert.rejects(
      () => buildStubSdk(bad),
      /拒绝在可疑路径构造 stub 树/,
      `${bad} 应被守卫拒绝`,
    );
  }
});
