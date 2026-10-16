import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

const readPkg = () => JSON.parse(read('package.json'));

test('package.json: 身份与入口字段', () => {
  const pkg = readPkg();
  assert.equal(pkg.name, 'dsh-ppt-master-wrapper');
  // T14 首灌定版后 version 镜像上游（vendor SKILL.md metadata.version），不再占位。
  const skillMd = read('skills/ppt-master/SKILL.md');
  const upstreamVersion = skillMd.match(/^\s+version:\s*"?([^"\s]+)"?\s*$/m)?.[1];
  // 前置防御：版本行缺失/变形时 upstreamVersion 为 undefined，下方 slice 会先抛
  // TypeError 而非给出可读断言——先锁「可解析为字符串」。
  assert.equal(typeof upstreamVersion, 'string', 'vendor SKILL.md metadata.version 应可解析');
  assert.ok(
    pkg.version === upstreamVersion || /^-r\d+$/.test(pkg.version.slice(upstreamVersion.length)),
    `version 镜像上游版本（可带 -rN 后缀）：pkg=${pkg.version} upstream=${upstreamVersion}`
  );
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
    'README.en.md',
    'NOTICE',
    'static',
    'LICENSE',
  ]);
});

test('package.json: exports 四条目', () => {
  const pkg = readPkg();
  assert.equal(pkg.exports['.'], './index.js');
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml');
  assert.equal(pkg.exports['./package.json'], './package.json');
  // 客户端半边（浏览器半边，config-ui 特性）：宿主按 dsh.client 声明装载该单文件。
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.deepEqual(Object.keys(pkg.exports).sort(), [
    '.',
    './client',
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
  const required = [
    '.env',
    '.upstream/',
    '.skills-staging/',
    '__pycache__/',
    '*.pyc',
    '.mnemon/',
    'sync-report.txt',
    '.superpowers/',
    'node_modules/',
    '.DS_Store',
    '*.log',
    '*.tmp',
  ];
  for (const entry of required) {
    assert.ok(lines.includes(entry), `.gitignore 缺少条目: ${entry}`);
  }
  // 忽略必须**真实生效**：每条目取一个代表路径，经 git check-ignore -q 断言命中
  // （exit 0）。目录类条目取下一级假想路径，glob 类条目取具体文件名。路径无需真实存在。
  const probes = [
    ['.env', '.env'],
    ['.upstream/', '.upstream/last-sync.json'],
    ['.skills-staging/', '.skills-staging/ppt-master'],
    ['__pycache__/', '__pycache__/x.pyc'],
    ['*.pyc', 'foo.pyc'],
    ['.mnemon/', '.mnemon/x'],
    ['sync-report.txt', 'sync-report.txt'],
    ['.superpowers/', '.superpowers/x'],
    ['node_modules/', 'node_modules/x'],
    ['.DS_Store', '.DS_Store'],
    ['*.log', 'debug.log'],
    ['*.tmp', 'tmp.tmp'],
  ];
  for (const [entry, probe] of probes) {
    const result = spawnSync('git', ['check-ignore', '-q', '--', probe], {
      cwd: repoRoot,
    });
    assert.equal(
      result.status,
      0,
      `.gitignore 条目未生效（git check-ignore 未命中）: ${entry} → ${probe}（exit ${result.status}）`
    );
  }
});

test('LICENSE: 本插件自身 MIT 许可', () => {
  const text = read('LICENSE');
  assert.match(text.split('\n')[0], /MIT License/);
  assert.match(text, /Copyright \(c\) 2026 dsh-ppt-master-wrapper contributors/);
  assert.match(text, /Permission is hereby granted, free of charge/);
});

test('README.md: 完整文档（安装/三工具/.env/同步用法/致谢双 LICENSE）', () => {
  const text = read('README.md');
  assert.match(text, /^# dsh-ppt-master-wrapper$/m);
  // 安装：本地 link 与公开主地址（GitHub）两种方式。
  // 2026-10-16 起插件主地址切到 GitHub（公开仓库），内网 GitLab 仅为可选镜像、不出现在 README。
  assert.match(text, /dsh plugin --profile <name> add link:/);
  assert.match(text, /https:\/\/github\.com\/SAXEM1997\/dsh-ppt-master-wrapper\.git/);
  // 三工具说明（spec §3.5）。
  for (const tool of ['ppt_master_info', 'ppt_master_check_env', 'ppt_master_setup_deps']) {
    assert.ok(text.includes(tool), `README 缺少工具说明: ${tool}`);
  }
  // .env 首次使用指引：从 vendor .env.example 复制。
  assert.match(text, /skills\/ppt-master\/\.env\.example/);
  // 同步脚本用法：脚本名与全部 flag。
  assert.ok(text.includes('sync-upstream.mjs'), 'README 缺少同步脚本用法');
  for (const flag of ['--ref', '--repo', '--refresh', '--confirm-structural', '--skip-guard', '--no-push', '--dry-run']) {
    assert.ok(text.includes(flag), `README 缺少同步 flag 说明: ${flag}`);
  }
  // 致谢上游与双 LICENSE 归属。
  assert.match(text, /github\.com\/hugohe3\/ppt-master/);
  assert.match(text, /skills\/ppt-master\/LICENSE/);
});
