---
title: "05. LLM 流式适配"
description: "从 prepareCall 到 DeepSeek SSE，理解选择、冻结、归一和失败。"
---

# 05. LLM 流式适配

## 0. 本章学习目标

- 区分 LLM Service Definition 与 Provider Adapter。
- 追踪 `prepareCall()`、request header、`stream()`。
- 解释为什么 Adapter 输出统一 `StreamChunk`。
- 识别 transport、protocol、idle timeout 与 cancellation。

## 1. 一句话讲明白

`LlmRuntime` 先把模型选择解析并冻结为一次性 Prepared Call，再由具体 Adapter 把 Provider 流翻译成统一 `StreamChunk`。

## 2. 能力 seam

```text
Consumer: agent-loop
   │ GenerateOptions
   ▼
Definition: @deepseek-ai/dsh-llm (ctx.llm)
   │ route + prepare + waterfall
   ├─ Provider: llm-deepseek
   └─ Provider: llm-pi-ai
          │
          ▼
统一 StreamChunk → Session assistant/chunk
```

这符合上游对 seam 的三角色定义：Service Definition / Provider / Consumer，见 [`docs/architecture.md:98-102`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md#L98-L102)。

## 3. 为什么先 `prepareCall()`

`prepareCall()` 在网络调用前完成 provider/model 解析并返回一次性 handle，见 [`packages/llm/llm/src/index.ts:779-815`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm/src/index.ts#L779-L815)。Agent Loop 可先把最终 header 写入 Session，再 dispatch 同一配置。若 prepare 后配置被改写或 handle 被用两次，运行时明确拒绝。

这解决了一个细微竞态：动态设置或凭据在“记录请求”和“真正发送”之间变化时，日志不能声称发送了 A，网络却发送 B。

## 4. DeepSeek Adapter 的真实路径

[`packages/llm/llm-deepseek/src/adapter.ts:214-260`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-deepseek/src/adapter.ts#L214-L260) 展示了关键步骤：

1. 每个 stream 调用只解析一次连接配置与凭据。
2. 建立 caller signal 与 idle watchdog。
3. 发送总是 streaming 且包含 usage 的请求。
4. 持续读取 SSE 并翻译 chunk。
5. consumer 提前停止时主动 abort 上游。

序列化器固定 `stream: true` 与 `stream_options.include_usage: true`，见 [`serialize.ts:144-177`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-deepseek/src/serialize.ts#L144-L177)。

## 5. 错误不是一个字符串

| 故障 | 归一结果 |
| --- | --- |
| HTTP 非 2xx | Provider/HTTP code + request id |
| SSE JSON 损坏 | `MALFORMED_RESPONSE` |
| 没有 `[DONE]` 就断流 | `STREAM_CLOSED` |
| 长时间无新数据 | `LLM_STREAM_IDLE_TIMEOUT` |
| 调用者取消 | aborted，不伪装 transport failure |
| 下游停止消费 | abort provider stream，释放连接 |

SSE 终止约束见 [`packages/llm/llm-deepseek/src/translate.ts:80-184`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-deepseek/src/translate.ts#L80-L184)。

## 6. 设计解读

统一 chunk 协议让 Agent Loop、日志和 UI 不依赖某家 SDK；但 Provider 的 replay metadata、reasoning、usage 仍需显式映射，不能为了“统一”丢失语义。Prepared Call 则把动态配置的时间边界变成可验证对象。

## 7. 可迁移方法与练习

- **动态配置在操作开始时快照。** 验证：流进行中改 API Key 会不会污染当前连接？
- **协议结束必须显式。** 验证：TCP 正常 EOF 是否会被误当模型正常完成？
- **取消要贯穿生产者与消费者。** 验证：UI Stop 后 Provider socket 是否真正关闭？

练习：为一个 OpenAI-compatible Provider 写出 Adapter 的输入、统一输出、错误映射和四个最小测试。下一章把模型产出的 tool call 送进受保护执行管线。
