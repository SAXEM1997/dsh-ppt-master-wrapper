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
 * - `output.render` must return an **array of content blocks**
 *   (`[{ type: 'text', text }]`), never a bare string: the host pipeline
 *   (dsh-tools `createSuccessResult`) installs render's return value verbatim
 *   as `result.content`, and its consumers (`content.some(...)`, block maps)
 *   require an array — first-party reference `dsh-tool-todo`. A string-returning
 *   render executes fine and then fails the whole call with
 *   "content.some is not a function" (found by live invocation on DSH
 *   0.2.0-rc.2; unit stubs cannot catch it, the shape is asserted in tests).
 *
 * @module dsh-ppt-master-wrapper/lib/tools
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { listSkillDirs, parseFrontmatter } from './skill-provider.js';
import {
  cleanupOldVenv,
  createVenvReader,
  effectiveInterpreter,
  ensureVenv,
  readWrapperState,
  writeWrapperState,
} from './venv.js';

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

/**
 * This package's own repository root, located from the module, never from cwd —
 * the same anchoring style as the two constants above. It is the third `.env`
 * probe location (README tells users to copy `.env.example` to the workspace
 * root, and upstream `config.py` searches cwd → skill-dir → repo-root →
 * `~/.ppt-master/.env`).
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 三处"未达清理门"返回行的 cleanup 区分注记（Gate 3 G3-10）。
 *
 * 安装成功门之外的三条返回路径都固定 `{oldPath: null, action: 'none'}`，而 `cleanupLines()`
 * 只按 `error` 键的有无区分「未清理（原因）」与「无需清理」——无注记时三者全落默认臂，把
 * "根本没清理"渲染成"没什么要清理"，与事实不符（旧登记 venv 可能仍在）。三注记是各行的
 * **固定**区分信号（不带 `oldPath`：这些行不读登记，给出登记路径会误导），并且各自如实：
 * 系统模式没有 venv 安装这回事、准备失败时安装未执行、真失败时未达"成功后才清理"的门。
 */
const CLEANUP_NOTE_SYSTEM_MODE = '系统模式（venv 未启用）不做旧 venv 清理';
const CLEANUP_NOTE_INSTALL_NOT_RUN = '安装未执行（venv 准备失败）';
const CLEANUP_NOTE_INSTALL_FAILED = '安装未成功（旧 venv 留待下次成功运行清理）';

/** The empty parameter schema shared by the two argument-less tools. */
function noParameters() {
  return { type: 'object', properties: {}, additionalProperties: false };
}

/**
 * Build the tool definitions this plugin registers.
 *
 * @param {{ skillRoots?: string[], venv?: { enabled: boolean, path: string,
 *   oldPathPolicy: 'keep'|'delete' }, repoRoot?: string, testSeams?: { writeMarker?: Function,
 *   readWrapperState?: Function, writeWrapperState?: Function, remove?: Function } }}
 *   [options] Optional injection-bag subset (Task 5). `venv` may be **either** plain
 *   values (test/embedding) **or** a volatile reference bag (the loader path): either way
 *   it is read through `createVenvReader`, so every call sees the current configuration —
 *   the host does not re-run `apply` for volatile-only changes (design R8 / issue #16).
 *   `skillRoots` mirrors `apply()`'s test/embedding hook: all three tools resolve
 *   their SKILL_DIR/packaged `skills/` scan from these roots instead of the packaged
 *   ones. Omitted (the production path) means the packaged root. `venv` is the
 *   configuration `ppt_master_info`/`ppt_master_check_env` report their `venv` sections
 *   from — and, for `check_env`, the switch every deps/guard probe is routed by — and the
 *   switch both tools' description hints are keyed on; omitted evaluates as "nothing
 *   configured". A **present** `venv` is completed by `normalizeVenvInput` inside the
 *   reader before any tool sees it (Gate 3 G3-09): other missing fields fall back to
 *   `VENV_DEFAULTS`, and `enabled` counts as on only when it is literally `true` — so
 *   `{ path }` can never silently enable the venv (and its creation side effects).
 *   `repoRoot` overrides the anchor of `check_env`'s **third** `.env` probe location (R2 M3): production omits it,
 *   keeping this package's own root; tests point it at a fixture so `envFileExists` cannot
 *   flip with a `.env` in the developer's workspace root — which here *is* the plugin root
 *   README:33-39 tells users to put it in. `testSeams` is the **test-only** stub channel of `ppt_master_setup_deps`
 *   (Task 5's declared shape: `writeMarker`/`readWrapperState`/`writeWrapperState`/
 *   `remove`, each substituting the same-named `lib/venv.js` primitive the venv branch
 *   would otherwise reach — production omits the whole object, so every field falls back
 *   to the module primitive). Tests inject recorders (order and zero-call assertions) or
 *   throwing stubs (marker write failure → warn channel; registration failure → payload
 *   note), which is why the venv orchestration needs neither an fs stub nor a read-only
 *   directory. The production path (`index.js`) deliberately never passes it.
 * @returns {Array<{ name: string, description: string, parameters: object,
 *   output: { schema: object, render: (args: object, value: object) => Array<{ type: 'text', text: string }> },
 *   execute: (args: object, exec: object) => Promise<object> }>} Exactly three
 *   definitions, in registration order.
 */
export function createTools(options) {
  // 工厂入口归一化（Gate 3 G3-09）：`venv` 键在场时补成三字段完整普通值，且"缺失或非 true 的
  // `enabled`"一律归一为 `false`。缺了这一步，`createTools({venv:{path:'/abs'}})` 这类测试/嵌入
  // 部分对象会被 `effectiveInterpreter` 的 `venv?.enabled === false` 判成"已启用"，
  // `ppt_master_setup_deps` 随即产生真实创建副作用。`venv` 键整体缺省时原样透传（"未配置"语义）。
  //
  // R8（issue #16）：归一化**不再一次性拍平**，而是经 `createVenvReader` 变成每轮现读——
  // loader 形态下 `options.venv` 是 volatile 引用袋，宿主 volatile-only 变更不重跑 `apply`，
  // 拍平即永久陈旧。普通值/缺省形态经同一 reader，行为与"拍平一次"逐字相同。
  const readVenv = createVenvReader(options?.venv);
  const normalized = { ...options, readVenv };
  return [
    infoTool(normalized),
    checkEnvTool(normalized),
    setupDepsTool(normalized),
  ];
}

// ─── the one skill-dir judgment (shared by all three tools) ──────

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
 * The **single** skill-directory judgment every tool in this module goes through:
 * expand the effective roots, read each skill's identity, and anchor the primary on
 * the frontmatter `name` `ppt-master`; when nothing matches, the first loaded record
 * wins (roots in the order given, directories in byte order inside a root).
 *
 * Exactly one implementation exists on purpose: `ppt_master_info` and the
 * SKILL_DIR-consuming tools (`ppt_master_check_env`/`ppt_master_setup_deps`) must
 * never describe different trees, and the synthesized entry skill's body anchors on
 * the same rule (name priority, then loaded order) — see `primarySkillDirectory()`
 * in `lib/skill-provider.js`, which is the provider-side baseline this judgment
 * agrees with on the production single-root catalog.
 *
 * The two surfaces differ only in how they treat a **broken scan**: `info` is
 * fail-loud (an empty or missing root is not a legal runtime state, so it lets
 * `listSkillDirs` throw and reports `primary: null` to its caller, which throws),
 * while the diagnostics must report the condition instead of failing the call —
 * hence `tolerateBadRoots`, which folds a throwing root into "no skill dirs here".
 *
 * @param {string[]|undefined} roots Factory-level root override (wins over `exec`).
 * @param {object|undefined} exec Per-call exec object; `exec.skillRoots` is honoured.
 * @param {{ tolerateBadRoots?: boolean }} [mode] `true` for the diagnostic surfaces.
 * @returns {{ scanRoots: string[], skillDirs: string[], primary: object|null,
 *   isFallback: boolean }} `primary` is the judged skill record
 *   (`{directory, name, version}`) or `null` when no root yielded a skill;
 *   `isFallback` is `true` only when there was something to pick and the pick was
 *   the byte-order first directory rather than a `ppt-master` name match.
 */
function scanPrimarySkill(roots, exec, { tolerateBadRoots = false } = {}) {
  const scanRoots = rootOverride(roots, exec) ?? [PACKAGED_SKILLS_ROOT];
  const skillDirs = scanRoots.flatMap((root) => {
    if (!tolerateBadRoots) return listSkillDirs(root);
    try {
      return listSkillDirs(root);
    } catch {
      return []; // missing/not-a-directory root: nothing to anchor on
    }
  });
  const skills = skillDirs.map((directory) => readSkill(directory));
  const anchored = skills.find((skill) => skill.name === PRIMARY_SKILL_NAME);
  const primary = anchored ?? skills[0] ?? null;
  return {
    scanRoots,
    skillDirs,
    primary,
    isFallback: primary !== null && anchored === undefined,
  };
}

// ─── tool descriptions (the one bilingual split) ─────────────────

/**
 * Build a two-segment bilingual tool description: `<中文> / <English>`.
 *
 * The split is on `/`, which is exactly why the venv hint is handed in separately
 * rather than pre-concatenated by each caller: one builder means one place knows both
 * the separator and the rule "hints join the Chinese segment only" — and one place
 * breaks if a hint ever contains a slash (it would silently become a third segment;
 * every description test asserts exactly two).
 *
 * @param {string} zh Chinese segment (slash-free).
 * @param {string} en English segment — pure ASCII and byte-stable.
 * @param {string|null} [hint] Chinese-only suffix; `null`/omitted appends nothing.
 * @returns {string} `<中文[+hint]> / <English>`
 */
function bilingualDescription(zh, en, hint = null) {
  return `${hint === null ? zh : `${zh}${hint}`} / ${en}`;
}

/**
 * The interpreter hint appended to the **Chinese segment** when the venv is enabled
 * (spec §5.3 交付项): a model that never read the entry skill still sees, on the tool
 * surface itself, that an interpreter contract applies. It points at the contract's home
 * (`ppt-master-env`) rather than restating it — that body is a registration-time snapshot
 * and the authoritative state is the tool payload.
 *
 * Deliberately slash-free and path-free: the bilingual split is on `/`, so a hint
 * containing one would break the two-segment shape, and a configured path in prose would
 * be a second, staler copy of `venv.path`.
 */
const VENV_DESCRIPTION_HINT =
  '（venv 已启用：解释器契约以入口 skill ppt-master-env 为准，勿直接以系统 python3 运行上游脚本）';

/** The hint for an enabled venv, or `null` when a description stays untouched. */
function venvHint(venv) {
  return venv?.enabled === true ? VENV_DESCRIPTION_HINT : null;
}

// ─── ppt_master_info ─────────────────────────────────────────────

/**
 * The model-facing payload schema: object-rooted, explicitly closed at every
 * object level, and declaring exactly the eight fields `execute()` returns.
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
      // The configured venv, reported on the spec §5.3 matrix. Nullable fields are
      // spelled as `oneOf` (never a type array, which the SDK rejects), and the
      // sub-object is closed like every other object level in this module.
      venv: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          path: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          exists: { type: 'boolean' },
          pythonPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['enabled', 'path', 'exists', 'pythonPath'],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
}

/**
 * The `venv` section of the info payload (spec §5.3 matrix): `enabled` is the
 * configuration switch **itself**, strictly as a boolean, while the other three
 * values come from one `effectiveInterpreter(venv)` evaluation — `path`/`exists`/
 * `pythonPath` are that single decision's answers, never a second judgement made
 * here (this module does not call `resolveVenvPath` or probe the interpreter
 * directly).
 *
 * Matrix reading:
 * - `off` (disabled with a valid path): `path` is the configured value verbatim —
 *   deliberately **unresolved** — and `exists: false` without probing;
 * - `off` from `invalid × disabled`: `enabled: false` but `path: null`, reporting
 *   the invalid configuration as it is;
 * - `invalid`: `path: null` with the configured `enabled: true` (behaviour degrades
 *   to system mode, the diagnosis stays truthful);
 * - `on-missing` / `on-ready`: the resolved absolute path;
 * - broken sub-state: **no extra field**. It is observable by inference only —
 *   `exists === true ∧ pythonPath === null` (a healthy `on-ready` carries
 *   `<path>/bin/python3`).
 *
 * A venv directory that is merely on disk — an unmarked orphan — is never
 * discovered, probed or hinted at here: only the configured path is judged (spec §6).
 *
 * @param {{ enabled: boolean, path: string, oldPathPolicy: 'keep'|'delete' }} [venv]
 * @returns {{ enabled: boolean, path: string|null, exists: boolean, pythonPath: string|null }}
 */
function infoVenvSection(venv) {
  const { path, exists, pythonPath } = effectiveInterpreter(venv);
  return {
    enabled: venv?.enabled === true,
    path,
    exists,
    pythonPath,
  };
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
 *
 * @param {{ skillRoots?: string[], venv?: object }} [options] Injection-bag subset;
 *   `venv` also drives the description hint below.
 */
function infoTool(options) {
  const roots = options?.skillRoots;
  // R8：现读访问器（`createTools` 注入）。描述投影与 execute 各取一次，绝不在此拍平。
  const readVenv = options?.readVenv ?? (() => options?.venv);
  return {
    name: 'ppt_master_info',
    // 描述做成 getter：宿主 `schemaOf()` 在**每次投影**时解构 `definition.description`
    //（`@deepseek-ai/dsh-tools/lib/index.js:3136`），故 volatile 换代后解释器提示语会跟着变，
    // 不会留下"venv 已启用"这种与现实相反的旧提示误导模型。
    get description() {
      return infoDescription(readVenv());
    },
    parameters: noParameters(),
    output: {
      schema: infoOutputSchema(),
      // Model-facing rendering: a compact, greppable block. Every value comes
      // from the validated payload, so the text can never disagree with it.
      // Wrapped as a content-block array (module-header contract note).
      render: (args, info) => [{ type: 'text', text: renderInfo(info) }],
    },
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted();
      const judgment = scanPrimarySkill(roots, exec);
      if (judgment.primary === null) {
        // Empty skills root is not a legal runtime state: without a skill there
        // is no SKILL_DIR to report and the wrapper is broken, so fail loud.
        throw new Error(
          `ppt_master_info: no skill directory found under roots（不存在或为空）: ${judgment.scanRoots.join(', ')}`,
        );
      }
      const primary = judgment.primary;
      exec?.signal?.throwIfAborted();

      return {
        pluginVersion: readPluginVersion(),
        upstreamVersion: primary.version,
        skillDirs: judgment.skillDirs,
        primarySkillDir: primary.directory,
        primarySkillName: primary.name,
        primaryIsFallback: judgment.isFallback,
        repository: UPSTREAM_REPOSITORY,
        venv: infoVenvSection(readVenv()),
      };
    },
  };
}

/** The Chinese half of the info tool's bilingual description. */
const INFO_DESCRIPTION_ZH = '查询包裹的 ppt-master 技能信息';

/** The English half — pure ASCII and byte-stable: hints never land here. */
const INFO_DESCRIPTION_EN = 'Inspect the wrapped ppt-master skill info';

/** Build the info description; the hint joins the Chinese segment only. */
function infoDescription(venv) {
  return bilingualDescription(INFO_DESCRIPTION_ZH, INFO_DESCRIPTION_EN, venvHint(venv));
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
 *
 * Coverage bar: every distribution in the vendored `requirements.txt` (19
 * items) resolves here. The ten same-name additions (`uharfbuzz`, `mammoth`,
 * `markdownify`, `ebooklib`, `nbconvert`, `openpyxl`, `numpy`, `requests`,
 * `curl_cffi`, `flask`) were verified against the vendor tree's own import
 * statements, not guessed; anything outside the vendor file still answers
 * `'UNKNOWN'`.
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
  uharfbuzz: 'uharfbuzz',
  mammoth: 'mammoth',
  markdownify: 'markdownify',
  ebooklib: 'ebooklib',
  nbconvert: 'nbconvert',
  openpyxl: 'openpyxl',
  numpy: 'numpy',
  requests: 'requests',
  curl_cffi: 'curl_cffi',
  flask: 'flask',
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
 * The lookup is an **own-property** test, never a bare `TABLE[key]`: a bare
 * index walks the prototype chain, so `'__proto__'` would answer with an object
 * and `'constructor'`/`'toString'` with a function. Both violate the
 * string-typed `deps[].importName` contract the payload schema declares, so
 * inherited members are treated exactly like any other unlisted distribution.
 *
 * @param {string} dist Distribution name.
 * @returns {string} The import name, or `'UNKNOWN'`.
 */
export function mapDistToImport(dist) {
  if (typeof dist !== 'string' || dist === '') return 'UNKNOWN';
  const key = String(dist).toLowerCase();
  return Object.hasOwn(DIST_TO_IMPORT, key) ? DIST_TO_IMPORT[key] : 'UNKNOWN';
}

/**
 * The three-field interpreter probe node (`{found, version, meetsSkillRequirement}`).
 *
 * One builder, two positions: the **system** probe (`python` — always the system
 * `python3`) and the first variant of `venv.python` (the **effective** interpreter).
 * Sharing it is what keeps the two sections' shapes from drifting, and the two
 * remaining `venv.python` rows — which probe nothing — are the `{skipped}` variant.
 */
function pythonProbeSchema() {
  return {
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
  };
}

/**
 * The dependency-probe payload schema: object-rooted, explicitly closed at
 * **every** object level (the `python` sub-object, each of the two `guard`
 * variants, each `deps` element and the `venv` sub-object with its own `python`
 * oneOf included), nullable fields spelled as `oneOf` rather than a type array,
 * and — as everywhere in this module — no `type: 'json'` node.
 *
 * `installed` is a three-state field (`true` / `false` / the string
 * `'UNKNOWN'`), which the oneOf spelling is exactly for: `false` means the
 * distribution is provably absent, `'UNKNOWN'` means the probe could not decide.
 */
function checkEnvOutputSchema() {
  return {
    type: 'object',
    properties: {
      python: pythonProbeSchema(),
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
      // The configured venv as one `effectiveInterpreter` evaluation sees it (spec §5.3):
      // `enabled` is the configuration switch itself, `path`/`exists` are that single
      // decision's answers, and `python` is either the effective interpreter's three-field
      // probe or the fixed `{skipped}` shape on the two rows that probe nothing.
      venv: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          // Nullable: `null` for the `invalid` row and for `invalid × disabled`.
          path: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          exists: { type: 'boolean' },
          python: {
            oneOf: [
              pythonProbeSchema(),
              {
                type: 'object',
                properties: { skipped: { type: 'boolean', const: true } },
                required: ['skipped'],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ['enabled', 'path', 'exists', 'python'],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
}

/** The Chinese half of the check_env tool's bilingual description. */
const CHECK_ENV_DESCRIPTION_ZH = '探测 ppt-master 的 Python3 与依赖环境';

/** The English half — pure ASCII and byte-stable: hints never land here. */
const CHECK_ENV_DESCRIPTION_EN = 'Probe the ppt-master Python3 and dependency environment';

/** Build the check_env description; the hint joins the Chinese segment only. */
function checkEnvDescription(venv) {
  return bilingualDescription(CHECK_ENV_DESCRIPTION_ZH, CHECK_ENV_DESCRIPTION_EN, venvHint(venv));
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
 * - any other python-level failure (`ImportError`, `MemoryError`, …) lands in
 *   the auxiliary import channel first (spec §3.5): when `DIST_TO_IMPORT`
 *   knows the module, one `python3 -c "import <mapped>"` subprocess re-asks
 *   the question, yielding `source: 'import'` on a verdict and falling back
 *   to `'UNKNOWN'` with `source: 'unknown'` otherwise. Without a mapping —
 *   or after a `spawn`-level failure such as `ENOENT`, where python3 itself
 *   could not start — the entry goes straight to `'UNKNOWN'`. A failed probe
 *   is **not** evidence of absence, so this case may never be reported as
 *   `false`.
 *
 * No `.env` file is ever read: `envFileExists` is an existence test only, so the
 * tool cannot leak or mis-handle secrets.
 *
 * The existence test covers the four locations of upstream `config.py`'s lookup
 * order — `<cwd>/.env` (where the README tells users to copy `.env.example`) →
 * `<PROJECT_ROOT>/.env` (SKILL_DIR) → `<REPO_ROOT>/.env` → `~/.ppt-master/.env`
 * (`USER_ENV_FILE`, `Path.home()/'.ppt-master'/'.env'`). The third item is this
 * wrapper package's root: only under the packaged layout is it equivalent to
 * upstream's REPO_ROOT — with injected `skillRoots` the two diverge, and the
 * wrapper keeps its own package root as the stable third probe. That anchor is
 * overridable at assembly time via `createTools(opts).repoRoot` (production default
 * unchanged: this package root), so tests can point the third probe at a fixture and
 * isolate it from the developer machine's workspace `.env`. Any one of
 * them present answers `true`; `.env.example` never counts, and contents are
 * still never read.
 *
 * The `venv` section reports the configured venv on the spec §5.3 matrix, and — the
 * behavioural half of this tool — **deps and guard probing follow the effective
 * interpreter**, not the system one unconditionally:
 * - `off` / `invalid` → the system `python3` (the invalid row is a *degraded
 *   continuation*, not an error, so its diagnostics stay useful);
 * - `on-ready` → the venv's `<absPath>/bin/python3` (the very `pythonPath`
 *   `effectiveInterpreter` produced — this module never joins its own path decision);
 * - `on-missing` / broken sub-state → **no system fallback**: every deps entry is
 *   `'UNKNOWN'` with `source: 'unknown'` and the guard is `{skipped}`. `'UNKNOWN'` is
 *   the deps vocabulary and is never borrowed for the guard.
 *
 * The top-level `python` field stays the **system** probe in every row: it answers
 * "is there a system interpreter here", while `venv.python` answers the *effective*
 * one, so the two sections are deliberately independent. Broken is observable by
 * inference only (`venv.exists === true ∧ venv.python.found === false`) — no extra
 * field (spec §5.3 note), and an unmarked venv directory on disk is never discovered,
 * probed or hinted at (spec §6): only the configured path is judged.
 *
 * @param {{ skillRoots?: string[], venv?: object }} [options] The same root override
 *   `ppt_master_info` honours (used here to locate SKILL_DIR), plus the de-referenced
 *   `venv` config that the `venv` section reports and every probe is routed by.
 */
function checkEnvTool(options) {
  const roots = options?.skillRoots;
  // R8：现读访问器——本工具是入口技能正文指向的权威诊断面，若它也读 apply 期快照，
  // 「实时以两个工具的输出为准」这条逃生门就是坏的。
  const readVenv = options?.readVenv ?? (() => options?.venv);
  // 第三个 `.env` 探测点的锚（装配期缝，R2 M3）：生产默认＝本包根目录 `REPO_ROOT`；
  // 测试/嵌入方可以用一个 fixture 目录替换它，使 `envFileExists` 与开发机工作区根的
  // `.env` 无关（本仓库工作区根＝插件根，README 又鼓励把 `.env` 放在工作区根）。
  const repoRoot = options?.repoRoot ?? REPO_ROOT;
  return {
    name: 'ppt_master_check_env',
    // getter：宿主每次投影现读（理由同 `infoTool`）。
    get description() {
      return checkEnvDescription(readVenv());
    },
    parameters: noParameters(),
    output: {
      schema: checkEnvOutputSchema(),
      // Content-block array (module-header contract note); renderCheckEnv
      // itself stays a pure string builder.
      render: (args, diagnostic) => [{ type: 'text', text: renderCheckEnv(diagnostic) }],
    },
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted();
      // R8：本次调用现读一次，随后整轮判定/探测都用这一份（同一次求值，行内自洽）。
      const venv = readVenv();
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

      // One `effectiveInterpreter` evaluation is the only source for the venv section
      // and for the probe routing below (`path`/`exists`/`pythonPath` are that single
      // decision's answers — this module never resolves or judges a venv path itself).
      const interpreter = effectiveInterpreter(venv);
      const python = await probePython(run, signal);
      const venvPython = await probeVenvPython(run, signal, interpreter);
      const executable = probeExecutable(interpreter, python.found);
      const guard = await probeGuard(run, skillDir, executable, signal);
      const dependencyState = await probeDependencies(deps, run, executable, signal);

      exec?.signal?.throwIfAborted();
      return {
        python,
        guard,
        deps: dependencyState,
        // Existence only — the file's contents are never read (spec §3.5).
        // Four probe locations, in upstream config.py's search order
        // (cwd → PROJECT_ROOT → REPO_ROOT → USER_ENV_FILE): cwd (README: copy
        // `.env.example` to the workspace root) → SKILL_DIR → this package's
        // root (≈ upstream REPO_ROOT only under the packaged layout; the two
        // diverge with injected skillRoots) → ~/.ppt-master/.env.
        envFileExists: [
          join(process.cwd(), '.env'),
          ...(skillDir === null ? [] : [join(skillDir, '.env')]),
          join(repoRoot, '.env'),
          join(homedir(), '.ppt-master', '.env'),
        ].some((candidate) => existsSync(candidate)),
        venv: {
          enabled: venv?.enabled === true,
          path: interpreter.path,
          exists: interpreter.exists,
          python: venvPython,
        },
      };
    },
  };
}

/**
 * Locate SKILL_DIR the same way `ppt_master_info` does — literally the same
 * judgment (`scanPrimarySkill`), so the two tool surfaces cannot describe
 * different trees: the skill directory whose frontmatter names `ppt-master`, else
 * the first in byte order, else `null` when the roots hold no skill at all.
 *
 * This never throws where `ppt_master_info` does — `check_env` is a diagnostic,
 * so an absent root or an empty root is a condition to *report* (no `SKILL_DIR`
 * means the guard is skipped), not a reason to fail the call.
 */
function locateSkillDir(roots, exec) {
  return scanPrimarySkill(roots, exec, { tolerateBadRoots: true }).primary?.directory ?? null;
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

/** The interpreter system-mode probes shell out to (`python3`, per brief). */
const PYTHON = 'python3';

/**
 * The venv interpreter, relative to the venv root (POSIX layout).
 *
 * The same `<absPath>/bin/python3` join `lib/venv.js` builds its `pythonPath` from —
 * that module keeps the constant private, so this is the one spelling on this side and
 * the two must stay in step. It is used **only** as the async version probe's candidate
 * on the two rows whose `pythonPath` is `null` (`on-missing` / broken): the probe target,
 * never a second path decision (the reported `path` always comes from
 * `effectiveInterpreter`).
 */
const VENV_PYTHON_REL = join('bin', 'python3');

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
 * Probe one interpreter: `<command> --version`.
 *
 * `command` is the executable the caller decided on — the system `python3` by default,
 * the venv's `<absPath>/bin/python3` (or, on the two `pythonPath: null` rows, that same
 * candidate) for the `venv.python` section.
 *
 * A spawn failure means "no such interpreter" — `found: false` and a `null` version
 * — reported as a value, never thrown (spec §3.5: `check_env` never fails a
 * call). `meetsSkillRequirement` stays `null` whenever the version could not be
 * established or parsed.
 */
async function probePython(run, signal, command = PYTHON) {
  const absent = { found: false, version: null, meetsSkillRequirement: null };
  let result;
  try {
    result = await run(command, ['--version'], { signal });
  } catch (error) {
    if (isUnknownCommand(error)) return absent;
    throw error;
  }
  if (!result || typeof result.exitCode !== 'number' || result.exitCode !== 0) return absent;
  // `||`（非 `??`）：stdout 为**空串**时也必须回退 stderr——`??` 只把
  // null/undefined 视为缺失，真实 spawn 形态下版本行可能只落在 stderr。
  const version = parsePythonVersion(result.stdout || result.stderr || '');
  if (version === null) return absent;
  return {
    found: true,
    version,
    meetsSkillRequirement: toVersionNumber(version) >= MINIMUM_PYTHON_NUMBER,
  };
}

/**
 * The `venv` section's `python` value (spec §5.3 matrix): the effective interpreter's
 * own three-field version probe, or the fixed `{skipped}` shape on the two rows that
 * probe nothing.
 *
 * Probe target, row by row:
 * - `off` / `invalid` → nothing is probed (`pythonPath` is `null` there by definition);
 * - `on-ready` (healthy) → `interpreter.pythonPath`, which already is
 *   `<absPath>/bin/python3`;
 * - `on-missing` / broken → `pythonPath` is `null` (that is exactly how the broken
 *   sub-state is observable), so the candidate `<absPath>/bin/python3` is joined here and
 *   handed to the same async probe — it is a *probe target*, not a second path decision.
 *
 * The **reported value** is the row's verdict, not the candidate's answer (R2 M2): the
 * broken sub-state covers both "no interpreter" and "interpreter but no install path"
 * (`bin/pip3` missing — the half-built shape ensurepip leaves behind), and spec §5.3's
 * broken cell is the absent three-field shape. Reporting the candidate's `found: true`
 * there would render a venv that `setup_deps` refuses to adopt as a healthy interpreter
 * version — the exact disagreement this fixes; the probe is still issued so the two
 * `pythonPath: null` rows keep one documented probe target.
 *
 * Broken needs no field: `exists === true ∧ python.found === false` is the inference form
 * (spec §5.3 note).
 */
async function probeVenvPython(run, signal, interpreter) {
  if (interpreter.state === 'off' || interpreter.state === 'invalid') return { skipped: true };
  const probed = await probePython(
    run,
    signal,
    interpreter.pythonPath ?? join(interpreter.path, VENV_PYTHON_REL),
  );
  if (interpreter.broken === true) return { found: false, version: null, meetsSkillRequirement: null };
  return probed;
}

/**
 * The interpreter deps and guard probing follow — the behavioural half of spec §5.3.
 *
 * - `off` / `invalid` → the system `python3` when the system probe found one, else `null`
 *   (the invalid row is a degraded continuation: its diagnostics stay system-mode);
 * - `on-ready` → the venv interpreter, `null` in the broken sub-state;
 * - `on-missing` / broken → `null`: **no system fallback**, which is what turns every
 *   deps entry into `'UNKNOWN'` and the guard into `{skipped}`.
 *
 * Routing is on the state alone (never on the async probe's `found`): a venv interpreter
 * that exists but cannot answer a probe is still the effective interpreter, and its spawn
 * failures fold into the existing "a failed probe is not evidence of absence" answers.
 */
function probeExecutable(interpreter, systemPythonFound) {
  if (interpreter.state === 'off' || interpreter.state === 'invalid') {
    return systemPythonFound ? PYTHON : null;
  }
  return interpreter.pythonPath;
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
 * Probe the attribution guard: run `${SKILL_DIR}/scripts/attribution_guard.py` with the
 * **effective interpreter** (`probeExecutable`).
 *
 * The guard's exit code is **recorded, not interpreted** — a non-zero code may
 * be the guard's own verdict and is never mapped onto a tool-level failure
 * (spec §3.5: only `setup_deps` owns install-time failures). The probe is
 * skipped when there is no effective interpreter (`executable === null`: no
 * system python3, or an `on-missing`/broken venv — no system fallback) or no
 * SKILL_DIR to run it from.
 *
 * `{skipped}` is the guard's own vocabulary: `'UNKNOWN'` belongs to deps entries and is
 * never borrowed here (spec §5.3).
 */
async function probeGuard(run, skillDir, executable, signal) {
  if (executable === null || skillDir === null) return { skipped: true };
  const script = join(skillDir, 'scripts', 'attribution_guard.py');
  let result;
  try {
    result = await run(executable, [script], { signal });
  } catch (error) {
    if (isUnknownCommand(error)) return { skipped: true };
    throw error;
  }
  return { ran: true, exitCode: typeof result?.exitCode === 'number' ? result.exitCode : -1 };
}

/**
 * Probe every listed distribution, one metadata subprocess each, through the
 * **effective interpreter** (`executable`).
 *
 * Running them one at a time keeps each verdict independent: one broken query
 * degrades exactly one entry to `'UNKNOWN'` instead of poisoning the batch.
 */
async function probeDependencies(dists, run, executable, signal) {
  const installed = [];
  for (const dist of dists) {
    installed.push(await probeDependency(dist, run, executable, signal));
  }
  return installed;
}

/**
 * Decide one distribution's state. With no effective interpreter (`executable === null`)
 * the answer is `'UNKNOWN'` for every entry — absence of the *probe*, not of the package —
 * and no subprocess is started at all (the `on-missing`/broken venv rows: no system
 * fallback, spec §5.3).
 */
async function probeDependency(dist, run, executable, signal) {
  const base = {
    dist,
    importName: mapDistToImport(dist),
    installed: 'UNKNOWN',
    source: 'unknown',
  };
  if (executable === null) return base;

  let result;
  try {
    result = await run(executable, ['-c', metadataScript(dist), dist], { signal });
  } catch (error) {
    // A spawn-level failure means the interpreter itself could not start —
    // fresh evidence it is unavailable right now, so the auxiliary
    // import probe is skipped (it could only fail the same way) and a failed
    // probe is inconclusive evidence, never proof of absence.
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
  // metadata query failed python-side (python3 demonstrably runs, it just
  // could not answer). Before settling for UNKNOWN, give the auxiliary import
  // channel (spec §3.5) its chance — gated on the dist→import mapping.
  return probeByImport(base, run, executable, signal);
}

/**
 * The auxiliary import probe (spec §3.5): `<effective interpreter> -c "import <mapped>"`.
 *
 * Reached only from `probeDependency`'s inconclusive-metadata branch, and only
 * when `DIST_TO_IMPORT` knows the module name — the probe must go through the
 * mapping (never a guessed import name, and never the distribution name:
 * `import PyYAML` is not a thing). Because the mapped name is a literal of
 * this module's own table — never derived from requirements-file input —
 * interpolating it into the script is injection-safe by construction.
 *
 * The second opinion is asked of the **same** interpreter the metadata query used
 * (`executable`): a different interpreter could answer about a different environment.
 *
 * Verdicts mirror the metadata channel exactly:
 * - exit `0` → `installed: true`, `source: 'import'`;
 * - exit `1` reporting `ModuleNotFoundError` → `installed: false`,
 *   `source: 'import'`;
 * - anything else (other exit codes, or a spawn-level failure of the probe
 *   itself) → the entry stays `'UNKNOWN'` with `source: 'unknown'` — a failed
 *   probe is still not evidence of absence. Only a non-spawn error (an abort)
 *   propagates.
 */
async function probeByImport(base, run, executable, signal) {
  const moduleName = base.importName;
  if (moduleName === 'UNKNOWN') return base; // no mapping: never guess an import name
  let result;
  try {
    result = await run(executable, ['-c', `import ${moduleName}`], { signal });
  } catch (error) {
    if (isUnknownCommand(error)) return base;
    throw error;
  }
  if (result?.exitCode === 0) return { ...base, installed: true, source: 'import' };
  if (result?.exitCode === 1 && String(result?.stderr ?? '').includes('ModuleNotFoundError')) {
    return { ...base, installed: false, source: 'import' };
  }
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

/**
 * The render line for the `venv` section (F2) — the **documented** model-visible channel
 * for `venv.path` (README「配置页指引」/「配置无效行的措辞」、spec §5.1「可见反馈通道」）。
 *
 * One compact line, read straight off the payload: `enabled` is the section's own value
 * (the *config* switch here, unlike `setup_deps`), `path` is the resolved absolute path or
 * the config value verbatim (`-` when `null`, i.e. the invalid row) and `python` is the
 * effective interpreter's version, `not found`, or `skipped` (the off/invalid shape).
 * Nothing is probed here: the model's environment picture stays identical to the payload.
 */
function venvCheckLine(venv) {
  const section = venv ?? {};
  const python = section.python ?? {};
  const pythonLabel =
    python.skipped === true
      ? 'skipped'
      : python.found === true
        ? (python.version ?? 'unknown')
        : 'not found';
  return `venv: enabled=${section.enabled === true} path=${section.path ?? '-'} `
    + `exists=${section.exists === true} python=${pythonLabel}`;
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
    venvCheckLine(diagnostic.venv),
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
 *
 * Task 9 appends the two venv-orchestration sections, both **unconditional** (system
 * mode reports their fixed values): `venv` (`enabled` is the *effective* switch here,
 * unlike info/check_env — deviation ⑲) and `cleanup` (`error` is the optional note
 * channel; it may carry a read-failure, a refusal reason and a registration-failure
 * note concatenated). Nullable fields keep the `oneOf` spelling this module uses
 * everywhere, and the action enumeration carries its sibling `type` (the SDK rejects a
 * bare `enum`).
 */
function setupDepsOutputSchema() {
  return {
    type: 'object',
    properties: {
      installCmd: { type: 'array', items: { type: 'string' } },
      installExit: { type: 'number' },
      checkEnv: checkEnvOutputSchema(),
      venv: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          created: { type: 'boolean' },
          adopted: { type: 'boolean' },
          // Nullable: `null` on the `invalid` row (and on `off × invalid`).
          path: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          // Optional: only the four "install not executed" rows carry a reason
          // (creation failure / non-empty non-venv refusal / exists-but-broken /
          // `venv 内 pip3 缺失（安装不完整）`).
          error: { type: 'string' },
        },
        required: ['enabled', 'created', 'adopted', 'path'],
        additionalProperties: false,
      },
      cleanup: {
        type: 'object',
        properties: {
          // Nullable: no registered old path (first run / unreadable state).
          oldPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          action: { type: 'string', enum: ['none', 'kept', 'deleted', 'failed'] },
          // Optional notes — read failure, precondition refusal, registration failure, and the
          // three fixed "未达清理门" row notes (system mode / install not executed / install failed).
          error: { type: 'string' },
        },
        required: ['oldPath', 'action'],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
}

/**
 * `ppt_master_setup_deps`: install the wrapped skill's Python dependencies, then
 * re-run the environment self-check and report both.
 *
 * This is the **only tool with a side effect** (spec §3.5), and therefore the single
 * place where the configured venv is created, installed into, cleaned up and registered
 * (spec §4.3; G1/G4/G5). It runs `pip3 install -r ${SKILL_DIR}/requirements.txt` — or,
 * under an enabled venv, `<absPath>/bin/pip3 install -r …` — and then re-probes the
 * environment with the very same logic `ppt_master_check_env` uses.
 *
 * **The state gate.** Exactly one `effectiveInterpreter(venv)` evaluation decides the
 * branch — `on-missing` / `on-ready` (broken sub-state included) take the venv branch,
 * while `off` and `invalid` stay in **pure system mode** and call none of
 * `ensureVenv`/`cleanupOldVenv`/`writeWrapperState` (the invalid row is a degraded
 * continuation, not an error). Outside the venv branch nothing reads `.path` either:
 * `absPath` is taken from that same evaluation only after the gate, which is what keeps
 * `path.join(null, …)` unreachable in system mode, and this module never resolves a venv
 * path itself.
 *
 * **venv branch order** (spec §4.3): `ensureVenv` → build
 * `installCmd = [<absPath>/bin/pip3, 'install', '-r', <req>]` (the call-time flags
 * `user`/`breakSystemPackages` are ignored in venv mode and the render says so) → run the
 * install → `readWrapperState` → `cleanupOldVenv` (skipped when the registered path is
 * the current one — the steady state carries no note) → `writeWrapperState(absPath)` →
 * re-run `check_env` with the de-referenced `venv` as its fourth argument (so the re-run
 * answers about the environment that was just installed into, never the venv-off
 * default). Install success gates the last three steps: the deletion policy promises
 * "delete after the next successful `setup_deps`" (Config annotation / spec §4.3
 * 「成功后 cleanupOldVenv」), so a failed install leaves the old venv and the previous
 * registration untouched — which is also what keeps the old path cleanable by the next
 * successful run instead of turning it into a forgotten orphan.
 *
 * **Failure semantics are asymmetric on purpose:**
 * - a **non-zero install exit is recorded, never thrown** — a failed install is
 *   exactly when the freshly re-run diagnostic is most useful, so the call still
 *   answers with `installExit` plus the current environment, and it must *not* be
 *   rendered as "not executed" (the real exit code is the whole point);
 * - the four **"install not executed" rows** (creation failure, non-empty non-venv
 *   refusal, exists-but-broken, `venv 内 pip3 缺失（安装不完整）`) report `venv.error`,
 *   the truthful `installCmd`,
 *   `installExit: -1` and a render line saying the install was not run, then still
 *   re-run `check_env` (the missing-venv vocabulary) and never throw;
 * - an **abort keeps propagating**: `ensureVenv` is the one primitive that rejects on
 *   cancellation, and that rejection must not be folded into `venv.error` — a cancelled
 *   call is not an environment fault;
 * - a **missing skill directory throws** — without SKILL_DIR there is no
 *   requirements file, no guard script and nothing to diagnose, so silently
 *   "succeeding" would hide a broken installation.
 *
 * Both new payload keys are emitted **unconditionally**, system mode included:
 * `venv: {enabled, created, adopted, path, error?}` (here `enabled` is the *effective*
 * state — `false` on the off and invalid rows, unlike the config-value semantics of
 * info/check_env) and `cleanup: {oldPath, action, error?}`, whose `error` concatenates
 * the read-failure, refusal-reason and registration-failure notes without overwriting
 * one another.
 *
 * The three return paths **outside the install-success gate** (system mode, venv
 * preparation failure, non-zero install exit) each carry one fixed note instead of the
 * bare `{oldPath: null, action: 'none'}` they used to (Gate 3 G3-10): without a note the
 * render fell into the `无需清理` default arm, which reads as "there was nothing to clean
 * up" while the truth is "nothing was cleaned" (a previously registered venv may well
 * still be there). The note is the *only* difference — no registration is read and no
 * primitive is called on those rows, which is what keeps the F1 steady-state contract
 * (registered path === path in use ⇒ no `error` key, `无需清理`) untouched.
 *
 * Idempotence comes from pip itself (already-satisfied requirements are a no-op
 * that exits 0); this tool adds no locking, no state file and no caching. The
 * concurrency stance is spec §6's: `pip` is idempotent and `ensureVenv` only creates
 * what is missing, so a double-build race may fail once and self-heals on a re-run —
 * no eventual-consistency promise is made.
 *
 * @param {{ skillRoots?: string[], venv?: { enabled: boolean, path: string,
 *   oldPathPolicy: 'keep'|'delete' }, repoRoot?: string, testSeams?: { writeMarker?: Function,
 *   readWrapperState?: Function, writeWrapperState?: Function, remove?: Function } }}
 *   [options] The same root override the other two tools honour (used here to locate
 *   SKILL_DIR), plus the de-referenced `venv` config this tool's side effects are keyed
 *   on, the `repoRoot` anchor its re-run `check_env` uses for the third `.env` probe (R2 M3),
 *   and the test-only primitive stub channel described on `createTools`.
 */
function setupDepsTool(options) {
  const roots = options?.skillRoots;
  // R8：现读访问器——本工具是 venv 创建/删除的唯一副作用面，"系统模式 vs venv 模式"
  // 的分支必须按**当前**配置判定，否则卡片里刚打开 venv 就调它仍会走系统 pip。
  const readVenv = options?.readVenv ?? (() => options?.venv);
  const seams = options?.testSeams ?? {};
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
      // Content-block array (module-header contract note); renderSetupDeps
      // itself stays a pure string builder.
      render: (args, payload) => [{ type: 'text', text: renderSetupDeps(payload) }],
    },
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted();
      // The same judgment (and the same effective-root list) `ppt_master_info`
      // uses — one implementation, so the two surfaces cannot disagree.
      const judgment = scanPrimarySkill(roots, exec, { tolerateBadRoots: true });
      const skillDir = judgment.primary?.directory ?? null;
      if (skillDir === null) {
        throw new Error(
          `ppt_master_setup_deps: no skill directory found under roots（不存在或为空）: ${judgment.scanRoots.join(', ')}`,
        );
      }
      const requirementsPath = join(skillDir, 'requirements.txt');

      // R8：本次调用现读一次——下面所有分支（含 cleanup 的旧路径策略）都用这一份。
      const venv = readVenv();

      // The state gate, and the only judgement of the configured venv: `off` and
      // `invalid` are pure system mode (no venv primitive is reached below), the other
      // two states — broken included — take the venv branch.
      const interpreter = effectiveInterpreter(venv);

      if (interpreter.state !== 'on-missing' && interpreter.state !== 'on-ready') {
        const installCmd = [PIP, ...buildPipArgs(requirementsPath, args)];

        // The install exit code is a *value*, not an exception: a spawn-level
        // failure (no pip3 at all) is folded into the same non-zero code so the
        // self-check below still runs and still gets reported.
        const installExit = await runInstall(installCmd, exec);

        // Same function `ppt_master_check_env` executes — the diagnostic is
        // re-derived, never reused from a cached earlier answer. The fourth argument
        // is the de-referenced config, so the re-run describes the same environment
        // this call resolved against (the off/invalid rows keep answering truthfully).
        const checkEnv = await runCheckEnv(roots, exec, requirementsPath, venv, options?.repoRoot);

        exec?.signal?.throwIfAborted();
        return {
          installCmd,
          installExit,
          checkEnv,
          // `enabled` here is the **effective** state: off and invalid are both
          // `false`, and `path` follows Task 2's row semantics (config value verbatim
          // on a valid `off`, `null` on `invalid`).
          venv: { enabled: false, created: false, adopted: false, path: interpreter.path },
          // 系统模式不消费登记、也没有清理动作：旧登记 venv 可能仍在，故给固定注记
          // 让 render 与稳态「无需清理」可区分（G3-10）。
          cleanup: { oldPath: null, action: 'none', error: CLEANUP_NOTE_SYSTEM_MODE },
        };
      }

      // `absPath` is taken **only** here, from the same evaluation the gate used — this
      // module never calls `resolveVenvPath` itself.
      const absPath = interpreter.path;
      // `ensureVenv` forwards `signal` into the runner and is the one primitive that
      // rejects on abort: that rejection is deliberately *not* caught here.
      const outcome = await ensureVenv(makeRun(exec), absPath, ensureVenvOptions(exec, seams));

      // The venv-mode command is assembled here (spec §3: `lib/venv.js` only answers
      // paths, this layer owns the command). The call-time `user`/`breakSystemPackages`
      // flags are deliberately absent: they are system-mode switches, and the render
      // says so.
      const installCmd = [join(absPath, 'bin', 'pip3'), 'install', '-r', requirementsPath];

      if (typeof outcome.error === 'string' && outcome.error !== '') {
        // Creation failure / refusal / broken: the install was never executed, so the
        // payload reports the truthful command with `-1` and no cleanup or registration
        // happened. The re-run still runs — with the venv config, hence the missing-venv
        // vocabulary of spec §5.3.
        const checkEnv = await runCheckEnv(roots, exec, requirementsPath, venv, options?.repoRoot);

        exec?.signal?.throwIfAborted();
        return {
          installCmd,
          installExit: -1,
          checkEnv,
          venv: {
            enabled: true,
            created: false,
            adopted: false,
            path: absPath,
            error: outcome.error,
          },
          cleanup: { oldPath: null, action: 'none', error: CLEANUP_NOTE_INSTALL_NOT_RUN },
        };
      }

      const installExit = await runInstall(installCmd, exec);
      const cleanup =
        installExit === 0
          ? settleOldVenv({ venv, absPath, seams })
          : { oldPath: null, action: 'none', error: CLEANUP_NOTE_INSTALL_FAILED };

      const checkEnv = await runCheckEnv(roots, exec, requirementsPath, venv, options?.repoRoot);

      exec?.signal?.throwIfAborted();
      return {
        installCmd,
        installExit,
        checkEnv,
        venv: {
          enabled: true,
          created: outcome.created === true,
          adopted: outcome.adopted === true,
          path: absPath,
        },
        cleanup,
      };
    },
  };
}

/**
 * `ensureVenv`'s options: the signal is forwarded verbatim (a cancellation must keep
 * propagating), and the marker write is routed through the test seam when one exists —
 * `lib/venv.js` owns the warn-channel degradation, this layer only chooses the writer.
 */
function ensureVenvOptions(exec, seams) {
  const options = { signal: exec?.signal };
  if (typeof seams?.writeMarker === 'function') options.writeMarker = seams.writeMarker;
  return options;
}

/**
 * The old-venv lifecycle after a **successful** install: read the registration, clean
 * up per policy, then re-register the current path (spec §4.3 order). Called only on
 * `installExit === 0` (see `setupDepsTool`), which is what makes the deletion policy's
 * "delete after the next successful setup_deps" promise and the registration's meaning
 * ("the venv we last installed into") hold together.
 *
 * `cleanup.error` is a **note channel** and carries three note classes, concatenated so
 * none overwrites another:
 * 1. read failure (`readWrapperState().readError` non-empty) — the old path is unknown,
 *    so cleanup is skipped with `action: 'none'` and the note never masquerades as
 *    `'failed'` (spec §6's wrapper-state row);
 * 2. a precondition refusal — `cleanupOldVenv` returns `action: 'none'` *with* the
 *    refusal reason (e.g. a missing ownership marker), which is a note and not a delete
 *    failure either;
 * 3. registration failure — a throwing `writeWrapperState` leaves `action` exactly as
 *    cleanup reported it, appends a note labelled 登记失败（非删除失败）**and** emits one
 *    `console.warn` carrying the registration target plus the reason (spec §6 asks for the
 *    note; the warn channel is the log-side counterpart of the marker-write row — G3-11).
 *
 * The steady state — the registered path **is** the path in use — is deliberately *not*
 * one of them: it is the most common invocation (every successful venv-mode run after
 * the first) and there is nothing to clean up, so it must render as an idle row with no
 * note at all. That case short-circuits here instead of reaching `cleanupOldVenv`, whose
 * equal-path branch stays a defensive guard whose refusal text only ever surfaces to a
 * direct caller.
 *
 * @param {{ venv?: object, absPath: string, seams: { readWrapperState?: Function,
 *   writeWrapperState?: Function, remove?: Function } }} params
 * @returns {{ oldPath: string|null, action: 'none'|'kept'|'deleted'|'failed', error?: string }}
 */
function settleOldVenv({ venv, absPath, seams }) {
  const state = seamOr(seams?.readWrapperState, readWrapperState)();
  let cleanup = { oldPath: null, action: 'none' };
  let note = null;

  if (typeof state?.readError === 'string' && state.readError !== '') {
    note = `wrapper-state 读取失败，跳过旧 venv 清理（非删除失败）：${state.readError}`;
  } else if (typeof state?.lastVenvPath === 'string') {
    cleanup = { oldPath: state.lastVenvPath, action: 'none' };
    if (state.lastVenvPath !== absPath) {
      const remove = typeof seams?.remove === 'function' ? { remove: seams.remove } : {};
      const result = cleanupOldVenv(state.lastVenvPath, venv?.oldPathPolicy, absPath, remove);
      cleanup.action = result.action;
      if (typeof result.error === 'string' && result.error !== '') note = result.error;
    }
  }

  try {
    seamOr(seams?.writeWrapperState, writeWrapperState)(absPath);
  } catch (error) {
    const reason = error?.message ?? error;
    // 两条通道互不替代（spec §6 登记失败行 + Gate 3 G3-11）：payload 注记是模型可见面，
    // `console.warn` 是与 marker 写失败行对称的**日志**面——登记失败不改变清理结论
    // （`action` 如实保留、注记照旧追加），但至少要能在日志里按 absPath + 原因定位。
    console.warn(`venv: wrapper-state 登记失败（非删除失败）——${absPath}: ${reason}`);
    note = appendNote(note, `wrapper-state 登记失败（非删除失败）：${reason}`);
  }

  return note === null ? cleanup : { ...cleanup, error: note };
}

/** The injected stub when it exists, else the module primitive（production path）. */
function seamOr(seam, primitive) {
  return typeof seam === 'function' ? seam : primitive;
}

/** Append one note to another without overwriting（`null`/empty start = the note itself）. */
function appendNote(current, note) {
  if (typeof note !== 'string' || note === '') return current;
  return typeof current === 'string' && current !== '' ? `${current}；${note}` : note;
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
 *
 * `venv` is the fourth, **configuration** channel (a parameter, never an environment
 * variable or module state): the de-referenced plain value from the injection bag, handed
 * straight to `checkEnvTool` so the re-run answers about the same environment the install
 * targeted instead of silently reporting the venv-off default. Omitted/`undefined` keeps
 * the system-mode answer. It stays the fourth parameter (the pinned shape callers rely on);
 * `repoRoot` is an optional fifth that carries the assembly-time `.env` probe anchor (R2 M3)
 * through unchanged — `undefined` keeps `checkEnvTool`'s production default.
 *
 * @param {string[]|undefined} roots Skill-root override (as `createTools`).
 * @param {object|undefined} exec Per-call exec object (injected `run`, `signal`, …).
 * @param {string|null} requirementsPath Requirements file the report is about.
 * @param {{ enabled: boolean, path: string, oldPathPolicy: 'keep'|'delete' }} [venv]
 *   De-referenced venv config; `undefined` evaluates as "nothing configured".
 * @param {string} [repoRoot] The third `.env` probe anchor (assembly-time seam); omitted
 *   means this package's own root.
 */
function runCheckEnv(roots, exec, requirementsPath, venv, repoRoot) {
  return checkEnvTool({ skillRoots: roots, venv, repoRoot }).execute({ requirementsPath }, exec);
}

/** `true` for an abort (by name or code), whichever way the runtime spells it. */
function isAbortError(error) {
  return error !== null && typeof error === 'object'
    && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
}

/**
 * Render the setup payload: the exact command that ran, its exit code, the venv
 * orchestration lines and the re-run diagnostic — which keeps the *same* rendering the
 * check_env tool produces, so an agent that has learned to read one can read the other.
 *
 * Pinned lines (spec §5.3/§6):
 * - the four "install not executed" rows say so (and carry `venv.error` — creation
 *   failure, non-empty non-venv refusal, exists-but-broken, and the half-built
 *   `venv 内 pip3 缺失（安装不完整）` shape), which must
 *   stay distinguishable from a **genuine** install failure — the latter keeps its real
 *   exit code and must never be rendered as "not executed";
 * - venv mode announces that the call-time `user`/`breakSystemPackages` flags are
 *   ignored;
 * - the four `cleanup.action` values each get a line, and `kept` names the old path plus
 *   both ways out (clean it up manually, or point `venv.path` back at it).
 */
function renderSetupDeps(payload) {
  const venv = payload.venv ?? null;
  return [
    `install: ${payload.installCmd.join(' ')}`,
    `install exit: ${payload.installExit}`,
    ...installOutcomeLines(payload, venv),
    ...venvLines(venv),
    ...cleanupLines(payload.cleanup ?? null),
    're-check:',
    renderCheckEnv(payload.checkEnv),
  ].join('\n');
}

/**
 * The install-outcome line: "not executed" is keyed on `venv.error` (only the four
 * preparation-failure rows carry it — creation failure, non-empty non-venv refusal,
 * exists-but-broken and `venv 内 pip3 缺失（安装不完整）`), never on the exit code — a real pip
 * failure has a real non-zero code and must be reported as a failure, not as a skipped
 * install.
 */
function installOutcomeLines(payload, venv) {
  if (typeof venv?.error === 'string' && venv.error !== '') {
    return [`install 未执行（venv 准备失败）：${venv.error}`];
  }
  if (payload.installExit === 0) return [];
  return ['install did not succeed — the environment below is unchanged/partial'];
}

/** The venv-mode explanation lines (none in system mode, where `enabled` is `false`). */
function venvLines(venv) {
  if (venv === null || venv.enabled !== true) return [];
  return [
    `venv: ${venv.path}（created=${venv.created}, adopted=${venv.adopted}）`,
    'venv 模式忽略 user/breakSystemPackages（调用期 flags 仅系统模式生效）',
  ];
}

/**
 * The old-venv lifecycle lines: one per `cleanup.action`, plus the note channel.
 *
 * The `'none'` arm splits on the note: **with** one it renders 「未清理（<原因>）」 — a
 * genuine precondition refusal, a read failure, a registration failure, or one of the
 * three fixed notes on the return paths outside the install-success gate (G3-10) — while
 * **without** one it renders 「无需清理」, the steady-state row (install succeeded and the
 * registered path is the path in use, or a first run with nothing registered).
 */
function cleanupLines(cleanup) {
  if (cleanup === null) return [];
  const at = cleanup.oldPath === null ? '' : `（${cleanup.oldPath}）`;
  switch (cleanup.action) {
    case 'kept':
      return [`cleanup: 旧 venv 保留${at} —— 请手动清理该目录，或将 venv.path 改回该路径以复用它`];
    case 'deleted':
      return [`cleanup: 旧 venv 已删除${at}`];
    case 'failed':
      return [`cleanup: 旧 venv 删除失败${at}: ${cleanup.error ?? '原因未知'}`];
    default:
      return cleanup.error === undefined
        ? [`cleanup: 无需清理${at}`]
        : [`cleanup: 未清理${at}: ${cleanup.error}`];
  }
}
