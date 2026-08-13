---
title: "01. 项目地图与启动"
description: "从 dsh 命令追到一棵可替换、可卸载的 Cordis 插件树。"
---

# 01. 项目地图与启动

## 0. 本章学习目标

- 说清 `apps/`、`packages/`、`vendor/`、`examples/` 的边界。
- 从 `dsh web` 追到 `Context` 和插件树装载。
- 解释 Profile、Bundle、Patch 的叠加顺序。
- 定位启动失败的停止点和清理行为。

## 1. 一句话讲明白

DeepSeek Harness 的启动不是构造一个固定应用，而是把 Profile 解析成有顺序的配置层，再装载成一棵 Cordis 插件树。

本章基于源码提交 [`47f9438`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)。中央问题是：**一条 `dsh web` 命令怎样变成正在运行的 Agent 产品？**

## 2. 先看全局地图

```text
apps/cli            命令解析、Profile 组合、进程退出
   │
   ├─ packages/boot       通用装载与失败审计
   ├─ packages/bundle     base / web-app / headless 配置层
   ├─ packages/*          可组合能力与产品插件
   ├─ vendor/cordis       插件容器与生命周期内核
   └─ apps/web            极薄的浏览器挂载入口
```

源码事实：根目录 [`AGENTS.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/AGENTS.md#L7-L57) 给出了完整分组；[`docs/architecture.md:17-35`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md#L17-L35) 定义了 Profile、Bundle 与层叠顺序。

## 3. 最小启动机制

```ts
const invocation = parseDshArgs(process.argv.slice(2), version)
const profile = prepareProfile(invocation.profile)
const ctx = await boot('dsh', profile.root, profile.patches, prepare)
```

真实入口在 [`apps/cli/src/bin.ts:27-49`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/bin.ts#L27-L49)。它先把参数解析为带判别字段的联合类型，再按分支动态导入实现。Java 开发者可以暂时把它看作 `CommandLineRunner`，但这里没有常驻的中心容器配置类：Profile 最终指向 YAML 插件行。

## 4. 一次 `dsh web` 的真实调用链

1. `parseDshArgs()` 识别 Profile、Patch、参数与特殊命令。
2. `runProfile()` 在任何插件启动前冻结命令参数、组合 Bundle 和用户 Patch，见 [`apps/cli/src/profile-boot.ts:203-283`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/profile-boot.ts#L203-L283)。
3. `boot()` 创建根 `Context`、挂载 Loader、执行 host prepare，再挂载根 Include。
4. Loader 完成后，`assertEntriesActivated()` 审计每个配置行是否真正激活。
5. Web Bundle 提供 server、API 与前端插件；Headless Bundle 则挂一条运行一次就结束的消费链。

关键源码是 [`packages/boot/app-boot/src/index.ts:757-800`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/boot/app-boot/src/index.ts#L757-L800)。注意 `await ctx.fiber.dispose()`：任一启动阶段失败都会先卸载已挂载部分，再保留最深层异常堆栈。

## 5. 决定性分支与失败路径

| 情况 | 行为 | 为什么重要 |
| --- | --- | --- |
| `--dump-config` | 只输出最终配置树 | 先证明组合结果，不启动产品 |
| 插件找不到 | `assertEntriesActivated` 报出具体配置行 | 不静默降级成缺能力应用 |
| Surface 启动中主动退出 | Loader 已随树销毁时直接返回 | 正常退出不被误判为启动失败 |
| prepare 失败 | 标记为 host preparation | 与 plugin tree failure 分开诊断 |

## 6. 设计解读：为什么不是一个大 `main()`

这是设计解读：配置层让发行版、用户配置和一次性 Overlay 使用同一种替换机制；生命周期交给 Fiber 后，热替换和失败回滚不需要每个能力手写清理总线。代价是阅读时必须同时理解“配置树”和“运行时插件树”。

## 7. 可迁移方法与验证问题

- **先输出最终配置再启动。** 验证：系统能否打印合并后的真实配置，而不是仅打印输入文件？
- **启动审计必须检查激活结果。** 验证：模块解析成功但初始化失败时，进程是否仍会错误地进入服务状态？
- **部分启动必须可逆。** 验证：第 8 个插件失败时，前 7 个注册的监听器和资源是否全部撤销？

## 8. 费曼复述与练习

不用术语，向同事解释：为什么 `dsh web` 和 `dsh headless` 可以共享模型、工具和日志，却拥有不同界面？

```bash
dsh --profile web --dump-config
dsh --profile headless --dump-config
```

对比输出，找出共同的 `base` 能力和各自新增的 Surface。下一章继续追问：**插件为什么能在同一个 Context 中注册服务、事件和可撤销副作用？**
