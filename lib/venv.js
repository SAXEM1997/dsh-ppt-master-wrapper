/**
 * venv path / ownership-marker / wrapper-state primitives.
 *
 * Task 1 of the venv-isolation feature: the lowest layer every other venv module
 * consumes (`lib/skill-provider.js` and `lib/tools.js` reach it through Tasks 2-9).
 * Everything here is plain synchronous `node:fs`/`node:os`; the module has no
 * import-time side effects and writes to exactly two locations:
 *
 * - `<venv>/.ppt-master-wrapper.json` — the ownership marker. Only a marked
 *   directory may ever be deleted by the cleanup path (spec §5.4), so the marker
 *   is written on creation *and* back-filled when an existing venv is adopted.
 * - `<homedir()>/.ppt-master/wrapper-state.json` — the last installed venv path,
 *   consulted by `cleanupOldVenv` (Task 4). Its directory is created on first
 *   write.
 *
 * `cleanupOldVenv` is the one thing here that removes more than those two files, and
 * it may only do so for an old venv directory carrying both `pyvenv.cfg` and the
 * marker, after its four preconditions pass.
 *
 * Contract notes that downstream tasks depend on:
 * - `resolveVenvPath` is *pure path semantics*: `enabled` plays no part here, and
 *   an unresolvable `~` (empty `os.homedir()`, i.e. `HOME=''`) yields
 *   `invalidReason: 'unresolvable'` rather than a root-level `/.ppt-master/...`.
 * - "absent" and "unreadable" are distinct wrapper-state outcomes: absent is the
 *   first-run initialisation semantic (no `readError` key), unreadable means the
 *   old path is unknown (skip cleanup, attach `readError`). Neither read throws.
 *   An unresolvable home (`os.homedir() === ''`) is *unreadable*, not a throw: the
 *   registration location must stay absolute under `$HOME`, so `wrapperStatePath`
 *   throws rather than returning a relative path that would write into the cwd.
 * - Writes deliberately do not swallow errors: `writeMarker` /
 *   `writeWrapperState` propagate to their caller, which decides between the
 *   warn channel (marker, spec §6) and the payload note (registration).
 *
 * `snapshotVenvConfig` and `assembleInjectionBag` are the Config boundary appended by
 * Task 5: the host's `.volatile()` leaves arrive as `.get()`-bearing reference objects,
 * and these two pure functions turn them into the plain values every downstream
 * signature expects (`createSkillProvider`/`createTools`/this module). They touch no
 * filesystem and no host package — `assembleInjectionBag` is also where the apply-side
 * per-leaf defaults live (the loader path gets its defaults from cordis validation).
 * `normalizeVenvInput` is the *factory-entry* counterpart for the test/embedding path:
 * a partial `venv` object handed straight to `createTools`/`createSkillProvider` is
 * completed there, with `enabled` normalised to `false` unless it is literally `true`
 * (Gate 3 G3-09) — so "the key is missing" can never mean "the venv is on".
 *
 * Task 2 appends the four-state `effectiveInterpreter` decision plus its synchronous
 * `probeVenvInterpreter` existence probe. That probe is *not* the async three-field
 * version probe in `lib/tools.js` (`{found, version, meetsSkillRequirement}`): it answers
 * only "is `<venvDir>/bin/python3` visible", taking the venv directory as its argument.
 * Since R2 M2 the *readiness* judgement is the same **two-question** examination as the
 * adoption one below (interpreter ∧ install path), so a half-built venv cannot read as
 * healthy on any consumer surface (info / check_env / entry skill).
 *
 * Task 3 appends `ensureVenv`, the single creation/adoption primitive (spec §5.4), which
 * `ppt_master_setup_deps` calls. Its precondition (`classifyTarget`) is what keeps
 * `python3 -m venv` away from directories holding user data; creation runs through an
 * injected runner, and the interpreter probe plus the marker write are injectable through
 * its options. The adoption physical examination asks **two** questions — interpreter
 * (`probeVenvInterpreter`) and install path (`probeVenvPip`) — because `python3 -m venv`
 * writes `pyvenv.cfg`/`bin/python3` before ensurepip runs: "the interpreter is there" is
 * not the same claim as "the install path works" (Gate 3 G3-02). A marker write failure
 * degrades to the warn channel (spec §6 marker row):
 * the venv stays usable and the creation/adoption conclusion is never rewritten.
 *
 * Task 4 appends `cleanupOldVenv`, the module's only deletion primitive (spec §5.4) and
 * therefore the safety boundary of the whole feature: four preconditions are re-read from
 * the filesystem on every call — path identity, mutual non-containment, `pyvenv.cfg`,
 * ownership marker — and only then may the injected delete seam run. That re-read is what
 * makes a half-deleted target retryable on the next `setup_deps` (spec §5.4 residual risk ②).
 *
 * @module dsh-ppt-master-wrapper/lib/venv
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** Ownership marker written into every wrapper-created or wrapper-adopted venv. */
export const MARKER_FILENAME = '.ppt-master-wrapper.json';

/** A directory is a venv iff it carries this file (stdlib venv layout, POSIX). */
const PYVENV_CFG = 'pyvenv.cfg';

/**
 * Interpreter path relative to a venv root (POSIX layout). Held once so the existence
 * probe and `effectiveInterpreter`'s `pythonPath` are provably the same target.
 */
const VENV_PYTHON_REL = join('bin', 'python3');

/**
 * Install-path entry relative to a venv root (POSIX layout) — the command
 * `ppt_master_setup_deps` runs for the install step.
 *
 * Held once for the same reason as `VENV_PYTHON_REL`: the completeness probe and the
 * tools layer's `installCmd[0]` name the same target, and only this module decides
 * whether that target is usable (the tools layer never joins `bin/pip3` to decide).
 */
const VENV_PIP_REL = join('bin', 'pip3');

/** Wrapper state directory/file under `$HOME` (single registration location). */
const STATE_DIRNAME = '.ppt-master';
const STATE_FILENAME = 'wrapper-state.json';

/** The interpreter `ensureVenv` shells out to for creation (`python3 -m venv`). */
const PYTHON = 'python3';

/**
 * Classify `ensureVenv`'s target directory (spec §5.4 precondition).
 *
 * `'absent'` and `'empty'` are creatable, `'venv'` (carries `pyvenv.cfg`) is adoptable,
 * `'occupied'` is refused. A target we cannot prove empty — unreadable, or not a
 * directory at all — is reported as `'occupied'`: `python3 -m venv` exits 0 on a
 * non-empty directory and keeps whatever is in it, so this precondition is the only
 * thing standing between that command and the user's files.
 *
 * @param {string} dirPath
 * @returns {'absent'|'empty'|'venv'|'occupied'}
 */
function classifyTarget(dirPath) {
  if (!existsSync(dirPath)) return 'absent';
  if (venvExists(dirPath)) return 'venv';
  try {
    return readdirSync(dirPath).length === 0 ? 'empty' : 'occupied';
  } catch {
    return 'occupied';
  }
}

/**
 * Write the ownership marker, degrading a failure to the warn channel.
 *
 * Spec §6 marker row: a failed write (or adoption back-fill) leaves the venv usable —
 * the next `setup_deps` retries the back-fill — so the caller's `created`/`adopted`
 * conclusion must not be rewritten and `error` (which travels to `venv.error`) stays
 * unset. The warn line carries the marker path so the failure is locatable in the log.
 *
 * @param {string} dirPath
 * @param {(dirPath: string) => void} write Marker writer (module default or injected).
 * @returns {void}
 */
function writeMarkerWarnOnly(dirPath, write) {
  try {
    write(dirPath);
  } catch (error) {
    const markerFile = join(dirPath, MARKER_FILENAME);
    console.warn(
      `venv: ${markerFile} 写入失败（venv 仍可用，下次 setup_deps 重试补写）: ${error?.message ?? error}`
    );
  }
}

/** `true` for an abort (by name or code), whichever way the runtime spells it. */
function isAbortError(error) {
  return error !== null && typeof error === 'object'
    && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
}

/**
 * Rethrow a cancellation instead of folding it into a failure row.
 *
 * `ensureVenv` forwards `signal` straight into the runner, so an aborted creation
 * surfaces either as an `AbortError` rejection (`spawn`'s `error` event) or as `close`
 * with `code === null` (`spawnRun` resolves that as a null exit code). Neither is an
 * environment fault: this is the rule `lib/tools.js` states for its probes — "an abort
 * must keep propagating rather than be reported as a missing interpreter" — applied to
 * the one caller (`ppt_master_setup_deps`) that carries a real signal.
 *
 * @param {AbortSignal|undefined} signal
 * @returns {void}
 * @throws {*} `signal.reason`, or a plain `Error('aborted')` when absent.
 */
function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
}

/**
 * Directional path containment: is `prefix` an ancestor of (or the same path as) `target`?
 *
 * The comparison is textual but segment-aware, which is exactly what the cleanup
 * precondition needs: `/a/venv` *contains* `/a/venv/inner` and `/a/venv/`, while it does
 * **not** contain the sibling `/a/venv-older` that a naive `startsWith` would match —
 * over-refusing there would silently stop the old venv from ever being cleaned up.
 * Non-strings are never a prefix: the caller may hand over a `null` path from an
 * unresolved config and must still get a value back instead of a `TypeError`.
 *
 * @param {string} prefix Candidate ancestor.
 * @param {string} target Candidate descendant.
 * @returns {boolean}
 */
function isPathPrefix(prefix, target) {
  if (typeof prefix !== 'string' || typeof target !== 'string') return false;
  if (prefix === '' || target === '') return false;
  if (target === prefix) return true;
  return target.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep);
}

/**
 * 判定用路径规范化：`path.resolve` 折叠 `.` / `..` / 重复分隔符（纯文本，不触文件系统）。
 *
 * 这只是**文本面**的第一道保守判定（原条件①口径）：同目录的不同文本拼写（`<b>//venv`、
 * `<b>/./venv`、`<b>/sub/../venv`）在这里就相等，比 canonical 判定更早、也更保守地拒绝。
 * 它**不回答**"这两条路径指的是不是同一个目录"——那是 `canonicalForJudgment` 的职责
 * （`resolve` 不触文件系统，符号链接与"先解链接再退父目录"的内核语义都不在其中）。
 * 传 `remove()` 的仍是调用方给的 `oldPath` 原值。非字符串/空串原样返回，让
 * `isPathPrefix` 的既有非字符串守卫继续兜底。
 *
 * @param {*} dirPath
 * @returns {*}
 */
function normalizeForJudgment(dirPath) {
  if (typeof dirPath !== 'string' || dirPath === '') return dirPath;
  try {
    return resolve(dirPath);
  } catch {
    return dirPath;
  }
}

/**
 * 判定用 canonical 路径：把一条路径化到**内核会实际打开的那个目录**（Gate 3 R2 M1）。
 *
 * 为什么不能用 `resolve`：条件①②问的是"这两条路径指的是不是同一个目录 / 谁包含谁"，而
 * `resolve` 只做文本归一——父目录是符号链接时 `<link>/venv` 与 `<real>/venv` 是两个不同
 * 目录的同一实体，`<real>` 与 `<link>/venv` 是包含关系，文本面全都看不见，条件③④一过就把
 * **本次在用的 venv**（乃至其祖先目录连同同层用户数据）交给 `rmSync(recursive)`。
 *
 * 为什么也不能只用 `realpathSync`（连"先 resolve 再 realpathSync"也不够）：Node 的
 * `realpathSync` 自己按**文本**折叠 `..`（实测 `realpathSync('<p>/link/..') === '<p>'`，而
 * `readlink -f` 给 `<q>`），故 `<p>/link/../venv`（link→`<q>/sub`）既可能让它抛 ENOENT、
 * 也可能让它在**文本落点也存在**时返回一个内核根本不会打开的目录（`<p>/venv`）——后者会让
 * 包含面重新失守（`old=<q>` 与内核真值 `<q>/venv` 之间判不出包含）。因此这里**一律**按调用方
 * **原始拼写**逐段走，不设"整条 realpath"快路径：
 * 1. 以 `/`（相对路径则以 `process.cwd()`，POSIX 下已是物理路径）为起点；
 * 2. 每段拼到**已解析的前缀**上：能 `realpathSync` 就把前缀换成真实路径（符号链接在此解开）；
 * 3. `..` 在**已解析的前缀**上回退——先解符号链接再退父目录，这正是内核语义；
 * 4. 不存在的中段按文本拼接（等同"最深存在祖先的 realpath ＋ 其余段"，与旧 `resolve` 口径一致）；
 * 5. 任何一步异常（非字符串/空串）→ 原样返回，交给既有守卫与条件③④。
 *
 * 只在**判定**上使用：`remove()` 收的仍是 `oldPath` 原值（`rmSync` 自己按内核语义解释它）。
 *
 * @param {*} dirPath
 * @returns {*}
 */
function canonicalForJudgment(dirPath) {
  if (typeof dirPath !== 'string' || dirPath === '') return dirPath;

  let text;
  try {
    text = resolve(dirPath);
  } catch {
    return dirPath;
  }

  try {
    const isAbs = isAbsolute(dirPath);
    const segments = (isAbs ? dirPath : text).split(sep);
    let acc = isAbs ? sep : (tryRealpath(process.cwd()) ?? process.cwd());
    for (const segment of segments) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') {
        const parent = dirname(acc);
        acc = parent === '' ? sep : parent;
        continue;
      }
      const candidate = join(acc, segment);
      acc = tryRealpath(candidate) ?? candidate;
    }
    return acc === '' ? sep : acc;
  } catch {
    return text;
  }
}

/** `realpathSync` 的值或 `null`（任一侧不可解析都不构成"同一实体"的判据）。 */
function tryRealpath(dirPath) {
  try {
    return realpathSync(dirPath);
  } catch {
    return null;
  }
}

/** `statSync` 的结果或 `null`（不存在/不可达与"存在但不是同一实体"必须分开）。 */
function tryStat(dirPath) {
  try {
    return statSync(dirPath);
  } catch {
    return null;
  }
}

/**
 * 两条路径是否指向**同一个文件系统实体**，判据是 `dev+ino`（canonical 相等另在条件①′判定）。
 *
 * 符号链接别名与绑挂（bind mount）这类 `realpath` 折不掉的别名都靠这条兜底：目录在 POSIX 下
 * 只有一个 inode（目录硬链接被禁止），dev+ino 相等必然同一目录。
 *
 * **退化文件系统守卫（Gate 3 R2 M8）**：`st_ino === 0` / `st_dev === 0` 的 FS（部分 FAT/网络
 * 盘/合成 fs）上任意两目录都"相等"，照用会把清理永久锁死、并谎称"别名拼写"。故仅在两侧
 * `statSync` 都成功**且两侧 dev/ino 都非零**时才启用该判据；任一侧缺失或退化即判"非同一实体"，
 * 由条件①②的 canonical 判定与条件③④照常给出结论（拒绝面不会因此放松成误删）。
 *
 * **限定**：停用该判据时"不会误删"仅对 `realpath` 可解析的别名成立——若同时存在 canonical
 * 折不掉的别名（如 bind mount），该保护不覆盖包含面。
 *
 * @param {*} left
 * @param {*} right
 * @returns {boolean}
 */
function sameDeviceAndInode(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left === '' || right === '') {
    return false;
  }
  const leftStat = tryStat(left);
  const rightStat = tryStat(right);
  if (leftStat === null || rightStat === null) return false;
  if (leftStat.ino === 0 || leftStat.dev === 0) return false;
  if (rightStat.ino === 0 || rightStat.dev === 0) return false;
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

/**
 * `cleanupOldVenv`'s default deletion primitive (spec §5.4: `rmSync` recursive).
 *
 * `force: true` keeps an already-vanished target from being reported as a delete
 * failure — "the old venv is gone" is the goal state, not an error.
 *
 * @param {string} dirPath
 * @returns {void}
 */
function removeVenvDir(dirPath) {
  rmSync(dirPath, { recursive: true, force: true });
}

/** Hard cap for the stderr summary embedded in `venv.error` (a model-visible payload). */
const STDERR_SUMMARY_LIMIT = 500;

/** How many additional hint lines (beyond the first) `summarizeStderr` may keep. */
const STDERR_SUMMARY_EXTRA_LINES = 4;

/**
 * Lines of a failed creation that carry an **actionable** hint, as opposed to the bulk of a
 * traceback. `python3 -m venv` reports the Debian/Ubuntu ensurepip remedy in the middle of
 * its message (`On Debian/Ubuntu systems, you need to install the python3-venv` … `apt
 * install python3.11-venv`) — see `summarizeStderr`.
 */
const STDERR_HINT_PATTERN =
  /ensurepip|python3-venv|python3\.\d+-venv|\bapt(-get)?\s+install|\b(dnf|yum|zypper)\s+install|\bapk\s+add|\bpacman\s+-S/i;

/**
 * Bound a failed creation's stderr before it is embedded in `venv.error` (F4, R2 M7).
 *
 * `venv.error` travels verbatim into the model-visible 「install 未执行…」 line, so a
 * verbose failure (a full traceback, or a single multi-megabyte line) must not be able to
 * blow up the payload. Two rules, both bounded:
 * 1. the **first non-empty line** — what `python3 -m venv` prints first for its own
 *    failures — is always the summary's head;
 * 2. up to `STDERR_SUMMARY_EXTRA_LINES` later lines matching `STDERR_HINT_PATTERN` are
 *    appended. Without this the only actionable remedy on a Debian/Ubuntu box without
 *    ensurepip (`apt install python3-venv`) is dropped — the first line is the wrapped
 *    sentence *about* ensurepip, and the package name/remedy sit on lines 2-5. A user (or
 *    model) then only sees "creation failed" and repeats the same doomed run.
 *
 * Kept lines are joined with ` | ` so `venv.error` stays a single line for the payload's
 * one-event-per-line rendering, and the whole summary is hard-capped at
 * `STDERR_SUMMARY_LIMIT` characters with a `…` marker when it was cut — the hint channel is
 * not a payload amplifier (a stderr full of keyword-matching lines stays bounded).
 *
 * @param {*} stderr Raw runner stderr (any shape; non-strings mean "nothing to report").
 * @returns {string} `''` when there is no usable line, else the bounded summary.
 */
function summarizeStderr(stderr) {
  if (typeof stderr !== 'string') return '';
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return '';

  const kept = [lines[0]];
  for (const line of lines.slice(1)) {
    if (kept.length > STDERR_SUMMARY_EXTRA_LINES) break;
    if (STDERR_HINT_PATTERN.test(line)) kept.push(line);
  }

  const summary = kept.join(' | ');
  return summary.length > STDERR_SUMMARY_LIMIT
    ? `${summary.slice(0, STDERR_SUMMARY_LIMIT)}…`
    : summary;
}

/**
 * Resolve the configured venv path to an absolute path.
 *
 * `~` and `~/...` expand against `os.homedir()`. A relative result — including
 * `~user/...`, which is not part of our expansion grammar — is invalid, and so is
 * an empty/blank/non-string path. When `os.homedir()` returns `''` (Node keeps
 * `HOME=''` verbatim instead of falling back to passwd), `~` expansion is invalid
 * rather than a root-level path.
 *
 * @param {{ enabled: boolean, path: string, oldPathPolicy: 'keep'|'delete' }} venv
 *   De-referenced plain config object.
 * @returns {{ path: string|null, invalidReason: string|null }} `invalidReason` is
 *   `'relative-path'` or `'unresolvable'` when `path` is null.
 */
export function resolveVenvPath(venv) {
  const rawPath = venv?.path;
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return { path: null, invalidReason: 'unresolvable' };
  }

  let resolved = rawPath;
  if (rawPath === '~' || rawPath.startsWith('~/')) {
    const home = homedir();
    // HOME='' ⇒ homedir()==='' and no passwd fallback: expanding would fabricate
    // '/.ppt-master/…'. Report the config as unresolvable and let §6 degrade.
    if (home === '') return { path: null, invalidReason: 'unresolvable' };
    resolved = rawPath === '~' ? home : join(home, rawPath.slice(2));
  }

  if (!isAbsolute(resolved)) return { path: null, invalidReason: 'relative-path' };
  return { path: resolved, invalidReason: null };
}

/**
 * Whether `dirPath` looks like a stdlib venv (`pyvenv.cfg` present).
 *
 * @param {string} dirPath
 * @returns {boolean} `false` for non-string input rather than throwing.
 */
export function venvExists(dirPath) {
  return typeof dirPath === 'string' && dirPath !== '' && existsSync(join(dirPath, PYVENV_CFG));
}

/**
 * Read the ownership marker of a venv directory.
 *
 * @param {string} dirPath
 * @returns {{ createdAt: string, path: string }|null} `null` when the marker is
 *   absent or unreadable/malformed — unreadable never grants delete authority.
 */
export function readMarker(dirPath) {
  try {
    const parsed = JSON.parse(readFileSync(join(dirPath, MARKER_FILENAME), 'utf8'));
    if (typeof parsed?.createdAt !== 'string' || typeof parsed?.path !== 'string') return null;
    return { createdAt: parsed.createdAt, path: parsed.path };
  } catch {
    return null;
  }
}

/**
 * Write the ownership marker into `dirPath` (created on venv creation and
 * back-filled when an existing venv is adopted).
 *
 * Failures propagate to the caller (spec §6: warn, venv stays usable) — notably
 * `EISDIR` when the marker name is occupied by a directory.
 *
 * @param {string} dirPath
 * @returns {void}
 */
export function writeMarker(dirPath) {
  const marker = { createdAt: new Date().toISOString(), path: dirPath };
  writeFileSync(join(dirPath, MARKER_FILENAME), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

/**
 * Absolute path of the wrapper state file: `<homedir()>/.ppt-master/wrapper-state.json`.
 *
 * The single registration location (spec §5.4/§8) must stay **absolute**: when
 * `os.homedir()` is not a non-empty string (`HOME=''`, Node's verbatim empty-home
 * semantics — reachable in the container configuration the README recommends, where
 * `venv.path` is absolute and nothing else needs `~`), joining would silently produce
 * the *relative* `.ppt-master/wrapper-state.json`, which `writeWrapperState` would then
 * create under the host's current working directory. That breaks the "one registration
 * location under `$HOME`" contract and makes the registration depend on wherever the
 * agent happened to be invoked from, so this throws instead of degrading.
 *
 * @returns {string}
 * @throws {Error} When `os.homedir()` is not a non-empty string.
 */
export function wrapperStatePath() {
  const home = homedir();
  if (typeof home !== 'string' || home === '') {
    throw new Error(
      `wrapper-state 路径不可解析：os.homedir() 非非空字符串（HOME=${JSON.stringify(home)}），`
        + '拒绝回退为相对路径（相对登记位置会落进宿主 cwd，破坏单一登记位置契约）'
    );
  }
  return join(home, STATE_DIRNAME, STATE_FILENAME);
}

/**
 * Read the last registered venv path.
 *
 * "Absent" and "unreadable" are deliberately separate and neither throws:
 * - absent → `{ lastVenvPath: null }` — first run, nothing to clean up;
 * - unreadable/unparsable → `{ lastVenvPath: null, readError }` — the old path is
 *   unknown, so cleanup is skipped and the reason travels to the payload note.
 *
 * An unresolvable `wrapperStatePath()` (see above) is the second form, not a throw: the
 * caller's contract is to never throw and to keep "absent" apart from "unreadable".
 *
 * @returns {{ lastVenvPath: string|null, readError?: string }}
 */
export function readWrapperState() {
  try {
    const parsed = JSON.parse(readFileSync(wrapperStatePath(), 'utf8'));
    return { lastVenvPath: typeof parsed?.lastVenvPath === 'string' ? parsed.lastVenvPath : null };
  } catch (error) {
    if (error.code === 'ENOENT') return { lastVenvPath: null };
    return { lastVenvPath: null, readError: error.message };
  }
}

/**
 * Register `lastVenvPath` as the current venv path.
 *
 * The state directory is created on first write. Failures propagate to the
 * caller, which reports the registration failure without touching the install
 * result (spec §6: registration failure is not a delete failure) — including the
 * unresolvable-home guard above: a throw here keeps the "登记失败（非删除失败）" note
 * accurate instead of writing a relative file into the caller's cwd.
 *
 * @param {string} lastVenvPath
 * @returns {void}
 */
export function writeWrapperState(lastVenvPath) {
  const filePath = wrapperStatePath();
  const stateDir = dirname(filePath);
  // Only create the directory when missing: a recursive mkdir over a parent path
  // occupied by a regular file reports EEXIST, which would mask the real shape
  // mismatch — writing directly surfaces ENOTDIR instead.
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ lastVenvPath }, null, 2)}\n`, 'utf8');
}

/**
 * 同步存在性探测的共同实现：venv 目录入参 + 模块内部持有相对路径。
 *
 * 两个导出原语（`probeVenvInterpreter` / `probeVenvPip`）共用它，故"探测目标＝模块常量拼出的
 * 单一路径"在实现层也只有一处；消费方一律传 venv **目录**，不自带拼接。
 *
 * @param {*} venvDir
 * @param {string} rel 模块常量持有的相对路径（`bin/python3` / `bin/pip3`）。
 * @returns {{ found: boolean }}
 */
function probeVenvEntry(venvDir, rel) {
  if (typeof venvDir !== 'string' || venvDir === '') return { found: false };
  return { found: existsSync(join(venvDir, rel)) };
}

/**
 * Synchronous existence probe for a venv's interpreter.
 *
 * Takes the venv *directory* and appends `bin/python3` internally — consumers never
 * carry that join themselves (the probe target and `effectiveInterpreter`'s `pythonPath`
 * are the same target by construction). A dangling symlink reports `found: false`: what
 * matters is whether the target is reachable, not whether the link entry exists.
 *
 * This is a different interface from the async three-field version probe in
 * `lib/tools.js`; this one never executes anything.
 *
 * @param {string} venvDir Absolute path of the venv directory.
 * @returns {{ found: boolean }} `false` for non-string input rather than throwing.
 */
export function probeVenvInterpreter(venvDir) {
  return probeVenvEntry(venvDir, VENV_PYTHON_REL);
}

/**
 * Synchronous existence probe for a venv's **install path** (`<venvDir>/bin/pip3`).
 *
 * Same 口径 as `probeVenvInterpreter` — venv directory in, module-held relative path
 * appended internally, `found: false` for non-string input, never executes anything —
 * but a *different* export rather than a second parameter on that one: `bin/python3` is
 * what the spec §5.4 probe pins, and a parameterised target would make each call site's
 * target implicit. The two are separate entries of the same completeness question, and
 * only this module joins them (Gate 3 G3-02).
 *
 * Why it exists: `python3 -m venv` writes `pyvenv.cfg` and `bin/python3` *before*
 * ensurepip runs, so an ensurepip failure (Debian without `python3-venv`, a restricted
 * index, …) leaves a directory that passes the interpreter probe but has no installer.
 * Adopting that directory makes every later `setup_deps` fail at
 * `<absPath>/bin/pip3` ENOENT with no recovery guidance, i.e. a permanently sticky
 * half-built venv.
 *
 * @param {string} venvDir Absolute path of the venv directory.
 * @returns {{ found: boolean }} `false` for non-string input rather than throwing.
 */
export function probeVenvPip(venvDir) {
  return probeVenvEntry(venvDir, VENV_PIP_REL);
}

/**
 * Decide the effective interpreter: the four-state position plus the `path`/`exists`/
 * `pythonPath`/`invalidReason`/`broken` values that Tasks 6/7/8/9 consume verbatim.
 *
 * Decision order (spec §5.3/§5.4) — disabled beats path semantics, path semantics beat
 * the filesystem:
 * 1. `enabled === false` → `off`. The reported path is the *config value verbatim* (off
 *    never resolves) when that path is valid; the invalid×disabled combination reports
 *    `path: null` with the real reason instead, so the diagnostic stays honest while the
 *    behaviour is off either way. Nothing is probed.
 * 2. enabled and `resolveVenvPath` invalid → `invalid` (`path: null`, reason carried).
 * 3. enabled, valid, `!venvExists` → `on-missing` (resolved absolute path, not probed).
 * 4. otherwise → `on-ready`. **Ready means both halves of the adoption physical
 *    examination hold**: `<path>/bin/python3` reachable *and* `<path>/bin/pip3` present —
 *    the same two questions `ensureVenv` asks before adopting (spec §5.4). `python3 -m
 *    venv` writes `pyvenv.cfg`/`bin/python3` *before* ensurepip runs, so a machine without
 *    ensurepip (Debian/Ubuntu without `python3-venv`) leaves a half-built directory that
 *    passes the interpreter probe alone. Treating that as ready made the three consumers
 *    disagree (R2 M2): `info` reported a `pythonPath`, `check_env` rendered a version and
 *    the entry skill advertised the state-1 substitution contract, while the only surface
 *    that can repair it — `setup_deps` — refused to adopt and reported the missing
 *    installer. Such a directory is therefore the **broken sub-state**: still `on-ready`,
 *    `exists: true`, `broken: true` and `pythonPath: null` — the payload's inferable form
 *    `exists && pythonPath === null`.
 *
 * @param {{ enabled: boolean, path: string, oldPathPolicy: 'keep'|'delete' }} venv
 *   De-referenced plain config object.
 * @param {{ probeVenvInterpreter?: (venvDir: string) => { found: boolean } }} [primitives]
 *   Named primitive object. Injection keeps every caller on one probe definition and lets
 *   tests force the broken sub-state; omitted it falls back to this module's own probe, so
 *   a single-argument call (e.g. Task 5's `invalidReason` warning) still answers on-ready rows.
 *   The install-path half (`probeVenvPip`) is deliberately **not** injectable: it is part of
 *   the judgement, not a stubbable environment fact, and both halves must be read from the
 *   same directory in the same evaluation.
 * @returns {{ state: 'off'|'invalid'|'on-missing'|'on-ready', path: string|null,
 *   exists: boolean, pythonPath: string|null, invalidReason: string|null, broken: boolean }}
 */
export function effectiveInterpreter(venv, primitives = {}) {
  const probe = primitives.probeVenvInterpreter ?? probeVenvInterpreter;
  const { path: resolvedPath, invalidReason } = resolveVenvPath(venv);

  if (venv?.enabled === false) {
    return {
      state: 'off',
      path: invalidReason === null ? venv.path : null,
      exists: false,
      pythonPath: null,
      invalidReason,
      broken: false,
    };
  }

  if (invalidReason !== null) {
    return {
      state: 'invalid',
      path: null,
      exists: false,
      pythonPath: null,
      invalidReason,
      broken: false,
    };
  }

  if (!venvExists(resolvedPath)) {
    return {
      state: 'on-missing',
      path: resolvedPath,
      exists: false,
      pythonPath: null,
      invalidReason: null,
      broken: false,
    };
  }

  if (!probe(resolvedPath).found || !probeVenvPip(resolvedPath).found) {
    return {
      state: 'on-ready',
      path: resolvedPath,
      exists: true,
      pythonPath: null,
      invalidReason: null,
      broken: true,
    };
  }

  return {
    state: 'on-ready',
    path: resolvedPath,
    exists: true,
    pythonPath: join(resolvedPath, VENV_PYTHON_REL),
    invalidReason: null,
    broken: false,
  };
}

/**
 * Ensure a usable venv at `absPath` — this module's only creation/adoption primitive
 * (spec §5.4), consumed by `ppt_master_setup_deps`.
 *
 * Six mutually exclusive outcomes, every one of them a returned value:
 * 1. target absent or empty → `python3 -m venv <absPath>` + marker → `created: true`;
 * 2. target carries `pyvenv.cfg`, its interpreter probe **and** its install-path probe
 *    (`bin/pip3`) both pass → adopt: back-fill the marker only when it is missing →
 *    `created: false, adopted: true`. An existing venv is never rebuilt ("缺才建");
 * 3. same, but the interpreter probe fails (exists-but-broken) → `error` and **no**
 *    automatic deletion: the directory is left exactly as it is, for a manual fix;
 * 4. same, but the interpreter is there and `bin/pip3` is missing — the half-built shape
 *    ensurepip leaves behind → the same class of refusal with its own recovery text
 *    (Gate 3 G3-02, extended by R2 M7 with the `python3-venv` prerequisite for hosts
 *    without ensurepip). Adopting it would pin `<absPath>/bin/pip3` ENOENT into every
 *    later `setup_deps` with no guidance, so it is refused instead: no adoption, no
 *    deletion;
 * 5. target exists, is not an empty directory and is not a venv → fail-loud refusal
 *    (`error`): nothing created, no marker written, existing files untouched;
 * 6. creation fails (non-zero exit code or a rejected spawn) → `error`.
 *
 * Only outcomes 3-6 carry `error`; it travels verbatim into the payload's `venv.error`.
 * A marker write failure is deliberately *not* an outcome: the venv stays usable, so the
 * conclusion stands and the failure goes to the warn channel (see `writeMarkerWarnOnly`).
 *
 * The one thing this promise *does* reject on is an abort, which is not a failure row:
 * `signal` is forwarded into the runner, so a cancelled creation arrives either as an
 * `AbortError` rejection or as a null exit code, and both keep propagating (see
 * `throwIfAborted`) — a cancellation must never be rendered as an environment fault, let
 * alone prompt pointless environment repair. Every other rejection of `run` is folded.
 *
 * @param {(command: string, args: string[], options: { signal?: AbortSignal }) =>
 *   Promise<{ exitCode: number|null, stderr?: string }>} run Injected runner, same shape
 *   as the tools layer's spawn wrapper: it resolves with the exit code and rejects when
 *   the process never started. `signal` is forwarded into its options verbatim.
 * @param {string} absPath Absolute path of the venv directory (already resolved by the
 *   caller — this primitive never expands `~`).
 * @param {{ signal?: AbortSignal,
 *   probeVenvInterpreter?: (venvDir: string) => { found: boolean },
 *   writeMarker?: (dirPath: string) => void }} [options] Declared injection seam for the
 *   interpreter probe and the marker write; both default to this module's own primitives.
 * @returns {Promise<{ created: boolean, adopted: boolean, error?: string }>}
 * @throws {*} The abort (`signal.reason`, or the `AbortError` the runner rejected with)
 *   when the creation was cancelled — never folded into `{ created: false, error }`.
 */
export async function ensureVenv(run, absPath, options = {}) {
  const probe = options.probeVenvInterpreter ?? probeVenvInterpreter;
  const write = options.writeMarker ?? writeMarker;
  const { signal } = options;

  const shape = classifyTarget(absPath);

  if (shape === 'occupied') {
    return { created: false, adopted: false, error: '目标目录非空且非 venv' };
  }

  if (shape === 'venv') {
    if (!probe(absPath).found) {
      return {
        created: false,
        adopted: false,
        error: 'venv 解释器不可用（exists-but-broken）——手动删除该目录后重跑',
      };
    }
    // 体检的第二问：安装路径是否可用。`python3 -m venv` 在 ensurepip **之前**就写好
    // pyvenv.cfg 与 bin/python3，ensurepip 失败会留下"有解释器、无 bin/pip3"的半成品
    // （Gate 3 G3-02）。收编它等于把 `<abs>/bin/pip3` ENOENT 固化进此后每一轮 setup_deps，
    // 故与解释器损坏同类拒绝：不自动删、不写标记、给手动恢复指引。
    if (!probeVenvPip(absPath).found) {
      return {
        created: false,
        adopted: false,
        error: 'venv 内 pip3 缺失（安装不完整）——手动删除该目录后重跑；'
          + '若系统缺 ensurepip，需先安装 python3-venv',
      };
    }
    // Adoption back-fills the marker only when it is missing: a readable marker is
    // never rewritten, so re-running on an adopted venv does not churn its createdAt.
    if (readMarker(absPath) === null) writeMarkerWarnOnly(absPath, write);
    return { created: false, adopted: true };
  }

  let result;
  try {
    result = await run(PYTHON, ['-m', 'venv', absPath], { signal });
  } catch (error) {
    // An aborted spawn rejects with the abort itself; anything else is a real failure.
    if (isAbortError(error)) throw error;
    throwIfAborted(signal);
    const reason = error?.message ?? error;
    return {
      created: false,
      adopted: false,
      error: `python3 -m venv 创建失败（无法启动）: ${reason}`,
    };
  }

  if (result?.exitCode !== 0) {
    // A killed child closes with `code === null`: when that kill was our own abort it is a
    // cancellation and rethrows; a non-abort null code stays an ordinary failure row.
    throwIfAborted(signal);
    const detail = summarizeStderr(result?.stderr);
    return {
      created: false,
      adopted: false,
      error: `python3 -m venv 创建失败（退出码 ${result?.exitCode ?? 'null'}）${
        detail === '' ? '' : `: ${detail}`
      }`,
    };
  }

  writeMarkerWarnOnly(absPath, write);
  return { created: true, adopted: false };
}

/**
 * Delete a previously registered venv — this module's only deletion primitive (spec
 * §5.4), called by `ppt_master_setup_deps` after a successful install.
 *
 * Four preconditions, **all re-read from the filesystem and evaluated before anything is
 * removed**; any one of them failing returns `{ action: 'none', error: <reason> }` and
 * leaves the disk untouched:
 * 1. `oldPath !== currentPath` — never delete the venv we are about to use;
 * 2. neither path contains the other (`isPathPrefix`, checked in **both** directions) —
 *    a nested old/new pair is refused whichever way round it is spelled (Review Focus
 *    #4), so a config change cannot aim the cleanup at its own container;
 * 3. `venvExists(oldPath)` — `pyvenv.cfg` present, i.e. it really is a venv;
 * 4. `readMarker(oldPath)` non-null — the ownership marker is the deletion
 *    authorization, and an unreadable or malformed marker grants nothing.
 *
 * Conditions 1-2 are decided on **canonical** paths (`canonicalForJudgment`), because both
 * questions are about *which directory* a path denotes, not about how it is spelled, and
 * because conditions 3-4 plus `remove()` act on the caller's spelling as the **filesystem**
 * resolves it (`rmSync`/`existsSync` follow symlinks and apply `..` to the resolved parent).
 * A purely textual reading let every variant through to `remove()` (Gate 3 G3-01
 * — reproduced as `action: 'deleted'` on the venv in use):
 * - textual spellings (`<b>//venv`, `<b>/./venv`, `<b>/sub/../venv`) are refused by the
 *   text-resolve equality check first — stricter than canonical, never looser;
 * - the same entity reached by different names (`/…/link/venv` vs `/…/real/venv`, or a
 *   venv directory symlink) is refused by canonical equality;
 * - a shared `dev+ino` (bind mounts, aliases `realpath` does not fold) is refused by the
 *   `dev+ino` positive evidence — only when both sides stat with non-zero dev and ino
 *   (Gate 3 R2 M8: degenerate filesystems otherwise match everything);
 * - ancestry across a symlinked parent, and ancestry hidden behind `..` applied to a
 *   symlink (`<p>/link/../venv` with link→`<q>/sub` is `<q>/venv`), is refused by the
 *   segment-aware prefix check on canonical forms (Gate 3 R2 M1).
 * Canonicalisation is used for the **judgement only**: `remove()` still receives the
 * caller's `oldPath` verbatim, so the deletion target keeps its original spelling
 * semantics. (Conditions 3-4 build their probe paths with `join`, which folds `..`
 * *textually*: when the caller's `..` sits behind a symlink they look at the
 * text-collapsed location and refuse — conservative and unchanged, and the reason the
 * canonical judgement has to run **before** them.)
 *
 * Only with all four true does the policy decide: exactly `'delete'` calls
 * `remove(oldPath)`, while anything else (the config default `'keep'`, or an unknown
 * value) is `'kept'` with nothing removed. A `remove` failure is reported as
 * `{ action: 'failed', error }` and is never rethrown (spec §6), so the caller keeps its
 * install conclusion and merely attaches the note.
 *
 * Re-reading the preconditions every call is what makes the half-deleted retry work
 * (spec §5.4 residual risk ②): a deletion that dies midway leaves `pyvenv.cfg` and the
 * marker in place, so the next run still satisfies all four conditions and tries again
 * rather than declaring the target already handled.
 *
 * @param {string} oldPath Previously registered venv path (absolute; never `~`).
 * @param {'keep'|'delete'} policy De-referenced `venv.oldPathPolicy`.
 * @param {string} currentPath The venv path in use now (absolute).
 * @param {{ remove?: (dirPath: string) => void }} [options] Declared deletion seam:
 *   defaults to `rmSync(dirPath, { recursive: true, force: true })`; tests inject a
 *   throwing stub to manufacture a deletion failure.
 * @returns {{ action: 'none'|'kept'|'deleted'|'failed', error?: string }} `error` carries
 *   the refusal reason on `'none'` (a note, not a delete failure) and the failure detail
 *   on `'failed'`.
 */
export function cleanupOldVenv(oldPath, policy, currentPath, { remove = removeVenvDir } = {}) {
  // 条件①②的判定一律在 canonical 路径上进行（见上方文档）：文本别名、符号链接别名、以及
  // `..` 作用在符号链接上的拼写都可能指向"本次正在使用的 venv"或落在它的祖先/内部，纯文本
  // 比较会让它们全部放行。删除目标不变（remove(oldPath)）。
  const textOld = normalizeForJudgment(oldPath);
  const textCurrent = normalizeForJudgment(currentPath);
  const canonicalOld = canonicalForJudgment(oldPath);
  const canonicalCurrent = canonicalForJudgment(currentPath);

  if (textOld === textCurrent) {
    return { action: 'none', error: `旧路径与当前路径相同，拒绝删除：${oldPath}` };
  }

  if (canonicalOld === canonicalCurrent) {
    return {
      action: 'none',
      error: `旧路径与当前路径指向同一实体（realpath 同实体，拒绝删除）：oldPath=${oldPath}, currentPath=${currentPath}`,
    };
  }

  if (sameDeviceAndInode(oldPath, currentPath)) {
    return {
      action: 'none',
      error: `旧路径与当前路径指向同一实体（dev+ino 同实体，拒绝删除）：oldPath=${oldPath}, currentPath=${currentPath}`,
    };
  }

  if (isPathPrefix(canonicalOld, canonicalCurrent) || isPathPrefix(canonicalCurrent, canonicalOld)) {
    return {
      action: 'none',
      error: `新旧路径互相前缀包含（嵌套配置，拒绝删除）：oldPath=${oldPath}, currentPath=${currentPath}`,
    };
  }

  if (!venvExists(oldPath)) {
    return { action: 'none', error: `旧路径不存在或缺 pyvenv.cfg（非 venv），拒绝删除：${oldPath}` };
  }

  if (readMarker(oldPath) === null) {
    return { action: 'none', error: `旧路径缺所有权标记（未标记目录永不自动删）：${oldPath}` };
  }

  if (policy !== 'delete') return { action: 'kept' };

  try {
    remove(oldPath);
  } catch (error) {
    return { action: 'failed', error: `旧 venv 删除失败（${oldPath}）: ${error?.message ?? error}` };
  }
  return { action: 'deleted' };
}

// ─── Config 边界：去引用快照 + 统一注入包（Task 5）──────────────

/**
 * venv 三字段的默认值（spec §5.1），逐字。
 *
 * 缺省补默认在系统里有**两个提供者**且不可互相替代：cordis 用 Config schema 的
 * `meta.default` 填 loader 路径（校验后必含三叶子），这里填测试/嵌入形态（缺 `venv`
 * 键或省略 opts）。两处取值必须逐字一致，故默认值只在此定义一份。
 */
const VENV_DEFAULTS = Object.freeze({
  enabled: false,
  path: '~/.ppt-master/venv',
  oldPathPolicy: 'keep',
});

/**
 * 叶子是否为宿主 `.volatile()` 的引用对象。
 *
 * 判据只有 `.get()` 鸭子类型——`.volatile()` 经 cosmokit `createVolatile` 把解析值
 * 包成 `Object.freeze({ get, [write]: ... })`，而 `write` 是 cosmokit 私有 symbol，
 * 本插件零 npm 依赖、拿不到该 symbol（spec §5.1 钉死的检测面即 `.get()`）。
 *
 * @param {*} value
 * @returns {boolean}
 */
function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && typeof value.get === 'function';
}

/**
 * 单个叶子去引用：引用对象取 `.get()`，普通值原样；缺键/`undefined` 取默认值。
 *
 * `null` 视作**配置值**（非缺省）原样保留——它是 `resolvable` 判定的输入，静默替换成
 * 默认值会把无效配置伪装成默认配置，与 §6 配置无效降级行冲突。
 *
 * @param {*} value 引用对象或普通值。
 * @param {*} fallback 该字段的默认值。
 * @returns {*}
 */
function dereferenceLeaf(value, fallback) {
  const plain = isVolatileRef(value) ? value.get() : value;
  return plain === undefined ? fallback : plain;
}

/**
 * 去引用快照：把 loader 形态的 venv 引用袋拍成普通值三字段（spec §5.1 apply 边界）。
 *
 * 唯一形态差转换点——下游接口签名一律按普通值，不感知 volatile 引用。快照是**值的**
 * 转换而非校验：无效路径（相对/不可解析）原样留在快照内，有效性与行为层降级由
 * `effectiveInterpreter` 判定（apply 只取同一次求值的 `invalidReason` 供 warn）。
 *
 * @param {{ enabled?: *, path?: *, oldPathPolicy?: * }} [raw] venv 子对象；loader 形态下
 *   三叶子为 `.get()` 引用对象，测试/嵌入形态下可含普通值或缺键。
 * @returns {{ enabled: boolean, path: string, oldPathPolicy: 'keep'|'delete' }} 普通值
 *   三字段（缺省处已填 `VENV_DEFAULTS`）。
 */
export function snapshotVenvConfig(raw) {
  return {
    enabled: dereferenceLeaf(raw?.enabled, VENV_DEFAULTS.enabled),
    path: dereferenceLeaf(raw?.path, VENV_DEFAULTS.path),
    oldPathPolicy: dereferenceLeaf(raw?.oldPathPolicy, VENV_DEFAULTS.oldPathPolicy),
  };
}

/**
 * 工厂入口的 venv 归一化：把"测试/嵌入形态"的 venv 子对象补成三字段完整普通值。
 *
 * 存在的理由（Gate 3 G3-09）：`effectiveInterpreter` 的判定序是
 * `venv?.enabled === false` → `off`，故**缺 `enabled` 键**的对象会被当成"已启用"——
 * 直呼工厂（`createTools({venv:{path:'/abs'}})` / `createSkillProvider(undefined,{venv})`）
 * 时 `{path}` 这类部分对象会静默开启 venv，`ppt_master_setup_deps` 于是真的去建目录、装依赖。
 * 生产路径不受影响（cordis 已按 Config schema 填好三叶子），风险面是测试与嵌入方。
 *
 * 归一化落在**工厂入口**而不是改判定序：判定序与逐行语义是 spec §5.3/§5.4 钉死的对外契约
 * （`off` 行 `path` 按配置原样、`invalid` 行 `path=null` 等），"把配置输入补齐"本来就是入口的
 * 职责。判据是严格 `=== true`：除字面 `true` 外一律关闭（缺失/`undefined`/非布尔同判）。
 *
 * `venv` 键**整体缺省或为 `null`** 时原样返回：那是"未配置"（经判定落 `invalid`、`path=null`，
 * tools/provider 的既有用例钉死的语义），与"配置了一个空袋"（补默认值 → 合法路径 + 关闭 → `off`
 * 行）是两回事，不得混同。
 *
 * 其余字段缺省处一律取 `VENV_DEFAULTS`——默认值只有这一份字面量（cordis 侧由 Config schema 的
 * `meta.default` 提供，两处逐字一致是既有约束）。
 *
 * @param {*} venv 直呼工厂时传入的 venv 子对象（普通值；引用袋由 `snapshotVenvConfig` 先折旧）。
 * @returns {*} 三字段完整普通值；`undefined`/`null` 原样返回。
 */
export function normalizeVenvInput(venv) {
  if (venv === undefined || venv === null) return venv;
  return {
    enabled: venv.enabled === true,
    path: venv.path === undefined ? VENV_DEFAULTS.path : venv.path,
    oldPathPolicy: venv.oldPathPolicy === undefined
      ? VENV_DEFAULTS.oldPathPolicy
      : venv.oldPathPolicy,
  };
}

/**
 * 组装 apply 的统一注入包 `{skillRoots, venv}`（Task 5 Produces）。
 *
 * `skillRoots` **原样透传**（同一引用、不复制不改写；缺省即 `undefined`，由消费方决定
 * 包内默认根），`venv` 经 `snapshotVenvConfig` 去引用并补默认。两键共存只在测试/嵌入
 * 路径成立：loader 传入的 config 永不带 `skillRoots`（它只承载 Config schema 的字段）。
 *
 * 包内**不含** `invalidReason`——无效/生效判定唯独经 `effectiveInterpreter` 求值一次，
 * 由各消费方自行取值，不在此另立判定路径、不做行为层降级（注入包保留原值）。
 *
 * @param {{ skillRoots?: string[], venv?: object }} [raw] apply 第二参（loader 形态＝
 *   经 cordis 校验的 config；测试/嵌入形态＝`{skillRoots}` 或省略）。
 * @returns {{ skillRoots: string[]|undefined, venv: { enabled: boolean, path: string,
 *   oldPathPolicy: 'keep'|'delete' } }}
 */
export function assembleInjectionBag(raw) {
  return {
    skillRoots: raw?.skillRoots,
    venv: snapshotVenvConfig(raw?.venv),
  };
}
