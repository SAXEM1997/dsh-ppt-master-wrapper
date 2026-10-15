/**
 * venv path / ownership-marker / wrapper-state primitives.
 *
 * Task 1 of the venv-isolation feature: the lowest layer every other venv module
 * consumes (`lib/skill-provider.js` and `lib/tools.js` reach it through Tasks 2-9).
 * Everything here is plain synchronous `node:fs`/`node:os`; the module has no
 * import-time side effects and touches exactly two locations:
 *
 * - `<venv>/.ppt-master-wrapper.json` — the ownership marker. Only a marked
 *   directory may ever be deleted by the cleanup path (spec §5.4), so the marker
 *   is written on creation *and* back-filled when an existing venv is adopted.
 * - `<homedir()>/.ppt-master/wrapper-state.json` — the last installed venv path,
 *   consulted by `cleanupOldVenv` (Task 4). Its directory is created on first
 *   write.
 *
 * Contract notes that downstream tasks depend on:
 * - `resolveVenvPath` is *pure path semantics*: `enabled` plays no part here, and
 *   an unresolvable `~` (empty `os.homedir()`, i.e. `HOME=''`) yields
 *   `invalidReason: 'unresolvable'` rather than a root-level `/.ppt-master/...`.
 * - "absent" and "unreadable" are distinct wrapper-state outcomes: absent is the
 *   first-run initialisation semantic (no `readError` key), unreadable means the
 *   old path is unknown (skip cleanup, attach `readError`). Neither read throws.
 * - Writes deliberately do not swallow errors: `writeMarker` /
 *   `writeWrapperState` propagate to their caller, which decides between the
 *   warn channel (marker, spec §6) and the payload note (registration).
 *
 * `snapshotVenvConfig` and `assembleInjectionBag` are appended to this same
 * module later by Task 5 and are intentionally absent here.
 *
 * @module dsh-ppt-master-wrapper/lib/venv
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/** Ownership marker written into every wrapper-created or wrapper-adopted venv. */
export const MARKER_FILENAME = '.ppt-master-wrapper.json';

/** A directory is a venv iff it carries this file (stdlib venv layout, POSIX). */
const PYVENV_CFG = 'pyvenv.cfg';

/** Wrapper state directory/file under `$HOME` (single registration location). */
const STATE_DIRNAME = '.ppt-master';
const STATE_FILENAME = 'wrapper-state.json';

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
 * @returns {string}
 */
export function wrapperStatePath() {
  return join(homedir(), STATE_DIRNAME, STATE_FILENAME);
}

/**
 * Read the last registered venv path.
 *
 * "Absent" and "unreadable" are deliberately separate and neither throws:
 * - absent → `{ lastVenvPath: null }` — first run, nothing to clean up;
 * - unreadable/unparsable → `{ lastVenvPath: null, readError }` — the old path is
 *   unknown, so cleanup is skipped and the reason travels to the payload note.
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
 * result (spec §6: registration failure is not a delete failure).
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
