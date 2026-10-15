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
 * Task 2 appends the four-state `effectiveInterpreter` decision plus its synchronous
 * `probeVenvInterpreter` existence probe. That probe is *not* the async three-field
 * version probe in `lib/tools.js` (`{found, version, meetsSkillRequirement}`): it answers
 * only "is `<venvDir>/bin/python3` visible", taking the venv directory as its argument.
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

/**
 * Interpreter path relative to a venv root (POSIX layout). Held once so the existence
 * probe and `effectiveInterpreter`'s `pythonPath` are provably the same target.
 */
const VENV_PYTHON_REL = join('bin', 'python3');

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
  if (typeof venvDir !== 'string' || venvDir === '') return { found: false };
  return { found: existsSync(join(venvDir, VENV_PYTHON_REL)) };
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
 * 4. otherwise → `on-ready`. When the probe finds no interpreter this is the
 *    exists-but-broken sub-state: still `on-ready`, `exists: true`, `broken: true` and
 *    `pythonPath: null` — the payload's inferable form `exists && pythonPath === null`.
 *
 * @param {{ enabled: boolean, path: string, oldPathPolicy: 'keep'|'delete' }} venv
 *   De-referenced plain config object.
 * @param {{ probeVenvInterpreter?: (venvDir: string) => { found: boolean } }} [primitives]
 *   Named primitive object. Injection keeps every caller on one probe definition and lets
 *   tests force the broken sub-state; omitted it falls back to this module's own probe, so
 *   a single-argument call (e.g. Task 5's `invalidReason` warning) still answers on-ready rows.
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

  if (!probe(resolvedPath).found) {
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
