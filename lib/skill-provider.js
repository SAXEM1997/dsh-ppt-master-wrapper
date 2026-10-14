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
 * @module dsh-ppt-master-wrapper/lib/skill-provider
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

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
 * @param {string[]} [roots] Skill root directories; defaults to this package's
 *   own `skills/`, located from the module file rather than the working
 *   directory.
 * @returns {{ name: string, list: (options?: object) => Promise<object[]>,
 *   get: (candidate: object, options?: object) => Promise<object | undefined> }}
 *   The provider: `list()` returns candidates sorted by `name` byte order,
 *   `get()` returns the full definition (with the verbatim body `content`) or
 *   `undefined` when the skill is gone.
 * @throws {Error} On any of the fail-loud conditions above.
 */
export function createSkillProvider(roots) {
  // `undefined`/`null` selects the packaged root, which then goes through the
  // same validation as an injected root — so a missing `skills/` reports the
  // path instead of surfacing a bare ENOENT from the directory scan.
  const scanRoots = normalizeRoots(roots);

  // Register-time validation: the catalog must be loadable and legal before any
  // caller can observe the provider, so a broken packaged tree aborts startup.
  const skills = loadSkillsSync(scanRoots);

  return {
    name: PROVIDER_NAME,

    async list(options) {
      options?.signal?.throwIfAborted();
      const candidates = skills.map((skill) => toCandidate(skill));
      options?.signal?.throwIfAborted();
      return candidates;
    },

    async get(candidate, options) {
      options?.signal?.throwIfAborted();
      const skill = skills.find((entry) => entry.name === candidate?.name);
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
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: SKILL_SOURCE,
    resourceBase: { kind: 'directory', path: skill.directory },
    rank: SKILL_RANK,
    locator: skill.skillFile,
    path: skill.skillFile,
  };
}

/** Project a skill record onto the registry's full definition shape. */
function toDefinition(skill) {
  return { ...toCandidate(skill), content: skill.content };
}

/**
 * Compare two strings by UTF-16 code unit — a `localeCompare`-free byte-order
 * sort whose result does not depend on the host locale.
 */
function compareByteOrder(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

