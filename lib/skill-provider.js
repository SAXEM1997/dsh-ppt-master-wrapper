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

const FRONTMATTER_DELIMITER = '---';
/** A nested block is detected by indentation; child keys are de-indented by this much. */
const INDENT_UNIT = 2;

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

  // Lossless split: re-joining every segment reproduces `raw` byte for byte,
  // so the returned body keeps the document's original line endings.
  const lines = raw.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines[0] !== FRONTMATTER_DELIMITER) return null;

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FRONTMATTER_DELIMITER) {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex < 0) return null;

  const data = parseSimpleYaml(lines.slice(1, closingIndex).join('\n'));
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;

  return { data, body: lines.slice(closingIndex + 1).join('\n') };
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
