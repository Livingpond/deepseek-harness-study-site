---
title: "09. Skills 与 Subagents"
description: "理解按需知识加载、Provider 排序、前后台委托与可续子会话。"
---

# 09. Skills 与 Subagents

## 0. 本章学习目标

- 区分 Skill metadata、content 和 invocation policy。
- 解释 Skill Provider 的发现与优先级。
- 区分 one-shot、background job 与 continuable child。
- 定位深度限制、能力协商和取消路径。

## 1. 一句话讲明白

Skill 给当前 Agent 按需加载规则与资源；Subagent 把任务交给另一个执行主体，并用 Provider 能力与 durable child identity 管理生命周期。

## 2. 两条不同扩展线

```text
SkillRegistry                       SubagentRuntime
  provider → catalog                  provider → run
  summary → model sees name           one-shot / continuable
  tool loads full content             foreground / background
  same Agent, more knowledge           another execution subject
```

不要把两者混为“插件”。Skill 不自动启动另一个 Agent；Subagent 也不等于加载一份 Markdown。

## 3. Skill 的发现优先级

`SkillRegistry` 收集多个 Provider 的 candidate，验证名称、调用策略与资源基址，再按 rank、provider、稳定 code-point 顺序消歧。核心类型与 Registry 在 [`packages/skill/skill/src/index.ts:34-147`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/skill/src/index.ts#L34-L147) 和 [`357-560`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/skill/src/index.ts#L357-L560)。

`tool-skill` 只把精简 catalog 放进模型上下文；模型调用 skill 工具后才读取完整内容。它还监听 `agent/pre-step`，确保 catalog 更新能在下一 Step 到达模型，见 [`packages/skill/tool-skill/src/index.ts:74-225`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/tool-skill/src/index.ts#L74-L225)。

## 4. Subagent 的三种运行体验

| 模式 | 返回给父 Agent | 生命周期 |
| --- | --- | --- |
| foreground one-shot | 等待并返回 output | 一次任务完成即结算 |
| background one-shot | 立即返回 job id | 用 `job_output` / `job_kill` 管理 |
| continuable | 立即返回 durable subagent id | 子会话可在后续 Turn 接收消息 |

工具插件根据配置和 Provider capability 动态注册，见 [`packages/subagent/tool-subagent/src/index.ts:267-305`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent/src/index.ts#L267-L305)。真正分支执行在 [`369-430`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent/src/index.ts#L369-L430)。

## 5. Provider 不是随便一个 async function

`SubagentRuntime.start()` 先确认 Provider 存在、能力满足、深度合法、output schema 合法，再生成不可变 descriptor 并观察 run，见 [`packages/subagent/subagent/src/index.ts:404-425`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/index.ts#L404-L425)。Provider 可指向进程内 child、ACP、Codex 或 Claude Code；父工具不需要知道具体驱动。

## 6. 失败路径

- 同名 Skill/Provider 重复注册：fail loud。
- 配置 numeric maxDepth，但 Provider 无法执行深度限制：装载时失败。
- continuable 模式配到不支持 `prepareContinuable` 的 Provider：装载时失败。
- 非 Agent 调用 subagent tool：缺少父级所有权，拒绝。
- background 需要 jobs 服务但未装载：执行前报明确错误。
- 调用者取消：signal 传到启动、持久化读取与 run。

## 7. 可迁移方法与练习

- **元数据先行、正文按需加载。** 控制上下文体积。
- **能力协商尽量在装载时完成。** 不把必然失败拖到第一次用户调用。
- **父子关系 durable，活对象 ownership 明确。**

练习：为“代码审查子 Agent”选择 one-shot 或 continuable，写出 output schema、深度策略、父上下文继承与取消语义。下一章回到产品入口：Profile 和 Patch 怎样决定这些插件究竟被装进哪个 `dsh`？
