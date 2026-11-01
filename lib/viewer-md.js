// DSH 自带文档查看器里的 .md 渲染器 —— 用「话布文档」接管它
//
// ⚠️⚠️ **这个文件就是源头，直接改这里**（2026-10-14 补的说明）
//    它和 lib/selref.js 一样，是「按请求供源码」的侧模块：
//      宿主用 GET /api/canvas/viewer-md.js 现读现给（Cache-Control: no-cache）
//      → 改完**刷新页面即生效** ✓ 不用 build、不用重启 ✓
//    与之相反：**lib/client.js 是生成的** ✗（由 src/client/editor-panel.js 复制而来，
//      `npm run build` 会覆盖它）—— 直接改 lib/client.js 会被冲掉 ✗
//    三个文件两种规矩，所以在这里写清楚。新增侧模块还要记得改两处：
//      · src/client/editor-panel.js 顶部的加载清单
//      · src/host/11-canvas-extras.js 里的端点白名单（**服务端常量 → 要重启** ✗）
//
// ═══ 为什么走这条路（2026-10-04 查证后定的）═══════════════════════
// ① 「点文档开哪儿」原先靠**抢点击**：doclink 只认 `[data-presented-file]`（present 生成的那种
//    卡片）。别的会话用 write/Edit 写出来的文档落在「改动文件」那一行，认不到 → 走了自带查看器。
//    靠抢点击永远抢不全。
// ② DSH 的查看器**明确允许外部实现顶掉内置实现**。registry.d.ts 原话：
//      "External implementations win over product implementations"
//    而 `priority: 'extension'` 就是为这个准备的。内置那版仍作为**备选**留着
//    （registry 保留 lower-priority alternatives）—— 所以接管是**可逆的**，用户随时能切回去。
// ③ 走的是**声明过的公开接口**（带 .d.ts），比我们现在"钩 DOM 属性、猜服务名"稳得多。
//
// ═══ 进度 ═══════════════════════════════════════════════════════
// 第 1 步（已完成）：只读接管 —— 内容由框架按 text-pages 交给我们，我们负责渲染。
// 第 3 步（本版）：**划词问AI** —— 在正文里选一段字，浮出「问AI」，点它把引用插进输入框。
//   复用的是现成那套（lib/selref.js）：__ccvSelRefCapture 记一笔 → __ccvSelRefAuto 走官方两步。
//   我们只做三件事：① 把官方 inputActions / 会话 id / 取数桥挂到全局（跟主模块 InputBridge 同一套）
//   ② 划词浮按钮 ③ 点了之后按顺序喊那两个函数。
//   编辑、保存、撤销留到下一步。
//
// ⚠️⚠️ 两个踩过的坑，别再踩：
//   ① content 是**顶层 prop**，不是 props.owner.content！
//      内置那版原话：`function MarkdownBody({ content, resourceAddress, useResource, t })`，
//      紧跟 `if (content.kind !== "text") return null`。
//      我按想象的形状写 → undefined → 渲染出**空白 div** → 主人的 .md 什么都不显示。
//   ② React 拿不到：本模块是 host 端点供源码后 `new Function(src)()` **裸 eval** 的 ——
//      既没有 require，也没有 window.React。主模块的 React 来自模块加载器的 require("react")。
//      所以主模块把 React / h 借到 window.__ccvKit 上，这里从那儿取。
//   两个坑的表现**一模一样（都是空白）**，全靠诊断日志打出 `React=没有` 才分清 ——
//   所以：**宁可显示"拿不到内容/出错"，也绝不静默空白**。
;
(function () {
  var VERSION = 2
  // ⚠️ id 必须全局唯一：重名时 documentPreviews.register 会**抛错**
  var ID = 'collab-canvas-md'
  // ⚠️ 显示名是「话布文档」而不是「话布」（2026-10-11 主人定）：
  //    查看器右上角那个下拉框列的是"用哪个渲染器"（官方还有 Markdown / 代码 / 纯文本 ✓），
  //    而"话布"将来是**一整套功能** —— markdown 只是第一档 ✗。
  //    主人原话：以后会有 UI 实时可视编辑网页等，所以需要一个**话布标签页**，
  //    打开后**选功能**；标签页那件事现在先不做（说明留在 editor-panel.js 里 ✓）。
  //    所以这里先把自己叫准：我是"话布·文档"这一档 ✓ 不是"话布"全体 ✓
  var TITLE = '话布文档'
  var booted = false

  // ⚠️ 日志限流（2026-10-17 事故的防御 ✓）
  //   事故：一个"每 400ms 自我重排"的循环 ✗ → 日志刷出成百上千行 ✓
  //   而**每一行日志都是一次 POST** ✗（→ /api/canvas/log ✓）
  //   → 浏览器与服务端被淹 ✓ → 页面崩掉刷新 ✗ → 拼音里没上屏的内容全丢 ✓✓
  //   所以：**同一句话 1 秒内只发一次** ✓ 被压掉的次数补在后面 ✓
  //   （日志是排查用的 ✓ 但不能成为"把系统压垮"的通道 ✗）
  var logSeen = {}
  var logDrop = {}
  function log(m) {
    try {
      var now = Date.now()
      var key = String(m).slice(0, 60)
      if (logSeen[key] && (now - logSeen[key]) < 1000) {
        logDrop[key] = (logDrop[key] || 0) + 1
        return
      }
      var extra = ''
      if (logDrop[key]) { extra = '（同句被压掉 ' + logDrop[key] + ' 次）'; logDrop[key] = 0 }
      logSeen[key] = now
      if (window.__ccvKit && window.__ccvKit.log) window.__ccvKit.log(m + extra, 'viewer')
    } catch (_) {}
  }

  // markdown → HTML：复用主模块的 mdToHtml（挂在 __ccvKit 上）。
  // 拿不到就退回**纯文本**（转义后 pre 包起来）—— 宁可朴素，也不能因为渲染器缺失白屏。
  //
  // ★★ A4（2026-10-15）：**按块渲染**，不再整篇交给它 ★★
  //   病根（日志实测）：主模块的 mdToHtml 是**按行循环**的 ✗
  //     var lines = src2.split("\n"); while (i < lines.length) { … out.push("<p>" + … ) }
  //   → **多行段落被拆成多个 <p>** ✗✗
  //     （日志：往返：有差异 6333 字，行数 308→311，差 100 行 ✓
  //       第208行 原="> 想指回更早那个编辑区就做不到。引用本身就在输入框里摆着，" 回="> " ✓）
  //   现在：先用**文档模型**切块 ✓（P1 的成果 ✓）每块单独渲染 ✓ 再拼起来 ✓
  //     · 多行段落 / 多行标题 → **合成一个块** ✓ 行间用 <br> ✓
  //     · 其余块 → 交给主模块渲染这一块 ✓
  //   → 块边界由**模型**决定 ✓ 不再由渲染器"重新推"✗
  function md2html(md) {
    var k = (window.__ccvKit && typeof window.__ccvKit.mdToHtml === 'function') ? window.__ccvKit : null
    if (k) {
      var M = window.__ccvDocModel
      if (M && typeof M.parse === 'function' && typeof M.serialize === 'function') {
        try {
          var doc = M.parse(md)
          var parts = []
          for (var i = 0; i < doc.blocks.length; i++) {
            var b = doc.blocks[i]
            // 多行段落 / 多行标题 → 一个块 ✓（行间 <br> ✓ 保留你写的换行 ✓）
            if ((b.type === 'p' || b.type === 'h') && String(b.text).indexOf('\n') >= 0) {
              var ls = String(b.text).split('\n')
              var inner = ls.map(function (one) {
                var head = ''
                if (b.type === 'h') { head = ''; for (var n = 0; n < b.level; n++) head += '#' }
                var h = k.mdToHtml(b.type === 'h' ? (head + ' ' + one) : one)
                return String(h)
                  .replace(/^\s*<p[^>]*>/, '').replace(/<\/p>\s*$/, '')
                  .replace(/^\s*<h[1-6][^>]*>/, '').replace(/<\/h[1-6]>\s*$/, '')
              }).join('<br>')
              parts.push(b.type === 'h'
                ? ('<h' + b.level + '>' + inner + '</h' + b.level + '>')
                : ('<p>' + inner + '</p>'))
              continue
            }
            parts.push(k.mdToHtml(M.serialize({ blocks: [b] })))
          }
          var joined = parts.join('')
          if (joined) return joined
        } catch (err) { log('按块渲染失败，退回整篇渲染: ' + (err && err.message)) }
      }
      try {
        var out = k.mdToHtml(md)
        if (typeof out === 'string' && out) return out
      } catch (_) {}
    }
    return '<pre style="white-space:pre-wrap;word-break:break-word">'
      + String(md == null ? '' : md).replace(/[&<>]/g, function (c) {
        return c === '&' ? '&amp;' : (c === '<' ? '&lt;' : '&gt;')
      }) + '</pre>'
  }

  // ★★ A4 保存侧：**按顶层子元素分块**转 markdown ★★
  //   病根：整棵树一次交给 htmlToMd ✗ → 块边界靠它重新推 ✗
  //        → 段落被合并/拆分、列表套代码块漂移 ✓
  //   现在：编辑区每个**顶层子元素**单独转 ✓ 用空行拼 ✓
  //        → 块边界 = **DOM 的顶层结构** ✓（就是你看到的块 ✓）
  //   ⚠️ 任何异常/空结果 → 一律退回整棵树转 ✓（宁可老行为，也不能丢内容 ✗）
  function editorToMd(el) {
    var k = window.__ccvKit
    if (!el) return ''
    if (!k || typeof k.htmlToMd !== 'function') return ''
    try {
      var kids = Array.prototype.slice.call(el.childNodes || [])
      var blocks = [], seen = 0
      for (var i = 0; i < kids.length; i++) {
        var n = kids[i]
        if (n.nodeType === 3) {                       // 裸文本节点（打字时浏览器会冒出来 ✓）
          var tx = String(n.nodeValue || '').replace(/\u00a0/g, ' ').trim()
          if (tx) { blocks.push(tx); seen++ }
          continue
        }
        if (n.nodeType !== 1) continue
        var one = k.htmlToMd(n)
        if (typeof one === 'string' && one.replace(/\s+/g, '') !== '') {
          blocks.push(one.replace(/^\n+/, '').replace(/\n+$/, ''))
          seen++
        }
      }
      if (!seen) return k.htmlToMd(el)                // 兜底 ✓
      var md = blocks.join('\n\n')
      if (!md.replace(/\s+/g, '')) return k.htmlToMd(el)   // 结果空 → 兜底 ✓
      return md
    } catch (err) {
      log('按块序列化失败，退回整棵: ' + (err && err.message))
      try { return k.htmlToMd(el) } catch (_) { return '' }
    }
  }

  // ─── React（从主模块借，见文件头 ⚠️②）────────────────────────
  var R = null
  function ensureR() {
    if (R) return R
    try {
      var k = window.__ccvKit
      if (k && k.React && k.React.createElement) { R = k.React; return R }
    } catch (_) {}
    if (window.React && window.React.createElement) R = window.React
    return R
  }

  // ─── 往返自检（2026-10-11 加）───────────────────────────────
  // 为什么放在查看器里：自检本来挂在**话布面板**的加载流程，而主人在查看器里翻文档 ——
  // 一次都没跑 ✗。测量点要跟着人走。
  // 往返（md → html → md）本来是**面板保存**时的事，但拼接（实施步骤 3）会让整篇重渲染，
  // 那时漂移就落到主文档上了 —— 所以先量清楚再上拼接。
  // 只跑一次（按 路径 + 字数 记），不刷屏。
  var rtChecked = {}
  function roundTripCheck(md, absPath) {
    try {
      var k = window.__ccvKit
      if (!k || typeof k.htmlToMd !== 'function' || typeof k.mdToHtml !== 'function') {
        log('往返自检：主模块还没把 mdToHtml/htmlToMd 借出来，跳过')
        return
      }
      var text = String(md || '')
      var key = String(absPath || '?') + '#' + text.length
      if (rtChecked[key]) return
      rtChecked[key] = true

      var box = document.createElement('div')
      box.innerHTML = k.mdToHtml(text)
      var back = k.htmlToMd(box)
      if (back === null || back === undefined) { log('往返自检：htmlToMd 返回空，跳过'); return }
      if (back === text) { log('往返：无损 ✓ ' + text.length + ' 字'); return }

      var la = text.split('\n')
      var lb = String(back).split('\n')
      var nd = 0
      var diffs = []
      for (var i = 0; i < Math.max(la.length, lb.length); i++) {
        if (la[i] === lb[i]) continue
        nd++
        if (diffs.length < 3) {
          diffs.push('第' + (i + 1) + '行 原=' + JSON.stringify(String(la[i] === undefined ? '（无此行）' : la[i]).slice(0, 44))
            + ' 回=' + JSON.stringify(String(lb[i] === undefined ? '（无此行）' : lb[i]).slice(0, 44)))
        }
      }
      log('往返：有差异 ' + text.length + ' 字，行数 ' + la.length + '→' + lb.length
        + '，差 ' + nd + ' 行 ｜ ' + diffs.join(' ｜ '))
    } catch (e) { log('往返自检出错：' + (e && e.message)) }
  }

  // ─── 查看器工具栏按钮（撤销 / 重做）────────────────────────
  // 挂到 `sidebar.right.tab.document.actions`（**list** 槽）—— 注册字段是 id/order/label ✓
  // owner props 是 `{ absolutePath }` ✓
  //   契约来源两处（都对上了才敢写）：
  //     · contract.d.ts: owner: { readonly absolutePath: string }
  //     · 官方 open-in-app 的写法：renderSlot(name, { absolutePath })
  // 这个槽的语义是"作用于当前预览文件的工具栏按钮" ✓ 正好放撤销/重做。
  //
  // ⚠️ 暂时**不放"保存"**：查看器这版还是**只读**的 ✗ 没有本地改动可存 ——
  //    保存要等编辑（contentEditable）做进来，否则是个点了没意义的按钮 ✗
  function canvasIdForPath(p) {
    if (!p || !canvasMap) return ''
    var hit = canvasMap[normPath(p)]
    return hit ? hit.id : ''
  }

  function Actions(props) {
    var r = ensureR()
    if (!r) return null
    return ActionsInner(props, r)
  }

  function ActionsInner(props, r) {
    var h = r.createElement
    var absPath = (props && props.absolutePath) || ''
    var st = r.useState({ id: '', canUndo: false, canRedo: false })
    var info = st[0]
    var setInfo = st[1]
    // 编辑状态（正文组件那边写进来的）：dirty = 有没有未保存的改动
    var ds = useDocStore(absPath, r)
    var dirty = !!(ds && ds.dirty)

    // 挂载 / 换文件时读一次状态（canUndo / canRedo / 版本号 / 原文 / 本地草稿）
    //
    // 🔴🔴 **必须有依赖数组**（2026-10-15 修，主人报的三个症状都是它引起的 ✗）
    //   原来写成 useEffect(fn) —— 没有第二个参数 ✗ → **每次渲染都跑** ✓
    //   而它里面会 docPatch → docNotify → 触发重渲染 → 又跑 ✗ → **死循环** ✓
    //   后果（主人现场）：
    //     · 焦点被反复抢走 → 操作一次后焦点从话布跳到聊天框 ✗
    //     · 连按 Ctrl+Z 不行（第二次的按键已经不在话布上了 ✗）
    //     · 循环里每次都去查本地草稿 → 撤销后又被"恢复草稿"盖回来 ✗
    r.useEffect(function () {
      // ─── 读一篇的状态（canUndo/canRedo/版本/原文/本地草稿）──────────────
      //   抽成函数是为了"映射表载入后重试" ✓（见下面那段注释 ✓）
      var readState = function (id) {
      try {
        fetch('/api/canvas/read?id=' + encodeURIComponent(id) + '&' + ccvSidQ(), { cache: 'no-store' })
          .then(function (x) { return x.json() })
          .then(function (d) {
            setInfo({ id: id, canUndo: !!d.canUndo, canRedo: !!d.canRedo })
            // ⚠️ 同时写进 docStore ✓ —— 快捷键（Ctrl+Z/Y）判断"画布有没有可撤销/可重做的"
            //    读的就是这里 ✗ 只放进组件 state 的话，快捷键永远读到 undefined ✗
            docPatch(absPath, { canUndo: !!d.canUndo, canRedo: !!d.canRedo })
            var ver = (typeof d.version === 'number') ? d.version : 0
            var srv = (typeof d.content === 'string') ? d.content : ''
            // 建立基准：服务端原文 + 版本号（保存时当 knownVer ✓）
            docPatch(absPath, { id: id, ver: ver, saved: srv, md: srv, dirty: false })
            // ── 恢复本地草稿（防丢 ✓ 与面板同一套判据）──────────────────
            // 面板的规矩：草稿的**基准版本对得上**才恢复 ✓ 对不上就不写回、只提示 ✓
            // 另加一道"每篇只试一次"的闸（重挂载时不会再翻旧账 ✗）
            if (draftTried[id]) { log('草稿检查已做过（' + id + '），跳过'); return }
            draftTried[id] = true
            var dft = null
            try { if (window.__ccvKit && window.__ccvKit.draftGet) dft = window.__ccvKit.draftGet(id) } catch (_) {}
            if (dft && typeof dft.content === 'string' && dft.content !== srv) {
              if (typeof dft.base === 'number' && dft.base === ver) {
                log('恢复未保存草稿：' + dft.content.length + ' 字（服务端 ' + srv.length + ' 字）')
                docPatch(absPath, { override: dft.content, md: dft.content, dirty: true })
                toastOn('恢复了未保存的草稿 —— 点保存写回')
              } else {
                log('草稿基准不符（草稿 v' + dft.base + ' / 服务端 v' + ver + '），不自动恢复')
              }
            }
          })
          .catch(function () { setInfo({ id: id, canUndo: false, canRedo: false }) })
      } catch (_) {}
      }
      // ─── 拿到 id 再读；拿不到就等映射表载入后**重试** ────────────────
      //   ★ 2026-10-15 修「这份文件不是话布，保存不了」★
      //   日志证据：路径日志 23:45:55.866 ✓ 而「清单已载入 14 篇」是 23:45:56.028
      //   —— **晚了 162ms** ✗
      //   原来这里 `if (!id) { setInfo({id:''}); return }` 直接返回 ✗
      //   → 之后**再也没人重试** ✗✗ → 保存时 d.id 为空 → 弹「不是话布」✓
      //   （右侧栏之所以"以前好使"，是因为它开得久、映射表早就在缓存里了 ✓
      //     而独立标签页每次都是新挂载 → 必然撞上这个竞态 ✗）
      var id = canvasIdForPath(absPath)
      if (id) { readState(id); return }
      log('挂载时映射表里还没有这篇 → 等它载入后重试 ✓')
      loadCanvasMap(function () {
        var id2 = canvasIdForPath(absPath)
        log('映射表载入后重试：' + (id2 ? '拿到 ' + id2 + ' ✓' : '还是没有 ✗（这篇可能不在清单里）'))
        if (id2) readState(id2)
        else setInfo({ id: '', canUndo: false, canRedo: false })
      })
    }, [absPath])

    // ── 保存 ──────────────────────────────────────────────
    // 自动保存见 afterEdit/saveDoc（打字停手 + 失焦都会存 ✓ 成熟文档软件的做法）。
    // 这个按钮是**立即保存**：不想等那 1.5 秒时点它 ✓ 状态也在它身上显示 ✓
    var doSave = function () { saveDoc(absPath, { manual: true }) }

    var doIt = function (kind) {
      // ★ 查找按钮（2026-10-17 D1）：不走服务端 ✓ 只开浮层 ✓ 不需要话布 id ✓
      //   为什么必须有它：主人试 Ctrl+F 时弹出来的是**浏览器的搜索** ✗
      //   （它连对话一起搜 ✓ 主人现场：文档 4 个 + 对话 4 个 = 8 ✓）
      //   按钮是**永远点得到**的入口 ✓ 不依赖焦点在哪 ✓
      if (kind === 'find') { findShow(absPath); return }
      var id = info.id || canvasIdForPath(absPath)
      var toast = function (m) {
        try { if (window.__ccvKit && window.__ccvKit.toast) window.__ccvKit.toast(m, 'ccv-viewer-undo') } catch (_) {}
      }
      if (!id) { toast('这份文件不是话布，撤销用不了'); return }
      try {
        fetch('/api/canvas/' + kind, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id }),
        }).then(function (x) { return x.json() })
          .then(function (d) {
            log(kind + ' → ' + JSON.stringify(d))
            if (!d || !d.ok) { toast(d && d.error ? ('失败：' + d.error) : '服务端没响应'); return }
            setInfo({ id: id, canUndo: !!d.canUndo, canRedo: !!d.canRedo })
            // ⚠️⚠️ 2026-10-29 主人：「撤销永远深色，重做永远是灰色」
            //   真因：上面这行只写了**组件 state**（info）✗
            //   两个按钮读的却是 **store**（ds = useDocStore）✗
            //   → store 里的 canRedo 从来没被更新 → 重做永远灰 ✓
            //   → 撤销那边因为 dirty 一直为真 → 永远深 ✓
            //   修法：状态**同时写进 store** ✓ 按钮订阅 store → 到点就变 ✓
            docPatch(absPath, { canUndo: !!d.canUndo, canRedo: !!d.canRedo })
            // ★ 当场显示结果，**不等文件监听**（2026-10-11 修"撤销有延迟"）：
            //   host 那边已经改成立刻落盘 ✓，但"文件变了 → 查看器重读"这一段仍有延迟 ✗
            //   而响应里本来就带 content ✓ → 直接拿它渲染 ✓ 手感就是即时的 ✓
            //   override 会在 props.content 追上来之后自动丢掉（见 BodyInner 的 effect ✓）
            if (typeof d.content === 'string') {
              docPatch(absPath, { override: d.content, saved: d.content, md: d.content, dirty: false })
            }
          })
          .catch(function (e) { toast('失败：' + (e && e.message)); })
      } catch (e) { toast('失败：' + (e && e.message)); }
    }

    // ── 图标按钮的样式（一次性注入）──────────────────────────
    // 只用主题 token ✓（技能要求；token 名字是查 Theme.listTokens 拿的，不是猜的 ✓）
    //   --dsw-alias-label-secondary     常态
    //   --dsw-alias-label-primary       悬停
    //   --dsw-alias-bg-layer-2          悬停底色（没有 bg-hover 这个 token ✗）
    //   --dsw-alias-state-idle-primary  **没得撤销时的颜色**（它的用途就是"inactive"✓）
    // 不 import Harness 客户端包 ✓（技能明确禁止）→ 图标是自带的内联 SVG ✓
    function ensureActionsCss() {
      try {
        if (document.getElementById('ccv-viewer-actions-style')) return
        var el = document.createElement('style')
        el.id = 'ccv-viewer-actions-style'
        el.textContent =
          '.ccv-vtool{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;'
          + 'padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;'
          + 'color:var(--dsw-alias-label-secondary,#666);transition:background .12s,color .12s}'
          + '.ccv-vtool:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14));'
          + 'color:var(--dsw-alias-label-primary,#1a1a1a)}'
          + '.ccv-vtool[data-off="1"]{color:var(--dsw-alias-state-idle-primary,rgba(128,128,128,.55))}'
          + '.ccv-vtool:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);outline-offset:1px}'
          // 正在写盘：用品牌色 + 半透明（"保存中…"要看得出来 ✓ 成熟软件都会显示状态）
          + '.ccv-vtool[data-saving="1"]{color:var(--dsw-alias-brand-primary,#4c8dff);opacity:.7}'
          // ── 挪位置：放到「话布」两个字**左边**（2026-10-11 主人指定）──────
          // 那个槽按设计是渲染在内置控件**之后** ✗（"rendered after the preview's own
          // controls"），所以只能用 CSS 的 order 挪。查过宿主 CSS：
          //   .dhJKeW_header{ align-items:center; gap:4px; height:38px; display:flex }
          // → 是 flex ✓ order 生效 ✓
          // 两级 order 才能精确插到"路径标签"和"话布"之间：
          //   路径标签 -2  →  我们 -1  →  其余（话布、⟳ ⤢ ↗ ⛶）默认 0
          // :has() 那一条是防"槽宿主还套了一层"—— 套了就连宿主一起提前 ✓
          // （order 在非 flex 容器里是空操作 ✓ 所以套错地方也不会坏 ✗）
          + '[data-ccv-viewer-actions]{order:-1}'
          + '*:has(>[data-ccv-viewer-actions]){order:-1}'
          + '[data-textpreview-path]{order:-2}'
        document.head.appendChild(el)
      } catch (_) {}
    }

    // 内联 SVG 图标（自带 ✓ 不依赖任何图标库 ✓）—— 弧形箭头，与内置图标同一视觉重量
    function svgIcon(d) {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      }, h('path', { d: d }))
    }
    var ICON_UNDO = 'M3.2 7.6h6.3a3.1 3.1 0 0 1 0 6.2H7.4 M6 4.4 3 7.6l3 3.2'
    var ICON_REDO = 'M12.8 7.6H6.5a3.1 3.1 0 0 0 0 6.2h2.1 M10 4.4l3 3.2-3 3.2'
    // 保存：下箭头进托盘（和内置图标的重量一致 ✓ 自带 SVG 不依赖图标库 ✓）
    var ICON_SAVE = 'M8 2.4v7.2 M4.9 6.6 8 9.7l3.1-3.1 M2.9 11.2v1.4a1 1 0 0 0 1 1h8.2a1 1 0 0 0 1-1v-1.4'
    // 查找：放大镜 ✓（2026-10-17 D1）
    var ICON_FIND = 'M7.2 2.6a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2Z M10.6 10.6l3 3'

    function toolBtn(kind, icon, on, title) {
      return h('button', {
        type: 'button', className: 'ccv-vtool', title: title,
        'data-ccv-viewer-action': kind, 'data-off': on ? '0' : '1',
        'aria-label': title,
        onClick: function () { doIt(kind) },
      }, svgIcon(icon))
    }

    return h('span', {
      'data-ccv-viewer-actions': '1',
      style: { display: 'inline-flex', gap: '2px', alignItems: 'center' },
      ref: function () { ensureActionsCss() },
    },
      // ⚠️ 撤销/重做的可用状态读 **store**（ds）而不是组件 state（info）✗
      //   2026-10-15 主人报「撤销有用，但是撤销键不变」：
      //   快捷键撤销走的是 docPatch（写 store ✓）而按钮读的是 info（组件 state ✗）
      //   → 按钮永远停在挂载时那一次的值 ✗
      //   ⚠️ 2026-10-29 主人澄清：「我说的不能重做是说重做到头了，已经不能继续重做，
      //      这时候就应该变灰，撤回同理」
      //   → 要的是**准确的禁用态** ✗ 不是永远深色 ✓
      //   状态来源（服务端每次 read / write / undo / redo 的响应都带 canUndo/canRedo）：
      //     撤销：canUndo（服务端历史栈还有）或 dirty（刚改过、还能撤掉这次改动）
      //     重做：canRedo（只有撤销过才有）
      //   两者都通过 docPatch 写进 store ✓ 按钮订阅 store → 到点就灰 ✓
      toolBtn('undo', ICON_UNDO, !!(ds && (ds.canUndo || ds.dirty)), '撤销上一步（含 AI 改的）· Ctrl+Z'),
      //   重做：只有 canRedo 为真才深色 ✓（重做到头 → 服务端回 canRedo:false → 立刻灰 ✓）
      toolBtn('redo', ICON_REDO, !!(ds && ds.canRedo), '重做 · Ctrl+Y 或 Ctrl+Shift+Z'),
      // ★ 查找（2026-10-17 D1）★
      //   为什么必须有这个按钮：主人试 Ctrl+F 时**弹出来的是浏览器的搜索** ✗
      //   —— 因为我的 Ctrl+F 只挂在编辑区的 keydown 上 ✓
      //      焦点不在编辑区里就不响应 ✓ 浏览器就接管了 ✓
      //   → 按钮是**永远点得到**的入口 ✓（不依赖焦点 ✓）
      //   另外说清楚：我们自己的查找**只搜这篇话布** ✓
      //     不像浏览器那个会连对话一起搜 ✓（主人现场：文档 4 个 + 对话 4 个 = 8 ✓）
      toolBtn('find', ICON_FIND, true, '查找 / 替换（只搜这篇话布，不会搜到对话）· Ctrl+F'),
      // ★ 目录（2026-10-24 主人要求「左目录 + 右正文」）★
      //   按标题扫出来 ✓ 只读 ✓ 点一条跳过去 ✓
      //   ⚠️ 状态放模块级 navOpen：宿主每次保存都重建组件 ✗ 组件 state 一保存就关 ✓
      //   ⚠️ 2026-10-28 主人：「目录按键应该一直深色」
      //      它不像撤销/重做那样有"可用/不可用"✗ 目录**永远能用** ✓
      //      所以 data-off 固定 '0'（深色）✗ 不再跟着 navOpen 变 ✓
      h('button', {
        type: 'button',
        className: 'ccv-vtool',
        title: '目录（按标题快速跳转 · 只读，不改正文）',
        'data-ccv-viewer-action': 'toc',
        'data-off': '0',
        'aria-label': '目录',
        onClick: function () { try { navToggle() } catch (e) { log('目录切换失败: ' + (e && e.message)) } },
      }, h('span', { style: { fontSize: '13px', lineHeight: 1 } }, '☰')),
      // 保存放最后（离"话布"最近 ✓ 三个按钮一组）
      // 状态显示在它身上（成熟软件都让保存状态可见 ✓）：
      //   有改动 → 亮 ✓  没改动 → idle 灰 ✓  正在写 → title 说"保存中…" ✓
      h('button', {
        type: 'button', className: 'ccv-vtool',
        title: (ds && ds.saving) ? '保存中…' : (dirty ? '立即保存（有未保存的改动；停手 1.5 秒也会自动存）' : '已保存（当前没有改动）'),
        'data-ccv-viewer-action': 'save', 'data-off': dirty ? '0' : '1',
        'data-saving': (ds && ds.saving) ? '1' : '0',
        'aria-label': (ds && ds.saving) ? '保存中' : '保存',
        onClick: function () { doSave() },
      }, svgIcon(ICON_SAVE)))
  }

  // ─── 样式：跟话布面板共用同一份 markdown 规则 ────────────────
  // 2026-10-04 主人拿两张截图问"为什么两边显示不一样"：
  //   两处用的是**同一个 mdToHtml**（都从 __ccvKit 取），差别只在**样式** ——
  //   面板的规则作用域是 `.ccv-panel .ccv-editor`，查看器这边没有 → 同一份 <table>
  //   有边框就是表格，没边框就看起来像纯文本（引用块的左边线同理）。
  //   做法：主模块把那份 CSS 文本借出来（mdCssFor 换掉作用域前缀），这里注入一次。
  //   一份规则两处用，不复制、不会漂移。
  function ensureViewerCss() {
    try {
      if (document.getElementById('ccv-viewer-md-style')) return
      var css = ''
      // ⚠️ 作用域写成**重复两遍的属性选择器**（[data-ccv-md-body][data-ccv-md-body]）：
      //    这样每一条规则的特异度都抬高一档，应用自带样式（各种 .xxx p{margin:1em}）
      //    压不过它。2026-10-04 主人报"表格没框、段落空隙大"—— 症状与"这份样式没生效"
      //    完全一致（默认 p 边距 1em、表格无边框），所以先把特异度钉死，排除被覆盖这条路。
      //    排版参数本身与面板一致（fontSize 14 / lineHeight 1.75，见 CCV_STYLE.editorWide）。
      if (window.__ccvKit && typeof window.__ccvKit.mdCssFor === 'function') {
        css = window.__ccvKit.mdCssFor('[data-ccv-md-body][data-ccv-md-body]')
      }
      if (!css) { log('没拿到 markdown 样式（面板的规则还没就绪？），正文会是素样式'); return }
      var el = document.createElement('style')
      el.id = 'ccv-viewer-md-style'
      el.textContent = css
      document.head.appendChild(el)
      log('已注入查看器 markdown 样式（' + css.length + ' 字节，特异度已抬高）')
    } catch (e) { log('注入样式失败: ' + (e && e.message)) }
  }

  // ─── 话布清单：文件路径 → 话布 id/标题 ──────────────────────
  // 为什么要它：选区引用（selref 的 capture）要求 doc.id **非空**，否则整笔不记；
  // 而查看器手里只有文件路径（resourceAddress → absolutePath），得换回话布 id。
  var canvasMap = null
  var canvasMapAt = 0
  function normPath(p) { return String(p || '').replace(/\\/g, '/').toLowerCase() }
  function baseName(p) { var s = String(p || '').replace(/\\/g, '/'); return s.slice(s.lastIndexOf('/') + 1) }

  function loadCanvasMap(cb) {
    if (canvasMap && Date.now() - canvasMapAt < 60000) { if (cb) cb(); return }
    try {
      fetch('/api/canvas/list?scope=all', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (d) {
          var m = {}
          var list = (d && d.canvases) || []
          for (var i = 0; i < list.length; i++) {
            var c = list[i]
            if (c && c.path) m[normPath(c.path)] = { id: c.id, title: c.title, version: c.version }
          }
          canvasMap = m
          canvasMapAt = Date.now()
          log('清单已载入 ' + Object.keys(m).length + ' 篇（划词问AI 靠它认话布）')
          if (cb) cb()
        })
        .catch(function (e) { log('清单载入失败: ' + (e && e.message)) })
    } catch (e) { log('清单载入异常: ' + (e && e.message)) }
  }

  // ─── 输入桥：把官方 inputActions / 会话 id / 取数桥挂到全局 ──
  // 与主模块的 InputBridge 用**同一套全局量** —— lib/selref.js 就是认这些的。
  //   sessions.scope(sessionId) → 会话作用域 → inputTriggers.sessionOf(它) → 输入管线控制器
  //
  // ★ ccvSidQ —— 请求里带的会话查询串（2026-10-24 修）★
  //   事故（主人现场）：「打开的文档都跑到旧记录.default 里去了，打开一个进去一个」
  //   根因：查看器这两处 `/api/canvas/read?id=…` **根本没带 sid** ✗
  //     → 主机端 `sessSafe(url.searchParams.get('sid'))` 拿到 null → 退成 'default' ✗
  //     → 每打开一篇就登记到 default 组 ✓（而且和 12 篇老文档混在一起 ✓）
  //   现在：优先用**真 sessionId**（publishInput 早就写进 window.__ccvSessionId ✓
  //         它是 props.sessionId，打开文档那一刻就有 ✓ 比 2 秒轮询的 __ccvSid 更及时 ✓
  //         ），拿不到再退回 __ccvSid ✓，最后才 'default' ✓
  function ccvSidQ() {
    try {
      var real = window.__ccvSessionId
      if (real && typeof real === 'string' && /^session-/.test(real)) {
        return 'sid=' + encodeURIComponent(real)
      }
      var k = window.__ccvSid
      if (k) return 'sid=' + encodeURIComponent(k)
    } catch (_) {}
    return 'sid=default'
  }

  function publishInput(props, absPath, inputState) {
    try { if (absPath) lastAbsPath = absPath } catch (_) {}
    try { if (props.inputActions) window.__ccvInputActions = props.inputActions } catch (_) {}
    try { if (props.sessionId) window.__ccvSessionId = props.sessionId } catch (_) {}
    try { if (inputState) window.__ccvInputState = inputState } catch (_) {}
    // 取数桥：capture 从这里取三样 —— doc / editor / range
    try {
      window.__ccvSelRefBridge = {
        doc: function () {
          var hit = canvasMap ? canvasMap[normPath(absPath)] : null
          return {
            id: hit ? hit.id : '',          // ⚠️ 空 id 会让 capture 整笔不记（宁可没序数，也不要错序数）
            title: hit ? hit.title : baseName(absPath),
            mention: '@"' + String(absPath || '').replace(/\\/g, '/') + '"',
            version: hit ? hit.version : 0
          }
        },
        editor: function () { return document.querySelector('[data-ccv-md-body="1"]') },
        range: function () { return savedRange }
      }
    } catch (_) {}
  }

  // ─── 划词栏（2026-10-15：把老画布面板那套搬过来）──────────────────
  // 原来这里只有一个「问AI」按钮 ✗，而老面板有一套完整的 markdown 划词栏
  // （图标库 CCV_ICONS / SELBAR_ITEMS / runCanvasCmd）—— 2026-10-11 随面板删了 ✗。
  // 主人要求"把老画布的功能移过来" ✓ 分阶段搬；**这是阶段 1**：
  //   问AI + 加粗 / 斜体 / 删除线 / 下划线 / 高亮 / 行内代码 / 清除格式 / 链接
  // 后面阶段：块（代码块/引用/表格/任务列表/高亮块/缩进）→ 上传（图片/文件）→
  //           右键菜单 + 三个下拉 → Ctrl+Z/Y 接管
  //
  // 从 git 里取的原件：git show 0a7cc65^:src/client/editor-panel.js
  //   ⚠️ 取的时候要用 execFileSync + 参数数组 —— node 的 execSync 走 cmd.exe，
  //      而 **cmd 里 `^` 是转义符** ✗ 会把 "0a7cc65^:" 吃成 "0a7cc65:" ✗
  var CCV_ICONS = {
    ask: '<path d="M4 5h16v11H10l-6 4z"/>',
    highlight: '<path d="M12 4.5a4.5 4.5 0 0 0-2.6 8.2c.6.4 1.1 1.2 1.1 2v.8h3v-.8c0-.8.5-1.6 1.1-2A4.5 4.5 0 0 0 12 4.5z"/><path d="M9.5 19h5M10.5 21.5h3"/><path d="M12 1.5v2M5.6 3.6L7 5M18.4 3.6L17 5M3 9h2M21.5 9h-2"/>',
    clear: '<path d="M16 4l4 4-9 9H7l-3-3L16 4z"/><path d="M5 21h14"/><path d="M11 9l4 4"/>',
    link: '<path d="M9.5 14.5a4 4 0 0 0 5.7 0l3.2-3.2a4 4 0 1 0-5.7-5.7l-1.6 1.6"/><path d="M14.5 9.5a4 4 0 0 0-5.7 0l-3.2 3.2a4 4 0 1 0 5.7 5.7l1.6-1.6"/>',
    code: '<path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5"/>',
    codeBlock: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9.5 10L7 12.5 9.5 15M14.5 10l2.5 2.5-2.5 2.5"/>',
    quote: '<path d="M10 6H5.5v5H9c0 2.5-1.2 3.8-3.5 4M18.5 6H14v5h3.5c0 2.5-1.2 3.8-3.5 4"/>',
    hr: '<path d="M4 12h16"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18M9.5 9.5V20M15.5 9.5V20"/>',
    task: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12.5l2.5 2.5 5-5.5"/>',
    listUl: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>',
    listOl: '<path d="M10 6h10M10 12h10M10 18h10"/><text x="2.5" y="8.5" font-size="7.5" stroke="none" fill="currentColor">1</text><text x="2.5" y="14.5" font-size="7.5" stroke="none" fill="currentColor">2</text><text x="2.5" y="20.5" font-size="7.5" stroke="none" fill="currentColor">3</text>',
    uploadImage: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 16v-5M9.5 13.5L12 11l2.5 2.5"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c3.2 2.7 3.2 14.3 0 17-3.2-2.7-3.2-14.3 0-17z"/>',
    file: '<path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3z"/><path d="M13.5 3v5.5H19"/>',
    hlBlock: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 12h10" stroke-width="2.4"/>',
    indent: '<path d="M4 5h16M10 10h10M10 14h10M4 19h16M7 9.5L4.5 12 7 14.5"/>',
    outdent: '<path d="M4 5h16M10 10h10M10 14h10M4 19h16M4.5 9.5L7 12l-2.5 2.5"/>'
  }
  function ccvIcon(name, size) {
    var body = CCV_ICONS[name]
    if (!body) return ''
    var s = size || 15
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor"'
      + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="display:block">' + body + '</svg>'
  }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  // 从**当前选区**取文字（跑命令前会先 restoreSelection ✓）
  function selectionText() {
    var sel = document.getSelection()
    return sel ? sel.toString() : ''
  }
  function currentRange() {
    var s = document.getSelection()
    return (s && s.rangeCount) ? s.getRangeAt(0).cloneRange() : null
  }
  // 弹层该出现在哪（有选区就贴选区 ✓ 没有就用屏幕中间偏上 ✓）
  function tableAnchor() {
    try {
      var rng = currentRange()
      if (rng) {
        var r = rng.getBoundingClientRect()
        if (r && (r.width || r.height)) return { left: r.left, top: r.top, bottom: r.bottom }
      }
    } catch (_) {}
    return { left: Math.max(40, window.innerWidth / 2 - 100), top: window.innerHeight / 2 - 60, bottom: window.innerHeight / 2 - 40 }
  }
  // 上传相关（阶段 3 搬过来的）：上传走 host 的 /api/canvas/upload ✓
  function assetDisplayUrl(p) {
    if (/^attachments\//.test(p)) return '/api/canvas/file?name=' + encodeURIComponent(p)
    return p
  }
  function uploadCanvasFile(file, onOk, onFail) {
    try {
      fetch('/api/canvas/upload?name=' + encodeURIComponent(file.name || 'file.bin'), {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file
      }).then(function (r) { return r.json() }).then(function (d) {
        if (d && d.ok && d.path) onOk(d.path, file.name || '图片')
        else onFail(file)
      }).catch(function () { onFail(file) })
    } catch (e) { onFail(file) }
  }
  // 上传失败兜底：图片转 dataURL 内嵌（md 会变大，仅作 fallback ✓）
  function fileToDataUrl(file, cb) {
    try {
      var fr = new FileReader()
      fr.onload = function () { cb(String(fr.result)) }
      fr.onerror = function () { cb('') }
      fr.readAsDataURL(file)
    } catch (_) { cb('') }
  }
  // 打开系统文件选择框（菜单点击是用户手势 → input.click() 能弹出 ✓）
  function pickFile(accept, cb) {
    var inp = document.createElement('input')
    inp.type = 'file'
    if (accept) inp.accept = accept
    inp.style.display = 'none'
    document.body.appendChild(inp)
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0]
      if (f) cb(f)
      inp.remove()
    })
    inp.click()
  }
  // 异步上传完成后在原光标处插 HTML：先聚焦编辑器、找回范围再 insertHTML ✓
  function insertHtmlAtRange(html, rng) {
    var ed = editorEl()
    if (!ed) return
    try { ed.focus() } catch (_) {}
    if (rng) {
      try { var s = document.getSelection(); s.removeAllRanges(); s.addRange(rng) } catch (_) {}
    }
    document.execCommand('insertHTML', false, html)
  }
  function insertTableHtml(rows, cols) {
    // ⚠️ 2026-10-29 主人（截图）：插入的表格**行高不一致** ✗
    //   原因：表头是 <th>表头</th>（有文字 → 占一行高）✓
    //         而正文是 <td></td>（完全空 → 在 contentEditable 里高度塌成 0 ✗）
    //   → 表头一行很高、正文行挤成一条线 ✓ 光标所在的空单元格又会被撑高 ✓
    //   修法：空的正文单元格里放一个 <br> ✓ 这样每行都是"一行文字"的高度 ✓
    //        （Word / Google Docs 插表格时也是这么做的 ✓）
    var html = '<table>'
    for (var r = 0; r < rows; r++) {
      html += '<tr>'
      for (var c = 0; c < cols; c++) html += (r === 0 ? '<th>表头</th>' : '<td><br></td>')
      html += '</tr>'
    }
    html += '</table><div><br></div>'
    document.execCommand('insertHTML', false, html)
  }

  // ─── 插入表格：网格选择器（成熟产品都这么做 ✓ 2026-10-15）──────────
  //   老面板用的是 window.prompt("3×4") ✗ —— 看不见样子、也只能填行列 ✗
  //   Word / Google Docs / 飞书 / Notion 全都是：**悬停格子 → 实时显示"3×4" → 点一下插入** ✓
  //   保留「自定义…」兜底（行列数很大时用 ✓）
  function showTablePicker(anchorRect) {
    var MAXR = 10, MAXC = 8
    log('插入表格：打开网格选择器')
    closeDropdowns()
    saveSelection()
    var dd = document.createElement('div')
    dd.setAttribute('data-ccv-tablepick', '1')
    dd.style.cssText = 'position:fixed;z-index:2147483002;background:var(--dsw-alias-bg-layer-1,#fff);'
      + 'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));border-radius:8px;'
      + 'box-shadow:0 6px 20px rgba(0,0,0,.18);padding:10px;font-size:13px;'
      + 'color:var(--dsw-alias-label-primary,#1a1a1a);user-select:none;-webkit-user-select:none'
    var title = document.createElement('div')
    title.textContent = '插入表格'
    title.style.cssText = 'font-size:11px;color:rgba(128,128,128,.85);margin-bottom:7px'
    dd.appendChild(title)
    var label = document.createElement('div')
    label.textContent = '拖到想要的格数'
    label.style.cssText = 'font-size:11px;color:rgba(128,128,128,.85);margin-bottom:6px'
    var grid = document.createElement('div')
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(' + MAXC + ',18px);gap:2px'
    var cells = []
    function paint(r, c) {
      for (var i = 0; i < cells.length; i++) {
        var on = cells[i].r <= r && cells[i].c <= c
        cells[i].el.style.background = on ? 'var(--dsw-alias-brand-primary,#4c8dff)' : 'rgba(128,128,128,.14)'
        cells[i].el.style.opacity = on ? '0.85' : '1'
      }
      label.textContent = (r && c) ? (r + ' 行 × ' + c + ' 列') : '拖到想要的格数'
    }
    for (var r = 1; r <= MAXR; r++) {
      for (var c = 1; c <= MAXC; c++) {
        var el = document.createElement('div')
        el.style.cssText = 'width:18px;height:18px;border-radius:3px;cursor:pointer;background:rgba(128,128,128,.14)'
        ;(function (rr, cc, node) {
          node.addEventListener('mouseenter', function () { paint(rr, cc) })
          node.addEventListener('click', function (e) {
            e.stopPropagation()
            closeDropdowns()
            restoreSelection()
            insertTableHtml(rr, cc)
            var ed = editorEl()
            if (ed) { try { ed.focus() } catch (_) {} }
            log('插入表格：' + rr + ' 行 × ' + cc + ' 列')
          })
        })(r, c, el)
        cells.push({ r: r, c: c, el: el })
        grid.appendChild(el)
      }
    }
    dd.appendChild(grid)
    var custom = document.createElement('div')
    custom.textContent = '自定义行列数…'
    custom.style.cssText = 'margin-top:8px;padding:5px 6px;border-radius:5px;cursor:pointer;font-size:12px;color:rgba(128,128,128,.95)'
    custom.addEventListener('mouseenter', function () { custom.style.background = 'rgba(128,128,128,.12)' })
    custom.addEventListener('mouseleave', function () { custom.style.background = 'transparent' })
    custom.addEventListener('click', function (e) {
      e.stopPropagation()
      closeDropdowns()
      var rc = window.prompt('表格行数×列数（如 3×4）：', '3×3')
      if (!rc) return
      var mm = rc.match(/(\d+)\s*[×xX*]\s*(\d+)/)
      if (!mm) { window.alert('格式不对，示例：3×4'); return }
      restoreSelection()
      insertTableHtml(Math.max(1, Math.min(50, +mm[1])), Math.max(1, Math.min(20, +mm[2])))
      var ed2 = editorEl()
      if (ed2) { try { ed2.focus() } catch (_) {} }
    })
    dd.appendChild(custom)
    // 按下时别让浏览器把焦点/选区弄塌（否则 execCommand 什么都不做 ✗）—— 与划词栏同款 ✓
    dd.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation() })
    document.body.appendChild(dd)
    openDropdown = dd
    // 定位：优先贴选区下方 ✓ 放不下就往上翻 ✓
    var rect = anchorRect || { left: 200, bottom: 200, top: 180 }
    var w = dd.offsetWidth, h = dd.offsetHeight
    var x = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8))
    var y = rect.bottom + 8
    if (y + h > window.innerHeight - 8) y = Math.max(8, (rect.top || 180) - h - 8)
    dd.style.left = x + 'px'
    dd.style.top = y + 'px'
    setTimeout(function () {
      document.addEventListener('mousedown', function close(ev) {
        if (!dd.contains(ev.target)) { closeDropdowns(); savedRange = null; document.removeEventListener('mousedown', close) }
      })
    }, 0)
  }
  // ★ 选区保存/恢复 —— 老面板的规矩：**点按钮前必须先恢复选区** ✓
  //   点划词栏/下拉菜单时编辑器已失焦、选区已塌 ✗ 不恢复的话"加粗"根本加不上 ✗
  function saveSelection() {
    try { savedRange = currentRange() } catch (_) {}
  }
  function restoreSelection() {
    if (!savedRange) return
    var sel = document.getSelection()
    if (sel) { try { sel.removeAllRanges(); sel.addRange(savedRange) } catch (_) {} }
  }
  // 老面板的模块级格式状态（下拉菜单要读它 ✓ 比如"当前是几级标题"）
  var selectionFormats = { bold: false, italic: false, underline: false, heading: null }
  function updateSelFormats(sel) {
    try {
      selectionFormats.bold = document.queryCommandState('bold')
      selectionFormats.italic = document.queryCommandState('italic')
      selectionFormats.underline = document.queryCommandState('underline')
      selectionFormats.strikeThrough = document.queryCommandState('strikeThrough')
    } catch (_) {}
    selectionFormats.heading = null
    selectionFormats.mark = false
    try {
      var node = sel.getRangeAt(0).startContainer
      if (node.nodeType === 3) node = node.parentNode
      while (node && node.nodeType === 1) {
        var tag = node.tagName ? node.tagName.toLowerCase() : ''
        if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].indexOf(tag) >= 0) { selectionFormats.heading = tag; break }
        if (tag === 'mark') { selectionFormats.mark = true }
        if (node.getAttribute && node.getAttribute('data-ccv-md-body')) break
        node = node.parentNode
      }
    } catch (_) {}
    return selectionFormats
  }
  // 划词栏的内容（老面板 SELBAR_ITEMS 原样搬 ✓ 阶段 1~4 全在）
  var SELBAR_ITEMS = [
    { label: ccvIcon('ask') + '<span style="margin-left:5px">问AI</span>', title: '将选中文本发送给 AI 问答', isAskAI: true },
    { type: 'sep' },
    { label: 'H', cmd: 'formatBlock', val: '<h2>', title: '标题', isHeading: true, hasDropdown: true },
    { type: 'sep' },
    { label: '≡', title: '对齐', hasDropdown: true, showAlign: true },
    { type: 'sep' },
    { label: '<b>B</b>', cmd: 'bold', title: '粗体（Ctrl+B）' },
    { label: '<i>I</i>', cmd: 'italic', title: '斜体（Ctrl+I）' },
    { label: '<s>S</s>', cmd: 'strikeThrough', title: '删除线' },
    { label: '<span style="text-decoration:underline">U</span>', cmd: 'underline', title: '下划线' },
    { label: ccvIcon('highlight'), cmd: 'highlight', title: '高亮' },
    { label: ccvIcon('clear'), cmd: 'clearFormat', title: '清除格式' },
    { type: 'sep' },
    { label: '⋮', title: '更多功能', hasDropdown: true, showFullMenu: true }
  ]
  // 老面板的自定义命令（阶段 1~3 全搬 ✓ 其余的 default 交给 execCommand ✓）
  function runCanvasCmd(cmd) {
    // ★★ 先聚焦编辑区，再恢复选区（顺序不能反 ✗）★★
    //   execCommand('insertHTML'/'bold'…) **要求编辑区处于聚焦状态** ✗
    //   点浮层（下拉菜单 / 网格选择器都是普通 div ✓）会把焦点弄到 body ✓
    //   → 命令**静默失败**（不报错、什么都不发生 ✗✗）
    //   focus() 会先把选区弄塌 ✗ 所以必须在 focus **之后**再 restoreSelection ✓
    //   （2026-10-15 主人报"表格插入失败"，根因就是这条 ✗）
    var ed0 = editorEl()
    if (ed0) { try { ed0.focus() } catch (_) {} }
    restoreSelection()
    var text
    switch (cmd) {
      case 'highlight': {
        text = selectionText()
        if (!text) return true
        document.execCommand('insertHTML', false, '<mark>' + escHtml(text) + '</mark>')
        break
      }
      case 'inlineCode': {
        text = selectionText() || 'code'
        document.execCommand('insertHTML', false, '<code>' + escHtml(text) + '</code>')
        break
      }
      case 'clearFormat': {
        document.execCommand('removeFormat', false, null)
        // removeFormat 管不到自定义的 <mark> 和 <a>：选区内的手动拆掉。
        // 脚注引用 [1]（href="#fn-…"）是内容标记不是格式，保留 ✓
        try {
          var ed3 = editorEl()
          var s3 = document.getSelection()
          if (ed3 && s3 && s3.rangeCount) {
            var rg = s3.getRangeAt(0)
            var marks = ed3.querySelectorAll('mark')
            for (var mi = marks.length - 1; mi >= 0; mi--) {
              if (rg.intersectsNode(marks[mi])) {
                var pMark = marks[mi].parentNode
                while (marks[mi].firstChild) pMark.insertBefore(marks[mi].firstChild, marks[mi])
                pMark.removeChild(marks[mi])
              }
            }
            var links = ed3.querySelectorAll('a')
            for (var ai = links.length - 1; ai >= 0; ai--) {
              var lh = links[ai].getAttribute('href') || ''
              if (lh.indexOf('#fn') === 0) continue
              if (rg.intersectsNode(links[ai])) {
                var pA = links[ai].parentNode
                while (links[ai].firstChild) pA.insertBefore(links[ai].firstChild, links[ai])
                pA.removeChild(links[ai])
              }
            }
          }
        } catch (_) {}
        break
      }
      case 'codeBlock': {
        text = selectionText() || 'code'
        document.execCommand('insertHTML', false, '<pre><code>' + escHtml(text) + '</code></pre><div><br></div>')
        break
      }
      case 'blockquote': {
        text = selectionText() || '引用内容'
        document.execCommand('insertHTML', false, '<blockquote><p>' + escHtml(text) + '</p></blockquote><div><br></div>')
        break
      }
      case 'link': {
        var url = window.prompt('请输入链接地址：', 'https://')
        if (url) {
          text = selectionText().trim() || '链接文字'
          document.execCommand('insertHTML', false, '<a href="' + escHtml(url) + '">' + escHtml(text) + '</a>')
        }
        break
      }
      case 'footnote': {
        // 脚注：自动生成编号，插入引用标记，并在文末添加定义 ✓（老面板原样）
        var label = window.prompt('脚注标签（如 1、2、a）：', '')
        if (label) {
          var fnHtml = '<a href="#fn-' + escHtml(label) + '" id="fnref-' + escHtml(label) + '" contenteditable="false" style="vertical-align:super;font-size:.75em">[' + escHtml(label) + ']</a>'
          document.execCommand('insertHTML', false, fnHtml)
          var ed = editorEl()
          if (ed) {
            var existing = ed.querySelector('#fn-' + label)
            if (!existing) {
              var fnDiv = ed.querySelector('.footnotes')
              if (!fnDiv) {
                fnDiv = document.createElement('div')
                fnDiv.className = 'footnotes'
                fnDiv.innerHTML = '<hr/>'
                fnDiv.appendChild(document.createElement('ol'))
                ed.appendChild(fnDiv)
              }
              var ol2 = fnDiv.querySelector('ol')
              var li = document.createElement('li')
              li.id = 'fn-' + label
              li.innerHTML = '脚注 ' + escHtml(label) + ' 的内容 <a href="#fnref-' + escHtml(label) + '" contenteditable="false">↩</a>'
              ol2.appendChild(li)
              try { li.scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch (_) {}
            }
          }
        }
        break
      }
      case 'uploadImage': {
        var rngImg = currentRange()
        pickFile('image/*', function (f) {
          uploadCanvasFile(f, function (p, name) {
            insertHtmlAtRange('<img src="' + escHtml(assetDisplayUrl(p)) + '" alt="' + escHtml(name) + '" style="max-width:100%;height:auto;vertical-align:middle"/>', rngImg)
          }, function (f2) {
            fileToDataUrl(f2, function (u) {
              if (u) insertHtmlAtRange('<img src="' + u + '" alt="" style="max-width:100%;height:auto;vertical-align:middle"/>', rngImg)
              else window.alert('图片上传失败')
            })
          })
        })
        break
      }
      case 'imageUrl': {
        var iurl = window.prompt('请输入图片地址：', 'https://')
        if (iurl) document.execCommand('insertHTML', false, '<img src="' + escHtml(iurl) + '" alt="" style="max-width:100%;height:auto;vertical-align:middle"/>')
        break
      }
      case 'uploadFile': {
        var rngFile = currentRange()
        pickFile('', function (f) {
          uploadCanvasFile(f, function (p, name) {
            insertHtmlAtRange('<a href="' + escHtml(assetDisplayUrl(p)) + '">' + escHtml(name) + '</a>', rngFile)
          }, function () { window.alert('文件上传失败') })
        })
        break
      }
      case 'insertTable': {
        // 成熟产品的做法：网格选择器 ✓（原来那个 prompt 是权宜 ✗ 已挪到选择器的"自定义…"里）
        showTablePicker(tableAnchor())
        break
      }
      case 'insertTaskList': {
        document.execCommand('insertHTML', false, '<ul><li><input type="checkbox"> 任务事项</li></ul><div><br></div>')
        break
      }
      case 'highlightBlock': {
        text = selectionText()
        var inner = text ? escHtml(text) : '高亮内容'
        document.execCommand('insertHTML', false, '<div class="ccv-hl"><p>' + inner + '</p></div><div><br></div>')
        break
      }
      case 'indent': document.execCommand('indent', false, null); break
      case 'outdent': document.execCommand('outdent', false, null); break
      default: return false
    }
    var ed4 = editorEl()
    if (ed4) { try { ed4.focus() } catch (_) {} }
    return true
  }
  // ─── 下拉菜单（阶段 4 搬过来的：openDropdownAt 原样 ✓）──────────────
  var openDropdown = null
  function closeDropdowns() {
    if (openDropdown && openDropdown.parentNode) openDropdown.parentNode.removeChild(openDropdown)
    openDropdown = null
  }
  // 老面板的 showDropdown(anchor, items, cb) —— 贴按钮下方弹出 ✓
  function showDropdown(anchor, items, onSelect) {
    var r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 40, bottom: 40 }
    openDropdownAt(r.left, r.bottom + 6, items, onSelect)
  }
  function openDropdownAt(left, top, items, onSelect) {
    closeDropdowns()
    saveSelection()
    var dd = document.createElement('div')
    dd.setAttribute('data-ccv-dropdown', '1')
    // 不透明底 ✓（老面板这里用的就是 bg-overlay，但主人要求划词栏不透明 —— 菜单同规矩 ✓）
    dd.style.cssText = 'position:fixed;z-index:2147483001;background:var(--dsw-alias-bg-layer-1,#fff);'
      + 'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));border-radius:8px;'
      + 'box-shadow:0 6px 20px rgba(0,0,0,.18);padding:4px 0;min-width:160px;max-width:320px;'
      + 'font-size:13px;color:var(--dsw-alias-label-primary,#1a1a1a);max-height:72vh;overflow-y:auto'
    function iconSpan(icon) {
      var ic = document.createElement('span')
      if (icon.indexOf('<svg') === 0) ic.innerHTML = icon
      else ic.textContent = icon
      ic.style.cssText = 'width:18px;display:flex;justify-content:center;flex:0 0 auto'
      return ic
    }
    function addRow(item) {
      var row = document.createElement('div')
      row.style.cssText = 'padding:7px 14px;cursor:pointer;display:flex;align-items:center;gap:9px;transition:background .1s;white-space:nowrap'
      if (item.icon) row.appendChild(iconSpan(item.icon))
      var lb = document.createElement('span')
      lb.textContent = item.label
      row.appendChild(lb)
      if (item.style) row.style.cssText += ';' + item.style
      if (item.active) { row.style.boxShadow = 'inset 0 0 0 1px currentColor'; row.style.fontWeight = '600' }
      row.addEventListener('mouseenter', function () { row.style.background = 'rgba(128,128,128,.12)' })
      row.addEventListener('mouseleave', function () { row.style.background = 'transparent' })
      row.addEventListener('click', function (e) { e.stopPropagation(); closeDropdowns(); onSelect(item) })
      dd.appendChild(row)
    }
    items.forEach(function (item) {
      if (item.type === 'sep') {
        var sep = document.createElement('div')
        sep.style.cssText = 'height:1px;background:rgba(128,128,128,.15);margin:4px 0'
        dd.appendChild(sep)
        return
      }
      if (item.type === 'header') {
        var hd = document.createElement('div')
        hd.style.cssText = 'padding:6px 14px 2px;font-size:11px;color:rgba(128,128,128,.75);letter-spacing:.5px;user-select:none;white-space:nowrap'
        hd.textContent = item.label
        dd.appendChild(hd)
        return
      }
      if (item.type === 'row') {
        var rr = document.createElement('div')
        rr.style.cssText = 'display:flex;align-items:center;gap:2px;padding:2px 8px'
        item.items.forEach(function (sub) {
          var b = document.createElement('div')
          b.style.cssText = 'flex:1 1 0;display:flex;align-items:center;justify-content:center;gap:5px;padding:7px 8px;cursor:pointer;border-radius:6px;white-space:nowrap;min-width:0'
          if (sub.icon) b.appendChild(iconSpan(sub.icon))
          var sl = document.createElement('span')
          sl.textContent = sub.label
          b.appendChild(sl)
          b.addEventListener('mouseenter', function () { b.style.background = 'rgba(128,128,128,.12)' })
          b.addEventListener('mouseleave', function () { b.style.background = 'transparent' })
          b.addEventListener('click', function (e) { e.stopPropagation(); closeDropdowns(); onSelect(sub) })
          rr.appendChild(b)
        })
        dd.appendChild(rr)
        return
      }
      addRow(item)
    })
    document.body.appendChild(dd)
    openDropdown = dd
    // 按下时别让浏览器把焦点/选区弄塌 ✓（2026-10-15：下拉菜单原来漏了这道守卫 ✗
    //   → 从菜单点「代码块 / 引用 / 表格…」时焦点已经跑到 body ✓
    //   → runCanvasCmd 里的 execCommand 静默失败 ✗）
    dd.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation() })
    // 先挂载量尺寸，再夹到视口内；下方放不下就翻到坐标上方 ✓
    var ddWidth = dd.offsetWidth
    var ddHeight = dd.offsetHeight
    var x = Math.max(8, Math.min(left, window.innerWidth - ddWidth - 8))
    var y = top
    if (y + ddHeight > window.innerHeight - 8) y = Math.max(8, top - ddHeight - 4)
    dd.style.left = x + 'px'
    dd.style.top = y + 'px'
    // 点击外部关闭；没点菜单就关掉的话，保存的选区一并作废（防止之后误插到旧位置 ✓）
    setTimeout(function () {
      document.addEventListener('mousedown', function close(ev) {
        if (!dd.contains(ev.target)) { closeDropdowns(); savedRange = null; document.removeEventListener('mousedown', close) }
      })
    }, 0)
  }
  function showHeadingDropdown(anchor) {
    var currentH = selectionFormats.heading
    var items = [
      { label: '正文', val: '<p>', active: !currentH },
      { type: 'sep' },
      { label: '一级标题', val: '<h1>', active: currentH === 'h1', style: 'font-size:18px;font-weight:700' },
      { label: '二级标题', val: '<h2>', active: currentH === 'h2', style: 'font-size:16px;font-weight:600' },
      { label: '三级标题', val: '<h3>', active: currentH === 'h3', style: 'font-size:14px;font-weight:600' },
      { label: '四级标题', val: '<h4>', active: currentH === 'h4', style: 'font-size:13px;font-weight:600' },
      { label: '五级标题', val: '<h5>', active: currentH === 'h5', style: 'font-size:12px;font-weight:500' },
      { label: '六级标题', val: '<h6>', active: currentH === 'h6', style: 'font-size:11px;font-weight:500' }
    ]
    showDropdown(anchor, items, function (item) {
      restoreSelection()
      document.execCommand('formatBlock', false, item.val)
      var ed = editorEl()
      if (ed) { try { ed.focus() } catch (_) {} }
    })
  }
  function showAlignDropdown(anchor) {
    var items = [
      { label: '左对齐', cmd: 'justifyLeft' },
      { label: '居中对齐', cmd: 'justifyCenter' },
      { label: '右对齐', cmd: 'justifyRight' }
    ]
    showDropdown(anchor, items, function (item) {
      restoreSelection()
      document.execCommand(item.cmd, false, null)
      var ed = editorEl()
      if (ed) { try { ed.focus() } catch (_) {} }
    })
  }
  function showFullMenu(anchor) {
    var items = [
      { type: 'header', label: '格式' },
      { label: '行内代码', cmd: 'inlineCode', icon: ccvIcon('code') },
      { label: '高亮', cmd: 'highlight', icon: ccvIcon('highlight') },
      { label: '清除格式', cmd: 'clearFormat', icon: ccvIcon('clear') },
      { label: '脚注', cmd: 'footnote', icon: '¹' },
      { type: 'header', label: '插入' },
      { label: '上传图片…', cmd: 'uploadImage', icon: ccvIcon('uploadImage') },
      { label: '网络图片…', cmd: 'imageUrl', icon: ccvIcon('globe') },
      { label: '上传文件…', cmd: 'uploadFile', icon: ccvIcon('file') },
      { label: '插入表格…', cmd: 'insertTable', icon: ccvIcon('table') },
      { label: '任务列表', cmd: 'insertTaskList', icon: ccvIcon('task') },
      { label: '无序列表', cmd: 'insertUnorderedList', icon: ccvIcon('listUl') },
      { label: '有序列表', cmd: 'insertOrderedList', icon: ccvIcon('listOl') },
      { label: '插入链接…', cmd: 'link', icon: ccvIcon('link') },
      { type: 'header', label: '块' },
      { type: 'row', items: [
        { label: '代码块', cmd: 'codeBlock', icon: ccvIcon('codeBlock') },
        { label: '引用', cmd: 'blockquote', icon: ccvIcon('quote') },
        { label: '分割线', cmd: 'insertHorizontalRule', icon: ccvIcon('hr') },
        { label: '高亮块', cmd: 'highlightBlock', icon: ccvIcon('hlBlock') }
      ] },
      { type: 'header', label: '缩进' },
      { label: '增加缩进', cmd: 'indent', icon: ccvIcon('indent') },
      { label: '减少缩进', cmd: 'outdent', icon: ccvIcon('outdent') }
    ]
    showDropdown(anchor, items, function (item) {
      restoreSelection()
      if (!runCanvasCmd(item.cmd)) {
        try { document.execCommand(item.cmd, false, item.val) } catch (_) {}
        var ed = editorEl()
        if (ed) { try { ed.focus() } catch (_) {} }
      }
    })
  }
  // ─── 右键菜单（阶段 4 搬过来的 ✓）────────────────────────────────
  function showContextMenu(x, y) {
    var hasSel = selectionText().trim().length > 0
    var items = [
      { label: '问AI', cmd: 'askAI', icon: ccvIcon('ask') },
      { type: 'sep' },
      { type: 'header', label: '常用' },
      { label: '上传图片…', cmd: 'uploadImage', icon: ccvIcon('uploadImage') },
      { label: '网络图片…', cmd: 'imageUrl', icon: ccvIcon('globe') },
      { label: '上传文件…', cmd: 'uploadFile', icon: ccvIcon('file') },
      { label: '插入表格…', cmd: 'insertTable', icon: ccvIcon('table') },
      { label: '插入链接…', cmd: 'link', icon: ccvIcon('link') },
      { type: 'row', items: [
        { label: '无序列表', cmd: 'insertUnorderedList', icon: ccvIcon('listUl') },
        { label: '有序列表', cmd: 'insertOrderedList', icon: ccvIcon('listOl') },
        { label: '任务列表', cmd: 'insertTaskList', icon: ccvIcon('task') }
      ] },
      { type: 'sep' },
      { type: 'header', label: '块' },
      { type: 'row', items: [
        { label: '代码块', cmd: 'codeBlock', icon: ccvIcon('codeBlock') },
        { label: '引用', cmd: 'blockquote', icon: ccvIcon('quote') },
        { label: '分割线', cmd: 'insertHorizontalRule', icon: ccvIcon('hr') },
        { label: '高亮块', cmd: 'highlightBlock', icon: ccvIcon('hlBlock') }
      ] },
      { type: 'sep' },
      { label: '增加缩进', cmd: 'indent', icon: ccvIcon('indent') },
      { label: '减少缩进', cmd: 'outdent', icon: ccvIcon('outdent') }
    ]
    if (hasSel) {
      items.push(
        { type: 'sep' },
        { type: 'header', label: '转换为' },
        { label: '代码块', cmd: 'codeBlock', icon: ccvIcon('codeBlock') },
        { label: '引用', cmd: 'blockquote', icon: ccvIcon('quote') },
        { label: '高亮', cmd: 'highlight', icon: ccvIcon('highlight') },
        { label: '链接', cmd: 'link', icon: ccvIcon('link') }
      )
    }
    openDropdownAt(x, y, items, function (item) {
      if (item.cmd === 'askAI') { askAi(); return }
      if (!runCanvasCmd(item.cmd)) document.execCommand(item.cmd, false, item.val)
    })
  }

  // ─── 表格单元格导航（Tab / Shift+Tab）──────────────────────────
  //   成熟产品都这么做 ✓ 写表格时手不用离开键盘 ✓
  function cellOf() {
    try {
      var sel = document.getSelection()
      if (!sel || !sel.rangeCount) return null
      var n = sel.getRangeAt(0).startContainer
      var el = (n && n.nodeType === 3) ? n.parentNode : n
      return (el && el.closest) ? el.closest('td,th') : null
    } catch (_) { return null }
  }
  function moveCell(back) {
    try {
      var cell = cellOf()
      if (!cell) return
      var table = cell.closest('table')
      if (!table) return
      var cells = table.querySelectorAll('th,td')
      var idx = Array.prototype.indexOf.call(cells, cell)
      var next = cells[idx + (back ? -1 : 1)]
      if (!next && !back) {
        // 到最后一个单元格再按 Tab → 自动加一行（列数照抄 ✓）—— Word / 飞书 的行为 ✓
        var trs = table.querySelectorAll('tr')
        var cols = trs.length ? trs[trs.length - 1].querySelectorAll('th,td').length : 0
        if (!cols) return
        var tr = document.createElement('tr')
        for (var i = 0; i < cols; i++) tr.appendChild(document.createElement('td'))
        table.appendChild(tr)
        next = tr.querySelector('td')
        log('表格：Tab 到末尾 → 自动加了一行（' + cols + ' 列）')
      }
      if (!next) return
      var rng = document.createRange()
      rng.selectNodeContents(next)
      rng.collapse(false)                       // 插入点落在单元格里 ✓
      var sel2 = document.getSelection()
      sel2.removeAllRanges()
      sel2.addRange(rng)
    } catch (e) { log('表格 Tab 出错: ' + (e && e.message)) }
  }

  // ─── 表格列宽拖拽（2026-10-15 加）──────────────────────────────
  //   成熟产品（Word / Google Docs / 飞书）都能拖列边界 ✓ 我们原来完全不能 ✗
  //   存法：把列宽写成 <colgroup><col style="width:40%"> ✓
  //         由 htmlToMd 序列化成表格后面的一行注释 <!-- ccv-table: 40,60 --> ✓
  //         由 mdToHtml 读回来 ✓ —— 表格本身保持 markdown 的可读形式 ✓
  //   拖完**手动派发一次 input 事件** ✓ —— 否则 onInput 不会跑、脏标记与自动保存接不上 ✗
  //   （execCommand 会自己触发 input ✓ 但直接改 DOM 不会 ✓）
  function fireInput() {
    try {
      var ed = editorEl()
      if (ed) ed.dispatchEvent(new Event('input', { bubbles: true }))
    } catch (_) {}
  }
  // 表格的列数（按第一行算）
  function colCount(table) {
    try {
      var tr = table.querySelector('tr')
      return tr ? tr.querySelectorAll('th,td').length : 0
    } catch (_) { return 0 }
  }
  // 确保有 colgroup（列数与表格一致 ✓）—— 没有就补一个全 auto 的 ✓
  function ensureColgroup(table) {
    var n = colCount(table)
    if (!n) return null
    var cg = table.querySelector('colgroup')
    if (!cg || cg.querySelectorAll('col').length !== n) {
      if (cg && cg.parentNode) cg.parentNode.removeChild(cg)
      cg = document.createElement('colgroup')
      for (var i = 0; i < n; i++) cg.appendChild(document.createElement('col'))
      table.insertBefore(cg, table.firstChild)
    }
    return cg
  }
  // ─── 表格拖拽（列宽 / 行高）2026-10-15 ────────────────────────
  //   ⚠️ 主人报「拉高度时经常卡，向下拉 8，卡一下退回 6」—— 两个原因：
  //     ① 拖动中途**变成了浏览器的文本选择** ✗
  //        鼠标稍微偏出 ±5px 热区时，mousedown 没被我们接管 ✓
  //        → 变成"选文字"拖动 → 高度停住、看着像弹回 ✗
  //        修：拖动期间给 body 上 user-select:none ✓（并 preventDefault ✓）
  //     ② 每个 mousemove 都在 **读布局**（getBoundingClientRect）+ **写布局**（style）
  //        → 强制同步排版，读写抖动 = 卡 ✓
  //        修：用 requestAnimationFrame 节流（**一帧只写一次** ✓）
  //            并且拖动期间**跳过光标探测**（那里面全是读布局 ✗）
  var tableDragging = false

  // 拖动期间禁掉文本选择 ✓（不然鼠标一偏就变成选文字 ✗）
  function lockSelect(on) {
    try {
      document.body.style.userSelect = on ? 'none' : ''
      document.body.style.webkitUserSelect = on ? 'none' : ''
    } catch (_) {}
  }

  function startColDrag(e, cell) {
    try {
      var table = cell.closest('table')
      if (!table) return
      e.preventDefault()
      e.stopPropagation()
      var cg = ensureColgroup(table)
      if (!cg) return
      var cols = cg.querySelectorAll('col')
      var cells = Array.prototype.slice.call(table.querySelector('tr').querySelectorAll('th,td'))
      var idx = cells.indexOf(cell)
      if (idx < 0) return
      var tRect = table.getBoundingClientRect()
      var startX = e.clientX
      var startW = cells[idx].getBoundingClientRect().width
      tableDragging = true
      lockSelect(true)
      var raf = 0, lastX = startX
      try { table.style.tableLayout = 'fixed' } catch (_) {}
      function apply() {
        raf = 0
        var w = Math.max(30, startW + (lastX - startX))
        var pct = Math.max(4, Math.min(96, Math.round(w / tRect.width * 1000) / 10))
        cols[idx].setAttribute('style', 'width:' + pct + '%')
      }
      function onMove(ev) {
        lastX = ev.clientX
        if (raf) return                      // ★ 一帧只写一次 ✓
        raf = requestAnimationFrame(apply)
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove, true)
        document.removeEventListener('mouseup', onUp, true)
        if (raf) { cancelAnimationFrame(raf); raf = 0 }
        apply()                              // 收尾时把最后一帧落定 ✓
        tableDragging = false
        lockSelect(false)
        log('表格列宽：第 ' + (idx + 1) + ' 列 → ' + (cols[idx].getAttribute('style') || ''))
        fireInput()   // ★ 让脏标记 / 草稿 / 自动保存接上 ✓
      }
      document.addEventListener('mousemove', onMove, true)
      document.addEventListener('mouseup', onUp, true)
      log('开始拖列宽：第 ' + (idx + 1) + ' 列（表格宽 ' + Math.round(tRect.width) + 'px）')
    } catch (err) { tableDragging = false; lockSelect(false); log('拖列宽出错: ' + (err && err.message)) }
  }
  // 双击列边界 → 恢复自动宽度（成熟产品：按内容自适应 ✓）
  function resetColWidth(cell) {
    try {
      var table = cell.closest('table')
      var cg = table && table.querySelector('colgroup')
      if (!cg) return
      var cells = Array.prototype.slice.call(table.querySelector('tr').querySelectorAll('th,td'))
      var idx = cells.indexOf(cell)
      var cols = cg.querySelectorAll('col')
      if (idx >= 0 && cols[idx]) cols[idx].removeAttribute('style')
      table.style.tableLayout = ''
      log('表格列宽：第 ' + (idx + 1) + ' 列恢复自动 ✓')
      fireInput()
    } catch (_) {}
  }
  // ─── 表格行高拖拽（2026-10-15 加）──────────────────────────────
  //   成熟产品：行高默认由**内容撑开** ✓（Word / Google Docs / 飞书 都是）
  //   但 Word / 飞书 允许拖行边界固定高度 ✓ 这里照做 ✓
  //   存法：<tr style="height:32px"> ✓ 由 htmlToMd 写成 <!-- ccv-table-h: 32,auto --> ✓
  function startRowDrag(e, tr) {
    try {
      var table = tr.closest('table')
      if (!table) return
      e.preventDefault()
      e.stopPropagation()
      var startY = e.clientY
      var startH = tr.getBoundingClientRect().height
      var rows = Array.prototype.slice.call(table.querySelectorAll('tr'))
      var idx = rows.indexOf(tr)
      if (idx < 0) return
      tableDragging = true
      lockSelect(true)
      var raf = 0, lastY = startY
      function apply() {
        raf = 0
        var h = Math.max(24, startH + (lastY - startY))
        tr.style.height = Math.round(h) + 'px'
      }
      function onMove(ev) {
        lastY = ev.clientY
        if (raf) return                      // ★ 一帧只写一次 ✓（原来每个 mousemove 都写 ✗ = 卡）
        raf = requestAnimationFrame(apply)
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove, true)
        document.removeEventListener('mouseup', onUp, true)
        if (raf) { cancelAnimationFrame(raf); raf = 0 }
        apply()                              // 收尾把最后一帧落定 ✓
        tableDragging = false
        lockSelect(false)
        log('表格行高：第 ' + (idx + 1) + ' 行 → ' + (tr.getAttribute('style') || '（无）'))
        fireInput()   // ★ 让脏标记 / 草稿 / 自动保存接上 ✓
      }
      document.addEventListener('mousemove', onMove, true)
      document.addEventListener('mouseup', onUp, true)
      log('开始拖行高：第 ' + (idx + 1) + ' 行（原高 ' + Math.round(startH) + 'px）')
    } catch (err) { tableDragging = false; lockSelect(false); log('拖行高出错: ' + (err && err.message)) }
  }
  // 双击行边界 → 恢复"由内容撑开"（成熟产品的默认 ✓）
  function resetRowHeight(tr) {
    try {
      tr.style.height = ''
      var rows = Array.prototype.slice.call(tr.closest('table').querySelectorAll('tr'))
      log('表格行高：第 ' + (rows.indexOf(tr) + 1) + ' 行恢复自动 ✓')
      fireInput()
    } catch (_) {}
  }

  // 鼠标划过列边界 → 光标变 ↔（并记住当前压着哪一格 ✓）
  function bindTableResize(root) {
    if (!root || root.__ccvTableBound) return
    root.__ccvTableBound = true
    // 表格工具条也靠这里同步（光标进出表格 ✓ 键盘移动光标 ✓）
    root.addEventListener('keyup', function () { tableBarSyncSoon() })
    root.addEventListener('click', function () { tableBarSyncSoon() })
    var hot = null
    var hotRow = null
    function clearCursors() {
      if (hot) { hot.style.cursor = ''; hot = null }
      if (hotRow) { hotRow.style.cursor = ''; hotRow = null }
    }
    root.addEventListener('mousemove', function (e) {
      // ★ 正在拖列宽/行高时**别做光标探测** ✗ —— 那里面全是 getBoundingClientRect（读布局 ✓）
      //   和 style.cursor 写入（写布局 ✓），一读一写就是强制同步排版 = 卡 ✓
      if (tableDragging) return
      var cell = (e.target && e.target.closest) ? e.target.closest('th,td') : null
      if (!cell) { clearCursors(); return }
      var r = cell.getBoundingClientRect()
      // ① 列边界（单元格右边界 ±6px ✓ 优先，因为竖向拖动更常用 ✓）
      if (Math.abs(e.clientX - r.right) <= 6) {
        if (hotRow) { hotRow.style.cursor = ''; hotRow = null }
        if (hot !== cell) { if (hot) hot.style.cursor = ''; hot = cell; cell.style.cursor = 'col-resize' }
        return
      }
      // ② 行边界（行下边界 ±6px ✓）
      var tr = cell.parentNode
      if (tr && tr.tagName === 'TR') {
        var rr = tr.getBoundingClientRect()
        if (Math.abs(e.clientY - rr.bottom) <= 6) {
          if (hot) { hot.style.cursor = ''; hot = null }
          if (hotRow !== tr) { if (hotRow) hotRow.style.cursor = ''; hotRow = tr; tr.style.cursor = 'row-resize' }
          return
        }
      }
      clearCursors()
    })
    root.addEventListener('mousedown', function (e) {
      var cell = (e.target && e.target.closest) ? e.target.closest('th,td') : null
      if (!cell) return
      var r = cell.getBoundingClientRect()
      if (Math.abs(e.clientX - r.right) <= 6) { startColDrag(e, cell); return }
      var tr = cell.parentNode
      if (tr && tr.tagName === 'TR') {
        var rr = tr.getBoundingClientRect()
        if (Math.abs(e.clientY - rr.bottom) <= 6) startRowDrag(e, tr)
      }
    }, true)
    root.addEventListener('dblclick', function (e) {
      var cell = (e.target && e.target.closest) ? e.target.closest('th,td') : null
      if (!cell) return
      var r = cell.getBoundingClientRect()
      if (Math.abs(e.clientX - r.right) <= 6) { e.preventDefault(); resetColWidth(cell); return }
      var tr = cell.parentNode
      if (tr && tr.tagName === 'TR') {
        var rr = tr.getBoundingClientRect()
        if (Math.abs(e.clientY - rr.bottom) <= 6) { e.preventDefault(); resetRowHeight(tr) }
      }
    })
  }

  // ─── 表格工具条（2026-10-15）──────────────────────────────────
  //   成熟产品（Google Docs 在表格上方 ✓ Notion 在左侧 ✓ 飞书在右上方 ✓）
  //   光标进表格就出现 ✓ 出表格就消失 ✓
  //
  //   ⚠️ **不做合并/拆分单元格** ✗ —— 不是偷懒：
  //      markdown 表格语法**表达不了 colspan/rowspan** ✗
  //      我们的 htmlToMd 会把表格压平成 | a | b | ✗ → 合并一次结构就丢了（内容错位 ✗✗）
  //      成熟产品能合并是因为它们存的是富文本模型 ✓ 我们存 markdown ✓
  var tblBar = null
  var tblBarFor = null
  var tblBarRaf = 0

  function tblBtn(label, title, fn) {
    var b = document.createElement('button')
    b.innerHTML = label
    b.title = title
    b.style.cssText = 'padding:3px 7px;border:none;background:transparent;color:inherit;border-radius:5px;'
      + 'font-size:12px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;'
      + 'min-width:26px;height:24px;white-space:nowrap;line-height:1'
    b.addEventListener('mouseenter', function () { b.style.background = 'rgba(128,128,128,.14)' })
    b.addEventListener('mouseleave', function () { b.style.background = 'transparent' })
    b.addEventListener('click', function (e) {
      e.stopPropagation()
      try { fn() } catch (err) { log('表格工具条出错: ' + (err && err.message)) }
    })
    return b
  }
  function ensureTableBar() {
    if (tblBar && tblBar.parentNode) return tblBar
    tblBar = document.createElement('div')
    tblBar.setAttribute('data-ccv-tblbar', '1')
    // 不透明（与划词栏/下拉同规矩 ✓）
    tblBar.style.cssText = 'position:fixed;z-index:2147483003;display:none;align-items:center;gap:1px;'
      + 'width:max-content;padding:2px 4px;border-radius:8px;'
      + 'background:var(--dsw-alias-bg-layer-1,#fff);'
      + 'color:var(--dsw-alias-label-primary,#1a1a1a);'
      + 'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));'
      + 'box-shadow:0 4px 14px rgba(0,0,0,.16);user-select:none;-webkit-user-select:none'
    // ★ 按下别让焦点跑掉（否则后续命令/输入都落空 ✗）—— 与划词栏同款 ✓
    tblBar.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation() })
    tblBar.appendChild(tblBtn('↑行', '在光标所在行上方插入一行', function () { tblAct('rowBefore') }))
    tblBar.appendChild(tblBtn('↓行', '在光标所在行下方插入一行', function () { tblAct('rowAfter') }))
    tblBar.appendChild(tblSep())
    tblBar.appendChild(tblBtn('←列', '在光标所在列左侧插入一列', function () { tblAct('colBefore') }))
    tblBar.appendChild(tblBtn('→列', '在光标所在列右侧插入一列', function () { tblAct('colAfter') }))
    tblBar.appendChild(tblSep())
    tblBar.appendChild(tblBtn('删行', '删除光标所在行', function () { tblAct('delRow') }))
    tblBar.appendChild(tblBtn('删列', '删除光标所在列', function () { tblAct('delCol') }))
    tblBar.appendChild(tblSep())
    // 单元格对齐（2026-10-15 加）—— markdown 的分隔行能表达 ✓ 所以这个能往返 ✓
    tblBar.appendChild(tblBtn('⇤', '这一列左对齐', function () { tblAct('alignLeft') }))
    tblBar.appendChild(tblBtn('↔', '这一列居中对齐', function () { tblAct('alignCenter') }))
    tblBar.appendChild(tblBtn('⇥', '这一列右对齐', function () { tblAct('alignRight') }))
    tblBar.appendChild(tblSep())
    tblBar.appendChild(tblBtn('删表格', '删除整个表格', function () { tblAct('delTable') }))
    document.body.appendChild(tblBar)
    return tblBar
  }
  function tblSep() {
    var s = document.createElement('span')
    s.style.cssText = 'width:1px;height:16px;background:rgba(128,128,128,.22);margin:0 3px;flex:0 0 auto'
    return s
  }
  function tableBarHide() {
    if (tblBar) tblBar.style.display = 'none'
    tblBarFor = null
  }
  // 光标在哪张表里（不在表格里返回 null ✓）
  function tableAtCaret() {
    try {
      var sel = document.getSelection()
      if (!sel || !sel.rangeCount) return null
      var n = sel.getRangeAt(0).startContainer
      var el = (n && n.nodeType === 3) ? n.parentNode : n
      if (!el || !el.closest) return null
      var t = el.closest('table')
      if (!t) return null
      var ed = editorEl()
      if (!ed || !ed.contains(t)) return null
      return t
    } catch (_) { return null }
  }
  function tableBarSync() {
    try {
      if (tableDragging) return
      var t = tableAtCaret()
      if (!t) { tableBarHide(); return }
      var bar = ensureTableBar()
      var r = t.getBoundingClientRect()
      bar.style.display = 'flex'
      var w = bar.offsetWidth || 300
      var h = bar.offsetHeight || 28
      var x = Math.max(8, Math.min(r.left, window.innerWidth - w - 8))
      var y = r.top - h - 6
      if (y < 8) y = Math.min(r.bottom + 6, window.innerHeight - h - 8)
      bar.style.left = x + 'px'
      bar.style.top = y + 'px'
      tblBarFor = t
    } catch (_) {}
  }
  function tableBarSyncSoon() {
    if (tblBarRaf) return
    tblBarRaf = requestAnimationFrame(function () { tblBarRaf = 0; tableBarSync() })
  }

  // 光标所在的单元格 / 行 / 列号
  function caretCell() {
    try {
      var sel = document.getSelection()
      if (!sel || !sel.rangeCount) return null
      var n = sel.getRangeAt(0).startContainer
      var el = (n && n.nodeType === 3) ? n.parentNode : n
      var cell = (el && el.closest) ? el.closest('th,td') : null
      if (!cell) return null
      var table = cell.closest('table')
      var tr = cell.parentNode
      var cells = Array.prototype.slice.call(tr.querySelectorAll('th,td'))
      var rows = Array.prototype.slice.call(table.querySelectorAll('tr'))
      return { table: table, cell: cell, tr: tr, rowIdx: rows.indexOf(tr), colIdx: cells.indexOf(cell), rows: rows, cells: cells }
    } catch (_) { return null }
  }
  // 表格的工具条动作（加行/加列/删行/删列/删表格）
  function tblAct(kind) {
    var c = caretCell()
    if (!c) { log('表格工具条：光标不在表格里'); return }
    var table = c.table
    if (kind === 'delTable') {
      table.parentNode.removeChild(table)
      log('表格：删除整个表格')
      tableBarHide(); fireInput(); return
    }
    if (kind === 'rowBefore' || kind === 'rowAfter') {
      var nCols = c.cells.length
      var tr = document.createElement('tr')
      for (var i = 0; i < nCols; i++) tr.appendChild(document.createElement('td'))
      if (kind === 'rowBefore') c.tr.parentNode.insertBefore(tr, c.tr)
      else c.tr.parentNode.insertBefore(tr, c.tr.nextSibling)
      log('表格：' + (kind === 'rowBefore' ? '上方' : '下方') + '插入一行（' + nCols + ' 列）')
    } else if (kind === 'colBefore' || kind === 'colAfter') {
      var at = c.colIdx + (kind === 'colAfter' ? 1 : 0)
      c.rows.forEach(function (r, ri) {
        var isHead = (ri === 0)
        var nc = document.createElement(isHead ? 'th' : 'td')
        var ref = r.querySelectorAll('th,td')[at] || null
        if (ref) r.insertBefore(nc, ref)
        else r.appendChild(nc)
      })
      // colgroup 也要跟着加一列 ✓（否则列宽会串位 ✗）
      var cg = table.querySelector('colgroup')
      if (cg) {
        var newCol = document.createElement('col')
        var cols = cg.querySelectorAll('col')
        var refCol = cols[at] || null
        if (refCol) cg.insertBefore(newCol, refCol)
        else cg.appendChild(newCol)
      }
      log('表格：' + (kind === 'colBefore' ? '左侧' : '右侧') + '插入一列（第 ' + (at + 1) + ' 列）')
    } else if (kind === 'delRow') {
      if (c.rows.length <= 1) { toastOn('只剩一行了，删不了'); return }
      c.tr.parentNode.removeChild(c.tr)
      log('表格：删除第 ' + (c.rowIdx + 1) + ' 行')
    } else if (kind === 'delCol') {
      if (c.cells.length <= 1) { toastOn('只剩一列了，删不了'); return }
      c.rows.forEach(function (r) {
        var cs = r.querySelectorAll('th,td')
        if (cs[c.colIdx]) cs[c.colIdx].parentNode.removeChild(cs[c.colIdx])
      })
      var cg2 = table.querySelector('colgroup')
      if (cg2) {
        var cs2 = cg2.querySelectorAll('col')
        if (cs2[c.colIdx]) cg2.removeChild(cs2[c.colIdx])
      }
      log('表格：删除第 ' + (c.colIdx + 1) + ' 列')
    } else if (kind === 'alignLeft' || kind === 'alignCenter' || kind === 'alignRight') {
      // 单元格对齐（2026-10-15 加）
      //   改的是**整列**（成熟产品也是整列 ✓ 一格一格对齐没人用 ✗）
      //   用 inline style ✓ 因为 htmlToMd 就是从这里读回 markdown 的 :---: 语法 ✓
      //   ⚠️ 合并已有 style 而不是整体覆盖 ✗（别把别的样式冲掉 ✓）
      var al2 = kind === 'alignLeft' ? 'left' : (kind === 'alignCenter' ? 'center' : 'right')
      c.rows.forEach(function (r) {
        var cs = r.querySelectorAll('th,td')
        var cell = cs[c.colIdx]
        if (!cell) return
        var old = String(cell.getAttribute('style') || '')
        old = old.replace(/text-align:\s*(left|center|right);?\s*/g, '').replace(/;\s*$/, '')
        var merged = old ? (old.replace(/;\s*$/, '') + ';text-align:' + al2) : ('text-align:' + al2)
        cell.setAttribute('style', merged)
      })
      log('表格：第 ' + (c.colIdx + 1) + ' 列对齐 → ' + al2)
    }
    var ed = editorEl()
    if (ed) { try { ed.focus() } catch (_) {} }
    fireInput()
    tableBarSyncSoon()
  }

  // ─── 光标位置（按"字符偏移"记 ✓ 因为重设正文后节点全是新的 ✗）──────
  //   2026-10-15 主人报「Ctrl+Z 会丢失焦点，需要再点一下话布」：
  //   撤销 → renderSeq +1 → React 重设 innerHTML ✗ → 节点被换掉 ✗
  //   → 焦点与光标一起没了 ✓（成熟软件重设内容时都必须自己接住光标 ✓）
  function caretOffset(el) {
    try {
      var sel = document.getSelection()
      if (!el || !sel || !sel.rangeCount) return -1
      var r = sel.getRangeAt(0)
      if (!el.contains(r.startContainer)) return -1
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null)
      var n, off = 0
      while ((n = walker.nextNode())) {
        if (n === r.startContainer) return off + r.startOffset
        off += n.nodeValue.length
      }
      return -1
    } catch (_) { return -1 }
  }
  function setCaretOffset(el, off) {
    try {
      if (!el) return
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null)
      var n, acc = 0
      while ((n = walker.nextNode())) {
        var len = n.nodeValue.length
        if (off >= 0 && acc + len >= off) {
          var r = document.createRange()
          r.setStart(n, Math.max(0, Math.min(len, off - acc)))
          r.collapse(true)
          var s = document.getSelection()
          s.removeAllRanges(); s.addRange(r)
          return
        }
        acc += len
      }
      // off 落在末尾之后 / 为 -1 → 放到最后 ✓
      var r2 = document.createRange()
      r2.selectNodeContents(el)
      r2.collapse(false)
      var s2 = document.getSelection()
      s2.removeAllRanges(); s2.addRange(r2)
    } catch (_) {}
  }

  // ★★ 编辑状态存在**组件外面**（2026-10-15 根治「保存后闪一下」）★★
  //   日志证据：宿主在**文件变化时会把我们的正文组件卸载再重装** ✗
  //     19:51:18.258  自动保存 ok（文件变了）
  //     19:51:19.866  重设正文（实例#2 …）   ← 1.6 秒后换了个新实例 ✗
  //     19:51:23.929  undo ok（文件又变了）
  //     19:51:23.952  重设正文（实例#3 …）   ← 又换了一个 ✗
  //   重挂载 = 元素全新 = 焦点/光标/滚动全没 ✓ 就是主人说的"像刷新了一下" ✓
  //
  //   成熟编辑器（VS Code / Typora）都这么做：**编辑状态不放在组件里** ✓
  //   所以这里把"最后已知的焦点与光标"放在模块级 ✓ 重挂载后自己接回来 ✓
  //   —— 组件可以被重建 ✓ 但用户**感觉不到** ✓
  var liveEditState = { hadFocus: false, offset: -1, scroll: 0, at: 0 }
  // ─── 大文档保护 + rAF 节流（2026-10-15 卡死事故的修 ✓）────────────
  //   事故：主人开着《创世沙盒-需求文档-v5.6》（14.5 万字节）→ 话布把 DSH 卡死 ✗
  //   原因链：
  //     ① caretOffset 是**全文 TreeWalker** ✗ —— 代价 O(文本节点数) ✓
  //     ② 它挂在**每次 selectionchange** 上 ✗ —— 打字时每个字都触发 ✓
  //     → 每敲一个字全文遍历一遍 ✓ → 十几万字的文档必然卡死 ✓
  //   修：① rAF 节流（一帧最多一次 ✓）② 超大文档干脆不算偏移 ✗
  //        （宁可光标位置不精确，也绝不能卡 ✓）
  var LIVE_STATE_MAX_CHARS = 60000
  var liveStateRaf = 0
  function noteLiveEditStateSoon() {
    if (liveStateRaf) return
    try {
      liveStateRaf = (window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16) })(function () {
        liveStateRaf = 0
        noteLiveEditState()
      })
    } catch (_) { liveStateRaf = 0 }
  }
  function noteLiveEditState() {
    try {
      var ed = liveEditor
      if (!ed) return
      // 大小只量一次（每个元素一次 textContent ✓ 之后走缓存 ✓）
      if (!ed.__ccvSizeChecked) {
        ed.__ccvSizeChecked = true
        try { ed.__ccvSize = (ed.textContent || '').length } catch (_) { ed.__ccvSize = 0 }
      }
      var tooBig = (ed.__ccvSize || 0) > LIVE_STATE_MAX_CHARS
      liveEditState = {
        hadFocus: document.activeElement === ed,
        offset: tooBig ? liveEditState.offset : caretOffset(ed),
        scroll: (function () { try { var sb = ccvScrollBox(ed); return sb ? sb.scrollTop : 0 } catch (_) { return 0 } })(),
        at: Date.now(),
      }
    } catch (_) {}
  }

  // ═══ 目录 / 大纲（2026-10-24）══════════════════════════════════════
  //
  // 主人要求：「改成「左目录 + 右正文」」
  //
  // 事实（读代码确认）：
  //   · 正文根元素**自己就是滚动容器**（boxStyle: height100% + overflow:auto ✓）
  //   · 所以目录必须是**另一个盒子** ✓ 不能塞进正文里 ✗（一塞就脏 → 触发保存）
  //   · 宿主**每次保存都会重建这个组件** ✗ → 开合状态必须放模块级 ✓
  //
  // 铁律（这片地雷多，逐条写死）：
  //   ① 外层容器形状**永远一样** ✓ 只让目录这个孩子出现/消失 ✓
  //      （"开目录才包一层"会让正文重挂载 → 丢焦点 ✗）
  //   ② 扫标题只读 DOM ✓ 一个字符都不写 ✓
  //   ③ 滚动高亮：rAF 节流 + 只读位置 ✓ 不做全文遍历 ✓
  // ★ 三态（2026-10-28 主人：「手机上竖屏还是默认开启目录，屏幕太窄，要默认收起」）★
  //   null = 自动：宽 ≥ 高（宽屏/桌面/横屏）→ 展开；否则（窄屏/竖屏手机）→ 收起
  //   true / false = 用户手动开/关过，此后不再自动干预 ✓
  var navOpen = null
  var NAV_W = 220                // 目录栏宽度（停靠模式，2026-10-27 由 260 收窄）
  var NAV_W_OVER = 190           // 浮层模式宽度（2026-10-27 由 208 收窄）
  // ★ 目录样式表（照豆包文档的大纲样式，2026-10-24）★
  //   豆包那版的特征：
  //     · 左侧常驻、**没有边框**（靠留白分隔 ✓）
  //     · 顶部一行：收起按钮 + 文档标题（粗体）
  //     · 一级标题粗、二级缩进、三级更小更淡 ✓
  //     · 当前所在那一项**有底色 + 主色**（截图里"2. 目标用户"那样 ✓）
  //     · 悬停有浅底色 ✓
  //     · 自己的**细滚动条**（不是系统粗条 ✓）
  //   ⚠️ 用 CSS class 而不是全内联 ✗ —— 内联写不了 :hover / ::-webkit-scrollbar ✓
  function ensureTocCss() {
    try {
      if (document.getElementById('ccv-toc-style')) return
      var el = document.createElement('style')
      el.id = 'ccv-toc-style'
      el.textContent = ''
        // ★ 2026-10-24 第二轮（主人四条意见）★
        //   ① 顶部标题和第一条重复 ✗ → 顶部用了第一个 h1 时，列表里**不再重复那一条** ✓
        //   ② 「有边框」✗ → 其实那是**滚动条槽**（scrollbar-gutter:stable 常驻占位 ✓）
        //      去掉 gutter ✓ 滚动条改成**平时透明、悬停才显形** ✓ 就不像一条边线了 ✓
        //   ③ 「太紧凑」✗ → 行距/内距都放大 ✓ 一级之间留更多空 ✓
        //   ④ 收起后的入口换成「≡」横线样式 ✓ 不要那个方块按钮 ✓
        + '.ccv-toc{height:100%;box-sizing:border-box;overflow-y:auto;overflow-x:hidden;'
        + 'padding:16px 12px 28px;font-size:13px;line-height:1.72}'
        + '.ccv-toc::-webkit-scrollbar{width:6px}'
        + '.ccv-toc::-webkit-scrollbar-track{background:transparent}'
        + '.ccv-toc::-webkit-scrollbar-thumb{background:transparent;border-radius:3px}'
        + '.ccv-toc:hover::-webkit-scrollbar-thumb{background:rgba(128,128,128,.35)}'
        + '.ccv-toc-head{display:flex;align-items:center;gap:6px;padding:0 2px 14px}'
        + '.ccv-toc-collapse{width:20px;height:20px;flex:none;border-radius:4px;display:flex;'
        + 'align-items:center;justify-content:center;cursor:pointer;font-size:13px;'
        + 'color:var(--dsw-alias-label-tertiary,#6b7280)}'
        + '.ccv-toc-collapse:hover{color:var(--dsw-alias-label-primary,#1a1a1a);'
        + 'background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}'
        + '.ccv-toc-title{font-size:13px;font-weight:700;min-width:0;overflow:hidden;'
        + 'text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#1a1a1a)}'
        // 条目：行距和内距都放大 ✓（原来太挤 ✓）
        + '.ccv-toc-item{padding:6px 10px;border-radius:6px;cursor:pointer;'
        + 'color:var(--dsw-alias-label-secondary,#8b8b8b);white-space:nowrap;overflow:hidden;'
        + 'text-overflow:ellipsis;font-size:13px;line-height:1.6}'
        + '.ccv-toc-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}'
        + '.ccv-toc-item.ccv-l1{font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a);margin-top:14px}'
        + '.ccv-toc-item.ccv-l1:first-child{margin-top:0}'
        + '.ccv-toc-item.ccv-l2{padding-left:20px;margin-top:2px}'
        + '.ccv-toc-item.ccv-l3{padding-left:34px;margin-top:2px;font-size:12.5px}'
        + '.ccv-toc-item.ccv-l4{padding-left:48px;margin-top:2px;font-size:12.5px}'
        + '.ccv-toc-item.is-active{color:var(--dsw-alias-brand-primary,#3b82f6);'
        + 'background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));font-weight:600}'
        + '.ccv-toc-empty{padding:2px 10px;font-size:12px;line-height:1.7;'
        + 'color:var(--dsw-alias-label-tertiary,#6b7280)}'
        // 收起后的入口（2026-10-27）：**整条左边留白都是热区** ✓
        //   ⚠️ 不能只做一个小图标 ✗ 那样只有 18px 能触发 ✓ 很难瞄 ✓
        //   三条横线仍在最上面当视觉提示 ✓
        + '.ccv-toc-reopen{position:absolute;left:0;top:0;bottom:0;width:20px;z-index:39;'
        + 'display:flex;flex-direction:column;align-items:center;gap:3px;'
        + 'padding-top:14px;box-sizing:border-box;cursor:default;opacity:.4}'
        + '.ccv-toc-reopen:hover{opacity:1}'
        + '.ccv-toc-reopen i{display:block;width:13px;height:1px;background:'
        + 'var(--dsw-alias-label-secondary,#8b8b8b);border-radius:1px}'
      document.head.appendChild(el)
    } catch (_) {}
  }
  // 工具栏（Actions）和正文（Body）是**两个独立组件** ✗
  //   → 用一个极小的订阅表把它们连起来 ✓（比状态库轻得多 ✓）
  var navSubs = []
  function navEmit() {
    for (var i = 0; i < navSubs.length; i++) { try { navSubs[i]() } catch (_) {} }
  }
  function navToggle() {
    navOpen = !navOpen
    try { log('目录：' + (navOpen ? '打开' : '关闭')) } catch (_) {}
    navEmit()
  }
  // 找**真正的滚动容器**：可能是元素自己，也可能是某个祖先
  //   ⚠️ 原来两处直接写 ed.parentElement.scrollTop ✗
  //      （正文自己才是滚动的那个 ✓ 所以一直取到 0 ✓ 顺手修对）
  function ccvScrollBox(el) {
    try {
      if (!el) return null
      if (el.scrollHeight > el.clientHeight + 4) return el
      var p = el.parentElement, n = 0
      while (p && n++ < 24) {
        var st = null
        try { st = window.getComputedStyle(p) } catch (_) {}
        var oy = st ? st.overflowY : ''
        if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 4) return p
        p = p.parentElement
      }
    } catch (_) {}
    return null
  }
  // 扫正文里的标题 → 大纲 ✓（只读 ✓）
  function buildOutline(ed) {
    var out = []
    try {
      if (!ed) return out
      var hs = ed.querySelectorAll('h1,h2,h3,h4,h5,h6')
      for (var i = 0; i < hs.length && i < 400; i++) {
        var el = hs[i]
        var txt = (el.textContent || '').replace(/\s+/g, ' ').trim()
        if (!txt) continue
        var lv = parseInt(String(el.tagName || 'H1').slice(1), 10) || 1
        out.push({ lv: lv, text: txt, el: el })
      }
    } catch (_) {}
    return out
  }
  // 重算大纲（防抖：打字时别每键重扫 ✗）
  var tocTimer = 0
  var tocRefreshFn = null      // 由组件挂上来（组件里才知道 setOutline）
  function tocRefreshSoon() {
    try {
      if (!navOpen) return
      if (tocTimer) return
      tocTimer = setTimeout(function () {
        tocTimer = 0
        try { if (tocRefreshFn) tocRefreshFn() } catch (_) {}
      }, 400)
    } catch (_) {}
  }
  // 当前高亮：最后一个"顶部已越过视口上沿"的标题 ✓
  function tocActiveIndex(ed, outline) {
    try {
      if (!ed || !outline || !outline.length) return -1
      var boxTop = ed.getBoundingClientRect().top + 30   // 留一点余量
      var idx = -1
      for (var i = 0; i < outline.length; i++) {
        var r = outline[i].el.getBoundingClientRect()
        if (r.top <= boxTop) idx = i
        else break
      }
      return idx
    } catch (_) { return -1 }
  }

  // ═══ 查找 / 替换（D1 · 2026-10-17）══════════════════════════════════
  //
  // 为什么要它：长文档里找一句话只能自己滚着看 ✗（14 万字那篇尤其痛苦 ✓）
  //
  // ★★ 设计上守住一条：**绝不碰编辑区地基** ✗ ★★
  //   · 查找 = **选中匹配** ✓（用 DOM Selection ✓ 一个字符都不改 ✓）+ 滚到可见 ✓
  //     —— 不做高亮 ✗（改 DOM 就会弄脏内容 ✓ 会把文档标成"有改动"✗✗）
  //   · 替换 = execCommand('insertText') ✓（和工具栏同一条路 ✓
  //     它会触发正常 input 事件 ✓ → 脏标记/草稿/自动保存全都自动接上 ✓✓）
  //   · 界面 = **固定定位的浮层** ✓（像表格工具条那样 ✓）
  //     —— **不插进 React 的 DOM 树** ✗（插进去就是又去碰宿主的地盘 ✓）
  //   · 不碰：保存路径 ✓ 渲染路径 ✓ 撤销 ✓ DOM 归属 ✓
  var findBar = null
  var findWatchTimer = null     // "查找条开着时每秒看一眼"的定时器（关了立刻清 ✓）
  var findState = { q: '', rep: '', idx: -1, count: 0 }
  var findForPath = ''

  function ensureFindBar() {
    if (findBar && findBar.parentNode) return findBar
    findBar = document.createElement('div')
    findBar.setAttribute('data-ccv-findbar', '1')
    findBar.style.cssText = 'position:fixed;z-index:2147483004;display:none;align-items:center;gap:4px;'
      + 'width:max-content;padding:5px 7px;border-radius:8px;font-size:13px;'
      + 'background:var(--dsw-alias-bg-layer-1,#fff);'
      + 'color:var(--dsw-alias-label-primary,#1a1a1a);'
      + 'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));'
      + 'box-shadow:0 6px 18px rgba(0,0,0,.18);user-select:none;-webkit-user-select:none'
    var mkInput = function (ph, w) {
      var i = document.createElement('input')
      i.type = 'text'
      i.placeholder = ph
      i.style.cssText = 'width:' + w + 'px;padding:3px 6px;font-size:13px;border-radius:5px;'
        + 'background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));'
        + 'color:var(--dsw-alias-label-primary,#1a1a1a);'
        + 'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));outline:none'
      // 点输入框不能把编辑区选区弄丢 ✓ → 先把选区存下来 ✓
      i.addEventListener('focus', function () { try { saveSelection() } catch (_) {} })
      return i
    }
    var q = mkInput('查找', 130); q.setAttribute('data-ccv-find-q', '1')
    var rep = mkInput('替换为', 130); rep.setAttribute('data-ccv-find-rep', '1')
    var cnt = document.createElement('span')
    cnt.setAttribute('data-ccv-find-count', '1')
    cnt.style.cssText = 'min-width:52px;text-align:center;opacity:.75;font-variant-numeric:tabular-nums'
    var mkBtn = function (label, title, fn) {
      var b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.title = title
      b.style.cssText = 'padding:3px 8px;font-size:12.5px;border-radius:5px;cursor:pointer;white-space:nowrap;'
        + 'background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));'
        + 'color:var(--dsw-alias-label-primary,#1a1a1a);'
        + 'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3))'
      b.addEventListener('mousedown', function (e) { e.preventDefault() })   // 别让焦点跑掉 ✓
      b.addEventListener('click', function (e) { e.preventDefault(); fn() })
      return b
    }
    // 回车 = 下一处 ✓ Shift+回车 = 上一处 ✓ Esc = 关 ✓
    // ⚠️ 2026-10-17 主人报：「下一处按钮显示可以按 enter，但我按了没有调下一步
    //    而是在话布上执行换行」✗
    //   原因：点完「下一处」后，我在编辑区里设了选区 ✓
    //         浏览器就把焦点挪进编辑区了 ✗ → 你按 Enter 落到编辑区 → 换行 ✓
    //   修：① 每次跳完**把焦点抢回查找框** ✓（成熟软件都这样 ✓
    //           VS Code 的查找框也一直握着焦点 ✓）
    //       ② 查找框开着时，**在文档级**也接 Enter/Shift+Enter/Esc ✓
    //          （这样不管焦点跑哪儿都能用 ✓ 而且只在这个框开着时才拦 ✓）
    q.addEventListener('keydown', function (e) {
      // ⚠️ 2026-10-17 主人说「enter的快捷键还在」→ **整个去掉** ✗
      //   他的意思很明确：不要这个快捷键 ✓
      //   去掉后：编辑区里 Enter 就是正常换行 ✓ 查找框里也不拦 ✓
      //   跳转只用 ↑ ↓ 按钮 ✓
      if (e.key === 'Escape') { e.preventDefault(); findHide() }
    })
    q.addEventListener('input', function () { findRecollect() })
    rep.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); findReplaceOne() }
      else if (e.key === 'Escape') { e.preventDefault(); findHide() }
    })
    findBar.appendChild(q)
    findBar.appendChild(cnt)
    findBar.appendChild(mkBtn('↑', '上一处（Shift+Enter）', function () { findGo(-1) }))
    findBar.appendChild(mkBtn('↓', '下一处（Enter）', function () { findGo(1) }))
    findBar.appendChild(rep)
    findBar.appendChild(mkBtn('替换', '替换这一处', function () { findReplaceOne() }))
    findBar.appendChild(mkBtn('全部替换', '替换全部（最多 500 处）', function () { findReplaceAll() }))
    findBar.appendChild(mkBtn('×', '关闭（Esc）', function () { findHide() }))
    document.body.appendChild(findBar)
    return findBar
  }

  // 收集所有匹配（**只读** ✓ 不改一个字符 ✓）
  //   返回 [{node, start, end}] —— 按文档顺序 ✓
  function findCollect(ed, q) {
    var out = []
    if (!ed || !q) return out
    try {
      var walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT, null)
      var n
      while ((n = walker.nextNode())) {
        var t = n.nodeValue || ''
        if (!t) continue
        var low = t.toLowerCase(), lq = q.toLowerCase(), from = 0, at
        while ((at = low.indexOf(lq, from)) >= 0) {
          out.push({ node: n, start: at, end: at + q.length })
          from = at + Math.max(1, q.length)
          if (out.length > 2000) return out      // 上限（防超大文档卡住 ✓）
        }
      }
    } catch (_) {}
    return out
  }
  // 一个文本节点里的某一点，在**整篇正文**里排第几个字符 ✓（诊断用 ✓）
  //   用来判断"两处匹配是不是落在同一个地方"✗
  function findOffsetOf(ed, node, off) {
    try {
      if (!ed) return -1
      var walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT, null)
      var n, acc = 0
      while ((n = walker.nextNode())) {
        if (n === node) return acc + off
        acc += (n.nodeValue || '').length
      }
    } catch (_) {}
    return -1
  }
  // ★★ 高亮改成【浮层色块】（2026-10-17 第三次修，这次一定能看见 ✓）★★
  //
  // 主人原话：「现在还是没有高亮，以前是选中文字，你之前是不是改掉改不回来了」
  //   —— 他说对了 ✗ 我把"选中"那条路弄没了：
  //     为了修 Enter 那个问题 ✓ 我让跳完**把焦点抢回查找框** ✗
  //     → 编辑区的选区变成**非激活** ✓ → 浏览器干脆不画它 ✗✓
  //     → 加上 CSS Custom Highlight API 在他浏览器上不支持 ✗
  //     → 结果：**什么都看不见** ✓✓
  //
  // 这次用**跟焦点无关**的办法 ✓：在正文上面盖一层**色块** ✓
  //   · 一个 `position:fixed; pointer-events:none` 的浮层容器 ✓
  //   · 每个匹配 → `range.getClientRects()` → 盖几个小块 ✓
  //   · 当前那一处换一种颜色 ✓
  //   · **一个字符都不改正文** ✓✓ 不脏 ✓ 不触发保存 ✓ 不碰地基 ✓
  //   · 浮层 `pointer-events:none` ✓ → 不挡点击 ✓
  //   · 只画**视口里**的 ✓（最多 200 块 ✓ 大文档也不卡 ✓）
  //   · 滚动 / 改字 / 定时检查时**重画** ✓（位置跟着走 ✓）
  var FIND_BOX_MAX = 200
  var findLayer = null
  function ensureFindLayer() {
    if (findLayer && findLayer.parentNode) return findLayer
    findLayer = document.createElement('div')
    findLayer.setAttribute('data-ccv-findlayer', '1')
    findLayer.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;'
      + 'pointer-events:none;z-index:2147482999;overflow:hidden'
    try { document.body.appendChild(findLayer) } catch (_) {}
    return findLayer
  }
  function findClearHighlight() {
    try {
      if (findLayer) findLayer.textContent = ''
    } catch (_) {}
    try {
      if (window.CSS && window.CSS.highlights) {
        window.CSS.highlights.delete('ccv-find')
        window.CSS.highlights.delete('ccv-find-cur')
      }
    } catch (_) {}
  }
  // 画：把每个匹配的 client rects 盖成小块 ✓
  function findPaintHighlight(ms, curIdx) {
    try {
      if (!ms || !ms.length) { findClearHighlight(); return }
      var layer = ensureFindLayer()
      var vh = window.innerHeight || 800
      var vw = window.innerWidth || 1200
      var frag = document.createDocumentFragment()
      var painted = 0
      for (var i = 0; i < ms.length && painted < FIND_BOX_MAX; i++) {
        var m = ms[i]
        var rg = null
        try {
          rg = document.createRange()
          rg.setStart(m.node, m.start)
          rg.setEnd(m.node, m.end)
        } catch (_) { continue }
        var rects = null
        try { rects = rg.getClientRects() } catch (_) {}
        if (!rects || !rects.length) continue
        var isCur = (i === curIdx)
        for (var k = 0; k < rects.length && painted < FIND_BOX_MAX; k++) {
          var rc = rects[k]
          // 只画视口里的 ✓（大文档不卡 ✓）
          if (rc.bottom < 0 || rc.top > vh || rc.right < 0 || rc.left > vw) continue
          if (rc.width < 1 || rc.height < 1) continue
          var bx = document.createElement('div')
          bx.style.cssText = 'position:fixed;pointer-events:none;border-radius:2px;'
            + 'left:' + Math.round(rc.left) + 'px;top:' + Math.round(rc.top) + 'px;'
            + 'width:' + Math.round(rc.width) + 'px;height:' + Math.round(rc.height) + 'px;'
            + 'background:' + (isCur ? 'rgba(255,140,0,.55)' : 'rgba(255,205,0,.42)')
          frag.appendChild(bx)
          painted++
        }
      }
      layer.textContent = ''
      layer.appendChild(frag)
      if (findHlPainted !== painted) {
        findHlPainted = painted
        log('查找高亮：已画 ' + painted + ' 块色块 ✓（浮层法 ✓ 与焦点无关 ✓ 不改正文 ✓）'
          + '｜匹配 ' + ms.length + ' 处')
      }
    } catch (err) {
      log('查找高亮出错: ' + (err && err.message))
    }
  }
  var findHlPainted = -1

  function findEd() { return editorEl() }
  function findShow(path) {
    try {
      var bar = ensureFindBar()
      findForPath = path || findForPath
      bar.style.display = 'inline-flex'
      findPlace()
      // 拿编辑区里选中的文字当默认查找词 ✓（像成熟软件那样 ✓）
      try {
        var sel = String((document.getSelection() || {}).toString() || '').trim()
        var qi = bar.querySelector('[data-ccv-find-q]')
        if (sel && sel.length <= 80 && qi && !qi.value) qi.value = sel
      } catch (_) {}
      findRecollect()
      try { var qi2 = bar.querySelector('[data-ccv-find-q]'); if (qi2) { qi2.focus(); qi2.select() } } catch (_) {}
      // ★ 开了之后：跟着滚动走 ✓ + 每秒看一次"编辑区还在不在"（2026-10-17）★
      //   ① 跟着滚动：不跟的话它就一直钉在窗口角上 ✗（主人截图里那样 ✓）
      //   ② 每秒看一次：关侧栏时**卸载和 resize 都不一定触发** ✗
      //      我上一版只靠那两条 → 检查根本没跑过 ✓ 所以"还是不会消失"✓
      //      ⚠️ 这个定时器**只在查找条开着时才存在** ✓ 关了立刻清掉 ✓
      try { window.addEventListener('scroll', findPlace, true) } catch (_) {}
      try {
        if (findWatchTimer) clearInterval(findWatchTimer)
        findWatchTimer = setInterval(function () {
          try {
            if (!findBar || findBar.style.display === 'none') {
              if (findWatchTimer) { clearInterval(findWatchTimer); findWatchTimer = null }
              try { window.removeEventListener('scroll', findPlace, true) } catch (_) {}
              return
            }
            var ed = findEd()
            // ★ 用 findEditorVisible（沿祖先链判 ✓ 而不是只看 isConnected ✗）
            if (!findEditorVisible()) {
              log('查找条开着，但编辑区看不见了（侧栏关了 / 切走了）→ 收起 ✓')
              findHide()
              return
            }
            findPlace()
          } catch (_) {}
        }, 300)
      } catch (_) {}
      log('查找条已打开（选中匹配但**不改内容** ✓ 零风险 ✓）')
    } catch (err) { log('打开查找条失败: ' + (err && err.message)) }
  }
  // 把查找条放到"编辑区可见区域的顶部" ✓ 并且**夹在视口里** ✓
  //   ⚠️ 2026-10-17 主人截图：它贴在窗口左上角 ✗
  //     原因：文档滚动后编辑区的 rect.top 是**负数** ✗ 被我夹成了 8 ✓
  //     → 现在：先算编辑区顶部 ✓ 再夹进 [8, 视口高-条高-8] ✓
  //       这样它**永远看得见、也永远压在正文上方** ✓ 滚动时跟着走 ✓
  function findPlace() {
    try {
      var bar = findBar
      if (!bar || bar.style.display === 'none') return
      var ed = findEd()
      var r = (ed && ed.getBoundingClientRect) ? ed.getBoundingClientRect() : null
      var vh = window.innerHeight || 800
      var vw = window.innerWidth || 1200
      var bh = bar.offsetHeight || 34
      var bw = bar.offsetWidth || 420
      var top = r ? (r.top + 6) : 70
      // 夹进视口 ✓（滚动后 r.top 可能是负的 ✓ 夹完就贴在视口顶部 ✓ 仍然可见 ✓）
      if (top < 8) top = 8
      if (top > vh - bh - 8) top = Math.max(8, vh - bh - 8)
      var left = r ? Math.min(r.right - bw - 12, r.left + 18) : (vw - bw - 24)
      if (!(left > 8)) left = 8
      if (left > vw - bw - 8) left = Math.max(8, vw - bw - 8)
      bar.style.top = Math.round(top) + 'px'
      bar.style.left = Math.round(left) + 'px'
      // ★ 色块要跟着滚动走 ✓（否则滚动后色块留在原地 ✗）
      //   ⚠️ 滚动事件很密 ✗ → rAF 节流（一帧最多重画一次 ✓）
      findRepaintSoon()
    } catch (_) {}
  }
  // 重画色块（rAF 节流 ✓ 滚动/改字/定时检查都会调它 ✓）
  var findRepaintRaf = 0
  function findRepaintSoon() {
    try {
      if (!findBar || findBar.style.display === 'none') return
      if (findRepaintRaf) return
      findRepaintRaf = (window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16) })(function () {
        findRepaintRaf = 0
        try { findPaintHighlight(findState.matches || [], findState.idx) } catch (_) {}
      })
    } catch (_) {}
  }
  function findHide() {
    try {
      if (findBar) findBar.style.display = 'none'
      // ★ 关掉时把高亮也清掉 ✓（不留痕迹 ✓）
      findClearHighlight()
      // ★ 把"跟着滚动"和"每秒看一眼"的钩子也撤掉 ✓（不关就一直在跑 ✗）
      if (findWatchTimer) { clearInterval(findWatchTimer); findWatchTimer = null }
      try { window.removeEventListener('scroll', findPlace, true) } catch (_) {}
      var ed = findEd()
      if (ed) { try { ed.focus() } catch (_) {} }
      try { restoreSelection() } catch (_) {}
      log('查找条已关闭 ✓')
    } catch (_) {}
  }
  function findRecollect() {
    try {
      var bar = findBar
      if (!bar) return
      var q = (bar.querySelector('[data-ccv-find-q]') || {}).value || ''
      findState.q = q
      var ms = findCollect(findEd(), q)
      findState.count = ms.length
      findState.matches = ms
      if (findState.idx >= ms.length) findState.idx = ms.length - 1
      var cnt = bar.querySelector('[data-ccv-find-count]')
      if (cnt) cnt.textContent = q ? (ms.length ? ((findState.idx + 1) + '/' + ms.length) : '0 处') : ''
      log('查找「' + q + '」→ ' + ms.length + ' 处')
      // ★ 把所有匹配都画上高亮 ✓（不改 DOM ✓ 焦点在查找框里也看得见 ✓）
      findPaintHighlight(ms, findState.idx)
      // ★ 诊断（2026-10-17 主人报"只搜到 4 个但显示 8 个"）★
      //   把每一处的位置与上下文打出来 ✓ —— 一眼就能看出是不是"两处落在同一个地方"✗
      //   （不猜 ✓ 让证据说话 ✓ 这是这轮反复吃亏换来的规矩 ✓）
      try {
        if (q && ms.length) {
          for (var di = 0; di < ms.length && di < 20; di++) {
            var m = ms[di]
            var p = m.node.parentElement
            var tag = (p && p.tagName) ? p.tagName.toLowerCase() : '?'
            var pth = ''
            try {
              var a = p
              while (a && a !== findEd() && pth.length < 60) {
                pth = (a.tagName ? a.tagName.toLowerCase() : '?') + (a.className ? '.' + String(a.className).split(' ')[0] : '') + '>' + pth
                a = a.parentElement
              }
            } catch (_) {}
            var txt = String(m.node.nodeValue || '')
            var win = txt.slice(Math.max(0, m.start - 12), m.end + 12)
            // 它在整篇里的字符偏移（用来判断是不是同一处 ✓）
            var off = findOffsetOf(findEd(), m.node, m.start)
            log('  第' + (di + 1) + '处：父<' + tag + '> 路径=' + pth
              + ' 偏移=' + off + ' 上下文=…' + win.replace(/\n/g, '⏎') + '…')
          }
        }
      } catch (_) {}
    } catch (_) {}
  }
  function findGo(dir) {
    try {
      var bar = findBar
      if (!bar) return
      var ms = findState.matches || []
      if (!ms.length) { findRecollect(); ms = findState.matches || [] }
      if (!ms.length) return
      var i = findState.idx
      if (i < 0) i = (dir > 0 ? -1 : 0)
      i = (i + dir + ms.length) % ms.length
      findState.idx = i
      var m = ms[i]
      // ★ 只**选中**它 ✓ 不改内容 ✓
      var rg = document.createRange()
      rg.setStart(m.node, m.start)
      rg.setEnd(m.node, m.end)
      var sel = document.getSelection()
      sel.removeAllRanges()
      sel.addRange(rg)
      savedRange = rg.cloneRange()          // 记下来 ✓ 替换要用 ✓
      // 滚到可见 ✓
      try {
        var p = m.node.parentElement
        if (p && p.scrollIntoView) p.scrollIntoView({ block: 'center', behavior: 'auto' })
      } catch (_) {}
      var cnt = bar.querySelector('[data-ccv-find-count]')
      if (cnt) cnt.textContent = (i + 1) + '/' + ms.length
      // ★ 当前那一处换个颜色 ✓（"跳到哪了"一眼可见 ✓）
      findPaintHighlight(ms, i)
      // ⚠️ 2026-10-17：**不再**把焦点抢回查找框 ✗✗
      //   原来抢焦点是为了让 Enter 不落到编辑区 ✓
      //   但它的副作用是：编辑区的选区变成**非激活** ✗ → 浏览器不画它 ✗✓
      //   → 主人看到的"什么都没有"✓ 根因就在这一行 ✓
      //   现在：高亮由**浮层**负责 ✓ 跟焦点无关 ✓
      //        所以焦点**留在编辑区**更好 ✓（选区也是激活的 ✓ 双重可见 ✓）
      //        而且 Enter 已经整个去掉了 ✗ 不存在"落到编辑区"的问题 ✓
    } catch (err) { log('跳到匹配失败: ' + (err && err.message)) }
  }
  // 查找框开着时，在**文档级**接 Enter / Shift+Enter / Esc ✓
  //   （不管焦点跑哪儿都能用 ✓ 而且只在框开着时才拦 ✓ 平时一个字都不影响 ✓）
  function findGlobalKey(e) {
    try {
      if (!findBar || findBar.style.display === 'none') return
      // ★ 顺手确认编辑区还看得见 ✓（看不见就收掉 ✓ 不做别的 ✓）
      if (!findEditorVisible()) { findHide(); return }
      var t = e.target
      // 已经在查找框里 → 由它自己的监听处理 ✓ 不重复 ✓
      if (t && findBar.contains(t)) return
      // ⚠️ 2026-10-17 主人说「enter的快捷键还在」→ **Enter 整个去掉** ✗
      //   只留 Esc（关查找条 ✓ 这个是他要的 ✓）
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault(); e.stopPropagation()
        findHide()
      }
    } catch (_) {}
  }
  // 编辑区真的没了 → 把查找条收掉 ✓
  //   ⚠️ 2026-10-17 主人报：「搜索窗口在我关了侧栏后还存在」✗
  //     因为查找条挂在 document.body 上 ✓ 关侧栏时没人收它 ✓
  //   ⚠️ 但不能一卸载就收 ✗ —— 宿主**每次保存都会重建组件** ✓
  //     那样查找框会在你搜索时突然消失 ✓
  //   → 判据：**等一拍再看编辑区还在不在文档里** ✓
  //     重挂载（宿主重建）→ 新编辑区还在 ✓ 不收 ✓
  //     真关闭（侧栏关了）→ 编辑区没了 ✓ 收 ✓
  // 编辑区现在**真的看得见**吗？（2026-10-17 修主人报的"关侧栏只是从左边跑到右边"✗）
  //   ⚠️ 上一版只看了 `isConnected` + `offsetWidth` ✗ —— **判错了** ✓
  //      关侧栏时元素**还在 DOM 里、还有宽度** ✓（只是被挪走或被祖先藏起来 ✓）
  //      → 检查通过 → 不收 ✓ 反而布局变了 → findPlace 把它挪到右边 ✗✓
  //   现在沿**祖先链**看四件事 ✓ 任何一条不满足就算"看不见了" ✓：
  //     ① 还在文档里 ✓  ② 没有祖先 display:none / visibility:hidden ✓
  //     ③ 尺寸没塌（宽高 > 40）✓  ④ 没有整个跑到视口外 ✓
  function findEditorVisible() {
    try {
      var ed = findEd()
      if (!ed || !ed.isConnected) { findWhy('编辑区不在文档里'); return false }
      // ★ 先做**便宜**的判断（读一次 rect ✓）再做贵的（走祖先链 ✗）
      var r = ed.getBoundingClientRect ? ed.getBoundingClientRect() : null
      if (!r) { findWhy('拿不到 rect'); return false }
      if (r.width < 40 || r.height < 40) { findWhy('尺寸塌了 ' + Math.round(r.width) + 'x' + Math.round(r.height)); return false }
      var vh = window.innerHeight || 800
      var vw = window.innerWidth || 1200
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) { findWhy('整个跑到视口外'); return false }
      // 再走祖先链 ✓（只在上面都通过时才做 ✓）
      var n = ed
      var guard = 0
      while (n && n.nodeType === 1 && guard++ < 60) {
        var cs = null
        try { cs = window.getComputedStyle(n) } catch (_) {}
        if (cs) {
          if (cs.display === 'none' || cs.visibility === 'hidden') {
            findWhy('祖先 ' + (n.tagName || '?') + ' 是 ' + cs.display + '/' + cs.visibility)
            return false
          }
        }
        n = n.parentElement
      }
      return true
    } catch (_) { return true }   // 判不出来就**不隐藏** ✓（宁可多留一会儿，也别乱收 ✓）
  }
  // 为什么判成"看不见"（诊断用 ✓ 只打一次同样的理由 ✓）
  var findWhySaid = ''
  function findWhy(why) {
    try {
      if (findWhySaid === why) return
      findWhySaid = why
      log('查找条：编辑区判成"看不见"了 → ' + why + '（据此收起 ✓）')
    } catch (_) {}
  }
  function findHideIfEditorGone() {
    try {
      if (!findBar || findBar.style.display === 'none') return
      setTimeout(function () {
        try {
          if (!findEditorVisible()) {
            log('编辑区不在了（侧栏关了 / 切走了 / 被藏起来）→ 收起查找条 ✓')
            findHide()
          }
        } catch (_) {}
      }, 0)
    } catch (_) {}
  }
  // 替换这一处：**走 execCommand** ✓ 与工具栏同一条路 ✓
  //   → 自动触发 input ✓ → 脏标记/草稿/自动保存全都接上 ✓✓
  function findReplaceOne() {
    try {
      var bar = findBar
      if (!bar) return
      var q = (bar.querySelector('[data-ccv-find-q]') || {}).value || ''
      var rp = (bar.querySelector('[data-ccv-find-rep]') || {}).value || ''
      if (!q) return
      var ed = findEd()
      if (!ed) return
      var ms = findCollect(ed, q)
      if (!ms.length) { toastOn('没找到「' + q + '」'); return }
      // 优先替换"当前选中那一处"✓ 没选中就替换第一处 ✓
      var target = null
      try {
        var sel = document.getSelection()
        if (sel && sel.rangeCount) {
          var r = sel.getRangeAt(0)
          for (var k = 0; k < ms.length; k++) {
            if (ms[k].node === r.startContainer && ms[k].start === r.startOffset) { target = ms[k]; break }
          }
        }
      } catch (_) {}
      if (!target) target = ms[0]
      try { ed.focus() } catch (_) {}
      var rg = document.createRange()
      rg.setStart(target.node, target.start)
      rg.setEnd(target.node, target.end)
      var s2 = document.getSelection()
      s2.removeAllRanges(); s2.addRange(rg)
      document.execCommand('insertText', false, rp)
      log('替换一处：「' + q + '」→「' + rp + '」✓（走 execCommand ✓ 正常 input 已触发 ✓）')
      findState.idx = -1
      findRecollect()
      findGo(1)
    } catch (err) { log('替换失败: ' + (err && err.message)) }
  }
  function findReplaceAll() {
    try {
      var bar = findBar
      if (!bar) return
      var q = (bar.querySelector('[data-ccv-find-q]') || {}).value || ''
      var rp = (bar.querySelector('[data-ccv-find-rep]') || {}).value || ''
      if (!q) return
      var ed = findEd()
      if (!ed) return
      var n = 0
      for (var guard = 0; guard < 500; guard++) {
        var ms = findCollect(ed, q)
        if (!ms.length) break
        var m = ms[0]
        try { ed.focus() } catch (_) {}
        var rg = document.createRange()
        rg.setStart(m.node, m.start)
        rg.setEnd(m.node, m.end)
        var s2 = document.getSelection()
        s2.removeAllRanges(); s2.addRange(rg)
        document.execCommand('insertText', false, rp)
        n++
      }
      log('全部替换：' + n + ' 处（上限 500 ✓ 走 execCommand ✓）')
      toastOn(n ? ('已替换 ' + n + ' 处 ✓') : ('没找到「' + q + '」'))
      findState.idx = -1
      findRecollect()
    } catch (err) { log('全部替换失败: ' + (err && err.message)) }
  }
  // 内容变了 → 重新数一遍 + 重画高亮 ✓（否则高亮的 Range 会指到已经不存在的节点上 ✗）
  //   ⚠️ 必须**节流** ✗ —— 打字时每次 input 都会调它 ✓
  //      而 findCollect 是全文遍历 ✗（正是 2026-10-15 卡死事故那个代价 ✓）
  //   → rAF 节流（一帧最多一次 ✓）而且只在查找条开着时才跑 ✓
  var findSyncRaf = 0
  function findSyncOnEdit() {
    try {
      if (!findBar || findBar.style.display === 'none') return
      if (findSyncRaf) return
      findSyncRaf = (window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16) })(function () {
        findSyncRaf = 0
        try { findRecollect() } catch (_) {}
      })
    } catch (_) {}
  }

  // 当前编辑区元素（模块级，Body 挂载时写进来 —— 老面板用的是 editorRef.current ✓）
  var liveEditor = null
  function editorEl() { return liveEditor }
  // 选中文字时那几个按钮该不该亮
  function updateSelFormats() {
    var out = { bold: false, italic: false, strikeThrough: false, underline: false, mark: false }
    try {
      out.bold = document.queryCommandState('bold')
      out.italic = document.queryCommandState('italic')
      out.strikeThrough = document.queryCommandState('strikeThrough')
      out.underline = document.queryCommandState('underline')
    } catch (_) {}
    try {
      var sel = document.getSelection()
      if (sel && sel.rangeCount) {
        var n = sel.getRangeAt(0).startContainer
        var el = (n && n.nodeType === 3) ? n.parentNode : n
        out.mark = !!(el && el.closest && el.closest('mark'))
      }
    } catch (_) {}
    return out
  }

  var selbar = null
  var savedRange = null
  var savedText = ''
  var listenersOn = false
  // 当前这篇文档的真实路径（建编辑区时交给 host，它按路径找回主文档）
  var lastAbsPath = ''
  // 路径来源诊断：只在路径变了时打一行 ✓（见 Body 里那段注释 ✓）
  var pathSaid = '\u0000未打过'

  function insideBody(node) {
    var el = (node && node.nodeType === 3) ? node.parentNode : node
    try { return !!(el && el.closest && el.closest('[data-ccv-md-body="1"]')) } catch (_) { return false }
  }

  function ensureSelbar() {
    if (selbar && selbar.parentNode) return selbar
    selbar = document.createElement('div')
    selbar.setAttribute('data-ccv-selbar', '1')
    // 样式只用主题令牌（技能要求：不许硬编码颜色，明暗主题都要能看）
    //
    // ⚠️ 背景**必须不透明**（2026-10-15 主人报"这个菜单是半透明的"）
    //   老面板用的是 `--dsw-alias-bg-overlay` + `backdrop-filter: blur(12px)` ✓
    //   —— 那是个**磨砂玻璃**效果：底色本来就是半透明的，靠模糊才好看 ✓
    //   我第一版把 backdrop-filter 漏了 ✗ → 半透明底色直接露出来 ✗
    //   主人要**不透明** ✓ → 换成 raised surface 的令牌（它是不透明的 ✓）：
    //     --dsw-alias-bg-layer-1  「Primary raised surface background」
    //   并且**不要** backdrop-filter ✓（加了反而会把它变回半透明观感 ✗）
    selbar.style.cssText = 'position:fixed;z-index:100000;display:none;align-items:center;gap:1px;'
      + 'width:max-content;max-width:none;flex-wrap:nowrap;flex-shrink:0;'
      + 'padding:3px 5px;border-radius:8px;'
      + 'background:var(--dsw-alias-bg-layer-1,#ffffff);'
      + 'color:var(--dsw-alias-label-primary,#1a1a1a);'
      + 'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));'
      + 'box-shadow:0 6px 20px rgba(0,0,0,.18);'
      + 'user-select:none;-webkit-user-select:none'
    // 按下时别让浏览器把选区弄塌（否则点按钮时选区已经没了）—— 老面板同款 ✓
    selbar.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation() })
    document.body.appendChild(selbar)
    return selbar
  }

  function hideSelbar() { if (selbar) selbar.style.display = 'none' }
  // 兼容旧名（别处还在调 hideAsk）
  function hideAsk() { hideSelbar() }

  function buildSelbar(rect) {
    var bar = ensureSelbar()
    // 先用「自然宽度」渲染（子项不收缩、文字不换行），渲染完再按实测尺寸定位。
    // 顺序很关键：先定位再渲染的话，栏会被挤窄 → 按钮收缩 → 带文字的按钮折行 ✗
    bar.style.left = '0px'; bar.style.top = '0px'
    bar.style.display = 'flex'
    bar.innerHTML = ''
    var fm = updateSelFormats(document.getSelection())
    SELBAR_ITEMS.forEach(function (item) {
      if (item.type === 'sep') {
        var sep = document.createElement('span')
        sep.style.cssText = 'width:1px;height:18px;background:rgba(128,128,128,.22);margin:0 3px;flex:0 0 auto'
        bar.appendChild(sep)
        return
      }
      var btn = document.createElement('button')
      btn.innerHTML = item.label
      btn.title = item.title || ''
      btn.style.cssText = 'padding:3px 7px;border:none;background:transparent;color:inherit;border-radius:6px;'
        + 'font-size:13px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;'
        + 'min-width:26px;height:26px;transition:background .1s ease;flex:0 0 auto;white-space:nowrap;line-height:1'
      btn.addEventListener('mouseenter', function () { if (!btn.dataset.active) btn.style.background = 'rgba(128,128,128,.12)' })
      btn.addEventListener('mouseleave', function () { if (!btn.dataset.active) btn.style.background = 'transparent' })
      // 选中态：灰色胶囊（不遮字、深浅主题都可读）—— 老面板同款 ✓
      var on = (item.cmd === 'bold' && fm.bold) || (item.cmd === 'italic' && fm.italic)
        || (item.cmd === 'strikeThrough' && fm.strikeThrough) || (item.cmd === 'underline' && fm.underline)
        || (item.cmd === 'highlight' && fm.mark)
        || (item.cmd === 'formatBlock' && fm.heading === 'h2')
      if (on) { btn.dataset.active = '1'; btn.style.background = 'rgba(128,128,128,.18)' }
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        if (item.isAskAI) { hideSelbar(); askAi(); return }
        // 下拉那三个（标题 / 对齐 / 更多）—— 老面板的 hasDropdown 分支 ✓
        if (item.hasDropdown) {
          restoreSelection()
          if (item.isHeading) showHeadingDropdown(btn)
          else if (item.showAlign) showAlignDropdown(btn)
          else if (item.showFullMenu) showFullMenu(btn)
          return
        }
        restoreSelection()                      // ★ 先把选区恢复回来（点按钮时已经塌了 ✗）
        // 诊断：点完把"命令 / 选区 / 结果 / 焦点"打进日志 ✓
        //   主人报过"点了没反应"和"焦点跳到聊天框" —— 焦点那一项就在这里看 ✓
        var whoBefore = (function () {
          try {
            var a = document.activeElement
            return a ? (a.tagName + (a.getAttribute && a.getAttribute('data-ccv-md-body') ? '#正文' : '') + (a.getAttribute && a.getAttribute('data-composer-input') ? '#聊天框' : '')) : '（无）'
          } catch (_) { return '?' }
        })()
        var diag = 'cmd=' + item.cmd + ' 选区=' + JSON.stringify(String(selectionText() || '').slice(0, 20)) + ' 点前焦点=' + whoBefore
        try {
          var handled = runCanvasCmd(item.cmd)
          diag += ' 自定义=' + handled
          if (!handled) {
            var ok = document.execCommand(item.cmd, false, item.val)
            diag += ' execCommand=' + ok
          }
          var ed = editorEl()
          if (ed) { try { ed.focus() } catch (_) {} }
          var whoAfter = (function () {
            try {
              var a = document.activeElement
              return a ? (a.tagName + (a.getAttribute && a.getAttribute('data-ccv-md-body') ? '#正文' : '') + (a.getAttribute && a.getAttribute('data-composer-input') ? '#聊天框' : '')) : '（无）'
            } catch (_) { return '?' }
          })()
          diag += ' 编辑区=' + (ed ? '有' : '空') + ' 点后焦点=' + whoAfter
        } catch (err) { diag += ' 抛错=' + (err && err.message) }
        log('划词栏点击：' + diag)
        hideSelbar()
      })
      bar.appendChild(btn)
    })
    // 渲染完再测量真实尺寸并定位：优先贴选区上方，放不下就挪到下方 ✓
    var bw = bar.offsetWidth || 300
    var bh = bar.offsetHeight || 32
    var x = Math.max(8, Math.min(rect.left, window.innerWidth - bw - 8))
    var y = rect.top - bh - 10
    if (y < 8) y = Math.min(rect.bottom + 10, window.innerHeight - bh - 8)
    bar.style.left = x + 'px'
    bar.style.top = y + 'px'
  }

  function onMouseUp(e) {
    try {
      // ★★ 点在**划词栏自己**上面 → 什么都别做（2026-10-15 修"按钮点了没反应"）
      //   老面板有一道一模一样的守卫（它的 globalMouseUp 里）：
      //       if (bar.contains(e.target)) return
      //   我第一版漏了 ✗ —— 于是：点按钮 → 选区已经塌了 → 下面"选区为空就藏栏" ✗
      //   → 栏在 click 事件之前就被藏掉 → 表现就是"按钮全都没反应" ✗✗
      if (e && e.target && e.target.closest && e.target.closest('[data-ccv-selbar]')) return
      var sel = document.getSelection()
      if (!sel || sel.rangeCount === 0) { hideSelbar(); return }
      var text = String(sel.toString() || '')
      if (!text.trim()) { hideSelbar(); return }
      if (!insideBody(sel.anchorNode) && !insideBody(sel.focusNode)) { hideSelbar(); return }
      var range = sel.getRangeAt(0)
      // ⚠️ 必须在**这一刻**存下来：点按钮之后选区可能已经塌了，那时再取就晚了
      savedRange = range.cloneRange()
      savedText = text
      buildSelbar(range.getBoundingClientRect())
    } catch (e2) { log('划词检测异常: ' + (e2 && e2.message)) }
  }

  function ensureListeners() {
    if (listenersOn) return
    listenersOn = true
    document.addEventListener('mouseup', onMouseUp, true)
    // ── 查找条：文档级快捷键 + "编辑区没了就收掉"（2026-10-17 D1）──
    //   ⚠️ 只在查找框开着时才起作用 ✓ 平时一个字都不影响 ✓
    document.addEventListener('keydown', findGlobalKey, true)
    //   ⚠️ 关侧栏时没有别的信号 ✗ → 借已有的高频事件顺手看一眼 ✓
    //     （selectionchange 是现成的 ✓ 而且这里只做一次极便宜的判断 ✓）
    document.addEventListener('resize', findHideIfEditorGone)
    // ── 表格工具条：光标动就同步一次（rAF 节流 ✓ selectionchange 触发非常频繁 ✗）──
    document.addEventListener('selectionchange', function () {
      // ★ 顺手把"最后已知的编辑状态"记到模块级 ✓
      //   （宿主会因文件变化重建我们的组件 ✗ 重建后靠它接回焦点与光标 ✓）
      //   ⚠️ 必须走**节流版** ✗✗ —— 2026-10-15 卡死事故：
      //      不节流 → 每敲一个字全文 TreeWalker → 十几万字文档卡死 DSH ✓
      noteLiveEditStateSoon()
      tableBarSyncSoon()
    })
    // 焦点进出也记一次 ✓（打字中途组件被重建时，光靠 selectionchange 可能来不及 ✓）
    document.addEventListener('focusin', function () { setTimeout(noteLiveEditState, 0) }, true)
    document.addEventListener('focusout', function () { setTimeout(noteLiveEditState, 0) }, true)
    document.addEventListener('mouseup', function (e) {
      var t2 = e.target
      if (t2 && t2.closest && (t2.closest('[data-ccv-tblbar]') || t2.closest('[data-ccv-md-body="1"]'))) { tableBarSyncSoon(); return }
      tableBarHide()
    }, true)
    document.addEventListener('mousedown', function (e) {
      var t = e.target
      // 点划词栏 / 表格工具条上的按钮不算"点别处"（否则会在 click 之前就被藏掉 ✗）
      if (t && t.closest && t.closest('[data-ccv-selbar]')) return
      if (t && t.closest && t.closest('[data-ccv-tblbar]')) return
      hideSelbar()
    }, true)
    window.addEventListener('scroll', hideAsk, true)
    // ── 关页 / 切走时立刻存（2026-10-11 加，自动保存的兜底）──────────
    // 为什么要两道：
    //   · beforeunload 是"最后机会"，但异步 fetch 在关页时**不保证发出去** ✗
    //   · visibilitychange → hidden 更可靠（切标签页、最小化都会触发 ✓）
    // 真正的防丢靠**草稿**（localStorage 是同步的 ✓ 一定能写进去 ✓）
    // ——这两道只是"尽量把改动落盘"✓ 不能当唯一保障 ✗
    try {
      window.addEventListener('beforeunload', function () { flushAllEdits() })
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flushAllEdits()
      })
    } catch (_) {}
    log('v' + VERSION + ' 划词「问AI」已装好')
  }

  // 把所有待保存的都立刻存一遍（关页/切走时用）
  function flushAllEdits() {
    try {
      for (var p in saveTimers) { if (saveTimers[p]) flushEdit(p) }
      for (var p2 in docStore) {
        var d = docStore[p2]
        if (d && d.dirty && !saveTimers[p2]) flushEdit(p2)
      }
    } catch (_) {}
  }

  // ─── 点了「问AI」────────────────────────────────────────────
  // 顺序一步都不能动（跟主模块 askAiFromSelection 一致）：
  //   ① capture 记一笔 —— 必须赶在输入框抢焦点之前，那之后浏览器选区就塌了
  //   ② 把焦点交回输入框 —— 胶囊是插进输入框的，官方那套照着"输入框当前状态"做版本比对
  //   ③ 请 selref 走官方两步（打开菜单 → 选中），成功的话输入框里直接出胶囊
  // ⚠️ 这里**故意不做**"整体重写草稿"那套兜底：草稿里已有胶囊时整体重写会毁掉
  //    主人前面所有引用（2026-09-15 立下的硬规矩）。失败就明说，让他再点一次。
  function askAi() {
    var text = savedText
    hideAsk()
    if (!text || !text.trim()) return
    var toast = function (m) {
      try { if (window.__ccvKit && window.__ccvKit.toast) window.__ccvKit.toast(m, 'ccv-viewer-ask') } catch (_) {}
    }
    var rec = null
    try { if (window.__ccvSelRefCapture) rec = window.__ccvSelRefCapture() } catch (_) {}

    // ── 建「选区编辑区」（实施步骤 1~3：建区 + 绑定 + 注入 + 拼接）──
    // 规格：canvas-docs/话布选区编辑区方案.md
    // ⚠️ **不在这里自己发请求** —— 建区的唯一实现在主模块（__ccvKit.createScratch），
    //    面板的划词栏走的是同一份。两条入口做同一件事，写两遍必然走偏 ✗
    //    （2026-10-11 主人报"我每次都是打开的老话布"：那时只有这边接了建区，
    //     从面板点「问AI」压根不建区 → 注入没有、拼接也不会发生 ✗）
    try {
      if (window.__ccvKit && typeof window.__ccvKit.createScratch === 'function') {
        window.__ccvKit.createScratch(rec)
      } else {
        log('建编辑区：主模块还没把 createScratch 借出来，跳过')
      }
    } catch (e) { log('建编辑区异常：' + (e && e.message)) }

    var input = document.querySelector('div[data-composer-input="true"]')
      || document.querySelector('[contenteditable="true"][role="textbox"]')
      || document.querySelector('textarea[placeholder*="发消息"]')
    if (input) { try { input.focus() } catch (_) {} }
    var auto = null
    if (rec) { try { if (window.__ccvSelRefAuto) auto = window.__ccvSelRefAuto(rec) } catch (_) {} }
    if (auto && typeof auto.then === 'function') {
      auto.then(function (ok) {
        if (!ok) toast('插入没成功 —— 请再点一次「问AI」')
      }).catch(function () { toast('插入失败（异常），请再点一次') })
    } else {
      toast('选区引用模块还没就绪，请稍后再试')
    }
  }

  var bodySaid = 0

  // ─── 一个小状态：正文 ↔ 工具栏（2026-10-11 加，编辑用）────────────
  // 为什么需要它：**正文和工具栏是两个独立组件** ✗（注册在两个不同的槽），
  // 而"保存"按钮必须跟着"有没有未保存的改动"变 ✓ —— 兄弟组件没法直接传 props ✗。
  // 所以就放一个最小订阅：path → { dirty, md, saved, ver }
  //   dirty  有没有未保存的改动（按钮亮不亮）
  //   md     编辑区当前序列化出来的 markdown（保存时要发它）
  //   saved  服务端给的原文（判断 dirty 的基准）
  //   ver    画布版本号（保存时当 knownVer 带上 → host 能检出并发冲突 ✓）
  //   override  撤销/重做**立刻**要显示的内容（见 Actions 里 doIt 的注释）
  //             查看器正文本来只认 props.content ✗，而那个要等文件监听才更新 ✗
  //             —— 有了 override 就能当场刷新 ✓ 等 props 追上来再丢掉 ✓
  var docStore = {}
  var docSubs = []
  // 草稿"每篇只检查一次"的闸（防止重挂载时把已经作废的草稿又恢复回来 ✗）
  var draftTried = {}
  // mdToHtml 结果缓存（键 = 路径 + 正文 ✓）—— 见 Body 里的注释 ✓
  var mdCache = { key: '', html: null }
  // Body 实例计数（诊断"是不是被重新挂载了"✗ 2026-10-15）
  //   主人报「保存后还是会闪，就像把页面刷新了一下」✓
  //   日志显示**同一个 renderSeq 重设了两次** ✗ → 说明组件 ref 被重置 ✗ → 重挂载 ✓
  //   重挂载 = 元素全新 = 就像刷新了一下 ✓✓ 与主人的描述完全对得上 ✓
  var bodyInstSeq = 0
  // 拖动期间被推迟的保存（只推迟、不丢弃 ✓）
  var saveRetryTimer = null
  // "我们自己刚写过的那份"（时间 + 文本）—— 用来识别 props 回传的**回声** ✓
  //   见采纳规则③的注释：不能只比文本 ✗ 文件监听回传常带格式规整 ✓
  var ownWriteAt = 0
  var ownWriteTxt = ''
  // 输入法是否正在组合（拼音还没上屏 ✓）—— 见 Body 里 onCompositionStart 的注释 ✓
  var composing = false
  function docNotify() {
    for (var i = 0; i < docSubs.length; i++) { try { docSubs[i]() } catch (_) {} }
  }
  function docGet(path) { return path ? (docStore[normPath(path)] || null) : null }  function docPatch(path, patch) {
    if (!path) return
    var k = normPath(path)
    var cur = docStore[k] || { dirty: false, md: '', saved: '', ver: 0, override: null, saving: false, id: '', buf: null, bufVer: '', renderSeq: 0 }
    for (var p in patch) { if (Object.prototype.hasOwnProperty.call(patch, p)) cur[p] = patch[p] }
    docStore[k] = cur
    docNotify()
  }
  // 订阅（用 useState 计数强制重渲染 —— 组件很小，不值得上外部状态库 ✓）
  function useDocStore(path, r) {
    var st = r.useState(0)
    var bump = st[1]
    r.useEffect(function () {
      var f = function () { bump(function (x) { return x + 1 }) }
      docSubs.push(f)
      return function () { var i = docSubs.indexOf(f); if (i >= 0) docSubs.splice(i, 1) }
    }, [path])
    return docGet(path)
  }

  // ─── 保存 / 自动保存（2026-10-11 加，照成熟文档软件的做法）──────────
  // 成熟软件（Google Docs / Notion / VS Code / Obsidian）的共同做法：
  //   自动保存（防抖 + 失焦）+ 可见的保存状态 + 版本历史 + 本地草稿兜底。
  // 我们四样都有底气做，因为：
  //   · 版本历史 —— 画布本来就有撤销栈 ✓ 而且刚加了"连续编辑合并成一步" ✓
  //     （没有那一步，自动保存会把撤销栈冲爆 ✗ 按一次撤销只退一小步 ✗）
  //   · 本地草稿 —— 面板早就有 ✓ 借出来共用 ✓
  //   · 冲突保护 —— knownVer ✓ + "有未保存改动就不覆盖正文" ✓
  // ★★ 保存频率（2026-10-17 重新定）★★
  //   主人问：「别的软件真的有那么频繁的自动保存吗」
  //   **没有** ✗ —— 成熟软件不是这么干的：
  //     VS Code     默认【关闭】自动保存 ✓ 开了也只是写文件 ✓ 编辑器毫无感觉 ✗
  //     Google Docs 每敲一个字发 op ✓ 频率更高 ✓ 但服务端【只回 ack】✗ 从不回灌整篇 ✓
  //     Obsidian    停手 ~2 秒写文件 ✓ 编辑器不受影响 ✓
  //   → 频率不是问题 ✓ **"保存之后宿主会重建我们的组件"才是** ✗
  //     文件一变 → DSH 文档预览重建组件 ✗ → 内容当 prop 回灌 → 重设 DOM → 闪 ✓
  //   → 在根治那条之前，**把保存频率降下来** ✓ 闪烁次数直接从"每 1.5 秒"掉一个数量级 ✓
  //
  //   新的分工（成熟软件也是这个分工 ✓）：
  //     · 草稿（localStorage ✓ 不碰文件 ✓ 不影响界面 ✓）→ 勤一点 ✓ 防丢 ✓
  //     · 写盘（会触发宿主重建 ✗）→ **懒一点** ✓ 只在"真的要离开这段输入"时写 ✓
  //     · 失焦 / Ctrl+S / 切换文档 → **立刻写** ✓（这些时机本来就是"要走了"✓）
  // ⚠️ 2026-10-29 主人：「现在还有自动保存吗，自动保存又打断了我的操作」
  //   机制说清楚：**写盘会改磁盘文件** → 宿主监听到 → 重建这个组件 ✗
  //     → 编辑区 innerHTML 被重设 → 光标/选区被抢 → 这就是"打断" ✓
  //   这个重建在客户端**没法规避** ✗ 所以只能少写盘 ✓
  //   策略（成熟做法：草稿勤快、落盘保守）：
  //     · 草稿每 800ms 写 localStorage ✓ 无副作用、不打断 ✓ 崩了能恢复 ✓
  //     · 真正落盘：**停手 20 秒**才写一次 ✓（原来 5 秒 ✗ 太勤）
  //     · 离开编辑区（失焦）/ 切后台 / 关页 → 立刻落盘 ✓
  //     · Ctrl+S / 点保存按钮 → 立刻落盘 ✓
  var AUTOSAVE_MS = 20000    // 停手 20 秒才写盘（2026-10-29 由 5 秒放宽）
  var DRAFT_MS = 800         // 草稿照旧勤快 ✓ 它只写 localStorage ✓ 没有任何副作用 ✓
  // ★ "你最后敲键盘是什么时候"（2026-10-17 加）★
  //   写盘前要靠它确认"你现在没在打字"✗ —— 见 saveDoc 里那条跳过 ✓
  //   为什么必须有：主人点出「卡着第五秒打字」那个窗口 ✗
  //     计时器到点、请求在路上，你恰好又开始打字 → 闪就落在你手上 ✓
  var lastInputAt = 0
  var saveTimers = {}
  var draftTimers = {}
  function toastOn(msg) {
    try { if (window.__ccvKit && window.__ccvKit.toast) window.__ccvKit.toast(msg, 'ccv-viewer-save') } catch (_) {}
  }

  // 真正写盘。opts.manual = 人点的（要提示 ✓）/ 自动保存（安静 ✓ 只在失败时说话 ✓）
  function saveDoc(path, opts) {
    opts = opts || {}
    // ★★★ 最要紧的一条：**你正在打字就不要写盘** ★★★（2026-10-17 主人点出来的）
    //   主人原话：「只在失焦保存，我要是卡着第五秒打字，还是有问题」
    //   他说得对 ✗ —— 任何**定时**写盘都可能正好落在你打字中间 ✓
    //     定时器到点 → 发保存 → 文件变 → 宿主重建组件 ✗ → 闪 ✓ → 打断你 ✓
    //   而"重置计时器"挡不住这个：计时器**已经到点、请求正在路上**那一瞬间，
    //   你恰好又开始打字了 ✗
    //   做法：**发之前再确认一次** ✓
    //     · 最近 1.2 秒内有输入 → **跳过这次** ✗（不是重排 ✗✗ 不会循环 ✓）
    //     · 跳过是安全的：你继续打字 → 计时器会重新排 ✓
    //                      你停手 → 下一次到点就会存 ✓
    //                      你走开（失焦）→ 立刻存 ✓
    //                      而且**草稿 800ms 就写好了** ✓ 一个字都不会丢 ✓
    //   ⚠️ 手动（Ctrl+S / 按钮）不受这条限制 ✓ —— 那是你明确要求的 ✓
    //   ⚠️ 2026-10-29：窗口从 1.2 秒放宽到 **3 秒** ✓ 并把"人还停在编辑区里"也算进来 ✓
    //      理由：主人报「自动保存又打断了我的操作」——
    //        写盘 → 宿主重建组件 → 光标被抢 ✓
    //        只要人还在这个文档里、且最近 3 秒动过，就不要写盘 ✓
    //      （草稿 800ms 已经在 localStorage 里 ✓ 一个字都不会丢 ✓）
    var ae = null
    try { ae = document.activeElement } catch (_) {}
    var stillInEditor = false
    try { stillInEditor = !!(ae && ae.closest && ae.closest('[data-ccv-md-body="1"]')) } catch (_) {}
    if (!opts.manual && ((lastInputAt && (Date.now() - lastInputAt) < 3000) || (stillInEditor && (Date.now() - lastInputAt) < 8000))) {
      log('刚还在打字（' + (Date.now() - lastInputAt) + 'ms 前）→ 这次自动保存跳过 ✓'
        + '（继续打字会重排 ✓ 停手会存 ✓ 走开会立刻存 ✓ 草稿已保住 ✓）')
      docPatch(path, { saving: false })
      return
    }
    // ★★ 正在拖表格列宽/行高时**不要保存**（2026-10-15）★★
    //   主人报"自动保存会卡我拉表格" ✓ 链条是：
    //     保存 → docPatch → docNotify → Body 重渲染 ✗（+ 网络请求 ✓）
    //     你正拉着表格 → 正好撞上 = 一卡 ✓
    //   做法：**推迟到拖完** ✓（300ms 后再试一次 ✓ 拖动中就一直往后推 ✓）
    //   ⚠️ 只推迟、**不丢弃** ✗ —— 拖完那一帧照样会 fireInput → 自动保存排上 ✓
    if (typeof tableDragging !== 'undefined' && tableDragging) {
      log('正在拖表格 → 这次保存推迟（' + (opts.manual ? '手动' : '自动') + '）')
      if (saveRetryTimer) clearTimeout(saveRetryTimer)
      saveRetryTimer = setTimeout(function () { saveRetryTimer = null; saveDoc(path, opts) }, 300)
      return
    }
    // ★★ 输入法正在组合时也不要保存（2026-10-15）★★
    //   主人报「打一长串拼音还没选字，自动保存就打断我」——
    //   保存回来会 docPatch → 重渲染 ✗ 而重设 innerHTML 会**打断输入法组合** ✗✗
    //   （组合期间我们本来就不标脏、不排保存 ✓ 这道是兜住"组合开始前就排上的那一次" ✓）
    //
    // ⚠️⚠️ 2026-10-17 事故：这里原来会**每 400 毫秒自我重排一次** ✗✗
    //   主人现场：打一行字 → 停手（自动保存排上）→ 再打第二行（还在拼音里）→
    //   日志刷出成百上千行「输入法组合中 → 这次保存推迟」✗
    //   （13:01:43 → 13:01:53 每 400ms 一条 ✓）
    //   → 日志是**每行一次 POST** ✗ → 浏览器与服务端被淹 ✓ → **页面崩掉刷新** ✗✗
    //   → 拼音里还没上屏的内容**全丢** ✓✓
    //   修：**只推迟、不自我重排** ✗
    //     组合结束时 onCompositionEnd 会调 handleEditInput() ✓ → 它会重新排保存 ✓
    //     （所以不会漏存 ✓ 只是把"重排"这件事交给组合结束 ✓）
    if (composing) {
      log('输入法组合中 → 这次保存跳过（组合结束会自己再排一次 ✓ 不再自我重排 ✗）')
      docPatch(path, { saving: false })
      return
    }
    var d = docGet(path)
    var id = (d && d.id) || ''
    if (!id) { if (opts.manual) toastOn('这份文件不是话布，存不了'); return }
    if (!d || !d.dirty) { if (opts.manual) toastOn('没有改动要保存'); return }
    if (d.saving) return
    docPatch(path, { saving: true })
    var mdToSave = d.md
    // ★★★ 绝不允许把文档写成空的（2026-10-15，主人现场「文档变空白了」）★★★
    //   链路：客户端某个时刻 md 变成 '' ✗ → 自动保存把它写进服务端 ✗✗
    //        → 历史里留下一条 after='' 的条目 ✗ → 之后点【重做】把 '' 写回 → 空白 ✓
    //   ⚠️ 判据必须用**编辑区的真实内容**（DOM 才是真相 ✓）而不是 d.md ✗
    //      —— 否则"主人真的全选删掉"这种**合法**操作也会被拦 ✗
    //   规则：要保存的是空的、但**编辑区里明明还有字** → 状态机错乱 → 拒绝保存 ✓
    //         （编辑区也是空的 → 那是主人真的要清空 → 照常保存 ✓）
    var domNow = ''
    try { domNow = liveEditor ? String(window.__ccvKit.htmlToMd(liveEditor) || '') : '' } catch (_) {}
    if (!mdToSave && domNow) {
      log('拒绝保存空内容（要存的是空的，但编辑区里还有 ' + domNow.length + ' 字 ✗ 状态机错乱）')
      docPatch(path, { saving: false })
      return
    }
    try {
      fetch('/api/canvas/write', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, content: mdToSave, knownVer: d.ver }),
      }).then(function (x) { return x.json() })
        .then(function (res) {
          log((opts.manual ? '保存（手动）' : '自动保存') + ' → ' + JSON.stringify(res))
          if (!res || !res.ok) {
            docPatch(path, { saving: false })
            // ── 版本冲突：单独认出来，说清楚 ✓（2026-10-15）──────────────
            //   服务端的冲突响应是 {"ok":false,"conflict":true,"currentVersion":N,
            //   "currentContent":"…"} —— **没有 error 字段** ✗
            //   而原来那句 `res.error || '服务端没响应'` 会把真实原因**盖住** ✗✗
            //   （主人 2026-10-15 报"所有操作都弹保存失败：服务端无响应"，
            //     真相是版本冲突 —— 日志里 res 明明白白写着 conflict:true ✓）
            if (res && res.conflict) {
              var cur = (typeof res.currentVersion === 'number') ? res.currentVersion : '?'
              log('保存冲突：本地 v' + d.ver + ' / 服务端 v' + cur
                + '（文档在别处被改过 ✓ 服务端把最新内容也给了 ✓ 不许静默覆盖 ✗）')
              // ★★ 关键：把版本对齐到服务端，否则**永远**冲突（死锁 ✗✗）★★
              //   内容与 dirty 都不动 ✓（用户的改动一点不丢 ✓）
              //   对齐之后下一次自动保存就能写进去 ✓
              //   —— 但**不能默默覆盖** ✗ 所以提示里把"会写回/会覆盖"说清楚 ✓
              docPatch(path, {
                ver: (typeof res.currentVersion === 'number') ? res.currentVersion : d.ver,
                conflict: { ver: cur, content: res.currentContent },
              })
              toastOn('文档已被别处改动（本地 v' + d.ver + ' / 服务端 v' + cur
                + '）—— 已对齐版本，你的改动会写回（会覆盖服务端那版）')
              return
            }
            // 其它拒绝：把服务端原样返回的东西打出来 ✓（别用兜底话盖住真实原因 ✗）
            var why = (res && (res.error || res.message || res.reason)) || ''
            if (!why && res) { try { why = JSON.stringify(res).slice(0, 200) } catch (_) { why = '' } }
            log('保存被拒绝：' + (why || '（服务端没给原因）') + '  knownVer=' + d.ver)
            toastOn('保存失败：' + (why || '服务端没给原因（见日志）'))
            return
          }
          docPatch(path, {
            saving: false, dirty: false, saved: mdToSave,
            ver: (typeof res.version === 'number') ? res.version : d.ver,
            // ★★ 必须把 canUndo/canRedo 也更新掉（2026-10-15，主人问"保存是不是导致撤销历史为空"）★★
            //   服务端每次都回这两个字段 ✓ 而这里原来只更新 saving/dirty/saved/ver ✗
            //   → 保存之后 canUndo 还停在旧值（多半是 false ✗）
            //   → Ctrl+Z 判定"画布没得撤" → 交给浏览器原生 ✓
            //   → 而保存回声会让 React 重设 innerHTML ✗ → **原生撤销栈被清空** ✗✗
            //   → 结果：按 Ctrl+Z 什么都不发生 = 主人说的"撤销历史为空" ✓
            canUndo: (typeof res.canUndo === 'boolean') ? res.canUndo : true,
            canRedo: !!res.canRedo,
            // 记下"这份是我们自己刚写进去的" ✓ —— 采纳规则③靠它认出 props 的回声 ✓
            justSaved: mdToSave,
          })
          // ★ 同时记进模块级（时间 + 文本）✓
          //   规则③不能只比文本 ✗ —— 文件监听回传常带格式规整（尾换行等 ✓）
          //   文本对不上就会被当外部改动 → renderSeq +1 → 整篇重设 → 闪一下 + 丢焦点 ✗✗
          //   （2026-10-15 主人现场「保存后还是会闪，就像刷新了一下」✓）
          ownWriteAt = Date.now()
          ownWriteTxt = mdToSave
          // 草稿功成身退（内容已经落盘 ✓）
          try { if (window.__ccvKit && window.__ccvKit.draftDropIf) window.__ccvKit.draftDropIf(id, mdToSave) } catch (_) {}
          if (opts.manual) toastOn('已保存 ✓')
        })
        .catch(function (e) {
          docPatch(path, { saving: false })
          toastOn('保存失败：' + (e && e.message))
        })
    } catch (e) {
      docPatch(path, { saving: false })
      toastOn('保存失败：' + (e && e.message))
    }
  }

  // 打字之后：先存草稿（快 ✓ 防丢），再排一次自动保存（慢一点 ✓ 写盘）
  function afterEdit(path, md, id, ver) {
    if (draftTimers[path]) clearTimeout(draftTimers[path])
    draftTimers[path] = setTimeout(function () {
      draftTimers[path] = null
      try { if (window.__ccvKit && window.__ccvKit.draftSet) window.__ccvKit.draftSet(id, md, ver) } catch (_) {}
    }, DRAFT_MS)
    if (saveTimers[path]) clearTimeout(saveTimers[path])
    saveTimers[path] = setTimeout(function () {
      saveTimers[path] = null
      saveDoc(path, { manual: false })
    }, AUTOSAVE_MS)
  }
  // 失焦 / 关页时立刻存（成熟软件都这么做 ✓ 别让最后一段输入卡在防抖里 ✗）
  function flushEdit(path) {
    if (saveTimers[path]) { clearTimeout(saveTimers[path]); saveTimers[path] = null }
    saveDoc(path, { manual: false })
  }

  // ★★ 离开页面 / 切到后台 → 立刻存一次（2026-10-17 加）★★
  //   为什么必须有：自动保存改成 5 秒之后 ✓ 万一你正好在这 5 秒里切走/关页 ✗
  //   成熟软件（VS Code / Obsidian / 飞书）都有这一手 ✓
  //   两条通道，各管一段：
  //     · visibilitychange（切到后台 ✓）→ **写盘 + 草稿** ✓（fetch 还来得及发出去 ✓）
  //     · beforeunload（真关页 ✗）→ **只写草稿** ✓
  //         （localStorage 是同步的 ✓ 可靠 ✓；fetch 在关页时可能被丢掉 ✗ 不能指望 ✓）
  function flushAllDrafts() {
    try {
      var n = 0
      for (var k in docStore) {
        var d = docStore[k]
        if (!d || !d.id || !d.dirty) continue
        try {
          if (window.__ccvKit && window.__ccvKit.draftSet) {
            window.__ccvKit.draftSet(d.id, d.md || '', d.ver || 0)
            n++
          }
        } catch (_) {}
      }
      if (n) log('离开前把 ' + n + ' 篇未保存的改动写进草稿 ✓（localStorage ✓ 同步可靠 ✓）')
    } catch (_) {}
  }
  function flushAllSaves() {
    try {
      for (var k in docStore) {
        var d = docStore[k]
        if (!d || !d.id || !d.dirty) continue
        flushEdit(k)      // 立刻写盘 ✓（走 saveDoc ✓ 有冲突保护 ✓）
      }
    } catch (_) {}
  }
  try {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { flushAllDrafts(); flushAllSaves() }
    })
    window.addEventListener('beforeunload', function () { flushAllDrafts() })
  } catch (_) {}

  // ─── 编辑区快捷键（2026-10-15 加）────────────────────────────
  // 老画布面板有一套（随面板删了 ✗），查看器这版原来**一个都没有** ✗ ——
  // 而写 markdown 的人每天都在按 Ctrl+B，没有就是"手感不对" ✗
  //
  // 用 document.execCommand：它虽然被标为废弃 ✗，但**是 contentEditable 上唯一
  // 能保留选区**的做法 ✓（手动改 DOM 会把光标弄丢 ✗）。而且它改完会**自动触发 input 事件** ✓
  // → 上面那条 onInput 的脏标记/自动保存/草稿全都自动接上 ✓ 不用另接一套 ✓
  function onEditKeyDown(e, path) {
    try {
      if (!e) return
      var mod = !!(e.ctrlKey || e.metaKey)
      var k = String(e.key || '')

      // ── Ctrl+S：拦掉浏览器的"保存网页"对话框，改成存话布 ✓✓
      //    这个最烦：写文档的人习惯性按 Ctrl+S，弹出来的却是"另存为" ✗
      if (mod && (k === 's' || k === 'S')) {
        e.preventDefault()
        if (saveTimers[path]) { clearTimeout(saveTimers[path]); saveTimers[path] = null }
        var d = docGet(path)
        if (d && d.dirty) { saveDoc(path, { manual: true }) } else { toastOn('没有改动要保存') }
        return
      }

      if (!mod) {
        // ── Tab / Shift+Tab ──
        //   ① 在**表格单元格**里 → 跳到下一个/上一个单元格 ✓（Word / 飞书 / Google Docs 都这样）
        //      到最后一个单元格再按 Tab → **自动加一行** ✓（Word 的行为）
        //   ② 不在表格里 → 插两个空格当缩进（不用 execCommand('indent')，那个会插 blockquote ✗）
        if (k === 'Tab') {
          e.preventDefault()
          if (cellOf()) { moveCell(e.shiftKey); return }
          try { document.execCommand('insertText', false, '  ') } catch (_) {}
        }
        return
      }

      var low = k.toLowerCase()
      // ── Ctrl+F：打开查找 / 替换（D1 · 2026-10-17）──
      //   浏览器自己的 Ctrl+F 是"找网页文字"✗ 在我们的编辑器里没用 ✓
      //   （它找不到 contentEditable 里你想要的"下一处"手感 ✓ 也没法替换 ✓）
      if (low === 'f') {
        e.preventDefault()
        findShow(path)
        return
      }
      // ── Esc：关掉查找条（顺手也关掉别的浮层 ✓）──
      if (k === 'Escape' || k === 'Esc') {
        try {
          if (findBar && findBar.style.display !== 'none') { e.preventDefault(); findHide(); return }
        } catch (_) {}
      }
      // ── Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y：老面板的做法（阶段 5 搬过来的 ✓）──
      //   本地有没保存的编辑 → 交给浏览器原生撤销 ✓
      //   本地是干净的（比如刚被 AI 改过）→ 走**画布撤销** ✓ 这样 Ctrl+Z 能退掉 AI 的改动 ✓
      //
      // ⚠️ 2026-10-15 修一个真 bug（主人问"只有撤销的快捷键没有重做的吗"）：
      //   原条件只看"本地是否干净" ✗ 于是：
      //     格式化一下（本地变脏）→ Ctrl+Z（原生撤销 ✓ 回到基准 ✓）
      //     → 再按 Ctrl+Y → 此时本地"看起来干净" → **被我们接管** ✗
      //     → 而画布的重做栈是空的（原生那次撤销没进画布历史 ✗）→ noop ✗
      //     → 表现就是「重做没反应」✗✗（浏览器的原生重做被我们挡住了 ✓）
      //   修法：**画布没有可撤销/可重做的，就别抢** ✓ 交给浏览器原生 ✓
      if (low === 'z' || low === 'y') {
        var isRedo = (low === 'y') || (low === 'z' && e.shiftKey)
        var d0 = docGet(path)
        // ★ 判据（2026-10-29 主人：「怎么没有撤回了」）★
        //   原来有一条 `if (d0 && d0.dirty) return` ✗ —— "有未保存改动就交给浏览器原生"
        //   但原生撤销栈在**保存往返后经常是空的** ✗
        //   而自动保存刚放宽到 20 秒 → dirty 长时间为真 ✗
        //   → 每次 Ctrl+Z 都交给原生 → 原生没得撤 → **就是"按了没反应"** ✓✓
        //   现在改成"服务端优先"：
        //     ① 未保存的改动**只写草稿**（不落盘 ✗ —— 落盘会清空服务端的重做栈 ✓✓）
        //        这就是"撤销后不能重做"的真正原因：我上一版在这里先 flushEdit（保存）
        //        而宿主的写盘逻辑会把 redoStack 清空 ✓ → 重做永远 noop ✓
        //     ② 再让服务端撤销/重做（它有真实历史栈，含 AI 改动）
        //     ③ 服务端回 noop（真没得撤）→ 再回退到浏览器原生 ✓
        if (d0 && d0.dirty) {
          try {
            if (window.__ccvKit && window.__ccvKit.draftSet) {
              window.__ccvKit.draftSet(d0.id, String(d0.buf || d0.md || ''), d0.ver)
            }
          } catch (_) {}
        }
        e.preventDefault()
        var id0 = (d0 && d0.id) || ''
        if (!id0) { try { document.execCommand(isRedo ? 'redo' : 'undo') } catch (_) {} ; return }
        try {
          fetch('/api/canvas/' + (isRedo ? 'redo' : 'undo'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id0 }),
          }).then(function (x) { return x.json() }).then(function (dd) {
            log('快捷键 ' + (isRedo ? '重做' : '撤销') + ' → ' + JSON.stringify(dd).slice(0, 160))
            if (dd && dd.ok) {
              // 服务端每次都回 canUndo/canRedo ✓ 拿它更新本地状态（否则快捷键会一直判错 ✗）
              var patch0 = { canUndo: !!dd.canUndo, canRedo: !!dd.canRedo }
              // ★★★ 不许把正文改成空 ✗✗（2026-10-15 主人现场：点重做 → 文档空白）★★★
              //   宿主历史里如果有一条 after='' 的坏条目 ✓ 重做就会把 '' 写回 ✗
              //   判据：返回的是空串、而我们手上明明有内容 → **拒绝采用** ✓
              //   （这是最后一道闸 ✓ 宁可"没反应"，也绝不清空文档 ✗）
              var newTxt = (typeof dd.content === 'string') ? dd.content : null
              var haveTxt = String((d0 && (d0.buf || d0.md || d0.saved)) || '').length
              if (newTxt !== null && newTxt.length === 0 && haveTxt > 0) {
                log('撤销/重做返回了空内容 → 拒绝采用（手上还有 ' + haveTxt + ' 字 ✗ 避免清空文档）')
                newTxt = null
                toastOn('这次' + (isRedo ? '重做' : '撤销') + '会清空文档，已拒绝 —— 内容还在 ✓')
              }
              // noop = 没得撤/没得重做 ✓ 正文本来就对 ✓ 别去动它 ✗
              // ⚠️ 2026-10-29：服务端说 noop 时**回退到浏览器原生** ✓
              //   以前直接 toast 就完了 ✗ 而原生栈里可能还有条目 ✓
              //   （这也是"服务端优先 + 原生兜底"的另一半 ✓）
              if (dd.noop) {
                newTxt = null
                try { document.execCommand(isRedo ? 'redo' : 'undo') } catch (_) {}
              }
              if (newTxt !== null) {
                patch0.override = newTxt
                patch0.saved = newTxt
                patch0.md = newTxt
                patch0.dirty = false
                // ★ 缓冲也要跟着走 ✓ 而且**必须 +1 renderSeq** ✓
                //   —— 撤销/重做是"内容来自外部"的入口之一 ✓ 不 +1 的话正文不会更新 ✗
                patch0.buf = newTxt
                patch0.renderSeq = ((d0 && d0.renderSeq) || 0) + 1
              }
              docPatch(path, patch0)
              if (!dd.ok) toastOn('操作失败（见日志）')
            } else { toastOn('操作失败（见日志）') }
          }).catch(function () {})
        } catch (_) {}
        return
      }
      // ── Ctrl+B 加粗 / Ctrl+I 斜体 ──
      if (low === 'b') { e.preventDefault(); try { document.execCommand('bold') } catch (_) {} return }
      if (low === 'i') { e.preventDefault(); try { document.execCommand('italic') } catch (_) {} return }
      // ── Ctrl+` 行内代码（execCommand 没有 code 这个命令 → 自己包一层 ✓）──
      if (k === '`' || k === '~') {
        e.preventDefault()
        try {
          var sel = String(window.getSelection ? window.getSelection().toString() : '')
          var esc = sel.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          document.execCommand('insertHTML', false, '<code>' + esc + '</code>')
        } catch (_) {}
        return
      }
      // ── Ctrl+K 链接 ──
      if (low === 'k') {
        e.preventDefault()
        try {
          var sel2 = String(window.getSelection ? window.getSelection().toString() : '')
          var url = window.prompt('链接地址（留空则只保留选中的文字）', 'https://')
          if (url === null) return
          var text = sel2 || url
          var href = (url && url !== 'https://') ? url : text
          document.execCommand('insertHTML', false,
            '<a href="' + href.replace(/"/g, '&quot;') + '">' + text.replace(/</g, '&lt;') + '</a>')
        } catch (_) {}
        return
      }
    } catch (err) { log('快捷键出错: ' + (err && err.message)) }
  }

  // ─── 正文组件 ──────────────────────────────────────────────
  // ⚠️ hooks 必须**无条件、最前面**调用 —— 所以外层只管取 React，内层才是真组件。
  function Body(props) {
    var r = ensureR()
    if (!r) return null
    return BodyInner(props, r)
  }

  function BodyInner(props, r) {
    var h = r.createElement

    // ── hooks（无条件）──
    // ★ 卸载时：编辑区真的没了就把查找条收掉 ✓（2026-10-17 D1）★
    //   主人报：「搜索窗口在我关了侧栏后还存在」✗
    //   为什么不能"一卸载就收"✗：宿主**每次保存都会重建这个组件** ✓
    //     那样你正在搜索时查找框会突然消失 ✓
    //   → 交给 findHideIfEditorGone：**等一拍**再看编辑区还在不在文档里 ✓
    //     重挂载 → 新编辑区还在 ✓ 不收 ✓
    //     真关闭（侧栏关了）→ 编辑区没了 ✓ 收 ✓
    r.useEffect(function () {
      return function () { findHideIfEditorGone() }
    }, [])
    // ★ 目录：订阅工具栏的开关 + 扫标题 + 滚动高亮（2026-10-24）★
    //   ⚠️ 依赖数组必须是 [] ✗ 否则每次内容变化都重新绑一次 scroll ✓ 又卡又抖 ✓
    r.useEffect(function () {
      var refresh = function () {
        try {
          var out = buildOutline(edRef.current)
          setOutline(out)
          setActIdx(tocActiveIndex(edRef.current, out))
        } catch (_) {}
      }
      tocRefreshFn = refresh
      var onNav = function () {
        setTocOn(navOpen)
        if (navOpen) refresh()
      }
      navSubs.push(onNav)
      if (navOpen) refresh()          // 重建后（宿主保存会重建）恢复目录内容 ✓
      // 滚动高亮：rAF 节流 + 只读位置 ✓
      var ed0 = null
      var raf = 0
      var onScroll = function () {
        try {
          if (raf) return
          raf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16) })(function () {
            raf = 0
            try {
              if (!navOpen) return
              var ix = tocActiveIndex(edRef.current, outlineRef.current)
              setActIdx(function (prev) { return prev === ix ? prev : ix })
            } catch (_) {}
          })
        } catch (_) {}
      }
      // 监听**正文自己**（它是滚动容器 ✓）
      var t = setTimeout(function () {
        try {
          ed0 = edRef.current
          if (ed0) ed0.addEventListener('scroll', onScroll, { passive: true })
        } catch (_) {}
      }, 0)
      return function () {
        try { tocRefreshFn = null } catch (_) {}
        var i = navSubs.indexOf(onNav)
        if (i >= 0) navSubs.splice(i, 1)
        clearTimeout(t)
        try { if (ed0) ed0.removeEventListener('scroll', onScroll) } catch (_) {}
      }
    }, [])
    r.useEffect(function () {
      outlineRef.current = outline
    }, [outline])
    // ★ 量容器尺寸 → 决定停靠还是浮层（2026-10-24）★
    //   ResizeObserver 盯着外层（正文的父级 = 我们那个 shell ✓）
    //   ⚠️ 只在**模式真的变了**才 setState ✗（否则每次改尺寸都重渲染 → 卡）
    r.useEffect(function () {
      var ro = null
      var last = null
      var measure = function () {
        try {
          var ed = edRef.current
          var shell = ed && ed.parentElement
          if (!shell) return
          var w = shell.clientWidth || 0
          var h = shell.clientHeight || 0
          if (w < 60 || h < 60) return
          var d = (w >= h)                 // 宽 ≥ 高 → 停靠 ✓
          if (last === d) return
          if (last !== null) log('目录：' + (d ? '停靠' : '浮层') + '（容器 ' + w + '×' + h + '）')
          last = d
          setDocked(d)
          // ★ 诊断：把【实际生效】的内距打出来（2026-10-25 主人：「这边距哪里改好了」）★
          //   只打一次，能一眼看出 CSS 到底有没有生效 ✓ 不用再猜 ✗
          try {
            var cs = window.getComputedStyle(ed)
            log('正文内距实际值：left=' + cs.paddingLeft + ' right=' + cs.paddingRight
              + '｜容器 ' + w + '×' + h + '｜模式=' + (d ? '停靠' : '浮层'))
          } catch (_) {}
        } catch (_) {}
      }
      var t = setTimeout(measure, 0)
      try {
        if (window.ResizeObserver) {
          ro = new window.ResizeObserver(function () { measure() })
          var ed0 = edRef.current
          if (ed0 && ed0.parentElement) ro.observe(ed0.parentElement)
        }
      } catch (_) {}
      return function () {
        clearTimeout(t)
        try { if (ro) ro.disconnect() } catch (_) {}
      }
    }, [])
    var inputState = null
    try { inputState = props.useInput ? props.useInput(function (s) { return s }) : null } catch (_) {}
    var fileInfo = null
    try { fileInfo = props.useResource ? props.useResource(props.resourceAddress) : null } catch (_) {}
    // ─── 文档路径：三级来源（2026-10-15 修「这份文件不是话布，存不了」）──────
    //   主人报：**在独立标签页里**打开话布 → 弹「这份文件不是话布，存不了」✗
    //   原因：Body 原来只认 useResource(...).value.absolutePath ✗
    //         而**标签页里这个 hook 给不出 absolutePath** ✗
    //         （lastAbsPath 那条路也不行 ✗ —— 它由 Actions 组件留下，
    //           而 Actions 注册在 sidebar.right.tab.document.actions，
    //           **标签页里根本没有那个 slot** ✗）
    //   → absPath = '' → docPatch('') 直接 return → store 里没有 id ✗ → 存不了 ✓
    //   修：三级兜底 ✓ 并把**实际用的是哪条**打进日志 ✓（下次一眼定位 ✓）
    var absPath = ''
    var absFrom = ''
    try {
      var fv = fileInfo && fileInfo.value
      if (fv && fv.absolutePath) { absPath = fv.absolutePath; absFrom = 'useResource.absolutePath' }
      else if (fv && typeof fv === 'string') { absPath = fv; absFrom = 'useResource(字符串)' }
      else if (fv && fv.path) { absPath = fv.path; absFrom = 'useResource.path' }
    } catch (_) {}
    if (!absPath) {
      var ra = props && props.resourceAddress
      if (typeof ra === 'string' && ra) {
        var cand = ra.replace(/^file:\/\/\/?/, '')
        try { cand = decodeURIComponent(cand) } catch (_) {}
        if (cand) { absPath = cand; absFrom = 'props.resourceAddress' }
      }
    }
    if (!absPath && lastAbsPath) { absPath = lastAbsPath; absFrom = 'lastAbsPath（Actions 留下的）' }
    if (absPath !== pathSaid) {
      pathSaid = absPath
      log('本页文档路径 = ' + JSON.stringify(absPath) + ' ｜ 来源 = ' + (absFrom || '（一条都没拿到 ✗）')
        + ' ｜ resourceAddress = ' + JSON.stringify(props && props.resourceAddress)
        + ' ｜ fileInfo.value 键 = ' + (function () {
          try { var fv2 = fileInfo && fileInfo.value; return fv2 ? Object.keys(fv2).join(',') : '（空）' } catch (_) { return '?' }
        })())
      // ⚠️ 2026-10-24：这里原来会登记 window.__ccvResourceTemplate ✗
      //   那是给"右侧栏清单点一下跳文档"用的 ✓ 但它有**先有鸡还是先有蛋**的问题 ✗：
      //     没打开过任何文档 → 模板永远没有 → 清单永远点不动 ✓（日志实证 ✓）
      //   → 现已改成主模块**自己拼地址** ✓（照官方 fileAddressFor 算法 ✓
      //     见 src/client/editor-panel.js 的 ccvSessionFileAddress ✓）
      //   → 这段登记**不再需要** ✗ 删掉少一处状态 ✓ 少一处错 ✓
    }

    // ── 编辑用的 refs（无条件声明 ✓ hooks 规则）──
    var edRef = r.useRef(null)         // 正文那个 contentEditable 元素
    var savedRef = r.useRef('')        // 服务端给的原文 = 判断 dirty 的基准
    var renderedRef = r.useRef(null)   // 上次真正渲染进去的 HTML（防"覆盖主人手打的内容"）
    var renderedSeqRef = r.useRef(-1)  // 上次渲染对应的 renderSeq（只有它变才允许重设 ✓）
    var pendingCaretRef = r.useRef(null) // 重设前记下的编辑状态（焦点/光标/滚动 ✓）
    // ★ 实例 id + 挂载/卸载留痕（2026-10-15 查"就像刷新了一下"✗）★
    //   如果重挂载 → 元素全新 → 焦点/光标/滚动全没 ✓ 与主人描述一致 ✓
    //   这个 id 只在挂载时分配一次 ✓ 日志里能直接看出"是不是换了个实例"✓
    var instIdRef = r.useRef(0)
    if (!instIdRef.current) instIdRef.current = ++bodyInstSeq
    var instId = instIdRef.current
    var saidRef = r.useRef(false)      // 日志去重（dirty 状态只在变化时打一行）
    // ── 大纲 / 目录（2026-10-24 主人：「改成「左目录 + 右正文」」）──
    //   ⚠️ **只读视图** ✓ 一个字符都不往正文里写 ✓ 不碰保存链路 ✓
    //   ⚠️ 开合状态放模块级 navOpen：宿主每次保存都会重建这个组件 ✗
    //      放组件 state 的话，一保存目录就自己关了 ✓
    // ⚠️ 初始一律**收起** ✗ 手机竖屏屏幕窄，一上来就占 220px 会很难看 ✓
    //   量完尺寸（几十毫秒内）由下面的"自动态跟随"决定要不要展开 ✓
    var tocSt = r.useState(function () { return navOpen === null ? false : navOpen })
    var tocOn = tocSt[0], setTocOn = tocSt[1]
    var outSt = r.useState(function () { return [] })     // [{ lv, text, el }]
    var outline = outSt[0], setOutline = outSt[1]
    var actSt = r.useState(-1)                            // 当前高亮的第几条
    var actIdx = actSt[0], setActIdx = actSt[1]
    // ★ 悬浮展开（2026-10-27 补回）：目录收起时鼠标停在左边留白 → 悬浮弹出，移出收起
    var peekSt = r.useState(false)
    var peekOn = peekSt[0], setPeekOn = peekSt[1]
    var outlineRef = r.useRef([])                          // 给 scroll 回调读（避免闭包拿到旧值 ✗）
    outlineRef.current = outline
    // ★ 目录停靠 / 浮层（2026-10-24 主人）★
    //   规则：容器 **宽 ≥ 高** → 停靠（占布局，正文让出宽度）
    //         否则         → 浮层（盖在正文左侧，自带滚动条 ✓ 不挤压正文）
    //   为什么要分两种：右侧栏有时是窄高的（截图那种）✗
    //     窄高里再挤 208px 给目录 → 正文只剩一条缝 ✗
    var dockSt = r.useState(false)   // ⚠️ 未量尺寸前先按"窄屏/浮层"处理 ✓（手机竖屏不占布局）
    var docked = dockSt[0], setDocked = dockSt[1]

    // ★ 自动态跟随（2026-10-28 补回）★
    //   navOpen === null（自动）时：量到宽屏 → 展开目录；窄屏（手机竖屏）→ 收起 ✓
    //   用户手动开/关过（navOpen 为 true/false）就不再干预 ✓
    r.useEffect(function () {
      if (navOpen !== null) return
      setTocOn(docked)
      if (docked) { try { if (tocRefreshFn) tocRefreshFn() } catch (_) {} }
    }, [docked])

    // ─── props 变化 → 决定"要不要采纳成新缓冲"（2026-10-15 改地基）──────
    //   成熟模型（VS Code 的 etag / Google Docs 的 op 流）都遵循同一套：
    //     · 编辑器缓冲是唯一真相 ✓ props 只是**输入** ✗ 不是渲染源
    //     · 用**修订号**判断新旧 ✓ 不用文本比大小 ✗
    //     · 外部改动只在"本地干净 + 不是输入法组合中"时采纳 ✓
    //   我们这里：fileInfo.value.version 就是那个修订号 ✓（日志实测有这个字段 ✓）
    r.useEffect(function () {
      var t = (props && props.content && props.content.text) || ''
      var propsVer = (fileInfo && fileInfo.value && fileInfo.value.version) || ''
      var prev0 = docGet(absPath)
      // ① 首次（还没有缓冲）→ 直接采纳 ✓
      if (!prev0 || typeof prev0.buf !== 'string') {
        savedRef.current = t
        saidRef.current = false
        docPatch(absPath, { buf: t, bufVer: propsVer, saved: t, md: t, dirty: false, override: null, renderSeq: (prev0 && prev0.renderSeq ? prev0.renderSeq : 0) + 1 })
        log('首次采纳内容为缓冲（fileVer=' + propsVer + '，' + t.length + ' 字）')
        return
      }
      // ② props 没变 → 什么都不做 ✓
      if (propsVer && prev0.bufVer === propsVer) return
      // ③ 这是我们自己保存的**回声** → 只更新修订号 ✓ **绝不重渲染** ✗
      //   两种情形都算回声：
      //     a) 与我们缓冲**一字不差** ✓
      //     b) **刚保存过的 5 秒窗口内、长度又相近** ✓
      //        ⚠️ 为什么不能只比文本 ✗：文件监听回传时常带格式规整
      //           （尾换行 / 空行 / 列表标记 ✓）→ 文本对不上 ✗ → 被当成外部改动 ✗
      //           → renderSeq +1 → **整篇重设 = 就像刷新了一下** ✗✗
      //           （2026-10-15 主人现场：保存后闪一下、焦点丢了、没法接着打字 ✓）
      //        ⚠️ 为什么加"长度相近"✗：真·外部改动（AI 改文档）长度会明显不同 ✓
      //           所以它照样会被采纳 ✓ 不会被这条挡住 ✓
      var ownAge = Date.now() - ownWriteAt
      var looksLikeEcho = false
      if (ownWriteTxt && ownAge >= 0 && ownAge < 5000) {
        var la = t.length, lb = String(ownWriteTxt).length
        looksLikeEcho = Math.abs(la - lb) <= Math.max(20, lb * 0.02)
      }
      if (t === prev0.buf || looksLikeEcho) {
        savedRef.current = t
        docPatch(absPath, { bufVer: propsVer, saved: t, justSaved: null })
        if (t !== prev0.buf) {
          log('props 回声（回传 ' + t.length + ' 字 / 我们写的 ' + String(ownWriteTxt).length
            + ' 字，' + Math.round(ownAge / 1000) + ' 秒前）→ 只更修订号，不重渲染 ✓')
        }
        return
      }
      // ④ 有本地未保存改动 / 输入法组合中 → **不采纳** ✓（留给冲突路径 / 组合结束 ✓）
      if (prev0.dirty || composing) {
        log('外部改动来了，但本地有未保存的改动（或正在打字）→ 先不采纳 ✓')
        return
      }
      // ⑤ 真·外部改动 + 本地干净 → 采纳 ✓（AI 改了文件 / 别的窗口改了 ✓）
      //    renderSeq + 1 ✓ —— 这是"内容来自外部"的少数几个入口之一 ✓
      savedRef.current = t
      saidRef.current = false
      docPatch(absPath, {
        buf: t, bufVer: propsVer, saved: t, md: t, dirty: false, override: null,
        renderSeq: (prev0.renderSeq || 0) + 1,
      })
      log('采纳外部改动为缓冲（fileVer=' + propsVer + '，' + t.length + ' 字）')
      // ★★ 版本号必须跟着刷新（2026-10-15 修「永久版本冲突」）★★
      //   原来这里只更新内容与基准，**没更新 ver** ✗
      //   于是"别处写过这篇文档"之后：内容变新了 ✓ 版本号还停在旧值 ✗
      //   → 之后每次保存都被判「版本冲突」✗ → **永久死锁** ✗✗
      //   （主人现场：本地 v28 / 服务端 v33，一直撞到刷新页面为止 ✓）
      //   这里只对齐版本，不动内容（内容已经由 props 给了 ✓）
      var idNow = (prev0 && prev0.id) || canvasIdForPath(absPath)
      if (idNow) {
        fetch('/api/canvas/read?id=' + encodeURIComponent(idNow) + '&' + ccvSidQ(), { cache: 'no-store' })
          .then(function (x) { return x.json() })
          .then(function (d) {
            if (d && typeof d.version === 'number') {
              var cur2 = docGet(absPath)
              if (cur2 && cur2.ver !== d.version) {
                docPatch(absPath, { ver: d.version })
                log('内容变了 → 版本对齐到 v' + d.version + '（原来 v' + cur2.ver + '）')
              }
            }
          }).catch(function () {})
      }
    }, [absPath, (props && props.content && props.content.text) || ''])

    // 正文文本（依赖数组要用它 —— 换文档/内容变了才重跑 ✓）
    var contentText = (props && props.content && props.content.text) || ''
    // ⚠️⚠️ **必须有依赖数组**（2026-10-15 修，第二个同类 bug ✗）
    //   原来没有第二个参数 → **每次渲染都跑** ✗ 而它每次都在做：
    //     · loadCanvasMap()   → 一次网络请求 ✗（渲染一次发一次 = 请求风暴 ✓）
    //     · ensureViewerCss() → 注入样式 ✗
    //     · setTimeout(400)   → 每次渲染又起一个定时器 ✗（getComputedStyle 会强制排版 ✓）
    //   后果（主人现场）：
    //     · 「保存失败：服务端无响应」—— 请求风暴把服务端打爆 ✓
    //     · 焦点乱跳（有时在画布、有时在聊天框）✗
    //     · 连按 Ctrl+Z 失效 ✗
    r.useEffect(function () {
      ensureViewerCss()
      loadCanvasMap(function () {})
      publishInput(props, absPath, inputState)
      ensureListeners()
      // 往返自检（md → html → md）：打开文档就量一次，差异写进日志
      roundTripCheck((props && props.content && props.content.text) || '', absPath)
      // ── 实测排版（2026-10-11 加）──
      //   主人报"引用块行距大"。我先猜"空段落"（错 ✗）、又猜"样式没生效"（也错 ✗）——
      //   日志证明 HTML 干净、样式也在。那就别再猜：**把浏览器算出来的值打出来**。
      //   marginTop/Bottom、lineHeight、fontSize 是"最终生效"的值，谁压过谁一目了然。
      setTimeout(function () {
        try {
          var body = document.querySelector('[data-ccv-md-body="1"]')
          if (!body) { log('实测：找不到正文元素'); return }
          var bs = window.getComputedStyle(body)
          var bq = body.querySelector('blockquote')
          var bqs = bq ? window.getComputedStyle(bq) : null
          var ps = body.querySelectorAll('blockquote p')
          var rows = []
          for (var i = 0; i < Math.min(3, ps.length); i++) {
            var cs = window.getComputedStyle(ps[i])
            var r = ps[i].getBoundingClientRect()
            rows.push('#' + i + ' top=' + Math.round(r.top) + ' h=' + Math.round(r.height)
              + ' mt=' + cs.marginTop + ' mb=' + cs.marginBottom
              + ' lh=' + cs.lineHeight + ' fs=' + cs.fontSize)
          }
          log('实测排版：正文 fs=' + bs.fontSize + ' lh=' + bs.lineHeight
            + ' whiteSpace=' + bs.whiteSpace
            + '；blockquote lh=' + (bqs ? bqs.lineHeight : '—') + ' fs=' + (bqs ? bqs.fontSize : '—')
            + '；块内段落 ' + ps.length + ' 个 → ' + (rows.join(' | ') || '（没有）'))
        } catch (e) { log('实测排版失败: ' + (e && e.message)) }
      }, 400)
    }, [absPath, contentText])   // ★★ 就是这里（原来只有 `})` ✗ → 每次渲染都跑 → 请求风暴）

    // ── 之后才允许提前返回 ──
    var content = props ? props.content : null
    var kind = content && content.kind
    // ★ 输入法组合期间**绝不重设 innerHTML** ✗（重设 = 打断输入法 ✗ 拼音白打 ✓）
    //   与"拖动期间不覆盖"同一个道理 ✓（2026-10-15）
    var boxStyle = {
      height: '100%', overflow: 'auto', boxSizing: 'border-box',
      // ⚠️ 2026-10-27：内距改成**固定值** ✗ 不随目录开合变
      //   之前是条件式（停靠 40 / 浮层 让宽 / 其余 36）→ 切换目录后会丢 ✓
      //   主人报过两次「开一次目录再关掉，间距又没了」→ 现在只用一个值 ✓
      //   让位（浮层盖住正文时）改由**外层 shell** 负责 ✓ 见下面的 data-ccv-shell-pad
      padding: '18px 24px 18px 20px', lineHeight: 1.75,
      fontSize: '14px', wordBreak: 'break-word',
      // ⚠️ 必须显式声明 normal。2026-10-11 实测定位到的那一个：
      //   渲染器产出的 HTML 在标签之间带换行（`</p>\n<p>`，见 renderBlocks 的 out.join("\n")），
      //   而这里**继承了查看器容器的 white-space: pre-wrap** → 每个换行被当成真换行渲染出来
      //   → 段落之间凭空多出一整行。
      //   实测数字：段落间距 38px，而边距只有 7px —— 38 ≈ 24.5(一整行) + 7 + 7 ✓ 正好对上。
      //   （面板没这毛病：编辑区里浏览器会把标签间的空白规整掉。）
      whiteSpace: 'normal'
    }
    var text = (content && typeof content.text === 'string') ? content.text
      : ((content && content.pages) || []).map(function (p) { return (p && p.text) || '' }).join('')
    // ★★ 渲染源 = 【缓冲】而不是 props（2026-10-15 改地基）★★
    //   原来 text 直接来自 props.content.text ✗ → 每次保存后 props 一变
    //   → React 就要重设 innerHTML ✗ → 我们只好加一堆守卫去拦（dirty / staleProps /
    //     echoOwnSave …）✓ 那就是"自动保存带来一堆问题"的根 ✓
    //   成熟软件（Google Docs 的文档模型 / VS Code 的编辑缓冲）都是：
    //     **编辑器自己的缓冲是唯一真相** ✓ props 只是**输入** ✓ 不是渲染源 ✗
    //   于是：我们自己的保存回声**根本不会引起重渲染** ✓（buf 没变 ✓）
    //         只有"真·外部改动 + 本地干净"才会采纳并重渲染 ✓
    var dsBodyBuf = docGet(absPath)
    if (dsBodyBuf && typeof dsBodyBuf.buf === 'string') text = dsBodyBuf.buf
    // 撤销/重做刚发生时，正文先按 override 显示（别等文件监听 ✗ —— 那是延迟的来源之一）
    var dsBody = docGet(absPath)
    if (dsBody && typeof dsBody.override === 'string') text = dsBody.override

    // 头几次渲染把现场写进日志（别刷屏：只记前 3 次）
    if (bodySaid < 3) {
      bodySaid++
      log('正文组件第 ' + bodySaid + ' 次被调用：'
        + 'React=' + (h ? '有' : '没有')
        + ' props键=' + (props ? Object.keys(props).join(',') : '（无）')
        + ' kind=' + (kind || '（无 content）')
        + ' 正文字数=' + text.length
        + ' 路径=' + (absPath || '（没拿到）'))
    }

    // 任何意外都不许变成空白：把话说明白
    try {
      if (kind !== 'text') {
        return h('div', { 'data-ccv-md-body': '1', style: boxStyle },
          kind ? '（话布渲染器：暂不认这种内容 ' + kind + '）' : '（话布渲染器：没拿到文件内容）')
      }
    // ─── 重设之后：把编辑状态还回去（2026-10-15）─────────────────────
    //   与上面"重设前接住"配对 ✓ —— 这是同一个总闸的另一半 ✓
    //   还原：焦点 ✓ 字符偏移处的光标 ✓ 滚动位置 ✓
    //   ⚠️ 只有**重设前编辑区确实有焦点**时才抢焦点 ✓（否则会打断你正在别处做的事 ✗）
    r.useEffect(function () {
      var p = pendingCaretRef.current
      if (!p) return
      pendingCaretRef.current = null
      try {
        var ed = edRef.current
        if (!ed) return
        if (p.had) {
          try { ed.focus({ preventScroll: true }) } catch (_) { try { ed.focus() } catch (_2) {} }
          setCaretOffset(ed, p.off)
        }
        try {
          var box = ccvScrollBox(ed)
          if (box && typeof p.scroll === 'number') box.scrollTop = p.scroll
        } catch (_) {}
        log('重设后已还原编辑状态：焦点=' + (p.had ? '还回去了 ✓' : '本来就没有（不抢）✓')
          + ' 光标偏移=' + p.off + ' 滚动=' + p.scroll)
      } catch (_) {}
    }, [renderedSeqRef.current])

    // ─── 一次"正常输入"的处理（组合结束后也走它 ✓）──────────────────
    //   从原来的 onInput 里原样搬出来 ✓ 逻辑一个字没改 ✓
    var handleEditInput = function () {
      try {
        var el = edRef.current
        if (!el) return
        // ★ 记下"最后一次输入的时刻"✓（saveDoc 靠它确认"你现在没在打字"✗）
        //   2026-10-17 主人点出的窗口：「卡着第五秒打字」✓
        lastInputAt = Date.now()
        // 查找条开着时：内容变了要重新数 + 重画高亮 ✓（rAF 节流 ✓）
        findSyncOnEdit()
        // ★ A4：按顶层子元素分块转 ✓（块边界 = DOM 的顶层结构 ✓ 不再重新推 ✗）
        var md = editorToMd(el)
        if (typeof md !== 'string') { log('取编辑内容失败：htmlToMd 没借出来'); return }
        var dirty = md !== savedRef.current
        if (dirty !== saidRef.current) {
          saidRef.current = dirty
          log(dirty ? '有未保存的改动（' + md.length + ' 字）' : '改动已回到基准（' + md.length + ' 字）')
        }
        docPatch(absPath, { dirty: dirty, md: md, saved: savedRef.current, buf: md })
        // ★ 自动保存 + 草稿（成熟文档软件的做法，见 afterEdit 的注释）
        //   有改动才排；回到基准（用户自己撤回去了）就不用存 ✓
        if (dirty) {
          var dsNow2 = docGet(absPath)
          afterEdit(absPath, md, (dsNow2 && dsNow2.id) || '', (dsNow2 && dsNow2.ver) || 0)
        } else {
          // ★ 内容**回到基准**了（用户自己按 Ctrl+Z 撤回去了 / 或撤到了头）→
          //   那份草稿就作废了，必须丢掉 ✓
          //   不丢的话：下次一查草稿 → 基准对得上 → "恢复"回那次编辑 ✗✗
          //   （主人 2026-10-15 的现场：改成斜体 → 马上 Ctrl+Z → 提示"恢复了未保存的
          //     草稿" → 内容又变回斜体 ✗ 根因就在这儿）
          var dsNow3 = docGet(absPath)
          try {
            if (dsNow3 && dsNow3.id && window.__ccvKit && window.__ccvKit.draftDrop) {
              window.__ccvKit.draftDrop(dsNow3.id)
              log('内容回到基准 → 草稿作废丢掉（' + dsNow3.id + '）')
            }
          } catch (_) {}
        }
      } catch (e) { log('onInput 出错: ' + (e && e.message)) }
    }

    // ★★ mdToHtml 结果缓存（2026-10-15，主人报"自动保存会卡我拉表格"）★★
      //   md2html 是**整篇 markdown 解析** ✓ 6KB 文档也要几毫秒 ✗
      //   而 Body 会因为**保存状态**变化就重渲染 ✗（saving:true/false 也发通知 ✓）
      //   → 每次重渲染都白跑一遍解析 ✗ 拖表格时正好撞上 = 卡 ✓✓
      //   修：只有正文真的变了才重算 ✓（缓存放在模块级，按 路径+正文 做键 ✓）
      var html = null
      var ck = absPath + '\u0000' + text
      if (mdCache.key === ck) {
        html = mdCache.html
      } else {
        html = md2html(text)
        mdCache = { key: ck, html: html }
      }
      // ⚠️ 有未保存的改动时**不覆盖正文** —— 否则 AI（或别的窗口）改了文件之后，
      //    主人手打的内容会凭空消失 ✗。做法：继续用上次渲染过的 HTML，
      //    React 看到字符串没变就不会重设 innerHTML ✓ 光标和内容都保住 ✓
      //
      // ★★ 还要防"刚保存成功那一瞬间"（2026-10-15 主人报「删了表格又给我恢复了」）★★
      //   链条：删表格 → dirty=true（守卫生效 ✓）→ 自动保存成功 → dirty=false ✗
      //        → 而 props.content.text 还是**旧的**（文件监听还没追上 ✓）
      //        → 守卫失效 → 用旧 props 算出的 HTML（带表格 ✗）被重新贴回去 ✗✗
      //   判据：props 的正文 ≠ 我们**刚写进服务端的那份**（dsNow.saved）→ props 是旧的 ✓
      //   ⚠️ 这不会挡住"外部改动"✗ —— 因为内容变化那个 effect 会在 props 变化时
      //      把 saved 同步成新 props ✓（于是两者相等 → 不再算 stale → 正常显示 ✓）
      // ★★★ 重渲染由**我们显式决定**（2026-10-15 第三次修，前两次都没根治）★★★
      //   前两版都在"猜"内容变没变（dirty / staleProps / echoOwnSave 四道守卫 ✗）
      //   而只要**有一次猜错** → React 重设 innerHTML → 闪一下 ✗
      //   → 你正按"插入表格"时那一下正好落在 execCommand 中间 → 插不进去 ✗
      //   → 打字时那一下打断输入法 ✗；保存时那一下清空原生撤销栈 ✗
      //
      //   成熟做法（Google Docs 的 op 流 / VS Code 的缓冲）：
      //     **编辑器 DOM 就是真相** ✓ 只有"内容来自外部"时才允许重设 ✓
      //   实现：store 里放一个 renderSeq ✓
      //     · 编辑区自己改的（打字 / 表格操作）→ **不动 seq** ✓ → htmlToShow 保持不变 ✓
      //     · 内容来自外部（首次加载 / 外部改动 / 撤销重做 / 草稿恢复）→ **seq + 1** ✓
      //   于是"猜"这件事彻底没有了 ✓ 四道守卫也全都不需要了 ✓
      var seqNow = dsBodyBuf ? (dsBodyBuf.renderSeq || 0) : 0
      var htmlToShow = renderedRef.current
      if (renderedSeqRef.current !== seqNow || !renderedRef.current) {
        log('重设正文（实例#' + instId + ' renderSeq=' + renderedSeqRef.current + '→' + seqNow
          + '，' + html.length + ' 字节 HTML）')
        // ★★ 重设之前先把编辑状态接住（2026-10-15）★★
        //   重设 innerHTML = 把编辑区整个重建 ✗ 会毁掉：
        //     焦点 / 光标 / 滚动位置 / 输入法组合 / 浏览器原生撤销栈 ✗
        //   （主人现场：Ctrl+Z 丢焦点要再点一下 ✓ 插表格被闪掉 ✓ 撤销历史为空 ✓
        //     这些**是同一件事** ✓ 不是三个 bug ✗）
        //   所以在这**唯一的总闸**上一次性接住：记下焦点与字符偏移 ✓ 重建后还回去 ✓
        try {
          pendingCaretRef.current = {
            had: !!(edRef.current && document.activeElement === edRef.current),
            off: caretOffset(edRef.current),
            scroll: (function () {
              try {
                var box = edRef.current && edRef.current.parentElement
                return box ? box.scrollTop : 0
              } catch (_) { return 0 }
            })(),
          }
        } catch (_) { pendingCaretRef.current = null }
        renderedSeqRef.current = seqNow
        renderedRef.current = html
        htmlToShow = html
      }
      if (!html) {
        return h('div', { 'data-ccv-md-body': '1', style: boxStyle },
          '（话布渲染器：正文是空的 —— 共 ' + text.length + ' 字）')
      }
      // 去掉标签之间的换行（第二道保险，第一道是上面的 whiteSpace: normal）。
      // ⚠️ 只吃 `>` 和 `<` 之间的换行 —— <pre> 里的换行是**内容**，两边不是 `>`/`<`，
      //    所以不会被误删（`<code>a\nb</code>` 的换行在 a 和 b 之间，安全）。
      html = html.replace(/>\s*\n\s*</g, '><')
      // 头一次渲染把**产物本身**打出来（2026-10-11 加）：
      //   主人报"引用块行距还是大"，我猜了"空段落"但改完没用 —— 猜错了两轮。
      //   所以直接把事实打出来：HTML 长什么样、空段落有几个、样式表里有没有那两条规则。
      //   项目里的老规矩：**先让证据说话，再改**。
      if (bodySaid <= 3) {
        try {
          var emptyP = (html.match(/<p>\s*<\/p>/g) || []).length
          var allP = (html.match(/<p[ >]/g) || []).length
          var st = document.getElementById('ccv-viewer-md-style')
          log('正文 HTML：空段落 ' + emptyP + ' / 段落共 ' + allP
            + '；样式表=' + (st ? (st.textContent.length + ' 字节, 含 p:empty=' + (st.textContent.indexOf('p:empty') >= 0)) : '没有'))
          log('HTML 开头 200 字：' + html.slice(0, 200).replace(/\n/g, '⏎'))
        } catch (_) {}
      }
      // ── 目录栏（只读视图 ✓ 不碰正文 ✓）—— 样式照豆包大纲 ──
      var tocEl = null
      // ★ 悬浮展开（2026-10-27 补回）：peekOn 只在"目录收起时鼠标停在左边留白"期间为真
      if (tocOn || peekOn) {
        ensureTocCss()
        // ★ ① 顶部标题和第一条重复 ✗（主人 2026-10-24 第二条意见）★
        //   文档第一个 h1 就是"文档标题" ✓ 已经放在顶部了 ✓
        //   → 列表里**跳过那一条** ✓ 不再出现两遍标题 ✓
        var srcOutline = outline || []
        var headTitle = ''
        var listStart = 0
        try {
          var first0 = srcOutline[0]
          if (first0 && first0.lv === 1) {
            headTitle = first0.text
            listStart = 1                 // ← 跳过第一条 ✓
          }
        } catch (_) {}
        var items = srcOutline.slice(listStart).map(function (it, i0) {
          var i = i0 + listStart          // 真实下标（高亮要对得上 ✓）
          var isAct = (i === actIdx)
          var cls = 'ccv-toc-item ccv-l' + Math.min(4, Math.max(1, it.lv)) + (isAct ? ' is-active' : '')
          return h('div', {
            key: 'toc' + i,
            className: cls,
            title: it.text,
            onClick: function () {
              try {
                // 滚到那个标题 ✓ 不抢焦点、不动光标 ✗
                var sb = ccvScrollBox(edRef.current)
                if (sb) {
                  var r0 = it.el.getBoundingClientRect()
                  var rb = sb.getBoundingClientRect()
                  sb.scrollTop = sb.scrollTop + (r0.top - rb.top) - 8
                } else {
                  it.el.scrollIntoView({ block: 'start' })
                }
                setActIdx(i)
                log('目录：跳到第 ' + (i + 1) + ' 条「' + it.text.slice(0, 24) + '」')
              } catch (_) {
                try { it.el.scrollIntoView() } catch (_2) {}
              }
            },
          }, it.text)
        })
        // 顶部标题：优先用文档里的第一个 h1（= 文档标题 ✓），否则用文件名 ✓
        var docTitle = headTitle
        if (!docTitle) {
          try {
            docTitle = String(absPath || '').replace(/\\/g, '/').split('/').pop().replace(/\.md$/i, '')
          } catch (_) {}
        }
        tocEl = h('div', {
          'data-ccv-toc': '1',
          'data-ccv-toc-mode': tocOn ? (docked ? 'dock' : 'overlay') : 'peek',
          className: 'ccv-toc',
          // 悬浮态：鼠标一移出就收起 ✓（固定展开时绝不能挂 ✗ 否则一动就没了）
          onMouseLeave: tocOn ? undefined : function () {
            try { setPeekOn(false); log('目录：悬浮收起') } catch (_) {}
          },
          style: tocOn ? (docked ? {
            // ── 停靠：占布局 ✓ 正文让出宽度 ✓（豆包那版没有边框，靠留白分隔 ✓）──
            flex: '0 0 ' + NAV_W + 'px', width: NAV_W + 'px',
          } : {
            // ── 浮层：贴正文左侧 ✓ 自带滚动条 ✓ 不挤压正文 ✓ ──
            //   ⚠️ 2026-10-24 主人说「你的目录有边框」✗
            //      停靠模式本来就没边框 ✓ 所以那条"边"来自**浮层的阴影** ✗
            //      → 阴影、圆角全部去掉 ✓ 只留底色，靠留白分隔（与豆包一致 ✓）
            position: 'absolute', left: 0, top: 0, bottom: 0, zIndex: 40,
            width: NAV_W_OVER + 'px',
            background: 'var(--dsw-alias-bg-layer-1,rgba(30,30,30,.96))',
          }) : {
            // ── 悬浮（收起状态下的临时展开）：盖在正文上 ✓ 移出即收 ✓ ──
            position: 'absolute', left: 0, top: 0, bottom: 0, zIndex: 41,
            width: NAV_W_OVER + 'px',
            background: 'var(--dsw-alias-bg-layer-1,rgba(30,30,30,.97))',
          },
        },
          h('div', { className: 'ccv-toc-head' },
            h('div', {
              className: 'ccv-toc-collapse',
              title: tocOn ? '收起目录' : '关闭（回到正文）',
              onClick: function () {
                try {
                  // ⚠️ 2026-10-28 主人：「手机上点留白区弹出悬浮目录，关不掉」
                  //   触屏没有 mouseleave ✗ 所以「移出即收」在手机上不成立 ✓
                  //   → 悬浮态下这个「«」就是**关闭键** ✓ 只关悬浮、不改 navOpen ✗
                  if (!tocOn) { setPeekOn(false); log('目录：关闭悬浮（点«）') ; return }
                  navOpen = false; navEmit(); log('目录：收起')
                } catch (_) {}
              },
            }, '«'),
            h('div', { className: 'ccv-toc-title', title: docTitle }, docTitle || '目录')),
          // ⚠️ 判空要用"去掉标题那条之后"的条数 ✓
          //   否则：文档只有一个大标题时 → 顶部有标题、下面却写"没有标题"✗
          (srcOutline.length > listStart) ? h('div', null, items)
            : h('div', { className: 'ccv-toc-empty' }, '这篇没有小标题（用 ## 开头的行会出现在这里）'))
      } else {
        // ★ 收起态（2026-10-27 补回悬停展开）★
        //   主人要求：鼠标移到左边留白里 → 目录悬浮弹出；移出 → 收起 ✓
        //   ⚠️ 热区 = **整条左边留白**（CSS 里 width:20px / top:0 / bottom:0）
        //      不是只有那个小图标能触发 ✗ 那样很难瞄 ✓
        ensureTocCss()
        tocEl = h('div', {
          className: 'ccv-toc-reopen',
          title: '鼠标移上去看目录（点击可固定展开）',
          'data-ccv-toc-reopen': '1',
          onClick: function () { try { navOpen = true; navEmit(); log('目录：固定展开') } catch (_) {} },
          onMouseEnter: function () {
            try {
              setPeekOn(true)
              if (tocRefreshFn) tocRefreshFn()      // 展开前重算一次 ✓ 别显示旧标题 ✓
              log('目录：悬浮展开')
            } catch (_) {}
          },
        },
          // 三条横线仍在最上面当视觉提示 ✓（主人 2026-10-24：「应该是一一的横线」）
          h('i', null), h('i', null), h('i', null))
      }
      var edEl = h('div', {
        'data-ccv-md-body': '1',
        // ⚠️ 2026-10-28 主人：「手机上点留白区弹出悬浮目录，关不掉」
        //   触屏没有 mouseleave ✗ 所以补一条"点正文任意处就关掉悬浮目录" ✓
        //   （桌面端也成立，且不抢焦点、不阻止点击 ✓）
        onMouseDown: function () { try { if (peekOn) setPeekOn(false) } catch (_) {} },
        onTouchStart: function () { try { if (peekOn) setPeekOn(false) } catch (_) {} },
        // ⚠️ 2026-10-27：正文**不再有任何条件式内距** ✗
        //   之前这里有两档 paddingLeft（停靠 40 / 浮层 让宽）→
        //   切换目录后内距会"丢"（主人报过两次）✓
        //   现在让位/留白统一由**外层 shell**（data-ccv-shell-pad）负责 ✓
        style: Object.assign({},
          boxStyle,
          { flex: '1 1 auto', minWidth: 0, minHeight: 0 }),
        // ── 编辑（2026-10-11 加，"把话布搬到查看器"的核心）──────────
        // contentEditable + 面板那套 mdToHtml/htmlToMd —— 两端共用同一份转换 ✓
        // ⚠️ 用 dangerouslySetInnerHTML 而不是手动 setInnerHTML：React 只在
        //    **字符串变了**时才重设 innerHTML ✓，所以打字过程中（text prop 没变）
        //    不会被 React 冲掉光标 ✓（面板那边是手动管的，因为它的重渲染更频繁）
        contentEditable: true,
        suppressContentEditableWarning: true,
        spellCheck: false,
        ref: function (el) {
          edRef.current = el
          liveEditor = el                  // 划词栏用（老面板的 editorRef.current 对应物 ✓）
          bindTableResize(el)              // 表格列宽拖拽（一次性绑定，委托在根上 ✓）
          // ★ 组件被宿主重建之后：把编辑状态接回来（2026-10-15）★
          //   宿主在文件变化时会卸载重装这个组件 ✗ → 元素全新 → 焦点/光标没了 ✓
          //   模块级 liveEditState 里存着"最后已知状态" ✓ 这里还回去 ✓
          //   ⚠️ 只在 5 秒内、且原本确实有焦点时才抢 ✓（免得抢你正在别处做的事 ✗）
          try {
            var ls = liveEditState
            if (el && ls && ls.hadFocus && (Date.now() - ls.at) < 5000) {
              setTimeout(function () {
                try {
                  var ed2 = edRef.current
                  if (!ed2) return
                  try { ed2.focus({ preventScroll: true }) } catch (_) { try { ed2.focus() } catch (_2) {} }
                  setCaretOffset(ed2, ls.offset)
                  var sb2 = ccvScrollBox(ed2); if (sb2) sb2.scrollTop = ls.scroll
                  log('组件被宿主重建过 → 已把焦点与光标接回来 ✓（偏移 ' + ls.offset + '）')
                } catch (_) {}
              }, 0)
            }
          } catch (_) {}
        },
        onBlur: function () { flushEdit(absPath) },   // 失焦即存 ✓（别让最后一段输入卡在防抖里 ✗）
        onKeyDown: function (e) { onEditKeyDown(e, absPath) },   // 快捷键（见 onEditKeyDown）
        onContextMenu: function (e) {                            // 右键菜单（阶段 4 搬过来的 ✓）
          try {
            if (!insideBody(e.target)) return
            e.preventDefault()
            // 右键那一刻先把选区存下来 ✓（菜单点完要用它）
            var sel = document.getSelection()
            if (sel && sel.rangeCount && String(sel.toString() || '').trim()) {
              savedRange = sel.getRangeAt(0).cloneRange()
              updateSelFormats(sel)
            }
            showContextMenu(e.clientX, e.clientY)
          } catch (err) { log('右键菜单出错: ' + (err && err.message)) }
        },
        onCompositionStart: function () {
          // ─── 输入法组合保护（2026-10-15，主人报「打一长串拼音还没选字，自动保存就打断我」）───
          //   contentEditable 里 **input 事件在拼写过程中就会触发** ✗（拼音还没上屏 ✓）
          //   我们把它当真实编辑 → 脏标记 + 草稿 + 自动保存 ✓
          //   → 保存回来 docPatch → 通知 → Body 重渲染 ✗ → React 重设 innerHTML ✗✗
          //   → **输入法组合被打断**（拼音白打 / 直接上屏 ✗）
          //   做法：组合期间**一律不当编辑** ✗ 组合结束再补一次正常处理 ✓
          composing = true
          log('输入法：开始组合（期间不标记脏、不排保存 ✓）')
        },
        onCompositionEnd: function () {
          composing = false
          log('输入法：组合结束 → 补一次正常处理 ✓')
          try { handleEditInput() } catch (_) {}
        },
        onInput: function (e) {
          // 组合期间（以及浏览器标了 isComposing 的）→ 完全不动 ✓
          try {
            if (composing || (e && e.isComposing)) return
          } catch (_) {}
          handleEditInput()
        },
        dangerouslySetInnerHTML: { __html: htmlToShow }
      })
      // ⚠️ 外层容器的形状**永远一样** ✓ 只让目录这个孩子出现/消失 ✓
      //    （"开目录才包一层"会让正文重新挂载 → 丢焦点 ✗）
      return h('div', {
        'data-ccv-md-shell': '1',
        // position:relative 让浮层模式能定位到左侧 ✓（停靠模式不受影响 ✓）
        // 留白三档：停靠开着 0 ✓（目录自己占位）／浮层开着 让宽+12 ✓／关着 16 ✓
        'data-ccv-shell-pad': tocOn ? (docked ? '0' : '1') : '2',
        style: {
          position: 'relative', display: 'flex', height: '100%', minHeight: 0, minWidth: 0,
          alignItems: 'stretch', boxSizing: 'border-box',
          paddingLeft: !tocOn ? '16px' : (docked ? 0 : ((NAV_W_OVER + 12) + 'px')),
        },
      }, tocEl, edEl)
    } catch (e) {
      var msg = (e && e.message) || String(e)
      log('正文组件出错: ' + msg)
      return h('div', { 'data-ccv-md-body': '1', style: boxStyle },
        '（话布渲染器出错：' + msg + '）')
    }
  }

  // ─── 注册进查看器 ──────────────────────────────────────────
  function boot(ctx) {
    if (booted) return
    if (!ctx) return

    var reg = null
    try { reg = (typeof ctx.get === 'function') ? ctx.get('documentPreviews') : ctx.documentPreviews } catch (_) {}
    if (!reg || typeof reg.register !== 'function') {
      // 服务拿不到就**安静放弃**：这个 DSH 版本没有这个口子，不该影响任何现有功能
      log('v' + VERSION + ' 取不到 documentPreviews 服务（此版本可能不支持），本轮放弃接管查看器')
      return
    }
    booted = true

    // ① 声明：接管哪些后缀、外部实现优先、内容由框架按 text-pages 模式加载
    try {
      ctx.effect(function () {
        return reg.register({
          id: ID,
          extensions: ['md', 'markdown'],
          priority: 'extension',   // ★ 外部实现优先 —— 内置那版会让位（但仍留作备选）
          title: function () { return TITLE },   // 「话布文档」（见顶部 TITLE 的说明）
          loading: 'text-pages',
          wrap: true
        })
      })
      log('v' + VERSION + ' 已声明接管 .md（id=' + ID + '，priority=extension）')
    } catch (e) {
      log('v' + VERSION + ' 声明失败: ' + (e && e.message))
      return
    }

    // ② 正文组件：注册进 keyed slot，key 必须与上面的 id 一致
    try {
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.tab.document', function () {
          return ctx.slots.register({ name: 'sidebar.right.tab.document', key: ID }, Body)
        })
      })
      log('v' + VERSION + ' 已注册正文组件（sidebar.right.tab.document，key=' + ID + '）')
    } catch (e) {
      log('v' + VERSION + ' 注册正文组件失败: ' + (e && e.message))
    }

    // ③ 工具栏按钮（撤销 / 重做）：挂到 list 槽 sidebar.right.tab.document.actions
    //    ⚠️ list 槽用 **id**（不是 key ✗）—— 契约来自 Slots.listSubTree：
    //       registration = id(必填) / order / label ✓
    //    id 用自己的，别撞官方的（撞上会顶掉人家的格子 ✗ 官方那个是 open-in-app）
    try {
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.tab.document.actions', function () {
          return ctx.slots.register({ name: 'sidebar.right.tab.document.actions', id: 'collab-canvas-undo', order: 10 }, Actions)
        })
      })
      log('v' + VERSION + ' 已注册工具栏按钮（撤销/重做）')
    } catch (e) {
      log('v' + VERSION + ' 注册工具栏按钮失败: ' + (e && e.message))
    }
  }

  // 主模块 apply(ctx) 会调它；也可能本模块先加载完、主模块后到 —— 两条路都要通
  window.__ccvViewerBoot = boot
  if (window.__ccvCtx) boot(window.__ccvCtx)
  else {
    var n = 0
    var t = setInterval(function () {
      if (window.__ccvCtx) { clearInterval(t); boot(window.__ccvCtx) }
      else if (++n > 40) { clearInterval(t); log('v' + VERSION + ' 等不到 __ccvCtx，放弃自举') }
    }, 250)
  }
})()
