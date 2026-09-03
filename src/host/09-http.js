// 画布 HTTP 端点——供浏览器编辑器通过 fetch 读写画布数据
// 路由：GET /api/canvas/list|read?id=xxx，POST /api/canvas/write|save|create
// 用 ctx.inject(['webServer']) 确保 webServer 服务就绪后再注册

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
  // GET /api/canvas/list
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/list', handler: async (req, res) => {
    const arr = []
    canvases.forEach((c) => { arr.push({ id: c.id, title: c.title, version: c.version }) })
    json(res, { ok: true, canvases: arr, activeId })
  }}))
  // GET /api/canvas/read?id=xxx
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/read', handler: async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const id = url.searchParams.get('id')
    const c = id ? canvases.get(id) : (activeId ? canvases.get(activeId) : null)
    if (!c) { error(res, 404, { ok: false, error: '画布不存在' }); return }
    json(res, { ok: true, id: c.id, title: c.title, content: c.content, version: c.version })
  }}))
  // POST /api/canvas/write
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/write', handler: async (req, res) => {
    try {
      const body = await readBody(req)
      const id = body.id || activeId
      const c = id ? canvases.get(id) : null
      if (!c) { error(res, 404, { ok: false, error: '画布不存在' }); return }
      const result = applyWrite(c, body.content, 'replace', body.knownVer, 'human')
      json(res, { ok: true, version: result.version })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/save
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/save', handler: async (req, res) => {
    try {
      const body = await readBody(req)
      const id = body.id || activeId
      const c = id ? canvases.get(id) : null
      if (!c) { error(res, 404, { ok: false, error: '画布不存在' }); return }
      const r = await saveCanvas(c, body.filePath)
      persistMeta()
      json(res, { ok: true, filePath: r.path })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/create
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/create', handler: async (req, res) => {
    try {
      const body = await readBody(req)
      const c = createCanvasDoc(body.title || '新话布')
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
