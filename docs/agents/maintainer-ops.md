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

**结构固定四段：`## 总结` + `## 变更`，`---`，`## Summary` + `## Changes`**（先中文后英文）。第 3 项不新增标题，并入前两段：

1. **总结段**：一段话，用**专业、严谨**的口吻说清「改了什么、影响谁、要不要升」。陈述事实
   与范围，不用感叹句、不用营销词、不承诺未验证的效果。读者只看这一段就该能决定要不要升。
2. **变更项列表**：**每项对应一个 PR**，一行一条。一个 PR 内含多处技术改动也只占一行；
   机制细节、根因、实测数据归 PR 与 issue，不进 release body。
3. **必要时的边界说明**：覆盖边界、已知限制、需要人工处理的事，一到两句，同样平实陈述。

模板：

说明文件放 `docs/releases/v<version>.md`，随 release PR 提交；`release.yml` 用它作 GitHub
Release 正文，文件缺失或为空会让发布在门禁阶段失败。模板：

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

## 6. npm 发布：tag 触发，token 直发（2FA stage 为兜底）

GitHub Release 与 npm 是两条独立渠道：Release 回答「要不要升级」，npm 让**插件市场**能解析
版本、比对更新并一键安装。从下一个发布起（首个带 `docs/releases/` 的版本），两者都由同一个 tag 推送完成；`v6.10.0-r1` 及其之前仍是 stage + 2FA 手工路径。

### 为什么上传在 CI 而不在本机

维护机出口上行被限到 ~23 KB/s（下载 1 MB/s；同出口对 Cloudflare 也是 ~52 KB/s），17.7 MB 的
tarball 传不完——2026-11-09 三次 `npm stage publish` 全部在中途 `ECONNRESET`。tarball 体积压
不下来：主体是 vendor 的 `templates/`，而 vendor 必须逐字节完整。runner 上行正常，故上传走 CI。

### 流程

```bash
# 1. release PR：① package.json.version ② lib/client.js 的 PLUGIN_VERSION
#    ③ README 双语与 AGENTS §5 表格 ④ docs/releases/v<version>.md
# 2. 合并后在合并提交上打附注 tag 并推送 —— 这一步就是「发版」
git tag -a v6.10.0-r2 -m v6.10.0-r2
git push origin v6.10.0-r2

# 3. release.yml 自动执行：门禁 → npm publish → 产物逐文件比对 → gh release create
# 4. 补跑：不传 source_ref（checkout tag），dry_run 必须显式 false（它默认 true）
gh workflow run release.yml -f version=6.10.0-r2 -f dry_run=false
```

重跑安全有前提：**tag 仍指向已发布的树**。版本已存在时发布会跳过，但随后把本地打包与
registry 产物解包逐文件比对，不一致直接失败、不建 Release。若 tag 从未成功发布（门禁就
失败），可以删掉重打：`git push origin :v<version>`，修 main 后重新打 tag；**一旦该版本已进
registry，永不移动 tag**——有改动就发 `-rN+1`。
两条约束：① `--tag latest` 会把 npm 的 `latest` 指向本次发布的版本，所以**只在最新版本线
上打 tag**；回填一个从未发布过的旧版本会把 `latest` 顶回去。② Release 正文由 workflow 从
**tag 内**的 notes 文件渲染，补跑会重写正文；对已建 Release 的手工修订会在下次补跑时丢失。

### 门禁

- tag 与 `package.json.version` 一致；
- `docs/releases/v<version>.md` 存在且非空；
- README 双语与 AGENTS §5 都有 ``| `v<version>` |`` 行；
- stub 树跑全套测试、`npm pack --dry-run`（`prepack` 会拦个人模板库）；
- `lib/client.js` 的 `PLUGIN_VERSION` 与 tag 一致；tag 必须是附注 tag 且指向 `main` 上的提交；
- `npm pack` 时核对 `skills/` 在磁盘与 tarball 中的文件数一致（否则用户侧 `attribution_guard.py` 必失败）；
- `npm whoami` 预检 `NPM_TOKEN`；发布前本地打包，发布后取回 registry 产物、解包逐文件比对（一致才建 Release）。不按字节比：tar 元数据（文件模式、压缩实现）可能让同一份内容得到不同字节；要证明的是文件内容一致。

### 兜底：2FA stage

`NPM_TOKEN` 若受 npm「限制绕过 2FA 的 token」新政影响，可能 `whoami` 通过、`publish` 被拒；
token 本身失效则 `whoami` 就失败。两种情况都改用仍保留的 `publish.yml`（它需要先修好 secret
里的 token；注意它**只**做 tag/manifest 断言与 vendor 文件数校验，notes、记账、附注 tag/on-main
与测试都不跑——切过去之前先手工确认这些门禁），由维护者带 2FA
`npm stage approve <stage-id> --registry=https://registry.npmjs.org` 完成发布。拒绝用
`npm stage reject <stage-id>`：该版本号不会被占用，改完可重发。

### 版本号的坑（必读）

本仓库修订版形如 `6.9.0-r1`，semver 视其为**预发布**（`6.9.0-r1 < 6.9.0`）。因此 ① 每次发布
（workflow 里的 `npm publish --tag latest`）都必须显式指定 `latest`，否则 `npm i <pkg>` 会停在旧的正式版；② `^6.9.0` 这类范围**不会**
包含 `6.9.0-r1`，要锁定修订版必须写全。

### 认证与 registry

token 只走环境变量或 CI secret，**不写进仓库任何文件**。`publishConfig.registry` 已钉死
`https://registry.npmjs.org`，`npm publish` / `npm stage publish` 跟随它；但
**`npm stage list|approve|reject` 不读 `publishConfig`**——本机默认 registry 是镜像站
（`registry.npmmirror.com` 没有 `/-/stage` 端点，会 404），故这几条必须显式
`--registry=https://registry.npmjs.org`。

### 本机直发（已取消）

不再支持从本机 `npm publish`：它会绕过 tag 校验、notes、版本记账、测试与 provenance，正是
`v6.9.0` 那个「tag 与产物对不上」事故的成因。上行受限或 `NPM_TOKEN` 失效时，走 `publish.yml`
的 `npm stage publish` + 维护者 `npm stage approve` 兜底。

### 发布前必查（workflow 已自动执行前两条）

```bash
npm pack --dry-run                 # tarball 体积与总文件数
find skills -type f | wc -l        # 与上面 skills/ 的文件数逐一对齐——vendor 必须完整，
                                   # 少一个文件，装上后 attribution_guard.py 完整性门必失败
npm i ./dsh-ppt-master-wrapper-<ver>.tgz   # 干净目录装一次；import 入口应打印 name/inject/Config
```

`files` 白名单已含 `skills`/`scripts`/`lib`/`cordis.patch.yml`/`static` 与双语 README；
`tests/` 与 `docs/` 不进包。tarball 约 17–18 MB（vendor 压缩后），远低于 registry 上限。
