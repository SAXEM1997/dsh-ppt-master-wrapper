import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// 访问形态钉死（plan Task 1 Step 1）：新导出一律经命名空间访问——Task 2/3/4/5 在同一文件
// 追加导出时，本文件既有用例保持绿、追加用例先红，使「追加红/既有绿」在 test 文件粒度可观测。
import * as venv from '../lib/venv.js';

/**
 * HOME 隔离（plan Global Constraints「fs 注入缝与 HOME 隔离」）：
 * 凡路径含 `~`/`os.homedir()` 的原语，用例前置把 `process.env.HOME` 赋值为**非空 tmpdir**，
 * teardown **赋回原值**——禁用 `delete` 作还原手段：delete 会落 `getpwuid` 回退（本机 `/root`），
 * 那不是隔离，而是把测试锚到宿主真实家目录。本机 Node v22.23.3 实测 `os.homedir()` 每次
 * 实时读 HOME，临时赋值即时生效；因此本文件任何用例都不可能写到真实 `/root/.ppt-master`。
 */
const ORIGINAL_HOME = process.env.HOME;

/** 建一个按用例隔离的 HOME；调用方务必在 finally 中 restore()。 */
function useTmpHome(prefix = 'venv-home-') {
  // 还原形态是「赋值」，其前提是原值确为字符串（本机 HOME 已设，POSIX + plan 基线）。
  assert.equal(typeof ORIGINAL_HOME, 'string', '测试前提：进程 HOME 已设置，否则无法用赋值还原');
  const home = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = home;
  return {
    home,
    restore() {
      process.env.HOME = ORIGINAL_HOME;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 造一个含 `pyvenv.cfg` 的最小 venv 目录（落在调用方给的 tmp 树内）。 */
function makeVenvDir(parent, name = 'venv') {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pyvenv.cfg'), 'home = /usr/bin\n');
  return dir;
}

/** Task 1 契约入参：去引用后的普通对象 `{ enabled, path, oldPathPolicy }`。 */
const cfg = (path, enabled = true) => ({ enabled, path, oldPathPolicy: 'keep' });

// ─── 导出面 ──────────────────────────────────────────────────────

test('venv: 导出面——7 个函数 + MARKER_FILENAME 常量齐备', () => {
  const { restore } = useTmpHome();
  try {
    for (const name of [
      'resolveVenvPath',
      'venvExists',
      'readMarker',
      'writeMarker',
      'wrapperStatePath',
      'readWrapperState',
      'writeWrapperState',
    ]) {
      assert.equal(typeof venv[name], 'function', `缺少函数导出: ${name}`);
    }
    assert.equal(venv.MARKER_FILENAME, '.ppt-master-wrapper.json');
  } finally {
    restore();
  }
});

// ─── 导出面增量（G3-02 / G3-09 追加的两个同步原语） ──────────────

test('venv: 导出面增量——probeVenvPip（安装路径探测）与 normalizeVenvInput（工厂入口归一化）就位', () => {
  for (const name of ['probeVenvPip', 'normalizeVenvInput']) {
    assert.equal(typeof venv[name], 'function', `缺少函数导出: ${name}`);
  }
});

test('normalizeVenvInput: 缺失或非 true 的 enabled → false；其余字段缺省补默认；venv 键缺省原样（G3-09）', () => {
  // `venv` 键整体缺省/为 null ＝"未配置"（落 invalid 行、path=null），不得改写成默认袋。
  assert.equal(venv.normalizeVenvInput(undefined), undefined);
  assert.equal(venv.normalizeVenvInput(null), null);

  // 严格 === true：除字面 true 外一律关闭（缺失、false、真值字符串、数字、null、对象）。
  for (const enabled of [undefined, false, 'true', 1, null, {}]) {
    assert.equal(
      venv.normalizeVenvInput({ enabled, path: '/abs/venv' }).enabled,
      false,
      `enabled=${JSON.stringify(enabled)} 须归一为 false（缺键一律关闭）`
    );
  }
  assert.equal(venv.normalizeVenvInput({ enabled: true, path: '/abs/venv' }).enabled, true);

  // 其余字段缺省处补默认；在场值原样（含相对路径——有效性判定归 effectiveInterpreter，不在此降级）。
  assert.deepEqual(
    venv.normalizeVenvInput({ path: '/abs/venv' }),
    { enabled: false, path: '/abs/venv', oldPathPolicy: 'keep' }
  );
  assert.deepEqual(
    venv.normalizeVenvInput({ enabled: true, path: 'relative/venv' }),
    { enabled: true, path: 'relative/venv', oldPathPolicy: 'keep' }
  );
  assert.deepEqual(
    venv.normalizeVenvInput({}),
    { enabled: false, path: '~/.ppt-master/venv', oldPathPolicy: 'keep' },
    '空袋 → 三默认值逐字'
  );
  // 默认值只此一份字面量：与去引用快照的缺省产物同源。
  assert.deepEqual(venv.normalizeVenvInput({}), venv.snapshotVenvConfig(undefined), '两处默认值同源（无第二份字面量）');
});

// ─── resolveVenvPath 矩阵 ────────────────────────────────────────

test('resolveVenvPath: `~` 展开到当前 HOME（tmpdir）', () => {
  const { home, restore } = useTmpHome();
  try {
    const resolved = venv.resolveVenvPath(cfg('~/.ppt-master/venv'));
    assert.deepEqual(resolved, {
      path: join(home, '.ppt-master', 'venv'),
      invalidReason: null,
    });
    // 展开基准是本用例的 tmpdir，而不是宿主真实家目录：路径必须落在临时 HOME 之下。
    assert.ok(resolved.path.startsWith(home), `展开结果应落在临时 HOME 内: ${resolved.path}`);
  } finally {
    restore();
  }
});

test('resolveVenvPath: 绝对路径原样返回', () => {
  const { home, restore } = useTmpHome();
  try {
    const abs = join(home, 'explicit', 'venv');
    assert.deepEqual(venv.resolveVenvPath(cfg(abs)), { path: abs, invalidReason: null });
  } finally {
    restore();
  }
});

test('resolveVenvPath: 相对路径 → relative-path', () => {
  const { home, restore } = useTmpHome();
  try {
    assert.deepEqual(venv.resolveVenvPath(cfg('relative/venv')), {
      path: null,
      invalidReason: 'relative-path',
    });
    // `~` 仅识别 `~` 与 `~/` 两种形态；`~user/venv` 不是本插件的展开语法，按相对路径处理。
    assert.deepEqual(venv.resolveVenvPath(cfg('~user/venv')), {
      path: null,
      invalidReason: 'relative-path',
    });
  } finally {
    restore();
  }
});

test('resolveVenvPath: 空串/非字符串 → unresolvable', () => {
  const { restore } = useTmpHome();
  try {
    for (const bad of ['', '   ', null, undefined]) {
      assert.deepEqual(
        venv.resolveVenvPath(cfg(bad)),
        { path: null, invalidReason: 'unresolvable' },
        `非法路径应判 unresolvable: ${JSON.stringify(bad)}`
      );
    }
  } finally {
    restore();
  }
});

test('resolveVenvPath: enabled=false 不参与路径判定（纯路径语义）', () => {
  const { home, restore } = useTmpHome();
  try {
    // 关掉 venv 也不改变路径语义：`~` 照样展开、相对路径照样判无效。
    assert.deepEqual(venv.resolveVenvPath(cfg('~/.ppt-master/venv', false)), {
      path: join(home, '.ppt-master', 'venv'),
      invalidReason: null,
    });
    assert.deepEqual(venv.resolveVenvPath(cfg('relative/venv', false)), {
      path: null,
      invalidReason: 'relative-path',
    });
  } finally {
    restore();
  }
});

test("resolveVenvPath: HOME='' → `~` 展开判无效（严禁拼出根级路径）", () => {
  const { restore } = useTmpHome();
  try {
    process.env.HOME = '';
    // 前置观测：Node 的 os.homedir() 在 HOME 为空串时返回空串、不回退 passwd（本机实测）。
    assert.equal(homedir(), '', '前置：HOME 空串时 os.homedir() 应返回空串');
    assert.deepEqual(
      venv.resolveVenvPath(cfg('~/.ppt-master/venv')),
      { path: null, invalidReason: 'unresolvable' },
      "HOME 空串时 `~` 展开必须判无效，不得拼出 '/.ppt-master/…' 之类根级路径"
    );
  } finally {
    restore();
  }
});

test('resolveVenvPath: HOME 未设置 → `~` 跟随 getpwuid 回退值（关系式断言）', () => {
  const { home, restore } = useTmpHome();
  try {
    // 本用例是唯一允许 delete HOME 的位置：目的正是观测「未设置」时的 getpwuid 回退关系。
    // 还原仍在 finally 里以赋值完成（见文件头 HOME 隔离规则）。
    delete process.env.HOME;
    const fallback = homedir();
    assert.equal(typeof fallback, 'string', 'getpwuid 回退值应为字符串');
    assert.ok(fallback.length > 0, 'getpwuid 回退值应非空');
    assert.notEqual(fallback, home, '回退值不应等于本用例的 tmpdir（它未被赋值给 HOME）');
    assert.equal(homedir(), fallback, '同一用例内两次观测应一致');
    // 按关系式断言，不钉死字面（本机观测为 /root，随宿主用户而变，且非隔离手段）。
    assert.deepEqual(venv.resolveVenvPath(cfg('~/.ppt-master/venv')), {
      path: join(fallback, '.ppt-master', 'venv'),
      invalidReason: null,
    });
  } finally {
    restore();
  }
});

// ─── venvExists ──────────────────────────────────────────────────

test('venvExists: 目录内含 pyvenv.cfg → true', () => {
  const { home, restore } = useTmpHome();
  try {
    assert.equal(venv.venvExists(makeVenvDir(home)), true);
  } finally {
    restore();
  }
});

test('venvExists: 缺 pyvenv.cfg / 目录不存在 / 非字符串 → false', () => {
  const { home, restore } = useTmpHome();
  try {
    const plain = join(home, 'plain');
    mkdirSync(plain);
    assert.equal(venv.venvExists(plain), false, '空目录不是 venv');
    assert.equal(venv.venvExists(join(home, 'missing')), false, '不存在的目录不是 venv');
    assert.equal(venv.venvExists(null), false, 'null 入参应为 false 而非抛错');
  } finally {
    restore();
  }
});

// ─── marker 写读回环与收编语义 ───────────────────────────────────

test('marker: writeMarker → readMarker 回环（{createdAt, path} 两键）', () => {
  const { home, restore } = useTmpHome();
  try {
    const venvDir = makeVenvDir(home);
    venv.writeMarker(venvDir);

    const markerFile = join(venvDir, venv.MARKER_FILENAME);
    assert.ok(existsSync(markerFile), `标记文件应落在 venv 目录内: ${markerFile}`);
    const onDisk = JSON.parse(readFileSync(markerFile, 'utf8'));
    assert.deepEqual(Object.keys(onDisk).sort(), ['createdAt', 'path']);
    assert.equal(onDisk.path, venvDir);
    assert.match(onDisk.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    const writtenAt = Date.parse(onDisk.createdAt);
    assert.ok(!Number.isNaN(writtenAt), 'createdAt 应为可解析的 ISO 时间');
    assert.ok(Math.abs(Date.now() - writtenAt) < 60_000, 'createdAt 应为本次写入时刻');

    const marker = venv.readMarker(venvDir);
    assert.deepEqual(marker, { createdAt: onDisk.createdAt, path: venvDir });
    assert.deepEqual(Object.keys(marker).sort(), ['createdAt', 'path']);
  } finally {
    restore();
  }
});

test('marker: 收编语义——既有 venv 缺标记 → null → writeMarker 后可读', () => {
  const { home, restore } = useTmpHome();
  try {
    // 不存在目录 / 无标记目录：readMarker 一律 null 且不抛。
    assert.equal(venv.readMarker(join(home, 'missing')), null);

    const venvDir = makeVenvDir(home);
    assert.equal(venv.venvExists(venvDir), true, '前置：这是一个既有 venv');
    assert.equal(venv.readMarker(venvDir), null, '未标记的既有 venv 读标记应为 null');
    venv.writeMarker(venvDir);
    const adopted = venv.readMarker(venvDir);
    assert.equal(adopted.path, venvDir, '补写后的标记应指向该 venv 目录');
    assert.match(adopted.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    restore();
  }
});

// ─── wrapper-state 三态 ──────────────────────────────────────────

test('wrapperStatePath: <HOME>/.ppt-master/wrapper-state.json 且无副作用', () => {
  const { home, restore } = useTmpHome();
  try {
    assert.equal(venv.wrapperStatePath(), join(home, '.ppt-master', 'wrapper-state.json'));
    assert.ok(!existsSync(join(home, '.ppt-master')), '纯路径函数不应创建目录');
  } finally {
    restore();
  }
});

test('readWrapperState: 不存在 → {lastVenvPath:null} 且无 readError 键', () => {
  const { home, restore } = useTmpHome();
  try {
    // 形态一：`<HOME>/.ppt-master` 整个不存在（首次运行）。
    const first = venv.readWrapperState();
    assert.deepEqual(first, { lastVenvPath: null });
    assert.ok(!('readError' in first), '不存在＝初始化语义，不得带 readError 键');

    // 形态二：状态目录已存在但没有状态文件，语义同上。
    mkdirSync(join(home, '.ppt-master'), { recursive: true });
    const second = venv.readWrapperState();
    assert.deepEqual(second, { lastVenvPath: null });
    assert.ok(!('readError' in second), '状态文件缺失同样不得带 readError 键');
  } finally {
    restore();
  }
});

test('writeWrapperState: 写入 → 读回 → 覆盖更新', () => {
  const { home, restore } = useTmpHome();
  try {
    const firstPath = join(home, 'first-venv');
    venv.writeWrapperState(firstPath);

    const stateFile = join(home, '.ppt-master', 'wrapper-state.json');
    assert.ok(existsSync(stateFile), `状态文件应被创建: ${stateFile}`);
    const onDisk = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.deepEqual(Object.keys(onDisk).sort(), ['lastVenvPath']);
    assert.equal(onDisk.lastVenvPath, firstPath);

    assert.deepEqual(venv.readWrapperState(), { lastVenvPath: firstPath });

    const secondPath = join(home, 'second-venv');
    venv.writeWrapperState(secondPath);
    assert.deepEqual(venv.readWrapperState(), { lastVenvPath: secondPath });
  } finally {
    restore();
  }
});

test('readWrapperState: 读失败（EISDIR / 内容不可解析）→ readError 非空且不抛', () => {
  const { home, restore } = useTmpHome();
  try {
    // 形态一：状态文件名位被同名目录占用 → readFileSync 抛 EISDIR。
    mkdirSync(venv.wrapperStatePath(), { recursive: true });
    const dirState = venv.readWrapperState();
    assert.equal(dirState.lastVenvPath, null);
    assert.equal(typeof dirState.readError, 'string', '读失败应附 readError 字符串');
    assert.ok(dirState.readError.length > 0, 'readError 应非空');

    // 形态二：文件在但内容不可解析（同族「读失败」，与「不存在」保持分离）。
    rmSync(venv.wrapperStatePath(), { recursive: true, force: true });
    writeFileSync(venv.wrapperStatePath(), '{ not json');
    const brokenState = venv.readWrapperState();
    assert.equal(brokenState.lastVenvPath, null);
    assert.equal(typeof brokenState.readError, 'string');
    assert.ok(brokenState.readError.length > 0);
  } finally {
    restore();
  }
});

test("wrapperState 三原语: HOME='' → 拒绝相对路径回退（路径抛错 / 读降级 readError / 写抛错）（F3）", () => {
  const { restore } = useTmpHome();
  try {
    process.env.HOME = '';
    // 前置观测：Node 的 os.homedir() 在 HOME 为空串时返回空串、不回退（同 resolveVenvPath 边界用例）。
    assert.equal(homedir(), '', '前置：HOME 空串时 os.homedir() 应返回空串');
    const cwdStateDir = join(process.cwd(), '.ppt-master');

    // ① 路径解析：抛错，绝不产出 './.ppt-master/wrapper-state.json' 这类相对路径
    //    （相对路径会让 writeWrapperState 写进宿主 cwd，破坏单一登记位置契约）。
    let caught = null;
    try {
      venv.wrapperStatePath();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, 'HOME 空串时 wrapperStatePath 应抛错（拒绝相对路径回退）');
    assert.match(String(caught.message), /homedir|HOME/, '错误信息应指明不可解析的原因');

    // ② 读：never-throw 契约不变——降级为 readError，且与「缺席」（无 readError 键）保持分离。
    const state = venv.readWrapperState();
    assert.equal(state.lastVenvPath, null, 'HOME 不可解析 ⇒ 旧路径未知');
    assert.equal(typeof state.readError, 'string', '读失败应附 readError 字符串');
    assert.ok(state.readError.length > 0, 'readError 应非空');
    assert.equal('readError' in state, true, 'HOME 不可解析 ⇒ 走「读失败」通道（与「缺席」分离）');

    // ③ 写：抛错传播（调用方转成「登记失败（非删除失败）」注记，不静默写入 cwd）。
    assert.throws(
      () => venv.writeWrapperState('/tmp/venv-anywhere'),
      /homedir|HOME/,
      'HOME 空串时 writeWrapperState 应抛错',
    );
    assert.equal(existsSync(cwdStateDir), false, 'HOME 空串不得在 cwd 落状态目录');
  } finally {
    restore();
  }
});

// ─── 写失败：路径形态失配的自然失败（不改写任何模块函数） ────────

test('writeMarker: marker 名位被目录占用 → 抛 EISDIR（可捕获）', () => {
  const { home, restore } = useTmpHome();
  try {
    const venvDir = makeVenvDir(home);
    // 自然失败注入：目录形态失配，root 下同样生效（chmod 只读目录在 root 下无效，故不采用）。
    mkdirSync(join(venvDir, venv.MARKER_FILENAME));

    let caught = null;
    try {
      venv.writeMarker(venvDir);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, 'writeMarker 在 marker 名位被目录占用时应抛错');
    assert.equal(caught.code, 'EISDIR');
  } finally {
    restore();
  }
});

test('writeWrapperState: <HOME>/.ppt-master 父路径被文件占用 → 抛 ENOTDIR（可捕获）', () => {
  const { home, restore } = useTmpHome();
  try {
    // 自然失败注入：父路径形态失配（同名文件），root 下同样生效。
    const occupied = join(home, '.ppt-master');
    writeFileSync(occupied, 'occupied');

    let caught = null;
    try {
      venv.writeWrapperState(join(home, 'venv'));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, '父路径被文件占用时 writeWrapperState 应抛错');
    assert.equal(caught.code, 'ENOTDIR');
    assert.equal(readFileSync(occupied, 'utf8'), 'occupied', '失败的写入不得破坏占用文件');
  } finally {
    restore();
  }
});

// ─── probeVenvInterpreter：同步存在性探测（入参＝venv 目录） ─────
//
// 与 lib/tools.js 的 async 三字段版本探测（{found, version, meetsSkillRequirement}）是
// 两个接口：本原语只答「<venvDir>/bin/python3 是否可见」，消费方不自带 `bin/python3` 拼接。

/** 在 venv 目录内造 `bin/python3`；`symlinkTo` 给定时建符号链接（可指向不存在的目标）。 */
function addPythonBinary(venvDir, { symlinkTo = null } = {}) {
  const binDir = join(venvDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const binPython = join(binDir, 'python3');
  if (symlinkTo === null) writeFileSync(binPython, '#!/bin/sh\n');
  else symlinkSync(symlinkTo, binPython);
  return binPython;
}

/**
 * 造 `<venvDir>/bin/pip3`——真·完整 venv 的**安装路径**入口。
 *
 * `python3 -m venv` 在 ensurepip 之前就写好 `pyvenv.cfg` 与 `bin/python3`，故"解释器存在"不等于
 * "安装路径可用"（Gate 3 G3-02）：收编体检必须同时看到 `bin/pip3`，否则半成品目录会被永久收编。
 */
function addPipBinary(venvDir) {
  const binDir = join(venvDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const binPip = join(binDir, 'pip3');
  writeFileSync(binPip, '#!/bin/sh\n');
  return binPip;
}

test('probeVenvInterpreter: 入参＝venv 目录、内部拼 bin/python3（有效符号链接→true、悬空→false）', () => {
  const { home, restore } = useTmpHome();
  try {
    const venvDir = makeVenvDir(home);
    // 形态一：bin/python3 是指向真实文件的符号链接 → found:true（假解释器，只验形态不执行）。
    const target = join(home, 'real-python3');
    writeFileSync(target, '#!/bin/sh\n');
    addPythonBinary(venvDir, { symlinkTo: target });

    const found = venv.probeVenvInterpreter(venvDir);
    assert.deepEqual(Object.keys(found).sort(), ['found'], '探测结果只承载 found 单键');
    assert.equal(found.found, true, '有效的 bin/python3 符号链接应 found:true');

    // 形态二：悬空符号链接（lstat 可见、stat 不可见）→ found:false，不得当作可用解释器。
    const binPython = join(venvDir, 'bin', 'python3');
    rmSync(binPython, { force: true });
    symlinkSync(join(venvDir, 'bin', 'python3-absent'), binPython);
    assert.equal(venv.probeVenvInterpreter(venvDir).found, false, '悬空符号链接应 found:false');
  } finally {
    restore();
  }
});

test('probeVenvInterpreter: 缺 bin/python3 / 目录不存在 / 非字符串 → found:false 且不抛', () => {
  const { home, restore } = useTmpHome();
  try {
    // 只有 pyvenv.cfg 的 venv（无 bin/）：不得把「venv 目录存在」当作 found。
    const bare = makeVenvDir(home, 'bare-venv');
    assert.equal(venv.probeVenvInterpreter(bare).found, false, '无 bin/python3 应 found:false');

    // 反证拼接口径：venv 根下放同名 python3 仍为 false——探测目标是 bin/python3，不是目录本身。
    writeFileSync(join(bare, 'python3'), '#!/bin/sh\n');
    assert.equal(venv.probeVenvInterpreter(bare).found, false, '必须是 bin/python3，venv 根下同名不算');

    assert.equal(
      venv.probeVenvInterpreter(join(home, 'missing-venv')).found,
      false,
      '目录不存在应 found:false'
    );
    assert.equal(venv.probeVenvInterpreter(null).found, false, '非字符串入参应 found:false 而非抛错');
  } finally {
    restore();
  }
});

// ─── effectiveInterpreter 四态矩阵（spec §5.3 逐行） ─────────────
//
// path/exists/pythonPath/invalidReason/broken 逐行定值；判定序＝disabled → invalid → on-missing → on-ready。

test('effectiveInterpreter: off（路径合法）—— path 按配置原样、exists=false、不探测', () => {
  const { home, restore } = useTmpHome();
  try {
    // 反证「disabled 优先于探测」：磁盘上摆一个完全可用的 venv，off 行仍不得探测/上报。
    const venvDir = makeVenvDir(join(home, '.ppt-master'));
    addPythonBinary(venvDir);

    const probeCalls = [];
    const result = venv.effectiveInterpreter(cfg('~/.ppt-master/venv', false), {
      probeVenvInterpreter: (dir) => {
        probeCalls.push(dir);
        return { found: true };
      },
    });

    // 六字段契约（多一键/少一键都应失败；deepEqual 亦钉死键集，此处仅为可读的字段名清单）。
    assert.deepEqual(Object.keys(result).sort(), [
      'broken',
      'exists',
      'invalidReason',
      'path',
      'pythonPath',
      'state',
    ]);
    assert.deepEqual(result, {
      state: 'off',
      path: '~/.ppt-master/venv', // 按配置原样：未做 `~` 展开
      exists: false, // 定值：不探测
      pythonPath: null,
      invalidReason: null,
      broken: false,
    });
    assert.deepEqual(probeCalls, [], 'off 行不得探测解释器');
  } finally {
    restore();
  }
});

test('effectiveInterpreter: off（invalid×disabled 组合）—— disabled 优先、诊断面 path=null、invalidReason 如实', () => {
  const { restore } = useTmpHome();
  try {
    for (const [badPath, reason] of [
      ['relative/venv', 'relative-path'],
      ['', 'unresolvable'],
    ]) {
      const result = venv.effectiveInterpreter(cfg(badPath, false), {
        probeVenvInterpreter: () => assert.fail('off 行不得探测解释器'),
      });
      assert.deepEqual(
        result,
        {
          state: 'off',
          path: null, // 无效如实：不回落「配置原样」
          exists: false,
          pythonPath: null,
          invalidReason: reason,
          broken: false,
        },
        `无效×disabled 组合应落 off 且诊断面如实: ${JSON.stringify(badPath)}`
      );
    }
  } finally {
    restore();
  }
});

test('effectiveInterpreter: invalid —— enabled 且路径无效（path=null、invalidReason=原因、不探测）', () => {
  const { restore } = useTmpHome();
  try {
    const probe = () => assert.fail('invalid 行不得探测解释器');
    assert.deepEqual(
      venv.effectiveInterpreter(cfg('relative/venv'), { probeVenvInterpreter: probe }),
      {
        state: 'invalid',
        path: null,
        exists: false,
        pythonPath: null,
        invalidReason: 'relative-path',
        broken: false,
      }
    );
    // 同族第二形态：`~` 展开失败（HOME 空串）——enabled 下判 invalid、原因 unresolvable。
    process.env.HOME = '';
    assert.deepEqual(
      venv.effectiveInterpreter(cfg('~/.ppt-master/venv'), { probeVenvInterpreter: probe }),
      {
        state: 'invalid',
        path: null,
        exists: false,
        pythonPath: null,
        invalidReason: 'unresolvable',
        broken: false,
      }
    );
  } finally {
    restore();
  }
});

test('effectiveInterpreter: on-missing —— 解析后绝对路径、exists=false、不体检', () => {
  const { home, restore } = useTmpHome();
  try {
    const probe = () => assert.fail('on-missing 行不得体检解释器');
    const resolved = join(home, '.ppt-master', 'venv');

    // 形态一：目标路径整个不存在。
    assert.deepEqual(
      venv.effectiveInterpreter(cfg('~/.ppt-master/venv'), { probeVenvInterpreter: probe }),
      {
        state: 'on-missing',
        path: resolved, // 解析后绝对（与 off 行的「配置原样」对照）
        exists: false,
        pythonPath: null,
        invalidReason: null,
        broken: false,
      }
    );

    // 形态二：目录在但不是 venv（缺 pyvenv.cfg）——venvExists 判否，同样落 on-missing。
    mkdirSync(resolved, { recursive: true });
    assert.deepEqual(
      venv.effectiveInterpreter(cfg('~/.ppt-master/venv'), { probeVenvInterpreter: probe }),
      {
        state: 'on-missing',
        path: resolved,
        exists: false,
        pythonPath: null,
        invalidReason: null,
        broken: false,
      }
    );
  } finally {
    restore();
  }
});

test('effectiveInterpreter: on-ready —— exists=true、pythonPath=<abs>/bin/python3、探测入参＝同源解析路径', () => {
  const { home, restore } = useTmpHome();
  try {
    const venvDir = makeVenvDir(join(home, '.ppt-master'));
    addPythonBinary(venvDir);
    addPipBinary(venvDir); // 就绪判据含安装路径：完整 venv 才有 on-ready 正常态（R2 M2）

    const probeCalls = [];
    const result = venv.effectiveInterpreter(cfg('~/.ppt-master/venv'), {
      probeVenvInterpreter: (dir) => {
        probeCalls.push(dir);
        return { found: true };
      },
    });

    assert.deepEqual(result, {
      state: 'on-ready',
      path: venvDir,
      exists: true,
      pythonPath: join(venvDir, 'bin', 'python3'),
      invalidReason: null,
      broken: false,
    });
    // 探测目标与 path 同源：同一次求值产出的解析后绝对路径（消费方不再自带 `bin/python3` 拼接）。
    assert.deepEqual(probeCalls, [venvDir]);
  } finally {
    restore();
  }
});

test('effectiveInterpreter: on-ready 子态 exists-but-broken（桩探测 found:false）—— broken:true、pythonPath:null', () => {
  const { home, restore } = useTmpHome();
  try {
    const venvDir = makeVenvDir(join(home, '.ppt-master'));

    const probeCalls = [];
    const result = venv.effectiveInterpreter(cfg('~/.ppt-master/venv'), {
      probeVenvInterpreter: (dir) => {
        probeCalls.push(dir);
        return { found: false };
      },
    });

    assert.deepEqual(result, {
      state: 'on-ready', // 子态不新增 state：仍是 on-ready
      path: venvDir,
      exists: true,
      pythonPath: null, // broken 行定值：null（非 <path>/bin/python3）
      invalidReason: null,
      broken: true,
    });
    assert.deepEqual(probeCalls, [venvDir]);
    // 推断式可观测（spec §5.3 矩阵注记）：exists=true ∧ pythonPath=null ⇒ exists-but-broken。
    assert.ok(
      result.exists === true && result.pythonPath === null,
      'broken 子态应满足推断式 exists=true ∧ pythonPath=null'
    );
  } finally {
    restore();
  }
});

// ── 就绪判据含安装路径（Gate 3 R2 M2：半成品不得在任何消费面被宣告健康） ──────
//
// 事实：`python3 -m venv` 在 ensurepip **之前**就写好 `pyvenv.cfg` 与 `bin/python3`，Debian 缺
// `python3-venv`（无 ensurepip）时留下"有解释器、无 bin/pip3"的半成品。旧判据只看
// `probeVenvInterpreter` ⇒ info 报 `exists=true`/`pythonPath` 非空、check_env 渲染 python=<版本>、
// 入口正文落**态1**（"生效解释器"替换契约），而唯一能修的 `setup_deps` 报 `venv 内 pip3 缺失
// （安装不完整）` 并拒绝收编 ⇒ 三个消费面共用的就绪判据分叉，模型据态1 去跑上游脚本必然 ImportError。
// 修法：`effectiveInterpreter` 的就绪判据＝解释器可用 **且** `bin/pip3` 存在（与 ensureVenv 的
// 收编体检同一判据）；该形态落 on-ready 子态 `broken:true`、`pythonPath:null`，三面据此一致表达
// "未就绪/需先 setup_deps"。

test('effectiveInterpreter: 半成品（pyvenv.cfg + bin/python3、缺 bin/pip3）→ broken:true、pythonPath:null（M2）', async () => {
  const { home, restore } = useTmpHome();
  try {
    const venvDir = makeVenvDir(join(home, '.ppt-master'));
    addPythonBinary(venvDir); // 解释器可用
    assert.equal(venv.probeVenvInterpreter(venvDir).found, true, '前置：bin/python3 可用');
    assert.equal(venv.probeVenvPip(venvDir).found, false, '前置：bin/pip3 缺失（ensurepip 未跑完）');

    const result = venv.effectiveInterpreter(cfg('~/.ppt-master/venv'), {
      probeVenvInterpreter: venv.probeVenvInterpreter,
    });

    assert.deepEqual(result, {
      state: 'on-ready', // 子态不新增 state
      path: venvDir,
      exists: true, // 目录确实是 venv
      pythonPath: null, // 未就绪：不得给出"可用解释器"的路径
      invalidReason: null,
      broken: true,
    });
    assert.ok(
      result.exists === true && result.pythonPath === null,
      '推断式 exists=true ∧ pythonPath=null ⇒ broken（info/check_env 两侧共用同一可观测量）'
    );

    // 与收编体检同一判据：同一目录 ensureVenv 拒绝收编、不自动删、不置 adopted（共享就绪判据的证）。
    const outcome = await venv.ensureVenv(
      async () => {
        throw new Error('半成品形态不得走到创建/收编的 runner');
      },
      venvDir,
    );
    assert.equal(
      outcome.error,
      'venv 内 pip3 缺失（安装不完整）——手动删除该目录后重跑；若系统缺 ensurepip，需先安装 python3-venv',
      '收编拒绝文案逐字（M7：缺 ensurepip 的 Debian 上须先装 python3-venv，否则删了重建照样失败）',
    );
    assert.equal(outcome.created, false);
    assert.equal(outcome.adopted, false);
    assert.equal(existsSync(join(venvDir, 'bin', 'python3')), true, '不自动删：目录原样保留');
    assert.equal(existsSync(join(venvDir, 'bin', 'pip3')), false, '拒绝行不得代写 pip3');
  } finally {
    restore();
  }
});

test('effectiveInterpreter: exists-but-broken 自然形态——悬空 bin/python3 经同步原语判定', () => {
  const { home, restore } = useTmpHome();
  try {
    const venvDir = makeVenvDir(join(home, '.ppt-master'));
    // 自然注入：bin/python3 是悬空符号链接——目录「看起来是 venv」但没有可用解释器。
    addPythonBinary(venvDir, { symlinkTo: join(venvDir, 'bin', 'python3-absent') });

    // 注入本模块实测原语（消费方形态），打通「探测 found:false ⇒ broken」全链路。
    const result = venv.effectiveInterpreter(cfg('~/.ppt-master/venv'), {
      probeVenvInterpreter: venv.probeVenvInterpreter,
    });
    assert.deepEqual(result, {
      state: 'on-ready',
      path: venvDir,
      exists: true,
      pythonPath: null,
      invalidReason: null,
      broken: true,
    });
  } finally {
    restore();
  }
});

// ─── ensureVenv：五类结果矩阵（创建/收编/体检损坏/非空拒绝/创建失败） ────
//
// 前置三态判定：不存在 | 空目录 → 创建；含 pyvenv.cfg → 体检后收编；存在且非空且无
// pyvenv.cfg → fail-loud 拒绝。创建走注入 `run`（同 tools.js spawnRun 形态：非零记码、
// reject＝spawn 失败），体检走 Task 2 的同步 `probeVenvInterpreter`（传 venv 目录，
// 本处**不得**自带 `bin/python3` 拼接），标记写失败经桩注入、只走 warn 通道。

/**
 * `run` 桩：逐次记录 `(command, args, options)`，默认返回 `{exitCode: 0}`。
 * `create: true` 时模拟 `python3 -m venv <path>` 的**真实副作用**（建目录 + pyvenv.cfg）——
 * 这是被注入命令桩的如实副作用，不是 fs 桩；否则随后的 marker 写入没有落点。
 * `throws` 非空时以该错误 reject，模拟 spawn 失败（如 ENOENT）。
 */
function makeRunStub({ exitCode = 0, stderr = '', throws = null, create = false } = {}) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (throws !== null) throw throws;
    if (create) {
      const target = args[args.length - 1];
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'pyvenv.cfg'), 'home = /usr/bin\n');
    }
    return { exitCode, stderr };
  };
  return { run, calls };
}

/** 捕获 `console.warn`（异步版）：返回被 await 的返回值与逐行日志，finally 原样还原。 */
async function captureWarnAsync(run) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    return { value: await run(), warnings };
  } finally {
    console.warn = original;
  }
}

test('ensureVenv: 目标不存在 → 创建（run argv 逐字 + signal 透传 + 写标记）→ created:true', async () => {
  const { home, restore } = useTmpHome();
  try {
    const target = join(home, 'fresh-venv');
    const { run, calls } = makeRunStub({ create: true });
    const signal = new AbortController().signal;

    const result = await venv.ensureVenv(run, target, { signal });

    assert.deepEqual(result, { created: true, adopted: false });
    assert.equal(calls.length, 1, '创建路径恰调用一次 run');
    assert.equal(calls[0].command, 'python3');
    assert.deepEqual(calls[0].args, ['-m', 'venv', target], 'argv 逐字：-m venv <absPath>');
    assert.equal(calls[0].options.signal, signal, 'signal 应原样透传给 run 的 options');
    assert.equal(venv.readMarker(target)?.path, target, '创建成功后应写入所有权标记');
  } finally {
    restore();
  }
});

test('ensureVenv: 目标为空目录 → 同创建路径（复用空目录、created:true）', async () => {
  const { home, restore } = useTmpHome();
  try {
    const target = join(home, 'empty-venv');
    mkdirSync(target, { recursive: true });
    const { run, calls } = makeRunStub({ create: true });

    const result = await venv.ensureVenv(run, target);

    assert.deepEqual(result, { created: true, adopted: false }, '空目录走创建路径而非拒绝');
    assert.deepEqual(calls[0].args, ['-m', 'venv', target]);
    assert.equal(venv.readMarker(target)?.path, target, '创建成功后应写入所有权标记');
  } finally {
    restore();
  }
});

test('ensureVenv: 既有可用 venv 缺标记 → 收编（探针入参＝venv 目录、补写标记、不重建）', async () => {
  const { home, restore } = useTmpHome();
  try {
    const target = makeVenvDir(home, 'adoptable');
    addPythonBinary(target);
    addPipBinary(target); // 真·完整 venv：收编体检须同时看到安装路径入口（G3-02）
    const { run, calls } = makeRunStub({ create: true });
    const probeCalls = [];

    const result = await venv.ensureVenv(run, target, {
      probeVenvInterpreter: (dir) => {
        probeCalls.push(dir);
        return { found: true };
      },
    });

    assert.deepEqual(result, { created: false, adopted: true }, '既有可用 venv 应复用（收编）');
    assert.deepEqual(probeCalls, [target], '体检入参必须是 venv 目录本身，不得自带 bin/python3 拼接');
    assert.equal(calls.length, 0, '复用路径不得重建（缺才建）');
    assert.equal(venv.readMarker(target)?.path, target, '缺标记应补写（收编可清理授权）');
  } finally {
    restore();
  }
});

test('ensureVenv: 既有可用 venv 已有标记 → 复用且不重写标记（writeMarker 桩零调用）', async () => {
  const { home, restore } = useTmpHome();
  try {
    const target = makeVenvDir(home, 'marked');
    addPythonBinary(target);
    addPipBinary(target); // 真·完整 venv：收编体检须同时看到安装路径入口（G3-02）
    venv.writeMarker(target);
    const before = venv.readMarker(target);
    const writes = [];

    const result = await venv.ensureVenv(makeRunStub().run, target, {
      writeMarker: (dir) => writes.push(dir),
    });

    assert.deepEqual(result, { created: false, adopted: true });
    assert.deepEqual(writes, [], '已有标记不得重写（缺标记才补写）');
    assert.deepEqual(venv.readMarker(target), before, '既有标记应原样保留');
  } finally {
    restore();
  }
});

test('ensureVenv: 既有 venv 体检不可用（exists-but-broken）→ 拒绝且不自动删', async () => {
  const { home, restore } = useTmpHome();
  try {
    // 形态一：只有 pyvenv.cfg、没有 bin/python3。
    const bare = makeVenvDir(home, 'broken-bare');
    // 形态二：bin/python3 是悬空符号链接（真正经本模块默认同步探针判定）。
    const dangling = makeVenvDir(home, 'broken-dangling');
    addPythonBinary(dangling, { symlinkTo: join(dangling, 'bin', 'python3-absent') });
    const { run, calls } = makeRunStub({ create: true });

    const expected = {
      created: false,
      adopted: false,
      error: 'venv 解释器不可用（exists-but-broken）——手动删除该目录后重跑',
    };
    for (const target of [bare, dangling]) {
      assert.deepEqual(await venv.ensureVenv(run, target), expected, `损坏行应拒绝: ${target}`);
      assert.ok(existsSync(join(target, 'pyvenv.cfg')), '不自动删：目录与 pyvenv.cfg 必须原样保留');
      assert.equal(venv.readMarker(target), null, '损坏行不写标记');
    }
    assert.equal(calls.length, 0, '损坏行不得重建（python3 -m venv 会覆盖既有 venv）');
  } finally {
    restore();
  }
});

test('ensureVenv: 创建失败 stderr 的 ensurepip 指引行不得被首行截断——apt/python3-venv 必须到达模型（M7）', async () => {
  const { home, restore } = useTmpHome();
  try {
    const target = join(home, 'ensurepip-fail-venv');
    // 真实 Debian/Ubuntu（缺 python3-venv ⇒ 无 ensurepip）形态：唯一可执行的修复指引在第 2-5 行，
    // 只留首行会让用户/模型拿不到根因，次轮起被"删除重建"指引误导成必然复现的循环。
    const stderr = [
      'The virtual environment was not created successfully because ensurepip is not',
      'available.  On Debian/Ubuntu systems, you need to install the python3-venv',
      'package using the following command.',
      '',
      '    apt install python3.11-venv',
      '',
      'You may need to use sudo with that command.  After installing the python3-venv',
      'package, recreate your virtual environment.',
      '',
      'Failing command: /tmp/v/bin/python3 -m ensurepip --upgrade',
      '',
    ].join('\n');
    const { run } = makeRunStub({ exitCode: 1, stderr });

    const result = await venv.ensureVenv(run, target);

    assert.match(result.error, /退出码 1/, '退出码仍如实');
    assert.ok(
      result.error.includes('apt install python3.11-venv'),
      `唯一可执行的修复指引必须保留（apt 行在第 5 行）：${result.error}`,
    );
    assert.ok(result.error.includes('python3-venv'), '点明需要安装的包名');
    assert.ok(result.error.includes('ensurepip'), '点明根因（ensurepip 不可用）');
    assert.equal(
      result.error.includes('package, recreate your virtual environment.'),
      false,
      '与指引无关的续行不得回灌（只留有信息量的行）',
    );
    assert.ok(result.error.length < 600, `多行形态 error 仍须有界（实长 ${result.error.length}）`);

    // 关键字刷屏同样受硬上限约束：提示行保留通道不是 payload 打爆通道。
    const { run: spamRun } = makeRunStub({
      exitCode: 1,
      stderr: `boom\n${'apt install python3-venv\n'.repeat(500)}`,
    });
    const spammed = await venv.ensureVenv(spamRun, target);
    assert.ok(spammed.error.length < 600, `关键字行同样有界（实长 ${spammed.error.length}）`);
  } finally {
    restore();
  }
});

test('ensureVenv: 半成品 venv（pyvenv.cfg + bin/python3、缺 bin/pip3）→ 首轮与次轮同一拒绝、不自动删、不写标记（P1）', async () => {
  const { home, restore } = useTmpHome();
  try {
    // 真实成因：`python3 -m venv` 在 ensurepip **之前**就写好 pyvenv.cfg 与 bin/python3；
    // ensurepip 失败（Debian 缺 python3-venv、受限源等）留下"有解释器、无 pip3"的半成品。
    const target = makeVenvDir(home, 'half-built');
    addPythonBinary(target);
    assert.equal(
      existsSync(join(target, 'bin', 'pip3')),
      false,
      '前置：bin/pip3 缺失（安装不完整形态）'
    );
    assert.equal(venv.probeVenvInterpreter(target).found, true, '前置：解释器入口可用');
    const { run, calls } = makeRunStub({ create: true });

    const expected = {
      created: false,
      adopted: false,
      error: 'venv 内 pip3 缺失（安装不完整）——手动删除该目录后重跑；若系统缺 ensurepip，需先安装 python3-venv',
    };
    // 粘滞消除：该形态首轮报错后，**次轮起**不得改判成"可收编"（否则 installCmd 指向
    // 不存在的 <abs>/bin/pip3，只留一句 install did not succeed 且无恢复指引）。
    for (const round of ['首轮', '次轮']) {
      assert.deepEqual(
        await venv.ensureVenv(run, target, {}),
        expected,
        `${round}：半成品 venv 必须得到同一类损坏拒绝（不得 adopted）`
      );
    }

    assert.equal(existsSync(join(target, 'pyvenv.cfg')), true, '不自动删：目录原样保留');
    assert.equal(existsSync(join(target, 'bin', 'python3')), true, '不自动删：解释器入口原样保留');
    assert.equal(existsSync(join(target, 'bin', 'pip3')), false, '拒绝行不得代写 pip3');
    assert.equal(venv.readMarker(target), null, '拒绝行不写所有权标记');
    assert.equal(calls.length, 0, '拒绝行不得重建（python3 -m venv 会覆盖既有 venv）');
  } finally {
    restore();
  }
});

test('probeVenvPip: 入参＝venv 目录、内部拼 bin/pip3（完整→true、缺 pip3/不存在/非字符串→false）', () => {
  const { home, restore } = useTmpHome();
  try {
    const venvDir = makeVenvDir(home, 'pip-probe');
    assert.equal(venv.probeVenvPip(venvDir).found, false, '只有 pyvenv.cfg：安装路径尚不可用');
    assert.deepEqual(Object.keys(venv.probeVenvPip(venvDir)).sort(), ['found'], '探测结果只承载 found 单键');

    addPipBinary(venvDir);
    assert.equal(venv.probeVenvPip(venvDir).found, true, 'bin/pip3 在场 → 安装路径可用');
    assert.equal(
      venv.probeVenvPip(join(home, 'absent-venv')).found,
      false,
      '目录不存在 → found:false（不抛）'
    );
    for (const bad of [null, undefined, 42, '']) {
      assert.equal(venv.probeVenvPip(bad).found, false, `非字符串入参 ${String(bad)} 不抛`);
    }
  } finally {
    restore();
  }
});

test('ensureVenv: 非空非 venv → fail-loud 拒绝（不创建/不写标记/既有文件原样保留）', async () => {
  const { home, restore } = useTmpHome();
  try {
    const target = join(home, 'occupied');
    mkdirSync(target, { recursive: true });
    const payload = join(target, 'data.txt');
    writeFileSync(payload, 'user data');
    const { run, calls } = makeRunStub({ create: true });

    const result = await venv.ensureVenv(run, target);

    assert.deepEqual(result, { created: false, adopted: false, error: '目标目录非空且非 venv' });
    assert.equal(calls.length, 0, '拒绝行不得调用创建命令');
    assert.equal(readFileSync(payload, 'utf8'), 'user data', '既有文件必须原样保留');
    assert.deepEqual(readdirSync(target), ['data.txt'], '拒绝不得增删该目录内容');
    assert.equal(existsSync(join(target, venv.MARKER_FILENAME)), false, '拒绝行不得写标记');

    // 同族第二形态：目标路径被普通文件占用（既非空目录也非 venv）——同一拒绝口径，文件不被触碰。
    const fileTarget = join(home, 'plain-file');
    writeFileSync(fileTarget, 'keep me');
    const second = await venv.ensureVenv(run, fileTarget);
    assert.deepEqual(second, { created: false, adopted: false, error: '目标目录非空且非 venv' });
    assert.equal(readFileSync(fileTarget, 'utf8'), 'keep me', '普通文件形态同样不得被触碰');
  } finally {
    restore();
  }
});

test('ensureVenv: 创建 run 非零退出码 → {created:false, error 含退出码与 stderr} 且不写标记', async () => {
  const { home, restore } = useTmpHome();
  try {
    const target = join(home, 'fail-venv');
    const { run, calls } = makeRunStub({ exitCode: 1, stderr: 'boom\n' });

    const result = await venv.ensureVenv(run, target);

    assert.deepEqual(Object.keys(result).sort(), ['adopted', 'created', 'error'], '恰好三键');
    assert.equal(result.created, false);
    assert.equal(result.adopted, false);
    assert.match(result.error, /退出码 1/, 'error 应如实带非零退出码');
    assert.match(result.error, /boom/, 'error 应附 stderr 摘要');
    assert.equal(calls.length, 1, '创建失败不得重试');
    assert.equal(existsSync(join(target, venv.MARKER_FILENAME)), false, '创建失败不得写标记');
  } finally {
    restore();
  }
});

test('ensureVenv: 创建失败 stderr 冗长（多行 / 单行超长）→ venv.error 只嵌有界摘要（F4）', async () => {
  const { home, restore } = useTmpHome();
  try {
    const target = join(home, 'verbose-fail-venv');
    // 形态一：多行 stderr（如整段 traceback）——只取首行，后续行不得整段回灌进 model 可见载荷。
    const firstLine = 'Error: [Errno 28] No space left on device';
    const { run } = makeRunStub({
      exitCode: 1,
      stderr: `${firstLine}\n${'  File "<stdin>", line 1\n'.repeat(2000)}`,
    });

    const result = await venv.ensureVenv(run, target);

    assert.match(result.error, /退出码 1/, '退出码仍如实');
    assert.ok(result.error.includes(firstLine), `首行原因应保留：${result.error}`);
    assert.equal(result.error.includes('File "<stdin>"'), false, '多行 stderr 不得整段回灌');
    assert.ok(result.error.length < 600, `多行形态 error 应有界（实长 ${result.error.length}）`);

    // 形态二：单行超长（无换行可切）——硬截断并以省略号标示。
    const { run: run2 } = makeRunStub({ exitCode: 2, stderr: 'X'.repeat(50_000) });
    const second = await venv.ensureVenv(run2, target);
    assert.ok(second.error.length < 600, `单行超长同样应有界（实长 ${second.error.length}）`);
    assert.ok(second.error.includes('…'), '截断应以省略号标示（不静默吞掉信息量）');
  } finally {
    restore();
  }
});

test('ensureVenv: 创建 spawn 失败（run reject）→ {created:false, error} 不抛', async () => {
  const { home, restore } = useTmpHome();
  try {
    const target = join(home, 'spawn-fail-venv');
    const spawnError = Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' });
    const { run, calls } = makeRunStub({ throws: spawnError });

    const result = await venv.ensureVenv(run, target);

    assert.deepEqual(Object.keys(result).sort(), ['adopted', 'created', 'error']);
    assert.equal(result.created, false);
    assert.equal(result.adopted, false);
    assert.match(result.error, /ENOENT/, 'spawn 失败原因应如实进 error');
    assert.equal(calls.length, 1);
    assert.equal(existsSync(join(target, venv.MARKER_FILENAME)), false, 'spawn 失败不得写标记');
  } finally {
    restore();
  }
});

test('ensureVenv: 收编行 marker 补写失败 → 仍 adopted:true（warn 含 marker 路径、不置 error）', async () => {
  const { home, restore } = useTmpHome();
  try {
    const target = makeVenvDir(home, 'adopt-warn');
    addPythonBinary(target);
    addPipBinary(target); // 真·完整 venv：收编体检须同时看到安装路径入口（G3-02）
    const writes = [];
    const { value: result, warnings } = await captureWarnAsync(() =>
      venv.ensureVenv(makeRunStub().run, target, {
        writeMarker: (dir) => {
          writes.push(dir);
          throw new Error('EISDIR: marker 名位被目录占用');
        },
      })
    );

    assert.deepEqual(writes, [target], '缺标记应触发补写（桩确实被调用）');
    assert.deepEqual(result, { created: false, adopted: true }, '写失败不改写收编结论、不置 error');
    assert.equal(warnings.length, 1, '写失败恰一行 warn');
    assert.ok(
      warnings[0].includes(join(target, venv.MARKER_FILENAME)),
      `warn 应含 marker 路径: ${warnings[0]}`
    );
  } finally {
    restore();
  }
});

test('ensureVenv: 创建行 marker 写入失败 → 仍 created:true（warn 含 marker 路径、不置 error）', async () => {
  const { home, restore } = useTmpHome();
  try {
    const target = join(home, 'create-warn');
    const { run } = makeRunStub({ create: true });
    const { value: result, warnings } = await captureWarnAsync(() =>
      venv.ensureVenv(run, target, {
        writeMarker: () => {
          throw new Error('EPERM: 写入被拒');
        },
      })
    );

    assert.deepEqual(result, { created: true, adopted: false }, '写失败不改写创建结论、不置 error');
    assert.equal(warnings.length, 1, '写失败恰一行 warn');
    assert.ok(
      warnings[0].includes(join(target, venv.MARKER_FILENAME)),
      `warn 应含 marker 路径: ${warnings[0]}`
    );
    assert.equal(venv.readMarker(target), null, '桩未落盘——写失败被降级为警告，venv 仍可用');
  } finally {
    restore();
  }
});

test('ensureVenv: 创建中 abort → 拒绝传播（不折成 {error} 环境故障；非 abort 的 null 码仍值返回）', async () => {
  const { home, restore } = useTmpHome();
  try {
    const target = join(home, 'aborted-venv');

    // 形态一：创建进行中被取消——spawn 的 'error' 事件以 abort 原因 reject（name=AbortError）。
    const live = new AbortController();
    const abortingRun = async () => {
      live.abort();
      throw live.signal.reason;
    };
    await assert.rejects(
      () => venv.ensureVenv(abortingRun, target, { signal: live.signal }),
      (error) => error === live.signal.reason,
      'run 以 AbortError reject 时必须原样传播，不得折成 {created:false, error}'
    );

    // 形态二：子进程被 kill 后 close（spawnRun 解析出 exitCode:null）且 signal 已 abort。
    const killed = new AbortController();
    killed.abort();
    const { run: killedRun, calls } = makeRunStub({ exitCode: null });
    await assert.rejects(
      () => venv.ensureVenv(killedRun, target, { signal: killed.signal }),
      (error) => error === killed.signal.reason,
      'exitCode:null + 已 abort 的 signal 必须传播 abort，不得报「创建失败」'
    );
    assert.equal(calls.length, 1, '创建确已发起（abort 发生于其后）');
    assert.ok(!existsSync(target), 'abort 行不得留下 venv 目录或标记');

    // 反证：同一 null 退出码在未 abort 时仍是普通创建失败行（非 abort 的值返回契约不变）。
    const { run: plainRun } = makeRunStub({ exitCode: null });
    const folded = await venv.ensureVenv(plainRun, target, {});
    assert.deepEqual(Object.keys(folded).sort(), ['adopted', 'created', 'error']);
    assert.equal(folded.created, false);
    assert.match(folded.error, /退出码 null/, '非 abort 的 null 码仍如实成 {error} 值');
  } finally {
    restore();
  }
});

// ─── cleanupOldVenv：四条件删除安全模型（spec §5.4；本模块唯一删除原语） ───
//
// 四条件（路径≠当前、互不前缀包含、pyvenv.cfg 存在、带标记）**每次调用都从文件系统重读**，
// 因而半删态下轮仍满足条件并重试（spec §5.4 残留风险②）。删除失败注入经已声明的第四参
// `{ remove }`（缺省即 rmSync 递归 + force），不改写模块函数、不 monkey-patch node:fs。

/** 造一个「可授权删除」的旧 venv：`pyvenv.cfg` + 所有权标记齐备。 */
function makeMarkedVenv(parent, name) {
  const dir = makeVenvDir(parent, name);
  venv.writeMarker(dir);
  return dir;
}

/** 记录调用的 `{remove}` 桩：缺省真删目录；`throws` 给定时改为抛错（可先经 `beforeThrow` 造副作用）。 */
function makeRemoveStub({ beforeThrow = null, throws = null } = {}) {
  const calls = [];
  const remove = (dirPath) => {
    calls.push(dirPath);
    if (throws === null) {
      rmSync(dirPath, { recursive: true, force: true });
      return;
    }
    beforeThrow?.(dirPath);
    throw throws;
  };
  return { calls, remove };
}

test('cleanupOldVenv: 四条件齐备 + policy=delete → deleted（默认 rmSync 递归删；路径经 `~` 展开）', () => {
  const { home, restore } = useTmpHome();
  try {
    // 旧/新路径按 Task 9 的真实数据源取得：resolveVenvPath 展开 `~` 后的绝对路径。
    const oldPath = venv.resolveVenvPath(cfg('~/.ppt-master/venv-old')).path;
    const currentPath = venv.resolveVenvPath(cfg('~/.ppt-master/venv')).path;
    const oldVenv = makeMarkedVenv(join(home, '.ppt-master'), 'venv-old');
    assert.equal(oldVenv, oldPath, '前置：旧路径即被标记的 venv 目录');
    addPythonBinary(oldVenv); // 嵌套内容——证明递归删除而非只删空目录

    const result = venv.cleanupOldVenv(oldPath, 'delete', currentPath);

    assert.deepEqual(result, { action: 'deleted' }, '四条件齐备且 policy=delete → deleted（无 error 键）');
    assert.equal(existsSync(oldPath), false, '旧 venv 目录应被递归删除');
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 四条件齐备 + policy=keep → kept（零删除调用、目录原样）', () => {
  const { home, restore } = useTmpHome();
  try {
    const oldPath = makeMarkedVenv(home, 'keep-venv');
    const currentPath = join(home, 'current-venv');
    const { calls, remove } = makeRemoveStub();

    const result = venv.cleanupOldVenv(oldPath, 'keep', currentPath, { remove });

    assert.deepEqual(result, { action: 'kept' }, 'keep 行只报闲置：不删除、不带 error');
    assert.deepEqual(calls, [], 'keep 行不得触碰删除原语');
    assert.equal(existsSync(oldPath), true, '目录原样保留');
    assert.notEqual(venv.readMarker(oldPath), null, '标记仍可读（未被删除/改写）');
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 条件一（oldPath === currentPath）→ none 且不删（两 policy 同判）', () => {
  const { home, restore } = useTmpHome();
  try {
    const oldPath = makeMarkedVenv(home, 'same-venv');
    const { calls, remove } = makeRemoveStub();

    for (const policy of ['delete', 'keep']) {
      const result = venv.cleanupOldVenv(oldPath, policy, oldPath, { remove });

      assert.deepEqual(Object.keys(result).sort(), ['action', 'error'], `policy=${policy}：none 行附原因`);
      assert.equal(result.action, 'none', `policy=${policy}：同路径必须拒绝删除`);
      assert.match(result.error, /相同/, '原因应指明路径相同');
      assert.deepEqual(calls, [], `policy=${policy}：零删除调用`);
      assert.equal(existsSync(oldPath), true, `policy=${policy}：目录未被触碰`);
    }
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 条件二——前缀包含双向拒绝（Review Focus #4：嵌套配置不得自毁）', () => {
  const { home, restore } = useTmpHome();
  try {
    const { calls, remove } = makeRemoveStub();

    // 方向一：旧路径是新路径的祖先（旧=<home>/nested，新=<home>/nested/inner）——最危险的自毁形态；
    // 该目录本身是四条件齐备的合法 venv，故被拒只能归因于前缀判定。
    const outerOld = makeMarkedVenv(home, 'nested');
    const innerNew = join(outerOld, 'inner');
    let result = venv.cleanupOldVenv(outerOld, 'delete', innerNew, { remove });
    assert.equal(result.action, 'none', '旧路径前缀包含新路径 → 拒绝');
    assert.match(result.error, /前缀包含/, '原因应指向前缀包含');
    assert.equal(existsSync(outerOld), true, '拒绝时目录原样保留');

    // 方向二：新路径是旧路径的祖先（旧=<home>/outer2/venv-old，新=<home>/outer2）。
    const outerNew = join(home, 'outer2');
    const nestedOld = makeMarkedVenv(outerNew, 'venv-old');
    result = venv.cleanupOldVenv(nestedOld, 'delete', outerNew, { remove });
    assert.equal(result.action, 'none', '新路径前缀包含旧路径 → 同样拒绝（方向性判定须双向）');
    assert.match(result.error, /前缀包含/);
    assert.equal(existsSync(nestedOld), true, '拒绝时目录原样保留');

    // 同目录异拼写（尾斜杠）：字面不等却互为前缀 → 仍拒绝，删除目标与当前 venv 不得重合。
    const slashed = makeMarkedVenv(home, 'slash-venv');
    for (const [old, current] of [[slashed, `${slashed}/`], [`${slashed}/`, slashed]]) {
      result = venv.cleanupOldVenv(old, 'delete', current, { remove });
      assert.equal(result.action, 'none', `尾斜杠同目录（old=${old}）→ 拒绝`);
    }

    assert.deepEqual(calls, [], '前缀类各行一律零删除调用');
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 条件三——缺 pyvenv.cfg（不存在/空目录/仅标记）→ none 且不删', () => {
  const { home, restore } = useTmpHome();
  try {
    const currentPath = join(home, 'current');
    const { calls, remove } = makeRemoveStub();

    // 形态一：路径不存在（登记残留的旧路径）。
    let result = venv.cleanupOldVenv(join(home, 'gone-venv'), 'delete', currentPath, { remove });
    assert.equal(result.action, 'none', '路径不存在 → 不删');
    assert.match(result.error, /非 venv/, '原因应指明不是 venv 目录');

    // 形态二：目录存在但为空（无 pyvenv.cfg）。
    const emptyDir = join(home, 'empty-dir');
    mkdirSync(emptyDir);
    result = venv.cleanupOldVenv(emptyDir, 'delete', currentPath, { remove });
    assert.equal(result.action, 'none', '空目录不是 venv → 拒绝（venvExists 判定）');

    // 形态三：带标记但无 pyvenv.cfg——证明条件三独立生效，标记不能替代 venv 判定。
    const markedOnly = join(home, 'marked-only');
    mkdirSync(markedOnly);
    venv.writeMarker(markedOnly);
    result = venv.cleanupOldVenv(markedOnly, 'delete', currentPath, { remove });
    assert.equal(result.action, 'none', '有标记但无 pyvenv.cfg → 仍拒绝');

    assert.deepEqual(calls, [], '三形态零删除调用');
    assert.equal(existsSync(emptyDir), true, '空目录原样保留');
    assert.equal(existsSync(markedOnly), true, '仅标记目录原样保留');
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 条件四——venv 无标记/标记损坏 → none（标记即删除授权）', () => {
  const { home, restore } = useTmpHome();
  try {
    const currentPath = join(home, 'current');
    const { calls, remove } = makeRemoveStub();

    // 形态一：合法 venv 但缺标记（历史遗留或手工建的 venv）。
    const unmarked = makeVenvDir(home, 'unmarked-venv');
    let result = venv.cleanupOldVenv(unmarked, 'delete', currentPath, { remove });
    assert.equal(result.action, 'none', '无标记即无删除授权');
    assert.match(result.error, /标记/, '原因应指明缺所有权标记');

    // 形态二：标记不可解析 → readMarker 返回 null → 同样不授权。
    const malformed = makeVenvDir(home, 'malformed-venv');
    writeFileSync(join(malformed, venv.MARKER_FILENAME), '{ 不是 JSON');
    assert.equal(venv.readMarker(malformed), null, '前置：损坏标记读回 null');
    result = venv.cleanupOldVenv(malformed, 'delete', currentPath, { remove });
    assert.equal(result.action, 'none', '损坏标记不授予删除权');

    // 形态三：标记可解析但字段类型不符（缺 path）→ readMarker 判 null。
    const wrongShape = makeVenvDir(home, 'wrong-shape-venv');
    writeFileSync(join(wrongShape, venv.MARKER_FILENAME), JSON.stringify({ createdAt: 1 }));
    result = venv.cleanupOldVenv(wrongShape, 'delete', currentPath, { remove });
    assert.equal(result.action, 'none', '字段类型不符的标记不授予删除权');

    assert.deepEqual(calls, [], '三形态零删除调用');
    for (const dir of [unmarked, malformed, wrongShape]) {
      assert.equal(existsSync(dir), true, `${dir} 应原样保留`);
    }
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 注入桩 remove 抛错 → failed + error 且不抛（恰一次调用、目录留存）', () => {
  const { home, restore } = useTmpHome();
  try {
    const oldPath = makeMarkedVenv(home, 'fail-venv');
    const currentPath = join(home, 'current');
    const { calls, remove } = makeRemoveStub({ throws: new Error('EBUSY: 目录忙') });

    let result;
    assert.doesNotThrow(() => {
      result = venv.cleanupOldVenv(oldPath, 'delete', currentPath, { remove });
    }, '删除失败必须值返回，不得抛（spec §6 cleanup 行）');

    assert.deepEqual(Object.keys(result).sort(), ['action', 'error'], 'failed 行两键');
    assert.equal(result.action, 'failed', '桩抛错 → failed');
    assert.match(result.error, /EBUSY/, 'error 应携带原因（不吞细节）');
    assert.deepEqual(calls, [oldPath], '删除原语恰一次、入参即旧路径');
    assert.equal(existsSync(oldPath), true, '桩未真删——目录留存待下轮重试');
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 半删态重试——首轮桩部分删除后抛错，次轮仍满足四条件并再次尝试删除', () => {
  const { home, restore } = useTmpHome();
  try {
    const oldPath = makeMarkedVenv(home, 'retry-venv');
    addPythonBinary(oldPath);
    const currentPath = join(home, 'current');

    // 首轮桩：造成可观测的部分删除（bin/ 被删）后抛错——模拟 rmSync 中途失败（残留风险②）。
    const first = makeRemoveStub({
      beforeThrow: (dirPath) => rmSync(join(dirPath, 'bin'), { recursive: true, force: true }),
      throws: new Error('EACCES: 删除中途被拒'),
    });
    const firstResult = venv.cleanupOldVenv(oldPath, 'delete', currentPath, { remove: first.remove });
    assert.equal(firstResult.action, 'failed', '首轮如实报 failed');
    assert.equal(existsSync(join(oldPath, 'bin')), false, '前置：首轮确已部分删除');
    assert.equal(venv.venvExists(oldPath), true, '前置：pyvenv.cfg 仍在 → 四条件仍可满足');
    assert.notEqual(venv.readMarker(oldPath), null, '前置：标记仍在 → 删除授权仍在');

    // 次轮：删除原语换成「记录调用 + 真删」——重试不得因「上次失败」被短路成 none。
    const second = makeRemoveStub();
    const secondResult = venv.cleanupOldVenv(oldPath, 'delete', currentPath, { remove: second.remove });
    assert.notEqual(secondResult.action, 'none', '半删态不得被判为无可清理（须再次尝试删除）');
    assert.equal(secondResult.action, 'deleted', '四条件复读仍成立 → 次轮删除成功');
    assert.deepEqual(second.calls, [oldPath], '次轮确实再次调用了删除原语');
    assert.equal(existsSync(oldPath), false, '残留目录最终被清除');
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 前缀判定的段边界——兄弟目录（名字共前缀但非嵌套）不误判 → deleted', () => {
  const { home, restore } = useTmpHome();
  try {
    // 朴素 startsWith 会把 `/…/venv` 当作 `/…/venv2` 的前缀而误拒；段边界判定必须放行。
    for (const [oldName, currentName] of [['venv', 'venv2'], ['venv2', 'venv']]) {
      const oldPath = makeMarkedVenv(home, oldName);
      const sentinel = join(home, `${currentName}-keep.txt`);
      writeFileSync(sentinel, '当前 venv 侧的哨兵文件\n');
      const { calls, remove } = makeRemoveStub();

      const result = venv.cleanupOldVenv(oldPath, 'delete', join(home, currentName), { remove });

      assert.equal(result.action, 'deleted', `${oldName} vs ${currentName}：兄弟目录不是前缀包含`);
      assert.deepEqual(calls, [oldPath], '删除目标须恰为旧路径');
      assert.equal(existsSync(oldPath), false, '旧目录被删');
      assert.equal(existsSync(sentinel), true, '当前侧文件不得被误删');
    }
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 非字符串/空路径入参 → none 且不抛（无删除授权时永不触删除缝）', () => {
  const { home, restore } = useTmpHome();
  try {
    const currentPath = join(home, 'current');
    const { calls, remove } = makeRemoveStub();

    // currentPath 为 null 是真实可达形态：venv.path 无效时 Task 2 的解析结果为 null。
    for (const [oldPath, current] of [
      [null, currentPath],
      [undefined, currentPath],
      [currentPath, null],
      [42, currentPath],
      ['', currentPath],
      [null, null],
    ]) {
      let result;
      assert.doesNotThrow(() => {
        result = venv.cleanupOldVenv(oldPath, 'delete', current, { remove });
      }, `oldPath=${String(oldPath)} currentPath=${String(current)}：不得抛`);
      assert.equal(result.action, 'none', `oldPath=${String(oldPath)}：无授权 → none`);
    }

    assert.deepEqual(calls, [], '非法入参一行都不得到达删除缝');
  } finally {
    restore();
  }
});


// ── 条件①②的路径规范化（P0：文本别名不得绕过删除安全） ──────────
//
// 事实（Gate 3 G3-01）：条件①（`oldPath !== currentPath`）与条件②（双向 `isPathPrefix`）曾按
// **纯文本**比较，而 `resolveVenvPath` 不做规范化——同一目录写成 `<b>//venv`、`<b>/./venv`、
// `<b>/sub/../venv` 时两条都放行，落到条件③④为真即删除**本次正在使用的 venv**。父目录为符号
// 链接时（`old=/…/link/venv`、`current=/…/real/venv`）`path.resolve` 两值不等但 `realpath` 相同，
// 故仅做 `resolve` 不足以修复：判定须按**同一文件系统实体**（realpath，退回 dev+ino）。
// 规范化只服务**判定**：传 `remove()` 的仍是调用方给的 `oldPath` 原值。

test('cleanupOldVenv: 条件一——同一目录的文本别名（重复分隔符 / `.` / `..`）一律拒绝，零删除调用（P0）', () => {
  const { home, restore } = useTmpHome();
  try {
    const base = join(home, 'alias-base');
    const currentPath = makeMarkedVenv(base, 'venv'); // 正在使用的 venv，四条件齐备
    mkdirSync(join(base, 'sub'), { recursive: true }); // 让 `sub/..` 成为可解析的真实路径
    const { calls, remove } = makeRemoveStub();

    for (const alias of [
      `${base}//venv`, // 内部重复分隔符
      `${base}/./venv`, // 内嵌 `.`
      `${base}/sub/../venv`, // 内嵌 `..`（raw 拼写：`join` 会自行归一化，不得借它造别名）
    ]) {
      assert.notEqual(alias, currentPath, `前置：别名拼写与当前路径字面不同（${alias}）`);
      assert.equal(resolve(alias), resolve(currentPath), '前置：别名与当前路径经 resolve 归一化后同一');
      const result = venv.cleanupOldVenv(alias, 'delete', currentPath, { remove });
      assert.equal(result.action, 'none', `别名 ${alias} 指向在用 venv → 必须拒绝删除`);
      assert.match(result.error, /相同/, '拒绝原因应指明同路径（条件①归一化后命中）');
    }

    assert.deepEqual(calls, [], '三条别名一律零删除调用');
    assert.equal(existsSync(currentPath), true, '在用 venv 与目录内容原样保留');
    assert.notEqual(venv.readMarker(currentPath), null, '在用 venv 的标记未被触碰');
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 条件一——父目录符号链接变体（resolve 不等、realpath 同实体）→ none 且不删（P0）', () => {
  const { home, restore } = useTmpHome();
  try {
    const real = join(home, 'real');
    const currentPath = makeMarkedVenv(real, 'venv'); // 在用 venv：真实拼写
    const link = join(home, 'link');
    symlinkSync(real, link); // link → real（父目录符号链接，非 venv 目录本身）
    const selfLink = join(home, 'venv-self-link');
    symlinkSync(currentPath, selfLink); // venv 目录本身的符号链接（第三种拼写）

    const { calls, remove } = makeRemoveStub();

    for (const [label, alias] of [
      ['父目录符号链接', join(link, 'venv')],
      ['目录自身符号链接', selfLink],
    ]) {
      assert.notEqual(alias, currentPath, `前置：${label}拼写与当前路径字面不同`);
      assert.notEqual(resolve(alias), resolve(currentPath), `前置：${label} 的 path.resolve 两值不等`);
      assert.equal(
        realpathSync(alias),
        realpathSync(currentPath),
        `前置：${label} 与当前路径 realpath 同一实体`,
      );
      const aliasStat = statSync(alias);
      const currentStat = statSync(currentPath);
      assert.equal(aliasStat.dev, currentStat.dev, `前置：${label} 同 dev`);
      assert.equal(aliasStat.ino, currentStat.ino, `前置：${label} 同 inode`);

      const result = venv.cleanupOldVenv(alias, 'delete', currentPath, { remove });
      assert.equal(result.action, 'none', `${label} 指向在用 venv → 必须拒绝删除`);
      assert.match(result.error, /同一实体/, `${label} 的拒绝原因应指明同一实体`);
    }

    assert.deepEqual(calls, [], '两种符号链接别名一律零删除调用');
    assert.equal(existsSync(currentPath), true, '在用 venv 目录原样保留');
    assert.equal(existsSync(join(currentPath, 'pyvenv.cfg')), true, 'venv 内容未被触碰');
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 别名不削弱既有判定——反向包含（old 为 current 父目录，别名拼写）仍拒绝（P0）', () => {
  const { home, restore } = useTmpHome();
  try {
    const outerOld = makeMarkedVenv(home, 'nested'); // 合法 venv，但它是 current 的祖先
    const innerCurrent = `${home}/./nested/inner`; // raw 别名拼写；归一化后确为嵌套配置
    const { calls, remove } = makeRemoveStub();

    const result = venv.cleanupOldVenv(outerOld, 'delete', innerCurrent, { remove });

    assert.equal(result.action, 'none', '归一化后仍识别为嵌套配置 → 拒绝');
    assert.match(result.error, /前缀包含/, '原因指向前缀包含（条件②未被规范化短路）');
    assert.deepEqual(calls, [], '拒绝即零删除调用');
    assert.equal(existsSync(outerOld), true, '祖先目录原样保留');
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 规范化只用于判定——真·不同路径经别名拼写仍 deleted，删除目标为原值（P0）', () => {
  const { home, restore } = useTmpHome();
  try {
    const base = join(home, 'target-base');
    const realOld = makeMarkedVenv(base, 'venv-old');
    mkdirSync(join(base, 'sub'), { recursive: true });
    const oldAlias = `${base}/sub/../venv-old`; // raw 别名拼写（`join` 会自行归一化）
    const currentPath = join(base, 'venv-current'); // 真·不同路径（不共用前缀段边界）
    const { calls, remove } = makeRemoveStub();

    assert.notEqual(oldAlias, realOld, '前置：删除入参是别名拼写而非 realOld');
    const result = venv.cleanupOldVenv(oldAlias, 'delete', currentPath, { remove });

    assert.equal(result.action, 'deleted', '四条件齐备 + 真不同路径 → 照常删除（规范化不得误拒）');
    assert.deepEqual(calls, [oldAlias], '删除原语收到的仍是调用方给的原值（删除目标语义不变）');
    assert.equal(existsSync(realOld), false, '别名与真实拼写同一目录，删除确已生效');
    assert.equal(existsSync(currentPath), false, '当前路径本就不存在（仅作对照，未创建）');
  } finally {
    restore();
  }
});

// ── 条件①②的 canonical 判定（Gate 3 R2 M1：内核语义的包含面与等式面） ──
//
// 事实：条件①②曾判 `path.resolve` 的**纯文本**结果，而条件③④与 `remove()` 用 `oldPath` 原值——
// `join`/`existsSync`/`rmSync` 的 `..` 是**内核语义**（先解符号链接再退父目录）。两个独立缺口：
// (a) 包含面：父目录为符号链接时文本不判包含、realpath 也不等（`old=<real>` 与
//     `current=<link>/venv` 是两个不同目录）⇒ 落到③④为真即 `rmSync(recursive)` 删掉**本次在用
//     的 venv**，连同其所在祖先目录与同层用户数据；
// (b) 等式面：`<p>/link/../venv`（link→`<q>/sub`）与 `<q>/venv` 在**内核**下同一目录，但
//     `path.resolve` 两值不等，而 Node `realpathSync` 自己也按**文本**折叠 `..`
//     （实测：`realpathSync('<p>/link/..') === '<p>'`，`readlink -f` 则给 `<q>`）⇒ 仅靠
//     `realpathSync` 仍漏判，必须按**原始拼写**逐段解析（`..` 在已解析的前缀上回退）。
// 修法：条件①②一律判 canonical 形式；`remove()` 仍收调用方原值（既有用例 1541 钉住）。

/** 造符号链接；本机不支持（EPERM/ENOSYS 等）时返回 false，调用方 `t.skip`。 */
function trySymlink(target, linkPath) {
  try {
    symlinkSync(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

test('cleanupOldVenv: 包含面——old 为祖先目录、current 经父目录符号链接抵达（<link>/venv）→ 拒绝且零删除（P0）', (t) => {
  const { home, restore } = useTmpHome();
  try {
    const real = makeMarkedVenv(home, 'real'); // 旧路径：合法 venv，同时是在用 venv 的祖先
    const inUse = makeMarkedVenv(real, 'venv'); // 本次在用的 venv（真实拼写）
    writeFileSync(join(real, 'user-data.txt'), '同层用户数据\n'); // 祖先目录里的无关数据
    const link = join(home, 'link');
    if (!trySymlink(real, link)) {
      t.skip('本机不支持符号链接（EPERM/ENOSYS），包含面无法构造');
      return;
    }
    const aliasCurrent = join(link, 'venv'); // 内核语义＝real/venv

    // 前置：文本两说、内核同一——正是文本判定放行的形态。
    assert.notEqual(resolve(aliasCurrent), resolve(inUse), '前置：<link>/venv 与 <real>/venv 文本不等');
    assert.equal(realpathSync(aliasCurrent), realpathSync(inUse), '前置：内核下两者同一目录');
    assert.notEqual(realpathSync(real), realpathSync(aliasCurrent), '前置：old 与 current 不是同一实体');
    assert.ok(
      !resolve(aliasCurrent).startsWith(resolve(real) + '/') && !aliasCurrent.startsWith(real),
      '前置：纯文本下 old 不是 current 的前缀（包含面判定失效点）'
    );

    const { calls, remove } = makeRemoveStub();
    const result = venv.cleanupOldVenv(real, 'delete', aliasCurrent, { remove });

    assert.equal(result.action, 'none', '内核语义下 old 包含 current → 必须拒绝删除');
    assert.match(result.error, /前缀包含/, '原因指向前缀包含（包含面按 canonical 判定）');
    assert.deepEqual(calls, [], '拒绝即零删除调用');
    assert.equal(existsSync(inUse), true, '本次在用的 venv 必须原样保留');
    assert.equal(existsSync(join(inUse, 'pyvenv.cfg')), true, '在用 venv 的内容不得被触碰');
    assert.equal(existsSync(join(real, 'user-data.txt')), true, '祖先目录内的用户数据不得被递归删除');
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 包含面反向——old 经父目录符号链接落在 current（<link>/subvenv、current=<real>）→ 拒绝（P0）', (t) => {
  const { home, restore } = useTmpHome();
  try {
    const real = makeMarkedVenv(home, 'real'); // 当前路径：本次在用的 venv
    const subOld = makeMarkedVenv(real, 'subvenv'); // 旧路径：在用 venv 的**内部**目录
    const link = join(home, 'link');
    if (!trySymlink(real, link)) {
      t.skip('本机不支持符号链接（EPERM/ENOSYS），包含面无法构造');
      return;
    }
    const aliasOld = join(link, 'subvenv'); // 内核语义＝real/subvenv

    assert.notEqual(resolve(aliasOld), resolve(real), '前置：文本不等');
    assert.notEqual(realpathSync(aliasOld), realpathSync(real), '前置：非同一实体');
    assert.ok(
      !resolve(real).startsWith(resolve(aliasOld) + '/') && !aliasOld.startsWith(real),
      '前置：文本双向都不判包含'
    );

    const { calls, remove } = makeRemoveStub();
    const result = venv.cleanupOldVenv(aliasOld, 'delete', real, { remove });

    assert.equal(result.action, 'none', '反向形态（old 位于 current 之内）同样必须拒绝');
    assert.match(result.error, /前缀包含/);
    assert.deepEqual(calls, [], '拒绝即零删除调用');
    assert.equal(existsSync(subOld), true, '在用 venv 的内部目录不得被删除');
    assert.equal(existsSync(real), true, '在用 venv 本身原样保留');
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 等式面——`..` × 符号链接两向拼写（kernel 同一、text 不等）→ 拒绝且零删除（P0）', (t) => {
  const { home, restore } = useTmpHome();
  try {
    const q = join(home, 'q');
    const current = makeMarkedVenv(q, 'venv'); // 在用 venv：真实拼写
    mkdirSync(join(q, 'sub'), { recursive: true });
    const p = join(home, 'p');
    mkdirSync(p, { recursive: true });
    const link = join(p, 'link');
    if (!trySymlink(join(q, 'sub'), link)) {
      t.skip('本机不支持符号链接（EPERM/ENOSYS），等式面无法构造');
      return;
    }
    const alias = `${p}/link/../venv`; // 内核语义＝q/venv（`..` 在 link 解析之后回退）

    assert.notEqual(resolve(alias), resolve(current), '前置：path.resolve 文本折叠 → 两值不等');
    assert.equal(
      resolve(alias),
      join(p, 'venv'),
      '前置：文本把 `link/..` 折叠成 p（Node realpathSync 亦按文本折叠，故逐段解析是唯一可靠通道）'
    );
    assert.ok(!existsSync(resolve(alias)), '前置：文本解析结果 p/venv 并不存在（realpath/stat 均不可用）');
    // `realpathSync` 自己按**文本**折叠 `..`（Node v22 实测 `realpathSync('<p>/link/..') === '<p>'`），
    // 故它要么抛错、要么给内核真值——绝不能把文本折叠结果当成内核真值。
    let rawRealpath = null;
    try {
      rawRealpath = realpathSync(alias);
    } catch {
      rawRealpath = null;
    }
    assert.ok(
      rawRealpath === null || rawRealpath === realpathSync(current),
      `前置：realpathSync(别名) 只能是抛错或内核真值，实际 ${String(rawRealpath)}`
    );
    assert.notEqual(rawRealpath, resolve(alias), '前置：realpathSync 不得返回文本折叠结果');

    const { calls, remove } = makeRemoveStub();

    // 方向一：old 为真实拼写、current 为 `..` 别名拼写。
    let result = venv.cleanupOldVenv(current, 'delete', alias, { remove });
    assert.equal(result.action, 'none', 'old=q/venv 与 current=<p>/link/../venv 内核下同一目录 → 拒绝');
    assert.match(result.error, /同一实体/, '原因应指明同一实体（等式面按 canonical 判定）');

    // 方向二：old 为 `..` 别名拼写、current 为真实拼写（同一判定须双向成立）。
    result = venv.cleanupOldVenv(alias, 'delete', current, { remove });
    assert.equal(result.action, 'none', '反向拼写同样拒绝');
    assert.match(result.error, /同一实体/);

    assert.deepEqual(calls, [], '两向都零删除调用');
    assert.equal(existsSync(current), true, '在用 venv 原样保留');
    assert.equal(existsSync(join(current, 'pyvenv.cfg')), true, '在用 venv 内容未被触碰');
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 等式面之外的包含面——`..` 别名落在 old 之内（old=q、current=<p>/link/../venv）→ 拒绝（P0）', (t) => {
  const { home, restore } = useTmpHome();
  try {
    const q = makeMarkedVenv(home, 'q'); // 旧路径：合法 venv，且是在用 venv 的祖先
    const inUse = makeMarkedVenv(q, 'venv');
    mkdirSync(join(q, 'sub'), { recursive: true });
    const p = join(home, 'p');
    mkdirSync(p, { recursive: true });
    if (!trySymlink(join(q, 'sub'), join(p, 'link'))) {
      t.skip('本机不支持符号链接（EPERM/ENOSYS），包含面无法构造');
      return;
    }
    const aliasCurrent = `${p}/link/../venv`;

    assert.notEqual(resolve(aliasCurrent), resolve(inUse), '前置：文本折叠后与在用 venv 不等');
    assert.ok(!existsSync(resolve(aliasCurrent)), '前置：文本折叠结果 p/venv 不存在（realpath/stat 皆不可用）');
    assert.ok(!resolve(aliasCurrent).startsWith(resolve(q) + '/'), '前置：文本下 old 不包含 current');

    const { calls, remove } = makeRemoveStub();
    const result = venv.cleanupOldVenv(q, 'delete', aliasCurrent, { remove });

    assert.equal(result.action, 'none', 'canonical 下 q 包含 q/venv → 拒绝');
    assert.match(result.error, /前缀包含/);
    assert.deepEqual(calls, [], '零删除调用');
    assert.equal(existsSync(inUse), true, '在用 venv 必须保留');
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 包含面——`..` 别名的**文本折叠结果也存在**时仍按内核语义判定（realpath 快路径不得覆盖 `..`）', (t) => {
  const { home, restore } = useTmpHome();
  try {
    const q = makeMarkedVenv(home, 'q'); // 旧路径：合法 venv，同时是在用 venv 的祖先
    const inUse = makeMarkedVenv(q, 'venv');
    mkdirSync(join(q, 'sub'), { recursive: true });
    const p = join(home, 'p');
    mkdirSync(join(p, 'venv'), { recursive: true }); // 诱饵：文本折叠结果 `<p>/venv` 真实存在
    writeFileSync(join(p, 'venv', 'decoy.txt'), '诱饵目录\n');
    if (!trySymlink(join(q, 'sub'), join(p, 'link'))) {
      t.skip('本机不支持符号链接（EPERM/ENOSYS），包含面无法构造');
      return;
    }
    const aliasCurrent = `${p}/link/../venv`; // 内核语义＝q/venv；文本折叠＝p/venv（存在）

    // 前置：这正是"先 resolve 再 realpathSync"的快路径会给出 p/venv（文本答案）的陷阱形态。
    assert.equal(realpathSync(resolve(aliasCurrent)), join(p, 'venv'), '前置：文本折叠结果存在且可 realpath');
    assert.notEqual(realpathSync(resolve(aliasCurrent)), realpathSync(inUse), '前置：文本答案与内核答案不是同一目录');

    const { calls, remove } = makeRemoveStub();
    const result = venv.cleanupOldVenv(q, 'delete', aliasCurrent, { remove });

    assert.equal(result.action, 'none', '内核语义下 q 包含 q/venv → 必须拒绝删除');
    assert.match(result.error, /前缀包含/);
    assert.deepEqual(calls, [], '拒绝即零删除调用');
    assert.equal(existsSync(inUse), true, '本次在用的 venv 必须原样保留');
    assert.equal(existsSync(join(p, 'venv', 'decoy.txt')), true, '文本折叠落点的诱饵目录同样不得被误删');
  } finally {
    restore();
  }
});

test('cleanupOldVenv: canonical 不误拒——真·不同路径（current 为 `..` 别名拼写）仍 deleted、remove 收原值（P0）', (t) => {
  const { home, restore } = useTmpHome();
  try {
    const q = join(home, 'q');
    const realOld = makeMarkedVenv(q, 'venv-old'); // 旧 venv：真实拼写
    mkdirSync(join(q, 'sub'), { recursive: true });
    const p = join(home, 'p');
    mkdirSync(p, { recursive: true });
    if (!trySymlink(join(q, 'sub'), join(p, 'link'))) {
      t.skip('本机不支持符号链接（EPERM/ENOSYS），别名构造不可用');
      return;
    }
    // current 侧一律不读文件系统（条件③④只看 oldPath），故 `..` × 符号链接的别名拼写可以落在
    // current：内核语义＝q/other-venv（不存在），文本折叠＝p/other-venv——两者都不是 old、也都
    // 不与 old 互含，判定必须放行。（old 侧带符号链接 `..` 的拼写另有口径：条件③经 `join` 会
    // 文本折叠，故 old 侧的别名面由既有 1541 用例以非符号链接 `..` 钉住。）
    const aliasCurrent = `${p}/link/../other-venv`;
    assert.notEqual(resolve(aliasCurrent), resolve(realOld), '前置：文本两值不等');
    assert.ok(!existsSync(resolve(aliasCurrent)), '前置：文本折叠结果 p/other-venv 不存在');

    const { calls, remove } = makeRemoveStub();
    const result = venv.cleanupOldVenv(realOld, 'delete', aliasCurrent, { remove });

    assert.equal(result.action, 'deleted', '四条件齐备 + 真不同路径 → 照常删除（canonical 不得误拒）');
    assert.deepEqual(calls, [realOld], '删除原语收到的仍是调用方给的原值');
    assert.equal(existsSync(realOld), false, '旧 venv 删除确已生效');
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 段边界——非符号链接的 `..` 别名仍 deleted 且 remove 收原值（canonical 与内核语义同向）', () => {
  const { home, restore } = useTmpHome();
  try {
    const base = join(home, 'base');
    const realOld = makeMarkedVenv(base, 'venv-old');
    mkdirSync(join(base, 'sub'), { recursive: true }); // 真目录（非符号链接）：join/resolve 的文本折叠与内核一致
    const oldAlias = `${base}/sub/../venv-old`;
    const currentPath = join(base, 'venv-current');
    const { calls, remove } = makeRemoveStub();

    assert.equal(venv.venvExists(oldAlias), true, '前置：条件③在真目录 `..` 上为真（文本折叠＝内核语义）');
    const result = venv.cleanupOldVenv(oldAlias, 'delete', currentPath, { remove });

    assert.equal(result.action, 'deleted', '真目录 `..` 别名不是包含/同一实体 → 照常删除');
    assert.deepEqual(calls, [oldAlias], 'remove 收到调用方原值而非 canonical 结果');
    assert.equal(existsSync(realOld), false, '删除确已生效');
  } finally {
    restore();
  }
});

test('cleanupOldVenv: 段边界——兄弟目录 `venv` vs `venv-older` 仍 deleted（canonical 前缀不得退化成 startsWith）', () => {
  const { home, restore } = useTmpHome();
  try {
    for (const [oldName, currentName] of [['venv', 'venv-older'], ['venv-older', 'venv']]) {
      const oldPath = makeMarkedVenv(home, oldName);
      const sentinel = join(home, `${currentName}-keep.txt`);
      writeFileSync(sentinel, '当前侧哨兵\n');
      const { calls, remove } = makeRemoveStub();

      const result = venv.cleanupOldVenv(oldPath, 'delete', join(home, currentName), { remove });

      assert.equal(result.action, 'deleted', `${oldName} vs ${currentName}：带 \`-\` 后缀的兄弟目录不是包含关系`);
      assert.deepEqual(calls, [oldPath], '删除目标恰为旧路径');
      assert.equal(existsSync(oldPath), false, '旧目录被删');
      assert.equal(existsSync(sentinel), true, '当前侧文件不得被误删');
    }
  } finally {
    restore();
  }
});

// ─── R8（issue #16）：配置现读 ─────────────────────────────────────
//
// 卡片保存走宿主 `_commitVolatile()`：**原地换代引用、不重跑 apply**。因此凡把 volatile
// 叶子在 apply 期拍平成普通值并闭包捕获的路径都会永久陈旧（设计 R8 的机制）。
// `createVenvReader` 是这个边界的**唯一现读入口**：每次调用现 `.get()`，读失败回落创建期
// 快照——工具调用永远拿得到三字段普通值，且永远不会比 apply 时更差。

/** 最小 volatile 引用袋：`.get()` 闭包读一个可变的当前值（模拟宿主原地换代）。 */
function makeVenvRefBag(initial) {
  const state = { ...initial };
  const leaf = (key) => ({ get: () => state[key] });
  return {
    state,
    bag: {
      enabled: leaf('enabled'),
      path: leaf('path'),
      oldPathPolicy: leaf('oldPathPolicy'),
    },
  };
}

test('createVenvReader: 引用袋原地换代后，每次调用都读到新值（R8 的核心判据）', () => {
  const { state, bag } = makeVenvRefBag({ enabled: false, path: '/tmp/venv-a', oldPathPolicy: 'keep' });
  const read = venv.createVenvReader(bag);

  assert.deepEqual(read(), { enabled: false, path: '/tmp/venv-a', oldPathPolicy: 'keep' }, '首读＝当前值');
  state.enabled = true; // 模拟 updateVolatile：引用不变、值原地换代
  state.path = '/tmp/venv-b';
  state.oldPathPolicy = 'delete';
  assert.deepEqual(
    read(),
    { enabled: true, path: '/tmp/venv-b', oldPathPolicy: 'delete' },
    '同一 reader 第二次读必须看到换代后的值（拍平快照则恒为旧值）',
  );
});

test('createVenvReader: 缺省 / null 保持「未配置」语义，不补默认三字段', () => {
  assert.equal(venv.createVenvReader(undefined)(), undefined, 'undefined 原样（判定落 invalid）');
  assert.equal(venv.createVenvReader(null)(), null, 'null 是配置值而非缺省，原样保留');
});

test('createVenvReader: 普通值形态经归一化（非字面 true 的 enabled 一律 false）', () => {
  assert.deepEqual(
    venv.createVenvReader({ path: '/tmp/venv-c' })(),
    { enabled: false, path: '/tmp/venv-c', oldPathPolicy: 'keep' },
    '缺 enabled 的部分对象不得被当成已启用（G3-09 同判）',
  );
});

test('createVenvReader: 叶子 .get() 抛错 → 回落创建期快照，不把异常带进工具调用', () => {
  const state = { enabled: true, path: '/tmp/venv-d', oldPathPolicy: 'keep' };
  let boom = false;
  const bag = {
    enabled: { get: () => { if (boom) throw new Error('volatile leaf exploded'); return state.enabled; } },
    path: { get: () => state.path },
    oldPathPolicy: { get: () => state.oldPathPolicy },
  };
  const read = venv.createVenvReader(bag);

  assert.equal(read().enabled, true, '首次读成功');
  boom = true;
  assert.deepEqual(
    read(),
    { enabled: true, path: '/tmp/venv-d', oldPathPolicy: 'keep' },
    '读失败沿用创建期快照（total 函数：不得让配置读取异常打断工具执行）',
  );
});
