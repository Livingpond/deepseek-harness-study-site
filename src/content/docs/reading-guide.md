---
title: 阅读说明与证据
description: 如何区分源码事实、设计解读与教学推演。
sidebar:
  order: 2
---

# 阅读说明与证据

## 0. 本页学习目标

- 确认本站对应的精确源码版本。
- 看懂正文里的固定提交链接与行号。
- 区分源码事实、设计解读和教学推演。

## 1. 一句话讲明白

每个重要判断都能回到固定提交 `47f943859bef60e4160492346772ded9b24f765a` 的真实源码，而不是依赖会漂移的 `master` 或 README 摘要。

## 证据等级

| 标记 | 含义 | 验证方法 |
| --- | --- | --- |
| **源码事实** | 代码、类型或配置直接表达的行为 | 打开固定 commit 的源码链接，核对行号与符号 |
| **设计解读** | 从依赖方向、生命周期或失败策略得出的工程判断 | 同时检查调用方、被调用方与测试 |
| **教学推演** | 为理解而构造的典型输入路径 | 不声称是实际录制，按章节命令自行运行 |

## 版本与状态

- 上游仓库：[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)
- 固定提交：[`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)
- 包版本：`0.1.0-rc.5`
- 状态：Developer Preview；上游明确提示未来会有破坏性变更。

## 阅读约定

正文先给全局地图，再只引入下一段源码所需的 TypeScript/Cordis 概念。Java 类比只帮助定位：Cordis `Context` 不等于 Spring `ApplicationContext`，Effect 也不等于普通 Bean 生命周期；真正行为以源码为准。

## 本地复核

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout 47f943859bef60e4160492346772ded9b24f765a
pnpm install
pnpm run build
```

上游要求 Node `^22.19.0 || >=24.0.0` 与 pnpm `11.7.0`。真实模型路径还需要 `DEEPSEEK_API_KEY`；没有密钥时，优先运行单元测试与 keyless snapshot。
