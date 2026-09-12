// ═══ DSH Collab-Canvas · 文档拖拽上传（独立功能模块，单独一个文件维护）═══
// 交互：把非图片文件（md/txt/任意类型）拖进 DSH 窗口 → 上传到会话工作区 uploads/
//       文件夹 → @ 引用自动追加进 DSH 输入框 → 发送后 AI 用文件工具读全文
// 加载方式：DSH 每个插件只打包一个 client 入口（lib/client.js），本文件由
//           host 端点 /api/canvas/docdrop.js 提供源码，client 入口动态执行——
//           因此改本文件只需刷新页面，不用重启 dsh-web
//
// 健壮性约定：
//   1) 不依赖 DSH 模块加载器（自执行 IIFE，加载器对新模块可能延迟/忽略）
//   2) 监听挂在 window 捕获层（比 document 捕获更早，抢在 DSH 自带 drop 处理前）
//   3) 防重复安装：window 标记位
//   4) 图片拖拽、话布面板内部的拖拽一律不接管（不干扰 DSH 原生流程）
//   5) 每个回调独立捕获异常，任何一步失败只写诊断日志 + 提示条，绝不外溢
//   6) 多文件拖入时逐个上传，单个失败不影响其余
;(function () {
  try {
    if (window.__ccvDocdropInstalled) return

    var VERSION = 9   // v8: 拖入 canvas-docs/ 下的文件时，自动注册为话布（按标题找
                      //     已有，没有就新建）并 @ 原生相对路径 canvas-docs/xxx.md——
                      //     未注册的遗留文档从此能被 AI、点击、画布清单三方识别
    var ENDPOINT = "/api/canvas/import-doc"
    var MAX_BYTES = 100 * 1024 * 1024
    var PANEL_SELECTOR = "#collab-canvas-panel"

    // ─── 诊断日志（沿用插件现有落盘通道，失败静默）───
    // 优先用 client.js 挂出来的共用实现（见 client.js 里的 window.__ccvKit）：
    // 日志这份代码原本在 client/docdrop/doclink 三处各存了一份。
    // 取不到（加载顺序不同、或 client.js 是旧版）就退回下面这份等价副本。
    function log(msg) {
      var kit = window.__ccvKit
      if (kit && kit.log) { kit.log(msg, "docdrop"); return }
      try {
        fetch("/api/canvas/log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ line: "[docdrop] " + msg })
        }).catch(function () {})
      } catch (_) {}
    }

    // ─── 轻提示条（深浅主题自动反色，2.5 秒自动消失）───
    function toast(msg) {
      var kit = window.__ccvKit
      if (kit && kit.toast) { kit.toast(msg, "ccv-docdrop-toast"); return }
      try {
        var old = document.getElementById("ccv-docdrop-toast")
        if (old) old.remove()
        var t = document.createElement("div")
        t.id = "ccv-docdrop-toast"
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

    // ─── 找 DSH 输入框（与划词栏「问AI」同一套探测链，逐条判空）───
    function findDshInput() {
      var selectors = [
        'div[data-composer-input="true"]',
        '[data-slot="conversation.input"] textarea',
        '[data-slot="conversation.composer"] textarea',
        '[data-slot="conversation.composer.bar"] textarea',
        '[data-pane="conversation"] textarea',
        'textarea[placeholder*="发消息"]',
        'textarea[placeholder*="说话"]',
        'textarea[placeholder*="消息"]',
        'textarea[placeholder*="输入"]',
        '[contenteditable="true"][role="textbox"]'
      ]
      for (var i = 0; i < selectors.length; i++) {
        try {
          var el = document.querySelector(selectors[i])
          if (el) return el
        } catch (_) {}
      }
      return null
    }

    // ─── 追加文本到输入框（不清空已有内容；三种输入框形态分别处理）───
    function appendDraft(text) {
      var input = findDshInput()
      if (!input) { log("输入框未找到"); return false }
      try {
        if (input.tagName === "TEXTAREA") {
          var desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")
          var cur = (input.value || "").replace(/\s*$/, "")
          if (desc && typeof desc.set === "function") {
            desc.set.call(input, cur ? cur + "\n" + text : text)
          } else {
            input.value = cur ? cur + "\n" + text : text
          }
          input.dispatchEvent(new Event("input", { bubbles: true }))
        } else if (window.__ccvInputActions && typeof window.__ccvInputActions.setDraft === "function") {
          var st = window.__ccvInputState
          var cur2 = st && st.draft ? String(st.draft).replace(/\s*$/, "") : ""
          window.__ccvInputActions.setDraft(cur2 ? cur2 + "\n" + text : text)
        } else {
          var esc = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          input.innerHTML += "<div>" + esc + "</div>"
          input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text.slice(0, 20) }))
        }
        input.focus()
        return true
      } catch (e) {
        log("追加输入框失败: " + (e && e.message))
        return false
      }
    }

    // ─── 上传单个文档到会话工作区 ───
    function uploadDoc(file, onOk, onFail) {
      try {
        if (!file || typeof file.size !== "number") { onFail(file, "非法文件对象"); return }
        if (file.size > MAX_BYTES) { onFail(file, "超过 100MB 上限"); return }
        fetch(ENDPOINT + "?name=" + encodeURIComponent(file.name || "doc.md"), {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file
        }).then(function (r) { return r.json() }).then(function (d) {
          if (d && d.ok && d.path) onOk(d.path, file.name)
          else onFail(file, (d && d.error) || "接口返回异常")
        }).catch(function (e) { onFail(file, (e && e.message) || "网络错误") })
      } catch (e) { onFail(file, (e && e.message) || "上传异常") }
    }

    // ─── 拖拽判定 ───
    function inCanvasPanel(node) {
      try { return !!(node && node.closest && node.closest(PANEL_SELECTOR)) } catch (_) { return false }
    }
    function hasFileDrag(e) {
      try {
        return !!(e.dataTransfer && e.dataTransfer.types &&
          Array.prototype.indexOf.call(e.dataTransfer.types, "Files") >= 0)
      } catch (_) { return false }
    }
    // 只收非图片文件：图片拖拽完全留给 DSH 原生流程
    function collectNonImageFiles(e) {
      var out = []
      try {
        var items = e.dataTransfer && e.dataTransfer.items
        if (!items) return out
        for (var i = 0; i < items.length; i++) {
          var it = items[i]
          if (!it || it.kind !== "file") continue
          var f = it.getAsFile ? it.getAsFile() : null
          if (f && !(it.type && String(it.type).indexOf("image/") === 0)) out.push(f)
        }
      } catch (_) {}
      return out
    }

    // 会话键：读 client.js 每 2 秒同步的全局 sid（与画布面板同键）
    function sidQ() {
      var kit = window.__ccvKit
      if (kit && kit.sidQ) return kit.sidQ()
      try { const sid = window.__ccvSid; return sid ? "sid=" + encodeURIComponent(sid) : "sid=default"; } catch (_) { return "sid=default"; }
    }

    // ─── DSH 图片拖放层善后：我们拦截了 drop，DSH 收不到“拖放结束”信号，
    //     它的全屏“图片拖动到此处”层会一直挂着。补发 dragleave + 把残留层藏掉 ───
    function overlayDirectText(el) {
      // 只看元素自身的直接文本（避免命中把整页内容都算进 textContent 的外层容器）
      var s = ""
      var kids = el.childNodes || []
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].nodeType === 3) s += kids[i].nodeValue
      }
      return s
    }
    function dismissDshImageOverlay() {
      try { window.dispatchEvent(new DragEvent("dragleave")) } catch (_) {}
      try { document.dispatchEvent(new DragEvent("dragleave", { bubbles: true })) } catch (_) {}
      setTimeout(function () {
        try {
          var nodes = document.querySelectorAll("body *")
          for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i]
            if ((el.textContent || "").indexOf("图片拖动到此处即可添加") === -1) continue
            if (overlayDirectText(el).indexOf("图片拖动") === -1) continue
            // 命中文案元素 → 先看自己是不是 fixed/absolute 覆盖层（portal 直挂
            // body 的常见形态），再把祖先链上的覆盖层全部收起
            try { el.dispatchEvent(new DragEvent("dragleave", { bubbles: true })) } catch (_) {}
            var hidden = 0
            try {
              var csSelf = getComputedStyle(el)
              if (csSelf.position === "fixed" || csSelf.position === "absolute") {
                el.style.setProperty("display", "none", "important")
                hidden++
              }
            } catch (_) {}
            var node = el
            while (node.parentElement && node.parentElement !== document.body) {
              node = node.parentElement
              var cs = getComputedStyle(node)
              if (cs.position === "fixed" || cs.position === "absolute") {
                node.style.setProperty("display", "none", "important")
                hidden++
              }
            }
            if (hidden) {
              log("已收起 DSH 图片拖放残留层（" + hidden + " 层）")
            }
            break
          }
        } catch (_) {}
      }, 120)
    }

    // dragenter/dragover 阶段拿不到 File 对象，但 item.type 可读：据此判断
    // 是否“含非图片文件”的拖拽
    function nonImageFileDrag(e) {
      try {
        var items = e.dataTransfer && e.dataTransfer.items
        if (!items) return false
        var any = false
        for (var i = 0; i < items.length; i++) {
          var it = items[i]
          if (!it || it.kind !== "file") continue
          any = true
          if (!(it.type && String(it.type).indexOf("image/") === 0)) return true
        }
        return false
      } catch (_) { return false }
    }

    // ─── 安装（window 捕获层：window → document → … → 目标，比 DSH 的
    //     document 级监听更早触发）───
    function onDragEnter(e) {
      try {
        if (inCanvasPanel(e.target)) return
        // 非图片文件拖入：从 dragenter 就拦掉，DSH 的图片拖放层没有登场机会
        if (hasFileDrag(e) && nonImageFileDrag(e)) {
          e.preventDefault()
          e.stopImmediatePropagation()
        }
      } catch (_) {}
    }

    function onDragOver(e) {
      try {
        if (inCanvasPanel(e.target)) return
        // 只拦非图片文件拖拽；纯图片拖拽一个字节都不碰，DSH 原生逻辑全权处理
        if (hasFileDrag(e) && nonImageFileDrag(e)) {
          e.preventDefault()
          e.stopImmediatePropagation()
        }
      } catch (_) {}
    }

    function onDrop(e) {
      try {
        if (inCanvasPanel(e.target)) {
          // 话布面板内部：不接管，但挡掉浏览器默认行为（防止整页跳转到被拖文件）
          if (hasFileDrag(e)) e.preventDefault()
          return
        }
        var files = collectNonImageFiles(e)
        if (!files.length) return   // 纯图片或非文件拖拽 → 交给 DSH 原生

        e.preventDefault()
        e.stopImmediatePropagation()
        dismissDshImageOverlay()

        var pending = files.length
        var refs = []
        var usedFallback = false   // 登记表未命中、走了 uploads 副本
        function settle() {
          pending--
          if (pending > 0) return
          if (refs.length) {
            if (appendDraft(refs.join(" ") + " ")) {
              if (usedFallback && lastRegFolders === 0) {
                toast("登记表为空：本次已复制副本到 uploads/ 并引用。点话布工具栏「登记」登记常用文件夹后，拖拽将按真实路径引用")
              } else {
                toast("已处理 " + refs.length + " 个文档，@ 引用已插入输入框")
              }
            } else {
              toast("@ 引用生成失败——输入框未找到")
            }
          } else {
            toast("未生成引用（可能已取消或上传失败），详见诊断日志")
          }
        }
        // 查文件登记表：按文件名找真实路径（host 端索引）；同时记录登记表是否为空
        var lastRegFolders = -1
        function locateReal(name, cb) {
          try {
            fetch("/api/canvas/locate?name=" + encodeURIComponent(name)).then(function (r) { return r.json() }).then(function (d) {
              if (d && d.ok) lastRegFolders = (typeof d.folders === "number") ? d.folders : lastRegFolders
              if (d && d.ok && Array.isArray(d.matches) && d.matches.length) cb(d.matches)
              else cb(null)
            }).catch(function () { cb(null) })
          } catch (_) { cb(null) }
        }
        // 同名多文件：让用户选（prompt 同步，取消则放弃该文件）
        function pickMatch(matches, cb) {
          if (matches.length === 1) return cb(matches[0])
          var list = matches.map(function (m, i) { return (i + 1) + ". " + (m.rel || m.path) }).join("\n")
          var ans = prompt("同名文件有 " + matches.length + " 处，输入序号选择要引用的：\n" + list, "1")
          if (ans === null) return cb(null)
          var idx = parseInt(ans, 10)
          cb(idx >= 1 && idx <= matches.length ? matches[idx - 1] : null)
        }
        files.forEach(function (f) {
          locateReal(f.name, function (matches) {
            if (matches) {
              // 优先：canvas-docs/ 下的文件（画布文档，含未注册的遗留文档）
              // → host 注册为话布（已有则复用）+ @ 原生相对路径，三方（AI/点击/清单）全识别
              var docHit = null
              matches.forEach(function (m) { if (!docHit && m.docsRel) docHit = m })
              if (docHit) {
                fetch("/api/canvas/load-doc?rel=" + encodeURIComponent(docHit.docsRel) + "&" + sidQ()).then(function (r) { return r.json() }).then(function (d) {
                  if (d && d.ok && d.id) toast((d.created ? "已登记为话布并引用：" : "已引用话布文档：") + "canvas-docs/" + f.name)
                  refs.push("@" + docHit.docsRel)
                  settle()
                }).catch(function () {
                  // 注册接口失败也不阻断：仍引用相对路径
                  refs.push("@" + docHit.docsRel)
                  settle()
                })
                return
              }
              // 其次：登记表命中（工作区内其他文件）→ @ 相对/绝对真实路径
              pickMatch(matches, function (hit) {
                if (!hit) { settle(); return }   // 用户取消选择
                refs.push("@" + (hit.rel || hit.path))
                settle()
              })
              return
            }
            // 登记表未命中 → 回退：复制进工作区 uploads/，@ 副本路径
            uploadDoc(f, function (p) {
              usedFallback = true
              refs.push("@" + p)
              settle()
            }, function (f2, why) {
              log("上传失败 " + ((f2 && f2.name) || "?") + ": " + why)
              settle()
            })
          })
        })
      } catch (e) {
        log("drop 处理异常: " + (e && e.message))
      }
    }

    window.addEventListener("dragenter", onDragEnter, true)
    window.addEventListener("dragover", onDragOver, true)
    window.addEventListener("drop", onDrop, true)
    window.__ccvDocdropInstalled = true
    log("文档拖拽接管已安装 v" + VERSION + "（window 捕获层，dragenter 起拦截）")
  } catch (e) {
    try { console.error("[docdrop] 安装失败", e) } catch (_) {}
  }
})()
