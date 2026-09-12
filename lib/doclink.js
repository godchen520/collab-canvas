// ═══ DSH Collab-Canvas · 对话文档名链接（独立功能模块，单独一个文件维护）═══
// 交互：AI 对话里出现话布文档名（标题或 id）时转为可点链接，点击打开话布
//       面板并加载该文档
// 加载方式：与 docdrop 相同——host 端点 /api/canvas/doclink.js 提供源码，
//           client 入口动态执行，改本文件只需刷新页面
//
// 识别规则（保守，防误伤）：
//   1) 长标题（≥4 字符）：正文出现即转链接，但前后紧邻字符不能是中英文/数字
//      （防“第123条”式的粘连误伤——短标题另有专门规则）
//   2) 短标题（<4 字符，如 123、222）：仅当被「」『』《》【】〔〕包着，或
//      整个内联 code/strong 元素就是该标题时才转
//   3) 文档 id（≥6 字符）：仅当整个 <code> 元素就是该 id 时转
//   4) 跳过代码块(pre)、链接(a)、脚本样式区；已处理的链接不重复处理
//
// 健壮性约定：与 docdrop 相同——防重复安装、每个回调独立捕获、失败静默降级
;(function () {
  try {
    if (window.__ccvDoclinkInstalled) return

    var VERSION = 2   // v2: 上传文档卡片（拖入文档的 @ 引用）可点击 → 在话布中打开
    var LIST_REFRESH_MS = 30000
    var SCAN_DEBOUNCE_MS = 400
    var MIN_LONG_TITLE = 4
    var MIN_ID_LEN = 6

    // 优先用 client.js 挂出来的共用实现（见 client.js 里的 window.__ccvKit）：
    // 日志/轻提示条/会话查询串这三样原本在 client/docdrop/doclink 各存了一份。
    // 取不到就退回下面自带的副本。
    function log(msg) {
      var kit = window.__ccvKit
      if (kit && kit.log) { kit.log(msg, "doclink"); return }
      try {
        fetch("/api/canvas/log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ line: "[doclink] " + msg })
        }).catch(function () {})
      } catch (_) {}
    }

    // ─── 画布清单（标题/id ↔ 链接目标）───
    var canvasList = []   // [{id, title}]
    function refreshList() {
      try {
        // ⚠️ 必须带 sid：/api/canvas/list 只返回「该会话清单」里的画布，
        // 不带参数会被 host 归到 default 会话，导致本会话新建的文档标题永远匹配不到、
        // 转不成可点链接。（AI 工具建的画布也归入当前会话的清单）
        fetch("/api/canvas/list?" + sidQ()).then(function (r) { return r.json() }).then(function (d) {
          if (d && d.ok && Array.isArray(d.canvases)) {
            canvasList = d.canvases
              .map(function (c) { return { id: String(c.id || ""), title: String(c.title || "").trim() } })
              .filter(function (c) { return c.id && c.title })
            scheduleScan()
          }
        }).catch(function () {})
      } catch (_) {}
    }

    // ─── 打开话布（经 client.js 暴露的桥接）───
    function openCanvas(id) {
      if (typeof window.__ccvCanvasToggle !== "function") { log("话布桥接未就绪"); return }
      try {
        if (!window.__ccvPanelOpen) {
          window.__ccvPendingCanvasId = id
          window.__ccvCanvasToggle()
        } else {
          window.dispatchEvent(new CustomEvent("ccv-open-canvas", { detail: { id: id } }))
        }
      } catch (e) { log("打开话布失败: " + (e && e.message)) }
    }

    // ─── 轻提示条（与 docdrop 同款）───
    function toast(msg) {
      var kit = window.__ccvKit
      if (kit && kit.toast) { kit.toast(msg, "ccv-doclink-toast"); return }
      try {
        var old = document.getElementById("ccv-doclink-toast")
        if (old) old.remove()
        var t = document.createElement("div")
        t.id = "ccv-doclink-toast"
        t.textContent = msg
        t.style.cssText = "position:fixed;left:50%;bottom:96px;transform:translateX(-50%);" +
          "z-index:2147483000;background:var(--dsw-alias-label-primary,#1a1a1a);" +
          "color:var(--dsw-alias-bg-overlay,#fff);font-size:13px;padding:8px 14px;" +
          "border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.25);pointer-events:none;" +
          "opacity:1;transition:opacity .3s"
        document.body.appendChild(t)
        setTimeout(function () { t.style.opacity = "0" }, 2200)
        setTimeout(function () { if (t.parentNode) t.remove() }, 2600)
      } catch (_) {}
    }

    // ─── 上传文档卡片（拖拽上传的 @ 引用卡片）→ 点击在话布中打开 ───
    // 卡片文件名是 docdrop 生成的“时间戳-随机码-原名”格式，精确匹配不误伤
    var UPLOAD_FNAME_RE = /^\d{13}-[a-z0-9]{2,8}-.{1,120}$/i
    function uploadFname(text) {
      var t = String(text || "").trim()
      if (!t || t.length > 150) return null
      return UPLOAD_FNAME_RE.test(t) ? t : null
    }
    // 从点击目标向上找卡片根：最小的“纯文件名”祖先
    function findUploadChip(e) {
      var n = e.target
      for (var i = 0; i < 6 && n && n !== document.body; i++) {
        if (n.nodeType === 1) {
          var t = (n.textContent || "").trim()
          var f = uploadFname(t)
          if (f && t.length <= f.length + 4) return { fname: f, el: n }
        }
        n = n.parentElement
      }
      return null
    }
    function openUploadInCanvas(fname) {
      var shown = fname.replace(/^\d{13}-[a-z0-9]{2,8}-/i, "")
      toast("正在把「" + shown + "」导入话布…")
      fetch("/api/canvas/open-upload?name=" + encodeURIComponent(fname))
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (d && d.ok && d.id) {
            openCanvas(d.id)
            toast((d.created ? "已导入话布并打开" : "已在话布中打开") + "「" + (d.title || shown) + "」")
          } else {
            toast("打开失败: " + ((d && d.error) || "未知错误"))
          }
        }).catch(function (e) { toast("打开失败: " + ((e && e.message) || "网络错误")) })
    }

    // ─── 匹配工具 ───
    function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }
    function isWordChar(ch) { return !!ch && /[\w\u4e00-\u9fa5\u3400-\u4dbf]/.test(ch) }
    function isWrapperChar(ch) { return !!ch && /[「」『』《》【】〔〕]/.test(ch) }

    // ─── 扫描：收集文本节点（跳过代码块/链接/已处理区）───
    function collectTextNodes(root, out) {
      if (!root || root.nodeType !== 1) return
      var tag = root.tagName ? root.tagName.toLowerCase() : ""
      if (tag === "pre" || tag === "script" || tag === "style" || tag === "textarea" || tag === "a") return
      if (root.classList && root.classList.contains("ccv-doc-link")) return
      var kids = root.childNodes || []
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i]
        if (k.nodeType === 3) out.push(k)
        else if (k.nodeType === 1) collectTextNodes(k, out)
      }
    }

    function processTextNode(node) {
      var text = node.nodeValue
      if (!text || text.length < 2) return
      var matches = []
      canvasList.forEach(function (c) {
        // 长标题：正文边界匹配
        if (c.title.length >= MIN_LONG_TITLE) {
          var re = new RegExp(escapeRe(c.title), "g")
          var m
          while ((m = re.exec(text)) !== null) {
            var s = m.index, e = s + c.title.length
            var prev = s > 0 ? text[s - 1] : ""
            var next = e < text.length ? text[e] : ""
            if (!isWordChar(prev) && !isWordChar(next)) matches.push({ s: s, e: e, id: c.id, label: c.title })
            if (re.lastIndex === m.index) re.lastIndex++
          }
        } else {
          // 短标题：仅引号/括号包裹，或整段处于纯标题的行内 code/strong 里
          var re2 = new RegExp("([「」『』《》【】〔〕])" + escapeRe(c.title) + "([「」『』《》【】〔〕])", "g")
          var m2
          while ((m2 = re2.exec(text)) !== null) {
            matches.push({ s: m2.index + 1, e: m2.index + 1 + c.title.length, id: c.id, label: c.title })
            if (re2.lastIndex === m2.index) re2.lastIndex++
          }
          var anc = node.parentElement
          var holder = anc && anc.closest ? anc.closest("code,strong,b") : null
          if (holder && holder.textContent === c.title) {
            matches.push({ s: 0, e: text.length, id: c.id, label: c.title })
          }
        }
        // 文档 id：整个 <code> 就是该 id
        if (c.id.length >= MIN_ID_LEN) {
          var anc2 = node.parentElement
          var code = anc2 && anc2.closest ? anc2.closest("code") : null
          if (code && code.textContent === c.id) {
            matches.push({ s: 0, e: text.length, id: c.id, label: c.id })
          }
        }
      })
      if (!matches.length) return
      // 去重去重叠（先位置、后长度优先）
      matches.sort(function (a, b) { return a.s - b.s || (b.e - b.s) - (a.e - a.s) })
      var kept = [], lastEnd = -1
      matches.forEach(function (mt) { if (mt.s >= lastEnd) { kept.push(mt); lastEnd = mt.e } })
      if (!kept.length) return
      // 重建文本节点
      var frag = document.createDocumentFragment()
      var pos = 0
      kept.forEach(function (mt) {
        if (mt.s > pos) frag.appendChild(document.createTextNode(text.slice(pos, mt.s)))
        var span = document.createElement("span")
        span.className = "ccv-doc-link"
        span.setAttribute("data-canvas-id", mt.id)
        span.title = "点击在话布中打开"
        span.textContent = mt.label
        frag.appendChild(span)
        pos = mt.e
      })
      if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)))
      if (node.parentNode) node.parentNode.replaceChild(frag, node)
    }

    // ─── 扫描入口（防重入：自己写入 DOM 引发的变更不再扫）───
    var scanning = false
    function scanRoot() {
      if (scanning || !canvasList.length) return
      scanning = true
      try {
        var root = document.querySelector('[data-pane="conversation"]') || document.body
        var nodes = []
        collectTextNodes(root, nodes)
        nodes.forEach(processTextNode)
        // 文档 id 的 <code> 芯片
        var codes = root.querySelectorAll ? root.querySelectorAll("code") : []
        for (var i = 0; i < codes.length; i++) {
          var code = codes[i]
          if (code.classList && code.classList.contains("ccv-doc-link")) continue
          var txt = (code.textContent || "").trim()
          if (txt.length < MIN_ID_LEN) continue
          var hit = null
          for (var j = 0; j < canvasList.length; j++) {
            if (canvasList[j].id === txt) { hit = canvasList[j]; break }
          }
          if (hit) {
            code.classList.add("ccv-doc-link")
            code.setAttribute("data-canvas-id", hit.id)
            code.title = "点击在话布中打开"
          }
        }
      } catch (e) { log("扫描失败: " + (e && e.message)) }
      scanning = false
    }

    var scanTimer = null
    function scheduleScan() {
      try {
        if (scanTimer) clearTimeout(scanTimer)
        scanTimer = setTimeout(function () { scanTimer = null; scanRoot() }, SCAN_DEBOUNCE_MS)
      } catch (_) {}
    }

    // ─── 样式：低调虚线下划线 + 原文字色 ───
    function injectStyle() {
      try {
        if (document.getElementById("ccv-doclink-style")) return
        var s = document.createElement("style")
        s.id = "ccv-doclink-style"
        s.textContent = ".ccv-doc-link{text-decoration:underline dotted;text-underline-offset:3px;cursor:pointer;color:inherit}" +
          ".ccv-doc-link:hover{background:rgba(128,128,128,.14);text-decoration-style:solid}"
        ;(document.head || document.body).appendChild(s)
      } catch (_) {}
    }

    // ─── .md/.txt 文件卡片识别（三种形态）─────────────
    // 1) 画布文档路径引用（canvas-docs/….md，含拖入产生的与 DSH 原生绝对路径卡片）
    // 2) 上传副本卡片（时间戳-随机码-原名，走 open-upload）
    // 3) 原生 @ 短名卡片（如 333.md，走 load-doc 注册/打开）
    // 卡片形态要求：元素文本以该文件名/路径结尾，防止长段落中途提及被误触发
    function findCanvasPathChip(e) {
      if (e.target && e.target.closest && e.target.closest("#collab-canvas-panel")) return null
      var n = e.target
      for (var i = 0; i < 6 && n && n !== document.body; i++) {
        if (n.nodeType === 1) {
          var t = (n.textContent || "").trim()
          if (!t || t.length > 300) continue
          var m = /canvas-docs[/\\]([^\s\\/:*?"<>|]+\.(?:md|markdown|txt))/i.exec(t)
          // 元素文本必须以该路径结尾（卡片形态）：防止长段落里“中途提到路径”被误触发
          if (m && t.slice(t.length - m[0].length).toLowerCase() === m[0].toLowerCase()) {
            return { rel: "canvas-docs/" + m[1], el: n }
          }
        }
        n = n.parentElement
      }
      return null
    }
    function findMdNameChip(e) {
      if (e.target && e.target.closest && e.target.closest("#collab-canvas-panel")) return null
      var n = e.target
      for (var i = 0; i < 6 && n && n !== document.body; i++) {
        if (n.nodeType === 1) {
          var t = (n.textContent || "").trim()
          if (!t || t.length > 120 || /\s/.test(t)) continue
          if (!/\.(md|markdown|txt)$/i.test(t)) continue
          var fname = t.replace(/^@/, "")
          if (!/\.(md|markdown|txt)$/i.test(fname)) continue
          return { fname: fname, el: n }
        }
        n = n.parentElement
      }
      return null
    }
    // 纯文件名卡片 → 尝试按 canvas-docs/<文件名> 注册/打开（最常见的工作区位置）
    function openMdNameInCanvas(fname) {
      toast("正在把「" + fname + "」登记为话布…")
      fetch("/api/canvas/load-doc?rel=" + encodeURIComponent("canvas-docs/" + fname) + "&" + sidQ())
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (d && d.ok && d.id) {
            openCanvas(d.id)
            toast((d.created ? "已登记为话布并打开：" : "已在话布中打开：") + (d.title || fname))
          } else {
            toast("工作区里没找到这个文档（仅支持 canvas-docs/ 下的 .md/.txt）")
          }
        }).catch(function (e) { toast("打开失败: " + ((e && e.message) || "网络错误")) })
    }
    // 会话键（与 client.js 同算法）：load-doc 建的画布记入当前会话清单
    function sidQ() {
      var kit = window.__ccvKit
      if (kit && kit.sidQ) return kit.sidQ()
      try { const sid = window.__ccvSid; return sid ? "sid=" + encodeURIComponent(sid) : "sid=default"; } catch (_) { return "sid=default"; }
    }
    function openCanvasPathChip(rel) {
      toast("正在把「" + rel.split("/").pop() + "」登记为话布…")
      fetch("/api/canvas/load-doc?rel=" + encodeURIComponent(rel) + "&" + sidQ())
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (d && d.ok && d.id) {
            openCanvas(d.id)
            toast((d.created ? "已登记为话布并打开：" : "已在话布中打开：") + (d.title || rel))
          } else {
            toast("打开失败: " + ((d && d.error) || "未知错误"))
          }
        }).catch(function (e) { toast("打开失败: " + ((e && e.message) || "网络错误")) })
    }

    // ─── 点击委托：文档名链接 + 上传卡片 + 路径卡片 + 原生短名卡片 ───
    function onClick(e) {
      try {
        var t = e.target && e.target.closest ? e.target.closest(".ccv-doc-link") : null
        if (t) {
          var id = t.getAttribute("data-canvas-id")
          if (id) {
            e.preventDefault()
            e.stopPropagation()
            openCanvas(id)
          }
          return
        }
        var cchip = findCanvasPathChip(e)
        if (cchip) {
          e.preventDefault()
          e.stopPropagation()
          openCanvasPathChip(cchip.rel)
          return
        }
        var chip = findUploadChip(e)
        if (chip) {
          e.preventDefault()
          e.stopPropagation()
          openUploadInCanvas(chip.fname)
          return
        }
        var md = findMdNameChip(e)
        if (md) {
          e.preventDefault()
          e.stopPropagation()
          openMdNameInCanvas(md.fname)
        }
      } catch (err) { log("点击处理失败: " + (err && err.message)) }
    }

    // 悬停时给可点元素加手型和提示（委托，动态出现的卡片也覆盖）
    function onHover(e) {
      try {
        var chip = findUploadChip(e)
        if (chip && !chip.el.__ccvChipMarked) {
          chip.el.__ccvChipMarked = 1
          chip.el.style.cursor = "pointer"
          chip.el.title = "点击在话布中打开这篇文档"
        }
        var cchip = findCanvasPathChip(e)
        if (cchip && !cchip.el.__ccvChipMarked) {
          cchip.el.__ccvChipMarked = 1
          cchip.el.style.cursor = "pointer"
          cchip.el.title = "点击在话布中打开这篇文档"
        }
        var md = findMdNameChip(e)
        if (md && !md.el.__ccvChipMarked) {
          md.el.__ccvChipMarked = 1
          md.el.style.cursor = "pointer"
          md.el.title = "点击在话布中打开「" + md.fname + "」"
        }
      } catch (_) {}
    }

    // ─── 安装（只装一次）───
    window.__ccvDoclinkInstalled = true
    injectStyle()
    refreshList()
    setInterval(refreshList, LIST_REFRESH_MS)

    var mo = null
    if (window.MutationObserver) {
      mo = new MutationObserver(function () { scheduleScan() })
      mo.observe(document.body, { childList: true, subtree: true, characterData: true })
    }
    document.addEventListener("click", onClick, false)
    document.addEventListener("mouseover", onHover, false)
    scheduleScan()
    log("文档名链接已安装 v" + VERSION + "（含上传卡片打开话布；清单 " + canvasList.length + " 篇）")
  } catch (e) {
    try { console.error("[doclink] 安装失败", e) } catch (_) {}
  }
})()
