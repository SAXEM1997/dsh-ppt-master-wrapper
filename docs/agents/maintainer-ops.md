# Maintainer ops: 外部 PR、上游比对树、宿主版本差异

维护者侧的三件操作：**外部贡献者 PR 怎么让 CI 跑起来**、**vendor 字节比对树怎么造**、
**宿主 SDK 升版后怎么判断契约面是否漂移**。三条都属于稳定规则，不含任何凭据值。

> 凭据约定：本仓库所有远端操作都用**一次性 URL 注入**，不写进 remote 配置、不写进
> 本文档、输出一律脱敏（`sed -E 's#https://[^@]*@#https://<redacted>@#g'`）。

## 1. 外部贡献者的 PR：先批准 CI，否则永久卡住

fork 首次投稿者的 workflow run 会停在 **`action_required`**——GitHub 的防滥用策略要求
维护者点一次批准。此时 PR 的 `test`（必需检查）**根本不会运行**，PR 因此永远无法合并。

```bash
# 1) 找到停在 action_required 的 run
gh pr checks <PR号> --repo SAXEM1997/dsh-ppt-master-wrapper   # → "no checks reported"
gh api repos/SAXEM1997/dsh-ppt-master-wrapper/actions/runs/<run_id> --jq '{status,conclusion}'
#    → {"status":"completed","conclusion":"action_required"}

# 2) 批准——注意：这一步不能走 gh 里存的凭据
gh api -X POST repos/SAXEM1997/dsh-ppt-master-wrapper/actions/runs/<run_id>/approve
#    → 403 "Resource not accessible by personal access token"（gh 存的 token 权限不够）

# 正确做法：classic PAT 直调（返回 201 且 body 为空即成功）
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $CLASSIC_PAT" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/SAXEM1997/dsh-ppt-master-wrapper/actions/runs/<run_id>/approve

# 3) 批准后 workflow 才真正开始跑，再等检查转绿
gh pr checks <PR号> --repo SAXEM1997/dsh-ppt-master-wrapper
```

贡献者若已在 fork 上跑过同名 workflow 并贴出结论，那只是**等价证据**，不能替代本仓库的
必需检查——批准这一步仍然免不了。

## 2. `.upstream/<ref>@<sha>` 比对树：`verify-plugin` 的输入

`scripts/verify-plugin.mjs` 的字节比对面要求显式 `--upstream`，指向一个**上游源码树**，
目录名必须严格是 `<ref>@<sha>`（`<sha>` 是该 tag 的 commit）。规则①同步时
`sync-upstream.mjs` 会自动建；**手工验证**（例如审查外部 PR 的同步）时自己造：

```bash
REF=v6.7.3
SHA=622bf0148bca4f697b0184322c7e2aa2a04520a2
git clone --depth 1 --branch "$REF" https://github.com/hugohe3/ppt-master.git \
  ".upstream/refs/tags/${REF}@${SHA}"
git -C ".upstream/refs/tags/${REF}@${SHA}" rev-parse HEAD   # 必须等于 $SHA

node scripts/verify-plugin.mjs --upstream ".upstream/refs/tags/${REF}@${SHA}"
```

要点：

- `.upstream/` 已在 `.gitignore` 中，不会污染工作区；
- **`SHA` 必须与 `REF` 对得上**，否则校验的是错误的树——克隆后先 `rev-parse HEAD` 核对；
- 目录名写错（缺 `@<sha>`）会 fail-loud，不会静默放过。

## 3. 宿主 SDK 升版：用 tarball diff，别靠 changelog

判断 DSH 新版本是否动摇插件契约面（`register` / `schemaOf` / volatile 语义等），
读 release notes 不可靠。可行做法是把两个版本各自解包后逐文件比对：

```bash
mkdir -p /tmp/dshdiff && cd /tmp/dshdiff
# 本机 npm 缓存可能是 root 所有，抽一份临时缓存避免 EACCES
npm pack --cache /tmp/npmcache @deepseek-ai/dsh-tools@<旧版本> @deepseek-ai/dsh-tools@<新版本>
for f in *.tgz; do d="x-${f%.tgz}"; mkdir -p "$d" && tar -xzf "$f" -C "$d" --strip-components=1; done
diff -rq x-deepseek-ai-dsh-tools-<旧版本> x-deepseek-ai-dsh-tools-<新版本>
```

判读：

- **输出为空** ⇒ 代码逐字节相同，契约面零风险；
- **只差 `package.json`** ⇒ 仅版本号变动（本轮 rc.2 → rc.3 即此形态）；
- 有其它差异 ⇒ 逐个看是否落在插件依赖的红线锚点上。

注意版本号体系**不统一**：`@deepseek-ai/dsh*` 走 `0.2.1-rc.N`，
而 `@deepseek-ai/cordis-plugin-loader` 走自己的 `1.0.x` 线（volatile 语义在那里）。
查宿主实际锁的 loader 版本：

```bash
npm view @deepseek-ai/dsh@<版本> dependencies --json | grep loader
```

两个宿主版本若同锁一个 loader 范围（如 `~1.0.6`），volatile 行为就不会变。

## 4. 合并后的收尾清单

外部贡献者 PR 合入并发布时，除常规发布链外补两件事：

1. **在 PR 与对应 issue 上都道谢**——记录验证结论（哪个门、什么结果），并具体说明贡献
   的价值（例如「Windows 路径修复补上了我们一直没暴露的盲区」），而不是一句 "thanks"；
2. **Release notes 署名**贡献者并链接其 PR/issue。

`squash merge` 会保留作者身份，但 GitHub 的贡献者图只统计**合入默认分支**的提交——
发布后顺手确认 `git log` 里有作者署名即可。
