# 澄清记录：dsh-ppt-master-wrapper

> 本文件为 Phase 0 brainstorming 决策的忠实索引。完整论证见设计文档：
> [docs/superpowers/specs/2026-10-14-dsh-ppt-master-wrapper-design.md](../specs/2026-10-14-dsh-ppt-master-wrapper-design.md)（经 3 轮完整审查 + 最终通读 PASS，Gate 0）。

## 任务目标

将上游项目 [hugohe3/ppt-master](https://github.com/hugohe3/ppt-master)（技能市场形式的 Claude/DSH 技能集）包装为 DSH 插件 `dsh-ppt-master-wrapper`，提供：

1. 上游技能经 cordis provider 注册到 DSH（零改写，忠实 vendor）
2. 生命周期工具（info / check_env / setup_deps / verify-plugin / check-dsh-compat）
3. 一键同步脚本（检测上游新版本 → 归类变更 → 版本 bump → 推送 GitLab）

## 关键澄清决策

| # | 问题 | 决策 |
|---|------|------|
| 1 | 上游代码如何进入本仓库？ | **方案 A：忠实 vendor + 零改写**——上游文件字节级原样进入 `.upstream/`，由 `attribution_guard.py` 完整性门校验（LICENSE SHA256、frontmatter 精确值、门文件清单）。否决方案 B（适配改写：维护成本高、偏离上游） |
| 2 | 上游更新如何跟进？ | 一键同步脚本（8 步流程，exit 0-7）：拉取 tag → guard 校验 → 变更归类（红/黄/绿）→ 版本决策（镜像上游版本 + `-rN` 后缀）→ tag + push。结构性变更（红）exit 2 交人工处理 wrapper |
| 3 | Git 策略？ | main 单分支 + tag；推送到 `gitlab.ai.isvacent.../zyx/dsh-ppt-master-wrapper.git`。**PAT 仅经环境变量 `DSH_PPT_GITLAB_PAT` / credential helper 注入，绝不落库** |
| 4 | 参考项目 pn1024/dsh-ppt-master 的地位？ | 仅作参考，不引入其代码（可丢弃） |
| 5 | 运行时依赖？ | 零 npm 运行时依赖（Node 内置 + git + python3 子进程） |

## 排除范围

- 不改写上游技能内容（不"修复"上游问题）
- 不支持 fork 上游或多上游
- 不做多分支 Git 工作流（main + tag 即可）

## 审查轨迹

- 设计文档 3 轮完整审查（P0×2 → P0×1 → 收敛）+ 最终通读 PASS（Gate 0，token `.gate-passed-0`，round=3）
- OpenSpec propose 阶段（Phase 1）本任务跳过（`.phase1-skipped`）
- 实施计划 3 轮完整审查 + 最终通读 PASS（Gate 2，token `.gate-passed-2`，round=3）
