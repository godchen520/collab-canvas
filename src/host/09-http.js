// 画布 HTTP 端点——供浏览器编辑器通过 fetch 读写画布数据
// 路由：GET /api/canvas/list|read?id=xxx，POST /api/canvas/write|save|create
// 用 ctx.inject(['webServer']) 确保 webServer 服务就绪后再注册

// ─── 会话独立清单：每个会话记录自己新建/打开过的画布 ───
// 元数据存 canvas-docs/.sessions/<sid>.json；文档 md 文件仍在共享池 canvas-docs/
var sessStore = new Map()   // sid -> { activeId, ids: [] }
var lastBrowserSid = 'default'   // 浏览器最近在看的会话键（AI 工具创建的画布归入它的清单）
// 一次性迁移的持久化标记（.sessions/.migrated）：迁移执行过一次就永久生效，
// 重启不再把全局画布重新挂回清单（之前标记是内存变量，重启清零导致删掉的清单复原）
function sessMigratedAlready() {
  try { return nodefs.existsSync(joinPath(sessDirPath(), '.migrated')) } catch (_) { return true }
}
function sessMarkMigrated() {
  try { nodefs.writeFileSync(joinPath(sessDirPath(), '.migrated'), String(Date.now())) } catch (_) {}
}
var sessMigrated = false
function sessDirPath() {
  const d = joinPath(docsDir(), '.sessions')
  try { nodefs.mkdirSync(d, { recursive: true }) } catch (_) {}
  return d
}
function sessSafe(sid) { return String(sid || '').replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 80) || 'default' }
function sessLoad(sid) {
  try {
    const j = JSON.parse(nodefs.readFileSync(joinPath(sessDirPath(), sessSafe(sid) + '.json'), 'utf8'))
    if (j && Array.isArray(j.ids)) return { activeId: j.activeId || null, ids: j.ids.filter(x => canvases.has(x)) }
  } catch (_) {}
  return { activeId: null, ids: [] }
}
function sessPersist(sid, st) {
  try { nodefs.writeFileSync(joinPath(sessDirPath(), sessSafe(sid) + '.json'), JSON.stringify({ activeId: st.activeId, ids: st.ids }, null, 2)) } catch (_) {}
}
function sessState(sid) {
  sid = sessSafe(sid)
  if (!sessStore.has(sid)) {
    let st = sessLoad(sid)
    // 一次性迁移：旧全局清单挂到重启后第一个使用的会话名下。
    // 标记用持久化文件（.sessions/.migrated），内存标记会在重启后丢失、
    // 导致每次重启都把全局画布重新挂回清单（用户删了又复现的根因）
    if (!st.ids.length && canvases.size && !sessMigratedAlready()) {
      st = { activeId: activeId, ids: Array.from(canvases.keys()) }
      sessMarkMigrated()
      sessPersist(sid, st)
      console.log('[collab-canvas] 会话清单迁移:', sid, '<-', st.ids.join(','))
    }
    sessStore.set(sid, st)
  }
  return sessStore.get(sid)
}
function sessAdd(sid, id) {
  const st = sessState(sid)
  if (st.ids.indexOf(id) < 0) { st.ids.push(id); sessPersist(sid, st) }
  if (st.activeId !== id) { st.activeId = id; sessPersist(sid, st) }
}
function sessRemove(sid, id) {
  const st = sessState(sid)
  st.ids = st.ids.filter(x => x !== id)
  if (st.activeId === id) st.activeId = null
  sessPersist(sid, st)
}

function initCanvasHttpEndpoints(ctx, webServer) {
  // JSON 响应辅助
  function json(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }
  function error(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }
  // 解析 POST body 为 JSON
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (e) { reject(new Error('Invalid JSON')) }
      })
      req.on('error', reject)
    })
  }
  // GET /api/canvas/list?sid=xxx —— 只返回该会话清单里的画布
  //                      ?scope=all —— 返回全部画布（跨会话）。客户端做「标题 → 可点链接」
  //                                    匹配时用：会话清单只含「本会话开过/建过的」，
  //                                    没登记过的文档标题会匹配不到、转不成链接。
  // 每条都带 path：md 文件的**真实绝对路径**（正斜杠）。客户端生成 @ 引用、
  // 显示位置都要用真实路径，不能自己拼相对路径 —— 存储根被 rootOverride
  // 固定到别处后，相对路径会指向工作区里的残留目录。
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/list', handler: async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.searchParams.get('scope') === 'all') {
      const all = []
      canvases.forEach((c) => all.push({ id: c.id, title: c.title, version: c.version, path: canvasMdPath(c) }))
      json(res, { ok: true, canvases: all, activeId: activeId, scope: 'all' })
      return
    }
    const sid = sessSafe(url.searchParams.get('sid'))
    lastBrowserSid = sid
    const st = sessState(sid)
    const arr = []
    st.ids.forEach((id) => { const c = canvases.get(id); if (c) arr.push({ id: c.id, title: c.title, version: c.version, path: canvasMdPath(c) }) })
    json(res, { ok: true, canvases: arr, activeId: st.activeId })
  }}))
  // GET /api/canvas/read?id=xxx —— 打开过就记入该会话清单
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/read', handler: async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const id = url.searchParams.get('id')
    const c = id ? canvases.get(id) : (activeId ? canvases.get(activeId) : null)
    if (!c) { error(res, 404, { ok: false, error: '画布不存在' }); return }
    sessAdd(url.searchParams.get('sid'), c.id)
    lastBrowserSid = sessSafe(url.searchParams.get('sid'))
    json(res, { ok: true, id: c.id, title: c.title, content: c.content, version: c.version, path: canvasMdPath(c) })
  }}))
  // GET /api/canvas/changes?since=N —— 画布端轮询「AI 刚改了哪儿」
  // 为什么用轮询而不是推送：客户端已经有现成的取数习惯（读文档、报日志都是普通请求），
  // 加一条推送通道要新增一套连接生命周期管理，收益不值当。
  // 轮询间隔 1.2 秒 —— AI 改完到主人看向屏幕本来就有间隔，这点延迟无感。
  // 只回 since **之后**的新条目：画布端记住自己处理到的 seq，取过的不会再要一次。
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/changes', handler: async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const raw = url.searchParams.get('since')
    const since = (raw === null || raw === '') ? 0 : parseInt(raw, 10)
    if (isNaN(since)) { error(res, 400, { ok: false, error: 'since 必须是数字' }); return }
    const out = aiChanges.filter((x) => x.seq > since)
    json(res, { ok: true, latest: aiChangeSeq, changes: out })
  }}))
  // POST /api/canvas/selref/pin —— 客户端报「你刚才划的是第几处」
  // 为什么需要：引用正文里**已经不写坐标了**（2026-09-15 主人要求对话里那张
  // 卡片只留文件名），而"第几处"靠的是**划选那一刻的 DOM 位置** —— 只有浏览器
  // 那边知道，服务端自己无论如何算不出。所以单独送一份过来，
  // 供 host 侧的「位置主动注入」（13-selref-context.js）使用。
  // 只存内存、不落盘：它是**当下的**输入，重启后就该丢。
  // 实现在 13-selref-context.js（那边有 [[CCV-SELCTX]] 标记，测试切得出来）。
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/selref/pin', handler: async (req, res) => {
    try {
      if (req.method !== 'POST') { error(res, 405, { ok: false, error: '只收 POST' }); return }
      const body = await readBody(req)
      const taken = ccvPinAdd(body)
      json(res, { ok: taken, n: ccvPins.length })
    } catch (e) { error(res, 400, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/write
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/write', handler: async (req, res) => {
    try {
      const body = await readBody(req)
      const id = body.id || activeId
      const c = id ? canvases.get(id) : null
      if (!c) { error(res, 404, { ok: false, error: '画布不存在' }); return }
      const result = applyWrite(c, body.content, 'replace', body.knownVer, 'human')
      // ⚠️ 冲突必须显式回传。applyWrite 检出并发冲突时返回
      //    { conflict, currentVersion, currentContent }，此时 result.version 是 undefined；
      //    若照原样 json({ ok: true, version: result.version })，
      //    undefined 会被 JSON.stringify 丢掉 → 响应变成 {"ok":true} ——
      //    冲突被伪装成成功，浏览器编辑器无从察觉，只能继续用旧内容写。
      if (result && result.conflict) {
        json(res, { ok: false, conflict: true, currentVersion: result.currentVersion, currentContent: result.currentContent })
        return
      }
      json(res, { ok: true, version: result.version })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/create?sid=xxx —— 新建即记入当前会话清单
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/create', handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const body = await readBody(req)
      const c = createCanvasDoc(body.title || '新话布')
      sessAdd(url.searchParams.get('sid'), c.id)
      json(res, { ok: true, id: c.id, title: c.title })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // ─── 客户端诊断日志（排障用）─────────────────────────
  // 环境里用户开不了浏览器控制台，客户端把关键判定点 POST 到这里，
  // 落盘到 %TEMP%/ccv-selbar.log，不用 console 也能复盘当时发生了什么。
  const DEBUG_LOG = (process.env.TEMP || process.env.TMPDIR || '.') + '/ccv-selbar.log'
  let _dbg = []
  const DBG_MAX = 400
  function ts() {
    const d = new Date()
    const p = function (n) { return String(n).padStart(2, '0') }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0')
  }
  function dbgWrite() {
    try {
      if (typeof nodefs !== 'undefined' && nodefs && nodefs.writeFileSync) {
        nodefs.writeFileSync(DEBUG_LOG, _dbg.join('\n') + '\n', 'utf8')
      }
    } catch (e) { /* 落盘失败不影响主流程 */ }
  }
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/log', handler: async (req, res) => {
    try {
      if (req.method === 'POST') {
        const body = await readBody(req)
        const lines = Array.isArray(body.lines) ? body.lines : [String(body.line || '')]
        lines.forEach(function (l) { _dbg.push(ts() + ' ' + String(l)) })
        if (_dbg.length > DBG_MAX) _dbg = _dbg.slice(_dbg.length - DBG_MAX)
        dbgWrite()
        json(res, { ok: true, n: _dbg.length, file: DEBUG_LOG })
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(_dbg.join('\n') + '\n')
      }
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // ─── 打开文档所在文件夹 ─────────────────────────────
  // 客户端「📁」按钮调用；host 是 Node 主进程，用 explorer/open/xdg-open
  // 在系统文件管理器里打开当前画布文档所在的目录。
  // 注意：不要用 fs.resolve —— 它返回的是沙箱内部标记，不是文件系统路径，
  // explorer 收到无效参数会默认打开「文档」库。这里用 path 模块自己归一化。
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/open-folder', handler: async (req, res) => {
    const c = activeId ? canvases.get(activeId) : null
    const raw = (c && c.filePath) ? path.dirname(c.filePath) : docsDir()
    let dir = path.isAbsolute(raw) ? raw : path.join(docsDirBase(), raw)
    dir = dir.replace(/[\\/]+$/, '')
    const plat = process.platform
    // explorer 对 / 与 \ 混用的路径解析不可靠（session cwd 常带正斜杠），
    // Windows 下一律归一成反斜杠 + path.win32.normalize
    if (plat === 'win32') dir = path.win32.normalize(dir.replace(/\//g, '\\'))
    const info = { dir: dir, raw: raw, exists: null, cwd: null, platform: plat, strategy: null, pid: null, err: null, exit: null }
    try { info.exists = nodefs.existsSync(dir) } catch (e) { info.err = 'existsSync: ' + (e && e.message) }
    try { info.cwd = process.cwd() } catch (e) { info.err = 'cwd: ' + (e && e.message) }
    try {
      if (plat === 'win32') {
        // explorer 从带 stdio 管道的子进程里启动时，偶尔会忽略参数、打开默认目录。
        // 用 detached + stdio:'ignore' 起，是最稳的传法。
        const child = spawn('explorer', [dir], { detached: true, stdio: 'ignore' })
        child.unref()
        info.strategy = 'spawn-explorer-detached'
        info.pid = child.pid
        child.on('error', function (e) { info.err = 'spawn error: ' + (e && e.message) })
        child.on('exit', function (code) { info.exit = code })
      } else {
        const child = spawn(plat === 'darwin' ? 'open' : 'xdg-open', [dir], { detached: true, stdio: 'ignore' })
        child.unref()
        info.strategy = 'spawn-open'
        info.pid = child.pid
        child.on('error', function (e) { info.err = 'spawn error: ' + (e && e.message) })
      }
    } catch (e) {
      info.err = 'spawn throw: ' + (e && e.message)
      try {
        exec(plat === 'win32' ? 'cmd /c start "" "' + dir + '"' : 'xdg-open "' + dir + '"', function (e2) {
          info.strategy = 'cmd-start-fallback'
          info.err = e2 ? ('cmd start: ' + e2.message) : null
        })
      } catch (e3) { info.err = 'fallback throw: ' + (e3 && e3.message) }
    }
    setTimeout(function () {
      _dbg.push(ts() + ' open-folder ' + JSON.stringify(info))
      if (_dbg.length > DBG_MAX) _dbg = _dbg.slice(_dbg.length - DBG_MAX)
      dbgWrite()
    }, 1200)
    console.log('[collab-canvas] open-folder', JSON.stringify(info))
    json(res, { ok: true, dir: dir, raw: raw, exists: info.exists, pid: info.pid, strategy: info.strategy })
  }}))
  console.log('[collab-canvas] HTTP endpoints registered: /api/canvas/* (debug log -> ' + DEBUG_LOG + ')')
}
