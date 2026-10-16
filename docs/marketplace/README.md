# 插件市场收录（awesome-dsh-plugin）

本目录是投递 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的**投递材料与核对表**。规范原文见该仓库的
[contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)。

## 投递物

| 文件 | 作用 |
|---|---|
| [`awesome-dsh-plugin.yml`](awesome-dsh-plugin.yml) | 条目内容，逐字复制为对方仓库的 `data/plugins/SAXEM1997__dsh-ppt-master-wrapper.yml` |
| [`../../screenshots.json`](../../screenshots.json) | 市场详情页截图声明（1-8 张，相对路径；本仓库根，与 `package.json` 同级） |
| [`../../assets/screenshot-1-config-card.png`](../../assets/screenshot-1-config-card.png) | 截图本体（插件页配置卡片） |

## 投递步骤

```bash
# 1) fork + clone
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin

# 2) 只新增一个文件（一个 PR 最多 3 条；不要手工编辑 README）
cp /path/to/dsh-ppt-master-wrapper/docs/marketplace/awesome-dsh-plugin.yml \
   data/plugins/SAXEM1997__dsh-ppt-master-wrapper.yml

# 3) 本地预览生成结果（可选，提交时须与数据源一致）
npm ci && node scripts/generate-readme.mjs

# 4) 提交并开 PR
git checkout -b add-dsh-ppt-master-wrapper
git add data/plugins/SAXEM1997__dsh-ppt-master-wrapper.yml
git commit -m "Add SAXEM1997/dsh-ppt-master-wrapper"
git push -u origin add-dsh-ppt-master-wrapper
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin --fill
```

## 前置条件核对表

| 条件 | 状态 | 证据 |
|---|---|---|
| `package.json` 声明 `dsh.bundle`（**只声明 `dsh.client` 会被拒**） | ✅ | `dsh.bundle.patch = ./cordis.patch.yml`；`tests/skeleton.test.mjs` 断言 |
| 仓库根有 `cordis.patch.yml`，且为 `insert:` 形 | ✅ | 根目录文件；`scripts/check-dsh-compat.mjs` §7.7③ 静态断言 |
| 真实可用的代码（非占位 / 纯 README） | ✅ | `index.js` / `lib/` / `scripts/` / `tests/`（570+ 用例） |
| 仓库创建满 **1 天**（CI 自动检查） | ⏳ | 本仓库 GitHub 端创建于 2026-10-16 ⇒ **2026-10-17 起**投递可通过 |
| 添加 `dsh-plugin` topic | ✅ | 已通过 GitHub API 设置 |
| 描述属实、无营销词 | ✅ | 逐句对应见 `awesome-dsh-plugin.yml` 顶部自检注释 |
| 分类贴合 | ✅ | `skill`（主体是技能封装；与同账号 specpowers 条目同类） |
| 活跃维护 | ✅ | 持续提交；周期性扫描会移除停更条目 |

## 可选加分项

- **`screenshots.json`**：已声明 `assets/screenshot-1-config-card.png`（市场详情页按此顺序展示，无需再来提 PR 换图，推本仓库即生效）。
- **npm 发布**：可选。若发布，`package.json` 的 `repository` 字段必须指回 `https://github.com/SAXEM1997/dsh-ppt-master-wrapper`（本仓库已按此填写），否则 registry 侧不会与条目关联。
- **预构建 tarball**：仅在"无法从源码安装"时必需；本插件无构建步骤（纯 JS + 逐字节 vendor），从源码安装即可，故不声明 `tarball:`。

## 备注

- 描述里出现的每个 API 名都会与代码核对：`ppt_master_info` / `ppt_master_check_env` / `ppt_master_setup_deps` 三工具确实存在于 `lib/tools.js`，venv 三叶子确实存在于配置声明，配置卡片确实由 `lib/client.js` 注册。
- 上线后如需改描述或换分类，**只改自己那一条**并重新生成 README（勿手工编辑 README，列表增长会导致行号漂移）。
