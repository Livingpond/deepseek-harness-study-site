---
title: "07. Prompt 与上下文"
description: "理解 Prompt section、工具 schema、agent/pre-step 与 request/context。"
---

# 07. Prompt 与上下文

## 0. 本章学习目标

- 区分 System Prompt、消息历史和一次性注入上下文。
- 解释 Prompt section 的排序、作用域与卸载。
- 追踪工具 schema 如何加入请求。
- 证明模型可见上下文怎样回写 Session。

## 1. 一句话讲明白

`SystemPrompt` 每个 Step 重新收集当前作用域的有序 section 与工具 schema，而一次性上下文在进入模型前写成 `request/context`，保持请求可重建。

## 2. 请求由三块组成

```text
system = persona + runtime + workspace instructions + plugin sections
messages = session.deriveMessages() + 当前已认领输入
tools = 当前 Agent scope 可见的 ToolDefinition schemas
```

`SystemPrompt.assemble()` 位于 [`packages/core/system-prompt/src/index.ts:467-535`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/system-prompt/src/index.ts#L467-L535)，每次返回冻结的 `PromptAssembly`。Agent Loop 不缓存跨 Step 的最终 Prompt，避免 HMR、设置或作用域变化后继续发旧能力列表。

## 3. Section 是协作接口

插件调用 `ctx.systemPrompt.section({ name, order, text })` 注册自己的片段，并由 effect disposer 撤销。启动后 CLI 还会添加 Harness 源码位置 section，且明确区分源码 checkout、task workspace 与 cwd，见 [`packages/boot/app-boot/src/index.ts:804-829`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/boot/app-boot/src/index.ts#L804-L829)。

这比各插件拼接一个全局字符串更安全：名字防重复、order 决定顺序、scope 决定可见性、disposer 决定生命周期。

## 4. `agent/pre-step` 与 `request/context`

Inbox 中有两类东西：能唤醒 Agent 的消息，以及等待下一次已唤醒 Step 的 injected context。`agent/pre-step` 可以接受、改写或拒绝 claim。真正进入请求的上下文必须在开放 Step 内写入 `request/context`；[`agent.ts:482`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L482) 执行这一步。

于是恢复时不需要重新运行当时的 Workspace 扫描或时间插件；日志已记录模型实际看到的快照。

## 5. 工具顺序也是请求事实

Prompt assembler 对 Tool schemas 形成确定性顺序，支持显式 `toolOrder` 与 rest 占位符。Agent Loop 将最终 provider/model/tool headers 写入 `request/header`。测试证明无论注册顺序如何，header 和 dispatched request 使用同一 canonical order，见 [`packages/core/agent-loop/tests/tool-order.spec.ts:67-96`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/tests/tool-order.spec.ts#L67-L96)。

## 6. 失败路径

- 重名 section 或不合法工具顺序在装配阶段失败。
- `toolOrder` 引用未注册工具时，首 Step 不发送请求，Turn 仍被封闭。
- `agent/pre-step` 短路或改写为空时，产生零 Step Turn。
- 请求内容和日志推导不一致时，request reconstruction invariant 拒绝发送。

## 7. 可迁移方法

- **Prompt 用具名片段组合，不共享可变字符串。**
- **动态上下文按“实际发送值”落账，不只保存生成规则。**
- **工具列表排序确定化。** 同一日志与配置应生成字节稳定的请求头。

## 8. 练习与下一问

实现一个“当前部署环境”上下文插件的设计草图：何时扫描、何时注入、写哪个事件、如何避免把 secret 放进 Prompt。下一章继续：**Session 日志怎样在崩溃、重启和不同存储后端下保持一致？**
