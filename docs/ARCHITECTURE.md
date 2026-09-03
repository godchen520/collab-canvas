# DSH Collab-Canvas 架构文档

> 状态：初稿（§8 待勘察项将在阶段 1 接口勘察后回填）
> 关联文档：[DESIGN.md](./DESIGN.md) · [TOOL-SCHEMAS.md](./TOOL-SCHEMAS.md)

## 1. 平台划分

### Host（DSH Node.js 进程内）

职责：状态的唯一权威持有者。

| 模块 | 职责 |
|------|------|
| canvasStore | 画布注册表：多画布、当前活跃画布、内容版本号、undo/redo 历史 |
| fileIO | 文件读写：workspace 内目录 + 外部白名单映射目录；realpath 校验防路径越界 |
| eventBus | Host 内事件总线：发布内容变更/文件/AI 编辑事件（V2 联动的接缝） |
| toolRegistrar | 注册 canvas_* 动态工具给模型 |
| rpcHandlers | harness.handle 注册 Client→Host 私有 RPC |
| autosave | timer 服务驱动的防抖自动保存 |

### Client（浏览器页面内）

职责：纯视图层，不持有权威状态，每次操作经 RPC 落到 Host 再回读结果。

| 组件 | 职责 |
|------|------|
| CanvasPanel | 画布面板容器：标签页切换、新建/关闭画布 |
| DocumentCanvas | Markdown 编辑区 + 预览区分栏、同步滚动 |
| Toolbar | 保存 / 撤销 / 重做 / 新建 / 打开 |
| AICommandBar | 底部指令输入栏（V1 引导式） |
| HistoryPanel | 编辑历史列表（区分 human/ai 来源），点击回退到该快照 |

### 通信规则

- **Client → Host**：`host.call` / `harness.handle` 包级私有 RPC，仅无损 JSON；
- **Host → Client 推送**：是否存在推送机制**待勘察**（§8.1）。若无，V1 采用客户端操作回包携带最新状态 + 编辑器本地乐观更新的方式，不做长轮询；
- **模型 → 画布**：动态工具 `execute` 在 Host 进程内直调 canvasStore，不经 RPC；
- 所有跨 RPC 的数据必须是自有的纯 JSON 叶子字段，禁止把 Service/Snapshot 等活数据序列化外传。

## 2. 数据模型

```js
// Host 内存中的画布注册表（canvasStore）
{
  canvases: Map<canvasId, {
    id: string,
    title: string,
    type: 'document',        // V1 固定；预留 'code' | 'ui-design' | 'workflow'
    content: string,          // Markdown 原文
    version: number,          // 每次成功编辑 +1，乐观锁依据
    filePath: string | null,  // 关联的保存文件（绝对路径）
    history: EditRecord[],    // undo 栈（含 AI 与人的编辑）
    redoStack: EditRecord[],
    dirty: boolean,           // 有未落盘修改
    updatedAt: number,
  }>,
  activeCanvasId: string | null,
}

// 单条编辑记录
{
  opId: string,              // nanoid 风格唯一 id
  source: 'human' | 'ai',
  before: string,            // 编辑前全文快照
  after: string,             // 编辑后全文快照
  at: number,                // 时间戳
}
```

**V1 简化决策**：undo 采用全文快照而非 diff/OT/CRDT。单人文档场景下足够可靠，实现简单。history 上限 50 条，超出丢弃最旧并同步收缩 redoStack 无效引用。

## 3. RPC 方法表（Client → Host）

统一返回 `{ ok: true, ...data }` 或 `{ ok: false, error: { code, message } }`。

| 方法 | 入参 | 出参 | 备注 |
|------|------|------|------|
| `canvas.list` | – | `{ canvases: [{id,title,type,updatedAt}] }` | |
| `canvas.create` | `{ title }` | `{ id }` | 同时成为活跃画布 |
| `canvas.open` | `{ canvasId }` | `{ id,title,content,version,filePath }` | |
| `canvas.edit` | `{ canvasId, content, baseVersion }` | `{ version }` | baseVersion 不符 → `E_CONFLICT` |
| `canvas.undo` | `{ canvasId }` | `{ content,version } \| { noop:true }` | |
| `canvas.redo` | `{ canvasId }` | 同上 | |
| `canvas.save` | `{ canvasId, filePath? }` | `{ filePath }` | 缺省存关联路径或默认目录 |
| `canvas.loadFile` | `{ filePath }` | `{ canvasId }` | 白名单校验失败 → `E_PATH_DENIED` |
| `canvas.close` | `{ canvasId }` | `{}` | dirty 时需 `{ force:true }` 否则 `E_DIRTY` |
| `canvas.setActive` | `{ canvasId }` | `{}` | |

错误码：`E_NOT_FOUND` / `E_CONFLICT` / `E_PATH_DENIED` / `E_DIRTY` / `E_IO` / `E_BAD_ARGS`。

## 4. 动态工具（模型可见）

六个工具的完整 schema 见 [TOOL-SCHEMAS.md](./TOOL-SCHEMAS.md)。要点：

- `canvas_write` 默认整文替换并做版本检查；也提供 append/prepend 模式降低模型负担；
- 工具 execute 直调 canvasStore，写入历史栈标记 `source:'ai'`，并发布 `AI_EDIT_APPLIED` 事件；
- 工具返回值给模型的文本要包含**下一步建议**（如"已写入 v7，可继续说'保存'"），提升对话体验。

## 5. 事件定义（V1 骨架）

```js
const CanvasEvents = {
  CONTENT_CHANGED:  'collab-canvas/content-changed', // {canvasId, version, source}
  CANVAS_CREATED:   'collab-canvas/canvas-created',  // {canvasId, title}
  CANVAS_CLOSED:    'collab-canvas/canvas-closed',   // {canvasId}
  FILE_SAVED:       'collab-canvas/file-saved',      // {canvasId, filePath}
  FILE_LOADED:      'collab-canvas/file-loaded',     // {canvasId, filePath}
  AI_EDIT_APPLIED:  'collab-canvas/ai-edit-applied', // {canvasId, opId}
  // —— 以下 V2 启用，先占名 ——
  WORKFLOW_TRIGGERED: 'collab-canvas/workflow-triggered',
  JUMP_TO_FILE:       'collab-canvas/jump-to-file',
  JUMP_TO_LINE:       'collab-canvas/jump-to-line',
  UI_DESIGN_UPDATED:  'collab-canvas/ui-design-updated',
}
```

eventBus 是 Host 内普通 pub/sub，`on()` 返回 disposer 并挂 Fiber，保证插件停止时清理。

## 6. 文件布局与持久化

```
<workspace>/canvas-docs/
├── .canvases.json          # 元数据：[{id,title,type,filePath}] + activeCanvasId
├── .external-roots.json    # 外部目录白名单：["D:\\proj\\a", ...]
└── <slug>.md               # 画布正文（slug 由标题生成，重名加序号）
```

规则：
- 自动保存：编辑后防抖 1500ms 落盘；save RPC 立即落盘；插件停止前 flush 全部 dirty；
- 外部路径访问：目标路径 realpath 后必须在某个白名单根之下，否则拒绝；
- `.external-roots.json` 的维护入口放设置页（V2），V1 允许用户手工编辑该文件。

## 7. Slot 注册计划（2024 阶段 1 勘察后定稿）

**画布主面板落点：`conversation.view`** —— 会话体的视图标签环（chat 与 trajectory 视图即挂于此），
list 协议，注册参数 `{ name:'conversation.view', id, order?, label? }`，
由会话体按 `only:<active id>` 一次渲染一个视图。画布作为与聊天平级的 Tab，
占据整个会话内容区。组件不依赖 owner props（数据全部经 host.call 获取），规避契约盲区。

| 目标 | Slot | 协议 | 用途 | 版本 |
|------|------|------|------|------|
| 画布主面板 | `conversation.view` | list: id/order/label | 会话级「画布」Tab | **V1** |
| 工具调用结果卡 | `tool.call.toolview` | keyed: 工具名 | canvas_* 调用卡片美化 | V1 可选 |
| Run 卡片交互区 | `tool.view.cordis` | keyed: 仅 'self' | 包级自述/快捷入口 | 备用 |
| 轻提示 toast | `shell.overlay` | list: id/order/label | 保存/冲突提醒 | **V1** |
| 侧边栏入口 | `sidebar.footer.action` | list: id/order/label | 快捷跳转画布 Tab | 备用 |
| 轮次尾部引用卡 | `conversation.chat.turnTail` | chain: select 函数 | AI 编辑摘要卡 | V2 |

## 8. 勘察结论（阶段 1 已回填）

1. **Host→Client 推送**：`webServer.registerUpgrade(WebUpgradeRoute)` 提供官方 WebSocket 通道，V2 联动采用；V1 不做推送，客户端以操作回包携带最新状态。
2. **向会话注入消息**：未发现公开服务。**AICommandBar V1 降级为引导模式**：一键复制指令 + 提示粘贴发送；后续若发现可用注入通道再升级。
3. **sidebar additive 位**：`sidebar.footer.action` 确认存在（list 协议）。
4. **fs 服务**：签名完整——`resolve(path)→FsTarget`、`readText/writeText/listDir/stat/lstat/editText/streamText/readBytes`、`contains/contains 校验`。**无 mkdir/unlink/rename**；目录创建与外部白名单校验行为在运行时探针确认。动态代码 Builtin 中无 require/process/fs 原生通道，**文件 IO 必须经 fs 服务**。
5. **timer**：双平台同构，`timeout/interval/throttle/debounce` 均返回 disposer；autosave 用 `debounce(flushAllDirty, 1500)`。
6. **工具注册**：`harness.defineTool({name,description,parameters,output:{schema,render},execute})` + `harness.registerTool(ctx, def)` 已有技能文档背书的完整示例；输出 render 返回 `[{type:'text',text}]`。
7. **Markdown 渲染器**：DSH 内部依赖 unified/shiki 栈但未暴露给动态代码（Client Builtin 仅 React/host/styles/console）。**V1 自带 ~150 行纯 JS 渲染器**（标题/粗斜体/代码块/列表/引用/链接/[[路径]]标记，全部 HTML 转义后输出）。
8. **Client 环境**：React 三件套（createElement/useState/useEffect）、`host.call`、`styles.insert(css)`、client 侧同样有 timer 服务；theme 服务可 overrideTokens（备用）。

> 过程备注：本会话中 Inspect 精确查询的对象型 input 通道异常（恒被拒为非对象），
> 剩余未知契约（FsTarget 构造细节、writeText 的 FsWriteIntent、turnTail select 签名）
> 改为 M2 垂直切片运行时探针 + 诊断回路确认。

## 10. 运行时环境关键事实（M2~M5 排障结论，务必遵守）

9. **沙箱与执行策略**：插件侧 `fs.writeText` 不传策略时按部署默认 `workspace-write` 执行，
   其"工作区"= **部署安装根**（`sandboxPolicy.workspaceRoot`，本机为 `E:\DeepSeek Harness`）——
   写到会话工作区（OneDrive 项目目录）会被拒。解法已验证：给 writeText 显式传
   字面量 `{ mode: 'danger-full-access' }`（SandboxMode 取值与工具层枚举一致）即可写任意路径；
   `policy.resolve({mode})` 亦不报错但结果未必更宽。writeFile 采用四级候选逐级尝试
   （literal-danger → resolve-danger → resolve-default → bare），任一成功即止。

10. **存储根判定**：宿主 `sessions.list()` 报告的 cwd 是 GUI 默认槽位
    （`.zcode\workspace\default`），**不是**用户项目目录；工具层的 `$env/Get-Location`
    才是真实项目路径。因此存储根以 `rootOverride`（持久化于 meta）为最高优先级，
    探测链仅作兜底。meta 双位置读写：优先 `<rootOverride>/canvas-docs/.canvases.json`，
    失败落 `<部署根>/canvas-docs/.canvases.json`。

11. **保存回退设计**：默认目录被沙箱拒绝时自动改存沙箱认可区并返回 `relocated:true`，
    UI/工具提示明确标注改存路径——**任何情况下内容不丢**；用户显式指定 filePath 失败时
    不静默改道，直接报错。

12. **fs 服务无 mkdir/unlink/rename**：目录创建依赖 writeText 的隐式行为
    （实测写 `canvas-docs/<file>` 成功，父目录由 fs 层处理或已存在），删除/重命名暂无需求。

13. **客户端 timer 服务不可用（v10 探针定位）**：Client 侧 `timer.timeout(callback, delay)`
    实测静默吞掉回调（疑似走了 `timeout(delay): Promise` 重载实现），导致依赖它的
    编辑防抖从未触发——这是"输入内容不保存"的最终根因。宿主侧 `ctx.debounce/timeout` 正常。
    **纪律：Client 侧一律不依赖 timer 服务**；v11 起编辑改为每次按键立即发送
    （不带 baseVersion，服务端末次写入为准；本地 GUI RPC 延迟极低，可靠且实现最简）。

14. **动态客户端包更新对页面即时生效**（v8~v11 徽章验证）：cordis_run update 后刷新页面
    即加载新客户端代码，无需 dev:web。调试客户端问题时在工具栏放常驻版本徽章是
    最可靠的"哪个版本在跑"判据（状态栏文字会被后续操作覆盖，不可靠）。

15. **RPC 错误可见性**：编辑类操作的失败提示会被后续操作的状态覆盖。关键操作
    （编辑/保存/删除）的状态消息带不同前缀（⏎/✓/✗），排障期保留。

## 9. 错误处理与边界原则

- 所有跳转/加载动作先做存在性检查，失败显示行内提示或 toast，绝不抛裸异常崩掉面板；
- 人机并发编辑：canvas.edit 带 baseVersion 乐观锁，冲突时返回服务端最新 content，客户端弹"刷新合并"提示（V1 不做自动三方合并）;
- AI 正在写入时人在打字：Host 侧串行化（同一画布的编辑按到达顺序应用），前端以回包 version 为准覆盖本地草稿前先 diff 提示；
- 插件生命周期：所有 timer、监听、Slot、Tool 注册必须挂当前 Fiber 的 disposer；停止前 flush dirty 画布。
