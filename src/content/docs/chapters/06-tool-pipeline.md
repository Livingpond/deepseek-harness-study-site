---
title: "06. 工具执行管线"
description: "从 ToolDefinition 到 pre/around/post waterfalls 与持久结果。"
---

# 06. 工具执行管线

## 0. 本章学习目标

- 读懂 `ToolDefinition` 的 schema、execute 与 presentation。
- 追踪 pre-execute、execute、post-execute 三段 Waterfall。
- 说明审批、超时、重试为何不写进每个工具。
- 理解并发安全与 Code Mode 子调用。

## 1. 一句话讲明白

工具不是模型直接调用的函数；它先被解析与校验，再经过策略决策、around wrapper、实现执行和结果归一，最后才记入 Session。

## 2. 管线地图

```text
model tool call
   ▼
lookup + JSON/schema validation
   ▼
tools/pre-execute ── deny / ask / allow
   ▼
tools/execute (around) ── timeout / retry / metrics
   ▼
ToolDefinition.execute
   ▼
tools/post-execute ── accept / replace / enrich
   ▼
ToolExecutionResult → tool/result event
```

事件约定直接写在 [`packages/core/tools/src/index.ts:140-189`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/tools/src/index.ts#L140-L189)。

## 3. 工具定义的三个面

[`ToolDefinition`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/tools/src/index.ts#L212-L235) 同时包含：

- **模型面**：名字、描述、参数 schema。
- **执行面**：`execute(args, exec)`，接收 signal 与调用 Agent。
- **呈现面**：output schema、render intent、位置等 UI 信息。

上游明确把工具 UI render intent 当作工具设计的一部分。这样 generic、terminal、diff 卡片不需要 UI 猜测工具名或解析随意文本。

## 4. 真实执行入口

`ToolRuntime.execute()` 位于 [`packages/core/tools/src/index.ts:1342-1425`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/tools/src/index.ts#L1342-L1425)。它创建不可伪造的 execution token，融合取消信号，按 scheduler 约束并发，再让 pre/around/post 三阶段产出冻结结果。

工具实现只负责本领域动作；审批插件监听 `tools/pre-execute`，超时插件包裹 `tools/execute`，展示插件读取纯 presentation。共同策略因此只写一次。

## 5. Code Mode 为什么更复杂

在 Code Mode 中，模型只能直接调用 `run_code`，代码里的 SDK 再分派其他工具。嵌套调用携带 parent token 和 subcall identity，`tools/code-dispatch-log` 先整形可见结果，再记录 `tool/code-dispatch`。这保证子调用仍可审计，又不会伪装成模型直接调用。

## 6. 决策与失败

| 阶段 | 失败示例 | 结果 |
| --- | --- | --- |
| lookup | 工具不存在 | `ToolNotFoundError` |
| 参数 | JSON/schema 不合格 | 结构化 failure，不执行工具 |
| pre | 策略 deny | 物化拒绝结果 |
| around | timeout/cancel | 保留稳定 error code |
| body | 实现抛错 | 捕获并归一 ToolFailure |
| presentation | renderer 抛错 | `ToolOutputError`，不伪造成功 |

并发不是默认越多越好。`isConcurrencySafe` 由工具声明；不安全工具恢复串行，安全工具才进入有界并发调度。

## 7. 可迁移方法

- **执行核心与横切策略分层。** 验证：新增审批规则是否改动了 Bash/File/Web 工具？
- **展示契约在生产者侧定义。** 验证：UI 能否不按工具名写巨大 switch？
- **嵌套执行保留父子身份。** 验证：审计日志能否区分模型调用与 SDK 子调用？

## 8. 实战

设计 `weather` 工具：参数 schema、输出 schema、取消、错误码、generic render intent，并指出审批应挂在哪个 Waterfall。下一章回答：**工具 schema、Persona、Workspace 指令和动态上下文怎样共同进入一次模型请求？**
