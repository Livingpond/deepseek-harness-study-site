---
title: "DeepSeek Harness 源码学习"
description: "一切皆插件：从 Cordis 组合、Agent 循环、事件账本到 Web 产品界面的完整中文源码课程。"
template: splash
hero:
  tagline: 基于固定提交 47f9438 的 12 章中文源码课程。先看系统地图，再沿一条真实请求追到模型、工具、日志与界面。
  actions:
    - text: 开始第一章
      link: /chapters/01-architecture-boot/
      icon: right-arrow
      variant: primary
    - text: 查看源码证据
      link: /reading-guide/
      icon: open-book
    - text: 去 OpenCode 对照学习
      link: https://opencode-study.korah-group.top
      icon: external
---

<div class="baseline-strip" role="note">
  <span>源码基线</span>
  <code>47f943859bef60e4160492346772ded9b24f765a</code>
  <strong>Developer Preview · dsh 0.1.0-rc.5</strong>
</div>

## 先抓住两条不变式

<div class="principle-grid">
  <article>
    <span class="eyebrow">COMPOSITION</span>
    <h3>一切皆插件</h3>
    <p>模型适配器、工具注册表、Session 日志、Agent Loop 都是 Cordis 插件。扩展优先挂接服务与事件，不直接修改循环。</p>
  </article>
  <article>
    <span class="eyebrow">OBSERVABILITY</span>
    <h3>模型可见，必须入账</h3>
    <p>发送给模型的内容必须能从 Session Event Log 重建。恢复、分叉、转录、遥测与界面都读同一条事实流。</p>
  </article>
</div>

## 一条请求怎样穿过系统

```text
dsh profile / Web 输入
        │
        ▼
Agent Inbox ──► turn/start ──► Prompt + Tools 组装
        │                              │
        │                              ▼
        │                     LLM 流式响应
        │                              │
        │               assistant/chunk + tool/call
        │                              │
        │                              ▼
        └──── Session Event Log ◄── Tool Pipeline
                       │
             持久化 / 恢复 / 投影 / UI
```

## 完整课程

<div class="course-grid">
  <a href="/chapters/01-architecture-boot/"><b>01</b><span><strong>项目地图与启动</strong><small>从 dsh 命令追到插件树</small></span></a>
  <a href="/chapters/02-cordis-plugin-kernel/"><b>02</b><span><strong>Cordis 插件内核</strong><small>Context、Service、Effect、Waterfall</small></span></a>
  <a href="/chapters/03-agent-loop/"><b>03</b><span><strong>Agent 主循环</strong><small>Turn、Step、Inbox 与停止条件</small></span></a>
  <a href="/chapters/04-session-ledger/"><b>04</b><span><strong>Session 事件账本</strong><small>唯一事实源与消息投影</small></span></a>
  <a href="/chapters/05-llm-streaming/"><b>05</b><span><strong>LLM 流式适配</strong><small>路由、准备、SSE 与错误归一</small></span></a>
  <a href="/chapters/06-tool-pipeline/"><b>06</b><span><strong>工具执行管线</strong><small>Schema、审批、调度与结果</small></span></a>
  <a href="/chapters/07-prompt-context/"><b>07</b><span><strong>Prompt 与上下文</strong><small>协作式组装与日志闭环</small></span></a>
  <a href="/chapters/08-persistence-recovery/"><b>08</b><span><strong>持久化与恢复</strong><small>Write-behind、JSONL、SQLite</small></span></a>
  <a href="/chapters/09-skills-subagents/"><b>09</b><span><strong>Skills 与 Subagents</strong><small>发现、装载、委托与生命周期</small></span></a>
  <a href="/chapters/10-cli-profiles/"><b>10</b><span><strong>CLI 与 Profiles</strong><small>Bundle、Patch 与无头运行</small></span></a>
  <a href="/chapters/11-product-surfaces/"><b>11</b><span><strong>Web / TUI 界面</strong><small>薄入口与事件投影</small></span></a>
  <a href="/chapters/12-extension-testing/"><b>12</b><span><strong>扩展、测试与实战</strong><small>新增能力的最小闭环</small></span></a>
</div>

## 三条阅读路线

| 目标 | 顺序 | 最终能做什么 |
| --- | --- | --- |
| 快速理解架构 | 01 → 02 → 03 → 04 | 讲清插件树、循环和事实账本的关系 |
| 开发模型能力 | 03 → 05 → 06 → 07 → 09 | 新增模型、工具、Skill 或 Subagent Provider |
| 参与项目开发 | 01 → 08 → 10 → 11 → 12 | 能启动、调试、扩展并用真实入口验证 |

> 本站与 [OpenCode Agent 源码学习](https://opencode-study.korah-group.top) 独立构建、独立发布。两站只做跨站跳转，内容与部署互不覆盖。
