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

    var VERSION = 4   // v2: 上传文档卡片（拖入文档的 @ 引用）可点击 → 在话布中打开
                      // v3: 清单请求带 sid + 并取全局清单；捕获阶段接管 deliverables
                      //     的 presented 卡片（是话布就直接开话布面板）
                      // v4: 删除「正文标题/ID 自动转链」整套 —— 它会扫到右侧栏的
                      //     话布编辑器（扫描根兜底是 document.body），把文档正文里的
                      //     H1 改写并加上 tooltip；且已被官方 present 卡片取代
    var LIST_REFRESH_MS = 30000

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
        // 两路并取后合并：
        //   1) 本会话清单 —— 必须带 sid，否则会被 host 归到 default 会话，
        //      本会话新建/打开的文档标题就匹配不到、转不成可点链接。
        //   2) 全局清单（scope=all）—— 让「还没登记进本会话」的文档标题也能点。
        //      不取这一路的话，标题必须先在这个会话里打开过一次才会变成链接。
        // 合并按 id 去重，先到的（会话清单）优先。
        var pSession = fetch("/api/canvas/list?" + sidQ())
          .then(function (r) { return r.json() }).catch(function () { return null })
        var pAll = fetch("/api/canvas/list?scope=all")
          .then(function (r) { return r.json() }).catch(function () { return null })
        Promise.all([pSession, pAll]).then(function (res) {
          var seen = {}
          var merged = []
          res.forEach(function (d) {
            if (!d || !d.ok || !Array.isArray(d.canvases)) return
            d.canvases.forEach(function (c) {
              var id = String(c.id || "")
              var title = String(c.title || "").trim()
              if (!id || !title || seen[id]) return
              seen[id] = 1
              merged.push({ id: id, title: title })
            })
          })
          canvasList = merged
          // 清单大小必须在 fetch 落地之后才准：安装时那句日志跑在异步之前，
          // 永远显示 0 篇，排障时会误导。这里补一条真实的。
          log("清单已加载 " + canvasList.length + " 篇")
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

    // 注：原先这里还有 escapeRe / isWordChar / isWrapperChar 三个匹配工具，
    // 只服务于已删除的「标题自动转链」。现在卡片的判定都靠文件名后缀与精确比较，
    // 不需要它们。

    // ─── 已删除：正文「标题/ID 自动转链」整套（2026-09-12）──────────────
    // 原实现把正文里出现的画布标题改成 <span class="ccv-doc-link">、把文档 id 的
    // <code> 打上同样的类，点击即开话布面板。删除原因有二：
    //
    // 1) 它会扫到不该扫的地方。扫描根是
    //        document.querySelector('[data-pane="conversation"]') || document.body
    //    选择器一旦没命中就兜底整个 body —— 右侧栏的话布编辑器也在 body 里，
    //    于是文档正文里的 H1「话布优化」被加上了 .ccv-doc-link 和 tooltip
    //    「点击在话布中打开」，可编辑内容被改写。
    //
    // 2) 它已经被官方卡片取代。现在改完话布文档会调 present 声明该 md 文件，
    //    DSH 的 deliverables 行会生成一张可点卡片，由本模块在捕获阶段接管
    //    （见 findPresentedCanvas）——入口由工具驱动，不依赖正文里写没写标题。
    //
    // 保留的部分：各种文件卡片的点击接管（路径卡片 / 工作区相对路径 / @短名 /
    // 上传卡片 / deliverables 声明卡片），它们只在点击时判定，且都带面板守卫。


    // ─── 样式：低调虚线下划线 + 原文字色 ───
    function injectStyle() {
      try {
        if (document.getElementById("ccv-doclink-style")) return
        var s = document.createElement("style")
        s.id = "ccv-doclink-style"
        s.textContent =
          // deliverables「已声明文件」卡片：命中话布时由 doclink 打上 data-ccv-canvas，
          // 此时点击会被接管去开话布面板，DSH 那句悬停提示「在侧栏预览」就是错的 ——
          // 隐掉它，并把平时显示的文件描述在悬停时保持可见（否则那一行会变空）。
          '[data-presented-file][data-ccv-canvas="1"] [class*="previewHint"]{display:none !important}' +
          '[data-presented-file][data-ccv-canvas="1"]:hover [class*="secondaryText"]{display:inline !important}'
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

    // ─── 本地文档路径卡片（工作区 / 已登记文件夹内的 .md/.txt）──────────
    // 与上面的 canvas-docs 卡片区分：这类走 load-path「就地登记」——
    // 绑定原路径，在话布里保存即写回原文件（不是复制一份）。
    // 判定：元素文本的「最后一个空白分隔词」是带路径分隔符的 .md/.txt。
    // 这样既认绝对路径（D:\x\y.md），也认工作区相对路径（docs/DESIGN.md）。
    function findLocalDocPathChip(e) {
      if (e.target && e.target.closest && e.target.closest("#collab-canvas-panel")) return null
      var n = e.target
      for (var i = 0; i < 6 && n && n !== document.body; i++) {
        if (n.nodeType === 1) {
          var t = (n.textContent || "").trim()
          if (t && t.length <= 300) {
            var words = t.split(/\s+/)
            var last = words[words.length - 1] || ""
            if (/\.(md|markdown|txt)$/i.test(last) && /[\\/]/.test(last)) {
              return { path: last, el: n }
            }
          }
        }
        n = n.parentElement
      }
      return null
    }
    // 就地打开：host 侧绑定原路径，保存即写回原文件
    function openLocalDocPath(p) {
      toast("正在把「" + p.split(/[\\/]/).pop() + "」就地登记为话布…")
      fetch("/api/canvas/load-path?path=" + encodeURIComponent(p) + "&" + sidQ())
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (d && d.ok && d.id) {
            openCanvas(d.id)
            toast((d.created ? "已登记并打开（就地编辑）：" : "已在话布中打开：") + (d.title || p))
          } else {
            toast("打开失败：" + ((d && d.error) || "未知错误"))
          }
        }).catch(function (e) { toast("打开失败：" + ((e && e.message) || "网络错误")) })
    }

    // ─── 接管 deliverables「已声明文件」卡片：是话布就开话布面板 ──────────
    // DSH 的 presented 卡片默认走 openFile()（DSH 文件打开器）；右侧菜单才是
    // 系统默认程序 / 文件管理器定位。若被声明的文件本身就是一份话布
    // （canvas-docs/<标题>.md），在话布里打开更合预期。
    // 规则：
    //   · 只接管两个预览热区，右侧菜单箭头（aria-haspopup="menu"）不碰，
    //     用户仍能用它调系统程序；
    //   · 只在该文件名能对应到一个已知话布时才接管，其他文件保持 DSH 原行为；
    //   · 必须靠捕获阶段监听才抢得到（见注册处），否则卡片自己的 onClick 先跑。
    // 卡片 → 话布：命中返回 {id,name}，否则 null。点击接管与悬停标记共用。
    function canvasForPresentedCard(card) {
      if (!card) return null
      var nameEl = card.querySelector('[class*="fileName"]')
      var name = nameEl ? String(nameEl.textContent || "").trim() : ""
      if (!/\.(md|markdown)$/i.test(name)) return null
      var title = name.replace(/\.(md|markdown)$/i, "")
      for (var i = 0; i < canvasList.length; i++) {
        if (canvasList[i].title === title) return { id: canvasList[i].id, name: name }
      }
      return null
    }
    // 命中话布的卡片打上 data-ccv-canvas：CSS 靠它隐藏 DSH 那句错误的悬停提示
    // （「在侧栏预览」——点击其实被我们接管去开话布面板了）
    function markPresentedCanvasCard(card) {
      if (!card || card.getAttribute("data-ccv-canvas") === "1") return
      if (canvasForPresentedCard(card)) card.setAttribute("data-ccv-canvas", "1")
    }

    function findPresentedCanvas(e) {
      var el = e.target
      if (!el || !el.closest) return null
      var card = el.closest("[data-presented-file]")
      if (!card) return null
      if (el.closest('button[aria-haspopup="menu"]')) return null
      markPresentedCanvasCard(card)
      var hit = canvasForPresentedCard(card)
      if (hit) {
        log("presented 卡片点击: 「" + hit.name + "」命中话布，转开话布面板")
        return hit
      }
      // 诊断：presented 卡片被点了，但没接管时要说清为什么（日志会落盘可复盘）
      var nameEl = card.querySelector('[class*="fileName"]')
      var nm = nameEl ? String(nameEl.textContent || "").trim() : ""
      if (!/\.(md|markdown)$/i.test(nm)) log("presented 卡片点击: 非 md（" + nm + "），不接管")
      else log("presented 卡片点击: 「" + nm + "」未命中话布（清单 " + canvasList.length + " 篇），交给 DSH")
      return null
    }

    // ─── 点击委托：文档名链接 + 上传卡片 + 路径卡片 + 原生短名卡片 ───
    function onClick(e) {
      try {
        // 优先级最高：deliverables 声明卡片（DSH 自己的处理在本函数之后才会跑）
        var pc = findPresentedCanvas(e)
        if (pc) {
          e.preventDefault()
          e.stopPropagation()
          openCanvas(pc.id)
          return
        }
        var cchip = findCanvasPathChip(e)
        if (cchip) {
          e.preventDefault()
          e.stopPropagation()
          openCanvasPathChip(cchip.rel)
          return
        }
        var lchip = findLocalDocPathChip(e)
        if (lchip) {
          e.preventDefault()
          e.stopPropagation()
          openLocalDocPath(lchip.path)
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
        // deliverables 声明卡片：命中话布的当场打标记（CSS 据此隐掉错误的悬停提示）
        var pcard = e.target && e.target.closest ? e.target.closest("[data-presented-file]") : null
        if (pcard) markPresentedCanvasCard(pcard)
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
        var lchip = findLocalDocPathChip(e)
        if (lchip && !lchip.el.__ccvChipMarked) {
          lchip.el.__ccvChipMarked = 1
          lchip.el.style.cursor = "pointer"
          lchip.el.title = "点击在话布中就地打开（编辑会写回原文件）"
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
    // ⚠️ click 必须用捕获阶段（第三参 true）：
    //    deliverables 的 presented 卡片自带 React onClick（走 DSH 文件打开器），
    //    React 18 把监听挂在根容器上，冒泡时会先于 document 上的监听触发。
    //    只有捕获阶段才抢得到它前面，才能把「打开话布」接上去。
    //    mouseover 不需要抢，保持冒泡即可（只做悬停提示）。
    document.addEventListener("click", onClick, true)
    document.addEventListener("mouseover", onHover, false)
    log("文件卡片点击接管已安装 v" + VERSION + "（清单 " + canvasList.length + " 篇）")
  } catch (e) {
    try { console.error("[doclink] 安装失败", e) } catch (_) {}
  }
})()
