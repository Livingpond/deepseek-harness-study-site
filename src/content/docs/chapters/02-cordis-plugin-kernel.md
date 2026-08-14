---
title: "02. Cordis 插件内核"
description: "用一个可热卸载的工具插件，拆开 Context、Service、Fiber、Effect 与事件分发。"
---

# 02. Cordis 插件内核

> 本章源码基线：[`deepseek-ai/deepseek-harness@47f9438`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)。文中用“源码事实 / 设计解读 / 教学推演”标注证据层次。

## 0. 本章学习目标

完成本章后，你应该能够：

- 画出 `Context → Registry → Fiber → Effect` 的所有权关系。
- 解释 `ctx.tools` 这类属性为什么不是普通对象字段。
- 分清 Service 直调、`emit`、`serial`、`waterfall` 的控制权。
- 沿一个插件的装载、等待、激活、卸载走完 Fiber 状态变化。
- 识别 inactive effect、漏调 `next()`、错误作用域和模块级副作用四类故障。
- 用合格边界说明 Cordis 与 Spring `ApplicationContext` 的相似处和不同处。

## 1. 一句话讲明白

**Cordis 把每个插件实例放进一个 Fiber：Context 负责解析当前作用域的 Service，Effect 记录插件拥有的副作用，事件负责插件间协作，Fiber 负责何时激活与何时反向清理。**

上一章已经让 `dsh web` 启动，但我们把 Cordis 当成了黑盒。

本章继续一个具体场景：团队给单个 Agent 挂载 `repo-search` 插件，它注册搜索能力、监听请求事件并打开文件 watcher；配置热更新时插件卸载，旧 Service、监听器和 watcher 必须一起消失，另一个 Agent 不能看见这份私有能力。

中央问题是：**怎样让“一切皆插件”仍然有依赖边界、作用域边界和可证明的清理边界？**

## 2. 最直觉的插件系统为什么不够

最直觉的实现通常是几个全局容器：

```ts
services.set('repoSearch', service)
listeners.push(onRequest)
const watcher = watch(root)
```

第一次启动看起来正常。

生产场景一旦出现热更新、多个 Agent 或部分失败，问题立即暴露：

- 谁负责从 `services` 删除旧实现？
- 新旧监听器是否会同时收到请求？
- watcher 初始化到一半抛错，已创建资源由谁回滚？
- Agent A 的私有搜索根目录为什么不会泄漏给 Agent B？
- Consumer 在 Provider 尚未出现时，是失败、轮询还是等待？

Cordis 的答案不是增加更多全局表，而是把“能力解析、插件实例、资源所有权、消息分发”放到同一套作用域与生命周期模型中。

## 3. 先画内核位置图

```text
Root Context（全局服务视图）
  │
  ├── RegistryService ── ctx.plugin() ──► Plugin Runtime
  │                                      │
  │                                      ▼
  │                                  Fiber 实例
  │                           PENDING / LOADING / ACTIVE
  │                                      │ owns
  │                                      ▼
  │                              Effect / disposer 栈
  │
  ├── ReflectService ── ctx.repoSearch ─► 当前 scope 的 Service impl
  │
  └── EventsService ── emit / serial / waterfall
            ▲
            │ context filter
Agent A Scope Context                  Agent B Scope Context
  isolate(repoSearch)                   isolate(repoSearch)
```

读图结论：**Context 不是插件本身；它是某个 Fiber 在当前作用域中读取服务、注册 Effect 和分发事件的入口。**

### 3.1 本章只需要记住五个对象

| 对象 | 负责什么 | 生命周期 |
| --- | --- | --- |
| `Context` | 当前作用域的操作入口 | 随父级原型链存在 |
| `RegistryService` | 规范化插件形态、创建 Fiber | 根 Context 内建 |
| `ReflectService` | Service 提供与解析、Proxy 行为 | 根 Context 内建 |
| `EventsService` | 监听器存储、过滤和分发模式 | 根 Context 内建 |
| `Fiber` | 一个插件实例的状态、依赖、Effect 与卸载 | `ctx.plugin()` 到 dispose |

表后结论：**Service、事件和 Effect 看似三套 API，最终都回到“当前 Fiber 拥有什么”。**

## 4. 最小机制：一个插件实例怎样获得可逆性

把本章场景缩成最短正确骨架：

```ts
// 教学伪代码：标识接近真实 Cordis API
export const inject = ['workspace']

export function apply(ctx: Context) {
  ctx.provide('repoSearch', createSearch(ctx.workspace.root))

  ctx.on('agent/request', async (payload, next) => {
    audit(payload)
    return next()
  })

  ctx.effect(() => {
    const watcher = watch(ctx.workspace.root)
    return () => watcher.close()
  })
}
```

数据怎样变化：

1. Loader 声明插件后，Registry 创建 Fiber，初始依赖里有 `workspace`。
2. `workspace` 不可用时，Fiber 保持 `PENDING`，不会调用 `apply`。
3. 依赖可用后，Fiber 进入 `LOADING`，执行 `apply`。
4. `ctx.provide()`、`ctx.on()` 和显式 `ctx.effect()` 都把 disposer 放进该 Fiber。
5. 全部成功后 Fiber 进入 `ACTIVE`。
6. 配置热更新或依赖消失时 Fiber 进入 `UNLOADING`，disposer 逆序运行。

为什么这样设计？插件作者只在“获得资源”的位置写对应释放动作，不需要维护另一张全局卸载清单。

## 5. Context：它为什么能同时表示依赖视图和作用域

### 5.1 Root Context 创建了哪些内建能力

`Context` 构造函数先创建 Proxy，再安装根 Fiber、Reflect、Registry、Events 和 Logger，见 [`vendor/cordis/src/context.ts#L70-L83`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/context.ts#L70-L83)。

源码事实：构造函数返回的是 `Proxy`，不是裸 `this`。

因此：

```ts
ctx.repoSearch
```

可能触发 Service 解析，而不只是读取 JavaScript 对象自己的字段。

### 5.2 属性读取如何找到 Service

`ReflectService.handler.get` 先处理对象已有属性；否则查属性定义，再沿当前 Fiber 与父 Fiber 寻找注入的实现，见 [`vendor/cordis/src/reflect.ts#L133-L170`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/reflect.ts#L133-L170)。

具体变化是：

```text
ctx.repoSearch
 → 当前 Context 的 isolate label
 → 当前 Fiber 的依赖 store
 → 父 Fiber（隔离标签不变才继续）
 → provider value / required-service error
```

读图结论：**同一个属性名能在不同作用域解析到不同实现，关键不在名字，而在 isolation label 与 Fiber 链。**

### 5.3 `extend()` 不是复制容器

`Context.extend(meta)` 用原型继承创建子 Context，并让新 metadata 遮蔽父值；它不复制所有 Service，见 [`vendor/cordis/src/context.ts#L90-L107`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/context.ts#L90-L107)。

这让 Agent Scope 可以携带 `agent`、filter 或其它元数据，同时继续读取父层公共 Service。

### 5.4 `isolate(name)` 真正隔离的是什么

`isolate('repoSearch')` 为该名字写入新的 symbol label，子树里的读写都指向新 label，见 [`vendor/cordis/src/context.ts#L109-L125`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/context.ts#L109-L125)。

它不是给对象加命名前缀，也不是复制整个 Context。

在本章场景中：

```text
Agent A: repoSearch → Symbol(A) → /workspace/a provider
Agent B: repoSearch → Symbol(B) → /workspace/b provider
Root:    repoSearch → root label → 可能不存在
```

## 6. Service：稳定能力接口怎样出现和消失

### 6.1 两种提供方式

插件可以：

- 调用 `ctx.provide(name, value)` 提供已有对象。
- 继承 `Service`，在构造时 `super(ctx, name)`。

`Service` 基类会把实例交给 `ctx.reflect.provide()`，并自动跟随拥有它的 Fiber 撤销，见 [`vendor/cordis/src/service.ts#L5-L11`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/service.ts#L5-L11) 与 [`service.ts#L31-L58`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/service.ts#L31-L58)。

### 6.2 `provide()` 为什么也是 Effect

`ReflectService.provide()` 的实现包在 `this.ctx.fiber.effect()` 中，见 [`vendor/cordis/src/reflect.ts#L270-L304`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/reflect.ts#L270-L304)。

所以 Provider 卸载时，不只删掉值；Cordis 还会通知依赖它的 Fiber 重新计算可用性。

在本场景中，`repoSearch` 消失后，声明 `inject = ['repoSearch']` 的 Consumer 会退出 ACTIVE，而不是继续持有陈旧对象。

### 6.3 容易误读：`ctx.get()` 与 `ctx.foo` 不等价

看到 `ctx.get('repoSearch')` 很容易把它当作 `ctx.repoSearch` 的动态名字版本。

实际条件不同：

- `ctx.repoSearch` 在插件 Context 中要求该 Service 已正确声明 inject，并沿依赖 store 解析。
- `ctx.get('repoSearch')` 通过 Reflect Store 查询，常用于可选能力或宿主边界。

`ReflectService.get(name, strict)` 的严格模式只返回 ACTIVE Provider，见 [`vendor/cordis/src/reflect.ts#L225-L243`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/reflect.ts#L225-L243)。

因此不要用大量 `ctx.get()` 绕开 inject；那会把声明式依赖退化成运行时空值判断。

## 7. Fiber：从等待依赖到反向卸载的状态机

### 7.1 状态图

```text
                 required services ready
PENDING ─────────────────────────────────► LOADING
   ▲                                         │
   │ dependency lost                         ├─ apply/config throws ─► FAILED
   │                                         │
   │                                         ▼
   └────────────────── UNLOADING ◄──────── ACTIVE
                              │ dispose
                              ▼
                           DISPOSED
```

读图结论：**`PENDING` 不等于报错；它表示依赖尚未组成可激活 epoch，真正失败是 `FAILED`。**

状态枚举和语义在 [`vendor/cordis/src/fiber.ts#L139-L154`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/fiber.ts#L139-L154)。

### 7.2 插件实例怎样被创建

Fiber 构造时：

- 从父 Context `extend({ fiber: this })` 得到插件 Context。
- 合入 inject 对应的 intercept config。
- 建立执行插件函数或类构造器的 runner。
- 把自己的 dispose 注册为父 Fiber 的 Effect。

这些关键动作见 [`vendor/cordis/src/fiber.ts#L212-L297`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/fiber.ts#L212-L297)。

这里形成真正的所有权树：父插件卸载会触发子 Fiber dispose。

### 7.3 依赖如何推动状态变化

Fiber 为每个 inject 保存 Provider 实现，拼出基于 Provider uid 的 epoch；缺一项就用 `INACTIVE`，见 [`vendor/cordis/src/fiber.ts#L597-L623`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/fiber.ts#L597-L623)。

epoch 从 inactive 变为可用时 `_reload()`，反向变化时 `_unload()`，分支见 [`vendor/cordis/src/fiber.ts#L625-L643`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/fiber.ts#L625-L643)。

这比“发现 Service 后调用一次回调”更强：Provider 实例换了 uid，即使名字不变，Consumer 也能重新装载。

## 8. Effect：注册为什么等于资源获取

### 8.1 Effect 接受什么

Effect 可以返回：

- 一个 disposer。
- disposer 的 Promise。
- 同步 iterable，逐个 yield disposer。
- 异步 iterable，逐个 yield disposer。

类型定义见 [`vendor/cordis/src/fiber.ts#L64-L94`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/fiber.ts#L64-L94)。

本章 watcher 场景是最简单的一种：创建 watcher，返回 `close()`。

### 8.2 清理顺序

`effect()` 保存 disposer，并在销毁时用 `reverse()` 逆序执行，见 [`vendor/cordis/src/fiber.ts#L402-L442`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/fiber.ts#L402-L442)。

如果插件先提供 Service，再建立 watcher，再注册监听器，卸载时通常先移除后注册的监听器，再关 watcher，最后撤销 Service。

为什么逆序？资源往往按依赖顺序获取：先打开连接，再创建订阅；释放时应先取消订阅，再关连接。

### 8.3 同步初始化失败也会回滚

`effect()` 在执行用户代码前先把 wrapper 放入 Fiber 的 disposer 列表；如果执行抛错，它会启动已收集 disposer 的清理，再把原错误抛出，见 [`vendor/cordis/src/fiber.ts#L504-L537`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/fiber.ts#L504-L537)。

这解决了本章场景中的中途失败：即使 watcher 创建后，后一个注册抛错，watcher 也不会泄漏。

### 8.4 失败边界：inactive Context 禁止新增 Effect

Fiber 已进入 `UNLOADING` 时，再调用 `ctx.effect()` 会抛出 `INACTIVE_EFFECT`，见 [`vendor/cordis/src/fiber.ts#L415-L423`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/fiber.ts#L415-L423)。

这个边界防止清理阶段又偷偷获得一个新资源，让卸载永远追不上创建。

## 9. Event：通知、决策与拦截不是同一种控制流

### 9.1 四种本章需要的分发模式

| 模式 | 是否等待 | 何时停止 | 适合 |
| --- | --- | --- | --- |
| `emit` | 否 | 不因返回值停止 | 发布已发生的事实 |
| `parallel` | 是，并行 | 全部 settle 后汇总错误 | 多个独立异步观察者 |
| `serial` | 是，顺序 | 首个 bail 值停止 | 顺序决策或停止钩子 |
| `waterfall` | 取决于返回值 | 监听器不调 `next()` 即短路 | around middleware / 策略包装 |

真实实现的语义入口见 [`vendor/cordis/src/events.ts#L177-L243`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/events.ts#L177-L243)。

表后结论：**选择事件模式是在选择“监听器拥有多少控制权”，不是性能风格。**

### 9.2 `ctx.on()` 为什么不需要手工 remove

监听器注册最终进入 `ctx.fiber.effect()`，disposer 会从 hook 数组删除它，见 [`vendor/cordis/src/events.ts#L245-L259`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/events.ts#L245-L259)。

所以 `repo-search` 插件热卸载后，旧 `agent/request` listener 不会留下。

### 9.3 Waterfall 的真实调用栈

假设有三个监听器：审计、权限、默认模型请求。

```text
audit(payload, next)
  └─ next()
      permission(payload, next)
        ├─ denied: return replacement（短路）
        └─ allowed: next()
            └─ builtInRequest()
```

读图结论：**Waterfall 是嵌套调用链，不是把上一个返回值自动传给下一个的数组 reduce。**

实现会把最后一个参数取作 inner，再依次把 listener 作为下一层，见 [`vendor/cordis/src/events.ts#L224-L243`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/events.ts#L224-L243)。

### 9.4 失败边界：忘记 `next()` 不是“只记录不影响”

本章伪代码中的审计 listener 必须 `return next()`。

如果只写：

```ts
ctx.on('agent/request', payload => audit(payload))
```

它会短路下游，默认请求不再运行。

仓库 Primer 明确把 Waterfall 定义为 around-middleware，并说明不调用 `next()` 是 veto，见 [`docs/cordis-primer.md#L28-L34`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/cordis-primer.md#L28-L34)。

## 10. 真实源码旅程：`repo-search` 从配置行到完整卸载

现在把零散机制重新装回同一个对象。

### 10.1 配置行进入 Registry

输入：Loader 已解析出插件模块、config 和 `inject: ['workspace']`。

Registry 支持函数、类和 `{ apply }` 对象插件形状；形状解析见 [`vendor/cordis/src/registry.ts#L189-L228`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/registry.ts#L189-L228)，runtime 复用与 Fiber 创建见 [`registry.ts#L304-L335`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/registry.ts#L304-L335)。

输出：一个拥有父 Context、raw config、inject map 的 Fiber。

### 10.2 `workspace` 未出现：Fiber 停在 PENDING

Fiber 的依赖 store 缺少 `workspace`，epoch 为 inactive。

此时：

- `apply()` 尚未执行。
- `repoSearch` 尚未提供。
- watcher 尚未创建。
- 这不是失败；Boot 最终审计时若仍未满足才报告 pending。

### 10.3 Provider 出现：Fiber 进入 LOADING

Workspace Provider 变为 ACTIVE 后，Reflect 通知相关 Fiber 刷新依赖。

Fiber 保存 Provider impl，epoch 由 Provider uid 构成，进入 `_reload()`。

输入从“声明依赖”变为“本次依赖实例快照”。

### 10.4 Config 校验在执行前完成

若插件声明标准 Schema，`resolveConfig()` 会同步校验；异步 Schema 不受支持，错误聚合为 `ValidationError`，见 [`vendor/cordis/src/fiber.ts#L42-L62`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/fiber.ts#L42-L62)。

失败时插件不会进入 ACTIVE，已登记的 Effect 会清理。

### 10.5 `apply()` 获得插件专属 Context

此 Context 的 `fiber` 指向 `repo-search` Fiber，Service 读取受 inject 约束，所有 `ctx.*` 注册归这个 Fiber 所有。

插件依次：

1. 读取 `ctx.workspace.root`。
2. 提供 `repoSearch` Service。
3. 注册 `agent/request` Waterfall listener。
4. 创建 watcher Effect。

输出：Fiber ACTIVE，Agent A 作用域能解析对应 Search Service。

### 10.6 一次 Agent 请求经过 listener

请求进入 `agent/request` Waterfall。

Agent A 的 scope filter 只选择匹配当前 Agent 的 hooks；Events dispatch 会读取 `thisArg` 的 Context filter，见 [`vendor/cordis/src/events.ts#L158-L175`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/events.ts#L158-L175)。

审计 listener 记录信息并调用 `next()`，模型请求继续。

### 10.7 热更新触发卸载

配置树决定旧 Fiber 不再有效。

Fiber 转为 UNLOADING，逆序执行：

1. 关闭 watcher。
2. 移除 `agent/request` listener。
3. 撤销 `repoSearch` Provider。
4. 处置它挂载的子插件。

输出：旧能力不可再解析，旧事件不会再触发，资源释放完成后 Fiber DISPOSED 或等待新 epoch 重载。

### 10.8 新版本重新激活

新 config / Provider uid 形成新 epoch，插件重新运行。

这就是“热替换”与“再调用一次模块函数”的差别：前者有确定的旧实例退出边界。

## 11. 失败、安全与停止边界

### 11.1 Provider 重名或越权写入

Service 实现记录拥有它的 Fiber；其它 Fiber 不能直接覆盖该值。Reflect 的 `set()` 会检查 owner，相关保护见 [`vendor/cordis/src/reflect.ts#L245-L264`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/reflect.ts#L245-L264)。

边界意义：能力所有权不能靠“最后一次 Map.set 赢”。

### 11.2 异步 disposer 失败

Fiber 卸载会等待异步清理；清理错误被记录，生命周期尽力继续，避免一个观察者阻断整棵所有权树。

但如果 Logger 自身也抛错，源码选择让拒绝传播，因为此处已无可靠报告通道，见 [`vendor/cordis/src/fiber.ts#L276-L295`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/src/fiber.ts#L276-L295)。

### 11.3 模块级副作用不受 Fiber 管理

```ts
// 错误示例
const watcher = watch(process.cwd())
export function apply(ctx: Context) { /* ... */ }
```

watcher 在模块导入时创建，不属于 `apply()` 的 Fiber；dispose 不知道它。

正确原则是：资源获取发生在 `ctx.effect()` 里面，释放函数与获取紧邻。

### 11.4 错误作用域导致能力泄漏

如果 `repoSearch` 本应每 Agent 隔离，却在 root Context 提供，那么所有子 Context 可能解析到同一实现。

这不是 TypeScript 类型能自动防住的业务错误；必须在创建 Agent scope 时决定哪些 Service isolate，并用跨 Agent 测试证明隔离。

## 12. DeepSeek Harness 的选择：Service、事件还是插件

| 需求 | 首选机制 | 理由 | 错用风险 |
| --- | --- | --- | --- |
| 调用明确能力并获得结果 | Service method | 调用者知道能力契约 | 用广播事件会隐藏唯一负责人 |
| 通知“事实已发生” | `emit` / `parallel` | 观察者不拥有主流程 | 返回值被误当决策 |
| 顺序执行停止钩子 | `serial` | 明确等待与 bail | 普通 emit 不等待 Promise |
| 包裹或替换默认行为 | `waterfall` | 有 `next()` 与短路 | 忘调 next 吞掉下游 |
| 装配一组能力与副作用 | Plugin + Fiber | 统一依赖和清理 | 模块级单例无法热卸载 |

表后结论：**先判断控制权属于“调用者、观察者还是策略链”，再选 API。**

## 13. Java 类比及其边界

### 13.1 可以借用的桥梁

| Cordis | Java/Spring 类比 |
| --- | --- |
| `Context` Service 解析 | `ApplicationContext#getBean` 与依赖注入 |
| `inject` | required constructor dependency |
| `Context.extend()` | 带父级的 child context |
| Fiber | Bean 实例 + `SmartLifecycle` + owner handle |
| Effect disposer | `AutoCloseable` / destroy callback |
| Waterfall | Servlet Filter / HandlerInterceptor around chain |

### 13.2 类比停止处

- Cordis Context 的 Proxy 属性读取会执行作用域 Service 解析，不是普通字段注入。
- 依赖 Provider 消失时，Consumer Fiber 可卸载并等待重激活；普通单例 Bean 通常不会这样动态往返。
- Event filter 使用 dispatch `thisArg` 携带作用域，不能只类比为全局 `ApplicationEventPublisher`。
- Effect 可以在一个插件内动态增加多个 disposer，比一个 Bean 的固定 destroy 方法更细粒度。

## 14. 源码事实、设计解读与教学推演

### 14.1 源码事实

- Root Context 是 Proxy，并内建 Registry、Events、Reflect、Logger。
- Fiber 的 epoch 由当前依赖 Provider uid 组成。
- `ctx.provide()` 与 `ctx.on()` 都由 Effect 承担清理。
- Waterfall listener 不调 `next()` 就截断链。
- Effect 在 UNLOADING 时禁止新增。

### 14.2 设计解读

Cordis 把“依赖可用性”和“资源所有权”绑定到同一个 Fiber，使动态组合不必由每个业务插件手写装卸状态机。

代价是 Context 承担多种语义：依赖视图、作用域 carrier、事件过滤和 Effect owner。读代码时必须明确当前 `ctx` 是 root、插件 child 还是 Agent scope。

### 14.3 教学推演

如果你给 Java Agent 增加可热卸载插件，最小可迁移设计不是复制 Proxy，而是：

```text
PluginHandle {
  dependencySnapshot
  state
  List<AutoCloseable> resources
  closeInReverseOrder()
}
```

等所有权闭环稳定后，再引入动态作用域和 around middleware。

## 15. 可以带走的方法

### 方法一：注册动作必须返回撤销动作

验证问题：每个 `register`、`listen`、`watch`、`provide` 能否找到归属 owner 与 disposer？

### 方法二：依赖变化用实例身份驱动，不只看名字

验证问题：同名 Provider 被热替换后，Consumer 会继续握旧对象，还是建立新依赖快照并重载？

### 方法三：策略链必须显式交棒

验证问题：一个只做日志的 middleware 如果遗漏 `next()`，测试是否立即暴露默认行为未执行？

## 16. 常见误区与第一遍可以忽略

### 误区一：Context 就是一个全局 Service Map

错。读取受 Fiber inject、isolation label 和 Context 原型链共同约束。

### 误区二：PENDING 表示插件启动失败

错。PENDING 是依赖未满足；FAILED 才表示 config 或 apply 失败。

### 误区三：调用 disposer 两次会重复清理

Effect disposer 是 single-shot；第二次调用不会重复执行资源释放。

### 第一遍可以忽略

- effect metadata 的诊断树细节。
- `intercept()` 对 Service config 的合并规则。
- Registry 对 class plugin 初始化 symbol 的完整兼容面。

先掌握 Context、Fiber、Effect、Event 四件套，再回来看这些扩展。

## 17. 费曼自测

1. 为什么 `ctx.repoSearch` 能在 Agent A 与 Agent B 解析到不同对象？
2. `workspace` 尚未出现时，为什么 `repo-search.apply()` 不应立即抛空指针？
3. `ctx.on()` 没有显式 `removeListener`，旧 listener 为什么仍能被清掉？
4. Waterfall 中一个只做审计的 listener 应怎样写，漏写会发生什么？
5. 为什么模块顶层创建 watcher 破坏了 Fiber 的生命周期保证？

### 一分钟复述模板

Cordis 用 Context 表示当前作用域的能力视图，用 Registry 把配置声明变成 Fiber；Fiber 根据 inject 的 Provider 实例决定 PENDING、ACTIVE 或卸载；插件在 apply 内通过 provide、on 和 effect 获取资源，这些 API 都把 disposer 记到当前 Fiber；父 Fiber dispose 或依赖消失时，资源逆序撤销。事件模式则决定观察者是否能等待、停止或包裹主流程。

## 18. 三层练习

### Level 1：只读定位

在 `vendor/cordis/src` 中找出：

- Context 构造 Proxy 的行。
- `ctx.on()` 进入 Effect 的行。
- Effect 逆序清理的行。
- Fiber 从 inactive 进入 reload 的条件。

把四处连成一张所有权图。

### Level 2：最小插件实验

写两个插件：`provider` 提供计数 Service，`consumer` 声明 inject 并注册监听器。

手动 dispose Provider，观察 Consumer 状态与 listener 是否仍存在。

要求记录确切状态顺序，不用 `setTimeout` 猜时机。

### Level 3：隔离与失败注入

创建两个 child Context，为同一 Service 名建立不同 isolation label。

每个作用域提供不同 root；在 Agent A 插件初始化中创建两个 Effect，第二个故意抛错。

验收：

- A 的第一个资源已回滚。
- B 的 Service 完全不受影响。
- root Context 不能意外读到任一私有实现。

## 19. 小结与下一章钩子

本章的 `repo-search` 插件经历了完整生命：

```text
配置声明
 → Fiber PENDING
 → workspace Provider ready
 → LOADING / config validation / apply
 → Service + listener + watcher Effects
 → ACTIVE
 → config or dependency change
 → reverse disposal
 → PENDING / DISPOSED / reloaded
```

现在插件树已能安全组合能力，新的黑盒是：用户消息到达后，究竟是谁开启 Turn，何时增加 Step，模型流和工具结果怎样推动下一轮调用，又怎样在取消或错误时封闭边界？

下一章进入 `ReactLoopAgent`，沿一条“读取 `package.json` 后总结”的请求，拆开真正的 Agent 主循环。
