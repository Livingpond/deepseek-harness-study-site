---
title: "04. Session 事件账本"
description: "把 append-only 事件流理解为模型历史与产品状态的唯一事实源。"
---

# 04. Session 事件账本

## 0. 本章学习目标

- 解释 `SessionEventMap` 的声明合并扩展方式。
- 说明 `append()` 与 `deriveMessages()` 的职责边界。
- 从同一事件流推导模型历史、恢复和 UI。
- 识别序列号、JSON、冻结与封闭性校验。

## 1. 一句话讲明白

Session 不保存一个可任意改写的“当前对话”；它只追加带序号的事实，再把模型消息与界面状态投影出来。

## 2. 数据地图

```text
SessionHeader              会话身份、cwd、父子关系、格式版本
SessionEvent[]             seq 连续的 append-only 事实
  ├─ turn/* step/*
  ├─ user/message assistant/* tool/*
  └─ 插件声明合并的新事件
         │
         ├─ deriveMessages() → LLM history
         ├─ projection       → UI / title / stats
         └─ persistence      → JSONL / SQLite
```

[`packages/core/session/src/types.ts:236-336`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/types.ts#L236-L336) 定义内置事件，并通过 `keyof SessionEventMap` 派生事件类型。插件可用 TypeScript declaration merging 增加自己的 durable vocabulary。

## 3. 最小机制

```ts
session.append('user/message', message)
session.append('assistant/chunk', { turn, step, chunk })
const messages = session.deriveMessages()
```

`append()` 的承诺不仅是 `array.push`。它校验 JSON 可序列化、event envelope、surface metadata 与内部生命周期不变式，快照并深冻结候选，然后发布观察事件。`deriveMessages()` 位于 [`packages/core/session/src/index.ts:726-749`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/index.ts#L726-L749)。

## 4. “模型可见 ⟺ 已入账”

上游架构直接规定：发送给模型的一切必须能从日志重建，见 [`docs/architecture.md:92-96`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md#L92-L96)。因此新增隐式 Prompt 前缀却不增加 Session event，会破坏恢复一致性；`agent-loop` 的 request reconstruction invariant 会拒绝这种漂移。

这个选择带来一个强结果：Fork、Resume、Transcript、Telemetry、Persistence 不是五套同步逻辑，而是五个读同一事实流的消费者。

## 5. 为什么保留 `assistant/chunk`

最终 `assistant/message` 足以做下一次模型历史，却不足以完整回放流式 UI、推理块边界与首 token 时间。原始 chunk 作为持久事件保留；存储层可以物理打包连续 chunk，但不能改变逻辑日志。

## 6. 失败路径与防数据丢失

- 非连续 `seq` 的 seed 被拒绝。
- 非 JSON 值、稀疏数组、异常 prototype 被拒绝。
- 传入对象在 append 后被修改，不影响已冻结快照。
- observer 在 commit 后抛错只记录告警，不能隐藏已落账事实。
- 未知扩展事件若没有 `ignorable: true`，旧构建拒绝读取，避免错误解释数据。

这些路径由 [`packages/core/session/tests/session.spec.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/tests/session.spec.ts#L437-L550) 的变异隔离、序列化和 seed 校验覆盖。

## 7. 可迁移方法

- **事实与视图分离。** 验证：删除缓存后能否仅靠日志重建同一模型请求？
- **扩展 durable union 时建立兼容规则。** 验证：旧消费者遇到新事件是拒绝还是可证明地忽略？
- **提交点以后隔离观察者失败。** 验证：遥测插件报错是否会让已写入事实“消失”？

## 8. 练习与下一问

设计一个 `review/decision` 插件事件：写出 payload、是否 model-visible、旧版本能否忽略，并说明它怎样投影成 UI。

下一章追问：**日志历史与当前配置准备好后，系统怎样选择模型适配器并把多种 Provider 的流归一成统一协议？**
