# DSH Collab-Canvas · 开发要点速查（v3 — 2026-09-16 校正）

> 本文档从 30+ 轮迭代中总结，供任何模型/会话正确维护此插件。
> **已从 cordis_define 动态方案迁移到 DSH composition 插件（生产部署）**。
> 源码：`src/host/*.js` + `src/client/editor-panel.js`
> → 构建：`node tools/build.cjs`（npm run build）→ 产物：`dist/host.js`
>
> ⚠️ **2026-09-16 校正过一批错话**。旧版本有三类错误，凡是别处（含历史会话记录）
> 还写着的，以下面为准：
> 1. 到处都是 `node tools/build.js` —— **这个文件从来不存在**，真名是 `tools/build.cjs`。
> 2. 说"已注册 8 个 AI 工具" —— 实际是 **9 个**（后来加了 `canvas_locate`）。
> 3. 第三、四节描述的是**已废弃的旧部署方式**（两个包 + 拷成 `index.mjs`），
>    与第零节的现状自相矛盾。旧内容已改写为"历史沿革"。
>
> 📌 **维护约定**：本文件里的命令与数字，**改流程时必须同步改这里**。
> 判断它有没有过期的最快办法：跑一遍 `node tools/verify-all.cjs`，
> 再看本文件里出现的每个 `tools/xxx` 命令**是否真的存在**。

---

## 零、当前部署状态（2026-09-16 最新）

**生产部署：单包 `collab-canvas`**（host + client 同包，`dsh.bundle.patch` 自动注册）：

- 物理位置：`E:\DeepSeek Harness\.dsh\profiles\web\node_modules\collab-canvas\`
- 启用方式：`profiles/web/package.json` 的 **`dsh.profile.bundles`** 数组里有 `collab-canvas`，
  包自身的 `package.json` 再通过 `dsh.bundle.patch` 指向本包的 `cordis.patch.yml`
  （该文件内容就是 `insert: - id: collab-canvas`）
- **Host 半边**：`dist/host.js`（由 `tools/build.cjs` 从 `src/host/*.js` 按文件名拼出）
- **Client 半边**：`lib/client.js` —— 独立的 `__ModuleLoader__.load` 模块，
  源文件是 `src/client/editor-panel.js`；由 package.json 的 `dsh.client` 声明加载
  ⚠️ **它不走 build.cjs**（该脚本只构建 host），由 `tools/deploy.cjs` 自动同步（见下一节）
- 另有 `lib/selref.js`、`lib/docdrop.js`、`lib/doclink.js`：host **按请求实时读盘**供出去的
  独立客户端模块 —— 改完**刷新页面即生效**，不用重启
- 已注册 **9 个** AI 工具（经 `ctx.tools.register`，全在 `src/host/07-tools.js`）：
  `canvas_list` / `create` / `read` / `write` / `save` / `load` / `configure` / `delete` / `locate`
- 数据持久化到：`canvas-docs/`，会话清单在 `canvas-docs/.sessions/<sid>.json`

> 历史遗留（2026-09-12 清理）：早期曾有 `collab-canvas-host` + `collab-canvas-client`
> 两个包，客户端走 `dist/client.js`（cordis composition 版）。现客户端统一走
> `lib/client.js`，`src/client/00-*.js ~ 99-*.js` 与 `dist/client.js` 均已删除。

**验证方式**：AI 直接调 `canvas_list` 返回画布列表；`canvas_write` 协作写画布。✅ 已验证工作。

---

## 零点五、日常四条命令（先看这个）

```bash
node tools/test-all.cjs     # 跑全部回归测试（自动收 tools/test-*.cjs，勿手打多条）
node tools/build.cjs        # 重新构建 dist/host.js（只构建 host！）
node tools/deploy.cjs       # 一键搬运到部署副本（含同步客户端 + 构建过期检查）
node tools/verify-all.cjs   # 上线前总检：真跑测试 + 工作区↔部署一致性 + 历史守卫
```

只改了客户端或侧模块时，中间那条 `build.cjs` 可以跳过（客户端不走构建）；
**改了 `src/host/*.js` 就必须先 `build.cjs` 再 `deploy.cjs`**，顺序别倒。

有 npm 的正常终端里也可以：`npm test` / `npm run build` / `npm run deploy` / `npm run verify`。
（`npm` 在某些受限 shell 里起不来，所以**以直接跑 node 的那四条命令为准**。）

### 🔴 改动生效方式（分三种，别混）

| 改了什么 | 怎么才能生效 |
| --- | --- |
| `src/host/*.js` → `dist/host.js` | `build.cjs` + `deploy.cjs` + **完全重启 dsh web** |
| `src/client/editor-panel.js` → `lib/client.js` | `deploy.cjs`（会自动同步这步）+ **刷新页面** |
| `lib/selref.js` 等侧模块 | `deploy.cjs` + **刷新页面**（host 按请求读盘） |

### 🔴 同步清单（已由 deploy.cjs 代劳）

改完源码后要保证这 **7 份**在**工作区与部署副本**两边一致：

```
dist/host.js   lib/client.js   lib/selref.js
lib/doclink.js lib/docdrop.js  package.json  cordis.patch.yml
```

`node tools/verify-all.cjs` 的第 3 节会把它们逐个比一遍并指出哪份不一致；
要动手搬运则用下面这条（不用再挨个拷）。

~~~bash
node tools/deploy.cjs           # 一键搬运：本仓库 → 部署副本（npm run deploy）
node tools/deploy.cjs --check   # 只看差哪几份，一个字节都不动
~~~

它顺带把两件最容易做错的事一起做了：

1. **先同步客户端** —— `src/client/editor-panel.js` → `lib/client.js`
   （这两份确认过是纯拷贝、内容完全相同，所以脚本可以代劳；
   以前那步"必须手工"是因为 `build.cjs` 不管客户端这一半）。
2. **先查构建是否过期** —— `dist/host.js` 比 `src/host/*.js` 旧就直接拒绝搬运
   并提示先跑 `build.cjs`，防止把旧的服务端推上去。

搬完还会把 7 份**读回来再逐个校验**，不给"搬了但没生效"留缝。
搬运是纯拷贝、可反复跑，两边已一致时会全部跳过。

---

## 一、为什么不能用 cordis_define（重要教训）

`cordis_define` 是**动态插件系统**，但有两个致命问题：

1. **oneOf 校验 bug（模型相关）**：`plugin` 参数的 `oneOf` 校验对合法输入判 "matched 0"。实测 Ox Alpha ≈100% 成功，DeepSeek V4 时好时坏，mimo 常失败。**这不是参数问题，是模型生成结构化参数的能力差异 + 框架 bug。**
2. **仅用于开发**：用户明确"cordis 只是开发调试工具，要正式部署"。

❌ **结论：不要再依赖 cordis_define。改用 composition 插件（见下文）。**

---

## 二、composition 插件生产部署（正确方案）

### 2.1 插件格式（ESM module）

真正的 DSH composition 插件格式（参考 `dsh-tool-fs`、`dsh-web-remote`）：

```js
const name = 'collab-canvas-host'
const inject = ['timer', 'tools', 'fs', 'webServer', 'systemPrompt']
function apply(ctx, config) {
  // 注册工具：ctx.tools.register(defineTool({...}))
  ctx.tools.register(defineTool({ name: 'canvas_list', ... }))
  // 读服务：ctx.fs / ctx.get('sandboxPolicy')
}
export { apply, inject, name }
```

### 2.2 build.cjs 输出 composition 格式

`node tools/build.cjs` 输出：
```
import { defineTool } from "@deepseek-ai/dsh-tools"
export const name = 'collab-canvas-host'
export const inject = ["timer","tools","fs","webServer","systemPrompt"]
export function apply(ctx, config) { ... }
```

### 2.3 关键差异（动态沙箱 vs composition）

| | 动态系统（cordis_define） | composition 插件 |
|--|--|--|
| 工具注册 | `harness.registerTool(ctx, harness.defineTool(...))` | `ctx.tools.register(defineTool(...))` |
| defineTool | `harness.defineTool` | `import { defineTool } from "@deepseek-ai/dsh-tools"` |
| 文件服务 | `ctx.get('fs')` | `ctx.fs`（inject） |
| Client 全局 | `React`/`styles`/`host`/`harness`（new Function 注入，仅动态） | **不存在**——composition 是 import 模块，不注入这些 |
| client-host 通信 | `harness.handle`/`host.call` | **`webServer` HTTP 端点 + `tapIndex` 注入脚本**（dsh-web-remote 模式） |

---

## 三、Phase 1 已落地（Host AI 工具）

> ⚠️ **本节的历史沿革**：下面"构建/部署步骤"里的 `collab-canvas-host/index.mjs` 是
> **早期双包方案**，**已废弃**。当前正确流程见**第零节与零点五节** ——
> 单包 `collab-canvas`，改完跑 `verify-all.cjs`、按"改动生效方式"那张表操作。
> 保留这段是为了解释为什么代码里还留着 `typeof harness` 之类的守卫。

### 改造点（当时的记录，仍有效）
- `00-ctx.js`：`ctx.fs`（injected）+ `ctx.get('sandboxPolicy')`（可选）
- `07-tools.js`：`harness.registerTool` → `ctx.tools.register(defineTool(...))`
- `06-rpc.js`：整段用 `if (typeof harness !== 'undefined')` 守卫（composition 下不执行）
- `08-prompt.js`：`sp.section()` 必须带 `order`（缺了报 "order must be a finite number"）
- `build.cjs`：输出 composition ESM，inject 含 `tools`/`fs`/`webServer`/`systemPrompt`

### 构建/部署步骤（❌ 已废弃，仅存档）
```
1. node tools/build.cjs                   # 生成 composition ESM dist（当时文档里错写成 build.js）
2. Copy dist/host.js → node_modules/collab-canvas-host/index.mjs   ← 双包方案，已不适用
3. web profile cordis.patch.yml insert: - id: collab-canvas-host   ← 现走 dsh.bundle.patch
4. 重启 DSH
```

### 验证
- 日志出现 `[collab-canvas] host half ready` + `restored N canvas(es)`
- AI 能调 `canvas_list` 返回画布列表

---

## 四、Phase 2 架构（WYSIWYG 编辑器「话布」Tab —— ✅ 已完成）

> 本节保留的是**当时的设计依据**（为什么客户端必须走 HTTP 而不是 `host.call`）。
> 「话布」Tab 本身已上线：注册在官方右侧栏，入口是门厅页那张「话布」卡片。
> 后续演进（选区引用、位置注入等）见 `canvas-docs/` 下的设计文档。

### 架构（composition 兼容，不需 cordis）
参考 `dsh-web-remote`：
1. **Host**：加 `webServer` 到 inject，用 `webServer.register({ kind:'exact', path:'/canvas/list', handler: async (req,res)=>{} })` 注册画布 CRUD HTTP 端点
2. **Client**：用 `webServer.tapIndex()` 注入编辑器脚本；编辑器用 **fetch** 调这些 HTTP 端点

### webServer 服务（已确认存在）
- id: `webserver`，name: `@deepseek-ai/dsh-host-webserver`
- `register({ kind:'exact'|'prefix', path, handler })` — handler 收 `(req,res)`（node:http）
- `tapIndex(transform)` — 往 index HTML 注入 `<script>`

### 注意
- `React`/`styles`/`host`/`harness` 是**动态沙箱专属全局**，composition client **拿不到**
- client 编辑器的数据访问必须走 HTTP（webServer 端点），不能走 `host.call`

---

## 五、关键服务名（compodition 里确认存在）

| 服务 | inject 名 | 说明 |
|------|----------|------|
| 工具注册 | `tools` | `ctx.tools.register(defineTool(...))` |
| 文件 | `fs` | `ctx.fs` |
| 提示词 | `systemPrompt` | `ctx.get('systemPrompt').section({order, ...})`（**必须带 order**）|
| 定时器 | `timer` | `ctx.debounce/timeout` |
| HTTP | `webServer` | id: webserver，注册端点 |

---

## 六、常见错误速查

| 症状 | 根因 | 修复 |
|------|------|------|
| prompt section "undefined" order 报错 | `sp.section()` 缺 `order` | 加 `order: 200` |
| host half ready 但工具没注册 | `ctx.tools.register` 的 defineTool 未 import | build.cjs 加 `import { defineTool }` |
| harness is not defined | 用了动态 API 但打了 composition | 06-rpc.js 用 `if (typeof harness)` 守卫 |
| styles/React 未定义（client） | composition 不注入动态全局 | 改用 webServer HTTP + tapIndex |
| DSH 启动崩溃 loader fibers failed | composition 插件 `apply` 抛错 | 查具体原因；一般是不该访问的全局 |

---

## 七、存储根（rootOverride）

```
rootOverride（持久化 meta）> sessions.cwd > workspaceRegistry > 部署根
```
⚠️ `sessions.list()` 报告的 cwd = GUI 槽位 ≠ 用户项目目录
⚠️ meta 必须双写所有候选位置（冷启动任何一份都带 override）
⚠️ composition 下 `docsDirBase()` 初始可能是部署根（`E:\DeepSeek Harness\canvas-docs`），restore 会读取 meta 里的 rootOverride 纠正到项目目录

---

## 八、改话布文档必须走画布，不能直接改文件（重要）

`canvas-docs/*.md` 的内容有**两份**：

| 位置 | 谁在用 |
| --- | --- |
| **画布内存**（host 的 `canvases` Map） | 画布面板显示的就是这份 |
| **磁盘文件** | git、外部工具、AI 读文件时看的是这份 |

**直接写文件只更新磁盘，画布内存仍是旧内容**，后果有两个：

1. 面板里看到的还是旧版本（用户以为你没改）
2. **面板下一次自动保存会把内存里的旧内容写回文件** —— 反过来覆盖掉你在文件上做的修正

**正确做法（三选一）：**

- `canvas_write` 工具（AI 用）
- `POST /api/canvas/write`，带 `knownVer`（脚本用）
- 直接改文件之后，**必须**再把文件内容写回画布同步一次

> 2026-09-14 实际踩到：用脚本直接改了设计稿的日期与代码围栏语言，
> 文件是对的、面板里还是旧的；靠用户引用那一行才发现。

同理，**恢复/改写文档时不要直接 `writeFileSync`** —— 用带 `knownVer` 的写回，
它同时更新内存与磁盘，且能挡住并发覆盖。
