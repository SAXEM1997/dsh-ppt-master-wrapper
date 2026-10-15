import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

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

