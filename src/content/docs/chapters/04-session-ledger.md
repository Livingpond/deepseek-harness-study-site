---
title: "04. Session 事件账本"
description: "沿一次两步工具调用，理解 append-only 事实、Surface 投影、请求重建与崩溃修复。"
---

# 04. Session 事件账本

> 本章源码基线：[`deepseek-ai/deepseek-harness@47f9438`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)。源码事实与设计解读分开陈述。

## 0. 本章学习目标

完成本章后，你应该能够：

- 画出 Session Header、Event Log、Surface 与 derived messages 的关系。
- 解释为什么 `append()` 不是简单的 `Array.push()`。
- 从上章“读 `package.json`”事件序列重建下一次模型请求历史。
- 分清 raw chunk、assembled message、tool call/result 和 request header 的用途。
- 说清 JSON、连续 seq、深冻结、Surface provenance 与 Turn/Step invariant。
- 解释崩溃尾部为什么要补 tool result、`step/end` 和 interrupted `turn/end`。

## 1. 一句话讲明白

**Session 是一个只追加、连续编号、JSON 可持久化的事实账本；模型历史、UI、恢复和审计不是各自维护状态，而是从同一日志的不同投影得到。**

上一章的 Agent Loop 每走一步都在 `session.append()`。

本章延续同一个贯穿场景：用户要求读取 `package.json` 后总结，Turn 1 有两个 Step；我们不再关注循环怎样跑，而是站在账本视角观察每个事实怎样进入、怎样被投影、怎样在崩溃后保持可解释。

中央问题是：**为什么 Harness 宁愿记录很多事件，也不直接保存一个最终 `messages[]` 和一个 `status`？**

## 2. 最直觉的 `messages[]` 方案为什么不够

最直觉的会话状态是：

```ts
session.messages.push(userMessage)
session.messages.push(assistantMessage)
session.status = 'completed'
```

它能支撑简单聊天，却丢掉生产 Agent 的关键事实：

- Assistant 是逐 token 流出的，UI 如何精确回放？
- Assistant 提出工具后进程崩溃，工具是否已经启动？
- 哪个 system prompt、tool schema、Provider 默认值生成了这次回答？
- compaction 替换模型可见历史后，用户已经看过的 transcript 是否也应被抹掉？
- 插件新增 durable 事件后，旧版本怎样判断能否安全忽略？
- 调用者传入对象后继续修改，历史会不会被悄悄篡改？

Harness 的选择是“事实先追加，视图后投影”。这不是为了套用 Event Sourcing 名词，而是为了让模型请求、产品界面和恢复路径共享可验证证据。

## 3. 先看数据地图

```text
SessionHeader
  id / version / createdAt / cwd / lineage / seedLength

SessionEvent[]  （append-only, seq = index）
  ├─ 执行边界: turn/*, step/*
  ├─ 原始流: assistant/chunk
  ├─ 模型 Surface: user/message, assistant/message, tool/result
  ├─ 工具审计: tool/call
  ├─ 请求快照: request/header, request/context
  └─ 插件扩展事件: declaration merging
              │
              ├─ Surface fold ──► deriveMessages() ──► next LLM request
              ├─ append-origin ─────────────────────► human transcript / UI
              ├─ full log ─────────────────────────► replay / telemetry / repair
              └─ storage encoding ─────────────────► JSONL / packed chunk rows
```

读图结论：**日志是事实源，Surface 是模型可见顺序，derived messages 只是 Surface 的一种缓存投影。**

### 3.1 四种数据不要混为“会话历史”

| 数据 | 是否可变 | 用途 | 典型消费者 |
| --- | --- | --- | --- |
| `SessionHeader` | 创建后冻结 | 身份、格式、cwd、父子关系 | Store、Fork、Resume |
| `Session.events` | 只追加，返回快照 | 完整事实与执行轨迹 | Persistence、Telemetry、Repair |
| `Session.surface.nodes` | 从事件增量折叠 | 当前模型可见节点顺序 | `deriveMessages()` |
| derived messages | 缓存后返回新数组 | 下一次 LLM history | Agent Loop |

表后结论：**Header 不是 Event，Surface 不是完整日志，derived messages 也不是新的事实源。**

## 4. 最小机制：先剥掉持久化与 UI

```ts
// 教学伪代码：体现真实不变量，不复制实现细节
class Session {
  private log = []
  private surface = []

  append(type, data, surfaceOp?) {
    const snapshot = validateAndCloneLosslessJson(data)
    const event = deepFreeze({
      type,
      seq: this.log.length,
      time: Date.now(),
      data: snapshot,
      surfaceOp,
    })
    validateNextSurfaceTransition(event)
    validateExecutionInvariants(event)
    this.log.push(event)
    publishContained(event)
    return event
  }

  deriveMessages() {
    return this.surface
      .map(seq => projectMessage(this.log[seq]))
      .filter(Boolean)
  }
}
```

一次 append 的数据变化是：

```text
调用者持有的 mutable data
 → lossless JSON snapshot
 → {type, seq, time, data, surface metadata}
 → deep-frozen candidate
 → pre-commit validation
 → append-only log
 → contained observers / async persistence buffer
```

为什么必须先 snapshot 再校验？如果 getter 第一次返回合法值、第二次返回另一值，分开“校验”和“复制”会产生 TOCTOU 漂移；Harness 用一次遍历同时读取、验证和脱离调用者对象。

### 4.1 通用机制与 Harness 产品叠加

| 通用事件账本机制 | Harness 叠加层 |
| --- | --- |
| 连续序列与不可变事实 | `SessionEventMap` 的 Agent/Tool/Request 词汇 |
| 投影生成读模型 | Surface append/replace 语义 |
| 恢复开放 bracket | Turn/Step/Tool 专用 repair |
| 持久编码 | chunk run packing、JSONL backend |
| Schema 演进 | declaration merging + `ignorable` 策略 |

表后结论：**append-only 是内核；Surface、Agent vocabulary 和 chunk packing 是围绕 Agent 产品需求长出的层。**

## 5. 类型地图：Session Event 怎样既封闭又可扩展

### 5.1 `SessionEventMap` 是词汇表

核心接口定义 `turn/start`、`assistant/chunk`、`tool/result` 等 payload，再由 key 派生 EventType，见 [`packages/core/session/src/types.ts#L230-L336`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/types.ts#L230-L336)。

插件能通过 TypeScript declaration merging 加新 key。

Java 类比是一个可由模块贡献 subtype 的事件注册表，但类比边界很明显：TypeScript interface merging 只在编译期扩充联合，持久化读入的 JSON 仍必须做运行时校验与版本策略。

### 5.2 Event envelope

每个事件至少包含：

```ts
{
  type: string,
  seq: number,
  time: number,
  data: JsonValue,
  surfaceOp?: 'append' | { op: 'replace', start, end },
  sourceEventSeqs?: number[],
  ignorable?: true,
}
```

Seed/load 边界只接受固定 envelope key，并校验 type、非负安全整数 seq、time、data 与 ignorable，见 [`packages/core/session/src/index.ts#L212-L250`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/index.ts#L212-L250)。

### 5.3 Surface 事件只有三种

运行时白名单是：

```text
user/message
assistant/message
tool/result
```

定义见 [`packages/core/session/src/surface.ts#L14-L28`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/surface.ts#L14-L28)。

容易误读：`assistant/chunk` 虽然包含模型输出，却不直接进入模型历史；它是流式回放事实，完整 `assistant/message` 才是模型 Surface 节点。

### 5.4 扩展事件必须声明旧版本能否忽略

类型层允许插件合并 `SessionEventMap`，不代表任意旧构建都能安全读取新词汇。

当前构建维护生成的 `KNOWN_SESSION_EVENT_TYPES`；持久化读路径遇到集合外类型时，只有 envelope 明确带 `ignorable: true` 才能跳过，否则应拒绝恢复，契约说明见 [`packages/core/session/src/known-event-types.ts#L8-L19`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/known-event-types.ts#L8-L19)。

为什么默认拒绝？一个新事件可能改变模型历史、权限或状态机；旧版本若静默丢弃，会重建出“格式合法但语义错误”的 Session。只有生产者能证明该事实对旧消费者无影响时，才应标记可忽略。

## 6. Header：为什么它不在 Event Log 中

`SessionHeader` 保存格式版本、ID、创建时间、cwd、父 Session、seedLength、delegation depth 等创建元数据。

`Session` 构造时会 snapshot、校验并 deep-freeze Header；版本、ID、绝对 cwd 和 lineage 字段校验见 [`packages/core/session/src/index.ts#L95-L156`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/index.ts#L95-L156)。

设计解读：Header 描述“这个 Session 是谁、从哪里创建”，Event 描述“Session 中发生了什么”。若把每次创建读取都写成事件，冷启动一个未改动 Session 也会增长对话账本。

Seed 恢复时，Session 会追加一次 `session/end-seed` 标记，但如果末尾已经有标记就不重复增长，见 [`packages/core/session/src/index.ts#L539-L547`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/index.ts#L539-L547)。

## 7. `append()`：提交边界到底做了什么

### 7.1 第一步：Lossless JSON snapshot

`snapshotJsonValue()` 接受：

- `null`、boolean、string、有限 number。
- 普通 dense array。
- plain object 或 null-prototype object。

拒绝：

- BigInt、function、symbol、undefined。
- `NaN`、Infinity、负零。
- 稀疏数组、循环引用。
- Map、Set、Date、class instance 等 exotic object。

实现用迭代任务栈而不是递归调用栈，说明见 [`packages/core/session/src/json.ts#L165-L189`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/json.ts#L165-L189)。

### 7.2 第二步：构造连续 seq 的冻结事件

事件使用 `seq: this.log.length`，因此 seq 与数组索引同值；`time` 在接受时取 `Date.now()`。

`append()` 的真实构造见 [`packages/core/session/src/index.ts#L604-L634`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/index.ts#L604-L634)。

为什么连续序号是基础不变量？Surface 用 seq 直接定位日志节点，工具结果用 seq 引用 source，Fork 用边界截取连续前缀，持久化也依赖它检查缺口。

### 7.3 第三步：Surface 预校验

候选事件进入 log 前先 `surfaceManager.validateNext(event)`。

若 message-producing event 没有 `surfaceOp`，或非 Surface event 错带 marker，都直接拒绝，规则入口见 [`packages/core/session/src/surface.ts#L184-L207`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/surface.ts#L184-L207)。

### 7.4 第四步：禁止 reentrant append

Session 在 publication 边界设置 `appending`；Observer 同步重入同一个 Session 的 append 会被拒绝，见 [`packages/core/session/src/index.ts#L623-L626`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/index.ts#L623-L626)。

原因不是“事件不能触发事件”，而是避免当前候选尚未完成发布时插入另一个 seq，破坏观察者对提交顺序的共同认识。

### 7.5 第五步：先 commit，再隔离 Observer 失败

收集 callback 后，事件进入 log，缓存失效；随后每个 Session observer 独立调用，失败被包含，不会让已经提交的事件从返回值中消失，见 [`packages/core/session/src/index.ts#L636-L654`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/index.ts#L636-L654)。

这形成清晰边界：pre-commit validator 可以 veto，post-commit observer 只能观察，不能回滚事实。

## 8. 真实源码旅程：两 Step 请求在账本里怎样长出来

以下 seq 是教学示例，具体 Session 可能还有 Inbox、Prompt 或插件事件；事件相对关系来自真实主循环。

### 8.1 输入入队，但尚未成为模型历史

```text
seq 0  agent/inbox/spliced  insert next-turn user message
```

此时用户意图已持久，但 Surface 还没有 `user/message`；模型历史不能提前包含尚未被 Turn 认领的输入。

### 8.2 Turn 开启并 claim

```text
seq 1  turn/start           { turn: 1 }
seq 2  agent/inbox/spliced  removeCount: 1 from next-turn
seq 3  step/start           { turn: 1, step: 1 }
seq 4  user/message         “读取 package.json...” surfaceOp: append
```

数据变化：Surface nodes 从 `[]` 变为 `[4]`，`deriveMessages()` 现在返回一个 user-role message。

### 8.3 请求配置也进入账本

```text
seq 5  request/header {
         reason: initial,
         header: {
           config: { provider, model, ... },
           system,
           tools
         }
       }
seq 6  request/context { provider, model, contextWindow }
```

`request/header` 用 full snapshot 而非 delta；`foldRequestHeader()` 取最后一份 canonical header，见 [`packages/core/session/src/request-header.ts#L56-L70`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/request-header.ts#L56-L70)。

它们是 log-only，不进入模型 message 数组；但恢复时能证明请求配置。

### 8.4 模型流与完整消息同时保留

```text
seq 7..12 assistant/chunk   tool-call deltas
seq 13    assistant/message { tool-call read_file }
          surfaceOp: append
          sourceEventSeqs: [7,8,9,10,11,12]
```

数据变化：Surface nodes `[4] → [4,13]`。

为什么 chunk 和 message 都保留？

- chunk 支撑流式 UI、块边界与精确回放。
- assembled message 支撑下一次模型 history。
- `sourceEventSeqs` 记录 assembled fact 从哪些早期事实推导。

### 8.5 Tool call 与 result 分工

```text
seq 14 tool/call   raw arguments, callId, name
seq 15 tool/result package.json content
       surfaceOp: append
       sourceEventSeqs: [14]
seq 16 step/end    { turn: 1, step: 1 }
```

`tool/call` 是执行审计，不直接产生模型 Message；`tool/result` 携带 user-role ToolResultMessage，进入 Surface。

Surface nodes 变为 `[4,13,15]`。

### 8.6 Step 2 的请求历史怎样得出

`deriveMessages()` 遍历 Surface node seq，并调用 `deriveEventMessage()`：

```text
seq 4  user/message      → user Message
seq 13 assistant/message → assistant Message（含 tool-call）
seq 15 tool/result       → user ToolResultMessage
```

单节点投影规则见 [`packages/core/session/src/surface.ts#L70-L114`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/surface.ts#L70-L114)。

读图结论：**下一次请求历史不是“扫描所有 Event 猜哪些像消息”，而是只按已验证 Surface 顺序投影。**

### 8.7 最终回答与 Turn 封闭

```text
seq 17 step/start        { turn: 1, step: 2 }
seq 18.. assistant/chunk final text deltas
seq 25 assistant/message final text, surfaceOp: append
seq 26 step/end          { turn: 1, step: 2 }
seq 27 turn/end          { turn: 1, reason: completed }
```

最终 Surface 是 `[4,13,15,25]`，完整 Event Log 则还保留所有执行边界、chunks、请求快照和 Inbox 变化。

## 9. Surface：append-only 日志上怎样允许模型历史“替换”

### 9.1 日志不改，Surface 节点可以被新事件遮蔽

Surface operation 有两种：

```ts
'append'
{ op: 'replace', start: oldSeqA, end: oldSeqB }
```

replace 不删除旧 Event；它追加一个新 Event，并把 Surface 中指定连续范围替换为新 seq。

```text
Log:     [4 user, 13 assistant, 15 tool, 25 answer, 30 compacted-summary]
Surface: [4, 13, 15, 25]
replace  start=4 end=25 with seq=30
Surface: [30]
```

读图结论：**模型历史可以缩短，而完整事实与用户已经看到的 append-origin transcript 仍保留。**

### 9.2 Provenance 为什么必须覆盖被遮蔽节点

Replace Event 的 `sourceEventSeqs` 必须引用早于当前 seq 的事件，并包含所有被遮蔽 Surface node；校验见 [`packages/core/session/src/surface.ts#L210-L242`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/surface.ts#L210-L242)。

这避免一个“总结”无证据地抹掉模型上下文中的旧消息。

### 9.3 容易误读：Surface 不是人类 Transcript

源码明确说明，模型 Surface 会隐藏被 replace 的节点，不适合直接作为用户 transcript；append-origin 事件才保留用户实际看过的对话材料，见 [`packages/core/session/src/surface.ts#L40-L54`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/surface.ts#L40-L54)。

字段名“surface”容易被误解成 UI surface，实际这里首先是 **model-visible surface**。

## 10. `deriveMessages()`：缓存不是第二事实源

`deriveMessages()` 维护：

- 已投影的 frozen Message 列表。
- 已处理 node 数。
- Surface replace generation。

普通 append 只处理新 nodes，成本是 O(new nodes)；发生 replace generation 变化时才清空重建，见 [`packages/core/session/src/index.ts#L701-L747`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/index.ts#L701-L747)。

每次返回新数组，但数组中的 Message 与日志内 frozen object 共享。

因此：

```ts
const first = session.deriveMessages()
session.append(...)
```

`first` 不会自动增长；调用者也不能通过修改 Message 篡改日志。

## 11. 执行 Invariant：Event 类型合法还不够

JSON 与 Surface 校验保证“事件可保存、可投影”，但 Agent 执行还要求时序合法。

Invariant companion 维护每个 Session 的 trace：

```text
lastSeq
openTurn
openStep
nextTurn
nextStep
pendingCalls
```

它在 `internal/dispatch` pre-commit 阶段纯校验 transition，只有真正发布 `session/event` 后才应用状态，见 [`packages/core/session/src/invariant.ts#L189-L242`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/invariant.ts#L189-L242)。

### 11.1 具体拒绝案例

- Turn 1 未关时再开 Turn 2。
- `turn/end.turn` 与 open Turn 不同。
- Step 1 未关时再开 Step 2。
- `assistant/chunk` 指向一个未打开的 Step。
- `tool/result` 没有对应的先前 `tool/call`。
- Step 编号从 1 跳到 3。

这些行为有真实测试覆盖，见 [`packages/core/session/tests/invariant.spec.ts#L119-L207`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/tests/invariant.spec.ts#L119-L207) 与 [`invariant.spec.ts#L210-L230`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/tests/invariant.spec.ts#L210-L230)。

### 11.2 为什么 pre-commit validator 能 veto，普通 observer 不能

若 invariant 在事件 append 后才报错，坏事实已经进入 log，无法在 append-only 模型中删除。

因此它借 `internal/dispatch` 在 commit 前计算 transition；普通 `session/event` observer 则发生在 commit 后，抛错只记 warning。

测试证明后置 hostile observer 不会让 append 失败，见 [`invariant.spec.ts#L89-L100`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/tests/invariant.spec.ts#L89-L100)。

## 12. 失败边界：坏数据必须在源头拒绝

### 12.1 非 JSON 值

BigInt、function、Map、Infinity、稀疏数组、循环引用都会在 append site 被拒绝，且日志长度不变；测试见 [`packages/core/session/tests/session.spec.ts#L471-L496`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/tests/session.spec.ts#L471-L496)。

### 12.2 Seed 不连续

恢复或 Fork seed 要求 `snapshot.seq === index`；否则构造 Session 直接失败，源码见 [`packages/core/session/src/index.ts#L508-L537`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/index.ts#L508-L537)。

测试中的 seq 0 后直接 seq 5 会被拒绝，见 [`packages/core/session/tests/session.spec.ts#L527-L533`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/tests/session.spec.ts#L527-L533)。

### 12.3 Surface Message 缺 marker

即使 TypeScript overload 正常能约束，原始持久 JSON 或被 widen 的类型仍可能绕过编译器；运行时必须拒绝没有 surfaceOp 的 message event，测试见 [`session.spec.ts#L498-L509`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/tests/session.spec.ts#L498-L509)。

### 12.4 调用者后改对象

append 记录的是 detached snapshot，并 deep-freeze；调用者之后修改原输入，不会改变 Event 与 derived history。

这条边界防止 UI、工具插件或 Adapter 共用对象引用时出现历史漂移。

## 13. 崩溃修复：开放 Turn 不能伪装成正常历史

### 13.1 场景：工具已经记录 call，但 result 尚未落账

假设上章场景在 seq 14 `tool/call(read_file)` 后进程崩溃：

```text
turn/start 1
step/start 1
assistant/message(tool-call)
tool/call read_file
<crash>
```

仅追加 `turn/end: interrupted` 还不够，因为 Provider transcript 里 Assistant tool-call 没有配对 ToolResult。

### 13.2 Repair 的顺序

`interruptedTurnClosers()` 扫描日志，跟踪 open Turn、open Step 与 pending call，然后按顺序补：

```text
1. pending tool/result error（每个未配对 call）
2. step/end（若 Step 仍开）
3. turn/end { kind: interrupted }
```

实现见 [`packages/core/session/src/repair.ts#L27-L80`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/repair.ts#L27-L80) 与 [`repair.ts#L82-L132`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/repair.ts#L82-L132)。

读图结论：**先补工具配对，再关 Step，再关 Turn，顺序与运行时 invariant 完全一致。**

### 13.3 已启动与未启动的 Tool 风险不同

Repair 用是否已有 `tool/call` seq 区分：

- 未记录启动：可以在仍需要时重试。
- 已记录启动但无结果：外部副作用未知，不能盲目重试；应根据幂等性检查外部状态或询问用户。

这是安全边界，不是错误文案细节；源码生成的合成 ToolResult 明确携带两种不同代码与指导，见 [`repair.ts#L89-L123`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/repair.ts#L89-L123)。

## 14. 存储优化：保留逻辑事件，不必逐行重复 envelope

Assistant stream 可能产生数百个很小的 delta，若每个都写完整 JSON Event envelope，空间成本很高。

`chunk-rows.ts` 把连续、同类型、同 turn/step、同 block index 的 delta run 编码为：

```text
text-chunks
reasoning-chunks
tool-call-chunks
```

它们是 **storage records，不是 Session events**；恢复时会展开成完全相同的原事件，文件说明见 [`packages/core/session/src/chunk-rows.ts#L1-L18`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/chunk-rows.ts#L1-L18)。

### 14.1 为什么要 exact-shape whitelist

Encoder 只压缩完整识别的 envelope/data/chunk shape；未知字段、未来 chunk variant 或时间差不可精确表示时，原样存储而不是“尽量压缩”，分类逻辑见 [`chunk-rows.ts#L88-L123`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/chunk-rows.ts#L88-L123)。

设计取舍：宁愿失去压缩率，不失去数据或前向兼容性。

### 14.2 最少三个成员才打包

低于三个时 row envelope 与省下的内容相当，常量和打包入口见 [`chunk-rows.ts#L72-L77`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/chunk-rows.ts#L72-L77) 与 [`chunk-rows.ts#L182-L205`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/chunk-rows.ts#L182-L205)。

## 15. DeepSeek Harness 的设计取舍

### 15.1 Append-only Log vs 可变最终状态

| 维度 | 可变 `messages[]` | Harness Event Log |
| --- | --- | --- |
| 写入成本 | 低 | 事件多、校验多 |
| 崩溃定位 | 只能看最后状态 | 可看到开放边界与最后事实 |
| 模型重建 | 直接拿数组，但来源不明 | Surface + header 可重建 |
| UI 回放 | 需另存 stream | raw chunk 已在日志 |
| Compaction | 原地改数组会丢历史 | append replace，旧事实保留 |
| 扩展 | 改中心 schema | declaration merging，但需兼容策略 |

表后结论：**Harness 用写入复杂度换取多消费者的一致证据与恢复能力。**

### 15.2 Hot append vs 每次同步落盘

`append()` 不阻塞等待 I/O；Persistence observer 负责缓冲，显式 `session/flush` 才是耐久检查点。

优点是 stream chunk 不被磁盘延迟卡住；代价是“已在内存账本提交”不自动等于“已经 fsync”。

因此 Java 类比中的数据库 transaction 到这里停止：Session commit 和 durable storage flush 是两层承诺。

### 15.3 Full request header vs delta

Full snapshot 让任意前缀只需取最后 header 就能重建；代价是 header 变化时记录较大对象。

代码还会 canonicalize 空 system/tools 并比较 schema，避免未变化时重复写，见 [`packages/core/session/src/request-header.ts#L14-L53`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/request-header.ts#L14-L53)。

## 16. Java 类比与边界

| Harness | Java 桥梁 |
| --- | --- |
| Session Event Log | Event Sourcing aggregate journal |
| `seq` | aggregate-local version / offset |
| Surface fold | materialized view / projection |
| `deriveMessages()` | 增量 projection cache |
| `sourceEventSeqs` | provenance / causal references |
| `session/flush` | write-behind buffer checkpoint |

类比停止处：

- Session 没有通用事件总线的跨 aggregate 全局 offset；seq 只在单 Session 连续。
- 不是所有 Event 都表示领域业务；chunk 与 step boundary 也承担执行追踪。
- append 已提交到内存，不等同于关系数据库事务耐久提交。
- Surface replace 是模型上下文视图语义，不是原事件被删改。

## 17. 源码事实、设计解读与教学推演

### 17.1 源码事实

- Event data 必须通过 lossless JSON snapshot。
- `seq` 等于 append 前的 log length。
- Surface message event 必须声明 append 或 replace。
- `deriveMessages()` 只从 Surface nodes 投影，并做增量缓存。
- Invariant 在 pre-commit 验证 Turn、Step 与 Tool 配对。
- Repair 只追加合成 closers，不改旧日志。

### 17.2 设计解读

Session 把“模型看到什么”和“系统发生过什么”分成 Surface 与完整日志；二者用 seq 与 provenance 连接。这让 compaction 能改变未来模型上下文，又不重写用户历史。

### 17.3 教学推演

实现一个最小账本时先保留：

```text
lossless snapshot
contiguous seq
append-only array
one message projection
open Turn invariant
explicit flush
```

等最小链可靠后，再增加 replace、provenance、chunk packing 与插件扩展事件。

## 18. 可以带走的方法

### 方法一：事实、模型视图和人类视图分开

验证问题：模型 compaction 后，系统是否仍能展示用户已经看过的原对话并审计摘要来源？

### 方法二：坏数据在 append site 失败

验证问题：一个 Map 或稀疏数组会在产生它的插件旁报错，还是等到后台 flush 才随机失败？

### 方法三：崩溃恢复遵守同一运行时 invariant

验证问题：修复开放 Tool/Step/Turn 时，合成事件能否通过正常的配对与编号规则？

## 19. 常见误区与第一遍可忽略

### 误区一：`assistant/chunk` 就是模型历史的一部分

错。Chunk 是流式事实；完整 `assistant/message` 才投影为模型 Message。

### 误区二：`Session.events` 会随 append 原地增长

getter 返回冻结快照并缓存到下一次 append；旧数组不会自动增长，见 [`packages/core/session/src/index.ts#L550-L566`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/index.ts#L550-L566)。

### 误区三：replace 会删除旧 Event

错。replace 只改变 Surface fold；完整日志继续保留旧节点与新替换事件。

### 误区四：append 返回成功就已经落盘

错。append 是内存提交边界，Persistence 为 write-behind，durability 由 flush checkpoint 保证。

### 第一遍可以忽略

- Tool result replacement 只允许改 content 的全部校验细节。
- Fork 的每种错误码。
- Packed chunk decoder 的所有 malformed 分支。

先能从事件序列准确重建 Step 2 请求，再进入这些高级路径。

## 20. 费曼自测

1. 为什么 `assistant/chunk` 和 `assistant/message` 都要保存，它们分别服务谁？
2. Surface 与完整 Event Log 有什么不同，为什么 Surface 不能直接当人类 transcript？
3. `append()` 为什么同时做 snapshot、freeze、Surface pre-validation 和 reentrancy guard？
4. 进程在 `tool/call` 后崩溃时，Repair 为什么不能只补一个 `turn/end`？
5. `deriveMessages()` 返回的是新数组，为何其中 Message 又可以共享日志对象？

### 一分钟复述模板

Session 把每个输入、执行边界、模型 chunk、完整消息、工具调用和请求快照写成连续编号的不可变 JSON 事件；append 在提交前脱离调用者对象并校验 Surface 与 invariant，提交后 observer 失败不能撤销事实；模型历史只从经过验证的 Surface nodes 投影，replace 能改变未来上下文但不删除旧日志；恢复时按工具、Step、Turn 顺序追加合成 closer，持久层则可无损打包 chunk。

## 21. 三层练习

### Level 1：手工投影

给定本章第 8 节事件序列，分别列出：

- 完整 Event 类型列表。
- Surface node seq。
- Step 2 的 `deriveMessages()` 结果角色顺序。
- 人类 transcript 应选择的 append-origin 事件。

要求说明为什么 `tool/call`、chunk、step boundaries 不在 derived messages 中。

### Level 2：失败输入测试

构造一个 Session，依次尝试 append：

- 正常 dense array。
- 含 BigInt 的 payload。
- 稀疏数组。
- 循环对象。
- 缺 surfaceOp 的 widened `user/message`。

记录每次失败后 `session.events.length`，证明拒绝不会部分写入。

### Level 3：最小 Repair 与 Projection

实现一个教学版事件账本：

- 支持 Turn/Step、Assistant tool-call、ToolResult。
- 用连续 seq 和 pre-commit invariant。
- 对开放工具调用生成 outcome-unknown result。
- 再补 step/end 和 interrupted turn/end。
- 从 Surface 重建 Message history。

验收：修复后的日志再次通过同一 invariant，而不是走后门插入。

## 22. 小结与下一章钩子

本章把上章两 Step 请求重新读成账本：

```text
mutable input
 → lossless frozen event
 → contiguous append-only log
 → Surface transition
 → derived model history
 → UI / persistence / repair consumers
```

现在我们已经拥有可重建的 messages、system、tools 与 route 快照，但还有下一个真实问题：`provider` 和 `model` 最终怎样找到具体 Adapter？不同 Provider 的 stream、错误和 token 信息怎样被归一成 Agent Loop 能消费的协议？

下一章进入 LLM 运行时与 Provider 路由，继续追同一个 request header 从配置变成真实模型流。
