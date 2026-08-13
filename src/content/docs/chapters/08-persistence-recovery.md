---
title: "08. 持久化与恢复"
description: "从 Session 事件到 write-behind、flush、JSONL/SQLite 与格式拒绝。"
---

# 08. 持久化与恢复

## 0. 本章学习目标

- 区分 Session 核心与 Persistence 插件。
- 说明 write-behind、batch、flush 和 shutdown drain。
- 比较 JSONL 与 SQLite Provider 的角色。
- 理解损坏、撕裂写与格式版本拒绝。

## 1. 一句话讲明白

Session 在内存里同步提交事件；Persistence Coordinator 观察已提交事件并异步批写，显式 flush 与 shutdown drain 划出持久化完成边界。

## 2. 能力分层

```text
Session.append()               同步事实提交
      │ session/event
      ▼
PersistenceCoordinator         排序、batch、flush、恢复协调
      │ PersistenceBackend
      ├─ JSONL (+ Zstd / torn marker)
      └─ SQLite (schema version)
```

Session 核心注释明确声明“Persistence is a plugin concern”，见 [`packages/core/session/src/index.ts:1-4`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/index.ts#L1-L4)。因此没有持久化 Provider 时，Agent 仍可运行，只是不具备重启恢复。

## 3. 真实接线

`PersistenceCoordinator` 监听四个生命周期点：`session/created` 建立状态，`session/event` 排队写入，`session/flush` 等待持久化，`session/disposed` 退休状态，见 [`packages/session/session-persistence/src/coordinator.ts:1090-1133`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/session/session-persistence/src/coordinator.ts#L1090-L1133)。

默认 batch 最大延迟为 200ms，是吞吐与风险窗口的明确配置，不是隐藏魔数。shutdown disposer 会持续等待所有 write chain settle，直到 `chains.size === 0`。

## 4. 恢复不是“读 JSON 然后 new Session”

Coordinator 必须校验：

- header 与 session id 一致；
- `SESSION_FORMAT_VERSION` 受当前构建支持；
- seq 连续、event payload 可接受；
- seed/prefix/suffix 关系合法；
- torn marker 或 backend corruption 明确分类。

错误类型 `SessionPersistenceCorruptionError` 与 `SessionFormatUnsupportedError` 位于 [`coordinator.ts:36-84`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/session/session-persistence/src/coordinator.ts#L36-L84)。上游处于预发布阶段，明确拒绝旧磁盘格式而非维护兼容 shim。

## 5. JSONL 与 SQLite 怎么选

| Provider | 优势 | 约束 |
| --- | --- | --- |
| JSONL | 顺序事实直观、便于逐条恢复、可压缩 | 需要处理撕裂尾部与原子发布 |
| SQLite | 查询、索引、事务与并发读取更成熟 | 有显式 schema version 与迁移责任 |

两者实现相同 `PersistenceBackend`；业务插件不能 import 某个具体后端。Provider swap 因此不改 Agent Loop。

## 6. 失败边界

- append 后 observer 报错：事件仍在内存日志，持久层后续仍可观察。
- backend 写失败：write chain 保留 rejection，flush/shutdown 暴露错误。
- 进程强杀落在 batch 窗口：恢复逻辑只接受已可靠发布的前缀。
- 新格式被旧程序读取：明确拒绝，不做“尽量加载”。

## 7. 可迁移方法

- **同步事实提交与异步 I/O 分开，但提供显式 flush。**
- **恢复验证必须比正常写路径更严格。** durable/file 边界不能只信 TypeScript。
- **存储格式版本与业务版本分开。**

## 8. 练习与下一问

画出“用户点击 Stop 后立即退出程序”的持久化时序：哪个组件 append cancel，哪个组件 flush，shutdown 等什么。下一章进入高层组合：**Skill 怎样按需装载知识，Subagent 又怎样把任务交给另一个执行主体？**
