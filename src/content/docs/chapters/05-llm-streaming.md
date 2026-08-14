---
title: "05. LLM 流式适配"
description: "沿一次 DeepSeek 流式请求理解路由冻结、Wire 协议翻译、终止语义与取消传播。"
---

# 05. LLM 流式适配

> 本章证据基线：DeepSeek Harness 固定提交 `47f943859bef60e4160492346772ded9b24f765a`。文中“源码事实”均可由链接直接核对；“设计解读”是对控制流的解释；“教学推演”是帮助迁移到其他 Agent 的简化模型。

## 0. 本章学习目标

学完本章，你应该能够：

1. 画出 Agent Loop、`LlmRuntime`、DeepSeek Adapter 与 Provider API 的边界图。
2. 解释为什么 `prepareCall()` 必须先于 `request/header` 和真正网络分派。
3. 沿一条真实请求追到 `fetch`、SSE 解帧、`StreamChunk` 翻译和 Session 落账。
4. 说清 `block-start`、delta、`block-end`、`usage`、`finish` 的顺序约束。
5. 区分 HTTP、传输、协议、空响应、超时和调用者取消六类失败。
6. 为自己的 Provider Adapter 设计可测试的统一流协议。

## 1. 一句话讲明白

**一句话直觉：`LlmRuntime` 先把“这次到底用哪个适配器、哪些默认参数”冻结成一次性调用，再由 DeepSeek Adapter 把 Provider 的 SSE 方言翻译成 Harness 唯一认识的 `StreamChunk`。**

本章中央问题是：

> 模型响应还没有完整到达时，系统如何既持续展示增量，又保证最终日志、错误分类和取消行为仍然可信？

如果只把流式输出理解成“边读边 `yield` 字符串”，你会漏掉最难的三件事：

- 请求配置可能在异步解析期间变化；
- SSE 正常 EOF 不等于模型正常结束；
- reasoning、文本、工具调用可能交错，最终却必须形成稳定的内容块。

## 2. 为什么现在必须理解它

上一章已经让 Agent Loop 准备好了一个 Step。下一步不是简单地执行 `fetch()`：循环还要选择 Provider、记录模型真正看到的请求、处理中途取消，并把每个增量写进 Session。

设想一次真实故障：请求开始前配置是模型 A，HMR 恰好替换了 Adapter；日志先记了 A 的 header，网络却通过新 Adapter 发往 B。之后即使保存了全部 chunk，你也无法证明这份响应对应哪个请求。

DeepSeek Harness 的处理顺序是：**解析并绑定 → 记录 → 分派 → 翻译 → 归档**。顺序本身就是一致性设计。

## 3. 位置图：谁负责什么

```mermaid
flowchart LR
  A["Agent.step<br/>完整消息、system、tools"] --> B["LlmRuntime.prepareCall<br/>解析路由与默认值"]
  B --> C["PreparedLlmCall<br/>冻结配置和 Adapter 注册"]
  C --> D["request/header + request/context<br/>写入 Session"]
  D --> E["DeepSeekAdapter.stream<br/>快照连接与凭据"]
  E --> F["serializeRequest<br/>Harness → Wire"]
  F --> G["fetch + SSE bytes"]
  G --> H["parseSse<br/>bytes → data payload"]
  H --> I["translate<br/>payload → StreamChunk"]
  I --> J["Agent Loop<br/>assistant/chunk + BlockAssembler"]
```

读图结论：**一次模型调用先在 Provider 中立层冻结身份，再跨越 Wire 边界，最后回到统一事件协议；Loop 从始至终不解析 DeepSeek 字段。**

这条链有四个明确边界：

| 边界 | 输入 | 输出 | 不负责的事 |
| --- | --- | --- | --- |
| Agent Loop | Session 推导的历史、Prompt、工具 | `GenerateOptions` | 不理解 DeepSeek SSE 字段 |
| `LlmRuntime` | Provider 中立调用配置 | 一次性 Prepared Call、统一 chunk 流 | 不拼 HTTP body |
| DeepSeek Adapter | Harness 消息与工具 schema | Provider 请求与统一 `StreamChunk` | 不决定 Turn 是否继续 |
| Session / Assembler | `StreamChunk` | 可恢复事件与完整 assistant message | 不选择 Provider |

读表结论：**每层只翻译相邻协议，Provider 差异不会穿透到 Session 和 Agent Loop。**

**源码事实：** `LlmRuntime` 暴露 `llm/stream` Waterfall，Adapter 只需要实现 `stream(options)`；接口位置见 [`packages/llm/llm/src/index.ts:46-65`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm/src/index.ts#L46-L65) 与 [`index.ts:174-232`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm/src/index.ts#L174-L232)。

## 4. 最小机制：先绑定，再消费

先忽略 Harness 的所有产品层，只保留最小正确机制：

```ts
// 教学伪代码，不是源码复制
const prepared = await llm.prepareCall(proposedConfig, turnSignal)
session.append('request/header', prepared.config)

const request = freeze({
  ...prepared.config,
  system,
  messages: session.deriveMessages(),
  tools,
  signal: turnSignal,
})

for await (const chunk of prepared.stream(request)) {
  session.append('assistant/chunk', chunk)
  assembler.push(chunk)
}

session.append('assistant/message', assembler.blocks())
```

这里最容易忽略的是 `prepared.stream()` 不是一个随便复用的函数。它只能调用一次，而且 request 中的配置必须与 prepare 得到的配置一致。

**源码事实：** `PreparedLlmCall` 明确声明一次性分派和配置一致性约束，见 [`packages/llm/llm/src/index.ts:154-171`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm/src/index.ts#L154-L171)。实现用 `dispatched` 防重用，并以 `callConfigEquals` 防止 prepare 后篡改，见 [`index.ts:779-813`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm/src/index.ts#L779-L813)。

### 4.1 为什么不能直接 `llm.stream(config)`

模型能力解析可能是异步的，例如解析 context window、默认输出上限和 reasoning effort。在这段时间里，Provider 注册可能因 HMR 被替换。

`prepareCall()` 先抓住当前 `registration`，再解析精确模型信息，最后把配置、重试策略、上下文和 Adapter 默认字段一起冻结。网络分派沿用同一个 registration。

**设计解读：** Prepared Call 像一张“已出票但未登机”的登机牌。它不是缓存所有 Provider 状态，而是把本次调用的身份边界变得不可歧义。

### 4.2 Java 类比，以及类比在哪里失效

可以暂时把 `PreparedLlmCall` 类比成 Java 中绑定了目标 client 和不可变 DTO 的一次性 `Callable<Response>`：

```java
PreparedCall call = router.prepare(config);
audit.append(call.resolvedConfig());
Response response = call.executeExactlyOnce(request);
```

类比的有效部分是“解析结果与执行目标绑定”。

类比失效处是：这里返回的不是一个最终 `Response`，而是 `AsyncIterable<StreamChunk>`；消费方可以提前停止，生产方还必须收到取消并释放 socket。它更接近带背压和关闭语义的异步 Publisher，但 Harness 没有采用 Reactor 的完整协议。

## 5. 读源码前必须懂的三个概念

### 5.1 `AsyncIterable` 不是数组

`for await ... of` 每次向上游请求下一项。消费方在两项之间停顿时，不应该被当作 Provider idle；真正的 idle 是某次“正在等待上游 read”长期没有返回。

这正是 Adapter 使用 per-read watchdog，而不是给整次调用套总时长的原因。

### 5.2 SSE framing 与 JSON payload 是两层协议

网络字节可能在任意位置切开，甚至切在 UTF-8 字符中。`parseSse()` 负责 BOM、CRLF、多行 `data:`、注释和空行终止；`translate()` 才负责解析 `data` 内的 JSON。

把两层混成一个循环会让“半个 UTF-8 字符”“未以空行结束的尾部”“坏 JSON”得到同一个模糊错误。

### 5.3 delta 与完整 block 不同

工具调用参数可能跨多个 chunk 到达：第一片只有 id，第二片有 name，后续才逐渐拼出 arguments。UI 需要 delta 做实时展示，Session 最终还需要完整 `ToolCallBlock`。

`StreamChunk` 因而同时定义开始、增量、结束、usage 和 finish。完整联合类型见 [`packages/llm/llm/src/types.ts:283-300`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm/src/types.ts#L283-L300)。

## 6. 一次真实源码旅程：让模型读取文件

假设用户提出：“读取 `package.json` 并告诉我包名。”本节只追模型请求与流，不展开工具真正执行；工具管线留到下一章。

### 第 1 站：Agent Loop 组装调用配置

`Agent.step()` 调用 `buildRequest()`。后者先从 Agent options 与已持久化 header 形成 seed config，再允许 `agent/request` Waterfall 改写路由。

**输入：** turn、step、system、工具 schema、Session 历史。

**输出：** proposed provider/model config。

**状态变化：** 此时尚未发网络请求，也没有 `assistant/chunk`。

源码顺序见 [`packages/core/agent-loop/src/agent.ts:407-455`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L407-L455)。

### 第 2 站：`prepareCall()` 解析精确模型能力

`prepareCall()` 找到当前 Provider 注册，调用 `resolveCallFor()`。如果用户没有显式给出 `maxTokens` 或 reasoning effort，Adapter 的模型信息可以提供默认值；不支持的显式 effort 在网络 I/O 前直接拒绝。

**输入：** `{ provider: 'deepseek', model: '...' }`。

**输出：** frozen config、context window、retry policy、adapterDefaults、一发性 `stream`。

**状态变化：** Adapter registration 已绑定，但还未 dispatch。

默认值和能力拒绝位于 [`packages/llm/llm/src/index.ts:720-768`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm/src/index.ts#L720-L768)。

### 第 3 站：先记录事实，再构造冻结请求

Agent Loop 用 resolved config、system 与 tools 形成 canonical header。如果是第一次、恢复或内容变化，就 append `request/header`；context window 变化则 append `request/context`。随后 request 直接从 header 中取 config/system/tools，并 `deepFreeze`。

**输入：** Prepared Call 与 Step 边界消息。

**输出：** 标记为 Agent Loop 构建的 frozen `GenerateOptions`。

**状态变化：** Session 已拥有“实际将发送什么”的可重建证据。

源码见 [`packages/core/agent-loop/src/agent.ts:458-494`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L458-L494)。

### 第 4 站：DeepSeek Adapter 为本次 stream 快照连接事实

`DeepSeekAdapter.stream()` 每次只读取一次 `config.options()`，再基于同一快照解析 API key。它创建 consumer controller，把调用者 signal 与 consumer signal 融合，并安装 idle watchdog。

**输入：** frozen `GenerateOptions`。

**输出：** 一个由 watchdog 驱动的异步 chunk iterator。

**状态变化：** baseURL、credential、模型目录与 idle budget 在本次请求期间固定；下次请求才重新读取。

见 [`packages/llm/llm-deepseek/src/adapter.ts:214-235`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-deepseek/src/adapter.ts#L214-L235)。

### 第 5 站：序列化 Harness 请求为 DeepSeek Wire 请求

`serializeRequest()` 把 system 放到第一条 wire message，把 Harness user message 中的 `tool-result` 展开为独立 `role: 'tool'`，并把工具 schema 变成 function tools。

它固定设置：

```ts
stream: true
stream_options: { include_usage: true }
```

**输入：** Provider 中立消息、工具与采样参数。

**输出：** DeepSeek chat-completions JSON body。

**状态变化：** 尚未触碰网络；序列化异常不会被错误标成 transport failure。

消息展开见 [`packages/llm/llm-deepseek/src/serialize.ts:104-140`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-deepseek/src/serialize.ts#L104-L140)，请求字段见 [`serialize.ts:143-186`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-deepseek/src/serialize.ts#L143-L186)。

### 第 6 站：发送 HTTP，并保留可诊断信息

Adapter 对 `${baseURL}/chat/completions` 发 POST，添加 Bearer token、SSE accept、归属 header、匿名 user id，并在存在时携带 Harness session id。

**输入：** JSON payload、连接快照、统一 abort signal。

**输出：** `Response` 或结构化 `LlmError`。

**状态变化：** 请求此刻才真正跨越信任边界。

请求构造与 fetch 见 [`packages/llm/llm-deepseek/src/adapter.ts:271-318`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-deepseek/src/adapter.ts#L271-L318)。HTTP 状态会映射为 `AUTH`、`QUOTA`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`SERVER` 或 `HTTP_n`，映射见 [`adapter.ts:132-149`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-deepseek/src/adapter.ts#L132-L149)。

### 第 7 站：SSE 字节变成完整 data payload

`parseSse()` 使用 `TextDecoderStream` 与 `EventSourceParserStream`。只有完整事件的 `data` 被 yield；注释只用于向 watchdog 报告 transport activity，不进入模型内容。

只有字面值 `[DONE]` 才是成功终止。流直接 EOF 会抛 `STREAM_CLOSED`。

源码见 [`packages/llm/llm-deepseek/src/sse.ts:20-39`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-deepseek/src/sse.ts#L20-L39)。

### 第 8 站：有状态翻译为统一 chunk

`translate()` 为 reasoning、text 和每个 wire tool-call index 维护 `OpenBlock`。工具参数片段不断追加到 `block.text`，同时立刻 yield `tool-call-delta`。

收到 `[DONE]` 后，它才按开启顺序输出所有 `block-end`，再输出最新 usage，最后输出唯一 finish。

**输入：** SSE data payload 序列。

**输出：** `StreamChunk` 序列。

**状态变化：** open block 从“仅有片段”收敛为完整 `ContentBlock`。

状态字段见 [`packages/llm/llm-deepseek/src/translate.ts:16-24`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-deepseek/src/translate.ts#L16-L24)，主体状态机见 [`translate.ts:86-180`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-deepseek/src/translate.ts#L86-L180)。

### 第 9 站：每个 chunk 先落账，再生成完整消息

Agent Loop 对流中的每一项 append `assistant/chunk`，同时交给 `BlockAssembler`。流结束后检查 finish；成功时才创建 `assistant/message`，并用 `sourceEventSeqs` 指回对应 chunk。

如果完整消息内包含 `tool-call`，下一步进入工具管线；否则当前 Turn 完成。

源码见 [`packages/core/agent-loop/src/agent.ts:339-399`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L339-L399)。

## 7. 关键类型与状态机

### 7.1 Prepared Call 状态

```text
未创建
  │ prepareCall
  ▼
已准备(dispatched=false, config frozen)
  ├─ 配置不一致 ──> INVALID_PREPARED_CALL
  ├─ 第一次 stream ──> 已分派(dispatched=true)
  └─ 第二次 stream ──> INVALID_PREPARED_CALL
```

这不是为了限制测试便利性，而是防止同一张“已记录的调用身份”被重复消费成两次网络事实。

### 7.2 `StreamChunk` 顺序

```text
block-start(index)
  → 多个同 index delta
  → block-end(index, complete block)
  → usage?
  → finish
  → 绝不再有 chunk
```

多个 block 可以交错产生 delta，但最终 block-end 由 Adapter 按开启顺序归并。

### 7.3 usage 为什么要去重语义

DeepSeek 的 `prompt_tokens` 包含 cache hit；Harness 的 `TokenUsage` 要求 `inputTokens` 与 `cacheReadTokens` 相互独立。因此 Adapter 会从 prompt total 中减去 cache read。

**源码事实：** 映射公式见 [`packages/llm/llm-deepseek/src/translate.ts:45-61`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-deepseek/src/translate.ts#L45-L61)。

**设计解读：** 统一协议不是“字段改名”，而是统一计量语义。若只复制数字，下游成本统计会重复计费。

## 8. 失败、停止与安全边界

### 8.1 HTTP 失败：Provider 已回答，但拒绝请求

401/403 是 `AUTH`，429 可能是 quota 或 rate limit，400 可能是 context overflow 或一般 invalid request。错误还可以保留 HTTP status、合法的 Retry-After 与 request id。

这类失败与 DNS 断开不同：前者说明到达了 Provider，后者连响应都没有。

### 8.2 transport failure：请求没有形成可信 Provider 响应

DNS、TLS、代理或拒绝连接在 fetch 处被包装成 `TRANSPORT`，消息包含 endpoint，原错误进入 `cause` 链。序列化发生在 try 之外，所以本地请求构造错误不会被伪装成网络故障。

### 8.3 malformed payload：SSE 帧完整，但 JSON 坏了

`JSON.parse` 失败映射为 `MALFORMED_RESPONSE`。这是协议内容错误，不是 framing 错误。

### 8.4 stream closed：TCP 结束，但没有 `[DONE]`

没有 `[DONE]` 的 EOF 是截断，不能当作正常完成。`parseSse()` 和 `translate()` 都防守这个不变量，后者也会拒绝一个绕过 parser 的坏 payload source。

### 8.5 empty response：Provider 声称 stop，却没有任何 block

如果 `[DONE]` 到达、finish 是 stop 或缺省，但没有打开过任何内容块，Translator 产出 `EMPTY_RESPONSE` error finish，而不是成功的空 assistant message。见 [`translate.ts:101-117`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-deepseek/src/translate.ts#L101-L117)。

### 8.6 idle timeout 与调用者取消必须分开

watchdog 超时映射为 `TIMEOUT`；如果原始 `options.signal` 已 aborted，则映射为 `ABORTED`。同一个底层 abort 不能让用户点击 Stop 看起来像 Provider 故障。

见 [`packages/llm/llm-deepseek/src/adapter.ts:236-258`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-deepseek/src/adapter.ts#L236-L258)。

### 8.7 下游停止消费也要关闭上游

当消费者 break 或抛错，`finally` 会 abort consumer controller；若 iterator 未耗尽，还调用 `iterator.return()`。见 [`adapter.ts:259-268`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-deepseek/src/adapter.ts#L259-L268)。

这是资源安全边界：停止渲染不等于停止生产。如果不反向取消，socket、计费与 Provider 推理都可能继续。

## 9. DeepSeek Harness 的选择与取舍

| 方案 | Harness 的选择 | 得到什么 | 付出什么 |
| --- | --- | --- | --- |
| 直接在 Loop 使用 Provider SDK | Provider Adapter seam | Loop 与 UI 只懂统一 chunk | Adapter 必须完整翻译语义 |
| 每次分派重新查 Adapter | `PreparedLlmCall` 绑定 registration | header 与 dispatch 一致 | handle 只能用一次 |
| EOF 即成功 | `[DONE]` 显式终止 | 截断不会伪装成功 | 必须实现协议状态机 |
| 整次调用总超时 | per-read idle watchdog | 消费者思考时间不算 Provider idle | 状态与取消原因更复杂 |
| 收到 finish_reason 立即 finish | 延迟到 `[DONE]` | 可吸收 trailing usage | UI 稍晚得到最终 finish |
| 原样上报 prompt tokens | 转成不相交 usage | 统一成本语义 | Adapter 了解 Provider 计数规则 |

读表结论：**Harness 接受 Adapter 侧更复杂的状态机，以换取上层统一、可恢复且不歧义的调用语义。**

**设计解读：** Harness 把“统一”放在语义层而不只是类型层。代价是 Adapter 代码更多，但复杂度被固定在 Provider 边界，不扩散到 Loop、日志、重试和 UI。

## 10. 可以带走的工程方法

### 方法一：动态配置要在操作边界快照

不要让一次长操作反复读取可变配置。开始时解析 endpoint、credential 与 timeout；下一次操作再读取新值。

验证问题：如果流进行到一半时用户切换 API key，本次请求的 endpoint 与 key 会不会来自两个配置世代？

### 方法二：把“传输结束”和“业务完成”分开

TCP EOF、HTTP body EOF 或 iterator done 都不天然等于业务成功。协议应有显式完成信号，并定义缺失信号的错误。

验证问题：删除 `[DONE]` 后，你的测试是否会失败，而不是得到一条看似完整的消息？

### 方法三：取消必须双向传播并保留原因

上游 signal 要进入 fetch 与 body reader；下游停止消费也要终止上游。与此同时，用户取消、超时与传输故障必须有不同机器码。

验证问题：UI Stop 后，Provider 连接是否真正关闭，日志里是否仍能辨别是谁终止了它？

## 11. 常见误区：第一遍先忽略什么

1. 不要一开始研究所有模型发现与配置目录；先抓住 Prepared Call 与 stream 主链。
2. 不要把 `AsyncIterable` 当作“异步数组”；它有消费、return 和取消语义。
3. 不要认为 SSE 的每个网络 chunk 就是一条 JSON；framing 层会重新组帧。
4. 不要用 Java 类比证明行为；真正证据是一次性 handle、状态机与测试边界。
5. 第一遍可暂时忽略 attribution header 的业务背景，但不能删除它；它属于外部请求契约。

## 12. 费曼复述与自测

请先不看答案，用自己的话回答：

1. 为什么 `request/header` 必须在 `prepared.stream()` 前记录，而且二者必须共享 Adapter registration？
2. `parseSse()` 与 `translate()` 分别处理什么错误？为什么不能合并为一个“读取 JSON”函数？
3. Provider 已发 `finish_reason: stop` 后，Harness 为什么仍等 `[DONE]` 才输出 `finish`？
4. idle timeout 为什么只计算正在等待上游 read 的时间，而不计算消费者处理 chunk 的间隔？
5. 当下游 break `for await` 时，哪段代码负责让 Provider socket 停止？

如果你能画出“prepare → header → fetch → SSE → translate → chunk log → message”的链，并解释两个 abort controller 的作用，就掌握了本章核心。

## 13. 三级练习

### Level 1：只读定位

在固定提交中找出并记录：

- Prepared Call 防重复使用的状态变量；
- `[DONE]` 缺失时的两个防守位置；
- usage 必须先于 finish 的实现位置；
- 下游停止消费触发上游 abort 的 `finally`。

验收：每项给出文件、行号和一句行为解释。

### Level 2：状态推演

给定以下 wire 序列，手工写出统一 chunk 序列：

1. reasoning delta `"先"`；
2. text delta `"结论"`；
3. tool call index 0，id 与 name；
4. tool arguments delta `{"path"`；
5. tool arguments delta `:"a"}`；
6. finish reason `tool_calls` 与 usage；
7. `[DONE]`。

验收：标出每个 block index、所有 block-end、usage 和唯一 finish 的顺序。

### Level 3：小型实现

实现一个最小 OpenAI-compatible Adapter 原型：

- 输入使用 Harness `GenerateOptions`；
- 输出严格使用 `StreamChunk`；
- 支持文本和一个并行工具调用；
- 区分 `MALFORMED_RESPONSE`、`STREAM_CLOSED`、`ABORTED`、`TIMEOUT`；
- 添加测试证明 `[DONE]` 后没有额外 chunk，提前停止消费会 abort 模拟 transport。

验收重点不是能访问公网，而是协议与生命周期测试完整。

## 14. 小结与下一章钩子

本章把模型流拆成了五层：路由冻结、请求序列化、SSE framing、统一 chunk 翻译、Session 落账。真正的内核不是 `fetch`，而是让每个不完整增量最终收敛成可验证事实，并让任何异常终止都不会冒充成功。

现在模型已经能稳定产出一个完整 `tool-call` block，但它只是一段模型建议的名字和 JSON 字符串。**谁验证参数、谁决定允许或拒绝、谁处理超时、结果又怎样成为下一次模型输入？** 下一章进入工具执行管线。
