#!/usr/bin/env node

/**
 * verify-plugin.mjs — 本地校验脚本（spec §6 verify 行逐项）。
 *
 * 检查清单（①-⑨，与 spec §6 / plan Task 8 Step 3 逐项对应）：
 *  ① LICENSE 归一化摘要：期望值用正则从**被验树内** `scripts/attribution_guard.py`
 *     的 `_LICENSE_DIGEST` 常量解析（绝不硬编码上游值——上游合法更新 digest 时不
 *     误报）；比对前复刻 guard `_normalized_bytes()`（BOM 拒绝、CRLF/CR→LF）。
 *  ② frontmatter 三键（copyright/license/official_repository）逐字精确值：
 *     期望值双重核对——被验树 SKILL.md 当前值 AND guard `_EXACT_METADATA_VALUES`
 *     常量（同自被验树解析），两者互证；另核 guard `_REQUIRED_METADATA_FIELDS`
 *     存在性（恰一次）。
 *  ③ 归属文件存在（LICENSE/SPONSORS.md/SPONSORS_CN.md，清单解析自 guard）。
 *  ④ 9 个门文件存在（清单解析自 guard `_REQUIRED_GATE_FILES`）。
 *  ⑤ SKILL.md 门标记计数==1（标记解析自 guard `_SKILL_GATE_MARKER`；蕴含⑧存在性）。
 *  ⑥ 全量逐字节比对——**方向性 skill 面比对**：以被验树（vendor 或 staging）的
 *     每个 skill 目录为基准，与 upstream 解压树中对应同名 skill 目录
 *     （`<upstream>/skills/<同名>`）逐文件比对；upstream 根文件与 `skills/` 一级
 *     非 skill 目录豁免（不在 vendor 面）。`--upstream` 缺省 → problems fail-loud
 *     提示「需提供 --upstream 比对树」，不静默跳过。
 *  ⑦ SKILL.md 相对链接：子树内死链 → problems；越出被验 skill 子树 → warnings
 *     （上游结构使然，豁免语义）。
 *  ⑧ 门标记存在（由⑤计数==1 蕴含）。
 *  ⑨ mock ctx 驱动真实 index.js（`apply(ctx, {skillRoots:[root]})` 同一注入通道）：
 *     provider list/get 往返一致 + 3 工具注册且各 output.schema 为 object-rooted
 *     JSON Schema（显式字段 + additionalProperties:false，禁 type:'json'）。
 *
 * 另：frontmatter 两级判据——name≠目录名 → warnings；name 缺失/非 kebab-case、
 * description 缺失 → problems（provider 注册已 throw 的场景由 runVerify 捕获并转
 * problems，不让异常逃逸）。
 *
 * `skipGuard=true` 只在 warnings 记「guard 未运行」标记（python attribution_guard
 * 未执行——它不是缺陷；本脚本的 JS 等价校验 ①-⑤ 仍照常运行，不构成完整性放行）。
 *
 * CLI：`node scripts/verify-plugin.mjs [--root <dir>] [--upstream <dir>] [--skip-guard]`
 * （无 marker-note 参数）。`--root` 缺省解析为 `<插件根>/skills`；`--upstream` 为
 * 解压仓库根（skill 目录位于其 `skills/` 下）。problems 非空 → **exit 1** 列出全部
 * （verify-plugin 自身退出码，spec §6 仅要求非零；sync-upstream 编排内该失败映射
 * 为退出码 4——两层退出码勿混用）。
 *
 * 零 npm 依赖（node:crypto/fs/path/url）。
 *
 * @module dsh-ppt-master-wrapper/scripts/verify-plugin
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { apply } from '../index.js';
import { listSkillDirs, parseFrontmatter } from '../lib/skill-provider.js';

// ─── 常量 ────────────────────────────────────────────────────────

/** 与 provider 相同的 kebab-case 语法（spec §3.4 两级判据的 problems 级）。 */
const KEBAB_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** ⑨ 期望注册的三个生命周期工具（本插件自身契约，非上游值）。 */
const EXPECTED_TOOLS = ['ppt_master_info', 'ppt_master_check_env', 'ppt_master_setup_deps'];

/** 插件自身的 skills 根（CLI `--root` 缺省值；T14 首灌后存在）。 */
const PACKAGED_SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url));

// ─── 纯函数：normalizedSha256 / parseExpectedDigest ──────────────

/**
 * 复刻 guard `_normalized_bytes()` 后计算 sha256：
 * UTF-8 BOM → throw（guard 同款拒绝，非静默剥离）；UTF-8 解码（非法字节 throw）；
 * `\r\n` 与孤立 `\r` 统一为 `\n`；对重编码字节取 sha256 hex。
 *
 * CRLF 签出环境因此不误报（Review Focus #2：真实上游 LICENSE 无 CRLF，测试须构造
 * CRLF 副本验证归一化等价）。
 *
 * @param {Uint8Array} bytes 原始字节。
 * @returns {string} 归一化内容的 sha256 hex。
 * @throws {Error} 带 BOM、或字节不是合法 UTF-8。
 */
export function normalizedSha256(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('normalizedSha256 expects Uint8Array');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error('UTF-8 BOM is not allowed（guard _normalized_bytes 同款拒绝）');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** `_LICENSE_DIGEST = "<hex>"` 的解析正则（① 的期望值来源）。 */
const DIGEST_PATTERN = /^_LICENSE_DIGEST\s*=\s*"([^"]*)"/m;

/**
 * 从 guard 源码解析期望的 LICENSE 归一化摘要。
 *
 * @param {string} guardSource `attribution_guard.py` 源码文本。
 * @returns {string} 摘要常量（引号内原文）。
 * @throws {Error} 正则无匹配——fail-loud，绝不静默跳过（spec §6 ①）。
 */
export function parseExpectedDigest(guardSource) {
  if (typeof guardSource !== 'string') {
    throw new TypeError('parseExpectedDigest expects string');
  }
  const match = DIGEST_PATTERN.exec(guardSource);
  if (match === null) {
    throw new Error('attribution_guard.py 无法解析 _LICENSE_DIGEST（正则无匹配）');
  }
  return match[1];
}

// ─── guard 常量解析（①-⑤ 期望值全部取自被验树，零硬编码上游值）──

/** 转义字符串供嵌入 RegExp 字面量使用。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `_EXACT_METADATA_VALUES = { "k": '"v"', … }` → `{ k: '"v"' }`；无匹配 → null。 */
function parseExactMetadataValues(guardSource) {
  const block = /_EXACT_METADATA_VALUES\s*=\s*\{([^}]*)\}/.exec(guardSource);
  if (block === null) return null;
  const pairs = {};
  const pattern = /"([^"]+)"\s*:\s*'([^']*)'/g;
  let match = pattern.exec(block[1]);
  if (match === null) return null;
  while (match !== null) {
    pairs[match[1]] = match[2];
    match = pattern.exec(block[1]);
  }
  return pairs;
}

/** `_NAME = ("a", "b", …)` 元组 → `['a','b',…]`；无匹配 → null。 */
function parseTupleConstant(guardSource, constantName) {
  const block = new RegExp(`${escapeRegExp(constantName)}\\s*=\\s*\\(([^)]*)\\)`).exec(guardSource);
  if (block === null) return null;
  const items = block[1].match(/"([^"]*)"/g);
  if (items === null) return null;
  return items.map((item) => item.slice(1, -1));
}

/** `_SKILL_GATE_MARKER = '…'` 单引号字面量 → 原文；无匹配 → null。 */
function parseGateMarker(guardSource) {
  const match = /_SKILL_GATE_MARKER\s*=\s*'([^']*)'/.exec(guardSource);
  return match === null ? null : match[1];
}

// ─── SKILL.md 归一化与 frontmatter 提取（guard 式） ─────────────

/**
 * SKILL.md 原始字节 → guard 同款归一化文本（BOM 拒绝 / CRLF,CR→LF）。
 *
 * @returns {string|null} 归一化全文；BOM/非法 UTF-8 → null（由调用方记 problems）。
 */
function normalizedTextOf(file) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file))
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
  } catch {
    return null;
  }
}

/**
 * guard `_frontmatter()` 的 JS 复刻：`---\n` 开头、`\n---\n` 收尾的前言块。
 *
 * @returns {string|null} 前言块文本（不含定界行），形态不符 → null。
 */
function frontmatterBlockOf(skillText) {
  if (skillText === null || !skillText.startsWith('---\n')) return null;
  const end = skillText.indexOf('\n---\n', 4);
  if (end < 0) return null;
  return skillText.slice(4, end);
}

/** 前言块中 `  <field>\s*:\s*(.*)` 行的捕获值（guard `^  f\s*:\s*v\s*$` 同位）；无 → null。 */
function metadataValuesOf(frontmatterLines, field) {
  const pattern = new RegExp(`^  ${escapeRegExp(field)}\\s*:\\s*(.*)$`);
  const values = [];
  for (const line of frontmatterLines) {
    const match = pattern.exec(line);
    if (match !== null) values.push(match[1].trimEnd());
  }
  return values;
}

/** 前言块中 `  <field>:` 键的出现次数（guard `_REQUIRED_METADATA_FIELDS` 判据）。 */
function metadataKeyCount(frontmatterLines, field) {
  const pattern = new RegExp(`^  ${escapeRegExp(field)}\\s*:`);
  return frontmatterLines.filter((line) => pattern.test(line)).length;
}

// ─── ⑦ SKILL.md 相对链接 ────────────────────────────────────────

/** 行内链接（含图片）的目标首 token；`[text](target "title")` 取 target。 */
const INLINE_LINK_PATTERN = /\]\(\s*([^)\s]+)[^)]*\)/g;

/** 跳过带 scheme 的目标（http/https/mailto…）与 `${…}` 模板占位。 */
const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

/**
 * 检查一个 skill 目录 SKILL.md 的相对链接。
 *
 * 解析限于被验 skill 目录子树内：目标越出子树（如指向上游仓库根的未 vendor 文件）
 * → warnings（上游结构使然，非本插件缺陷，不判失败）；子树内目标不存在 → problems。
 *
 * @returns {{problems: string[], warnings: string[]}}
 */
function checkSkillLinks(skillDir, skillName, skillText) {
  const problems = [];
  const warnings = [];
  if (skillText === null) return { problems, warnings };

  const seen = new Set();
  for (const match of skillText.matchAll(INLINE_LINK_PATTERN)) {
    const target = match[1];
    if (SCHEME_PATTERN.test(target) || target.startsWith('#') || target.includes('${')) continue;
    const path = target.split('#')[0];
    if (path === '' || seen.has(path)) continue;
    seen.add(path);

    const resolved = resolve(skillDir, path);
    if (resolved !== skillDir && !resolved.startsWith(`${skillDir}/`)) {
      warnings.push(`[${skillName}] SKILL.md 链接越出 skill 子树，豁免（警告）: ${path}`);
      continue;
    }
    if (!existsSync(resolved)) {
      problems.push(`[${skillName}] SKILL.md 死链（子树内目标不存在）: ${path}`);
    }
  }
  return { problems, warnings };
}

// ─── ⑨ mock ctx 驱动真实 index.js ──────────────────────────────

/**
 * 经 `apply(ctx, {skillRoots:[root]})` 同一注入通道驱动真实 index.js：
 * 3 工具注册且各 output.schema 为 object-rooted JSON Schema（type:'object' +
 * 非空 properties+`additionalProperties:false`，禁 `type:'json'`——SDK 静默降级）。
 *
 * provider 注册 throw（frontmatter fail-loud 契约）→ **捕获转 problems，不上抛**。
 *
 * @returns {object|null} 已实例化的 provider（供 list/get 往返），不可用 → null。
 */
function checkRegistration(root, problems) {
  const registered = { providers: [], tools: [] };
  const ctx = {
    skills: { registerProvider: (factory) => registered.providers.push(factory) },
    tools: { register: (tool) => registered.tools.push(tool) },
  };
  try {
    apply(ctx, { skillRoots: [root] });
  } catch (error) {
    problems.push(`apply 注册失败（provider fail-loud，转为 problems 不上抛）: ${error.message}`);
    return null;
  }

  const names = registered.tools.map((tool) => tool?.name);
  if (registered.tools.length !== EXPECTED_TOOLS.length || EXPECTED_TOOLS.some((n, i) => names[i] !== n)) {
    problems.push(
      `mock ctx 注册工具不符（期望 ${EXPECTED_TOOLS.join('/')}，实际 ${names.join('/') || '无'}）`,
    );
  }
  for (const tool of registered.tools) {
    const schema = tool?.output?.schema;
    const shapeOk =
      schema !== null && typeof schema === 'object'
      && schema.type === 'object'
      && schema.additionalProperties === false
      && typeof schema.properties === 'object' && schema.properties !== null
      && Object.keys(schema.properties).length > 0;
    if (!shapeOk) {
      problems.push(
        `工具 ${tool?.name} output.schema 非 object-rooted JSON Schema（type:'object' + 非空 properties + additionalProperties:false，禁 type:'json'）`,
      );
    }
  }
  return registered.providers.length > 0 ? registered.providers[0]() : null;
}

/** provider list/get 往返一致（list 每个候选 get 回定义：name 一致 + content 字符串）。 */
async function checkRoundtrip(provider, problems) {
  let listed;
  try {
    listed = await provider.list();
  } catch (error) {
    problems.push(`provider list() 失败: ${error.message}`);
    return;
  }
  for (const candidate of listed) {
    let definition;
    try {
      definition = await provider.get({ name: candidate.name });
    } catch (error) {
      problems.push(`provider get(${candidate.name}) 失败: ${error.message}`);
      continue;
    }
    if (
      definition === undefined
      || definition.name !== candidate.name
      || typeof definition.content !== 'string'
    ) {
      problems.push(`provider get(${candidate.name}) 往返回传失败（undefined/name 不符/缺 content）`);
    }
  }
}

// ─── ⑥ 方向性 skill 面全量逐字节比对 ────────────────────────────

/** 递归收集目录下全部文件（含隐藏文件）的绝对路径，按相对路径字节序排序。 */
function walkFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (statSync(path).isFile()) files.push(path);
      else if (statSync(path).isDirectory()) visit(path);
    }
  };
  visit(directory);
  return files.sort((left, right) => compareByteOrder(relative(directory, left), relative(directory, right)));
}

/** UTF-16 码单元序比较（localeCompare-free，与插件其余部分同一约定）。 */
function compareByteOrder(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * 逐对比较被验 skill 目录与 upstream 同名目录：文件集一致 + 每文件逐字节相等。
 *
 * 比对范围写死为**方向性 skill 面比对**——只有被验树的 skill 目录参与配对；
 * upstream 根文件与 `skills/` 一级非 skill 目录天然豁免（spec §4.1 步骤 3 自证）。
 */
function compareSkillPair(skillDir, skillName, upstreamDir, problems) {
  const leftFiles = walkFiles(skillDir);
  const rightFiles = walkFiles(upstreamDir);
  const rightRelative = new Map(rightFiles.map((file) => [relative(upstreamDir, file), file]));

  for (const file of leftFiles) {
    const rel = relative(skillDir, file);
    const counterpart = rightRelative.get(rel);
    if (counterpart === undefined) {
      problems.push(`[${skillName}] 仅存在于被验树（upstream 无此文件）: ${rel}`);
      continue;
    }
    if (Buffer.compare(readFileSync(file), readFileSync(counterpart)) !== 0) {
      problems.push(`[${skillName}] 与 upstream 逐字节不一致: ${rel}`);
    }
  }
  const leftRelative = new Set(leftFiles.map((file) => relative(skillDir, file)));
  for (const [rel] of rightRelative) {
    if (!leftRelative.has(rel)) problems.push(`[${skillName}] 仅存在于 upstream（被验树无此文件）: ${rel}`);
  }
}

/** ⑥ 编排：缺省 upstream fail-loud；逐 skill 目录配对比较。 */
function checkAgainstUpstream(root, skillDirs, upstream, problems) {
  if (upstream === undefined || upstream === null || upstream === '') {
    problems.push('第⑥项全量逐字节比对未执行：需提供 --upstream 比对树（fail-loud，不静默跳过）');
    return;
  }
  if (!existsSync(upstream) || !statSync(upstream).isDirectory()) {
    problems.push(`--upstream 路径不可用（不存在或非目录）: ${upstream}`);
    return;
  }
  for (const skillDir of skillDirs) {
    const skillName = baseName(skillDir);
    const counterpart = join(upstream, 'skills', skillName);
    if (!existsSync(counterpart) || !statSync(counterpart).isDirectory()) {
      problems.push(`[${skillName}] upstream 解压树缺少对应 skill 目录: ${counterpart}`);
      continue;
    }
    compareSkillPair(skillDir, skillName, counterpart, problems);
  }
}

/** 路径末段（POSIX/绝对路径通吃）。 */
function baseName(path) {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? path : path.slice(separator + 1);
}

// ─── 单 skill 目录：frontmatter 两级判据 + guard 逐项等价 ①-⑤ ──

/**
 * 对一个 skill 目录执行 frontmatter 两级判据与 guard 等价清单 ①-⑤、⑦。
 *
 * 期望值（digest/精确值/必存字段/归属文件/门文件/门标记）全部用正则从**本目录内**
 * `scripts/attribution_guard.py` 解析——被验树自证，上游合法更新常量时不误报；
 * 常量缺失/不可解析 → problems（fail-loud，不静默跳过）。
 */
function checkSkillDirectory(skillDir, problems, warnings) {
  const skillName = baseName(skillDir);
  const skillFile = join(skillDir, 'SKILL.md');
  const skillText = normalizedTextOf(skillFile);

  // ── frontmatter 两级判据（provider 同款判据的 verify 侧复刻）──
  const parsed = skillText === null ? null : parseFrontmatter(skillText);
  if (parsed === null) {
    problems.push(`[${skillName}] SKILL.md 无可解析 frontmatter 块（name/description 判据无从执行）`);
  } else {
    const name = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : '';
    const description =
      typeof parsed.data.description === 'string' ? parsed.data.description.trim() : '';
    if (name === '') {
      problems.push(`[${skillName}] SKILL.md frontmatter name 缺失`);
    } else if (!KEBAB_PATTERN.test(name)) {
      problems.push(`[${skillName}] SKILL.md name 非 kebab-case: "${name}"`);
    } else if (name !== skillName) {
      // 两级判据的警告级：合法但与目录名不一致，不判失败（spec §3.4/§6）
      warnings.push(`[${skillName}] SKILL.md name "${name}" ≠ 目录名 ${skillName}（警告级，spec §6 两级判据）`);
    }
    if (description === '') {
      problems.push(`[${skillName}] SKILL.md frontmatter description 缺失`);
    }
  }

  // ── ①-⑤ 期望值来源：被验树内的 attribution_guard.py ──
  const guardPath = join(skillDir, 'scripts', 'attribution_guard.py');
  if (!existsSync(guardPath)) {
    problems.push(`[${skillName}] attribution_guard.py 缺失，无法解析 _LICENSE_DIGEST 与 _EXACT_METADATA_VALUES 等 ①-⑤ 期望值（fail-loud）`);
    return;
  }
  const guardSource = readFileSync(guardPath, 'utf8');

  // ① LICENSE 归一化摘要 vs guard _LICENSE_DIGEST
  let expectedDigest;
  try {
    expectedDigest = parseExpectedDigest(guardSource);
  } catch (error) {
    problems.push(`[${skillName}] ${error.message}`);
  }
  if (expectedDigest !== undefined) {
    const licensePath = join(skillDir, 'LICENSE');
    if (!existsSync(licensePath)) {
      problems.push(`[${skillName}] LICENSE 缺失，无法计算归一化摘要`);
    } else {
      try {
        const actual = normalizedSha256(readFileSync(licensePath));
        if (actual !== expectedDigest) {
          problems.push(
            `[${skillName}] LICENSE 归一化摘要不匹配 guard _LICENSE_DIGEST（期望 ${expectedDigest}，实际 ${actual}）`,
          );
        }
      } catch (error) {
        problems.push(`[${skillName}] LICENSE 归一化失败: ${error.message}`);
      }
    }
  }

  // ② frontmatter 三键逐字精确值：SKILL.md 当前值与 guard 常量互证
  const exactValues = parseExactMetadataValues(guardSource);
  if (exactValues === null) {
    problems.push(`[${skillName}] attribution_guard.py 无法解析 _EXACT_METADATA_VALUES（正则无匹配）`);
  } else {
    const frontmatter = frontmatterBlockOf(skillText);
    if (frontmatter === null) {
      problems.push(`[${skillName}] SKILL.md 无法提取 frontmatter 块（guard 式 --- 分隔），② 无法执行`);
    } else {
      const lines = frontmatter.split('\n');
      for (const [field, expected] of Object.entries(exactValues)) {
        const current = metadataValuesOf(lines, field);
        if (current.length === 0) {
          problems.push(`[${skillName}] SKILL.md frontmatter 缺少 metadata.${field} 行（guard _EXACT_METADATA_VALUES）`);
        } else if (current.some((value) => value !== expected)) {
          problems.push(
            `[${skillName}] SKILL.md metadata.${field} 与 guard 常量不一致（guard=${expected}，SKILL.md=${current.join(' | ')}）`,
          );
        }
      }
    }
  }
  const requiredFields = parseTupleConstant(guardSource, '_REQUIRED_METADATA_FIELDS');
  if (requiredFields === null) {
    problems.push(`[${skillName}] attribution_guard.py 无法解析 _REQUIRED_METADATA_FIELDS（正则无匹配）`);
  } else {
    const frontmatter = frontmatterBlockOf(skillText);
    const lines = frontmatter === null ? [] : frontmatter.split('\n');
    for (const field of requiredFields) {
      const count = metadataKeyCount(lines, field);
      if (count !== 1) {
        problems.push(
          `[${skillName}] SKILL.md metadata.${field} 出现 ${count} 次（guard _REQUIRED_METADATA_FIELDS 要求恰 1 次）`,
        );
      }
    }
  }

  // ③ 归属文件存在（清单解析自 guard）
  const attributionFiles = parseTupleConstant(guardSource, '_REQUIRED_ATTRIBUTION_FILES');
  if (attributionFiles === null) {
    problems.push(`[${skillName}] attribution_guard.py 无法解析 _REQUIRED_ATTRIBUTION_FILES（正则无匹配）`);
  } else {
    for (const file of attributionFiles) {
      if (!existsSync(join(skillDir, file))) problems.push(`[${skillName}] 归属文件缺失: ${file}`);
    }
  }

  // ④ 门文件存在（清单解析自 guard；等价面=存在性，内容完整性由 ⑥ 兜底）
  const gateFiles = parseTupleConstant(guardSource, '_REQUIRED_GATE_FILES');
  if (gateFiles === null) {
    problems.push(`[${skillName}] attribution_guard.py 无法解析 _REQUIRED_GATE_FILES（正则无匹配）`);
  } else {
    for (const file of gateFiles) {
      if (!existsSync(join(skillDir, file))) problems.push(`[${skillName}] 门文件缺失: ${file}`);
    }
  }

  // ⑤ 门标记计数==1（guard 同款全文字符串计数；蕴含⑧存在性）
  const marker = parseGateMarker(guardSource);
  if (marker === null) {
    problems.push(`[${skillName}] attribution_guard.py 无法解析 _SKILL_GATE_MARKER（正则无匹配）`);
  } else if (skillText === null) {
    problems.push(`[${skillName}] SKILL.md 不可读/非法 UTF-8/BOM，门标记计数无法执行`);
  } else {
    const count = skillText.split(marker).length - 1;
    if (count !== 1) {
      problems.push(`[${skillName}] SKILL.md 门标记计数 ${count} ≠ 1（标记: ${marker}）`);
    }
  }

  // ⑦ 相对链接：子树内死链→problems；越界→warnings
  const links = checkSkillLinks(skillDir, skillName, skillText);
  problems.push(...links.problems);
  warnings.push(...links.warnings);
}

// ─── runVerify：①-⑨ 编排 ───────────────────────────────────────

/**
 * 对一个 skills 根（skill 目录的直接父级——staging 用法传 `.skills-staging/`，
 * 插件根用法传 `<插件根>/skills`）执行 spec §6 verify 行逐项校验。
 *
 * @param {string} root skills 根目录。
 * @param {{ skipGuard?: boolean, upstream?: string }} [opts] `upstream` = 解压仓库根
 *   （skill 目录位于其 `skills/` 下）；缺省 → 第⑥项 fail-loud 报 problems。
 *   `skipGuard: true` → warnings 含「guard 未运行」标记（JS 等价校验仍照常运行）。
 * @returns {Promise<{problems: string[], warnings: string[]}>} problems 非空 → CLI
 *   exit 1；provider 注册 throw 等异常一律捕获转 problems，不让异常逃逸。
 */
export async function runVerify(root, opts = {}) {
  const problems = [];
  const warnings = [];

  if (opts?.skipGuard === true) {
    warnings.push('guard 未运行（--skip-guard：python attribution_guard.py 未执行；本脚本的 JS 等价校验 ①-⑤ 仍已运行）');
  }

  // 归一为绝对路径：⑦ 的包含性判定比较 resolve 产物与 skillDir，两侧必须同构，
  // 否则相对 root 会把绝对化后的链接目标误判为越出子树（⑥ 配对同理取绝对路径）。
  const absoluteRoot = typeof root === 'string' && root !== '' ? resolve(root) : root;
  const upstream = opts?.upstream;
  const absoluteUpstream =
    typeof upstream === 'string' && upstream !== '' ? resolve(upstream) : upstream;

  // skill 目录面（与 provider 同一权威谓词；root 不可用 → problems 而非异常）
  let skillDirs = [];
  try {
    skillDirs = listSkillDirs(absoluteRoot);
    if (skillDirs.length === 0) {
      problems.push(`root 下无 skill 目录（一级含 SKILL.md 的目录，不存在或为空）: ${root}`);
    }
  } catch (error) {
    problems.push(`skill root 不可用（fail-loud 转 problems）: ${error.message}`);
  }

  // 逐 skill：frontmatter 两级判据 + guard 逐项等价 ①-⑤ + 链接 ⑦
  for (const skillDir of skillDirs) {
    try {
      checkSkillDirectory(skillDir, problems, warnings);
    } catch (error) {
      problems.push(`[${baseName(skillDir)}] 校验执行异常（fail-loud 转 problems）: ${error.message}`);
    }
  }

  // ⑨ mock ctx 驱动真实 index.js：3 工具注册 + schema 形态 + list/get 往返
  const provider = checkRegistration(absoluteRoot, problems);
  if (provider !== null) await checkRoundtrip(provider, problems);

  // ⑥ 方向性 skill 面全量逐字节比对
  checkAgainstUpstream(absoluteRoot, skillDirs, absoluteUpstream, problems);

  return { problems, warnings };
}

// ─── CLI ─────────────────────────────────────────────────────────

/** 解析 CLI 参数；未知参数或缺失取值 → `{ error }`（usage 错误，exit 1）。 */
function parseCliArgs(argv) {
  const options = { root: undefined, upstream: undefined, skipGuard: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root' || arg === '--upstream') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { error: `参数 ${arg} 缺少取值` };
      }
      options[arg === '--root' ? 'root' : 'upstream'] = value;
      i++;
    } else if (arg === '--skip-guard') {
      options.skipGuard = true;
    } else {
      return { error: `未知参数: ${arg}` };
    }
  }
  return options;
}

/** CLI 主流程：打印 problems/warnings，problems 非空 → exit 1（sync 编排映射为 4）。 */
async function cliMain(argv) {
  const options = parseCliArgs(argv);
  if ('error' in options) {
    console.error(
      `用法: node scripts/verify-plugin.mjs [--root <dir>] [--upstream <dir>] [--skip-guard]\n${options.error}`,
    );
    process.exit(1);
  }
  const root = options.root ?? PACKAGED_SKILLS_ROOT;
  const { problems, warnings } = await runVerify(root, {
    skipGuard: options.skipGuard,
    upstream: options.upstream,
  });

  console.log(`verify-plugin: root ${root}${options.upstream ? `（upstream ${options.upstream}）` : '（未提供 --upstream）'}`);
  if (warnings.length > 0) {
    console.log(`warnings ${warnings.length}:`);
    for (const warning of warnings) console.log(`  ⚠ ${warning}`);
  }
  if (problems.length > 0) {
    console.log(`problems ${problems.length}:`);
    for (const problem of problems) console.log(`  ✗ ${problem}`);
  }
  console.log(
    problems.length > 0
      ? `verify-plugin: FAILED（problems ${problems.length}，退出码 1）`
      : `verify-plugin: OK（problems 0，warnings ${warnings.length}）`,
  );
  process.exit(problems.length > 0 ? 1 : 0);
}

// 直接以 `node scripts/verify-plugin.mjs` 运行时才走 CLI；被 import 时不触发。
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
