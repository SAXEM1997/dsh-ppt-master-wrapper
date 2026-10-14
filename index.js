/**
 * dsh-ppt-master wrapper entry: registers the packaged ppt-master skill set on
 * `ctx.skills` and exposes the three model-facing tools on `ctx.tools`.
 *
 * Zero-dependency implementation — no external npm packages required.
 *
 * @module dsh-ppt-master-wrapper
 */

import { createSkillProvider } from './lib/skill-provider.js';
import { createTools } from './lib/tools.js';

export const name = 'dsh-ppt-master-wrapper';

/** `skills` is a hard dependency; `tools` is probed at apply time and degraded. */
export const inject = ['skills', 'tools'];

/**
 * Assemble the plugin.
 *
 * The skill provider is mandatory: without `ctx.skills.registerProvider` there
 * is nothing to contribute, so this throws rather than booting a half-plugin.
 * The tool registry is optional: when `ctx.tools.register` is unusable the
 * provider is still registered and the degradation is announced on the console.
 *
 * @param {object} ctx Registrant context carrying the skill and tool registries.
 * @param {{ skillRoots?: string[] }} [opts] Test/embedding hook: explicit skill
 *   scan roots, forwarded verbatim to `createSkillProvider`. Omitted (the
 *   production path) means the provider defaults to this package's `skills/`.
 * @throws {Error} When `ctx.skills.registerProvider` is missing or not a function.
 */
export function apply(ctx, opts) {
  const registerProvider = ctx?.skills?.registerProvider;
  if (typeof registerProvider !== 'function') {
    throw new Error(`${name}: ctx.skills.registerProvider is required`);
  }

  // The registry takes a factory, matching the upstream reference shape.
  const provider = createSkillProvider(opts?.skillRoots);
  registerProvider(() => provider);

  const register = ctx?.tools?.register;
  if (typeof register !== 'function') {
    console.warn(`${name}: tools 不可用，降级仅注册 skill provider`);
    return;
  }
  for (const tool of createTools()) register(tool);
}
