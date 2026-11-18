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
 * 三条承载语义：
 *  1. **`when` 同步、永不抛**。条件抛错会让宿主**步骤准备**失败
 *     （`TOOL_ACTIVATION_FAILED`），把一次坏判定升级成整步不可用；所有分支都必须
 *     收敛成 `true`/`false`。
 *  2. **`selected` fail-closed**：注册表未就绪、`list()` 抛错、无 cwd、路径不属任何
 *     工作区、名单为空、判定尚未完成 ⇒ 一律 `false`。
 *  3. **`global` 不碰注册表**：默认配置与「没有这个特性」逐字等价，也不产生任何
 *     注册表读取成本。
 *
 * 判定分两级：`resolveNow`（同步：会话成员 + 字符串路径）回答「这一步」；未命中且有
 * cwd 时排一次**异步精化**（`judgeAgent` + `resolveByPath`，收敛符号链接/拼写差异），
 * 精化只提升后续步骤的命中率，不参与 fail-open。缓存按 agent id + 代际记账：落败
 * 代际不得写缓存（mount / invalidate / dispose 各推进一次代际）。
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
 * @param {object} ctx 插件根 ctx（只用到可选 `inject`）
 * @param {{ scopeConfig?: unknown, warn?: (message: string) => void, now?: () => number }} [options]
 *   `scopeConfig` 是**原始 volatile 引用容器**：每次 `when` 现读，不得在此拍平。
 * @returns {{
 *   when: (context: unknown) => boolean,
 *   invalidate: () => void,
 *   dispose: () => void,
 *   hostState: () => { state: 'pending'|'ready'|'unsupported', reason: string },
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
  let warnedMissingRegistry = false;

  /** agentId → `{ workspaceId, generation }`：只缓存「已解析」的异步精化结果。 */
  const resolvedCache = new Map();
  /** agentId 集合：同一 agent 的精化不并发。 */
  const inFlight = new Set();
  /** agentId → 上次精化的时间戳（节流）。 */
  const lastAttempt = new Map();

  const readConfig = () => readScopeConfig(scopeConfig);

  /** 现读注册表并投影成 `{ workspaces, pathMap }`；任何异常按「读不到」处理。 */
  function readRegistry() {
    const list = registry?.list;
    if (typeof list !== 'function') return { ok: false, workspaces: [], pathMap: new Map() };
    try {
      const workspaces = readWorkspaces(list.call(registry));
      const pathMap = new Map();
      for (const workspace of workspaces) {
        if (workspace.path !== undefined && !pathMap.has(workspace.path)) {
          pathMap.set(workspace.path, workspace.id);
        }
      }
      return { ok: true, workspaces, pathMap };
    } catch {
      return { ok: false, workspaces: [], pathMap: new Map() };
    }
  }

  /**
   * 排一次异步精化（不 await）。节流 + 单飞 + 代际三重约束：
   * 永久失败的 cwd 不会每步重跑，落败代际的结果不会写进新缓存。
   */
  function scheduleRefine(agent) {
    if (disposed || agent.cwd === undefined || inFlight.has(agent.id)) return;
    const at = now();
    const last = lastAttempt.get(agent.id);
    if (last !== undefined && at - last < REFINE_RETRY_MS) return;
    lastAttempt.set(agent.id, at);
    const gen = generation;
    inFlight.add(agent.id);
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
          resolvedCache.set(agent.id, { workspaceId: record.workspaceId, generation: gen });
        }
      } catch {
        // 精化失败保持「本步不可见」，不升级成步骤失败。
      } finally {
        inFlight.delete(agent.id);
      }
    })();
  }

  /**
   * 宿主每步对每个工具调用一次。同步、永不抛。
   *
   * @param {unknown} context `{ agent, signal }`（宿主形状）；也接受 agent 本身
   * @returns {boolean} 该工具在本步是否可见
   */
  function when(context) {
    if (disposed) return false;
    try {
      if (context?.signal?.aborted === true) return false;
      const config = readConfig();
      if (config.mode !== 'selected') return true;

      const agent = projectAgent(context?.agent ?? context);
      if (agent === undefined) return false;

      const { ok, workspaces, pathMap } = readRegistry();
      if (!ok) {
        if (!warnedMissingRegistry) {
          warnedMissingRegistry = true;
          warn('scope.mode=selected 已启用，但 workspaceRegistry 尚未就绪：本步工具按不可见处理');
        }
        return false;
      }

      const record = resolveNow({ config, agent, workspaces, pathMap });
      if (record.status === 'resolved') return record.visible;

      const cached = resolvedCache.get(agent.id);
      if (cached !== undefined && cached.generation === generation) {
        if (workspaces.some((workspace) => workspace.id === cached.workspaceId)) {
          return isVisible(config, cached.workspaceId);
        }
        resolvedCache.delete(agent.id);
      }

      scheduleRefine(agent);
      return false;
    } catch {
      return false;
    }
  }

  function invalidate() {
    generation += 1;
    resolvedCache.clear();
    lastAttempt.clear();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    invalidate();
    registry = null;
    hostState = { state: 'unsupported', reason: '作用域已释放' };
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
      });
    } catch {
      hostState = { state: 'unsupported', reason: 'workspaceRegistry 注入失败' };
    }
  } else {
    hostState = { state: 'unsupported', reason: '宿主无 ctx.inject（拿不到 workspaceRegistry）' };
  }

  return {
    when,
    invalidate,
    dispose,
    hostState: () => ({ ...hostState }),
  };
}
