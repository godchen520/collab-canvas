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
  debouncedFlush()
  return { version: c.version }
}

async function loadFileDoc(filePath, title) {
  const target = await fs.resolve(filePath)
  let key
  try { key = path.resolve(String(target)) } catch (_) { key = String(target) }
  // ⚠️ 同一文件已经有画布 → 直接复用，绝不再新建一条。
  // 否则每加载一次就多一条指向同一 filePath 的记录，两条各自持有内存内容：
  // 旧的那条是过期的，它一旦保存就把文件覆盖回旧内容 ——
  // 用户以为改好了，实际被静默回滚（2026-09-12 另一会话实测到的重复画布即此）。
  let existing = null
  canvases.forEach(function (x) {
    if (existing || !x.filePath) return
    let k2
    try { k2 = path.resolve(String(x.filePath)) } catch (_) { k2 = String(x.filePath) }
    if (k2 === key) existing = x
  })
  if (existing) {
    activeId = existing.id
    return existing
  }
  const content = await fs.readText(target)
  const id = 'cv-' + Date.now().toString(36) + '-' + (++idSeq)
  const t = title || baseName(filePath).replace(/\.[^.]+$/, '') || 'loaded'
  const c = { id: id, title: t, type: 'document', content: content, version: 1, filePath: filePath, history: [], redoStack: [], dirty: false, updatedAt: Date.now() }
  canvases.set(id, c)
  activeId = id
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
