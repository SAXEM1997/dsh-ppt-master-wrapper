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
 * 本 Task 交付**状态壳 + 读面**：卡片渲染标题 + 说明 + 版本块 + 三字段自绘控件 +
 * 后果文案 + 提示与状态行；`ready` 分支由 `readVenv` 类型化读取快照 `value.venv`，
 * 缺基值/类型不符的叶子控件禁用（不注入默认值）。**写面**（暂存态落盘、`mutate`）由
 * 后续 Task 在 `Card` 内追加；本 Task 的三个 `on*` 只改本地暂存态，不发宿主写。
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
    /** 三个自绘控件的元素 id（`<label htmlFor>` 的关联锚；测试与宿主同用）。 */
    const FIELD_IDS = {
      enabled: 'ppt-master-config-enabled',
      path: 'ppt-master-config-path',
      oldPathPolicy: 'ppt-master-config-policy',
    };
    /**
     * 版本三元组＝**手写常量**（设计 §5.4：宿主 `volatileForm` 重建 schema 时丢弃根
     * description，注解不可达，版本只能随包发布）。`PLUGIN_VERSION` 与 `package.json.version`、
     * `UPSTREAM_VERSION` 与 `SKILL.md` 的 `metadata.version` 各由一条配对断言守护
     * （归一化规则＝上游版本 + 可选 `-rN`，**不做三值相等**）。
     * `SKILL_DIR_TAIL` 逐字含尖括号：`<包根>` 是**展示用符号占位**、不是模板变量——
     * 绝对 SKILL_DIR 在别的机器上必然错，故只显示固定相对尾部。它是 **zh 字典值
     * `version.skillDirValue` 的单一来源**（`DICT.zh` 直接引用本常量），渲染侧一律经
     * `t('version.skillDirValue')` 取用——直接渲染常量会让英文界面显示中文占位串、
     * 并使该字典键成为死键（T2 审查 Important-1）。
     */
    const PLUGIN_VERSION = '6.7.1';
    const UPSTREAM_VERSION = '6.7.1';
    const SKILL_DIR_TAIL = '<包根>/skills/ppt-master';


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
        'version.skillDirValue': SKILL_DIR_TAIL,
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
    // （禁硬编码颜色字面量）。分四段：#1 容器与标题 / #2 版本块 / #3 控件 / #4 动作与状态。
    //
    // ⚠️ 令牌名必须逐字取自宿主设计系统（本机 rc.2 实证词汇）：
    //   颜色 `--dsw-alias-label-primary|secondary|tertiary`、`--dsw-alias-label-primary-foreground`、
    //        `--dsw-alias-state-{business,success,error}-primary`、`--dsw-alias-brand-primary`、
    //        `--dsw-alias-button-primary-fill|hover`、`--dsw-alias-bg-layer-1|2|3`、
    //        `--dsw-alias-border-l2|l3|l4`、`--dsw-alias-interactive-bg-hover`；
    //   尺度 `--dsw-radius-sm|md|lg`、`--dsw-shadow-lv1`、`--ds-font-family-code`。
    //   写错名字而**无兜底**时，整条声明在计算值阶段失效（边框/背景/颜色静默消失，
    //   卡片退化成裸文本——2026-10-16 实测过），故每个 `var()` 都带主题安全的兜底：
    //   `color-mix(in srgb, currentColor N%, transparent)`（深浅色主题都成立，且不含
    //   被静态契约禁掉的颜色字面量）。

    const CSS = [
      // #1 容器与标题
      '.ppt-master-config-card {',
      '  display: flex;',
      '  flex-direction: column;',
      '  padding: 16px;',
      '  border: .5px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 14%, transparent));',
      '  border-radius: var(--dsw-radius-lg, 12px);',
      '  background: var(--dsw-alias-bg-layer-2, transparent);',
      '  color: var(--dsw-alias-label-primary, inherit);',
      '  font-size: 13px;',
      '  line-height: 1.5;',
      '}',
      '.ppt-master-config-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.4; }',
      '.ppt-master-config-intro {',
      '  margin: 4px 0 0;',
      '  color: var(--dsw-alias-label-secondary, color-mix(in srgb, currentColor 70%, transparent));',
      '}',
      // #2 版本块：容器即网格 + 行 `display: contents` ⇒ 三行标签列对齐（英文长标签亦不破）
      '.ppt-master-config-versions {',
      '  display: grid;',
      '  grid-template-columns: max-content 1fr;',
      '  column-gap: 16px;',
      '  row-gap: 4px;',
      '  margin-top: 14px;',
      '  padding: 10px 12px;',
      '  border-radius: var(--dsw-radius-md, 8px);',
      '  background: var(--dsw-alias-bg-layer-3, color-mix(in srgb, currentColor 6%, transparent));',
      '}',
      '.ppt-master-config-versions-line { display: contents; }',
      '.ppt-master-config-versions-label {',
      '  color: var(--dsw-alias-label-tertiary, color-mix(in srgb, currentColor 55%, transparent));',
      '}',
      '.ppt-master-config-versions-value {',
      '  color: var(--dsw-alias-label-secondary, color-mix(in srgb, currentColor 70%, transparent));',
      '  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);',
      '  word-break: break-all;',
      '}',
      // #3 控件（字段＝宿主同款：`gap:6px` + 上发丝分隔线）
      '.ppt-master-config-field {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 6px;',
      '  margin-top: 12px;',
      '  padding-top: 12px;',
      '  border-top: .5px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 14%, transparent));',
      '}',
      '.ppt-master-config-field[data-layout="inline"] > .ppt-master-config-field-head {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 12px;',
      '}',
      '.ppt-master-config-label { font-weight: 500; }',
      '.ppt-master-config-input, .ppt-master-config-select {',
      '  box-sizing: border-box;',
      '  width: 100%;',
      '  max-width: 480px;',
      '  height: 34px;',
      '  padding: 0 12px;',
      '  border: .5px solid var(--dsw-alias-border-l4, color-mix(in srgb, currentColor 22%, transparent));',
      '  border-radius: var(--dsw-radius-md, 8px);',
      '  background: var(--dsw-alias-bg-layer-3, color-mix(in srgb, currentColor 6%, transparent));',
      '  color: var(--dsw-alias-label-primary, inherit);',
      '  font: inherit;',
      '  font-size: 13px;',
      '}',
      '.ppt-master-config-select { max-width: 320px; }',
      '.ppt-master-config-input:focus-visible, .ppt-master-config-select:focus-visible,',
      '.ppt-master-config-switch:focus-visible, .ppt-master-config-button:focus-visible {',
      '  outline: 2px solid var(--dsw-alias-state-business-primary, color-mix(in srgb, currentColor 60%, transparent));',
      '  outline-offset: 1px;',
      '}',
      '.ppt-master-config-switch:disabled, .ppt-master-config-button:disabled,',
      '.ppt-master-config-input:disabled, .ppt-master-config-select:disabled {',
      '  opacity: .4;',
      '  cursor: not-allowed;',
      '}',
      // 开关＝纯 knob 药丸（文案由字段 `<label>` 承担，避免同句重复）
      '.ppt-master-config-switch {',
      '  position: relative;',
      '  flex: none;',
      '  box-sizing: border-box;',
      '  width: 40px;',
      '  height: 22px;',
      '  padding: 0;',
      '  border: none;',
      '  border-radius: 999px;',
      '  background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 14%, transparent));',
      '  cursor: pointer;',
      '  transition: background .15s ease;',
      '}',
      '.ppt-master-config-switch-knob {',
      '  position: absolute;',
      '  top: 2px;',
      '  left: 2px;',
      '  width: 18px;',
      '  height: 18px;',
      '  border-radius: 50%;',
      '  background: var(--dsw-alias-label-primary-foreground, Canvas);',
      '  box-shadow: var(--dsw-shadow-lv1, 0 1px 2px color-mix(in srgb, currentColor 25%, transparent));',
      '  transition: transform .15s ease;',
      '}',
      '.ppt-master-config-switch[aria-checked="true"] {',
      '  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, currentColor));',
      '}',
      '.ppt-master-config-switch[aria-checked="true"] > .ppt-master-config-switch-knob {',
      '  transform: translateX(18px);',
      '}',
      // #4 动作与状态
      '.ppt-master-config-actions {',
      '  display: flex;',
      '  justify-content: flex-end;',
      '  gap: 8px;',
      '  margin-top: 16px;',
      '}',
      '.ppt-master-config-button {',
      '  box-sizing: border-box;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  height: 32px;',
      '  padding: 0 14px;',
      '  border: none;',
      '  border-radius: var(--dsw-radius-md, 8px);',
      '  background: transparent;',
      '  color: var(--dsw-alias-label-primary, inherit);',
      '  font: inherit;',
      '  font-size: 13px;',
      '  cursor: pointer;',
      '}',
      '.ppt-master-config-button[data-variant="primary"] {',
      '  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, currentColor));',
      '  color: var(--dsw-alias-label-primary-foreground, Canvas);',
      '}',
      '.ppt-master-config-button[data-variant="primary"]:hover:not(:disabled) {',
      '  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, currentColor));',
      '}',
      '.ppt-master-config-button[data-variant="ghost"] {',
      '  border: .5px solid var(--dsw-alias-border-l4, color-mix(in srgb, currentColor 22%, transparent));',
      '}',
      '.ppt-master-config-button[data-variant="ghost"]:hover:not(:disabled) {',
      '  background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent));',
      '}',
      '.ppt-master-config-hint {',
      '  margin: 0;',
      '  max-width: 68ch;',
      '  font-size: 12px;',
      '  line-height: 1.5;',
      '  color: var(--dsw-alias-label-tertiary, color-mix(in srgb, currentColor 55%, transparent));',
      '}',
      '.ppt-master-config-card > .ppt-master-config-hint { margin-top: 14px; }',
      '.ppt-master-config-status {',
      '  margin: 8px 0 0;',
      '  font-size: 12px;',
      '  color: var(--dsw-alias-label-secondary, color-mix(in srgb, currentColor 70%, transparent));',
      '}',
      '.ppt-master-config-notice { margin: 8px 0 0; font-size: 12px; }',
      '.ppt-master-config-notice[data-tone="pending"],',
      '.ppt-master-config-notice[data-tone="success"] {',
      '  color: var(--dsw-alias-label-secondary, color-mix(in srgb, currentColor 70%, transparent));',
      '}',
      '.ppt-master-config-notice[data-tone="success"] {',
      '  color: var(--dsw-alias-state-success-primary, color-mix(in srgb, currentColor 70%, transparent));',
      '}',
      '.ppt-master-config-notice[data-tone="error"] {',
      '  color: var(--dsw-alias-state-error-primary, color-mix(in srgb, currentColor 70%, transparent));',
      '}',
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
        // 真实宿主 `describe()` 返回 **mirror face**（无顶层 `view`）：ns 列表在
        // `describe().getSnapshot().view.namespaces`；旧形状（顶层 `view`）保留兼容
        // （standalone S3；mirror 优先）。
        const described = forms?.describe?.();
        const namespaces =
          described?.getSnapshot?.()?.view?.namespaces ?? described?.view?.namespaces;
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
        revision: typeof raw.revision === 'number' ? raw.revision : undefined,
        writable: raw.writable === true,
        mode: raw.mode === 'memory' ? 'memory' : 'host',
      };
    }

    /**
     * 从快照 `value` 类型化读取 `venv` 三叶子（**只做类型化读取、不注入默认值**）：
     * `value?.venv?.[leaf]` 类型不符即 `undefined`——`undefined` 语义＝"宿主未给基值"，
     * 消费方据此**禁用**该字段（不猜默认、不入 ops）。
     *
     * 非 `boolean` / 非 `string` / 非 `'keep'|'delete'` 一律落 `undefined`：敌人快照
     * （`enabled:'yes'`、`path:42`、`oldPathPolicy:'nope'`）因此与"缺字段"同形。
     */
    function readVenv(snapshot) {
      const venv = snapshot?.value?.venv;
      const leaf = (key) => (isPlainObject(venv) ? venv[key] : undefined);
      const enabled = leaf('enabled');
      const path = leaf('path');
      const oldPathPolicy = leaf('oldPathPolicy');
      return {
        enabled: typeof enabled === 'boolean' ? enabled : undefined,
        path: typeof path === 'string' ? path : undefined,
        oldPathPolicy:
          oldPathPolicy === 'keep' || oldPathPolicy === 'delete' ? oldPathPolicy : undefined,
      };
    }

    // ─── 写面：ops 组装（设计 §5.5）────────────────────────────────

    /**
     * 三个叶子的**固定顺序**（`buildSetOps` 与 `RESET_OPS` 共用）：脏集/重置 ops 的
     * 排列恒为 `enabled → path → oldPathPolicy`，与用户操作次序无关——顺序若随渲染
     * 或对象键序漂移，宿主侧 diff 与测试深比较都会变成不稳定锚。
     */
    const LEAF_ORDER = ['enabled', 'path', 'oldPathPolicy'];
    /** 配置所在的顶层键（嵌套 `path` 的第一段；schema 维持嵌套，见设计 §5.5）。 */
    const VENV_KEY = 'venv';

    /**
     * 重置 ops：**一次** `mutate` 携带三个 `unset`（不是三次调用、不是 `set` 默认值）。
     * 宿主语义＝删除该插件 config 键、三叶子回落继承层；故这里只 unset、不写任何值。
     * 模块级冻结：数组与每个 op 都冻结，防渲染期被就地改写。
     */
    const RESET_OPS = Object.freeze(
      LEAF_ORDER.map((leaf) => Object.freeze({ op: 'unset', path: Object.freeze([VENV_KEY, leaf]) })),
    );

    /**
     * 由**当前基值**与暂存值算出 `set` ops（脏字段计算）。
     *
     * 两条守卫（顺序即输出顺序）：
     * ① `baseline[leaf] !== undefined`——基值缺失/类型不符的叶子**不入 ops**（控件本已
     *    禁用，此守卫让"禁用 ⇒ 不可暂存 ⇒ 不产出 op"成为**结构性**保证，而非只靠禁用）；
     * ② `staged[leaf] !== baseline[leaf]`——只发真正改动的叶子（沿用 `!==` 而非深比较：
     *    三叶子均为 boolean/string 原始值）。
     *
     * `baseline` **取自当前快照**（非暂存态里冻结的基值）：快照换代后脏判定立刻按新基值
     * 现算——宿主回推暂存值 ⇒ ops 自然变空 ⇒ 无需任何乐观清理。
     */
    function buildSetOps(baseline, staged) {
      const ops = [];
      for (const leaf of LEAF_ORDER) {
        const base = baseline?.[leaf];
        if (base === undefined) continue;
        const next = staged?.[leaf];
        if (next === undefined || next === base) continue;
        ops.push({ op: 'set', path: [VENV_KEY, leaf], value: next });
      }
      return ops;
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
      // `value` 按**三叶值**比较（standalone S5）：原始值 schema 下与引用判等等价，
      // 而宿主原地改写 `value`（同引用换内容）时引用判等会漏判。
      const av = readVenv(a);
      const bv = readVenv(b);
      return (
        a.status === b.status &&
        a.revision === b.revision &&
        a.writable === b.writable &&
        a.mode === b.mode &&
        av.enabled === bv.enabled &&
        av.path === bv.path &&
        av.oldPathPolicy === bv.oldPathPolicy
      );
    }

    /**
     * 版本块的只读行：标签 + 值。行内**只**出现上层给定的一个字面量值——版本块的
     * 「不得出现其它版本类串」约束（T2①③ 的 `every()`）靠此结构性保证：值只来自
     * `PLUGIN_VERSION` / `UPSTREAM_VERSION` / 字典的 `version.skillDirValue`。
     */
    function versionsLine(label, value) {
      return createElement(
        'div',
        { className: 'ppt-master-config-versions-line' },
        createElement('span', { className: 'ppt-master-config-versions-label' }, label),
        createElement('span', { className: 'ppt-master-config-versions-value' }, value),
      );
    }

    /**
     * 字段行（本地辅助，**只返回已 `createElement` 的元素**、不新增 hook、不定义子组件）：
     * 默认列式＝`<label htmlFor>` + 控件 + `<p className="ppt-master-config-hint">`；
     * `inline`＝标签与控件并排（标签左、控件右），供开关这类"单行布尔"用——标签文案
     * 由 `<label>` 承担，控件本身不再重复同一句。类名恒为 `ppt-master-config-field`
     * （测试按全等定位），形态差异只走 `data-layout`；`inline` 时标签带 id 供
     * `aria-labelledby` 关联（控件无可读文案）。
     */
    function renderField(t, id, labelKey, hintKey, control, inline) {
      const label = createElement(
        'label',
        {
          className: 'ppt-master-config-label',
          htmlFor: id,
          id: inline ? `${id}-label` : undefined,
        },
        t(labelKey),
      );
      return createElement(
        'div',
        {
          className: 'ppt-master-config-field',
          'data-layout': inline ? 'inline' : 'stacked',
        },
        inline
          ? createElement('div', { className: 'ppt-master-config-field-head' }, label, control)
          : label,
        inline ? null : control,
        createElement('p', { className: 'ppt-master-config-hint' }, t(hintKey)),
      );
    }

    /**
     * 配置卡片：状态壳 + 读面。
     *
     * 快照 `undefined`（未接入，含 `configForms` 缺失）→ `state.unconfigured`；
     * `loading`（含 `status` 非枚举值）→ `state.loading`；`unavailable` → `state.unavailable`；
     * `ready` → 版本块 + 三字段控件 + 提示 + 状态行。
     * 全部为**原生元素**（`type` 均为字符串；不定义子组件、不用 Fragment、不声明 `children`）。
     *
     * 快照字段每帧现读：宿主 volatile 保存**不 remount**（引用原地换代），`t` 亦须现取以
     * 跟随语言切换——故 `formHolder` / `t` 在**函数体内**解构（不在模块级捕获）。
     *
     * 本 Task 的三个 `on*` 只改**本地暂存态**、不发任何宿主写；写面由 T3 追加。
     * hook 计数＝2 个 `useState`（snapshot、staged）＋ 2 个 `useEffect`（holder 订阅、暂存态初始化）。
     */
    const Card = () => {
      const [snapshot, setSnapshot] = useState(undefined);
      // 暂存态：`baseRevision === undefined` ＝ 尚未由首个 `ready` 快照初始化（见下方 effect）。
      // `initialized` 是**初始化闩锁**：快照 `revision` 本身可以为 `undefined`（Review Focus #1 的
      // 缺失形态），故闩锁不能复用 `baseRevision`——否则初始化永不收敛（settle 自激 20 轮）。
      const [staged, setStaged] = useState({
        leaves: {},
        baseRevision: undefined,
        initialized: false,
      });

      // 订阅面与渲染期资源一律**每次执行现取**：`apply` 每次执行都会刷新 Card 的静态引用，
      // 若在函数体内缓存到不随代际变化的闭包/依赖里，`disposeAll()` 后重挂载的卡片会读旧
      // holder（旧 holder 已被清空）而死在"未接入"——重挂载子断言（用例 25）钉住此点。
      // 生产形态：`t` 的 getter 由 `defineProperty` 安装；转发器＋默认值规则见 apply。
      const { formHolder, t } = Card.forwarder;

      // 幂等写 state：值未变则回传**同一引用**，React 因此跳过重渲染（防自激循环）。
      const publish = () => {
        setSnapshot((previous) => {
          const next = readSnapshot(formHolder().get());
          return sameSnapshot(previous, next) ? previous : next;
        });
      };

      useEffect(() => formHolder().subscribe(publish), [formHolder]);

      useEffect(() => {
        publish();
        setStaged((previous) => {
          if (previous.initialized) return previous; // 幂等：已初始化则回传同一引用（防自激）
          const current = readSnapshot(formHolder().get());
          if (current?.status !== 'ready') return previous; // 首个 ready 快照才落基
          // **不**把三叶种入 `staged.leaves`（standalone S1）：全量种入会让宿主第三方更新
          // 后的显示被陈旧暂存值影子化，且脏判定会把三个旧值以新 revision 写回（静默回退）。
          // `leaves` 恒只承载**用户改过的叶子**；未触碰的叶子一律现读当前基值。
          return { leaves: {}, baseRevision: current.revision, initialized: true };
        });
      }, [formHolder]);

      // 第 3 个（也是最后一个）`useState`：写面提示。取值为**字典键**（而非已翻译文案），
      // 使语言切换后 `t(notice.key)` 现取即可跟随；`notice.message` 仅在传输失败时出现。
      // **位置在两条 `useEffect` 之后**：hook 槽位＝调用序，既有用例 25 以
      // `SUBSCRIBE_SLOT = 2` / `INIT_SLOT = 3` 观测两 effect 的依赖，把本 state 插在
      // 它们之前会让两 effect 移到 3/4、使那条既有断言读到空槽（本 Task 不得改既有用例）。
      // 条件分支里不调用任何 hook，故顺序跨渲染恒定。
      const [notice, setNotice] = useState(undefined);

      // 状态行文案：`ready` 是**通道可用**态——不得与 readOnly/memory 行同屏渲染
      // "配置通道不可用"（自相矛盾，standalone S2），故 `ready` 显式取 `undefined` 表示
      // 不渲染状态行。非枚举 `status` 已被 `readSnapshot` 归一化为 `loading`。
      const body =
        snapshot === undefined
          ? t('state.unconfigured')
          : snapshot.status === 'ready'
            ? undefined
            : snapshot.status === 'loading'
              ? t('state.loading')
              : t('state.unavailable');

      // 基值＝当前快照（**不注入默认值**）；暂存值仅在用户改动过该叶子时覆盖基值。
      const baseline = snapshot?.status === 'ready' ? readVenv(snapshot) : undefined;
      const stagedLeaves = staged.leaves ?? {};
      const valueOf = (leaf) =>
        leaf in stagedLeaves ? stagedLeaves[leaf] : baseline?.[leaf];
      const setLeaf = (leaf, value) =>
        setStaged((previous) => ({ ...previous, leaves: { ...previous.leaves, [leaf]: value } }));

      /**
       * 写门：`ready` 且宿主明确授予写权限。memory 模式下宿主给的是
       * `{status:'unavailable', writable:false}`，故此处自然关闭（设计 §5.5 裁决 3）。
       */
      const canWrite = snapshot?.status === 'ready' && snapshot.writable === true;
      const setOps = baseline === undefined ? [] : buildSetOps(baseline, stagedLeaves);

      /**
       * 提交 ops：`form.mutate(ops, revision)` 以**方法形态**调用（宿主控制器是对象方法，
       * 解构裸调会丢 `this`）。`revision` 与 `form` 一律**调用期现取**——缓存旧 revision 会
       * 让保存打到过期快照（Review Focus #3）。
       *
       * 两类可观测量（设计 §6，**不得**混用、**不得**声称能分辨"被更高优先级层覆盖"）：
       * 恰为字面 `true` ⇒ `saved`；其余 resolve 值（含 `false`）⇒ `rejected`；
       * 抛错/`reject` ⇒ `transportError` + 错误消息（`String(error?.message ?? error)`，
       * 兼容非 Error 抛出物）。
       *
       * **无乐观更新**：本函数不改写任何本地基值、不自行 bump `revision`、不清暂存值——
       * 生效与否一律等宿主回推快照（回推后 `setOps` 自然变空）。
       *
       * 返回 Promise（可测性契约）：React 事件处理器返回值无副作用，故 `onClick` 直接
       * 传本函数绑定即可既满足契约、又让 `<button>` 的行为在真实 React 下不变。
       *
       * **写门在 `commit` 内复检**（不只靠 `disabled`）：真实 DOM 不会派发禁用按钮的
       * click，但测试与程序化调用可直达 `onClick`，故这里以**当前**快照再判一次
       * `ready && writable`——写门关闭、`ops` 为空、或 `mutate` 不可调用时一律
       * 返回 `false` 且**不发** `mutate`（T3 用例 ⑨②③ 的"点击不发 mutate"由此成立）。
       */
      const commit = (ops) => {
        const form = formHolder().get();
        if (!canWrite || ops.length === 0 || typeof form?.mutate !== 'function') {
          return Promise.resolve(false);
        }
        const current = readSnapshot(form);
        setNotice({ key: 'notice.pending' });
        return Promise.resolve()
          .then(() => form.mutate(ops, current?.revision))
          .then((outcome) => {
            setNotice({ key: outcome === true ? 'notice.saved' : 'notice.rejected' });
            return outcome;
          })
          .catch((error) => {
            setNotice({ key: 'notice.transportError', message: String(error?.message ?? error) });
            return false;
          });
      };

      const fields =
        baseline === undefined
          ? []
          : [
              renderField(
                t,
                FIELD_IDS.enabled,
                'field.enabled.label',
                'field.enabled.hint',
                createElement(
                  'button',
                  {
                    type: 'button',
                    role: 'switch',
                    'aria-checked': valueOf('enabled') === true,
                    // 控件本身无可读文案（视觉上只是 knob 药丸）：可访问名取自字段标签，
                    // 免得同一句话在标签与控件上各出现一次。
                    'aria-labelledby': `${FIELD_IDS.enabled}-label`,
                    className: 'ppt-master-config-switch',
                    id: FIELD_IDS.enabled,
                    disabled: baseline.enabled === undefined,
                    // 基值为 `false`（未开启）时点击 = 开启；其余（含基值 true）取反。
                    onClick: () => setLeaf('enabled', valueOf('enabled') !== true),
                  },
                  createElement('span', {
                    className: 'ppt-master-config-switch-knob',
                    'aria-hidden': 'true',
                  }),
                ),
                true,
              ),
              renderField(
                t,
                FIELD_IDS.path,
                'field.path.label',
                'field.path.hint',
                createElement('input', {
                  type: 'text',
                  className: 'ppt-master-config-input',
                  id: FIELD_IDS.path,
                  value: valueOf('path') ?? '',
                  disabled: baseline.path === undefined,
                  onChange: (event) => setLeaf('path', event?.target?.value),
                  // Escape＝**该字段**暂存值回落宿主基值（其余字段不动）。
                  onKeyDown: (event) => {
                    if (event?.key !== 'Escape') return;
                    setStaged((previous) => {
                      const leaves = { ...previous.leaves };
                      delete leaves.path;
                      return { ...previous, leaves };
                    });
                  },
                }),
              ),
              renderField(
                t,
                FIELD_IDS.oldPathPolicy,
                'field.oldPathPolicy.label',
                'field.oldPathPolicy.hint',
                createElement(
                  'select',
                  {
                    className: 'ppt-master-config-select',
                    id: FIELD_IDS.oldPathPolicy,
                    value: valueOf('oldPathPolicy') ?? '',
                    disabled: baseline.oldPathPolicy === undefined,
                    onChange: (event) => setLeaf('oldPathPolicy', event?.target?.value),
                  },
                  createElement('option', { value: 'keep' }, t('option.keep')),
                  createElement('option', { value: 'delete' }, t('option.delete')),
                ),
              ),
            ];

      /**
       * 动作按钮：保存与重置**同形**（`type="button"` 防表单提交、类名即唯一按钮锚）。
       * 类名恒为 `ppt-master-config-button`（测试按全等 + 文案定位），主/次视觉差异走
       * `data-variant`（`primary`／`ghost`），不进类名。
       * `onClick` 直接传 `commit` 的绑定（`() => commit(ops)` 的返回值即 commit 的 Promise
       * ——可测性契约），不包 `async` 以免把 reject 折成新的、语义不同的 Promise。
       */
      const actionButton = (labelKey, ops, disabled, variant) =>
        createElement(
          'button',
          {
            type: 'button',
            className: 'ppt-master-config-button',
            'data-variant': variant,
            disabled,
            onClick: () => commit(ops),
          },
          t(labelKey),
        );

      /**
       * 动作行：**「有快照就渲染」**（不只 `ready`）——`loading`/`unavailable`/只读形态下
       * 两个按钮仍应在场且 `disabled`，好让"写门关闭"是**可见**事实而非"按钮消失"
       * （T3 用例 ⑨②③ 按此钉住：两态都要求按钮在场且禁用）。快照 `undefined`（未接入，
       * 连 holder 都没有表单）时才整行不渲染。
       */
      const actions =
        snapshot === undefined
          ? null
          : createElement(
              'div',
              { className: 'ppt-master-config-actions' },
              actionButton('action.save', setOps, !canWrite || setOps.length === 0, 'primary'),
              actionButton('action.reset', RESET_OPS, !canWrite, 'ghost'),
            );

      // notice 文案＝字典键现取（语言切换后跟随）；传输失败追加错误消息。
      const noticeText =
        notice === undefined
          ? undefined
          : notice.key === 'notice.transportError'
            ? `${t(notice.key)}${notice.message ?? ''}`
            : t(notice.key);

      /** notice 色调（只影响配色）：保存成功＝success，被拒/传输失败＝error，进行中＝pending。 */
      const noticeTone =
        notice === undefined
          ? undefined
          : notice.key === 'notice.saved'
            ? 'success'
            : notice.key === 'notice.pending'
              ? 'pending'
              : 'error';

      return createElement(
        'div',
        { className: 'ppt-master-config-card' },
        createElement('p', { className: 'ppt-master-config-title' }, t('title')),
        createElement('p', { className: 'ppt-master-config-intro' }, t('intro')),
        createElement(
          'div',
          { className: 'ppt-master-config-versions' },
          versionsLine(t('version.plugin'), PLUGIN_VERSION),
          versionsLine(t('version.upstream'), UPSTREAM_VERSION),
          versionsLine(t('version.skillDir'), t('version.skillDirValue')),
        ),
        ...(snapshot !== undefined && snapshot.status === 'ready' ? fields : []),
        createElement('p', { className: 'ppt-master-config-hint' }, t('reset.hint')),
        actions,
        noticeText === undefined
          ? null
          : createElement(
              'p',
              { className: 'ppt-master-config-notice', role: 'status', 'data-tone': noticeTone },
              noticeText,
            ),
        createElement('p', { className: 'ppt-master-config-status', role: 'status' }, body),
        snapshot?.status === 'ready' && snapshot.writable !== true
          ? createElement(
              'p',
              { className: 'ppt-master-config-status', role: 'status' },
              t('state.readOnly'),
            )
          : null,
        snapshot?.mode === 'memory'
          ? createElement(
              'p',
              { className: 'ppt-master-config-status', role: 'status' },
              t('state.memory'),
            )
          : null,
      );
    };

    /**
     * 卡片的**稳定转发器**：对象引用恒不变（故可作为订阅 effect 的依赖），成员按代取值。
     * 默认值＝惰性兜底（本模块尚未被任何 `apply` 安装时的形态）：holder 返回 `undefined`
     * ⇒ 卡片落 `state.unconfigured`；缺键 `t` 回落 key（与字典缺键同判据）。
     */
    Card.forwarder = {
      formHolder: () => undefined,
      t: (key) => key,
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
      // 槽位渲染器实例化卡片时拿不到 ctx，故经 `Card.forwarder` 这一**稳定对象**发布
      // 作用域（每代 apply 可选地重装它；无代际安装时用惰性默认值兜底）：
      // - `formHolder` 是**每次执行都取最新**的函数，且被用作订阅 effect 的**依赖**
      //   （T1 审查裁定②）：`disposeAll()` 后旧 holder 已清空，重挂载的卡片必须重新订阅
      //   **新** holder，否则死在"未接入"（用例 25 的重挂载子断言钉住）。
      // - `t` 必须是**访问器**（T1 审查裁定①）：渲染期现取，宿主语言切换与代际重装才能生效。
      // `t` 的绑定落在 `locale` isolate **内**：`bind` 与 `register` 同属该硬服务，
      // 任一抛错都只应记一条 warn、不冒泡出 apply（隔离收窄到注册点，而非整体 try/catch）。
      const forwarder = Card.forwarder;
      let boundT = (key) => key;
      // 每代一个**恒定**的取值器：卡片侧调用 `formHolder()` 取当代 holder，而该函数
      // **引用本身**只在换代时变化——故它既是稳定依赖（同一代内不触发重复订阅），
      // 又是换代信号（T1 审查裁定②：依赖为 holder 身份，换代后必须重新订阅）。
      const holderOf = () => formHolder;
      Object.defineProperty(forwarder, 'formHolder', {
        configurable: true,
        enumerable: true,
        get: () => holderOf,
      });
      Object.defineProperty(forwarder, 't', {
        configurable: true,
        enumerable: true,
        get: () => boundT,
      });

      isolate('locale', () => {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, DICT), `${LOCALE_NS}: dictionaries`);
        const t = ctx.locale.bind(LOCALE_NS);
        // `t` 也在卡片渲染期被调用（宿主语言切换后仍返回最新文案），故再包一层：
        // 字典服务在渲染期抛错不得拖垮卡片（回落 key，与缺键同形）。
        boundT = (key, params) => {
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
