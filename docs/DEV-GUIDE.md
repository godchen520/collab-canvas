# DSH Collab-Canvas · 开发要点速查（v2 — production composition 方案）

> 本文档从 30+ 轮迭代中总结，供任何模型/会话正确维护此插件。
> **已从 cordis_define 动态方案迁移到 DSH composition 插件（生产部署）**。
> 源码：`src/host/*.js` + `src/client/*.js` → 构建：`node tools/build.js` → 产物：`dist/*.js`

---

## 零、当前部署状态（2026-09 最新）

**生产部署：单包 `collab-canvas`**（host + client 同包，`dsh.bundle.patch` 自动注册）：

- 物理位置：`E:\DeepSeek Harness\.dsh\profiles\web\node_modules\collab-canvas\`
- composition 条目：web profile 的 `cordis.patch.yml` 里 `insert` → `id: collab-canvas`
- **Host 半边**：`dist/host.js`（由 `tools/build.cjs` 从 `src/host/*.js` 拼出）
- **Client 半边**：`lib/client.js` —— 独立的 `__ModuleLoader__.load` 模块，
  源文件是 `src/client/editor-panel.js`；由 package.json 的 `dsh.client` 声明加载
- 另有 `lib/docdrop.js`、`lib/doclink.js`：host 按请求实时供源码的独立客户端模块
  （改完**刷新页面**即生效，不用重启）
- 已注册 8 个 AI 工具（经 `ctx.tools.register`）：
  `canvas_list` / `create` / `read` / `write` / `save` / `load` / `configure` / `delete`
- 数据持久化到：`canvas-docs/`，会话清单在 `canvas-docs/.sessions/<sid>.json`

> 历史遗留（2026-09-12 清理）：早期曾有 `collab-canvas-host` + `collab-canvas-client`
> 两个包，客户端走 `dist/client.js`（cordis composition 版）。现客户端统一走
> `lib/client.js`，`src/client/00-*.js ~ 99-*.js` 与 `dist/client.js` 均已删除。

**验证方式**：AI 直接调 `canvas_list` 返回画布列表；`canvas_write` 协作写画布。✅ 已验证工作。

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
const inject = ['timer', 'tools', 'fs', 'systemPrompt']
function apply(ctx, config) {
  // 注册工具：ctx.tools.register(defineTool({...}))
  ctx.tools.register(defineTool({ name: 'canvas_list', ... }))
  // 读服务：ctx.fs / ctx.get('sandboxPolicy')
}
export { apply, inject, name }
```

### 2.2 build.js 已改为 composition 输出

`node tools/build.js` 现在输出：
```
import { defineTool } from "@deepseek-ai/dsh-tools"
export const name = 'collab-canvas-host'
export const inject = ["timer","tools","fs","systemPrompt"]
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

## 三、已部署的 Phase 1（Host AI 工具）

### 改造点
- `00-ctx.js`：`ctx.fs`（injected）+ `ctx.get('sandboxPolicy')`（可选）
- `07-tools.js`：`harness.registerTool` → `ctx.tools.register(defineTool(...))`
- `06-rpc.js`：整段用 `if (typeof harness !== 'undefined')` 守卫（composition 下不执行）
- `08-prompt.js`：`sp.section()` 必须带 `order`（缺了报 "order must be a finite number"）
- `build.js`：输出 composition ESM，inject 含 `tools`/`fs`/`systemPrompt`

### 构建/部署步骤
```
1. node tools/build.js                    # 生成 composition ESM dist
2. Copy dist/host.js → node_modules/collab-canvas-host/index.mjs
3. web profile cordis.patch.yml insert:
     - id: collab-canvas-host
       name: collab-canvas-host
       config: {}
4. 重启 DSH
```

### 验证
- 日志出现 `[collab-canvas] host half ready` + `restored N canvas(es)`
- AI 能调 `canvas_list` 返回画布列表

---

## 四、Phase 2 方案（WYSIWYG 编辑器「话布」Tab，待做）

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
| host half ready 但工具没注册 | `ctx.tools.register` 的 defineTool 未 import | build.js 加 `import { defineTool }` |
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
