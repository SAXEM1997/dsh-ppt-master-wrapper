/**
 * Minimal, zero-dependency YAML-frontmatter parsing for SKILL.md files.
 *
 * This module intentionally implements only the subset of YAML that SKILL.md
 * frontmatter uses in practice: `key: value` scalars, nested objects by
 * indentation, `- item` sequences, `>` folded and `|` literal block scalars,
 * and single/double quoted values.
 *
 * It is deliberately not a general YAML parser: anchors, aliases, tags,
 * flow collections and multi-document streams are out of scope, and any
 * unparsable line is skipped rather than throwing.
 *
 * The module also owns the skill catalog itself. Alongside the vendor `skills/`
 * tree it synthesizes one **memory-only** entry skill, `ppt-master-env`, which
 * carries the interpreter-routing contract (spec §5.2): it exists only as a catalog
 * record, is never written to disk, and is catalogued only when the provider is
 * created without explicit roots — so the packaged `skills/` tree stays byte-identical.
 *
 * @module dsh-ppt-master-wrapper/lib/skill-provider
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { effectiveInterpreter, normalizeVenvInput } from './venv.js';

const FRONTMATTER_DELIMITER = '---';
/** A nested block is detected by indentation; child keys are de-indented by this much. */
const INDENT_UNIT = 2;

/** The Kebab-case grammar a skill `name` must satisfy. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The instruction file every skill directory must carry directly inside it. */
const SKILL_FILE_NAME = 'SKILL.md';

/** Provider name registered on `ctx.skills`; also stamped on every candidate. */
export const PROVIDER_NAME = 'dsh-ppt-master-wrapper';

/**
 * Precedence rank for packaged skill providers.
 *
 * 550 follows the locally installed superpowers-dsh constant rather than an SDK
 * export: it ranks below the SDK's `BUNDLED_SKILL_RANK` (600), so a locally
 * bundled skill wins a duplicate name. Re-check this pairing when the upstream
 * reference implementation changes (see spec §3.4).
 */
export const SKILL_RANK = 550;

/** Discovery source bucket these skills advertise under (prompt-visible metadata). */
const SKILL_SOURCE = 'custom';

/** This package's own `skills/` directory, located from the module, never from cwd. */
const PACKAGED_SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url));

/** The synthesized entry skill's name; it is never written to disk (spec §5.2). */
const ENTRY_SKILL_NAME = 'ppt-master-env';

/**
 * Frontmatter name of the upstream本体 skill the entry skill anchors on — it names
 * both the routing target and the preferred `SKILL_DIR` source.
 */
const PRIMARY_SKILL_NAME = 'ppt-master';

/** The entry skill's bilingual description (spec §5.2: 中英双语 + 前置声明). */
const ENTRY_SKILL_DESCRIPTION =
  'ppt-master 解释器路由入口（PPT-MASTER interpreter routing entry）：任何 ppt-master 路由前必须先读本入口，' +
  '它给出当前生效解释器与准备状态。Read this entry before any ppt-master routing: it states the effective ' +
  'interpreter and the preparation state.';

/**
 * The entry skill's text for `on-missing` **and** for the broken `on-ready` sub-state.
 *
 * A venv whose interpreter does not resolve has no path to substitute, so it must not
 * advertise state 1's interpreter contract; `on-ready`+broken therefore takes this,
 * the "enabled but not ready" state of the pinned four — the state that routes to
 * `ppt_master_setup_deps`, whose own fail-loud verdict carries the delete-and-retry
 * guidance for a broken venv (spec §6).
 */
const NOT_READY_CONTRACT = [
  'venv 已启用，但解释器尚未就绪（venv 未创建，或目录已损坏）：先调用 `ppt_master_setup_deps` 准备环境；',
  '在它成功之前，不要以系统 `python3` 运行任何上游业务脚本。',
].join('');

/**
 * Split a YAML frontmatter block off a document.
 *
 * @param {string} raw Full file contents.
 * @returns {{ data: Record<string, unknown>, body: string } | null} The parsed
 *   frontmatter and the remaining body, or `null` when the document has no
 *   leading `---` block or the block is never closed.
 */
export function parseFrontmatter(raw) {
  if (typeof raw !== 'string') return null;

  if (raw === '') return null;

  // Scan the document line by line, keeping each line's span so the body can
  // be sliced out of `raw` afterwards. Comparison strips a trailing `\r` so
  // CRLF documents parse the same as LF ones, but the slice keeps the original
  // bytes: the returned body preserves the document's line endings verbatim.
  const lines = raw.split('\n');
  if (delimiterText(lines[0]) !== FRONTMATTER_DELIMITER) return null;

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (delimiterText(lines[i]) === FRONTMATTER_DELIMITER) {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex < 0) return null;

  // YAML data section: CRLF is normalised away here (CRLF and LF YAML are
  // equivalent), which is why we join the segments instead of slicing.
  const yamlText = lines
    .slice(1, closingIndex)
    .map(delimiterText)
    .join('\n');
  const data = parseSimpleYaml(yamlText);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;

  return { data, body: bodyAfterLine(raw, closingIndex) };
}

/** A line without its trailing `\r`, for delimiter comparison. */
function delimiterText(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * The verbatim remainder of `raw` after the line at `lineIndex`.
 *
 * The result is a slice of `raw`, so it keeps the original `\r\n` / `\n`
 * bytes and the presence or absence of a final newline.
 */
function bodyAfterLine(raw, lineIndex) {
  let offset = 0;
  for (let i = 0; i <= lineIndex; i++) {
    const newline = raw.indexOf('\n', offset);
    if (newline < 0) return '';
    offset = newline + 1;
  }
  return raw.slice(offset);
}

/**
 * Parse a YAML fragment containing scalars, nested objects, `- item`
 * sequences and `>` / `|` block scalars.
 *
 * Unknown or unparsable lines are ignored; blank lines and `#` comments are
 * skipped. Keys whose value is an absent nested block become `null`.
 *
 * @param {string} text YAML fragment (frontmatter body without delimiters).
 * @returns {Record<string, unknown>} Parsed mapping, `{}` when nothing parsed.
 */
export function parseSimpleYaml(text) {
  if (typeof text !== 'string' || text.trim() === '') return {};

  const lines = splitLines(text);
  const result = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const content = line.trim();
    if (content === '' || content.startsWith('#')) {
      i++;
      continue;
    }

    const indent = countIndent(line);
    const colonIndex = content.indexOf(':');
    if (colonIndex < 0) {
      // Not a mapping entry — skip rather than fail.
      i++;
      continue;
    }

    const key = content.slice(0, colonIndex).trim();
    const valuePart = content.slice(colonIndex + 1).trim();

    if (isBlockScalarHeader(valuePart)) {
      const { value, nextIndex } = readBlockScalar(lines, i + 1, indent, valuePart);
      result[key] = value;
      i = nextIndex;
      continue;
    }

    if (valuePart !== '') {
      result[key] = stripQuotes(valuePart);
      i++;
      continue;
    }

    // Empty value: either a nested object, a sequence, or genuinely null.
    const { block, nextIndex } = collectIndentedBlock(lines, i + 1, indent);
    if (block.length === 0) {
      result[key] = null;
      i = nextIndex;
      continue;
    }

    const childText = block.map((child) => dedent(child, indent + INDENT_UNIT)).join('\n');
    result[key] = isSequence(childText)
      ? parseSequence(childText)
      : parseSimpleYaml(childText);
    i = nextIndex;
  }

  return result;
}

// ─── internals ───────────────────────────────────────────────────

/** Split on `\n`, normalise CRLF, and drop a single trailing empty line. */
function splitLines(text) {
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function countIndent(line) {
  return line.length - line.trimStart().length;
}

function isBlockScalarHeader(valuePart) {
  return /^[>|][+-]?\d*$/.test(valuePart);
}

/** Collect the contiguous run of lines deeper than `indent`. */
function collectIndentedBlock(lines, start, indent) {
  const block = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      block.push('');
      i++;
      continue;
    }
    if (countIndent(line) <= indent) break;
    block.push(line);
    i++;
  }
  return { block, nextIndex: i };
}

/**
 * `>` folds newlines into spaces; `|` preserves them. Leading/trailing blank
 * filler is clipped and the common indentation is removed.
 */
function readBlockScalar(lines, start, indent, header) {
  const { block } = collectIndentedBlock(lines, start, indent);
  const nextIndex = start + block.length;

  let content = block;
  while (content.length > 0 && content[0].trim() === '') content = content.slice(1);
  while (content.length > 0 && content[content.length - 1].trim() === '') content = content.slice(0, -1);
  if (content.length === 0) return { value: '', nextIndex };

  const minIndent = Math.min(
    ...content.filter((line) => line.trim() !== '').map((line) => countIndent(line)),
  );
  const dedented = content.map((line) => (line.trim() === '' ? '' : line.slice(minIndent)));

  const value = header.startsWith('>')
    ? dedented.join(' ').replace(/\s+/g, ' ').trim()
    : dedented.join('\n');
  return { value, nextIndex };
}

function dedent(line, amount) {
  if (line.trim() === '') return '';
  return line.length >= amount && line.slice(0, amount).trim() === '' ? line.slice(amount) : line;
}

function isSequence(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .every((line) => line.trim() === '-' || line.trim().startsWith('- '));
}

function parseSequence(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line === '-' || line.startsWith('- '))
    .map((line) => stripQuotes(line.slice(1).trim()));
}

function stripQuotes(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

// ─── skill provider ──────────────────────────────────────────────

/**
 * Locate every skill directory under one root.
 *
 * The authoritative predicate (spec §3.4, shared with Task 3): a **first-level
 * directory** whose **direct child** is a `SKILL.md` is a skill — dotfile
 * directories included, symlinks included. Directories without one are skipped
 * silently, and nothing deeper is ever inspected.
 *
 * Returned paths are absolute (built from `root` and the entry name) and sorted
 * by **directory name byte order** — the same `localeCompare`-free order the
 * provider uses for skill names.
 *
 * Existence is tested before reading, so a SKILL.md-less directory never
 * surfaces an ENOENT; the SKILL.md contents themselves are *not* parsed here.
 *
 * @param {string} root Skill root directory.
 * @returns {string[]} Absolute skill directory paths, in directory-name byte order.
 * @throws {Error} When `root` does not exist or is not a directory — fail-loud,
 *   so a caller never mistakes a bad root for an empty skill set.
 */
export function listSkillDirs(root) {
  if (!existsSync(root)) {
    throw new Error(`${PROVIDER_NAME}: skill root does not exist: ${root}`);
  }
  if (!statSync(root).isDirectory()) {
    throw new Error(`${PROVIDER_NAME}: skill root is not a directory: ${root}`);
  }
  const directories = [];
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const directory = join(root, entry.name);
    if (!existsSync(join(directory, SKILL_FILE_NAME))) continue; // no SKILL.md → not a skill
    directories.push(directory);
  }
  return directories.sort((left, right) => compareByteOrder(baseName(left), baseName(right)));
}

/** The final path segment of an absolute or relative path. */
function baseName(directory) {
  const separator = directory.lastIndexOf('/');
  return separator < 0 ? directory : directory.slice(separator + 1);
}

/**
 * Build the `ctx.skills` provider for the packaged skill set.
 *
 * The scan is generalised: every first-level directory of every root that
 * carries a `SKILL.md` directly inside it is a skill — dotfile directories
 * included — and every directory without one is skipped silently. Upstream may
 * therefore add or drop skill directories without touching this code.
 *
 * Registration is **fail-loud**, and the whole catalog is validated eagerly:
 * this call throws when a root does not exist, when the roots together yield no
 * skill directory, or when a directory carrying a `SKILL.md` has a frontmatter
 * that lacks `name`/`description` or carries a non-kebab-case `name`. A
 * `name` that merely differs from its directory name is *not* a failure here —
 * that is the warning-level verdict of the verify layer (spec §3.4).
 *
 * Unlike the reference implementation, this scanner tests for `SKILL.md` before
 * reading it; a blind `readFile` would throw ENOENT for every directory without
 * one, which is exactly the case the authoritative predicate says to skip.
 *
 * The catalog additionally carries the synthesized entry skill `ppt-master-env`
 * (spec §5.2) on the production path. The entry record is memory-only — no file is
 * ever written — and its body is rendered **once, here**, so it is a snapshot of this
 * provider instance: a venv config change reaches the body when the instance is
 * rebuilt (spec §5.2 freshness), and a filesystem change afterwards is covered by the
 * body's fixed footnote pointing at `ppt_master_info`/`ppt_master_check_env`.
 *
 * @param {string[]} [roots] Skill root directories; defaults to this package's
 *   own `skills/`, located from the module file rather than the working
 *   directory.
 * @param {{ venv?: { enabled: boolean, path: string, oldPathPolicy: 'keep'|'delete' } }} [opts]
 *   Unified injection-bag subset (Task 5), already de-referenced to plain values: the
 *   `venv` the entry body's four-state contract is evaluated from, in a single
 *   `effectiveInterpreter` call. The production path always receives it; a direct
 *   factory call without one evaluates as `invalid` and renders the correction text.
 *   A *present* `venv` goes through `normalizeVenvInput` first (Gate 3 G3-09): a partial
 *   object such as `{ path }` — no `enabled` key — is completed with the same defaults
 *   `createTools` uses, and anything but a literal `true` normalises to `enabled: false`,
 *   so a missing key can never render the "venv is on" states.
 * @returns {{ name: string, list: (options?: object) => Promise<object[]>,
 *   get: (candidate: object, options?: object) => Promise<object | undefined> }}
 *   The provider: `list()` returns candidates sorted by `name` byte order,
 *   `get()` returns the full definition (with the verbatim body `content`) or
 *   `undefined` when the skill is gone. `ppt-master-env` is part of the catalog
 *   only when `roots` was omitted (decision A: any explicit roots — the packaged
 *   directory included — leave the catalog vendor-only, and the synthesized
 *   candidate carries no `resourceBase`).
 * @throws {Error} On any of the fail-loud conditions above.
 */
export function createSkillProvider(roots, opts) {
  // Decision A trigger, read from the **argument** rather than from `scanRoots`
  // (which substitutes the packaged root for an omitted one): only a
  // parameter-omitted creation synthesizes the entry skill. Explicitly passing the
  // packaged `skills/` is still "explicit roots" and therefore appends nothing.
  const withEntrySkill = roots === undefined || roots === null;

  // `undefined`/`null` selects the packaged root, which then goes through the
  // same validation as an injected root — so a missing `skills/` reports the
  // path instead of surfacing a bare ENOENT from the directory scan.
  const scanRoots = normalizeRoots(roots);

  // Register-time validation: the catalog must be loadable and legal before any
  // caller can observe the provider, so a broken packaged tree aborts startup.
  const skills = loadSkillsSync(scanRoots);

  // The entry record joins the already name-sorted vendor list and the whole catalog
  // is re-sorted, so `list()` keeps its documented name byte-order invariant.
  const catalog = withEntrySkill
    // 工厂入口归一化（Gate 3 G3-09）：与 `createTools` 同判——`{venv:{path}}` 这类缺 `enabled`
    // 键的部分对象不得被当成"已启用"而渲染态2 指引（`normalizeVenvInput` 见 `lib/venv.js`）。
    ? [...skills, synthesizeEntrySkill(skills, normalizeVenvInput(opts?.venv))].sort((left, right) =>
        compareByteOrder(left.name, right.name),
      )
    : skills;

  return {
    name: PROVIDER_NAME,

    async list(options) {
      options?.signal?.throwIfAborted();
      const candidates = catalog.map((skill) => toCandidate(skill));
      options?.signal?.throwIfAborted();
      return candidates;
    },

    async get(candidate, options) {
      options?.signal?.throwIfAborted();
      const skill = catalog.find((entry) => entry.name === candidate?.name);
      if (skill === undefined) return undefined;
      const definition = toDefinition(skill);
      options?.signal?.throwIfAborted();
      return definition;
    },
  };
}

/** Validate the caller-supplied roots, normalising an omitted/empty argument. */
function normalizeRoots(roots) {
  // An omitted argument selects the packaged root, and that root is validated by
  // the same loop below rather than short-circuited — otherwise a missing
  // packaged `skills/` would surface as a bare scan ENOENT.
  const requested = roots === undefined || roots === null ? [PACKAGED_SKILLS_ROOT] : roots;
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new Error(`${PROVIDER_NAME}: roots must be a non-empty array of directory paths`);
  }
  return requested.map((root) => {
    if (typeof root !== 'string' || root === '') {
      throw new Error(`${PROVIDER_NAME}: invalid skill root ${JSON.stringify(root)}`);
    }
    if (!existsSync(root)) {
      throw new Error(`${PROVIDER_NAME}: skill root does not exist: ${root}`);
    }
    if (!statSync(root).isDirectory()) {
      throw new Error(`${PROVIDER_NAME}: skill root is not a directory: ${root}`);
    }
    return root;
  });
}

/**
 * Discover and validate every skill under `roots`.
 *
 * Existence is tested before reading (the authoritative predicate), so
 * SKILL.md-less directories—dotfile ones included—are skipped without error.
 * A directory that *does* carry a SKILL.md must be fully legal, otherwise this
 * throws: partial catalogs are never observable.
 */
function loadSkillsSync(scanRoots) {
  const skills = [];
  for (const root of scanRoots) {
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const directory = join(root, entry.name);
      const skillFile = join(directory, SKILL_FILE_NAME);
      if (!existsSync(skillFile)) continue; // no SKILL.md → not a skill, skip silently
      skills.push(parseSkill(readFileSync(skillFile, 'utf8'), directory, skillFile));
    }
  }

  if (skills.length === 0) {
    // A nonexistent root already failed in normalizeRoots, so the reachable case
    // here is "roots exist but hold no skill directory". The message still names
    // both criteria because the injected-root contract exposes them as one
    // fail-loud condition to callers (spec §3.4).
    throw new Error(
      `${PROVIDER_NAME}: no skill directory found under roots（不存在或为空）: ${scanRoots.join(', ')}`,
    );
  }

  // Deterministic byte order on the skill name (not locale order), matching the
  // directory-name byte-order convention used by the rest of the plugin.
  skills.sort((left, right) => compareByteOrder(left.name, right.name));
  return skills;
}

/** Parse one SKILL.md into the internal skill record, or throw when illegal. */
function parseSkill(raw, directory, skillFile) {
  const parsed = parseFrontmatter(raw);
  if (parsed === null) {
    throw new Error(`${PROVIDER_NAME}: ${skillFile} has no parsable frontmatter block`);
  }

  const name = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : '';
  const description = typeof parsed.data.description === 'string' ? parsed.data.description.trim() : '';
  if (name === '') {
    throw new Error(`${PROVIDER_NAME}: ${skillFile} frontmatter requires a name`);
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`${PROVIDER_NAME}: ${skillFile} has a non-kebab-case name "${name}"`);
  }
  if (description === '') {
    throw new Error(`${PROVIDER_NAME}: ${skillFile} frontmatter requires a description`);
  }

  const metadata = parsed.data.metadata;
  const hasMetadata = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata);

  return {
    name,
    description,
    ...(hasMetadata ? { metadata } : {}),
    directory,
    skillFile,
    // The body is kept as the verbatim slice produced by parseFrontmatter —
    // never trimmed here, so CRLF and leading newlines survive to consumers.
    content: parsed.body,
  };
}

/** Project a skill record onto the registry's candidate shape. */
function toCandidate(skill) {
  const candidate = {
    name: skill.name,
    description: skill.description,
    ...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: SKILL_SOURCE,
    rank: SKILL_RANK,
  };
  // The synthesized entry skill has no file behind it, so the file-bound fields are
  // omitted rather than pointed at a path that does not exist: `resourceBase` (which
  // the host passes through only when `!== undefined`, then renders "resources are
  // managed by provider …"), and `locator`/`path` (which `get()` never needs — it
  // keys off `name` alone).
  if (skill.memoryOnly === true) return candidate;
  return {
    ...candidate,
    resourceBase: { kind: 'directory', path: skill.directory },
    locator: skill.skillFile,
    path: skill.skillFile,
  };
}

/** Project a skill record onto the registry's full definition shape. */
function toDefinition(skill) {
  return { ...toCandidate(skill), content: skill.content };
}

// ─── synthesized entry skill ─────────────────────────────────────

/**
 * Synthesize the `ppt-master-env` catalog record (spec §5.2).
 *
 * The record has the internal shape `parseSkill` produces minus every file-bound
 * field — there is no directory and no `SKILL.md` — which is what makes
 * `toCandidate` emit a candidate without `resourceBase`/`locator`/`path`.
 *
 * `effectiveInterpreter` is evaluated exactly once, here, through its
 * single-argument form (the module's own synchronous probe): `path`, `exists`,
 * `pythonPath` and `broken` reach the body from one decision, never from a second
 * judgement by this module.
 *
 * @param {object[]} skills The loaded, name-byte-order-sorted vendor catalog.
 * @param {{ enabled: boolean, path: string, oldPathPolicy: 'keep'|'delete' }} [venv]
 *   De-referenced plain venv config from the injection bag.
 * @returns {object} The memory-only skill record.
 */
function synthesizeEntrySkill(skills, venv) {
  const interpretation = effectiveInterpreter(venv);
  return {
    name: ENTRY_SKILL_NAME,
    description: ENTRY_SKILL_DESCRIPTION,
    memoryOnly: true,
    content: renderEntrySkillBody(interpretation, primarySkillDirectory(skills)),
  };
}

/**
 * Anchor the body's `SKILL_DIR` on the provider's **own already-loaded metadata**:
 * the skill whose frontmatter `name` is `ppt-master`, else the first record of the
 * loaded list — which `loadSkillsSync` sorted by name byte order.
 *
 * `lib/tools.js`'s private `locateSkillDir` is deliberately not consulted. The two
 * rules can diverge for injected multi-root catalogs (this one ranks by frontmatter
 * name across all roots, that one expands roots and ranks by directory name); the
 * provider side is the baseline Task 7 unifies on.
 *
 * @param {object[]} skills Non-empty loaded catalog.
 * @returns {string} Absolute skill directory.
 */
function primarySkillDirectory(skills) {
  const primary = skills.find((skill) => skill.name === PRIMARY_SKILL_NAME);
  return (primary ?? skills[0]).directory;
}

/** Render the entry body: state contract, `SKILL_DIR`, routing step, fixed footnote. */
function renderEntrySkillBody(interpretation, skillDir) {
  return [
    '# ppt-master-env：解释器路由入口（interpreter routing entry）',
    '',
    '本入口由 dsh-ppt-master-wrapper 在插件实例注册期合成（内存对象，不落盘）：任何 ppt-master 路由前必须先读本入口。',
    '本入口只承载解释器契约，不改上游流程。',
    '',
    '## 当前生效解释器（实例注册期快照）',
    '',
    interpreterContract(interpretation),
    '',
    '## SKILL_DIR',
    '',
    `SKILL_DIR: ${skillDir}`,
    '',
    '## 读毕路由',
    '',
    `准备就绪后（见上）读 \`${skillDir}/SKILL.md\`，按其流程路由 \`ppt-master\`。`,
    '',
    '## 实时状态（固定脚注）',
    '',
    '本入口正文是注册期快照，**配置变化**（如在插件页改了 `venv.*`）与文件系统变化（如 venv'
      + ' 被外部删除或损坏）后都可能陈旧：实时生效解释器与依赖状态一律以 `ppt_master_info` /'
      + ' `ppt_master_check_env` 为准（这两个工具每轮现读配置，不受本快照影响）；'
      + '`ppt_master_setup_deps` 执行后以该工具输出为准。',
    '',
  ].join('\n');
}

/**
 * The state-specific half of the entry body — spec §5.2's four states keyed by
 * `effectiveInterpreter().state`.
 *
 * `on-ready` without `broken` is the only state that can advertise a concrete
 * interpreter path. The broken sub-state shares the `on-missing` text (see
 * `NOT_READY_CONTRACT`): it also has no resolvable interpreter, so state 1's
 * substitution contract would name a path that does not work. `disabled×invalid`
 * arrives here as `off` (disabled beats path semantics), hence state 3.
 *
 * @param {{ state: string, pythonPath: string|null, broken: boolean }} interpretation
 * @returns {string}
 */
function interpreterContract(interpretation) {
  switch (interpretation.state) {
    case 'on-ready':
      return interpretation.broken
        ? NOT_READY_CONTRACT
        : [
            `生效解释器：\`${interpretation.pythonPath}\``,
            '一切上游脚本调用一律以该绝对路径替换字面 `python3` —— 包括 SKILL.md 第 2 步 '
              + 'attribution_guard 的字面 `python3` 调用。',
          ].join('\n');
    case 'on-missing':
      return NOT_READY_CONTRACT;
    case 'off':
      return 'venv 未启用：使用系统 `python3`（现状系统模式）。';
    default:
      // `invalid`: a configured-but-unusable path. Behaviour degrades to system mode,
      // and the visible correction channel is the config page / profile patch.
      return [
        '配置无效：`venv.path` 必须为绝对路径或 `~/` 前缀（当前值无法解析）。',
        '请在配置页或 profile patch 修正；修正前按系统模式继续，使用系统 `python3`。',
      ].join('');
  }
}

/**
 * Compare two strings by UTF-16 code unit — a `localeCompare`-free byte-order
 * sort whose result does not depend on the host locale.
 */
function compareByteOrder(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

