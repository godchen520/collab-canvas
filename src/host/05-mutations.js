// 共享变更逻辑（RPC 与模型工具共用同一套历史栈）
var HISTORY_MAX = 50
function pushHistory(c, before, after, source, version) {
  c.history.push({ opId: 'op-' + Date.now().toString(36) + '-' + (++idSeq), source: source, before: before, after: after, at: Date.now(), version: version })
  if (c.history.length > HISTORY_MAX) c.history.shift()
  c.redoStack.length = 0
}

function createCanvasDoc(title) {
  // 标题净化：AI/导入可能把 "xxx.md" 当标题传入，canvas_save 落盘时会变成
  // "xxx.md.md" 双扩展名文件——这里统一剥掉尾扩展名
  title = String(title || '').replace(/\.(md|markdown)$/i, '') || '未命名话布'
  const id = 'cv-' + Date.now().toString(36) + '-' + (++idSeq)
  const c = { id: id, title: title, type: 'document', content: '', version: 1, filePath: null, history: [], redoStack: [], dirty: true, updatedAt: Date.now() }
  canvases.set(id, c)
  activeId = id
  emit(EV.CANVAS_CREATED, { canvasId: id, title: title })
  persistMeta()
  debouncedFlush()
  return c
}

function applyWrite(c, content, mode, baseVersion, source) {
  if (typeof baseVersion === 'number' && baseVersion !== c.version) {
    return { conflict: true, currentVersion: c.version, currentContent: c.content }
  }
  const before = c.content
  if (!mode || mode === 'replace') c.content = content
  else if (mode === 'append') c.content = before + content
  else if (mode === 'prepend') c.content = content + before
  else return { badMode: true }
  c.version += 1
  c.dirty = true
  c.updatedAt = Date.now()
  pushHistory(c, before, c.content, source, c.version)
  emit(EV.CONTENT_CHANGED, { canvasId: c.id, version: c.version, source: source })
  if (source === 'ai') {
    const opId = 'op-' + Date.now().toString(36) + '-' + (++idSeq)
    emit(EV.AI_EDIT_APPLIED, { canvasId: c.id, opId: opId })
  }
  debouncedFlush()
  return { version: c.version }
}

async function loadFileDoc(filePath, title) {
  const content = await fs.readText(await fs.resolve(filePath))
  const id = 'cv-' + Date.now().toString(36) + '-' + (++idSeq)
  const t = title || baseName(filePath).replace(/\.[^.]+$/, '') || 'loaded'
  const c = { id: id, title: t, type: 'document', content: content, version: 1, filePath: filePath, history: [], redoStack: [], dirty: false, updatedAt: Date.now() }
  canvases.set(id, c)
  activeId = id
  emit(EV.FILE_LOADED, { canvasId: id, filePath: filePath })
  persistMeta()
  return c
}

async function setRootDoc(newRoot) {
  const oldBase = docsDirBase()
  rootOverride = newRoot
  let migrated = 0
  for (const c of Array.from(canvases.values())) {
    if (c.filePath && oldBase && c.filePath.indexOf(oldBase) === 0) {
      try {
        const np = joinPath(joinPath(newRoot, 'canvas-docs'), baseName(c.filePath))
        await writeFile(np, c.content)
        c.filePath = np
        migrated++
      } catch (e) { console.error('[collab-canvas] migrate fail:', c.title, e && e.message) }
    }
  }
  await persistMeta()
  return { root: docsDirBase(), migrated: migrated }
}
