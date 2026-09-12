// 持久化：多策略沙箱写入、保存（含认可区回退）、meta 双写、防抖冲刷、启动恢复
function candidatePolicies() {
  const list = []
  list.push({ tag: 'literal-danger', ep: { mode: 'danger-full-access' } })
  try {
    const r = policy && typeof policy.resolve === 'function' ? policy.resolve({ mode: 'danger-full-access' }) : null
    if (r) list.push({ tag: 'resolve-danger', ep: r })
  } catch (e) { console.error('[collab-canvas] resolve({mode}) rejected:', e && e.message) }
  try {
    const r2 = policy && typeof policy.resolve === 'function' ? policy.resolve({}) : null
    if (r2) list.push({ tag: 'resolve-default', ep: r2 })
  } catch (_) { /* ignore */ }
  list.push({ tag: 'bare', ep: null })
  return list
}

async function writeFile(path, content) {
  if (!fs) throw new Error('fs 服务不可用')
  const target = await fs.resolve(path)
  let lastErr = null
  for (const cand of candidatePolicies()) {
    try {
      if (cand.ep) await fs.writeText(target, content, undefined, undefined, cand.ep)
      else await fs.writeText(target, content)
      console.log('[collab-canvas]', 'write ok via', cand.tag, '->', path)
      return true
    } catch (e) {
      lastErr = e
      console.error('[collab-canvas]', 'write fail via', cand.tag, ':', e && e.message)
    }
  }
  throw lastErr || new Error('写入失败')
}

function sanctionedDocsDir() {
  return joinPath((policy !== undefined && policy.workspaceRoot) ? policy.workspaceRoot : '.', 'canvas-docs')
}

async function saveCanvas(c, filePath) {
  const primary = filePath || c.filePath || joinPath(docsDir(), slugify(c.title) + '.md')
  try {
    await writeFile(primary, c.content)
    c.filePath = primary
    c.dirty = false
    return { path: primary, relocated: false }
  } catch (e) {
    // 显式指定路径失败不静默改道；默认目录被拒则回退到沙箱认可区
    if (filePath || c.filePath) throw e
    const p2 = joinPath(sanctionedDocsDir(), slugify(c.title) + '.md')
    await writeFile(p2, c.content)
    c.filePath = p2
    c.dirty = false
    return { path: p2, relocated: true }
  }
}

async function persistMeta() {
  const payload = JSON.stringify({ activeId: activeId, rootOverride: rootOverride, canvases: Array.from(canvases.values()).map(function (c) {
    return { id: c.id, title: c.title, type: c.type, filePath: c.filePath }
  }) }, null, 2)
  // 同步写所有候选位置：冷启动时无论读到哪一份都带 rootOverride
  const targets = [metaPath(), joinPath(sanctionedDocsDir(), '.canvases.json')]
  let okCount = 0
  for (const mp of targets) {
    try { await writeFile(mp, payload); okCount++ } catch (e) { console.error('[collab-canvas] meta persist miss:', mp, e && e.message) }
  }
  if (!okCount) console.error('[collab-canvas] meta persist failed at all locations')
}

async function flushDirty() {
  const dirty = []
  canvases.forEach(function (c) { if (c.dirty) dirty.push(c) })
  let failed = 0
  for (const c of dirty) {
    try { await saveCanvas(c) } catch (e) { failed++; console.error('[collab-canvas] autosave failed:', c.title, e.message) }
  }
  if (dirty.length > failed) persistMeta()
}
const debouncedFlush = ctx.debounce(function () { flushDirty() }, 1500)
ctx.effect(function () { return function () { flushDirty() } }, 'final-flush')

async function restore() {
  if (!fs) { console.error('[collab-canvas]', 'fs service unavailable — persistence disabled'); return }
  const metaCandidates = [metaPath(), joinPath(sanctionedDocsDir(), '.canvases.json')]
  const metas = []
  for (const mp of metaCandidates) {
    try {
      const raw = await fs.readText(await fs.resolve(mp))
      metas.push(JSON.parse(raw))
      console.log('[collab-canvas]', 'meta found at', mp)
    } catch (e) { /* try next */ }
  }
  // 多份 meta 并存时，优先采信带 rootOverride 的那份
  const meta = metas.find(function (m) { return m && typeof m.rootOverride === 'string' && m.rootOverride.length > 2 }) || metas[0] || null
  if (!meta) { console.log('[collab-canvas]', 'no previous meta (first run)'); return }
  try {
    if (typeof meta.rootOverride === 'string' && meta.rootOverride.length > 2) rootOverride = meta.rootOverride
    for (const m of meta.canvases || []) {
      let content = ''
      if (m.filePath) {
        try { content = await fs.readText(await fs.resolve(m.filePath)) }
        catch (e) { console.error('[collab-canvas] restore miss:', m.filePath, e.message); continue }
      }
      canvases.set(m.id, {
        id: m.id, title: m.title, type: m.type || 'document', content: content,
        version: 1, filePath: m.filePath || null, history: [], redoStack: [],
        dirty: false, updatedAt: Date.now(),
      })
    }
    activeId = meta.activeId && canvases.has(meta.activeId) ? meta.activeId : (meta.canvases && meta.canvases[0] && meta.canvases[0].id) || null
    console.log('[collab-canvas]', 'restored', canvases.size, 'canvas(es), root =', docsDirBase())
  } catch (e) {
    console.log('[collab-canvas]', 'restore failed:', e.message)
  }
}
