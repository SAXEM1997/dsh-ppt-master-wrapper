import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideVersion, parseRSuffix } from '../scripts/sync-upstream.mjs';

/**
 * Task 12 契约：sync 版本规则（`decideVersion` 纯函数 + `parseRSuffix` 解析助手）。
 *
 * 权威判据 = spec §4.3（优先级**互斥判定**，自上而下命中即止）+ brief Interfaces：
 *
 * | rule | 触发 | 结论 |
 * |---|---|---|
 * | ① | `upstreamVersion` 的 base ≠ `current` 的 base（上游版本变化） | `version = 上游版本`、`-r` 归零 |
 * | ④ | 同①但 `vendorDiff=false`（新 tag 仅改未 vendor 的 docs） | **版本结论与①相同**，仅 `rule` 标 `④`（镜像语义补充分支） |
 * | ② | 上游版本未变 + `vendorDiff=true` | base 不变、`n+1` |
 * | ③ | 上游版本未变 + `vendorDiff=false` + `wrapperPending=true` | base 不变、`n+1`（纯包装层变更） |
 * | no-change | 上游版本未变 + 两者皆 false（docs-only） | `version=current`、`notes=[]`——**不落③** |
 *
 * 覆盖钉子——
 * - **五分支五枚举值**：①④②③/no-change 每个枚举值至少一条用例直接断言。
 * - **互斥命中即止**：① 吸收同版本 diff 与包装层变更——`upstreamVersion` 变化时
 *   `vendorDiff`/`wrapperPending` **不再另追加 `-r`**（专项对偶断言：同上游版本
 *   变化下三个 flag 组合的 `version` 完全一致）。
 * - **归零 note 仅在 current 的 N>0 时出现**，且 N 值取自 `parseRSuffix(current).n`
 *   （对偶缺席断言：`current` 无后缀时不出现归零 note）。
 * - **非法 `-r` 后缀 fail-soft**：非 `^-r\d+$` 后缀（`6.7.0-r` / `6.7.0-rx`）**不剥离**
 *   ——整串作 base、`n=0`（不 throw）。版本格式校验归 T13 编排入口。
 * - **`upstreamVersion=null`**（§4.2 行 3 🔴 前置拦截前的纯函数自洽）→ no-change、不 throw。
 * - 「上游版本变化」判据是**字符串不等**（`parseRSuffix(current).base !== upstreamVersion`），
 *   不做 semver 大小比较——**回滚到旧版本同样是版本变化**（专项回归用例）。
 *
 * 纯函数：零网络、零文件系统、零 npm 依赖；用例之间无共享可变状态。
 */

/** `decideVersion` 的输入构造器——只列出本用例关心的字段，其余取常规缺省。 */
function input(overrides = {}) {
  return {
    current: '6.7.0',
    upstreamVersion: '6.7.0',
    vendorDiff: false,
    wrapperPending: false,
    ...overrides,
  };
}

/** 断言结果对象形态（三键齐全 + 类型正确）——防「少键/多键」契约漂移。 */
function assertShape(result) {
  assert.deepEqual(
    Object.keys(result).sort(),
    ['notes', 'rule', 'version'],
    'decideVersion 返回对象必须恰为 { version, rule, notes }',
  );
  assert.equal(typeof result.version, 'string');
  assert.equal(typeof result.rule, 'string');
  assert.equal(Array.isArray(result.notes), true);
}

// ─── parseRSuffix ────────────────────────────────────────────────

test('parseRSuffix: 无后缀 → n=0，整串作 base', () => {
  assert.deepEqual(parseRSuffix('6.7.0'), { base: '6.7.0', n: 0 });
});

test('parseRSuffix: 合法 -rN → 剥离后缀取 N（r1 / r2 / r3）', () => {
  assert.deepEqual(parseRSuffix('6.7.0-r1'), { base: '6.7.0', n: 1 });
  assert.deepEqual(parseRSuffix('6.7.0-r2'), { base: '6.7.0', n: 2 });
  assert.deepEqual(parseRSuffix('6.7.0-r3'), { base: '6.7.0', n: 3 });
});

test('parseRSuffix: 合法 -r0 与多位 N 同样剥离', () => {
  assert.deepEqual(parseRSuffix('6.7.0-r0'), { base: '6.7.0', n: 0 });
  assert.deepEqual(parseRSuffix('6.7.0-r12'), { base: '6.7.0', n: 12 });
});

test('parseRSuffix: 非法后缀形态 fail-soft——不剥离，整串作 base、n=0、不 throw', () => {
  // 钉子：非 `^-r\d+$` 后缀一律不剥离（`-r` 无数字、`-rx` 非数字、`-r1x` 尾随、
  // `-R1` 大写、`- r1` 带空格）——整个串作 base、n=0，绝不 throw。
  const cases = ['6.7.0-r', '6.7.0-rx', '6.7.0-r1x', '6.7.0-R1', '6.7.0- r1', '6.7.0-r-1'];
  for (const value of cases) {
    assert.deepEqual(parseRSuffix(value), { base: value, n: 0 }, `非法后缀必须整串作 base: ${value}`);
  }
});

test('parseRSuffix: 非 semver 串不 throw（原样作 base）', () => {
  // 版本格式合法性由 T13 编排入口校验；本助手是 fail-soft 解析器。
  assert.deepEqual(parseRSuffix('not-a-version'), { base: 'not-a-version', n: 0 });
  assert.deepEqual(parseRSuffix('v6.7.0'), { base: 'v6.7.0', n: 0 });
});

// ─── decideVersion：五分支五枚举值 ───────────────────────────────

test('decideVersion ①: 上游版本变化（有 vendorDiff）→ version=上游版本、rule=①', () => {
  const result = decideVersion(input({
    current: '6.7.0',
    upstreamVersion: '6.8.0',
    vendorDiff: true,
    wrapperPending: false,
  }));

  assertShape(result);
  assert.equal(result.rule, '①');
  assert.equal(result.version, '6.8.0');
  assert.deepEqual(result.notes, [], 'current 无 r 后缀 → 不出现归零 note');
});

test('decideVersion ④: 上游版本变化 + vendorDiff=false → rule=④、version 与①相同', () => {
  const onlyDocs = decideVersion(input({
    current: '6.7.0',
    upstreamVersion: '6.8.0',
    vendorDiff: false,
    wrapperPending: false,
  }));

  assertShape(onlyDocs);
  assert.equal(onlyDocs.rule, '④', 'docs-only 新 tag 落 ④（不落 no-change）');
  assert.equal(onlyDocs.version, '6.8.0');

  // 钉子：④ 与 ① 的**版本结论相同**，区分仅在 vendorDiff / rule 标记。
  const withDiff = decideVersion(input({
    current: '6.7.0',
    upstreamVersion: '6.8.0',
    vendorDiff: true,
    wrapperPending: false,
  }));
  assert.equal(onlyDocs.version, withDiff.version);
  assert.notEqual(onlyDocs.rule, withDiff.rule);
});

test('decideVersion ②: 上游版本未变 + vendorDiff → base 不变、n+1', () => {
  const first = decideVersion(input({
    current: '6.7.0',
    upstreamVersion: '6.7.0',
    vendorDiff: true,
    wrapperPending: false,
  }));

  assertShape(first);
  assert.equal(first.rule, '②');
  assert.equal(first.version, '6.7.0-r1', '无后缀视为 r0 → 新后缀 r1');
  assert.deepEqual(first.notes, []);
});

test('decideVersion ③: 上游版本未变 + 仅包装层变更（vendorDiff=false、wrapperPending=true）→ n+1', () => {
  const result = decideVersion(input({
    current: '6.7.0',
    upstreamVersion: '6.7.0',
    vendorDiff: false,
    wrapperPending: true,
  }));

  assertShape(result);
  assert.equal(result.rule, '③');
  assert.equal(result.version, '6.7.0-r1');
  assert.deepEqual(result.notes, []);
});

test('decideVersion no-change: 上游版本未变 + 两者皆无（docs-only）→ 不落③、notes 空', () => {
  const result = decideVersion(input({
    current: '6.7.0',
    upstreamVersion: '6.7.0',
    vendorDiff: false,
    wrapperPending: false,
  }));

  assertShape(result);
  assert.equal(result.rule, 'no-change');
  assert.equal(result.version, '6.7.0', 'version=current 原样');
  assert.deepEqual(result.notes, []);

  // 对偶：同样「上游版本未变、无 diff」，wrapperPending=true 时**必须**落③——
  // 锁定 no-change 不是「wrapperPending 被忽略」造成的假绿。
  const pending = decideVersion(input({
    current: '6.7.0',
    upstreamVersion: '6.7.0',
    vendorDiff: false,
    wrapperPending: true,
  }));
  assert.equal(pending.rule, '③');
});

// ─── 边界组合（brief Step 1 全集）─────────────────────────────────

test('边界: current=6.7.0-r3、上游升 6.8.0 → 6.8.0 + 归零 note（N=3）', () => {
  const result = decideVersion(input({
    current: '6.7.0-r3',
    upstreamVersion: '6.8.0',
    vendorDiff: true,
    wrapperPending: false,
  }));

  assert.equal(result.rule, '①');
  assert.equal(result.version, '6.8.0', '-r 后缀归零');
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /包装层此前有 3 次修订已被归零/);
});

test('边界: 归零 note 的 N 取自 current 的 rN（r1 / r12），且不误报上游版本号', () => {
  const r1 = decideVersion(input({ current: '6.7.0-r1', upstreamVersion: '6.8.0', vendorDiff: true }));
  assert.equal(r1.version, '6.8.0');
  assert.equal(r1.notes.length, 1);
  assert.match(r1.notes[0], /包装层此前有 1 次修订已被归零/);

  const r12 = decideVersion(input({ current: '6.7.0-r12', upstreamVersion: '6.8.0', vendorDiff: false }));
  assert.equal(r12.rule, '④', '归零 note 与 ①/④ 分支无关：上游版本变 + 无 diff 仍归零');
  assert.equal(r12.version, '6.8.0');
  assert.match(r12.notes[0], /包装层此前有 12 次修订已被归零/);
  assert.doesNotMatch(r12.notes[0], /6\.8\.0/, 'note 不得混入上游版本号（N 必须是 rN）');
});

test('边界: current=6.7.0、同版本 tag 重推 diff → 6.7.0-r1；再重推 → 6.7.0-r2', () => {
  const first = decideVersion(input({ current: '6.7.0', upstreamVersion: '6.7.0', vendorDiff: true }));
  assert.equal(first.version, '6.7.0-r1');

  // 第二轮以第一轮产物为 current（同版本 tag 再次重推）。
  const second = decideVersion(input({ current: first.version, upstreamVersion: '6.7.0', vendorDiff: true }));
  assert.equal(second.rule, '②');
  assert.equal(second.version, '6.7.0-r2');
  assert.deepEqual(second.notes, [], '同版本递增不是归零，不得出现归零 note');

  // 第三轮：连续递增不丢历史基数。
  const third = decideVersion(input({ current: second.version, upstreamVersion: '6.7.0', vendorDiff: true }));
  assert.equal(third.version, '6.7.0-r3');
});

test('边界: 纯③（仅 wrapperPending=true）→ 6.7.0 → 6.7.0-r1；且可自续接', () => {
  const first = decideVersion(input({
    current: '6.7.0',
    upstreamVersion: '6.7.0',
    vendorDiff: false,
    wrapperPending: true,
  }));
  assert.equal(first.rule, '③');
  assert.equal(first.version, '6.7.0-r1');

  const second = decideVersion(input({
    current: first.version,
    upstreamVersion: '6.7.0',
    vendorDiff: false,
    wrapperPending: true,
  }));
  assert.equal(second.rule, '③');
  assert.equal(second.version, '6.7.0-r2', 'spec §4.3 规则 3 原文：6.7.0-r1 → 6.7.0-r2');
});

test('边界: 纯④（上游版本变 + vendorDiff=false）→ rule=④、version=6.8.0、无归零 note（current 无后缀）', () => {
  const result = decideVersion(input({
    current: '6.7.0',
    upstreamVersion: '6.8.0',
    vendorDiff: false,
    wrapperPending: false,
  }));

  assert.equal(result.rule, '④');
  assert.equal(result.version, '6.8.0');
  assert.deepEqual(result.notes, []);
});

test('边界: ②③同时命中按②（同一 -r 递增覆盖两类变更，恰一次递增）', () => {
  const both = decideVersion(input({
    current: '6.7.0',
    upstreamVersion: '6.7.0',
    vendorDiff: true,
    wrapperPending: true,
  }));

  assert.equal(both.rule, '②');
  assert.equal(both.version, '6.7.0-r1', '恰一次递增——不得出现 -r2 或被跳过');

  const bothFromR1 = decideVersion(input({
    current: '6.7.0-r1',
    upstreamVersion: '6.7.0',
    vendorDiff: true,
    wrapperPending: true,
  }));
  assert.equal(bothFromR1.rule, '②');
  assert.equal(bothFromR1.version, '6.7.0-r2');
});

test('边界: upstreamVersion=null → no-change、不 throw', () => {
  // 理论上由 §4.2 行 3 🔴（metadata.version 缺失/不可解析）在编排层前置拦截；
  // 纯函数契约仍需自洽：不 throw、按「无上游版本可比」处置。
  const cases = [
    input({ current: '6.7.0', upstreamVersion: null, vendorDiff: false, wrapperPending: false }),
    input({ current: '6.7.0', upstreamVersion: null, vendorDiff: true, wrapperPending: false }),
    input({ current: '6.7.0-r2', upstreamVersion: null, vendorDiff: false, wrapperPending: true }),
  ];

  for (const value of cases) {
    let result;
    assert.doesNotThrow(() => {
      result = decideVersion(value);
    }, `upstreamVersion=null 不得 throw: ${JSON.stringify(value)}`);
    assertShape(result);
    assert.equal(result.rule, 'no-change');
    assert.equal(result.version, value.current, '无上游版本可比 → 保持 current 原样（不误判为版本变化、不误 bump）');
    assert.deepEqual(result.notes, []);
  }
});

// ─── 互斥 / 命中即止 ─────────────────────────────────────────────

test('互斥: 上游版本变化时吸收同版本 diff 与包装层变更（① 吸收其余两条 + 归零 note 保持）', () => {
  const base = { current: '6.7.0-r2', upstreamVersion: '6.8.0' };
  const combos = [
    { vendorDiff: false, wrapperPending: false, rule: '④' },
    { vendorDiff: true, wrapperPending: false, rule: '①' },
    { vendorDiff: false, wrapperPending: true, rule: '④' },
    { vendorDiff: true, wrapperPending: true, rule: '①' },
  ];

  for (const combo of combos) {
    const result = decideVersion(input({ ...base, vendorDiff: combo.vendorDiff, wrapperPending: combo.wrapperPending }));
    assert.equal(result.rule, combo.rule, `rule 仅由 vendorDiff 决定: ${JSON.stringify(combo)}`);
    assert.equal(result.version, '6.8.0', '①/④ 一律取上游版本、r 归零——vendorDiff/wrapperPending 不另追加 -r');
    assert.match(result.notes[0] ?? '', /包装层此前有 2 次修订已被归零/);
    assert.equal(result.notes.length, 1, '归零 note 恰一条（不重复/不丢失）');
  }
});

test('互斥: 上游版本变化下 ①/④ 的 version 恒等（区分仅在 rule 标记与门语义）', () => {
  const withDiff = decideVersion(input({ current: '6.7.0', upstreamVersion: '6.9.0', vendorDiff: true, wrapperPending: true }));
  const docsOnly = decideVersion(input({ current: '6.7.0', upstreamVersion: '6.9.0', vendorDiff: false, wrapperPending: true }));

  assert.equal(withDiff.version, docsOnly.version);
  assert.equal(withDiff.rule, '①');
  assert.equal(docsOnly.rule, '④');
  assert.deepEqual(withDiff.notes, docsOnly.notes);
});

test('互斥: 上游版本未变时 rule 只由 vendorDiff/wrapperPending 决定（② 覆盖 ③，二者不叠加）', () => {
  const matrix = [
    { vendorDiff: false, wrapperPending: false, rule: 'no-change', version: '6.7.0-r1' },
    { vendorDiff: true, wrapperPending: false, rule: '②', version: '6.7.0-r2' },
    { vendorDiff: false, wrapperPending: true, rule: '③', version: '6.7.0-r2' },
    { vendorDiff: true, wrapperPending: true, rule: '②', version: '6.7.0-r2' },
  ];

  for (const row of matrix) {
    const result = decideVersion(input({
      current: '6.7.0-r1',
      upstreamVersion: '6.7.0',
      vendorDiff: row.vendorDiff,
      wrapperPending: row.wrapperPending,
    }));
    assert.equal(result.rule, row.rule, `rule 判定: ${JSON.stringify(row)}`);
    assert.equal(result.version, row.version, `version 判定: ${JSON.stringify(row)}`);
  }
});

test('互斥: 五个枚举值全部可达（防「某分支被上游分支吞掉」）', () => {
  const rules = new Set([
    decideVersion(input({ current: '6.7.0', upstreamVersion: '6.8.0', vendorDiff: true })).rule,
    decideVersion(input({ current: '6.7.0', upstreamVersion: '6.8.0', vendorDiff: false })).rule,
    decideVersion(input({ current: '6.7.0', upstreamVersion: '6.7.0', vendorDiff: true })).rule,
    decideVersion(input({ current: '6.7.0', upstreamVersion: '6.7.0', vendorDiff: false, wrapperPending: true })).rule,
    decideVersion(input({ current: '6.7.0', upstreamVersion: '6.7.0', vendorDiff: false, wrapperPending: false })).rule,
  ]);

  assert.deepEqual([...rules].sort(), ['no-change', '①', '②', '③', '④'].sort());
});

// ─── 判据：字符串不等（非 semver 大小）───────────────────────────

test('判据: 回滚到旧版本同样是「上游版本变化」→ 取上游版本、r 归零（不做大小比较）', () => {
  const rollback = decideVersion(input({
    current: '6.8.0-r1',
    upstreamVersion: '6.7.0',
    vendorDiff: true,
    wrapperPending: false,
  }));

  assert.equal(rollback.rule, '①');
  assert.equal(rollback.version, '6.7.0', '降版本也镜像上游（若做大小比较会误判为 no-change）');
  assert.match(rollback.notes[0] ?? '', /包装层此前有 1 次修订已被归零/);

  // 对偶：反向（升版本）同样命中①——判据对称。
  const upgrade = decideVersion(input({ current: '6.7.0', upstreamVersion: '6.8.0', vendorDiff: true }));
  assert.equal(upgrade.rule, '①');
  assert.equal(upgrade.version, '6.8.0');
});

test('判据: current 的 base 与上游版本比较（带 rN 的 current 不因后缀而被判为版本变化）', () => {
  // current=6.7.0-r2、上游 6.7.0 → base 相等（6.7.0 === 6.7.0）→ 非①/④。
  const sameBase = decideVersion(input({
    current: '6.7.0-r2',
    upstreamVersion: '6.7.0',
    vendorDiff: true,
    wrapperPending: false,
  }));
  assert.equal(sameBase.rule, '②');
  assert.equal(sameBase.version, '6.7.0-r3');
  assert.deepEqual(sameBase.notes, []);

  // 反向哨兵：若实现拿 current 整串（含 -r2）去比较，会误判为「版本变化」并归零。
  assert.notEqual(sameBase.version, '6.7.0', '误用 current 整串比较会在此归零');
});

test('判据: 非法 -r 后缀不剥离——current=6.7.0-rx 与上游 6.7.0 属版本变化（base=整串）', () => {
  // parseRSuffix 的 fail-soft 直接作用于 decideVersion 的比较基准：`6.7.0-rx`
  // 的 base 是整串，与上游 `6.7.0` 不等 → 落①/④（版本格式校验属 T13 编排入口）。
  const result = decideVersion(input({
    current: '6.7.0-rx',
    upstreamVersion: '6.7.0',
    vendorDiff: true,
    wrapperPending: false,
  }));

  assert.equal(result.rule, '①');
  assert.equal(result.version, '6.7.0');
  assert.deepEqual(result.notes, [], '非法后缀不作 rN 解读 → 不得出现归零 note');
});

// ─── 形态 / 纯函数性 ─────────────────────────────────────────────

test('形态: 返回对象恰含三键且 notes 为全新数组（不共享可变引用）', () => {
  const first = decideVersion(input({ current: '6.7.0-r1', upstreamVersion: '6.8.0', vendorDiff: true }));
  const second = decideVersion(input({ current: '6.7.0-r1', upstreamVersion: '6.8.0', vendorDiff: true }));

  assertShape(first);
  assert.notEqual(first.notes, second.notes, 'notes 必须是每次新建的数组');
  assert.deepEqual(first, second, '同输入 → 同输出（纯函数，无隐藏状态）');
});

test('形态: 不修改输入对象（纯函数无副作用）', () => {
  const value = input({ current: '6.7.0-r1', upstreamVersion: '6.8.0', vendorDiff: true, wrapperPending: true });
  const snapshot = { ...value };

  decideVersion(value);

  assert.deepEqual(value, snapshot);
});

test('形态: 未提供的布尔字段按缺省处置（undefined 视为 false，不误判为包装层待发布）', () => {
  const bare = decideVersion({ current: '6.7.0', upstreamVersion: '6.7.0' });

  assertShape(bare);
  assert.equal(bare.rule, 'no-change');
  assert.equal(bare.version, '6.7.0');
});
