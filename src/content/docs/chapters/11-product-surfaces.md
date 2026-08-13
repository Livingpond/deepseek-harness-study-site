---
title: "11. Web / TUI 产品界面"
description: "从极薄入口到 Conversation Node、Tool Card 与 Host/Client 分层。"
---

# 11. Web / TUI 产品界面

## 0. 本章学习目标

- 区分 Host、Client runtime 与 UI plugin。
- 解释 Web 入口为什么只有十行。
- 说明 Session Event 怎样变成 Conversation Node。
- 理解 Tool presentation 与 UI renderer 的职责边界。

## 1. 一句话讲明白

产品界面不复制 Agent 状态机；Host 暴露会话能力，Client 从事件构造投影，UI 插件再把具名 Node 和 Tool presentation 填进可组合 Slot。

## 2. 分层地图

```text
Host plugins                   Browser client plugins
sessions / api / webserver ─► protocol / object services
                                      │
                                      ▼
                          conversation projection
                                      │
                     ┌────────────────┴──────────────┐
                     ▼                               ▼
              Chat Node renderers              details / settings
                     │
              Tool generic/terminal/diff cards
```

`apps/web/src/main.ts` 只有寻找 `#root` 并启动 `AppWebEntry`，见 [`apps/web/src/main.ts:1-10`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/web/src/main.ts#L1-L10)。装载、module table、AppRoot gate 和插件组合都在 `@deepseek-ai/dsh-client-web`。

## 3. Conversation 不是硬编码消息联合

`ui-conversation` 的 Chat business rows 是独立 registry contribution。插件声明合并自己的 `ChatNodeDataMap` key，注册 `ConversationNodeDefinition` 与同 key renderer，不修改中央 switch。这个契约在 [`packages/client/ui-conversation/README.md:15-25`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/client/ui-conversation/README.md#L15-L25) 有明确说明。

因此新增 `/goal` 命令输入、Skill 行或 produced files，都能以插件加入，卸载后对应 UI 消失，而 Session 核心不用认识这些产品行。

## 4. Tool Card 从哪来

Tool 层在定义时给出 presentation intent；Client runtime 投影 tool call tree；`ui-tool` 再按 name/key 分派 generic、terminal、diff、read、search、web 等 renderer。UI 不解析原始 result 字符串猜“这大概是 diff”。

## 5. TUI 与 Web 的共同边界

二者共享 Agent/Session/Tool 语义和 durable events，但拥有不同 presentation adapter。TUI 关心终端宽度、折叠和键盘焦点；Web 关心响应式布局、拖放、lightbox 与可点击卡片。正确复用点是领域投影与 Tool presentation，不是强行共享每个视图组件。

## 6. 失败与性能路径

- 缺少 `#root`：入口立即抛错，不静默白屏。
- 未注册某个 Chat Node renderer：该插件能力不呈现，核心日志仍完整。
- Tool 专用 renderer 缺失：details 可保留 raw-result fallback，但主聊天不猜测类型。
- 长 Session：流式 tail 与历史分组分离，投影缓存按引用不变跳过无关事件。
- 插件卸载：Effect 撤销 renderer/slot，避免 HMR 后重复行。

## 7. 可迁移方法

- **界面读投影，不读活核心对象。**
- **业务行用 registry + keyed renderer 扩展。**
- **数据所有者决定最小 UI 字段。** 不把整个 Session 对象跨 Host/Client 边界搬运。

## 8. 练习与下一问

设计一种 `review/decision` Chat Node：列出 durable event、projection data、renderer props 和缺失 renderer 时的行为。最后一章把全系统重新组装：**怎样新增一个能力，并用最小但真实的测试证明它从配置到用户输出都工作？**
