import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main, parseArgs, writeLastSync } from '../scripts/sync-upstream.mjs';

/**
 * Task 13 契约：sync 流程编排（main(options, deps) → 退出码 0-7）。
 *
 * 测试策略——全部 stub deps、零网络：
 *  - `fetchTarball` stub：把 fixture 真实 tarball 复制到 dest，返回
 *    `{ bytesPath, contentLength }`（下载/解压分离契约：解压由编排经系统 tar 执行，
 *    二次磁盘预检因此可在解压前经 stub 的 contentLength 驱动）。
 *  - `runGit`：默认**不注入**（编排缺省实现跑真实 git）——fixture 用 tmp 目录构造
 *    真实仓库（init + 初始 commit + 本地 bare origin + upstream bare 标签），
 *    `file://` URL 驱动真实 `git ls-remote --tags`。仅 PAT/push 类用例注入 canned
 *    stub（避免真实网络推送）。
 *  - `runPython` / `runVerify` / `freeSpace`：全 stub。
 *
 * 覆盖退出码全集 0/1/2/3/4/5/6/7 与 brief「Step 1 测试全集」逐条对应（含「声明未测
 * 合集」五条补测中的四条 T13 侧用例）。
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
/** 上游解压树形态 fixture（仓库根：skills/ + .claude-plugin/marketplace.json）。 */
const UPSTREAM_TREE = join(FIXTURES, 'upstream-tree');
/** vendor 形态 fixture（旧版本 6.7.0，与 upstream-tree 有受控差异）。 */
const VENDOR_SKILLS = join(FIXTURES, 'vendor-tree', 'skills');
/** 与上游同内容 vendor 面（幂等/no-change 场景）。 */
const UPSTREAM_SKILLS = join(UPSTREAM_TREE, 'skills');

/** 充足磁盘（10GB）——freeSpace stub 默认值。 */
const HUGE_BYTES = 10 * 1024 * 1024 * 1024;

/** canned git 用例的假 sha（40 位 hex）。 */
const CANNED_SHA = '1111111111111111111111111111111111111111';
const CANNED_HEAD_SHA = '2222222222222222222222222222222222222222';
const CANNED_ORIGIN_URL = 'https://gitlab.example.com/zyx/dsh-wrapper-test.git';

// ─── 助手 ────────────────────────────────────────────────────────

/** 在 cwd 下执行 git（非零退出码直接抛错——fixture 只跑预期成功的命令）。 */
function gitIn(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 打一个真实 tarball（顶层目录 = sourceDir 的 basename，供 --strip-components=1）。 */
function buildTarball(sourceDir, tarPath) {
  execFileSync('tar', ['-czf', tarPath, '-C', dirname(sourceDir), basename(sourceDir)]);
  return tarPath;
}

/** 复制 fixture 并施加变更后打 tarball（marketplace 豁免等定制上游用）。 */
function customTarball(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-orch-tar-'));
  const copy = join(dir, 'upstream-tree');
  cpSync(UPSTREAM_TREE, copy, { recursive: true });
  mutate(copy);
  const tarPath = join(dir, 'upstream.tgz');
  buildTarball(copy, tarPath);
  return { tarPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** bare 仓库中某 tag 的 commit sha（经 ls-remote 主行解析）。 */
function tagShaOf(bare, tag) {
  const out = execFileSync('git', ['ls-remote', '--tags', bare], { encoding: 'utf8' });
  for (const line of out.split('\n')) {
    const [sha, ref] = line.trim().split('\t');
    if (ref === `refs/tags/${tag}`) return sha;
  }
  throw new Error(`fixture tag 缺失: ${tag}`);
}

/**
 * 构造一个完整编排场景：
 *  - 真实 git 工作仓库（初始 commit + .gitignore + package.json + 可选 vendor 面）；
 *  - 可选本地 bare origin（main 已 push -u，无 tag——远端 tag 预判的干净基线）；
 *  - 独立 upstream bare（带指定 release tag，作 `--repo` 的 ls-remote 来源）；
 *  - upstream-tree fixture 的真实 tarball（fetchTarball stub 的下载源）。
 */
function makeScenario({ vendorFrom = null, version = '6.7.0', origin = true, upstreamTags = ['v6.8.0'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sync-orch-repo-'));
  gitIn(root, ['init', '-q', '-b', 'main']);
  gitIn(root, ['config', 'user.email', 'test@example.com']);
  gitIn(root, ['config', 'user.name', 'Test']);
  writeFileSync(join(root, '.gitignore'), '.upstream/\n.skills-staging/\nsync-report.txt\n');
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'wrapper-test', version, type: 'module' }, null, 2)}\n`,
  );
  if (vendorFrom !== null) cpSync(vendorFrom, join(root, 'skills'), { recursive: true });
  gitIn(root, ['add', '-A']);
  gitIn(root, ['commit', '-q', '-m', 'init']);

  let originPath = null;
  if (origin) {
    originPath = `${root}.origin.git`;
    gitIn(root, ['init', '-q', '--bare', '-b', 'main', originPath]);
    gitIn(root, ['remote', 'add', 'origin', originPath]);
    gitIn(root, ['push', '-q', '-u', 'origin', 'main']);
  }

  const upstreamDir = mkdtempSync(join(tmpdir(), 'sync-orch-up-'));
  const upstreamBare = join(upstreamDir, 'upstream.git');
  gitIn(upstreamDir, ['init', '-q', '--bare', '-b', 'main', upstreamBare]);
  const seed = join(upstreamDir, 'seed');
  gitIn(upstreamDir, ['init', '-q', '-b', 'main', seed]);
  gitIn(seed, ['config', 'user.email', 'test@example.com']);
  gitIn(seed, ['config', 'user.name', 'Test']);
  writeFileSync(join(seed, 'README.md'), 'upstream seed\n');
  gitIn(seed, ['add', '-A']);
  gitIn(seed, ['commit', '-q', '-m', 'seed']);
  gitIn(seed, ['remote', 'add', 'origin', upstreamBare]);
  gitIn(seed, ['push', '-q', 'origin', 'main']);
  const upstreamMainShaOf = () =>
    execFileSync('git', ['--git-dir', upstreamBare, 'rev-parse', 'refs/heads/main'], {
      encoding: 'utf8',
    }).trim();
  const upstreamMainSha = upstreamMainShaOf();
  const tagShas = {};
  for (const tag of upstreamTags) {
    gitIn(seed, ['tag', tag]);
    gitIn(seed, ['push', '-q', 'origin', `refs/tags/${tag}`]);
    tagShas[tag] = tagShaOf(upstreamBare, tag);
  }

  const tarballPath = join(upstreamDir, 'upstream.tgz');
  buildTarball(UPSTREAM_TREE, tarballPath);

  return {
    root,
    originPath,
    upstreamBare,
    repoUrl: `file://${upstreamBare}`,
    tarballPath,
    tagShas,
    /** 上游 bare 的 branch main head sha（`--ref main` 的 ls-remote 解析对象）。 */
    upstreamMainSha,
    /** 在上游 seed 上追加一个 commit 并推送 → branch main head sha 前进，返回新 sha。 */
    advanceUpstreamMain() {
      writeFileSync(join(seed, `ADVANCE-${Date.now()}.md`), 'advance\n');
      gitIn(seed, ['add', '-A']);
      gitIn(seed, ['commit', '-q', '-m', 'advance main']);
      gitIn(seed, ['push', '-q', 'origin', 'main']);
      return upstreamMainShaOf();
    },
    /** 解压树路径（`.upstream/<cacheKey>/`）——runVerify upstream 参数的期望值。 */
    extractDirOf(tag = 'v6.8.0') {
      return join(root, '.upstream', `refs/tags/${tag}@${tagShas[tag]}`);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(upstreamDir, { recursive: true, force: true });
    },
  };
}

/**
 * stub deps 集合。缺省实现：fetch 复制 scenario tarball、guard 退出 0、verify 全绿
 * （skipGuard 时回显 T8 的「guard 未运行」警告语义）、磁盘充足；log/logError 为
 * 收集器（编排不直写 stdout——隔离式 node --test 子进程内直写会与 runner 报告流
 * 串流；输出断言从 calls.logs 取）。
 */
function stubDeps(overrides = {}) {
  const calls = { fetch: [], python: [], verify: [], git: [], logs: [] };
  const deps = {
    fetchTarball:
      overrides.fetchTarball ??
      (async (url, dest) => {
        calls.fetch.push({ url, dest });
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(overrides.tarballPath, dest);
        return { bytesPath: dest, contentLength: statSync(overrides.tarballPath).size };
      }),
    runPython:
      overrides.runPython ??
      (async (args, opts) => {
        calls.python.push({ args, opts });
        return { code: 0, stdout: '', stderr: '' };
      }),
    runVerify:
      overrides.runVerify ??
      (async (root, opts) => {
        calls.verify.push({ root, opts });
        return {
          problems: [],
          warnings:
            opts?.skipGuard === true ? ['guard 未运行（--skip-guard：python attribution_guard.py 未执行）'] : [],
        };
      }),
    freeSpace: overrides.freeSpace ?? (async () => HUGE_BYTES),
    now: overrides.now ?? (() => new Date('2026-10-14T12:00:00Z')),
    log: overrides.log ?? ((text) => calls.logs.push(text)),
    logError: overrides.logError ?? ((text) => calls.logs.push(text)),
  };
  calls.output = () => calls.logs.join('\n');
  if (overrides.runGit !== undefined) {
    deps.runGit = async (args, opts) => {
      const result = await overrides.runGit(args, opts);
      calls.git.push({ args, opts, result });
      return result;
    };
  }
  return { deps, calls };
}

/**
 * canned git stub：matchers 命中即返回；缺省——tag 存在探测 1（不存在）、@{u} 探测
 * 128 fatal（走回退分支）、rev-parse HEAD 假 sha、ls-remote 空清单、其余成功。
 */
function cannedGit(matchers = []) {
  return async (args) => {
    for (const matcher of matchers) {
      if (matcher.match(args)) {
        return typeof matcher.resp === 'function' ? matcher.resp(args) : matcher.resp;
      }
    }
    if (args[0] === 'rev-parse' && args.includes('--verify')) return { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      return { code: 128, stdout: '', stderr: 'fatal: no upstream configured for branch main' };
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { code: 0, stdout: CANNED_HEAD_SHA, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

/**
 * 真实 git 的捕获式封装（部分注入 runGit 的用例把未匹配调用委托回真实 git）：
 * 非零退出码不抛错、原样返回 `{code, stdout, stderr}`。
 */
async function realGitResult(args, opts = {}) {
  try {
    const stdout = execFileSync('git', args, {
      cwd: opts.cwd ?? process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** 读取 last-sync.json 原始 JSON（at 不可注入——断言放宽为可解析，其余字段精确）。 */
function readLastSyncRaw(root) {
  const file = join(root, '.upstream', 'last-sync.json');
  assert.equal(existsSync(file), true, `last-sync.json 应存在: ${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

const commitCount = (root) => Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
const tagList = (root) => execFileSync('git', ['tag', '-l'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const headSha = (root) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const originMainSha = (originPath) =>
  execFileSync('git', ['--git-dir', originPath, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim();

/** 递归收集目录下全部文件绝对路径（PAT 残留扫描用）。 */
function walkAllFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walkAllFiles(path));
    else files.push(path);
  }
  return files;
}

/** 临时设置/删除环境变量，结束后恢复。 */
function withEnv(name, value, fn) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return fn().finally(() => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  });
}

// ─── 退出码 1：用法错误 ───────────────────────────────────────────

test('usage：--skip-guard 默认推送 → 退出码 1（Review Focus #5）', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'sync-orch-usage-'));
  try {
    const { deps, calls } = stubDeps({ tarballPath: 'unused' });
    const code = await main({ ...parseArgs(['--skip-guard']), root: tmpRoot }, deps);
    assert.equal(code, 1);
    // UltraReview #26：USAGE_TEXT 的联用措辞为「须至少与…之一联用」。
    assert.match(calls.output(), /须至少与 --no-push 或 --dry-run 之一联用/);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('usage：非法 --ref（短 sha）→ normalizeRef usageError → 退出码 1', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'sync-orch-usage-'));
  try {
    const { deps } = stubDeps({ tarballPath: 'unused' });
    const code = await main({ ref: 'abc123', root: tmpRoot }, deps);
    assert.equal(code, 1);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── 退出码 5：环境失败（来源/网络/磁盘） ──────────────────────────

// ─── git 工具链预检（UltraReview Fix #4）：spawn 级失败 → 退出码 7 ──
//
// 此前 git 二进制缺失（spawn ENOENT）在首个真实 git 调用（ls-remote）处以
// 未分类异常冒泡到 CLI 入口 → 「未预期的失败（退出码 5）」+ 原始堆栈。工具链
// 缺失属解释器级失败族（与 python3 ENOENT → 7 同族），应报 7 且不带堆栈。

test('git 工具链缺失（spawn ENOENT）→ 退出码 7 且输出含「git」「工具链」，无原始堆栈', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS });
  try {
    const { deps, calls } = stubDeps({
      tarballPath: s.tarballPath,
      runGit: async () => {
        const error = new Error('spawn git ENOENT');
        error.code = 'ENOENT';
        throw error;
      },
    });
    const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
    assert.equal(code, 7, 'spawn 级 git 失败 = 工具链缺失 = 解释器级失败族（退出码 7）');
    assert.match(calls.output(), /git/);
    assert.match(calls.output(), /工具链/);
    assert.doesNotMatch(calls.output(), /ENOENT/, '不回显原始 spawn 错误（无堆栈/裸错误）');
    assert.doesNotMatch(calls.output(), /\n\s+at\s/, '绝不输出原始堆栈');
    assert.equal(calls.fetch.length, 0, '预检失败不得进入下载');
  } finally {
    s.cleanup();
  }
});

test('git 预检：--version 非零退出不视为工具链缺失（流程照常继续）', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS });
  try {
    const { deps, calls } = stubDeps({
      tarballPath: s.tarballPath,
      // --version 返回非零（git 在场但命令异常）→ 不判 7，其余调用走真实 git，
      // 流程照常走到结构检测（🔴 second-skill）→ 退出码 2。
      runGit: async (args, opts) => {
        if (args[0] !== undefined && args[0] === '--version') {
          return { code: 1, stdout: '', stderr: 'weird git' };
        }
        return realGitResult(args, opts);
      },
    });
    const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
    assert.equal(code, 2, '预检只认 spawn 级失败；非零退出的 git 继续原流程');
    assert.doesNotMatch(calls.output(), /工具链/);
  } finally {
    s.cleanup();
  }
});

test('无匹配 release tag → 退出码 5 且错误指引用 --ref', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS, upstreamTags: [] });
  try {
      const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
      const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
      assert.equal(code, 5);
      assert.match(calls.output(), /--ref/);
      assert.equal(calls.fetch.length, 0, '无 tag 时不应下载');
  } finally {
    s.cleanup();
  }
});

test('仅存在非 semver tag（rc 形态不匹配 ^v?\\d+\\.\\d+\\.\\d+$）→ 同样退出码 5', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS, upstreamTags: ['v6.8.0-rc1'] });
  try {
    const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
    const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
    assert.equal(code, 5);
    assert.equal(calls.fetch.length, 0, 'rc tag 不算 release tag，不应下载');
  } finally {
    s.cleanup();
  }
});

test('网络失败：fetchTarball 抛错 → 退出码 5', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS });
  try {
    const { deps, calls } = stubDeps({
      tarballPath: s.tarballPath,
      fetchTarball: async () => {
        throw new Error('getaddrinfo ENOTFOUND codeload.github.com');
      },
    });
    const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
    assert.equal(code, 5);
  } finally {
    s.cleanup();
  }
});

test('启动磁盘预检不足 → 退出码 5（下载前拦截）', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS });
  try {
    const { deps, calls } = stubDeps({
      tarballPath: s.tarballPath,
      freeSpace: async () => 100 * 1024 * 1024,
    });
    const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
    assert.equal(code, 5);
    assert.equal(calls.fetch.length, 0, '启动预检不足时不应下载');
  } finally {
    s.cleanup();
  }
});

test('二次磁盘预检不足（拉取后、解压前）→ 退出码 5 且不解压', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS });
  try {
    const { deps, calls } = stubDeps({
      tarballPath: s.tarballPath,
      // 300MB：过启动阈值 260MB；二次预算 = 300MB(tarball 谎报) + 114 + 78 > 300MB → 拦截。
      freeSpace: async () => 300 * 1024 * 1024,
      fetchTarball: async (url, dest) => {
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(s.tarballPath, dest);
        return { bytesPath: dest, contentLength: 300 * 1024 * 1024 };
      },
    });
    const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
    assert.equal(code, 5);
    assert.equal(existsSync(s.extractDirOf('v6.8.0')), false, '二次预检不足时不得解压');
  } finally {
    s.cleanup();
  }
});

test('ls-remote 本身失败（git exit 128）→ 退出码 5', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS, origin: false });
  try {
    const { deps, calls } = stubDeps({
      tarballPath: s.tarballPath,
      runGit: cannedGit([
        {
          match: (args) => args[0] === 'ls-remote',
          resp: { code: 128, stdout: '', stderr: 'fatal: unable to access' },
        },
      ]),
    });
    const code = await main({ root: s.root, repo: 'https://github.com/fake/up.git', noPush: true }, deps);
    assert.equal(code, 5);
  } finally {
    s.cleanup();
  }
});

// ─── 退出码 3 / 7：完整性门 ───────────────────────────────────────

test('guard 业务判定失败（退出码 78）→ 退出码 3；guard 逐 skill 调用形态正确', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS });
  try {
    const { deps, calls } = stubDeps({
      tarballPath: s.tarballPath,
      runPython: async (args, opts) => {
        calls.python.push({ args, opts });
        return { code: 78, stdout: '', stderr: 'license digest mismatch' };
      },
    });
    const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
    assert.equal(code, 3);
    assert.equal(calls.python.length, 1, '当前 fixture 仅 ppt-master 一个 skill');
    assert.equal(calls.python[0].args[0], join('.skills-staging', 'ppt-master', 'scripts', 'attribution_guard.py'));
    assert.equal(calls.python[0].opts?.cwd, s.root);
    // last-sync 写入时机：拉取成功即写 ref/sha（guard 失败发生在其后）。
    const raw = readLastSyncRaw(s.root);
    assert.equal(raw.ref, 'refs/tags/v6.8.0');
    assert.equal(raw.sha, s.tagShas['v6.8.0']);
    assert.equal(Number.isNaN(Date.parse(raw.at)), false, 'at 应可解析');
  } finally {
    s.cleanup();
  }
});

test('python 解释器级失败（spawn ENOENT）→ 退出码 7（不 --skip-guard）', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS });
  try {
    const { deps, calls } = stubDeps({
      tarballPath: s.tarballPath,
      runPython: async () => {
        const error = new Error('spawn python3 ENOENT');
        error.code = 'ENOENT';
        throw error;
      },
    });
    const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
    assert.equal(code, 7);
  } finally {
    s.cleanup();
  }
});

// ─── 退出码 4：verify 前置失败 ────────────────────────────────────

test('verify problems 非空 → 退出码 4 且 vendor 树未变（替换未发生）', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS });
  try {
    const vendorSkillFile = join(s.root, 'skills', 'ppt-master', 'SKILL.md');
    const before = readFileSync(vendorSkillFile, 'utf8');
    const { deps, calls } = stubDeps({
      tarballPath: s.tarballPath,
      runVerify: async () => ({ problems: ['[ppt-master] 与 upstream 逐字节不一致: SKILL.md'], warnings: [] }),
    });
    const code = await main({ root: s.root, repo: s.repoUrl, confirmStructural: true, noPush: true }, deps);
    assert.equal(code, 4);
    assert.equal(readFileSync(vendorSkillFile, 'utf8'), before, 'verify 失败不得触碰 vendor 树');
    assert.equal(existsSync(join(s.root, 'skills', 'second-skill')), false, '替换不得发生');
    // last-sync 拉取时机：verify 失败发生在其后，ref/sha 已落盘。
    const raw = readLastSyncRaw(s.root);
    assert.equal(raw.ref, 'refs/tags/v6.8.0');
    assert.equal(raw.sha, s.tagShas['v6.8.0']);
  } finally {
    s.cleanup();
  }
});

// ─── verify 接线：upstream 显式传参 + skipGuard 标记 ───────────────

test('runVerify 以 { skipGuard, upstream: <解压树路径> } 被调用（upstream 必须显式传）', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS });
  try {
    const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
    const code = await main({ root: s.root, repo: s.repoUrl, confirmStructural: true, noPush: true }, deps);
    assert.equal(code, 0);
    assert.equal(calls.verify.length, 1);
    assert.equal(calls.verify[0].root, join(s.root, '.skills-staging'));
    assert.equal(calls.verify[0].opts?.upstream, s.extractDirOf('v6.8.0'), '漏传 upstream 会恒 exit 4');
    assert.notEqual(calls.verify[0].opts?.skipGuard, true);
  } finally {
    s.cleanup();
  }
});

test('--skip-guard --no-push：verify 收到 skipGuard 标记，guard 不执行，警告回显', async () => {
  const s = makeScenario({ vendorFrom: UPSTREAM_SKILLS, version: '6.8.0' });
  try {
      const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
      const code = await main(
        { ...parseArgs(['--skip-guard', '--no-push', '--repo', s.repoUrl]), root: s.root },
        deps,
      );
      assert.equal(code, 0);
      assert.equal(calls.python.length, 0, '--skip-guard 跳过 guard 执行');
      assert.equal(calls.verify.length, 1);
      assert.equal(calls.verify[0].opts?.skipGuard, true);
      assert.equal(calls.verify[0].opts?.upstream, s.extractDirOf('v6.8.0'));
      assert.match(calls.output(), /guard 未运行/);
  } finally {
    s.cleanup();
  }
});

// ─── 退出码 2：结构变化路径 ───────────────────────────────────────

test('结构变化（上游多 skill fixture）→ 退出码 2 + sync-report.txt 写入 + last-sync 先写 ref/sha', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS });
  try {
    const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
    const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
    assert.equal(code, 2);
    const report = join(s.root, 'sync-report.txt');
    assert.equal(existsSync(report), true, '结构路径也写 sync-report.txt');
    assert.match(readFileSync(report, 'utf8'), /second-skill/, '报告应含 🔴 结构变化明细');
    // exit 2 路径也先写 ref/sha（--confirm-structural 重跑固定 ref 有值可取）；
    // 无 wrapper commit → head 不写（保持无基线语义）。
    const raw = readLastSyncRaw(s.root);
    assert.equal(raw.ref, 'refs/tags/v6.8.0');
    assert.equal(raw.sha, s.tagShas['v6.8.0']);
    assert.equal(raw.head, '', 'exit 2 无 wrapper commit，不写 head 基线');
    assert.equal(commitCount(s.root), 1, '结构路径不 commit');
  } finally {
    s.cleanup();
  }
});

// ─── --confirm-structural 强制自动路径 → 0 ───────────────────────

test('--confirm-structural：🔴 存在时强制走自动路径 → 替换/bump/commit/tag → 退出码 0', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS });
  try {
    const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
    const code = await main({ root: s.root, repo: s.repoUrl, confirmStructural: true, noPush: true }, deps);
    assert.equal(code, 0);
    // 替换：新 skill 目录落地，vendor 面与上游一致。
    assert.equal(existsSync(join(s.root, 'skills', 'second-skill', 'SKILL.md')), true);
    // bump：package.json version 由 6.7.0 → 6.8.0（规则①）。
    assert.equal(JSON.parse(readFileSync(join(s.root, 'package.json'), 'utf8')).version, '6.8.0');
    // last-sync：version+head 于 wrapper commit 完成点更新；ref/sha 精确。
    const raw = readLastSyncRaw(s.root);
    assert.equal(raw.ref, 'refs/tags/v6.8.0');
    assert.equal(raw.sha, s.tagShas['v6.8.0']);
    assert.equal(raw.version, '6.8.0');
    assert.equal(raw.head, headSha(s.root), 'head = wrapper commit 后的 HEAD（包装层基线）');
    // commit + tag（--no-push 仍创建本地 tag）。
    assert.equal(commitCount(s.root), 2, '自动路径产生一个同步 commit');
    assert.deepEqual(tagList(s.root), ['v6.8.0']);
    // sync-report 成功路径写入 + staging 清理（spec §4.1 步骤 6 末尾动作）。
    assert.equal(existsSync(join(s.root, 'sync-report.txt')), true);
    assert.equal(existsSync(join(s.root, '.skills-staging')), false, '成功路径末尾清理 staging');
  } finally {
    s.cleanup();
  }
});

// ─── ref 缺省回退：--confirm-structural 固定上次 ref ───────────────

test('ref 回退：--confirm-structural 固定 **branch** ref（sha 不可得记录的可读性回归）', async () => {
  // P1-②：branch ref 的 refSha 恒为 null，writeLastSync 落 `sha: ''`；此前
  // readLastSync 要求 sha 非空，整条记录被判 null → 回退分支走不到，
  // --confirm-structural 静默回落最新 tag（违反 spec §4.1 步骤 7）。本用例固定
  // 「branch 记录写入即不可读」这一回归：重跑必须取记录的 branch ref。
  const s = makeScenario({ vendorFrom: UPSTREAM_SKILLS, version: '6.8.0' });
  try {
    // 先跑一次 --ref main 让编排自己写记录（sha 不可得 → 空串），再重跑确认可读。
    const { deps: depsFirst, calls: callsFirst } = stubDeps({ tarballPath: s.tarballPath });
    const codeFirst = await main(
      { root: s.root, repo: s.repoUrl, ref: 'main', confirmStructural: true, noPush: true },
      depsFirst,
    );
    assert.equal(codeFirst, 0);
    assert.equal(callsFirst.fetch.length, 1);
    assert.ok(
      callsFirst.fetch[0].url.endsWith('/tar.gz/refs/heads/main'),
      `首次 --ref main 应取 branch ref: ${callsFirst.fetch[0].url}`,
    );
    const recorded = readLastSyncRaw(s.root);
    assert.equal(recorded.ref, 'refs/heads/main', '记录 ref 为 branch 形态');
    // Fix #3 后 branch head sha 经 ls-remote 解析落盘（不再恒空串）——「branch 记录
    // 写入即不可读」的回归由 ref 可读性断言本身固定（空串形态的读取宽容语义另由
    // sync-parse 的 last-sync 用例覆盖）。
    assert.equal(recorded.sha, s.upstreamMainSha, 'branch ref 的 sha 落解析出的 head sha');

    // 重跑：带 --refresh 强制再拉（否则缓存复用不调 fetchTarball），不带 --ref。
    const { deps: depsAgain, calls: callsAgain } = stubDeps({ tarballPath: s.tarballPath });
    const codeAgain = await main(
      { root: s.root, repo: s.repoUrl, confirmStructural: true, refresh: true, noPush: true },
      depsAgain,
    );
    assert.equal(codeAgain, 0);
    assert.equal(callsAgain.fetch.length, 1, '--refresh 绕过缓存 → 必调 fetchTarball');
    assert.ok(
      callsAgain.fetch[0].url.endsWith('/tar.gz/refs/heads/main'),
      `--confirm-structural 必须固定记录的 branch ref，实际: ${callsAgain.fetch[0].url}`,
    );
    assert.match(callsAgain.output(), /固定上次检出 ref refs\/heads\/main/);
  } finally {
    s.cleanup();
  }
});

test('branch ref 重跑：sha 不可得不得误判幂等同 ref（cacheKey 走 no-sha 且继续同步）', async () => {
  // sameRefSha 比对 `previousSync.sha === (refSha ?? '')`：branch 侧 previousSync.sha
  // 现在是 null、refSha 仍是 null → null === '' 为 false，正确地**不**判同 ref。
  // 若把 null 归一成 '' 就会误命中幂等短路，把应同步的变更吞掉。
  const s = makeScenario({ vendorFrom: UPSTREAM_SKILLS, version: '6.7.0' });
  try {
    writeLastSync({ ref: 'refs/heads/main', sha: '', version: '6.7.0' }, s.root);
    // Fix #3 后真实链路会解析出 branch head sha；本用例固定的是「sha 解析失败」
    // 的兜底语义 → 拦截 branch-head ls-remote 返回空（远端解析不到）。
    const { deps, calls } = stubDeps({
      tarballPath: s.tarballPath,
      runGit: async (args, opts) => {
        if (args[0] === 'ls-remote' && args[1] === s.repoUrl && args[2] === 'refs/heads/main') {
          return { code: 0, stdout: '', stderr: '' };
        }
        return realGitResult(args, opts);
      },
    });
    const code = await main(
      { root: s.root, repo: s.repoUrl, ref: 'main', refresh: true, noPush: true },
      deps,
    );
    assert.equal(code, 0);
    // sha 不可得 → 缓存键回落 'no-sha'（分支 ref 的既定缓存语义）。
    assert.ok(
      calls.fetch[0].dest.includes('refs/heads/main@no-sha'),
      `branch ref 缓存键应为 no-sha 形态: ${calls.fetch[0].dest}`,
    );
    // 未误判幂等：真的走完了同步（版本按上游 6.8.0 落位 = 规则①）。
    assert.equal(JSON.parse(readFileSync(join(s.root, 'package.json'), 'utf8')).version, '6.8.0');
    assert.doesNotMatch(calls.output(), /already up to date/, 'sha 不可得不得被判同 ref');
  } finally {
    s.cleanup();
  }
});

// ─── branch ref 的 head sha 解析（UltraReview Fix #3）──────────────
//
// 此前 `--ref <branch>` 的 refSha 恒 null → cacheKey 恒 `<branch>@no-sha`：
// 上游 branch 前进（head sha 变化）缓存**永不失效**，last-sync.sha 也恒空。
// 修复：解析阶段对 refs/heads/ 前缀 ref 增补 `git ls-remote <repo> refs/heads/<name>`，
// 首行 sha 纳入 cacheKey 与 last-sync.sha；解析不到 → log 警告 + 维持 no-sha 现状。

test('branch ref（Fix #3）：--ref main 首跑缓存键与 last-sync.sha 均含上游 head sha', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS, version: '6.7.0' });
  try {
    const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
    const code = await main(
      { root: s.root, repo: s.repoUrl, ref: 'main', confirmStructural: true, noPush: true },
      deps,
    );
    assert.equal(code, 0);
    assert.equal(calls.fetch.length, 1);
    assert.ok(
      calls.fetch[0].dest.includes(`refs/heads/main@${s.upstreamMainSha}`),
      `缓存键应含 branch head sha（而非 no-sha）: ${calls.fetch[0].dest}`,
    );
    const raw = readLastSyncRaw(s.root);
    assert.equal(raw.sha, s.upstreamMainSha, 'last-sync.sha 落 branch head sha');
    assert.doesNotMatch(calls.output(), /branch head sha 未能解析/);
  } finally {
    s.cleanup();
  }
});

test('branch ref（Fix #3）：上游 branch 前进（head sha 变）→ cacheKey 变化 → 重新下载', async () => {
  const s = makeScenario({ vendorFrom: UPSTREAM_SKILLS, version: '6.8.0' });
  try {
    const depsA = stubDeps({ tarballPath: s.tarballPath });
    const codeA = await main({ root: s.root, repo: s.repoUrl, ref: 'main', noPush: true }, depsA.deps);
    assert.equal(codeA, 0);
    assert.ok(depsA.calls.fetch[0].dest.includes(`refs/heads/main@${s.upstreamMainSha}`));

    // 上游 branch 前进：seed 追加 commit 并推送 → head sha 变化。
    const advancedSha = s.advanceUpstreamMain();
    assert.notEqual(advancedSha, s.upstreamMainSha, '前置：head sha 确已前进');

    const depsB = stubDeps({ tarballPath: s.tarballPath });
    const codeB = await main({ root: s.root, repo: s.repoUrl, ref: 'main', noPush: true }, depsB.deps);
    assert.equal(codeB, 0);
    assert.equal(depsB.calls.fetch.length, 1, '缓存键随 head sha 变化 → 必须重新下载（而非复用 no-sha 旧缓存）');
    assert.ok(
      depsB.calls.fetch[0].dest.includes(`refs/heads/main@${advancedSha}`),
      `新缓存键应含前进后的 sha: ${depsB.calls.fetch[0].dest}`,
    );
  } finally {
    s.cleanup();
  }
});

test('branch ref（Fix #3）：head sha 解析失败（ls-remote 空输出）→ 警告 + no-sha 键留存', async () => {
  const s = makeScenario({ vendorFrom: UPSTREAM_SKILLS, version: '6.7.0' });
  try {
    const { deps, calls } = stubDeps({
      tarballPath: s.tarballPath,
      runGit: async (args, opts) => {
        if (args[0] === 'ls-remote' && args[1] === s.repoUrl && args[2] === 'refs/heads/main') {
          return { code: 0, stdout: '', stderr: '' };
        }
        return realGitResult(args, opts);
      },
    });
    const code = await main({ root: s.root, repo: s.repoUrl, ref: 'main', refresh: true, noPush: true }, deps);
    assert.equal(code, 0);
    assert.match(calls.output(), /branch head sha 未能解析/, '解析失败必须 log 警告');
    assert.match(calls.output(), /无 sha 键/, '警告须说明缓存将以无 sha 键留存');
    assert.ok(
      calls.fetch[0].dest.includes('refs/heads/main@no-sha'),
      `解析失败维持 no-sha 现状: ${calls.fetch[0].dest}`,
    );
    assert.equal(readLastSyncRaw(s.root).sha, '', 'sha 不可得 → last-sync.sha 空串');
  } finally {
    s.cleanup();
  }
});

test('ref 回退：--confirm-structural 且未传 --ref → fetchTarball 收到 last-sync 记录 ref；对照：不带则取最新 tag', async () => {
  const s = makeScenario({ vendorFrom: UPSTREAM_SKILLS, version: '6.8.0' });
  try {
    writeLastSync({ ref: 'refs/tags/v6.7.0', sha: '7'.repeat(40), version: '6.7.0' }, s.root);
    const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
    const code = await main({ root: s.root, repo: s.repoUrl, confirmStructural: true, noPush: true }, deps);
    assert.equal(code, 0);
    assert.equal(calls.fetch.length, 1);
    assert.ok(calls.fetch[0].url.endsWith('/tar.gz/refs/tags/v6.7.0'), `回退应取记录 ref: ${calls.fetch[0].url}`);

    // 对照用例：不带 --confirm-structural 重跑不传 --ref → 正常解析最新 tag。
    const code2 = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
    assert.equal(code2, 0);
    assert.equal(calls.fetch.length, 2);
    assert.ok(calls.fetch[1].url.endsWith('/tar.gz/refs/tags/v6.8.0'), `对照应取最新 tag: ${calls.fetch[1].url}`);
  } finally {
    s.cleanup();
  }
});

// ─── 幂等（退出码 0 短路 + 两禁用触发 + 回退分支） ─────────────────

test('幂等命中：ref sha 相同 + 树无 diff + 无包装层待发布 → 0 且未跑 guard/verify', async () => {
  const s = makeScenario({ vendorFrom: UPSTREAM_SKILLS, version: '6.8.0' });
  try {
    writeLastSync({ ref: 'refs/tags/v6.8.0', sha: s.tagShas['v6.8.0'], version: '6.8.0' }, s.root);
      const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
      const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
      assert.equal(code, 0);
      assert.equal(calls.python.length, 0, '幂等短路不跑 guard');
      assert.equal(calls.verify.length, 0, '幂等短路不跑 verify');
      assert.match(calls.output(), /already up to date/);
      assert.equal(commitCount(s.root), 1, '无空提交');
      assert.deepEqual(tagList(s.root), []);
  } finally {
    s.cleanup();
  }
});

test('幂等禁用②：存在未推送的包装层提交 → 不短路，规则③ bump -r+1', async () => {
  const s = makeScenario({ vendorFrom: UPSTREAM_SKILLS, version: '6.8.0' });
  try {
    writeLastSync({ ref: 'refs/tags/v6.8.0', sha: s.tagShas['v6.8.0'], version: '6.8.0' }, s.root);
    // 未推送的包装层提交（@{u}..HEAD 触及 lib/ 包装层文件）。
    mkdirSync(join(s.root, 'lib'), { recursive: true });
    writeFileSync(join(s.root, 'lib', 'foo.js'), 'export {};\n');
    gitIn(s.root, ['add', '-A']);
    gitIn(s.root, ['commit', '-q', '-m', 'wrapper change']);

    const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
    const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
    assert.equal(code, 0);
    assert.equal(calls.verify.length, 1, '未短路：verify 照常执行');
    assert.equal(JSON.parse(readFileSync(join(s.root, 'package.json'), 'utf8')).version, '6.8.0-r1', '规则③ -r+1');
    assert.equal(commitCount(s.root), 3, 'init + 包装层 commit + 同步 commit');
    assert.deepEqual(tagList(s.root), ['v6.8.0-r1']);
  } finally {
    s.cleanup();
  }
});

test('幂等禁用①：工作区相对 HEAD 有包装层 diff（未提交）→ 不短路', async () => {
  const s = makeScenario({ vendorFrom: UPSTREAM_SKILLS, version: '6.8.0' });
  try {
    writeLastSync({ ref: 'refs/tags/v6.8.0', sha: s.tagShas['v6.8.0'], version: '6.8.0' }, s.root);
    // 未提交的包装层工作区变更——不得被幂等短路吞掉（spec §4.1 步骤 8 明文）。
    mkdirSync(join(s.root, 'lib'), { recursive: true });
    writeFileSync(join(s.root, 'lib', 'foo.js'), 'export {};\n');

      const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
      const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
      assert.equal(code, 0);
      assert.equal(calls.verify.length, 1, '未短路：verify 照常执行');
      assert.equal(calls.python.length, 2, '未短路：guard 逐 skill 执行（fixture = ppt-master + second-skill）');
      // wrapperPending 只认未推送提交——工作区未提交变更不触发自动 bump（规则③由脚本自动执行，判据为已提交的未推送包装层提交）。
      assert.equal(commitCount(s.root), 1, 'no-change：不产生空提交');
      assert.equal(JSON.parse(readFileSync(join(s.root, 'package.json'), 'utf8')).version, '6.8.0');
      assert.match(calls.output(), /包装层/);
  } finally {
    s.cleanup();
  }
});

// ─── 规则③自触发修复（UltraReview Fix #1）：同步 commit 不算「未推送包装层提交」──
//
// `--no-push` 复核后正式跑（或重跑）时，上次同步 commit 自身（触碰 package.json）
// 位于 @{u}..HEAD 内且过 isWrapperPath——被误判 wrapperPending=true → 规则③
// double-bump。修复：待发布 = @{u}..HEAD 中**晚于 last-sync.head** 的提交（同步
// commit 即 last-sync.head 本身，被区间排除）；锚缺失/非祖先 → 维持全部计入。

test('规则③自触发（Fix #1）：--no-push 同步后立即重跑 → 同步 commit 被锚定排除 → 幂等短路不 double-bump', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS, version: '6.7.0' });
  try {
    // 首跑：--no-push 自动路径 → sync commit（未推送、触碰 package.json）+ tag。
    const depsA = stubDeps({ tarballPath: s.tarballPath });
    const codeA = await main(
      { root: s.root, repo: s.repoUrl, confirmStructural: true, noPush: true },
      depsA.deps,
    );
    assert.equal(codeA, 0);
    assert.equal(JSON.parse(readFileSync(join(s.root, 'package.json'), 'utf8')).version, '6.8.0');
    assert.equal(commitCount(s.root), 2, 'init + 同步 commit');

    // 重跑（不带 --ref）：sameRefSha + vendorDiff=false；同步 commit 虽在 @{u}..HEAD
    // 内（未推送、package.json 为包装层文件）但 = last-sync.head → 必须排除 →
    // wrapperPending=false → 幂等短路（否则规则③ double-bump 6.8.0-r1）。
    const depsB = stubDeps({ tarballPath: s.tarballPath });
    const codeB = await main({ root: s.root, repo: s.repoUrl }, depsB.deps);
    assert.equal(codeB, 0);
    assert.match(depsB.calls.output(), /already up to date/);
    assert.equal(depsB.calls.verify.length, 0, '不 double-bump：不进自动路径');
    assert.equal(JSON.parse(readFileSync(join(s.root, 'package.json'), 'utf8')).version, '6.8.0', '版本不得 double-bump');
    assert.equal(commitCount(s.root), 2, '不得再产生同步 commit');
    assert.deepEqual(tagList(s.root), ['v6.8.0'], '不得再产生 -r1 tag');
  } finally {
    s.cleanup();
  }
});

test('规则③保留语义（Fix #1）：--no-push 后开发者提交包装层文件 → 重跑 wrapperPending=true → 规则③ bump', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS, version: '6.7.0' });
  try {
    const depsA = stubDeps({ tarballPath: s.tarballPath });
    const codeA = await main(
      { root: s.root, repo: s.repoUrl, confirmStructural: true, noPush: true },
      depsA.deps,
    );
    assert.equal(codeA, 0);

    // 同步 commit 之后，开发者另提交一个包装层文件（晚于 last-sync.head 锚）。
    mkdirSync(join(s.root, 'lib'), { recursive: true });
    writeFileSync(join(s.root, 'lib', 'foo.js'), 'export {};\n');
    gitIn(s.root, ['add', '-A']);
    gitIn(s.root, ['commit', '-q', '-m', 'wrapper change']);

    const depsB = stubDeps({ tarballPath: s.tarballPath });
    const codeB = await main({ root: s.root, repo: s.repoUrl, noPush: true }, depsB.deps);
    assert.equal(codeB, 0);
    assert.equal(depsB.calls.verify.length, 1, '锚只排除同步 commit 自身——后续包装层提交仍触发');
    assert.equal(JSON.parse(readFileSync(join(s.root, 'package.json'), 'utf8')).version, '6.8.0-r1', '规则③ -r+1');
    assert.equal(commitCount(s.root), 4, 'init + 同步 + 开发者 + 第二次同步 commit');
    assert.deepEqual(tagList(s.root), ['v6.8.0', 'v6.8.0-r1']);
  } finally {
    s.cleanup();
  }
});

// ─── push 部分失败修复（UltraReview Fix #2）：幂等短路前补推缺失的发布 tag ──
//
// push 两段（main + tag）中 main 成功、tag 被拒（exit 6）后重跑：sameRefSha +
// vendorDiff=false + wrapperPending=false 全中 → 被幂等短路吞掉，本地已就绪的
// tag 永不发布。修复：短路 return 前——本地 tag 存在且 origin ls-remote 无该
// tag → 补推该 tag 后再短路；本地 tag 不存在 / 远端已有 → 照常短路。

/** Fix #2 场景的 runGit：origin 侧查询 canned、其余委托真实 git；push 记录并成功。 */
function backPushRunGit(originUrl, pushes, originTagsStdout = '') {
  return async (args, opts) => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return { code: 0, stdout: `${originUrl}\n`, stderr: '' };
    }
    if (args[0] === 'ls-remote' && args[2] === originUrl) {
      return { code: 0, stdout: originTagsStdout, stderr: '' };
    }
    if (args[0] === 'push') {
      pushes.push(args);
      return { code: 0, stdout: '', stderr: '' };
    }
    return realGitResult(args, opts);
  };
}

test('push 部分失败修复（Fix #2）：main 已推 tag 未推 → 重跑幂等短路前补推缺失 tag → exit 0', async () => {
  const s = makeScenario({ vendorFrom: UPSTREAM_SKILLS, version: '6.8.0', origin: false });
  try {
    // 现场：上次运行 main 已推、本地 tag 已建但 tag push 被拒（远端无该 tag）。
    writeLastSync(
      { ref: 'refs/tags/v6.8.0', sha: s.tagShas['v6.8.0'], version: '6.8.0', head: headSha(s.root) },
      s.root,
    );
    gitIn(s.root, ['tag', 'v6.8.0']);

    await withEnv('DSH_PPT_GITLAB_PAT', 'glpat-backpush', async () => {
      const pushes = [];
      const { deps, calls } = stubDeps({
        tarballPath: s.tarballPath,
        runGit: backPushRunGit(CANNED_ORIGIN_URL, pushes),
      });
      const code = await main({ root: s.root, repo: s.repoUrl }, deps);
      assert.equal(code, 0, '补推成功后照常短路 exit 0');
      assert.match(calls.output(), /补推缺失的发布 tag/);
      assert.equal(pushes.length, 1, '只补推 tag（main 已推，不重复推）');
      assert.equal(pushes[0][0], 'push');
      assert.ok(
        pushes[0].includes('refs/tags/v6.8.0'),
        `stub push 应收到 tag refspec: ${JSON.stringify(pushes[0])}`,
      );
      assert.equal(pushes[0][1], `https://oauth2:glpat-backpush@gitlab.example.com/zyx/dsh-wrapper-test.git`);
      assert.match(calls.output(), /already up to date/);
    });
  } finally {
    s.cleanup();
  }
});

test('push 部分失败修复（Fix #2）对照：本地 tag 不存在 / 远端已有该 tag → 照常短路（无补推）', async () => {
  const s = makeScenario({ vendorFrom: UPSTREAM_SKILLS, version: '6.8.0', origin: false });
  try {
    await withEnv('DSH_PPT_GITLAB_PAT', 'glpat-backpush', async () => {
      // ① 本地 tag 不存在 → 无可补推对象，照常短路。
      writeLastSync(
        { ref: 'refs/tags/v6.8.0', sha: s.tagShas['v6.8.0'], version: '6.8.0', head: headSha(s.root) },
        s.root,
      );
      let pushes = [];
      let { deps, calls } = stubDeps({
        tarballPath: s.tarballPath,
        runGit: backPushRunGit(CANNED_ORIGIN_URL, pushes),
      });
      let code = await main({ root: s.root, repo: s.repoUrl }, deps);
      assert.equal(code, 0);
      assert.equal(pushes.length, 0, '本地 tag 不存在 → 不补推');
      assert.match(calls.output(), /already up to date/);
      assert.doesNotMatch(calls.output(), /补推缺失的发布 tag/);

      // ② 本地 tag 存在但远端已有该 tag → 已发布，无需补推。
      gitIn(s.root, ['tag', 'v6.8.0']);
      pushes = [];
      ({ deps, calls } = stubDeps({
        tarballPath: s.tarballPath,
        runGit: backPushRunGit(CANNED_ORIGIN_URL, pushes, `${CANNED_SHA}\trefs/tags/v6.8.0\n`),
      }));
      code = await main({ root: s.root, repo: s.repoUrl }, deps);
      assert.equal(code, 0);
      assert.equal(pushes.length, 0, '远端已有 tag → 不补推');
      assert.doesNotMatch(calls.output(), /补推缺失的发布 tag/);
    });
  } finally {
    s.cleanup();
  }
});

// ─── 幂等回退分支（无 @{u} → last-sync.head 包装层基线锚，三态） ──
// sha 空间分离：last-sync.sha 是**上游** commit sha（缓存键语义），永不作包装层
// merge-base 锚；锚 = head 字段（wrapper commit 后写入——生产可达状态）。

test('回退分支三态①：head 缺失（首灌前/旧记录）→ wrapperPending=false', async () => {
  const s = makeScenario({ vendorFrom: UPSTREAM_SKILLS, version: '6.8.0', origin: false });
  try {
    // head 不写（旧形态记录：仅 ref/sha/version）——首灌前确无已发布基线。
    writeLastSync({ ref: 'refs/tags/v6.7.0', sha: 'b'.repeat(40), version: '6.8.0' }, s.root);
    const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
    const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
    assert.equal(code, 0);
    assert.equal(calls.verify.length, 1, '@{u} exit 128 → 走回退分支不崩；ref 已变（记录 v6.7.0 vs 实际 v6.8.0）不短路');
    assert.equal(commitCount(s.root), 1, 'wrapperPending=false → no-change，无 commit');
    assert.equal(JSON.parse(readFileSync(join(s.root, 'package.json'), 'utf8')).version, '6.8.0');
  } finally {
    s.cleanup();
  }
});

test('回退分支三态②：head=HEAD（无新提交）→ wrapperPending=false', async () => {
  const s = makeScenario({ vendorFrom: UPSTREAM_SKILLS, version: '6.8.0', origin: false });
  try {
    writeLastSync(
      { ref: 'refs/tags/v6.7.0', sha: 'b'.repeat(40), version: '6.8.0', head: headSha(s.root) },
      s.root,
    );
    const { deps } = stubDeps({ tarballPath: s.tarballPath });
    const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
    assert.equal(code, 0);
    assert.equal(commitCount(s.root), 1, 'head==HEAD → 无待发布包装层提交，no-change 无 commit');
    assert.equal(JSON.parse(readFileSync(join(s.root, 'package.json'), 'utf8')).version, '6.8.0');
  } finally {
    s.cleanup();
  }
});

test('回退分支三态③：head 为 HEAD 祖先且其后另有包装层提交 → wrapperPending=true（规则③）', async () => {
  const s = makeScenario({ vendorFrom: UPSTREAM_SKILLS, version: '6.8.0', origin: false });
  try {
    const baseline = headSha(s.root);
    writeLastSync(
      { ref: 'refs/tags/v6.7.0', sha: 'b'.repeat(40), version: '6.8.0', head: baseline },
      s.root,
    );
    // 基线之后新增未推送包装层提交。
    mkdirSync(join(s.root, 'lib'), { recursive: true });
    writeFileSync(join(s.root, 'lib', 'foo.js'), 'export {};\n');
    gitIn(s.root, ['add', '-A']);
    gitIn(s.root, ['commit', '-q', '-m', 'after baseline']);

    const { deps } = stubDeps({ tarballPath: s.tarballPath });
    const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
    assert.equal(code, 0);
    assert.equal(JSON.parse(readFileSync(join(s.root, 'package.json'), 'utf8')).version, '6.8.0-r1', 'head 祖先且 HEAD≠head → ③');
    assert.equal(commitCount(s.root), 3);
    assert.deepEqual(tagList(s.root), ['v6.8.0-r1']);
  } finally {
    s.cleanup();
  }
});

test('回退分支真实链路：自动路径写入 head → 重跑经 head==HEAD 幂等短路 → 包装层提交后 ③ bump', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS, version: '6.7.0', origin: false });
  try {
    // 第 1 跑：confirm 自动路径（无 @{u} 仓库）→ wrapper commit 后写入 head 基线。
    const depsA = stubDeps({ tarballPath: s.tarballPath });
    const codeA = await main({ root: s.root, repo: s.repoUrl, confirmStructural: true, noPush: true }, depsA.deps);
    assert.equal(codeA, 0);
    const afterFirst = readLastSyncRaw(s.root);
    assert.equal(afterFirst.version, '6.8.0');
    assert.equal(afterFirst.head, headSha(s.root), 'head = wrapper commit 后的 HEAD（生产可达状态）');

    // 第 2 跑：同一状态重跑——head==HEAD、ref/sha 同、树无 diff → 幂等短路。
    const depsB = stubDeps({ tarballPath: s.tarballPath });
    const codeB = await main({ root: s.root, repo: s.repoUrl, confirmStructural: true, noPush: true }, depsB.deps);
    assert.equal(codeB, 0);
    assert.equal(depsB.calls.verify.length, 0, '经 head 锚判 wrapperPending=false → 幂等短路');
    assert.equal(depsB.calls.python.length, 0);
    assert.match(depsB.calls.output(), /already up to date/);

    // 第 3 跑：基线后新增包装层提交 → head 为祖先 → wrapperPending=true → 规则③。
    mkdirSync(join(s.root, 'lib'), { recursive: true });
    writeFileSync(join(s.root, 'lib', 'foo.js'), 'export {};\n');
    gitIn(s.root, ['add', '-A']);
    gitIn(s.root, ['commit', '-q', '-m', 'wrapper change']);
    const depsC = stubDeps({ tarballPath: s.tarballPath });
    const codeC = await main({ root: s.root, repo: s.repoUrl, confirmStructural: true, noPush: true }, depsC.deps);
    assert.equal(codeC, 0);
    assert.equal(JSON.parse(readFileSync(join(s.root, 'package.json'), 'utf8')).version, '6.8.0-r1', '未推送包装层提交不被幂等短路吞掉 → ③');
    assert.deepEqual(tagList(s.root), ['v6.8.0', 'v6.8.0-r1']);
  } finally {
    s.cleanup();
  }
});

test('幂等补充③：vendorDiff=false 且 wrapperPending=false（no-change）→ 无 commit/无 tag、退出 0 并报告 already up to date', async () => {
  const s = makeScenario({ vendorFrom: UPSTREAM_SKILLS, version: '6.8.0' });
  try {
    // ref sha 与记录不同（v6.7.0/v6.8.0）→ 不短路；但树无 diff + 无待发布 → no-change。
    writeLastSync({ ref: 'refs/tags/v6.7.0', sha: '7'.repeat(40), version: '6.7.0' }, s.root);
      const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
      const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
      assert.equal(code, 0);
      assert.equal(commitCount(s.root), 1, 'no-change：无 commit');
      assert.deepEqual(tagList(s.root), [], 'no-change：无 tag');
      assert.match(calls.output(), /already up to date/);
  } finally {
    s.cleanup();
  }
});

// ─── 退出码 6：tag 冲突（本地先行检测 + 远端预判） ─────────────────

test('tag 冲突（本地 rev-parse 已存在）→ 退出码 6 且未 push（本地 commit 保留）', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS });
  try {
    gitIn(s.root, ['tag', 'v6.8.0']); // 本地已有同名 tag（rev-parse 检测依赖仓库已有 commit——fixture 前提满足）
      const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
      const code = await main({ root: s.root, repo: s.repoUrl, confirmStructural: true, noPush: true }, deps);
      assert.equal(code, 6);
      assert.match(calls.output(), /绝不覆盖/);
      const originBefore = originMainSha(s.originPath);
      assert.equal(originMainSha(s.originPath), originBefore, '不得 push');
      assert.deepEqual(tagList(s.root), ['v6.8.0'], '既有 tag 原样保留（仍指向初始 commit）');
      assert.ok(commitCount(s.root) >= 2, 'tag 冲突前本地 commit 已产生（保留）');
  } finally {
    s.cleanup();
  }
});

test('tag 冲突远端预判：origin ls-remote 结果含同名 tag → 不依赖本地 rev-parse 也拦截 → 退出码 6', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS });
  try {
    // 只在远端 bare 上创建 tag——工作仓库本地没有（隔离远端预判通道）。
    execFileSync('git', ['--git-dir', s.originPath, 'tag', 'v6.8.0', originMainSha(s.originPath)]);
    assert.deepEqual(tagList(s.root), [], '前置：本地无同名 tag');
    const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
    const code = await main({ root: s.root, repo: s.repoUrl, confirmStructural: true, noPush: true }, deps);
    assert.equal(code, 6);
    assert.deepEqual(tagList(s.root), [], '未创建本地 tag');
    const originBefore = originMainSha(s.originPath);
    assert.equal(originMainSha(s.originPath), originBefore, '不得 push');
  } finally {
    s.cleanup();
  }
});

// ─── 推送：PAT 解析顺序 / 一次性 URL / --no-push（canned git） ─────

/** canned 推送场景公用 stub：upstream ls-remote 有 v6.8.0、origin 查询齐全。 */
function pushScenarioMatchers(extra = []) {
  return [
    {
      match: (args) => args[0] === 'ls-remote' && args[2] === 'https://github.com/fake/up.git',
      resp: { code: 0, stdout: `${CANNED_SHA}\trefs/tags/v6.8.0\n`, stderr: '' },
    },
    {
      match: (args) => args[0] === 'remote' && args[1] === 'get-url',
      resp: { code: 0, stdout: `${CANNED_ORIGIN_URL}\n`, stderr: '' },
    },
    ...extra,
  ];
}

test('PAT：env 提供 → push URL 含 oauth2: 且 PAT 不落任何文件', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS, origin: false });
  try {
    const pat = 'glpat-test-123';
    await withEnv('DSH_PPT_GITLAB_PAT', pat, async () => {
      const { deps, calls } = stubDeps({
        tarballPath: s.tarballPath,
        runGit: cannedGit(pushScenarioMatchers()),
      });
      const code = await main({ root: s.root, repo: 'https://github.com/fake/up.git', confirmStructural: true }, deps);
      assert.equal(code, 0);
      const pushes = calls.git.filter((call) => call.args[0] === 'push');
      assert.equal(pushes.length, 2, 'push main + tag 两次');
      const oneShot = `https://oauth2:${pat}@gitlab.example.com/zyx/dsh-wrapper-test.git`;
      assert.equal(pushes[0].args[1], oneShot, '一次性 URL 含 oauth2:<PAT>');
      assert.equal(pushes[1].args[1], oneShot);
      assert.ok(pushes[1].args.includes('refs/tags/v6.8.0'));
      assert.equal(existsSync(join(s.root, 'sync-report.txt')), true, '成功路径写 sync-report.txt');
      // PAT 不落任何文件（含 last-sync.json / sync-report.txt / .git）。
      for (const file of walkAllFiles(s.root)) {
        assert.equal(readFileSync(file, 'utf8').includes(pat), false, `PAT 不得落盘: ${file}`);
      }
    });
  } finally {
    s.cleanup();
  }
});

test('PAT：env 缺失且 credential fill 失败 → 退出码 6 且指引配置 PAT', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS, origin: false });
  try {
    await withEnv('DSH_PPT_GITLAB_PAT', undefined, async () => {
        const { deps, calls } = stubDeps({
          tarballPath: s.tarballPath,
          runGit: cannedGit(
            pushScenarioMatchers([
              {
                match: (args) => args[0] === 'credential' && args[1] === 'fill',
                resp: { code: 1, stdout: '', stderr: '' },
              },
            ]),
          ),
        });
        const code = await main({ root: s.root, repo: 'https://github.com/fake/up.git', confirmStructural: true }, deps);
        assert.equal(code, 6);
        assert.match(calls.output(), /DSH_PPT_GITLAB_PAT/, '指引配置 PAT');
        assert.equal(calls.git.some((call) => call.args[0] === 'push'), false, 'PAT 解析失败不得 push');
    });
  } finally {
    s.cleanup();
  }
});

test('PAT credential helper 成功路径：env 缺失但 credential stub 返回 PAT → 推送成功且不经 oauth2 URL', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS, origin: false });
  try {
    await withEnv('DSH_PPT_GITLAB_PAT', undefined, async () => {
      const { deps, calls } = stubDeps({
        tarballPath: s.tarballPath,
        runGit: cannedGit(
          pushScenarioMatchers([
            {
              match: (args) => args[0] === 'credential' && args[1] === 'fill',
              resp: {
                code: 0,
                stdout: 'protocol=https\nhost=gitlab.example.com\nusername=oauth2\npassword=credpat-secret\n',
                stderr: '',
              },
            },
          ]),
        ),
      });
      const code = await main({ root: s.root, repo: 'https://github.com/fake/up.git', confirmStructural: true }, deps);
      assert.equal(code, 0);
      const pushes = calls.git.filter((call) => call.args[0] === 'push');
      assert.equal(pushes.length, 2);
      assert.equal(pushes[0].args[1], 'origin', 'credential 路径推 origin——PAT 只在 git 进程内流转');
      assert.ok(pushes.every((call) => !call.args.join(' ').includes('oauth2:')), 'argv 不得含 oauth2: URL');
    });
  } finally {
    s.cleanup();
  }
});

test('push 失败 → 退出码 6（指引 pull --rebase 重试）', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS, origin: false });
  try {
    await withEnv('DSH_PPT_GITLAB_PAT', 'glpat-push-fail', async () => {
        const { deps, calls } = stubDeps({
          tarballPath: s.tarballPath,
          runGit: cannedGit(
            pushScenarioMatchers([
              {
                match: (args) => args[0] === 'push',
                resp: { code: 1, stdout: '', stderr: '! [rejected] main -> main (non-fast-forward)' },
              },
            ]),
          ),
        });
        const code = await main({ root: s.root, repo: 'https://github.com/fake/up.git', confirmStructural: true }, deps);
        assert.equal(code, 6);
        assert.match(calls.output(), /git pull --rebase/);
    });
  } finally {
    s.cleanup();
  }
});

test('--no-push → 本地 commit+tag、无 push 调用', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS, origin: false });
  try {
    const { deps, calls } = stubDeps({
      tarballPath: s.tarballPath,
      runGit: cannedGit(pushScenarioMatchers()),
    });
    const code = await main({ root: s.root, repo: 'https://github.com/fake/up.git', confirmStructural: true, noPush: true }, deps);
    assert.equal(code, 0);
    assert.ok(calls.git.some((call) => call.args[0] === 'commit'), '本地 commit');
    assert.ok(calls.git.some((call) => call.args[0] === 'tag'), '本地 tag（--no-push 仍创建）');
    assert.equal(calls.git.some((call) => call.args[0] === 'push'), false, '无 push 调用');
    assert.equal(existsSync(join(s.root, 'sync-report.txt')), true);
  } finally {
    s.cleanup();
  }
});

// ─── --dry-run ───────────────────────────────────────────────────

test('--dry-run → 只报告将发生的变化，无替换/commit/tag/push', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS });
  try {
      const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
      const code = await main({ root: s.root, repo: s.repoUrl, dryRun: true }, deps);
      assert.equal(code, 0);
      assert.match(calls.output(), /second-skill/, 'dry-run 报告将发生的结构变化');
      // 无替换：vendor 面保持旧版本、无新 skill。
      assert.match(readFileSync(join(s.root, 'skills', 'ppt-master', 'SKILL.md'), 'utf8'), /6\.7\.0/);
      assert.equal(existsSync(join(s.root, 'skills', 'second-skill')), false);
      // 无 commit/tag/push。
      assert.equal(commitCount(s.root), 1);
      assert.deepEqual(tagList(s.root), []);
      assert.equal(calls.verify.length, 0, 'dry-run 不进入自动路径（verify 不跑）');
  } finally {
    s.cleanup();
  }
});

// ─── 缓存：--refresh 绕过 + 缓存命中复用 ──────────────────────────

test('--refresh 绕过缓存：缓存目录存在仍调用 fetchTarball', async () => {
  const s = makeScenario({ vendorFrom: UPSTREAM_SKILLS, version: '6.8.0' });
  try {
    // 预置缓存目录（解压树形态）。
    cpSync(UPSTREAM_TREE, s.extractDirOf('v6.8.0'), { recursive: true });
    const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
    const code = await main({ root: s.root, repo: s.repoUrl, refresh: true, noPush: true }, deps);
    assert.equal(code, 0);
    assert.equal(calls.fetch.length, 1, '--refresh 必须重新下载');
  } finally {
    s.cleanup();
  }
});

test('缓存命中：缓存目录存在且未 --refresh → 不下载，直接复用', async () => {
  const s = makeScenario({ vendorFrom: UPSTREAM_SKILLS, version: '6.8.0' });
  try {
    cpSync(UPSTREAM_TREE, s.extractDirOf('v6.8.0'), { recursive: true });
    writeLastSync({ ref: 'refs/tags/v6.8.0', sha: s.tagShas['v6.8.0'], version: '6.8.0' }, s.root);
    const { deps, calls } = stubDeps({ tarballPath: s.tarballPath });
    const code = await main({ root: s.root, repo: s.repoUrl, noPush: true }, deps);
    assert.equal(code, 0);
    assert.equal(calls.fetch.length, 0, '缓存命中不下载');
    assert.equal(calls.verify.length, 0, '幂等短路同样生效');
  } finally {
    s.cleanup();
  }
});

// ─── marketplace 豁免 note 并入 🟡 汇总 ────────────────────────────

test('marketplace 校验豁免（上游无 .claude-plugin/marketplace.json）→ 🟡 汇总含豁免 note', async () => {
  const s = makeScenario({ vendorFrom: VENDOR_SKILLS });
  const custom = customTarball((copy) => rmSync(join(copy, '.claude-plugin'), { recursive: true, force: true }));
  try {
      const { deps, calls } = stubDeps({ tarballPath: custom.tarPath });
      const code = await main({ root: s.root, repo: s.repoUrl, confirmStructural: true, noPush: true }, deps);
      assert.equal(code, 0);
      assert.match(calls.output(), /豁免/, 'T11 豁免 note 由编排并入 🟡 汇总输出');
      assert.match(readFileSync(join(s.root, 'sync-report.txt'), 'utf8'), /豁免/, '同步报告同样并入');
  } finally {
    s.cleanup();
    custom.cleanup();
  }
});
