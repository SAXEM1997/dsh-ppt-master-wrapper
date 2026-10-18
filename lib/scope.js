/**
 * 工具可见范围（scope）的**纯逻辑**层：配置归一化、可见性严格序、agent → 工作区判定、
 * 工作区/工具名的边界投影。
 *
 * 本模块**不 import 任何宿主包、不碰 fs、不碰 ctx**：判定规则全部是纯函数，因此可以在
 * `node --test` 里直接锁死（design §7 纯逻辑单测）。宿主集成（探针、注入、restrict/guard
 * 的安装与释放、事件订阅、轮次合并）全部在 `lib/scope-host.js`，两者只经本文件的导出交接。
 *
 * 三条承载语义（design §5.2）：
 *  1. **默认 global**：与参考实现 dsh-cherry-bridge 的 `selected + []`（谁都不给）相反——
 *     本插件的默认配置必须与"没有这个特性"逐字等价（澄清 [Q2]）。
 *  2. **selected 是 fail-closed**：只有命中名单的工作区可见；无 cwd、路径不属任何已登记
 *     工作区、名单为空，一律不可见（澄清 [Q2] 与 cherry 一致）。
 *  3. **比较归一化不改写语义**：名单在读取时 trim/去空/去重/升序，`isVisible` 两侧同样经
 *     `String().trim()` 比较；不做大小写折叠、不做路径猜测。
 *
 * @module dsh-ppt-master-wrapper/scope
 */

/** 配置顶层键（`index.js` 的 Config schema 与客户端卡片的 ops 路径共用这一处字面量）。 */
export const SCOPE_KEY = 'scope';

/** 两个合法模式（冻结：调用方不得就地改写）。 */
export const SCOPE_MODES = Object.freeze(['global', 'selected']);

/**
 * 缺省配置：**global + 空名单**。
 *
 * 空名单在 global 下不参与判定（`isVisible` 对 global 恒真），故"默认谁都不限制"。
 * 整体与内层数组都冻结：任何调用方拿到的都是同一份不可变常量，避免"某处顺手 push 一下
 * 就污染了所有实例"。
 */
export const SCOPE_DEFAULT = Object.freeze({
  mode: 'global',
  workspaceIds: Object.freeze([]),
});

/** 单条判定状态的四个取值（design §5.4）。 */
export const JUDGEMENT_STATUSES = Object.freeze(['resolved', 'no-cwd', 'no-match', 'unresolved']);

/**
 * 解引用一个可能被 `.volatile()` 包过的配置叶子。
 *
 * 宿主 schemastery 的 `.volatile()` 把叶子换成带 `.get()` 的引用对象；**必须每次读取时
 * 现解引用**——`cordis-plugin-loader` 对"只改 volatile 叶子"的配置变更走 `_commitVolatile()`：
 * 原地更新引用、**不重挂插件**（`lib/index.js:382-424`）。apply 期拍平的普通值因此永远是旧的
 * （design §4 步 2）。
 *
 * `get()` 抛错按"读不出来"处理（返回 `undefined`），由调用方归到 invalid——本模块的任何
 * 函数都不向外抛，判定链上抛错会直接变成"插件装配失败"。
 */
function deref(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/**
 * `String(value)` 的安全版：转换抛错（敌意对象的 throwing `toString`/`valueOf`、
 * `Symbol.toPrimitive`）按"取不到文本"返回 `undefined`。
 *
 * 本模块的对外承诺是"任何函数都不向外抛"（见模块头）：装配期 `syncMode` → `readScopeConfig`
 * 抛错会一路穿透 `mountToolScope` → `apply`，把**整个插件（含 vendor 技能面）**装载失败。
 * 所有文本转换都必须经这里，不得直接写 `String(...)`。
 */
function safeString(value) {
  try {
    return String(value);
  } catch {
    return undefined;
  }
}

/** `String(value).trim()`，无可用文本时 `undefined`（空串、null、undefined、转换抛错都算没有）。 */
function usableText(value) {
  if (value === undefined || value === null) return undefined;
  const text = safeString(value);
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 归一化一份 scope 配置（唯一入口；`mountToolScope` 每轮判定前都调它）。
 *
 * @param {unknown} raw 配置叶子容器：`{ mode, workspaceIds }`，两个字段都可以是 volatile
 *   引用对象；也可以整体是 `undefined`（未配置）或任意敌人形状。
 * @returns {{ mode: 'global'|'selected', workspaceIds: string[], problem?: 'invalid' }}
 *   - **缺省**（整体不可读，或两个键都没给）⇒ `SCOPE_DEFAULT`（global），**无** `problem`：
 *     未配置不是错误（澄清 [Q2]：本插件默认全局）；
 *   - **非法**（任一键在场但类型/取值不对）⇒ **更严一侧** `selected + []`（谁都不给）+
 *     `problem: 'invalid'`。这与参考实现 cherry 的"读不出/非法一律落到更严一侧"一致
 *     （澄清 §0），也是 Gate 0 对齐审查 F5 的裁决：同一"非法"不得有两种处置——
 *     宿主 schema 校验在装载期先拦（`ValidationError`），走到这里的非法值只可能来自
 *     测试/嵌入路径或跳过校验的宿主，此时"静默放宽成 global"等于把用户的收窄配置无声作废；
 *   - 合法 ⇒ 名单逐项 `String().trim()`、去空、去重、升序（比较归一化，不改写存储语义）。
 */
export function readScopeConfig(raw) {
  const container = deref(raw);
  if (container === null || typeof container !== 'object' || Array.isArray(container)) {
    return { mode: SCOPE_DEFAULT.mode, workspaceIds: [] };
  }

  const rawMode = deref(container.mode);
  const rawIds = deref(container.workspaceIds);

  // 两个键都没给 ⇒ 与"未配置"同形（宿主 schema 已填默认值，这条只服务测试/嵌入路径）。
  if (rawMode === undefined && rawIds === undefined) {
    return { mode: SCOPE_DEFAULT.mode, workspaceIds: [] };
  }

  if (!SCOPE_MODES.includes(rawMode) || !Array.isArray(rawIds)) {
    return { mode: 'selected', workspaceIds: [], problem: 'invalid' };
  }

  const ids = [];
  const seen = new Set();
  for (const item of rawIds) {
    const text = usableText(item);
    if (text === undefined || seen.has(text)) continue;
    seen.add(text);
    ids.push(text);
  }
  ids.sort();
  return { mode: rawMode, workspaceIds: ids };
}

/**
 * 可见性严格序（design §5.2）——本模块**唯一**决定"看得见/看不见"的地方。
 *
 * - `global`：恒真，含 `workspaceId === undefined`（无归属会话也看得见，因为没在限制）；
 * - `selected`：命中名单才真；`undefined`、未命中、空名单一律假（fail-closed，澄清 [Q2]）。
 *
 * 两侧都经 `usableText` 归一后比较：`'  w1 '` 与 `'w1'` 相等，但 `'W1'` 与 `'w1'` 不等
 * （不做大小写折叠——工作区 id 是 UUID，折叠只会掩盖配置错误）。
 */
export function isVisible(config, workspaceId) {
  const mode = config?.mode === 'selected' ? 'selected' : 'global';
  if (mode === 'global') return true;
  const wanted = usableText(workspaceId);
  if (wanted === undefined) return false;
  const ids = Array.isArray(config?.workspaceIds) ? config.workspaceIds : [];
  return ids.some((id) => usableText(id) === wanted);
}

/** 工作区标签：有 title 用 `工作区「title」(id)`，无 title 用 `工作区 id`。 */
export function describeWorkspace(workspace) {
  const id = usableText(workspace?.id);
  if (id === undefined) return '未知工作区';
  const title = usableText(workspace?.title);
  return title === undefined ? `工作区 ${id}` : `工作区「${title}」(${id})`;
}

/**
 * 把活 agent 投影成判定需要的两字段（`id` + `cwd`）。
 *
 * 投影放在纯逻辑层，`judgeAgent`/`resolveNow` 就只依赖 `{ id, cwd? }`：测试不必造活 agent，
 * 宿主侧也不必把 `agent.session.header` 的形状泄漏进判定规则。
 * 无可用 id ⇒ `undefined`（调用方跳过该 agent，而不是给它一个假身份）。
 */
export function projectAgent(agent) {
  const id = usableText(agent?.id);
  if (id === undefined) return undefined;
  const cwd = usableText(agent?.session?.header?.cwd);
  return cwd === undefined ? { id } : { id, cwd };
}

/**
 * 归一化工作区注册表列表。
 *
 * 注册表的返回类型不是我们能假设的（id 不保证是字符串、`sessionIds` 不保证是数组），
 * 因此每个文本字段都过 `usableText` / `safeString`（**永不抛**：throwing `toString` 的
 * 敌意项按"取不到文本"处理，不得把注册表数据变成装配期异常）；无 id 的项被丢弃
 * （它无法与名单比较），`sessionIds` 非数组退化为 `[]` 而不是抛错。
 *
 * 转换失败的 `sessionIds` 元素被**丢弃**而不是塞进空串：它们不可能等于任何 agent id，
 * 塞 `''` 只会多造一个"空身份"成员位。
 */
export function readWorkspaces(list) {
  if (!Array.isArray(list)) return [];
  const workspaces = [];
  for (const raw of list) {
    const id = usableText(raw?.id);
    if (id === undefined) continue;
    const path = usableText(raw?.path);
    const title = safeString(raw?.title);
    const sessionIds = [];
    if (Array.isArray(raw?.sessionIds)) {
      for (const value of raw.sessionIds) {
        const text = safeString(value);
        if (text !== undefined) sessionIds.push(text);
      }
    }
    workspaces.push({
      id,
      title: title === undefined ? '' : title,
      ...(path === undefined ? {} : { path }),
      sessionIds,
    });
  }
  return workspaces;
}

/**
 * 从 `createTools()` 的产出派生工具名清单（design §5.6 / 澄清 C7）。
 *
 * **不写第二份字面量**：`tools.restrict()` 对未知全局工具名会直接抛错，名字清单与注册清单
 * 一旦漂移，限制层就装不上（而失败只表现为"没隐藏"）。返回冻结数组，按注册顺序。
 */
export function toolNamesOf(tools) {
  if (!Array.isArray(tools)) return Object.freeze([]);
  const names = [];
  for (const tool of tools) {
    const name = usableText(tool?.name);
    if (name !== undefined) names.push(name);
  }
  return Object.freeze(names);
}

/** 造一条判定记录；`workspaceId`/`cwd` 缺席时**省略字段**（`Object.hasOwn` 仍能区分）。 */
function judged(config, agent, status, workspaceId, reason) {
  const record = {
    agentId: agent.id,
    status,
    visible: isVisible(config, workspaceId),
    reason,
  };
  if (workspaceId !== undefined) record.workspaceId = workspaceId;
  if (agent.cwd !== undefined) record.cwd = agent.cwd;
  return record;
}

/** 规则一：会话成员命中（工作区的 `sessionIds` 含该 agent）。 */
function bySessionMembership(agent, workspaces) {
  return workspaces.find((workspace) => workspace.sessionIds.includes(agent.id));
}

/**
 * **同步**判定（design §5.2/§5.3）：规则一 + 缓存路径表，不 `await`、不调宿主。
 *
 * **唯一用途是 guard 的同步裁决**——guard 必须是同步的，而判定缓存可能尚未填上（`agent/created`
 * 已被宿主 await，所以这是罕见窗口）。它**不**用于"先装层再纠正"：那会让 realpath 等价的
 * 会话先被藏掉工具（design §5.4 / §11 F6 已取消该做法）。
 * 认不出 realpath 等价是它的已知边界，调用方据此只把 `no-match` 当"判不出"。
 */
export function resolveNow({ config, agent, workspaces, pathMap }) {
  const list = Array.isArray(workspaces) ? workspaces : [];

  const member = bySessionMembership(agent, list);
  if (member !== undefined) {
    return judged(config, agent, 'resolved', member.id, `会话成员命中 ${describeWorkspace(member)}`);
  }

  if (agent.cwd === undefined) {
    return judged(
      config,
      agent,
      'no-cwd',
      undefined,
      '会话 header 无 cwd，路径规则无法判定（selected 下不可见）',
    );
  }

  const workspaceId = pathMap?.get?.(agent.cwd);
  if (workspaceId === undefined) {
    return judged(
      config,
      agent,
      'no-match',
      undefined,
      `cwd ${agent.cwd} 在规范路径表里没有匹配项（同步首判不含 realpath，异步轮次会精化）`,
    );
  }
  return judged(
    config,
    agent,
    'resolved',
    workspaceId,
    `规范化路径命中 ${labelOf(list, workspaceId)}`,
  );
}

/**
 * 异步精化判定（design §5.4）：规则一 → 规则二（`resolveByPath` 规范路径）。
 *
 * 与 `resolveNow` 的差别只在规则二：这里用宿主注册表的 `resolveByPath(cwd)` 拿**规范路径**
 * 对应的实体，因此符号链接与拼写差异都能收敛。三态语义严格区分：
 * - 实体在场 ⇒ `resolved`（可见性仍只由 `isVisible` 决定）；
 * - 返回 `undefined` ⇒ `no-match`（宿主明确回答"我不拥有这个目录"）；
 * - 抛错 ⇒ `unresolved`（"这次答不上来"，宿主侧对它有界复检）。
 * 宿主没有 `resolveByPath` 时退化为路径字符串等价（不做大小写/尾斜杠猜测）。
 */
export async function judgeAgent({ config, agent, workspaces, pathMap, resolveByPath }) {
  const list = Array.isArray(workspaces) ? workspaces : [];

  const member = bySessionMembership(agent, list);
  if (member !== undefined) {
    return judged(config, agent, 'resolved', member.id, `会话成员命中 ${describeWorkspace(member)}`);
  }

  if (agent.cwd === undefined) {
    return judged(
      config,
      agent,
      'no-cwd',
      undefined,
      '会话 header 无 cwd，路径规则无法判定（selected 下不可见）',
    );
  }

  if (typeof resolveByPath !== 'function') {
    const workspaceId = pathMap?.get?.(agent.cwd);
    return workspaceId === undefined
      ? judged(
          config,
          agent,
          'no-match',
          undefined,
          `宿主无 resolveByPath，cwd ${agent.cwd} 与任何注册表项都不字符串等价（不做 realpath）`,
        )
      : judged(config, agent, 'resolved', workspaceId, `路径字符串等价命中 ${labelOf(list, workspaceId)}`);
  }

  let entity;
  try {
    entity = await resolveByPath(agent.cwd);
  } catch {
    return judged(
      config,
      agent,
      'unresolved',
      undefined,
      `cwd ${agent.cwd} 本次解析失败（注册表未就绪或 realpath 失败），有界复检后仍失败即维持不可见`,
    );
  }

  if (entity === undefined) {
    return judged(
      config,
      agent,
      'no-match',
      undefined,
      `宿主不拥有目录 ${agent.cwd}（resolveByPath 返回 undefined），不属任何已登记工作区`,
    );
  }

  const resolved = usableText(entity?.id);
  if (resolved === undefined) {
    return judged(
      config,
      agent,
      'no-match',
      undefined,
      `cwd ${agent.cwd} 解析出的注册表项没有可用 id，不参与匹配`,
    );
  }
  return judged(config, agent, 'resolved', resolved, `规范化路径命中 ${labelOf(list, resolved)}`);
}

/** 工作区 id → 展示标签；不在本轮列表里就退化成 `工作区 <id>`。 */
function labelOf(workspaces, workspaceId) {
  const workspace = workspaces.find((item) => item.id === workspaceId);
  return workspace === undefined ? `工作区 ${workspaceId}` : describeWorkspace(workspace);
}
