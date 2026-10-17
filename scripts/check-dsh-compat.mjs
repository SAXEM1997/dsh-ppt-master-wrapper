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
 *     ctx.skills.list() 非空 + 逐名 get() 读回 content/resourceBase。**合成入口豁免**：
 *     参数缺省（生产包内根）时 provider 追加内存合成的 `ppt-master-env`，它无文件、
 *     按设计不带 `resourceBase`，故按**名字**豁免 directory 判定（Task 6）；其余候选
 *     维持严格判定。**入口装载形态**：
 *     定位成功后动态 `import(PLUGIN_ENTRY)`（顶层静态 import 会让插件装载期的
 *     schemastery fail-loud 抢在 CLI 解析之前，见下方 import 区注释与 Task 5 报告）。
 *  5. rank 相对关系：SKILL_RANK（可注入期望值，缺省取 lib/skill-provider.js 真值）
 *     < SDK BUNDLED_SKILL_RANK（从定位到的 SDK 读回常量比较；600 遮蔽 550）。
 *  6. 漂移观测：读回同环境 superpowers-dsh 的 PACKAGED_SKILL_RANK（该常量在
 *     superpowers-dsh@0.2.0 为入口模块**私有 const、未导出**——已探明实际导出
 *     形态，固定以源码正则读其入口文件）与本插件期望值比对：读得到且不等 →
 *     漂移告警 + 非零退出；读不到 → warning 降级该项（本脚本主职责是 SDK 契约，
 *     superpowers-dsh 为跟随策略观测项）。
 *  7. §7.7 六项设计成立性前置检查（Task 10 + Task 4）——载体分工钉死：**③④＝静态
 *     源码文本**断言（bundle insert 层 `cordis.patch.yml` 条目、受控解析通道存在），
 *     **①②⑤＝实跑断言**（`ns.Config` volatile 声明、apply 第二参注入通道、
 *     生产根形态经真实 SkillRegistry 读回入口技能）。**不采用 env 通道子进程**。
 *     另含默认值交叉锚定（schema 校验默认值 ≡ 注入袋缺省默认值；两处字面拷贝的
 *     唯一钉住处）。
 *     **⑥＝客户端半边 stub 装载与注册**（`lib/client.js` 经 stub `window.__ModuleLoader__`
 *     装载 ＋ 假 require/假 ctx 驱动 `factory`+`apply`，断言 loader id＝包名、硬 inject 含
 *     slots/locale 且不含 configForms、`ctx.inject(['configForms'])` 回调式接入、槽位
 *     options 三键逐字）——它与①–⑤的**宿主面**取文处不同（客户端半边是另一个文件），
 *     故并入静态检查报告段后在装载失败路径**同样给出结论**。
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
// `lib/venv.js` 同为纯 fs 原语、零 npm 依赖、不触 schemastery，可静态导入：
// §7.7 的默认值交叉锚定需 `snapshotVenvConfig` 与组合纯函数 `assembleInjectionBag`
// 两者比对（schema 校验默认值 vs 注入袋缺省默认值）。
import { assembleInjectionBag, snapshotVenvConfig } from '../lib/venv.js';

/**
 * compat 挂载驱动的插件入口——本插件**包根** index.js（显式导出供测试断言：
 * 路径含 /index.js 且非参考实现的 lib/index.js，防照抄参考脚本挂错入口）。
 */
export const PLUGIN_ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));

/**
 * §7.7⑥ 的取文处：本插件**客户端半边**（浏览器侧插件入口）。
 *
 * 与 `PLUGIN_ENTRY`（宿主侧包根 index.js）是两个不同的装载面——⑤ 走真实 SkillRegistry
 * 挂载宿主半边，⑥ 走 stub `window` 装载客户端半边；两者不得互相代替。
 */
export const PLUGIN_CLIENT_ENTRY = fileURLToPath(new URL('../lib/client.js', import.meta.url));

/** 本包根（§7.7③ 的 bundle 面静态断言取文位置）。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** bundle insert 层 patch 文件（§7.7③：静态源码文本断言的唯一取文处）。 */
const BUNDLE_PATCH_FILE = join(PACKAGE_ROOT, 'cordis.patch.yml');

/** CLI `--skill-roots` 缺省值：包内 skills/（T14 首灌前不存在，smoke 须注入）。 */
const PACKAGED_SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url));

/**
 * 合成入口技能名（Task 6，spec §5.2）：内存合成、不落盘，宿主对候选的
 * `resourceBase` 条件透传而 provider 不捏造该字段，故第 4 步的 directory 判定按
 * **此名**豁免；其余候选（vendor）一律维持严格判定。
 */
const ENTRY_SKILL_NAME = 'ppt-master-env';

// ─── §7.7 六项设计成立性前置检查的判据锚（Task 10 + Task 4）───────

/**
 * ① 的遍历口径锚：Config **五**叶子 volatile（venv 三 + scope 两），**且**必须另有 ≥1 个非 volatile 叶。
 *
 * 本机宿主实测：`Config.toJSON()` 为 `{uid, refs}` 引用图（**顶层无属性对象**），
 * 9 个 refs = 5 volatile（venv 的 `enabled` boolean 叶、`path` string 叶、
 * `oldPathPolicy` union 叶；scope 的 `mode` union 叶、`workspaceIds` list 叶）
 * + 4 非 volatile（root/venv/scope 三个 object 容器 + `oldPathPolicy` 的两个 const 叶；
 * scope 的 `mode` 两个 const 叶与 `workspaceIds` 的 string 叶随其父叶一并计入 volatile 侧，
 * 口径由下方动态遍历决定，此处只记录期望总数）。
 * 只数 volatile 而不要求非 volatile 叶在场，会让替身/真实包"把所有叶都标 volatile"
 * 时同样全绿——即自我印证。
 */
/**
 * volatile 叶的期望条数：`venv.{enabled,path,oldPathPolicy}` 三叶 + `scope.{mode,workspaceIds}`
 * 两叶（2026-10-18 工具可见范围特性新增）。少一个 ⇒ 宿主不出该字段的编辑面；多一个 ⇒ 说明
 * 有叶子被误标（volatile 会让宿主原地改引用而不重挂插件，语义必须逐叶确认）。
 */
const VOLATILE_LEAF_COUNT = 5;

/** ②/⑤ 判据锚：vendor 主技能名（生产包内根读回的在场证据）。 */
const VENDOR_PRIMARY_SKILL = 'ppt-master';

/** ③ 判据锚：bundle insert 条目 id（应与插件 `name` 导出一致；不一致即 problems）。 */
const BUNDLE_INSERT_ID = 'dsh-ppt-master-wrapper';

/** ⑥ 判据锚：插件页 bundle 级配置槽名（客户端半边 `slots.register` 的 options.name）。 */
const SLOT_NAME = 'plugins.bundle.config';

/**
 * ⑥ 判据锚：客户端半边的 locale 命名空间（`ctx.locale.register` 的 ns，亦是槽位
 * options.locale）——与 §7.7①②③④⑤ 的宿主面 anchor 相互独立。
 */
const CLIENT_LOCALE_NS = 'dsh-ppt-master-config';

/**
 * ④ 的静态文本判据（受控解析通道的两半）：正向标记必须出现、ESM 裸导入必须缺席。
 *
 * ④ 的**实跑**证据（入口装载成功）同时是 ① 的前提：`Config.toJSON()` 的引用图由同一个
 * 受控解析出的 schemastery 产出，替身若失真（例如把所有叶都标 volatile）则 ① 会自我
 * 印证——故 ① 的「另有非 volatile 叶」断言与 ④ 同批判定，缺一即整套验证面不可采信。
 */
const CONTROLLED_CHANNEL_MARKERS = [
  { label: 'createRequire', pattern: /createRequire\(/ },
  { label: '@deepseek-ai/schemastery', pattern: /@deepseek-ai\/schemastery/ },
];
const BARE_SCHEMASTERY_IMPORT = /(?:^|\n)\s*import\b[^\n]*from\s*['"]@deepseek-ai\/schemastery['"]/;

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

// ─── §7.7 静态源码文本判据（③④；不引入 env 通道子进程）─────────

/**
 * 两**普通值**对象是否键集与值逐字相等（无 npm 依赖的浅比较；本契约对象只有标量键）。
 *
 * 用于默认值交叉锚定（§7.7 附带项）：`snapshotVenvConfig(Config({}).venv)` 与
 * `assembleInjectionBag(undefined).venv` 是两处字面拷贝的产物，无此断言则漂移静默。
 */
function samePlainRecord(left, right) {
  const keysOf = (value) => Object.keys(value ?? {}).sort();
  const leftKeys = keysOf(left);
  const rightKeys = keysOf(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && Object.is(left[key], right[key]));
}

/**
 * 读回 bundle 层 `cordis.patch.yml` 的 `insert:` 段内条目 id 列表（③ 的静态源码文本断言）。
 *
 * **分层重解释（不可越界）**：本包 patch 的顶层是 `- insert:` 列表项，其下才是
 * `- id: <插件 id>` 条目——compat 侧静态断言**只锁 bundle insert 层**。**profile 层**
 * 条目（`$DSH_HOME/profiles/<p>/cordis.patch.yml`）在本版 DSH（0.2.0-rc.2）由操作者
 * **手工写入**或宿主 config-editor 代建（设置页渲染者＝本包客户端半边，2026-10-16 特性已交付）；若宿主版本提供设置页，
 * 则由宿主 config-editor `edit()` 在首次编辑且 `index<0` 时以
 * `document.add({id,name,config})` 代建——两通道均不写成 bundle 面静态断言，
 * 其落点是验收期人工步骤（见 README §8 核对表）。
 *
 * 零 npm 依赖、不引入 YAML 解析：以「`insert:` 行之后、下一个同级或更外层键之前」为
 * 段，段内收集 `- id:` 行。
 *
 * @returns {{ ok: true, ids: string[] } | { ok: false, reason: string }}
 */
function readBundleInsertIds() {
  let source;
  try {
    source = readFileSync(BUNDLE_PATCH_FILE, 'utf8');
  } catch (error) {
    return { ok: false, reason: `bundle ${BUNDLE_PATCH_FILE} 不可读: ${firstLine(error)}` };
  }
  const lines = source.split('\n');
  const insertAt = lines.findIndex((line) => /^(\s*)(?:-\s*)?insert:\s*$/.test(line));
  if (insertAt < 0) return { ok: false, reason: `无 insert: 段（${BUNDLE_PATCH_FILE}）` };
  const baseIndent = lines[insertAt].match(/^(\s*)/)[1].length;
  const ids = [];
  for (const line of lines.slice(insertAt + 1)) {
    if (line.trim() === '') continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= baseIndent) break; // 段结束（下一个同级/更外层键）
    const idMatch = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line);
    if (idMatch !== null) ids.push(idMatch[1]);
  }
  return { ok: true, ids };
}

/**
 * §7.7④ 的静态文本证据：插件入口必须经**受控解析通道**取宿主 schemastery。
 *
 * 正向＝`createRequire` + 包名标记在场；负向＝无 `@deepseek-ai/schemastery` 的 ESM
 * 裸导入（符号链接装载路径下裸导入必然 ERR_MODULE_NOT_FOUND，spec §5.1/§6.1⓪）。
 * 与**实跑**（入口在本环境装载成功＝受控解析命中）合成本项证据；不另立 env 通道。
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function readControlledChannelEvidence() {
  let source;
  try {
    source = readFileSync(PLUGIN_ENTRY, 'utf8');
  } catch (error) {
    return { ok: false, reason: `插件入口 ${PLUGIN_ENTRY} 不可读: ${firstLine(error)}` };
  }
  const missing = CONTROLLED_CHANNEL_MARKERS.filter(({ pattern }) => !pattern.test(source));
  if (missing.length > 0) {
    return { ok: false, reason: `受控解析通道标记缺席: ${missing.map(({ label }) => label).join('、')}` };
  }
  if (BARE_SCHEMASTERY_IMPORT.test(source)) {
    return { ok: false, reason: '插件入口存在 @deepseek-ai/schemastery 的 ESM 裸导入（受控解析通道被绕过）' };
  }
  return { ok: true };
}

// ─── §7.7⑥ 客户端半边 stub 装载与注册（静态判据外的独立性检查）───

/**
 * 假 `require`：**白名单仅 react 系**（与 `lib/client.js` 的装载契约一致）。
 *
 * 表外 spec（尤其 `@deepseek-ai/dsh-client-*` 等 Harness 客户端包）一律 **throw**——
 * 官方 practice 明令客户端半边不得 require 任何 Harness 客户端包，一切经 Cordis 服务
 * 取得。拒绝是**如实转 problems**、不静默降级：require 白名单是硬契约。
 */
function clientRequireStub(spec) {
  if (spec === 'react' || spec === 'react-dom' || spec === 'react/jsx-runtime') {
    // 桩只提供注册面断言所需的成员；⑥ 不渲染卡片，故无需真实 React。
    return { createElement: () => null, useState: () => [undefined, () => {}], useEffect: () => {} };
  }
  throw new Error(`require 白名单拒绝模块表外的 spec：${spec}`);
}

/**
 * §7.7⑥：以 stub `window` 装载**真实**客户端半边，驱动 `factory` + `apply`，断言四要素。
 *
 * **当前 realm 求值**：用 `new Function('window', source)` 而非 `vm.runInNewContext`——
 * 后者产出的对象跨 realm，`deepStrictEqual`/字符串比较虽可用，但对象面不必要地跨界。
 *
 * 四要素（任一失败 → `problems` 前缀逐字 `§7.7⑥ `）：
 *  ① 载荷 `id === BUNDLE_INSERT_ID`（逐字＝包名，Loader 以它作 settings 命名空间名）；
 *  ② 插件面 `inject` 恰含 `slots`/`locale`（**不含** `configForms`——可选能力不得列入
 *     硬 inject）且 `apply` 为函数；
 *  ③ `ctx.inject` 收到 `['configForms']`（可选能力经回调式接入）；
 *  ④ `slots.register` 的 options 为 `{name:'plugins.bundle.config', key: BUNDLE_INSERT_ID,
 *     locale:'dsh-ppt-master-config'}`（槽位名/归属键/locale ns 三者逐字）。
 *
 * 全通过 → `note` 前缀逐字 `§7.7⑥ 客户端半边`，并逐字列出**四个证据串**（loader id＝
 * 包名、槽位名、locale ns、接入方式 `configForms`）；任一失败 → `problems` 非空、`note` 为 null。
 *
 * **夹具同形而刻意不复用** `tests/client-half.test.mjs` 的 `loadEntry`/假 require/假 ctx：
 * 测试不得依赖被测脚本的测试替身（替身失全会同时污染两侧），故两处各自维护、仅互相指认
 * （twin: `tests/client-half.test.mjs` 的「装载」/`makeRequire`/假 ctx 三节及其 Task 4
 * 用例头注）。
 *
 * @param {{ clientEntry?: string }} [options] `clientEntry` 为测试注入缝（tmpdir 改写源
 *   驱动负向用例）；生产缺省＝真实 `lib/client.js`。
 * @returns {{ problems: string[], note: string | null }}
 */
export function checkClientHalf({ clientEntry = PLUGIN_CLIENT_ENTRY } = {}) {
  const problems = [];
  const fail = (reason) => {
    problems.push(`§7.7⑥ ${reason}`);
    return { problems, note: null };
  };

  // ── 装载：读源 → 当前 realm 求值 → 捕获载荷 ──
  let source;
  try {
    source = readFileSync(clientEntry, 'utf8');
  } catch (error) {
    return fail(`客户端半边 ${clientEntry} 不可读: ${firstLine(error)}`);
  }

  const loads = [];
  const stubWindow = { __ModuleLoader__: { load: (payload) => loads.push(payload) } };
  try {
    // 含顶层 `import`/`export` 语句的源在此抛 SyntaxError——如实转 problems、不冒泡。
    new Function('window', source)(stubWindow);
  } catch (error) {
    return fail(`客户端半边 ${clientEntry} 装载失败（stub window 求值抛错）: ${firstLine(error)}`);
  }
  if (loads.length !== 1) {
    return fail(`__ModuleLoader__.load 应恰调用一次（实际 ${loads.length}）——装载契约漂移`);
  }

  // ── ① 载荷 id 逐字＝包名 ──
  const payload = loads[0];
  if (payload?.id !== BUNDLE_INSERT_ID) {
    return fail(
      `loader 载荷 id 非包名: 期望 ${BUNDLE_INSERT_ID}、实读 ${String(payload?.id)}`
        + '（Loader 以该 id 作 settings 命名空间名，不一致则宿主不认归属）',
    );
  }
  if (typeof payload?.factory !== 'function') {
    return fail('loader 载荷 factory 非函数——插件面无从取得');
  }

  // ── 插件面：factory(require) 的返回值即宿主眼中的 module.exports ──
  let face;
  try {
    face = payload.factory(clientRequireStub);
  } catch (error) {
    return fail(`factory(require) 执行失败: ${firstLine(error)}`);
  }

  // ── ② 硬 inject 恰含 slots/locale（不含 configForms）且 apply 为函数 ──
  const inject = Array.isArray(face?.inject) ? face.inject : null;
  if (inject === null) {
    return fail(`插件面 inject 非数组（实读 ${String(face?.inject)}）——硬服务声明无从判定`);
  }
  const missingServices = ['slots', 'locale'].filter((service) => !inject.includes(service));
  if (missingServices.length > 0) {
    return fail(
      `插件面 inject 缺硬服务: ${missingServices.join('、')}（实读 [${inject.join(', ')}]）`
        + '——二者缺失时 apply 根本不被调用，宿主以 pending 上报',
    );
  }
  if (inject.includes('configForms')) {
    return fail(
      `插件面 inject 误含可选能力 configForms（实读 [${inject.join(', ')}]）`
        + '——可选能力一律经 ctx.inject([\'configForms\'], cb) 回调式接入',
    );
  }
  if (typeof face?.apply !== 'function') {
    return fail(`插件面未导出 apply 函数（实读 ${typeof face?.apply}）——注册面无从驱动`);
  }

  // ── 驱动 apply：假 ctx 记录四个注册面（inject/effect/locale.register/slots.*）──
  const calls = { injects: [], localeRegisters: [], slotInjects: [], slotRegisters: [], formsGet: [] };
  // 最小 form：只满足 `readSnapshot` 的形状要求（`getSnapshot` 取到 loading、`subscribe` 可退订）。
  // `mutate` 在场使"写路由存在"可被后续判据消费；本检查不驱动写。
  const stubForm = {
    getSnapshot: () => ({ status: 'loading' }),
    subscribe: () => () => {},
    mutate: () => Promise.resolve(true),
  };
  const stubConfigForms = {
    get: (ns) => {
      calls.formsGet.push(ns);
      return stubForm;
    },
    describe: () => ({ getSnapshot: () => ({ status: 'ready', view: { namespaces: [] } }) }),
  };
  const ctx = {
    // `configForms` 与 `slots`/`locale` 一样是 **ctx 上的服务**（可选能力，见插件面 inject 判据）：
    // 在场才能驱动 `ctx.inject(['configForms'], cb)` 的**回调体**——否则该接入体是死代码，
    // 其内部异常（standalone S4 指出的"接入体 throw 仍 exit 0"）无从暴露。
    configForms: stubConfigForms,
    inject: (deps, cb) => {
      calls.injects.push(deps);
      cb?.(ctx);
    },
    effect: (fn) => fn(),
    locale: {
      register: (ns, dicts) => {
        calls.localeRegisters.push({ ns, dicts });
        return () => {};
      },
      bind: () => (key) => key,
    },
    slots: {
      inject: (name, cb) => {
        calls.slotInjects.push(name);
        return cb();
      },
      register: (options, Component) => {
        calls.slotRegisters.push({ options, Component });
        return () => {};
      },
    },
  };
  try {
    face.apply(ctx);
  } catch (error) {
    return fail(`apply(ctx) 实跑抛错: ${firstLine(error)}`);
  }

  // ── ③ 可选能力 configForms 经 ctx.inject 回调式接入 ──
  const configFormsInject = calls.injects.find(
    (deps) => Array.isArray(deps) && deps.includes('configForms'),
  );
  if (configFormsInject === undefined) {
    return fail(
      `未观测到 ctx.inject(['configForms'], cb) 回调式接入（实读 ${JSON.stringify(calls.injects)}）`
        + '——缺可选能力时该接入不注册，但接入通道本身必须存在',
    );
  }

  // ── ④ 槽位注册：options 三键逐字 ──
  if (calls.slotInjects.length === 0) {
    return fail('未观测到 slots.inject 槽位接入（实读 0 次）——卡片无挂载点');
  }
  if (calls.slotRegisters.length !== 1) {
    return fail(`slots.register 应恰调用一次（实际 ${calls.slotRegisters.length}）——注册契约漂移`);
  }
  const registered = calls.slotRegisters[0];
  if (typeof registered.Component !== 'function') {
    return fail(`slots.register 的 Component 非函数（实读 ${typeof registered.Component}）`);
  }
  const options = registered.options ?? {};
  if (options.name !== SLOT_NAME) {
    return fail(`槽位 options.name 非 ${SLOT_NAME}（实读 ${String(options.name)}）`);
  }
  if (options.key !== BUNDLE_INSERT_ID) {
    return fail(
      `槽位 options.key 非包名 ${BUNDLE_INSERT_ID}（实读 ${String(options.key)}）`
        + '——key 不＝包名时宿主插件页不渲染该 section',
    );
  }
  if (options.locale !== CLIENT_LOCALE_NS) {
    return fail(`槽位 options.locale 非 ${CLIENT_LOCALE_NS}（实读 ${String(options.locale)}）`);
  }

  // ── ⑤ 接入体**被真实驱动**：`configForms.get(ns)` 实际被调用 ──
  // 仅"看到 ctx.inject(['configForms'], cb)"不足以证明接入体可跑（S4）：接入体内部若抛错，
  // 或缺 `forms.get` 守卫，注册面照旧成立而该路径是死代码。故要求 `get` 被调用**恰一次**。
  if (calls.formsGet.length !== 1) {
    return fail(
      `configForms.get 应恰调用一次（实际 ${calls.formsGet.length}）`
        + '——接入体未被驱动时其内部异常与守卫均无从暴露（死代码）',
    );
  }

  // 全通过：note 逐字五个证据串（供用例 1 的三标记断言证明非空跑）。
  return {
    problems,
    note:
      `§7.7⑥ 客户端半边: stub window 装载 ${clientEntry} 成功；loader id=${payload.id}、`
      + `槽位 ${options.name}（key=${options.key}）、locale ns=${options.locale}、`
      + `可选能力 configForms 经 ctx.inject 回调式接入（未入硬 inject）、`
      + `接入体已驱动（configForms.get(${calls.formsGet[0]}) 恰一次）`,
  };
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
 *   - `clientEntry?: string` — §7.7⑥ 的取文处，缺省真实 `lib/client.js`；测试以
 *     tmpdir 改写源驱动⑥的负向分支（生产恒为真实文件）。
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
  // ⑥ 的取文处：测试注入缝（tmpdir 改写源驱动负向用例）；生产缺省＝真实 lib/client.js。
  const clientEntry = options.clientEntry ?? PLUGIN_CLIENT_ENTRY;

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
  //
  // 动态命名空间与第 4 步读回结果向第 7 步传递：§7.7① 取 `ns.Config`，§7.7② 的
  // 实跑面复用本步的 `apply(ctx, toolOptions)` 结果，§7.7⑤ 在生产根形态下复用本步读回
  // （toolOptions 缺省即生产包内根形态，避免同形态二次挂载）。
  let ctx = null;
  let pluginNamespace = null;
  let skillReadBack = null;
  try {
    pluginNamespace = await import(pathToFileURL(PLUGIN_ENTRY).href);
    if (typeof pluginNamespace.apply !== 'function') {
      problems.push(`插件入口 ${PLUGIN_ENTRY} 未导出 apply——无法驱动 SkillRegistry 挂载`);
    } else {
      ctx = mount();
      pluginNamespace.apply(ctx, toolOptions);
    }
  } catch (error) {
    problems.push(`apply(ctx, { skillRoots }) 驱动 ${PLUGIN_ENTRY} 失败: ${firstLine(error)}`);
    ctx = null;
    pluginNamespace = null;
  }

  if (ctx !== null) {
    try {
      const summaries = await ctx.skills.list({});
      if (!Array.isArray(summaries) || summaries.length === 0) {
        problems.push('真实 SkillRegistry list() 返回 0 个候选——provider 挂载未生效');
      } else {
        const broken = [];
        const loaded = new Map();
        for (const summary of summaries) {
          const definition = await ctx.skills.get(summary.name, {});
          loaded.set(summary.name, definition);
          if (
            definition === undefined || definition === null
            || typeof definition.content !== 'string' || definition.content.trim() === ''
          ) {
            broken.push(summary.name);
          } else if (summary.name !== ENTRY_SKILL_NAME && definition.resourceBase?.kind !== 'directory') {
            // 判据钉死为**名字**：只有内存合成的入口技能（无文件、无 resourceBase）豁免；
            // 任何其他候选缺 directory resourceBase 仍是 problem（判定不弱化）。
            broken.push(`${summary.name}（resourceBase.kind 非 directory）`);
          }
        }
        skillReadBack = { names: summaries.map((summary) => summary.name), loaded };
        if (broken.length > 0) {
          problems.push(`候选经真实 SkillRegistry get() 读回失败: ${broken.join(', ')}`);
        } else {
          notes.push(`skills 读回（经真实 SkillRegistry）: ${summaries.map((summary) => summary.name).join(', ')}`);
        }
      }
    } catch (error) {
      problems.push(`真实 SkillRegistry list()/get() 失败: ${firstLine(error)}`);
      skillReadBack = null;
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

  // ── 7. §7.7 六项设计成立性前置检查（Task 10 + Task 4）──
  //
  // 载体分工（brief Step 1）：**③④＝静态源码文本断言**、**①②⑤＝实跑断言**；不采用
  // env 通道子进程。⑤ 的生产根形态＝`toolOptions` 缺省（provider 以参数缺省创建 →
  // 决策A 追加入口技能）；显式 `--skill-roots` 场景按决策A 不追加，故另挂一次生产根
  // 形态专测本项（读回结果复用第 4 步，避免同形态二次挂载）。
  //
  // ③④ 是纯源码文本判据、与插件装载成败无关，故封装为可重复调用的报告段：装载失败
  // 时也要给出这两项结论（①②⑤ 则确实无从判定）。

  /**
   * ③ bundle insert 层 ＋ ④ 受控解析通道（静态源码文本断言；两条 return 路径都调用）。
   *
   * @param {{ pluginLoaded: boolean }} outcome 入口装载结果——④ 的**实跑半**只在装载成功时
   *   才能声称「受控解析命中」；装载失败时如实标为实跑半失败（否则该行会在 ④ 本应诊断的
   *   场景里自相矛盾地报成功）。
   */
  const reportStaticChecks = ({ pluginLoaded }) => {
    // ③ bundle insert 层（静态源码文本断言；profile 层＝操作者手工条目 or 宿主 config-editor 代建 + 验收期人工步骤）
    const bundle = readBundleInsertIds();
    if (!bundle.ok) {
      problems.push(`§7.7③ bundle insert 层静态断言失败: ${bundle.reason}`);
    } else {
      // 期望 id 优先取插件 `name` 导出（bundle 条目须指向本插件）；装载失败时回落常量。
      const expectedId = typeof pluginNamespace?.name === 'string' && pluginNamespace.name !== ''
        ? pluginNamespace.name
        : BUNDLE_INSERT_ID;
      if (!bundle.ids.includes(expectedId)) {
        problems.push(
          `§7.7③ bundle insert 层缺 id: ${expectedId} 条目（${BUNDLE_PATCH_FILE} 的 insert 段实读: `
            + `${bundle.ids.join(', ') || '空'}）`,
        );
      } else {
        notes.push(
          `§7.7③ bundle insert 层: cordis.patch.yml 的 insert 段含 id: ${expectedId}（静态源码文本断言）；`
            + 'profile 层条目＝操作者手工写入或宿主 config-editor 代建；设置页渲染者＝本包客户端半边'
            + '（2026-10-16特性已交付）→ 验收期人工步骤，不在 bundle 面静态断言',
        );
      }
    }

    // ④ schemastery 可解析性：静态源码文本断言（受控解析通道存在）＋ 实跑半（装载结果如实陈述）
    const channel = readControlledChannelEvidence();
    if (!channel.ok) {
      problems.push(`§7.7④ 受控解析通道静态断言失败: ${channel.reason}`);
    } else {
      notes.push(
        '§7.7④ schemastery 可解析性: index.js 含受控解析通道（createRequire 锚定定位到的宿主 '
          + 'node_modules、无 ESM 裸导入——静态源码文本断言）'
          + (pluginLoaded
            ? '＋ 本环境入口实跑装载成功（受控解析命中）'
            : '；**本环境入口实跑装载失败**——受控解析未命中（见 problems），本项仅静态半成立'),
      );
    }

    // ⑥ 客户端半边（stub window 装载 + 注册面断言）：与宿主面装载成败**无关**——它读的是
    //    另一个文件（lib/client.js），故装载失败路径同样给出⑥结论（与③④同纪律）。
    //    ⑥ 自身不抛：任何失败都在 checkClientHalf 内转成带 `§7.7⑥ ` 前缀的 problems。
    const clientHalf = checkClientHalf({ clientEntry: clientEntry });
    if (clientHalf.problems.length > 0) {
      problems.push(...clientHalf.problems);
    } else {
      notes.push(clientHalf.note);
    }
  };

  if (pluginNamespace === null) {
    reportStaticChecks({ pluginLoaded: false });
    problems.push('§7.7①/②/⑤ 无法判定：插件入口装载失败（见上）——Config/apply/入口技能三面均不可达');
  } else {
    // ① Config volatile 声明（访问路径钉死＝动态命名空间的 `ns.Config`）
    try {
      const json = typeof pluginNamespace.Config?.toJSON === 'function'
        ? pluginNamespace.Config.toJSON()
        : null;
      if (json === null || typeof json !== 'object' || json.refs === undefined || json.refs === null) {
        problems.push('§7.7① Config 不可达或其 toJSON() 非 {uid, refs} 引用图——volatile 声明无从遍历');
      } else {
        const refs = Object.values(json.refs);
        const volatileRefs = refs.filter((node) => node.meta?.volatile === true);
        // 「非 volatile 叶」＝无子节点的 ref（容器 object/union 不算）：只断言"存在非
        // volatile 节点"会被 root/venv 容器满足，使本检查自我印证。
        const nonVolatileLeaves = refs.filter(
          (node) => node.meta?.volatile !== true && node.dict === undefined && node.list === undefined,
        );
        if (volatileRefs.length !== VOLATILE_LEAF_COUNT) {
          problems.push(
            `§7.7① Config volatile 声明异常: toJSON() refs 内 volatile 叶 ${volatileRefs.length} ≠ ${VOLATILE_LEAF_COUNT}`
              + '（五字段 venv.enabled/path/oldPathPolicy + scope.mode/workspaceIds 须逐个 .volatile()）',
          );
        } else if (nonVolatileLeaves.length === 0) {
          problems.push(
            '§7.7① Config volatile 声明不可采信: 引用图内无任何非 volatile 叶——volatile 计数可能自我印证'
              + '（须另含 ≥1 非 volatile 叶，如 oldPathPolicy 联合型的 const 子节点）',
          );
        } else {
          notes.push(
            `§7.7① Config volatile 声明: ns.Config 可达；toJSON() refs ${refs.length} 项，`
              + `volatile 恰 ${volatileRefs.length}（Object.values(refs) 遍历口径），另有 ${nonVolatileLeaves.length} 个非 volatile 叶`,
          );
        }
      }
    } catch (error) {
      problems.push(`§7.7① Config volatile 声明检查失败: ${firstLine(error)}`);
    }

    // ① 附带：默认值交叉锚定（携入自 Task 5 审查）——schema 校验默认值 vs 注入袋缺省默认值
    try {
      const parsed = typeof pluginNamespace.Config === 'function' ? pluginNamespace.Config({}) : null;
      const schemaDefaults = snapshotVenvConfig(parsed?.venv);
      const bagDefaults = assembleInjectionBag(undefined).venv;
      if (!samePlainRecord(schemaDefaults, bagDefaults)) {
        problems.push(
          '默认值交叉锚定失败: schema 校验默认值与注入袋缺省默认值不一致'
            + `（schema=${JSON.stringify(schemaDefaults)}，注入袋=${JSON.stringify(bagDefaults)}）`
            + '——两处字面拷贝已漂移（index.js Config default vs lib/venv.js VENV_DEFAULTS）',
        );
      } else {
        notes.push(
          `默认值交叉锚定: snapshotVenvConfig(Config({}).venv) ≡ assembleInjectionBag(undefined).venv`
            + ` = ${JSON.stringify(bagDefaults)}`,
        );
      }
    } catch (error) {
      problems.push(`默认值交叉锚定检查失败: ${firstLine(error)}`);
    }

    // ② apply 第二参注入通道（实跑；与第 4 步的 `apply(ctx, toolOptions)` 同一通道）
    if (typeof pluginNamespace.apply !== 'function') {
      problems.push('§7.7② 插件入口未导出 apply——第二参注入通道无从实跑');
    } else if (ctx === null || skillReadBack === null || skillReadBack.names.length === 0) {
      problems.push(
        '§7.7② apply(ctx, toolOptions) 实跑未驱动注册面'
          + `（第 4 步读回: ${skillReadBack === null ? '失败' : skillReadBack.names.join(', ') || '空'}）`,
      );
    } else {
      try {
        // 探针注入：显式根经**第二参**驱动注册面，且按决策A 不追加合成入口——两向都可观测。
        const probeCtx = mount();
        pluginNamespace.apply(probeCtx, { skillRoots: [PACKAGED_SKILLS_ROOT] });
        const probeNames = (await probeCtx.skills.list({})).map((candidate) => candidate.name);
        if (!probeNames.includes(VENDOR_PRIMARY_SKILL)) {
          problems.push(
            `§7.7② 显式 skillRoots 经第二参未生效: 读回 ${probeNames.join(', ') || '空'}（缺 ${VENDOR_PRIMARY_SKILL}）`,
          );
        } else if (probeNames.includes(ENTRY_SKILL_NAME)) {
          problems.push(
            `§7.7② 显式 skillRoots 不应追加合成入口技能 ${ENTRY_SKILL_NAME}（决策A：仅参数缺省时追加）`,
          );
        } else {
          notes.push(
            `§7.7② apply 第二参注入通道: apply(ctx, toolOptions) 实跑读回 ${skillReadBack.names.join(', ')}；`
              + `显式 roots 探针 [包内 skills/] → ${probeNames.join(', ')}（第二参生效；决策A 下不追加合成入口）`,
          );
        }
      } catch (error) {
        problems.push(`§7.7② apply(ctx, { skillRoots }) 探针实跑失败: ${firstLine(error)}`);
      }
    }

    // ③ bundle insert 层 ＋ ④ 受控解析通道（静态源码文本断言，与装载成败无关）
    reportStaticChecks({ pluginLoaded: true });

    // ⑤ 入口技能读回（生产根形态；与 Task 6 决策A 联动）
    try {
      let production = toolOptions === undefined ? skillReadBack : null;
      if (production === null) {
        const productionCtx = mount();
        pluginNamespace.apply(productionCtx, undefined); // 参数缺省 → 生产包内根（追加入口）
        const summaries = await productionCtx.skills.list({});
        const loaded = new Map();
        for (const summary of summaries) {
          loaded.set(summary.name, await productionCtx.skills.get(summary.name, {}));
        }
        production = { names: summaries.map((summary) => summary.name), loaded };
      }
      if (!production.names.includes(ENTRY_SKILL_NAME)) {
        problems.push(
          `§7.7⑤ 生产根形态读回不含入口技能 ${ENTRY_SKILL_NAME}`
            + `（实际: ${production.names.join(', ') || '空'}）——合成入口未随 provider 挂载`,
        );
      } else {
        const entry = production.loaded.get(ENTRY_SKILL_NAME);
        if (
          entry === undefined || entry === null
          || typeof entry.content !== 'string' || entry.content.trim() === ''
        ) {
          problems.push(`§7.7⑤ 入口技能 ${ENTRY_SKILL_NAME} 经真实 SkillRegistry get() 读回失败或 content 为空`);
        } else {
          notes.push(
            `§7.7⑤ 入口技能读回（生产根形态）: ${ENTRY_SKILL_NAME} 经真实 SkillRegistry 在场、可 get()、`
              + `content 非空（${entry.content.length} 字符）`,
          );
        }
      }
    } catch (error) {
      problems.push(`§7.7⑤ 生产根形态挂载/读回失败: ${firstLine(error)}`);
    }
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
