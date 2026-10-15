/**
 * dsh-ppt-master wrapper entry: registers the packaged ppt-master skill set on
 * `ctx.skills`, exposes the three model-facing tools on `ctx.tools`, and declares
 * the cordis `Config` schema behind the venv-isolation settings page.
 *
 * Zero *declared* npm dependencies (package.json carries none). The Config schema
 * is built from the host-provided `@deepseek-ai/schemastery`, obtained through the
 * controlled channel below (host `node_modules` location + `createRequire` anchored
 * there): a bare ESM import cannot work — the plugin is loaded through a symlink and
 * the package is CJS (`type: 'module'`, `main: 'lib/index.cjs'`), spec §5.1/§6.1⓪.
 * Resolution failure is **fail-loud at module load**: the whole plugin (and with it
 * the vendor skill surface) is unavailable, never a Config-less degradation.
 *
 * @module dsh-ppt-master-wrapper
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSkillProvider, parseFrontmatter } from './lib/skill-provider.js';
import { createTools } from './lib/tools.js';
import { assembleInjectionBag, effectiveInterpreter } from './lib/venv.js';

export const name = 'dsh-ppt-master-wrapper';

/** `skills` is a hard dependency; `tools` is probed at apply time and degraded. */
export const inject = ['skills', 'tools'];

/** This package's root directory (the entry sits at the package root). */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

// ─── 宿主 schemastery 受控解析（spec §5.1 / §6.1⓪）────────────────

/** 非空字符串 → 原值；否则 null（空串环境变量视为未设置，与 compat 脚本同判据）。 */
function nonEmpty(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** 存在且是目录（探测判据；statSync 失败按不存在计）。 */
function isDirectory(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 定位宿主 profile 的 `node_modules`（插件侧 **env 四级**，无 explicit 参数可用）。
 *
 * ① `$DSH_NODE_MODULES`
 * ② `$DSH_PROFILE_DIR/node_modules`
 * ③ `$DSH_HOME/profiles/$DSH_PROFILE/node_modules`（两级都要有值）
 * ④ `$DSH_HOME/profiles/node_modules`
 *
 * 与 `scripts/check-dsh-compat.mjs` 的 `resolveDshModules` 前四级**语义相同、各自实现**
 * （插件不得反向 import `scripts/`：循环依赖 + CLI 副作用）。**有意收窄**：插件侧不含
 * 该脚本的 explicit 级，也不含第五级未命中时 `$DSH_HOME/profiles/<star>/node_modules` 的
 * 无序扫描回落——装载期不做候选消歧，未命中即 fail-loud（§6.1⓪ 触发面）。
 *
 * @returns {{ dir: string|null, via: string|null, attempted: string[] }}
 */
function locateDshModules() {
  const env = process.env;
  const home = nonEmpty(env?.DSH_HOME);
  const tiers = [
    ['DSH_NODE_MODULES', nonEmpty(env?.DSH_NODE_MODULES)],
    [
      'DSH_PROFILE_DIR',
      nonEmpty(env?.DSH_PROFILE_DIR) === null ? null : join(env.DSH_PROFILE_DIR, 'node_modules'),
    ],
    [
      'DSH_HOME/DSH_PROFILE',
      home !== null && nonEmpty(env?.DSH_PROFILE) !== null
        ? join(home, 'profiles', env.DSH_PROFILE, 'node_modules')
        : null,
    ],
    ['DSH_HOME/profiles', home === null ? null : join(home, 'profiles', 'node_modules')],
  ];

  const attempted = [];
  for (const [via, dir] of tiers) {
    if (dir === null) continue;
    attempted.push(`${via}=${dir}`);
    if (isDirectory(dir)) return { dir, via, attempted };
  }
  return { dir: null, via: null, attempted };
}

/**
 * 同步解析宿主 `@deepseek-ai/schemastery`。
 *
 * `createRequire` **必须以定位到的 node_modules 为锚**（锚点取该目录下的占位文件路径）：
 * 锚在 `index.js` 上即便 `DSH_PROFILE_DIR` 正确也会 `MODULE_NOT_FOUND`（本机实测）——
 * 本包被符号链接装载，从包内向上找不到 profile 的 node_modules。包为 CJS，同步解析可行。
 *
 * 任一级未命中或 require 失败 → 在**模块加载期**抛出（不捕获、不降级为无 Config 导出）。
 * 错误文案约束（Task 5 Step 3a）：不得含「用法 / unknown / 未知」（否则 compat 的
 * `CLI: 未知参数 → exit 1 usage 提示` 例会被装载期文案抢先匹配而不转红），也不得含
 * 「无法定位」（否则 `CLI: 无 --dsh-modules 且 env 无定位线索` 例取 `error.stdout` 的
 * 断言会被装载期文案污染）；包名 `@deepseek-ai/schemastery` 须留在**首行**（compat 的
 * 不可解析态子进程用例以它作唯一正向标记，`firstLine` 只上抛首行）。
 *
 * @returns {Function} 可调用的 schemastery 命名空间（`object/string/boolean/union/const`）。
 * @throws {Error} 定位链未命中或宿主未安装该包。
 */
function loadSchemastery() {
  const { dir, via, attempted } = locateDshModules();

  if (dir === null) {
    throw new Error(
      `@deepseek-ai/schemastery 未能解析：宿主 node_modules 定位链四级均未命中`
        + `（已探测：${attempted.length > 0 ? attempted.join('；') : '无任何级别可探测'}）。`
        + '请设置 DSH_NODE_MODULES / DSH_PROFILE_DIR / DSH_HOME(+DSH_PROFILE) '
        + '指向已安装该包的宿主 profile。',
    );
  }

  const requireFromHost = createRequire(join(dir, 'noop-anchor.cjs'));
  try {
    return requireFromHost('@deepseek-ai/schemastery');
  } catch (error) {
    throw new Error(
      `@deepseek-ai/schemastery 未能解析（node_modules=${dir}，via ${via}）: `
        + `${error?.message ?? error}`,
    );
  }
}

const z = loadSchemastery();

// ─── Config 注解（spec §4.1/§5.1；模块加载期求值一次）────────────

/** 插件自身版本（package.json，模块加载期读一次）。 */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))?.version ?? '（不可读）';
  } catch {
    return '（不可读）';
  }
})();

/** 上游 vendor 单一 skill 根＝`<包根>/skills/ppt-master`（本包只 vendor 它一个）。 */
const SKILL_DIR = join(PACKAGE_ROOT, 'skills', 'ppt-master');

/** 上游 skill 版本（vendor SKILL.md 的 `metadata.version`；不可读时降级为占位串）。 */
const UPSTREAM_VERSION = (() => {
  try {
    const parsed = parseFrontmatter(readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8'));
    const version = parsed?.data?.metadata?.version;
    return typeof version === 'string' && version !== '' ? version : '（不可读）';
  } catch {
    return '（不可读）';
  }
})();

/**
 * 配置页版本注解：插件版本 / 上游版本 / SKILL_DIR——模块加载期求值并**烘焙进 schema
 * description**，模块缓存内不重求值。机制注记（spec §4.1）：设置页的 `applies:"live"`
 * 是宿主 describe 的固定输出，真正的可编辑性由字段 volatile 声明决定；本注解随插件
 * 升级（版本变化 → 模块重载）换代，**不随热重载换代**。
 */
const CONFIG_ANNOTATION =
  `ppt-master 包装层配置（插件版本 ${PLUGIN_VERSION}；上游 ppt-master ${UPSTREAM_VERSION}；`
  + `SKILL_DIR ${SKILL_DIR}）。venv 隔离开关与路径在此配置，变更经宿主热重载即时生效。`;

/**
 * 原生配置页 schema（spec §5.1）。
 *
 * 三叶子**逐个** `.volatile()`（宿主惯例，如 dsh-agent-loop `maxParallelToolCalls`）：
 * 未标 volatile 的叶子宿主不出页、写入被拒；标注只钉叶子级、不两层叠加（嵌套标注在
 * 校验期即抛 ValidationError）。`.volatile()` 同时把解析值包成 `.get()` 引用对象，故
 * apply 边界必须经 `assembleInjectionBag` 去引用（`lib/venv.js`）。
 *
 * 默认值与 `lib/venv.js` 的 `VENV_DEFAULTS` 逐字一致（两提供者：cordis 校验填默认 vs
 * apply 自填）；路径形状约束不在 schema 层声明（schemastery 无法表达路径谓词），
 * 非法值可保存，反馈通道＝入口 skill「配置无效」态 + check_env 的 `venv.path=null`
 * 提示 + apply 期 warn（spec §5.1 编辑期校验闭环）。
 */
export const Config = z.object({
  venv: z.object({
    enabled: z
      .boolean()
      .default(false)
      .description(
        'venv 隔离开关：true 时在下方路径创建/复用独立 venv 并以其中解释器运行上游脚本；'
          + 'false（默认）沿用系统 python3/pip3。',
      )
      .volatile(),
    path: z
      .string()
      .default('~/.ppt-master/venv')
      .description(
        'venv 路径：~ 于使用处按 DSH 宿主进程 HOME 展开；须为绝对路径或 ~ 前缀'
          + '（相对路径判无效——venv 视为关闭并告警）。',
      )
      .volatile(),
    oldPathPolicy: z
      .union([z.const('keep'), z.const('delete')])
      .default('keep')
      .description(
        '路径变更后对旧标记 venv 的处理：keep（默认）保留待手动清理；'
          + 'delete 在下次 setup_deps 成功后删除（仅删带所有权标记的旧 venv）。',
      )
      .volatile(),
  }).description('venv 隔离与旧路径清理策略。'),
}).description(CONFIG_ANNOTATION);

// ─── apply ───────────────────────────────────────────────────────

/**
 * Assemble the plugin.
 *
 * The skill provider is mandatory: without `ctx.skills.registerProvider` there
 * is nothing to contribute, so this throws rather than booting a half-plugin.
 * The tool registry is optional: when `ctx.tools.register` is unusable the
 * provider is still registered and the degradation is announced on the console.
 *
 * `opts` is the **unified injection bag** assembled by `assembleInjectionBag`
 * (Task 5): on the loader path it is the cordis-validated config (`venv` leaves are
 * `.volatile()` reference objects, defaults already filled by the schema); on the
 * test/embedding path it is `{ skillRoots }` or omitted, and `venv` defaults are
 * filled here. Everything below the boundary sees plain values only.
 *
 * @param {object} ctx Registrant context carrying the skill and tool registries.
 * @param {{ skillRoots?: string[], venv?: object }} [opts] Unified injection bag:
 *   explicit skill scan roots (test/embedding hook, forwarded verbatim) and the
 *   de-referenced venv config. Omitted (the production loader path) means the
 *   provider defaults to this package's `skills/` and venv falls back to
 *   `enabled: false`.
 * @throws {Error} When `ctx.skills.registerProvider` is missing or not a function.
 */
export function apply(ctx, opts) {
  const skills = ctx?.skills;
  if (typeof skills?.registerProvider !== 'function') {
    throw new Error(`${name}: ctx.skills.registerProvider is required`);
  }

  // 统一注入包：唯一形态差转换点（volatile 引用 → 普通值），下游只见普通值。
  const bag = assembleInjectionBag(opts);

  // 降级视图（spec §6 配置无效行）：与消费方**同一次** `effectiveInterpreter` 求值取
  // `invalidReason` 供 warn——本 Task 不替消费方判定 `state`、不另立判定路径。
  // `invalid × disabled`（enabled:false + 相对路径）的 invalidReason 沿用
  // `resolveVenvPath` 的原因，故该组合下 warn 照常触发；路径合法而仅 disabled 时为
  // `null`，不 warn（默认配置因此静默）。console.warn 仅作日志补充——可见反馈通道是
  // 入口 skill「配置无效」态与 check_env 的 `venv.path=null`。注入包保留原值：此处
  // **不改写** venv 值，行为层降级归各消费方。
  const { invalidReason } = effectiveInterpreter(bag.venv);
  if (invalidReason !== null) {
    console.warn(
      `${name}: venv.path 无效（${invalidReason}）——venv 视为关闭，按系统模式运行；`
        + `请在设置页修正 venv.path（当前值：${String(bag.venv.path)}）`,
    );
  }

  // The registry takes a factory, matching the upstream reference shape. The second
  // argument is the venv subset of the injection bag (方案甲：roots 保持首参数组；
  // Task 6 起由 createSkillProvider 消费——本 Task 只接线，多出的实参被一参签名忽略)。
  const provider = createSkillProvider(bag.skillRoots, { venv: bag.venv });
  // Method-form invocation (`skills.registerProvider(...)`, never extracting the
  // function first): on a real cordis context every service access is wrapped by a
  // traceable proxy that rebinds `this` for method calls only — a detached call
  // lands in the implementation with `this === undefined` and throws. Caught by
  // scripts/check-dsh-compat.mjs against the installed SDK (Task 9).
  skills.registerProvider(() => provider);

  const tools = ctx?.tools;
  if (typeof tools?.register !== 'function') {
    console.warn(`${name}: tools 不可用，降级仅注册 skill provider`);
    return;
  }
  // Same scan-root channel as the provider: the tools resolve SKILL_DIR from the
  // very roots the provider lists from, so the two can never describe different
  // trees. `undefined` (production) means each tool's packaged default. The venv
  // subset travels the same bag; the test-only `testSeams` channel is deliberately
  // omitted on the production path (Task 9 consumes it through `createTools`).
  // Method form here too, for the same traceable-`this` reason as above.
  for (const tool of createTools({ skillRoots: bag.skillRoots, venv: bag.venv })) {
    tools.register(tool);
  }
}
