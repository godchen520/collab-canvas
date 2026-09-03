# DSH Collab-Canvas 工具 Schema 定义

> 状态：初稿。注册时的确切签名以 `Builtin.listBuiltins` 勘察结果为准，参数 schema 以本文件为准。
> 关联文档：[DESIGN.md](./DESIGN.md) · [ARCHITECTURE.md](./ARCHITECTURE.md)

## 总则

- 参数与返回值均为无损 JSON；
- 未指定 `canvasId` 时默认操作**当前活跃画布**；无活跃画布时报错并提示先创建；
- 返回给模型的文本末尾附**下一步建议**，引导多轮协作；
- 所有写操作进入 undo 历史栈，标记 `source:'ai'`，人可撤销。

---

## canvas_list

列出全部画布。

| 项 | 内容 |
|----|------|
| 用途 | 让模型知道现有哪些画布、哪个是活跃画布，便于选择目标 |
| 参数 | 无 |
| 返回 | `{ canvases: [{ id, title, type, updatedAt, hasFile }], activeId }` |

## canvas_create

新建一个文档画布。

| 项 | 内容 |
|----|------|
| 用途 | 用户要求"开个新画布写XX"时调用 |
| 参数 | `title: string`（必填，画布标题，同时用作默认文件名） |
| 返回 | `{ canvasId, title }` |
| 建议 | 创建后通常紧接着 canvas_write 写入内容 |

## canvas_read

读取画布内容。

| 项 | 内容 |
|----|------|
| 用途 | 编辑前先读现状；用户问"画布里写了什么"时也用它 |
| 参数 | `canvasId?: string`（缺省=活跃画布）；`head?: number`（可选，只取前 N 字符，用于大文档粗看） |
| 返回 | `{ canvasId, title, content, version, updatedAt }` |
| 建议 | 写入前务必先 read，避免盲目覆盖他人内容 |

## canvas_write

写入/修改画布内容。

| 项 | 内容 |
|----|------|
| 用途 | AI 向画布产出内容的唯一入口：写方案、改章节、追加笔记 |
| 参数 | `content: string`（必填）；`mode?: 'replace' \| 'append' \| 'prepend'`（缺省 replace）；`baseVersion?: number`（提供时做强一致检查，不符返回 E_CONFLICT 和最新 version） |
| 返回 | `{ canvasId, version, opId, mode }`；冲突时 `{ error:'E_CONFLICT', currentVersion }` |
| 行为 | 整文替换场景必须先 canvas_read 拿最新 version 作为 baseVersion；append/prepend 无需 baseVersion |

## canvas_save

保存画布到文件。

| 项 | 内容 |
|----|------|
| 用途 | 用户说"保存/落到文件"时调用；外部项目文件的首次保存也走这里 |
| 参数 | `canvasId?: string`；`filePath?: string`（缺省=已关联路径或默认目录 `<workspace>/canvas-docs/<slug>.md`） |
| 返回 | `{ filePath, bytes }`；路径被拒时 `{ error:'E_PATH_DENIED', hint:'将目录加入 .external-roots.json 白名单' }` |

## canvas_load

从文件加载为画布。

| 项 | 内容 |
|----|------|
| 用途 | 用户说"把 XX.md 打开成画布"时调用；加载已有项目文档进行协作改写 |
| 参数 | `filePath: string`（必填）；`title?: string`（缺省用文件名） |
| 返回 | `{ canvasId, title, sizeChars }`；不存在 → `{ error:'E_NOT_FOUND' }` |

## canvas_trigger_workflow （V2 预留，V1 不注册）

| 项 | 内容 |
|----|------|
| 用途 | 全栈协作的执行环节：触发编译/测试等工作流并把结果反馈进画布 |
| 参数（草案） | `name: string`；`args?: object`；`feedbackToCanvasId?: string` |
| 依赖 | Harness subagent/workflow 能力的确切调用方式，V2 勘察后定稿 |

---

## 模型使用指引（将写入 preset prompt section）

1. 用户提到"画布/canvas/写在画布上"→ 使用本组工具，**不要**把长内容直接贴在聊天里；
2. 写入 replace 模式前必须先 canvas_read；
3. 大改动建议分段 append，每段完成后告知用户可 Ctrl+Z 回退；
4. 用户未明说保存时不主动 canvas_save（自动保存已在后台进行）；
5. 引用画布内容进对话时只摘必要片段，避免刷屏。
