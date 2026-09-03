// Client→Host 包级私有 RPC（composition 无 harness 沙箱，仅动态系统存在）
// Phase 1（纯 Host 工具）跳过这些 RPC；若 harness 存在则注册（Phase 2 WYSIWYG 用）
if (typeof harness !== 'undefined') {
harness.handle('canvas.list', async function () {
  const arr = []
  canvases.forEach(function (c) {
    arr.push({ id: c.id, title: c.title, type: c.type, updatedAt: c.updatedAt, hasFile: !!c.filePath })
  })
  return { ok: true, canvases: arr, activeId: activeId, docsDir: docsDir() }
})

harness.handle('canvas.create', async function (args) {
  const title = args && typeof args.title === 'string' && args.title.trim()
  if (!title) return err('E_BAD_ARGS', '需要非空 title')
  const c = createCanvasDoc(title)
  return { ok: true, id: c.id }
})

harness.handle('canvas.open', async function (args) {
  const c = canvases.get(args && args.canvasId)
  if (!c) return err('E_NOT_FOUND', '画布不存在')
  activeId = c.id
  return { ok: true, id: c.id, title: c.title, type: c.type, content: c.content, version: c.version, filePath: c.filePath }
})

harness.handle('canvas.edit', async function (args) {
  const c = canvases.get(args && args.canvasId)
  if (!c) return err('E_NOT_FOUND', '画布不存在')
  if (typeof args.content !== 'string') return err('E_BAD_ARGS', 'content 必须是字符串')
  const r = applyWrite(c, args.content, 'replace', typeof args.baseVersion === 'number' ? args.baseVersion : undefined, 'human')
  if (r.conflict) return Object.assign(err('E_CONFLICT', '版本冲突：服务端已是 v' + r.currentVersion), { currentVersion: r.currentVersion, currentContent: r.currentContent })
  let othersAfter = 0
  if (typeof args.knownVer === 'number') {
    for (const h of c.history) {
      if (h.source === 'ai' && typeof h.version === 'number' && h.version > args.knownVer) othersAfter++
    }
  }
  return { ok: true, version: r.version, othersAfter: othersAfter }
})

harness.handle('canvas.undo', async function (args) {
  const c = canvases.get(args && args.canvasId)
  if (!c) return err('E_NOT_FOUND', '画布不存在')
  if (!c.history.length) return { ok: true, noop: true }
  const rec = c.history.pop()
  c.redoStack.push(rec)
  c.content = rec.before
  c.version += 1
  c.dirty = true
  c.updatedAt = Date.now()
  emit(EV.CONTENT_CHANGED, { canvasId: c.id, version: c.version, source: 'undo' })
  debouncedFlush()
  return { ok: true, content: c.content, version: c.version }
})

harness.handle('canvas.redo', async function (args) {
  const c = canvases.get(args && args.canvasId)
  if (!c) return err('E_NOT_FOUND', '画布不存在')
  if (!c.redoStack.length) return { ok: true, noop: true }
  const rec = c.redoStack.pop()
  c.history.push(rec)
  c.content = rec.after
  c.version += 1
  c.dirty = true
  c.updatedAt = Date.now()
  emit(EV.CONTENT_CHANGED, { canvasId: c.id, version: c.version, source: 'redo' })
  debouncedFlush()
  return { ok: true, content: c.content, version: c.version }
})

harness.handle('canvas.save', async function (args) {
  const c = canvases.get(args && args.canvasId)
  if (!c) return err('E_NOT_FOUND', '画布不存在')
  if (!fs) return err('E_IO', 'fs 服务不可用，无法保存')
  try {
    const r = await saveCanvas(c, args && args.filePath)
    persistMeta()
    return { ok: true, filePath: r.path, relocated: r.relocated }
  } catch (e) {
    return err('E_IO', '写入失败：' + e.message)
  }
})

harness.handle('canvas.loadFile', async function (args) {
  const p = args && args.filePath
  if (!p || typeof p !== 'string') return err('E_BAD_ARGS', '需要 filePath')
  if (!fs) return err('E_IO', 'fs 服务不可用')
  try {
    const c = await loadFileDoc(p, args && args.title)
    return { ok: true, canvasId: c.id, title: c.title }
  } catch (e) {
    return err(e.message.indexOf('ENOENT') >= 0 ? 'E_NOT_FOUND' : 'E_IO', '读取失败：' + e.message)
  }
})

harness.handle('canvas.getRoot', async function () {
  return { ok: true, root: docsDirBase(), override: rootOverride, docsDir: docsDir() }
})

harness.handle('canvas.setRoot', async function (args) {
  const r = args && typeof args.root === 'string' ? args.root.trim() : ''
  if (r.length < 3) return err('E_BAD_ARGS', '需要有效的 root 目录绝对路径')
  try {
    const out = await setRootDoc(r)
    return { ok: true, root: out.root, migrated: out.migrated }
  } catch (e) {
    return err('E_IO', '设置失败：' + e.message)
  }
})

harness.handle('canvas.delete', async function (args) {
  const c = canvases.get(args && args.canvasId)
  if (!c) return err('E_NOT_FOUND', '画布不存在')
  canvases.delete(c.id)
  if (activeId === c.id) {
    const first = canvases.keys().next()
    activeId = first.done ? null : first.value
  }
  emit(EV.CANVAS_CLOSED, { canvasId: c.id })
  await persistMeta()
  return { ok: true, activeId: activeId, note: '文件保留在磁盘' + (c.filePath ? '：' + c.filePath : '（未落盘）') + '，可手动清理' }
})
}
