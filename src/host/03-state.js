// 画布注册表状态 + 存储根多级探测
var canvases = new Map()   // id -> {id,title,type,content,version,filePath,history[],redoStack[],dirty,updatedAt}
var activeId = null
var idSeq = 0
var rootOverride = null   // 用户显式固定的存储根（持久化于 meta）

function docsDirBase() {
  // 多级探测：显式覆盖 > 活跃会话 cwd > workspace 注册表 > 部署根兜底
  if (rootOverride) return rootOverride
  try {
    const svc = ctx.get('sessions')
    const arr = svc && svc.list ? svc.list() : []
    for (const s of arr) {
      const holder = s && (s.header || s.meta || s)
      const cwd = holder && holder.cwd
      if (typeof cwd === 'string' && cwd.length > 2) return cwd
    }
  } catch (e) { console.error('[collab-canvas] session-cwd probe failed:', e && e.message) }
  try {
    const reg = ctx.get('workspaceRegistry')
    const list = reg && reg.list ? reg.list() : []
    if (list[0] && typeof list[0].path === 'string' && list[0].path.length > 2) return list[0].path
  } catch (e) { console.error('[collab-canvas] workspace-registry probe failed:', e && e.message) }
  return policy !== undefined && policy.workspaceRoot ? policy.workspaceRoot : '.'
}
function docsDir() { return joinPath(docsDirBase(), 'canvas-docs') }
function metaPath() { return joinPath(docsDir(), '.canvases.json') }
