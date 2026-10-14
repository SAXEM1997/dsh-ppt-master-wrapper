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
 *  - Task 13（替换占位）：`main(options, deps)` 全流程编排与退出码闭环。
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
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根——以**模块位置**定位（src/scripts/ 的上一级），与 cwd 无关。 */
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
 * 无文件、不可读、JSON 损坏、或结构不是 `{ref:string, sha:string, version:string,
 * at:string}` → null（**不 throw**：状态文件是可留存缓存的便利设施，其缺失等价
 * 「首次同步」，不应让调用方崩溃）。
 *
 * @param {string} [root] 仓库根；缺省 = 本模块所属仓库根（与 cwd 无关）。
 * @returns {{ ref: string, sha: string, version: string, at: string } | null}
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
  for (const key of ['ref', 'sha', 'version', 'at']) {
    if (typeof parsed[key] !== 'string' || parsed[key] === '') return null;
  }
  return { ref: parsed.ref, sha: parsed.sha, version: parsed.version, at: parsed.at };
}

/**
 * 写 `.upstream/last-sync.json`（建目录 + 原子写 + `at` ISO 时间）。
 *
 * 原子写：先写同目录临时文件再 `rename`，避免并发/中断留下半截 JSON（该文件被
 * 读作缓存锚点，半截 JSON 会静默降级为 null 从而丢失幂等比对基准）。
 * `at` 由本函数写入（ISO 8601，UTC），data 中的 `at` 被忽略。
 *
 * @param {{ ref: string, sha: string, version: string, at?: string }} data 状态内容。
 * @param {string} [root] 仓库根；缺省 = 本模块所属仓库根（与 cwd 无关）。
 * @returns {{ ref: string, sha: string, version: string, at: string }} 落盘内容。
 */
export function writeLastSync(data, root) {
  const file = lastSyncPath(root);
  const payload = {
    ref: String(data?.ref ?? ''),
    sha: String(data?.sha ?? ''),
    version: String(data?.version ?? ''),
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
 *
 * 所有分类项均以 `vendorDiff` 汇总——不做「红/黄项不置 diff」的短路，因为规则①
 * 的「上游版本变 + 有 diff」与规则④的「无 diff」正是靠本字段区分。
 *
 * @param {string} vendorSkillsRoot vendor 侧 skill 根（其下直接是各 skill 目录）。
 * @param {string} stagingRoot staging 根（`stageSkills` 产物）。
 * @param {string} upstreamRoot 上游解压树根（aux-dir 数据源）。
 * @param {string} [auxStatePath] aux-dir 状态文件路径（缺省由 vendorSkillsRoot 推导）。
 * @returns {{ red: Array<{kind: string, detail: string}>,
 *   yellow: Array<{kind: string, detail: string}>, green: boolean, vendorDiff: boolean }}
 */
export function classifyChanges(vendorSkillsRoot, stagingRoot, upstreamRoot, auxStatePath) {
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
  if (addedAux.length > 0 || removedAux.length > 0 || previousAuxDirs === null) {
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

  const marketplaceVersion = parsed !== null && typeof parsed === 'object' ? parsed.version : undefined;
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

// ─── main：编排占位（Task 13 替换）────────────────────────────────

/**
 * 同步主编排（spec §4.1 步骤 1-8 + 退出码闭环）。
 *
 * **Task 10 占位**：本任务只交付解析/纯函数层，编排（拉取/预检/staging/guard/
 * 结构检测/替换/bump/commit/tag/push 与 0-7 退出码）由 Task 13 替换本实现。
 * 占位即 throw——绝不静默返回 0 让调用方误以为同步成功。
 *
 * @param {object} options parseArgs 产物（或等价显式对象）。
 * @param {object} [deps] 可注入依赖（T13：fetchTarball / runGit / runPython /
 *   runVerify / now / freeSpace）。
 * @returns {Promise<number>} 退出码。
 */
export async function main(options, deps) {
  void options;
  void deps;
  throw new Error('TODO: T13——sync 编排（拉取/预检/staging/guard/结构检测/替换/commit/tag/push）尚未实现');
}
