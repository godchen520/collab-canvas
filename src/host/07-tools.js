// 模型可见动态工具（execute 直调 store，写入标记 source:'ai'）
function toolOutput(v) { return JSON.stringify(v) }
function resolveCanvas(args) {
  const id = args && args.canvasId ? args.canvasId : activeId
  const c = id ? canvases.get(id) : undefined
  if (!c) return { error: err('E_NOT_FOUND', '未找到目标画布' + (id ? '：' + id : '（当前无活跃画布，可先 canvas_create）')) }
  return { c: c }
}

ctx.tools.register(defineTool({
  name: 'canvas_list',
  description: '列出共创话布（DSH 画布插件）中的全部画布及当前活跃画布。当用户提到"画布/共创话布/话布/canvas"时先调用它了解现状。',
  parameters: {},
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function () {
    const arr = []
    canvases.forEach(function (c) { arr.push({ id: c.id, title: c.title, type: c.type, version: c.version, chars: c.content.length, hasFile: !!c.filePath }) })
    return toolOutput({ ok: true, activeId: activeId, canvases: arr, docsDir: docsDir(), hint: '需要新画布用 canvas_create；读取内容用 canvas_read。' })
  },
}))

ctx.tools.register(defineTool({
  name: 'canvas_create',
  description: '新建一个 Markdown 文档画布并设为活跃画布。用户说"开个新画布写XX/在共创话布上起草XX"时调用。',
  parameters: { title: { type: 'string', required: true, description: '画布标题，同时用作默认文件名' } },
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function (args) {
    const title = args && typeof args.title === 'string' && args.title.trim()
    if (!title) return toolOutput(err('E_BAD_ARGS', 'title 必须为非空字符串'))
    const c = createCanvasDoc(title)
    return toolOutput({ ok: true, canvasId: c.id, title: title, hint: '已创建并设为活跃画布，接着可用 canvas_write 写入内容。' })
  },
}))

ctx.tools.register(defineTool({
  name: 'canvas_read',
  description: '读取一个画布的标题与完整 Markdown 内容（含版本号）。写入前务必先读；用户问"画布里有什么"也用它。',
  parameters: {
    canvasId: { type: 'string', description: '画布 id，缺省读活跃画布' },
    head: { type: 'number', description: '只返回前 N 个字符（大文档粗看用）' },
  },
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function (args) {
    const r = resolveCanvas(args)
    if (r.error) return toolOutput(r.error)
    let content = r.c.content
    if (args && typeof args.head === 'number' && args.head > 0 && content.length > args.head) {
      content = content.slice(0, args.head) + '…(截断，共 ' + r.c.content.length + ' 字符)'
    }
    return toolOutput({ ok: true, canvasId: r.c.id, title: r.c.title, version: r.c.version, content: content })
  },
}))

ctx.tools.register(defineTool({
  name: 'canvas_write',
  description: '向画布写入 Markdown 内容（AI 编辑直接生效，用户可撤销）。replace 需先 canvas_read 取最新 baseVersion 强一致检查；append/prepend 无需 baseVersion。',
  parameters: {
    content: { type: 'string', required: true, description: '要写入的 Markdown 文本' },
    mode: { type: 'string', description: "写入模式：'replace'(默认整文替换) | 'append' 追加到末尾 | 'prepend' 插入开头" },
    canvasId: { type: 'string', description: '画布 id，缺省写活跃画布' },
    baseVersion: { type: 'number', description: '期望的当前版本号；与服务端不符将拒绝以防覆盖他人修改' },
  },
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function (args) {
    if (!args || typeof args.content !== 'string') return toolOutput(err('E_BAD_ARGS', 'content 必须为字符串'))
    const mode = args.mode || 'replace'
    const r = resolveCanvas(args)
    if (r.error) return toolOutput(r.error)
    const w = applyWrite(r.c, args.content, mode, typeof args.baseVersion === 'number' ? args.baseVersion : undefined, 'ai')
    if (w.badMode) return toolOutput(err('E_BAD_ARGS', "mode 仅支持 'replace'|'append'|'prepend'"))
    if (w.conflict) return toolOutput(Object.assign(err('E_CONFLICT', '版本冲突：服务端已是 v' + w.currentVersion + '，请先 canvas_read 再重试'), { currentVersion: w.currentVersion }))
    return toolOutput({ ok: true, canvasId: r.c.id, title: r.c.title, version: w.version, mode: mode, hint: '已写入画布「' + r.c.title + '」v' + w.version + '，用户可撤销。内容约 1.5 秒后自动落盘。' })
  },
}))

ctx.tools.register(defineTool({
  name: 'canvas_save',
  description: '立即保存画布到文件（自动保存之外的手动落盘）。首次保存外部项目文件或用户明说"保存"时调用。',
  parameters: {
    canvasId: { type: 'string', description: '画布 id，缺省保存活跃画布' },
    filePath: { type: 'string', description: '目标文件路径；缺省用已关联路径或 <workspace>/canvas-docs/<标题>.md' },
  },
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function (args) {
    const r0 = resolveCanvas(args)
    if (r0.error) return toolOutput(r0.error)
    try {
      const r = await saveCanvas(r0.c, args && args.filePath)
      persistMeta()
      return toolOutput({ ok: true, canvasId: r0.c.id, filePath: r.path, relocated: r.relocated, hint: r.relocated ? '注意：目标目录被文件沙箱拒绝，内容已保存到沙箱认可区 ' + r.path : '已保存。' })
    } catch (e) {
      return toolOutput(err('E_IO', '写入失败：' + e.message))
    }
  },
}))

ctx.tools.register(defineTool({
  name: 'canvas_load',
  description: '把一个已有的本地 Markdown 文件加载为新画布（如打开项目里的 README/方案文档进行协作改写）。',
  parameters: {
    filePath: { type: 'string', required: true, description: '文件绝对路径' },
    title: { type: 'string', description: '画布标题，缺省用文件名' },
  },
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function (args) {
    const p = args && args.filePath
    if (!p || typeof p !== 'string') return toolOutput(err('E_BAD_ARGS', 'filePath 必须为字符串'))
    try {
      const c = await loadFileDoc(p, args && args.title)
      return toolOutput({ ok: true, canvasId: c.id, title: c.title, chars: c.content.length, hint: '已加载为画布并设为活跃。' })
    } catch (e) {
      return toolOutput(err(e.message.indexOf('ENOENT') >= 0 ? 'E_NOT_FOUND' : 'E_IO', '读取失败：' + e.message))
    }
  },
}))

ctx.tools.register(defineTool({
  name: 'canvas_configure',
  description: '查询或固定共创话布插件的存储根目录。传入 root 则固定（自动迁移已有画布文件并持久化），不传则仅查询当前生效目录。用户要求"把画布存到XX目录"时调用。',
  parameters: {
    root: { type: 'string', description: '要固定的存储根目录绝对路径；缺省仅查询' },
  },
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function (args) {
    if (args && typeof args.root === 'string' && args.root.trim().length > 2) {
      try {
        const out = await setRootDoc(args.root.trim())
        return toolOutput({ ok: true, root: out.root, migrated: out.migrated, hint: '存储根已固定并持久化，迁移了 ' + out.migrated + ' 个画布文件。' })
      } catch (e) {
        return toolOutput(err('E_IO', '设置失败：' + e.message))
      }
    }
    return toolOutput({ ok: true, root: docsDirBase(), docsDir: docsDir(), hint: '当前存储根如上；传 root 参数可固定到其他目录。' })
  },
}))

ctx.tools.register(defineTool({
  name: 'canvas_delete',
  description: '删除一个画布记录（内存 + meta 落盘）。删除后文件保留在磁盘可手动清理；用户说"删除/清理某个画布"时调用。',
  parameters: {
    canvasId: { type: 'string', required: true, description: '要删除的画布 id（来自 canvas_list）' },
  },
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function (args) {
    const id = args && typeof args.canvasId === 'string' ? args.canvasId : ''
    if (!id) return toolOutput(err('E_BAD_ARGS', 'canvasId 必须为字符串'))
    const c = canvases.get(id)
    if (!c) return toolOutput(err('E_NOT_FOUND', '画布不存在：' + id))
    canvases.delete(id)
    if (activeId === id) {
      const first = canvases.keys().next()
      activeId = first.done ? null : first.value
    }
    emit && emit(EV.CANVAS_CLOSED, { canvasId: id })
    try { await persistMeta() } catch (e) { console.error('[collab-canvas] delete persist failed:', e.message) }
    return toolOutput({ ok: true, canvasId: id, activeId: activeId, note: '文件保留在磁盘' + (c.filePath ? '：' + c.filePath : '（未落盘）') + '，可手动清理' })
  },
}))
