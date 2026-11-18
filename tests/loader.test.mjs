import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildStubSdk } from './helpers/stub-sdk.mjs';

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

test('loader: env 无任何 DSH_* 时，装好的插件靠裸导入解析 schemastery 并装载', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loader-'));
  try {
    const modules = join(root, 'node_modules');
    await buildStubSdk(modules);

    // 把真实入口按「已安装」形态落进 profile 的 node_modules。
    const installed = join(modules, 'dsh-ppt-master-wrapper');
    await cp(join(PACKAGE_ROOT, 'index.js'), join(installed, 'index.js'));
    await cp(join(PACKAGE_ROOT, 'package.json'), join(installed, 'package.json'));
    await cp(join(PACKAGE_ROOT, 'lib'), join(installed, 'lib'), { recursive: true });

    const entry = pathToFileURL(join(installed, 'index.js')).href;
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
