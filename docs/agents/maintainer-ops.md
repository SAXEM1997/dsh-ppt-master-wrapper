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

# 2) 批准——先用 gh 里存的凭据试（够用就不要绕路）
gh api -X POST repos/SAXEM1997/dsh-ppt-master-wrapper/actions/runs/<run_id>/approve
#    → 成功时返回空对象 {}，随后 run 由 action_required 转 queued
#    （2026-11-06 在 run 42154397773 上实测成功；本文档早先记录的
#      "403 Resource not accessible by personal access token" 已不可复现，
#      但该失败形态仍可能出现——若命中，走下面的 classic PAT 直调）

# 兜底：classic PAT 直调（返回 201 且 body 为空即成功）
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
REF=v6.8.0
SHA=5e8856be0da8e6bc85c4aa28acc614478f7b7137
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

## 5. Release 说明的写法

**结构固定三段，中英双语各一份**（先中文后英文，英文段单独 `---` 分隔）：

1. **总结段**：一段话，用**专业、严谨**的口吻说清「改了什么、影响谁、要不要升」。陈述事实
   与范围，不用感叹句、不用营销词、不承诺未验证的效果。读者只看这一段就该能决定要不要升。
2. **变更项列表**：**每项对应一个 PR**，一行一条。一个 PR 内含多处技术改动也只占一行；
   机制细节、根因、实测数据归 PR 与 issue，不进 release body。
3. **必要时的边界说明**：覆盖边界、已知限制、需要人工处理的事，一到两句，同样平实陈述。

模板：

```markdown
## 总结

<一段话：改了什么、影响谁、建议不升/建议升>

## 变更

- #<PR 号> <一行结论>
- #<PR 号> <一行结论>

---

## Summary

<one paragraph, same content, formal register>

## Changes

- #<PR number> <one line>
- #<PR number> <one line>
```

**口吻参照**（左对右错）：

| 对 | 错 |
|---|---|
| 本版本修复一处装载期竞态，在 DSH 0.2.2-rc.1 上可能导致插件不激活。 | 修好了一个**让插件完全装不上**的大坑！ |
| 触发条件与启动批次的插件构成有关，同一版本在不同环境可表现不同。 | 同一版本在两台机器上表现可以完全不同。 |
| 使用 0.2.2 的环境建议升级；0.2.1 环境不受影响。 | 用 0.2.2 的赶紧升！ |

**反例**（曾经的写法，别回去）：把根因分析、红→绿三态实测表、stub 替身设计理由全塞进
release body——那属于 PR 描述和 AGENTS，release 页面只服务「要不要升级」这一个问题；
或者按技术改动逐条列点、导致一个 PR 拆成四五条，读者看不出这版到底合了什么。

## 6. npm 发布：先 stage，再由维护者批准

GitHub Release 与 npm 是两条独立渠道：Release 回答「要不要升级」，npm 让**插件市场**能解析
版本、比对更新并一键安装。发版时两条都要走。

**认证**：用 npm granular access token（`npm_…`），只经环境变量传，**不写进仓库任何文件**。
本机默认 registry 是镜像站（`registry.npmmirror.com`），**镜像不能发布**——`package.json` 的
`publishConfig.registry` 已钉死 `https://registry.npmjs.org`，`npm publish` 与 `npm stage publish`
都会跟随它，不必每次手写 `--registry`。

**先 stage，把 2FA 证明推迟到批准那一刻**：

```bash
export NPM_TOKEN='npm_…'
npm stage publish --tag latest --//registry.npmjs.org/:_authToken="$NPM_TOKEN"
# → 输出 stage id
npm stage list --//registry.npmjs.org/:_authToken="$NPM_TOKEN"
```

维护者批准（需 2FA），或拒绝：

```bash
npm stage approve <stage-id>     # 批准后正式发布
npm stage reject  <stage-id>     # 拒绝：该版本号不会被占用，改完可重发
```

**版本号的坑（必读）**：本仓库修订版形如 `6.9.0-r1`，semver 视其为**预发布**
（`6.9.0-r1 < 6.9.0`）。因此 ① 每次发布都必须显式 `--tag latest`，否则 `npm i <pkg>`
会停在旧的正式版；② `^6.9.0` 这类范围**不会**包含 `6.9.0-r1`，要锁定修订版必须写全。

**发布前必查**（三条，任一失败都会把坏包发出去）：

```bash
npm pack --dry-run                 # 看 tarball 体积与总文件数
find skills -type f | wc -l        # 与上面 skills/ 的文件数逐一对齐——vendor 必须完整，
                                   # 少一个文件，装上后 attribution_guard.py 完整性门必失败
npm i ./dsh-ppt-master-wrapper-<ver>.tgz   # 干净目录装一次；import 入口应打印 name/inject/Config
```

`files` 白名单已含 `skills`/`scripts`/`lib`/`cordis.patch.yml`/`static` 与双语 README；
`tests/` 与 `docs/` 不进包。tarball 约 17–18 MB（vendor 压缩后），远低于 registry 上限。
