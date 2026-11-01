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
// ★ 2026-10-24：分组改成【唯一归属】（一篇文档只属于一个会话）★
//   事故（主人现场）：「我拖动换组怎么成这样了」
//   根因：sessAdd 只往新组**追加**，从不把文档从旧组摘掉 ✗
//     → 同一篇文档同时挂在好几个 .json 里 ✓
//     → 界面按"先遇到的组"显示它 ✗ → 它跑到没预期的组里 / 拖走以后旧组那份还在 ✓
//   现在：登记到某组时，顺手把它从**其它所有组**里摘掉 ✓
//   代价：要读一遍 .json（21 个，实测 11~16ms ✓）—— 只在打开/新建文档时发生 ✓
function sessAddExclusive(sid, id) {
  // ⚠️ 没有会话键、或键就是历史兜底桶 'default' → **不登记** ✓
  //   别再把文档塞进那个假会话里 ✗（2026-10-24 那批就是这么进去的 ✓）
  if (!sid || String(sid) === 'default') return
  const target = sessSafe(sid)
  // ① 先从其它组里摘掉 ✓（不碰目标组 ✓）
  let files = []
  try { files = nodefs.readdirSync(sessDirPath()).filter(f => /\.json$/i.test(f)) } catch (_) {}
  for (const f of files) {
    const key = String(f).replace(/\.json$/i, '')
    if (key === target) continue                    // 目标组不动 ✓
    const fp = joinPath(sessDirPath(), f)
    let j = null
    try { j = JSON.parse(nodefs.readFileSync(fp, 'utf8')) } catch (_) { continue }
    if (!j || !Array.isArray(j.ids) || j.ids.indexOf(id) < 0) continue
    j.ids = j.ids.filter(x => x !== id)
    const nextActive = (j.activeId === id) ? (j.ids[0] || null) : (j.activeId || null)
    try { nodefs.writeFileSync(fp, JSON.stringify({ activeId: nextActive, ids: j.ids }, null, 2)) } catch (_) {}
    sessStore.delete(key)
  }
  // ② 再登记到目标组 ✓
  sessAdd(sid, id)
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
  // HTTP 响应辅助：2026-10-26 重构 P2 起统一由 01-utils.js 提供
  //   httpJson / httpError / httpReadBody(Buffer) / httpReadJson(解析对象)
  //   原来是本文件与 11-canvas-extras 各写一份 ✗ 语义还不完全一致（Buffer vs JSON）
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
      // ⚠️ 选区编辑区（type='scratch'）**不进任何清单**（2026-10-11 加）。
      //   它不是给人看的，是 AI 的工作台（规格第九节「明确不做」：不加分组、不加行）。
      canvases.forEach((c) => { if (c && c.type !== 'scratch') all.push({ id: c.id, title: c.title, version: c.version, path: canvasMdPath(c) }) })
      httpJson(res, { ok: true, canvases: all, activeId: activeId, scope: 'all' })
      return
    }
    // ★ ?scope=groups —— 按【会话】分组（2026-10-24 主人要求）★
    //   为什么新增一个 scope 而不是改老的两个：
    //     老的 scope=all / scope=sid 都有人在用（客户端做标题链接、会话清单）✗
    //     改它们的返回形状 = 静默弄坏别处 ✓ 所以只**新增**一个分支 ✓
    //   数据来源：canvas-docs/.sessions/<sid>.json 里的 { activeId, ids } ✓
    //     —— 这份归属关系早就有（09-http.js 顶部那套 sessState），
    //        只是一直没有"把全部会话一起返回"的接口 ✓
    //   返回：
    //     groups   [{ sid, activeId, ids: [...] }]   按 .json 的修改时间**倒序**（最近用过的在前）
    //     canvases 全量元数据（id/title/path/updatedAt），客户端按 id 拼装
    //   规则：
    //     · 跳过 type='scratch' ✓（AI 工作台，不进任何清单 ✓）
    //     · 跳过 ids 全都不存在的空组 ✓（不显示空会话 ✓）
    if (url.searchParams.get('scope') === 'groups') {
      const dir = sessDirPath()
      let files = []
      try { files = nodefs.readdirSync(dir).filter((f) => /\.json$/i.test(f)) } catch (_) {}
      // ① 先全部读出来 ✓
      const entries = []
      for (const f of files) {
        let mt = 0
        let j = null
        try {
          mt = nodefs.statSync(joinPath(dir, f)).mtimeMs || 0
          j = JSON.parse(nodefs.readFileSync(joinPath(dir, f), 'utf8'))
        } catch (_) { continue }
        if (!j || !Array.isArray(j.ids)) continue
        entries.push({ f, key: String(f).replace(/\.json$/i, ''), mt, j, fp: joinPath(dir, f) })
      }
      // ② ★ 归一：每篇文档只留【一个】归属，并写回磁盘（2026-10-24）★
      //   主人症状：「我移动文档改分组，怎么乱变分组」
      //   根因（实测）：25 篇里 10 篇同时挂在多个组 ✗（有一篇挂了 5 个组 ✓）
      //     而我上一版是**按文件修改时间去决定归属** ✗
      //     → 每拖动一次，目标文件的时间戳变新 ✓
      //     → 下一次读，其它重复文档的归属也跟着变 ✓ → 界面"乱变"✓✓
      //   修法：在**服务端**把重复彻底收敛掉 ✓ 规则稳定、与时间无关：
      //     真会话键优先（session-…）→ 其次键名升序（确定性 ✓ 不随写入漂移 ✓）
      //     归谁就写回磁盘：从其它组的 ids 里摘掉 ✓ 以后再也不重复 ✓
      const ranked = entries.slice().sort((a, b) => {
        const ar = /^session-/.test(a.key) ? 1 : 0
        const br = /^session-/.test(b.key) ? 1 : 0
        if (ar !== br) return br - ar                 // 真会话优先 ✓
        return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0)   // 其余按键名 ✓ 稳定 ✓
      })
      const ownerOf = {}
      for (const e of ranked) {
        for (const id of e.j.ids) { if (!ownerOf[id]) ownerOf[id] = e.key }
      }
      let normalized = 0
      for (const e of entries) {
        const keep = e.j.ids.filter((id) => ownerOf[id] === e.key)
        if (keep.length === e.j.ids.length) continue
        const nextActive = (e.j.activeId && keep.indexOf(e.j.activeId) >= 0) ? e.j.activeId : (keep[0] || null)
        try { nodefs.writeFileSync(e.fp, JSON.stringify({ activeId: nextActive, ids: keep }, null, 2)) } catch (_) {}
        sessStore.delete(e.key)
        e.j = { activeId: nextActive, ids: keep }
        normalized++
      }
      if (normalized) {
        console.log('[collab-canvas] 分组归一：' + normalized + ' 个组的重复归属已收敛（每篇文档只留一个归属）')
      }
      // ③ 组装分组（顺序只影响客户端默认排序 ✓ 客户端会自己按更新时间和当前会话重排 ✓）
      const withTime = []
      for (const e of entries) {
        const ids = e.j.ids.filter((id) => {
          const c = id ? canvases.get(id) : null
          return !!(c && c.type !== 'scratch')
        })
        if (!ids.length) continue          // 空组不返回 ✓
        withTime.push({ mtime: e.mt, g: { sid: e.key, activeId: e.j.activeId || null, ids } })
      }
      withTime.sort((a, b) => b.mtime - a.mtime)
      const groupsOut = withTime.map((x) => x.g)
      const all = []
      canvases.forEach((c) => {
        if (!c || c.type === 'scratch') return
        all.push({ id: c.id, title: c.title, version: c.version, path: canvasMdPath(c), updatedAt: c.updatedAt || 0 })
      })
      httpJson(res, {
        ok: true,
        scope: 'groups',
        // real: 这个键是不是【真会话 id】（session-… 形式）。
        //   2026-10-24 之前客户端用的是 hash(会话名) 当键 ✗ → 那些组查不到会话名 ✓
        //   客户端会拿 hash(会话名) 反着撞一遍，能撞上的就当那个会话 ✓（见客户端注释）
        groups: groupsOut.map((g) => Object.assign({ real: /^session-/.test(g.sid) }, g)),
        canvases: all,
        activeId: activeId,
      })
      return
    }
    const sid = sessSafe(url.searchParams.get('sid'))
    lastBrowserSid = sid
    const st = sessState(sid)
    const arr = []
    st.ids.forEach((id) => { const c = canvases.get(id); if (c && c.type !== 'scratch') arr.push({ id: c.id, title: c.title, version: c.version, path: canvasMdPath(c) }) })
    httpJson(res, { ok: true, canvases: arr, activeId: st.activeId })
  }}))
  // GET /api/canvas/read?id=xxx —— 打开过就记入该会话清单
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/read', handler: async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const id = url.searchParams.get('id')
    const c = id ? canvases.get(id) : (activeId ? canvases.get(activeId) : null)
    if (!c) { httpError(res, 404, { ok: false, error: '画布不存在' }); return }
    // ★ 2026-10-24 事故防线 ★
    //   「打开的文档都跑到旧记录.default 里去了，打开一个进去一个」
    //   根因：查看器那两处请求**没带 sid** ✗ → sessSafe(null) 退成 'default' ✗
    //     → 每打开一篇就默默堆进 default ✓（和 12 篇老文档混在一起 ✓）
    //   客户端已修（补 sid）✓ 这里再加一道：
    //     **sid 没带就别登记** ✓ —— 宁可让它落在「未归属」（看得见 ✓）
    //     也不要静默塞进一个假会话 ✓
    const sidRaw = url.searchParams.get('sid')
    if (sidRaw) {
      sessAddExclusive(sidRaw, c.id)
      lastBrowserSid = sessSafe(sidRaw)
    }
    httpJson(res, { ok: true, id: c.id, title: c.title, content: c.content, version: c.version, path: canvasMdPath(c), canUndo: canUndo(c), canRedo: canRedo(c) })
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
    if (isNaN(since)) { httpError(res, 400, { ok: false, error: 'since 必须是数字' }); return }
    const out = aiChanges.filter((x) => x.seq > since)
    httpJson(res, { ok: true, latest: aiChangeSeq, changes: out })
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
      if (req.method !== 'POST') { httpError(res, 405, { ok: false, error: '只收 POST' }); return }
      const body = await httpReadJson(req)
      const taken = ccvPinAdd(body)
      httpJson(res, { ok: taken, n: ccvPins.length })
    } catch (e) { httpError(res, 400, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/scratch —— 开一个「选区编辑区」
  // 规格：canvas-docs/话布选区编辑区方案.md（第二、三、七节）
  // 客户端点「问 AI」时调它。body: { pinCode, docId, docPath, quote, ordinal, dupCount }
  //
  // 🔴 偏移由 **host 侧**按「引文 + 序数」解析，客户端不必把 DOM 偏移硬换算成
  //    markdown 偏移 —— 那一步最容易错（渲染会吃掉 `**`、拆并段落）。
  //    口径与「位置主动注入」完全一致：**渲染前后文字的出现顺序不变**，
  //    所以两边数出来的"第几处"是同一个数（见 13-selref-context.js 的注释）。
  // 解析不出来（序数越界 / 引文找不到）→ offset 记 -1，**不猜**；
  //    实施步骤 3（拼接）遇到 -1 会报给主人，而不是硬拼。
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/scratch', handler: async (req, res) => {
    try {
      if (req.method !== 'POST') { httpError(res, 405, { ok: false, error: '只收 POST' }); return }
      const body = await httpReadJson(req)
      const quote = String(body.quote || '')
      if (!quote.trim()) { httpError(res, 400, { ok: false, error: '没有引文' }); return }

      // 找主文档：优先 id，其次按真实路径（正斜杠、忽略大小写）
      let doc = body.docId ? canvases.get(body.docId) : null
      if (!doc && body.docPath) {
        const want = String(body.docPath).replace(/\\/g, '/').toLowerCase()
        canvases.forEach(function (c) {
          if (doc || !c || c.type === 'scratch') return
          const p = String(c.filePath || '').replace(/\\/g, '/').toLowerCase()
          if (p && p === want) doc = c
        })
      }

      let offset = -1
      let dup = 0
      if (doc) {
        const hits = occIndexes(String(doc.content || ''), quote)
        dup = hits.length
        const ord = (typeof body.ordinal === 'number' && body.ordinal > 0) ? body.ordinal : 0
        if (ord > 0 && ord <= hits.length) offset = hits[ord - 1]
        else if (hits.length === 1) offset = hits[0]
      }

      const c = createScratchCanvas({
        docId: doc ? doc.id : null,
        docPath: doc ? canvasMdPath(doc) : (body.docPath || null),
        offset: offset,
        length: quote.length,
        docVersion: doc ? doc.version : 0,
        ordinal: body.ordinal,
        dupCount: dup || body.dupCount,
        pinCode: body.pinCode,
        quote: quote,
      })
      ccvTrace('开了选区编辑区 ' + c.id + '（主文档=' + (doc ? doc.title : '没找到')
        + '，偏移=' + offset + '，全文 ' + dup + ' 处，序数=' + (body.ordinal || 0) + '）')
      httpJson(res, { ok: true, areaId: c.id, offset: offset, dupCount: dup })
    } catch (e) { httpError(res, 400, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/write
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/write', handler: async (req, res) => {
    try {
      const body = await httpReadJson(req)
      const id = body.id || activeId
      const c = id ? canvases.get(id) : null
      if (!c) { httpError(res, 404, { ok: false, error: '画布不存在' }); return }
      const result = applyWrite(c, body.content, 'replace', body.knownVer, 'human')
      // ⚠️ 冲突必须显式回传。applyWrite 检出并发冲突时返回
      //    { conflict, currentVersion, currentContent }，此时 result.version 是 undefined；
      //    若照原样 httpJson({ ok: true, version: result.version })，
      //    undefined 会被 JSON.stringify 丢掉 → 响应变成 {"ok":true} ——
      //    冲突被伪装成成功，浏览器编辑器无从察觉，只能继续用旧内容写。
      if (result && result.conflict) {
        httpJson(res, { ok: false, conflict: true, currentVersion: result.currentVersion, currentContent: result.currentContent })
        return
      }
      httpJson(res, { ok: true, version: result.version, canUndo: canUndo(c), canRedo: canRedo(c) })
    } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/undo | /api/canvas/redo
  //
  // 为什么必须加 HTTP 这一层：撤销栈（history/redoStack）和 canvas.undo RPC
  // **早就在了**，但那是走 harness.handle 的包级 RPC，而画布面板只走 HTTP
  // （/api/canvas/*）—— 两边根本不连通，于是"有撤销"这件事在界面上等于不存在
  // （2026-09-28 核对：lib/client.js 里 undo|redo 零命中，09-http.js 也一个端点都没有）。
  //
  // 语义：把 content 换成快照里的 before/after，version+1（客户端靠它同步 knownVer），
  // 结果落盘。栈空时回 { ok:true, noop:true } 而不是报错 —— 界面据此提示"没有可撤销的了"。
  function undoRedoEndpoint(path, fn) {
    ctx.effect(() => webServer.register({ kind: 'exact', path: path, handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { httpError(res, 405, { ok: false, error: '只收 POST' }); return }
        const body = await httpReadJson(req)
        const id = body.id || activeId
        const c = id ? canvases.get(id) : null
        if (!c) { httpError(res, 404, { ok: false, error: '画布不存在' }); return }
        const r = fn(c)
        if (!r.ok) { httpError(res, 404, { ok: false, error: r.error }); return }
        // ⚠️ **立刻落盘**（2026-10-11 加，修"撤销有延迟"）
        //   默认路径是 applyWrite → debouncedFlush（1500ms ✗），而查看器是**等文件变化**
        //   才刷新正文的 → 两段延迟叠起来手感很明显（主人报"撤回重做有延迟"）。
        //   撤销/重做是**人的一次性动作**，没有连打的场景 —— 不值得为它省一次写盘 ✓
        //   所以这里跳过 debounce 直接 flush（写盘量很小，就一篇文档 ✓）。
        try { await flushDirty() } catch (_) {}
        httpJson(res, { ok: true, noop: !!r.noop, content: r.content, version: r.version, source: r.source || null, canUndo: canUndo(c), canRedo: canRedo(c) })
      } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
    }}))
  }
  undoRedoEndpoint('/api/canvas/undo', undoCanvas)
  undoRedoEndpoint('/api/canvas/redo', redoCanvas)
  // POST /api/canvas/create?sid=xxx —— 新建即记入当前会话清单
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/create', handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const body = await httpReadJson(req)
      const c = createCanvasDoc(body.title || '新话布')
      // 同上：sid 没带就别登记 ✓（别塞进假会话 'default' ✗）
      const sidCreate = url.searchParams.get('sid')
      if (sidCreate) sessAddExclusive(sidCreate, c.id)
      httpJson(res, { ok: true, id: c.id, title: c.title })
    } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
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
        const body = await httpReadJson(req)
        const lines = Array.isArray(body.lines) ? body.lines : [String(body.line || '')]
        lines.forEach(function (l) { _dbg.push(ts() + ' ' + String(l)) })
        if (_dbg.length > DBG_MAX) _dbg = _dbg.slice(_dbg.length - DBG_MAX)
        dbgWrite()
        httpJson(res, { ok: true, n: _dbg.length, file: DEBUG_LOG })
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(_dbg.join('\n') + '\n')
      }
    } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
  }}))
  // ─── POST /api/canvas/move-group —— 把一篇文档挪到另一个分组 ──────────
  //   2026-10-24 主人要求「我要能自由拖动改分组」✓
  //   分组**只是索引** ✓ 这里只动 .sessions/*.json 里的 id 数组 ✓
  //   **绝不碰 md 文件、绝不碰 filePath、绝不碰内容** ✓（主人确认过这条 ✓）
  //   body: { id, toSid }   toSid 为空字符串 = 移出所有组（回到「未归属」）✓
  //   ⚠️ 改完必须清 sessStore 缓存 ✗ 否则内存里还是旧清单 ✓
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/move-group', handler: async (req, res) => {
    try {
      if (req.method !== 'POST') { httpError(res, 405, { ok: false, error: '只收 POST' }); return }
      const body = await httpReadJson(req)
      const id = String((body && body.id) || '').trim()
      const toSid = String((body && body.toSid) || '').trim()
      if (!id) { httpError(res, 400, { ok: false, error: '缺 id' }); return }
      const c = canvases.get(id)
      if (!c) { httpError(res, 404, { ok: false, error: '文档不存在' }); return }
      if (c.type === 'scratch') { httpError(res, 400, { ok: false, error: 'scratch 不进任何分组' }); return }
      const dir = sessDirPath()
      let files = []
      try { files = nodefs.readdirSync(dir).filter((f) => /\.json$/i.test(f)) } catch (_) {}
      let removed = 0
      for (const f of files) {
        const fp = joinPath(dir, f)
        let j = null
        try { j = JSON.parse(nodefs.readFileSync(fp, 'utf8')) } catch (_) { continue }
        if (!j || !Array.isArray(j.ids) || j.ids.indexOf(id) < 0) continue
        j.ids = j.ids.filter((x) => x !== id)
        const nextActive = (j.activeId === id) ? (j.ids[0] || null) : (j.activeId || null)
        try { nodefs.writeFileSync(fp, JSON.stringify({ activeId: nextActive, ids: j.ids }, null, 2)) } catch (_) {}
        sessStore.delete(String(f).replace(/\.json$/i, ''))
        removed++
      }
      let targetSid = ''
      if (toSid) {
        targetSid = sessSafe(toSid)
        const st = sessLoad(targetSid)          // 从盘读，别用可能过期的缓存 ✓
        if (st.ids.indexOf(id) < 0) st.ids.push(id)
        const keepActive = (st.activeId && st.ids.indexOf(st.activeId) >= 0) ? st.activeId : id
        sessPersist(targetSid, { activeId: keepActive, ids: st.ids })
        sessStore.delete(targetSid)
      }
      httpJson(res, { ok: true, id, removed, toSid: targetSid })
    } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
  }}))
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
    httpJson(res, { ok: true, dir: dir, raw: raw, exists: info.exists, pid: info.pid, strategy: info.strategy })
  }}))
  console.log('[collab-canvas] HTTP endpoints registered: /api/canvas/* (debug log -> ' + DEBUG_LOG + ')')
}
