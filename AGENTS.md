# Agent Writing Contract

本仓库是 DeepSeek Harness 的独立中文源码学习站，不属于 OpenCode 站点。

## 证据基线

- 上游仓库：`deepseek-ai/deepseek-harness`
- 固定提交：`47f943859bef60e4160492346772ded9b24f765a`
- 本地默认源码：`../../deepseek-harness`
- 正文中的源码链接必须使用固定提交，不得链接漂移的 `master`。

## 写作与验证

- 面向有 Java 背景、正在学习 TypeScript 与 Agent 架构的开发者。
- 每章必须含“本章学习目标”和“一句话讲明白”，先画地图，再追调用链。
- 明确区分源码事实、设计解读和教学推演。
- 新增关键结论时同步更新 `scripts/validate-sources.mjs` 的证据索引。
- 完成后运行 `pnpm run validate:sources`、`pnpm run check`、`pnpm run build`。
