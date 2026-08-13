---
title: "02. Cordis 插件内核"
description: "理解 Context、Service、Effect、Scope 与 Waterfall。"
---

# 02. Cordis 插件内核

## 0. 本章学习目标

- 解释 `Context` 为什么同时是依赖容器和作用域。
- 区分普通事件、串行事件和 Waterfall。
- 说明 `ctx.effect()` 返回 disposer 的工程意义。
- 判断新行为应注册服务、事件还是插件。

## 1. 一句话讲明白

Cordis 用可分层的 `Context` 解析服务，用 Fiber 管理插件生命周期，用可撤销 Effect 承载注册，再用事件把插件连接起来。

中央问题：**“一切皆插件”靠什么机制避免变成一堆全局回调？**

## 2. 位置图

```text
Context（读取服务 + 当前作用域）
 ├─ Registry / Service     谁提供能力
 ├─ Events                 谁观察或拦截行为
 └─ Fiber / Effect         谁拥有注册、何时撤销
      └─ child Context     extend / isolate / intercept
```

[`vendor/cordis/src/context.ts:36-83`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/context.ts#L36-L83) 证明 `Context` 是 Proxy：普通属性读取经过服务解析器，构造时安装 registry、events、logger 等内置服务。

## 3. 最小机制

```ts
export function apply(ctx: Context) {
  const dispose = ctx.effect(() => {
    registry.set('name', value)
    return () => registry.delete('name')
  })
  ctx.on('event', listener)
}
```

核心不是“执行一次 apply”，而是**注册与所有者生命周期绑定**。插件卸载时，effect 的 disposer 逆向撤销；这也是 HMR 能安全替换插件的前提。

## 4. 四种连接方式

| 机制 | 适合 | 调用语义 |
| --- | --- | --- |
| Service | 稳定能力接口 | 从 `ctx.xxx` 解析当前作用域实现 |
| 普通事件 | 广播事实 | 多监听器观察，不改变结果 |
| Serial | 有顺序的通知 | 逐个等待，无 `next()` |
| Waterfall | 策略/拦截链 | 监听器必须调用 `next()` 才委托下一层 |

上游在 [`docs/architecture.md:53-60`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md#L53-L60) 把事件分为 durable Session event、live Agent event 和 capability event。Waterfall 的短路语义见 [`docs/cordis-primer.md:28-34`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/cordis-primer.md#L28-L34)。

## 5. Scope 不是命名空间装饰

`Context.extend()` 创建原型继承的子上下文，不改父级；`Context.isolate(name)` 为指定服务创建独立解析标签，见 [`vendor/cordis/src/context.ts:90-124`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/context.ts#L90-L124)。所以同一进程里不同 Agent 能拥有不同 Tool/Prompt/Skill 注册，而不复制整个运行时。

Java 类比：它有点像子 `ApplicationContext` 加 Bean Scope，但 Cordis 的事件分发也会读取作用域载体；不能把它简化为依赖注入。

## 6. 失败路径

- 重名 Provider 在 effect 内抛错，已 yield 的 rollback 立即撤销。
- Waterfall 监听器忘记 `next()` 会有意短路，可能让调用永远到不了 Provider。
- 插件把注册写成模块级 `Map.set()`，Fiber 无法回收，HMR 后会泄漏旧实现。
- 对一个 Agent 应隔离的 Service 若注册到 root，会把能力暴露给所有 Agent。

这些不是推测：上游全局约定明确要求“registrations are effects”，并要求 Waterfall 调用 `next()`，见 [`AGENTS.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/AGENTS.md#L81-L90)。

## 7. 可迁移方法

- **注册即资源。** 验证：每次 `register()` 是否返回并实际绑定 disposer？
- **把策略做成 Around/Waterfall，而非散落条件。** 验证：超时、审批、重试能否在不 import 核心循环的情况下包裹执行？
- **作用域和所有权一起设计。** 验证：一个 Session 卸载后，它注册的工具是否仍能被其他 Session 看到？

## 8. 复述与下一问

请用“插座—电器—断路器”类比解释 Service、Plugin 和 Effect，然后立即换回准确标识：`Context`、`ctx.plugin()`、`ctx.effect()`。

下一章进入 `ReactLoopAgent`：**当输入到达后，插件内核怎样驱动一个可停止、可续步的 Agent Loop？**
