---
title: "01. 项目地图与启动"
description: "沿一条 dsh web 命令，读懂 Profile、Bundle、Patch、Loader 与可回滚插件树。"
---

# 01. 项目地图与启动

> 本章源码基线：[`deepseek-ai/deepseek-harness@47f9438`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)。除明确标注“设计解读”或“教学推演”的段落外，行为结论都来自这个固定提交。

## 0. 本章学习目标

完成本章后，你应该能够：

- 不查文档，画出 `dsh web` 从 argv 到 Cordis 插件树的主路径。
- 分清 Profile、Bundle、Patch 和运行时插件实例，避免把四者都叫“配置”。
- 按真实覆盖顺序解释 bundle、profile、home、`--patch` 和遥测开关。
- 说出 Loader 为什么等待“依赖可用”，而不是按 YAML 行号依次启动。
- 定位参数错误、Bundle 解析失败、插件激活失败和进程退出的停止边界。
- 用“组合先行、激活审计、失败回滚”三条方法设计自己的可插拔 Java 服务。

## 1. 一句话讲明白

**DeepSeek Harness 的启动，就是把一个 Profile 展开成有优先级的 Patch 栈，再把结果装载成一棵由 Fiber 管理生命周期的 Cordis 插件树。**

本章只追一个贯穿场景：

```bash
dsh web --patch ./team.cordis.yml --port 3090
```

用户想启动 Web 界面；`team.cordis.yml` 是团队临时覆盖；`--port 3090` 不是启动器参数，而是交给 Web Surface 的内部参数。

中央问题是：**这几个 token 怎样逐步变成一个真正监听 3090 端口、可在失败时完整卸载的应用？**

## 2. 为什么先学启动，而不是直接读 Agent Loop

上一站只有一个仓库链接，现在我们第一次进入运行时。

最直觉的读法是找到 `main()`，顺着 `new Agent()` 一路单步。

这在一个固定 Spring Boot 应用里常常有效，在 Harness 里却会漏掉决定产品形态的前半段：

- `web` 与 `headless` 共享大部分能力，却挂载不同 Surface。
- 用户能用 Patch 替换、禁用或插入配置行。
- 插件不会单纯按文件顺序启动，而会等待声明的 Service。
- 启动只完成一半就失败时，已注册的端口、监听器和后台任务必须撤销。

如果跳过启动组合，你之后看到 `ctx.tools`、`ctx.sessions` 或 `ctx.llm` 时，只知道“它存在”，不知道是谁把它放进当前作用域、何时可用、何时会消失。

因此本章先把“应用从哪里长出来”讲清楚，再把下一章的 Cordis 内核作为待打开的黑盒。

## 3. 先看位置图：命令外壳、组合层、运行时树

```text
用户输入
  dsh web --patch ./team.cordis.yml --port 3090
          │
          ▼
apps/cli/src/args.ts             只认 launcher flags
          │  DshInvocation
          ▼
apps/cli/src/profile-boot.ts     加载 Profile，组合 Patch 栈
          │  PatchOptions[]
          ▼
packages/boot/app-boot           创建 Context，挂 Loader / Include
          │  effective entries
          ▼
vendor/loader + vendor/cordis    按依赖激活插件 Fiber
          │
          ├── packages/bundle/base      Session / LLM / Agent / Tools ...
          └── packages/bundle/web-app   WebServer / API / Browser plugins ...
```

读图结论：**CLI 不是应用本体；它只把声明式配置交给通用 Boot，真正的应用是 Loader 激活后的插件树。**

### 3.1 四个根目录各负责什么

| 目录 | 本章角色 | 不要误读成 |
| --- | --- | --- |
| `apps/cli` | 解析启动器参数，准备 Profile，管理进程退出 | 所有业务能力的总入口 |
| `packages/boot` | 通用 Profile/Bundle 解析、装载和激活审计 | Web 专用启动代码 |
| `packages/bundle` | 用 Patch 声明某种发行形态要组合哪些插件 | 已经运行的插件实例 |
| `vendor/cordis`、`vendor/loader` | 依赖容器、生命周期、配置树装载 | 业务领域层 |

表后结论：**目录层级表达的是责任边界，而 Profile 组合决定某次运行实际采用哪些责任。**

## 4. 最小内核：先把产品细节全部剥掉

先不要看 WebServer、LLM 和 Tool。Harness 启动的最小机制可以缩成：

```ts
// 教学伪代码：保留真实控制顺序，省略错误包装和热更新
const invocation = parseDshArgs(argv)
const profile = loadProfile(invocation.profile)
const patches = compose(
  profile.bundlePatches,
  profile.userPatches,
  invocation.patchFiles,
)
const ctx = new Context()
await ctx.plugin(Loader)
await include(ctx, profile.rootConfig, patches)
await ctx.loader.await()
assertEveryEntryActivated(ctx)
```

这段代码里发生了三次数据形态变化：

1. 字符串数组 `argv` 变成带 `mode` 判别字段的 `DshInvocation`。
2. Profile 名称和 Patch 文件变成一组有顺序的 `PatchOptions[]`。
3. 配置行变成带状态和清理逻辑的插件 Fiber。

为什么要分三段？因为“用户意图是否合法”“最终配置是什么”“运行时是否真的激活”是三个不同问题，混在一个 `main()` 中很难独立诊断。

### 4.1 通用 Agent 机制与 Harness 产品层

| 层次 | 通用机制 | Harness 在本提交上的产品叠加 |
| --- | --- | --- |
| 启动 | 参数 → 配置 → 运行对象 | `DshInvocation`、Profile、Bundle Patch |
| 依赖 | Provider 出现后 Consumer 激活 | Cordis Service 与 Loader `inject` |
| 生命周期 | 创建资源时登记清理动作 | Fiber、Effect、根 Context dispose |
| 产品形态 | 用不同组合共享核心能力 | `dsh-base` + `dsh-web-app` / `dsh-headless` |

表后结论：**Agent Loop 并不负责“造出整个产品”；它只是由某个 Bundle 装入插件树的一项能力。**

## 5. 读源码前必须分清四个词

### 5.1 Profile：一次运行选择的配置容器

源码事实：`Profile` 包含名称、目录、有序 Bundle 层、用户 Patch 路径和已解析 Patch，定义在 [`packages/boot/app-boot/src/profile.ts#L72-L96`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/boot/app-boot/src/profile.ts#L72-L96)。

`web` 和 `headless` 是内置模板：前者组合 `dsh-base` 与 `dsh-web-app`，后者组合 `dsh-base` 与 `dsh-headless`，见 [`profile.ts#L113-L125`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/boot/app-boot/src/profile.ts#L113-L125)。

Profile 不是“一个 YAML 文件”。它是目录级部署单元，还包含 `package.json` 和独立依赖。

### 5.2 Bundle：可复用的默认配置层

源码事实：Bundle 包在 `package.json` 的 `dsh.bundle.patch` 中声明 Patch 文件，Profile 通过有序 `bundles` 列表引用它，数据类型见 [`profile.ts#L41-L69`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/boot/app-boot/src/profile.ts#L41-L69)。

`dsh-base` 的主要内容甚至不是 TypeScript API，而是 `cordis.patch.yml`；其中插入 Session、Agent、LLM、Tools 等共享插件，入口注释见 [`packages/bundle/base/cordis.patch.yml#L1-L24`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/bundle/base/cordis.patch.yml#L1-L24)。

### 5.3 Patch：对配置树做有顺序的变换

Patch 可以插入行、按 `id` 替换配置或禁用行。

它不是 Java `Properties` 的键值合并。源码注释明确指出，命中的 `config` 是整块替换，而不是深合并；Web Bundle 因此需要重述整份行配置，见 [`packages/bundle/web-app/cordis.patch.yml#L1-L12`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/bundle/web-app/cordis.patch.yml#L1-L12)。

### 5.4 Plugin Fiber：某个配置行激活后的运行实例

配置行还不是运行中的能力。

Loader 解析模块、等待依赖、校验配置并调用插件后，Cordis 才创建 Fiber。Fiber 持有状态、依赖快照和 disposer；下一章会拆开它。

## 6. 必要的 TypeScript：判别联合让分发可穷尽

`parseDshArgs()` 返回 `DshInvocation`，它由三种对象组成：

```ts
type DshInvocation =
  | { mode: 'profile'; profile: string; patches: string[]; args: string[] }
  | { mode: 'dump-config'; profile: string; defaultOnly: boolean; patches: string[] }
  | { mode: 'plugin'; profile: string; args: string[] }
```

真实接口与联合定义在 [`apps/cli/src/args.ts#L20-L48`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/args.ts#L20-L48)。

Java 类比是 `sealed interface Invocation permits ProfileInvocation, DumpConfigInvocation, PluginInvocation`。

类比边界：TypeScript 在这里依靠对象字段做运行时判别，没有 Java 类层级；`invocation satisfies never` 只做编译期穷尽检查，不会替你校验外部 JSON。

## 7. 真实源码旅程：`dsh web --patch ... --port 3090`

现在沿同一个场景逐步走，不按文件目录散讲。

### 7.1 第一步：Launcher 只吃掉自己拥有的参数

输入：

```text
["web", "--patch", "./team.cordis.yml", "--port", "3090"]
```

`args.ts` 将 `web` 注册为 `--profile web` 的别名，并开启 `allowUnknownOption()`、`passThroughOptions()`；相关分支见 [`apps/cli/src/args.ts#L156-L169`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/args.ts#L156-L169)。

输出大致是：

```ts
{
  mode: 'profile',
  profile: 'web',
  patches: ['./team.cordis.yml'],
  args: ['--port', '3090'],
}
```

状态变化：原始 token 被分为“启动器所有”和“Surface 所有”两组；此时没有创建 Context，也没有打开端口。

### 7.2 容易误读：`--port` 并不是 CLI Launcher 的选项

看到最终能监听 3090，很容易以为 `parseDshArgs()` 解析了端口。

实际条件是：解析器在第一个不认识的 token 处把剩余参数原样留给启动后的应用。源码顶部明确说明这种所有权切分，见 [`args.ts#L1-L15`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/args.ts#L1-L15)。

因此 `dsh --profile web --port 3090` 合法，但把 Launcher 参数放到内部参数之后就可能不再由外层识别。

### 7.3 第二步：`bin.ts` 只分发对应模式

`bin.ts` 在 [`apps/cli/src/bin.ts#L27-L49`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/bin.ts#L27-L49) 读取 `mode`：

- `profile` 动态导入 `profile-boot.ts`。
- `plugin` 动态导入依赖管理命令。
- `dump-config` 只组合并打印，不启动树。

输出：`runProfile({ environment, profile, patchFiles, args })` 的调用。

为什么动态导入？源码事实只证明不同模式走不同模块；“减少无关模式进入当前分发路径”是文件注释给出的设计意图，不应扩张成未经测量的启动性能结论。

### 7.4 第三步：加载 Profile 和 Bundle 清单

`prepareProfile('web')` 会加载或初始化 Profile，并重写一个空的 `cordis.yml` 作为 Include 锚点，见 [`apps/cli/src/profile-boot.ts#L85-L103`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/profile-boot.ts#L85-L103)。

为什么根配置是空数组？因为完整树由 Patch 层从空列表上组合出来；若把上次 Loader 写回的结果继续当根，下一次启动会重复插入 Bundle 行。

`loadProfile()` 再按 manifest 顺序解析每个 Bundle；找不到 Bundle，或包没有声明 `dsh.bundle`，都会直接抛错，见 [`packages/boot/app-boot/src/profile.ts#L357-L402`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/boot/app-boot/src/profile.ts#L357-L402)。

### 7.5 第四步：组成精确的覆盖顺序

`composeProfile()` 的输入是 Profile 名称和 `--patch` 文件列表，核心组装在 [`apps/cli/src/profile-boot.ts#L131-L170`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/profile-boot.ts#L131-L170)。

本场景的顺序是：

```text
1. @deepseek-ai/dsh-base bundle patches
2. @deepseek-ai/dsh-web-app bundle patches
3. $DSH_HOME/profiles/web/cordis.patch.yml
4. $DSH_HOME/cordis.patch.yml
5. ./team.cordis.yml
6. 环境变量生成的 telemetry hard-disable patch（若满足条件）
```

读图结论：**越靠后的层越接近本次运行意图，但隐私硬开关仍可在最后禁止遥测。**

### 7.6 第五步：Patch 栈先被索引，再交给 Boot

`composeEntries()` 对空数组一次性应用展平后的 Patch，并用 `structuredClone` 避免原对象被配置树原地修改，见 [`packages/boot/app-boot/src/profile.ts#L405-L419`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/boot/app-boot/src/profile.ts#L405-L419)。

`profile-boot.ts` 还建立 `id → row` 索引，用来判断是否存在 `agent-presets`、遥测行等。

这里的输出仍是配置行，不是插件对象。

### 7.7 第六步：先安装进程退出边界

`runProfile()` 在 `boot()` 前创建 shutdown controller，并监听 `SIGTERM` 与 `SIGINT`，见 [`apps/cli/src/profile-boot.ts#L207-L225`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/profile-boot.ts#L207-L225)。

状态变化：进程信号现在拥有“处置整棵树”的通道，即使插件树仍在启动。

`SIGTERM` 使用退出码 0；`SIGINT` 使用 130。shutdown 最多给 dispose 5 秒，重复中断会升级为强制退出，见 [`apps/cli/src/process-shutdown.ts#L1-L76`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/process-shutdown.ts#L1-L76)。

### 7.8 第七步：Boot 创建根 Context 并装载 Loader

`boot()` 在 [`packages/boot/app-boot/src/index.ts#L757-L785`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/boot/app-boot/src/index.ts#L757-L785) 依次执行：

1. `new Context()`。
2. 设置相对模块解析的 `baseUrl`。
3. 提供 `dshHomePath`。
4. 挂载 Loader。
5. 执行 host `prepare`。
6. 挂载根 Include 和 Patch。
7. 等待 Loader settle。
8. 审计每一行是否真正激活。

在本场景中，`prepare` 会提供冻结的启动环境与 `cmdlineArgs`；Web Startup 插件随后才读取 `--port 3090`。

### 7.9 第八步：依赖可用，而非 YAML 行号，决定激活

Base Patch 开头就写明行顺序不携带加载语义，服务可用性才携带，见 [`packages/bundle/base/cordis.patch.yml#L1-L13`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/bundle/base/cordis.patch.yml#L1-L13)。

Web 的 `webserver` 行声明 `inject: [webStartup]`，其配置表达式从 `ctx.webStartup.port` 读端口，见 [`packages/bundle/web-app/cordis.patch.yml#L105-L121`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/bundle/web-app/cordis.patch.yml#L105-L121)。

因此真实状态演进是：

```text
web-startup PENDING → cmdlineArgs 出现 → ACTIVE → 提供 webStartup
webserver   PENDING → webStartup 出现  → ACTIVE → 绑定 3090
web-runtime PENDING → webStartup + webServer 可用 → ACTIVE
connection  PENDING → webRuntime 出现 → ACTIVE
```

读图结论：**配置顺序帮助人阅读；Service 依赖才是机器的启动拓扑。**

### 7.10 第九步：只有整棵树 settle 后才报告就绪

Web Runtime 在挂载静态资源、Prompt 和环境变量后，等待 Loader settle 才打印 URL；它避免在兄弟行随后失败时发出假就绪信号，见 [`packages/bundle/web-app/src/index.ts#L135-L183`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/bundle/web-app/src/index.ts#L135-L183)。

到这里，本场景才从“配置合法”变成“Web 产品已运行”。

## 8. 覆盖规则：最直觉方案为何不够

最直觉的方案是把所有配置做深度合并：后来的字段覆盖前面的同名字段。

生产场景里它有三个问题：

- 删除旧字段很难表达，配置会留下历史残片。
- 不同层对数组、表达式和嵌套对象的合并语义容易分歧。
- 打印出来的输入层不能直接说明最终行是什么。

Harness 选择“按行 ID 打 Patch，命中的整块 config 替换”。

| 行为 | 直觉深合并 | Harness Patch |
| --- | --- | --- |
| 修改一项配置 | 只写变化字段 | 重述该行完整 `config` |
| 删除旧字段 | 需要删除语法 | 新整块自然不含旧字段 |
| 审计最终值 | 需理解递归合并器 | 查看 compose 后的行 |
| 编写成本 | 较低 | 较高，容易漏掉必需字段 |

表后结论：**Harness 用更显式的作者成本，换取更可预测的最终配置。**

## 9. 启动审计：settled 不等于全部 ACTIVE

Loader Promise 结束后，仍需检查每个条目的 Fiber。

`assertEntriesActivated()` 会区分：

- `FAILED`：等待 Fiber rejection，保留插件错误。
- `PENDING`：列出仍缺少的 Service。
- 其他非 ACTIVE 状态：输出实际状态。

相关分支在 [`packages/boot/app-boot/src/index.ts#L700-L724`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/boot/app-boot/src/index.ts#L700-L724)。

为什么重要？一个漏装模型 Provider 的 Web 页面可能仍能打开，但 Agent 一定不能工作。若只把“端口已绑定”当健康状态，就会把缺能力产品误报为正常。

## 10. 失败与停止边界

### 10.1 边界一：参数在创建 Context 前失败

`--dump-config` 与 `--dump-default-config` 互斥；dump 模式不接收应用内部参数，相关校验见 [`apps/cli/src/args.ts#L83-L103`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/args.ts#L83-L103)。

此时没有插件副作用，直接退出是正确停止点。

### 10.2 边界二：Profile 或 Bundle 解析失败

非法 Profile 名包含 `/`、`\\`、`.`、`..` 或保留目录 `node_modules` 时，`resolveProfileDir()` 直接拒绝，见 [`profile.ts#L98-L111`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/boot/app-boot/src/profile.ts#L98-L111)。

Bundle 找不到或没有声明 Patch 也会停止；系统不会静默少装一个 Bundle。

### 10.3 边界三：Host preparation 与插件树失败分开标记

`boot()` 初始错误阶段是 `host preparation failed`；只有 `prepare` 成功后才切换为 `plugin tree failed to load`，见 [`packages/boot/app-boot/src/index.ts#L764-L774`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/boot/app-boot/src/index.ts#L764-L774)。

这是诊断边界，不只是文案差异：前者说明配置树尚未挂载，后者说明已有部分插件可能启动。

### 10.4 边界四：部分启动失败必须先回滚

catch 分支先 `await ctx.fiber.dispose()`，再包装并抛出最深层错误，见 [`packages/boot/app-boot/src/index.ts#L786-L800`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/boot/app-boot/src/index.ts#L786-L800)。

这意味着第 20 个插件失败时，前 19 个插件登记在 Fiber 上的 Effect 会被撤销，然后调用者才看到启动失败。

### 10.5 边界五：主动结束不是启动失败

一次性 Surface 可能在启动流程仍等待时主动 dispose 整棵树。

`boot()` 每次 await 后重新检查 Loader 是否还存在；若已经随树销毁，就直接返回 Context，而不是把正常结束误报为激活失败，见 [`packages/boot/app-boot/src/index.ts#L775-L784`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/boot/app-boot/src/index.ts#L775-L784)。

## 11. `web` 与 `headless`：共享内核，不共享 Surface

| 维度 | Web Bundle | Headless Bundle |
| --- | --- | --- |
| 入口输入 | Web 参数、浏览器请求 | 一个 task 字符串 |
| Host | HTTP、API、静态前端 | 不挂 HTTP/浏览器插件 |
| Agent 创建 | 由 API/产品交互触发 | Runner 直接创建一次 |
| 结束条件 | 长期运行至信号/退出 | Agent idle、flush、打印结果后退出 |
| 共享能力 | Base 中的 Session、LLM、Agent、Tools、Persistence | 同左 |

Headless Runner 等完整 Loader settle 后创建 Agent，运行任务、flush Session，再按 `turn/end` 原因选择退出码，见 [`packages/bundle/headless/src/index.ts#L90-L149`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/bundle/headless/src/index.ts#L90-L149)。

表后结论：**Surface 是“怎样接收与交付任务”，不是另一套 Agent 内核。**

## 12. Java 类比：可用，但要知道边界

可以把这条启动链暂时映射为：

| Harness | Java/Spring 桥梁 |
| --- | --- |
| Profile | 一组 deployment profile + 外部配置目录 |
| Bundle Patch | 可复用的 AutoConfiguration 集合 |
| Loader entry | Bean definition / module declaration |
| Cordis Service | 按名字解析的 Bean 能力 |
| Fiber | Bean 实例加生命周期句柄 |
| root dispose | 关闭 ApplicationContext |

类比停止处有三点：

1. Cordis Plugin 可以因 Service 出现或消失而重新激活，不只是应用启动时创建一次。
2. Patch 操作的是插件配置树，不等同于 Spring `Environment` 属性覆盖。
3. `Context` 同时参与 Service 解析、事件过滤和 Effect 所有权，职责比普通 DI 容器更宽。

## 13. DeepSeek Harness 的设计取舍

### 13.1 源码事实

- Bundle 层按 manifest 顺序装入，再叠加用户层与一次性 Overlay。
- Base 与 Surface Bundle 使用同一种 Patch 机制。
- Loader settle 后还会做逐条激活审计。
- Boot 失败先处置根 Fiber，再抛错。

### 13.2 设计解读

Harness 把“发行版默认值”“机器偏好”“Profile 偏好”“单次运行覆盖”放进同一组合模型，减少每个产品入口手写装配代码。

代价是调试需要同时观察两棵树：静态配置树和动态 Fiber 状态树。

### 13.3 教学推演

若你自己实现一个精简 Harness，可以先只支持：

```text
base entries → one user patch → activate → audit → dispose
```

等这条端到端链稳定后，再加 Bundle 包解析、双用户层、热更新和特殊隐私 Overlay。这样保留架构方向，又避免一开始复制全部产品复杂度。

## 14. 可以带走的工程方法

### 方法一：在激活前生成可审计的最终配置

做法：让 `dump-config` 与真实启动复用同一 compose 函数。

验证问题：打印结果是否与真正交给 Loader 的 entries 来自同一算法，而不是另写一套展示逻辑？

### 方法二：区分“配置已解析”和“能力已激活”

做法：在容器 settle 后逐项检查 ACTIVE，并报告缺失依赖。

验证问题：一个 Consumer 永久等待 Provider 时，健康检查会失败还是永远显示“启动中”？

### 方法三：让部分启动天然可逆

做法：所有注册都挂到同一个所有权树，失败只需 dispose 根节点。

验证问题：任意第 N 个模块抛错后，前 N-1 个模块打开的端口、线程、监听器能否确定全部撤销？

## 15. 常见误区与第一遍可以忽略的内容

### 误区一：YAML 越靠前，插件越先启动

错。行顺序主要服务阅读，激活受 `inject` 的 Service 可用性驱动。

### 误区二：`dsh web --port` 的端口由 Launcher 解析

错。Launcher 保留内部 argv，Web Startup 插件负责自己的参数。

### 误区三：Patch 会递归合并 `config`

错。命中的整块 `config` 被替换，所以后层要重述完整值。

### 第一遍可以忽略

- Profile 模块 fallback 的 BFS 修复细节。
- Web 客户端插件 roster 的每一行。
- 配置 HMR 的文件监听竞态。

它们重要，但不阻碍你先复述主启动链。

## 16. 费曼自测：请先遮住答案

1. 为什么 `dsh web --port 3090` 能让 Web 读到端口，但 Launcher 自己没有 `port` 字段？
2. Profile、Bundle、Patch、Fiber 分别处在哪个阶段？
3. 为什么 `ctx.loader.await()` 成功后还要执行 `assertEntriesActivated()`？
4. 团队 Patch 与遥测 hard-disable 同时修改一行时，哪个优先，为什么？
5. 第 20 个插件初始化失败时，什么机制保证前 19 个插件先清理？

### 参考复述

一条命令先被拆成 Launcher 意图与 Surface 参数；Launcher 加载 Profile 的有序 Bundle，再叠加用户和单次 Patch；Boot 创建 Context、挂 Loader，并把配置行变成受 Service 依赖驱动的 Fiber；整棵树 settle 且每行 ACTIVE 后才算启动成功，失败则 dispose 根 Fiber 回滚。

如果你无法在一分钟内说出这段话，请回看第 4 节与第 7 节，不要先钻进 Web Bundle 的全部行。

## 17. 三层练习

### Level 1：只读定位

运行或阅读配置 dump，回答：

```bash
dsh web --dump-default-config
dsh web --dump-config
```

找出用户层新增或修改了哪些行，并说明为什么两个命令都不应打开端口。

### Level 2：画调用链

从 `apps/cli/src/bin.ts` 开始，画出到 `packages/boot/app-boot/src/index.ts#boot` 的调用链。

每个箭头写上输入与输出类型，至少出现 `DshInvocation`、`Profile`、`PatchOptions[]`、`Context`。

### Level 3：小型实现

写一个不依赖 Harness 的 50 行 TypeScript 实验：

- 基础配置有两个带 `id` 的模块。
- 后层 Patch 整块替换其中一项配置。
- 激活第二项时故意抛错。
- 验证第一项的 disposer 在异常返回前执行。

验收标准不是“能跑”，而是日志顺序明确证明 acquire、failure、dispose 的因果顺序。

## 18. 小结与下一章钩子

本章沿 `dsh web --patch ./team.cordis.yml --port 3090` 走完了：

```text
argv
 → DshInvocation
 → Profile + ordered patches
 → effective entries
 → Context + Loader
 → dependency-driven Fibers
 → activation audit
 → ready / rollback
```

现在还有一个关键黑盒：我们反复说“Fiber 会等 Service”“Effect 会随树撤销”“Context 能隔离作用域”，但这些保证到底由什么数据结构和状态机实现？

下一章进入 Cordis 插件内核，继续用本章启动后的 Web 产品做场景：**当一个插件注册服务、事件和副作用时，Cordis 怎样确保它们属于正确的作用域，并在卸载时一项不漏地回收？**
