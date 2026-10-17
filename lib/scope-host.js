/**
 * 工具可见范围的**宿主集成**层：能力探针、动态注入、判定轮次（含合并闸门）、
 * 逐 agent 的限制层安装/释放、执行层 guard，以及拆除顺序。
 *
 * 判定规则本身在 `lib/scope.js`（纯逻辑、可单测）；本文件只负责"把判定结果变成宿主上的
 * 事实"，因此它的每一处失败都必须**降级而非抛错**——装配期抛错会让整个 ppt-master
 * 技能面一起消失，那是比"工具多列几条"严重得多的损坏（design §6）。
 *
 * 六条关键约定（design §4/§5.3/§6）：
 *  1. **`global` 短路是两层的**：装配期**无条件**只建探针与 `loader/volatile-update` 订阅
 *     （零日志、零副作用）；只有 `selected` 才注入、装层、装 guard。默认配置下的行为与
 *     日志必须与"没有这个特性"逐字一致。
 *  2. **配置惰性读取**：`scopeConfig` 是 volatile 引用容器，宿主对 volatile-only 变更
 *     原地改引用、**不重挂插件**（`cordis-plugin-loader` 的 `_commitVolatile()`），
 *     故每轮判定前现读，并靠 `loader/volatile-update` 触发重算与激活。
 *  3. **`tools.restrict()` 只能在 agent 作用域调用**（根 ctx 调用宿主会抛
 *     "a context-global restriction would mask every agent"），故限制层逐个 agent 装在
 *     `agent.ctx.tools` 上；`tools.guard()` 装在**根 ctx**，由根 disposer 释放。
 *  4. **差异式安装**：`restrict` 在安装与释放两侧都会 emit `tools/change`，"每轮先释放再
 *     重装"会让合并闸门永久脏。只在"目标可见性 ≠ 当前已装状态"时动宿主。
 *  5. **首轮即正确**：`agent/created` 的监听器返回 promise（宿主 await 后才让该会话进第一轮），
 *     在里面做权威 `resolveByPath` 判定，不用同步猜测先装层。
 *  6. **三类"判不了"处置不同**（design §6）：能力缺失 ⇒ 全拒；瞬时读失败 ⇒ 保留旧判定 +
 *     无判定者放行；明确无归属 ⇒ 不可见。
 *
 * @module dsh-ppt-master-wrapper/scope-host
 */

import {
  judgeAgent,
  projectAgent,
  readScopeConfig,
  readWorkspaces,
  resolveNow,
} from './scope.js';

/** 本子系统需要的两个注入服务（一次 `ctx.inject` 调用）。 */
const INJECT_KEYS = Object.freeze(['agents', 'workspaceRegistry']);

/** `unresolved` / 读失败的有界复检：每个 agent 至多一次（design §5.4 / 澄清 C3）。 */
const RETRY_DELAY_MS = 1000;

/**
 * `resolveByPath` 的等待上界（design §5.4 / 落地审查 F3）。
 *
 * 宿主 `resolveByPath` 内部是 `await realpathNormalize(...)`，慢盘或挂死的挂载点会让它
 * 无限期不返回。`agent/created` 的监听器**会被宿主 await**（G8），所以这里必须有上界：
 * 超时按 `unresolved` 处理（→ 不可见），而不是让会话创建一起挂住。
 */
const RESOLVE_TIMEOUT_MS = 1500;

/** 日志与拒绝原因的前缀（单一字面量来源）。 */
const LABEL = 'dsh-ppt-master-wrapper';

/** 把未知抛出物转成一行可读文本。 */
function describeError(error) {
  const message = error?.message ?? error;
  return typeof message === 'string' ? message : String(message);
}

/**
 * 探针：宿主版本能力（一次，在根 ctx 上）。
 *
 * `canRestrict` 只说明"这个宿主支持 restrict"；真正的可调用性要看 `agent.ctx.tools`。
 */
function probeCapabilities(ctx) {
  const tools = ctx?.tools;
  return {
    canInject: typeof ctx?.inject === 'function',
    canOn: typeof ctx?.on === 'function',
    canRestrict: typeof tools?.restrict === 'function',
    canGuard: typeof tools?.guard === 'function',
  };
}

/**
 * 装配工具可见范围子系统。
 *
 * @param {object} ctx 插件根 ctx（需 `tools`；`inject`/`on` 缺失时按 design §6 降级）。
 * @param {{ scopeConfig: unknown, toolNames?: readonly string[], warn?: (message: string) => void }} options
 *   - `scopeConfig`：**volatile 引用容器**（`{mode, workspaceIds}`），不得在这里拍平；
 *   - `toolNames`：要收窄的工具名（由 `createTools()` 产出派生，见 `lib/scope.js#toolNamesOf`）；
 *   - `warn`：日志通道（默认 `console.warn`，与仓库既有降级日志同源）。
 * @returns {{ dispose: () => void, whenIdle: () => Promise<void> }}
 *   `dispose` 幂等；`whenIdle` 等当前轮次（含补跑）结束，供宿主与测试观测。
 */
export function mountToolScope(ctx, options) {
  const opts = options ?? {};
  const names = Object.freeze(Array.isArray(opts.toolNames) ? [...opts.toolNames] : []);
  const warnWith = typeof opts.warn === 'function' ? opts.warn : (message) => console.warn(message);
  const caps = probeCapabilities(ctx);

  const state = {
    disposed: false,
    /** 注入体是否已建立（一旦建立不再拆除：`ctx.inject` 是一次性挂载）。 */
    activated: false,
    /** 配置切回 global 后的挂起态：注入体留着，但不再判定、不再拦。 */
    suspended: false,
    /** 能力缺失 ⇒ guard 全拒（design §6 第一类）。 */
    denyAll: false,
    running: false,
    dirty: false,
    /** 判定缓存：agentId → 判定记录。guard 只读它（未命中时同步重判）。 */
    judgements: new Map(),
    /** 限制层账本：agentId → { dispose, reason }。 */
    layers: new Map(),
    workspaces: [],
    pathMap: new Map(),
    /** 注册表本轮是否给出了可用列表（false ⇒ 本轮不产生新判定）。 */
    listAvailable: false,
    resolveByPath: undefined,
    warned: new Set(),
    retried: new Set(),
    timers: new Set(),
    rootUnsubscribers: [],
    childUnsubscribers: [],
    releaseGuard: undefined,
    idleWaiters: [],
  };

  const warnOnce = (key, message) => {
    if (state.warned.has(key)) return;
    state.warned.add(key);
    try {
      warnWith(`${LABEL}: ${message}`);
    } catch {
      // 日志通道自身抛错不得影响判定链。
    }
  };

  const flushIdle = () => {
    for (const resolve of state.idleWaiters.splice(0)) resolve();
  };

  const whenIdle = () =>
    state.running ? new Promise((resolve) => state.idleWaiters.push(resolve)) : Promise.resolve();

  // ─── 限制层（差异式）─────────────────────────────────────

  function installLayer(rawAgent, judgement) {
    if (names.length === 0) return;
    const tools = rawAgent?.ctx?.tools;
    const restrict = typeof tools?.restrict === 'function' ? tools.restrict : undefined;
    if (restrict === undefined) {
      // 宿主整体不支持 restrict 时，装配期已 warn 过一条总说明，这里不再按 agent 刷屏。
      if (caps.canRestrict) {
        warnOnce(
          `restrict-missing:${judgement.agentId}`,
          `agent ${judgement.agentId} 没有 scoped tools.restrict，无法安装限制层——`
            + '这些工具对该会话保持可见，执行层 guard 仍会拒绝调用',
        );
      }
      return;
    }
    try {
      const dispose = restrict.call(tools, { deny: [...names] });
      state.layers.set(judgement.agentId, { dispose, reason: judgement.reason });
    } catch (error) {
      warnOnce(
        `restrict-failed:${judgement.agentId}`,
        `agent ${judgement.agentId} 的 tools.restrict 安装被宿主拒绝（${describeError(error)}）——`
          + '该会话本轮未隐藏工具，执行层 guard 仍会拒绝调用',
      );
    }
  }

  function releaseLayer(agentId) {
    const record = state.layers.get(agentId);
    if (record === undefined) return;
    // 先摘账本再释放：释放抛错时不会留下"以为还装着"的陈旧记录。
    state.layers.delete(agentId);
    try {
      record.dispose();
    } catch (error) {
      warnOnce(
        `release-failed:${agentId}`,
        `agent ${agentId} 的限制层释放失败（${describeError(error)}）——层可能仍在生效，重启 DSH 可清除`,
      );
    }
  }

  /** 把一条判定落成宿主事实（幂等：可见性与已装状态一致时不动宿主）。 */
  function applyJudgement(rawAgent, judgement) {
    state.judgements.set(judgement.agentId, judgement);
    const installed = state.layers.has(judgement.agentId);
    if (judgement.visible) {
      if (installed) releaseLayer(judgement.agentId);
      return;
    }
    if (!installed) installLayer(rawAgent, judgement);
  }

  // ─── 执行层兜底 ──────────────────────────────────────────

  /**
   * 同步裁决（guard 必须是同步的）。
   *
   * 优先级：挂起/不相关工具 ⇒ 放行；能力缺失 ⇒ 全拒；有缓存判定 ⇒ 照判定；
   * 无缓存 ⇒ 用 `resolveNow` **就地同步重判**（不 await、不写缓存）；仍判不出 ⇒ 放行。
   * 放行兜底的理由：`agent/created` 已 await 权威判定，缓存未命中是罕见窗口，
   * 把"还不知道"当成"拒绝"会让刚创建的会话平白失败。
   */
  function verdict(execution) {
    if (state.disposed || state.suspended) return undefined;
    const name = execution?.name;
    if (typeof name !== 'string' || !names.includes(name)) return undefined;
    if (state.denyAll) {
      return (
        `${LABEL}: 工具 ${name} 已配置为"仅指定工作区可见"，但宿主缺少判定工作区归属所需的能力`
        + '（ctx.inject / agents / workspaceRegistry），为避免在未选工作区暴露能力，调用被拒绝。'
      );
    }
    const agentId = execution?.agent?.id;
    if (agentId === undefined || agentId === null) return undefined;

    let judgement = state.judgements.get(agentId);
    if (judgement === undefined) {
      if (!state.listAvailable) return undefined;
      const agent = projectAgent(execution.agent);
      if (agent === undefined) return undefined;
      judgement = resolveNow({
        config: readScopeConfig(opts.scopeConfig),
        agent,
        workspaces: state.workspaces,
        pathMap: state.pathMap,
      });
      // 只有 `no-match` 算"同步窗口判不出"（它认不出 realpath 等价），放行交给异步轮次。
      // `no-cwd` / `unresolved` 都是**有结论的不可见**（design §5.4 / §6），必须拒绝。
      if (judgement.status === 'no-match') return undefined;
    }
    if (judgement.visible) return undefined;
    return (
      `${LABEL}: 工具 ${name} 在当前会话不可见——${judgement.reason}。`
      + '把该会话所在工作区加入插件配置的 scope.workspaceIds，或把 scope.mode 设为 global 即可恢复。'
    );
  }

  function installGuard() {
    if (!caps.canGuard) {
      warnOnce('guard-missing', '宿主缺 tools.guard：执行层兜底不可用，只剩装配层移除');
      return;
    }
    try {
      state.releaseGuard = ctx.tools.guard((execution) => verdict(execution));
    } catch (error) {
      warnOnce('guard-failed', `tools.guard 安装被宿主拒绝（${describeError(error)}）：执行层兜底不可用`);
    }
  }

  function releaseGuard() {
    const release = state.releaseGuard;
    state.releaseGuard = undefined;
    if (typeof release !== 'function') return;
    try {
      release();
    } catch (error) {
      warnOnce('guard-release', `guard 释放失败（${describeError(error)}）`);
    }
  }

  // ─── 工作区快照 ──────────────────────────────────────────

  function refreshWorkspaces() {
    const registry = state.registry;
    let list;
    try {
      list = registry.list();
    } catch (error) {
      state.listAvailable = false;
      warnOnce('workspace-list', `工作区注册表 list() 抛出（${describeError(error)}）——本轮不产生新判定，已有判定保留`);
      return false;
    }
    // 空表是**权威回答**（注册表确无工作区）：selected 下即"谁都不给"。
    state.workspaces = Array.isArray(list) ? readWorkspaces(list) : [];
    const pathMap = new Map();
    for (const workspace of state.workspaces) {
      if (workspace.path !== undefined) pathMap.set(workspace.path, workspace.id);
    }
    state.pathMap = pathMap;
    state.listAvailable = true;
    state.resolveByPath =
      typeof registry.resolveByPath === 'function'
        ? (path) => {
            let timer;
            const timeout = new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`resolveByPath 超过 ${RESOLVE_TIMEOUT_MS}ms 未返回`)),
                RESOLVE_TIMEOUT_MS,
              );
              if (typeof timer?.unref === 'function') timer.unref();
            });
            // 正常返回时必须清掉超时定时器：否则每次判定都留一个最长 1500ms 的待触发 timer，
            // 而且它不在 `state.timers` 里、`dispose` 清不掉。
            return Promise.race([Promise.resolve().then(() => registry.resolveByPath(path)), timeout]).finally(
              () => clearTimeout(timer),
            );
          }
        : undefined;
    return true;
  }

  // ─── 轮次 ────────────────────────────────────────────────

  function scheduleRetry(agentId) {
    if (state.retried.has(agentId)) return;
    state.retried.add(agentId);
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      requestRound();
    }, RETRY_DELAY_MS);
    if (typeof timer?.unref === 'function') timer.unref();
    state.timers.add(timer);
  }

  /** 判定一个 agent 并落成宿主事实；返回其判定（供 created 监听器 await）。 */
  async function judgeOne(rawAgent) {
    if (state.disposed || state.suspended || !state.activated) return undefined;
    const agent = projectAgent(rawAgent);
    if (agent === undefined) return undefined;
    if (!refreshWorkspaces()) {
      // §6：读失败时本轮不产生新判定，但要自愈——否则该会话会一直停在"可见"且永不重算。
      scheduleRetry(agent.id);
      return undefined;
    }

    const judgement = await judgeAgent({
      config: readScopeConfig(opts.scopeConfig),
      agent,
      workspaces: state.workspaces,
      pathMap: state.pathMap,
      resolveByPath: state.resolveByPath,
    });
    applyJudgement(rawAgent, judgement);
    if (judgement.status === 'unresolved') scheduleRetry(agent.id);
    return judgement;
  }

  /**
   * 读 live agent 列表，**区分"读失败"与"读成功但为空"**。
   *
   * 压成同一个 `[]` 会出人命：`roundOnce` 的残留层清理按"不在列表里 ⇒ 已消失 ⇒ 释放"工作，
   * 于是一次瞬时读失败会把**所有**已装限制层拆掉，而判定缓存仍记着"不可见"——工具重新出现
   * 在工具表里、每次调用却被 guard 拒绝，且没有任何路径把它们装回去（Gate 3 F1）。
   */
  function readLiveAgents() {
    try {
      const list = state.agents?.list?.();
      if (!Array.isArray(list)) return { ok: false, list: [] };
      return { ok: true, list };
    } catch (error) {
      warnOnce('agents-list', `agents.list() 抛出（${describeError(error)}）——本轮不产生新判定`);
      return { ok: false, list: [] };
    }
  }

  async function roundOnce() {
    const liveIds = new Set();
    // 每轮只读一次注册表：即使本轮没有 live agent，也要让 `listAvailable`/路径表反映宿主现状
    // （guard 的同步重判读的正是这份快照）。
    refreshWorkspaces();
    const live = readLiveAgents();
    if (!live.ok) {
      // 读失败 ⇒ 本轮不产生新判定（既不改层，也不做"已消失"清理），并排一次有界复检。
      scheduleRetry('agents-list');
      return;
    }
    for (const rawAgent of live.list) {
      const projected = projectAgent(rawAgent);
      if (projected !== undefined) liveIds.add(projected.id);
      if (state.suspended) return;
      await judgeOne(rawAgent);
    }
    // 已消失的 agent：释放残留层（agent/disposed 通常已经做过，这里兜底）。
    // 只有**读成功**才走到这里：`ok && list.length === 0` 才是"确实一个都没有"。
    for (const agentId of [...state.layers.keys()]) {
      if (!liveIds.has(agentId)) releaseLayer(agentId);
    }
  }

  async function runRound() {
    state.running = true;
    try {
      do {
        state.dirty = false;
        await roundOnce();
      } while (state.dirty && !state.disposed);
    } catch (error) {
      warnOnce('round-failed', `判定轮次异常（${describeError(error)}）——维持上一轮判定`);
    } finally {
      state.running = false;
      // 一轮跑完（含补跑）后重置复检计数：有界复检是"每次失败至多一次"，
      // 不是"每个 agent 一生一次"——否则一次瞬时失败就永久失去自愈能力。
      state.retried.clear();
      flushIdle();
    }
  }

  /** 合并闸门：进行中只置脏；空闲则起一轮。 */
  function requestRound() {
    if (state.disposed || state.suspended || !state.activated) return;
    if (state.running) {
      state.dirty = true;
      return;
    }
    void runRound();
  }

  // ─── 注入、激活与挂起 ────────────────────────────────────

  function subscribe(target, event, handler) {
    if (typeof target?.on !== 'function') return;
    try {
      const off = target.on(event, handler);
      if (typeof off === 'function') state.childUnsubscribers.push(off);
    } catch (error) {
      warnOnce(`subscribe:${event}`, `订阅 ${event} 失败（${describeError(error)}）`);
    }
  }

  function activate(child) {
    if (state.disposed) return undefined;
    const agents = child?.agents;
    const registry = child?.workspaceRegistry;
    if (typeof agents?.list !== 'function' || typeof registry?.list !== 'function') {
      state.denyAll = true;
      warnOnce(
        'services',
        '注入到的 agents / workspaceRegistry 不可用：无法判定工作区归属，'
          + '按"仅指定工作区可见"的最严口径拒绝本插件工具调用',
      );
      return undefined;
    }
    state.agents = agents;
    state.registry = registry;

    if (!caps.canRestrict) {
      warnOnce(
        'restrict-unsupported',
        '宿主缺 tools.restrict：降级为"仅执行层拒绝"（工具仍出现在工具表里，调用会被 guard 拒绝）',
      );
    }

    // created 的监听器**返回 promise**：宿主 await 后才让该会话进入第一轮（design §5.4 G8）。
    // 但它**绝不能 reject**——宿主把监听器失败当成会话创建失败（落地审查 F2），
    // 判定失败最多是"这一轮没隐藏工具"，不该连累用户开不了会话。
    subscribe(child, 'agent/created', (payload) =>
      judgeOne(payload?.agent).catch((error) => {
        warnOnce(
          'created-failed',
          `agent/created 判定失败（${describeError(error)}）——该会话本轮按"未判定"放行，不影响会话创建`,
        );
      }),
    );
    subscribe(child, 'agent/disposed', (payload) => {
      const agentId = payload?.agent?.id;
      if (typeof agentId === 'string') {
        state.judgements.delete(agentId);
        releaseLayer(agentId);
      }
      requestRound();
    });
    subscribe(child, 'tools/change', () => requestRound());

    requestRound();
    return undefined;
  }

  /**
   * 让子系统跟随配置的当前取值：`selected` 才激活；切回 `global` 则挂起并释放一切。
   *
   * 之所以不是"装配时判一次就完事"：宿主对 volatile-only 变更**不重挂插件**，
   * 只能靠 `loader/volatile-update` 就地切换（design §4 步 7）。
   */
  function syncMode() {
    if (state.disposed) return;
    const { mode, problem } = readScopeConfig(opts.scopeConfig);
    if (problem === 'invalid') {
      warnOnce(
        'invalid-config',
        'scope 配置非法（mode 非 global/selected 或 workspaceIds 非字符串数组）——'
          + '按最严口径处理：仅指定工作区可见且名单为空（谁都不给）',
      );
    }

    if (mode !== 'selected') {
      // 回到 global：**无条件**释放一切——包括 `ctx.inject` 抛错后留下的 `denyAll` 与 guard。
      // 只看 `activated` 就短路会让默认 global 下三个工具永久不可调用（Gate 3 F6）。
      state.suspended = true;
      for (const agentId of [...state.layers.keys()]) releaseLayer(agentId);
      state.judgements.clear();
      state.denyAll = false;
      releaseGuard();
      return;
    }

    state.suspended = false;
    if (!caps.canOn) {
      warnOnce(
        'on-missing',
        '宿主缺 ctx.on：只在装配时判定一次——新会话不会被判定，配置改动需重启 DSH 才生效',
      );
    }

    if (state.activated) {
      if (state.releaseGuard === undefined) installGuard();
      requestRound();
      return;
    }

    state.activated = true;
    installGuard();
    if (!caps.canInject) {
      state.denyAll = true;
      warnOnce(
        'inject-missing',
        '宿主缺 ctx.inject：无法判定工作区归属，按"仅指定工作区可见"的最严口径拒绝本插件工具调用',
      );
      return;
    }
    try {
      ctx.inject([...INJECT_KEYS], (child) => activate(child));
    } catch (error) {
      // 注入失败：回到"未激活"，并把已经装上的 guard 与 denyAll 一起撤掉——
      // 否则默认 global 下会全拒（Gate 3 F6）。
      state.activated = false;
      state.denyAll = false;
      releaseGuard();
      warnOnce('inject-failed', `ctx.inject 失败（${describeError(error)}）：工具可见范围不启用`);
    }
  }

  function teardown() {
    for (const off of state.childUnsubscribers.splice(0)) {
      try {
        off();
      } catch {
        // 退订失败不得阻塞拆除。
      }
    }
    for (const timer of state.timers) clearTimeout(timer);
    state.timers.clear();
    for (const agentId of [...state.layers.keys()]) releaseLayer(agentId);
    releaseGuard();
  }

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    for (const off of state.rootUnsubscribers.splice(0)) {
      try {
        off();
      } catch {
        // 同上：拆除路径不抛。
      }
    }
    teardown();
    state.judgements.clear();
    flushIdle();
  }

  // 配置变更的观察点：装配期**无条件**建立（global → selected 的那次切换只有这一个信号）。
  if (caps.canOn) {
    try {
      const off = ctx.on('loader/volatile-update', () => syncMode());
      if (typeof off === 'function') state.rootUnsubscribers.push(off);
    } catch (error) {
      warnOnce('subscribe:volatile', `订阅 loader/volatile-update 失败（${describeError(error)}）`);
    }
  }

  syncMode();

  return { dispose, whenIdle };
}
