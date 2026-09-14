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
    // 会话清单登记：AI 建的画布归入浏览器最近在看的会话清单（面板轮询可见）
    try { sessAdd(lastBrowserSid, c.id) } catch (_) {}
    return toolOutput({ ok: true, canvasId: c.id, title: title, hint: '已创建并设为活跃画布，接着可用 canvas_write 写入内容。本轮结束前记得调用 present 声明 "canvas-docs/' + slugify(c.title) + '.md"——它会在回复末尾生成一张可点卡片，点开就是话布面板。' })
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
    return toolOutput({ ok: true, canvasId: r.c.id, title: r.c.title, version: w.version, mode: mode, hint: '已写入画布「' + r.c.title + '」v' + w.version + '，用户可撤销。内容约 1.5 秒后自动落盘。本轮结束前记得调用 present 声明 "canvas-docs/' + slugify(r.c.title) + '.md"——它会在回复末尾生成一张可点卡片，点开就是话布面板。' })
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
      // 会话清单登记：AI 加载的文档归入浏览器最近在看的会话清单（面板轮询可见）
      try { sessAdd(lastBrowserSid, c.id) } catch (_) {}
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
    try { await persistMeta() } catch (e) { console.error('[collab-canvas] delete persist failed:', e.message) }
    return toolOutput({ ok: true, canvasId: id, activeId: activeId, note: '文件保留在磁盘' + (c.filePath ? '：' + c.filePath : '（未落盘）') + '，可手动清理' })
  },
}))

// ═══ canvas_locate：把「这段原文到底是哪一处」讲清楚 ═══════════════
// 为什么要有它（2026-09-14 主人拍板）：
//   @话布选区 的引用本身只有「路径 + 行号 + 原文」两行。同一段原文在文档里
//   出现多次时，**模型没法只凭行号认出是哪一处** —— 而把"前后文坐标"塞进
//   引用正文既长又难读（主人原话：不够优雅），模型照样得自己数。
//   所以改成"模型按需来问"：它想问的时候问一次，我们当场算给它。
// 顺带的好处：这里读的是**当前**文档，所以"这段引用是不是已经失效"也一并答了。
//
// [[CCV-LOCATE-BEGIN]] —— 下面到 END 之间是这块功能的全部代码。
//   tools/test-host-locate.cjs 靠这两个标记把这段**真代码**切出来单独跑，
//   不是照抄一份来测。挪动或删除标记会让那份测试失效。
function occIndexes(text, needle) {
  const out = []
  let i = 0
  while ((i = text.indexOf(needle, i)) >= 0) { out.push(i); i += 1 }   // 允许重叠
  return out
}
// 某一处在 Markdown 源码里的行号 / 列号（都从 1 数）。
function lineColOf(text, idx) {
  const before = text.slice(0, idx)
  return { line: before.split('\n').length, col: idx - (before.lastIndexOf('\n') + 1) + 1 }
}
// 摘要里出现换行会把结构拆散，换成看得见的符号；长度不变、意思不丢。
function asOneLine(s) { return String(s).replace(/\n/g, '↵') }

// 按 canvasId / path 找文档；都没给就用活跃画布。
// 引用里给的是**文件路径**，所以要支持按路径匹配。
function findCanvasByArg(args) {
  const id = args && typeof args.canvasId === 'string' ? args.canvasId : ''
  if (id) return canvases.get(id) || null
  const raw = args && typeof args.path === 'string' ? args.path : ''
  if (raw) {
    const norm = (s) => String(s).replace(/\\/g, '/').replace(/^"+|"+$/g, '')
    const want = norm(raw)
    let hit = null
    canvases.forEach(function (c) { if (!hit && c.filePath && norm(c.filePath) === want) hit = c })
    if (hit) return hit
    // 兜底：模型可能只给了文件名的一部分 —— 用标题去认
    canvases.forEach(function (c) {
      if (!hit && c.title && want.indexOf(norm(c.title).replace(/\.md$/i, '')) >= 0) hit = c
    })
    if (hit) return hit
  }
  return activeId ? canvases.get(activeId) || null : null
}

ctx.tools.register(defineTool({
  name: 'canvas_locate',
  description: '在话布文档里精确找出「一段原文」所处的位置（第几处、每处长什么样），'
    + '并在原文已不在文档里时明确告知这段引用已经失效。'
    + '⚠️ 用户用 @话布选区 引用了一段文字、且引用标签上标着「多处」时，动手改之前必须先调用它确认是哪一处；'
    + '标签里的「第 N 处」直接传 ordinal 就能定住（它比行号可靠 —— 同一行里可能有好几处一模一样的文字）。'
    + '没标「多处」时也可以用它复核。原文重复时不要自己挑一处改 —— 改错地方比不回答更糟。',
  parameters: {
    text: { type: 'string', required: true, description: '要定位的原文（引用里「」中的内容，请一字不差地照抄）' },
    canvasId: { type: 'string', description: '画布 id；缺省用活跃画布' },
    path: { type: 'string', description: '文档路径（引用里的 @ 路径）；给了它就不必给 canvasId' },
    line: { type: 'number', description: '引用标签里给的第几行，用于优先核对' },
    ordinal: { type: 'number', description: '引用标签里给的「第 N 处」；给了它就直接定位到这一处，优先于 line' },
  },
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function (args) {
    const text = args && typeof args.text === 'string' ? args.text : ''
    if (!text) return toolOutput(err('E_BAD_ARGS', 'text 必须为非空字符串（引用里「」中的那段原文）'))
    const c = findCanvasByArg(args)
    if (!c) return toolOutput(err('E_NOT_FOUND', '没找到对应的话布文档；可先用 canvas_list 看看有哪些'))
    const content = String(c.content || '')
    const idxs = occIndexes(content, text)

    // 找不到 → 引用已经失效。这时候**绝不能**让它去找"相似内容"照着改。
    if (!idxs.length) {
      return toolOutput({
        ok: false,
        error: { code: 'E_GONE', message: '这段原文已经不在《' + c.title + '》里了' },
        canvasId: c.id, title: c.title, version: c.version,
        hint: '这段引用很可能已经失效（用户发出引用之后文档被改过）。'
          + '请让用户重新划一次要引用的段落，**不要**去找相似的内容按猜测改。',
      })
    }

    const askedLine = args && typeof args.line === 'number' ? args.line : -1
    const askedOrd = args && typeof args.ordinal === 'number' ? args.ordinal : -1
    const CTX = 20    // 每处前后各带多少字
    const MAX = 8     // 最多列几处，避免输出爆炸
    const spots = idxs.map(function (idx) {
      const lc = lineColOf(content, idx)
      const a = Math.max(0, idx - CTX)
      const b = Math.min(content.length, idx + text.length + CTX)
      return {
        line: lc.line,
        col: lc.col,
        excerpt: (a > 0 ? '…' : '') + asOneLine(content.slice(a, idx))
          + '【' + asOneLine(text) + '】'
          + asOneLine(content.slice(idx + text.length, b)) + (b < content.length ? '…' : ''),
        likelyTarget: false,   // 下面统一算：只有**恰好一处**吻合行号时才置 true
      }
    })
    // 定位优先级：
    //   ① 引用给的「第 N 处」最可靠 —— 同一行里可能有好几处一模一样的文字，行号根本分不开
    //   ② 退而用行号，且只有**恰好一处**吻合时才认
    //   ③ 都定不住 → 一处都不标，把每一处摆出来让用户确认
    if (askedOrd > 0 && askedOrd <= spots.length) {
      spots[askedOrd - 1].likelyTarget = true
    } else {
      const nearIdx = []
      if (askedLine > 0) spots.forEach(function (s, i) { if (Math.abs(s.line - askedLine) <= 2) nearIdx.push(i) })
      if (nearIdx.length === 1) spots[nearIdx[0]].likelyTarget = true
    }
    const shown = spots.slice(0, MAX)
    const near = spots.filter(function (s) { return s.likelyTarget })
    let hint
    if (spots.length === 1) {
      hint = '原文在文中只有这一处，就是它。'
    } else if (askedOrd > 0 && askedOrd <= spots.length) {
      hint = '按引用标签给的「第 ' + askedOrd + ' 处」（全文共 ' + spots.length + ' 处），目标就是标了 likelyTarget 的那一处；'
        + '请照 excerpt 核对一次再动手。'
    } else if (near.length === 1) {
      hint = '共 ' + spots.length + ' 处；与引用给出的第 ' + askedLine + ' 行对得上的那一处已标 likelyTarget，多半就是它 ——'
        + '但仍请照 excerpt 核对一次再动手。'
    } else {
      hint = '共 ' + spots.length + ' 处，仅凭行号分不出来。请把每处的 excerpt 摆给用户，让他确认改哪一处，不要自己挑一处改。'
    }
    return toolOutput({
      ok: true,
      canvasId: c.id, title: c.title, version: c.version,
      total: spots.length, shown: shown.length,
      note: spots.length > shown.length ? '只列了前 ' + shown.length + ' 处。' : '',
      lineNote: '这里的行号按 Markdown 源码数；引用标签里的行号按编辑器渲染结果数，两者可能有偏差，请以 excerpt 为准。',
      spots: shown,
      hint: hint,
    })
  },
}))
// [[CCV-LOCATE-END]]
