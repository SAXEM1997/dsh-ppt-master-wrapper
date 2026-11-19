#!/usr/bin/env node
/**
 * 发布前哨：确认个人模板库没有被带进包体。
 *
 * **为什么不用 `.npmignore`**（实测无效，2026-11-19）：`package.json` 的 `files`
 * 是白名单且含 `skills`，npm 打包时不会再用根 `.npmignore` 把白名单目录里的文件剔掉
 * ——把 `templates/local/` 写进 `.npmignore` 后 `npm pack --dry-run` 仍然列出
 * `skills/ppt-master/templates/local/brands/probe/meta.json`。
 *
 * 因此改成**显式哨兵**：`prepack` 钩子在本仓库既没有该目录时静默通过，存在即
 * fail-loud（退出码 1），把「个人模板被误打包发布」挡在发布之前。正常发布从 tag
 * 干净检出，目录天然不存在；本地打包前请把个人模板移出仓库。
 *
 * `--root <dir>` 仅供测试与排障指向别的树。
 *
 * @module dsh-ppt-master-wrapper/scripts/check-pack
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根——以**模块位置**定位（scripts/ 的上一级），与 cwd 无关。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 个人模板库在仓库内的相对路径（与 sync-upstream 的 `LOCAL_TEMPLATE_REL` 同一处语义）。 */
export const LOCAL_TEMPLATE_REL = 'skills/ppt-master/templates/local';

/**
 * 该目录是否存在（含空目录：空目录也会被 npm 以目录条目形式带入包体）。
 *
 * @param {string} [root] 仓库根（缺省 `REPO_ROOT`）。
 * @returns {boolean}
 */
export function hasLocalTemplateLibrary(root = REPO_ROOT) {
  const path = join(root, LOCAL_TEMPLATE_REL);
  return existsSync(path) && statSync(path).isDirectory();
}

const USAGE = '用法: node scripts/check-pack.mjs [--root <dir>]';

/** 解析参数；未知参数按用法错误处理（退出码 2）。 */
export function parseArgs(argv) {
  const options = { root: REPO_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return { error: '--root 需要一个目录参数' };
      options.root = resolve(value);
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') return { help: true };
    return { error: `未知参数: ${arg}` };
  }
  return options;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`${parsed.error}\n${USAGE}`);
    process.exit(2);
  }
  if (parsed.help) {
    console.log(USAGE);
    return;
  }
  if (!hasLocalTemplateLibrary(parsed.root)) return;
  console.error([
    `发布前哨拦截：${LOCAL_TEMPLATE_REL} 存在，它属于运行时用户数据，不能进包体。`,
    '（package.json 的 files 白名单含 skills，npm 不会用 .npmignore 剔除其中文件。）',
    '处理：把个人模板移出仓库后重跑；若确认要发布，这个目录必须不存在。',
  ].join('\n'));
  process.exit(1);
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
