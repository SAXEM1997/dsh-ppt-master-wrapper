import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

const readPkg = () => JSON.parse(read('package.json'));

test('package.json: 身份与入口字段', () => {
  const pkg = readPkg();
  assert.equal(pkg.name, 'dsh-ppt-master-wrapper');
  assert.equal(pkg.version, '0.0.0');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'index.js');
  assert.deepEqual(pkg.engines, { node: '>=20.0.0' });
});

test('package.json: 零运行时 npm 依赖', () => {
  const pkg = readPkg();
  assert.equal(pkg.dependencies, undefined, 'dependencies 不得存在');
  assert.equal(pkg.devDependencies, undefined, 'devDependencies 不得存在');
});

test('package.json: files 白名单', () => {
  const pkg = readPkg();
  assert.deepEqual(pkg.files, [
    'index.js',
    'lib',
    'skills',
    'scripts',
    'cordis.patch.yml',
    'README.md',
    'LICENSE',
  ]);
});

test('package.json: exports 三条目', () => {
  const pkg = readPkg();
  assert.equal(pkg.exports['.'], './index.js');
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml');
  assert.equal(pkg.exports['./package.json'], './package.json');
  assert.deepEqual(Object.keys(pkg.exports).sort(), [
    '.',
    './cordis.patch.yml',
    './package.json',
  ]);
});

test('package.json: dsh 字段（engines + bundle.patch）', () => {
  const pkg = readPkg();
  assert.equal(pkg.dsh.engines.dsh, '>=0.1.1-rc.1');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
});

test('cordis.patch.yml: insert 挂载行', () => {
  const text = read('cordis.patch.yml');
  assert.match(text, /^- insert:$/m);
  assert.match(text, /^\s+- id: dsh-ppt-master-wrapper$/m);
  assert.match(text, /^\s+name: dsh-ppt-master-wrapper$/m);
});

test('.gitignore: 逐项覆盖忽略清单', () => {
  const lines = read('.gitignore').split('\n').filter((l) => l.trim() !== '');
  for (const entry of [
    '.env',
    '.upstream/',
    '.skills-staging/',
    '__pycache__/',
    '*.pyc',
    '.mnemon/',
    'sync-report.txt',
    '.superpowers/',
  ]) {
    assert.ok(lines.includes(entry), `.gitignore 缺少条目: ${entry}`);
  }
});

test('LICENSE: 本插件自身 MIT 许可', () => {
  const text = read('LICENSE');
  assert.match(text.split('\n')[0], /MIT License/);
  assert.match(text, /Copyright \(c\) 2026 dsh-ppt-master-wrapper contributors/);
  assert.match(text, /Permission is hereby granted, free of charge/);
});

test('README.md: 骨架标题 + TODO 指向设计文档', () => {
  const text = read('README.md');
  assert.match(text, /^# dsh-ppt-master-wrapper$/m);
  assert.match(text, /docs\/superpowers\/specs\/2026-10-14-dsh-ppt-master-wrapper-design\.md/);
});
