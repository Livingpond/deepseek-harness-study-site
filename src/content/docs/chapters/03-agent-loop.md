---
title: "03. Agent 主循环"
description: "沿一次读文件再总结的请求，拆开 Inbox、Turn、Step、模型流、工具调度与停止边界。"
---

# 03. Agent 主循环

> 本章源码基线：[`deepseek-ai/deepseek-harness@47f9438`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)。行为以固定提交源码为准；推断和简化会明确标注。

## 0. 本章学习目标

完成本章后，你应该能够：

- 用自己的话准确区分 Agent、Turn、Step 和一次 LLM request。
- 画出 `followup()` 从 Inbox 到 `turn/end` 的真实控制流。
- 解释“读文件后总结”为何通常是一 Turn、两 Step，而不是两 Turn。
- 追踪 request header、stream chunk、assistant message、tool call/result 的状态变化。
- 说清 completed、max-tokens、blocked、aborted、error 五类停止路径。
- 解释 Tool 并发执行与“结果按模型顺序入账”如何同时成立。

## 1. 一句话讲明白

**`ReactLoopAgent` 把唤醒输入包进一个 Turn；每个 Step 只做一次模型请求，并执行这次响应提出的工具，工具结果或 steer 输入再进入下一个 Step，直到没有续步工作才关闭 Turn。**

上一章回答了“能力怎样安全装进作用域”，但插件树只是静止结构。

本章用一个贯穿场景让它动起来：

> 用户输入：“读取当前项目的 `package.json`，告诉我有哪些 scripts，并用一句话总结项目用途。”

假设模型第一步调用 `read_file`，工具返回文件内容，模型第二步才给出最终文本。

中央问题是：**一条用户消息怎样变成一个可续步、可取消、可回放并且边界成对封闭的 Agent Turn？**

## 2. 最直觉的循环为什么撑不住生产场景

最直觉的 Agent 代码通常只有：

```ts
while (true) {
  const response = await llm.generate(messages)
  if (!response.toolCalls.length) return response.text
  messages.push(await runTools(response.toolCalls))
}
```

它表达了工具循环的“形”，却缺少生产系统真正需要的事实：

- 用户在模型运行中又发一条 steer，应进入当前工作还是下个 Turn？
- 取消发生在 stream、工具执行或停止钩子时，怎样留下完整结束原因？
- 一次响应里多个工具可并发，但结果必须按模型声明顺序回放，如何保证？
- 模型流失败后重试，是新 Step 还是同一 Step？
- 进程崩溃后，怎样知道 Turn/Step 开到了哪里？
- Prompt、Tools、Provider 默认值变化后，恢复时怎样重建真实请求？

Harness 的主循环因此不是一个裸 `while`，而是一台围绕 Session 日志、Inbox 和显式 phase 运行的状态机。

## 3. 先看全局地图

```text
Surface / API
   │ agent.followup(userMessage)
   ▼
Inbox.nextTurn ── durable splice ──► wakeDriver()
   │                                  │
   │ claim                            ▼
   └──────────────────────────── ReactLoopAgent
                                      │
                         turn/start ──┤
                                      ▼
                         preStep + prompt/tools
                                      │
                         step/start ──┤
                                      ▼
                    buildRequest → LLM stream
                                      │
                    assistant message / tool calls
                                      │
                        executeToolCalls()
                                      │ result context
                         Inbox.nextStep
                                      │
                         step/end ─────┘ next Step
                                      │ no more work
                         turn/end ─────┘
```

读图结论：**Inbox 决定工作在哪个边界被认领，Session 记录边界与事实，Agent Loop 只驱动状态前进。**

### 3.1 三个包的职责不要混

| 层 | 真实职责 | 本场景对象 |
| --- | --- | --- |
| `dsh-agent` | Agent 接口、Inbox、Registry、作用域事件 | `followup()`、`Inbox.nextTurn` |
| `dsh-agent-loop` | 默认 Turn/Step driver、请求构造、工具调度 | `ReactLoopAgent` |
| `dsh-session` | append-only 事件与模型历史投影 | `turn/start`、`tool/result` |

表后结论：**Surface 面向 Agent 接口，不需要知道默认 driver 的私有 `turn()` 或 `step()`。**

## 4. 最小内核：先剥离 Harness 产品层

```ts
// 教学伪代码：保留 Turn/Step 的真实嵌套关系
async function runTurn(input) {
  append('turn/start')
  let boundaryInput = [input]
  let keepStepping = true
  let reason
  try {
    while (keepStepping) {
      append('step/start')
      try {
        appendMessages(boundaryInput)
        const reply = await callModel(deriveMessages())
        appendAssistant(reply)
        const tools = await runToolsAndAppendResults(reply.toolCalls)
        boundaryInput = tools.additionalContexts
        keepStepping = reply.toolCalls.length > 0 && !tools.concluded
        reason = keepStepping ? null : 'completed'
      } finally {
        append('step/end')
      }
    }
  } catch (error) {
    reason = classify(error)
  } finally {
    append('turn/end', reason)
  }
}
```

数据变化顺序：

```text
pending user input
 → durable user/message
 → derived request history
 → streamed assistant/chunk*
 → assembled assistant/message
 → tool/call + tool/result*
 → next-step user-role contexts
 → final assistant/message
```

为什么每层都先写边界？外部模型、工具和插件都可能失败；先写 `turn/start` / `step/start`，再用 finally 写结束，恢复者才知道执行停在哪个 bracket。

### 4.1 通用内核与 Harness 产品叠加

| 通用 Agent 机制 | Harness 叠加层 |
| --- | --- |
| 用户输入排队 | 两个 durable Inbox 列表与 splice 事件 |
| 模型—工具循环 | Cordis Waterfall、System Prompt、Tool registry |
| 中断信号 | 带 `AgentCancelCause` 的 AbortController |
| 对话历史 | Session Surface、request header/context |
| 工具调度 | live execution mode、并发池、ordered commit |
| 可观察性 | agent scope 事件、chunk、usage、错误事实 |

表后结论：**Loop 的内核很小，复杂度来自并发输入、恢复一致性和产品扩展缝。**

## 5. 读源码前先分清 Turn、Step、Request

### 5.1 Turn：一次被唤醒的工作区间

Turn 从 `turn/start` 到 `turn/end`。

它通常对应一次用户发起的任务，但不是“消息数组中的一对 user/assistant”。一个 Turn 可以：

- 没有 Step：输入被拒绝、清空或启动后立即取消。
- 有一个 Step：模型直接回答。
- 有多个 Step：模型调用工具，再基于结果继续。

### 5.2 Step：一个模型调用加它请求的工具执行

Step 从 `step/start` 到 `step/end`。

本章场景：

```text
Turn 1
  Step 1: 用户请求 → 模型提出 read_file → 工具返回 package.json
  Step 2: 工具结果 → 模型生成 scripts 与项目总结 → completed
```

读图结论：**工具调用不会自动开启新 Turn；它通常要求当前 Turn 再走一个 Step。**

### 5.3 Request：Step 内可能重试的模型请求

一个 Step 通常对应一次成功的 LLM request，但流失败并被 `agent/request-error` 策略判为 retry 时，会在同一个 Step 的内层 `while (true)` 再请求。

因此严格关系是：

```text
1 Turn → 0..N Steps
1 Step → 1..N request attempts（若发生可恢复重试）
```

这纠正了一个常见误读：**Step 编号不是模型 HTTP 调用次数。**

## 6. Agent 的 phase 状态机

`ReactLoopAgent` 使用判别联合保存 phase：

```text
idle(lastTurn)
  ├─ wake ─► running(abort, turn, step, wakeRequested)
  └─ job  ─► maintenance(abort, lastTurn, wakeRequested)

running / maintenance
  └─ converge ─► idle
```

读图结论：**对外 `status` 只有 idle/running，但内部 maintenance 与 running 分开，避免维护任务和模型 Turn 并发占用同一 Agent。**

真实 `Phase` 类型见 [`packages/core/agent-loop/src/agent.ts#L38-L47`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L38-L47)。

构造函数还会：

- 创建带 durable projection 的 Inbox。
- 从已有日志恢复最后 Turn 编号。
- 创建 Agent Scope 与 `ctx.extend({ agent: this })`。
- 建立运行时 Context 投影。

这些动作见 [`agent.ts#L63-L97`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L63-L97)。

## 7. Inbox：followup、steer、inject 的真实区别

### 7.1 两个队列

`Inbox` 私有状态只有：

```ts
{
  'next-turn': UserMessage[],
  'next-step': UserMessage[],
}
```

源码定义与恢复逻辑见 [`packages/core/agent/src/inbox.ts#L24-L39`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent/src/inbox.ts#L24-L39)。

### 7.2 三个 API 的目标边界

| API | 目标 | 是否唤醒 | 典型用途 |
| --- | --- | --- | --- |
| `followup()` | `next-turn` | 是 | 新任务 |
| `steer()` | `next-step` | 是 | 用户打断并补充当前工作 |
| `inject()` | `next-step` | 否 | 插件加入上下文，不单独启动任务 |

真实方法见 [`packages/core/agent-loop/src/agent.ts#L113-L132`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L113-L132)。

表后结论：**目标队列决定消息进入哪个执行边界，wakeup 决定它是否有权启动 driver。**

### 7.3 Inbox 变更为什么也要入账

`splice()` 先规范化索引和删除数，构造 `agent/inbox/spliced`，验证消息 ID 唯一，再 append，最后才修改内存数组，见 [`packages/core/agent/src/inbox.ts#L157-L192`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent/src/inbox.ts#L157-L192)。

本场景的第一条事件不是 `user/message`，而可能先是：

```ts
{
  type: 'agent/inbox/spliced',
  data: {
    target: 'next-turn',
    start: 0,
    inserted: [message]
  }
}
```

当 Turn claim 这条消息时，又会用 removedCount 记录队列减少。

为什么？只看 `user/message` 无法判断“输入还在等”“已被认领”还是“取消时未执行就被丢弃”。

## 8. 真实源码旅程：读取 `package.json` 后总结

### 8.1 第一步：`followup()` 插入并唤醒

输入是一条有 ID、source 和 content 的 `UserMessage`。

`followup()` 调用 `send(input, 'next-turn', true)`；`send()` 先插入 Inbox，再调用 `wakeDriver()`。

若 Agent 当前 idle，`wakeDriver()` 会：

- 创建新 `AbortController`。
- 把 phase 改为 running。
- 通过 Agent Registry 的 initiator context 调用 `kick()`。

关键代码见 [`agent.ts#L164-L193`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L164-L193)。

状态变化：`idle(lastTurn=0)` → `running(turn=0, step=0)`。

### 8.2 第二步：`kick()` 驱动一个或多个 Turn

`kick()` 的内核是：

```ts
while (await this.turn()) {}
```

异常在 driver 边界被包含；finally 把 phase 收敛回 idle，并在需要时重放 latch wake，见 [`agent.ts#L202-L222`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L202-L222)。

`turn()` 返回 true 的条件不是“模型说 continue”，而是当前 Turn 封闭后 Inbox 仍有 pending 工作。

### 8.3 第三步：Turn 在 claim 输入前先打开

`turn()` 先计算 `turn = phase.turn + 1`，再 append `turn/start`，见 [`agent.ts#L245-L260`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L245-L260)。

为什么先开 Turn 再 claim？“尝试处理但被取消/拒绝”也是一个需要记账的工作区间。

本场景现在是：

```text
phase.turn = 1
session += turn/start { turn: 1 }
Inbox.nextTurn 仍待 claim
```

### 8.4 第四步：`preStep()` 认领输入并装配 Prompt

`preStep('next-turn', { turn: 1, step: 1 })`：

1. 从 Inbox claim 消息。
2. 用 Agent + signal 组装 System Prompt 与 Tools。
3. 渲染 runtime context。
4. 经过 `agent/pre-step` Waterfall。
5. 得到 `enter` 或 `reject` 决策。

真实路径见 [`agent.ts#L225-L243`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L225-L243)。

输入从 pending message 变成“本 Step 要 append 的 messages + 冻结的 PromptAssembly”。

### 8.5 第五步：Step 1 打开并写入用户消息

决策为 enter 后，Loop append：

```text
step/start { turn: 1, step: 1 }
user/message { ...读取 package.json... }
```

对应代码在 [`agent.ts#L263-L293`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L263-L293)。

用户消息带 `surfaceOp: 'append'`，因此会进入下一次请求的模型历史；`step/start` 只用于执行边界，不进入模型消息。

### 8.6 第六步：`buildRequest()` 固化可重建请求

`step()` 先渲染 system，再调用：

```ts
buildRequest(turn, step, tools, system, session.deriveMessages(), signal)
```

`buildRequest()` 做四件关键事：

1. 从 AgentOptions 或已有 header 形成 seed config。
2. 经过 `agent/request` Waterfall，让插件包装或替换配置。
3. 让 LLM Runtime `prepareCall()` 解析精确 Adapter 默认值。
4. append `request/header` / `request/context`，再冻结最终 request。

Provider/model 缺失会直接报错，header 记录逻辑见 [`agent.ts#L417-L470`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L417-L470)，最终 request 构造见 [`agent.ts#L472-L494`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L472-L494)。

状态变化：模型历史、system、tools、route 从多个 live registry 汇合为一个 deep-frozen request。

### 8.7 第七步：消费流并组装 Assistant Message

Loop 迭代 Adapter stream：

```text
assistant/chunk(text/reasoning/tool-call delta)*
             │
             ▼ BlockAssembler
assistant/message(content blocks + usage)
```

每个 chunk 先 append，再推给 `BlockAssembler`；流结束后才创建完整 `assistant/message`，并用 `sourceEventSeqs` 关联 chunk，见 [`agent.ts#L339-L390`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L339-L390)。

本场景第一条 Assistant Message 包含：

```ts
{
  type: 'tool-call',
  id: 'call-1',
  name: 'read_file',
  arguments: '{"path":"package.json"}'
}
```

### 8.8 第八步：模型有工具调用，进入调度器

`step()` 过滤出 `tool-call` blocks；没有工具时返回 completed，有工具时调用 `executeToolCalls()`，见 [`agent.ts#L391-L400`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L391-L400)。

工具参数会尝试 JSON.parse；非法 JSON 不会在这里丢失，而是保留为原字符串交给工具层处理，见 [`packages/core/agent-loop/src/tool-calls.ts#L103-L110`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/tool-calls.ts#L103-L110)。

### 8.9 第九步：工具结果按模型顺序入账

Tool 调度器可让 parallel 工具 body 重叠，但它维护 `slots[]` 和 `committed` 游标；只有连续就绪的槽位才 finalize 并 append result，见 [`tool-calls.ts#L121-L159`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/tool-calls.ts#L121-L159)。

```text
模型顺序: call A, call B, call C
完成顺序:       B, C, A
入账顺序: A → B → C
```

读图结论：**并发优化发生在执行阶段，Session 与下一次模型上下文仍保持模型声明顺序。**

本场景只有 `read_file`：

```text
tool/call   { callId: call-1, name: read_file, arguments: ... }
tool/result { message: package.json content, sourceEventSeqs: [callSeq] }
```

append 细节见 [`tool-calls.ts#L261-L289`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/tool-calls.ts#L261-L289)。

### 8.10 第十步：Tool result 已在 Surface，附加上下文才进 Inbox

工具结果本身由调度器直接 append 为 `tool/result`，已经进入 Session Surface；acceptor 只把工具返回的 `additionalContexts` 插入 `Inbox.nextStep`，见 [`tool-calls.ts#L145-L158`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/tool-calls.ts#L145-L158)。

本场景假设 `read_file` 没有额外上下文，所以 `Inbox.nextStep` 可以为空。只要工具没有 `concludesTurn`，`step()` 仍返回 `null`，表示当前响应没有结束整个 Turn；外层 finally 写 `step/end {1,1}`。

此时：

```text
Turn 1 open
Step 1 closed
Session Surface includes tool/result
Inbox.nextStep = []
turnEnds = null
```

### 8.11 第十一步：Step 2 读取工具结果

Turn 循环把 target 改成 `next-step`，再次 `preStep()`。

它会 claim 可能存在的 `additionalContexts`；即使本场景 claim 结果为空，因为 `turnEnds` 仍是 `null`，Loop 也会打开下一 Step。这里不会重复 append `tool/result`，那条 Surface Event 已在 Step 1 内写入。

Loop append：

```text
step/start { turn: 1, step: 2 }
```

然后 `deriveMessages()` 重建完整历史：用户请求、Assistant tool-call、tool result。

模型这次返回最终文字，不再包含 tool-call。

### 8.12 第十二步：停止钩子与 Turn 封闭

`step()` 返回 `{ kind: 'completed' }`。

外层写 `step/end {1,2}`；若 `nextStep` 已空，会串行运行 `agent/turn-stopping`，插件仍可在这里追加最后工作。确认仍为空后，循环退出并在 finally 写 `turn/end`，见 [`agent.ts#L294-L323`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L294-L323)。

最终状态：

```text
turn/end { turn: 1, reason: { kind: 'completed' } }
phase: running → idle(lastTurn=1)
Inbox: empty
```

## 9. 容易误读的源码细节

### 9.1 一个 Turn 可以零 Step

字段名 `turn/start` 容易让人以为模型一定已经开始运行。

实际条件：Turn 在 preStep 前打开；若 waking message 被清空，或 enter 决策改写为空，首 Step 不会发生，Loop 仍以 completed 封闭 Turn，见 [`agent.ts#L263-L277`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L263-L277)。

### 9.2 `status === idle` 也可能处于 maintenance

getter 把 idle 与 maintenance 都映射为外部 `'idle'`，见 [`agent.ts#L99-L101`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L99-L101)。

因此调用 `runMaintenance()` 仍会拒绝第二个活动；不要只用公开 status 判断能否并发占用内部 driver。

### 9.3 max-tokens 不等于“丢弃已生成内容”

Assembler 仍形成 Assistant Message 并记录 usage；随后 Step 返回 max-tokens。若后续又有 Step 正常完成，Turn 的 max-tokens 结果仍保持 sticky，不被降级成 completed，逻辑见 [`agent.ts#L285-L290`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L285-L290)。

## 10. 停止条件与失败路径

### 10.1 正常完成

条件：Assistant Message 没有 tool-call，或工具明确 `concludesTurn`，且 `nextStep` 最终为空。

结果：`turn/end.reason.kind = 'completed'`。

### 10.2 达到最大输出 token

条件：Assembler finish 为 `max-tokens`。

结果：Step 返回 max-tokens，Turn 记住这个 sticky reason；代码入口见 [`agent.ts#L373-L394`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L373-L394)。

### 10.3 Pre-step 阻断

条件：`agent/pre-step` Waterfall 返回 `{ kind: 'reject' }`。

结果：Turn 以 blocked 结束，不进入模型 Step，见 [`agent.ts#L266-L270`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L266-L270)。

### 10.4 用户取消或 dispose

`cancel()` 默认清空 Inbox 和 wake latch，并 abort 当前 controller；`keepInbox` 可以保留尚未 claim 的输入，见 [`agent.ts#L134-L140`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L134-L140)。

Turn catch 发现 signal aborted 后，把原因记为：

```ts
{ kind: 'aborted', reason: signal.reason }
```

### 10.5 LLM stream 失败与重试

当 finish 为 error / aborted，Loop 调用 `agent/request-error` Waterfall。

只有返回 `{ kind: 'retry' }` 才在同一 Step 重试；否则抛 `LlmError`，见 [`agent.ts#L347-L370`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L347-L370)。

测试证明两次 RATE_LIMIT / unavailable 后成功，仍只有一个 Turn、一个 Step 位置，见 [`packages/core/agent-loop/tests/request-error.spec.ts#L50-L99`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/tests/request-error.spec.ts#L50-L99)。

### 10.6 普通异常

非 Abort、非结构化 LLM 错误会被 `errorChain()` 压成 `{ code: 'UNKNOWN', message }`，Turn 以 error 封闭，并发 `agent/error`，见 [`agent.ts#L302-L315`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L302-L315)。

## 11. Tool 调度的两个生产边界

### 11.1 Exclusive call 是屏障

调度器每次启动前重新查询工具的 live execution mode；parallel group 中遇到后来被重新分类为 exclusive 的调用，会先排空当前池，再让它成为下一组屏障，见 [`tool-calls.ts#L198-L213`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/tool-calls.ts#L198-L213)。

这不是只在计划开始时读一次 mode，避免运行中注册表变化破坏互斥承诺。

### 11.2 Abort 也必须补齐可回放结果

取消后：

- 已启动调用先 drain 并提交结果。
- 未启动调用写合成 error result：`tool call aborted before dispatch`。
- 不再补充新的实际 dispatch。

相关逻辑见 [`tool-calls.ts#L237-L258`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/tool-calls.ts#L237-L258)。

为什么要合成结果？Assistant Message 已经包含 tool-call；若历史没有配对结果，很多 Provider 会拒绝后续 transcript。

## 12. DeepSeek Harness 的设计取舍

### 12.1 两个 Inbox，而不是一个带优先级的队列

优点：边界语义直接体现在类型 `next-turn | next-step`，claim 时无需重新推断优先级。

代价：跨队列唯一 ID、取消与 wake latch 的状态组合更复杂。

### 12.2 事件先入 Session，再做外部调用

优点：崩溃后知道 open Turn/Step、已输出 chunk 与已启动 Tool。

代价：日志事件多，持久层需要 chunk packing 等优化；下一章会展开。

### 12.3 工具 body 并发、提交顺序稳定

优点：保留并行吞吐，同时让 replay 与 Provider transcript 确定。

代价：需要 slots、rolling pool、barrier 和 drain 逻辑，不能简单 `Promise.all()`。

### 12.4 Request Header 记录变化，而非只存最终消息

优点：恢复者能知道某次请求用了哪个 system、tools、provider/model 和 Adapter 默认值。

代价：Loop 必须做 canonical equality 与增量 fold。

## 13. Java 类比与边界

| Harness | Java 桥梁 |
| --- | --- |
| `Phase` 判别联合 | sealed state hierarchy |
| Turn | 一次业务 transaction / job interval |
| Step | 状态机中的外部调用状态 |
| Inbox | 两个持久命令队列 |
| AbortSignal | 结构化 cancellation token，不是线程中断本身 |
| `whenIdle()` | 等待当前 activity generation 收敛的 barrier |

类比停止处：

- Turn 的日志边界不是数据库 ACID transaction；Session append 与持久化 flush 分离。
- `AbortSignal` 是协作式取消；工具或 Adapter 必须观察 signal，不能假设立刻终止底层系统调用。
- Step 不是固定工作流节点；插件可以改 Prompt、请求、工具结果并加入 next-step context。

## 14. 源码事实、设计解读与教学推演

### 14.1 源码事实

- `followup`、`steer`、`inject` 映射到两个 Inbox 目标和不同 wakeup 值。
- Turn 在 preStep 前写 start，Step 在模型调用前写 start。
- Step 的 finally 始终尝试写 `step/end`，Turn 的 finally 始终写 `turn/end`。
- 流失败的 retry 发生在 Step 内层循环。
- Tool result 可并发产生，但按模型顺序提交。

### 14.2 设计解读

Harness 把主循环设计成“持久事实驱动的状态机”，而不是“内存 messages 驱动的聊天函数”。这让 UI、恢复、取消、工具和插件策略共享同一边界语言。

### 14.3 教学推演

自己实现最小 Agent 时，可以先保留：

```text
one durable next-turn queue
one Turn bracket
one Step bracket
append before external effect
AbortSignal
```

之后再增加 steer、并行工具和 request middleware；不要一开始就复制完整 scheduler。

## 15. 可以带走的方法

### 方法一：业务轮次和外部调用次数分开建模

验证问题：一次任务包含三次工具回合时，用户看到的是一个工作 Turn 还是四个伪对话轮次？

### 方法二：并发执行与确定提交分离

验证问题：A/B/C 完成顺序变化时，日志与下一次模型历史是否仍完全一致？

### 方法三：每个停止点都写结构化原因

验证问题：只看日志能否分清策略阻断、用户取消、token 上限、模型失败和正常完成？

## 16. 常见误区与第一遍可忽略

### 误区一：一个 Tool call 就是一个新 Step

错。一个 Step 的模型响应可包含多个 Tool call；这些工具都属于该 Step。

### 误区二：模型重试一定增加 Step 编号

错。`agent/request-error` 允许同一 Step 内重试 request。

### 误区三：`whenIdle()` 只读取一次 Promise

错。它循环比较 activity generation，确保等待期间启动的新 activity 也收敛，见 [`agent.ts#L195-L200`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L195-L200)。

### 第一遍可以忽略

- reasoning effort 默认值的恢复细节。
- Runtime Context Projection 的每种上下文来源。
- Tool post-result presentation 的私有 meta。

先能完整追踪一 Turn 两 Step，再进入这些分支。

## 17. 费曼自测

1. “读文件后总结”为什么通常是一个 Turn、两个 Step？
2. `steer()` 与 `inject()` 都写 next-step，为什么前者会唤醒而后者不会？
3. 为什么 LLM stream 重试不必创建新 Step？
4. 三个并行工具按 B、C、A 完成时，Harness 怎样保证结果仍按 A、B、C 入账？
5. 取消发生在工具池中间时，为什么未启动调用也要写合成 result？

### 一分钟复述模板

用户 followup 先成为 durable Inbox splice，并唤醒 idle Agent；driver 打开 Turn，在 preStep claim 输入和装配 Prompt，随后打开 Step，把消息写入 Session，从日志派生 history 并构造冻结请求；模型 chunk 逐个入账，完整 Assistant Message 若含工具就调度工具，结果作为 next-step 上下文触发后续 Step；没有工具和新输入时执行停止钩子，最后以结构化原因封闭 Turn。

## 18. 三层练习

### Level 1：只读事件排序

根据本章场景写出最小事件序列，至少包含：

```text
agent/inbox/spliced
turn/start
step/start
user/message
request/header
assistant/chunk
assistant/message
tool/call
tool/result
step/end
step/start
assistant/message
step/end
turn/end
```

标注哪些进入模型 Surface，哪些只做执行追踪。

### Level 2：状态机测试

阅读 [`packages/core/agent-loop/tests/cancel.spec.ts#L244-L260`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/tests/cancel.spec.ts#L244-L260)，解释为何 cancel 后会有 Turn、没有 Step。

再写一个表格列出 phase、Inbox、最后事件的变化。

### Level 3：实现一个精简 driver

用假的 Adapter 和两个工具实现最小循环：

- 第一次响应包含两个并行工具。
- B 先完成，A 后完成。
- 日志必须按 A、B 提交。
- 第二次模型调用输出最终文本。
- 在 A 执行中触发 abort，验证 Turn 仍有结构化结束原因。

验收要求：不依赖 sleep 猜顺序，使用可控 Promise gate。

## 19. 小结与下一章钩子

本章把静态插件树推进成真实工作流：

```text
followup
 → Inbox next-turn
 → Turn 1
 → Step 1 / request / read_file
 → ordered tool result
 → Step 2 / request / final answer
 → turn-stopping
 → completed
```

但我们反复使用了一个尚未完全打开的前提：`Session.append()` 为什么能同时服务模型历史、恢复、UI、工具配对与错误审计？为什么不直接维护一个可变 `messages[]`？

下一章继续使用这次“读 `package.json`”的事件序列，把 Session 当作事件账本拆开：**事实怎样被接受、冻结、投影、压缩，并在崩溃尾部修复？**
