# 贡献指南 / Contributing

本仓库采用 **GitHub Flow**：`main` 受保护、不直接推送，每次改动都走 **Issue → 分支 → PR → Squash merge**。

## 工作流

1. **先开 issue**（bug / feature / chore 模板），写清动机与验收标准；纯文档等小改动可复用已有 issue，但 PR 描述必须写 `Closes #<issue>`。
2. **从 `main` 拉分支**，命名：`feat/<slug>`、`fix/<slug>`、`chore/<slug>`、`docs/<slug>`。
3. **本地跑全套校验**（见下），把结果贴进 PR。
4. **提 PR**（模板会自动带 checklist），描述里 `Closes #<issue>`。
5. 评审通过后 **squash merge**（仓库只允许 squash），合并后删除分支；`main` 历史保持线性。

`main` 的分支保护：必须经 PR 合入、禁止 force-push 与删除、管理员同样受限。

## 提交信息

- 约定式前缀：`feat:` / `fix:` / `docs:` / `chore:` / `test:` / `refactor:` / `perf:`
- 标题中文、尽量 ≤ 72 字符；正文写**动机**与**验证证据**（命令 + 实际输出）
- 不要在一个提交里混入无关改动（便于 review 与回滚）

## PR 前必须跑的校验

```bash
# 1) 全套测试（当前 711 例；CI 等价环境 711/709，2 条 skip 为显式声明）
node --test tests/*.test.mjs

# 2) 对照已安装 DSH SDK 的契约检查（spec §7.7 六项，warnings 必须为 0）
node scripts/check-dsh-compat.mjs

# 3) vendor 树字节比对（上游完整性；--upstream 取 .upstream/ 缓存目录名 <ref>@<sha>）
node scripts/verify-plugin.mjs --upstream .upstream/refs/tags/v6.8.0@5e8856be0da8e6bc85c4aa28acc614478f7b7137
```

> 环境前置：`@deepseek-ai/schemastery` 须可由宿主 profile 的 `node_modules` 解析（详见 README「本地校验」）。若该前置不满足，部分测试文件会在 **import 期**整体失败，而不是单条用例红。

以上 1) 与 2) 同时由 GitHub Actions CI（`.github/workflows/ci.yml`）在每个 PR 与 `main` 的 push 上跑：job id `test`，已设为 `main` 的**必需状态检查**，PR 必须等它通过才能合并。（3) 不入 CI，仍需本地跑。）

## 红线

- **禁止改动 `skills/ppt-master/**`**：那是上游 vendor 树，逐字节一致、受上游 `attribution_guard.py` 完整性门校验；只能由 `scripts/sync-upstream.mjs` 替换。
- **不要手改** `cordis.patch.yml` 的 `insert:` 结构（由 `check-dsh-compat` 静态断言）。
- 发布面文件（`README.md` / `README.en.md` / `NOTICE` / `LICENSE` / `package.json` / `screenshots.json`）改动需与版本策略一致。

## 版本与发布

| 场景 | 版本动作 |
|---|---|
| 上游发布新版本（同步脚本规则①） | base 改为上游版本，`-r` 后缀归零，如 `6.7.0-r3 → 6.7.1` |
| 仅包装层自身修订（同上游版本） | 追加 `-rN`，如 `6.7.1 → 6.7.1-r1` |
| 仅文档 / CI / 仓库治理 | **不 bump**，不打 tag |

发布：附注 tag `v<version>`（写要点）→ GitHub Release（双语说明 + 验证结果）→ 同步内网镜像 `origin`。

## 上游同步

```bash
node scripts/sync-upstream.mjs --dry-run   # 先看计划
node scripts/sync-upstream.mjs --no-push   # 本地替换 + commit + tag（推送自行控制）
```

同步后**必须**核对两个版本常量各自的对标关系（卡片版本块与测试都依赖它），并补双语 README 的版本表：

- `PLUGIN_VERSION` ≡ `package.json.version`（本插件自身版本，含 `-rN` 后缀，如 `6.7.1-r1`）；
- `UPSTREAM_VERSION` ≡ vendor `skills/ppt-master/SKILL.md` 的 `metadata.version`（上游版本，如 `6.7.1`）——**不是** `package.json.version`。

---

## English

This repository follows **GitHub Flow**: `main` is protected and never pushed to directly — every change goes **Issue → branch → PR → squash merge**.

1. Open an issue first (bug / feature / chore templates) stating the motivation and acceptance criteria; PRs must say `Closes #<issue>`.
2. Branch from `main`: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`.
3. Run the three verification commands above and paste the results into the PR.
4. Open the PR (the template carries the checklist).
5. **Squash merge** after review (the repo only allows squash merges); delete the branch afterwards so `main` stays linear.

`main` requires a pull request, forbids force pushes and deletion, and applies to administrators too.

**Never edit `skills/ppt-master/**` by hand** — it is the upstream vendored tree, byte-for-byte and guarded by the upstream `attribution_guard.py`; only `scripts/sync-upstream.mjs` may replace it.

**Version policy**: an upstream sync takes the upstream base and resets `-r` (rule ①); wrapper-only revisions append `-rN`; docs/CI/governance changes do not bump. Releases are annotated `v<version>` tags plus a bilingual GitHub Release, mirrored to the internal `origin`.
