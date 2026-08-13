---
title: "12. 扩展、测试与实战"
description: "用 Service Definition / Provider / Consumer 完成一个可验证能力闭环。"
---

# 12. 扩展、测试与实战

## 0. 本章学习目标

- 为新能力选择正确的扩展点，而不是修改 Agent Loop。
- 设计 Definition / Provider / Consumer 三角色。
- 建立 unit、e2e、snapshot 的最小证据链。
- 用真实 entry path 验证构建产物。

## 1. 一句话讲明白

一次合格扩展要同时完成能力接口、可替换实现、真实消费方、配置接线、失败策略、文档和从真实入口经过的测试。

## 2. 先做扩展点决策

| 需求 | 正确位置 |
| --- | --- |
| 新模型 Provider | `ctx.llm` adapter registration |
| 新模型工具 | `ctx.tools.register()` + schema/presentation |
| 新持久事实 | declaration-merge `SessionEventMap` + projection |
| 拦截请求/工具 | 对应 `agent/*` 或 `tools/*` Waterfall |
| 新 UI 业务行 | Conversation Node Definition + keyed renderer |
| 新后台执行 | `ctx.jobs` / workflow / subagent Provider |

完整表在 [`docs/architecture.md:104-129`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md#L104-L129)。上游明确规定新行为优先上扩展点；直接改 `agent-loop` 必须同步架构文档。

## 3. 最小端到端：新增 `weather` 能力

```text
packages/weather/weather            Service Definition
packages/weather/weather-http       Provider
packages/weather/tool-weather       Consumer
packages/bundle/base patch          组合接线
docs + README                       当前行为与限制
tests                               unit + assembled snapshot
```

最简单实现先让 tool 调 `ctx.weather.query()`，明确 timeout/cancel/error codes；不要提前增加缓存、Provider fallback 或多城市批处理。

## 4. 三层验证

| 层 | 证明什么 | 示例 |
| --- | --- | --- |
| Unit | schema、归一、边界与失败 | invalid city、abort、provider error |
| E2E / integration | Definition/Provider/Consumer 接线 | 真实 Cordis 配置加载并完成一次调用 |
| Keyless snapshot | 用户/模型实际看到的产物 | 从 runnable example 回放固定模型流 |

上游测试政策要求“验证世界，而不是组件自述”，并优先真实入口，见 [`docs/testing.md:21-35`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/testing.md#L21-L35)。模型或产品可见的非平凡行为必须补 keyless snapshot，不能只写 mock 单测。

## 5. 工程 gate

```bash
pnpm run test
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run hygiene
pnpm run doc-sync
pnpm run test:snapshot
```

不要机械地每次跑全套；按变更面选择相关检查，CI 负责完整平台矩阵。发布路径还要运行 built-bin / NodeNext consumer smoke，证明使用 `exports → lib`，而不是测试环境偷偷解析 `src`。

## 6. 安全与失败清单

- 解析器、配置、durable/file、worker、process、wire 边界做运行时校验。
- 同进程 typed 边界信任 TypeScript，不制造无意义 defensive code。
- misconfiguration 尽早 fail loud，不静默禁用能力。
- 所有注册用 Effect，卸载后无残留。
- model-visible 新输入必须有 Session event。
- credential 只用引用，不进配置 dump、日志或 UI。
- 子进程、文件、网络调用贯穿 AbortSignal 与 timeout。

## 7. 完整复述

现在你应能用一条链重讲全站：

> CLI 选择 Profile，把 Bundle 和 Patch 组合成 Cordis 插件树；Surface 把输入送进 Agent Inbox；Loop 以 Turn/Step 驱动 Prompt、LLM 和 Tool；所有模型可见事实进入 Session Log；Persistence、Subagent、Web/TUI 都通过 Service 与事件围绕同一事实流扩展。

## 8. 毕业练习

完成一个最小 Provider + Tool：

1. 写三角色和 package 依赖方向。
2. 写配置 schema 与 fail-loud 条件。
3. 写一个成功、一个取消、一个 Provider 失败单测。
4. 用 runnable example 生成 keyless snapshot。
5. 从 `dsh --profile ... --dump-config` 证明插件已装入。

做到这一步，你已经不是“读过 DeepSeek Harness”，而是能按它的不变式安全扩展它。
