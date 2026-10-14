/**
 * Tool definitions for the ppt-master wrapper.
 *
 * Task 4 shipped this module as a **stub** with three placeholder definitions;
 * Tasks 5-7 replaced them one by one with real implementations
 * (`ppt_master_info`, `ppt_master_check_env`, `ppt_master_setup_deps`), so the
 * placeholder machinery is gone and nothing here returns an empty payload.
 *
 * The contract these definitions satisfy (verified against the bundled SDK in
 * `@deepseek-ai/dsh-tools`):
 * - `ctx.tools.register()` rejects a definition without
 *   `output: { schema, render }` (TypeError) and runs the schema through
 *   `assertSupportedJsonSchema`, which admits only the enforced JSON Schema
 *   subset (type/oneOf/properties/required/additionalProperties/items/enum/
 *   const + annotations).
 * - `output.schema` is deliberately **not** written as `type: 'json'`: that
 *   author-only node is silently compiled down to an empty (annotation-only)
 *   contract, which would not describe the real payload.
 * - Every object node carries an explicit `additionalProperties`, which is
 *   what `defineTool`'s value-schema path demands; writing it everywhere is
 *   this package's encoding convention.
 * - A nullable field cannot be written as a type array (the SDK rejects
 *   `type: ['string','null']`); `oneOf: [{type:'string'},{type:'null'}]` is the
 *   enforced-subset spelling, and it survives `defineTool` compilation.
 *
 * @module dsh-ppt-master-wrapper/lib/tools
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { listSkillDirs, parseFrontmatter } from './skill-provider.js';

/** The upstream skill name the primary directory is anchored on. */
const PRIMARY_SKILL_NAME = 'ppt-master';

/**
 * The upstream repository this package vendors from — the constant the info
 * tool reports and the one the sync script's default `--repo` is built from
 * (spec §3.5 / §4: `…/ppt-master` plus the `.git` suffix the clone URL needs).
 */
export const UPSTREAM_REPOSITORY = 'https://github.com/hugohe3/ppt-master';

/** This package's own `skills/` directory, located from the module, never from cwd. */
const PACKAGED_SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url));

/** This package's own manifest, read for the reported plugin version. */
const PACKAGE_JSON_PATH = fileURLToPath(new URL('../package.json', import.meta.url));

/** The empty parameter schema shared by the two argument-less tools. */
function noParameters() {
  return { type: 'object', properties: {}, additionalProperties: false };
}

/**
 * Build the tool definitions this plugin registers.
 *
 * @param {{ skillRoots?: string[] }} [options] Optional skill-root override,
 *   mirroring `apply()`'s test/embedding hook: all three tools resolve their
 *   SKILL_DIR/packaged `skills/` scan from these roots instead of the packaged
 *   ones. Omitted (the production path) means the packaged root.
 * @returns {Array<{ name: string, description: string, parameters: object,
 *   output: { schema: object, render: (args: object, value: object) => string },
 *   execute: (args: object, exec: object) => Promise<object> }>} Exactly three
 *   definitions, in registration order.
 */
export function createTools(options) {
  return [
    infoTool(options),
    checkEnvTool(options),
    setupDepsTool(options),
  ];
}

// ─── ppt_master_info ─────────────────────────────────────────────

/**
 * The model-facing payload schema: object-rooted, explicitly closed, and
 * declaring exactly the seven fields `execute()` returns.
 */
function infoOutputSchema() {
  return {
    type: 'object',
    properties: {
      pluginVersion: { type: 'string' },
      // Nullable: a primary skill without `metadata.version` reports null.
      upstreamVersion: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      skillDirs: { type: 'array', items: { type: 'string' } },
      primarySkillDir: { type: 'string' },
      primarySkillName: { type: 'string' },
      primaryIsFallback: { type: 'boolean' },
      repository: { type: 'string' },
    },
    additionalProperties: false,
  };
}

/**
 * Resolve the effective skill roots: an explicit `createTools()` override wins,
 * otherwise a per-call `exec.skillRoots` (the same injection shape `apply()`
 * exposes) is honoured, otherwise the packaged `skills/`.
 */
function rootOverride(roots, exec) {
  if (Array.isArray(roots) && roots.length > 0) return roots;
  const perCall = exec?.skillRoots;
  return Array.isArray(perCall) && perCall.length > 0 ? perCall : undefined;
}

/**
 * `ppt_master_info`: report which skills this package wraps and which of them is
 * the primary `ppt-master` skill. Pure read — nothing is written, and no file
 * outside this package and the scanned roots is touched.
 *
 * Anchoring: the primary directory is the skill whose frontmatter `name` is
 * `ppt-master` (`primaryIsFallback: false`). When no directory matches, the
 * first directory in **byte order** becomes primary and `primaryIsFallback` is
 * `true` — the fallback is announced in the payload rather than thrown, so a
 * renamed or absent本体 skill still yields a usable SKILL_DIR.
 */
function infoTool(options) {
  const roots = options?.skillRoots;
  return {
    name: 'ppt_master_info',
    description: '查询包裹的 ppt-master 技能信息 / Inspect the wrapped ppt-master skill info',
    parameters: noParameters(),
    output: {
      schema: infoOutputSchema(),
      // Model-facing rendering: a compact, greppable block. Every value comes
      // from the validated payload, so the text can never disagree with it.
      render: (args, info) => renderInfo(info),
    },
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted();
      const scanRoots = rootOverride(roots, exec) ?? [PACKAGED_SKILLS_ROOT];
      const skillDirs = scanRoots.flatMap((root) => listSkillDirs(root));
      if (skillDirs.length === 0) {
        // Empty skills root is not a legal runtime state: without a skill there
        // is no SKILL_DIR to report and the wrapper is broken, so fail loud.
        throw new Error(
          `ppt_master_info: no skill directory found under roots（不存在或为空）: ${scanRoots.join(', ')}`,
        );
      }

      const skills = skillDirs.map((directory) => readSkill(directory));
      const anchored = skills.find((skill) => skill.name === PRIMARY_SKILL_NAME);
      const primary = anchored ?? skills[0];
      exec?.signal?.throwIfAborted();

      return {
        pluginVersion: readPluginVersion(),
        upstreamVersion: primary.version,
        skillDirs,
        primarySkillDir: primary.directory,
        primarySkillName: primary.name,
        primaryIsFallback: anchored === undefined,
        repository: UPSTREAM_REPOSITORY,
      };
    },
  };
}

/**
 * Read one skill directory's identity: its frontmatter `name` and
 * `metadata.version`.
 *
 * A SKILL.md that is missing, or that carries no parsable frontmatter, still
 * yields a directory — the info tool reports what it can rather than refusing to
 * describe the tree (the provider is the layer that fails loud on illegal
 * skills). A missing/non-string `metadata.version` reports `null`.
 */
function readSkill(directory) {
  const skillFile = join(directory, 'SKILL.md');
  const parsed = existsSync(skillFile) ? parseFrontmatter(readFileSync(skillFile, 'utf8')) : null;
  const data = parsed?.data ?? {};
  const name = typeof data.name === 'string' && data.name.trim() !== '' ? data.name.trim() : null;
  const metadata = data.metadata;
  const version =
    typeof metadata === 'object' && metadata !== null && typeof metadata.version === 'string'
      ? metadata.version
      : null;
  // The directory name is a truthful label even without frontmatter; `name`
  // stays reportable (never null) because the schema declares it a string.
  return { directory, name: name ?? baseName(directory), version };
}

/** The plugin's own version, read from the packaged manifest. */
function readPluginVersion() {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  return typeof manifest.version === 'string' ? manifest.version : '';
}

/** The final path segment of a path. */
function baseName(path) {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? path : path.slice(separator + 1);
}

/** Render the info payload for the model. */
function renderInfo(info) {
  return [
    `ppt-master plugin: ${info.pluginVersion} (upstream skill ${info.upstreamVersion ?? 'unknown'})`,
    `repository: ${info.repository}`,
    `primary skill: ${info.primarySkillName}${info.primaryIsFallback ? ' (fallback: no skill named ppt-master)' : ''}`,
    `SKILL_DIR: ${info.primarySkillDir}`,
    `skill dirs (${info.skillDirs.length}):`,
    ...info.skillDirs.map((directory) => `  - ${directory}`),
  ].join('\n');
}

// ─── ppt_master_check_env ────────────────────────────────────────

/**
 * Built-in distribution → import-name map.
 *
 * A dependency's *distribution* name is what the requirements file lists and
 * what `importlib.metadata` is asked about; its *import* name is a different
 * string that cannot be derived mechanically (`PyYAML` → `yaml`). Two different
 * distributions can even share an import name, so `deps[].importName` is
 * metadata the probe is expected to hand out — this table is the offline
 * fallback, and `'UNKNOWN'` is a first-class answer for anything not listed
 * (never a guess).
 *
 * Keys are lower-cased distribution names; `mapDistToImport` normalises lookups.
 */
export const DIST_TO_IMPORT = {
  pyyaml: 'yaml',
  pillow: 'PIL',
  'python-pptx': 'pptx',
  beautifulsoup4: 'bs4',
  pymupdf: 'fitz',
  'skia-pathops': 'pathops',
  xlsxwriter: 'xlsxwriter',
  'google-genai': 'google.genai',
  'edge-tts': 'edge_tts',
};

/**
 * The smallest Python the upstream skill supports. Purely **informational** in
 * this tool: it is reported through `python.meetsSkillRequirement` and never
 * turns the probe into a tool-level failure (spec §3.5 / §4.1 step 4 — only
 * `ppt_master_setup_deps` owns install-time exit codes).
 */
export const MINIMUM_PYTHON = { major: 3, minor: 10 };

/** Minimum Python as a comparable number (`3.10` → `310`). */
const MINIMUM_PYTHON_NUMBER = MINIMUM_PYTHON.major * 100 + MINIMUM_PYTHON.minor;

/**
 * `parseRequirements(text)`: the top-level distribution names of a requirements
 * file.
 *
 * Every line is reduced to at most one entry:
 * - comments are cut at `#` (whole-line and trailing alike) and blank lines drop out;
 * - option lines (`-r other.txt`, `-e .`, `--index-url …`) never name a
 *   distribution and are dropped — includes are **not** followed, so the parser
 *   stays pure and dependency-free;
 * - environment markers (`; python_version < "3.12"`) and everything else after
 *   the first space are cut, which also removes every specifier spelling
 *   (`==`, `>=`, `~=`, `!=`, bare `<`);
 * - extras (`python-pptx[image]`) are stripped down to the base name.
 *
 * Names are **lower-cased** (`PyYAML`/`pyyaml` are one distribution) and
 * de-duplicated keeping first-appearance order, so the returned list has the
 * same shape as the `deps` array it feeds.
 *
 * @param {string} text Raw requirement lines.
 * @returns {string[]} Lower-cased distribution names, de-duplicated, in file order.
 */
export function parseRequirements(text) {
  if (typeof text !== 'string' || text === '') return [];
  const seen = new Set();
  const dists = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (line === '' || line.startsWith('-')) continue;
    // A trailing comment/continuation may leave a dangling continuation slash.
    const token = line.split(/\s+/)[0].replace(/\\$/, '');
    const withoutExtras = token.split('[')[0];
    const name = withoutExtras.split(/[<>=!~;]/)[0].trim();
    if (name === '') continue;
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    dists.push(normalized);
  }
  return dists;
}

/**
 * `mapDistToImport(dist)`: look a distribution name up in `DIST_TO_IMPORT`,
 * case-insensitively. A distribution this table does not know about yields the
 * literal `'UNKNOWN'` — the honest answer, never a guessed module name.
 *
 * @param {string} dist Distribution name.
 * @returns {string} The import name, or `'UNKNOWN'`.
 */
export function mapDistToImport(dist) {
  if (typeof dist !== 'string' || dist === '') return 'UNKNOWN';
  return DIST_TO_IMPORT[dist.toLowerCase()] ?? 'UNKNOWN';
}

/**
 * The dependency-probe payload schema: object-rooted, explicitly closed at
 * **every** object level (the `python` sub-object, each of the two `guard`
 * variants and each `deps` element included), nullable fields spelled as
 * `oneOf` rather than a type array, and — as everywhere in this module — no
 * `type: 'json'` node.
 *
 * `installed` is a three-state field (`true` / `false` / the string
 * `'UNKNOWN'`), which the oneOf spelling is exactly for: `false` means the
 * distribution is provably absent, `'UNKNOWN'` means the probe could not decide.
 */
function checkEnvOutputSchema() {
  return {
    type: 'object',
    properties: {
      python: {
        type: 'object',
        properties: {
          found: { type: 'boolean' },
          // Nullable: absent interpreter, or a `--version` line we cannot parse.
          version: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          // Nullable tri-state: unknown / below the skill's floor / at or above.
          meetsSkillRequirement: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
        },
        required: ['found', 'version', 'meetsSkillRequirement'],
        additionalProperties: false,
      },
      guard: {
        oneOf: [
          {
            type: 'object',
            properties: {
              ran: { type: 'boolean', const: true },
              exitCode: { type: 'number' },
            },
            required: ['ran', 'exitCode'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { skipped: { type: 'boolean', const: true } },
            required: ['skipped'],
            additionalProperties: false,
          },
        ],
      },
      deps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            dist: { type: 'string' },
            importName: { type: 'string' },
            installed: { oneOf: [{ type: 'boolean' }, { type: 'string', const: 'UNKNOWN' }] },
            source: { type: 'string', enum: ['metadata', 'import', 'unknown'] },
          },
          required: ['dist', 'importName', 'installed', 'source'],
          additionalProperties: false,
        },
      },
      envFileExists: { type: 'boolean' },
    },
    additionalProperties: false,
  };
}

/**
 * `ppt_master_check_env`: report whether this machine can run the wrapped skill.
 *
 * The probe is **diagnostic, never fatal** (spec §3.5): a missing interpreter,
 * an unreadable requirements file, a failing guard script and an inconclusive
 * metadata query all come back as describe-the-situation values instead of
 * thrown errors. Only an aborted `exec.signal` stops the call.
 *
 * Distribution state is decided **from package metadata first** — one
 * `python3 -c "import importlib.metadata; …"` subprocess per distribution — and
 * the three outcomes are kept strictly distinct:
 * - exit `0` with a version → `installed: true`, `source: 'metadata'`;
 * - exit `1` reporting `PackageNotFoundError` → `installed: false`,
 *   `source: 'metadata'` (the distribution is provably not installed);
 * - any other python-level failure (`ImportError`, `MemoryError`, …), an empty
 *   answer, or a `spawn`-level failure such as `ENOENT` → `'UNKNOWN'` with
 *   `source: 'unknown'`. A failed probe is **not** evidence of absence, so this
 *   case may never be reported as `false`.
 *
 * No `.env` file is ever read: `envFileExists` is an existence test only, so the
 * tool cannot leak or mis-handle secrets.
 *
 * @param {{ skillRoots?: string[] }} [options] The same root override
 *   `ppt_master_info` honours, used here to locate SKILL_DIR.
 */
function checkEnvTool(options) {
  const roots = options?.skillRoots;
  return {
    name: 'ppt_master_check_env',
    description: '探测 ppt-master 的 Python3 与依赖环境 / Probe the ppt-master Python3 and dependency environment',
    parameters: noParameters(),
    output: {
      schema: checkEnvOutputSchema(),
      render: (args, diagnostic) => renderCheckEnv(diagnostic),
    },
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted();
      const run = makeRun(exec);
      const signal = exec?.signal ?? null;
      const skillDir = locateSkillDir(roots, exec);

      // Requirements come from an explicit path (the model may hand one over)
      // or from SKILL_DIR, and a missing/unreadable file is simply "no deps to
      // probe" — the probe itself must never fail loud.
      const requirementsPath =
        typeof args?.requirementsPath === 'string' && args.requirementsPath !== ''
          ? args.requirementsPath
          : skillDir === null
            ? null
            : join(skillDir, 'requirements.txt');
      const deps = parseRequirements(readTextOrNull(requirementsPath));

      const python = await probePython(run, signal);
      const guard = await probeGuard(run, skillDir, python.found, signal);
      const dependencyState = await probeDependencies(deps, run, python.found, signal);

      exec?.signal?.throwIfAborted();
      return {
        python,
        guard,
        deps: dependencyState,
        // Existence only — the file's contents are never read (spec §3.5).
        envFileExists: skillDir !== null && existsSync(join(skillDir, '.env')),
      };
    },
  };
}

/**
 * Locate SKILL_DIR the same way `ppt_master_info` does: the skill directory
 * whose frontmatter names `ppt-master`, else the first in byte order, else
 * `null` when the roots hold no skill at all.
 *
 * This never throws where `ppt_master_info` does — `check_env` is a diagnostic,
 * so an absent root or an empty root is a condition to *report* (no `SKILL_DIR`
 * means the guard is skipped), not a reason to fail the call.
 */
function locateSkillDir(roots, exec) {
  const scanRoots = rootOverride(roots, exec) ?? [PACKAGED_SKILLS_ROOT];
  const skillDirs = scanRoots.flatMap((root) => {
    try {
      return listSkillDirs(root);
    } catch {
      return []; // missing/not-a-directory root: nothing to anchor on
    }
  });
  if (skillDirs.length === 0) return null;
  const skills = skillDirs.map((directory) => readSkill(directory));
  return (skills.find((skill) => skill.name === PRIMARY_SKILL_NAME) ?? skills[0]).directory;
}

/** Read a text file, or `null` when it is absent or unreadable. */
function readTextOrNull(path) {
  if (path === null || !existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The subprocess helper every probe goes through.
 *
 * An injected `exec.run` always wins and is handed `(command, args, options)`
 * verbatim, which is what makes these probes stubbable without a real Python.
 * Without one, the packaged implementation spawns the process itself — the
 * production path — and `options.signal` is threaded through the injected case
 * so a cancelled call can abort a running child.
 */
function makeRun(exec) {
  return typeof exec?.run === 'function' ? exec.run : spawnRun;
}

/**
 * The built-in `exec.run`: spawn `command`, capture stdout/stderr, and never
 * reject on a non-zero exit (only on a genuine spawn error such as `ENOENT`).
 *
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number|null }>}
 */
function spawnRun(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { signal: options?.signal ?? undefined });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
  });
}

/** The interpreter every probe shells out to (`python3`, per brief). */
const PYTHON = 'python3';

/** The error codes that mean "the process never started". */
const SPAWN_FAILURE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR']);

/**
 * Classify a `run` rejection. Returns `true` when the child never started (a
 * spawn-level failure) and `false` for anything else — an abort must keep
 * propagating rather than be reported as a missing interpreter.
 */
function isUnknownCommand(error) {
  if (error === null || typeof error !== 'object') return false;
  if (typeof error.code === 'string' && SPAWN_FAILURE_CODES.has(error.code)) return true;
  return false;
}

/**
 * Probe the interpreter: `python3 --version`.
 *
 * A spawn failure means "no python3 here" — `found: false` and a `null` version
 * — reported as a value, never thrown (spec §3.5: `check_env` never fails a
 * call). `meetsSkillRequirement` stays `null` whenever the version could not be
 * established or parsed.
 */
async function probePython(run, signal) {
  const absent = { found: false, version: null, meetsSkillRequirement: null };
  let result;
  try {
    result = await run(PYTHON, ['--version'], { signal });
  } catch (error) {
    if (isUnknownCommand(error)) return absent;
    throw error;
  }
  if (!result || typeof result.exitCode !== 'number' || result.exitCode !== 0) return absent;
  const version = parsePythonVersion(result.stdout ?? result.stderr ?? '');
  if (version === null) return absent;
  return {
    found: true,
    version,
    meetsSkillRequirement: toVersionNumber(version) >= MINIMUM_PYTHON_NUMBER,
  };
}

/** `Python 3.11.2` (either stream) → `'3.11.2'`; anything else → `null`. */
function parsePythonVersion(text) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text));
  return match === null ? null : match[0];
}

/** `'3.11.2'` → `311`; unparsable → `-1` (below every floor). */
function toVersionNumber(version) {
  const [major, minor] = version.split('.');
  return Number(major) * 100 + Number(minor);
}

/**
 * Probe the attribution guard: run `${SKILL_DIR}/scripts/attribution_guard.py`.
 *
 * The guard's exit code is **recorded, not interpreted** — a non-zero code may
 * be the guard's own verdict and is never mapped onto a tool-level failure
 * (spec §3.5: only `setup_deps` owns install-time failures). The probe is
 * skipped when there is no python3 or no SKILL_DIR to run it from.
 */
async function probeGuard(run, skillDir, pythonFound, signal) {
  if (!pythonFound || skillDir === null) return { skipped: true };
  const script = join(skillDir, 'scripts', 'attribution_guard.py');
  let result;
  try {
    result = await run(PYTHON, [script], { signal });
  } catch (error) {
    if (isUnknownCommand(error)) return { skipped: true };
    throw error;
  }
  return { ran: true, exitCode: typeof result?.exitCode === 'number' ? result.exitCode : -1 };
}

/**
 * Probe every listed distribution, one metadata subprocess each.
 *
 * Running them one at a time keeps each verdict independent: one broken query
 * degrades exactly one entry to `'UNKNOWN'` instead of poisoning the batch.
 */
async function probeDependencies(dists, run, pythonFound, signal) {
  const installed = [];
  for (const dist of dists) {
    installed.push(await probeDependency(dist, run, pythonFound, signal));
  }
  return installed;
}

/**
 * Decide one distribution's state. When there is no python3 at all the answer is
 * `'UNKNOWN'` for every entry — absence of the *probe*, not of the package.
 */
async function probeDependency(dist, run, pythonFound, signal) {
  const base = {
    dist,
    importName: mapDistToImport(dist),
    installed: 'UNKNOWN',
    source: 'unknown',
  };
  if (!pythonFound) return base;

  let result;
  try {
    result = await run(PYTHON, ['-c', metadataScript(dist), dist], { signal });
  } catch (error) {
    // A spawn-level failure (or any other run failure) is inconclusive evidence,
    // never proof of absence.
    if (isUnknownCommand(error)) return base;
    throw error;
  }

  const stdout = String(result?.stdout ?? '').trim();
  const stderr = String(result?.stderr ?? '');
  if (result?.exitCode === 0) {
    if (stdout === '') return base; // exit 0 without a version answers nothing
    return { ...base, installed: true, source: 'metadata' };
  }
  // The one non-zero exit that *is* a verdict: importlib.metadata raises
  // PackageNotFoundError (exit code 1) when the distribution has no metadata.
  if (result?.exitCode === 1 && stderr.includes('PackageNotFoundError')) {
    return { ...base, installed: false, source: 'metadata' };
  }
  // ImportError / MemoryError / a traceback from the interpreter itself: the
  // probe failed, so the state stays unknown rather than being misreported as
  // "not installed".
  return base;
}

/**
 * The per-distribution query script.
 *
 * The name is appended **after** the script string as `sys.argv[1]`, so no
 * dependency name is ever interpolated into python source: not even a hostile
 * line in a requirements file can inject code, and the probe never needs a
 * quoting rule of its own. The script still reads as a plain
 * `importlib.metadata.version("…")` query in argv order.
 */
function metadataScript(dist) {
  return `import sys, importlib.metadata; print(importlib.metadata.version(sys.argv[1])) # version(${JSON.stringify(dist)})`;
}

/** Render the diagnostic payload for the model: compact, greppable, one line per dep. */
function renderCheckEnv(diagnostic) {
  const { python, guard, deps, envFileExists } = diagnostic;
  const pythonLine =
    python.found === true
      ? `python3: ${python.version ?? 'unknown'}${
          python.meetsSkillRequirement === false ? ` (below ${MINIMUM_PYTHON.major}.${MINIMUM_PYTHON.minor})` : ''
        }`
      : 'python3: not found';
  const guardLine =
    guard.skipped === true
      ? 'guard: skipped'
      : `guard: ran (exit ${guard.exitCode})`;
  return [
    pythonLine,
    guardLine,
    `env file: ${envFileExists ? 'present' : 'absent'}`,
    `deps (${deps.length}):`,
    ...deps.map(
      (dep) => `  - ${dep.dist} → ${dep.importName}: ${dep.installed} (${dep.source})`,
    ),
  ].join('\n');
}

// ─── ppt_master_setup_deps ───────────────────────────────────────

/** The installer this tool drives (`pip3`, per brief — the POSIX spelling). */
const PIP = 'pip3';

/**
 * The install command's argument array (everything after the executable).
 *
 * `pip3 install -r <requirementsPath>` plus the two optional flags, whose order
 * is **fixed**: `--user` first, `--break-system-packages` second. Fixed order
 * keeps `installCmd` (and therefore the rendered command, the log line and the
 * tests) byte-stable across combinations — the two flags are independent, so
 * any order would install the same thing and only one of them is ever worth
 * asserting.
 *
 * The `pip3` executable itself is deliberately **not** part of the return
 * value: this is the pure argv builder, and `installCmd` is
 * `[PIP, ...buildPipArgs(path, opts)]`. `pip3` rather than a bare `pip`
 * because a leftover python2 `pip` on PATH is the classic way to install into
 * the wrong interpreter.
 *
 * Pure: no I/O, no validation of `requirementsPath` (a missing file is pip's
 * own non-zero exit to report), and absent/false flags produce no argument at
 * all rather than an empty token.
 *
 * @param {string} requirementsPath Path to the requirements file, verbatim.
 * @param {{ user?: boolean, breakSystemPackages?: boolean }} [opts] Optional flags.
 * @returns {string[]} `['install', '-r', requirementsPath, ...flags]`.
 */
export function buildPipArgs(requirementsPath, opts) {
  const args = ['install', '-r', requirementsPath];
  if (opts?.user === true) args.push('--user');
  if (opts?.breakSystemPackages === true) args.push('--break-system-packages');
  return args;
}

/**
 * The setup payload schema: object-rooted and explicitly closed, with the
 * diagnostic object nested under `checkEnv` **by reference to the same builder
 * `ppt_master_check_env` uses** — so the two contracts cannot drift apart, and
 * every nested object level is closed exactly as in `checkEnvOutputSchema()`.
 */
function setupDepsOutputSchema() {
  return {
    type: 'object',
    properties: {
      installCmd: { type: 'array', items: { type: 'string' } },
      installExit: { type: 'number' },
      checkEnv: checkEnvOutputSchema(),
    },
    additionalProperties: false,
  };
}

/**
 * `ppt_master_setup_deps`: install the wrapped skill's Python dependencies, then
 * re-run the environment self-check and report both.
 *
 * This is the **only tool with a side effect** (spec §3.5): it runs
 * `pip3 install -r ${SKILL_DIR}/requirements.txt` and then re-probes the
 * environment with the very same logic `ppt_master_check_env` uses.
 *
 * Failure semantics are asymmetric on purpose:
 * - a **non-zero install exit is recorded, never thrown** — a failed install is
 *   exactly when the freshly re-run diagnostic is most useful, so the call still
 *   answers with `installExit` plus the current environment;
 * - a **missing skill directory throws** — without SKILL_DIR there is no
 *   requirements file, no guard script and nothing to diagnose, so silently
 *   "succeeding" would hide a broken installation.
 *
 * Idempotence comes from pip itself (already-satisfied requirements are a no-op
 * that exits 0); this tool adds no locking, no state file and no caching.
 *
 * @param {{ skillRoots?: string[] }} [options] The same root override the other
 *   two tools honour, used here to locate SKILL_DIR.
 */
function setupDepsTool(options) {
  const roots = options?.skillRoots;
  return {
    name: 'ppt_master_setup_deps',
    description: '安装 ppt-master 的 Python 依赖并复跑环境自检 / Install the ppt-master Python dependencies and re-run the environment check',
    parameters: {
      type: 'object',
      properties: {
        user: { type: 'boolean' },
        breakSystemPackages: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    output: {
      schema: setupDepsOutputSchema(),
      render: (args, payload) => renderSetupDeps(payload),
    },
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted();
      const skillDir = locateSkillDir(roots, exec);
      if (skillDir === null) {
        throw new Error(
          `ppt_master_setup_deps: no skill directory found under roots（不存在或为空）: ${
            (rootOverride(roots, exec) ?? [PACKAGED_SKILLS_ROOT]).join(', ')
          }`,
        );
      }
      const requirementsPath = join(skillDir, 'requirements.txt');
      const installCmd = [PIP, ...buildPipArgs(requirementsPath, args)];

      // The install exit code is a *value*, not an exception: a spawn-level
      // failure (no pip3 at all) is folded into the same non-zero code so the
      // self-check below still runs and still gets reported.
      const installExit = await runInstall(installCmd, exec);

      // Same function `ppt_master_check_env` executes — the diagnostic is
      // re-derived, never reused from a cached earlier answer.
      const checkEnv = await runCheckEnv(roots, exec, requirementsPath);

      exec?.signal?.throwIfAborted();
      return { installCmd, installExit, checkEnv };
    },
  };
}

/**
 * Run the install command through the same injectable `run` channel every probe
 * uses, and reduce the outcome to a single exit code.
 *
 * A `run` rejection means the process never started (no `pip3` on PATH); that is
 * reported as `-1`, the same "no exit code observed" convention the guard probe
 * uses. An abort is **not** swallowed: it keeps propagating so a cancelled call
 * cannot be mistaken for a failed install.
 */
async function runInstall(installCmd, exec) {
  const run = makeRun(exec);
  const [command, ...args] = installCmd;
  let result;
  try {
    result = await run(command, args, { signal: exec?.signal ?? null });
  } catch (error) {
    if (isAbortError(error)) throw error;
    return -1;
  }
  return typeof result?.exitCode === 'number' ? result.exitCode : -1;
}

/**
 * Re-run the environment self-check for `exec` and return its diagnostic object.
 *
 * The path is threaded through `requirementsPath` so the report describes the
 * *same* file that was just installed from, instead of re-deriving it (and
 * possibly disagreeing with the installer about which file was used).
 */
function runCheckEnv(roots, exec, requirementsPath) {
  return checkEnvTool({ skillRoots: roots }).execute({ requirementsPath }, exec);
}

/** `true` for an abort (by name or code), whichever way the runtime spells it. */
function isAbortError(error) {
  return error !== null && typeof error === 'object'
    && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
}

/**
 * Render the setup payload: the exact command that ran, its exit code, and the
 * re-run diagnostic — which keeps the *same* rendering the check_env tool
 * produces, so an agent that has learned to read one can read the other.
 */
function renderSetupDeps(payload) {
  return [
    `install: ${payload.installCmd.join(' ')}`,
    `install exit: ${payload.installExit}`,
    ...(payload.installExit === 0
      ? []
      : ['install did not succeed — the environment below is unchanged/partial']),
    're-check:',
    renderCheckEnv(payload.checkEnv),
  ].join('\n');
}
