---
title: 术语表
description: DeepSeek Harness、Cordis 与 Agent 架构核心术语。
---

# 术语表

| 术语 | 本站定义 | 不要混淆 |
| --- | --- | --- |
| Harness | 组合模型、工具、上下文、持久化与产品 Surface 的 Agent 运行框架 | 不等于单个 Agent 或模型 SDK |
| Cordis | 插件、服务、作用域、事件与 Effect 生命周期内核 | 不只是 DI 容器 |
| Plugin | 挂到 Cordis Context、贡献服务/事件/Effect 的模块 | 不等于 Skill |
| Effect | 与插件 Fiber 绑定、可撤销的注册或资源 | 不等于任意副作用 |
| Waterfall | 必须显式调用 `next()` 才委托下一层的拦截链 | 不等于广播事件 |
| Profile | 一组按顺序堆叠的 Bundle 与用户 Patch | 不等于 Agent Preset |
| Bundle | 可分发的 Cordis config rows 与代码层 | 不等于 npm monorepo package group |
| Agent Preset | 按 Session 组合 Agent 能力的配置 | 不决定整个 app Surface |
| Turn | 从输入处理尝试开始到不再欠工作，可含 0..N 个 Step | 不等于一次 LLM 请求 |
| Step | 一次模型请求及其工具调用 | 不等于一条消息 |
| Session Event | append-only、可持久化的事实 | 不等于 live Agent event |
| Projection | 从事件日志派生的只读视图 | 不应成为第二事实源 |
| Capability seam | Definition、Provider、Consumer 三个角色组成的可替换能力 | 只有 interface 不算完整 seam |
| Skill | 可发现、可按需加载的指令与资源 | 不会自动创建子 Agent |
| Subagent | 被 Provider 驱动的另一个执行主体 | 不等于后台线程 |
| Surface | CLI、Headless、Web、TUI、ACP 等产品入口或呈现面 | 不拥有核心事实 |
