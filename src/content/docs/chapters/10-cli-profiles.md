---
title: "10. CLI、Profile 与无头运行"
description: "理解 dsh 参数、Profile 层叠、Bundle、Patch 和 Headless Surface。"
---

# 10. CLI、Profile 与无头运行

## 0. 本章学习目标

- 从 CLI 参数解析到 `runProfile()`。
- 准确说出配置层叠顺序。
- 区分 Web、Headless 与 Plugin 子命令。
- 使用 `--dump-config` 诊断真实组合。

## 1. 一句话讲明白

CLI 不决定 Agent 有哪些能力；它选择 Profile，再把 Bundle、用户 Patch、Home Patch 与一次性 Overlay 按顺序叠加成插件树。

## 2. 四层配置

```text
空 entry list
  + profile 声明的 bundles（按顺序）
  + profile/cordis.patch.yml
  + home/cordis.patch.yml
  + --patch overlays
= 最终 Cordis rows
```

这条顺序是源码文档事实，见 [`docs/architecture.md:17-35`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md#L17-L35)。Patch 按 row id 替换整段 config 或插入新 row，不做无法解释的深层隐式 merge。

## 3. CLI 判别联合

`parseDshArgs()` 返回不同 `kind`：运行 Profile、输出配置、执行 Plugin 命令、版本/帮助等。`bin.ts` 对 `kind` 做穷尽分支并动态 import，见 [`apps/cli/src/bin.ts:27-52`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/bin.ts#L27-L52)。这让只看帮助时不加载完整运行时。

## 4. Web 与 Headless 共享什么

`dsh-base` 提供模型、工具、持久化、sandbox、审批、设置、凭据和遥测。`dsh-web-app` 加浏览器应用；`dsh-headless` 加一次性 runner，不启动 server。共同能力由 Bundle 组合共享，不靠复制两个 main。

典型命令：

```bash
npx @deepseek-ai/dsh web
pnpm dsh --profile headless "解释当前仓库"
dsh --profile web --dump-config
dsh --profile headless --dump-config
```

## 5. 环境与凭据边界

启动层读取 `DEEPSEEK_API_KEY`、可选 base URL 与根 `.env`，但 `CredentialRef` 只保存引用，不把值写入配置、Session 或 UI。`loadLayeredEnv()` 还区分 bootstrap-only 变量，避免把 `DSH_*` 等宿主控制量无意传进插件环境。

## 6. 失败路径

- Profile 不存在：准备阶段失败，不创建半棵树。
- Overlay 指向错误 row：dump-config 可在启动前发现。
- 插件 bare specifier 未列入 resolver manifest：验证 gate 拒绝。
- headless 没有 API key：真实模型路径失败；keyless snapshots 仍可验证装配行为。
- 子进程运行源码时 CJS/ESM 混用：源码启动合约拒绝，项目要求 ESM everywhere。

## 7. 可迁移方法

- **产品差异用组合层表达。** 不复制核心初始化逻辑。
- **提供可审计的最终配置。** 线上故障先对真实组合，不猜默认值。
- **命令解析结果使用判别联合。** 新子命令可被编译器要求穷尽处理。

## 8. 练习与下一问

基于 `--dump-config` 设计一个只换 LLM Provider、不改工具与持久化的 Overlay。下一章看最后一层：**Web/TUI 如何消费同一 Session 事实，却保持界面插件可组合？**
