#!/usr/bin/env node

/**
 * sync-upstream.mjs — 一键把上游 ppt-master 的 skill 面同步进本包装层。
 *
 * 本文件按 spec §4 分三层递进实现（Task 10-13）：
 *  - **Task 10（已实现）**：参数解析 + 纯函数层——`git ls-remote --tags`
 *    解析、最新 release tag 选取（数字元组逐段比较）、ref 规范化、codeload URL
 *    推导、缓存键、磁盘预算、`.upstream/last-sync.json` 状态读写助手。
 *  - **Task 11（本层，已实现）**：staging 复制（权威谓词过滤 + 含隐藏文件的逐字节
 *    复制）、结构分类（🔴🟡🟢 分类矩阵 + 行 1 单向比对 + `vendorDiff` 字节差异
 *    汇总 + aux-dir 状态记录读写）、上游仓库根 marketplace 版本一致性校验。
 *  - **Task 12（本层，已实现）**：版本判定规则（①④②③/no-change）——`parseRSuffix`
 *    解析助手 + `decideVersion` 互斥判定纯函数（spec §4.3）。
 *  - **Task 13（本层，已实现）**：`main(options, deps)` 全流程编排与退出码闭环
 *    （spec §4.1 步骤 1-8：解析→拉取→staging→guard→结构检测→自动/人工路径→幂等）。
 *    deps 可注入 `{ fetchTarball, runGit, runPython, now, runVerify, freeSpace }`
 *    供测试驱动；编排不直接 import verify-plugin（runVerify 为注入位，缺省经动态
 *    import 注入）。
 *
 * 用法（完整选项见 spec §4；本层仅解析、不执行）：
 *   node scripts/sync-upstream.mjs [--ref <tag|branch|commit>] [--repo <url>]
 *     [--refresh] [--confirm-structural] [--skip-guard] [--no-push] [--dry-run]
 *
 * 关键契约（全部在 tests/sync-parse.test.mjs 固定，零网络、纯 fixture）：
 *  - **tag 远端原名**：从 `ls-remote --tags` 行取 `refs/tags/` 之后的部分（如
 *    `v6.7.0`）；拼装 ref 时按原名构造 `refs/tags/<原名>`——双前缀
 *    `refs/tags/refs/tags/…` 是必须防住的回归（实测 41 个 semver tag 全部带 v
 *    前缀；无 v 前缀仅作 `normalizeRef` 防御性分支，不与 codeload 真实性绑定）。
 *  - **annotated / lightweight 双形态**：`^{}` 松散行被剥离（不作为独立条目），
 *    其信息以 `isAnnotated` 布尔 + `peeledSha` 字段**并入同一返回数组的对应主
 *    行**——不设第二返回值、不设旁路映射，因此调用方只需一个数组即可取到
 *    commit sha 的取行规则。cacheKey 的 sha 即取该规则产物（annotated → `^{}`
 *    行 sha；否则 tag 行 sha），cacheKey 本身只做拼接。
 *  - **数字元组比较**：剥 `v` 按 `.` 分段转数字逐段比较，避免字符串比较把
 *    `6.10.0` 排在 `6.7.0` 之下。
 *  - **commit ref 必须 40 位全长 sha**：codeload 对短 sha 的接受性未经验证且
 *    不假设——非 40 位且不匹配 tag/branch 形态 → 以 `usageError` 标记抛出。
 *  - **usage 错误形态**：`parseArgs` 不 throw，返回带 `usageError: true` 的对象
 *    （`--skip-guard` 未与 `--no-push`/`--dry-run` 联用即属此列）；`normalizeRef`
 *    的非法 ref 则必须以 `usageError` **标记的 Error 抛出**供调用方区分。两条
 *    通道互不混淆。
 *
 * 零 npm 依赖（node:fs / node:path / node:url 内建）。
 *
 * @module dsh-ppt-master-wrapper/scripts/sync-upstream
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseFrontmatter } from '../lib/skill-provider.js';

/** 仓库根——以**模块位置**定位（scripts/ 的上一级），与 cwd 无关。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 默认上游仓库（spec §4 用法块；ls-remote 与 codeload 同源取值）。 */
export const DEFAULT_REPO = 'https://github.com/hugohe3/ppt-master.git';

/** 状态文件相对仓库根的路径（缓存目录 `.upstream/`，已 gitignore）。 */
const LAST_SYNC_REL = join('.upstream', 'last-sync.json');

/** 启动磁盘预检的保守固定阈值：260MB（spec §4.1 附注①）。 */
const STARTUP_DISK_BYTES = 260 * 1024 * 1024;

/** 解压后 `.upstream/` 全树实测近似常量：114MB（spec §4.1 附注）。 */
const EXTRACTED_TREE_BYTES = 114 * 1024 * 1024;

/** staging 副本实测近似常量：78MB（spec §4.1 附注）。 */
const STAGING_COPY_BYTES = 78 * 1024 * 1024;

/** 仅匹配 release 语义版本 tag（排除 rc / pre-release 与其它形态）。 */
const SEMVER_TAG_PATTERN = /^v?\d+\.\d+\.\d+$/;

/** 40 位小写/大写 hex 的 commit sha。 */
const FULL_SHA_PATTERN = /^[0-9a-fA-F]{40}$/;

/**
 * branch ref 形态：git 允许的保守名字子集（排除空白与 `~^:?*[\` 等保留字符，
 * 排除 `..`、前导/尾随 `/`、前导 `-` 与 `.`）。
 *
 * 与短 sha 的歧义由 `normalizeRef` 的**歧义守卫**处理，而非本模式：`abc123` 与
 * `my-branch` 在字符集上完全同类（都匹配本模式），只能靠「纯 hex 且长度 ≤12」
 * 这一形态特征把短 sha 判出来（见该函数）。裸的 39/41 位 hex 串同样被守卫拦下。
 */
const BRANCH_REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

/** 短 sha 形态：纯 hex 且长度落在 git 短 sha 常见区间（4-12）——歧义守卫用。 */
const SHORT_SHA_PATTERN = /^[0-9a-fA-F]{4,12}$/;

/** `git ls-remote --tags` 主行：`<sha>\trefs/tags/<名>`（亦容忍空格分隔）。 */
const LS_REMOTE_LINE_PATTERN = /^([0-9a-fA-F]{40})\s+(refs\/tags\/.+)$/;

/**
 * 构造带 `usageError` 标记的用法错误。
 *
 * 标记存在的意义：调用方（T13 编排的 CLI 层）须把「用法错误 → 退出码 1」与
 * 其它失败（网络/校验/推送）分开处置，因此错误对象必须可判别——仅凭 message
 * 文本判别是脆弱的。
 */
function usageError(message) {
  const error = new Error(message);
  error.usageError = true;
  return error;
}

/** 非空字符串 → 原值；否则 null。 */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

// ─── parseArgs：CLI 参数解析 ─────────────────────────────────────

/**
 * 解析 CLI 参数（spec §4 用法块）。
 *
 * 返回的 `Options` 只带**显式给出**的字段（缺省字段保持 undefined，供 T13 区分
 * 「用户显式传了 `--ref`」——`--confirm-structural` 的 last-sync ref 回退仅在
 * 未显式传 `--ref` 时生效）。
 *
 * 非法组合（`--skip-guard` 未与 `--no-push`/`--dry-run` 联用——该次运行最终会
 * 执行推送，属 spec 用法块禁止的组合）不 throw，而是返回 `{ ...options,
 * usageError: true }`：其余字段照常解析，调用方据 `usageError` 决定退出码 1。
 *
 * @param {string[]} argv 参数数组（不含 node/脚本路径）。
 * @returns {{ repo?: string, ref?: string, refresh?: boolean,
 *   confirmStructural?: boolean, skipGuard?: boolean, noPush?: boolean,
 *   dryRun?: boolean, usageError?: true }} Options（usageError 存在即非法）。
 */
export function parseArgs(argv) {
  const options = {};
  let usageErrorFlag = false;

  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    switch (arg) {
      case '--ref':
      case '--repo': {
        const value = list[i + 1];
        // 缺值判据：到达末尾，或下一个 token 本身是标志（`--ref --refresh`）。
        if (value === undefined || value.startsWith('--')) {
          usageErrorFlag = true;
          continue;
        }
        if (arg === '--ref') options.ref = value;
        else options.repo = value;
        i++;
        break;
      }
      case '--refresh':
        options.refresh = true;
        break;
      case '--confirm-structural':
        options.confirmStructural = true;
        break;
      case '--skip-guard':
        options.skipGuard = true;
        break;
      case '--no-push':
        options.noPush = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        usageErrorFlag = true;
        break;
    }
  }

  // 联用约束（spec 用法块）：--skip-guard 仅豁免 guard 执行，若该次运行最终会
  // 推送（含默认推送）即属非法组合。
  if (options.skipGuard === true && options.noPush !== true && options.dryRun !== true) {
    usageErrorFlag = true;
  }

  if (usageErrorFlag) options.usageError = true;
  return options;
}

// ─── parseLsRemote：ls-remote --tags 文本解析 ────────────────────

/**
 * 解析 `git ls-remote --tags <repo>` 的 stdout。
 *
 * 返回**单一主行数组**（顺序即 ls-remote 输出序）：`^{}` 松散行被剥除，其信息
 * 以两个字段并入对应主行条目——
 *  - `isAnnotated: boolean` — 该 tag 是否有 `^{}` 行（annotated tag）；
 *  - `peeledSha: string | null` — `^{}` 行指向的 commit sha（lightweight → null）。
 *
 * 因此 commit sha 的「取行规则」（annotated 取 `^{}` 行、否则取 tag 行）在调用
 * 方是纯字段读取，无需第二返回值或旁路映射。
 *
 * 非 `refs/tags/` 行（如 `refs/heads/…`）与不可解析行被忽略——本函数只服务
 * `--tags` 输出。
 *
 * @param {string} text ls-remote stdout。
 * @returns {Array<{ sha: string, ref: string, tagName: string, isAnnotated: boolean,
 *   peeledSha: string | null }>} 主行条目数组。
 */
export function parseLsRemote(text) {
  const entries = [];
  const byRef = new Map();

  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line === '') continue;
    const match = LS_REMOTE_LINE_PATTERN.exec(line);
    if (match === null) continue;

    const [, sha, ref] = match;
    if (ref.endsWith('^{}')) {
      // 松散行：不产生独立条目；信息并入对应主行——主行条目若已入数组，必须
      // **就地**修正该条目（map 值与之是两个对象，只改 map 会丢失并入信息）。
      const mainRef = ref.slice(0, -'^{}'.length);
      const pending = byRef.get(mainRef);
      if (pending !== undefined && pending.entry !== undefined) {
        pending.entry.isAnnotated = true;
        pending.entry.peeledSha = sha;
        pending.peeledSha = sha;
      } else if (pending !== undefined) {
        pending.peeledSha = sha;
      } else {
        // 松散行先于主行出现（ls-remote 实际成对输出，但顺序不作假设）。
        byRef.set(mainRef, { mainSha: null, peeledSha: sha, entry: undefined });
      }
      continue;
    }

    const pending = byRef.get(ref);
    const entry = {
      sha,
      ref,
      tagName: ref.slice('refs/tags/'.length),
      // annotated 只在**已见到该 tag 的 `^{}` 行**时为真（peeledSha 非 null）。
      isAnnotated: (pending?.peeledSha ?? null) !== null,
      peeledSha: pending?.peeledSha ?? null,
    };
    // 登记本主行条目，供其后到达的 `^{}` 行就地修正（顺序不作假设）。
    byRef.set(ref, { mainSha: sha, peeledSha: entry.peeledSha, entry });
    entries.push(entry);
  }

  return entries;
}

/**
 * 从主行条目取「该 tag 的 commit sha」——annotated 取 `^{}` 行 sha，否则取 tag
 * 行 sha（spec §4.1 步骤 1 缓存键 sha 取行规则）。
 */
function commitShaOf(entry) {
  return entry.peeledSha !== null && entry.peeledSha !== undefined ? entry.peeledSha : entry.sha;
}

/** 把 tag 名解析成数字元组；不含 semver 形态 → null。 */
function semverTuple(name) {
  if (!SEMVER_TAG_PATTERN.test(name)) return null;
  return name.replace(/^v/, '').split('.').map((part) => Number(part));
}

/** 数字元组逐段比较（>0 左大；<0 右大；0 相等）。 */
function compareTuples(left, right) {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}

/**
 * 选取最高 release tag（spec §4.1 步骤 1）。
 *
 * 仅考虑匹配 `^v?\d+\.\d+\.\d+$` 的 tag（排除 rc/pre-release），`v` 前缀不参与
 * 比较；比较采用**数字元组逐段比较**（避免字符串比较把 `6.10.0` 排在 `6.7.0`
 * 之下）。返回**远端原名**（带 v 前缀，如 `v2.13.0`）与 commit sha。
 *
 * @param {Array<object>} entries parseLsRemote 产物。
 * @returns {{ name: string, sha: string } | null} 无匹配 → null（不 throw；调用
 *   方据此报「上游无可用 release tag」并指引 `--ref`）。
 */
export function pickLatestTag(entries) {
  let best = null;
  let bestTuple = null;

  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = entry?.tagName ?? null;
    if (name === null) continue;
    const tuple = semverTuple(name);
    if (tuple === null) continue;

    // 元组相同（如同时存在 v6.7.0 与 6.7.0）时保持先出现者——稳定、可预期。
    if (bestTuple !== null && compareTuples(tuple, bestTuple) <= 0) continue;
    best = { name, sha: commitShaOf(entry) };
    bestTuple = tuple;
  }

  return best;
}

// ─── normalizeRef：ref → 规范化完整 ref ─────────────────────────

/**
 * 规范化 ref（构造 codeload URL 前，spec §4.1 步骤 2）。
 *
 *  - tag（如 `v6.7.0`，或 `6.7.0`）→ `refs/tags/<远端原名>`（**保留远端原名形态**，
 *    不猜测、不补 `v`）；
 *  - branch（如 `main`、`feature/x`）→ `refs/heads/<名>`；
 *  - 40 位 hex sha → 原样。
 *
 * **双前缀防御**：输入已含 `refs/tags/` / `refs/heads/` 时原样返回，绝不产出
 * `refs/tags/refs/tags/…`。
 *
 * **短 sha 拒绝**：非 40 位且不匹配 tag/branch 形态（如 `abc123`）→ 抛带
 * `usageError` 标记的错误。理由：commit ref 必须是 40 位全长 sha——codeload 对
 * 短 sha 的接受性未经验证，不假设。
 *
 * @param {string} ref 用户 `--ref` 值或远端 tag 原名。
 * @returns {string} 规范化 ref。
 * @throws {Error} 非法 ref（`error.usageError === true`）。
 */
export function normalizeRef(ref) {
  const value = nonEmpty(ref);
  if (value === null) {
    throw usageError('ref 不能为空——请传 tag（如 v6.7.0）、branch（如 main）或 40 位 commit sha。');
  }

  // 双前缀防御：已是完整 ref 直接原样返回。
  if (value.startsWith('refs/tags/') || value.startsWith('refs/heads/')) return value;

  if (FULL_SHA_PATTERN.test(value)) return value;

  // tag 形态：semver（v 可选）。远端原名原样拼装。
  if (SEMVER_TAG_PATTERN.test(value)) return `refs/tags/${value}`;

  // branch 形态（单段或多段名，字符集取 git 允许的保守子集）。
  //
  // **歧义守卫**：短 sha（`abc123`）与普通分支名（`my-branch`）在字符集上无法
  // 区分，但契约要求「commit ref 必须 40 位全长 sha，短 sha 一律拒绝」。因此把
  // 「纯 hex 且长度在短 sha 区间（4-12）」判为短 sha 形态拒绝——这类串在实践中
  // 几乎只作 sha 缩写使用，牺牲它换取「短 sha 绝不被静默当作 branch 放行」这一
  // 硬约束（codeload 对短 sha 的接受性未验证，不予假设）。同理拦下任意长度的
  // 纯 hex 串（39/41 位等接近全长的畸形 sha），避免它们被当作 branch 拼装。
  if (BRANCH_REF_PATTERN.test(value) && !value.includes('..') && !value.endsWith('/')) {
    const looksLikeSha = /^[0-9a-fA-F]+$/.test(value) && (SHORT_SHA_PATTERN.test(value) || value.length >= 39);
    if (!looksLikeSha) return `refs/heads/${value}`;
  }

  throw usageError(
    `非法 ref: ${JSON.stringify(value)}——commit ref 必须是 40 位全长 sha`
      + `（codeload 对短 sha 的接受性未验证，不予假设），或 tag（v6.7.0 形态）`
      + `或 branch 名（如 main、feature/x）。`,
  );
}

// ─── buildCodeloadUrl：repo URL → codeload tarball URL ──────────

/**
 * 从 `--repo` 值推导 codeload tarball URL（spec §4.1 步骤 2）。
 *
 * `https://github.com/<owner>/<name>.git` →
 * `https://codeload.github.com/<owner>/<name>/tar.gz/<normalizedRef>`。
 * owner/name 由 repo URL 解析（剥 `.git` 后缀与尾斜杠）。ls-remote 与 codeload
 * 同源取值——同一个 `--repo` 驱动两处。
 *
 * @param {string} repo 仓库 URL。
 * @param {string} normalizedRef normalizeRef 产物（或已经是完整 ref / 40 位 sha）。
 * @returns {string} codeload tarball URL。
 * @throws {Error} repo 无法解析出 owner/name（`error.usageError === true`）。
 */
export function buildCodeloadUrl(repo, normalizedRef) {
  const value = nonEmpty(repo);
  if (value === null) {
    throw usageError(`--repo 不能为空——请传形如 ${DEFAULT_REPO} 的仓库 URL。`);
  }
  const ref = nonEmpty(normalizedRef);
  if (ref === null) {
    throw usageError('normalizedRef 不能为空——请先经 normalizeRef 规范化。');
  }

  let owner;
  let name;
  const scpLike = /^[^/@\s]+@[^/:\s]+:(.+)$/.exec(value);
  if (scpLike !== null) {
    // scp 形态 git@github.com:owner/name.git（无协议前缀）——同样按末两段解析。
    ({ owner, name } = splitOwnerName(scpLike[1]));
  } else {
    let pathname;
    try {
      pathname = new URL(value).pathname;
    } catch {
      throw usageError(`--repo 不是可解析的仓库 URL: ${JSON.stringify(value)}。`);
    }
    ({ owner, name } = splitOwnerName(pathname));
  }

  if (owner === null || name === null) {
    throw usageError(
      `--repo 无法解析出 owner/name: ${JSON.stringify(value)}——`
        + `期望形如 ${DEFAULT_REPO}（或 git@github.com:owner/name.git）。`,
    );
  }

  return `https://codeload.github.com/${owner}/${name}/tar.gz/${ref}`;
}

/** 从路径取末两段为 owner/name，剥 `.git` 后缀与尾斜杠；不足两段 → null。 */
function splitOwnerName(pathname) {
  const segments = String(pathname).replace(/\/+$/, '').split('/').filter((segment) => segment !== '');
  if (segments.length < 2) return { owner: null, name: null };
  const name = segments[segments.length - 1].replace(/\.git$/, '');
  const owner = segments[segments.length - 2];
  if (owner === '' || name === '') return { owner: null, name: null };
  return { owner, name };
}

// ─── cacheKey：缓存键 ───────────────────────────────────────────

/**
 * 缓存键 `<ref>@<sha>`（spec §4.1 步骤 2 的 `.upstream/<ref>@<sha>/`）。
 *
 * sha 的取行规则（annotated → `^{}` 行 sha，否则 tag 行 sha）是
 * `parseLsRemote` / `pickLatestTag` 的产物，**本函数只做拼接**。同名 tag 重推
 * （sha 变化）→ 键不同 → 缓存失效重下；sha 不变 → 键稳定 → 复用。
 *
 * @param {string} ref 规范化完整 ref（normalizeRef 产物）。
 * @param {string} sha commit sha。
 * @returns {string} `<ref>@<sha>`。
 */
export function cacheKey(ref, sha) {
  return `${String(ref)}@${String(sha)}`;
}

// ─── diskBudget：磁盘预算 ───────────────────────────────────────

/**
 * 磁盘预算（字节，spec §4.1 附注）。
 *
 *  - 无参 = **启动保守固定阈值 260MB**（三段之和 ≈240MB 加余量取整）；
 *  - 有参 = 三项实际之和：①tarball 实际字节（Content-Length）②解压后
 *    `.upstream/` 全树常量 114MB ③staging 副本常量 78MB。
 *
 * ②③ 是实测近似常量（本函数不探测磁盘），因此有参调用是「按实际 tarball 大小
 * 复检」（二次预检，解压前）。
 *
 * @param {number} [tarballBytes] tarball 实际字节数（Content-Length）。
 * @returns {number} 预算字节数。
 */
export function diskBudget(tarballBytes) {
  if (tarballBytes === undefined || tarballBytes === null) return STARTUP_DISK_BYTES;
  return Number(tarballBytes) + EXTRACTED_TREE_BYTES + STAGING_COPY_BYTES;
}

// ─── .upstream/last-sync.json 状态读写助手 ──────────────────────

/** 状态文件绝对路径（root 缺省 = 仓库根，与 cwd 无关）。 */
function lastSyncPath(root) {
  return join(root ?? REPO_ROOT, LAST_SYNC_REL);
}

/**
 * 读 `.upstream/last-sync.json`（spec §4.1 步骤 2 / 7 / 8 的 ref·sha 锚点）。
 *
 * 无文件、不可读、JSON 损坏、或结构不是 `{ref:string, version:string, at:string}`
 * → null（**不 throw**：状态文件是可留存缓存的便利设施，其缺失等价「首次同步」，
 * 不应让调用方崩溃）。
 *
 * `sha` 为**可选**字段（branch ref 场景不可得——`--ref <branch>` 时 refSha 恒
 * null，写入侧落 `sha: ''`）。缺失/空串/非字符串 → 保留整条记录、`sha` 字段为
 * null。此前 sha 与 ref/version/at 同为必填，导致 branch ref 记录**写入即不可读**
 * ——`--confirm-structural` 对 branch 的「固定上次检出 ref」承诺（spec §4.1 步骤 7）
 * 静默失效并回落最新 tag。判据因此分两级：`ref`/`version`/`at` 必填且非空，`sha`
 * 可缺。`sameRefSha` 幂等比对对 null 的处理见编排侧（`previousSync.sha === (refSha
 * ?? '')` 对 branch 不误判同 ref）。
 *
 * `head` 为**可选**字段（包装层 HEAD 基线——无 @{u} 回退分支的 wrapperPending
 * 锚，T13 fix）：旧记录/首灌前无该字段或为空 → null。`sha` 字段保持**上游**
 * commit sha 语义（缓存键/幂等 ref 比对）——两字段 sha 空间分离，互不作锚。
 *
 * @param {string} [root] 仓库根；缺省 = 本模块所属仓库根（与 cwd 无关）。
 * @returns {{ ref: string, sha: string | null, version: string, at: string,
 *   head: string | null } | null}
 */
export function readLastSync(root) {
  const file = lastSyncPath(root);
  if (!existsSync(file)) return null;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  for (const key of ['ref', 'version', 'at']) {
    if (typeof parsed[key] !== 'string' || parsed[key] === '') return null;
  }
  // sha 可选：缺失/空串 = 「不可得」（branch ref），保留记录并归 null；非空字符串
  // 原样保留；其余类型（数字/对象等畸形值）仍判无效——那不是「不可得」而是损坏。
  let sha = null;
  if (parsed.sha !== undefined && parsed.sha !== '') {
    if (typeof parsed.sha !== 'string') return null;
    sha = parsed.sha;
  }
  return {
    ref: parsed.ref,
    sha,
    version: parsed.version,
    at: parsed.at,
    head: typeof parsed.head === 'string' && parsed.head !== '' ? parsed.head : null,
  };
}

/**
 * 写 `.upstream/last-sync.json`（建目录 + 原子写 + `at` ISO 时间）。
 *
 * 原子写：先写同目录临时文件再 `rename`，避免并发/中断留下半截 JSON（该文件被
 * 读作缓存锚点，半截 JSON 会静默降级为 null 从而丢失幂等比对基准）。
 * `at` 由本函数写入（ISO 8601，UTC），data 中的 `at` 被忽略。
 *
 * `head`（可选）：包装层 HEAD 基线——非空字符串才写实质值，缺省写 `''`（读取侧
 * 视为无基线）。写入时机由 T13 编排控制：wrapper commit 之后（exit 2 路径无
 * wrapper commit，不写）；`sha` 仍是上游 commit sha（缓存键语义）。
 *
 * @param {{ ref: string, sha: string, version: string, head?: string,
 *   at?: string }} data 状态内容。
 * @param {string} [root] 仓库根；缺省 = 本模块所属仓库根（与 cwd 无关）。
 * @returns {{ ref: string, sha: string, version: string, head: string,
 *   at: string }} 落盘内容。
 */
export function writeLastSync(data, root) {
  const file = lastSyncPath(root);
  const payload = {
    ref: String(data?.ref ?? ''),
    sha: String(data?.sha ?? ''),
    version: String(data?.version ?? ''),
    head: typeof data?.head === 'string' && data.head !== '' ? data.head : '',
    at: new Date().toISOString(),
  };

  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return payload;
}

// ─── Task 11：staging 复制 / 结构分类 / marketplace 校验 ─────────

/** 权威谓词：一级目录且**直接子级**存在该文件即为 skill 目录（§3.4，与 T3 同源）。 */
const SKILL_FILE_NAME = 'SKILL.md';

/**
 * 一级条目增删即判 🔴 的四个架构级目录（spec §4.2 行 4；仅比一级条目）。
 */
const STRUCTURAL_DIRS = ['workflows', 'scripts', 'templates', 'references'];

/** frontmatter `metadata.version` 的期望行（`  version: "6.7.0"`，引号可选）。 */
const METADATA_VERSION_LINE = /^\s{2}version\s*:\s*(.+?)\s*$/m;

/** frontmatter 块内顶层 `name:` 行（缩进 0，避免命中 metadata 下的键）。 */
const FRONTMATTER_NAME_LINE = /^name\s*:\s*(.*)$/m;

/** frontmatter 块内顶层 `description:` 行（含 `>` / `|` 折叠标量形态）。 */
const FRONTMATTER_DESCRIPTION_LINE = /^description\s*:\s*(.*)$/m;

/** requirements.txt 的依赖行（非空、非注释）；比较以「行集合」为单位。 */
const REQUIREMENT_LINE = /^\s*[^#\s][^#]*$/;

/** aux-dir 状态记录的默认位置：`<vendorSkillsRoot 的父级>/.upstream/last-aux-dirs.json`。 */
const AUX_STATE_REL = join('.upstream', 'last-aux-dirs.json');

// ── 通用助手 ─────────────────────────────────────────────────────

/** UTF-16 码单元序比较（localeCompare-free，与插件其余部分同一约定）。 */
function compareByteOrder(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** 路径末段（POSIX 与绝对路径通吃）。 */
function baseName(path) {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? path : path.slice(separator + 1);
}

/**
 * 逐字节比较两个文件。
 *
 * 与 Task 8 的比对思路同源（`Buffer.compare`，非文本归一化）——同步检测必须
 * 对任何字节差异敏感，CRLF/LF 之别也是差异（vendor 面要求逐字节保真）。
 * 任一侧不可读（不存在/是目录/权限）→ 视为**不相等**（调用方按「有差异」处置，
 * 而非抛错中断分类）。
 */
function commonBytesEqual(leftFile, rightFile) {
  try {
    return Buffer.compare(readFileSync(leftFile), readFileSync(rightFile)) === 0;
  } catch {
    return false;
  }
}

/** 目录下一级条目名（含 dotfile），按字节序排序；不可读 → []。 */
function firstLevelEntries(directory) {
  try {
    return readdirSync(directory).sort(compareByteOrder);
  } catch {
    return [];
  }
}

/**
 * 按权威谓词（一级目录且直接子级存在 SKILL.md，dotfile 同判）列出 skill 目录名。
 *
 * 与 T3 `listSkillDirs` 的谓词同源，但只返回**目录名**并容忍根缺失（返回 []）：
 * 分类需要区分「vendor 面为空」与「vendor 面缺失」，而 staging 复制面的根必在。
 * 只扫一级，绝不深入（`skills/.claude-plugin/` 这类无 SKILL.md 的目录被静默跳过）。
 */
function skillDirNames(root) {
  const names = [];
  for (const name of firstLevelEntries(root)) {
    const directory = join(root, name);
    try {
      if (!statSync(directory).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(directory, SKILL_FILE_NAME))) names.push(name);
  }
  return names;
}

/**
 * 递归收集目录下全部文件（含隐藏文件）的**相对路径**，按字节序排序。
 *
 * 逐字节比对必须覆盖整棵子树——隐藏文件（`.env.example`）与任意深度都在面内；
 * 只用 `readdirSync` 的名字列表会漏掉「深层文件内容变了但名字没变」。
 */
function walkRelativeFiles(root) {
  const files = [];
  const visit = (current, prefix) => {
    for (const name of firstLevelEntries(current)) {
      const path = join(current, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) visit(path, rel);
      else files.push(rel);
    }
  };
  visit(root, '');
  return files.sort(compareByteOrder);
}

/** 提取 SKILL.md 的 frontmatter 块文本；无 frontmatter / 不可读 → null。 */
function frontmatterBlock(skillFile) {
  let text;
  try {
    text = readFileSync(skillFile, 'utf8');
  } catch {
    return null;
  }
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return null;
  return normalized.slice(4, end);
}

/** frontmatter 块内某顶层键的标量值（`>`/`|` 折叠标量为「块起始行 + 正文行」）。 */
function frontmatterScalar(block, pattern) {
  if (block === null) return null;
  const match = pattern.exec(block);
  if (match === null) return null;
  return match[1].trim();
}

/**
 * 从 frontmatter 块提取 `description` 的**自身值**（不含其它键）。
 *
 * 上游真实形态是折叠标量（`description: >` 后跟缩进正文）。**只取本键的值**是
 * 关键：若把整个 frontmatter 块当作 description 的值，则任何其它键的改动
 * （`metadata.version` 版本 bump、`name`、`license`…）都会连带改变该值，把
 * spec §4.3 规则① 的版本 bump 主路径误报成 🟡 description 变更（幻影报警）。
 *
 * 取值规则（覆盖 `>` / `|` 折叠与单行标量两种形态）：
 *  - 从 `description:` 行起，到**下一个一列 0 的键行**（行首非空白且含 `:`）为止；
 *  - 或到 frontmatter 块尾（description 是最后一个键）为止。
 *
 * 返回值经行尾空白归一（`.` → `''`，保留缩进以对齐 YAML 折叠语义）——
 * 仅比较用，不参与落盘。
 *
 * @param {string} block frontmatter 块文本（不含定界行）。
 * @returns {string|null} description 自身值；无该键 → null。
 */
function extractDescription(block) {
  if (block === null) return null;
  const lines = block.split('\n');
  const startIndex = lines.findIndex((line) => FRONTMATTER_DESCRIPTION_LINE.test(line));
  if (startIndex < 0) return null;

  const collected = [lines[startIndex].replace(/\s+$/, '')];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    // 一列 0 的键行（行首非空白且含 `:`）即下一个键——description 值到此为止。
    if (/^\S.*:/.test(line)) break;
    collected.push(line.replace(/\s+$/, ''));
  }

  // 归一尾部空行（折叠块后常跟空行）：比较语义不受尾随换行数影响。
  while (collected.length > 1 && collected[collected.length - 1] === '') collected.pop();
  return collected.join('\n');
}

/**
 * SKILL.md 的 frontmatter 摘要：`{ name, version, description }`。
 *
 *  - `name` / `description` 缺失或不含 frontmatter → null（各自分类项据此报告）；
 *  - `version` 缺失或不可解析 → null（spec §4.2 行 3 的 🔴 判据）。
 *
 * 三个键各自**独立取值**（description 只取本键的折叠块，见 `extractDescription`），
 * 因此某一键的改动不会污染其它键的比对结果。
 */
function skillFrontmatter(skillDir) {
  const block = frontmatterBlock(join(skillDir, SKILL_FILE_NAME));
  if (block === null) return { name: null, version: null, description: null };

  const nameMatch = FRONTMATTER_NAME_LINE.exec(block);
  const versionMatch = METADATA_VERSION_LINE.exec(block);

  let version = null;
  if (versionMatch !== null) {
    // 去引号后非空才算可解析（`version:` 空值 / `version: ""` → 不可解析）。
    const raw = versionMatch[1].replace(/^["']|["']$/g, '').trim();
    version = raw === '' ? null : raw;
  }

  return {
    name: nameMatch === null ? null : nameMatch[1].replace(/^["']|["']$/g, '').trim(),
    version,
    description: extractDescription(block),
  };
}

/** requirements.txt 的依赖行集合（忽略注释/空行/行序/**重复行**）；文件缺失 → null。 */
function requirementLines(skillDir) {
  let text;
  try {
    text = readFileSync(join(skillDir, 'requirements.txt'), 'utf8');
  } catch {
    return null;
  }
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => REQUIREMENT_LINE.test(line));
  // 去重：requirements 语义是「依赖集合」，同一行出现两次不构成依赖增删。
  return [...new Set(lines)].sort(compareByteOrder);
}

/** 两个字符串数组的对称差（供依赖行增删的报告明细）。 */
function symmetricDifference(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return [
    ...left.filter((item) => !rightSet.has(item)),
    ...right.filter((item) => !leftSet.has(item)),
  ].sort(compareByteOrder);
}

/** 两个数组是否逐项相等（已排序数组的元素比较）。 */
function arraysEqual(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

// ── stageSkills：谓词过滤 + 含隐藏文件的逐字节复制 ───────────────

/**
 * 把上游 `skills/` 下的 skill 面复制进 staging（spec §4.1 步骤 3）。
 *
 * **复制源**：`<upstreamRoot>/skills/` 下每个满足权威谓词的一级目录——直接子级
 * 存在 `SKILL.md`（dotfile 目录同判）。`skills/` 一级**不含** `SKILL.md` 的目录
 * （如 `skills/.claude-plugin/`——Claude 插件清单，DSH 不消费）**不进入** staging。
 *
 * **复制面 = 含隐藏文件的逐字节全树复制**：dotfile 不排除（`.env.example` 实测被
 * 上游 git 跟踪、README 指引依赖它），且逐字节保真（`cpSync` 不作文本归一化）。
 * 目标 skill 目录先清空再复制——staging 是每次运行的等价快照，残留会让分类把
 * 「上次运行的遗留文件」误判为上游变更。
 *
 * @param {string} upstreamRoot 上游解压树根（`<root>/skills/…`）。
 * @param {string} stagingRoot staging 根（`.skills-staging/`）。
 * @returns {string[]} 已复制的 skill 目录名数组（字节序）。
 * @throws {Error} `upstreamRoot/skills` 缺失或不是目录（fail-loud：把「拉取/解压
 *   失败」误当作「上游无 skill」会让后续替换把 vendor 面清空）。
 */
export function stageSkills(upstreamRoot, stagingRoot) {
  const skillsRoot = join(upstreamRoot, 'skills');
  if (!existsSync(skillsRoot) || !statSync(skillsRoot).isDirectory()) {
    throw new Error(`上游 skills/ 目录不可用（不存在或非目录）: ${skillsRoot}`);
  }

  const copied = skillDirNames(skillsRoot);
  mkdirSync(stagingRoot, { recursive: true });

  for (const name of copied) {
    const target = join(stagingRoot, name);
    rmSync(target, { recursive: true, force: true });
    cpSync(join(skillsRoot, name), target, { recursive: true });
  }

  return copied;
}

// ── aux-dir 状态记录（`.upstream/last-aux-dirs.json`）────────────

/** aux-dir 状态文件路径：显式参数优先，否则 `<vendorSkillsRoot 父级>/.upstream/…`。 */
function auxStateFile(vendorSkillsRoot, auxStatePath) {
  if (typeof auxStatePath === 'string' && auxStatePath !== '') return auxStatePath;
  return join(dirname(vendorSkillsRoot), AUX_STATE_REL);
}

/**
 * 读上次同步的辅助目录清单；无文件 / JSON 损坏 / 结构不符 → null（等价「首灌」）。
 *
 * 与 `readLastSync` 同一宽容哲学：状态文件是可留存缓存的便利设施，其缺失只应
 * 降级为「全部视为新增」，不应让分类崩溃。
 */
function readAuxDirs(file) {
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.auxDirs)) return null;
  if (!parsed.auxDirs.every((item) => typeof item === 'string')) return null;
  return [...parsed.auxDirs].sort(compareByteOrder);
}

/** 写辅助目录清单（建目录 + 原子写；结构固定为 `{ auxDirs: string[] }`）。 */
function writeAuxDirs(file, auxDirs) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ auxDirs }, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * 上游 `skills/` 一级**辅助目录**名（不含 `SKILL.md` 的目录，无论是否 dotfile）。
 *
 * 数据源是上游全树（spec §4.2 行 7）——vendor 树本身不含辅助目录（staging 丢弃
 * 对象），故增删只能与**上次同步的记录**比对，见 `classifyChanges`。
 */
function auxDirNames(upstreamRoot) {
  const skillsRoot = join(upstreamRoot, 'skills');
  const names = [];
  for (const name of firstLevelEntries(skillsRoot)) {
    const directory = join(skillsRoot, name);
    try {
      if (!statSync(directory).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(join(directory, SKILL_FILE_NAME))) names.push(name);
  }
  return names.sort(compareByteOrder);
}

// ── classifyChanges：🔴🟡🟢 分类 ─────────────────────────────────

/**
 * 结构变化分类（spec §4.2 单表；数据源 = vendor 树 vs staging 为主）。
 *
 * 返回 `{ red, yellow, green, vendorDiff }`——
 *
 *  - `red` / `yellow`：`Change[]`，每项 `{ kind, detail }`。`kind` 取值
 *    `skill-dir` / `name` / `metadata.version` / `top-level-entries` /
 *    `requirements` / `description` / `aux-dir`。
 *  - `green: boolean` = 存在**常规内容变更**（其余文件内容更新——含 `LICENSE`、
 *    `SKILL.md` 正文、`SPONSORS*`、`.env.example` 等 skill 目录根级文件），
 *    即「有常规更新要走自动同步」。它与红/黄**正交**：某次同步可以同时有
 *    🔴 项与常规内容变更。
 *  - `vendorDiff: boolean` = vendor skill 面与 staging 之间存在**任何字节差异**
 *    （含红/黄类变更涉及的文件与常规文件）——Task 12 `decideVersion` 规则①/④
 *    的判别输入，故命名与之一致、桥接零转换。`green` 是它的**子集语义**：
 *    有常规变更必有差异，但红/黄类变更可以只置 `vendorDiff` 而不置 `green`。
 *
 * **行 1 单向性**：skill-dir 比对只在上游→vendor 方向报告——staging 有而 vendor
 * 无 → 🔴；vendor 多出的 skill 目录**不产生 red**（那是包装层人工变更，属 §4.3
 * 规则③域）。
 *
 * **aux-dir 契约**：vendor 树不含辅助目录（staging 丢弃对象），故增删判定 = 上游
 * `skills/` 一级当前辅助目录 vs **上次同步的记录** `.upstream/last-aux-dirs.json`
 * （路径可由第五参数 `auxStatePath` 覆盖）。本函数**负责读写该记录**：分类后把
 * 当前清单落盘。记录缺失（首灌）→ 当前全部辅助目录列为新增（🟡 知悉）。
 * `opts.dryRun === true`（Step F #10）时分类照常返回，但**不写**该记录——
 * dry-run 不得消费 🟡 一次性知悉信号（exit-2/幂等路径的非 dry-run 写盘保留）。
 *
 * 所有分类项均以 `vendorDiff` 汇总——不做「红/黄项不置 diff」的短路，因为规则①
 * 的「上游版本变 + 有 diff」与规则④的「无 diff」正是靠本字段区分。
 *
 * @param {string} vendorSkillsRoot vendor 侧 skill 根（其下直接是各 skill 目录）。
 * @param {string} stagingRoot staging 根（`stageSkills` 产物）。
 * @param {string} upstreamRoot 上游解压树根（aux-dir 数据源）。
 * @param {string} [auxStatePath] aux-dir 状态文件路径（缺省由 vendorSkillsRoot 推导）。
 * @param {{ dryRun?: boolean }} [opts] 可选行为开关（缺省行为与旧签名完全一致）。
 * @returns {{ red: Array<{kind: string, detail: string}>,
 *   yellow: Array<{kind: string, detail: string}>, green: boolean, vendorDiff: boolean }}
 */
export function classifyChanges(vendorSkillsRoot, stagingRoot, upstreamRoot, auxStatePath, opts) {
  const red = [];
  const yellow = [];
  let green = false;
  let vendorDiff = false;

  const vendorSkills = skillDirNames(vendorSkillsRoot);
  const stagedSkills = skillDirNames(stagingRoot);
  const vendorSet = new Set(vendorSkills);
  const stagedSet = new Set(stagedSkills);

  // 行 1（单向 上游→vendor）：staging 有而 vendor 无 → 🔴；反向不报告。
  for (const name of stagedSkills) {
    if (!vendorSet.has(name)) {
      vendorDiff = true;
      red.push({ kind: 'skill-dir', detail: `上游新增 skill 目录: ${name}（vendor 树中不存在）` });
    }
  }

  // 逐 skill：仅比对双方共有的目录（单侧存在的已由行 1 / 包装层域处置）。
  for (const name of stagedSkills) {
    if (!vendorSet.has(name)) continue;
    const vendorDir = join(vendorSkillsRoot, name);
    const stagedDir = join(stagingRoot, name);

    // ── 全树逐字节比对：任何差异都置 vendorDiff（含红/黄涉及的文件）──
    const vendorFiles = walkRelativeFiles(vendorDir);
    const stagedFiles = walkRelativeFiles(stagedDir);
    const vendorFileSet = new Set(vendorFiles);
    const stagedFileSet = new Set(stagedFiles);

    const onlyStaged = stagedFiles.filter((rel) => !vendorFileSet.has(rel));
    const onlyVendor = vendorFiles.filter((rel) => !stagedFileSet.has(rel));
    const contentChanged = stagedFiles.filter(
      (rel) => vendorFileSet.has(rel) && !commonBytesEqual(join(vendorDir, rel), join(stagedDir, rel)),
    );

    if (onlyStaged.length > 0 || onlyVendor.length > 0 || contentChanged.length > 0) vendorDiff = true;

    // ── frontmatter 三键 ──
    const vendorMeta = skillFrontmatter(vendorDir);
    const stagedMeta = skillFrontmatter(stagedDir);

    if (stagedMeta.name !== vendorMeta.name) {
      red.push({
        kind: 'name',
        detail: `[${name}] SKILL.md frontmatter name 变更: ${JSON.stringify(vendorMeta.name)} → ${JSON.stringify(stagedMeta.name)}`,
      });
    }

    if (stagedMeta.version === null) {
      red.push({
        kind: 'metadata.version',
        detail: `[${name}] SKILL.md frontmatter metadata.version 缺失或不可解析（版本 bump 无法执行）`,
      });
    }

    if (stagedMeta.description !== vendorMeta.description) {
      yellow.push({
        kind: 'description',
        detail: `[${name}] SKILL.md frontmatter description 变更（技能展示/路由描述变化，知悉）`,
      });
    }

    // ── 四个架构级目录的一级条目增删 ──
    for (const dirName of STRUCTURAL_DIRS) {
      const before = firstLevelEntries(join(vendorDir, dirName));
      const after = firstLevelEntries(join(stagedDir, dirName));
      const added = after.filter((entry) => !before.includes(entry));
      const removed = before.filter((entry) => !after.includes(entry));
      if (added.length === 0 && removed.length === 0) continue;
      const parts = [];
      if (added.length > 0) parts.push(`新增 ${added.join(', ')}`);
      if (removed.length > 0) parts.push(`删除 ${removed.join(', ')}`);
      red.push({ kind: 'top-level-entries', detail: `[${name}] ${dirName}/ 一级条目增删: ${parts.join('；')}` });
    }

    // ── requirements.txt 依赖行增删 ──
    const vendorRequirements = requirementLines(vendorDir);
    const stagedRequirements = requirementLines(stagedDir);
    if (vendorRequirements !== null && stagedRequirements !== null
      && !arraysEqual(vendorRequirements, stagedRequirements)) {
      const diff = symmetricDifference(vendorRequirements, stagedRequirements);
      yellow.push({
        kind: 'requirements',
        detail: `[${name}] requirements.txt 依赖行增删: ${diff.join(', ')}（提醒重跑 ppt_master_setup_deps）`,
      });
    }

    // ── 🟢 常规内容变更（spec §4.2 末行「其余文件内容常规更新」）──
    //
    // 红类的 `top-level-entries` 只覆盖**四个架构级目录的一级条目增删**；因此
    // 下列差异都落常规路径，而非被判成结构变化——
    //  - SKILL.md 的**正文**变更（frontmatter 三键已单独分类，正文属常规更新）；
    //  - 四个目录下**更深层**文件的增删与内容变更（一级条目集不变即非结构信号）；
    //  - skill 根级其余文件（LICENSE / SPONSORS* / requirements.txt 内容本身 /
    //    `.env.example` 等 dotfile）的增删与内容变更——分类空白在此消除。
    //
    // 判据按**一级条目集是否变化**表述（与红类同源），而不是「路径是否在某目录下」：
    // 后者会把 `scripts/svg_quality/cli.py` 的内容变更错判为无常规更新。
    const structuralRelPaths = new Set(STRUCTURAL_DIRS);
    const isStructuralTopLevelEntry = (rel) => {
      const segments = rel.split('/');
      if (segments.length !== 2) return false; // 深层路径：不是一级条目
      return structuralRelPaths.has(segments[0]) && segments[1] !== '';
    };
    const isRegularChange = (rel) => !isStructuralTopLevelEntry(rel);
    const regularChanged = contentChanged.filter(isRegularChange);
    const regularOnlyStaged = onlyStaged.filter(isRegularChange);
    const regularOnlyVendor = onlyVendor.filter(isRegularChange);
    if (regularChanged.length > 0 || regularOnlyStaged.length > 0 || regularOnlyVendor.length > 0) {
      green = true;
    }
  }

  // ── aux-dir（🟡）：上游 skills/ 一级辅助目录增删 vs 上次同步记录 ──
  const auxFile = auxStateFile(vendorSkillsRoot, auxStatePath);
  const currentAuxDirs = auxDirNames(upstreamRoot);
  const previousAuxDirs = readAuxDirs(auxFile);
  const previousSet = new Set(previousAuxDirs ?? []);
  const currentSet = new Set(currentAuxDirs);

  const addedAux = currentAuxDirs.filter((name) => !previousSet.has(name));
  const removedAux = (previousAuxDirs ?? []).filter((name) => !currentSet.has(name));
  for (const name of addedAux) {
    yellow.push({ kind: 'aux-dir', detail: `上游 skills/ 一级辅助目录新增: ${name}（staging 丢弃对象，仅知悉）` });
  }
  for (const name of removedAux) {
    yellow.push({ kind: 'aux-dir', detail: `上游 skills/ 一级辅助目录删除: ${name}（staging 丢弃对象，仅知悉）` });
  }
  // Step F #10：dry-run 时 aux 状态不落盘——🟡 一次性知悉信号不得被计划跑消费
  //（dry-run 后正式跑须能再次报出同一信号）。
  if ((addedAux.length > 0 || removedAux.length > 0 || previousAuxDirs === null) && opts?.dryRun !== true) {
    writeAuxDirs(auxFile, currentAuxDirs);
  }

  return { red, yellow, green, vendorDiff };
}

// ── checkMarketplaceVersion：上游仓库根 marketplace 一致性 ───────

/**
 * 校验上游 skill 版本与上游仓库根 `.claude-plugin/marketplace.json` 的一致性
 * （spec §4.1 步骤 3 / §4.3）。
 *
 * **路径钉子**：数据源是**上游仓库根**的 `.claude-plugin/marketplace.json`，与
 * `<upstreamRoot>/skills/.claude-plugin/plugin.json` 是**两个不同路径**——后者是
 * staging 丢弃对象，其 `version` 不得被当作 marketplace 数据源。
 *
 * **豁免语义（警告级，不判失败）**：文件缺失、不可解析、或无可用的 `version`
 * 字段 → `{ ok: true, note: '…豁免…' }`。上游未来删除/移动该文件时记警告并豁免
 * 该子校验（同 §6 链接越界豁免逻辑）。豁免 note 由 T13 编排并入 🟡 汇总输出。
 *
 * 调用点在 T13 编排的 staging 步；本函数是纯函数（只读，无副作用）。
 *
 * @param {string} upstreamRoot 上游解压树根。
 * @param {string} skillVersion staging `SKILL.md` frontmatter `metadata.version`
 *   （不一致时以 SKILL.md 为准并提示）。
 * @returns {{ ok: boolean, note: string }} 不一致 → `ok:false`。
 */
export function checkMarketplaceVersion(upstreamRoot, skillVersion) {
  const file = join(upstreamRoot, '.claude-plugin', 'marketplace.json');
  if (!existsSync(file)) {
    return {
      ok: true,
      note: `豁免: 上游未提供 .claude-plugin/marketplace.json（${file}），版本一致性校验跳过`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {
      ok: true,
      note: `豁免: 上游 .claude-plugin/marketplace.json 不可解析（${file}），版本一致性校验跳过`,
    };
  }

  // 版本取值层级：metadata.version 优先（真实上游 v6.7.0 起 marketplace.json 的
  // version 位于 metadata 层级），顶层 version 向后兼容（旧 fixture 形态）。
  // 只读顶层会把真实树恒判「无 version 字段（豁免）」，该子校验从未生效。
  const marketplaceVersion =
    parsed !== null && typeof parsed === 'object'
      ? parsed?.metadata?.version ?? parsed?.version
      : undefined;
  if (typeof marketplaceVersion !== 'string' || marketplaceVersion.trim() === '') {
    return {
      ok: true,
      note: `豁免: 上游 .claude-plugin/marketplace.json 无 version 字段（${file}），版本一致性校验跳过`,
    };
  }

  const expected = String(skillVersion ?? '');
  if (marketplaceVersion !== expected) {
    return {
      ok: false,
      note: `marketplace.json version（${marketplaceVersion}）与 SKILL.md metadata.version（${expected}）不一致——以 SKILL.md 为准`,
    };
  }

  return { ok: true, note: `marketplace.json version（${marketplaceVersion}）与 SKILL.md 一致` };
}

// ── parseRSuffix / decideVersion：版本判定规则（spec §4.3）───────

/** 合法的 `-rN` 后缀形态（N 为十进制整数，含 0）——不匹配即不剥离。 */
const R_SUFFIX_PATTERN = /-r(\d+)$/;

/**
 * 解析版本串的 `-rN` 内部修订后缀（spec §4.3「`-rN` 后缀仅供内部追踪」）。
 *
 * **fail-soft 钉子**：只有 `^-r\d+$` 形态的后缀才被剥离；`6.7.0-r`、`6.7.0-rx`、
 * `6.7.0-r1x`、`6.7.0-R1` 等非法形态**不剥离**——整个串原样作 `base`、`n = 0`，
 * **不 throw**（本助手是解析器，不是校验器）。版本格式的合法性校验属 T13 编排
 * 入口（那里的非法版本应 fail-loud 退出），纯函数层的容错保证 `decideVersion`
 * 对任何输入都自洽。
 *
 * 无后缀视为 `r0`（spec §4.3：无后缀视为 r0，新后缀 = 当前 N+1）。
 *
 * @param {string} version 版本串（如 `6.7.0`、`6.7.0-r3`）。
 * @returns {{ base: string, n: number }} `base` = 剥后缀后的上游版本；`n` = 修订号。
 */
export function parseRSuffix(version) {
  const value = typeof version === 'string' ? version : String(version ?? '');
  const match = R_SUFFIX_PATTERN.exec(value);
  if (match === null) return { base: value, n: 0 };
  return { base: value.slice(0, -match[0].length), n: Number(match[1]) };
}

/**
 * 版本 bump 判定（spec §4.3，优先级**互斥判定**、自上而下**命中即止**）。
 *
 * | rule | 触发条件 | 结论 |
 * |---|---|---|
 * | ① | 上游版本变化（`upstreamVersion` ≠ `parseRSuffix(current).base`） | `version = upstreamVersion`、`-r` 归零 |
 * | ④ | 同①但 `vendorDiff === false`（新 tag 仅改未 vendor 的 docs） | **与①同版本结论**，仅 `rule` 标 `④`（镜像语义补充分支） |
 * | ② | 上游版本未变 + `vendorDiff` | base 不变、`n + 1` |
 * | ③ | 上游版本未变 + `vendorDiff === false` + `wrapperPending` | base 不变、`n + 1`（纯包装层变更） |
 * | no-change | 上游版本未变 + 两者皆 false（docs-only） | `version = current`、`notes = []`——**不落③** |
 *
 * **① 的吸收语义**：上游版本变化时其余两条不再另行追加 `-r`——`vendorDiff` 只
 * 决定 `rule` 标 ① 还是 ④（版本结论恒等），`wrapperPending` 完全不再参与判定。
 * 「包装层此前有 N 次修订已被归零」提示仅在 `current` 带 `-rN`（`n > 0`）时出现。
 *
 * **「上游版本变化」的判据是字符串不等**（不做 semver 大小比较）：`--ref` 回滚到
 * 旧版本同属版本变化，同样镜像上游版本并归零。
 *
 * **`upstreamVersion === null`**（理论上由 §4.2 行 3 🔴——`metadata.version` 缺失
 * 或不可解析——在编排层前置拦截）在本纯函数内自洽处置为 `no-change`：没有可比
 * 的上游版本，就不臆断版本变化、也不凭 `vendorDiff`/`wrapperPending` 误 bump。
 *
 * 本函数纯只读、无副作用（不修改入参、不读写文件、不打日志）；notes 每次新建。
 *
 * @param {{ current: string, upstreamVersion: string|null,
 *   vendorDiff?: boolean, wrapperPending?: boolean }} input
 *   `current` = 当前已发布版本；`upstreamVersion` = staging `SKILL.md` frontmatter
 *   `metadata.version`（缺失 → null）；`vendorDiff` = T11 `classifyChanges` 产物，
 *   命名一致零转换；`wrapperPending` = 存在未推送的包装层提交（T13 判定）。
 * @returns {{ version: string, rule: '①'|'④'|'②'|'③'|'no-change', notes: string[] }}
 */
export function decideVersion(input) {
  const value = input ?? {};
  const current = typeof value.current === 'string' ? value.current : String(value.current ?? '');
  const upstreamVersion = typeof value.upstreamVersion === 'string' ? value.upstreamVersion : null;
  const vendorDiff = value.vendorDiff === true;
  const wrapperPending = value.wrapperPending === true;

  const { base, n } = parseRSuffix(current);

  // 规则①/④：上游版本变化（字符串不等——回滚同样是版本变化）。
  if (upstreamVersion !== null && upstreamVersion !== base) {
    const notes = [];
    if (n > 0) notes.push(`包装层此前有 ${n} 次修订已被归零`);
    return { version: upstreamVersion, rule: vendorDiff ? '①' : '④', notes };
  }

  // upstreamVersion === null：无可比上游版本 → 自洽 no-change（不 throw）。
  if (upstreamVersion === null) {
    return { version: current, rule: 'no-change', notes: [] };
  }

  // 规则②/③：上游版本未变，同一 `-r` 递增覆盖两类变更（②③同命中按②）。
  if (vendorDiff || wrapperPending) {
    return { version: `${base}-r${n + 1}`, rule: vendorDiff ? '②' : '③', notes: [] };
  }

  // docs-only（上游版本未变、无 diff、无包装层变更）→ 不落③、保持镜像版本。
  return { version: current, rule: 'no-change', notes: [] };
}

// ─── main：Task 13 全流程编排（spec §4.1 步骤 1-8 + 退出码闭环）───

/** PAT 环境变量名（spec §5 解析顺序第一级）。 */
const PAT_ENV = 'DSH_PPT_GITLAB_PAT';

/**
 * guard 输出中判「解释器级失败」（→ 7）的 stderr 特征：python 语法/缩进错误类。
 * 其余非零退出（guard 完整运行后的业务判定，实测 78 一类）→ 3。
 */
const INTERPRETER_ERROR_PATTERN = /SyntaxError|IndentationError|TabError/;

/**
 * 子进程 spawn 级失败码族（ENOENT/EACCES/EPERM/ENOTDIR/EISDIR）——与 lib/tools.js
 * 的 SPAWN_FAILURE_CODES 同源同族：这些码意味着子进程**从未启动**（工具链缺失，
 * 退出码 7），而非命令运行业务失败。git 工具链预检与 tar 解压的失败分类共用
 * （R2 Fix：tar spawn ENOENT 同属工具链缺失族）。
 */
const GIT_SPAWN_FAILURE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR']);

/**
 * 编排日志助手工厂：stdout=流程信息、stderr=失败报告（退出码路径的说明走 stderr）。
 *
 * 经 deps 注入（`deps.log` / `deps.logError`，缺省 console）：测试注入收集器捕获
 * 输出断言（already up to date / 指引文案 / 🟡 汇总等）——不让编排直写进程
 * stdout（隔离式 node --test 子进程内直写会与 runner 的报告流串流）。
 */
function makeLoggers(deps) {
  const info = (...parts) => deps.log(parts.join(' '));
  const fail = (...parts) => deps.logError(parts.join(' '));
  return { info, fail };
}

/** 字节数 → 人类可读 MB（预检报错用）。 */
function mb(bytes) {
  return `${Math.round(Number(bytes) / (1024 * 1024))}MB`;
}

/**
 * spawn 一个命令并捕获 stdout/stderr。
 *
 * 非零退出码**原样返回**（调用方按语义分支）；spawn 级失败（ENOENT 等）reject——
 * 编排按「解释器级失败」类映射（runPython → 退出码 7）。
 */
function spawnCapture(command, args, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: opts.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', (chunk) => outChunks.push(chunk));
    child.stderr.on('data', (chunk) => errChunks.push(chunk));
    if (opts.stdin !== undefined && opts.stdin !== null) {
      // EPIPE 容忍：git credential fill 读完即退出，stdin 写入竞态不应误报失败。
      child.stdin.on('error', () => {});
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      resolvePromise({
        code: code ?? -1,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });
  });
}

/** 缺省 runGit：真实 git（cwd 由调用方经 opts 注入）。 */
async function defaultRunGit(args, opts = {}) {
  return spawnCapture('git', args, opts);
}

/** 缺省 runPython：真实 python3（spawn ENOENT → reject → 编排映射退出码 7）。 */
async function defaultRunPython(args, opts = {}) {
  return spawnCapture('python3', args, opts);
}

/** 按 URL scheme 选 http/https get。 */
function getOf(url) {
  return url.startsWith('http://') ? httpGet : httpsGet;
}

/** 下载 URL 全量字节（跟随重定向，≤5 跳）。 */
function downloadBytes(url, redirectsLeft = 5) {
  return new Promise((resolvePromise, rejectPromise) => {
    getOf(url)(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          rejectPromise(new Error(`重定向次数超限: ${url}`));
          return;
        }
        const next = new URL(response.headers.location, url).toString();
        downloadBytes(next, redirectsLeft - 1).then(resolvePromise, rejectPromise);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        rejectPromise(new Error(`HTTP ${response.statusCode}: ${url}`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolvePromise(Buffer.concat(chunks)));
      response.on('error', rejectPromise);
    }).on('error', rejectPromise);
  });
}

/**
 * 缺省 fetchTarball：真实下载 codeload tarball 到 dest。
 *
 * 契约（与测试 stub 一致）：只下载不解压，返回 `{ bytesPath, contentLength }`——
 * 解压由编排执行，二次磁盘预检因此在解压前发生。contentLength 取实际落盘字节
 * （不依赖 Content-Length 头的存在）。
 */
async function defaultFetchTarball(url, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const bytes = await downloadBytes(url);
  writeFileSync(dest, bytes);
  return { bytesPath: dest, contentLength: bytes.length };
}

/**
 * 解压 tarball 到目标目录（`--strip-components=1`：剥掉 tarball 的顶层目录，
 * 落地为仓库根形态——`skills/`、`.claude-plugin/` 在解压树根）。
 */
async function extractTarball(bytesPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const result = await spawnCapture('tar', ['-xzf', bytesPath, '-C', destDir, '--strip-components=1']);
  if (result.code !== 0) {
    throw new Error(`tar 解压失败（exit ${result.code}）: ${bytesPath}\n${result.stderr.trim()}`);
  }
}

/** 缺省 freeSpace：root 所在文件系统的可用字节数（statfs bavail×bsize）。 */
function defaultFreeSpace(root) {
  return async () => {
    const stats = statfsSync(root);
    return Number(stats.bavail) * Number(stats.bsize);
  };
}

/** 仓库根 package.json 的 version（缺失/不可解析/非字符串 → null）。 */
function readPackageVersion(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) return null;
    return typeof pkg.version === 'string' && pkg.version.trim() !== '' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** 更新仓库根 package.json 的 version（保留其余字段；文件缺失则创建最小骨架）。 */
function writePackageVersion(root, version) {
  const file = join(root, 'package.json');
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    pkg = {};
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) pkg = {};
  pkg.version = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

// ─── 版本常量联动（issue #3）──────────────────────────────────────

/** lib/client.js 相对仓库根路径（联动改写对象，单一字面量来源）。 */
const CLIENT_REL = join('lib', 'client.js');

/** 正则元字符转义（写后自检用——版本串含 `.` 等通配符字符）。 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * lib/client.js 版本常量联动改写（issue #3）。
 *
 * 背景：`writePackageVersion` 只 bump `package.json`，而 `tests/client-half.test.mjs`
 * 断言「`PLUGIN_VERSION` ≡ `package.json.version`」与「`UPSTREAM_VERSION` ≡ vendor
 * `SKILL.md` `metadata.version`」——不联动则同步后必然变红，此前每次同步需手工补
 * （6.7.1 同步时即手工补；漏补要等测试才暴露）。
 *
 * 四态语义（幂等、fail-loud）：
 *  - `'missing'`：`lib/client.js` 不存在——调用方记 🟡 提示、不判失败（仓库形态
 *    异常不该卡死同步，但必须可见）；
 *  - `'problem'`：目标值非法（空/缺失/含引号或反斜杠）、或任一常量的
 *    `const NAME = '…';` 匹配数 ≠ 1（形态漂移）——**文件不写**（部分改写比不
 *    改更糟）；唯一例外是**写回自检失败**分支：此时文件已落盘但未通过验证，
 *    调用方报告须提示可用 `git checkout -- lib/client.js` 还原（Gate 3 P3-1）；
 *  - `'unchanged'`：两常量均已等于目标——不写（幂等，规则③重跑等场景）；
 *  - `'rewritten'`：有差异 → 整文件一次写回 + 重读自检，`changes` 列出
 *    `{ constant, from, to }` 明细（供同步报告列出被改写的文件与值）。
 *
 * @param {string} root 仓库根。
 * @param {{ pluginVersion?: string, upstreamVersion?: string }} versions 目标值
 *   （pluginVersion = decideVersion 产物；upstreamVersion = staging 主 skill 的
 *   `metadata.version`——自动路径前置防线已断言非 null）。
 * @returns {{ status: 'rewritten'|'unchanged'|'missing'|'problem',
 *   changes?: Array<{ constant: string, from: string, to: string }>,
 *   problems?: string[] }}
 */
export function applyVersionLinkage(root, versions) {
  const file = join(root, CLIENT_REL);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { status: 'missing' };
  }

  const targets = [
    { constant: 'PLUGIN_VERSION', to: versions?.pluginVersion },
    { constant: 'UPSTREAM_VERSION', to: versions?.upstreamVersion },
  ];
  const problems = [];
  const spans = [];
  for (const { constant, to } of targets) {
    if (typeof to !== 'string' || to.trim() === '') {
      problems.push(`${constant} 目标值缺失或为空（decideVersion / staging metadata.version 产物异常）`);
      continue;
    }
    // 目标值含引号/反斜杠 → 拒绝（注入面：值被原样写进字符串字面量；现实来源
    // ——semver 规则 + SKILL.md metadata.version——不可达，纯防御，Gate 3 P3-3）。
    if (/['\\]/.test(to)) {
      problems.push(`${constant} 目标值 ${JSON.stringify(to)} 含引号或反斜杠——拒绝注入字符串字面量`);
      continue;
    }
    const pattern = new RegExp(
      `(^[ \\t]*const[ \\t]+${escapeRegExp(constant)}[ \\t]*=[ \\t]*)'([^']*)'([ \\t]*;)`,
      'gm',
    );
    const matches = [...text.matchAll(pattern)];
    if (matches.length !== 1) {
      problems.push(
        `lib/client.js 中 \`const ${constant} = '…';\` 匹配 ${matches.length} 处（期望恰 1 处）——常量形态漂移，拒绝改写`,
      );
      continue;
    }
    spans.push({ constant, to, match: matches[0], from: matches[0][2] });
  }
  if (problems.length > 0) return { status: 'problem', problems };

  const changes = spans
    .filter(({ from, to }) => from !== to)
    .map(({ constant, from, to }) => ({ constant, from, to }));
  if (changes.length === 0) return { status: 'unchanged' };

  // 自右向左替换（span 按出现序互不重叠；逆序改写避免前段偏移影响后段下标）。
  let updated = text;
  for (const { match, to } of [...spans].sort((left, right) => right.match.index - left.match.index)) {
    updated =
      updated.slice(0, match.index) + `${match[1]}'${to}'${match[3]}` + updated.slice(match.index + match[0].length);
  }
  writeFileSync(file, updated, 'utf8');

  // 写后自检：重读并确认两常量逐字等于目标（防写通道损坏静默假绿）。
  let verifyText;
  try {
    verifyText = readFileSync(file, 'utf8');
  } catch {
    verifyText = '';
  }
  for (const { constant, to } of targets) {
    const verifyPattern = new RegExp(
      `^[ \\t]*const[ \\t]+${constant}[ \\t]*=[ \\t]*'${escapeRegExp(to)}'[ \\t]*;`,
      'm',
    );
    if (!verifyPattern.test(verifyText)) {
      return {
        status: 'problem',
        changes,
        problems: [`写回自检失败：${constant} 写后 ≠ ${to}（写通道异常）`],
      };
    }
  }
  return { status: 'rewritten', changes };
}

/**
 * staging 某 skill 的 frontmatter `metadata.version`（decideVersion 的
 * upstreamVersion 数据源）。
 *
 * 接缝归一（钉子 #4）：缺失/空值/不可解析 → **null**（绝不让 `''` 混入
 * decideVersion——其内部对 null 自洽处置为 no-change，空串会被当作合法版本参与
 * 字符串比较造成假判定）。
 */
function readStagedVersion(stagingRoot, skillName) {
  if (typeof skillName !== 'string' || skillName === '') return null;
  try {
    const raw = readFileSync(join(stagingRoot, skillName, SKILL_FILE_NAME), 'utf8');
    const parsed = parseFrontmatter(raw.replace(/^\uFEFF/, ''));
    const version = parsed?.data?.metadata?.version;
    if (typeof version !== 'string') return null;
    const trimmed = version.trim().replace(/^["']|["']$/g, '');
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * 包装层文件判据：路径不在 vendored `skills/` 面内即包装层（index.js / lib/ /
 * scripts/ / package.json / README.md / tests/ …）。
 *
 * 用于两个独立语义（勿混）：
 *  - 幂等禁用①（工作区相对 HEAD 的包装层 diff——未提交变更也算）；
 *  - wrapperPending（未推送提交中触及包装层文件）。
 */
const isWrapperPath = (path) => {
  const trimmed = path.trim();
  return trimmed !== '' && trimmed !== 'skills' && !trimmed.startsWith('skills/');
};

/**
 * 从 `git credential fill` 的 stdout 解析 `password=<PAT>` 行。
 */
function parseCredentialPassword(stdout) {
  for (const line of String(stdout ?? '').split('\n')) {
    const match = /^password=(.*)$/.exec(line.trim());
    if (match !== null && match[1] !== '') return match[1];
  }
  return null;
}

/**
 * 构造一次性推送 URL：`https://host/path` → `https://oauth2:<PAT>@host/path`。
 * 非 http(s) 形态（ssh 等）→ null（env PAT 模式无法构造）。
 */
function buildOneShotUrl(originUrl, pat) {
  const match = /^(https?:\/\/)(.+)$/.exec(originUrl);
  if (match === null) return null;
  return `${match[1]}oauth2:${pat}@${match[2]}`;
}

/**
 * git 输出脱敏（PAT 安全约束）：一次性 URL 可能回显于 git 的 stdout/stderr——
 * 以 PAT 全量切分替换为 ***，PAT 绝不出现在日志。pat 为 null（credential 路径）
 * 时原样返回。主 push 失败回显与补推预判/push 失败回显共用。
 */
function sanitizedGitOutput(pat, result) {
  const raw = `${result.stdout}\n${result.stderr}`;
  return pat !== null ? raw.split(pat).join('***') : raw;
}

/**
 * 发布推送 refspec 序列（Step F Fix #2 裁决扩展）：main 先行 + tag——只推 tag
 * 会让远端出现指向未上 main 的 commit 的 tag（Step 5 观察项④）。主 push 与
 * 幂等短路前的补推共用同一序列，保证两处发布语义一致。
 *
 * @param {string} tagName 形如 `v6.8.0` 的 tag 名。
 * @returns {string[]} refspec 列表（`['main', 'refs/tags/<tag>']`）。
 */
const releasePushRefspecs = (tagName) => ['main', `refs/tags/${tagName}`];

/**
 * 同步主编排（spec §4.1 步骤 1-8 + 退出码单表）。
 *
 * 序列：usage 检查（→1）→ 启动磁盘预检（→5）→ git 工具链预检（spawn 级失败
 * →7）→ 解析来源[ls-remote 固定 `--tags`；`--confirm-structural` 且未显式传
 * `--ref` 时固定 last-sync 记录 ref]→ 拉取[缓存键/两段预检；拉取成功即写
 * last-sync ref/sha]→ staging[marketplace 校验]→ 幂等判定[短路禁用两触发：工作区
 * 包装层 diff / 未推送包装层提交]→ guard[逐 skill；解释器级=7、业务=3]→ 结构检测
 * [🔴 且未确认 →2]→ 自动路径[verify 前置（显式传 upstream）→ 替换 → bump → 🟡
 * 汇总 → commit → tag 先行检测（→6）→ sync-report → push（PAT env→credential
 * fill→指引；→6）→ 清理 staging]。每个退出码路径单一 return。
 *
 * @param {object} options parseArgs 产物或等价显式对象（测试可另传 `root` 覆盖
 *   仓库根，缺省 = 本模块所属仓库根）。
 * @param {object} deps_ 可注入依赖 `{ fetchTarball, extractTarball, runGit,
 *   runPython, now, log, logError, runVerify, freeSpace }`（全部缺省为真实实现；
 *   extractTarball 缺省即本模块 tar 解压（spawn 级失败 reject）；runVerify 缺省经
 *   动态 import 注入 verify-plugin——编排不静态 import 它；log/logError 缺省
 *   console——测试注入收集器捕获输出断言）。
 * @returns {Promise<number>} 退出码 0/1/2/3/4/5/6/7。
 */
export async function main(options, deps_) {
  const opts = options ?? {};
  const root = typeof opts.root === 'string' && opts.root !== '' ? opts.root : REPO_ROOT;

  const upstreamDir = join(root, '.upstream');
  const stagingRoot = join(root, '.skills-staging');
  const vendorSkillsRoot = join(root, 'skills');
  const reportPath = join(root, 'sync-report.txt');

  const deps = {
    fetchTarball: deps_?.fetchTarball ?? defaultFetchTarball,
    extractTarball: deps_?.extractTarball ?? extractTarball,
    runGit: deps_?.runGit ?? defaultRunGit,
    runPython: deps_?.runPython ?? defaultRunPython,
    now: deps_?.now ?? (() => new Date()),
    log: deps_?.log ?? ((text) => console.log(text)),
    logError: deps_?.logError ?? ((text) => console.error(text)),
    runVerify:
      deps_?.runVerify ??
      (async (verifyRoot, verifyOpts) => {
        const module = await import('./verify-plugin.mjs');
        return module.runVerify(verifyRoot, verifyOpts);
      }),
    freeSpace: deps_?.freeSpace ?? defaultFreeSpace(root),
  };
  const { info: logInfo, fail: logFail } = makeLoggers(deps);
  /** runGit 绑定仓库根 cwd（编排内全部 git 操作都在仓库根执行）。 */
  const git = (args, extra = {}) => deps.runGit(args, { cwd: root, ...extra });
  const writeReport = (text) => writeFileSync(reportPath, `${text.trim()}\n`, 'utf8');
  const cleanupStaging = () => rmSync(stagingRoot, { recursive: true, force: true });

  // ── usage 错误 → 退出码 1（含 --skip-guard 未与 --no-push/--dry-run 联用）──
  if (opts.usageError === true) {
    logFail(USAGE_TEXT, '\n用法错误：参数组合非法（如 --skip-guard 须至少与 --no-push 或 --dry-run 之一联用）。退出码 1。');
    return 1;
  }

  // ── 启动磁盘预检（保守固定阈值 260MB；不足 → 退出码 5，下载前拦截）──
  const startupFree = await deps.freeSpace();
  if (startupFree < diskBudget()) {
    logFail(`磁盘空间不足：启动预检需 ≥${mb(diskBudget())}，实际可用 ${mb(startupFree)}（环境失败，退出码 5）。`);
    return 5;
  }

  // ── git 工具链预检（UltraReview Fix #4）：spawn 级失败 → 退出码 7 ──
  //
  // 此前 git 二进制缺失（spawn ENOENT/EACCES）在首个真实 git 调用（ls-remote）
  // 以未分类异常冒泡 → CLI 入口「未预期的失败（退出码 5）」+ 原始堆栈。工具链
  // 缺失属解释器级失败族（与 python3 ENOENT → 7 同族，判定码族与 lib/tools.js
  // SPAWN_FAILURE_CODES 同源）。git 在场但 `--version` 非零退出**不**视为工具链
  // 缺失——继续原流程（由后续真实调用的业务分支处置）。
  try {
    await git(['--version']);
  } catch (error) {
    if (GIT_SPAWN_FAILURE_CODES.has(error?.code)) {
      logFail('git 不可用（工具链缺失，退出码 7）。');
      return 7;
    }
    throw error;
  }

  // ── 步骤 1：解析来源 ────────────────────────────────────────────
  const repo = nonEmpty(opts.repo) ?? DEFAULT_REPO;
  const previousSync = readLastSync(root); // 拉取前快照（幂等比对/回退 ref/回退锚点）
  let normalizedRef = null;

  if (nonEmpty(opts.ref) !== null) {
    try {
      normalizedRef = normalizeRef(opts.ref);
    } catch (error) {
      if (error?.usageError === true) {
        logFail(error.message, '\n退出码 1（用法错误）。');
        return 1;
      }
      throw error;
    }
  } else if (opts.confirmStructural === true && previousSync !== null) {
    // --confirm-structural 且未显式传 --ref：固定上次检出的 ref（spec §4.1 步骤 7
    // ——人工介入期间上游发新 tag 时，重跑对象仍与人工评估对象一致）。
    try {
      normalizedRef = normalizeRef(previousSync.ref);
    } catch (error) {
      if (error?.usageError === true) {
        logFail(`.upstream/last-sync.json 记录的 ref 不可用（${previousSync.ref}）：${error.message}`);
        return 1;
      }
      throw error;
    }
    logInfo(`--confirm-structural 重跑：固定上次检出 ref ${previousSync.ref}（.upstream/last-sync.json）。`);
  }

  // ls-remote 固定 `--tags` 形态（parseLsRemote 对非 --tags 输出静默返回 []——
  // 命令形态错了会导致「无可用 release tag」误报，此处为唯一调用形态）。
  const lsRemote = await git(['ls-remote', '--tags', repo]);
  if (lsRemote.code !== 0) {
    logFail(
      `git ls-remote --tags 失败（exit ${lsRemote.code}，网络/来源失败，退出码 5）:\n${lsRemote.stderr.trim()}`,
    );
    return 5;
  }
  const tagEntries = parseLsRemote(lsRemote.stdout);

  let refSha = null;
  if (normalizedRef === null) {
    const latest = pickLatestTag(tagEntries);
    if (latest === null) {
      logFail(
        `上游无可用 release tag（${repo} 无 ^v?\\d+\\.\\d+\\.\\d+$ 形态 tag）——`,
        `请用 --ref 显式指定 tag（如 v6.7.0）、branch 或 40 位 commit sha。退出码 5。`,
      );
      return 5;
    }
    normalizedRef = `refs/tags/${latest.name}`;
    refSha = latest.sha;
    logInfo(`解析来源：最新 release tag ${latest.name}（${latest.sha}）。`);
  } else if (FULL_SHA_PATTERN.test(normalizedRef)) {
    refSha = normalizedRef; // 显式 40 位 sha：ref 即 commit
  } else if (normalizedRef.startsWith('refs/tags/')) {
    const wanted = normalizedRef.slice('refs/tags/'.length);
    const found = tagEntries.find((entry) => entry.tagName === wanted);
    if (found !== undefined) refSha = commitShaOf(found);
    else if (previousSync !== null && previousSync.ref === normalizedRef) refSha = previousSync.sha; // 固定 ref 重跑：tag 已不在远端
  } else if (normalizedRef.startsWith('refs/heads/')) {
    // branch ref：增补 `git ls-remote <repo> refs/heads/<name>` 解析 head sha
    // （UltraReview Fix #3——此前 refSha 恒 null，cacheKey 恒 `<branch>@no-sha`，
    // 上游 branch 前进时缓存**永不失效**）。首行须与请求 ref 精确对应；解析不到
    // （branch 已删/输出空）→ 维持 'no-sha' 现状并 log 警告（不阻断流程）。
    const branchHead = await git(['ls-remote', repo, normalizedRef]);
    const firstLine = (branchHead.stdout.split('\n')[0] ?? '').trim();
    const [maybeSha, maybeRef] = firstLine.split(/\s+/);
    if (branchHead.code === 0 && maybeRef === normalizedRef && FULL_SHA_PATTERN.test(maybeSha)) {
      refSha = maybeSha;
    } else {
      logInfo('⚠ branch head sha 未能解析，缓存将以无 sha 键留存——branch 前进时无法自动失效，必要时用 --refresh 强制重拉。');
    }
  }

  // ── 步骤 2：拉取（缓存键 + 两段预检 + 解压）─────────────────────
  const key = cacheKey(normalizedRef, refSha ?? 'no-sha');
  const cacheDir = join(upstreamDir, key);
  const tarballPath = join(upstreamDir, `${key}.tar.gz`);

  if (existsSync(cacheDir) && opts.refresh !== true) {
    logInfo(`复用 .upstream/ 缓存: ${key}`);
  } else {
    let codeloadUrl;
    try {
      codeloadUrl = buildCodeloadUrl(repo, normalizedRef);
    } catch (error) {
      if (error?.usageError === true) {
        logFail(error.message, '\n退出码 1（用法错误）。');
        return 1;
      }
      throw error;
    }
    let download;
    try {
      mkdirSync(upstreamDir, { recursive: true });
      download = await deps.fetchTarball(codeloadUrl, tarballPath);
    } catch (error) {
      logFail(`下载失败（网络/拉取失败，退出码 5）: ${error.message}`);
      return 5;
    }
    // 二次预检（解压前）：tarball 实际字节 + 解压全树 + staging 副本三项之和。
    const freeNow = await deps.freeSpace();
    if (freeNow < diskBudget(download.contentLength)) {
      rmSync(tarballPath, { force: true });
      logFail(
        `磁盘空间不足：二次预检需 ≥${mb(diskBudget(download.contentLength))}`
          + `（tarball ${mb(download.contentLength)} + 解压全树 114MB + staging 副本 78MB），`
          + `实际可用 ${mb(freeNow)}——不解压，退出码 5。`,
      );
      return 5;
    }
    try {
      await deps.extractTarball(download.bytesPath, cacheDir);
    } catch (error) {
      rmSync(tarballPath, { force: true });
      rmSync(cacheDir, { recursive: true, force: true });
      // tar spawn 级失败（ENOENT 码族）= 工具链缺失（与 git/python3 同族，→7），
      // 不回显裸 spawn 错误；其余（tar 在场但非零退出）仍为来源失败（→5）。
      if (GIT_SPAWN_FAILURE_CODES.has(error?.code)) {
        logFail('tar 不可用（工具链缺失，退出码 7）。');
        return 7;
      }
      logFail(`${error.message}（来源失败，退出码 5）。`);
      return 5;
    }
    rmSync(tarballPath, { force: true }); // 缓存以解压树形态留存；tarball 及时回收
  }

  // 拉取成功（下载+解压完成）即写 ref/sha——「git checkout 前」落盘：后续任何
  // 失败（guard/verify/结构退出码 2）都不丢锚点，--confirm-structural 重跑固定
  // ref 有值可取。version 保持当前值（bump 后于 wrapper commit 完成点更新）、
  // head 保持既有包装层基线（仅 wrapper commit 后更新——exit 2 无 wrapper commit
  // 不写，见自动路径）。
  // --dry-run（Step F #10）：计划跑不落盘——无条件写会污染幂等比对基准
  //（dry-run 后正式跑 sameRefSha 已被写成 true）。锚点语义不受影响：dry-run
  // 不产生任何同步效果，previousSync 留待正式跑写入。
  const currentVersion = readPackageVersion(root) ?? previousSync?.version ?? '0.0.0';
  if (opts.dryRun !== true) {
    writeLastSync(
      { ref: normalizedRef, sha: refSha ?? '', version: currentVersion, head: previousSync?.head ?? undefined },
      root,
    );
  }

  // ── 步骤 3：staging + marketplace 一致性校验 ─────────────────────
  let stagedSkills;
  try {
    stagedSkills = stageSkills(cacheDir, stagingRoot);
  } catch (error) {
    logFail(`staging 失败（来源形态异常，退出码 5）: ${error.message}`);
    return 5;
  }
  // 主 skill：当前上游即 ppt-master 单 skill；多 skill 时锚定 ppt-master，
  // 缺失则回退字节序第一个（marketplace/版本判定均取主 skill 的 metadata.version）。
  const primarySkill = stagedSkills.includes('ppt-master') ? 'ppt-master' : stagedSkills[0];
  const upstreamVersion = readStagedVersion(stagingRoot, primarySkill);
  const marketplace = checkMarketplaceVersion(cacheDir, upstreamVersion ?? '');
  // 豁免/不一致 note 并入 🟡 汇总（T11 契约注：调用点与并入动作均在编排内）。
  const marketplaceNote =
    marketplace.ok === true && !marketplace.note.includes('豁免') ? null : marketplace.note;

  // ── 步骤 5（数据预计算）：结构分类（幂等判定与结构检测共用同一份结果）──
  // dryRun 透传（Step F #10）：aux 🟡 照常分类输出，但状态记录不落盘。
  const changes = classifyChanges(
    vendorSkillsRoot,
    stagingRoot,
    cacheDir,
    undefined,
    { dryRun: opts.dryRun === true },
  );

  // ── 包装层待发布状态（幂等禁用两触发 + wrapperPending，探测一次共用）──
  // 禁用①：工作区相对 HEAD 的包装层 diff——含**未提交的新文件**（spec §4.1 步骤 8
  // 防吞场景：未提交包装层变更不得被幂等短路吞掉）。经 `git status --porcelain`
  // 探测：gitignored 路径（.upstream/ .skills-staging/ sync-report.txt）天然排除。
  const status = await git(['status', '--porcelain', '--untracked-files=all']);
  const workspaceWrapperDiff =
    status.code === 0 &&
    status.stdout.split('\n').some((line) => {
      if (line === '') return false;
      // porcelain v1：XY<space><path>（rename 行为 `R  old -> new`——两侧任一为包装层即算）。
      return line.slice(3).split(' -> ').some(isWrapperPath);
    });

  const upstreamProbe = await git(['rev-parse', '--abbrev-ref', '@{u}']);
  let wrapperPending = false;

  /**
   * @{u} 分支的未推送包装层提交判定（UltraReview Fix #1：排除 last-sync.head
   * 及其祖先）。待发布 = `@{u}..HEAD` 中**晚于 last-sync.head** 的提交——上次
   * `--no-push` 产出的同步 commit 即 last-sync.head 本身（`anchor..HEAD` 区间
   * 自然排除），否则「同步 commit 触碰 package.json → 被算未推送包装层提交 →
   * 正式跑规则③ double-bump」。锚缺失 / 非 HEAD 祖先（rebase 等）→ 维持现状
   * （全部未推送计入）。isWrapperPath 过滤保留：区间语义只按提交排除，区间内
   * 非包装层文件的提交仍不计。
   */
  const detectUnpushedWrapperCommits = async () => {
    const revs = await git(['rev-list', '@{u}..HEAD']);
    if (revs.code !== 0) return false;
    let shas = revs.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    const anchorHead = previousSync?.head ?? null;
    if (anchorHead !== null && FULL_SHA_PATTERN.test(anchorHead)) {
      // merge-base --is-ancestor 把自身判真（A 是 A 的祖先），锚自身的排除必须
      // 显式比较 sha——同步 commit == last-sync.head 时 `sha === anchorHead` 即落
      // 在此分支被剔除。
      const anchorIsAncestor = await git(['merge-base', '--is-ancestor', anchorHead, 'HEAD']);
      if (anchorIsAncestor.code === 0) {
        const kept = [];
        for (const sha of shas) {
          if (sha === anchorHead) continue;
          const later = await git(['merge-base', '--is-ancestor', anchorHead, sha]);
          if (later.code === 0) kept.push(sha);
        }
        shas = kept;
      }
    }
    if (shas.length === 0) return false;
    const files = await git(['log', '--name-only', '--pretty=format:', '--no-walk', ...shas]);
    return files.code === 0 && files.stdout.split('\n').some(isWrapperPath);
  };

  if (upstreamProbe.code === 0) {
    // @{u} 存在：区间内存在涉及包装层文件的未推送提交 → wrapperPending=true。
    wrapperPending = await detectUnpushedWrapperCommits();
  } else {
    // 回退分支（无 upstream/空仓库：@{u} 探测 exit 128 fatal——绝不裸跑
    // `git log @{u}..HEAD`）。锚 = last-sync 的 **head** 字段（包装层 HEAD 基线），
    // 绝不是 sha 字段——sha 是上游 commit sha（缓存键语义），tarball 同步从不
    // 引入上游 commit，上游 sha 永不为包装层祖先，拿它作 merge-base 锚在生产
    // 无 @{u} 场景恒 false（禁用②不可达 → 未推送包装层提交被幂等短路吞掉）。
    //   head 缺失（首灌前/旧记录）→ false——确无已发布基线，首灌前的工作区
    //   变更由禁用①（工作区包装层 diff）兜住；
    //   head == HEAD → false；head 为 HEAD 祖先且 HEAD≠head → true。
    const anchorHead = previousSync?.head ?? null;
    if (anchorHead !== null && FULL_SHA_PATTERN.test(anchorHead)) {
      const head = await git(['rev-parse', 'HEAD']);
      if (head.code === 0) {
        const headValue = head.stdout.trim();
        if (headValue !== anchorHead) {
          const ancestor = await git(['merge-base', '--is-ancestor', anchorHead, 'HEAD']);
          wrapperPending = ancestor.code === 0;
        }
      }
    }
  }

  // ── 步骤 8（前置执行）：幂等短路 ────────────────────────────────
  // 范围 = vendor 树 + 包装层待发布：ref sha 同 + 树无 diff + 无待发布才短路。
  // 两个禁用触发任一命中（工作区包装层 diff / 未推送包装层提交）即继续走 bump
  // 流程——「工作区未提交变更不参与 wrapperPending 取值」的限定语不适用于此处。

  /**
   * PAT 解析（spec §5 顺序：env → git credential fill）：供补推复用。解析失败 →
   * null（与主 push 路径同序同据，但失败不映射退出码——补推属尽力而为）。
   */
  const resolvePushTarget = async (originUrl) => {
    const envPat = nonEmpty(process.env[PAT_ENV]);
    if (envPat !== null) {
      const oneShot = buildOneShotUrl(originUrl, envPat);
      return oneShot === null ? null : { mode: 'env', target: oneShot, pat: envPat };
    }
    const fill = await git(['credential', 'fill'], { stdin: `url=${originUrl}\n` });
    if (fill.code === 0 && parseCredentialPassword(fill.stdout) !== null) {
      // credential 路径：PAT 只在 git 进程内流转，push 走 origin。
      return { mode: 'credential', target: 'origin', pat: null };
    }
    return null;
  };

  /**
   * UltraReview Fix #2：push 部分失败（main 已推、tag 被拒 exit 6）后重跑会被
   * 幂等短路吞掉——本地已就绪的发布 tag 永不发布。短路 return 前补推：本地
   * last-sync 版本对应 tag 存在（rev-parse -q --verify）且 origin ls-remote
   * 结果无该 tag → 补推；本地无 / 远端已有 / 凭据不可用 → 照常短路
   * （补推不改变短路 exit 0——失败下次运行重试）。
   * Step F 裁决扩展：补推 refspec 由 [tag] 扩为 [main, tag]（releasePushRefspecs
   * 共用）——恢复完整发布语义，tag 不再指向未上 main 的 commit。main 已在远端
   * 时该 refspec 推送为幂等 no-op（Everything up-to-date）。
   * R2 Fix（预判鉴权化）：**先** resolvePushTarget（env PAT → credential fill，
   * 与主 push 路径同序同据），再用推送目标（env → 一次性 URL；credential →
   * origin）跑 ls-remote 预判——此前裸 origin URL 预判在 env PAT + 私有 origin
   * 场景（无 credential helper）必然鉴权失败 128 → 静默短路，补推永不执行。
   * 凭据不可用 / 预判不可达 → 输出跳过原因（不再静默）后照常短路；一次性
   * URL 的脱敏约束（PAT 不落盘/不回显）对预判输出同样适用。
   */
  const backPushMissingReleaseTag = async () => {
    const tagName = `v${currentVersion}`;
    const localTag = await git(['rev-parse', '-q', '--verify', `refs/tags/${tagName}`]);
    if (localTag.code !== 0) return; // 本地 tag 不存在 → 照常短路
    const originUrlResult = await git(['remote', 'get-url', 'origin']);
    if (originUrlResult.code !== 0) return;
    const originUrl = originUrlResult.stdout.trim();
    const pushPlan = await resolvePushTarget(originUrl);
    if (pushPlan === null) {
      logInfo(`⚠ 发布 tag ${tagName} 本地已就绪且远端缺失，但推送凭据不可用——本次未补推（下次运行重试）。`);
      return;
    }
    const remoteTags = await git(['ls-remote', '--tags', pushPlan.target]);
    if (remoteTags.code !== 0) {
      // 预判通道不可达（网络等）不阻断——照常短路，但不再静默：回显跳过原因
      //（一次性 URL 可能回显于 git 输出——先行脱敏，PAT 绝不出现在日志）。
      logInfo(
        `⚠ 补推预判通道不可达（git ls-remote --tags exit ${remoteTags.code}），`
          + `本次未补推（下次运行重试）:\n${sanitizedGitOutput(pushPlan.pat, remoteTags).trim()}`,
      );
      return;
    }
    const remoteTagNames = new Set(parseLsRemote(remoteTags.stdout).map((entry) => entry.tagName));
    if (remoteTagNames.has(tagName) || remoteTagNames.has(currentVersion)) return; // 远端已有 → 已发布
    for (const refspec of releasePushRefspecs(tagName)) {
      const push = await git(['push', pushPlan.target, refspec]);
      if (push.code !== 0) {
        // 一次性 URL 可能回显于 git 输出——先行脱敏（PAT 绝不出现在日志）。
        logInfo(`⚠ 补推 ${refspec} 失败（下次运行重试）:\n${sanitizedGitOutput(pushPlan.pat, push).trim()}`);
        return;
      }
    }
    logInfo(`补推缺失的发布: main + ${tagName}（上次推送部分失败的遗留）。`);
  };

  const sameRefSha =
    previousSync !== null && previousSync.ref === normalizedRef && previousSync.sha === (refSha ?? '');
  if (sameRefSha && !changes.vendorDiff && !wrapperPending && !workspaceWrapperDiff) {
    // Fix #2：--no-push/--dry-run 明示不推送时不补推；其余短路场景先补推缺失 tag。
    if (opts.noPush !== true && opts.dryRun !== true) {
      await backPushMissingReleaseTag();
    }
    logInfo('already up to date（ref 与上次同步一致、vendor 树无 diff、无包装层待发布）——不跑 guard/verify/结构检测。');
    cleanupStaging();
    return 0;
  }

  // 版本判定（dry-run 计划与自动路径共用；🟡 汇总行）。
  const yellowLines = changes.yellow.map((change) => change.detail);
  if (marketplaceNote !== null) yellowLines.push(marketplaceNote);
  const versionPlan =
    upstreamVersion === null
      ? { note: '无法判定（staging metadata.version 缺失——🔴 待人工）' }
      : (() => {
          const decision = decideVersion({
            current: currentVersion,
            upstreamVersion,
            vendorDiff: changes.vendorDiff,
            wrapperPending,
          });
          return { decision, note: `${currentVersion} → ${decision.version}（规则${decision.rule}）` };
        })();

  // ── --dry-run：完成幂等检查 + 结构检测后输出将发生的变化，无任何落盘动作 ──
  // （状态写已在上游门控——fetch 时点 writeLastSync 与 classifyChanges 的 aux
  // 记录均以 opts.dryRun 跳过；.upstream tarball 缓存不受影响。）
  if (opts.dryRun === true) {
    const plan = [
      '--dry-run：以下为将发生的变化（未执行替换/commit/tag/push）。',
      `上游: ${repo} @ ${normalizedRef}（${refSha ?? 'sha 未知'}）`,
      changes.red.length > 0
        ? `🔴 结构变化 ${changes.red.length} 项（需 --confirm-structural 人工确认后才走自动路径）:\n${changes.red.map((change) => `  - ${change.detail}`).join('\n')}`
        : '🔴 结构变化 0 项——将走自动路径。',
      ...(yellowLines.length > 0 ? [`🟡 提示 ${yellowLines.length} 项:\n${yellowLines.map((line) => `  - ${line}`).join('\n')}`] : []),
      `版本判定: ${versionPlan.note}`,
      `将替换 skill 面: ${stagedSkills.join(', ')}`,
      ...(existsSync(join(root, CLIENT_REL))
        ? [`将联动改写: ${CLIENT_REL}（PLUGIN_VERSION → ${versionPlan.decision?.version ?? '<待定>'}、UPSTREAM_VERSION → ${upstreamVersion ?? '<待定>'}）`]
        : []),
      `将创建 tag v${versionPlan.decision?.version ?? '<待定>'} 并推送（未传 --no-push 时）。`,
    ];
    logInfo(plan.join('\n'));
    return 0;
  }

  // ── 步骤 4：完整性门（guard 逐 skill；--skip-guard 跳过执行）────
  if (opts.skipGuard !== true) {
    for (const skill of stagedSkills) {
      const guardScript = join('.skills-staging', skill, 'scripts', 'attribution_guard.py');
      let guardResult;
      try {
        guardResult = await deps.runPython([guardScript], { cwd: root });
      } catch (error) {
        logFail(`guard 无法运行（解释器级失败：python3 缺失或不可执行，工具链缺失，退出码 7）:\n${error.message}`);
        return 7;
      }
      if (guardResult.code !== 0) {
        if (INTERPRETER_ERROR_PATTERN.test(guardResult.stderr)) {
          logFail(`guard 解释器级失败（语法错误类，退出码 7）: python3 ${guardScript}\n${guardResult.stderr.trim()}`);
          return 7;
        }
        logFail(
          `guard 判定失败（guard 完整运行后返回 ${guardResult.code}，完整性门失败，退出码 3）: python3 ${guardScript}\n${guardResult.stderr.trim()}`,
        );
        return 3;
      }
    }
  }

  // ── 步骤 7：结构变化路径（🔴 且未确认 → 报告 + sync-report.txt + 退出码 2）──
  if (changes.red.length > 0 && opts.confirmStructural !== true) {
    const report = [
      '检测到结构变化（🔴）——需人工评估插件可见面（spec §4.1 步骤 7）。',
      `🔴 结构变化 ${changes.red.length} 项:`,
      ...changes.red.map((change) => `  - ${change.detail}`),
      ...(yellowLines.length > 0
        ? [`🟡 提示 ${yellowLines.length} 项（同批次检出，随确认后的自动路径输出指引）:`, ...yellowLines.map((line) => `  - ${line}`)]
        : []),
      '影响评估: 结构变化影响 provider 可见面——§3.4 泛化扫描使多数结构变化无需改码即可自动纳入；frontmatter 相关 🔴（name 变更/metadata.version 缺失）需人工修复，替换前 verify 会二次拦截。',
      `后续指引: ① 按需人工更新包装层代码并本地 commit；② 以 --confirm-structural 重跑同步走自动路径（重跑固定本次 ref ${normalizedRef}，除非显式改 --ref）。`,
      '退出码 2（流程停止，待人工）。',
    ].join('\n');
    logFail(report);
    writeReport(report);
    return 2;
  }

  // ── 步骤 6：自动路径（🟢 或已 --confirm-structural）──────────────

  // verify 前置（校验先于替换）：**必须显式传 upstream**——T8 缺省语义第⑥项对
  // 未传 upstream 恒报 problems（verify-plugin 自身退出码 1 → 编排映射退出码 4）。
  const verifyResult = await deps.runVerify(stagingRoot, {
    skipGuard: opts.skipGuard === true,
    upstream: cacheDir,
  });
  if (verifyResult.problems.length > 0) {
    logFail(
      [
        `verify-plugin 校验失败（${verifyResult.problems.length} 项，vendor 树未触碰，退出码 4）:`,
        ...verifyResult.problems.map((problem) => `  ✗ ${problem}`),
      ].join('\n'),
    );
    for (const warning of verifyResult.warnings) logInfo(`⚠ ${warning}`);
    return 4;
  }
  for (const warning of verifyResult.warnings) logInfo(`⚠ ${warning}`);

  // decideVersion 前第二道防线（钉子 #4）：显式断言 upstreamVersion 非 null。
  // §4.2 行 3 🔴（metadata.version 缺失）已在结构检测先行拦截；此防线兜住
  // 「🔴 存在 + --confirm-structural 强制自动」组合下版本 bump 无法执行的缺陷假绿。
  if (upstreamVersion === null) {
    const report = [
      `staging 主 skill（${primarySkill}）SKILL.md frontmatter metadata.version 缺失或不可解析——版本 bump 无法执行（结构检测 🔴 的第二道防线）。`,
      '后续指引: 人工修复上游 skill 的 metadata.version 后重跑同步。退出码 2。',
    ].join('\n');
    logFail(report);
    writeReport(report);
    return 2;
  }
  // versionPlan 在 upstreamVersion 非 null 时必带 decision（与 dry-run 计划同一份
  // 判定输入，两处调用点之间这些输入不变）。
  const decision = versionPlan.decision;

  // no-change（上游版本未变 + 无 diff + 无包装层待发布）：不产生空提交。
  if (decision.rule === 'no-change') {
    logInfo('already up to date（上游版本未变、vendor 树无 diff、无包装层待发布）——不产生空提交。');
    if (workspaceWrapperDiff) {
      logInfo('注意：工作区存在未提交的包装层变更——不参与自动 bump（规则③以已提交的未推送包装层提交为判据），请自行 commit 后再同步。');
    }
    cleanupStaging();
    return 0;
  }

  // ── 版本常量联动（issue #3）：bump package.json 之外，lib/client.js 的
  //    PLUGIN_VERSION / UPSTREAM_VERSION 一并改写。**先于替换/bump 执行**：
  //    联动失败（形态漂移 / 文件带未提交变更）时 vendor 面与版本面均未触碰，
  //    干净退出 2；成功则改写结果随后随同步 commit 一起提交。
  let linkage = { status: 'missing' };
  if (existsSync(join(root, CLIENT_REL))) {
    // 未提交变更守卫：lib/client.js 若有未提交的人工改动，git add 会把它们整个
    // 卷进同步 commit——拒绝执行，先请人工提交（fail-loud 优于静默裹挟）。
    // 守卫自身失败（code≠0，如瞬时 index.lock）同样 fail-loud（Gate 3 P2-1）：
    // 此守卫的目的就是安全拦截，「查不了」必须当「不能继续」，否则守卫被静默击穿。
    const dirtyClient = await git(['status', '--porcelain', '--', CLIENT_REL]);
    if (dirtyClient.code !== 0) {
      logFail(
        `git status --porcelain -- ${CLIENT_REL} 失败（环境失败，退出码 5）——无法确认 ${CLIENT_REL} 是否带未提交变更，版本常量联动拒绝继续:\n${dirtyClient.stderr.trim()}`,
      );
      return 5;
    }
    if (dirtyClient.stdout.trim() !== '') {
      const report = [
        `lib/client.js 存在未提交变更——为避免把人工改动卷进同步 commit，版本常量联动拒绝执行（vendor 面与版本号均未改动）。`,
        `后续指引: 先提交 lib/client.js 的变更（或 git stash），再重跑同步。退出码 2。`,
      ].join('\n');
      logFail(report);
      writeReport(report);
      return 2;
    }
    linkage = applyVersionLinkage(root, { pluginVersion: decision.version, upstreamVersion });
  } else {
    yellowLines.push('lib/client.js 不存在——版本常量联动跳过（仓库形态异常，请人工确认）');
  }
  if (linkage.status === 'problem') {
    const report = [
      'lib/client.js 版本常量联动失败（vendor 面与版本号均未改动）:',
      ...linkage.problems.map((problem) => `  ✗ ${problem}`),
      '后续指引: 人工核对 lib/client.js 的常量形态（恰一处 const PLUGIN_VERSION / UPSTREAM_VERSION 字面量声明）后重跑同步。',
      '注: 若失败发生在写回自检阶段，lib/client.js 可能已写入未验证内容——git checkout -- lib/client.js 可还原后重试。退出码 2。',
    ].join('\n');
    logFail(report);
    writeReport(report);
    return 2;
  }
  if (linkage.status === 'rewritten') {
    logInfo(
      `联动改写: ${CLIENT_REL}（${linkage.changes.map((change) => `${change.constant} → ${change.to}`).join('、')}）`,
    );
  } else if (linkage.status === 'unchanged') {
    logInfo(`联动改写: ${CLIENT_REL} 无变化（两常量已与目标一致）`);
  }

  // 替换 skill 面（单向 上游→vendor：vendor 多出的 skill 目录属包装层人工变更，保留）。
  for (const skill of stagedSkills) {
    const target = join(vendorSkillsRoot, skill);
    rmSync(target, { recursive: true, force: true });
    cpSync(join(stagingRoot, skill), target, { recursive: true });
  }

  // bump：package.json version（last-sync 的 version+head 于下方 wrapper commit
  // 完成点一并写入——head 必须 = commit 后的 HEAD，写在 commit 前会锚到旧提交）。
  writePackageVersion(root, decision.version);
  if (decision.notes.length > 0) for (const note of decision.notes) logInfo(`ℹ ${note}`);

  // 🟡 汇总（三类指引：依赖变更→重跑 setup_deps；description/辅助目录→知悉；
  // 另并入 marketplace 豁免/不一致 note）。🟡 不改变退出码 0。
  if (yellowLines.length > 0) {
    logInfo([`🟡 提示汇总 ${yellowLines.length} 项（不阻塞自动路径）:`, ...yellowLines.map((line) => `  - ${line}`)].join('\n'));
  }

  // commit（只提交同步面：skills + package.json + 联动改写的 lib/client.js；
  // 包装层人工变更由人工自行提交——lib/client.js 的未提交守卫已在联动步拦截）。
  const commitMessage = `chore(sync): 同步上游 ${normalizedRef} → v${decision.version}`;
  const addTargets = ['skills', 'package.json'];
  if (linkage.status === 'rewritten') addTargets.push(CLIENT_REL);
  const addResult = await git(['add', ...addTargets]);
  if (addResult.code !== 0) {
    logFail(`git add 失败（环境失败，退出码 5）:\n${addResult.stderr.trim()}`);
    return 5;
  }
  const commitResult = await git(['commit', '-m', commitMessage]);
  if (commitResult.code !== 0) {
    logFail(`git commit 失败（环境失败，退出码 5）:\n${commitResult.stderr.trim()}`);
    return 5;
  }

  // wrapper commit 完成：更新 last-sync 的 version 与 head（包装层 HEAD 基线——
  // 无 @{u} 回退分支的 wrapperPending 锚；--no-push 本地 commit 同样写入）。
  // exit 2 路径无 wrapper commit，不写 head（fetch 时已保持既有值）。
  const headAfter = await git(['rev-parse', 'HEAD']);
  const newHead = headAfter.code === 0 ? headAfter.stdout.trim() : null;
  writeLastSync(
    {
      ref: normalizedRef,
      sha: refSha ?? '',
      version: decision.version,
      head: newHead ?? previousSync?.head ?? undefined,
    },
    root,
  );

  // tag 先行检测（绝不覆盖 tag、绝不 force push）：
  //  ① 本地 `git rev-parse -q --verify refs/tags/v<version>`（依赖仓库已有 commit）；
  //  ② 远端从 origin 的 ls-remote 结果预判（upstream 仓库与本仓库 tag 空间不同，
  //     预判对象是推送目标 origin——同步 v6.8.0 时 upstream 必然已有同名 tag）。
  const tagName = `v${decision.version}`;
  const localTag = await git(['rev-parse', '-q', '--verify', `refs/tags/${tagName}`]);
  if (localTag.code === 0) {
    logFail(
      `tag ${tagName} 已存在（本地 rev-parse 先行检测命中）——绝不覆盖已有 tag。`,
      '指引（人工处理）: 拒绝本次回滚同步，或人工评估后改版本号。--no-push 不适用于 tag 冲突（其仍会创建本地 tag）。本地 commit 已保留。退出码 6。',
    );
    return 6;
  }
  const originUrlResult = await git(['remote', 'get-url', 'origin']);
  const originUrl = originUrlResult.code === 0 ? originUrlResult.stdout.trim() : null;
  if (originUrl !== null) {
    const remoteTags = await git(['ls-remote', '--tags', originUrl]);
    if (remoteTags.code === 0) {
      const remoteTagNames = new Set(parseLsRemote(remoteTags.stdout).map((entry) => entry.tagName));
      if (remoteTagNames.has(tagName) || remoteTagNames.has(decision.version)) {
        logFail(
          `tag ${tagName} 已存在于远端（origin ls-remote 预判命中）——绝不覆盖已有 tag。`,
          '指引（人工处理）: 拒绝本次回滚同步，或人工评估后改版本号。本地 commit 已保留。退出码 6。',
        );
        return 6;
      }
    } // 预判通道不可达（网络等）不阻断——tag 冲突最终由 push 侧拒绝兜底
  }

  // tag 创建（--no-push 仍创建本地 tag，只是不推送）。
  const tagResult = await git(['tag', tagName]);
  if (tagResult.code !== 0) {
    logFail(`git tag ${tagName} 失败（退出码 6）:\n${tagResult.stderr.trim()}`);
    return 6;
  }

  // sync-report.txt：仓库根、每次覆盖（成功/结构两路径都写；先于 push）。
  const report = [
    'ppt-master 上游同步报告',
    `时间: ${deps.now().toISOString()}`,
    `上游: ${repo} @ ${normalizedRef}（${refSha ?? 'sha 未知'}）`,
    `结论: 同步完成（规则${decision.rule}，版本 ${currentVersion} → ${decision.version}）`,
    `替换 skill 面: ${stagedSkills.join(', ')}`,
    ...(linkage.status === 'rewritten'
      ? [
          `联动改写: ${CLIENT_REL}（${linkage.changes
            .map((change) => `${change.constant}: ${change.from} → ${change.to}`)
            .join('、')}）`,
        ]
      : []),
    ...(linkage.status === 'unchanged' ? [`联动改写: ${CLIENT_REL} 无变化（两常量已与目标一致）`] : []),
    ...(linkage.status === 'missing' ? ['联动改写: 跳过（lib/client.js 不存在，见 🟡 提示）'] : []),
    '待人工: README.md / README.en.md 版本历史表与「本地校验」--upstream 示例路径（脚本不自动改写文档）',
    `commit: ${commitMessage}`,
    `tag: ${tagName}`,
    ...(yellowLines.length > 0 ? ['🟡 提示:', ...yellowLines.map((line) => `  - ${line}`)] : []),
  ].join('\n');
  writeReport(report);
  logInfo(report);

  // push（--no-push：本地 commit+tag 已就绪，直接成功返回）。
  if (opts.noPush === true) {
    logInfo('--no-push：本地 commit 与 tag 已创建，未推送。');
    cleanupStaging();
    return 0;
  }
  if (originUrl === null) {
    logFail(
      `推送前置依赖不可用：未配置 origin 远端（git remote get-url origin 失败）。`,
      '指引: git remote add origin <url> 后重试。本地 commit 与 tag 已保留。退出码 6。',
    );
    return 6;
  }

  // PAT 解析顺序（spec §5）：env → git credential fill → 失败并指引（退出码 6）。
  const envPat = nonEmpty(process.env[PAT_ENV]);
  let pushMode = null; // 'env' | 'credential'
  let oneShotUrl = null;
  if (envPat !== null) {
    pushMode = 'env';
    oneShotUrl = buildOneShotUrl(originUrl, envPat);
    if (oneShotUrl === null) {
      logFail(
        `推送不可用：origin 为非 https 形态（${originUrl}），${PAT_ENV} 一次性 URL 无法构造。`,
        '指引: 改用 https origin 或配置 credential helper。本地 commit 与 tag 已保留。退出码 6。',
      );
      return 6;
    }
  } else {
    const fill = await git(['credential', 'fill'], { stdin: `url=${originUrl}\n` });
    // credential 路径：PAT 完全不经由本脚本参数/环境——push 走 origin，凭据在 git 进程内流转。
    if (fill.code === 0 && parseCredentialPassword(fill.stdout) !== null) pushMode = 'credential';
  }
  if (pushMode === null) {
    logFail(
      `推送凭据不可用：${PAT_ENV} 未设置且 git credential fill 未取得 PAT（推送环节前置依赖不可用归推送失败）。`,
      `指引: 配置 ${PAT_ENV} 环境变量，或配置 git credential helper（git credential fill 可解析）。本地 commit 与 tag 已保留。退出码 6。`,
    );
    return 6;
  }

  const pushTarget = pushMode === 'env' ? oneShotUrl : 'origin';
  const pushRefspecs = releasePushRefspecs(tagName);
  for (const refspec of pushRefspecs) {
    const push = await git(['push', pushTarget, refspec]);
    if (push.code !== 0) {
      // 一次性 URL 可能回显于 git 输出——推送失败信息先行脱敏（PAT 绝不出现在日志）。
      const sanitized = envPat !== null
        ? `${push.stdout}\n${push.stderr}`.split(envPat).join('***')
        : `${push.stdout}\n${push.stderr}`;
      logFail(
        `推送失败（exit ${push.code}，本地 commit 与 tag 已保留，退出码 6）:\n${sanitized.trim()}`,
        '指引: 远端推送被拒（non-fast-forward）时先 git pull --rebase origin main 解决后重试；「可 --no-push 重试或手动推送」仅适用此类远端推送场景（tag 冲突不适用）。',
      );
      return 6;
    }
    logInfo(`已推送: ${refspec}`);
  }

  cleanupStaging();
  logInfo(`同步完成：v${decision.version}（规则${decision.rule}）——skill 面已替换、已 commit/tag/push。`);
  return 0;
}

/** 用法块（spec §4；usage 错误退出码 1 时输出）。 */
const USAGE_TEXT = `用法: node scripts/sync-upstream.mjs [选项]
  --ref <tag|branch|commit>   指定上游 ref（默认：最新语义版本 release tag）
  --repo <url>                上游仓库 URL（默认 ${DEFAULT_REPO}；同步源与 ls-remote/codeload 均取此值）
  --refresh                   强制忽略 .upstream/ 缓存重新下载
  --confirm-structural        结构变化已人工确认，强制走自动路径
  --skip-guard                跳过步骤 4 attribution_guard 的执行（须至少与 --no-push 或 --dry-run 之一联用）
  --no-push                   只本地 commit，不推送
  --dry-run                   只输出将发生的变化`;

// ─── CLI 入口（直接以 `node scripts/sync-upstream.mjs` 运行时）────

const invokedDirectly = (() => {
  if (typeof process.argv[1] !== 'string') return false;
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(parseArgs(process.argv.slice(2)))
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      // 未分类的环境级异常（spawn 失败、意外 IO 等）——不静默吞掉。
      console.error(`sync-upstream: 未预期的失败（退出码 5）: ${error?.stack ?? error}`);
      process.exit(5);
    });
}
