// 画布编辑器客户端模块——通过 DSH composition 客户端加载器加载
window.__ModuleLoader__.load({
  id: "collab-canvas",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // 独立功能模块动态挂载（源码各自单文件维护，由 host 端点提供，读盘即最新，
    // 改完刷新页面即可）。引导失败只影响对应功能，画布本体不受影响。
    try {
      if (!window.__ccvSideModulesBooted) {
        window.__ccvSideModulesBooted = true;
        ["/api/canvas/docdrop.js", "/api/canvas/doclink.js"].forEach(function (u) {
          var name = u.slice(u.lastIndexOf("/") + 1);
          fetch(u + "?ts=" + Date.now()).then(function (r) {
            ccvLog(name + ": 源码拉取 HTTP " + r.status);
            return r.ok ? r.text() : "";
          }).then(function (src) {
            if (!src) { ccvLog(name + ": 源码为空，跳过"); return; }
            try {
              new Function(src)();
              ccvLog(name + ": 模块执行完成");
            } catch (e) { ccvLog(name + ": 模块执行失败 " + (e && e.message)); }
          }).catch(function (e) { ccvLog(name + ": 拉取失败 " + (e && e.message)); });
        });
      }
    } catch (e) { try { ccvLog("侧模块引导异常 " + (e && e.message)); } catch (_) {} }

    const React = require("react");
    const { createElement: h, useState, useEffect, useRef } = React;

    // ─── 诊断日志（排障用，可整段删除）────────────────────
    // 本环境开不了浏览器控制台，把划词链路的关键判定点发到 host，
    // 由 host 落盘到 %TEMP%/ccv-selbar.log，之后直接读文件复盘。
    // ─── 会话标识：侧边栏「当前选中会话行」的标题 ───
    // 选中行有独立的 selected 类，切会话即变、同会话稳定——比窗口标题可靠
    //（窗口标题会随视图/加载状态变成无会话名的形态，导致键漂移）
    function hashStr(s) {
      let h = 5381;
      for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; }
      return h.toString(36);
    }
    // 标题形如 "DeepSeek Harness - <会话名> — DeepSeek Harness"，随会话切换变化；
    // 哈希保证不同会话不同键，同会话稳定。每个会话的画布清单互相独立。
    function activeSessionTitle() {
      try {
        const row = document.querySelector('[class*="sessionRow"][class*="selected"]') ||
                    document.querySelector('[class*="sessionRow"][class*="active"]');
        if (!row) return null;
        const t = row.querySelector('[class*="title"]');
        const name = ((t || row).textContent || "").trim();
        return name || null;
      } catch (_) {}
      return null;
    }
    function sessionKey() {
      const name = activeSessionTitle();
      if (name) return "sess-" + hashStr(name);
      const t = (document.title || "默认会话").trim() || "默认会话";
      return "t" + hashStr(t);
    }
    function canvasApi(path) {
      try { return path + (path.indexOf("?") >= 0 ? "&" : "?") + "sid=" + encodeURIComponent(sessionKey()); } catch (_) { return path; }
    }
    function ccvLog(msg) {
      try {
        fetch("/api/canvas/log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lines: [String(msg)] })
        }).then(function () {}, function () {});
      } catch (_) {}
    }
    // 只在高频路径上用的日志：CCV_DEBUG 关着时连字符串拼接都不做（msg 可传函数，按需求值）
    function ccvLogD(msg) {
      if (!CCV_DEBUG) return;
      try { ccvLog(typeof msg === "function" ? msg() : msg); } catch (_) {}
    }
    // ─── 子模块共用的小工具 ────────────────────────────────
    // docdrop.js / doclink.js 是「单文件、由 host 按请求供源码」的模块：改完刷新页面即生效、
    // 不用重启。代价是它们没法互相 require，只能复制代码 —— 日志、轻提示条、会话查询串
    // 因此在三处各存了一份。这里挂个全局命名空间给它们取用；取不到就各自退回自带的副本，
    // 所以加载顺序变了也不会坏。
    window.__ccvKit = {
      // 统一走 /api/canvas/log；tag 会前置成 [tag]
      log: function (msg, tag) {
        ccvLog(tag ? "[" + tag + "] " + msg : msg);
      },
      // 轻提示条。id 由调用方给：原来两处各用自己的 id、各自去重，这里保持同样口径。
      toast: function (msg, id) {
        try {
          var tid = id || "ccv-kit-toast";
          var old = document.getElementById(tid);
          if (old) old.remove();
          var t = document.createElement("div");
          t.id = tid;
          t.textContent = msg;
          t.style.cssText = "position:fixed;left:50%;bottom:96px;transform:translateX(-50%);" +
            "z-index:2147483000;background:var(--dsw-alias-label-primary,#1a1a1a);" +
            "color:var(--dsw-alias-bg-overlay,#fff);font-size:13px;padding:8px 14px;" +
            "border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.25);pointer-events:none;" +
            "opacity:1;transition:opacity .3s";
          document.body.appendChild(t);
          setTimeout(function () { t.style.opacity = "0" }, 2200);
          setTimeout(function () { if (t.parentNode) t.remove() }, 2600);
        } catch (_) {}
      },
      // 会话查询串片段（形如 "sid=xxx"）。刻意读 window.__ccvSid 而不是直接调 sessionKey()：
      // 与子模块原来的口径完全一致（首帧 __ccvSid 还没算出来时退成 sid=default）。
      sidQ: function () {
        try { var sid = window.__ccvSid; return sid ? "sid=" + encodeURIComponent(sid) : "sid=default"; } catch (_) { return "sid=default"; }
      }
    };
    // 会话键同步：轮询当前会话键，变化时更新全局 sid（docdrop/doclink 读取）
    try {
      if (!window.__ccvSidTimer) {
        window.__ccvSidTimer = setInterval(function () {
          try {
            const k = sessionKey();
            if (window.__ccvSid !== k) {
              const first = !window.__ccvSid;
              window.__ccvSid = k;
              ccvLog("会话键" + (first ? "" : " 更新") + ": " + k + (activeSessionTitle() ? " | 侧栏选中行命中" : " | 未识别到选中会话"));
            }
          } catch (_) {}
        }, 2000);
      }
    } catch (_) {}
    // 会话键诊断：每次页面加载记录一次解析结果，便于排障
    try {
      if (!window.__ccvSessKeyLogged) {
        window.__ccvSessKeyLogged = true;
        ccvLog("会话键: " + sessionKey() + " | 窗口标题: " + (document.title || ""));
      }
    } catch (_) {}
    function ccvDesc(el) {
      if (!el) return "null";
      return el.tagName + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.split(/\s+/).slice(0, 2).join(".") : "");
    }

    // ─── 停靠模式（右侧栏）─────────────────────────────
    // 右侧栏的标签一切走，正文组件就被整个卸载重建（实测「正文已挂载」每次 +1）。
    // 也就是说：界面上的东西没有任何一样能指望它自己记得住。
    // 于是——① 面板实例放到模块级，方便别处复用；② 用户「刚敲进去、还没写盘」
    // 的内容在卸载前抢存一份到 localStorage，切回来时先恢复它。
    var CCV_DOCK_KIND = "collab-canvas";
    // 🔍 高频路径的调试日志开关。默认 false —— 因为"鼠标松开 / 划词判定 / 隐藏划词栏"
    //    这类动作一秒能触发几十次，每次都在拼调用栈并发一条网络请求写盘，属于实打实的卡顿源。
    //    平时静默；排查划词相关问题时把它改成 true，这些日志就会照旧出现。
    //    低频日志（各种 catch 里的失败原因）不受影响，永远都会记。
    var CCV_DEBUG = false;
    // client.js 的版本标记。改动后**必须**在这里 +1，否则无法从日志核对浏览器
    // 加载的是哪一版（本环境开不了控制台，日志是唯一的核对通道）。
    //   v1  2026-09-12 起：并发保护（knownVer + 冲突处理）、草稿基准版本校验、
    //      行内规则先抽出后还原、列表往返修复
    //   v2  2026-09-12：引用块带上来源 @md 路径（ccvDocMention），
    //      多行选区逐行加 ">" 引号
    //   v3  2026-09-12：@ 来源改用 host 给的真实绝对路径（含空格走 @"..." 引号形式），
    //      不再自己拼相对路径 canvas-docs/<标题>.md
    //   v4  2026-09-14：「过期草稿」提示改为只提示一次（加 notified 标记），并缩短文案
    //   v5  2026-09-14：代码围栏的语言标记不再丢失（mdToHtml 存到 <pre data-lang>，
    //      htmlToMd 读回）；补了往返测试用例堵住这个盲区
    var CCV_CLIENT_VERSION = 5;
    var CCV_DRAFT_KEY = "ccv-draft-cache";    // { [canvasId]: { content, at, base } }
    var ccvCtx = null;                        // 模块级 ctx：tab 正文是独立组件，拿不到 apply 的闭包
    var ccvLiveEditor = null;                 // 当前编辑区 DOM。组件卸载后 React 会把 ref 置空，
    var ccvLiveCanvasId = null;               // 但我们自己留的这份引用仍能读到用户刚敲的字。
    var ccvLiveVer = 0;                       // 本机已知的服务端版本号（组件内 versionRef 的镜像）
    function ccvDrafts() {
      try { var o = JSON.parse(localStorage.getItem(CCV_DRAFT_KEY) || "{}"); return o && typeof o === "object" ? o : {}; } catch (_) { return {}; }
    }
    function draftGet(id) {
      if (!id) return null;
      var d = ccvDrafts()[id];
      return d && typeof d.content === "string" ? d : null;
    }
    // 大文档（画布内嵌图片时动辄几百 KB）不进 localStorage：写配额报错比丢草稿更烦人。
    var CCV_DRAFT_MAX = 400 * 1024;
    // base = 这份草稿是基于服务端哪一版写出来的。**必须记**：
    // loadCanvas 恢复草稿后会补写回服务端，若拿服务端的「当前版本」当 knownVer，
    // 一份基于旧版本的草稿就会被当成合法写入、直接覆盖新内容 ——
    // 话布优化文档两次被整段抹掉都是这个路径干的。
    function draftSet(id, content, base) {
      if (!id || typeof content !== "string") return;
      if (content.length > CCV_DRAFT_MAX) return;
      var b = (typeof base === "number") ? base : (typeof ccvLiveVer === "number" ? ccvLiveVer : null);
      // notified 每次写新草稿都归零：新内容可能又是一份会过期的草稿，该提示还得提示
      try { var all = ccvDrafts(); all[id] = { content: content, at: Date.now(), base: b, notified: false }; localStorage.setItem(CCV_DRAFT_KEY, JSON.stringify(all)); } catch (_) {}
    }
    // 标记「这份草稿过期的事已经提示过了」。
    // 没有它的话，草稿会一直躺在 localStorage 里，每次打开这篇话布都弹一次同样的提示 ——
    // 而用户看了也无事可做，只能无视（2026-09-14 手机上实测到这个问题）。
    function draftMarkNotified(id) {
      if (!id) return;
      try {
        var all = ccvDrafts();
        if (all[id]) { all[id].notified = true; localStorage.setItem(CCV_DRAFT_KEY, JSON.stringify(all)); }
      } catch (_) {}
    }
    function draftDrop(id) {
      if (!id) return;
      try { var all = ccvDrafts(); if (all[id]) { delete all[id]; localStorage.setItem(CCV_DRAFT_KEY, JSON.stringify(all)); } } catch (_) {}
    }
    // 只有「存盘成功的那一版」才清草稿：如果这期间用户又敲了新内容，草稿得更新，不能清。
    function draftDropIf(id, md) {
      var d = draftGet(id);
      if (d && d.content === md) draftDrop(id);
    }

    // 窄屏（手机/平板竖屏）：分栏拖拽没法用，话布一律全屏铺满。
    // 阈值 768 是常见断点；同时认 coarse pointer（触屏）兜底。
    var NARROW_MAX = 768;
    function isNarrow() {
      if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches &&
          window.innerWidth < 1024) return true;
      return window.innerWidth < NARROW_MAX;
    }

    // ─── Markdown ↔ HTML 转换（纯函数）────────────────────
    // 2026-09-12 从 CanvasPanel 里搬到这里。理由：这两个只依赖传进来的 DOM / 字符串，
    // 不碰任何组件状态，却被写在组件内部 —— 组件每渲染一次就重新创建一遍它们，
    // 而组件在打字时每次输入都会重渲染。搬出来同时让巨型组件少了 413 行。
    // 搬动有等价性测试守着（工作区 _md_test.js：改前改后 22 个用例的产物逐字节一致）。
    // ⚠️ 别再搬回组件里 —— 它们和组件状态无关，放回去只会重新引入上面的浪费。
    function htmlToMd(root) {
      var fnDefs = [];
      // 对齐：execCommand('justifyCenter'/'justifyRight') 会在块元素上留 align 属性
      // 或 text-align 内联样式。markdown 没有对齐语法，存成 ::: center/right 围栏，
      // 渲染端 renderBlocks 负责转回 <div style="text-align:...">
      function blockAlign(el) {
        if (!el || !el.getAttribute) return "";
        var a = (el.getAttribute("align") || "").toLowerCase();
        if (a === "center" || a === "right") return a;
        var m = (el.getAttribute("style") || "").match(/text-align\s*:\s*(center|right)/i);
        if (m) return m[1].toLowerCase();
        try { var ta = el.style && el.style.textAlign; if (ta === "center" || ta === "right") return ta; } catch (_) {}
        return "";
      }
      function withAlign(al, md) {
        if (!al) return md;
        return "::: " + al + "\n" + md.replace(/\n*$/, "\n") + ":::\n";
      }
      function withFence(kind, md) {
        return "::: " + kind + "\n" + md.replace(/\n*$/, "\n") + ":::\n";
      }
      // 编辑器里 <img>/<a> 的 src/href 是 host 读文件接口地址（插入时就要能显示）；
      // 存盘换回 attachments/ 相对路径，md 文件保持可携带、跟着画布文件夹走
      function assetMdPath(u) {
        var m = String(u).match(/^\/api\/canvas\/file\?name=([^&]+)$/);
        if (m) {
          try {
            var d = decodeURIComponent(m[1]);
            if (d.indexOf("attachments/") === 0) return d;
          } catch (_) {}
        }
        return u;
      }
      function w(n) {
        if (n.nodeType === 3) return n.nodeValue.replace(/\u00a0/g, " ");
        if (n.nodeType !== 1) return "";
        // ⚠️ 脚注区域必须在 switch 之前拦截：.footnotes 是 <div>，
        // 走 case "div" 会把它当普通正文输出，脚注定义就退化成
        // "脚注 1 的内容 [↩](#fnref-1)" 这种半 markdown 的残渣。
        if (n.classList && n.classList.contains('footnotes')) {
          var lis = n.querySelectorAll('li');
          for (var li2 = 0; li2 < lis.length; li2++) {
            var liId = lis[li2].getAttribute('id') || '';
            var liLabel = liId.indexOf('fn-') === 0 ? liId.slice(3) : '';
            if (!liLabel) continue;
            // 逐子节点序列化，跳过返回链接 ↩（href="#fnref-*"），保留其余行内格式
            var parts = [];
            var kids = lis[li2].childNodes || [];
            for (var ki = 0; ki < kids.length; ki++) {
              var kid = kids[ki];
              if (kid.nodeType === 1) {
                var kh = (kid.getAttribute && kid.getAttribute('href')) || '';
                if (kh.indexOf('#fnref-') === 0) continue;
              }
              parts.push(w(kid));
            }
            var liContent = parts.join('').replace(/\s*↩\s*$/, '').trim();
            fnDefs.push('[^' + liLabel + ']: ' + liContent);
          }
          return '';
        }
        var t = n.tagName ? n.tagName.toLowerCase() : "";
        if (t === "br") return "\n";
        var inner = Array.prototype.map.call(n.childNodes || [], w).join("");
        switch (t) {
          case "div": case "p": {
            // 高亮块：mdToHtml 渲染 ::: highlight 时打的 class，序列化回围栏
            if (t === "div" && n.classList && n.classList.contains("ccv-hl")) {
              return withFence("highlight", inner);
            }
            return withAlign(blockAlign(n), inner + "\n");
          }
          case "h1": return withAlign(blockAlign(n), "# " + inner + "\n");
          case "h2": return withAlign(blockAlign(n), "## " + inner + "\n");
          case "h3": return withAlign(blockAlign(n), "### " + inner + "\n");
          case "h4": return withAlign(blockAlign(n), "#### " + inner + "\n");
          case "h5": return withAlign(blockAlign(n), "##### " + inner + "\n");
          case "h6": return withAlign(blockAlign(n), "###### " + inner + "\n");
          case "img": {
            var iSrc = n.getAttribute && n.getAttribute("src") || "";
            var iAlt = n.getAttribute && n.getAttribute("alt") || "";
            return iSrc ? "![" + iAlt + "](" + assetMdPath(iSrc) + ")" : "";
          }
          case "ul": case "ol": return renderListMd(n, "");
          case "li": {
            var pN = n.parentNode;
            var pOrdered = pN && pN.tagName && pN.tagName.toLowerCase() === "ol";
            return serializeLi(n, pOrdered ? "1. " : "- ", "", pOrdered ? "   " : "  ");
          }
          case "strong": case "b": return inner ? "**" + inner + "**" : "";
          case "em": case "i": return inner ? "*" + inner + "*" : "";
          // markdown 没有下划线语法，用 ++文字++ 扩展标记存（渲染端 im 负责转回 <u>）。
          // 之前直接存 <u> 原始标签，mdToHtml 的 esc 会把它转义成字面文字，重开画布就露馅
          case "u": case "ins": return inner ? "++" + inner + "++" : "";
          // 高亮：==文字== ↔ <mark>
          case "mark": return inner ? "==" + inner + "==" : "";
          case "strike": case "s": case "del": return inner ? "~~" + inner + "~~" : "";
          case "code": return "`" + inner + "`";
          case "pre": {
            // 语言标记从 mdToHtml 打在 <pre data-lang> 上取回；没有就是裸围栏
            var pLang = (n.getAttribute && n.getAttribute("data-lang")) || "";
            return "\n```" + pLang + "\n" + (n.textContent || "") + "\n```\n";
          }
          case "blockquote": return inner.trim() ? inner.trim().split("\n").map(l => "> " + l).join("\n") + "\n" : "";
          case "table": {
            // <table> 必须显式序列化成 markdown 表格；走 default 会把单元格文本
            // 压成一坨（含 ` 的 code 单元格混在一起），重新打开就没格式了
            var tblTrs = n.querySelectorAll ? n.querySelectorAll("tr") : [];
            if (!tblTrs.length) return "";
            var tblRows = [], tblW = 0;
            for (var trI = 0; trI < tblTrs.length; trI++) {
              var tds = tblTrs[trI].querySelectorAll("th,td");
              if (!tds.length) continue;
              var rowArr = [];
              for (var tdI = 0; tdI < tds.length; tdI++) {
                var cellMd = Array.prototype.map.call(tds[tdI].childNodes || [], w).join("");
                cellMd = cellMd.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
                rowArr.push(cellMd);
              }
              if (rowArr.length > tblW) tblW = rowArr.length;
              tblRows.push(rowArr);
            }
            if (!tblRows.length) return "";
            var tblOut = [];
            for (var trJ = 0; trJ < tblRows.length; trJ++) {
              while (tblRows[trJ].length < tblW) tblRows[trJ].push("");
              tblOut.push("| " + tblRows[trJ].join(" | ") + " |");
              if (trJ === 0) {
                var sepArr = [];
                for (var scI = 0; scI < tblW; scI++) sepArr.push("---");
                tblOut.push("| " + sepArr.join(" | ") + " |");
              }
            }
            return "\n" + tblOut.join("\n") + "\n";
          }
          case "a":
            var href = n.getAttribute && n.getAttribute("href") || "";
            // 脚注引用链接：<a href="#fn-label">...</a> → [^label]
            if (href.indexOf("#fn-") === 0) {
              return "[^" + href.replace("#fn-", "") + "]";
            }
            return "[" + inner + "](" + assetMdPath(href) + ")";
          case "hr": return "\n---\n";
          case "sup":
            // 脚注引用：<sup><a href="#fn-label">[label]</a></sup>
            var aTag = n.querySelector ? n.querySelector('a[href^="#fn-"]') : null;
            if (!aTag) {
              // 兼容：遍历子节点找 a
              var children = Array.prototype.slice.call(n.childNodes);
              for (var ci = 0; ci < children.length; ci++) {
                if (children[ci].nodeType === 1 && children[ci].tagName.toLowerCase() === 'a') {
                  var h = children[ci].getAttribute('href') || '';
                  if (h.indexOf('#fn-') === 0) { aTag = children[ci]; break; }
                }
              }
            }
            if (aTag) {
              var href2 = aTag.getAttribute('href') || '';
              var label = href2.replace('#fn-', '');
              return '[^' + label + ']';
            }
            return inner;
          default:
            // 脚注引用 span：<span id="fnref-label">...</span> → [^label]
            if (n.id && n.id.indexOf("fnref-") === 0) {
              return "[^" + n.id.replace("fnref-", "") + "]";
            }
            return inner;
        }
      }
      // 列表递归序列化：把 <ul>/<ol>（含嵌套子列表、任务列表复选框）还原成带缩进的 Markdown
      function renderListMd(node, pad) {
        var isOl = node.tagName.toLowerCase() === "ol";
        var unit = isOl ? "   " : "  ";
        var childPad = pad + unit;
        var liOut = [];
        var liNum = 0;
        var kids = node.childNodes || [];
        for (var x = 0; x < kids.length; x++) {
          var el = kids[x];
          if (!el || el.nodeType !== 1) continue;
          var lt = el.tagName.toLowerCase();
          if (lt === "ul" || lt === "ol") {
            // 子列表作为兄弟节点（contentEditable 偶尔这样存）→ 整体缩进并入上一级
            var sub = renderListMd(el, childPad).replace(/^\n+/, "").replace(/\n+$/, "");
            if (sub) liOut.push(sub);
            continue;
          }
          if (lt !== "li") continue;
          liNum++;
          var marker = isOl ? (liNum + ". ") : "- ";
          liOut.push(serializeLi(el, marker, pad, childPad));
        }
        if (!liOut.length) return "";
        return "\n" + liOut.join("\n") + "\n";
      }
      function serializeLi(liEl, marker, pad, childPad) {
        // 任务列表：<li> 内含 <input type="checkbox"> → 还原成 - [ ] / - [x]
        var cb = liEl.querySelector ? liEl.querySelector('input[type="checkbox"],input[type=checkbox]') : null;
        var isTask = !!cb;
        var checked = isTask && (cb.hasAttribute("checked") || cb.checked);
        var parts = [];
        var kids = liEl.childNodes || [];
        for (var k = 0; k < kids.length; k++) {
          var kid = kids[k];
          if (kid.nodeType === 1) {
            var kn = kid.tagName.toLowerCase();
            if (kn === "input") continue; // 跳过复选框本身
            if (kn === "ul" || kn === "ol") {
              parts.push("\n" + renderListMd(kid, childPad).replace(/^\n+/, "").replace(/\n+$/, ""));
              continue;
            }
          }
          parts.push(w(kid));
        }
        var inner = parts.join("").replace(/^\n+/, "").replace(/\n+$/, "");
        // 任务列表：mdToHtml 渲染成 `<input …> 内容`，跳过 input 后那个前导空格
        // 会留在文本节点里，拼出来就是 "- [ ]  内容"（两个空格）。这里吃掉它。
        if (isTask) inner = inner.replace(/^[ \t]+/, "");
        var lns = inner.split("\n");
        var out = pad + (isTask ? ("- [" + (checked ? "x" : " ") + "] ") : marker) + lns[0];
        for (var j = 1; j < lns.length; j++) {
          var ln = lns[j];
          // ⚠️ 嵌套列表已经由 renderListMd(kid, childPad) 按 childPad 缩进过了，
          //    这里再加一次 pad 会变成双倍缩进（三级列表 4 空格漂成 6 空格）。
          //    判据：已带前导空白 = 自己管好了缩进，直接原样输出；空行保持空。
          out += "\n" + (ln === "" ? "" : (/^[ \t]/.test(ln) ? ln : pad + ln));
        }
        return out;
      }
      var md = w(root).replace(/\n{3,}/g, "\n\n").trim();
      // 追加脚注定义
      if (fnDefs.length > 0) {
        md += '\n\n' + fnDefs.join('\n');
      }
      return md;
    }

    function mdToHtml(src) {
      if (!src) return "";
      function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
      // 附件相对路径（attachments/…）重写成 host 读文件接口；编辑器里才能显示。
      // 存盘的 md 始终保持相对路径，画布文件夹整个挪走/换机器都不断链
      function resolveAssetUrl(u) {
        if (/^attachments\//.test(u)) return "/api/canvas/file?name=" + encodeURIComponent(u)
        return u
      }
      function im(s) {
        // ⚠️ 行内代码必须「先抽出、后还原」。
        //    代码跨度里的 * ~ = + 等字符不是标记。若先把代码换成 <code> HTML、
        //    再跑强调规则，`\*([^*]+)\*` 会跨过 <code> 边界配对，生成非法嵌套
        //    （<em>…<code>…</em>…</code>）；浏览器纠正该 DOM 后，htmlToMd 再把它
        //    序列化回 markdown，反引号位置就错乱了 —— 文档被静默破坏。
        //    实例：**移除全部 `emit(EV.*)` 调用** 会变成 **移除全部 `emit(EV.`*`)` 调用**。
        //    做法：先把代码替换成不含标记字符的占位符，跑完全部行内规则再还原。
        var codes = []
        var body = esc(s).replace(/`([^`]+)`/g, function (_mc, code) {
          codes.push(code)
          return '\u0000C' + (codes.length - 1) + '\u0000'
        })
        var out = body
          // 兼容旧版直接存进 md 的 <u> 原始标签（已被 esc 转义成 &lt;u&gt;）→ 转回真下划线
          .replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, '<u>$1</u>')
          // 兼容旧版 htmlToMd 产生的 [[label]](#fn-label) 手写链接 → 转成规范脚注引用
          .replace(/\[\[([^\]]+)\]\]\(#fn-([^)]+)\)/g, '<a href="#fn-$2" id="fnref-$2" contenteditable="false" style="vertical-align:super;font-size:.75em;color:#3b82f6;cursor:pointer;text-decoration:none">[$2]</a>')
          // ⚠️ 图片必须先于链接规则处理：!\[alt\](src) 里的 [alt](src) 会被链接
          // 规则啃掉，渲染成 !<a href="src">alt</a> 这种残骸
          .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (_m0, alt, src) {
            return '<img src="' + resolveAssetUrl(src) + '" alt="' + alt + '" style="max-width:100%;height:auto;vertical-align:middle"/>'
          })
          .replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_m1, txt, href) {
            // title 悬停显示 md 里写的原始地址；esc 不管引号，title 属性里自己补 &quot;
            return '<a href="' + resolveAssetUrl(href) + '" title="' + String(href).replace(/"/g, '&quot;') + '">' + txt + '</a>'
          })
          // 注：代码跨度已在上面抽走，这里的 * 只可能是真标记，不会跨界误配对
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
          .replace(/\*([^*]+)\*/g, "<em>$1</em>")
          .replace(/~~([^~]+)~~/g, "<del>$1</del>")
          .replace(/\+\+([^+]+)\+\+/g, "<u>$1</u>")
          .replace(/==([^=]+)==/g, "<mark>$1</mark>")
          .replace(/\[\^([^\]]+)\](?!:)/g, '<a href="#fn-$1" id="fnref-$1" contenteditable="false" style="vertical-align:super;font-size:.75em;color:#3b82f6;cursor:pointer;text-decoration:none">[$1]</a>')
        // 还原代码跨度（内容在 esc 阶段已转义，直接放回）
        return out.replace(/\u0000C(\d+)\u0000/g, function (_mr, idx) {
          return '<code>' + codes[Number(idx)] + '</code>'
        })
      }
      // 块级渲染（可递归：blockquote 内部再走一遍同样的块解析，支持引用里套表格/列表）
      function buildTable(ls) {
        var rows = [];
        for (var k = 0; k < ls.length; k++) {
          if (k === 1) continue; // 第二行是 |---|---| 分隔行
          var raw = ls[k].trim().replace(/^\|/, "").replace(/\|$/, "");
          var cells = raw.split("|").map(function (c) { return im(c.trim()); });
          rows.push(cells);
        }
        var tbl = "<table>";
        for (var k2 = 0; k2 < rows.length; k2++) {
          var tag = k2 === 0 ? "th" : "td";
          tbl += "<tr>" + rows[k2].map(function (c) { return "<" + tag + ">" + c + "</" + tag + ">"; }).join("") + "</tr>";
        }
        return tbl + "</table>";
      }
      function renderBlocks(src2) {
        var lines = String(src2).split("\n"), out = [], i = 0, inCode = false, codeBuf = [];
        // 开围栏那一行本身不进 codeBuf，但它尾巴上的语言标记（```js）必须留下 ——
        // 否则往返一次语言就没了（htmlToMd 只能输出裸围栏）。
        // 存在 <pre data-lang> 上，htmlToMd 的 case "pre" 再读回来。
        var codeLang = "";
        while (i < lines.length) {
          var l = lines[i];
          if (/^```/.test(l)) {
            if (!inCode) { inCode = true; codeBuf = []; codeLang = String(l).replace(/^```/, "").trim(); }
            else { out.push("<pre" + (codeLang ? ' data-lang="' + esc(codeLang) + '"' : "") + "><code>" + esc(codeBuf.join("\n")) + "</code></pre>"); inCode = false; codeLang = ""; }
            i++; continue;
          }
          if (inCode) { codeBuf.push(l); i++; continue; }
          var t = l.trim(); if (!t) { i++; continue; }
          var h2 = t.match(/^(#{1,6})\s+(.*)$/); if (h2) { out.push("<h" + h2[1].length + ">" + im(h2[2]) + "</h" + h2[1].length + ">"); i++; continue; }
          if (/^(-{3,}|\*{3,})$/.test(t)) { out.push("<hr/>"); i++; continue; }
          // ::: 围栏：center/right/left 对齐 + highlight 高亮块，同一套机制，
          // 支持嵌套（depth 计数），内部递归渲染，标题/列表/引用放进去都行
          var alM = t.match(/^:::\s*(center|right|left|highlight)\s*$/i);
          if (alM) {
            var alInner = [], alDepth = 1;
            i++;
            while (i < lines.length) {
              var alT = lines[i].trim();
              if (/^:::\s*$/.test(alT)) { alDepth--; if (!alDepth) { i++; break; } }
              else if (/^:::\s*(center|right|left|highlight)\s*$/i.test(alT)) alDepth++;
              alInner.push(lines[i]); i++;
            }
            var alKind = alM[1].toLowerCase();
            out.push(alKind === "highlight"
              ? '<div class="ccv-hl">' + renderBlocks(alInner.join("\n")) + "</div>"
              : '<div style="text-align:' + alKind + '">' + renderBlocks(alInner.join("\n")) + "</div>");
            continue;
          }
          // 表格：本行含 |，且下一行是 |---|---| 形式的分隔行 → 收集连续 | 行成表
          if (t.indexOf("|") >= 0 && i + 1 < lines.length) {
            var next = lines[i + 1].trim();
            if (next.indexOf("|") >= 0 && next.indexOf("-") >= 0 && /^\|?[\s:|-]+\|?$/.test(next)) {
              var tblLines = [t];
              // ⚠️ 只 i+=1：分隔行也要进 tblLines（buildTable 靠 ls[1] 是分隔行来跳过它），
              // 若在这里 i+=2 跳过分隔行，第一行正文会被 buildTable 当分隔行吃掉
              i += 1;
              while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") >= 0) { tblLines.push(lines[i].trim()); i++; }
              out.push(buildTable(tblLines));
              continue;
            }
          }
          // 引用：连续 > 行合并为一个 blockquote，内部递归块渲染
          if (/^>\s?/.test(t)) {
            var bqLines = [];
            while (i < lines.length && /^\s*>\s?/.test(lines[i])) { bqLines.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
            out.push("<blockquote>" + renderBlocks(bqLines.join("\n")) + "</blockquote>");
            continue;
          }
          // 列表（支持嵌套缩进 + 任务列表 - [ ]/- [x]）：连续列表项（含缩进子项）合成嵌套 <ul>/<ol>
          if (/^\s*[-*+]\s+/.test(t) || /^\s*\d+[.)]\s+/.test(t)) {
            var listLines = [];
            while (i < lines.length) {
              var lm = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
              if (lm) { listLines.push(lines[i]); i++; continue; }
              break;
            }
            out.push(parseList(listLines));
            continue;
          }
          out.push("<p>" + im(t) + "</p>"); i++;
        }
      if (inCode) out.push("<pre" + (codeLang ? ' data-lang="' + esc(codeLang) + '"' : "") + "><code>" + esc(codeBuf.join("\n")) + "</code></pre>");
      return out.join("\n");
    }
      // 列表解析：把一组列表行（含缩进子项）解析成嵌套树，再渲染成 <ul>/<ol>。
      // 支持 - * + 无序、1. 有序、以及任务列表 - [ ] / - [x]（渲染成复选框）。
      function parseList(listLines) {
        var items = [];
        for (var k = 0; k < listLines.length; k++) {
          var m = listLines[k].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (!m) continue;
          var indent = m[1].replace(/\t/g, "  ").length;
          items.push({ indent: indent, ordered: /\d/.test(m[2]), content: m[3] });
        }
        if (!items.length) return "";
        // 栈式嵌套：indent 严格大于栈顶才作为子项
        var root = { children: [] };
        var stack = [{ indent: -1, node: root }];
        for (var a = 0; a < items.length; a++) {
          var it = items[a];
          while (stack.length > 1 && it.indent <= stack[stack.length - 1].indent) stack.pop();
          var parent = stack[stack.length - 1].node;
          var node = { ordered: it.ordered, content: it.content, children: [] };
          parent.children.push(node);
          stack.push({ indent: it.indent, node: node });
        }
        function renderNodes(ns) {
          if (!ns.length) return "";
          var tag = ns[0].ordered ? "ol" : "ul";
          var html = "<" + tag + ">";
          for (var i = 0; i < ns.length; i++) html += "<li>" + renderItem(ns[i]) + "</li>";
          return html + "</" + tag + ">";
        }
        function renderItem(n) {
          var inner = renderItemContent(n.content);
          if (n.children && n.children.length) inner += renderNodes(n.children);
          return inner;
        }
        function renderItemContent(content) {
          var tm = content.match(/^\[([ xX])\]\s+(.*)$/);
          if (tm) {
            var ck = tm[1].toLowerCase() === "x" ? " checked" : "";
            return '<input type="checkbox"' + ck + '> ' + im(tm[2]);
          }
          return im(content);
        }
        return renderNodes(root.children);
      }
      // 第一遍：收集脚注定义（[^label]: 内容），不进正文
      var lines0 = String(src).split("\n");
      var footnotes = {}, mainLines = [];
      var i0 = 0;
      while (i0 < lines0.length) {
        var l0 = lines0[i0];
        var fnDef = l0.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
        if (fnDef) {
          var label0 = fnDef[1], content0 = fnDef[2];
          // 多行脚注定义：后续缩进行属于同一脚注
          while (i0 + 1 < lines0.length && /^\s+/.test(lines0[i0 + 1]) && !/^\[\^/.test(lines0[i0 + 1].trim())) {
            i0++;
            content0 += " " + lines0[i0].trim();
          }
          footnotes[label0] = content0;
          i0++;
          continue;
        }
        mainLines.push(l0);
        i0++;
      }
      var bodyHtml = renderBlocks(mainLines.join("\n"));
      // 渲染脚注区域
      var fnKeys = Object.keys(footnotes);
      if (fnKeys.length > 0) {
        var fnOut = ['<div class="footnotes"><hr/><ol>'];
        fnKeys.forEach(function(label, idx) {
          fnOut.push('<li id="fn-' + label + '">' + im(footnotes[label]) + ' <a href="#fnref-' + label + '" contenteditable="false">↩</a></li>');
        });
        fnOut.push('</ol></div>');
        bodyHtml += "\n" + fnOut.join("\n");
      }
      return bodyHtml;
    }

    // ─── 静态资源（模块级）─────────────────────────────
    // 2026-09-12 从 CanvasPanel 里搬出来。这些要么是纯常量、要么只依赖彼此，
    // 与任何组件状态无关 —— 留在组件体内等于每渲染一次就重造一遍（划词栏一弹出就是几十次）。
    
    // ─── 黑白线条图标库（stroke=currentColor，随主题/悬停变色，避免 emoji 彩色不统一）──
    var CCV_ICONS = {
      ask: '<path d="M4 5h16v11H10l-6 4z"/>',
      highlight: '<path d="M12 4.5a4.5 4.5 0 0 0-2.6 8.2c.6.4 1.1 1.2 1.1 2v.8h3v-.8c0-.8.5-1.6 1.1-2A4.5 4.5 0 0 0 12 4.5z"/><path d="M9.5 19h5M10.5 21.5h3"/><path d="M12 1.5v2M5.6 3.6L7 5M18.4 3.6L17 5M3 9h2M21.5 9h-2"/>',
      clear: '<path d="M16 4l4 4-9 9H7l-3-3L16 4z"/><path d="M5 21h14"/><path d="M11 9l4 4"/>',
      uploadImage: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 16v-5M9.5 13.5L12 11l2.5 2.5"/>',
      globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c3.2 2.7 3.2 14.3 0 17-3.2-2.7-3.2-14.3 0-17z"/>',
      file: '<path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3z"/><path d="M13.5 3v5.5H19"/>',
      table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18M9.5 9.5V20M15.5 9.5V20"/>',
      task: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12.5l2.5 2.5 5-5.5"/>',
      listUl: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>',
      listOl: '<path d="M10 6h10M10 12h10M10 18h10"/><text x="2.5" y="8.5" font-size="7.5" stroke="none" fill="currentColor">1</text><text x="2.5" y="14.5" font-size="7.5" stroke="none" fill="currentColor">2</text><text x="2.5" y="20.5" font-size="7.5" stroke="none" fill="currentColor">3</text>',
      link: '<path d="M9.5 14.5a4 4 0 0 0 5.7 0l3.2-3.2a4 4 0 1 0-5.7-5.7l-1.6 1.6"/><path d="M14.5 9.5a4 4 0 0 0-5.7 0l-3.2 3.2a4 4 0 1 0 5.7 5.7l1.6-1.6"/>',
      code: '<path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5"/>',
      codeBlock: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9.5 10L7 12.5 9.5 15M14.5 10l2.5 2.5-2.5 2.5"/>',
      quote: '<path d="M10 6H5.5v5H9c0 2.5-1.2 3.8-3.5 4M18.5 6H14v5h3.5c0 2.5-1.2 3.8-3.5 4"/>',
      hr: '<path d="M4 12h16"/>',
      hlBlock: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 12h10" stroke-width="2.4"/>',
      indent: '<path d="M4 5h16M10 10h10M10 14h10M4 19h16M7 9.5L4.5 12 7 14.5"/>',
      outdent: '<path d="M4 5h16M10 10h10M10 14h10M4 19h16M4.5 9.5L7 12l-2.5 2.5"/>',
    }
    function ccvIcon(name, size) {
      var body = CCV_ICONS[name]
      if (!body) return ""
      var s = size || 15
      return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="display:block">' + body + '</svg>'
    }
    
    var SELBAR_ITEMS = [
      { label: ccvIcon("ask") + '<span style="margin-left:5px">问AI</span>', title: "将选中文本发送给 AI 问答", isAskAI: true },
      { type: "sep" },
      { label: "H", cmd: "formatBlock", val: "<h2>", title: "标题", isHeading: true, hasDropdown: true },
      { type: "sep" },
      { label: "≡", title: "对齐", hasDropdown: true, showAlign: true },
      { type: "sep" },
      { label: "<b>B</b>", cmd: "bold", title: "粗体" },
      { label: "<i>I</i>", cmd: "italic", title: "斜体" },
      { label: "<s>S</s>", cmd: "strikeThrough", title: "删除线" },
      { label: "U", cmd: "underline", title: "下划线", style: "text-decoration:underline" },
      { label: ccvIcon("highlight"), cmd: "highlight", title: "高亮" },
      { label: ccvIcon("clear"), cmd: "clearFormat", title: "清除格式" },
      { type: "sep" },
      { label: "⋮", title: "更多功能", hasDropdown: true, showFullMenu: true },
    ]
    
    // ─── 样式常量 ──────────────────────────────────
    var CCV_STYLE = {
      // 定位/宽高/边框由注入的 CSS（!important）统一控制，这里只放外观
      // 内层根 div 必须填满 #collab-canvas-panel 宿主（flex 列、高 100vh），
      // 否则它没有确定高度 → 编辑区 flex:1 1 0% 解析成 0 → 内容被压没、overflowY 失效、滚轮滚不动。
      // minWidth/minHeight 必须写 0：flex 子项默认 min-width:auto，会被内容（宽表格、
      // 长代码块）顶着涨，撑出容器 —— 停靠在窄侧栏里尤其明显。
      panel: { flex: "1 1 0%", minHeight: 0, minWidth: 0, background: "var(--dsw-alias-bg-layer-1, #fff)", color: "var(--dsw-alias-label-primary, #1a1a1a)", display: "flex", flexDirection: "column", fontFamily: "var(--font-ui, system-ui, sans-serif)" },
      // overflowX:auto —— 宽表格/长代码块在窄侧栏里自己横向滚动，而不是把面板撑宽
      editorWide: { flex: "1 1 0%", minHeight: 0, minWidth: 0, overflowY: "auto", overflowX: "auto", padding: "24px 32px", outline: "none", fontSize: 14, lineHeight: 1.75, wordBreak: "break-word" },
    // 窄屏/窄侧栏：内边距收紧，省下的宽度留给内容
      editorCompact: { flex: "1 1 0%", minHeight: 0, minWidth: 0, overflowY: "auto", overflowX: "auto", padding: "14px 16px", outline: "none", fontSize: 14, lineHeight: 1.75, wordBreak: "break-word" }
    };

    // ─── 编辑器面板组件 ─────────────────────────────────
    // 只以「右侧栏标签正文」这一种方式被挂载（唯一调用点：下面的 CanvasDockBody）。
    // 自建悬浮窗口 —— 连同顶栏按钮、拖拽边框、自带全屏、宽度测量、挤压对话列的整套
    // 布局引擎 —— 已于 2026-09-12 整体删除；官方浮动（把标签拖出面板）走的也是这条路。
    // 现在面板宽度完全由右侧栏标签页决定，自己量，不再碰对话列。
    function CanvasPanel({ ctx }) {
      const [canvases, setCanvases] = useState([]);
      const [activeId, setActiveId] = useState(null);
      // 顶栏两行：creating = 行内新建输入框展开（不弹浮层，直接插在第一行流里）
      // dropOpen = 文件名胶囊下的话布切换下拉（absolute，挂在第一行内）
      const [creating, setCreating] = useState(false);
      const [newTitle, setNewTitle] = useState("");
      const [dropOpen, setDropOpen] = useState(false);
      const [content, setContent] = useState("");
      const [version, setVersion] = useState(0);
      const [narrow, setNarrow] = useState(isNarrow());
      // 面板宽度由右侧栏标签页给，自己量（拖宽拖窄标签页时跟着变）
      const [selfW, setSelfW] = useState(0);
      const [restored, setRestored] = useState(false);   // 顶栏显示「已恢复未保存内容」
      const editorRef = useRef(null);
      const saveTimer = useRef(null);
      const panelRef = useRef(null);
      const meterRef = useRef(null);
      // 兜底宽度用 ref 存一份。下面几个测量 effect 只在挂载时重跑一次，
      // 若把宽度写进依赖数组，就会绕成「量宽度 → setSelfW → 宽度变 → 又去量」的圈。
      // 用 ref 读最新值：既拿不到过期的数（原来的隐患），也不会多跑。
      const panelWRef = useRef(selfW);
      panelWRef.current = selfW;
      const draftTimer = useRef(null);
      // 划词选区暂存。2026-09-12 从组件函数体的普通变量改成 ref，理由见 saveSelection 处。
      const savedRangeRef = useRef(null);
      // ── 并发保护（2026-09-12）────────────────────────────────
      // version 是 useState，但自动保存跑在 setTimeout 回调里，闭包抓到的是「设定时器
      // 那次渲染」的值，可能已经过期。所以另存一份 ref，写入时读它才是当前已知版本号。
      const versionRef = useRef(0);
      // 最后一次「与服务端一致」的内容。用于冲突时判断本机有没有未保存的编辑：
      //   DOM 内容 === lastSyncedMd.current  → 用户没动过，可以安全采用服务端版本
      //   不等                              → 用户正在编辑，绝不能拿服务端内容覆盖他
      const lastSyncedMd = useRef(null);
      // "窄"由面板自己的宽度决定，而不是整个窗口 ——
      // 窗口 1600 宽、侧栏只给 315 时，面板也是窄的，得用紧凑内边距。
      const isNarrowPane = selfW > 0 && selfW < 520;
      const compact = narrow || isNarrowPane;

      // 横竖屏切换 / 窗口缩放时刷新窄屏判定
      useEffect(() => {
        function onResize() { setNarrow(isNarrow()); }
        window.addEventListener('resize', onResize);
        window.addEventListener('orientationchange', onResize);
        return function () {
          window.removeEventListener('resize', onResize);
          window.removeEventListener('orientationchange', onResize);
        };
      }, []);

      // 读数直接写 DOM，不走 state。停靠模式只有一种读数：面板自己被侧栏分到多宽。
      function updateMeter(w) {
        if (!meterRef.current) return;
        meterRef.current.textContent = Math.round(w) + "px · 侧栏";
      }
      // 挂载后（CSS 已生效）测一次真实宽度。必须现场量 panelRef ——
      // 不能用上面那个渲染时就定住的 selfW，首帧它还是 0，会把读数写成 0px。
      useEffect(() => {
        var t = setTimeout(function () {
          var el = panelRef.current;
          var w = el ? el.getBoundingClientRect().width : panelWRef.current;
          setSelfW(Math.round(w));
          updateMeter(w);
        }, 0);
        return function () { clearTimeout(t); };
      }, []);

      // 宽度由右侧栏标签页给，自己量。拖宽拖窄标签页时跟着变。
      useEffect(function () {
        var el = panelRef.current;
        if (!el) return;
        var measure = function () {
          var w = Math.round(el.getBoundingClientRect().width);
          setSelfW(w);
          updateMeter(w);
        };
        measure();
        if (typeof ResizeObserver === "undefined") return;
        var ro = new ResizeObserver(measure);
        ro.observe(el);
        return function () { ro.disconnect(); };
      }, []);

      // 把「正在编辑的 DOM + 它属于哪个话布」记到模块级：卸载后 React 会把 ref 置空，
      // 我们留的这份引用还能读到用户刚敲进去的字，用来抢存草稿。
      useEffect(function () { ccvLiveCanvasId = activeId; }, [activeId]);
      // 把组件内的已知版本号镜像到模块级：draftSet 是模块级函数，读不到 versionRef，
      // 但草稿必须记住自己的基准版本（见 draftSet 注释）。每次渲染后同步一次即可 ——
      // versionRef 的每次变更都伴随 setVersion → 必然触发渲染。
      useEffect(function () { ccvLiveVer = versionRef.current; });
      useEffect(function () {
        ccvLiveEditor = editorRef.current;
        return function () {
          // 卸载瞬间抢存：右侧栏标签一切走，本组件就被整个拆掉，晚一步就读不到内容了
          try {
            if (ccvLiveCanvasId && ccvLiveEditor) draftSet(ccvLiveCanvasId, htmlToMd(ccvLiveEditor));
          } catch (e) { ccvLog("草稿抢存失败: " + (e && e.message)); }
          ccvLiveEditor = null;
        };
      }, []);

      // 防抖落草稿（打字时只更新内存引用，500ms 空闲才动 localStorage）
      function scheduleDraft() {
        var el = editorRef.current;
        if (!el || !activeId) return;
        ccvLiveEditor = el;
        ccvLiveCanvasId = activeId;
        if (draftTimer.current) return;
        draftTimer.current = setTimeout(function () {
          draftTimer.current = null;
          try {
            if (ccvLiveEditor && ccvLiveCanvasId) draftSet(ccvLiveCanvasId, htmlToMd(ccvLiveEditor));
          } catch (_) {}
        }, 500);
      }

      // 关页面/刷新前也抢一次：F5 不会触发 React 卸载
      useEffect(function () {
        function flush() { try { if (ccvLiveCanvasId && ccvLiveEditor) draftSet(ccvLiveCanvasId, htmlToMd(ccvLiveEditor)); } catch (_) {} }
        window.addEventListener("beforeunload", flush);
        window.addEventListener("pagehide", flush);
        return function () {
          window.removeEventListener("beforeunload", flush);
          window.removeEventListener("pagehide", flush);
        };
      }, []);

      // 全局点击隐藏划词栏和下拉菜单
      useEffect(() => {
        function onGlobalMouseUp(e) {
          var bar = document.getElementById('ccv-selbar')
          if (bar && bar.style.display !== 'none') {
            if (bar.contains(e.target)) return
            if (editorRef.current && editorRef.current.contains(e.target)) return
            ccvLog('globalMouseUp: 命中隐藏分支 target=' + ccvDesc(e.target) +
              ' editorRef=' + (editorRef.current ? '有' : '空') +
              ' 在编辑区内=' + !!(editorRef.current && editorRef.current.contains(e.target)))
            hideSelbar()
          }
          // 下拉菜单由各自的 mousedown 事件处理关闭
        }
        document.addEventListener('mouseup', onGlobalMouseUp)
        return function () { document.removeEventListener('mouseup', onGlobalMouseUp) }
      }, [])

      // 面板挂载后自检：栏元素在不在、编辑区 ref 有没有、面板祖先链状态
      useEffect(function () {
        var t = setTimeout(function () {
          var bar = document.getElementById('ccv-selbar')
          var panel = panelRef.current
          // 版本标记：client.js 由 DSH 打包加载，浏览器缓存/未刷新时从外观上看不出来。
          // 排查「改动没生效」时第一件事就是核对它（doclink 早就因此加了 VERSION）。
          ccvLog('client v' + CCV_CLIENT_VERSION + ' 已挂载')
          var host = panel ? (panel.closest('#collab-canvas-panel') || panel.parentElement) : null
          var hostCs = host ? getComputedStyle(host) : null
          ccvLog('挂载自检: panel=' + ccvDesc(panel) + ' host=' + ccvDesc(host) +
            ' hostOverflow=' + (hostCs ? hostCs.overflow : '?') +
            ' hostTransform=' + (hostCs ? hostCs.transform : '?') +
            ' editorRef=' + (editorRef.current ? '有' : '空'))
          ccvLog('挂载自检: #ccv-selbar=' + (bar ? ('存在 display=' + bar.style.display + ' offsetParent=' + ccvDesc(bar.offsetParent)) : '缺失'))
        }, 600)
        return function () { clearTimeout(t) }
      }, [])

      // contentEditable 里的 <a> 浏览器默认不跳转（单击只把光标移进去）：
      // - 脚注引用 [1]：capture 拦截，手动 scrollIntoView 跳到文末
      // - 普通链接：单击直接新标签页打开，两端行为一致（外链开网页，
      //   attachments/ 附件链接触发下载）。要改链接文字/地址：选中新链接文字后
      //   重新「插入链接」即可覆盖
      useEffect(function () {
        var ed = editorRef.current;
        if (!ed) return;
        function onClick(e) {
          var a = e.target.closest && e.target.closest('a[href]');
          if (!a) return;
          var href = a.getAttribute('href') || '';
          if (!href) return;
          if (href.indexOf('#fn') === 0) {
            e.preventDefault();
            e.stopPropagation();
            var id = href.slice(1);
            var target = document.getElementById(id) || ed.querySelector('[id="' + id + '"]');
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
          }
          // 单击直接新标签页打开（外链开网页，attachments/ 附件链接触发下载）。
          // 两端行为一致：手机端本来就没有 Ctrl 键，桌面端跟随。
          // 只放行 http(s) 和站内路径（附件接口），防 javascript: 之类的注入
          var openable = /^https?:\/\//i.test(href) || href.charAt(0) === '/';
          ccvLog('链接点击: href=' + href + ' openable=' + openable);
          if (!openable) return;
          e.preventDefault();
          e.stopPropagation();
          window.open(href, '_blank', 'noopener');
        }
        ed.addEventListener('click', onClick, true);
        return function () { ed.removeEventListener('click', onClick, true); };
      }, []);

      // 编辑区增强：粘贴截图自动上传、Tab/Shift+Tab 列表缩进
      useEffect(function () {
        var ed = editorRef.current;
        if (!ed) return;
        function inListItem() {
          var sel = document.getSelection()
          if (!sel || sel.rangeCount === 0) return false
          var node = sel.getRangeAt(0).startContainer
          if (node.nodeType === 3) node = node.parentNode
          while (node && node.nodeType === 1) {
            var tag = node.tagName ? node.tagName.toLowerCase() : ""
            if (tag === "li" || tag === "ul" || tag === "ol") return true
            if (node.classList && node.classList.contains("ccv-editor")) break
            node = node.parentNode
          }
          return false
        }
        function onKeyDown(e) {
          if (e.key !== "Tab") return
          e.preventDefault()
          if (inListItem()) {
            // 列表里：Tab 嵌套一级、Shift+Tab 退回一级，效果相反
            document.execCommand(e.shiftKey ? "outdent" : "indent", false, null)
          } else if (!e.shiftKey) {
            // 非列表：Tab 插两个空格；Shift+Tab 无处可退，不做动作
            // （之前 Shift+Tab 也走这里插空格，两种按起来一样，是 bug）
            document.execCommand("insertText", false, "  ")
          }
        }
        function onPaste(e) {
          var items = e.clipboardData && e.clipboardData.items
          if (!items) return
          for (var i = 0; i < items.length; i++) {
            var it = items[i]
            if (it.kind === "file" && it.type && it.type.indexOf("image/") === 0) {
              var f = it.getAsFile()
              if (!f) continue
              e.preventDefault()
              // 剪贴板里的截图通常叫 image.png，重命名带上时间戳便于辨认
              var ext = (it.type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "") || "png"
              var name = "clipboard-" + Date.now() + "." + ext
              try { f = new File([f], name, { type: it.type }) } catch (_) { /* 旧环境保留原名 */ }
              var rng = currentRange()
              uploadCanvasFile(f, function(p) {
                insertHtmlAtRange('<img src="' + escHtml(assetDisplayUrl(p)) + '" alt="截图" style="max-width:100%;height:auto;vertical-align:middle"/>', rng)
              }, function(f2) {
                // 上传失败兜底：dataURL 内嵌
                fileToDataUrl(f2, function(u) {
                  if (u) insertHtmlAtRange('<img src="' + u + '" alt="截图" style="max-width:100%;height:auto;vertical-align:middle"/>', rng)
                  else ccvLog("paste: 图片上传失败且无兜底")
                })
              })
              return
            }
          }
        }
        ed.addEventListener("keydown", onKeyDown)
        ed.addEventListener("paste", onPaste)
        return function () {
          ed.removeEventListener("keydown", onKeyDown)
          ed.removeEventListener("paste", onPaste)
        };
      }, []);

      // 兜底触发：编辑区的 React onMouseUp 不是每次都生效（拖选结束时指针落在
      // 编辑区外、选区在 mouseup 之后才定型等）。用 selectionchange 补一次，
      // 只在「选区确实落在编辑区内」时才接管，避免污染会话区的划词。
      useEffect(function () {
        var t = null
        function onSelChange() {
          if (t) clearTimeout(t)
          t = setTimeout(function () {
            try {
              var sel = document.getSelection()
              if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
              var ed = editorRef.current
              if (!ed || !sel.anchorNode || !ed.contains(sel.anchorNode)) return
              var bar = document.getElementById('ccv-selbar')
              if (bar && bar.style.display !== 'none') return   // 已经显示就不再重复渲染
              var rect = sel.getRangeAt(0).getBoundingClientRect()
              if (!rect || (!rect.width && !rect.height)) return
              ccvLog('selectionchange: 兜底触发（编辑区 mouseup 未生效）')
              updateSelFormats(sel)
              showSelbar(rect)
            } catch (e) {}
          }, 30)
        }
        document.addEventListener('selectionchange', onSelChange)
        return function () { if (t) clearTimeout(t); document.removeEventListener('selectionchange', onSelChange) }
      }, [])

      useEffect(() => {
        fetch(canvasApi("/api/canvas/list")).then(r => r.json()).then(d => {
          // pending 时让位：doclink 链接点名要打开的画布优先于默认 activeId
          if (d.ok) { setCanvases(d.canvases); if (d.activeId && !window.__ccvPendingCanvasId) loadCanvas(d.activeId); }
        }).catch(() => {});
      }, []);

      // doclink 桥接：外部「文档名链接」点名要打开的画布（优先于默认 activeId），
      // 打开状态下通过事件直接切换
      useEffect(function () {
        var pid = window.__ccvPendingCanvasId;
        if (pid) { window.__ccvPendingCanvasId = null; loadCanvas(pid); }
        function onOpen(e) {
          var id = e.detail && e.detail.id;
          if (!id) return;
          loadCanvas(id);
          // 新导入的画布不在清单里，顺手刷新下拉列表
          fetch(canvasApi("/api/canvas/list")).then(r => r.json()).then(d => {
            if (d.ok) setCanvases(d.canvases);
          }).catch(() => {});
        }
        window.addEventListener('ccv-open-canvas', onOpen);
        return function () { window.removeEventListener('ccv-open-canvas', onOpen); };
      }, []);

      // 清单轮询：AI 通过工具创建/加载的画布自动出现在下拉清单里（10 秒一次）
      useEffect(function () {
        var t = setInterval(function () {
          try {
            fetch(canvasApi("/api/canvas/list")).then(r => r.json()).then(d => {
              if (d.ok) setCanvases(d.canvases);
            }).catch(() => {});
          } catch (_) {}
        }, 10000);
        return () => clearInterval(t);
      }, []);

      function loadCanvas(id) {
        clearTimeout(saveTimer.current);   // 防竞态：切换前丢掉旧文档的待写自动保存
        fetch(canvasApi("/api/canvas/read?id=" + encodeURIComponent(id))).then(r => r.json()).then(d => {
          if (!d.ok) return;
          var dft = draftGet(d.id);
          if (dft && dft.content !== d.content) {
            // ⚠️ 草稿必须先验「基准版本」再用。
            // 草稿是「本机还没写回服务端」的那一版；但如果服务端在草稿产生之后前进过
            // （AI 改了文档、或另一处写了新内容），把草稿写回去就是用旧内容覆盖新内容。
            // 两次「话布优化」被整段抹掉都是这条路径干的：
            // 恢复草稿 → 用服务端的当前版本当 knownVer → 版本校验通过 → 覆盖成功。
            var dbase = (typeof dft.base === "number") ? dft.base : null;
            if (dbase === null || dbase !== d.version) {
              // 基准对不上（含没有 base 的旧格式草稿）→ 不自动写回，只载入服务端内容。
              // 草稿仍留在 localStorage 里没被删，用户的内容不会丢。
              ccvLog("草稿基准不符(草稿 v" + dbase + " / 服务端 v" + d.version + ")，不自动写回: id=" + d.id);
              setActiveId(d.id); setContent(d.content); setVersion(d.version);
              versionRef.current = d.version; lastSyncedMd.current = d.content;
              setRestored(false);
              // 只提示一次：草稿会一直躺在 localStorage 里，每打开一次都弹就成了噪音，
              // 而且用户看了也无事可做。保护照旧（每次都不写回），只是不再重复告知。
              if (!dft.notified) {
                draftMarkNotified(d.id);
                if (window.__ccvKit && window.__ccvKit.toast) {
                  window.__ccvKit.toast("已跳过一份过期的本地草稿，当前显示的是最新版本", "ccv-draft-stale");
                }
              }
              return;
            }
            // 有一份没来得及写盘的草稿：它是用户刚敲的，比服务端那版新，优先恢复它。
            // 恢复后按「停止输入 1.5 秒自动存」的同一规矩补写回服务端，
            // 否则用户切走之后，这段内容只活在浏览器里，AI 在对话里看不到。
            ccvLog("恢复未保存草稿: id=" + d.id + " 长度=" + dft.content.length + " 服务端长度=" + d.content.length);
            setActiveId(d.id); setContent(dft.content); setVersion(d.version);
            // 已知版本 = 服务端的版本；已同步内容 = 服务端那份（≠ 本地草稿，
            // 冲突判定据此认出「本机有未保存编辑」）
            versionRef.current = d.version; lastSyncedMd.current = d.content;
            setRestored(true);
            clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(function () { writeMd(d.id, dft.content); }, 1500);
          } else {
            setActiveId(d.id); setContent(d.content); setVersion(d.version);
            versionRef.current = d.version; lastSyncedMd.current = d.content;
            setRestored(false);
          }
        }).catch(() => {});
      }

      // 删除话布：移出清单并删除对应 md 文件（host 端 /api/canvas/delete）
      function deleteCanvasById(id, title) {
        if (!confirm("确定删除话布「" + title + "」吗？\n对应的 md 文件也会一并删除，不可恢复。")) return;
        fetch(canvasApi("/api/canvas/delete?id=" + encodeURIComponent(id))).then(r => r.json()).then(d => {
          if (d.ok) {
            setCanvases(prev => prev.filter(x => x.id !== id));
            if (activeId === id) { setActiveId(null); setContent(""); setVersion(0); versionRef.current = 0; lastSyncedMd.current = null; }
          } else alert("删除失败: " + (d.error || "未知错误"));
        }).catch(() => alert("删除失败"));
      }

      // 并发冲突处理（host 端 applyWrite 检出 baseVersion 不匹配时回调到这里）。
      // AI 在对话里改过这份文档 → 服务端版本已经前进，而我们手里是旧内容。
      // 关键是别把正在编辑的人的内容丢掉，所以分两种情形：
      //   ① 本机没有未保存编辑（DOM 内容 === 最后一次与服务端一致的内容）
      //      → 采用服务端版本。这正是「AI 写入被编辑器覆盖」那个 bug 的修复点。
      //   ② 本机有编辑 → 不覆盖，只提示，交给用户决定（点「重载」拿最新）。
      function resolveConflict(localMd, d) {
        var serverMd = typeof d.currentContent === "string" ? d.currentContent : "";
        var base = lastSyncedMd.current;
        if (base !== null && localMd === base) {
          ccvLog("冲突: 本机无改动 -> 采用服务端 v" + d.currentVersion);
          setContent(serverMd);
          setVersion(d.currentVersion);
          versionRef.current = d.currentVersion;
          lastSyncedMd.current = serverMd;
          setRestored(false);
          if (window.__ccvKit && window.__ccvKit.toast) window.__ccvKit.toast("这份话布已被 AI 更新，已同步到最新版本");
        } else {
          ccvLog("冲突: 本机有未保存编辑 -> 保留本地，不覆盖");
          if (window.__ccvKit && window.__ccvKit.toast) window.__ccvKit.toast("这份话布已被 AI 更新；你的编辑尚未提交，点「重载」可查看最新内容", "ccv-conflict-toast");
        }
      }

      // 写盘。接受显式的 md：卸载后 / 恢复草稿时编辑器 DOM 已不可靠，
      // 这两种情况下必须用调用方手里那份内容，不能再回头读 DOM。
      function writeMd(id, md) {
        if (!id || typeof md !== "string") return Promise.resolve(null);
        return fetch(canvasApi("/api/canvas/write"), {
          method: "POST", headers: { "Content-Type": "application/json" },
          // knownVer：带上去，host 端 applyWrite 才能检出「我们基于旧版本写」的并发冲突。
          // 不带的话 typeof baseVersion !== 'number' → 直接跳过校验 → 后写覆盖先写。
          body: JSON.stringify({ id: id, content: md, knownVer: versionRef.current })
        }).then(r => r.json()).then(function (d) {
          if (d && d.ok) {
            setVersion(d.version);
            versionRef.current = d.version;
            lastSyncedMd.current = md;
            draftDropIf(id, md); setRestored(false);
          } else if (d && d.conflict) {
            resolveConflict(md, d);
          }
          return d;
        }).catch(function () { return null; });
      }

      function saveCanvas() {
        if (!activeId || !editorRef.current) return;
        writeMd(activeId, htmlToMd(editorRef.current));
      }

      // 在系统文件管理器里打开当前文档所在的文件夹（host 端调 explorer/open/xdg-open）
      function openFolder() {
        fetch("/api/canvas/open-folder", { method: "POST" })
          .then(r => r.json())
          .then(d => { ccvLog("open-folder 响应: " + JSON.stringify(d)); })
          .catch(e => { ccvLog("open-folder 请求失败: " + e); });
      }

      // 「登记」：管理拖拽文件来源文件夹（host 端文件登记表，命中后按真实路径 @ 引用）
      function manageRegistry() {
        fetch("/api/canvas/registry").then(r => r.json()).then(d => {
          if (!d.ok) { alert("读取登记信息失败"); return; }
          const folders = d.folders || [];
          const tip = folders.length
            ? folders.map((f, i) => (i + 1) + ". " + f).join("\n") + "\n\n输入序号移除对应文件夹；或直接输入新的文件夹绝对路径添加："
            : "尚未登记文件夹。\n输入要登记的文件夹绝对路径（之后拖拽该文件夹内的文件时，将按真实路径 @ 引用）：";
          const ans = prompt("已登记 " + folders.length + " 个文件夹，共索引 " + (d.files || 0) + " 个文件。\n\n" + tip, "");
          if (ans === null) return;
          const t = ans.trim();
          let next;
          const idx = /^\d+$/.test(t) ? parseInt(t, 10) - 1 : -1;
          if (idx >= 0 && idx < folders.length) {
            next = folders.filter((_, i) => i !== idx);
          } else if (t) {
            next = folders.concat([t]);
          } else {
            return;
          }
          fetch("/api/canvas/registry", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folders: next })
          }).then(r => r.json()).then(d2 => {
            if (d2.ok) alert("已更新登记文件夹（" + (d2.folders || []).length + " 个，索引 " + (d2.files || 0) + " 个文件，构建中）");
            else alert("更新失败: " + (d2.error || "未知错误"));
          }).catch(() => alert("更新失败"));
        }).catch(() => alert("读取登记信息失败"));
      }

      // ─── 顶栏：新建话布（行内输入框，替掉原生 prompt）──
      function startCreate() { setDropOpen(false); setNewTitle(""); setCreating(true); }
      function cancelCreate() { setCreating(false); setNewTitle(""); }
      function submitCreate() {
        const t = newTitle.trim();
        if (!t) { cancelCreate(); return; }
        fetch(canvasApi("/api/canvas/create"), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: t })
        }).then(r => r.json()).then(d => {
          if (d.ok) {
            setCanvases(prev => prev.concat([{ id: d.id, title: d.title }]));
            loadCanvas(d.id);
          }
          cancelCreate();
        }).catch(() => { cancelCreate(); });
      }
      function toggleDrop() { setCreating(false); setDropOpen(v => !v); }

      // 点下拉/胶囊以外的地方关闭下拉；Esc 同时取消新建
      useEffect(() => {
        if (!dropOpen && !creating) return;
        function onDown(e) {
          const t = e.target;
          if (t && t.closest && (t.closest(".ccv-drop") || t.closest(".ccv-chip") || t.closest(".ccv-ninput"))) return;
          setDropOpen(false);
          cancelCreate();
        }
        function onKey(e) { if (e.key === "Escape") { setDropOpen(false); cancelCreate(); } }
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [dropOpen, creating]);

      // ─── Markdown ↔ HTML ──────────────────────────
      // ⚠️ htmlToMd / mdToHtml 已搬到模块级，见文件上方「Markdown ↔ HTML 转换（纯函数）」。
      //    找不到不是被删了 —— 往上翻。

      // ↑ 已提到模块级：见文件上方「静态资源（模块级）」
      // ─── 划词栏（参考豆包样式）──────────────────────
      // 选区暂存。用 ref（savedRangeRef，声明在组件顶部的 ref 区），**不能用普通变量**：
      // 写在组件函数体里的变量每次重渲染都会被重新初始化，而这里存在**真正的跨渲染访问** ——
      // 下面 showDropdownAt 里注册的「点外部关闭」监听是异步的（setTimeout + mousedown 事件），
      // 它会写这个变量；中间只要发生过一次重渲染，那次写入就落进了旧闭包，
      // 当前渲染读到的还是旧值 → 之后 restoreSelection 会把内容加粗到**旧位置**。
      // 改成 ref 后：所有渲染共享同一个对象（不再有新旧闭包之分），
      // 同时保持"每个面板实例各存各的"——悬浮与停靠并存时不会互相覆盖。

      function saveSelection() {
        var sel = document.getSelection()
        if (sel && sel.rangeCount > 0) savedRangeRef.current = sel.getRangeAt(0).cloneRange()
      }
      function restoreSelection() {
        if (!savedRangeRef.current) return
        var sel = document.getSelection()
        if (sel) { sel.removeAllRanges(); sel.addRange(savedRangeRef.current) }
        savedRangeRef.current = null
      }

      function closeDropdowns() {
        var existing = document.querySelectorAll('.ccv-dropdown')
        existing.forEach(function(d) { d.remove() })
      }

      // 菜单在任意屏幕坐标打开（右键菜单用）；showDropdown 走 anchor 定位也归到这里
      function openDropdownAt(left, top, items, onSelect) {
        closeDropdowns()
        saveSelection()
        var dd = document.createElement('div')
        dd.className = 'ccv-dropdown'
        // 黑白极简：不透明底、细灰边、轻阴影，无毛玻璃无彩色
        dd.style.cssText = 'position:fixed;z-index:2147483001;background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.1);padding:4px 0;min-width:160px;max-width:320px;font-size:13px;color:var(--dsw-alias-label-primary,#1a1a1a);max-height:72vh;overflow-y:auto'
        // 图标：SVG 用 innerHTML（线条图标），纯文本（如 ¹）用 textContent
        function iconSpan(icon) {
          var ic = document.createElement('span')
          if (icon.indexOf('<svg') === 0) ic.innerHTML = icon
          else ic.textContent = icon
          ic.style.cssText = 'width:18px;display:flex;justify-content:center;flex:0 0 auto'
          return ic
        }
        function addRow(item) {
          var row = document.createElement('div')
          row.style.cssText = 'padding:7px 14px;cursor:pointer;display:flex;align-items:center;gap:9px;transition:background .1s;border-radius:0;white-space:nowrap'
          if (item.icon) row.appendChild(iconSpan(item.icon))
          var lb = document.createElement('span')
          lb.textContent = item.label
          row.appendChild(lb)
          if (item.style) row.style.cssText += ';' + item.style
          // 选中态：黑白线条风 = 1px currentColor 描边 + 加粗，不用彩色
          if (item.active) { row.style.boxShadow = 'inset 0 0 0 1px currentColor'; row.style.fontWeight = '600' }
          row.addEventListener('mouseenter', function() { row.style.background = 'rgba(128,128,128,.12)' })
          row.addEventListener('mouseleave', function() { row.style.background = 'transparent' })
          row.addEventListener('click', function(e) { e.stopPropagation(); closeDropdowns(); onSelect(item) })
          dd.appendChild(row)
        }
        items.forEach(function(item) {
          if (item.type === 'sep') {
            var sep = document.createElement('div')
            sep.style.cssText = 'height:1px;background:rgba(128,128,128,.15);margin:4px 0'
            dd.appendChild(sep)
            return
          }
          if (item.type === 'header') {
            // 分组标题：不可点，小号灰字、加字距
            var hd = document.createElement('div')
            hd.style.cssText = 'padding:6px 14px 2px;font-size:11px;color:rgba(128,128,128,.75);letter-spacing:.5px;user-select:none;-webkit-user-select:none;white-space:nowrap'
            hd.textContent = item.label
            dd.appendChild(hd)
            return
          }
          if (item.type === 'row') {
            // 横排：多个紧凑按钮挤一行（块区四个常用项），省菜单高度
            var rr = document.createElement('div')
            rr.style.cssText = 'display:flex;align-items:center;gap:2px;padding:2px 8px'
            item.items.forEach(function(sub) {
              var b = document.createElement('div')
              b.style.cssText = 'flex:1 1 0;display:flex;align-items:center;justify-content:center;gap:5px;padding:7px 8px;cursor:pointer;border-radius:6px;white-space:nowrap;min-width:0'
              if (sub.icon) b.appendChild(iconSpan(sub.icon))
              var sl = document.createElement('span')
              sl.textContent = sub.label
              b.appendChild(sl)
              b.addEventListener('mouseenter', function() { b.style.background = 'rgba(128,128,128,.12)' })
              b.addEventListener('mouseleave', function() { b.style.background = 'transparent' })
              b.addEventListener('click', function(e) { e.stopPropagation(); closeDropdowns(); onSelect(sub) })
              rr.appendChild(b)
            })
            dd.appendChild(rr)
            return
          }
          addRow(item)
        })
        document.body.appendChild(dd)
        // 先挂载量尺寸，再夹到视口内；下方放不下就翻到坐标上方
        var ddWidth = dd.offsetWidth
        var ddHeight = dd.offsetHeight
        var x = Math.max(8, Math.min(left, window.innerWidth - ddWidth - 8))
        var y = top
        if (y + ddHeight > window.innerHeight - 8) y = Math.max(8, top - ddHeight - 4)
        dd.style.left = x + 'px'
        dd.style.top = y + 'px'
        // 点击外部关闭；没点菜单就关掉的话，保存的选区一并作废（防止之后误插到旧位置）
        setTimeout(function() {
          document.addEventListener('mousedown', function close(ev) {
            if (!dd.contains(ev.target)) { closeDropdowns(); savedRangeRef.current = null; document.removeEventListener('mousedown', close) }
          })
        }, 0)
      }

      function showDropdown(anchor, items, onSelect) {
        var rect = anchor.getBoundingClientRect()
        openDropdownAt(rect.left, rect.bottom + 4, items, onSelect)
      }

      // ─── 画布命令统一分发（划词栏 / ⋮ / 右键菜单共用）──────────
      function escHtml(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      }
      // 插入时用 host 接口地址，图/链接当场就能显示；htmlToMd 的 assetMdPath
      // 存盘时再换回 attachments/ 相对路径，两边互逆
      function assetDisplayUrl(p) {
        if (/^attachments\//.test(p)) return "/api/canvas/file?name=" + encodeURIComponent(p)
        return p
      }
      function selectionText() {
        var sel = document.getSelection()
        return sel ? sel.toString() : ""
      }
      function currentRange() {
        var s = document.getSelection()
        return (s && s.rangeCount) ? s.getRangeAt(0).cloneRange() : null
      }
      // 异步上传完成后在原光标处插 HTML：先聚焦编辑器、找回范围再 insertHTML
      function insertHtmlAtRange(html, rng) {
        var ed = editorRef.current
        if (!ed) return
        ed.focus()
        if (rng) {
          try { var s = document.getSelection(); s.removeAllRanges(); s.addRange(rng) } catch (_) {}
        }
        document.execCommand("insertHTML", false, html)
      }
      // 上传文件 → host /api/canvas/upload → 返回相对路径 attachments/xxx
      function uploadCanvasFile(file, onOk, onFail) {
        try {
          fetch("/api/canvas/upload?name=" + encodeURIComponent(file.name || "file.bin"), {
            method: "POST",
            headers: { "Content-Type": file.type || "application/octet-stream" },
            body: file
          }).then(function(r) { return r.json() }).then(function(d) {
            if (d && d.ok && d.path) onOk(d.path, file.name || "图片")
            else onFail(file)
          }).catch(function() { onFail(file) })
        } catch (e) { onFail(file) }
      }
      // 上传失败兜底：图片转 dataURL 内嵌（md 会变大，仅作 fallback）
      function fileToDataUrl(file, cb) {
        try {
          var fr = new FileReader()
          fr.onload = function() { cb(String(fr.result)) }
          fr.onerror = function() { cb("") }
          fr.readAsDataURL(file)
        } catch (_) { cb("") }
      }
      // 打开系统文件选择框，选中后回调（菜单点击是用户手势，input.click() 能弹出）
      function pickFile(accept, cb) {
        var inp = document.createElement("input")
        inp.type = "file"
        if (accept) inp.accept = accept
        inp.style.display = "none"
        document.body.appendChild(inp)
        inp.addEventListener("change", function() {
          var f = inp.files && inp.files[0]
          if (f) cb(f)
          inp.remove()
        })
        inp.click()
      }
      function insertTableHtml(rows, cols) {
        var html = "<table>"
        for (var r = 0; r < rows; r++) {
          html += "<tr>"
          for (var c = 0; c < cols; c++) html += (r === 0 ? "<th>表头</th>" : "<td></td>")
          html += "</tr>"
        }
        html += "</table><div><br></div>"
        document.execCommand("insertHTML", false, html)
      }
      // 引用来源的 @ 提及：算出当前话布对应的 md 真实路径。
      // 为什么要带来源：用户引用一段文字问 AI 时，如果两篇文档含同样的文字，
      // 光看引用块 AI 无从判断该改哪一篇 —— 只能靠记忆猜，猜错就改了错的文档，
      // 而且是静默的（用户看不到任何变化）。带上 @路径 这一步就变成事实判断。
      //
      // ⚠️ 必须用 host 给的真实绝对路径，不能自己拼 "canvas-docs/<标题>.md"：
      //    那是相对路径，只在「会话工作区 == 存储根」时才成立。存储根被
      //    canvas_configure 固定到别处后（rootOverride），它指向的是工作区里
      //    的残留目录 —— 文件根本不在那儿（2026-09-12 另一会话据此报过）。
      //
      // ⚠️ 真实路径几乎必然含空格（"DSH project"、"OneDrive - …"），必须用
      //    DSH 的引号形式 @"path"：@ token 由空白终止，裸写会在第一个空格处截断。
      //    规则与 dsh-file-reference 的 formatFileMention 一致。
      function ccvDocMention(id) {
        var c = null
        try {
          (canvases || []).forEach(function (x) { if (x && x.id === id) c = x })
        } catch (_) {}
        if (!c) return ''
        if (c.path) {
          var abs = String(c.path).replace(/\\/g, '/')
          return /\s/.test(abs) ? '@"' + abs + '"' : '@' + abs
        }
        if (!c.title) return ''
        // 兜底：拿不到真实路径时（旧版 host 没返回 path 字段）退回相对形式
        var slug = String(c.title).replace(/[\\/:*?"<>|#%]+/g, '').trim().replace(/\s+/g, '-')
        if (!slug) slug = 'untitled'
        return '@canvas-docs/' + slug + '.md'
      }

      // 问 AI：选中文本以引用块格式塞进 DSH 输入框（划词栏💬与右键菜单共用）
      function askAiFromSelection() {
        var sel = document.getSelection()
        var text = sel ? sel.toString().trim() : ''
        if (!text) { alert('请先选中要问 AI 的文本'); return }
        hideSelbar()
        // ⚠️ 必须留一个空格：@ 提及 token 由空白字符终止，
        //    写成 "@xxx>内容" 会把 ">" 并进路径里。
        var mention = ccvDocMention(activeId)
        // 多行选区每一行都要带 ">"，否则只有首行是引用块
        var quoted = text.split('\n').map(function (l) { return '> ' + l }).join('\n')
        var body = (mention ? mention + ' ' : '') + quoted
        var input =
          document.querySelector('div[data-composer-input="true"]') ||
          document.querySelector('[data-slot="conversation.input"] textarea') ||
          document.querySelector('[data-slot="conversation.composer"] textarea') ||
          document.querySelector('[data-slot="conversation.composer.bar"] textarea') ||
          document.querySelector('[data-pane="conversation"] textarea') ||
          document.querySelector('textarea[placeholder*="发消息"]') ||
          document.querySelector('textarea[placeholder*="说话"]') ||
          document.querySelector('textarea[placeholder*="消息"]') ||
          document.querySelector('textarea[placeholder*="输入"]') ||
          document.querySelector('[contenteditable="true"][role="textbox"]')
        if (input) {
          if (input.tagName === 'TEXTAREA') {
            var quote = body + '\n\n'
            var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
            nativeInputValueSetter.call(input, quote + input.value)
            input.dispatchEvent(new Event('input', { bubbles: true }))
          } else {
            // 新版 DSH 用 Lexical 编辑器：优先走官方 inputActions.setDraft（能保留换行）
            var draftState = window.__ccvInputState
            var curDraft = (draftState && draftState.draft) ? draftState.draft : ''
            var newDraft = body + '\n\n' + curDraft
            if (window.__ccvInputActions && window.__ccvInputActions.setDraft) {
              window.__ccvInputActions.setDraft(newDraft)
            } else {
              // fallback: 直接写 DOM + 派发 input
              var escTxt = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              var escMention = mention ? String(mention).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + ' ' : ''
              var quoteHtml = '<div>' + escMention + '&gt; ' + escTxt + '</div><div><br></div><div><br></div>'
              input.innerHTML = quoteHtml + input.innerHTML
              input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: body }))
            }
          }
          input.focus()
        }
      }
      function runCanvasCmd(cmd) {
        restoreSelection()
        var text
        switch (cmd) {
          case "highlight": {
            text = selectionText()
            if (!text) return true
            document.execCommand("insertHTML", false, "<mark>" + escHtml(text) + "</mark>")
            break
          }
          case "clearFormat": {
            document.execCommand("removeFormat", false, null)
            // removeFormat 管不到自定义的 <mark> 和 <a>：选区内的手动拆掉。
            // 脚注引用 [1]（href="#fn-…"）是内容标记不是格式，保留
            try {
              var ed3 = editorRef.current
              var s3 = document.getSelection()
              if (ed3 && s3 && s3.rangeCount) {
                var rg = s3.getRangeAt(0)
                var marks = ed3.querySelectorAll("mark")
                for (var mi = marks.length - 1; mi >= 0; mi--) {
                  if (rg.intersectsNode(marks[mi])) {
                    var pMark = marks[mi].parentNode
                    while (marks[mi].firstChild) pMark.insertBefore(marks[mi].firstChild, marks[mi])
                    pMark.removeChild(marks[mi])
                  }
                }
                var links = ed3.querySelectorAll("a")
                for (var ai = links.length - 1; ai >= 0; ai--) {
                  var lh = links[ai].getAttribute("href") || ""
                  if (lh.indexOf("#fn") === 0) continue
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
          case "inlineCode": {
            text = selectionText() || "code"
            document.execCommand("insertHTML", false, '<code style="background:rgba(136,136,136,.15);padding:1px 4px;border-radius:3px;font-family:monospace;font-size:.9em">' + escHtml(text) + '</code>')
            break
          }
          case "codeBlock": {
            text = selectionText() || "code"
            document.execCommand("insertHTML", false, '<pre style="background:#f5f5f5;padding:12px 16px;border-radius:6px;font-family:monospace;font-size:13px;line-height:1.5;overflow-x:auto;white-space:pre"><code>' + escHtml(text) + '</code></pre><div><br></div>')
            break
          }
          case "blockquote": {
            text = selectionText() || "引用内容"
            document.execCommand("insertHTML", false, '<blockquote style="border-left:3px solid #ccc;padding-left:12px;margin:8px 0;color:#666">' + escHtml(text) + '</blockquote><div><br></div>')
            break
          }
          case "link": {
            var url = prompt("请输入链接地址：", "https://")
            if (url) {
              text = selectionText().trim() || "链接文字"
              document.execCommand("insertHTML", false, '<a href="' + escHtml(url) + '" style="color:#3b82f6;text-decoration:underline">' + escHtml(text) + '</a>')
            }
            break
          }
          case "footnote": {
            // 脚注：自动生成编号，插入引用标记，并在文末添加定义
            var label = prompt("脚注标签（如 1、2、a）：", "")
            if (label) {
              var html = '<a href="#fn-' + escHtml(label) + '" id="fnref-' + escHtml(label) + '" contenteditable="false" style="vertical-align:super;font-size:.75em;color:#3b82f6;cursor:pointer;text-decoration:none">[' + escHtml(label) + ']</a>'
              document.execCommand("insertHTML", false, html)
              var ed = editorRef.current
              if (ed) {
                var existing = ed.querySelector('#fn-' + label)
                if (!existing) {
                  var fnDiv = ed.querySelector('.footnotes')
                  if (!fnDiv) {
                    fnDiv = document.createElement('div')
                    fnDiv.className = 'footnotes'
                    fnDiv.innerHTML = '<hr/>'
                    var ol = document.createElement('ol')
                    fnDiv.appendChild(ol)
                    ed.appendChild(fnDiv)
                  }
                  var ol2 = fnDiv.querySelector('ol')
                  var li = document.createElement('li')
                  li.id = 'fn-' + label
                  li.innerHTML = '脚注 ' + escHtml(label) + ' 的内容 <a href="#fnref-' + escHtml(label) + '" contenteditable="false" style="color:#3b82f6;text-decoration:none">↩</a>'
                  ol2.appendChild(li)
                  li.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }
              }
            }
            break
          }
          case "uploadImage": {
            var rngImg = currentRange()
            pickFile("image/*", function(f) {
              uploadCanvasFile(f, function(p, name) {
                insertHtmlAtRange('<img src="' + escHtml(assetDisplayUrl(p)) + '" alt="' + escHtml(name) + '" style="max-width:100%;height:auto;vertical-align:middle"/>', rngImg)
              }, function(f2) {
                fileToDataUrl(f2, function(u) {
                  if (u) insertHtmlAtRange('<img src="' + u + '" alt="" style="max-width:100%;height:auto;vertical-align:middle"/>', rngImg)
                  else alert("图片上传失败")
                })
              })
            })
            break
          }
          case "imageUrl": {
            var iurl = prompt("请输入图片地址：", "https://")
            if (iurl) document.execCommand("insertHTML", false, '<img src="' + escHtml(iurl) + '" alt="" style="max-width:100%;height:auto;vertical-align:middle"/>')
            break
          }
          case "uploadFile": {
            var rngFile = currentRange()
            pickFile("", function(f) {
              uploadCanvasFile(f, function(p, name) {
                insertHtmlAtRange('<a href="' + escHtml(assetDisplayUrl(p)) + '">' + escHtml(name) + '</a>', rngFile)
              }, function() { alert("文件上传失败") })
            })
            break
          }
          case "insertTable": {
            var rc = prompt("表格行数×列数（如 3×4）：", "3×3")
            if (rc) {
              var mm = rc.match(/(\d+)\s*[×xX*]\s*(\d+)/)
              if (mm) insertTableHtml(Math.max(1, Math.min(50, +mm[1])), Math.max(1, Math.min(20, +mm[2])))
              else alert("格式不对，示例：3×4")
            }
            break
          }
          case "insertTaskList": {
            document.execCommand("insertHTML", false, '<ul><li><input type="checkbox"> 任务事项</li></ul><div><br></div>')
            break
          }
          case "highlightBlock": {
            text = selectionText()
            var inner = text ? escHtml(text) : "高亮内容"
            document.execCommand("insertHTML", false, '<div class="ccv-hl"><p>' + inner + '</p></div><div><br></div>')
            break
          }
          case "indent": document.execCommand("indent", false, null); break
          case "outdent": document.execCommand("outdent", false, null); break
          default: return false
        }
        if (editorRef.current) editorRef.current.focus()
        return true
      }
      // ─── 右键菜单（桌面端插入入口）──────────────────────
      function showContextMenu(x, y) {
        var hasSel = selectionText().trim().length > 0
        var items = [
          { label: "问AI", cmd: "askAI", icon: ccvIcon("ask") },
          { type: "sep" },
          { type: "header", label: "常用" },
          { label: "上传图片…", cmd: "uploadImage", icon: ccvIcon("uploadImage") },
          { label: "网络图片…", cmd: "imageUrl", icon: ccvIcon("globe") },
          { label: "上传文件…", cmd: "uploadFile", icon: ccvIcon("file") },
          { label: "插入表格…", cmd: "insertTable", icon: ccvIcon("table") },
          { label: "插入链接…", cmd: "link", icon: ccvIcon("link") },
          { type: "row", items: [
            { label: "无序列表", cmd: "insertUnorderedList", icon: ccvIcon("listUl") },
            { label: "有序列表", cmd: "insertOrderedList", icon: ccvIcon("listOl") },
            { label: "任务列表", cmd: "insertTaskList", icon: ccvIcon("task") },
          ]},
          { type: "sep" },
          { type: "header", label: "块" },
          { type: "row", items: [
            { label: "代码块", cmd: "codeBlock", icon: ccvIcon("codeBlock") },
            { label: "引用", cmd: "blockquote", icon: ccvIcon("quote") },
            { label: "分割线", cmd: "insertHorizontalRule", icon: ccvIcon("hr") },
            { label: "高亮块", cmd: "highlightBlock", icon: ccvIcon("hlBlock") },
          ]},
          { type: "sep" },
          { label: "增加缩进", cmd: "indent", icon: ccvIcon("indent") },
          { label: "减少缩进", cmd: "outdent", icon: ccvIcon("outdent") },
        ]
        if (hasSel) {
          items.push(
            { type: "sep" },
            { type: "header", label: "转换为" },
            { label: "代码块", cmd: "codeBlock", icon: ccvIcon("codeBlock") },
            { label: "引用", cmd: "blockquote", icon: ccvIcon("quote") },
            { label: "高亮", cmd: "highlight", icon: ccvIcon("highlight") },
            { label: "链接", cmd: "link", icon: ccvIcon("link") }
          )
        }
        openDropdownAt(x, y, items, function(item) {
          if (item.cmd === "askAI") { askAiFromSelection(); return }
          if (!runCanvasCmd(item.cmd)) document.execCommand(item.cmd, false, item.val)
        })
      }

      // 标题下拉菜单
      function showHeadingDropdown(anchor) {
        var currentH = selectionFormats.heading
        var items = [
          { label: "正文", val: "<p>", active: !currentH },
          { type: "sep" },
          { label: "一级标题", val: "<h1>", active: currentH === 'h1', style: "font-size:18px;font-weight:700" },
          { label: "二级标题", val: "<h2>", active: currentH === 'h2', style: "font-size:16px;font-weight:600" },
          { label: "三级标题", val: "<h3>", active: currentH === 'h3', style: "font-size:14px;font-weight:600" },
          { label: "四级标题", val: "<h4>", active: currentH === 'h4', style: "font-size:13px;font-weight:600" },
          { label: "五级标题", val: "<h5>", active: currentH === 'h5', style: "font-size:12px;font-weight:500" },
          { label: "六级标题", val: "<h6>", active: currentH === 'h6', style: "font-size:11px;font-weight:500" },
        ]
        showDropdown(anchor, items, function(item) {
          restoreSelection()
          document.execCommand('formatBlock', false, item.val)
          if (editorRef.current) editorRef.current.focus()
        })
      }

      // 对齐下拉菜单
      function showAlignDropdown(anchor) {
        var items = [
          { label: "左对齐", cmd: "justifyLeft", active: false },
          { label: "居中对齐", cmd: "justifyCenter", active: false },
          { label: "右对齐", cmd: "justifyRight", active: false },
        ]
        showDropdown(anchor, items, function(item) {
          restoreSelection()
          document.execCommand(item.cmd, false, null)
          if (editorRef.current) editorRef.current.focus()
        })
      }

      // ↑ 已提到模块级：见文件上方「静态资源（模块级）」
      // ─── 全功能菜单（⋮：移动端唯一入口，格式+插入都在）──────────────
      function showFullMenu(anchor) {
        var items = [
          { type: "header", label: "格式" },
          { label: "行内代码", cmd: "inlineCode", icon: ccvIcon("code") },
          { label: "高亮", cmd: "highlight", icon: ccvIcon("highlight") },
          { label: "清除格式", cmd: "clearFormat", icon: ccvIcon("clear") },
          { label: "脚注", cmd: "footnote", icon: "¹" },
          { type: "header", label: "插入" },
          { label: "上传图片…", cmd: "uploadImage", icon: ccvIcon("uploadImage") },
          { label: "网络图片…", cmd: "imageUrl", icon: ccvIcon("globe") },
          { label: "上传文件…", cmd: "uploadFile", icon: ccvIcon("file") },
          { label: "插入表格…", cmd: "insertTable", icon: ccvIcon("table") },
          { label: "任务列表", cmd: "insertTaskList", icon: ccvIcon("task") },
          { label: "无序列表", cmd: "insertUnorderedList", icon: ccvIcon("listUl") },
          { label: "有序列表", cmd: "insertOrderedList", icon: ccvIcon("listOl") },
          { label: "插入链接…", cmd: "link", icon: ccvIcon("link") },
          { type: "header", label: "块" },
          { type: "row", items: [
            { label: "代码块", cmd: "codeBlock", icon: ccvIcon("codeBlock") },
            { label: "引用", cmd: "blockquote", icon: ccvIcon("quote") },
            { label: "分割线", cmd: "insertHorizontalRule", icon: ccvIcon("hr") },
            { label: "高亮块", cmd: "highlightBlock", icon: ccvIcon("hlBlock") },
          ]},
          { type: "header", label: "缩进" },
          { label: "增加缩进", cmd: "indent", icon: ccvIcon("indent") },
          { label: "减少缩进", cmd: "outdent", icon: ccvIcon("outdent") },
        ]
        showDropdown(anchor, items, function(item) {
          if (!runCanvasCmd(item.cmd)) document.execCommand(item.cmd, false, item.val)
        })
      }
      var selectionFormats = { bold: false, italic: false, underline: false, heading: null }

      function onEditorMouseUp() {
        try {
          ccvLogD("mouseup: enter")
          var sel = document.getSelection()
          if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
            ccvLogD(function () { return "mouseup: 选区为空 -> hide (sel=" + (sel ? "collapsed" : "null") + ")" })
            hideSelbar(); return
          }
          var rect = sel.getRangeAt(0).getBoundingClientRect()
          ccvLogD(function () { return "mouseup: rect w=" + Math.round(rect.width) + " h=" + Math.round(rect.height) + " l=" + Math.round(rect.left) + " t=" + Math.round(rect.top) })
          if (!rect || (!rect.width && !rect.height)) {
            ccvLogD("mouseup: rect 空 -> hide")
            hideSelbar(); return
          }
          updateSelFormats(sel)
          showSelbar(rect)
        } catch(err) { ccvLog("mouseup: 抛异常 " + (err && err.message)); hideSelbar() }
      }

      function updateSelFormats(sel) {
        selectionFormats.bold = document.queryCommandState('bold')
        selectionFormats.italic = document.queryCommandState('italic')
        selectionFormats.underline = document.queryCommandState('underline')
        selectionFormats.heading = null
        try {
          var node = sel.getRangeAt(0).startContainer
          if (node.nodeType === 3) node = node.parentNode
          while (node && node.nodeType === 1) {
            var tag = node.tagName ? node.tagName.toLowerCase() : ''
            if (['h1','h2','h3','h4','h5','h6'].indexOf(tag) >= 0) { selectionFormats.heading = tag; break }
            if (node.classList && node.classList.contains('ccv-editor')) break
            node = node.parentNode
          }
        } catch(_){}
      }

      function showSelbar(rect) {
        var bar = document.getElementById('ccv-selbar')
        if (!bar) { ccvLog('showSelbar: 找不到 #ccv-selbar 元素'); return }
        // 先用「自然宽度」渲染（子项不收缩、文字不换行），渲染完再按实测尺寸定位。
        // 顺序很关键：若先定位再渲染，栏会被 left 挤到只剩很窄的可用宽度，
        // 按钮随之收缩，「💬 问AI」这类带文字的按钮内部就会折行。
        bar.style.left = '0px'; bar.style.top = '0px'
        bar.style.display = 'flex'
        bar.innerHTML = ''
        SELBAR_ITEMS.forEach(function(item) {
          if (item.type === 'sep') {
            var sep = document.createElement('span')
            sep.style.cssText = 'width:1px;height:20px;background:rgba(128,128,128,.2);margin:0 2px;flex:0 0 auto'
            bar.appendChild(sep)
            return
          }
          var btn = document.createElement('button')
          btn.innerHTML = item.label; btn.title = item.title
          btn.style.cssText = 'padding:4px 8px;border:none;background:transparent;color:inherit;border-radius:6px;font-size:13px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;min-width:28px;height:28px;transition:background .1s ease;flex:0 0 auto;white-space:nowrap;line-height:1'
          btn.addEventListener('mouseenter', function() { if (!btn.dataset.active) btn.style.background = 'rgba(128,128,128,.12)' })
          btn.addEventListener('mouseleave', function() { if (!btn.dataset.active) btn.style.background = 'transparent' })
          var isActive = false
          if (item.cmd === 'bold') isActive = selectionFormats.bold
          else if (item.cmd === 'italic') isActive = selectionFormats.italic
          else if (item.cmd === 'underline') isActive = selectionFormats.underline
          else if (item.cmd === 'formatBlock' && item.val) isActive = selectionFormats.heading === item.val.replace('<','').replace('>','')
          // 选中态：灰色胶囊（不遮字、深浅主题都可读），替代之前的黑白反色
          if (isActive) { btn.dataset.active = '1'; btn.style.background = 'rgba(128,128,128,.18)'; btn.style.color = 'var(--dsw-alias-label-primary, #1a1a1a)' }
          btn.addEventListener('mousedown', function(e) { e.preventDefault() })
          btn.addEventListener('click', function(e) {
            e.stopPropagation()
            if (item.isAskAI) {
              // 问 AI：选中文本以引用格式塞进输入框（右键菜单同款逻辑）
              askAiFromSelection()
            } else if (item.hasDropdown) {
              if (item.isHeading) showHeadingDropdown(btn)
              else if (item.showAlign) showAlignDropdown(btn)
              else if (item.showFullMenu) showFullMenu(btn)
            } else if (!runCanvasCmd(item.cmd)) {
              document.execCommand(item.cmd, false, item.val)
              if (editorRef.current) editorRef.current.focus()
            }
          })
          bar.appendChild(btn)
        })
        // 渲染完再测量真实尺寸并定位：优先贴选区左侧，
        // 右边放不下就整体左移（允许盖到会话区上方，即「超出话布」）。
        var bw = bar.offsetWidth || 340
        var bh = bar.offsetHeight || 40
        var x = Math.max(8, Math.min(rect.left, window.innerWidth - bw - 8))
        var y = rect.top - bh - 10
        if (y < 8) y = Math.min(rect.bottom + 10, window.innerHeight - bh - 8)
        bar.style.left = x + 'px'; bar.style.top = y + 'px'
        // 落定后再量一次：位置/尺寸/裁剪祖先，任何一项不对都能从日志看出来
        ccvLogD(function () {
          var fin = bar.getBoundingClientRect()
          return 'showSelbar: 完成 bw=' + bw + ' bh=' + bh + ' x=' + x + ' y=' + y +
            ' | display=' + bar.style.display +
            ' | 实际渲染 w=' + Math.round(fin.width) + ' h=' + Math.round(fin.height) +
            ' l=' + Math.round(fin.left) + ' t=' + Math.round(fin.top) +
            ' | offsetParent=' + ccvDesc(bar.offsetParent) +
            ' | parent=' + ccvDesc(bar.parentElement)
        })
        // 沿祖先链找第一个会裁剪 fixed 子元素的容器（有 overflow 且非 visible）
        // 这段纯粹是诊断用的（结果只进日志），且 getComputedStyle 会强制排版 —— 同样只在开关打开时跑
        ccvLogD(function () {
          var n = bar.parentElement, clip = 'none'
          while (n && n !== document.documentElement) {
            var ov = getComputedStyle(n).overflow
            if (ov && ov !== 'visible') { clip = ccvDesc(n) + ' overflow=' + ov; break }
            n = n.parentElement
          }
          return 'showSelbar: 裁剪祖先 ' + clip
        })
      }
      function hideSelbar() {
        var bar = document.getElementById('ccv-selbar');
        if (bar) bar.style.display = 'none';
        // 取调用栈很贵，且这里一次鼠标松开可能被调多次 —— 只有 CCV_DEBUG 打开时才做
        ccvLogD(function () {
          var st = ''
          try { st = (new Error()).stack || '' } catch (e) {}
          var line = st.split('\n')[2] || ''
          return 'hideSelbar: 调用 bar=' + (bar ? 'yes' : 'MISSING') + ' 来自 ' + String(line).trim()
        })
      }

      // ↑ 已提到模块级：见文件上方「静态资源（模块级）」
      // 当前话布标题：canvases 里找 activeId 对应的那条
      let curTitle = "";
      for (let i = 0; i < canvases.length; i++) {
        if (canvases[i].id === activeId) { curTitle = canvases[i].title; break; }
      }

      // ccv-docked 是个纯标记类（没有对应 CSS），用来在 DOM 上标明"停靠"这一种摆法
      return h("div", { ref: panelRef, className: "ccv-panel ccv-docked", style: CCV_STYLE.panel },
        h("div", {
          className: "ccv-head",
          // 读数平时透明，鼠标移进顶栏才浮现
          onMouseEnter: () => { if (meterRef.current) meterRef.current.style.opacity = "0.45"; },
          onMouseLeave: () => { if (meterRef.current) meterRef.current.style.opacity = "0"; }
        },
          // ─── 第一行：管话布（新建 / 切换 / 全屏）───
          h("div", { className: "ccv-row ccv-row-top" },
            h("button", {
              className: "ccv-ibtn",
              onClick: creating ? cancelCreate : startCreate,
              title: creating ? "取消新建" : "新建话布"
            }, creating ? "✕" : "＋"),
            creating
              ? h("input", {
                  className: "ccv-ninput", autoFocus: true, value: newTitle,
                  placeholder: "话布标题，回车创建",
                  onChange: e => setNewTitle(e.target.value),
                  onKeyDown: e => {
                    if (e.key === "Enter") { e.preventDefault(); submitCreate(); }
                    else if (e.key === "Escape") { e.preventDefault(); cancelCreate(); }
                  }
                })
              : h("div", { className: "ccv-chipwrap" },
                  h("div", { className: "ccv-chip", onClick: toggleDrop, title: "点击切换话布" },
                    h("span", { className: "ccv-chip-title", title: curTitle || "未选话布" }, curTitle || "未选话布"),
                    h("span", { className: "ccv-chip-caret" }, "▾")
                  ),
                  // 切换下拉：absolute 挂在胶囊正下方（left:0 对齐胶囊左缘），
                  // 不是 fixed 浮层 —— 它属于顶栏的局部堆叠，不会脱离面板
                  dropOpen ? h("div", { className: "ccv-drop" },
                    canvases.length
                      ? canvases.map(c => h("div", { key: c.id, className: "ccv-drop-row" },
                          h("button", {
                            className: "ccv-drop-item", "data-on": c.id === activeId ? "1" : "0",
                            title: c.title,
                            onClick: () => { loadCanvas(c.id); setDropOpen(false); }
                          }, c.title),
                          h("button", {
                            className: "ccv-drop-x", title: "删除话布「" + c.title + "」（同时删除对应 md 文件）",
                            onClick: (e) => { e.stopPropagation(); deleteCanvasById(c.id, c.title); }
                          }, "×")
                        ))
                      : h("div", { className: "ccv-drop-empty" }, "还没有话布，点 ＋ 新建一个")
                  ) : null
                ),
            h("div", { className: "ccv-spacer" }),
            // 全屏、关闭都交给右侧栏标签栏自己做（官方那个 × 与我原来的 × 完全重复，
            // 已于 2026-09-12 撤下），这里不再重复放按钮。
            null
          ),
          // ─── 第二行：管当前文档（保存 / 重载）───
          h("div", { className: "ccv-row ccv-row-doc" },
            h("button", { className: "ccv-tbtn", onClick: saveCanvas, disabled: !activeId, title: "保存到服务端（停止输入 1.5 秒后也会自动存）" }, "保存"),
            h("button", { className: "ccv-tbtn", onClick: () => { if (activeId) loadCanvas(activeId); }, disabled: !activeId, title: "从服务端拉取最新内容 —— AI 在对话里改过话布后用它同步" }, "重载"),
            h("button", { className: "ccv-ibtn", onClick: openFolder, title: "在文件管理器中打开本文档所在的文件夹",
              dangerouslySetInnerHTML: { __html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:auto"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>' } }),
            h("button", { className: "ccv-tbtn", onClick: manageRegistry, title: "登记文件夹：之后把登记文件夹内的文件拖进 DSH 窗口时，按真实路径 @ 引用（不产生副本）" }, "登记"),
            h("div", { className: "ccv-spacer" }),
            // 恢复提示：切标签会拆掉画布，切回来时如果捞到一份没写盘的草稿就说明一下，
            // 否则用户会以为"我明明打过的字怎么自己变回去了"
            restored ? h("span", {
              className: "ccv-meter",
              title: "这是你上次没来得及保存的内容，已自动补存回服务端",
              style: { opacity: 1, color: "var(--dsw-alias-label-secondary, #6b7280)" }
            }, "已恢复未保存内容") : null,
            h("span", {
              ref: meterRef, className: "ccv-meter",
              title: "本标签的宽度"
            })
          )
        ),
        h("div", {
          ref: editorRef, className: "ccv-editor", contentEditable: true, suppressContentEditableWarning: true, style: compact ? CCV_STYLE.editorCompact : CCV_STYLE.editorWide,
          dangerouslySetInnerHTML: { __html: mdToHtml(content) },
          onInput: () => { scheduleDraft(); clearTimeout(saveTimer.current); saveTimer.current = setTimeout(saveCanvas, 1500); },
          onMouseUp: onEditorMouseUp,
          onContextMenu: (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY) }
        }),
        // width:max-content + flexWrap:nowrap —— 让栏按内容取自然宽度，
        // 绝不被 left 位置挤窄；放不下时由 showSelbar 整体左移，而不是内部折行。
        h("div", { id: "ccv-selbar", style: { position: "fixed", zIndex: 100000, display: "none", alignItems: "center", gap: 1, width: "max-content", maxWidth: "none", flexWrap: "nowrap", flexShrink: 0, background: "var(--dsw-specific-menu, var(--dsw-alias-bg-overlay, #fff))", color: "var(--dsw-alias-label-primary, #1a1a1a)", border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))", borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,.1)", padding: "3px 6px", userSelect: "none", WebkitUserSelect: "none", backdropFilter: "blur(12px) saturate(150%)", WebkitBackdropFilter: "blur(12px) saturate(150%)" } })
      );
    }

    // ─── 输入桥组件：把官方 inputActions / draft 暴露给划词栏 ──
    // 新版 DSH 输入框是 Lexical 编辑器，直接改 DOM 无法可靠同步；
    // slot 组件能拿到 inputActions.setDraft（官方接口），存到全局供「问AI」调用。
    function InputBridge(props) {
      var inputState = null
      try { inputState = props.useInput ? props.useInput(function(s) { return s }) : null } catch (e) { inputState = null }
      React.useEffect(function() {
        if (props.inputActions) window.__ccvInputActions = props.inputActions
      }, [])
      React.useEffect(function() {
        window.__ccvInputState = inputState
      }, [inputState])
      return null
    }

    // ─── 门厅页（右侧栏「开始」）的入口图标 ────────────────
    // 门厅页会给每个注册的标签类型画一个入口胶囊，图标没给就画个占位方块。
    // 这里画一块"画布 + 两行字"的小图，和「工作区文件」的文件夹图标同尺寸。
    // 只需 { size, className } 两个属性，跟随 currentColor，主题自动适配。
    function CcvGuideGlyph(props) {
      var size = props && props.size ? props.size : 16;
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none",
        className: props ? props.className : undefined, "aria-hidden": "true"
      },
        h("rect", {
          x: 2.1, y: 2.7, width: 11.8, height: 10.6, rx: 2.2,
          stroke: "currentColor", strokeWidth: 1.2
        }),
        h("path", {
          d: "M5.1 6.1h5.8M5.1 9.1h3.5",
          stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round"
        })
      );
    }

    // ─── 插件注册 ──────────────────────────────────────
    // ─── 停靠模式：右侧栏标签的正文 ────────────────────────
    // 这里渲染的就是同一个 CanvasPanel，只是把它当"填满标签页的一块区域"，
    // 而不再是一个自己拖宽度、自己挤对话列的悬浮层。
    // 右侧栏标签正文会收到一组标准 props（useTabInfo / sessionId / actions …）。
    // 将来若要加「关闭本标签」之类的入口，从 props.useTabInfo().tab.actions 取就行 ——
    // 官方标签栏自带的 × 已经在做这件事，所以我方不再放重复的关闭按钮（2026-09-12 撤下）。
    function CanvasDockBody() {
      return h("div", {
        style: {
          display: "flex", flexDirection: "column",
          height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden",
          background: "var(--dsw-alias-bg-layer-1, #fff)"
        }
      }, h(CanvasPanel, { ctx: ccvCtx }));
    }

    const inject = ["slots", "conversation", "sidebarRightTabs", "sidebarRight"];

    // 幂等注入一段 CSS：同一个 id 只插一次，重复调用是空操作。
    // apply 有可能被走多遍（宿主重挂插件），靠这里去重。
    function ensureStyle(id, cssText) {
      if (typeof document === 'undefined') return;
      if (document.getElementById(id)) return;   // 已注入过，不重复插
      var el = document.createElement('style');
      el.id = id;
      el.textContent = cssText;
      document.head.appendChild(el);
    }

    function apply(ctx) {
      ccvCtx = ctx;   // tab 正文是另一个组件，用的就是这个引用
      // ─── 会话内容限流 ──────────────────────────────
      // DSH 的会话消息不主动给 <img> 设 max-width，AI 生成的大图 / 截图会撑破
      // 会话列宽；右侧一旦打开话布（position:fixed、高 z-index），溢出的图片
      // 就被压在话布底下看不见。在 apply 入口注入一次，按列宽缩放。
      ensureStyle('ccv-cc-constrain',

          // 全局兜底：DSH 各处都可能塞大图（AI 截图、代码块配图、Markdown 预览、
          // React Portal 灯箱等），都得按父容器宽缩放。图标通常有自己的显式
          // width/height，加这两条只对它们是"上限"，不影响已设的尺寸。
          // ⚠️ 不加 height:auto——只显式 width 没显式 height 的图标会被重置比例。
          'img{' +
            'max-width:100%!important;' +
            'max-height:100vh!important;' +
          '}' +
          // 会话列：图片按列宽缩放，长代码块横向滚动
          '[data-slot="conversation"] img,' +
          '[data-pane="conversation"] img,' +
          // 话布面板内部：话布渲染的内容里有 AI 给的 <img>，同样会撑破面板
          // 用 .ccv-panel（面板根自己的 class）而不是 #collab-canvas-panel：
          // 停靠到右侧栏时没有那个宿主 id，写死 id 会让这一整段失效。
          // 类名写两遍是故意加权重，替掉原来靠 id 提权的做法。
          '.ccv-panel.ccv-panel img,' +
          '.ccv-panel.ccv-panel .ccv-editor img{' +
            'max-width:100%!important;' +
          '}' +
          // 不让 #root / body / 浮层超出视口横向滚动
          'html,body,#root{' +
            'overflow-x:hidden!important;' +
          '}' +
          '[data-slot="conversation"] pre,' +
          '[data-pane="conversation"] pre,' +
          // 长 <pre> 也按列宽走横向滚动，避免撑破话布面板
          '.ccv-panel.ccv-panel .ccv-editor pre{' +
            'max-width:100%!important;' +
            'overflow-x:auto!important;' +
          '}'
      );
      // ─── 两行顶栏样式 ────────────────────────────
      // 上行管话布（＋新建 / 文件名切换 / 全屏），下行管当前文档（保存 / 重载 / 关闭）。
      // hover 与 disabled 用内联 style 表达不了（内联优先级还会盖掉 CSS 的 hover），
      // 所以走 className + 注入 CSS；选择器统一带 .ccv-panel 前缀提权（面板根自己的
      // class，悬浮/停靠两种摆法都命中），因此不需要 !important。
      ensureStyle('ccv-hdr2-style',
         [
          '.ccv-panel .ccv-head{display:flex;flex-direction:column;flex:0 0 auto;min-width:0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25))}',
          '.ccv-panel .ccv-row{display:flex;align-items:center;gap:6px;padding:5px 8px;flex-wrap:nowrap;overflow:visible;min-width:0}',
          '.ccv-panel .ccv-row-top{position:relative}',
          '.ccv-panel .ccv-row-doc{border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14))}',
          '.ccv-panel .ccv-ibtn{width:26px;height:26px;display:flex;align-items:center;justify-content:center;background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:6px;color:inherit;cursor:pointer;font-size:13px;font-family:inherit;line-height:1;padding:0;flex:0 0 auto;white-space:nowrap}',
          '.ccv-panel .ccv-ibtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15))}',
          '.ccv-panel .ccv-ibtn:disabled{opacity:.35;cursor:default}',
          '.ccv-panel .ccv-ibtn:disabled:hover{background:transparent}',
          '.ccv-panel .ccv-tbtn{padding:4px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:6px;background:transparent;color:inherit;font-size:12px;font-family:inherit;cursor:pointer;flex:0 0 auto;white-space:nowrap;line-height:1.4}',
          '.ccv-panel .ccv-tbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15))}',
          '.ccv-panel .ccv-tbtn:disabled{opacity:.35;cursor:default}',
          '.ccv-panel .ccv-tbtn:disabled:hover{background:transparent}',
          '.ccv-panel .ccv-chip{display:flex;align-items:center;gap:6px;padding:4px 6px 4px 8px;background:rgba(128,128,128,.08);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:7px;max-width:240px;min-width:56px;flex:0 1 auto;font-size:13px;color:inherit;cursor:pointer;user-select:none}',
          '.ccv-panel .ccv-chip:hover{filter:brightness(1.06)}',
          '.ccv-panel .ccv-chipwrap{position:relative;display:flex;min-width:0;flex:0 1 auto}',
          '.ccv-panel .ccv-chip-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}',
          '.ccv-panel .ccv-chip-caret{flex:0 0 auto;font-size:10px;line-height:1;opacity:.65}',
          '.ccv-panel .ccv-spacer{flex:1 1 0%;min-width:6px}',
          '.ccv-panel .ccv-ninput{width:150px;flex:0 1 auto;min-width:64px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));border-radius:6px;background:transparent;color:inherit;font-size:13px;font-family:inherit;outline:none;line-height:1.4}',
          '.ccv-panel .ccv-drop{position:absolute;top:calc(100% + 3px);left:0;z-index:60;min-width:200px;max-width:min(260px,80vw);max-height:52vh;overflow-y:auto;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:8px;padding:4px;box-shadow:0 4px 14px rgba(0,0,0,.12)}',
          '.ccv-panel .ccv-drop-item{display:block;width:100%;text-align:left;padding:6px 8px;border:none;background:transparent;color:inherit;font-size:13px;font-family:inherit;cursor:pointer;border-radius:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;box-sizing:border-box}',
          '.ccv-panel .ccv-drop-item:hover{background:rgba(128,128,128,.12)}',
          '.ccv-panel .ccv-drop-item[data-on="1"]{font-weight:600;background:rgba(128,128,128,.1)}',
          '.ccv-panel .ccv-drop-row{display:flex;align-items:center;gap:4px}',
          '.ccv-panel .ccv-drop-row .ccv-drop-item{flex:1 1 auto;min-width:0}',
          '.ccv-panel .ccv-drop-x{flex:0 0 auto;width:20px;height:24px;border:none;background:transparent;color:inherit;opacity:.45;cursor:pointer;font-size:14px;line-height:1;border-radius:4px}',
          '.ccv-panel .ccv-drop-x:hover{opacity:1;background:rgba(128,128,128,.18)}',
          '.ccv-panel .ccv-drop-empty{padding:8px;opacity:.6;font-size:12px;text-align:center}',
          '.ccv-panel .ccv-meter{font-size:11px;opacity:0;transition:opacity .15s ease;white-space:nowrap;user-select:none;font-variant-numeric:tabular-nums;flex:0 0 auto}',
          // 脚注区域样式
          '.ccv-panel .ccv-editor .footnotes{margin-top:16px;padding-top:8px;font-size:13px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.85))}',
          '.ccv-panel .ccv-editor .footnotes hr{border:none;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));margin:0 0 8px}',
          '.ccv-panel .ccv-editor .footnotes ol{margin:0;padding-left:20px}',
          '.ccv-panel .ccv-editor .footnotes li{margin:4px 0;line-height:1.6}',
          '.ccv-panel .ccv-editor .footnotes a{color:#3b82f6;text-decoration:none}'
        ].join('\n')
      );
      // ─── Markdown 渲染样式（新 editor 用 .ccv-editor；旧 03-styles.js 的 .ccv-wysiwyg 已弃用）
      ensureStyle('ccv-md-style',
         [
          '.ccv-panel .ccv-editor > *:first-child{margin-top:0}',
          '.ccv-panel .ccv-editor > *:last-child{margin-bottom:0}',
          '.ccv-panel .ccv-editor h1{font-size:1.6em;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));padding-bottom:.2em;margin:.6em 0 .4em;font-weight:600;line-height:1.3}',
          '.ccv-panel .ccv-editor h2{font-size:1.35em;margin:.7em 0 .45em;font-weight:600;line-height:1.35}',
          '.ccv-panel .ccv-editor h3{font-size:1.18em;margin:.7em 0 .45em;font-weight:600;line-height:1.35}',
          '.ccv-panel .ccv-editor h4{font-size:1.05em;margin:.7em 0 .45em;font-weight:600;line-height:1.35}',
          '.ccv-panel .ccv-editor h5{font-size:1em;margin:.7em 0 .45em;font-weight:600;line-height:1.35}',
          '.ccv-panel .ccv-editor h6{font-size:.95em;margin:.7em 0 .45em;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-secondary,rgba(0,0,0,.65))}',
          '.ccv-panel .ccv-editor p{margin:.5em 0}',
          '.ccv-panel .ccv-editor blockquote{border-left:3px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));margin:.6em 0;padding:4px 12px;opacity:.9;color:var(--dsw-alias-label-secondary,rgba(0,0,0,.7))}',
          '.ccv-panel .ccv-editor blockquote > *:first-child{margin-top:0}',
          '.ccv-panel .ccv-editor blockquote > *:last-child{margin-bottom:0}',
          '.ccv-panel .ccv-editor mark{background:rgba(250,204,21,.45);color:inherit;padding:0 2px;border-radius:3px}',
          '.ccv-panel .ccv-editor .ccv-hl{background:rgba(250,204,21,.16);border-left:3px solid rgba(234,179,8,.55);border-radius:6px;padding:8px 14px;margin:.6em 0}',
          '.ccv-panel .ccv-editor .ccv-hl > *:first-child{margin-top:0}',
          '.ccv-panel .ccv-editor .ccv-hl > *:last-child{margin-bottom:0}',
          '.ccv-panel .ccv-editor input[type="checkbox"]{cursor:pointer}',
          '.ccv-panel .ccv-editor pre{background:var(--dsw-alias-markdown-code-block,rgba(128,128,128,.12));padding:10px 12px;border-radius:6px;overflow-x:auto;white-space:pre-wrap;margin:.6em 0;font-family:var(--font-mono,ui-monospace,Menlo,monospace);font-size:.95em}',
          '.ccv-panel .ccv-editor code{background:var(--dsw-alias-markdown-inline-code,rgba(128,128,128,.16));padding:1px 4px;border-radius:3px;font-family:var(--font-mono,ui-monospace,Menlo,monospace);font-size:.95em}',
          '.ccv-panel .ccv-editor pre code{background:transparent;padding:0;border-radius:0}',
          '.ccv-panel .ccv-editor ul,.ccv-panel .ccv-editor ol{padding-left:1.6em;margin:.5em 0}',
          '.ccv-panel .ccv-editor li{margin:.25em 0}',
          '.ccv-panel .ccv-editor ul ul,.ccv-panel .ccv-editor ol ol,.ccv-panel .ccv-editor ul ol,.ccv-panel .ccv-editor ol ul{margin:.2em 0}',
          '.ccv-panel .ccv-editor li input[type="checkbox"]{margin-right:.45em;vertical-align:middle;width:1em;height:1em}',
          '.ccv-panel .ccv-editor li:has(> input[type="checkbox"]){list-style:none;margin-left:-.2em}',
          '.ccv-panel .ccv-editor table{border-collapse:separate;border-spacing:0;margin:.8em 0;width:100%;max-width:100%;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.55));border-radius:6px;overflow:hidden}',
          '.ccv-panel .ccv-editor th,.ccv-panel .ccv-editor td{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.55));padding:8px 12px;text-align:left;vertical-align:top}',
          '.ccv-panel .ccv-editor th{background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.18));font-weight:600}',
          '.ccv-panel .ccv-editor tr:nth-child(even){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}',
          '.ccv-panel .ccv-editor tr:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(59,130,246,.08))}',
          '.ccv-panel .ccv-editor hr{border:none;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));margin:1em 0}',
          '.ccv-panel .ccv-editor a{color:#3b82f6;text-decoration:underline;cursor:pointer}',
          // 脚注引用 [1] 和文末 ↩ 不是网页链接，保持无下划线、不做手型
          '.ccv-panel .ccv-editor a[href^="#fn"]{text-decoration:none;cursor:default}',
          '.ccv-panel .ccv-editor img{max-width:100%;height:auto;vertical-align:middle}',
          '.ccv-panel .ccv-editor strong{font-weight:600}',
          '.ccv-panel .ccv-editor em{font-style:italic}',
          '.ccv-panel .ccv-editor del{text-decoration:line-through;opacity:.75}'
        ].join('\n')
      );
      // ─── JS 终极兜底 ──────────────────────────────
      // 即使 CSS 选择器漏、即使 inline style 用了 !important (CSS 覆盖不了
      // inline !important) 都能压住。
      //
      // ⚠️ 2026-09-12 改：**不再"任何 DOM 新增都全量重扫"**。
      //    实测（600 次 DOM 变更，模拟 AI 流式输出）：旧写法每次变更都重扫全页图片，
      //    4.0ms → 93.5ms，每次多花 0.155ms、**慢 233 倍**。
      //    （同一个函数在"布局已静止"的页面上只要 0.027ms —— 差别全在布局是不是脏的：
      //     布局一旦变脏，每次读 offsetWidth 都会强制同步重排。所以静态页面测不出问题。）
      //    现在：DOM 变化只在"新增节点里确实含 <img>"时才扫，且**只扫新增的那棵子树**；
      //    另外保留每秒一次的全量扫作为安全网 —— 它专门负责"容器变窄但没加节点"这类情况
      //    （那种情况不产生任何 DOM 变化，观察者根本收不到通知）。
      //    安全网的代价：静止时每次约 0.03ms，流式时每秒约 0.15ms，都不值一提。
      //
      // ⚠️ 2026-09-12 又修两处（真机实测才发现，前面几轮静态检查全都没抓到）：
      //    ① `addEventListener("DOMContentLoaded", fix)` 会把**事件对象**当第一个实参传进去，
      //       于是 fix 收到 root=Event（不是节点），`scope.querySelectorAll` 不存在 → 扫空集合。
      //       结果：首次注入时那次修复是**哑的**，只能等 1 秒后的定时器。
      //       实测时间线：图片 2000px 溢出，DOMContentLoaded 不动，1200ms 才被压回。
      //       改成 `function(){fix()}` 后，DOMContentLoaded 当帧就压回 —— 提前约 1.2 秒。
      //    ② 图片还没解码完时 `offsetWidth`/`naturalWidth` 都是 0，量不出溢出，
      //       于是给它挂一次性 `load` 回调，解码完再量一次（属性 `__ccvLh` 防重复挂）。
      //       这条对**网络图片**才是关键（data URI 是同步解码的，测不出来）。
      //    真机三场景回归（初始 / 容器变窄 / 后续新插入）全部 100% 压住。
      //
      // ⚠️ JS 必须严格无 inline `//` 注释——下面的代码会被拼成单行，注释到 EOF
      // 行为不可靠。这里用 \n 转义序列替代源换行，并把注释放进函数体内作为可
      // 运行的字符串字面量（不是真的 JS 注释，零运行时开销）。
      if (!document.getElementById('ccv-cc-constrain-js')) {
        try {
          var js = document.createElement('script');
          js.id = 'ccv-cc-constrain-js';
          js.textContent = [
            '(function(){',
            'var one=function(img){',
            'if(!img||!img.isConnected)return;',
            'var parent=img.parentElement||document.body;',
            'var pw=parent.clientWidth;',
            'if(!pw)return;',
            'var w=img.offsetWidth||img.naturalWidth||0;',
            'if(!w){if(!img.__ccvLh){img.__ccvLh=1;img.addEventListener("load",function(){one(img)},false);}return;}',
            'if(w>pw+2){',
            'img.style.maxWidth="100%";',
            'img.style.maxHeight="100vh";',
            'img.style.width="100%";',
            'img.style.height="auto";',
            '}',
            '};',
            'var fix=function(root){',
            'var scope=(root&&root.nodeType)?root:document;',
            'if(scope.nodeType===1&&scope.tagName==="IMG"){one(scope);return;}',
            'var imgs=scope.querySelectorAll?scope.querySelectorAll("img"):[];',
            'for(var i=0;i<imgs.length;i++)one(imgs[i]);',
            '};',
            'var hasImg=function(n){',
            'if(!n||n.nodeType!==1)return false;',
            'if(n.tagName==="IMG")return true;',
            'return !!(n.querySelector&&n.querySelector("img"));',
            '};',
            'if(document.readyState!=="loading")fix();',
            'else document.addEventListener("DOMContentLoaded",function(){fix()});',
            'setInterval(fix,1000);',
            'try{',
            'new MutationObserver(function(muts){',
            'var hit=null;',
            'for(var i=0;i<muts.length;i++){',
            'var ns=muts[i].addedNodes;',
            'if(!ns||!ns.length)continue;',
            'for(var j=0;j<ns.length;j++){',
            'if(hasImg(ns[j])){hit=ns[j];break;}',
            '}',
            'if(hit)break;',
            '}',
            'if(hit)fix(hit);',
            '}).observe(document.body,{childList:true,subtree:true});',
            '}catch(e){}',
            '})();'
          ].join('\n');
          document.head.appendChild(js);
        } catch (e) {}
      }

      // ─── 对外桥接（原先由顶栏按钮组件注册，现改由插件自己提供）──────
      // 对话里的文档名链接、上传卡片链接（lib/doclink.js）靠这两个全局量打开
      // 话布、并判断画布是否已打开。撤掉顶栏按钮后若不补上，那些链接会点不动
      // （doclink 日志里会出现「话布桥接未就绪」）。
      // __ccvPanelOpen 必须做成"取值即判断"的 getter：doclink 是在点击那一刻读它的，
      // 要反映此刻有没有画布，而不是某个组件的挂载状态。
      window.__ccvCanvasToggle = function () {
        var svc = null;
        try { svc = ctx.sidebarRight; } catch (_) {}
        if (!svc || typeof svc.openTab !== "function") {
          ccvLog("打开话布失败：拿不到右侧栏接口");
          return false;
        }
        try { svc.openTab(CCV_DOCK_KIND); return true; }
        catch (e) { ccvLog("打开话布失败: " + (e && e.message)); return false; }
      };
      try {
        Object.defineProperty(window, "__ccvPanelOpen", {
          configurable: true,
          get: function () {
            try { return !!document.querySelector(".ccv-panel"); } catch (_) { return false; }
          }
        });
      } catch (e) { ccvLog("注册画布状态桥接失败: " + (e && e.message)); }
      // 注册输入桥（隐藏组件，暴露 inputActions.setDraft 给划词栏）
      ctx.slots.inject("conversation.input.dock", () =>
        ctx.slots.register({
          name: "conversation.input.dock",
          id: "collab-canvas-input-bridge",
          order: 999,
          label: () => "画布输入桥"
        }, InputBridge)
      );

      // ─── 停靠模式：把真画布挂进 DSH 内置右侧栏 ─────────────────
      // 两阶段注册，和官方 sidebar-files 完全同款：
      //   ① 声明一个「页面型」标签类型（不认地址，靠 openTab 打开）
      //   ② 把正文注册到 sidebar.right.pane.tab 槽位，key = 上面那个 id
      // 注意：这两个服务必须写进 inject（声明依赖），不能运行时 ctx.xxx 现取 ——
      // 现取拿不到，而且失败会被静默吞掉，按钮出来了却点不开。
      try {
        ctx.effect(function () {
          return ctx.sidebarRightTabs.register({
            id: CCV_DOCK_KIND,
            kind: CCV_DOCK_KIND,
            priority: "extension",
            title: function () { return "话布"; },
            // 门厅页（右侧栏「开始」）的入口胶囊。给了 guide 就出现在那一页，
            // 点它 = 在本标签的位置打开话布，所以门厅是"门"而不是"常驻页"。
            // order 越小越靠前（官方的「工作区文件」是 10）。
            guide: [{
              order: 20,
              title: function () { return "话布"; },
              description: function () { return "画布式文档：随手记与整理，可存进工作区"; },
              icon: CcvGuideGlyph
            }]
          });
        }, "collab-canvas: 右侧栏 tab 类型");
      } catch (e) { ccvLog("右侧栏 tab 类型注册失败: " + (e && e.message)); }

      try {
        ctx.slots.inject("sidebar.right.pane.tab", function () {
          return ctx.slots.register({ name: "sidebar.right.pane.tab", key: CCV_DOCK_KIND }, CanvasDockBody);
        });
      } catch (e) { ccvLog("右侧栏 tab 正文注册失败: " + (e && e.message)); }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
