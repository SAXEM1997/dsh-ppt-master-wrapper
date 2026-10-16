/**
 * dsh-ppt-master-wrapper — 浏览器半边（客户端插件）。
 *
 * 形态：自包含单文件，**无** `import`/`export` 语句、无 JSX/TS、无构建链。顶层把
 * `{ id, factory }` 交给宿主 vendored cordis Loader（`id` **逐字＝包名**；Loader 以该
 * id 作为 settings 命名空间名）。`factory(require)` 返回宿主眼中的 `module.exports`
 * ——一个 cordis 插件面 `{ name, inject, apply }`。
 *
 * 依赖面（设计 §5.1/§5.2）：
 * - 硬服务（列入 `inject`）：`slots`、`locale`。二者缺失时 `apply` 根本不被调用，
 *   宿主以 `pending (waiting for service…)` 上报——那不是本半边能"安静降级"的形态。
 * - 可选能力：`configForms` **不得**列入硬 `inject`，一律经 `ctx.inject(['configForms'], cb)`
 *   回调式接入；缺失 ⇒ 该接入不注册、槽位注册照常、卡片渲染为不可用态。
 * - `require` 白名单仅 react 系（`react` / `react-dom` / `react/jsx-runtime`）；
 *   官方 practice 明令**不得 require 任何 Harness 客户端包**（`@deepseek-ai/dsh-client-*`），
 *   `configForms`/`slots`/`locale` 一律经 Cordis 服务取得。
 *
 * 注册与生命周期（设计 §5.2）：`slots.inject`/`slots.register` 在宿主 renderer 侧已是
 * fiber 作用域，**不再**包 `ctx.effect`；需显式 `ctx.effect` 的只有 `locale.register`
 * （返回 disposer）与卡片对表单控制器的 `subscribe`。异常隔离收窄到**单个注册点**
 * （各自 try/catch + 单行 warn），**不得**在 `apply` 外层整体 try/catch。
 *
 * 本 Task 只交付**状态壳**：卡片渲染标题 + 说明 + 三态文案之一
 * （`state.unconfigured` / `state.loading` / `state.unavailable`），不渲染任何配置控件；
 * 读面/写面由后续 Task 在 `Card` 内追加。
 */

window.__ModuleLoader__.load({
  id: 'dsh-ppt-master-wrapper',
  factory: (require) => {
    const React = require('react'); // 唯一 require；白名单内
    const { createElement, useState, useEffect } = React; // 只用这两个 hook

    // ─── 常量 ─────────────────────────────────────────────────────

    /** 插件名＝包名。槽位 `key` 与 settings 命名空间均取此值（宿主以包名判定归属）。 */
    const NS = 'dsh-ppt-master-wrapper';
    /** 本卡片专属的 locale 命名空间（字典注册键）。 */
    const LOCALE_NS = 'dsh-ppt-master-config';
    /** 插件页 bundle 级配置槽（键＝包名）。 */
    const SLOT_NAME = 'plugins.bundle.config';
    /** 槽位注册选项：`key` 必须＝包名，否则宿主插件页不渲染该 section。 */
    const REGISTER_OPTIONS = { name: SLOT_NAME, key: NS, locale: LOCALE_NS };
    /** 注入样式元素的 id（幂等判据）。 */
    const STYLE_ID = 'ppt-master-config-styles';

    // ─── 双语字典 ─────────────────────────────────────────────────
    //
    // 键集固定 26 项，`zh`/`en` 键集合必须相等（单测断言）。文案须说清三个字段的**后果**
    // （设计 §5.3）：关＝用系统 python3 且不删除任何目录；路径非法不由 schema 拦（保存照常
    // 成功、插件侧按"配置无效"降级）；重置会删宿主 config 键、三字段回落继承层。

    const DICT = {
      zh: {
        title: 'ppt-master 包装层配置',
        intro: '配置 venv 隔离与旧路径清理策略；改动经宿主配置通道保存，免重启生效。',
        'version.plugin': '插件版本',
        'version.upstream': '上游 ppt-master 版本',
        'version.skillDir': '技能目录',
        'version.skillDirValue': '<包根>/skills/ppt-master',
        'field.enabled.label': '启用 venv 隔离',
        'field.enabled.hint':
          '关闭（默认）时沿用系统 python3，且不删除任何目录——依赖已就绪的容器用户不需要开启；'
          + '开启后在下方路径创建/复用独立 venv，并以其中解释器运行上游脚本（容器用户宜显式配置到持久卷）。',
        'field.path.label': 'venv 路径',
        'field.path.hint':
          '绝对路径或以 ~ 前缀（~ 按宿主进程 HOME 展开）。路径非法不由 schema 拦：保存照常成功，'
          + '插件侧按"配置无效"降级（venv 视为关闭），请以 ppt_master_check_env 的 venv.path 复核。',
        'field.oldPathPolicy.label': '旧路径处理',
        'field.oldPathPolicy.hint':
          'keep（默认）＝保留旧 venv 待手动清理；delete＝下次环境准备成功后删除带所有权标记的旧目录。',
        'option.keep': '保留（手动清理）',
        'option.delete': '删除（带标记）',
        'action.save': '保存',
        'action.reset': '重置',
        'reset.hint':
          '重置会 unset 三个叶子，宿主保存时删除该插件的 config 键，三字段回落继承层（默认值）。',
        'state.loading': '正在读取宿主配置…',
        'state.unavailable': '配置通道不可用：宿主未向本插件暴露配置命名空间。',
        'state.unconfigured': '配置通道未接入：宿主未提供 configForms 服务，本卡片只读展示。',
        'state.readOnly': '当前配置为只读（宿主未授予写入权限）。',
        'state.memory': '当前会话为 memory 模式，本次会话不会写入宿主配置。',
        'notice.pending': '正在保存…',
        'notice.saved': '已保存。',
        'notice.rejected':
          '保存被拒绝：若保存未生效，可能存在更高优先级的配置层（如 profile patch 或 CLI overlay）覆盖了本次改动。',
        'notice.transportError': '保存传输失败：',
      },
      en: {
        title: 'ppt-master wrapper configuration',
        intro:
          'Configure venv isolation and old-path cleanup. Changes are saved through the host '
          + 'configuration channel and take effect without a restart.',
        'version.plugin': 'Plugin version',
        'version.upstream': 'Upstream ppt-master version',
        'version.skillDir': 'Skill directory',
        'version.skillDirValue': '<package root>/skills/ppt-master',
        'field.enabled.label': 'Enable venv isolation',
        'field.enabled.hint':
          'Off (default) keeps using the system python3 and removes no directory at all — container '
          + 'users whose dependencies are already installed do not need this. On creates/reuses a '
          + 'dedicated venv at the path below and runs the upstream scripts with its interpreter '
          + '(container users should point it at a persistent volume).',
        'field.path.label': 'venv path',
        'field.path.hint':
          'Absolute path or a ~ prefix (~ is expanded against the host process HOME). An invalid path '
          + 'is not blocked by the schema: saving still succeeds and the plugin degrades to "invalid '
          + 'configuration" (venv treated as off); verify with ppt_master_check_env venv.path.',
        'field.oldPathPolicy.label': 'Old path policy',
        'field.oldPathPolicy.hint':
          'keep (default) keeps the previous venv for manual cleanup; delete removes the '
          + 'ownership-marked old directory after the next successful environment setup.',
        'option.keep': 'Keep (manual cleanup)',
        'option.delete': 'Delete (marked)',
        'action.save': 'Save',
        'action.reset': 'Reset',
        'reset.hint':
          'Reset unsets the three leaves; the host then removes this plugin\'s config key and all '
          + 'three fields fall back to the inherited (default) layer.',
        'state.loading': 'Reading host configuration…',
        'state.unavailable': 'Configuration channel unavailable: the host exposes no namespace for this plugin.',
        'state.unconfigured':
          'Configuration channel not connected: the host provides no configForms service, so this card is read-only.',
        'state.readOnly': 'This configuration is read-only (the host granted no write access).',
        'state.memory': 'This session is in memory mode; nothing will be written to the host configuration.',
        'notice.pending': 'Saving…',
        'notice.saved': 'Saved.',
        'notice.rejected':
          'Save rejected: if the change did not take effect, a higher-priority configuration layer '
          + '(profile patch or CLI overlay) may be overriding it.',
        'notice.transportError': 'Save transport failed: ',
      },
    };

    // ─── 样式 ─────────────────────────────────────────────────────
    //
    // 自绘控件：类名一律 `ppt-master-config-` 前缀，颜色只用 `--dsw-alias-*` token
    // （禁硬编码颜色字面量）。分四段：#1 卡片容器 / #2 版本块 / #3 控件 / #4 提示与状态。

    const CSS = [
      // #1 卡片容器
      '.ppt-master-config-card {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 12px;',
      '  padding: 16px;',
      '  border: 1px solid var(--dsw-alias-border-secondary);',
      '  border-radius: var(--dsw-alias-radius-medium, 8px);',
      '  background: var(--dsw-alias-bg-primary);',
      '  color: var(--dsw-alias-text-primary);',
      '  font-size: 13px;',
      '  line-height: 1.5;',
      '}',
      '.ppt-master-config-title { margin: 0; font-size: 14px; font-weight: 600; }',
      '.ppt-master-config-intro { margin: 0; color: var(--dsw-alias-text-secondary); }',
      // #2 版本块
      '.ppt-master-config-versions {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 4px;',
      '  padding: 8px 10px;',
      '  border-radius: var(--dsw-alias-radius-small, 6px);',
      '  background: var(--dsw-alias-bg-secondary);',
      '  color: var(--dsw-alias-text-secondary);',
      '}',
      '.ppt-master-config-versions-line { display: flex; gap: 8px; }',
      '.ppt-master-config-versions-label { min-width: 8em; color: var(--dsw-alias-text-tertiary); }',
      // #3 控件
      '.ppt-master-config-field { display: flex; flex-direction: column; gap: 4px; }',
      '.ppt-master-config-label { font-weight: 500; }',
      '.ppt-master-config-input, .ppt-master-config-select {',
      '  box-sizing: border-box;',
      '  padding: 6px 8px;',
      '  border: 1px solid var(--dsw-alias-border-secondary);',
      '  border-radius: var(--dsw-alias-radius-small, 6px);',
      '  background: var(--dsw-alias-bg-primary);',
      '  color: var(--dsw-alias-text-primary);',
      '  font: inherit;',
      '}',
      '.ppt-master-config-input:focus-visible, .ppt-master-config-select:focus-visible,',
      '.ppt-master-config-switch:focus-visible, .ppt-master-config-button:focus-visible {',
      '  outline: 2px solid var(--dsw-alias-border-focus);',
      '  outline-offset: 1px;',
      '}',
      '.ppt-master-config-switch {',
      '  align-self: flex-start;',
      '  padding: 4px 10px;',
      '  border: 1px solid var(--dsw-alias-border-secondary);',
      '  border-radius: 999px;',
      '  background: var(--dsw-alias-bg-secondary);',
      '  color: var(--dsw-alias-text-primary);',
      '  font: inherit;',
      '  cursor: pointer;',
      '}',
      '.ppt-master-config-switch[aria-checked="true"] {',
      '  border-color: var(--dsw-alias-border-focus);',
      '  background: var(--dsw-alias-bg-active);',
      '}',
      '.ppt-master-config-switch:disabled, .ppt-master-config-button:disabled,',
      '.ppt-master-config-input:disabled, .ppt-master-config-select:disabled {',
      '  opacity: 0.5;',
      '  cursor: not-allowed;',
      '}',
      '.ppt-master-config-actions { display: flex; gap: 8px; }',
      '.ppt-master-config-button {',
      '  padding: 5px 12px;',
      '  border: 1px solid var(--dsw-alias-border-secondary);',
      '  border-radius: var(--dsw-alias-radius-small, 6px);',
      '  background: var(--dsw-alias-bg-secondary);',
      '  color: var(--dsw-alias-text-primary);',
      '  font: inherit;',
      '  cursor: pointer;',
      '}',
      // #4 提示与状态
      '.ppt-master-config-hint { margin: 0; color: var(--dsw-alias-text-tertiary); font-size: 12px; }',
      '.ppt-master-config-status { margin: 0; color: var(--dsw-alias-text-secondary); font-size: 12px; }',
      '.ppt-master-config-notice { margin: 0; color: var(--dsw-alias-text-secondary); font-size: 12px; }',
    ].join('\n');

    /**
     * 幂等注入样式：无 document（SSR/装载早期）静默返回；已存在 `STYLE_ID` 元素则跳过；
     * 任何异常 → 单行 `console.warn`，**不抛**（样式失败不得拖垮插件注册面）。
     */
    function ensureStyles() {
      try {
        if (typeof document === 'undefined' || !document?.head) return;
        if (document.getElementById?.(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
      } catch (error) {
        console.warn(`${NS}: 样式注入失败：${error?.message ?? error}`);
      }
    }

    // ─── 命名空间解析与表单 holder ─────────────────────────────────

    /** 普通对象（非 null/非数组）判定。 */
    function isPlainObject(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    /**
     * 解析 settings 命名空间：以 `configForms.describe()` 的 served-namespace 目录兜底。
     *
     * ① 目录可读且含 `NS` → `NS`（常规路径）；
     * ② 否则目录内 `value` 为普通对象且含**顶层 `venv` 键**的 ns **恰一个** → 该 ns；
     * ③ 其余（含任何读取异常）→ `NS`（不做候选消歧、不误 address 他人命名空间）。
     */
    function resolveNamespace(forms) {
      try {
        const namespaces = forms?.describe?.()?.view?.namespaces;
        if (!Array.isArray(namespaces)) return NS;
        if (namespaces.some((entry) => entry?.ns === NS)) return NS;
        const candidates = namespaces.filter(
          (entry) => isPlainObject(entry?.value) && 'venv' in entry.value,
        );
        return candidates.length === 1 && typeof candidates[0].ns === 'string' ? candidates[0].ns : NS;
      } catch {
        return NS;
      }
    }

    /**
     * 表单 holder：卡片经它读当前表单控制器；`set`/`notify` 均向订阅者广播
     * （订阅者＝卡片，借 `useState` 触发重渲染）。
     */
    function createFormHolder() {
      let form;
      const listeners = new Set();
      const broadcast = () => {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch (error) {
            console.warn(`${NS}: holder 订阅者抛错：${error?.message ?? error}`);
          }
        }
      };
      return {
        get: () => form,
        set: (next) => {
          form = next;
          broadcast();
        },
        notify: () => broadcast(),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    /**
     * 读宿主快照并**归一化**为五字段 `Snapshot`；`undefined` ＝未接入（无表单/读不出）。
     *
     * - `form` 缺失、`getSnapshot` 非函数、或抛错 → `undefined`
     * - `status` 非三枚举值 → `'loading'`
     * - `value` 非普通对象 → `undefined`
     * - `writable` 仅字面 `true` 为真
     * - `mode` 仅字面 `'memory'` 为 memory，其余 `'host'`
     */
    function readSnapshot(form) {
      if (typeof form?.getSnapshot !== 'function') return undefined;
      let raw;
      try {
        raw = form.getSnapshot();
      } catch {
        return undefined;
      }
      if (!isPlainObject(raw)) return undefined;
      const status = ['loading', 'ready', 'unavailable'].includes(raw.status) ? raw.status : 'loading';
      return {
        status,
        value: isPlainObject(raw.value) ? raw.value : undefined,
        revision: raw.revision,
        writable: raw.writable === true,
        mode: raw.mode === 'memory' ? 'memory' : 'host',
      };
    }

    // ─── 卡片（本 Task 仅状态壳）───────────────────────────────────

    /**
     * 比较两份归一化快照是否等价（按五字段**值**比较）。
     *
     * 必要性：`readSnapshot` 每次返回**新对象**，若订阅回调用 `Object.is` 由 React 判等，
     * 每次广播都会视为"变了"→ 重渲染 → 若广播又发生则自激。故这里显式按值比较，
     * 只有实质变化才写 state（返回同一引用 = React 跳过重渲染）。
     */
    function sameSnapshot(a, b) {
      if (a === b) return true;
      if (a === undefined || b === undefined) return false;
      return (
        a.status === b.status &&
        a.value === b.value &&
        a.revision === b.revision &&
        a.writable === b.writable &&
        a.mode === b.mode
      );
    }

    /**
     * 配置卡片：状态壳——标题 + 说明 + 三态文案之一。
     *
     * 快照 `undefined`（未接入，含 `configForms` 缺失）→ `state.unconfigured`；
     * `loading` → `state.loading`；`unavailable` → `state.unavailable`。
     * 全部为**原生元素**（`type` 均为字符串；不定义子组件、不用 Fragment、不声明 `children`）。
     *
     * hook 计数＝2 个 `useState`（T2 起增加 staged/notice 槽）＋ 2 个 `useEffect`。
     */
    const Card = () => {
      const [snapshot, setSnapshot] = useState(undefined);
      const { formHolder } = Card;
      const t = Card.t;

      // 幂等写 state：值未变则回传**同一引用**，React 因此跳过重渲染（防自激循环）。
      const publish = () => {
        setSnapshot((previous) => {
          const next = readSnapshot(formHolder.get());
          return sameSnapshot(previous, next) ? previous : next;
        });
      };

      useEffect(() => formHolder.subscribe(publish), []);

      useEffect(() => {
        publish();
      }, []);

      const body =
        snapshot === undefined
          ? t('state.unconfigured')
          : snapshot.status === 'ready'
            ? t('state.unavailable')
            : t(snapshot.status === 'loading' ? 'state.loading' : 'state.unavailable');

      return createElement(
        'div',
        { className: 'ppt-master-config-card' },
        createElement('p', { className: 'ppt-master-config-title' }, t('title')),
        createElement('p', { className: 'ppt-master-config-intro' }, t('intro')),
        createElement('p', { className: 'ppt-master-config-status', role: 'status' }, body),
      );
    };

    // ─── apply（三个互相隔离的注册点）───────────────────────────────

    /**
     * 装配插件：三个注册点**各自** try/catch + 单行 warn（`isolate` 即三处独立
     * try/catch 的具名化——**不得**把 `apply` 整体包进 try/catch）。
     *
     * ① locale 字典（`ctx.effect` 包裹，回收 disposer）
     * ② `configForms` 可选能力（回调式；内部 `ctx.effect` 建表单订阅并发布到 holder）
     * ③ 槽位注册（宿主 renderer 侧已是 fiber 作用域，**不**再包 `ctx.effect`）
     */
    function apply(ctx) {
      const formHolder = createFormHolder();
      const isolate = (label, fn) => {
        try {
          fn();
        } catch (error) {
          console.warn(`${NS}: ${label} 注册失败：${error?.message ?? error}`);
        }
      };

      // 卡片的作用域来源＝apply 闭包捕获的 ctx（configForms 为模块级单例服务）：
      // 槽位渲染器实例化卡片时拿不到 ctx，故经 Card 的静态字段发布 holder 与 t。
      // `t` 的绑定落在 `locale` isolate **内**：`bind` 与 `register` 同属该硬服务，
      // 任一抛错都只应记一条 warn、不冒泡出 apply（隔离收窄到注册点，而非整体 try/catch）。
      Card.formHolder = formHolder;

      isolate('locale', () => {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, DICT), `${LOCALE_NS}: dictionaries`);
        const t = ctx.locale.bind(LOCALE_NS);
        // `t` 也在卡片渲染期被调用（宿主语言切换后仍返回最新文案），故再包一层：
        // 字典服务在渲染期抛错不得拖垮卡片（回落 key，与缺键同形）。
        Card.t = (key, params) => {
          try {
            return t(key, params);
          } catch {
            return key;
          }
        };
      });

      ctx.inject(['configForms'], (c) =>
        isolate('configForms', () => {
          const forms = c?.configForms;
          if (typeof forms?.get !== 'function') return; // 缺可选能力 → 该接入不注册
          c.effect(() => {
            const form = forms.get(resolveNamespace(forms));
            const off =
              typeof form?.subscribe === 'function' ? form.subscribe(() => formHolder.notify()) : undefined;
            formHolder.set(form);
            return () => {
              off?.();
              formHolder.set(undefined);
            };
          }, `${LOCALE_NS}: config form`);
        }),
      );

      isolate('slot', () => ctx.slots.inject(SLOT_NAME, () => ctx.slots.register(REGISTER_OPTIONS, Card)));

      ensureStyles();
    }

    return { name: NS, inject: ['slots', 'locale'], apply };
  },
});
