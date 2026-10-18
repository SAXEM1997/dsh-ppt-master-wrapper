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

/** 有界复检的间隔。 */
const RETRY_DELAY_MS = 1000;

/**
 * 有界复检的**次数上限**（每个 key 每个"失败周期"内）。
 *
 * 额度**按 key 记账、按该 key 自己的结果清零**（Gate 3 R3-1）：`agents-list` 在读成功的
 * 那一轮清零，agent 额度只在它的判定**不再是 unresolved** 时清零。若按"整轮成功"整批清零，
 * 判定级 unresolved（cwd 被删 ⇒ realpath ENOENT、挂载点挂死 ⇒ 1500ms 超时）会让额度每轮
 * 归零 ⇒ 无界轮询，且每个未决 agent 每轮各排一个 timer ⇒ N 个 agent 轮次按 N^t 放大。
 * 额度耗尽后靠外部事件自愈（tools/change / loader/volatile-update / agent/created）。
 */
const MAX_RETRIES = 3;

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

/**
 * 注入看门狗的上界（M6）：`selected` 激活后这么久注入回调仍未到达，就点名告警。
 *
 * 背景：宿主缺 `agents`/`workspaceRegistry` 任一服务时，`ctx.inject([...], cb)` 的回调
 * **永不触发**（cordis 对永不可用的服务不回调）。此时 `capabilityLost` 恒 false、无判定、
 * 零告警 ⇒ `selected` 完全空转（工具处处可见且可调用），违背 design §6「能力缺失 ⇒ 全拒」。
 *
 * 只补**可诊断性**，不改 fail 语义（不因此置 `denyAll`）：pending 的常见成因是服务稍后才
 * 就绪，此时置全拒会让一批合法调用在窗口内失败。watchdog 只在 `selected` 下启动。
 */
const INJECT_WATCHDOG_MS = 5000;

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
    /**
     * 能力缺失 ⇒ guard 全拒（design §6 第一类）。
     *
     * 它是**每次进入 selected 时**由 {@link state.capabilityLost} 重新算出来的派生值：
     * 挂起（global）期间不动它，因为 `verdict` 已被 `suspended` 短路；而能力结论本身
     * 必须**粘住**，否则"global 走一圈再回来"会把 fail-closed 变成 fail-open（Gate 3 R2-1）。
     */
    denyAll: false,
    /** 能力结论（粘性）：注入服务不可用 / 宿主无 `ctx.inject` / 注入抛错 ⇒ true。 */
    capabilityLost: false,
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
    /**
     * 有界复检计数：key → 已排次数。**按 key 自己的结果清零**（不是整轮清零）：
     * `agents-list` 在读成功的一轮清零（`roundOnce`）；agent 额度在其判定不再是
     * unresolved 时清零（`judgeOne`）。整轮清零会让判定级 unresolved 永远有额度，
     * 退化成无界轮询（Gate 3 R3-1）。
     */
    retries: new Map(),
    /** 每个 key 同时最多一个在飞复检 timer（`scheduleRetry` 去重用，Gate 3 R3-1）。 */
    pendingRetries: new Set(),
    /** 代际令牌：`syncMode`/`dispose` 自增，在飞轮次回来时代际不符即丢弃（Gate 3 R2-3）。 */
    epoch: 0,
    timers: new Set(),
    /** 注入回调是否已到达（M6 看门狗的触发条件之一）。 */
    injected: false,
    /** 注入看门狗 timer（未到点时持引用，`activate`/`dispose`/切回 global 都要清掉）。 */
    watchdog: undefined,
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

  // ─── 注入看门狗（M6）─────────────────────────────────────
  //
  // 只观察、不干预：回调到点未到达 ⇒ `warnOnce` 一条点名告警，**不**置 `denyAll`。
  // 三条纪律：① 只在 selected 启动（global 下启动会让默认配置冒出日志，红线）；
  // ② timer 必须 `unref()`，否则 pending 注入会把进程钉住；③ 拆除/切回 global/回调到达
  // 三条路径都要 clear，避免拆后仍触发。

  function clearInjectionWatchdog() {
    const timer = state.watchdog;
    if (timer === undefined) return;
    state.watchdog = undefined;
    state.timers.delete(timer);
    clearTimeout(timer);
  }

  function startInjectionWatchdog() {
    // 注入回调已到达过、已拆除、已挂起、或已在计时 ⇒ 都不重排（重排只会推迟告警）。
    if (state.injected || state.disposed || state.suspended) return;
    if (state.watchdog !== undefined) return;
    const timer = setTimeout(() => {
      state.watchdog = undefined;
      state.timers.delete(timer);
      if (state.disposed || state.suspended || state.injected) return;
      warnOnce(
        'inject-pending',
        `scope.mode=selected 已启用，但 agents/workspaceRegistry 的注入 ${INJECT_WATCHDOG_MS}ms 内未到达`
          + '（宿主缺其中一个服务时 ctx.inject 的回调永不触发）——工具可见范围判定未生效，'
          + '本插件工具当前对所有会话可见且可调用；补齐宿主服务或把 scope.mode 设为 global',
      );
    }, INJECT_WATCHDOG_MS);
    if (typeof timer?.unref === 'function') timer.unref();
    state.watchdog = timer;
    state.timers.add(timer);
  }

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

  /**
   * 清掉某个 agent 的**记账键**（M19）：`state.retries` 里的 agent 键与 `state.warned` 里
   * 以该 agent 结尾的告警键（`restrict-missing:<id>` / `restrict-failed:<id>` /
   * `release-failed:<id>`）。
   *
   * 为什么必须清：这两张表在长寿命宿主上只增不减——`agent/disposed` 只删判定与层，
   * 于是每次会话开关都留下几条永不回收的键。retries 里的 agent 键必须用**全等**匹配，
   * 不得用前缀/包含（非 agent 键 `agents-list` 不能被误删，agent id 也可能与它撞形）。
   * warned 的键都是 `<kind>:<agentId>` 形态，故按「冒号之后 == agentId」精确匹配。
   */
  function forgetAgentBookkeeping(agentId) {
    state.retries.delete(agentId);
    const suffix = `:${agentId}`;
    for (const key of [...state.warned]) {
      if (key.endsWith(suffix)) state.warned.delete(key);
    }
    // 在飞复检 timer 的 key 也一并摘掉：它到点后只是触发一次轮次，没必要记着。
    state.pendingRetries.delete(agentId);
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
    // 幂等：已装则不重装。inject 抛错期间每次 selected→selected（volatile 更新）都会重新
    // 走到激活分支，若不判重，旧 disposer 会被覆盖丢失、宿主 guard 层无限累积——每次工具
    // 调用都多跑 N 条陈旧回调，且"global 释放 guard"名存实亡（Gate 3 R3-2）。
    if (state.releaseGuard !== undefined) return;
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
      // 刻意**不清空** `state.workspaces`/`state.pathMap`：读失败时保留上一轮快照供 guard
      // 同步重判（§6 第二类：瞬时读失败 ⇒ 已有判定保留）。置空会让 guard 在下一秒把
      // 所有会话判成 no-match 并放行，等于一次抖动抹掉用户的工作区可见性。
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

  function scheduleRetry(key) {
    // 同 key 去重：同一波里多个轮次都想排同一 key 时只排一个。没有这条，"每轮每个未决
    // agent 各排一个 timer"会在同一秒内叠加出 N 个在飞 timer ⇒ 轮次按 N^t 放大（R3-1）。
    if (state.pendingRetries.has(key)) return;
    const used = state.retries.get(key) ?? 0;
    if (used >= MAX_RETRIES) return;
    state.retries.set(key, used + 1);
    const timer = setTimeout(() => {
      state.pendingRetries.delete(key);
      state.timers.delete(timer);
      requestRound();
    }, RETRY_DELAY_MS);
    if (typeof timer?.unref === 'function') timer.unref();
    state.timers.add(timer);
    state.pendingRetries.add(key);
  }

  /**
   * 判定一个 agent 并落成宿主事实；返回其判定（供 created 监听器 await）。
   *
   * `listOk` 是本轮工作区快照的**新鲜度**（由调用方刷新一次后传下来，M22）：`roundOnce`
   * 已经刷过，`judgeOne` 不再各刷一遍（否则每轮 N+1 次 `registry.list()`）；单 agent 的
   * 入口（`agent/created`）自己调一次 {@link refreshWorkspaces} 并把结果传进来。
   * 读失败（`listOk === false`）时的既有语义不变：本轮不产生新判定 + 排有界复检。
   *
   * `listOk` 缺席（`undefined`）⇒ 视为"调用方没刷新过"，这里自己刷一次以保住旧契约。
   */
  async function judgeOne(rawAgent, listOk) {
    if (state.disposed || state.suspended || !state.activated) return undefined;
    const epoch = state.epoch;
    const agent = projectAgent(rawAgent);
    if (agent === undefined) return undefined;
    const fresh = listOk ?? refreshWorkspaces();
    if (!fresh) {
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
    // await 回来时世界可能已经变了：挂起（切回 global）、被拆除、或已换代。
    // 直接落判定会把刚释放的层**重新装回**——global 下该会话继续被隐藏，
    // 甚至在 dispose 之后留下一个永不释放的层（Gate 3 R2-3）。
    if (state.disposed || state.suspended || epoch !== state.epoch) return undefined;
    applyJudgement(rawAgent, judgement);
    // 判定级额度：只有"判出来了"（含可见、no-cwd、no-match——它们都是有结论的）才清零；
    // unresolved 消耗额度换一次有界复检。绝不能随"整轮成功"整批清零——注册表和 agent
    // 列表都读得好好的，唯独这个 agent 的 resolveByPath 一直抛错/超时，是完全现实的
    // 状态（cwd 被删、挂载点挂死），整批清零会让它每轮都满额度 ⇒ 无界轮询（R3-1）。
    if (judgement.status === 'unresolved') {
      scheduleRetry(agent.id);
    } else {
      state.retries.delete(agent.id);
    }
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
    // 每轮只读一次注册表（M22）：即使本轮没有 live agent，也要让 `listAvailable`/路径表
    // 反映宿主现状（guard 的同步重判读的正是这份快照）。结果**必须**传给各 judgeOne，
    // 否则每个 agent 各刷一遍 = 每轮 N+1 次 `registry.list()`，且本轮这份返回值白算。
    const listOk = refreshWorkspaces();
    const live = readLiveAgents();
    if (!live.ok) {
      // 读失败 ⇒ 本轮不产生新判定（既不改层，也不做"已消失"清理），并排一次有界复检。
      scheduleRetry('agents-list');
      return;
    }
    // 读成功 ⇒ 该 key 的复检额度恢复：下次再遇到读失败，重新有 MAX_RETRIES 次自愈机会。
    state.retries.delete('agents-list');
    for (const rawAgent of live.list) {
      const projected = projectAgent(rawAgent);
      if (projected !== undefined) liveIds.add(projected.id);
      if (state.suspended) return;
      await judgeOne(rawAgent, listOk);
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
    // 回调到达：注入了就是注入了（哪怕服务不可用——后者已有自己的 fail-closed 告警），
    // 看门狗不再有意义。
    state.injected = true;
    clearInjectionWatchdog();
    const agents = child?.agents;
    const registry = child?.workspaceRegistry;
    if (typeof agents?.list !== 'function' || typeof registry?.list !== 'function') {
      state.capabilityLost = true;
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
    state.capabilityLost = false;
    state.denyAll = false;

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
        forgetAgentBookkeeping(agentId);
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
      // 回到 global：释放层与 guard（只看 `activated` 就短路会让默认 global 下三个工具
      // 永久不可调用——Gate 3 F6）。**但不动 `denyAll`**：它承载"能力缺失"这一粘性事实，
      // 而 global 下 `verdict` 已被 `suspended` 短路，不需要靠清零来放行（Gate 3 R2-1）。
      // 看门狗也必须在这里停：global 是"没有这个特性"的等价态，任何后续日志都是新增噪声。
      clearInjectionWatchdog();
      state.suspended = true;
      state.epoch += 1; // 在飞轮次据此丢弃，避免把刚释放的层装回去（R2-3）
      for (const agentId of [...state.layers.keys()]) releaseLayer(agentId);
      state.judgements.clear();
      releaseGuard();
      return;
    }

    state.suspended = false;
    // 每次进入 selected 都按**能力结论**重算全拒开关（能力结论是粘性的）。
    state.denyAll = state.capabilityLost;
    if (!caps.canOn) {
      warnOnce(
        'on-missing',
        '宿主缺 ctx.on：只在装配时判定一次——新会话不会被判定，配置改动需重启 DSH 才生效',
      );
    }

    if (state.activated) {
      installGuard(); // 自身幂等：已装不重装
      requestRound();
      return;
    }

    state.activated = true;
    installGuard();
    if (!caps.canInject) {
      state.capabilityLost = true;
      state.denyAll = true;
      warnOnce(
        'inject-missing',
        '宿主缺 ctx.inject：无法判定工作区归属，按"仅指定工作区可见"的最严口径拒绝本插件工具调用',
      );
      return;
    }
    // 看门狗在 `inject` **之前**启动：`inject` 自身同步抛错有 `inject-failed` 告警，回调
    // 同步到达则 `activate` 立刻清掉它；只有"登记了但永不回调"这条静默路径需要它。
    startInjectionWatchdog();
    try {
      ctx.inject([...INJECT_KEYS], (child) => activate(child));
    } catch (error) {
      // 注入失败 ⇒ 与"宿主无 ctx.inject"同一口径：**fail-closed**（guard 留着、全拒），
      // 并记为粘性能力缺失，切回 global 时才释放 guard。切到 global 仍然完全放行，
      // 所以这不会把用户锁死在不可用状态（Gate 3 F6 + R2-1）。
      clearInjectionWatchdog();
      state.activated = false;
      state.capabilityLost = true;
      state.denyAll = true;
      warnOnce(
        'inject-failed',
        `ctx.inject 失败（${describeError(error)}）：无法判定工作区归属，按"仅指定工作区可见"的最严口径拒绝本插件工具调用`,
      );
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
    state.watchdog = undefined; // 引用一并清掉（timer 本身由下面的清账覆盖）
    for (const timer of state.timers) clearTimeout(timer);
    state.timers.clear();
    state.pendingRetries.clear();
    for (const agentId of [...state.layers.keys()]) releaseLayer(agentId);
    releaseGuard();
  }

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    state.epoch += 1; // 在飞轮次回来时丢弃判定，不得在拆除后再装层（R2-3）
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
