#!/usr/bin/env node

/**
 * check-dsh-compat.mjs — 对照已安装 DSH SDK 的契约检查（spec §3.5 / §6，Task 9）。
 *
 * 用法：
 *   node scripts/check-dsh-compat.mjs [--dsh-modules <dir>] [--skill-roots <dir[,dir...]>]
 *
 * 检查链（逐级对应 brief Step 3-4）：
 *  1. 定位 SDK：resolveDshModules 有序五级（--dsh-modules 参数 > $DSH_NODE_MODULES >
 *     $DSH_PROFILE_DIR/node_modules > $DSH_HOME/profiles/$DSH_PROFILE/node_modules >
 *     $DSH_HOME/profiles/node_modules；按序探测、命中即用——有序优先级即消歧，
 *     前级命中不再探测后级、不报多候选）；第五级不存在时回落**无序扫描**
 *     $DSH_HOME/profiles/<star>/node_modules（唯一入口）：>1 命中 → throw 列出全部
 *     候选要求显式指定；恰 1 → 用之；0 → 全失败报错。「多候选报错」仅适用于
 *     无序扫描场景。
 *  2. 动态 import 定位到的 SDK：@deepseek-ai/{cordis,dsh-system-prompt,dsh-skill,
 *     dsh-tools}（入口经各包 package.json exports["."]/main 解析，file URL 导入，
 *     与 Node 自身解析同构）。dsh-system-prompt 是真实 ToolRuntime 构造函数的
 *     ctx.systemPrompt 依赖，必须先挂载。
 *  3. ToolRuntime register 验证：createTools() 真实三工具产物（非临时最小定义——
 *     生产 schema 在真实 SDK 的 assertSupportedJsonSchema 路径上验证）逐一经
 *     ctx.tools.register()（方法形态）。register 拒绝手写定义 → spec §3.5 风险
 *     兜底：import defineTool 重建定义于全新 runtime 重验，并报告「须声明
 *     @deepseek-ai/dsh-tools 为 peerDependency」（peerDep 仅声明宿主必带包，
 *     不违反零 dependencies 约束）。
 *  4. SkillRegistry 挂载：apply(ctx, { skillRoots }) 驱动**本插件根 index.js**
 *     （PLUGIN_ENTRY，显式断言非参考实现的 lib/index.js），经同一注入通道
 *     （T14 前包内 skills/ 不存在，须注入 fixture 正例子集）读回候选：
 *     ctx.skills.list() 非空 + 逐名 get() 读回 content/resourceBase。**入口装载形态**：
 *     定位成功后动态 `import(PLUGIN_ENTRY)`（顶层静态 import 会让插件装载期的
 *     schemastery fail-loud 抢在 CLI 解析之前，见下方 import 区注释与 Task 5 报告）。
 *  5. rank 相对关系：SKILL_RANK（可注入期望值，缺省取 lib/skill-provider.js 真值）
 *     < SDK BUNDLED_SKILL_RANK（从定位到的 SDK 读回常量比较；600 遮蔽 550）。
 *  6. 漂移观测：读回同环境 superpowers-dsh 的 PACKAGED_SKILL_RANK（该常量在
 *     superpowers-dsh@0.2.0 为入口模块**私有 const、未导出**——已探明实际导出
 *     形态，固定以源码正则读其入口文件）与本插件期望值比对：读得到且不等 →
 *     漂移告警 + 非零退出；读不到 → warning 降级该项（本脚本主职责是 SDK 契约，
 *     superpowers-dsh 为跟随策略观测项）。
 *
 * 全绿 → exit 0；任一契约失败/漂移 → 非零退出并列出全部 problems。
 *
 * 主流程接受可注入依赖（deps 模式，参照 Task 13）：importModule（动态 import
 * 函数，单测注入 stub 模块驱动全分支——无网络、不依赖真实安装位置）与
 * expectedRank（期望 rank 常量，驱动漂移分支）。
 *
 * 方法形态契约：真实 cordis 上下文的服务访问经 traceable 代理包装，把
 * ctx.skills.registerProvider / ctx.tools.register 提取成变量再调用会以
 * this=undefined 落入实现（脱挂 TypeError）——本脚本对 SDK 的一切调用保持
 * 方法形态，且 stub 单测复刻该契约防止 index.js 回归。
 *
 * 零 npm 依赖（node:fs/path/url 内建）。
 *
 * @module dsh-ppt-master-wrapper/scripts/check-dsh-compat
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 插件入口**不做顶层静态 import**（Task 5 装载形态修复）：Config 落地后插件装载期
// 需要宿主 `@deepseek-ai/schemastery`，静态 import 会把该 fail-loud 提到 CLI 参数解析
// 与 SDK 定位之前，使 `CLI: 未知参数 → exit 1 usage 提示` 与 `CLI: 无 --dsh-modules 且
// env 无定位线索 → exit 1 报无法定位` 两例的断言语义失效。入口改由 runCompatCheck 在
// **定位成功后**动态 `import(PLUGIN_ENTRY)`（见第 4 步）。
// `lib/skill-provider.js` / `lib/tools.js` 零 npm 依赖、不触 schemastery，保持静态导入。
import { SKILL_RANK } from '../lib/skill-provider.js';
import { createTools } from '../lib/tools.js';

/**
 * compat 挂载驱动的插件入口——本插件**包根** index.js（显式导出供测试断言：
 * 路径含 /index.js 且非参考实现的 lib/index.js，防照抄参考脚本挂错入口）。
 */
export const PLUGIN_ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));

/** CLI `--skill-roots` 缺省值：包内 skills/（T14 首灌前不存在，smoke 须注入）。 */
const PACKAGED_SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url));

/** 动态导入的 SDK 包（顺序即挂载顺序：systemPrompt 是 ToolRuntime 的构造依赖）。 */
const SDK_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-tools',
];

// ─── resolveDshModules：有序五级 + 无序扫描 ──────────────────────

/** 非空字符串 → 原值；否则 null（空串环境变量视为未设置）。 */
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
 * 无序扫描 $DSH_HOME/profiles 下一级 profile 的 node_modules。
 *
 * 「多候选 → 报错列出候选」仅适用于本扫描（有序各级天然唯一）。返回结果按路径
 * 字节序排序，报错信息因此确定。
 */
function scanProfileNodeModules(profilesRoot) {
  if (!isDirectory(profilesRoot)) return [];
  const hits = [];
  for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const modules = join(profilesRoot, entry.name, 'node_modules');
    if (isDirectory(modules)) hits.push(resolve(modules));
  }
  return hits.sort(compareByteOrder);
}

/** UTF-16 码单元序比较（localeCompare-free，与插件其余部分同一约定）。 */
function compareByteOrder(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 定位已安装的 DSH SDK（node_modules 根）。
 *
 * 有序五级，按序探测、命中即用——前级命中不再探测后级、不报多候选（有序优先级
 * 即消歧）。每级判据：目录存在（同步 existsSync）。
 *
 * ① explicit 参数（CLI --dsh-modules）
 * ② env.DSH_NODE_MODULES
 * ③ env.DSH_PROFILE_DIR + '/node_modules'（DSH_PROFILE_DIR 为 profile 根）
 * ④ env.DSH_HOME + '/profiles/' + env.DSH_PROFILE + '/node_modules'（两级都要有值）
 * ⑤ env.DSH_HOME + '/profiles/node_modules'
 *
 * 第五级不存在时回落无序扫描 env.DSH_HOME + '/profiles/<star>/node_modules'：
 * >1 命中 → throw 列出全部候选要求显式指定；恰 1 → 用之；0 → 全失败报错。
 * env 无 DSH_HOME（且无更前级命中）→ throw。
 *
 * @param {string} [explicit] 显式指定的 node_modules 目录（CLI 一级来源）。
 * @param {object} [env] 环境变量表（缺省 {}；生产传 process.env）。
 * @returns {{ path: string, via: string }} 绝对路径与命中级别标签
 *   （'explicit' | 'DSH_NODE_MODULES' | 'DSH_PROFILE_DIR' | 'DSH_HOME/DSH_PROFILE'
 *   | 'DSH_HOME/profiles' | 'scan'）。
 * @throws {Error} 无序扫描多候选 / 全失败 / env 无 DSH_HOME 且无前级命中。
 */
export function resolveDshModules(explicit, env = {}) {
  const home = nonEmpty(env?.DSH_HOME);
  const levels = [
    ['explicit', nonEmpty(explicit)],
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
  for (const [via, path] of levels) {
    if (path === null) continue;
    attempted.push(`  - ${via}: ${path}`);
    if (isDirectory(path)) return { path: resolve(path), via };
  }

  if (home === null) {
    throw new Error(
      '无法定位 DSH SDK：env 无 DSH_HOME（且无 explicit/DSH_NODE_MODULES/DSH_PROFILE_DIR 命中）。'
        + '请传 --dsh-modules <dir>，或设置 DSH_NODE_MODULES / DSH_PROFILE_DIR / DSH_HOME。'
        + (attempted.length > 0 ? `\n已探测：\n${attempted.join('\n')}` : ''),
    );
  }

  const profilesRoot = join(home, 'profiles');
  const candidates = scanProfileNodeModules(profilesRoot);
  if (candidates.length > 1) {
    throw new Error(
      `无法定位 DSH SDK：无序扫描 ${profilesRoot}/* 发现多个 profile 候选，请显式指定 --dsh-modules：\n`
        + candidates.map((candidate) => `  - ${candidate}`).join('\n'),
    );
  }
  if (candidates.length === 1) return { path: candidates[0], via: 'scan' };

  throw new Error(
    '无法定位 DSH SDK：五级均未命中，且 $DSH_HOME/profiles 下无 node_modules（全失败）。\n'
      + `已探测：\n${attempted.length > 0 ? attempted.join('\n') : '  - （无任何级别可探测）'}\n`
      + `扫描根：${profilesRoot}`,
  );
}

// ─── SDK 包入口解析 / superpowers-dsh 常量读取 ───────────────────

/**
 * 解析一个包的 ESM 入口（Node 同构：exports["."] → module → main）。
 *
 * @returns {{ dir: string, manifest: object, url: string } | null} 包缺失、
 *   manifest 不可解析或入口文件不存在 → null。
 */
function entryOf(modules, name) {
  const dir = join(modules, ...name.split('/'));
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  const exported = manifest.exports?.['.'];
  const target =
    (typeof exported === 'string' ? exported : (exported?.default ?? exported?.import))
    ?? manifest.module
    ?? manifest.main;
  if (typeof target !== 'string' || target === '') return null;
  const entryFile = resolve(dir, target);
  if (!existsSync(entryFile)) return null;
  return { dir, manifest, url: pathToFileURL(entryFile).href };
}

/** superpowers-dsh 私有常量的源码正则（该包未导出 PACKAGED_SKILL_RANK，见文件头）。 */
const PACKAGED_RANK_PATTERN = /(?:const|let|var)\s+PACKAGED_SKILL_RANK\s*=\s*(\d+)/;

/**
 * 读回同环境 superpowers-dsh 的 PACKAGED_SKILL_RANK。
 *
 * 已探明的实际导出形态：superpowers-dsh@0.2.0 的入口 lib/index.js 把该常量声明为
 * 模块私有 const（不随 ESM 导出），因此固定以源码正则读其入口文件——与参考实现
 * 读自身常量的手法一致。任何读不到（包缺失/入口不可解析/源码不可读/正则无匹配）
 * 都只是「观测项不可得」，交由调用方降级为 warning，绝不判失败。
 *
 * @returns {{ ok: true, rank: number } | { ok: false, reason: string }}
 */
function readSuperpowersRank(modules) {
  const entry = entryOf(modules, 'superpowers-dsh');
  if (entry === null) {
    return { ok: false, reason: `包缺失或入口不可解析（${join(modules, 'superpowers-dsh')}）` };
  }
  let source;
  try {
    source = readFileSync(fileURLToPath(entry.url), 'utf8');
  } catch (error) {
    return { ok: false, reason: `入口源码不可读: ${error.message}` };
  }
  const match = PACKAGED_RANK_PATTERN.exec(source);
  if (match === null) {
    return { ok: false, reason: '入口源码未解析出 PACKAGED_SKILL_RANK 常量' };
  }
  return { ok: true, rank: Number(match[1]) };
}

// ─── runCompatCheck：主流程编排 ─────────────────────────────────

/** 错误首行（多行 message 只保留第一行，报告可读）。 */
function firstLine(error) {
  return String(error?.message ?? error).split('\n')[0];
}

/**
 * 对照定位到的 DSH SDK 执行全量契约检查。
 *
 * @param {object} [options] 可注入依赖与输入（deps 模式）：
 *   - `dshModules?: string` — 定位一级来源（CLI --dsh-modules）。
 *   - `skillRoots?: string[]` — apply 注入扫描根（CLI --skill-roots 逗号拆分；
 *     缺省为包内 skills/——T14 前不存在，真实运行须注入 fixture 正例子集）。
 *   - `env?: object` — 环境变量表，缺省 process.env。
 *   - `importModule?: (url: string) => Promise<object>` — 动态 import 函数，
 *     缺省真实 `import(url)`；单测注入 stub 模块（无网络、不依赖真实安装位置）。
 *   - `expectedRank?: number` — 期望 rank 常量，缺省 lib/skill-provider.js 的
 *     SKILL_RANK 真值；与 superpowers-dsh 实际常量比对驱动漂移分支。
 * @returns {Promise<{ problems: string[], warnings: string[], notes: string[],
 *   resolved: { path: string, via: string } | null, entry: string }>}
 *   problems 非空 → CLI 非零退出；warnings 永不影响退出码。
 */
export async function runCompatCheck(options = {}) {
  const problems = [];
  const warnings = [];
  const notes = [];

  const env = options.env ?? process.env;
  const importModule = options.importModule ?? ((url) => import(url));
  const expectedRank = options.expectedRank ?? SKILL_RANK;

  // ── 1. 定位（五级 + 无序扫描；定位失败即整检失败）──
  let resolved = null;
  try {
    resolved = resolveDshModules(options.dshModules, env);
  } catch (error) {
    problems.push(error.message);
    return { problems, warnings, notes, resolved, entry: PLUGIN_ENTRY };
  }
  notes.push(`SDK 定位: ${resolved.path}（via ${resolved.via}）`);
  notes.push(`挂载入口: ${PLUGIN_ENTRY}（本插件根 index.js，非 lib/index.js）`);

  // ── 2. 动态导入 SDK 四包（入口经 package.json 解析，import 走可注入函数）──
  const entries = {};
  for (const name of SDK_PACKAGES) {
    const entry = entryOf(resolved.path, name);
    if (entry === null) {
      problems.push(
        `SDK 包 ${name} 不可用（package.json 或入口不可解析）: ${join(resolved.path, ...name.split('/'))}`,
      );
      continue;
    }
    try {
      entries[name] = { module: await importModule(entry.url), version: entry.manifest.version };
    } catch (error) {
      problems.push(`SDK 包 ${name} 动态导入失败: ${firstLine(error)}`);
    }
  }
  if (problems.length > 0) return { problems, warnings, notes, resolved, entry: PLUGIN_ENTRY };
  notes.push(
    `SDK 版本: @deepseek-ai/dsh-skill ${entries['@deepseek-ai/dsh-skill'].version}`
      + ` / @deepseek-ai/dsh-tools ${entries['@deepseek-ai/dsh-tools'].version}`,
  );

  const { Context } = entries['@deepseek-ai/cordis'].module;
  const { SystemPrompt } = entries['@deepseek-ai/dsh-system-prompt'].module;
  const { SkillRegistry, BUNDLED_SKILL_RANK } = entries['@deepseek-ai/dsh-skill'].module;
  const { ToolRuntime, defineTool } = entries['@deepseek-ai/dsh-tools'].module;

  /** 挂载一套独立服务（fresh Context；SystemPrompt 先于 ToolRuntime——构造依赖）。 */
  const mount = ({ withSkills = true } = {}) => {
    const ctx = new Context();
    new SystemPrompt(ctx, {});
    new ToolRuntime(ctx);
    if (withSkills) new SkillRegistry(ctx);
    return ctx;
  };

  const toolOptions =
    options.skillRoots === undefined || options.skillRoots === null
      ? undefined
      : { skillRoots: options.skillRoots };

  // ── 3. ToolRuntime register 验证：createTools() 真实三工具产物（方法形态）──
  try {
    const ctxTools = mount({ withSkills: false });
    const tools = createTools(toolOptions);
    for (const tool of tools) ctxTools.tools.register(tool);
    notes.push(`ToolRuntime register: createTools() 三工具产物全部被接受（${tools.map((tool) => tool.name).join('/')}）`);
  } catch (error) {
    // §3.5 风险兜底：真实 SDK register 拒绝手写工具定义时，import defineTool
    // 重建定义重验。peerDependency 补救不违反零 dependencies 约束（该约束禁
    // 运行时依赖，peerDep 仅声明宿主必带包）。仅在实测拒绝时启用。
    let fallbackOutcome;
    if (typeof defineTool !== 'function') {
      fallbackOutcome = `spec §3.5 回退不可行——SDK 未导出 defineTool: ${firstLine(error)}`;
    } else {
      try {
        const ctxRetry = mount({ withSkills: false });
        for (const tool of createTools(toolOptions)) ctxRetry.tools.register(defineTool(tool));
        fallbackOutcome =
          'spec §3.5 回退可行——defineTool 重建后 register 通过；须声明 @deepseek-ai/dsh-tools 为 peerDependency 并以 defineTool 构建定义';
      } catch (retryError) {
        fallbackOutcome = `spec §3.5 回退亦失败: ${firstLine(retryError)}`;
      }
    }
    problems.push(
      `ToolRuntime register 拒绝 createTools() 真实三工具产物: ${firstLine(error)}（${fallbackOutcome}）`,
    );
  }

  // ── 4. SkillRegistry 挂载：apply(ctx, { skillRoots }) 驱动插件根 index.js ──
  //
  // 装载形态（Task 5 修复）：插件入口在**定位成功后**动态装载——顶层静态 import 会让
  // 插件装载期的 schemastery fail-loud 抢在 CLI 参数解析与 SDK 定位之前（cp. 文件头）。
  // 动态命名空间**仅**用于取 `ns.apply`；`createTools` 沿用顶层静态导入（两处引用点
  // 不变），**禁止**为适配动态命名空间而在 index.js 增导出具名符号（该错误修复不会
  // 转红——tests/skeleton.test.mjs 只锁 package.json exports，故以文本硬约束）。
  // 入口用的是**真实**动态 import（不走可注入的 `importModule`——那条缝只服务 SDK stub
  // 模块替换；插件入口在每条用例里都必须是本包真实文件，否则挂载面失真）。
  // 装载失败（宿主包不可解析）如实转 problems，不静默：fail-loud 语义的唯一可观测面。
  let ctx = null;
  try {
    const ns = await import(pathToFileURL(PLUGIN_ENTRY).href);
    if (typeof ns.apply !== 'function') {
      problems.push(`插件入口 ${PLUGIN_ENTRY} 未导出 apply——无法驱动 SkillRegistry 挂载`);
    } else {
      ctx = mount();
      ns.apply(ctx, toolOptions);
    }
  } catch (error) {
    problems.push(`apply(ctx, { skillRoots }) 驱动 ${PLUGIN_ENTRY} 失败: ${firstLine(error)}`);
    ctx = null;
  }

  if (ctx !== null) {
    try {
      const summaries = await ctx.skills.list({});
      if (!Array.isArray(summaries) || summaries.length === 0) {
        problems.push('真实 SkillRegistry list() 返回 0 个候选——provider 挂载未生效');
      } else {
        const broken = [];
        for (const summary of summaries) {
          const loaded = await ctx.skills.get(summary.name, {});
          if (
            loaded === undefined || loaded === null
            || typeof loaded.content !== 'string' || loaded.content.trim() === ''
          ) {
            broken.push(summary.name);
          } else if (loaded.resourceBase?.kind !== 'directory') {
            broken.push(`${summary.name}（resourceBase.kind 非 directory）`);
          }
        }
        if (broken.length > 0) {
          problems.push(`候选经真实 SkillRegistry get() 读回失败: ${broken.join(', ')}`);
        } else {
          notes.push(`skills 读回（经真实 SkillRegistry）: ${summaries.map((summary) => summary.name).join(', ')}`);
        }
      }
    } catch (error) {
      problems.push(`真实 SkillRegistry list()/get() 失败: ${firstLine(error)}`);
    }
  }

  // ── 5. rank 相对关系：期望值 < SDK BUNDLED_SKILL_RANK（常量从 SDK 读回比较）──
  if (typeof BUNDLED_SKILL_RANK !== 'number' || !Number.isFinite(BUNDLED_SKILL_RANK)) {
    problems.push(
      `SDK 未导出数字型 BUNDLED_SKILL_RANK（实际: ${String(BUNDLED_SKILL_RANK)}）——rank 相对关系无从比较`,
    );
  } else if (expectedRank >= BUNDLED_SKILL_RANK) {
    problems.push(
      `rank 相对关系失败: SKILL_RANK=${expectedRank} ≥ BUNDLED_SKILL_RANK=${BUNDLED_SKILL_RANK}`
        + '（必须低于，否则同 profile 内置根将遮蔽本插件候选）',
    );
  } else {
    notes.push(`rank 相对关系: SKILL_RANK=${expectedRank} < BUNDLED_SKILL_RANK=${BUNDLED_SKILL_RANK} ✓`);
  }

  // ── 6. 漂移观测：superpowers-dsh 实际常量 vs 本插件期望值（读不到 → 降级）──
  const drift = readSuperpowersRank(resolved.path);
  if (!drift.ok) {
    warnings.push(
      `superpowers-dsh rank 常量读不到（${drift.reason}）——跟随策略观测项降级为 warning（本脚本主职责是 SDK 契约）`,
    );
  } else if (drift.rank !== expectedRank) {
    problems.push(
      `rank 漂移: superpowers-dsh PACKAGED_SKILL_RANK=${drift.rank} ≠ 本插件 SKILL_RANK=${expectedRank}`
        + '（跟随策略要求一致，请同步 lib/skill-provider.js 的 SKILL_RANK 或确认上游变更）',
    );
  } else {
    notes.push(`superpowers-dsh PACKAGED_SKILL_RANK=${drift.rank} = 本插件 SKILL_RANK=${expectedRank} ✓（跟随一致）`);
  }

  return { problems, warnings, notes, resolved, entry: PLUGIN_ENTRY };
}

// ─── CLI ─────────────────────────────────────────────────────────

/** 解析 CLI 参数；未知参数或缺失取值 → `{ error }`（usage 错误，exit 1）。 */
function parseCliArgs(argv) {
  const options = { dshModules: undefined, skillRoots: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dsh-modules' || arg === '--skill-roots') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { error: `参数 ${arg} 缺少取值` };
      }
      if (arg === '--dsh-modules') {
        options.dshModules = value;
      } else {
        const roots = value.split(',').map((root) => root.trim()).filter((root) => root !== '');
        options.skillRoots = roots.length > 0 ? roots : undefined;
      }
      i++;
    } else {
      return { error: `未知参数: ${arg}` };
    }
  }
  return options;
}

/** CLI 主流程：notes/warnings/problems 打印；problems 非空 → exit 1。 */
async function cliMain(argv) {
  const options = parseCliArgs(argv);
  if ('error' in options) {
    console.error(
      `用法: node scripts/check-dsh-compat.mjs [--dsh-modules <dir>] [--skill-roots <dir[,dir...]>]\n${options.error}`,
    );
    process.exit(1);
  }
  const result = await runCompatCheck({
    dshModules: options.dshModules,
    skillRoots: options.skillRoots,
    env: process.env,
  });

  console.log(
    `check-dsh-compat: skillRoots ${options.skillRoots === undefined ? PACKAGED_SKILLS_ROOT : options.skillRoots.join(',')}`,
  );
  for (const note of result.notes) console.log(`  · ${note}`);
  for (const warning of result.warnings) console.log(`  ⚠ ${warning}`);
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.log(`  ✗ ${problem}`);
    console.log(`check-dsh-compat: FAILED（problems ${result.problems.length}，退出码 1）`);
    process.exit(1);
  }
  console.log(`check-dsh-compat: OK — 本插件与已安装 DSH SDK 契约一致（warnings ${result.warnings.length}）`);
  process.exit(0);
}

// 直接以 `node scripts/check-dsh-compat.mjs` 运行时才走 CLI；被 import 时不触发。
const invokedDirectly = (() => {
  if (typeof process.argv[1] !== 'string') return false;
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  await cliMain(process.argv.slice(2));
}
