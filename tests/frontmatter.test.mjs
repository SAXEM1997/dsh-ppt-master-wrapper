import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFrontmatter, parseSimpleYaml } from '../lib/skill-provider.js';

/**
 * 上游 v6.7.0 skills/ppt-master/SKILL.md frontmatter 的真实形态（内容自造）：
 * 折叠 `description: >`、嵌套 `metadata:`（含字符串标量）、嵌套 `sponsors:` 数组。
 */
const REAL_SHAPE = [
  '---',
  'name: ppt-master',
  'description: >',
  '  AI-driven presentation workflow for generating editable PPTX decks,',
  '  reconstructing page visuals, and filling native PPTX templates.',
  '  Use when the user asks to create a presentation or mentions ppt-master.',
  'metadata:',
  '  version: "6.7.0"',
  '  copyright: "Copyright (c) 2025-2026 Hugo He"',
  '  license: "MIT"',
  '  official_repository: "https://github.com/hugohe3/ppt-master"',
  '  sponsors:',
  '    - "SPONSORS.md"',
  '    - "SPONSORS_CN.md"',
  '---',
  '',
  '# PPT Master Skill',
  '',
  'Body line one.',
  '',
].join('\n');

test('parseFrontmatter: 上游真实形态（嵌套 metadata + sponsors 数组 + 折叠 description）', () => {
  const parsed = parseFrontmatter(REAL_SHAPE);
  assert.ok(parsed, '应解析出 frontmatter');
  assert.equal(parsed.data.name, 'ppt-master');
  assert.equal(
    parsed.data.description,
    'AI-driven presentation workflow for generating editable PPTX decks, '
      + 'reconstructing page visuals, and filling native PPTX templates. '
      + 'Use when the user asks to create a presentation or mentions ppt-master.',
  );
  assert.equal(parsed.data.description.includes('\n'), false, '折叠标量不得保留换行');
  assert.deepEqual(parsed.data.metadata, {
    version: '6.7.0',
    copyright: 'Copyright (c) 2025-2026 Hugo He',
    license: 'MIT',
    official_repository: 'https://github.com/hugohe3/ppt-master',
    sponsors: ['SPONSORS.md', 'SPONSORS_CN.md'],
  });
  assert.deepEqual(parsed.data.metadata.sponsors, ['SPONSORS.md', 'SPONSORS_CN.md']);
  assert.equal(parsed.body, '\n# PPT Master Skill\n\nBody line one.\n');
});

test('parseSimpleYaml: 顶层数组 `- item`', () => {
  const data = parseSimpleYaml(['sponsors:', '  - "SPONSORS.md"', '  - SPONSORS_CN.md'].join('\n'));
  assert.deepEqual(data, { sponsors: ['SPONSORS.md', 'SPONSORS_CN.md'] });
});

test('parseSimpleYaml: `>` 折叠标量跨多行连接为单行', () => {
  const data = parseSimpleYaml(['description: >', '  first line', '  second line', '  third line'].join('\n'));
  assert.deepEqual(data, { description: 'first line second line third line' });
});

test('parseSimpleYaml: `|` 字面标量保留换行', () => {
  const data = parseSimpleYaml(['notes: |', '  first line', '  second line'].join('\n'));
  assert.equal(data.notes, 'first line\nsecond line');
});

test('parseSimpleYaml: 引号值剥离（单引号与双引号）', () => {
  const data = parseSimpleYaml([
    "single: 'quoted value'",
    'double: "quoted value"',
    'bare: unquoted value',
  ].join('\n'));
  assert.deepEqual(data, {
    single: 'quoted value',
    double: 'quoted value',
    bare: 'unquoted value',
  });
});

test('parseSimpleYaml: 空值与块后未缩进行回退为 null', () => {
  const data = parseSimpleYaml(['empty:', 'next: value'].join('\n'));
  assert.deepEqual(data, { empty: null, next: 'value' });
});

test('parseSimpleYaml: 注释与空行被跳过', () => {
  const data = parseSimpleYaml(['# leading comment', '', 'name: alpha', '', '# inner comment'].join('\n'));
  assert.deepEqual(data, { name: 'alpha' });
});

test('parseFrontmatter: 无 frontmatter → null（归一化，非 undefined）', () => {
  const parsed = parseFrontmatter('# Just a heading\n\nNo frontmatter here.\n');
  assert.equal(parsed, null);
});

test('parseFrontmatter: 空文档 → null', () => {
  assert.equal(parseFrontmatter(''), null);
});

test('parseFrontmatter: 未闭合 frontmatter → null', () => {
  const raw = ['---', 'name: broken', 'description: never closed', '', '# body'].join('\n');
  assert.equal(parseFrontmatter(raw), null);
});

test('parseFrontmatter: `---` 不在首行 → null', () => {
  const raw = ['', '---', 'name: late', '---', ''].join('\n');
  assert.equal(parseFrontmatter(raw), null);
});

test('parseFrontmatter: CRLF 文档 —— data 与 LF 等价、body 保留 `\\r\\n` 字节', () => {
  const raw = ['---', 'name: crlf', '---', '# body', 'second line', ''].join('\r\n');
  const parsed = parseFrontmatter(raw);
  assert.ok(parsed);
  assert.deepEqual(parsed.data, { name: 'crlf' }, 'YAML 数据在 CRLF 下应与 LF 解析等价');
  assert.equal(parsed.body, '# body\r\nsecond line\r\n', 'body 必须保留原始 CRLF 行尾');
  assert.equal(parsed.body.includes('\r'), true, 'body 不得把 CRLF 归一为 LF');
  // body 是原文切片：前缀 + body 必须重建整个文档
  const closing = raw.indexOf('---\r\n', 4) + '---\r\n'.length;
  assert.equal(parsed.body, raw.slice(closing), 'body 应为 raw 的原样切片');
});

test('parseFrontmatter: CRLF 下缺失结尾换行时 body 同样保真', () => {
  const raw = '---\r\nname: crlf\r\n---\r\n# body';
  const parsed = parseFrontmatter(raw);
  assert.equal(parsed.body, '# body');
});

test('parseSimpleYaml: CRLF 输入与 LF 输入解析结果一致', () => {
  const lf = parseSimpleYaml(['name: a', 'metadata:', '  version: "1.0"'].join('\n'));
  const crlf = parseSimpleYaml(['name: a', 'metadata:', '  version: "1.0"'].join('\r\n'));
  assert.deepEqual(crlf, lf);
  assert.deepEqual(crlf, { name: 'a', metadata: { version: '1.0' } });
});

test('parseFrontmatter: 空 frontmatter 块 → data {} 且 body 为剩余正文', () => {
  const parsed = parseFrontmatter(['---', '---', '# body', ''].join('\n'));
  assert.deepEqual(parsed, { data: {}, body: '# body\n' });
});

test('parseFrontmatter: body 保留原文（含结尾换行与无结尾换行两种）', () => {
  const withNewline = parseFrontmatter(['---', 'name: a', '---', 'body', ''].join('\n'));
  assert.equal(withNewline.body, 'body\n');
  const withoutNewline = parseFrontmatter(['---', 'name: a', '---', 'body'].join('\n'));
  assert.equal(withoutNewline.body, 'body');
});

test('parseFrontmatter: 闭合分隔符后无正文 → body 为空串', () => {
  assert.deepEqual(parseFrontmatter(['---', 'name: a', '---'].join('\n')), {
    data: { name: 'a' },
    body: '',
  });
});

test('parseSimpleYaml: 折叠标量内空行折叠为空格，字面标量内空行保留', () => {
  const folded = parseSimpleYaml(['d: >', '  a', '', '  b'].join('\n'));
  assert.deepEqual(folded, { d: 'a b' });
  const literal = parseSimpleYaml(['d: |', '  a', '', '  b'].join('\n'));
  assert.deepEqual(literal, { d: 'a\n\nb' });
});
