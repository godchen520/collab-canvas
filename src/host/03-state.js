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
  if (policy !== undefined && policy.workspaceRoot) return policy.workspaceRoot
  // ⚠️ 兜底绝不能用 '.'（进程 cwd）：DSH 的 cwd 可能就在它自己的安装目录里。
  // 实测 2026-09-12 20:28 落到 node_modules/@deepseek-ai/dsh/lib —— 插件把
  // file-registry.json 和 canvas-docs/.canvases.json 写进了 DSH 的包目录。
  // 改用一个稳定的、与 DSH 无关的用户级目录。
  const home = (typeof process !== 'undefined' && process.env
    && (process.env.USERPROFILE || process.env.HOME)) || ''
  const fallback = home ? joinPath(home, '.dsh-collab-canvas') : '.'
  console.error('[collab-canvas] 存储根探测全部失败（sessions / workspaceRegistry / policy 都不可用），'
    + '退到兜底目录:', fallback, '——请检查会话工作区是否正常')
  return fallback
}
function docsDir() { return joinPath(docsDirBase(), 'canvas-docs') }
function metaPath() { return joinPath(docsDir(), '.canvases.json') }

// 画布对应的 md 文件「真实路径」（绝对、正斜杠）。
// filePath 为空时按存储根 + slugify(标题) 推算（与 saveCanvas 的落盘规则一致）。
//
// ⚠️ 别再让调用方自己拼 "canvas-docs/<标题>.md"：那是**相对**路径，只有当
//    「会话工作区 == 存储根」时才成立。存储根被 canvas_configure 固定到别处后
//    （rootOverride），它指向的是工作区里的残留目录 —— 文件根本不在那儿。
//    2026-09-14 另一会话据此报过一次「引用给出的路径不存在」。
function canvasMdPath(c) {
  if (!c) return ''
  let p = c.filePath
  if (!p) { try { p = joinPath(docsDir(), slugify(c.title) + '.md') } catch (_) { p = '' } }
  return String(p).replace(/\\/g, '/')
}
