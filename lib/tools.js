/**
 * Tool definitions for the ppt-master wrapper.
 *
 * Task 4 ships this module as a **stub**: three placeholder definitions that
 * already satisfy the SDK's minimal legal contract, so `apply()` can register
 * three tools from Task 4 onward and the assertion never has to move again.
 * Tasks 5-7 replace each placeholder with its real implementation, in order.
 *
 * The contract these placeholders satisfy (verified against the bundled SDK
 * in `@deepseek-ai/dsh-tools`):
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
 *
 * @module dsh-ppt-master-wrapper/lib/tools
 */

/** Which task replaces each placeholder, for the placeholder description/render text. */
const PLACEHOLDER_TASKS = {
  ppt_master_info: 5,
  ppt_master_check_env: 6,
  ppt_master_setup_deps: 7,
};

/** The smallest object-rooted schema the SDK accepts, used by every placeholder. */
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
 * @returns {Array<{ name: string, description: string, parameters: object,
 *   output: { schema: object, render: (args: object, value: object) => string },
 *   execute: (args: object, exec: object) => Promise<object> }>} Exactly three
 *   definitions, in registration order.
 */
export function createTools() {
  return [
    placeholderTool('ppt_master_info'),
    placeholderTool('ppt_master_check_env'),
    placeholderTool('ppt_master_setup_deps'),
  ];
}

/** One placeholder definition: legal to register, empty when executed. */
function placeholderTool(name) {
  const task = PLACEHOLDER_TASKS[name];
  return {
    name,
    description: `占位：T${task} 替换 / placeholder, replaced by Task ${task}`,
    parameters: placeholderParameters(),
    output: {
      schema: placeholderOutputSchema(),
      // Placeholder renderer: the real payloads arrive with Tasks 5-7, which
      // also replace this with their model-facing rendering.
      render: () => `${name}: placeholder, replaced by Task ${task}`,
    },
    execute: async () => ({}),
  };
}
