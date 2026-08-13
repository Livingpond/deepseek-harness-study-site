---
title: "03. Agent 主循环"
description: "沿 ReactLoopAgent 读懂 Turn、Step、Inbox、续步与停止。"
---

# 03. Agent 主循环

## 0. 本章学习目标

- 准确定义 Turn 与 Step。
- 从 Inbox 追到 LLM stream 和 Tool execution。
- 解释为何一个 Turn 可以零 Step 或多 Step。
- 列出完成、取消、错误、token 上限等停止路径。

## 1. 一句话讲明白

`ReactLoopAgent` 每次从 Inbox 认领输入开启 Turn；每个 Step 组装一次请求、消费一次模型流并执行工具，直到没有后续工作才关闭 Turn。

## 2. 整体时序

```text
inbox ─► turn/start
          ├─ claim input
          ├─ agent/pre-step
          ├─ step/start
          │   ├─ request/header + context
          │   ├─ llm.stream
          │   ├─ assistant/chunk*
          │   └─ tool call/result*
          ├─ step/end ── 仍欠工作？──► next step
          └─ agent/turn-stopping ─► turn/end
```

这条时序由 [`docs/architecture.md:63-88`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md#L63-L88) 明确定义；不是教学臆造。

## 3. 三层职责

`@deepseek-ai/dsh-agent` 定义接口、live registry 与事件；`@deepseek-ai/dsh-agent-loop` 提供默认 driver；具体 Surface 只操作 `AgentHandle`。这使 UI、SDK、ACP 不必依赖 `ReactLoopAgent` 实现。注册表缺少 factory 时会报 `no agent factory registered`，见 [`packages/core/agent/src/index.ts:217-256`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent/src/index.ts#L217-L256)。

## 4. 真实执行路径

`ReactLoopAgent.run()` 持续调用 `turn()`，直到返回 false；异常统一发出 `agent/error`。主循环位于 [`packages/core/agent-loop/src/agent.ts:206-212`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L206-L212)。

`turn()` 的关键动作在 [`agent.ts:246-319`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L246-L319)：

1. 通过 Waterfall 决定是否进入本轮。
2. 记录 `turn/start`。
3. 组装 Prompt/Tools，认领消息，记录 `step/start`。
4. 运行 `step()`，记录 `step/end`。
5. 工具或新输入仍要求一次模型请求时继续。
6. 串行运行 `agent/turn-stopping` 后写 `turn/end`。

`step()` 从 `systemPrompt`、`session.deriveMessages()` 和冻结的 request header 构造请求，然后迭代流，见 [`agent.ts:332-381`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L332-L381)。

## 5. 为什么 Turn 可以没有 Step

`agent/pre-step` 可以拒绝输入，或把第一次 claim 改写为空。系统仍写入 `turn/start` 与 `turn/end`，因为“曾尝试处理”本身是持久事实。这样观察者不会把“没有收到输入”和“输入被策略拒绝”混为一谈。

## 6. 停止与失败

| 路径 | 日志结果 |
| --- | --- |
| 模型正常 stop 且无工具续步 | `turn/end: completed` |
| 达到输出 token 上限 | 记录 max-token 相关 reason |
| 用户取消 / shutdown / interrupt | 记录带 cause 的 cancelled reason |
| LLM 或插件异常 | `agent/error`，Turn 以错误原因封闭 |
| Tool 要求继续 | 当前 `step/end` 后进入下一 Step |

关键不变式是 Turn/Step 必须成对封闭。上游测试直接拒绝未封闭的 step-scoped 事件，见 [`packages/core/session/tests/invariant.spec.ts:210`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/tests/invariant.spec.ts#L210)。

## 7. 可迁移方法与练习

- **把“用户轮次”和“模型调用”分开建模。** 工具循环需要多 Step。
- **先落账边界，再执行不可控外部调用。** 崩溃后能判断停在哪。
- **停止原因使用判别联合，不用字符串 message 猜。**

画出“用户要求读文件后修改”的 Turn，标出至少两次 Step。下一章回答：**为什么所有状态都围绕 Session Event Log，而不是直接保存最终消息数组？**
