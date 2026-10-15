import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkMarketplaceVersion,
  classifyChanges,
  stageSkills,
} from '../scripts/sync-upstream.mjs';

/**
 * Task 11 契约：sync 检测层（谓词 staging 复制 / 🔴🟡🟢 结构分类 / marketplace
 * 校验）。
 *
 * fixture 两个：`tests/fixtures/upstream-tree/`（解压仓库根形态——`skills/` 下
 * `ppt-master` mini + 仅上游存在的 `second-skill` + 不含 SKILL.md 的
 * `skills/.claude-plugin/` + 根 `.claude-plugin/marketplace.json`）与
 * `tests/fixtures/vendor-tree/`（vendor 形态——其下直接是 `skills/ppt-master`，
 * 旧版本、内容受控差异）。
 *
 * 覆盖钉子——
 * - staging 复制面 = T3 谓词（一级目录且直接子级存在 SKILL.md，dotfile 同判）
 *   过滤后的 skill 目录；`skills/.claude-plugin/` **不进入** staging；目录内
 *   隐藏文件（`.env.example`）**必须在场**（防空断言：前置 existsSync）。
 * - 行 1（skill-dir）**单向** 上游→vendor：上游多出 → red；vendor 多出 → 不红。
 * - 分类：red = skill-dir / name / metadata.version / top-level-entries；
 *   yellow = requirements / description / aux-dir；green = 其余常规内容变更。
 * - `green`（有常规内容变更）与 `vendorDiff`（任何字节差异，含红/黄涉及文件）
 *   语义**分离**——红/黄类变更同时把 vendorDiff 置真。
 * - aux-dir 数据源 = `<vendorSkillsRoot>` 同级的 `.upstream/last-aux-dirs.json`
 *   记录（第五可选参数 `auxStatePath` 可覆盖，测试传 tmp 路径）；
 *   `classifyChanges` 负责读写该记录。
 * - `checkMarketplaceVersion`：一致 → ok；不一致 → ok:false；缺失/无 version
 *   → 豁免（ok:true + note 警告语义）。
 *
 * 全部用例零网络、零 npm 依赖；每处对 fixture 关键文件的**行为**断言前先
 * `existsSync` 断言该文件确实存在（防 fixture 漂移导致的空断言假绿）。
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const upstreamTreeRoot = join(fixturesDir, 'upstream-tree');
const vendorTreeRoot = join(fixturesDir, 'vendor-tree');

/** vendor 树形态：其下直接是 skill 目录（`skills/ppt-master` 的父级）。 */
const vendorSkillsRoot = join(vendorTreeRoot, 'skills');

const upstreamPptMaster = join(upstreamTreeRoot, 'skills', 'ppt-master');

/** requirements.txt 的依赖行（非空、非注释）——测试侧自备，不复用生产正则。 */
const REQUIREMENT_HEAD = /^\s*[^#\s]/;

// ─── 助手 ────────────────────────────────────────────────────────

/** 断言路径存在——防空断言假绿（fixture 漂移时立刻报「前置缺失」而非静默放行）。 */
function requireExists(path, label) {
  assert.equal(existsSync(path), true, `前置 fixture 缺失（${label}）: ${path}`);
}

/**
 * 收集目录下全部文件相对路径（含隐藏文件），递归——用于断言 staging 复制面
 * 与 fixture 面逐一对齐。
 */
function listRelativeFiles(root) {
  const files = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path.slice(root.length + 1));
    }
  };
  walk(root);
  return files.sort();
}

/** 新建一个临时工作区（upstream 解压树 + vendor 树 + staging + aux 状态的宿主）。 */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'sync-detect-'));
  const upstream = join(root, 'upstream');
  const vendor = join(root, 'vendor');
  cpSync(upstreamTreeRoot, upstream, { recursive: true });
  cpSync(vendorTreeRoot, vendor, { recursive: true });
  return {
    root,
    upstream,
    vendor,
    vendorSkills: join(vendor, 'skills'),
    staging: join(root, '.skills-staging'),
    auxStatePath: join(root, '.upstream', 'last-aux-dirs.json'),
  };
}

/** 复制 upstream 的 skill 面到 staging（谓词过滤后的等价动作，供分类用例的基线）。 */
function stageInto(workspace) {
  return stageSkills(workspace.upstream, workspace.staging);
}

/**
 * 把 vendor 面「同步」到 staging 的当前内容，得到**中性基线**（vendor == staging）。
 *
 * fixture 的 upstream-tree 与 vendor-tree 之间刻意留有受控差异（多一个 skill、
 * 版本/描述更旧、多一个脚本、依赖行不同）——它们由**基线用例**（行 1、green 等）
 * 断言。凡是要隔离**单一分类项**的用例，必须先中性化，否则断言会被这些既存差异
 * 污染成「假红/假绿」。中性化后辅助目录状态也落一次盘，使 aux-dir 噪声归零。
 */
function neutralize(workspace) {
  stageInto(workspace);
  rmSync(workspace.vendorSkills, { recursive: true, force: true });
  cpSync(workspace.staging, workspace.vendorSkills, { recursive: true });
  classifyChanges(workspace.vendorSkills, workspace.staging, workspace.upstream, workspace.auxStatePath);
}

/**
 * 单个分类项用例的样板：中性基线 → 施加一处 staging 变更 → 分类。
 *
 * @param {(workspace: object) => void} mutate 施加在 staging 上的单一变更。
 * @returns {{ red: object[], yellow: object[], green: boolean, vendorDiff: boolean }}
 */
function classifyAfterSingleChange(mutate) {
  const workspace = makeWorkspace();
  try {
    neutralize(workspace);
    mutate(workspace);
    return classifyChanges(
      workspace.vendorSkills,
      workspace.staging,
      workspace.upstream,
      workspace.auxStatePath,
    );
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
}

/** 分类结果的 kind 列表（按 red/yellow 分桶）。 */
const kindsOf = (changes) => changes.map((change) => change.kind).sort();

/** staging 中某 skill 的相对路径（相对 staging 根）。 */
function stagingFile(workspace, ...segments) {
  return join(workspace.staging, ...segments);
}

/** 读取某 skill 在 staging 中的 SKILL.md 文本，替换 frontmatter 一行后写回。 */
function rewriteSkillLine(workspace, skillName, pattern, replacement) {
  const file = stagingFile(workspace, skillName, 'SKILL.md');
  requireExists(file, `${skillName} staging SKILL.md`);
  const text = readFileSync(file, 'utf8');
  const next = text.replace(pattern, replacement);
  assert.notEqual(next, text, `重写未生效（pattern 未命中）: ${pattern}`);
  writeFileSync(file, next);
}

// ─── stageSkills：谓词过滤 + 含隐藏文件的逐字节复制 ──────────────

test('stageSkills: 复制谓词过滤后的 skill 目录，返回目录名数组', () => {
  requireExists(join(upstreamTreeRoot, 'skills', 'ppt-master', 'SKILL.md'), 'upstream ppt-master/SKILL.md');
  requireExists(join(upstreamTreeRoot, 'skills', 'second-skill', 'SKILL.md'), 'upstream second-skill/SKILL.md');

  const workspace = makeWorkspace();
  try {
    const copied = stageInto(workspace);

    assert.deepEqual(copied, ['ppt-master', 'second-skill']);
    assert.equal(existsSync(stagingFile(workspace, 'ppt-master', 'SKILL.md')), true);
    assert.equal(existsSync(stagingFile(workspace, 'second-skill', 'SKILL.md')), true);
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('stageSkills: skills/ 一级非 skill 目录不进 staging（.claude-plugin）', () => {
  // 前置：该辅助目录确实存在（否则「不存在于 staging」是空断言）。
  requireExists(
    join(upstreamTreeRoot, 'skills', '.claude-plugin', 'plugin.json'),
    'upstream skills/.claude-plugin/plugin.json',
  );

  const workspace = makeWorkspace();
  try {
    stageInto(workspace);

    assert.equal(existsSync(stagingFile(workspace, '.claude-plugin')), false);
    assert.equal(existsSync(stagingFile(workspace, '.claude-plugin', 'plugin.json')), false);
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('stageSkills: 目录内隐藏文件随复制面保留（.env.example 逐字节在场）', () => {
  const sourceDotfile = join(upstreamTreeRoot, 'skills', 'ppt-master', '.env.example');
  requireExists(sourceDotfile, 'upstream ppt-master/.env.example');

  const workspace = makeWorkspace();
  try {
    stageInto(workspace);

    const stagedDotfile = stagingFile(workspace, 'ppt-master', '.env.example');
    assert.equal(existsSync(stagedDotfile), true, 'staging 丢失了隐藏文件 .env.example');
    assert.deepEqual(readFileSync(stagedDotfile), readFileSync(sourceDotfile));
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('stageSkills: staging 复制为逐字节全树等价（含隐藏文件，无遗漏）', () => {
  const workspace = makeWorkspace();
  try {
    stageInto(workspace);

    for (const skillName of ['ppt-master', 'second-skill']) {
      const expected = listRelativeFiles(join(workspace.upstream, 'skills', skillName));
      const actual = listRelativeFiles(join(workspace.staging, skillName));
      assert.deepEqual(actual, expected, `${skillName} staging 文件集与上游不一致`);
      for (const rel of expected) {
        assert.deepEqual(
          readFileSync(join(workspace.staging, skillName, rel)),
          readFileSync(join(workspace.upstream, 'skills', skillName, rel)),
          `${skillName}/${rel} 逐字节不一致`,
        );
      }
    }
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});

// ─── classifyChanges 行 1：skill-dir 单向（上游→vendor）──────────

test('classifyChanges: 上游多出 skill 目录 → red(skill-dir)（行 1 正向）', () => {
  requireExists(join(upstreamTreeRoot, 'skills', 'second-skill', 'SKILL.md'), 'upstream second-skill');

  const workspace = makeWorkspace();
  try {
    stageInto(workspace);
    const result = classifyChanges(workspace.vendorSkills, workspace.staging, workspace.upstream, workspace.auxStatePath);

    const skillDirChanges = result.red.filter((change) => change.kind === 'skill-dir');
    assert.equal(skillDirChanges.length, 1, `期望恰一条 skill-dir 变更，实得: ${JSON.stringify(result.red)}`);
    assert.match(skillDirChanges[0].detail, /second-skill/);
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('classifyChanges: vendor 多出 skill 目录 → 不产生 red（行 1 单向，包装层变更）', () => {
  // 中性基线上只有「vendor 多出」这一处差异——上游的 second-skill 也在基线里，
  // 否则它自己会先贡献一条 skill-dir 红项，掩盖本用例的判据。
  const workspace = makeWorkspace();
  try {
    neutralize(workspace);

    // 前置：基线中性（staging 与 vendor 的 skill 面一致），否则本用例结论无意义。
    assert.deepEqual(
      classifyChanges(workspace.vendorSkills, workspace.staging, workspace.upstream, workspace.auxStatePath).red,
      [],
    );

    // vendor 侧人工新增一个 skill 目录（上游没有）——属规则③域，不得入 red。
    const extra = join(workspace.vendorSkills, 'wrapper-only-skill');
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(extra, 'SKILL.md'), '---\nname: wrapper-only-skill\ndescription: wrapper-only fixture\n---\n\n# Wrapper Only\n');

    const result = classifyChanges(workspace.vendorSkills, workspace.staging, workspace.upstream, workspace.auxStatePath);

    assert.deepEqual(result.red, [], `vendor 多出 skill 目录不得产生 red，实得: ${JSON.stringify(result.red)}`);
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});

// ─── classifyChanges：red 各族 ───────────────────────────────────

test('classifyChanges: name 变更 → red(kind=name)', () => {
  const result = classifyAfterSingleChange((workspace) => {
    rewriteSkillLine(workspace, 'ppt-master', /^name: ppt-master$/m, 'name: ppt-master-renamed');
  });

  const changes = result.red.filter((change) => change.kind === 'name');
  assert.equal(changes.length, 1, `实得: ${JSON.stringify(result.red)}`);
  assert.match(changes[0].detail, /ppt-master-renamed/);
  assert.equal(result.vendorDiff, true);
});

test('classifyChanges: metadata.version 缺失 → red(kind=metadata.version)', () => {
  const result = classifyAfterSingleChange((workspace) => {
    // 前置：staging SKILL.md 确实带 metadata.version（否则「缺失」断言是空断言）。
    const skillFile = stagingFile(workspace, 'ppt-master', 'SKILL.md');
    assert.match(readFileSync(skillFile, 'utf8'), /^  version: /m);
    rewriteSkillLine(workspace, 'ppt-master', /^  version: ".*"$/m, '  version_unparsable_marker: true');
  });

  assert.equal(result.red.some((change) => change.kind === 'metadata.version'), true);
  assert.equal(result.vendorDiff, true);
});

test('classifyChanges: workflows/scripts/templates/references 一级条目增删 → red(top-level-entries)', () => {
  const result = classifyAfterSingleChange((workspace) => {
    mkdirSync(stagingFile(workspace, 'ppt-master', 'scripts', 'gantt'), { recursive: true });
    writeFileSync(stagingFile(workspace, 'ppt-master', 'scripts', 'gantt', 'cli.py'), '# new\n');
  });

  const changes = result.red.filter((change) => change.kind === 'top-level-entries');
  assert.equal(changes.length, 1, `期望恰一条 top-level-entries，实得: ${JSON.stringify(result.red)}`);
  assert.match(changes[0].detail, /scripts/);
});

test('classifyChanges: 删除 references/ 一级条目同样 → red(top-level-entries)', () => {
  const result = classifyAfterSingleChange((workspace) => {
    rmSync(stagingFile(workspace, 'ppt-master', 'references', 'notes.md'), { force: true });
  });

  const changes = result.red.filter((change) => change.kind === 'top-level-entries');
  assert.equal(changes.length, 1, `实得: ${JSON.stringify(result.red)}`);
  assert.match(changes[0].detail, /references/);
  assert.match(changes[0].detail, /notes\.md/);
});

test('classifyChanges: templates/ 一级条目增删同样 → red（四目录对称）', () => {
  const result = classifyAfterSingleChange((workspace) => {
    // 新增一个一级条目（而非删除既有文件）——目录仍在，仅条目集变化。
    writeFileSync(stagingFile(workspace, 'ppt-master', 'templates', 'extra.md'), '# extra template\n');
  });

  const changes = result.red.filter((change) => change.kind === 'top-level-entries');
  assert.equal(changes.length, 1, `实得: ${JSON.stringify(result.red)}`);
  assert.match(changes[0].detail, /templates/);
  assert.match(changes[0].detail, /extra\.md/);
});

test('classifyChanges: 二级目录内部文件内容变更不触发 top-level-entries（仅一级）', () => {
  const result = classifyAfterSingleChange((workspace) => {
    const nested = stagingFile(workspace, 'ppt-master', 'scripts', 'svg_quality', 'cli.py');
    requireExists(nested, 'staging scripts/svg_quality/cli.py');
    writeFileSync(nested, '# changed nested content\n');
  });

  assert.deepEqual(result.red.filter((change) => change.kind === 'top-level-entries'), []);
  assert.equal(result.vendorDiff, true);
  assert.equal(result.green, true);
});

// ─── classifyChanges：yellow 各族 ────────────────────────────────

test('classifyChanges: description 变更 → yellow(kind=description)', () => {
  const result = classifyAfterSingleChange((workspace) => {
    rewriteSkillLine(
      workspace,
      'ppt-master',
      /^description: >$/m,
      'description: Rewritten fixture description for the yellow description path.',
    );
  });

  const changes = result.yellow.filter((change) => change.kind === 'description');
  assert.equal(changes.length, 1, `实得: ${JSON.stringify(result.yellow)}`);
  assert.equal(result.vendorDiff, true);
});

test('classifyChanges: description 折叠标量正文改写（首行不变）也算显著变更 → yellow', () => {
  const result = classifyAfterSingleChange((workspace) => {
    // 首行 `description: >` 保持原样，只改折叠正文——只比首行会把此变更漏判。
    rewriteSkillLine(
      workspace,
      'ppt-master',
      /^  deliberately newer than vendor-tree so classifyChanges has controlled diffs\.$/m,
      '  rewritten folded body that keeps the block scalar header untouched.',
    );
  });

  const changes = result.yellow.filter((change) => change.kind === 'description');
  assert.equal(changes.length, 1, `实得: ${JSON.stringify(result.yellow)}`);
});

// ── description 提取的对偶断言：只取 description 自身的值 ──────────
//
// 上游真实形态是 `description: >`（折叠标量）。若提取时把**整个 frontmatter 块**
// 当作 description 的值，则任何其它 frontmatter 改动（版本 bump、name、license…）
// 都会连带改变该值，把规则① 的版本 bump 主路径误报成 🟡 description 变更。
// 下列用例是**对偶断言**（断 description-yellow 缺席）——只断「自家 kind 存在」
// 的用例永远抓不到这类幻影报警。

test('classifyChanges: 仅 metadata.version 行变更 → yellow 不含 description（消除版本 bump 幻影）', () => {
  const result = classifyAfterSingleChange((workspace) => {
    rewriteSkillLine(workspace, 'ppt-master', /^  version: ".*"$/m, '  version: "6.9.0"');
  });

  assert.deepEqual(
    result.yellow.filter((change) => change.kind === 'description'),
    [],
    '纯版本 bump 不得误报 description 变更（description 提取耦合了整个 frontmatter 块）',
  );
  // 版本行变更本身不属任何红/黄分类项（行 3 只判 staging 侧缺失/不可解析），
  // 但它是一次文件内容更新 → 落 🟢。
  assert.equal(result.green, true);
  assert.equal(result.vendorDiff, true);
});

test('classifyChanges: 仅 name 行变更 → yellow 不含 description（对偶断言）', () => {
  const result = classifyAfterSingleChange((workspace) => {
    rewriteSkillLine(workspace, 'ppt-master', /^name: ppt-master$/m, 'name: ppt-master-renamed');
  });

  assert.equal(result.red.some((change) => change.kind === 'name'), true);
  assert.deepEqual(
    result.yellow.filter((change) => change.kind === 'description'),
    [],
    'name 变更不得误报 description 变更',
  );
});

test('classifyChanges: 仅 license 行变更 → yellow 不含 description（对偶断言）', () => {
  const result = classifyAfterSingleChange((workspace) => {
    rewriteSkillLine(workspace, 'ppt-master', /^  license: "MIT"$/m, '  license: "Apache-2.0"');
  });

  assert.deepEqual(result.yellow.filter((change) => change.kind === 'description'), []);
  assert.equal(result.vendorDiff, true);
});

test('classifyChanges: description 单行标量形态变更 → yellow 仍在（非折叠形态同样检出）', () => {
  const result = classifyAfterSingleChange((workspace) => {
    rewriteSkillLine(
      workspace,
      'ppt-master',
      /^description: >[\s\S]*?(?=\nmetadata:)/m,
      'description: Single-line rewritten description for the plain scalar path.\n',
    );
  });

  const changes = result.yellow.filter((change) => change.kind === 'description');
  assert.equal(changes.length, 1, `实得: ${JSON.stringify(result.yellow)}`);
});

test('classifyChanges: version 与 description 同时变更 → description yellow 恰一条（不重复计数）', () => {
  const result = classifyAfterSingleChange((workspace) => {
    rewriteSkillLine(workspace, 'ppt-master', /^  version: ".*"$/m, '  version: "6.9.0"');
    rewriteSkillLine(
      workspace,
      'ppt-master',
      /^  deliberately newer than vendor-tree so classifyChanges has controlled diffs\.$/m,
      '  genuinely rewritten folded description body.',
    );
  });

  assert.equal(result.yellow.filter((change) => change.kind === 'description').length, 1);
});

test('classifyChanges: description 为最后一个键（块尾）时 —— 版本变更不幻影、自身变更仍检出', () => {
  // 构造一个 description 位于 frontmatter **末尾**（无后随键行）的 vendor/staging 对，
  // 覆盖取值规则「到块尾为止」分支。关键：两棵树的键序必须一致，否则键序变化本身
  // 就会改变取值形态，混入非受控差异。
  const skillText = (version, descriptionBody) => [
    '---',
    'name: ppt-master',
    'metadata:',
    `  version: "${version}"`,
    'description: >',
    descriptionBody,
    '---',
    '',
    '# body',
    '',
  ].join('\n');

  const workspace = makeWorkspace();
  try {
    stageInto(workspace); // staging 需先存在（本用例自行覆写两侧 SKILL.md）
    const vendorSkill = join(workspace.vendorSkills, 'ppt-master', 'SKILL.md');
    const stagedSkill = join(workspace.staging, 'ppt-master', 'SKILL.md');
    const BODY = '  tail-key folded description body, identical in both trees.';
    requireExists(vendorSkill, 'vendor ppt-master/SKILL.md');
    requireExists(stagedSkill, 'staging ppt-master/SKILL.md');

    // 两棵树同为「description 收尾」形态，仅版本不同。
    writeFileSync(vendorSkill, skillText('6.7.0', BODY));
    writeFileSync(stagedSkill, skillText('6.9.0', BODY));
    // 前置：两棵树的 description 取值形态一致（只有版本行不同）。
    assert.equal(readFileSync(vendorSkill, 'utf8').includes('description: >\n  tail-key'), true);

    const versionOnly = classifyChanges(workspace.vendorSkills, workspace.staging, workspace.upstream, workspace.auxStatePath);
    assert.deepEqual(
      versionOnly.yellow.filter((change) => change.kind === 'description'),
      [],
      '块尾形态下版本变更不得幻影报 description',
    );

    // 只改描述正文 → 必须检出。
    writeFileSync(stagedSkill, skillText('6.9.0', '  a genuinely different folded body for the tail-key path.'));
    const descChanged = classifyChanges(workspace.vendorSkills, workspace.staging, workspace.upstream, workspace.auxStatePath);
    assert.equal(
      descChanged.yellow.filter((change) => change.kind === 'description').length,
      1,
      `实得: ${JSON.stringify(descChanged.yellow)}`,
    );
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('classifyChanges: requirements.txt 依赖行增删 → yellow(kind=requirements)', () => {
  const result = classifyAfterSingleChange((workspace) => {
    const staged = stagingFile(workspace, 'ppt-master', 'requirements.txt');
    const current = readFileSync(staged, 'utf8');
    // 前置：新增行必须确实不在当前依赖集合里（重复行不构成「增删」）。
    assert.doesNotMatch(current, /^python-docx/m);
    writeFileSync(staged, `${current}python-docx>=1.1\n`);
  });

  const changes = result.yellow.filter((change) => change.kind === 'requirements');
  assert.equal(changes.length, 1, `实得: ${JSON.stringify(result.yellow)}`);
  assert.match(changes[0].detail, /python-docx/);
  assert.equal(result.vendorDiff, true);
});

test('classifyChanges: requirements.txt 删除依赖行 → yellow（对称方向）', () => {
  const result = classifyAfterSingleChange((workspace) => {
    const staged = stagingFile(workspace, 'ppt-master', 'requirements.txt');
    const current = readFileSync(staged, 'utf8');
    assert.match(current, /^PyYAML>=6\.0$/m);
    writeFileSync(staged, current.replace(/^PyYAML>=6\.0\n/m, ''));
  });

  const changes = result.yellow.filter((change) => change.kind === 'requirements');
  assert.equal(changes.length, 1, `实得: ${JSON.stringify(result.yellow)}`);
  assert.match(changes[0].detail, /PyYAML/);
});

test('classifyChanges: requirements.txt 重复同一依赖行 → 不算依赖增删（集合语义）', () => {
  const result = classifyAfterSingleChange((workspace) => {
    const staged = stagingFile(workspace, 'ppt-master', 'requirements.txt');
    const current = readFileSync(staged, 'utf8');
    const firstRequirement = current.split('\n').find((line) => REQUIREMENT_HEAD.test(line));
    assert.notEqual(firstRequirement, undefined);
    writeFileSync(staged, `${current}${firstRequirement.trim()}\n`);
  });

  assert.deepEqual(result.yellow.filter((change) => change.kind === 'requirements'), []);
});

test('classifyChanges: requirements.txt 仅注释变更 → 不产生 yellow（依赖行未变）', () => {
  const result = classifyAfterSingleChange((workspace) => {
    const staged = stagingFile(workspace, 'ppt-master', 'requirements.txt');
    const current = readFileSync(staged, 'utf8');
    writeFileSync(staged, current.replace(/^# upstream fixture requirements$/m, '# rewritten comment only'));
  });

  assert.deepEqual(result.yellow.filter((change) => change.kind === 'requirements'), []);
  // 文件内容确实变了 → 属常规内容变更，走 🟢。
  assert.equal(result.green, true);
  assert.equal(result.vendorDiff, true);
});

test('classifyChanges: skills/ 一级辅助目录（不含 SKILL.md）→ yellow(aux-dir) 且写入状态记录', () => {
  requireExists(
    join(upstreamTreeRoot, 'skills', '.claude-plugin', 'plugin.json'),
    'upstream skills/.claude-plugin/plugin.json',
  );

  const workspace = makeWorkspace();
  try {
    stageInto(workspace);

    // 首次分类：无状态记录 → 当前辅助目录全部视为新增（首灌语义）。
    const first = classifyChanges(workspace.vendorSkills, workspace.staging, workspace.upstream, workspace.auxStatePath);
    const firstAux = first.yellow.filter((change) => change.kind === 'aux-dir');
    assert.equal(firstAux.length, 1, `期望恰一条 aux-dir，实得: ${JSON.stringify(first.yellow)}`);
    assert.match(firstAux[0].detail, /\.claude-plugin/);

    // 状态记录必须已落盘（classifyChanges 负责写）。
    requireExists(workspace.auxStatePath, 'aux state file');
    assert.deepEqual(JSON.parse(readFileSync(workspace.auxStatePath, 'utf8')).auxDirs, ['.claude-plugin']);

    // 第二次分类：辅助目录未变 → 不再报告。
    const second = classifyChanges(workspace.vendorSkills, workspace.staging, workspace.upstream, workspace.auxStatePath);
    assert.deepEqual(second.yellow.filter((change) => change.kind === 'aux-dir'), []);

    // 上游新增第二个辅助目录 → 报告新增项。
    mkdirSync(join(workspace.upstream, 'skills', '.helper-tools'), { recursive: true });
    writeFileSync(join(workspace.upstream, 'skills', '.helper-tools', 'note.txt'), 'helper\n');
    const third = classifyChanges(workspace.vendorSkills, workspace.staging, workspace.upstream, workspace.auxStatePath);
    const thirdAux = third.yellow.filter((change) => change.kind === 'aux-dir');
    assert.equal(thirdAux.length, 1);
    assert.match(thirdAux[0].detail, /\.helper-tools/);
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});

// ─── classifyChanges：🟢 green 与 vendorDiff 语义分离 ────────────

test('classifyChanges: 仅 SKILL.md 正文变更 → green=true 且无 red/yellow', () => {
  const result = classifyAfterSingleChange((workspace) => {
    rewriteSkillLine(workspace, 'ppt-master', /^# Fixture PPT Master$/m, '# Fixture PPT Master (upstream body)');
  });

  assert.equal(result.green, true);
  assert.equal(result.vendorDiff, true);
  assert.deepEqual(result.red, []);
  assert.deepEqual(result.yellow, []);
});

test('classifyChanges: 仅 .env.example 常规文件变更 → green=true + vendorDiff=true（消除分类空白）', () => {
  const result = classifyAfterSingleChange((workspace) => {
    const dotfile = stagingFile(workspace, 'ppt-master', '.env.example');
    requireExists(dotfile, 'staging .env.example');
    const before = readFileSync(dotfile);
    writeFileSync(dotfile, '# upstream updated the tracked dotfile\nPPT_MASTER_FIXTURE_KEY=changed\n');
    assert.notDeepEqual(readFileSync(dotfile), before);
  });

  assert.equal(result.green, true, '.env.example 变更必须落 🟢 常规路径');
  assert.equal(result.vendorDiff, true);
  assert.deepEqual(result.red, []);
  assert.deepEqual(result.yellow, []);
});

test('classifyChanges: 新增隐藏文件（skill 根级）→ green=true（dotfile 在常规面内）', () => {
  const result = classifyAfterSingleChange((workspace) => {
    writeFileSync(stagingFile(workspace, 'ppt-master', '.new-dotfile'), 'created upstream\n');
  });

  assert.equal(result.green, true);
  assert.equal(result.vendorDiff, true);
  assert.deepEqual(result.red, []);
});

test('classifyChanges: 仅 LICENSE 内容变更 → green=true（🟢 常规同步）', () => {
  const result = classifyAfterSingleChange((workspace) => {
    const license = stagingFile(workspace, 'ppt-master', 'LICENSE');
    requireExists(license, 'staging LICENSE');
    writeFileSync(license, 'Fixture upstream LICENSE — updated upstream.\n');
  });

  assert.equal(result.green, true);
  assert.equal(result.vendorDiff, true);
  assert.deepEqual(result.red, []);
});

test('classifyChanges: vendor 与 staging 完全一致 → green=false、vendorDiff=false', () => {
  const workspace = makeWorkspace();
  try {
    neutralize(workspace);
    const result = classifyChanges(workspace.vendorSkills, workspace.staging, workspace.upstream, workspace.auxStatePath);

    assert.equal(result.green, false);
    assert.equal(result.vendorDiff, false);
    assert.deepEqual(result.red, []);
    assert.deepEqual(result.yellow, []);
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('classifyChanges: vendorDiff 含红类变更涉及的文件（name 变更 → 真）', () => {
  const result = classifyAfterSingleChange((workspace) => {
    rewriteSkillLine(workspace, 'ppt-master', /^name: ppt-master$/m, 'name: ppt-master-v2');
  });

  assert.equal(result.red.length >= 1, true);
  assert.equal(result.vendorDiff, true, 'vendorDiff 语义 = 任何字节差异，含红类涉及文件');
});

test('classifyChanges: 红类变更（top-level-entries）也置 vendorDiff=true', () => {
  const result = classifyAfterSingleChange((workspace) => {
    writeFileSync(stagingFile(workspace, 'ppt-master', 'workflows', 'new-routing.md'), '# new\n');
  });

  assert.equal(result.red.some((change) => change.kind === 'top-level-entries'), true);
  assert.equal(result.vendorDiff, true);
});

test('classifyChanges: vendorDiff 含黄类变更涉及的文件（description → 真）', () => {
  const result = classifyAfterSingleChange((workspace) => {
    rewriteSkillLine(workspace, 'ppt-master', /^description: >$/m, 'description: shorter yellow-path description.');
  });

  assert.equal(result.yellow.some((change) => change.kind === 'description'), true);
  assert.equal(result.vendorDiff, true);
});

test('classifyChanges: green 与 vendorDiff 语义分离（结构项单独变化时 green=false）', () => {
  // 分类是多标签报告：green 只看「有没有常规内容变更」，vendorDiff 看「有没有任何
  // 字节差异」。把两者彻底分开的判别用例 = 只发生**结构类**变更（不触碰任何常规
  // 文件内容）：新 skill 目录只贡献 vendorDiff，不贡献 green。
  const workspace = makeWorkspace();
  try {
    neutralize(workspace);

    // 上游新增一个 skill 目录（结构项），不触碰既有 skill 的任何文件内容。
    const added = join(workspace.staging, 'brand-new-skill');
    mkdirSync(added, { recursive: true });
    writeFileSync(join(added, 'SKILL.md'), '---\nname: brand-new-skill\ndescription: new upstream skill\nmetadata:\n  version: "1.0.0"\n---\n\n# New\n');

    const result = classifyChanges(
      workspace.vendorSkills,
      workspace.staging,
      workspace.upstream,
      workspace.auxStatePath,
    );

    assert.equal(result.red.some((change) => change.kind === 'skill-dir'), true);
    assert.equal(result.vendorDiff, true, '结构项也是字节差异 → vendorDiff 真');
    assert.equal(result.green, false, 'green 只统计常规文件内容更新（结构项不计入）');
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('classifyChanges: 红类与 🟢 可同时为真（SKILL.md 改动既是 name 红项也是内容更新）', () => {
  // spec §4.2 末行无条件覆盖「其余文件内容常规更新」——SKILL.md 的改动同时也是一次
  // 内容更新，故 green 与红项并存（分类是多标签报告，不是互斥开关）。
  const result = classifyAfterSingleChange((workspace) => {
    rewriteSkillLine(workspace, 'ppt-master', /^name: ppt-master$/m, 'name: ppt-master-both');
  });

  assert.equal(result.red.some((change) => change.kind === 'name'), true);
  assert.equal(result.green, true);
  assert.equal(result.vendorDiff, true);
});

test('classifyChanges: Change 形状 = { kind, detail } 字符串对', () => {
  const workspace = makeWorkspace();
  try {
    stageInto(workspace);
    const result = classifyChanges(workspace.vendorSkills, workspace.staging, workspace.upstream, workspace.auxStatePath);

    assert.equal(result.red.length + result.yellow.length > 0, true, '基线 fixture 应产出分类项');
    for (const change of [...result.red, ...result.yellow]) {
      assert.equal(typeof change.kind, 'string');
      assert.equal(typeof change.detail, 'string');
      assert.notEqual(change.detail, '');
    }
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('classifyChanges: 基线 fixture 上 red 含 skill-dir 与 top-level-entries（受控差异）', () => {
  const workspace = makeWorkspace();
  try {
    stageInto(workspace);
    const result = classifyChanges(workspace.vendorSkills, workspace.staging, workspace.upstream, workspace.auxStatePath);
    const kinds = kindsOf(result.red);

    assert.equal(kinds.includes('skill-dir'), true, `实得: ${JSON.stringify(result.red)}`);
    assert.equal(kinds.includes('top-level-entries'), true, `实得: ${JSON.stringify(result.red)}`);
    assert.equal(result.green, true);
    assert.equal(result.vendorDiff, true);
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});

// ─── checkMarketplaceVersion ─────────────────────────────────────

test('checkMarketplaceVersion: 与 skillVersion 一致 → ok:true', () => {
  requireExists(
    join(upstreamTreeRoot, '.claude-plugin', 'marketplace.json'),
    'upstream .claude-plugin/marketplace.json',
  );
  const marketplace = JSON.parse(readFileSync(join(upstreamTreeRoot, '.claude-plugin', 'marketplace.json'), 'utf8'));
  // 前置：fixture 确实声明了 version（否则「一致」用例是空断言）。
  assert.equal(marketplace.version, '6.8.0');

  const result = checkMarketplaceVersion(upstreamTreeRoot, '6.8.0');

  assert.equal(result.ok, true);
  assert.equal(typeof result.note, 'string');
});

test('checkMarketplaceVersion: 与 skillVersion 不一致 → ok:false 且 note 指明双方取值', () => {
  requireExists(
    join(upstreamTreeRoot, '.claude-plugin', 'marketplace.json'),
    'upstream .claude-plugin/marketplace.json',
  );

  const result = checkMarketplaceVersion(upstreamTreeRoot, '6.7.0');

  assert.equal(result.ok, false);
  assert.match(result.note, /6\.8\.0/);
  assert.match(result.note, /6\.7\.0/);
});

test('checkMarketplaceVersion: marketplace.json 缺失 → 豁免（ok:true + 警告 note）', () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-marketplace-'));
  try {
    // 前置：确认真的是「文件缺失」而非 fixture 路径写错。
    assert.equal(existsSync(join(root, '.claude-plugin', 'marketplace.json')), false);

    const result = checkMarketplaceVersion(root, '6.8.0');

    assert.equal(result.ok, true);
    assert.match(result.note, /豁免/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkMarketplaceVersion: marketplace.json 无 version 字段 → 豁免（ok:true + 警告 note）', () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-marketplace-'));
  try {
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(root, '.claude-plugin', 'marketplace.json'),
      `${JSON.stringify({ name: 'ppt-master', plugins: [] }, null, 2)}\n`,
    );
    requireExists(join(root, '.claude-plugin', 'marketplace.json'), 'constructed marketplace.json');

    const result = checkMarketplaceVersion(root, '6.8.0');

    assert.equal(result.ok, true);
    assert.match(result.note, /豁免/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── metadata.version 层级（真实上游 v6.7.0 起的 marketplace.json 形态）──
// UltraReview Fix #6：真实 marketplace.json 的 version 位于 metadata.version
// 层级，此前只读顶层 parsed.version——真实树上恒判「无 version 字段（豁免）」，
// 该子校验从未生效。修复后 metadata.version 优先，顶层 version 向后兼容。

/** 构造指定形态的 marketplace.json fixture 并返回其根目录。 */
function marketplaceRoot(payload) {
  const root = mkdtempSync(join(tmpdir(), 'sync-marketplace-'));
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), `${JSON.stringify(payload, null, 2)}\n`);
  return root;
}

test('checkMarketplaceVersion: metadata.version 层级与 skillVersion 不一致 → ok:false（不再豁免）', () => {
  const root = marketplaceRoot({ name: 'ppt-master', metadata: { description: 'd', version: '6.8.0' }, plugins: [] });
  try {
    const result = checkMarketplaceVersion(root, '6.7.0');
    assert.equal(result.ok, false, 'metadata.version 有值且不一致 → 必须报不一致，不得豁免');
    assert.match(result.note, /6\.8\.0/);
    assert.match(result.note, /6\.7\.0/);
    assert.doesNotMatch(result.note, /豁免/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkMarketplaceVersion: metadata.version 一致 → ok:true 且无豁免 note', () => {
  const root = marketplaceRoot({ name: 'ppt-master', metadata: { version: '6.7.0' }, plugins: [] });
  try {
    const result = checkMarketplaceVersion(root, '6.7.0');
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.note, /豁免/, '版本字段可得时不得输出豁免 note');
    assert.match(result.note, /6\.7\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkMarketplaceVersion: 两层级并存 → metadata.version 优先于顶层 version', () => {
  const root = marketplaceRoot({ name: 'ppt-master', version: '6.6.0', metadata: { version: '6.8.0' }, plugins: [] });
  try {
    // metadata.version=6.8.0 与 skillVersion 6.8.0 一致；若误读顶层 6.6.0 会误报不一致。
    const result = checkMarketplaceVersion(root, '6.8.0');
    assert.equal(result.ok, true, '并存时必须以 metadata.version 为准');
    assert.match(result.note, /6\.8\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkMarketplaceVersion: 顶层 version（旧 fixture 形态）向后兼容照旧 ok', () => {
  // 旧形态（顶层 version）不因修复回归——upstream-tree fixture 即此形态，
  // 与 fixture 版本一致 → ok:true。
  const result = checkMarketplaceVersion(upstreamTreeRoot, '6.8.0');
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.note, /豁免/);
});

test('checkMarketplaceVersion: 读取上游仓库根路径，而非 skills/.claude-plugin/plugin.json', () => {
  // 钉子：两个路径不同——skills/.claude-plugin/plugin.json 是 staging 丢弃对象，
  // 其 version（0.1.0）不得被当作 marketplace 数据源。
  requireExists(
    join(upstreamTreeRoot, 'skills', '.claude-plugin', 'plugin.json'),
    'upstream skills/.claude-plugin/plugin.json',
  );
  const plugin = JSON.parse(readFileSync(join(upstreamTreeRoot, 'skills', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plugin.version, '0.1.0');

  const result = checkMarketplaceVersion(upstreamTreeRoot, '0.1.0');

  assert.equal(result.ok, false, '误取 plugin.json 的 version 会在此误判为一致');
});
