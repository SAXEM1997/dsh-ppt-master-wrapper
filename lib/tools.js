/**
 * Tool definitions for the ppt-master wrapper.
 *
 * Task 4 shipped this module as a **stub** with three placeholder definitions;
 * Task 5 replaces the first one (`ppt_master_info`) with its real
 * implementation and leaves the other two placeholders untouched for Tasks 6-7.
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
import { fileURLToPath } from 'node:url';

import { listSkillDirs, parseFrontmatter } from './skill-provider.js';

/** Which task replaces each placeholder, for the placeholder description/render text. */
const PLACEHOLDER_TASKS = {
  ppt_master_check_env: 6,
  ppt_master_setup_deps: 7,
};

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

/** The smallest object-rooted schema the SDK accepts, used by the placeholders. */
function placeholderParameters() {
  return { type: 'object', properties: {}, additionalProperties: false };
}

/**
 * The placeholder output schema: object-rooted, explicitly closed, and carrying
 * one advisory property so the shape is never an empty contract.
 */
function placeholderOutputSchema() {
  return {
    type: 'object',
    properties: { placeholder: { type: 'string' } },
    additionalProperties: false,
  };
}

/**
 * Build the tool definitions this plugin registers.
 *
 * @param {{ skillRoots?: string[] }} [options] Optional skill-root override,
 *   mirroring `apply()`'s test/embedding hook: `ppt_master_info` scans these
 *   roots instead of the packaged `skills/`. Omitted (the production path)
 *   means the packaged root.
 * @returns {Array<{ name: string, description: string, parameters: object,
 *   output: { schema: object, render: (args: object, value: object) => string },
 *   execute: (args: object, exec: object) => Promise<object> }>} Exactly three
 *   definitions, in registration order.
 */
export function createTools(options) {
  return [
    infoTool(options),
    placeholderTool('ppt_master_check_env'),
    placeholderTool('ppt_master_setup_deps'),
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
    parameters: placeholderParameters(),
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

// ─── placeholders (Tasks 6-7) ────────────────────────────────────

/** One placeholder definition: legal to register, empty when executed. */
function placeholderTool(name) {
  const task = PLACEHOLDER_TASKS[name];
  return {
    name,
    description: `占位：T${task} 替换 / placeholder, replaced by Task ${task}`,
    parameters: placeholderParameters(),
    output: {
      schema: placeholderOutputSchema(),
      // Placeholder renderer: the real payloads arrive with Tasks 6-7, which
      // also replace this with their model-facing rendering.
      render: () => `${name}: placeholder, replaced by Task ${task}`,
    },
    execute: async () => ({}),
  };
}
