import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
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

// ─── M1 所有权标记法（P0）：rm 前判定「目标是不是本工具建的」─────────────
//
// 根形态守卫挡不住「形态合法但指向真实依赖树」的路径（如 `buildStubSdk('node_modules')`
// 解析到 <cwd>/node_modules）。以下用例全部在 mkdtemp 临时目录内构造，**不触碰真实
// 仓库 node_modules**；每条断言具体行为（拒绝消息语义 + 既有内容零删除），不只断言抛错。

test('stub-sdk: M1 外部目录拒绝——预置真实依赖树形态的 node_modules 不得被删（P0 核心）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'stub-sdk-m1-foreign-'));
  try {
    const modules = join(base, 'node_modules');
    const realPkg = join(modules, 'some-real-pkg', 'package.json');
    mkdirSync(join(modules, 'some-real-pkg'), { recursive: true });
    writeFileSync(realPkg, '{"name":"some-real-pkg"}\n');
    await assert.rejects(
      () => buildStubSdk(modules),
      /不是本工具创建的 stub 树.*拒绝覆盖/,
      '缺所有权标记的既有目录必须被拒绝',
    );
    // P0 核心：拒绝之外还必须零删除——真实依赖树完好。
    assert.equal(existsSync(realPkg), true, 'some-real-pkg/package.json 必须仍在（不得被 rm）');
    assert.equal(readFileSync(realPkg, 'utf8'), '{"name":"some-real-pkg"}\n', '内容逐字未动');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stub-sdk: M1 symlink 拒绝——目标为符号链接时拒绝且目标目录内容完好', async () => {
  const base = mkdtempSync(join(tmpdir(), 'stub-sdk-m1-symlink-'));
  try {
    const realTree = join(base, 'real-tree');
    mkdirSync(realTree, { recursive: true });
    writeFileSync(join(realTree, 'payload.txt'), 'do-not-touch\n');
    const linkParent = join(base, 'linkproj');
    mkdirSync(linkParent, { recursive: true });
    const link = join(linkParent, 'node_modules');
    symlinkSync(realTree, link);
    await assert.rejects(
      () => buildStubSdk(link),
      /符号链接.*拒绝覆盖/,
      'symlink 目标必须被拒绝（防御性）',
    );
    assert.equal(lstatSync(link).isSymbolicLink(), true, '链接本身必须仍在（未被 rm）');
    assert.equal(readFileSync(join(realTree, 'payload.txt'), 'utf8'), 'do-not-touch\n', '目标内容完好');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stub-sdk: M1 标记不符拒绝——.ppt-master-stub-sdk 内容不匹配时拒绝覆盖', async () => {
  const base = mkdtempSync(join(tmpdir(), 'stub-sdk-m1-badmarker-'));
  try {
    const modules = join(base, 'node_modules');
    mkdirSync(modules, { recursive: true });
    writeFileSync(join(modules, '.ppt-master-stub-sdk'), '{"owner":"other"}');
    await assert.rejects(
      () => buildStubSdk(modules),
      /不是本工具创建的 stub 树.*拒绝覆盖/,
      '标记内容不符必须被拒绝',
    );
    assert.equal(
      readFileSync(join(modules, '.ppt-master-stub-sdk'), 'utf8'),
      '{"owner":"other"}',
      '他人标记不得被覆盖改写',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stub-sdk: M1 幂等重建——自建目录连续构建成功，标记与 stub 包齐全', async () => {
  const base = mkdtempSync(join(tmpdir(), 'stub-sdk-m1-idem-'));
  try {
    const modules = join(base, 'node_modules');
    await buildStubSdk(modules);
    await buildStubSdk(modules); // 第二次：自己建的树必须放行（幂等）
    const marker = JSON.parse(readFileSync(join(modules, '.ppt-master-stub-sdk'), 'utf8').trim());
    assert.deepEqual(marker, { owner: 'ppt-master-stub-sdk', format: 1 }, '标记内容正确');
    for (const name of [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-skill',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-scope',
      '@deepseek-ai/schemastery',
      'superpowers-dsh',
    ]) {
      assert.ok(existsSync(join(modules, ...name.split('/'), 'package.json')), `${name} 在重建后的树内`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stub-sdk: M1 相对路径攻击回归——buildStubSdk(\'node_modules\') 不得删 <cwd>/node_modules（原始攻击形态）', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'stub-sdk-m1-cwd-'));
  const modules = join(base, 'node_modules');
  const realPkg = join(modules, 'some-real-pkg', 'package.json');
  mkdirSync(join(modules, 'some-real-pkg'), { recursive: true });
  writeFileSync(realPkg, '{"name":"some-real-pkg"}\n');
  const originalCwd = process.cwd();
  process.chdir(base);
  t.after(() => process.chdir(originalCwd)); // 无论成败都恢复 cwd
  try {
    await assert.rejects(
      () => buildStubSdk('node_modules'), // 解析为 <base>/node_modules——恰是预置的真实依赖树
      /不是本工具创建的 stub 树.*拒绝覆盖/,
      '相对路径解析到的真实 node_modules 必须被拒绝',
    );
    assert.equal(existsSync(realPkg), true, '<cwd>/node_modules/some-real-pkg/package.json 必须仍在');
    assert.equal(readFileSync(realPkg, 'utf8'), '{"name":"some-real-pkg"}\n', '真实依赖树内容逐字未动');
  } finally {
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test('stub-sdk: M2b execute 行使 guard 拒绝语义——拒绝半零执行 + isError，放行半恰一次执行', async () => {
  const sdk = await makeStubSdk();
  try {
    const base = `file://${sdk.modules}/`;
    const { Context } = await import(`${base}@deepseek-ai/cordis/index.mjs`);
    const { ToolRuntime } = await import(`${base}@deepseek-ai/dsh-tools/index.mjs`);
    const ctx = new Context();
    new ToolRuntime(ctx);

    // 注册探针工具（经 traceable 代理，与探针同路径），工具体计数。
    let bodyRuns = 0;
    ctx.tools.register({
      name: 'stub-guard-probe',
      description: 'M2b 探针',
      parameters: { type: 'object', properties: {} },
      output: { render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async () => {
        bodyRuns += 1;
        return { ok: true };
      },
    });

    const execShape = { callId: 'c1', name: 'stub-guard-probe', arguments: {} };

    // 拒绝半：guard 返回字符串 ⇒ isError、error.message 逐字、content 块前缀、工具体零执行。
    // 注意 guard 与 execute 是**两次独立的 ctx.tools 读取**（两只 traceable 代理）——
    // guards 存模块级容器才跨代理可见（M2b 陷阱的回归锁）。
    const denyGuard = ctx.tools.guard(() => 'scope: not visible');
    try {
      const denied = await ctx.tools.execute(execShape);
      assert.equal(denied.isError, true, 'guard 返回字符串 ⇒ isError=true');
      assert.equal(denied.error?.message, 'scope: not visible', '拒绝理由逐字一致');
      assert.deepEqual(
        denied.content,
        [{ type: 'text', text: 'Error: scope: not visible' }],
        '拒绝结果的 content 块形态',
      );
      assert.equal(bodyRuns, 0, '拒绝必须短路调度——工具体零执行');
    } finally {
      denyGuard();
    }

    // 放行半：guard 返回 undefined ⇒ 非错误、value 回传、content 经 render、工具体恰一次。
    const allowGuard = ctx.tools.guard(() => undefined);
    try {
      const allowed = await ctx.tools.execute(execShape);
      assert.equal(allowed.isError, false, 'guard 返回 undefined ⇒ 放行');
      assert.deepEqual(allowed.value, { ok: true }, '工具体返回值回传');
      assert.deepEqual(
        allowed.content,
        [{ type: 'text', text: '{"ok":true}' }],
        'content 经 definition.output.render 产出',
      );
      assert.equal(bodyRuns, 1, '放行后工具体恰执行一次');
    } finally {
      allowGuard();
    }

    // 兜底：guard 全退订后未知工具名 ⇒ unknown tool 错误（不抛、走 isError 通道）。
    const unknown = await ctx.tools.execute({ callId: 'c2', name: 'no-such-tool', arguments: {} });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.error?.message, 'unknown tool: no-such-tool');
  } finally {
    await sdk.cleanup();
  }
});
