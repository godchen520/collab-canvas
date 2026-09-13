// 画布扩展端点：外部文档拖拽 / 文件登记表 / 删除 / 模块源码服务
// 依赖同作用域：docsDirBase, docsDir, canvases, createCanvasDoc, applyWrite,
//               saveCanvas, persistMeta, nodefs, path（均由其他模块提供）
function initCanvasExtraEndpoints(ctx, webServer) {
  // JSON 响应辅助（与 09-http 同款，本文件自包含）
  function json(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }
  function error(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (limit && size > limit) { reject(new Error('文件超过大小上限')); try { req.destroy() } catch (_) {} ; return }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  // 会话工作区目录（@ 文件选择器索引的目录）
  function sessionWorkspaceDir() {
    try {
      const svc = ctx.get('sessions')
      const arr = svc && svc.list ? svc.list() : []
      for (const s of arr) {
        const holder = s && (s.header || s.meta || s)
        const cwd = holder && holder.cwd
        if (typeof cwd === 'string' && cwd.length > 2) return cwd
      }
    } catch (e) { console.error('[collab-canvas] session-cwd probe failed:', e && e.message) }
    return docsDirBase()
  }

  // ─── 文件登记表：让拖拽按“真实路径”引用外部文档 ───
  const REG_CONFIG_FILE = () => path.join(docsDirBase(), 'file-registry.json')
  const REG_SKIP_DIRS = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information'])
  const REG_MAX_FILES = 150000
  const regFolders = []
  const regIndex = new Map()      // folder -> Map(basename -> [fullPath])
  const regWatchers = new Map()
  let regTotal = 0

  function regLoadConfig() {
    try {
      const f = REG_CONFIG_FILE()
      if (nodefs.existsSync(f)) {
        const j = JSON.parse(nodefs.readFileSync(f, 'utf8'))
        if (Array.isArray(j.folders)) return j.folders.filter(p => typeof p === 'string' && path.isAbsolute(p))
      }
    } catch (e) { console.error('[collab-canvas] registry config read failed:', e && e.message) }
    return []
  }
  function regSaveConfig(folders) {
    try {
      nodefs.writeFileSync(REG_CONFIG_FILE(), JSON.stringify({ folders: folders }, null, 2))
    } catch (e) { console.error('[collab-canvas] registry config write failed:', e && e.message) }
  }
  function regScanFolder(folder) {
    const map = new Map()
    let count = 0
    function walk(dir, depth) {
      if (depth > 16 || count > REG_MAX_FILES) return
      let entries = []
      try { entries = nodefs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
      for (const ent of entries) {
        try {
          if (ent.isSymbolicLink()) continue
          const full = path.join(dir, ent.name)
          if (ent.isDirectory()) {
            if (REG_SKIP_DIRS.has(ent.name)) continue
            walk(full, depth + 1)
          } else if (ent.isFile()) {
            count++
            if (count > REG_MAX_FILES) return
            const arr = map.get(ent.name) || []
            arr.push(full)
            map.set(ent.name, arr)
          }
        } catch (_) {}
      }
    }
    walk(folder, 0)
    return map
  }
  function regRescanFolder(folder) {
    try {
      const map = regScanFolder(folder)
      let n = 0
      const sigs = []
      map.forEach(arr => { n += arr.length; arr.forEach(p => sigs.push(p)) })
      sigs.sort()
      const sig = n + '|' + sigs.join(',')
      // 无变化的重扫（OneDrive 触碰文件、临时文件增删）静默处理，只留真正变化日志
      const changed = sig !== regLastSig.get(folder)
      regLastSig.set(folder, sig)
      regIndex.set(folder, map)
      regTotal = 0
      regIndex.forEach(m => { m.forEach(arr => { regTotal += arr.length }) })
      if (changed) console.log('[collab-canvas] registry scanned', folder, '->', n, 'files')
    } catch (e) { console.error('[collab-canvas] registry scan failed:', folder, e && e.message) }
  }
  const regLastSig = new Map()   // folder -> 上次索引签名（文件数+路径集），无变化的重扫静默处理
  const regRescanTimers = new Map()
  function regScheduleRescan(folder) {
    if (regRescanTimers.has(folder)) return
    const t = setTimeout(function () { regRescanTimers.delete(folder); regRescanFolder(folder) }, 3000)
    regRescanTimers.set(folder, t)
  }
  function regWatch(folder) {
    if (regWatchers.has(folder)) return
    try {
      const w = nodefs.watch(folder, { recursive: true }, function () { regScheduleRescan(folder) })
      w.on('error', function () {})
      regWatchers.set(folder, w)
    } catch (e) { console.error('[collab-canvas] registry watch failed:', folder, e && e.message) }
  }
  function regUnwatch(folder) {
    const w = regWatchers.get(folder)
    if (w) { try { w.close() } catch (_) {} regWatchers.delete(folder) }
  }
  // 空登记表自愈：配置为空/被清空时，自动补登记会话工作区（拖拽最常见来源）
  function regSeedIfEmpty() {
    if (regFolders.length) return false
    try {
      let cfg = regLoadConfig()
      if (!cfg.length) cfg = [sessionWorkspaceDir()]
      regFolders.push(...cfg)
      cfg.forEach(function (f) { regRescanFolder(f); regWatch(f) })
      console.log('[collab-canvas] registry: 空登记表自动补登记 ->', cfg.join(' | '))
      return true
    } catch (_) { return false }
  }

  const UPLOAD_LIMIT = 100 * 1024 * 1024

  // /api/canvas/registry —— GET 查看登记文件夹与索引规模；POST 设置登记文件夹
  //（须存在的绝对路径目录）。注意：DSH exact 路由同路径只允许注册一次，
  // GET/POST 必须合并在同一个 handler 里按 method 分流
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/registry', handler: async (req, res) => {
    try {
      if (req.method === 'POST') {
        const body = await readBody(req)
        const folders = Array.isArray(body.folders) ? body.folders.map(s => String(s).trim()).filter(Boolean) : []
        const invalid = folders.filter(f => !path.isAbsolute(f) || !nodefs.existsSync(f) || !nodefs.statSync(f).isDirectory())
        if (invalid.length) { error(res, 400, { ok: false, error: '以下路径无效或不是文件夹: ' + invalid.join(', ') }); return }
        const uniq = Array.from(new Set(folders))
        regFolders.length = 0
        regFolders.push(...uniq)
        regSaveConfig(regFolders)
        Array.from(regIndex.keys()).forEach(function (f) { if (!regFolders.includes(f)) regIndex.delete(f) })
        Array.from(regWatchers.keys()).forEach(function (f) { if (!regFolders.includes(f)) regUnwatch(f) })
        uniq.forEach(function (f) {
          regWatch(f)
          setTimeout(function () { regRescanFolder(f) }, 0)
        })
        json(res, { ok: true, folders: regFolders.slice(), files: regTotal, note: '索引构建中' })
        return
      }
      json(res, { ok: true, folders: regFolders.slice(), files: regTotal })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // GET /api/canvas/locate?name=xxx —— 按文件名查登记索引，返回真实路径
  //（rel = 会话工作区相对路径；docsRel = 画布文档目录相对路径，形如 canvas-docs/xxx.md）
  // 查询前先做空登记表自愈，避免“忘了登记 → 永远查不到”的死循环
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/locate', handler: async (req, res) => {
    try {
      regSeedIfEmpty()
      const url = new URL(req.url, 'http://x')
      const name = url.searchParams.get('name') || ''
      const ws = sessionWorkspaceDir().replace(/[\\/]+$/, '')
      const docsDirN = docsDir().replace(/[\\/]+$/, '')
      const matches = []
      regIndex.forEach(function (map) {
        const arr = map.get(name)
        if (arr) arr.forEach(function (p) {
          const norm = p.replace(/\//g, '\\')
          let rel = null, docsRel = null
          const low = norm.toLowerCase()
          if (low.indexOf(ws.toLowerCase() + '\\') === 0) rel = norm.slice(ws.length + 1).replace(/\\/g, '/')
          if (low.indexOf(docsDirN.toLowerCase() + '\\') === 0) docsRel = 'canvas-docs/' + norm.slice(docsDirN.length + 1).replace(/\\/g, '/')
          matches.push({ path: norm, rel: rel, docsRel: docsRel })
        })
      })
      json(res, { ok: true, name: name, matches: matches, folders: regFolders.length })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // GET /api/canvas/load-doc?rel=canvas-docs/xxx.md —— 把 canvas-docs 里的 md
  // 注册为话布（按标题找已有，找不到新建）并返回画布 id——即 canvas_load 的最小实现
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/load-doc', handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const rel = String(url.searchParams.get('rel') || '')
      if (!/^canvas-docs\/[^\\/]+\.md$/i.test(rel)) { error(res, 400, { ok: false, error: '仅支持 canvas-docs/ 下的 .md 文件' }); return }
      const full = path.join(docsDir(), rel.slice('canvas-docs/'.length))
      if (!nodefs.existsSync(full)) { error(res, 404, { ok: false, error: '文件不存在' }); return }
      const content = nodefs.readFileSync(full, 'utf8')
      const title = rel.split('/').pop().replace(/\.(md|markdown)$/i, '')
      let c = null
      // 先按标题找；找不到再按「已绑定到同一个文件」找。
      // 只按标题去重是不够的：标题不同但指向同一文件时仍会新建一条，
      // 于是同一文件挂两条记录，旧的那条内容过期、保存即覆盖。
      let fullKey
      try { fullKey = path.resolve(full) } catch (_) { fullKey = full }
      canvases.forEach(function (x) {
        if (c || !x.filePath) return
        let k
        try { k = path.resolve(String(x.filePath)) } catch (_) { k = String(x.filePath) }
        if (k === fullKey) c = x
      })
      canvases.forEach(function (x) { if (!c && x.title === title) c = x })
      let created = false
      if (!c) {
        c = createCanvasDoc(title)
        applyWrite(c, content, 'replace', undefined, 'human')
        try { await saveCanvas(c) } catch (e) { console.error('[collab-canvas] load-doc save failed:', e && e.message) }
        created = true
      }
      sessAdd(url.searchParams.get('sid'), c.id)   // 登记即记入当前会话清单
      json(res, { ok: true, id: c.id, title: c.title, created: created })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // ─── 白名单：本地文档「就地」登记为话布 ───────────────────────────
  // 允许范围 = 会话工作区 ∪ 画布目录 ∪ 文件登记表里登记的文件夹。
  // 路径先 resolve 归一化再比较，防止 ../ 逃逸；不满足即拒绝（不开全盘口子）。
  function pathAllowedInTarget(target) {
    let t
    try { t = path.resolve(String(target || '')) } catch (_) { return false }
    const roots = []
    try { roots.push(path.resolve(sessionWorkspaceDir())) } catch (_) {}
    try { roots.push(path.resolve(docsDirBase())) } catch (_) {}
    regFolders.forEach(function (f) { try { roots.push(path.resolve(f)) } catch (_) {} })
    for (let i = 0; i < roots.length; i++) {
      const rel = path.relative(roots[i], t)
      if (rel === '' || (rel.indexOf('..') !== 0 && !path.isAbsolute(rel))) return true
    }
    return false
  }
  // GET /api/canvas/load-path?path=<绝对路径|工作区相对路径>&sid=xxx
  // —— 把白名单内的本地文档就地登记为话布：**绑定原路径，保存即写回原文件**（不是副本）。
  //    与 load-doc 的区别：load-doc 只认 canvas-docs/ 下的文件、复制内容另存；
  //    这里支持工作区/登记文件夹内的任意 .md/.markdown/.txt，且保持就地编辑语义。
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/load-path', handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const raw = String(url.searchParams.get('path') || '').trim()
      if (!raw) { error(res, 400, { ok: false, error: '缺少 path 参数' }); return }
      if (!/\.(md|markdown|txt|text)$/i.test(raw)) { error(res, 400, { ok: false, error: '仅支持 .md/.markdown/.txt' }); return }
      const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(sessionWorkspaceDir(), raw)
      if (!pathAllowedInTarget(abs)) {
        error(res, 403, { ok: false, error: '路径不在允许范围内（会话工作区 / 画布目录 / 已登记文件夹）' })
        return
      }
      if (!nodefs.existsSync(abs)) { error(res, 404, { ok: false, error: '文件不存在' }); return }
      let c = null
      canvases.forEach(function (x) {
        if (!c && x.filePath) { try { if (path.resolve(x.filePath) === abs) c = x } catch (_) {} }
      })
      let created = false
      if (!c) { c = await loadFileDoc(abs); created = true }
      sessAdd(url.searchParams.get('sid'), c.id)
      json(res, { ok: true, id: c.id, title: c.title, filePath: c.filePath, created: created })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // GET /api/canvas/delete?id=xxx&sid=xxx —— 从当前会话清单移除画布；
  // 若其他会话清单仍引用该画布则只摘引用保留文件，无人引用才连 md 一起删
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/delete', handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const id = url.searchParams.get('id')
      const sid = sessSafe(url.searchParams.get('sid'))
      const c = id ? canvases.get(id) : null
      if (!c) { error(res, 404, { ok: false, error: '画布不存在' }); return }
      sessRemove(sid, id)
      let referenced = false
      try {
        const files = nodefs.readdirSync(sessDirPath())
        for (const f of files) {
          if (!f.endsWith('.json') || f === sessSafe(sid) + '.json') continue
          try {
            const j = JSON.parse(nodefs.readFileSync(path.join(sessDirPath(), f), 'utf8'))
            if (Array.isArray(j.ids) && j.ids.indexOf(id) >= 0) { referenced = true; break }
          } catch (_) {}
        }
      } catch (_) {}
      if (!referenced) {
        canvases.delete(id)
        if (activeId === id) activeId = null
        try {
          if (c.filePath && nodefs.existsSync(c.filePath)) nodefs.unlinkSync(c.filePath)
        } catch (e) { console.error('[collab-canvas] delete file failed:', e && e.message) }
        persistMeta()
      }
      json(res, { ok: true, id: id, title: c.title, fileDeleted: !referenced })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/import-doc?name=xxx —— 外部文档拖入/上传：复制到会话工作区
  // 的 uploads/ 文件夹（@ 文件选择器可索引到），返回相对路径供 @ 引用
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/import-doc', handler: async (req, res) => {
    try {
      if (req.method !== 'POST') { error(res, 405, { ok: false, error: 'POST only' }); return }
      const url = new URL(req.url, 'http://x')
      let name = url.searchParams.get('name') || 'doc.md'
      name = String(name).replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || 'doc.md'
      const body = await readBody(req, UPLOAD_LIMIT)
      if (!body || !body.length) { error(res, 400, { ok: false, error: '空文件' }); return }
      const dir = path.join(sessionWorkspaceDir(), 'uploads')
      try { nodefs.mkdirSync(dir, { recursive: true }) } catch (e) {}
      const fname = Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '-' + name
      nodefs.writeFileSync(path.join(dir, fname), body)
      console.log('[collab-canvas] import-doc:', fname, body.length + 'B')
      json(res, { ok: true, path: 'uploads/' + fname, name: name, size: body.length })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // GET /api/canvas/open-upload?name=xxx —— 把拖入上传的文档变成/打开话布：
  // 已有同名（去掉时间戳前缀后的标题，含/不含 .md 扩展名）话布 → 直接返回其 id；
  // 否则新建话布并写入文件内容。只允许读 uploads/ 目录、文件名限本插件生成的格式
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/open-upload', handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const fname = String(url.searchParams.get('name') || '')
      if (!/^\d{13}-[a-z0-9]{2,8}-[^\r\n\\/:"*?<>|]{1,120}$/i.test(fname)) { error(res, 400, { ok: false, error: '非法文件名' }); return }
      const upDir = path.join(sessionWorkspaceDir(), 'uploads')
      const full = path.join(upDir, fname)
      if (path.resolve(full).indexOf(path.resolve(upDir) + path.sep) !== 0) { error(res, 403, { ok: false, error: '非法路径' }); return }
      if (!nodefs.existsSync(full)) { error(res, 404, { ok: false, error: '文件不存在' }); return }
      const content = nodefs.readFileSync(full, 'utf8')
      const title = fname.replace(/^\d{13}-[a-z0-9]{2,8}-/i, '')
      const baseTitle = title.replace(/\.(md|markdown)$/i, '')
      // 查重按“路径”判断：拖拽拿不到源文件真实路径（安全限制），但拖进来
      // 的文件名就是路径的最后一段，而画布文档的存盘名 = 标题 + .md，
      // 因此“文件名(含/不含扩展名) = 画布标题”即视为同一篇文档，不按内容判断
      let c = null, matched = 'created'
      canvases.forEach(function (x) {
        if (!c && (x.title === title || x.title === baseTitle)) { c = x; matched = 'title' }
      })
      let created = false
      if (!c) {
        c = createCanvasDoc(title)
        applyWrite(c, content, 'replace', undefined, 'human')
        try { await saveCanvas(c) } catch (e) { console.error('[collab-canvas] open-upload save failed:', e && e.message) }
        created = true
      }
      sessAdd(url.searchParams.get('sid'), c.id)   // 导入即记入当前会话清单
      json(res, { ok: true, id: c.id, title: c.title, created: created, matched: matched })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // 画布附件与独立模块源码服务（file / docdrop.js / doclink.js）
  function canvasDocDir() {
    const c = activeId ? canvases.get(activeId) : null
    const raw = (c && c.filePath) ? path.dirname(c.filePath) : docsDir()
    let dir = path.isAbsolute(raw) ? raw : path.join(docsDirBase(), raw)
    dir = dir.replace(/[\\/]+$/, '')
    if (process.platform === 'win32') dir = path.win32.normalize(dir.replace(/\//g, '\\'))
    return dir
  }
  const MIME_MAP = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8',
  }
  // GET /api/canvas/file?name=attachments/xxx.png —— 读画布附件（路径限制在画布目录内）
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/file', handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const rel = url.searchParams.get('name') || ''
      const base = path.resolve(canvasDocDir())
      const full = path.resolve(base, rel)
      const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
      if (norm(full) !== norm(base) && norm(full).indexOf(norm(base) + path.sep) !== 0) {
        error(res, 403, { ok: false, error: '非法路径' }); return
      }
      if (!nodefs.existsSync(full) || !nodefs.statSync(full).isFile()) {
        error(res, 404, { ok: false, error: '文件不存在' }); return
      }
      const ext = (full.split('.').pop() || '').toLowerCase()
      const mime = MIME_MAP[ext] || 'application/octet-stream'
      const buf = nodefs.readFileSync(full)
      const disp = /^(image|video|audio)\//.test(mime) || ext === 'pdf' ? 'inline' : 'attachment'
      const fname = path.basename(full)
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': buf.length,
        'Content-Disposition': disp + "; filename*=UTF-8''" + encodeURIComponent(fname),
        'Cache-Control': 'no-cache',
      })
      res.end(buf)
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/upload?name=xxx —— 画布附件上传（图片粘贴等），存 canvas-docs/attachments/
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/upload', handler: async (req, res) => {
    try {
      if (req.method !== 'POST') { error(res, 405, { ok: false, error: 'POST only' }); return }
      const url = new URL(req.url, 'http://x')
      let name = url.searchParams.get('name') || 'file.bin'
      name = String(name).replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || 'file.bin'
      const body = await readRawBody(req, UPLOAD_LIMIT)
      if (!body || !body.length) { error(res, 400, { ok: false, error: '空文件' }); return }
      const dir = path.join(canvasDocDir(), 'attachments')
      try { nodefs.mkdirSync(dir, { recursive: true }) } catch (e) {}
      const fname = Date.now() + '-' + name
      nodefs.writeFileSync(path.join(dir, fname), body)
      console.log('[collab-canvas] upload:', fname, body.length + 'B')
      json(res, { ok: true, path: 'attachments/' + fname, name: name, size: body.length })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  function readRawBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > limit) { reject(new Error('文件超过大小上限')); try { req.destroy() } catch (_) {} ; return }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }
  // GET /api/canvas/docdrop.js、/api/canvas/doclink.js —— 提供独立客户端模块源码
  //（client 入口动态挂载；每次读盘，改完刷新页面即生效，无需重启）。
  // 注意：运行时路径相对于部署目录的 dist/host.js 解析（../lib/…）
  ;['docdrop.js', 'doclink.js'].forEach(function (modFile) {
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/' + modFile, handler: async (req, res) => {
      try {
        const srcPath = new URL('../lib/' + modFile, import.meta.url)
        const src = nodefs.readFileSync(srcPath, 'utf8')
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
        res.end(src)
      } catch (e) { error(res, 500, { ok: false, error: e.message }) }
    }}))
  })

  // 启动文件登记表：无配置文件则先写默认（会话工作区），再自愈补登记 + 异步扫描
  setTimeout(function () {
    try {
      if (!nodefs.existsSync(REG_CONFIG_FILE())) {
        regSaveConfig([sessionWorkspaceDir()])
        console.log('[collab-canvas] registry: 首次运行，默认登记会话工作区 ->', sessionWorkspaceDir())
      }
      regSeedIfEmpty()
      console.log('[collab-canvas] file registry:', regFolders.length ? regFolders.join(' | ') : '(未登记文件夹)', '索引', regTotal, '文件')
    } catch (e) { console.error('[collab-canvas] registry init failed:', e && e.message) }
  }, 0)
}
