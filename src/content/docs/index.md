---
title: "DeepSeek Harness 源码学习"
description: "一切皆插件：从 Cordis 组合、Agent 循环、事件账本到 Web 产品界面的完整中文源码课程。"
template: splash
---

<section class="dh-hero">
  <div class="dh-hero-copy">
    <p class="hero-kicker"><span></span> DEEPSEEK HARNESS · 源码精读</p>
    <h1>从一条请求出发，读懂<br/><em>Agent 系统如何运转</em></h1>
    <p class="hero-summary">不是 README 翻译，也不是 API 罗列。这是一套基于固定源码提交的 12 章中文课程：先建立系统地图，再沿真实调用链追到模型、工具、事件账本和产品界面。</p>
    <div class="hero-actions">
      <a class="hero-action primary" href="/deepseek-harness-study-site/chapters/01-architecture-boot/">开始第一章 <span aria-hidden="true">→</span></a>
      <a class="hero-action secondary" href="/deepseek-harness-study-site/reading-guide/">阅读说明与证据</a>
    </div>
    <dl class="hero-stats" aria-label="课程概况">
      <div><dt>12</dt><dd>章完整课程</dd></div>
      <div><dt>47f9438</dt><dd>固定源码基线</dd></div>
      <div><dt>4</dt><dd>个学习模块</dd></div>
    </dl>
  </div>
  <figure class="hero-visual">
    <img src="/deepseek-harness-study-site/og.png" alt="DeepSeek Harness 源码学习路线总览：从入口、Agent 循环、模型与工具到事件账本" width="1734" height="909" loading="eager" decoding="async" />
    <figcaption><span>课程总览</span> 先看全景，再进源码</figcaption>
  </figure>
</section>

<div class="baseline-strip" role="note">
  <span>源码基线</span>
  <code>47f943859bef60e4160492346772ded9b24f765a</code>
  <strong>Developer Preview · dsh 0.1.0-rc.5</strong>
</div>

<section class="home-section section-intro">
  <p class="section-label">01 · MENTAL MODEL</p>
  <h2>先抓住两条不变式</h2>
  <p class="section-lead">后面的组件很多，但判断设计是否合理只需要反复检查这两件事。</p>
</section>

<div class="principle-grid">
  <article>
    <span class="principle-number">01</span>
    <div>
      <span class="eyebrow">COMPOSITION</span>
      <h3>一切皆插件</h3>
      <p>模型适配器、工具注册表、Session 日志、Agent Loop 都是 Cordis 插件。扩展优先挂接服务与事件，不直接修改循环。</p>
    </div>
  </article>
  <article>
    <span class="principle-number">02</span>
    <div>
      <span class="eyebrow">OBSERVABILITY</span>
      <h3>模型可见，必须入账</h3>
      <p>发送给模型的内容必须能从 Session Event Log 重建。恢复、分叉、转录、遥测与界面都读同一条事实流。</p>
    </div>
  </article>
</div>

<section class="home-section section-intro flow-heading">
  <p class="section-label">02 · REQUEST FLOW</p>
  <h2>一条请求怎样穿过系统</h2>
  <p class="section-lead">输入不会直接“扔给模型”。它会被 Inbox 接收、组装上下文、流式执行，再把每一步写入事件账本。</p>
</section>

<div class="request-flow" role="img" aria-label="请求从 CLI 或 Web 输入，经过 Agent Inbox、上下文组装、模型与工具循环，最终写入 Session 事件账本并投影到界面">
  <div class="flow-node source"><span>入口</span><strong>CLI / Web</strong><small>用户输入</small></div>
  <span class="flow-arrow" aria-hidden="true">→</span>
  <div class="flow-node"><span>接收</span><strong>Agent Inbox</strong><small>turn / start</small></div>
  <span class="flow-arrow" aria-hidden="true">→</span>
  <div class="flow-node active"><span>组装</span><strong>Prompt + Tools</strong><small>上下文与能力</small></div>
  <span class="flow-arrow" aria-hidden="true">→</span>
  <div class="flow-node"><span>执行</span><strong>LLM ↔ Tool</strong><small>流式循环</small></div>
  <span class="flow-arrow" aria-hidden="true">→</span>
  <div class="flow-node ledger"><span>事实源</span><strong>Event Log</strong><small>持久化 / 恢复 / UI</small></div>
</div>

<section class="home-section course-heading">
  <div class="section-intro">
    <p class="section-label">03 · CURRICULUM</p>
    <h2>12 章，按四个模块读完</h2>
    <p class="section-lead">每章都从“本章学习目标”和“一句话讲明白”开始，再进入源码证据与调用链。</p>
  </div>
  <a class="text-link" href="/deepseek-harness-study-site/reading-guide/">课程怎么读 <span aria-hidden="true">→</span></a>
</section>

<div class="module-list">
  <section class="course-module">
    <header><span>MODULE A</span><h3>看懂骨架</h3><p>入口、插件内核与主循环</p></header>
    <div class="course-grid">
      <a href="/deepseek-harness-study-site/chapters/01-architecture-boot/"><b>01</b><span><strong>项目地图与启动</strong><small>从 dsh 命令追到插件树</small></span><i aria-hidden="true">↗</i></a>
      <a href="/deepseek-harness-study-site/chapters/02-cordis-plugin-kernel/"><b>02</b><span><strong>Cordis 插件内核</strong><small>Context、Service、Effect、Waterfall</small></span><i aria-hidden="true">↗</i></a>
      <a href="/deepseek-harness-study-site/chapters/03-agent-loop/"><b>03</b><span><strong>Agent 主循环</strong><small>Turn、Step、Inbox 与停止条件</small></span><i aria-hidden="true">↗</i></a>
    </div>
  </section>
  <section class="course-module">
    <header><span>MODULE B</span><h3>追踪一次执行</h3><p>事件账本、模型流与工具管线</p></header>
    <div class="course-grid">
      <a href="/deepseek-harness-study-site/chapters/04-session-ledger/"><b>04</b><span><strong>Session 事件账本</strong><small>唯一事实源与消息投影</small></span><i aria-hidden="true">↗</i></a>
      <a href="/deepseek-harness-study-site/chapters/05-llm-streaming/"><b>05</b><span><strong>LLM 流式适配</strong><small>路由、准备、SSE 与错误归一</small></span><i aria-hidden="true">↗</i></a>
      <a href="/deepseek-harness-study-site/chapters/06-tool-pipeline/"><b>06</b><span><strong>工具执行管线</strong><small>Schema、审批、调度与结果</small></span><i aria-hidden="true">↗</i></a>
    </div>
  </section>
  <section class="course-module">
    <header><span>MODULE C</span><h3>理解上下文与扩展</h3><p>Prompt、持久化和委托机制</p></header>
    <div class="course-grid">
      <a href="/deepseek-harness-study-site/chapters/07-prompt-context/"><b>07</b><span><strong>Prompt 与上下文</strong><small>协作式组装与日志闭环</small></span><i aria-hidden="true">↗</i></a>
      <a href="/deepseek-harness-study-site/chapters/08-persistence-recovery/"><b>08</b><span><strong>持久化与恢复</strong><small>Write-behind、JSONL、SQLite</small></span><i aria-hidden="true">↗</i></a>
      <a href="/deepseek-harness-study-site/chapters/09-skills-subagents/"><b>09</b><span><strong>Skills 与 Subagents</strong><small>发现、装载、委托与生命周期</small></span><i aria-hidden="true">↗</i></a>
    </div>
  </section>
  <section class="course-module">
    <header><span>MODULE D</span><h3>落到真实产品</h3><p>命令行、界面与扩展实战</p></header>
    <div class="course-grid">
      <a href="/deepseek-harness-study-site/chapters/10-cli-profiles/"><b>10</b><span><strong>CLI 与 Profiles</strong><small>Bundle、Patch 与无头运行</small></span><i aria-hidden="true">↗</i></a>
      <a href="/deepseek-harness-study-site/chapters/11-product-surfaces/"><b>11</b><span><strong>Web / TUI 界面</strong><small>薄入口与事件投影</small></span><i aria-hidden="true">↗</i></a>
      <a href="/deepseek-harness-study-site/chapters/12-extension-testing/"><b>12</b><span><strong>扩展、测试与实战</strong><small>新增能力的最小闭环</small></span><i aria-hidden="true">↗</i></a>
    </div>
  </section>
</div>

<section class="route-section">
  <div class="section-intro">
    <p class="section-label">04 · READING PATH</p>
    <h2>不用拘泥于顺序</h2>
    <p class="section-lead">按你的目标选择最短路线；需要补背景时，再回到相邻章节。</p>
  </div>
  <div class="route-grid">
    <article><span>架构速读</span><h3>01 → 02 → 03 → 04</h3><p>讲清插件树、Agent 循环和事实账本的关系。</p></article>
    <article><span>开发模型能力</span><h3>03 → 05 → 06 → 07 → 09</h3><p>新增模型、工具、Skill 或 Subagent Provider。</p></article>
    <article><span>参与项目开发</span><h3>01 → 08 → 10 → 11 → 12</h3><p>启动、调试、扩展，并用真实入口完成验证。</p></article>
  </div>
</section>

<aside class="cross-site-note">
  <div><span>对照学习</span><h2>还在读 OpenCode？</h2><p>两套站点独立构建、独立发布，只通过链接互相跳转，内容和部署不会互相覆盖。</p></div>
  <a href="https://opencode-study.korah-group.top">前往 OpenCode 源码学习 <span aria-hidden="true">↗</span></a>
</aside>
