# collab-canvas（话布）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH Compatible](https://img.shields.io/badge/DSH-0.2.x-brightgreen)](https://github.com/deepseek-ai/deepseek-harness)

> 面向 DeepSeek Harness（DSH）的**协作画布**插件：一块人和 AI 共写的 Markdown 文档面。

## 它解决什么问题

在聊天窗口里，AI 的长内容会刷屏，改一个段落要重发全文，版本也追不回来。

话布把长内容搬到一块**独立画布**上：

- 它在 DSH 界面里以 Markdown 文档的形式存在，你可以**直接编辑**
- AI 通过 9 个 `canvas_*` 工具读写它，而不是把内容贴进对话
- 双方的每次写入都进**撤销历史**，随时可以退回去
- 写入带**版本检查**，AI 不会盲目覆盖你刚改的内容

## 功能

| 功能 | 说明 |
|------|------|
| 📝 **浏览器内编辑** | 画布在 DSH 页面内渲染与编辑，改动自动保存 |
| 🤖 **AI 可读写** | 9 个 `canvas_*` 工具，模型直接操作画布 |
| ↩️ **撤销历史** | 每次写入入栈，你和 AI 的改动都可回退 |
| 🔒 **冲突检测** | `canvas_write` 支持 `baseVersion` 强一致检查，不符返回 `E_CONFLICT` 并给出最新版本 |
| 💾 **文件持久化** | 画布落成普通 `.md` 文件，另有 `.canvases.json` 记录元信息 |
| 🎯 **划词引用** | 选中画布里的文字即弹出划词栏，可把该段引用进对话 |
| 🔗 **文档链接/拖放** | 画布内可拖入文档、生成链接 |
| 📁 **存储根可配** | `canvas_configure` 可把画布根目录固定到任意位置（如项目目录） |
| 🎨 **跟随主题** | 界面全部使用 `var(--dsw-*)` 设计 token，换肤自动适配 |

## AI 工具

| 工具 | 用途 |
|------|------|
| `canvas_list` | 列出全部画布与当前活跃画布 |
| `canvas_create` | 新建一个画布 |
| `canvas_read` | 读取画布内容（`head` 可只取前 N 字符粗看） |
| `canvas_write` | 写入/修改（`replace` / `append` / `prepend`，可选 `baseVersion` 强一致检查） |
| `canvas_save` | 保存到文件（可指定 `filePath`） |
| `canvas_load` | 把已有 Markdown 文件加载为画布 |
| `canvas_locate` | 在文档中精确定位一段原文（多处重复时确认是第几处） |
| `canvas_delete` | 删除画布记录 |
| `canvas_configure` | 固定画布存储根目录 |

## 安装

```bash
# 1. 装进 profile
dsh plugin --profile web add github:godchen520/collab-canvas

# 2. 把 "collab-canvas" 加进 profile package.json 的 dsh.profile.bundles 数组
#    （只加 dependencies 不加 bundles 的话，cordis.patch.yml 不会生效 —— 插件"装了但没启用"）

# 3. 重启
dsh web
```

> **两处都要加**：`dependencies` 负责把包装上，`dsh.profile.bundles` 负责让它的
> `cordis.patch.yml` 进入组合。缺任何一边都会出现"装上了但功能不在"。

## 数据存放

```
<存储根>/
├── .canvases.json      # 画布元信息（id、标题、关联文件、版本）
├── <标题>.md           # 画布正文，普通 Markdown 文件
├── .sessions/          # 会话级清单（运行时状态）
└── attachments/        # 画布里粘贴/拖入的图片
```

存储根默认取当前会话工作区；用 `canvas_configure` 可固定到别处，重启后仍生效。

> `canvas-docs/`、`uploads/` 属于**使用中产生的个人内容**，已列入 `.gitignore`，不进本仓库。

## 架构

插件由两半组成，分别跑在两个平面：

| 平面 | 文件 | 职责 |
|------|------|------|
| **Host**（DSH Node 进程） | `dist/host.js` | 注册 9 个工具、HTTP 端点（`/api/canvas/*`）、画布状态与持久化、编辑器脚本 |
| **Client**（浏览器页面） | `lib/client.js` | 注入编辑器 UI、划词栏、右键/长按菜单、与 Host 的 RPC |

- `dist/host.js` 由 `src/host/*.js` 构建（`node tools/build.js`）
- `lib/client.js` 由 `src/client/editor-panel.js` 同步而来（客户端为保证运行时不引入打包器，采用直接拼装）

设计细节见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 与 [`docs/DESIGN.md`](docs/DESIGN.md)。

## 开发

```bash
npm run build         # src/host/*.js  → dist/host.js
npm test              # 回归测试
npm run verify        # 上线前总检（含真跑测试 + 部署一致性 + 文档检查）
npm run deploy        # 一键搬运到 DSH 部署目录（--check 只看差异）
```

**部署目录**默认由 `DSH_HOME` 推导：

```
$DSH_HOME/profiles/web/node_modules/collab-canvas
```

换机器或换 profile 时，用环境变量覆盖：

```bash
CCV_DEPLOY_DIR=/path/to/deployed/collab-canvas npm run deploy
```

**生效方式**（两种别混）：

- 改了 `src/host/*.js` → 搬运后必须**完全重启 `dsh web`**（刷新页面不够）
- 只改了客户端 → 搬运后**刷新页面**即可

## 兼容性

| DSH 版本 | 状态 |
|---|---|
| **0.2.x（0.2.0-rc.2 实测）** | ✅ 支持 |

本插件从 `@deepseek-ai/dsh-tools` 取 `defineTool`（已声明为 `peerDependencies`），
其余宿主能力（`timer`、`tools`、`fs`、`webServer`、`systemPrompt`）全部通过
cordis 服务注入获取。

## License

[MIT](LICENSE)
