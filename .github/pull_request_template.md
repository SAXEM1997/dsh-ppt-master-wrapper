## 目的 / What & why

Closes #

<!-- 一句话说明要解决什么问题；引用相关 issue -->

## 改动 / Changes

-

## 验证 / Verification

- [ ] `node --test tests/*.test.mjs` → **711/711**（贴实际输出；CI 等价环境为 711/709，2 条 skip 是显式声明）
- [ ] `node scripts/check-dsh-compat.mjs` → **OK**（spec §7.7 六项齐，warnings 0）
- [ ] `node scripts/verify-plugin.mjs --upstream <缓存目录>` → **problems 0**
- [ ] 未触碰 `skills/ppt-master/**`（上游 vendor 树逐字节）
- [ ] 版本策略已核对：docs-only 不 bump / 包装层修订追加 `-rN` / 上游同步走规则①
- [ ] 双语 README 已同步（若涉及用户可见行为或发布面）

## 备注 / Notes

<!-- 截图、风险评估、后续 issue 等 -->
