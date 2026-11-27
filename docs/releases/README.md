# Release notes

每个版本一份 `v<version>.md`。它在 tag 时**就是 GitHub Release 的正文**（tag 后不再改它：补跑会用 tag 内的旧文件重写正文）：`release.yml` 在打 tag 后
读取这个文件建 Release，文件缺失或为空会让发布在门禁阶段失败。

## 写法

结构固定四段（中文 `## 总结`、`## 变更`，`---`，英文 `## Summary`、`## Changes`），先中文后英文：

1. `## 总结` / `## Summary`：一段话，专业、严谨，说清「改了什么、影响谁、要不要升」。
2. `## 变更` / `## Changes`：**每个 PR 一行**，只写结论；机制细节、根因、实测数据归 issue 与 PR。

细则与正反例见 [`docs/agents/maintainer-ops.md`](../agents/maintainer-ops.md) §5。

## 流程

1. release PR 里同时改版本号、`lib/client.js` 的 `PLUGIN_VERSION`、README 双语与 AGENTS §5 表格，并新增本目录下的 notes 文件；
2. 合并后在合并提交上打附注 tag `v<version>` 并推送；
3. tag 触发 `release.yml`：门禁 → `npm publish` → 解包逐文件比对 registry 产物 → 用本文件建 Release。

重跑只在 **tag 仍指向已发布树** 时安全：版本已存在则跳过发布，但仍会把本地打包与 registry 产物解包逐文件比对，不一致即失败；Release 已存在时用 notes 文件更新正文，不重建。
