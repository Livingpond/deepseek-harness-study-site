---
title: "09. Skills 与 Subagents"
description: "从按需加载知识到可续子会话，理解两条完全不同的 Agent 扩展线。"
---

# 09. Skills 与 Subagents

> 本章证据基线：DeepSeek Harness 固定提交 `47f943859bef60e4160492346772ded9b24f765a`。
> 标为“源码事实”的内容可由链接直接核对；“设计解读”是对控制流的解释；“教学推演”是帮助迁移的简化模型。
> 贯穿场景：主 Agent 先按需加载“代码审查规范” Skill，再把仓库审查委托给一个可继续追问的 child Agent。

## 0. 本章学习目标

学完后，你应该能够：

1. 用一句话区分 Skill 和 Subagent，而不是把二者统称为“插件”。
2. 画出 Skill 从 Provider 发现、Registry 消歧、catalog 注入到正文按需加载的完整路径。
3. 解释 `SkillSummary`、`SkillCandidate`、`SkillDefinition` 为什么分成三层。
4. 区分 foreground one-shot、background one-shot 与 continuable child 的返回值和生命周期。
5. 沿一次 `subagent` 工具调用追到 `SubagentRuntime`，说清父级所有权、深度预算和取消信号。
6. 找出至少两个 fail-loud 边界，并能为自己的 Agent 选择合适的委托模式。

## 1. 一句话讲明白

**Skill 是给同一个 Agent 按需展开“怎么做”的知识包；Subagent 是创建另一个有独立 Session 和生命周期的执行主体。**

本章中央问题是：

> 当主 Agent 不可能把全部知识放进上下文，也不适合亲自完成所有工作时，Harness 怎样既控制上下文体积，又控制委托的身份、权限与停止？

如果只记住“都能扩展能力”，你会在三个地方犯错：

- 想加载一份规范，却错误地创建昂贵子会话；
- 想隔离长任务，却只把一段 Markdown 塞给当前模型；
- 创建了子 Agent，却没有定义谁能继续它、谁负责取消它、完成结果怎样回到父级。

## 2. 为什么现在需要理解它

前几章已经建立了 Turn、Step、Tool 与 Session Log。

现在出现两个现实问题。

第一个问题是**知识太多**。

如果每个 Skill 的完整正文都常驻 system prompt，Skill 越多，模型真正处理任务的空间越少。

第二个问题是**工作太多**。

检索、测试、审查等任务可以独立推进；若主 Agent 串行等待，吞吐量和交互性都会下降。

Harness 没用同一种机制解决二者。

它用 Skill 的“摘要先行、正文后取”解决知识发现，用 Subagent 的“Provider 能力 + 父子身份 + 生命周期”解决工作委托。

## 3. 位置图：两条扩展线在哪里相交

```mermaid
flowchart LR
  FS["Skill Provider\nfilesystem / runtime"] --> SR["SkillRegistry\n发现、分层、消歧"]
  SR --> CAT["catalog 摘要\n进入 prompt"]
  CAT --> ST["skill tool"]
  ST --> BODY["完整 SkillDefinition\n进入当前 Agent"]

  MODEL["当前 Agent / 模型"] --> SAT["subagent tool"]
  SAT --> RT["SubagentRuntime"]
  RT --> P["Subagent Provider"]
  P --> CHILD["独立 child Session / Agent"]
  CHILD --> RESULT["结果、通知或后续消息"]

  BODY --> MODEL
  MODEL --> SAT
```

边界要先画清：

| 问题 | Skill | Subagent |
| --- | --- | --- |
| 改变执行主体吗 | 否，仍是当前 Agent | 是，创建或恢复 child |
| 主要资源 | 上下文 token、关联资源 | Session、模型调用、工具与运行时 |
| 核心身份 | skill name + provider | parent session + child session + provider |
| 典型返回 | 完整 instructions | output、job id 或 durable child id |
| 后续交互 | 再次加载 Skill | continuable child 可接收后续 Turn |
| 主要停止点 | lookup/load 被取消或正文不可用 | 深度超限、取消、settle、父级销毁 |

读图与表的结论：同一个“完成代码审查”场景里，Skill 解决审查者需要知道什么，Subagent 解决谁在另一个生命周期里执行审查。

**源码事实：** Skill 服务只负责合并 Provider catalog、解析同名胜者并加载正文，不负责创建 Agent，见 [`packages/skill/skill/src/index.ts:1-10`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/skill/src/index.ts#L1-L10)。

**源码事实：** continuable child 拥有一个 durable Session，进程内最多有一个 Activation；Turn 排队仍由 Agent inbox 负责，见 [`packages/subagent/subagent/src/continuation.ts:1-19`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/continuation.ts#L1-L19)。

## 4. 最小机制：先剥掉产品细节

### 4.1 Skill 的最小机制

下面是教学伪代码，不是原样复制源码：

```ts
const summaries = await skills.list({ cwd, scope, signal })
// prompt 里只放 name + description + invocation policy

if (modelCallsSkill(name)) {
  const definition = await skills.get(name, { cwd, scope, signal })
  return renderSkillContent(definition)
}
```

这段机制的重点不是“读文件”，而是**发现与加载分离**。

发现阶段要便宜，加载阶段可以昂贵但只为已选 Skill 付费。

### 4.2 Subagent 的最小机制

```ts
const parent = exec.agent
assert(parent !== undefined)
assert(depth(parent) < maxDepth)

if (mode === 'foreground') return await runtime.start(provider, request)
if (mode === 'background-one-shot') return jobs.start(() => runtime.start(provider, request))
return runtime.startContinuable({ provider, request, parent })
```

这里最重要的不是 `await`，而是三项前置条件：

1. 谁是父级；
2. Provider 承诺什么能力；
3. 本次委托的生命周期由谁持有。

## 5. 读源码前必须认识的类型

### 5.1 `SkillSummary`、`SkillCandidate`、`SkillDefinition`

三种类型不是重复建模。

| 类型 | 多出来的内容 | 使用阶段 |
| --- | --- | --- |
| `SkillSummary` | name、description、invocation、source、provider | 给 catalog 和路由看 |
| `SkillCandidate` | rank、locator、path、metadata | Registry 消歧和回调 Provider |
| `SkillDefinition` | content、path、metadata | 真正加载后交给模型 |

**源码事实：** 三种类型分别定义在 [`packages/skill/skill/src/index.ts:55-101`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/skill/src/index.ts#L55-L101)。

`locator` 被声明为 `unknown`，意味着 Registry 不解释 Provider 私有定位方式。

文件系统 Provider 可以放路径，远端 Provider 可以放对象键，Registry 只在 `get(candidate)` 时把它原样交还。

这是典型的**不透明句柄**。

### 5.2 `SkillInvocationPolicy`

`modelInvocable` 和 `userInvocable` 是两个独立布尔值。

因此“用户能显式调用”不等于“模型能自行发现”。

**源码事实：** 策略与两个判定函数在 [`packages/skill/skill/src/index.ts:47-53`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/skill/src/index.ts#L47-L53) 和 [`122-138`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/skill/src/index.ts#L122-L138)。

### 5.3 Subagent 的三个身份

学习 continuable 模式时，不要只看一个 id。

- `parent.id`：谁发起委托并拥有权限；
- `childId`：跨 Activation 稳定的 Session 身份；
- `messageId`：某次进入 child inbox 的消息身份。

**源码事实：** `ContinuableStart` 明确返回 `childId` 与初始 `messageId`，见 [`packages/subagent/subagent/src/continuation.ts:126-132`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/continuation.ts#L126-L132)。

## 6. 真实源码旅程一：模型加载一个 Skill

我们追踪模型看到 catalog 后调用 `skill({ name })` 的路径。

### 第 1 步：Provider 注册到 Registry

Provider 通过 `registerProvider()` 同步注册工厂。

远端初始化、认证和扫描不放在注册阶段，而由异步 `list()` 负责。

**源码事实：** `SkillProvider.list()` / `get()` 的职责与取消约定在 [`packages/skill/skill/src/index.ts:247-267`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/skill/src/index.ts#L247-L267)。

注册返回 Cordis disposer；插件卸载时 Provider 被移除，catalog cache 随之失效。

**源码事实：** 注册、保留 lifecycle signal、拒绝保留名的逻辑始于 [`packages/skill/skill/src/index.ts:380-414`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/skill/src/index.ts#L380-L414)。

### 第 2 步：Registry 按 scope 合并候选

Harness 不只有全局 Skill。

宿主插件落入 global layer，Agent preset 内挂载的插件落入该 Agent scope。

最近 scope 的同名项直接胜出；只有同一 layer 内的重复候选才比较 rank 和注册顺序。

**源码事实：** 分层规则写在 `SkillRegistry` 的类注释中，见 [`packages/skill/skill/src/index.ts:346-355`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/skill/src/index.ts#L346-L355)。

**设计解读：** 这让 preset 可以覆盖全局同名 Skill，却不需要修改全局目录，也不会把另一个 Agent 的专用知识泄漏进来。

### 第 3 步：`tool-skill` 把摘要放入下一 Step

`tool-skill` 在 `agent/pre-step` 读取当前 Agent 的 `cwd` 与 scope，再请求 catalog snapshot。

它不是启动时生成一次静态字符串，而是让 catalog 变更能在下一 Step 被看见。

**源码事实：** catalog 注入监听器和 snapshot 调用在 [`packages/skill/tool-skill/src/index.ts:210-225`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/tool-skill/src/index.ts#L210-L225)。

### 第 4 步：模型只凭摘要选 name

此时模型看见的应是路由信息，而不是所有正文。

这和搜索引擎先给标题摘要、点开后才取全文相似。

但类比到这里就停止：Skill catalog 受 scope、invocation policy 与 Provider 消歧约束，并不是公开网页索引。

### 第 5 步：工具再次确认策略并加载正文

工具先从 `list()` 找同名 summary，再确认它可被模型调用；之后才 `get()` 完整定义。

**源码事实：** 查 summary、加载 definition 的连续路径在 [`packages/skill/tool-skill/src/index.ts:128-145`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/tool-skill/src/index.ts#L128-L145)。

这次二次检查很重要。

catalog 生成与工具调用之间可能发生 HMR、文件变化或 Provider 失效。

旧 catalog 不是授权凭证。

### 第 6 步：正文被统一包装

`renderSkillContent()` 输出 `<skill_content>`，并携带资源基址提示。

directory、URL、opaque 三种资源基址的说明不同。

**源码事实：** canonical 包装和资源提示在 [`packages/skill/skill/src/index.ts:162-214`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/skill/src/index.ts#L162-L214)。

此时状态变化可以总结为：

```text
Provider candidate
  → Registry winning candidate
  → prompt-visible SkillSummary
  → tool invocation(name)
  → SkillDefinition(content)
  → model-visible instructions
```

## 7. 真实源码旅程二：委托一个可续子任务

现在追踪 `subagent({ description, prompt })`，配置为 continuable background。

### 第 1 步：插件装载时做能力协商

`tool-subagent` 读取 `backgroundMode`、`maxDepth` 与 Provider capability。

若配置了 numeric `maxDepth`，Provider 必须声明 `depthLimit`。

若选择 continuable，Provider 必须实现 `prepareContinuable`。

**源码事实：** 两个 fail-loud 检查在 [`packages/subagent/tool-subagent/src/index.ts:270-305`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent/src/index.ts#L270-L305)。

**设计解读：** 必然失败的组合在装载时暴露，比等模型第一次调用后才发现更可诊断。

### 第 2 步：执行时取得精确父 Agent

工具从 `exec.agent` 取得父级。

非 Agent 调用没有父子所有权，因此不能偷用 subagent 工具。

**源码事实：** 父级检查和 request 构造在 [`packages/subagent/tool-subagent/src/index.ts:366-385`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent/src/index.ts#L366-L385)。

### 第 3 步：运行模式分支

continuable background 调用 `ctx.subagents.startContinuable()`，立即返回 durable `subagentId`。

one-shot background 则通过 jobs 服务返回 `jobId`。

foreground 直接等待普通 `start()` 的结算。

**源码事实：** 三路分支在 [`packages/subagent/tool-subagent/src/index.ts:387-430`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent/src/index.ts#L387-L430)。

### 第 4 步：Runtime 预留 child 身份并计算深度

continuation manager 先检查父级仍可接纳，验证 `maxDepth`，计算 childDepth，再构造 descriptor seed。

**源码事实：** 这组顺序在 [`packages/subagent/subagent/src/continuation.ts:403-443`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/continuation.ts#L403-L443)。

深度不是仅靠本次 options。

恢复 child 时，以 durable session header 与 runtime option 的较大值为准，不能借“重启”把深度洗回零。

**源码事实：** `delegationDepthOf()` 的单调规则在 [`packages/subagent/subagent/src/depth.ts:18-36`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/depth.ts#L18-L36)。

### 第 5 步：消息进入 child inbox

初始 prompt 被接纳后，调用者拿到 `childId` 和 `messageId`。

后续 `send_message` 不是修改同一个 Tool result，而是给同一 child Session 投递下一条 FIFO Turn 输入。

**源码事实：** follow-up 的定义明确写着“next FIFO turn”，见 [`packages/subagent/subagent/src/continuation.ts:460-496`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/continuation.ts#L460-L496)。

### 第 6 步：child 安静后不一定立刻销毁

Activation 有三个派生状态：

- `running`：有活动 Turn 或待唤醒消息；
- `waiting`：自身安静，但仍拥有未结束后代；
- `settled`：自身安静且全部后代已释放。

**源码事实：** 状态语义在 [`packages/subagent/subagent/src/continuation.ts:151-159`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/continuation.ts#L151-L159)。

这避免父 child 在孙 child 仍运行时过早宣布完成。

### 第 7 步：结算通知回到父级

continuation manager 负责构造运行时结算通知。

父级空闲时用 `followup` 唤醒；父级忙碌时用 `steer`；父级正在关闭时只 inject，不重新唤醒。

**源码事实：** 路由分支在 [`packages/subagent/subagent/src/continuation.ts:1383-1445`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/continuation.ts#L1383-L1445)。

## 8. 三种委托模式怎样选择

| 判断维度 | foreground one-shot | background one-shot | continuable |
| --- | --- | --- | --- |
| 下一动作依赖结果 | 是 | 否 | 通常否 |
| 是否需要后续追问 | 否 | 否 | 是 |
| 立即返回 | 最终 output | job id | durable child id |
| 中间管理 | 调用取消 | `job_output` / `job_kill` | message / interrupt / settlement |
| 适合任务 | 短分析、结构化子结果 | 独立测试、一次扫描 | 多轮审查、长期研究 |

**教学推演：** 可以用时间轴做决策。

如果父级下一行代码必须消费结果，用 foreground。

如果只需稍后收集一次最终产物，用 background one-shot。

如果预计会说“继续看另一个文件”“根据刚才发现再验证”，用 continuable。

## 9. 失败、停止与安全边界

### 9.1 Skill 同名不是随便覆盖

同一 layer 内 Provider 名重复会抛错；最近 scope 覆盖全局项是显式分层规则。

不要把“允许 scoped override”理解成“任何重复都静默 last-wins”。

### 9.2 catalog 可能是不完整观察

Provider 可以返回 `complete: false`。

这表示当前候选可用，但不应当把观察当作稳定完成结果缓存。

**源码事实：** observation 的 `complete` 语义见 [`packages/skill/skill/src/index.ts:231-245`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/skill/src/index.ts#L231-L245)。

### 9.3 Subagent 深度是安全预算

`maxDepth` 必须是非负安全整数，`-0` 也被拒绝。

**源码事实：** 校验在 [`packages/subagent/subagent/src/depth.ts:38-50`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/depth.ts#L38-L50)。

它不仅防无限递归，也限制费用、并发和授权扩散。

### 9.4 background jobs 缺失时不能伪装成功

one-shot background 依赖 jobs 服务；未装载时直接报明确错误。

不能返回一个永远无法收集的假 id。

### 9.5 continuable 必须有持久化

冷恢复需要 Session persistence。

服务缺失时 fail loud，而不是悄悄把 continuable 降级成内存 one-shot。

**源码事实：** persistence 必需检查在 [`packages/subagent/subagent/src/continuation.ts:1469-1477`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/continuation.ts#L1469-L1477)。

### 9.6 只有精确父级能继续 child

冷恢复会核对 durable parent lineage；传入另一个活 Agent 不能“猜中 id”后接管 child。

**源码事实：** exact live parent 与 parentSession 检查在 [`packages/subagent/subagent/src/continuation.ts:1207-1224`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/continuation.ts#L1207-L1224)。

## 10. DeepSeek Harness 的选择与取舍

### 10.1 metadata 先行，而不是正文常驻

收益是上下文稳定、Skill 数量可增长。

代价是调用多一步，而且 catalog 与加载之间必须重新验证。

### 10.2 Provider 是能力接口，而不是一个裸 async function

收益是 in-process、ACP、Codex 等实现可替换。

代价是要显式声明 depth limit、continuable 等 capability，并处理装载时协商。

### 10.3 child identity durable，Activation 只是驻留时期

收益是 Session 可恢复，后续消息不依赖旧进程对象。

代价是实现必须维护 descriptor、lineage、persistence 和结算通知。

### 10.4 fail loud，不做隐式降级

若 continuable 配到不支持的 Provider，直接拒绝。

这牺牲“看起来能跑”的宽容，换来可预测语义。

## 11. Java 类比，以及类比失效处

### 11.1 Skill 像 Spring 的延迟 Bean 吗

局部相似：先有可发现元数据，真正需要时才构造或读取完整对象。

失效处：Skill 正文最终进入模型上下文，不是 JVM 内可调用服务；它携带 invocation policy 和资源解析提示。

### 11.2 Subagent 像 `CompletableFuture` 吗

foreground/background one-shot 在等待关系上相似。

失效处：continuable child 有 durable Session、父子授权和后续 Turn，不是一个只结算一次的 future。

### 11.3 Provider 像 Java SPI 吗

在“接口与实现分离、按名称选择”上相似。

失效处：Harness Provider 还参与 Cordis effect 生命周期、scope、能力协商和 AbortSignal 传播。

## 12. 可以带走的工程方法

### 方法一：发现对象与重对象分层

先暴露稳定摘要，再按标识加载重内容。

验证问题：不加载正文时，调用方是否仍足以做路由决定？

### 方法二：在装配阶段验证静态能力

配置要求 continuable，就在工具注册时检查 Provider 能力。

验证问题：某个失败是否与用户输入无关、在启动时已确定？若是，应尽早失败。

### 方法三：把 durable identity 与 live handle 分开

Session id 负责跨重启身份，Activation/handle 负责当前进程资源。

验证问题：进程重启后，授权和深度是否仍能从持久事实恢复？

## 13. 费曼复述与自测

请不看上文回答：

1. 为什么 Skill catalog 不能直接包含全部正文？
2. `SkillCandidate.locator` 为什么是 `unknown`，这保护了哪条边界？
3. foreground one-shot、background one-shot、continuable 分别返回什么？
4. 为什么恢复后的 child 不能把 `subagentDepth` 重置为零？
5. child 自己已经 idle 时，为什么仍可能处于 `waiting` 而不是 `settled`？

合格复述应包含以下主干：

> Registry 先按 scope 和 Provider 规则产生轻量 catalog；模型选中 name 后，工具重新验证策略并按需加载正文。委托则从精确父 Agent 出发，经过 Provider 能力和深度检查，进入 one-shot 或 continuable 生命周期；durable child id、Session lineage 和持久化保证后续消息与恢复仍受父级授权约束。

## 14. 三级练习

### Level 1：只读定位

在源码中找出：

- catalog 注入发生在哪个 `agent/pre-step` listener；
- continuable 能力在何处装载时检查；
- child 结算后父级空闲与忙碌分别调用什么。

写出路径、符号和行号，不改代码。

### Level 2：设计题

为“代码审查子 Agent”写一页设计：

- 选择 one-shot 还是 continuable；
- 定义输入、结构化输出和 maxDepth；
- 说明父级取消、用户 interrupt、Provider 错误的语义；
- 说明哪些知识应做成 Skill，而不是塞进 child prompt。

### Level 3：最小实现

实现一个测试 Provider：

- 支持 foreground one-shot；
- 显式声明是否支持 depth limit；
- 为 pre-abort、深度超限、成功输出各写测试；
- 再决定是否增加 continuable，不能用内存 id 假装 durable。

## 15. 常见误区与第一遍可以忽略什么

- 不要把 Skill 当 Tool：Skill 给指令，Tool 执行动作。
- 不要把 background job 当 continuable child：job 是一次任务，child 是可继续会话。
- 不要用日志里的 child 名称做授权：授权基于精确 live parent 与 durable lineage。
- 第一遍可以忽略 continuation manager 的全部竞态细节，但不能忽略 Activation 与 Session 的区别。
- 第一遍可以不研究每个 Provider 实现，但必须确认 capability 是 Runtime 的统一边界。

## 16. 小结与下一章钩子

本章把 Agent 的两种“变强”拆开了：

- Skill 让同一个 Agent 在需要时获得知识；
- Subagent 让另一个执行主体接手工作；
- 两者都通过 Registry、scope、effect 和 fail-loud 规则保持可组合；
- 真正的安全边界来自 invocation policy、父子身份、深度、取消与持久化，而不是工具描述里的自然语言。

但还有一个问题没有回答：

> 这些 Skill Provider、Subagent Provider、jobs 和 persistence，究竟由谁决定装进当前这次 `dsh` 运行？

下一章进入 CLI、Profile 与 Patch，追踪一条命令怎样变成最终 Cordis 插件树。
