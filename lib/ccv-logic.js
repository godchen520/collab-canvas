// DSH Collab-Canvas · 纯逻辑共享层（2026-10-26 重构 P1）
//
// 为什么单独一个文件：
//   · 客户端有两块代码需要同一套算法（主模块 editor-panel.js、查看器 viewer-md.js）
//     而侧模块**不能 require** ✗ 只能靠全局量交接 ✓
//   · 这些逻辑又**全都不碰 DOM** ✓ → 放进一个可被 Node 直接 require 的模块 ✓
//     → 终于能给它们写自动化测试 ✓（本会话多次出错的地方正是这些算法 ✓）
//
// 加载方式：
//   浏览器：由 editor-panel.js 的侧模块引导拉取，执行后挂到 window.__ccvLogic
//           （同时挂 window.__ccvKit.logic，给其它侧模块用 ✓）
//   Node ：require('./lib/ccv-logic.js') ✓ 直接拿到同一份实现 ✓
//
// ⚠️ 铁律：**这里只准放纯函数** ✗ 不许碰 DOM / window API / 定时器
//          （碰了就没法在 Node 里测 ✓ 也就失去抽出来的意义 ✗）
var CCV_LOGIC = (function () {
  'use strict'

  // ── 1. 会话键哈希（djb2 → 36 进制）──
  //   历史：会话键曾是 "sess-" + hash(会话名)，落盘文件名就是它 ✓
  //   现已优先用真 sessionId，但**旧键反查**仍需要这个哈希 ✓
  //   实证：hash('DeepSeek Harness') === 'qberq7'（与老日志一致 ✓）
  function hashStr(s) {
    var h = 5381
    var str = String(s == null ? '' : s)
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0
    return h.toString(36)
  }

  // ── 2. dsh-resource 地址拼装（照官方 fileAddressFor 的编码规则）──
  //   规则：逐段 encodeURIComponent ✓ 但盘符冒号保留 ✓
  var FILE_PREFIX = 'dsh-resource://file/'
  function encSeg(seg) {
    var s = String(seg == null ? '' : seg)
    try { s = encodeURIComponent(s) } catch (_) {}
    return s.split('%3A').join(':').split('%3a').join(':')
  }
  function encPath(p) {
    return String(p == null ? '' : p).split('/').map(encSeg).join('/')
  }
  function sessionFileAddress(sessionId, absPath) {
    var sid = String(sessionId == null ? '' : sessionId).trim()
    if (!sid) return ''
    var p = String(absPath == null ? '' : absPath).replace(/\\/g, '/')
    if (!p) return ''
    while (p.indexOf('./') === 0) {
      p = p.slice(2)
      if (p.indexOf('./') !== 0) break
    }
    return FILE_PREFIX + 'session/' + encSeg(sid) + '/' + encPath(p)
  }

  // ── 3. 会话键选择（纯逻辑部分：真 id 优先）──
  //   ⚠️ 读 window.__ccvSessionId / DOM 的部分留在调用方 ✗ 这里只做判断 ✓
  function isRealSessionId(v) {
    return typeof v === 'string' && /^session-/.test(v)
  }

  // ── 4. 宽高判据：宽 ≥ 高 → 停靠（真·纯函数，测起来最简单）──
  function pickDocked(w, h) {
    var W = Number(w) || 0
    var H = Number(h) || 0
    if (W < 60 || H < 60) return null      // 太小，先别判 ✓
    return W >= H
  }

  // ── 5. 旧哈希键 → 真会话 id 的反查表 ──
  //   byId 形如 { 'session-xxx': { displayTitle, title } }
  //   返回 { 'sess-<hash>': sid, 't<hash>': sid } ✓
  function hashKeyMap(byId) {
    var map = {}
    if (!byId || typeof byId !== 'object') return map
    Object.keys(byId).forEach(function (sid) {
      var row = byId[sid]
      if (!row) return
      var t = row.displayTitle || row.title || ''
      if (!t) return
      map['sess-' + hashStr(t)] = sid
      map['t' + hashStr(t)] = sid
    })
    return map
  }

  // ── 6. 分组拼装（本会话反复出错的地方 ✓ 现在能被测试锁住）──
  //   data    = { canvases:[{id,title,updatedAt,filePath}], groups:[{sid,real,ids}] }
  //   curSid  = 当前会话 id（用来把它的组置顶）
  //   byId    = 会话快照（用来取真名 + 旧键反查）
  //   titleOf = function(sid) -> string（取会话名；为空则回落）
  //   返回    = { groups:[{sid,key,keys,legacy,title,matched,items,latest}], total }
  //   规则：
  //     · 同一篇文档只出现一次 ✓（先到先得：宿主已按唯一归属返回 ✓）
  //     · 旧哈希键反查成功 → 归到真会话名下 ✓ 合并到同一组 ✓
  //     · 当前会话置顶 ✓ 认不出的旧组垫底 ✓ 未归属最后 ✓
  function buildGroups(data, curSid, byId, titleOf) {
    var canvases = (data && data.canvases) || []
    var rawGroups = (data && data.groups) || []
    var map = hashKeyMap(byId)
    var byCanvas = {}
    canvases.forEach(function (c) { if (c && c.id) byCanvas[c.id] = c })
    var seen = {}
    var byEff = {}
    var order = []
    rawGroups.forEach(function (g) {
      var items = []
      ;(g.ids || []).forEach(function (id) {
        var c = byCanvas[id]
        if (!c || seen[id]) return
        seen[id] = 1
        items.push(c)
      })
      if (!items.length) return
      var guess = (!g.real && map[g.sid]) ? map[g.sid] : ''
      var effSid = guess || g.sid
      var title = (titleOf && titleOf(effSid)) || (titleOf && titleOf(g.sid)) || ''
      if (byEff[effSid]) {
        byEff[effSid].items = byEff[effSid].items.concat(items)
        byEff[effSid].keys.push(g.sid)
        if (!byEff[effSid].title && title) byEff[effSid].title = title
      } else {
        byEff[effSid] = {
          sid: effSid,
          key: g.sid,
          keys: [g.sid],
          legacy: !g.real && !guess,
          title: title,
          matched: !!guess,
          items: items,
        }
        order.push(effSid)
      }
    })
    var groups = order.map(function (sid) {
      var g = byEff[sid]
      g.items.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) })
      g.latest = g.items[0].updatedAt || 0
      return g
    })
    var orphans = canvases.filter(function (c) { return c && c.id && !seen[c.id] })
    groups.sort(function (a, b) {
      var ac = (a.sid === curSid) ? 1 : 0
      var bc = (b.sid === curSid) ? 1 : 0
      if (ac !== bc) return bc - ac
      if (a.legacy !== b.legacy) return a.legacy ? 1 : -1
      return (b.latest || 0) - (a.latest || 0)
    })
    if (orphans.length) {
      orphans.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) })
      groups.push({ sid: '__orphan__', key: '', keys: [], legacy: false, title: '未归属', matched: false, items: orphans, latest: 0 })
    }
    return { groups: groups, total: canvases.length }
  }

  // ── 7. 归属归一（服务端也有一份实现；这里是同一套规则的纯函数版 ✓ 用于测试）──
  //   entries = [{ key, ids }]（顺序无关 ✓ 规则确定性 ✓ 与时间戳无关 ✓）
  //   规则：真会话键优先 → 其余按键名升序 ✓
  //   返回 { owner:{ id: key }, keep:{ key: [ids] } }
  function normalizeOwnership(entries) {
    var list = (entries || []).slice().sort(function (a, b) {
      var ar = /^session-/.test(a.key) ? 1 : 0
      var br = /^session-/.test(b.key) ? 1 : 0
      if (ar !== br) return br - ar
      return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0)
    })
    var owner = {}
    list.forEach(function (e) {
      (e.ids || []).forEach(function (id) { if (!owner[id]) owner[id] = e.key })
    })
    var keep = {}
    ;(entries || []).forEach(function (e) {
      keep[e.key] = (e.ids || []).filter(function (id) { return owner[id] === e.key })
    })
    return { owner: owner, keep: keep }
  }

  // ── 8. 目录条目切分（顶部标题 vs 列表）──
  //   outline = [{ lv, text }]；首个一级标题当"文档标题"✓ 列表里跳过它 ✓
  function splitOutline(outline) {
    var list = outline || []
    var headTitle = ''
    var listStart = 0
    if (list.length && list[0] && list[0].lv === 1) {
      headTitle = list[0].text || ''
      listStart = 1
    }
    return { headTitle: headTitle, listStart: listStart, rest: list.slice(listStart) }
  }

  // ── 9. 目录行/列宽（纯换算）──
  function tocWidth(docked) { return docked ? 220 : 190 }
  function shellPadLeft(tocOn, docked) {
    if (!tocOn) return '16px'
    return docked ? 0 : (tocWidth(false) + 12) + 'px'
  }

  // ── 10. 文档标题（2026-10-26 P3：从 BodyInner 里搬出来的纯计算）──
  //   优先正文第一个 h1（= 文档标题）✓ 兜底文件名（去 .md，反斜杠也认）✓
  function docTitle(outline, absPath) {
    var list = outline || []
    if (list.length && list[0] && list[0].lv === 1 && list[0].text) return list[0].text
    try {
      return String(absPath || '').replace(/\\/g, '/').split('/').pop().replace(/\.md$/i, '')
    } catch (_) { return '' }
  }

  // ── 11. 目录条目 class（层级夹到 1..4 + 高亮）──
  function tocItemClass(lv, isActive) {
    var n = Math.min(4, Math.max(1, Number(lv) || 1))
    return 'ccv-toc-item ccv-l' + n + (isActive ? ' is-active' : '')
  }

  // ── 12. 目录面板样式（停靠 / 浮层 / 悬浮三种）✓ 纯对象，可被测试比对 ──
  function tocPanelStyle(mode) {
    if (mode === 'dock') {
      var w = tocWidth(true)
      return { flex: '0 0 ' + w + 'px', width: w + 'px' }
    }
    if (mode === 'overlay') {
      return {
        position: 'absolute', left: 0, top: 0, bottom: 0, zIndex: 40,
        width: tocWidth(false) + 'px',
        background: 'var(--dsw-alias-bg-layer-1,rgba(30,30,30,.96))',
      }
    }
    return {
      position: 'absolute', left: 0, top: 0, bottom: 0, zIndex: 41,
      width: tocWidth(false) + 'px',
      background: 'var(--dsw-alias-bg-layer-1,rgba(30,30,30,.97))',
    }
  }

  // ── 13. 外层壳样式（包住目录 + 正文的那一层）──
  function shellStyle(tocOn, docked) {
    return {
      position: 'relative', display: 'flex', height: '100%',
      minHeight: 0, minWidth: 0, alignItems: 'stretch',
      boxSizing: 'border-box',
      paddingLeft: shellPadLeft(!!tocOn, !!docked),
    }
  }

  // ── 14. 正文盒模型样式（2026-10-27 从 viewer 搬来；固定值，不随目录开合变）──
  //   ⚠️ whiteSpace 必须是 normal：宿主容器是 pre-wrap ✗ 会把我产出的 HTML
  //      标签间换行当真换行渲染 ✓ 段落间就凭空多一行（2026-10-11 实测过）✓
  function editorBoxStyle() {
    return {
      height: '100%', overflow: 'auto', boxSizing: 'border-box',
      padding: '18px 24px 18px 20px', lineHeight: 1.75,
      fontSize: '14px', wordBreak: 'break-word',
      whiteSpace: 'normal',
    }
  }
  return {
    hashStr: hashStr,
    isRealSessionId: isRealSessionId,
    encSeg: encSeg,
    encPath: encPath,
    sessionFileAddress: sessionFileAddress,
    pickDocked: pickDocked,
    hashKeyMap: hashKeyMap,
    buildGroups: buildGroups,
    normalizeOwnership: normalizeOwnership,
    splitOutline: splitOutline,
    docTitle: docTitle,
    tocItemClass: tocItemClass,
    tocPanelStyle: tocPanelStyle,
    shellStyle: shellStyle,
    editorBoxStyle: editorBoxStyle,
    tocWidth: tocWidth,
    shellPadLeft: shellPadLeft,
    FILE_PREFIX: FILE_PREFIX,
  }
})()

// 浏览器：挂全局（侧模块 / 主模块共用 ✓）
try { if (typeof window !== 'undefined' && window) window.__ccvLogic = CCV_LOGIC } catch (_) {}
// 主模块的 kit 也挂一份（其它侧模块可以通过 __ccvKit.logic 取 ✓）
try {
  if (typeof window !== 'undefined' && window && window.__ccvKit) window.__ccvKit.logic = CCV_LOGIC
} catch (_) {}
// Node：直接 require ✓（自动化测试用）
if (typeof module === 'object' && module && module.exports) module.exports = CCV_LOGIC
