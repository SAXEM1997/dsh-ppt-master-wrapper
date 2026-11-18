/**
 * 工具可见范围的**宿主集成层**：把 `scope` 配置翻成宿主每个模型步骤问一次的
 * `when(context)` 谓词。
 *
 * 只有一条路径（2026-11-18 迁移；参考实现 dsh-cherry-bridge #345）：
 * `tools.register(def, { when })` —— 宿主在 `tools.resolve({ agent, signal })` 里逐个
 * `await when(...)`，为真才进入本步可见集。于是没有「装在别人身上的限制层」：
 * 无 per-agent `restrict`、无根 `guard`、无 `agent/created` 订阅、无注入看门狗、
 * 无复检定时器；配置保存下一步生效。
 *
 * 四条承载语义：
 *  1. **`when` 同步、永不抛**。条件抛错会让宿主**步骤准备**失败
 *     （`ToolActivationError`），把一次坏判定升级成整步不可用；所有分支都必须收敛成
 *     `true`/`false`。
 *  2. **`selected` fail-closed**：注册表未就绪、`list()` 抛错、无 cwd、路径不属任何
 *     工作区、名单为空、判定尚未完成 ⇒ 一律 `false`。
 *  3. **`global` 不碰注册表**：默认配置与「没有这个特性」逐字等价（在 ≥0.2.2 宿主上），
 *     也不产生任何注册表读取成本。
 *  4. **一步一结论**：宿主对同一 `resolve()` 的所有工具复用同一个 `context` 对象，
 *     故按 context 缓存本步结论——精化在微任务里落定时，不会让同一步后两个工具看到
 *     与第一个不同的答案。
 *
 * 判定分两级：`resolveNow`（同步：会话成员 + 字符串路径）回答「这一步」；未命中且有
 * cwd 时排一次**异步精化**（`judgeAgent` + `resolveByPath`，收敛符号链接/拼写差异），
 * 精化只提升后续步骤的命中率，不参与 fail-open。
 *
 * 缓存**按 agent 对象本身**（WeakMap）而不是 agent id：宿主会跨 clear/压缩/resume 复用
 * 会话 id，按 id 记账会让某个曾经被 realpath 精化命中的会话在 cwd 移出工作区后仍然可见
 * （fail-open）；对象身份随会话销毁自然失效，重放同 id 的新对象不会继承旧结论。
 * 负结论也缓存：`no-match` 记下当时的**注册表指纹**（工作区 id+路径的有序快照）——指纹
 * 不变就不重试，指纹变了（新建/删除/改路径，注册表没有变更事件可订阅）才丢弃重排；
 * `unresolved` 是瞬时失败（最多重试 `MAX_UNRESOLVED_RETRIES` 次），避免永久不匹配的 cwd
 * 每步都做 realpath。代际（mount / invalidate / dispose 各推进一次）决定缓存是否仍然有效。
 *
 * @module dsh-ppt-master-wrapper/scope-host
 */

import {
  isVisible,
  judgeAgent,
  readScopeConfig,
  projectAgent,
  readWorkspaces,
  resolveNow,
} from './scope.js';

/** 异步精化对同一 agent 的最小重试间隔（毫秒）：永久不可解析的 cwd 不刷爆。 */
const REFINE_RETRY_MS = 2000;

/** 瞬时失败（`resolveByPath` 抛错）的最大重试次数；确定性 no-match 不重试。 */
const MAX_UNRESOLVED_RETRIES = 3;

/** 注入键：只需要工作区注册表；agent 由 `when` 的上下文直接给出。 */
const INJECT_KEYS = Object.freeze(['workspaceRegistry']);

/**
 * 能力自检：本插件的可见范围押在 `tools.resolve` 上（dsh-tools 0.2.2-alpha.2+）。
 *
 * 缺失时不注册任何工具也无法收窄（`when` 第二参会被静默忽略），故 fail-loud。
 *
 * @param {{ resolve?: Function } | undefined} tools
 * @throws {Error} 宿主不支持步骤级可见性
 */
export function assertWhenCapable(tools) {
  if (typeof tools?.resolve !== 'function') {
    throw new Error(
      '工具可见范围需要步骤级 when：本宿主缺少 tools.resolve（需要 DSH ≥ 0.2.2-rc.1）。'
        + '旧宿主会静默忽略 when 的第二参，导致 scope.mode=selected 失效而不报错，故本版本拒绝装载。',
    );
  }
}

/**
 * 挂载可见范围子系统。
 *
 * @param {object} ctx 插件根 ctx（用可选 `inject` 拿注册表、`on` 听 volatile 变更）
 * @param {{ scopeConfig?: unknown, warn?: (message: string) => void, now?: () => number }} [options]
 *   `scopeConfig` 是**原始 volatile 引用容器**：每次 `when` 现读，不得在此拍平。
 * @returns {{
 *   when: (context: unknown) => boolean,
 *   invalidate: () => void,
 *   dispose: () => void,
 *   hostState: () => { state: 'pending'|'ready'|'unsupported', reason: string }  // 诊断/测试用
 * }}
 */
export function mountToolScope(ctx, options = {}) {
  const scopeConfig = options.scopeConfig;
  const warn = typeof options.warn === 'function' ? options.warn : () => {};
  const now = typeof options.now === 'function' ? options.now : Date.now;

  let disposed = false;
  let generation = 0;
  let registry = null;
  let hostState = { state: 'pending', reason: '等待 workspaceRegistry 注入' };

  /** 本步结论：context 对象 → 可见性（宿主同一步对每个工具复用同一个 context）。 */
  const stepVerdicts = new WeakMap();
  /** agent 对象 → `{ workspaceId, cwd, generation }`：realpath 精化命中的缓存。 */
  let resolvedCache = new WeakMap();
  /** agent 对象 → `{ status, cwd, generation, attempts }`：确定性 no-match / 瞬时失败。 */
  let negativeCache = new WeakMap();
  /** agent 对象集合：同一 agent 的精化不并发。 */
  let inFlight = new WeakSet();
  /** agent 对象 → 上次精化的时间戳（节流）。 */
  let lastAttempt = new WeakMap();

  const warnOnce = (() => {
    const seen = new Set();
    return (key, message) => {
      if (seen.has(key)) return;
      seen.add(key);
      warn(message);
    };
  })();

  const readConfig = () => readScopeConfig(scopeConfig);

  /**
   * 注册表指纹：工作区 `id` + 规范化前的路径字符串的有序快照。负结论只在指纹不变时
   * 复用；指纹变了（新建/删除/改路径）就重排一次精化。注册表没有变更事件可订阅——
   * 这正是不能用「缓存到插件重载」的原因，也不需要定时器。
   *
   * @param {Array<object>} workspaces 已投影的工作区列表
   * @returns {string}
   */
  function fingerprintOf(workspaces) {
    return workspaces
      .map((workspace) => `${workspace.id}\u0000${workspace.path}`)
      .sort()
      .join('\u0001');
  }

  /**
   * 现读注册表并投影成 `{ ok, code, reason, workspaces, pathMap }`。
   *
   * `code` 区分两类失败，供告警**各占一个 key**：`pending`（注入还没到，启动期一次性、
   * 自己会好）与 `list-failed`（`list()` 抛错，需要人看）。共用 key 会让启动期那条把
   * 真正要处理的那条吃掉。
   */
  function readRegistry() {
    const list = registry?.list;
    if (typeof list !== 'function') {
      return {
        ok: false, code: 'pending', reason: 'workspaceRegistry 尚未注入', workspaces: [], pathMap: new Map(),
      };
    }
    try {
      const workspaces = readWorkspaces(list.call(registry));
      const pathMap = new Map();
      for (const workspace of workspaces) {
        if (workspace.path !== undefined && !pathMap.has(workspace.path)) {
          pathMap.set(workspace.path, workspace.id);
        }
      }
      return { ok: true, code: 'ok', reason: '', workspaces, pathMap };
    } catch {
      return {
        ok: false, code: 'list-failed', reason: 'workspaceRegistry.list() 读取失败', workspaces: [], pathMap: new Map(),
      };
    }
  }

  /**
   * 排一次异步精化（不 await）。节流 + 单飞 + 代际三重约束：
   * 确定性 no-match 落负缓存后不再重试；瞬时失败最多 `MAX_UNRESOLVED_RETRIES` 次；
   * 落败代际的结果不会写进新缓存。
   *
   * @param {object} rawAgent 宿主给的 agent 对象（缓存键）
   * @param {{ id: string, cwd?: string }} agent 投影后的判定输入
   */
  function scheduleRefine(rawAgent, agent) {
    if (disposed || agent.cwd === undefined || inFlight.has(rawAgent)) return;
    const at = now();
    const last = lastAttempt.get(rawAgent);
    if (last !== undefined && at - last < REFINE_RETRY_MS) return;
    lastAttempt.set(rawAgent, at);
    const gen = generation;
    inFlight.add(rawAgent);
    void (async () => {
      try {
        const { workspaces, pathMap } = readRegistry();
        if (workspaces.length === 0) return;
        const record = await judgeAgent({
          config: readConfig(),
          agent,
          workspaces,
          pathMap,
          resolveByPath: typeof registry?.resolveByPath === 'function'
            ? registry.resolveByPath.bind(registry)
            : undefined,
        });
        if (disposed || gen !== generation) return;
        if (record.status === 'resolved' && typeof record.workspaceId === 'string') {
          resolvedCache.set(rawAgent, {
            workspaceId: record.workspaceId,
            cwd: agent.cwd,
            basis: record.basis,
            fingerprint: fingerprintOf(workspaces),
            generation: gen,
          });
          negativeCache.delete(rawAgent);
          return;
        }
        const previous = negativeCache.get(rawAgent);
        const attempts = (previous?.generation === gen ? previous.attempts : 0) + 1;
        negativeCache.set(rawAgent, {
          status: record.status,
          cwd: agent.cwd,
          generation: gen,
          attempts,
          fingerprint: fingerprintOf(workspaces),
          at: now(),
        });
      } catch {
        // judgeAgent 自身吞 resolveByPath 异常；这里兜的是意外，同样保持不可见。
      } finally {
        inFlight.delete(rawAgent);
      }
    })();
  }

  /**
   * 宿主每步对每个工具调用一次。同步、永不抛。
   *
   * @param {unknown} context `{ agent, signal }`（宿主形状）；也接受 agent 本身（不按步缓存，
   *   因为 agent 对象跨步长存——缓存会把第一步的结论冻结到会话结束）
   * @returns {boolean} 该工具在本步是否可见
   */
  function when(context) {
    if (disposed) return false;
    const cacheKey = context !== null && typeof context === 'object' ? context : undefined;
    // 裸 agent 对象与宿主给出的步上下文都是对象；用 `agent` 字段区分，前者不缓存。
    // 取字段本身也可能抛（敌意 getter），故这一句也要兜住。
    let isStepContext = false;
    try {
      isStepContext = cacheKey !== undefined && cacheKey.agent !== undefined;
    } catch {
      isStepContext = false;
    }
    if (isStepContext && stepVerdicts.has(cacheKey)) {
      return stepVerdicts.get(cacheKey);
    }
    let verdict = false;
    try {
      verdict = computeVerdict(context);
    } catch {
      verdict = false;
    }
    if (isStepContext) stepVerdicts.set(cacheKey, verdict);
    return verdict;
  }

  /** `when` 的实际判定（异常由 `when` 兜住）。 */
  function computeVerdict(context) {
    if (context?.signal?.aborted === true) return false;
    const config = readConfig();
    if (config.problem === 'invalid') {
      warnOnce(
        'invalid-config',
        'scope 配置非法（mode/workspaceIds 类型不符）：已按 selected + 空名单 fail-closed，请修正配置',
      );
    }
    if (config.mode !== 'selected') return true;

    const rawAgent = context?.agent ?? context;
    const agent = projectAgent(rawAgent);
    if (agent === undefined || rawAgent === null || typeof rawAgent !== 'object') return false;

    // 无 cwd：不做路径判定，也不使用任何缓存——精化命中的缓存只对「有 cwd 的同一会话」成立。
    if (agent.cwd === undefined) return false;

    const { ok, code, reason, workspaces, pathMap } = readRegistry();
    if (!ok) {
      warnOnce(`registry-${code}`, `scope.mode=selected 已启用，但${reason}：本步工具按不可见处理`);
      return false;
    }

    const record = resolveNow({ config, agent, workspaces, pathMap });
    if (record.status === 'resolved') return record.visible;

    const cached = resolvedCache.get(rawAgent);
    if (cached !== undefined && cached.generation === generation && cached.cwd === agent.cwd) {
      const workspace = workspaces.find((item) => item.id === cached.workspaceId);
      // 路径命中的缓存只在注册表指纹不变时成立；成员命中的缓存还要求该会话仍在该
      // 工作区名单里（会话被移出工作区后，路径可能根本不匹配，不能沿用旧结论）。
      const sameRegistry = cached.fingerprint === fingerprintOf(workspaces);
      const stillMember = cached.basis !== 'member'
        || (workspace !== undefined && workspace.sessionIds.includes(agent.id));
      if (workspace !== undefined && sameRegistry && stillMember) {
        return isVisible(config, cached.workspaceId);
      }
      resolvedCache.delete(rawAgent);
    }

    const negative = negativeCache.get(rawAgent);
    if (negative !== undefined && negative.generation === generation && negative.cwd === agent.cwd) {
      if (negative.status === 'no-match') {
        // 指纹未变：同一批工作区给出同一结论，直接拒绝；变了才丢弃并重排。
        if (negative.fingerprint === fingerprintOf(workspaces)) return false;
        negativeCache.delete(rawAgent);
      } else if (negative.status === 'unresolved' && negative.attempts >= MAX_UNRESOLVED_RETRIES) {
        return false;
      }
    }

    scheduleRefine(rawAgent, agent);
    return false;
  }

  function invalidate() {
    generation += 1;
    // **不**清 `stepVerdicts`：宿主同一步对三个工具复用同一个 context，换代若发生在步中，
    // 清掉会让同一步出现「前一个工具按旧结论、后一个按新结论」；每步对象本身不可跨步复用。
    resolvedCache = new WeakMap();
    negativeCache = new WeakMap();
    inFlight = new WeakSet();
    lastAttempt = new WeakMap();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    invalidate();
    registry = null;
    hostState = { state: 'pending', reason: '作用域已释放' };
  }

  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(INJECT_KEYS, (services) => {
        if (disposed) return;
        const candidate = services?.workspaceRegistry;
        if (candidate === undefined || candidate === null) {
          hostState = { state: 'pending', reason: 'workspaceRegistry 未随注入到达' };
          return;
        }
        registry = candidate;
        hostState = { state: 'ready', reason: '宿主支持步骤级 when（tools.resolve）' };
        invalidate();
      });
    } catch {
      hostState = { state: 'unsupported', reason: 'workspaceRegistry 注入失败' };
    }
  } else {
    hostState = { state: 'unsupported', reason: '宿主无 ctx.inject（拿不到 workspaceRegistry）' };
  }

  // 配置换代时清缓存：负结论（no-match）可能因 workspaceIds / 工作区清单变化而作废。
  const offVolatile = typeof ctx?.on === 'function'
    ? ctx.on('loader/volatile-update', () => {
      if (!disposed) invalidate();
    })
    : undefined;

  return {
    when,
    invalidate,
    dispose: () => {
      if (typeof offVolatile === 'function') offVolatile();
      dispose();
    },
    hostState: () => ({ ...hostState }),
  };
}
