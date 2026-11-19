import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { hasLocalTemplateLibrary, LOCAL_TEMPLATE_REL, parseArgs } from '../scripts/check-pack.mjs';

const run = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-pack.mjs');

/** 跑一次 CLI，返回退出码与 stderr（不抛）。 */
async function runScript(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('hasLocalTemplateLibrary: 只在目录存在时为真（文件不算）', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-pack-'));
  try {
    assert.equal(hasLocalTemplateLibrary(root), false, '空树不应拦截');
    mkdirSync(join(root, LOCAL_TEMPLATE_REL), { recursive: true });
    assert.equal(hasLocalTemplateLibrary(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-pack: 保留路径上是普通文件也算（同样会被打包）', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-pack-file-'));
  try {
    mkdirSync(join(root, 'skills/ppt-master/templates'), { recursive: true });
    writeFileSync(join(root, LOCAL_TEMPLATE_REL), 'not a directory');
    assert.equal(hasLocalTemplateLibrary(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-pack CLI: 无个人模板库 → 退出码 0（正常发布路径）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'check-pack-ok-'));
  try {
    const result = await runScript(['--root', root]);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-pack CLI: 有个人模板库 → 退出码 1，并说明为什么不能靠 .npmignore', async () => {
  const root = mkdtempSync(join(tmpdir(), 'check-pack-block-'));
  try {
    mkdirSync(join(root, LOCAL_TEMPLATE_REL, 'brands', 'mine'), { recursive: true });
    const result = await runScript(['--root', root]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /不能进包体/);
    assert.match(result.stderr, /npmignore/, '拦截文案要点明 .npmignore 为什么无效');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseArgs: 未知参数与缺值都按用法错误返回（退出码 2 的前置）', () => {
  assert.match(parseArgs(['--root']).error, /需要一个目录参数/);
  assert.match(parseArgs(['--nope']).error, /未知参数/);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs([]).root.length > 0, true);
});
