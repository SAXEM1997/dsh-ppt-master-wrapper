import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildStubSdk, SCHEMASTERY_STUB } from './helpers/stub-sdk.mjs';

/**
 * 装载期宿主包解析契约：**裸导入优先，env 定位链兜底**。
 *
 * 背景：`DSH_HOME` / `DSH_PROFILE` / `DSH_PROFILE_DIR` 只由 `dsh-shell-env` 在每次
 * shell 调用时现造（宿主 asar 内 `process.env.DSH_PROFILE` 出现 0 次，`dsh-app-boot`
 * 的 `.env` 分层又把 `DSH_*` 前缀列为 bootstrap-only 并拒绝），因此**宿主进程里这些
 * 变量恒为空**——四级探测链在正常安装形态下必然全落空。装好的插件应当由 Node 从
 * profile 的 `node_modules` 解析到 `@deepseek-ai/schemastery`（官方插件与同 profile 的
 * 第三方插件皆如此），env 链只服务「符号链接装载、包内向上找不到 profile」的开发形态。
 *
 * 本用例构造的正是**装好**的形态：包落在 `<root>/node_modules/dsh-ppt-master-wrapper/`，
 * 子进程环境剔除全部 `DSH_*`。改前该子进程在 import 期抛「定位链四级均未命中」。
 */

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 与宿主进程一致的环境：保留用户变量，剔除全部 `DSH_*`。 */
function envWithoutDsh() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_')));
}

/** 把真实入口按「已安装」形态落进 stub profile；返回入口 URL 与 node_modules 根。 */
async function installPlugin(root) {
  const modules = join(root, 'node_modules');
  await buildStubSdk(modules);
  const installed = join(modules, 'dsh-ppt-master-wrapper');
  await cp(join(PACKAGE_ROOT, 'index.js'), join(installed, 'index.js'));
  await cp(join(PACKAGE_ROOT, 'package.json'), join(installed, 'package.json'));
  await cp(join(PACKAGE_ROOT, 'lib'), join(installed, 'lib'), { recursive: true });
  return { entry: pathToFileURL(join(installed, 'index.js')).href, modules };
}

/** 在无 `DSH_*` 的子进程里装载入口，并要求 `Config` 可导出。 */
async function assertLoads(entry, root) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const m = await import(${JSON.stringify(entry)});`
        + "if (typeof m.Config !== 'function') throw new Error('Config 未导出');",
    ],
    { cwd: root, env: envWithoutDsh() },
  );
  assert.equal(stdout, '');
}

test('loader: env 无任何 DSH_* 时，装好的插件靠裸导入解析 schemastery 并装载', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loader-'));
  try {
    const { entry } = await installPlugin(root);
    await assertLoads(entry, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader: 宿主包只导出命名 Schema（无 default）时，仍按命名导出装载', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loader-named-'));
  try {
    const { entry, modules } = await installPlugin(root);
    // 用「只有命名导出」的 ESM 替身覆盖 stub 的 CJS 包：真实包当前是
    // `export { Schema as default }`，但上游若改成纯命名导出，装载不应退化成裸 TypeError。
    const pkg = join(modules, '@deepseek-ai', 'schemastery');
    await rm(pkg, { recursive: true, force: true });
    await mkdir(pkg, { recursive: true });
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: '@deepseek-ai/schemastery',
        version: '0.0.0',
        type: 'module',
        exports: { '.': { import: './index.mjs' } },
      }),
    );
    await writeFile(
      join(pkg, 'index.mjs'),
      SCHEMASTERY_STUB.replace('module.exports = Schema;', 'export { Schema };'),
    );
    await assertLoads(entry, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
