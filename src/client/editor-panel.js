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
        // docdrop.js / doclink.js 随画布面板一起删了（2026-10-11）——它们是面板专属的：
        //   docdrop  把文件拖到**面板上**上传；doclink 把对话里的文档名链接指向**面板**。
        // 留着两个没人调的模块只会白拉两次源码 ✗
        // ⚠️ doc-model.js 必须排在 viewer-md.js **前面** ✓
        //   （A4：viewer-md 按块转换要用 window.__ccvDocModel ✓ 虽然是在渲染时才用，
        //     但先加载它能让"模型没到 → 退回老路"这个兜底尽量不触发 ✓）
        ["/api/canvas/ccv-logic.js", "/api/canvas/doc-model.js", "/api/canvas/selref.js", "/api/canvas/viewer-md.js"].forEach(function (u) {
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
    //
    // ★ 2026-10-26 重构 P1：纯逻辑搬进 lib/ccv-logic.js ★
    //   hashStr / 地址拼装 / 分组拼装 / 旧键反查 全部在那边 ✓ 单一实现 ✓ 可被 Node 测试 ✓
    //   这里只保留**需要 DOM / window / ctx** 的部分 ✓（这些本来就测不了 ✓）
    //   ⚠️ 逻辑模块由侧模块引导异步加载 ✗ 所以用这个取值器：
    //      真正用到它时（用户点开列表 / 打开文档）早就加载完了 ✓
    //      取不到就**明确报错**并降级 ✓ 不静默 ✗
    function ccvLogic() {
      try {
        var L = window.__ccvLogic
        if (L && typeof L.buildGroups === 'function') return L
      } catch (_) {}
      ccvLog('逻辑层未加载 ✗（lib/ccv-logic.js 没到）—— 分组/地址功能会降级')
      return null
    }
    // 兜底哈希：只在逻辑层没到时用 ✓（宁可算得对但重复，也不要直接崩 ✗）
    function hashStr(s) {
      var L = ccvLogic()
      if (L) return L.hashStr(s)
      let h = 5381;
      const str = String(s == null ? '' : s)
      for (let i = 0; i < str.length; i++) { h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; }
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
    // ★ 2026-10-24：会话键优先用**真 sessionId** ★
    //   主人原话：「现在要准确把分组名字显示成会话的名字」
    //   老做法 = hash(会话名) ✗ 单向哈希 → 查不回会话名 → 分组只能显示乱码 ✓
    //   真 sessionId 一直拿得到：
    //     · 查看器 props.sessionId → window.__ccvSessionId（publishInput 里写的 ✓）
    //     · 话布标签页 props.sessionId → 挂载时也写进同一个全局量 ✓
    //   → 有真 id 就用真 id ✓ 没有才退回老的哈希键（不能让功能炸 ✗）
    function realSessionId() {
      try {
        const v = window.__ccvSessionId
        if (v && typeof v === 'string' && /^session-/.test(v)) return v
      } catch (_) {}
      return ''
    }
    function sessionKey() {
      const real = realSessionId()
      if (real) return real                    // ← 新行为 ✓
      const name = activeSessionTitle()        // ← 老兜底（哈希键 ✓）
      if (name) return 'sess-' + hashStr(name)
      const t = (document.title || '默认会话').trim() || '默认会话'
      return 't' + hashStr(t)
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
      // markdown → HTML。给「接管查看器 .md」那个侧模块用（lib/viewer-md.js）：
      // 它要把文件内容渲染出来，而渲染器是本模块里的 mdToHtml —— 不重复造一份。
      mdToHtml: function (md) { try { return mdToHtml(md); } catch (_) { return ""; } },
      // React 也要借出去 —— 2026-10-04 补，这一条踩过坑：
      //   React 是本模块从**模块加载器** require("react") 拿的（见文件开头 L30），
      //   而侧模块是 host 端点供源码后 `new Function(src)()` **裸 eval** 的 ——
      //   它既没有 require，也没有 window.React。viewer-md.js 里写
      //   `window.React.createElement` 拿到的是 undefined → 组件 return null →
      //   查看器里**一片空白**（而且看不出原因，因为组件明明被调用了）。
      //   诊断日志打出 `React=没有` 才一眼定位。
      React: React,
      h: h,
      // htmlToMd 也借出去 —— 2026-10-11 加。
      // 为什么：往返自检（md → mdToHtml → htmlToMd → md2）本来挂在**面板**的加载流程里，
      // 结果主人在**查看器**里翻文档，自检一次都没跑 ✗。
      // 借给查看器之后，打开任何文档都能量到往返差异 —— 测量点跟着人走，而不是跟着代码走。
      htmlToMd: function (el) { try { return htmlToMd(el); } catch (_) { return null; } },
      // 建编辑区：**唯一实现**在主模块（见 ccvCreateScratch 的注释）——
      // 查看器的划词按钮从这里取，保证两个入口行为一模一样。
      createScratch: function (rec) { try { ccvCreateScratch(rec); } catch (_) {} },
      // 草稿（未保存内容的本地兜底）—— **唯一实现在面板里** ✓
      // 查看器拿它做"关页/崩溃不丢" ✓ 两个入口共用一份，行为必然一致 ✓
      // （面板的做法见 draftSet / draftDropIf：打字停一下就存 localStorage ✓
      //   打开文档时若草稿的基准版本对得上就恢复 ✓ 保存成功后丢掉 ✓）
      draftGet: function (id) { try { return draftGet(id); } catch (_) { return null; } },
      draftSet: function (id, content, base) { try { draftSet(id, content, base); } catch (_) {} },
      draftDropIf: function (id, md) { try { draftDropIf(id, md); } catch (_) {} },
      // 无条件丢掉草稿。用途：内容**回到基准**了（用户自己按 Ctrl+Z 撤回去了 ✓）
      // 那份草稿就作废了 —— 不丢的话下次一查又会"恢复"回那次编辑 ✗✗
      // （主人 2026-10-15 报的正是这个：改成斜体 → Ctrl+Z → 提示恢复了未保存的草稿 → 又变回斜体）
      draftDrop: function (id) { try { draftDrop(id); } catch (_) {} },
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
    // 🔍 高频路径的调试日志开关。默认 false —— 因为"鼠标松开 / 划词判定 / 隐藏划词栏"
    //    这类动作一秒能触发几十次，每次都在拼调用栈并发一条网络请求写盘，属于实打实的卡顿源。
    //    平时静默；排查划词相关问题时把它改成 true，这些日志就会照旧出现。
    //    低频日志（各种 catch 里的失败原因）不受影响，永远都会记。
    var CCV_DEBUG = false;
    // client.js 的版本标记。改动后**必须**在这里 +1，否则无法从日志核对浏览器
    // 加载的是哪一版（本环境开不了控制台，日志是唯一的核对通道）。
    //   v1  2026-09-12 起：并发保护（knownVer + 冲突处理）、草稿基准版本校验、
    //      行内规则先抽出后还原、列表往返修复
    //   v2  2026-09-14：引用块带上来源 @md 路径（ccvDocMention），
    //      多行选区逐行加 ">" 引号
    //   v3  2026-09-14：@ 来源改用 host 给的真实绝对路径（含空格走 @"..." 引号形式），
    //      不再自己拼相对路径 canvas-docs/<标题>.md
    //   v4  2026-09-14：「过期草稿」提示改为只提示一次（加 notified 标记），并缩短文案
    //   v5  2026-09-14：代码围栏的语言标记不再丢失（mdToHtml 存到 <pre data-lang>，
    //      htmlToMd 读回）；补了往返测试用例堵住这个盲区
    //   v6  2026-09-28：接上撤销/重做（工具栏两个按钮 + Ctrl+Z/Y）。
    //      撤销栈早在 host 侧就有（history/redoStack + canvas.undo RPC），
    //      但客户端只走 HTTP、RPC 够不着，界面上等于不存在
    //   v7  2026-10-04：修「点了撤销没反应」两处 ——
    //      ① 程序性重绘后把「已同步」基线重定到 DOM 自己的序列化结果
    //         （md 往返不是无损的，拿服务端 md 当基线会误判成"用户改了字"，
    //          于是撤销前白写一步，撤掉的是刚写的同一份内容 = 看起来没反应）；
    //      ② 撤销/重做按钮不再用 disabled 属性，栈空时也照样能点并给出提示
    //   v8  2026-10-04：撤销/重做**成功之后也给提示**。
    //      原来只在失败时说话，成功时界面一片安静 —— 主人按过撤销自己也不确定，
    //      AI 那边更查不到，于是把"点了 3 次撤销"误判成了"面板覆盖文件"。
    var CCV_CLIENT_VERSION = 8;
    var CCV_DRAFT_KEY = "ccv-draft-cache";    // { [canvasId]: { content, at, base } }
    var ccvCtx = null;                        // 模块级 ctx：tab 正文是独立组件，拿不到 apply 的闭包
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
      // ── 建「选区编辑区」（规格：canvas-docs/话布选区编辑区方案.md）──────────
      // 点「问AI」时，除了照旧插一条引用，还把这一笔选区交给 host：
      // 开一个临时画布（编辑区），AI 改它、**从不碰主文档**；这一轮结束时自动拼回去。
      //
      // 🔴 **两个入口必须共用这一份**（面板的划词栏 / 查看器的划词按钮）——
      //    2026-10-11 主人报"我每次都是打开的老话布"：那时只有查看器接了建区 ✗，
      //    从面板点「问AI」压根不建区 → 注入没有、拼接也不会发生 ✗。
      //    两条入口做的是同一件事，写两遍必然走偏（今晚 CSS 那次就是教训）。
      //    所以这份是**唯一实现**，并挂在 __ccvKit 上给查看器用（见 lib/viewer-md.js）。
      function ccvCreateScratch(rec) {
        try {
          if (!rec || !rec.code) return;
          var path = "";
          try {
            // rec.doc.mention 是主模块按官方引号规则算好的 @"绝对路径"
            path = String((rec.doc && rec.doc.mention) || "").replace(/^@"?/, "").replace(/"$/, "");
          } catch (_) {}
          fetch("/api/canvas/scratch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pinCode: rec.code,
              docId: (rec.doc && rec.doc.id) || "",
              docPath: path,
              quote: rec.selected || "",
              ordinal: rec.ordinal || 0,
              dupCount: rec.dupCount || 0,
            }),
          }).then(function (r) { return r.json(); })
            .then(function (d) { ccvLog("编辑区：" + JSON.stringify(d)); })
            .catch(function (e) { ccvLog("编辑区建立失败：" + (e && e.message)); });
        } catch (e) { ccvLog("编辑区建立异常：" + (e && e.message)); }
      }

    var NARROW_MAX = 768;

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
                for (var scI = 0; scI < tblW; scI++) {
                  // 对齐（2026-10-15 加）：从**第一行**对应单元格的 inline text-align 读 ✓
                  //   （单元格里的块级元素也可能带 text-align —— execCommand('justifyCenter')
                  //     就是写在那上面的 ✗ 所以两处都看 ✓）
                  //   左 / 默认 → 写裸 --- ✓（左是 markdown 的默认 ✓ 文件更干净 ✓）
                  var al = "";
                  try {
                    var c0 = tblTrs[0].querySelectorAll("th,td")[scI];
                    var stA = (c0 && c0.getAttribute("style")) || "";
                    var amA = stA.match(/text-align:\s*(left|center|right)/);
                    if (!amA && c0 && c0.firstElementChild) {
                      var stB = c0.firstElementChild.getAttribute("style") || "";
                      var amB = stB.match(/text-align:\s*(left|center|right)/);
                      if (amB) amA = amB;
                    }
                    if (amA) al = amA[1];
                  } catch (_) {}
                  sepArr.push(al === "center" ? ":---:" : (al === "right" ? "---:" : "---"));
                }
                tblOut.push("| " + sepArr.join(" | ") + " |");
              }
            }
            var tblMd = "\n" + tblOut.join("\n") + "\n";
            // ── 列宽（2026-10-15 加）──────────────────────────────────
            // 拖动列边界之后 DOM 里会有 <colgroup><col style="width:40%"> ✓
            // 把它序列化成紧随表格的一行注释：<!-- ccv-table: 40,60 -->
            // mdToHtml 读它并把 <colgroup> 放回去 ✓（往返保真 ✓）
            // 全是 auto（没有 colgroup / 宽度都是 auto）就不写注释 ✓ 保持文件干净 ✓
            try {
              var colEls = n.querySelectorAll ? n.querySelectorAll("colgroup col") : [];
              var colWs = [];
              for (var ci2 = 0; ci2 < colEls.length; ci2++) {
                var st2 = colEls[ci2].getAttribute("style") || "";
                var mw = st2.match(/width:\s*([\d.]+)%/);
                colWs.push(mw ? Math.round(parseFloat(mw[1])) : 0);
              }
              var hasW = false;
              for (var wi = 0; wi < colWs.length; wi++) { if (colWs[wi] > 0) { hasW = true; break; } }
              if (hasW) tblMd += "<!-- ccv-table: " + colWs.join(",") + " -->\n";
            } catch (_) {}
            // ── 行高（2026-10-15 加）──────────────────────────────────
            // 拖过行边界之后 <tr> 上会有 style="height:32px" ✓
            // 序列化成另一行注释：<!-- ccv-table-h: 32,auto -->
            // auto = 没拖过（由内容撑开 ✓）→ 一个都没拖过就不写注释 ✓ 保持文件干净 ✓
            try {
              var trEls = n.querySelectorAll ? n.querySelectorAll("tr") : [];
              var rowHs = [];
              var hasH = false;
              for (var ri2 = 0; ri2 < trEls.length; ri2++) {
                var st3 = trEls[ri2].getAttribute("style") || "";
                var mh = st3.match(/height:\s*(\d+(?:\.\d+)?)px/);
                var hv = mh ? Math.round(parseFloat(mh[1])) : 0;
                if (hv > 0) hasH = true;
                rowHs.push(hv > 0 ? hv : "auto");
              }
              if (hasH) tblMd += "<!-- ccv-table-h: " + rowHs.join(",") + " -->\n";
            } catch (_) {}
            return tblMd;
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
              var tblHtml = buildTable(tblLines);
              // ── 列宽（2026-10-15 加）────────────────────────────────
              // 拖过列边界的表格，紧跟一行注释：<!-- ccv-table: 40,60 -->
              // 用注释而不是内嵌 HTML 表格：**表格保持 markdown 的可读形式** ✓
              // 注释在渲染时不可见 ✓ 也不会被当成正文 ✓
              // （markdown 表格语法本身没有宽高 ✗ —— 成熟 markdown 工具也是靠外挂信息 ✓）
              var wm = (lines[i] || "").trim().match(/^<!--\s*ccv-table:\s*([\d.,\s]+?)\s*-->$/);
              if (wm) {
                var ws = wm[1].split(",").map(function (x) { return parseFloat(x) || 0; });
                if (ws.length) {
                  var cg = "<colgroup>" + ws.map(function (x) {
                    return x > 0 ? '<col style="width:' + x + '%">' : "<col>";
                  }).join("") + "</colgroup>";
                  tblHtml = tblHtml.replace("<table>", "<table>" + cg);
                  i++;   // 吃掉注释行 ✓（别让它渲染出来）
                }
              }
              // ── 行高（2026-10-15 加）────────────────────────────────
              // 同一套思路，另一个标记：<!-- ccv-table-h: 32,auto -->
              // auto = 由内容撑开（成熟产品的默认行为 ✓）→ 不写 style ✓
              var hm = (lines[i] || "").trim().match(/^<!--\s*ccv-table-h:\s*([\d.,auto\s]+?)\s*-->$/);
              if (hm) {
                var hs = hm[1].split(",").map(function (x) {
                  var v = String(x).trim();
                  return (v === "auto" || v === "" || !(parseFloat(v) > 0)) ? 0 : Math.round(parseFloat(v));
                });
                if (hs.length) {
                  var trIdx = -1;
                  tblHtml = tblHtml.replace(/<tr>/g, function () {
                    trIdx++;
                    var h = hs[trIdx] || 0;
                    return h > 0 ? '<tr style="height:' + h + 'px">' : "<tr>";
                  });
                  i++;   // 吃掉注释行 ✓
                }
              }
              // ── 单元格对齐（2026-10-15 加）──────────────────────────
              // markdown 的**分隔行自带对齐语法** ✓ —— 这是标准 markdown ✓ 不用外挂注释 ✓
              //   | :--- | :---: | ---: |   →   左 / 中 / 右
              //   （只有左是默认，所以左可以不写冒号；中间/右边必须写 ✓）
              var sepLine = String(tblLines[1] || "").trim().replace(/^\|/, "").replace(/\|$/, "");
              var aligns = sepLine.split("|").map(function (cc) {
                var s2 = cc.trim();
                var lf = s2.charAt(0) === ":";
                var rt = s2.charAt(s2.length - 1) === ":";
                return (lf && rt) ? "center" : (rt ? "right" : (lf ? "left" : ""));
              });
              var anyAlign = false;
              for (var ai3 = 0; ai3 < aligns.length; ai3++) { if (aligns[ai3]) { anyAlign = true; break; } }
              if (anyAlign) {
                var cellIdx = -1;
                tblHtml = tblHtml.replace(/<(th|td)>/g, function (m0, tag) {
                  cellIdx++;
                  var a0 = aligns[cellIdx % Math.max(1, aligns.length)];
                  return a0 ? "<" + tag + ' style="text-align:' + a0 + '">' : m0;
                });
              }
              out.push(tblHtml);
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
    // （画布面板 2026-10-11 整体删除后，这里只剩下面这些共享件：
    //    markdown 转换、草稿、__ccvKit、侧模块加载。图标库 / 划词栏条目 /
    //    面板布局常量都随面板一起删了 —— 那些是面板专属的 ✗）





    // 面板专属的会话服务声明（slots 之外的那些）
    //
    // 🔴 每一项都要写清**谁在用** —— 2026-10-14 我"清理未用声明"时删掉了 conversation ✗，
    //    而它是 **lib/selref.js 要的**：那个文件里 missingServices() 要
    //    sessions / conversation / inputTriggers **三个齐了**才注册引用源 ✗
    //    结果：引用源没注册 → 聊天里报
    //      「slash: no serializer for reference source "话布选区"」✗
    //    依赖在**另一个文件**里，从这个文件看不出来 ✗ —— 所以逐条注明 ✓
    //    verify-all 里也加了守卫（那三项缺一不可 ✓）
    //
    //   slots            → 主模块：把查看器正文/工具栏注册进右侧栏（__ccvViewerBoot）
    //   sessions         → lib/selref.js：由会话 id 取作用域、拿输入框句柄
    //   conversation     → lib/selref.js：同上（missingServices 三个之一 ✗ 别删）
    //   inputTriggers    → lib/selref.js：注册「话布选区」引用源
    //   sidebarRightTabs → 主模块：声明右侧栏「话布」标签类型（两阶段注册之一）
    //   sidebarRight     → **2026-10-22 起有调用点了** ✓
    //                      用它打开文档：ctx.sidebarRight.openResource(地址) ✓
    //                      契约来自官方 dsh-client-ui-sidebar-right 的 service.d.ts：
    //                        openResource(address: string, options?): void
    //                          address 必须是 `dsh-resource://<type>/…` ✓
    //                          不接受的话**会抛**（官方注释：那是接线错误，不是用户错误 ✓）
    //                      这就是主人要的"点一下跳到文档"✓
    // ⚠️ **必须写进这里，不能运行时 ctx.get 现取** —— 未声明的服务取不到。
    //    2026-09-14 实测：不加 sessions / inputTriggers 时 selref 自检报「暂缺」
    const inject = ["slots", "sessions", "conversation", "inputTriggers", "sidebarRightTabs", "sidebarRight"];

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

  // ══════════════════════════════════════════════════════════════════════
  //  右侧栏「话布」标签页：整块（2026-10-27 重构 P4，第二次尝试）
  //
  //  第一次尝试（8c019f0）失败了 ✗ 原因记在这里，别重犯：
  //    我把 405 行搬走时，**只核对了"引用了什么"，没核对"定义了什么"** ✗
  //    这段里其实**定义了** ccvSessionsSnapshot / ccvSessionTitleOf /
  //    ccvHashKeyMap / ccvBuildGroups / ccvFetchGroups / 缓存 … ✗
  //    搬走之后 apply 里引用它们的地方全变成 undefined ✓
  //    → "右侧「话布」标签页整个消失" ✓ 而当时的检查一条都没拦住 ✗
  //
  //  这次的做法：
  //    · 先用客户端冒烟测试证明"现状是绿的"（tools/test-client-smoke.cjs）✓
  //    · 精确算过：区段内**顶层定义 9 个**、apply 区段外**只用到 CcvFeatureTab** ✓
  //    · 区段内用到、区段外定义的只有 7 个 → 由 D 传入 ✓
  //    · 代码逐字搬运，一行未改 ✓
  function ccvMakeCanvasTab(D) {
    // 这 7 个是区段外定义的（在 apply 里），其余依赖都在模块级 ✓ 直接可见
    var CCV_ROW_BASE = D.CCV_ROW_BASE, CCV_TAB_ID = D.CCV_TAB_ID
    var CcvEntry = D.CcvEntry, CcvErrorBoundary = D.CcvErrorBoundary
    var CcvRow = D.CcvRow, CcvTabGlyph = D.CcvTabGlyph
    var ccvGuideColumn = D.ccvGuideColumn
    var ctx = D.ctx   // ← apply 的参数，第一次搬漏了它：ctx.slots 直接抛错被 catch 吞掉 ✗

      // ─── 右侧栏「话布」标签页（2026-10-24 改成两级）───────────────────
      //   主人原话：「这一页是话布功能选页，清单应该放到话布文档二级菜单里」
      //   → 一级页 = **功能入口**（话布文档 / 规划中的功能）
      //     二级页 = **话布文档**（文档清单 ✓ 点一下跳到那篇 ✓ + 返回）
      //   ⚠️ 用组件内一个 view 状态切页 ✓ 不需要路由 ✓ 简单可靠 ✓
      //   ⚠️ **必须接 props** ✗ —— sessionId 就在这里 ✓（官方 FilesBody 同款 ✓）
      //      我原来写成 CcvFeatureTab() 不带参数 → 永远拿不到 sessionId ✓
      //
      // ★ 2026-10-24 第二轮：清单**按会话分组** ★
      //   主人原话：「清单页做分组，按会话名来分组，把当前会话的组置顶并展开，
      //              别的会话默认收起」
      //   数据：/api/canvas/list?scope=groups ✓（本轮新增的分支 ✓）
      //         groups: [{ sid, activeId, ids }]  canvases: 全量元数据
      //   会话名：ctx.sessions.list.getSnapshot().byId[sid].displayTitle ✓
      //     —— 官方里就是这么命令式读的（client.js 里到处是
      //        `ctx.sessions.list.getSnapshot().byId[...]`）✓
      //     ⚠️ 不用 useSessions 那个 hook ✓ 免得在"可能不存在"的 prop 上
      //        做条件式 hook 调用（那会违反 hook 规则 ✓ 上次就是这么白的 ✓）
      //   默认展开：**只有当前会话**（s.open 里没有这个 sid 时，看它是不是当前会话 ✓）
      //     → 这样不需要在数据到达时初始化状态 ✓ 少一处时序 bug ✓
      // 把接口数据按会话分好组 ✓（当前会话置顶 ✓ 其余按最新更新倒序 ✓）
      //
      // ★ 2026-10-24：旧哈希键「反着撞一遍」★
      //   老键 = "sess-" + hash(侧栏里那行会话名) ✓ 哈希虽单向，
      //   但**名字我这儿有**（ctx.sessions.list 里就有 displayTitle）✓
      //   → 对每个已知会话算一遍 hash(displayTitle)，撞上哪个旧键，那组就是它 ✓
      //   算法与输入已被日志实证（hash("DeepSeek Harness") = qberq7 ✓
      //   hash("默认会话") = 1nbvho8 ✓ 都对上了）✓
      //   撞不上的（default、老命名 xxx-hash）→ 显示「旧记录」✓ 由拖动解决 ✓
      function ccvSessionsSnapshot() {
        try {
          var snap = ctx.sessions && ctx.sessions.list && ctx.sessions.list.getSnapshot
            ? ctx.sessions.list.getSnapshot() : null
          return (snap && snap.byId) || null
        } catch (_) { return null }
      }
      function ccvSessionTitleOf(byId, sid) {
        try {
          var row = byId ? byId[sid] : null
          if (row) return row.displayTitle || row.title || ''
        } catch (_) {}
        return ''
      }
      // 旧哈希键 → 真 sessionId（用已知会话名反算）
      //   ⚠️ 2026-10-26：算法已搬进 lib/ccv-logic.js ✓ 这里只做委托
      function ccvHashKeyMap(byId) {
        var L = ccvLogic()
        return L ? L.hashKeyMap(byId) : {}
      }
      // 分组拼装（当前会话置顶 / 旧键反查合并 / 未归属垫底）
      //   ⚠️ 同样是委托 ✓ 同一套规则有 60 条 Node 断言守着 ✓
      function ccvBuildGroups(data, curSid, byId) {
        var L = ccvLogic()
        if (!L) return { groups: [], total: (data && data.canvases || []).length }
        return L.buildGroups(data, curSid, byId, function (sid) { return ccvSessionTitleOf(byId, sid) })
      }

      // ★ 清单数据缓存 + 预取（2026-10-24 修「别的会话里要十多秒」）★
      //   实测证据：
      //     当前会话 清单加载耗时   11ms ✓
      //     刚换会话 清单加载耗时 9288ms ✗（同样的 14 组 / 20 篇 ✓ 接口一样快 ✓）
      //   机制：**换会话那一刻请求被排在队尾** ✓（宿主/浏览器主线程正忙 ✓）
      //         —— 不是我们的接口慢 ✓ 也不是渲染慢 ✓
      //   但有一个事实可以利用：`?scope=groups` 的返回**与会话无关** ✓
      //     （主机端这个分支压根不看 sid ✓ 全部会话 + 全部文档 ✓）
      //   → 于是：① 进标签页就【预取】✓ 不等点开二级页
      //           ② 20 秒内再用【直接用缓存】✓ 不再发请求
      //           ③ 缓存过期也先显示旧数据 ✓ 后台静默刷新 ✓（不让人对着"读取中"✓）
      var CCV_GROUPS_TTL = 20000
      var ccvGroupsCache = { at: 0, data: null, err: '' }
      function ccvFetchGroups(force) {
        var now = Date.now()
        if (!force && ccvGroupsCache.data && (now - ccvGroupsCache.at) < CCV_GROUPS_TTL) {
          return Promise.resolve({ data: ccvGroupsCache.data, err: '', ms: 0, cached: true })
        }
        var t0 = Date.now()
        return fetch('/api/canvas/list?scope=groups', { cache: 'no-store' })
          .then(function (r) { return r.json() })
          .then(function (d) {
            var data = { canvases: (d && d.canvases) || [], groups: (d && d.groups) || [] }
            var err = (d && d.ok === false) ? (d.error || '读不到') : ''
            ccvGroupsCache = { at: Date.now(), data: data, err: err }
            return { data: data, err: err, ms: Date.now() - t0, cached: false }
          })
          .catch(function (e) {
            return { data: null, err: (e && e.message) || '读不到', ms: Date.now() - t0, cached: false }
          })
      }
      function CcvFeatureTab(props) {
        var sessionId = (props && props.sessionId) || ''
        // 初始就吃缓存 ✓（第二次进标签页 = 立刻有内容 ✓ 不用等 ✓）
        var st = React.useState({
          view: 'home', loading: !ccvGroupsCache.data, err: ccvGroupsCache.err,
          data: ccvGroupsCache.data, open: {}, rev: 0,
        })
        var s = st[0], setS = st[1]
        // ★ 把真 sessionId 挂到全局 ✓（2026-10-24）
        //   为什么需要：sessionKey() 现在优先读它 ✓
        //     写入这一侧（打开/新建文档记到哪个会话）才是真会话 ✓
        //     —— 不挂的话，标签页里根本没打开过文档时，仍会退回哈希键 ✗
        React.useEffect(function () {
          try { if (sessionId) window.__ccvSessionId = sessionId } catch (_) {}
        }, [sessionId])
        // ★ 预取（进标签页就拉 ✓ 不等点进二级页 ✓）★
        //   换会话那 10 秒里请求会排在队尾 ✗ 所以在【安静的时候】先把它拿下来 ✓
        React.useEffect(function () {
          var alive = true
          ccvFetchGroups(false).then(function (r) {
            if (!alive || r.cached) return
            ccvLog('清单预取 ' + r.ms + 'ms' + (r.err ? (' ✗ ' + r.err) : ' ✓'))
            setS(function (p) {
              if (!r.data) return p
              return Object.assign({}, p, { data: r.data, loading: false, err: r.err })
            })
          })
          return function () { alive = false }
        }, [sessionId])
        // 切到二级页 + 拖动后刷新 ✓（有缓存就直接显示 ✓ 过期才真去拉 ✓）
        React.useEffect(function () {
          if (s.view !== 'docs') return
          if (s.data && !s.rev) return            // 有缓存且不是拖动后 → 不用再拉 ✓
          var alive = true
          var force = !!s.rev                      // 拖动后必须真拉 ✓
          ccvFetchGroups(force).then(function (r) {
            if (!alive) return
            ccvLog('清单加载耗时 ' + r.ms + 'ms' + (r.cached ? '（缓存）' : '')
              + ' ｜ 组 ' + ((r.data && r.data.groups) || []).length
              + ' 个 ｜ 文档 ' + ((r.data && r.data.canvases) || []).length + ' 篇'
              + (r.err ? (' ✗ ' + r.err) : ''))
            setS(function (p) {
              if (!r.data) return Object.assign({}, p, { loading: false, err: r.err })
              return Object.assign({}, p, { data: r.data, loading: false, err: r.err })
            })
          })
          return function () { alive = false }
        }, [s.view, s.rev])
        // ★ 拖动改分组（2026-10-24 主人要求「我要能自由拖动改分组」）★
        //   只调一个主机端点 ✓ 主机端只改 .sessions/*.json 的 id 数组 ✓
        //   **文件、路径、内容一律不碰** ✓（主人已确认这条 ✓）
        var moveTo = function (docId, toSid) {
          if (!docId) return
          ccvLog('拖动分组：' + docId + ' → ' + (toSid || '（移出所有组）'))
          fetch('/api/canvas/move-group', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: docId, toSid: toSid || '' }),
            cache: 'no-store',
          })
            .then(function (r) { return r.json() })
            .then(function (d) {
              if (d && d.ok === false) ccvLog('拖动失败 ✗ ' + (d.error || ''))
              else ccvLog('拖动完成 ✓ 从 ' + ((d && d.removed) || 0) + ' 个组移出')
              setS(function (p) { return Object.assign({}, p, { rev: (p.rev || 0) + 1 }) })
            })
            .catch(function (e) {
              ccvLog('拖动请求失败 ✗ ' + (e && e.message))
              setS(function (p) { return Object.assign({}, p, { rev: (p.rev || 0) + 1 }) })
            })
        }
        var card = { border: '1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3))', borderRadius: '8px', padding: '10px 12px', marginBottom: '8px' }
        var dim = { color: 'var(--dsw-alias-label-secondary,#6b7280)', fontSize: '12px', lineHeight: 1.6 }
        var go = function (view) {
          setS(function (p) { return Object.assign({}, p, { view: view }) })
        }
        // ── 二级页：话布文档（清单）──
        //   ★ 骨架照官方文件树（FilesBody）★（2026-10-24 主人要求"按这个文件列表的显示风格"）
        //     root   height:100%; min-height:0; display:flex; flex-direction:column;
        //            font-size: var(--dsh-content-font-size-secondary, 13px); line-height:1.5
        //     header height:38px; border-bottom:.5px solid border-l3;
        //            align-items:center; gap:4px; padding:0 6px 0 16px; flex:none
        //     body   flex:auto; min-height:0; overflow:auto;
        //            padding:8px 0 8px 8px; margin-right:2px;
        //            scrollbar-gutter:stable   ← 滚动条出现时不跳
        //   ⚠️ 不是居中卡片列 ✗ —— 文件树是**贴左、通栏**的 ✓
        if (s.view === 'docs') {
          // 按会话分组 ✓（当前会话置顶 ✓ 其余默认收起 ✓）
          // ★ 构建计时（只记慢的 ✓ 不刷屏）★
          var tb0 = Date.now()
          var model = ccvBuildGroups(s.data, sessionId, ccvSessionsSnapshot())
          var buildMs = Date.now() - tb0
          if (buildMs >= 30) ccvLog('清单构建耗时 ' + buildMs + 'ms ｜ 组 ' + model.groups.length + ' 个')
          var isOpen = function (sid) {
            if (Object.prototype.hasOwnProperty.call(s.open || {}, sid)) return !!s.open[sid]
            return sid === sessionId          // 默认只展开当前会话 ✓
          }
          var toggleGroup = function (sid) {
            setS(function (p) {
              var nx = Object.assign({}, p.open || {})
              nx[sid] = !isOpen(sid)
              return Object.assign({}, p, { open: nx })
            })
          }
          var rows = model.groups.map(function (g) {
            var open = isOpen(g.sid)
            var isCur = (g.sid === sessionId)
            var isOrphan = (g.sid === '__orphan__')
            // 名字：真会话名 ✓；旧键反查成功的也用真名 ✓；
            //      认不出的 → 「旧记录 · <键>」✓ 不再截断成 _Harness 那种碎片 ✗
            var title = g.title
              || (isOrphan ? '未归属' : ('旧记录 · ' + g.sid))
            // 组头：chevron + 会话名 + 篇数（当前会话那组给个标记 ✓ 一眼能认出来 ✓）
            var head = h('div', {
              key: 'h:' + g.sid,
              onClick: function () { toggleGroup(g.sid) },
              title: isOrphan ? '不属于任何会话的文档' : (g.legacy ? ('旧键：' + g.sid + '（把文档拖到别的组即可）') : ('会话：' + (g.title || g.sid))),
              role: 'button',
              // ★ 拖到这里 = 归到这一组 ✓（未归属 = 移出所有组 ✓）
              onDragOver: function (e) {
                try {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  e.currentTarget.style.background = 'var(--dsw-alias-brand-primary,rgba(59,130,246,.18))'
                  e.currentTarget.style.outline = '.5px dashed var(--dsw-alias-brand-primary,#3b82f6)'
                } catch (_) {}
              },
              onDragLeave: function (e) {
                try {
                  e.currentTarget.style.background = '0 0'
                  e.currentTarget.style.outline = 'none'
                } catch (_) {}
              },
              onDrop: function (e) {
                try {
                  e.preventDefault()
                  e.currentTarget.style.background = '0 0'
                  e.currentTarget.style.outline = 'none'
                  var id = e.dataTransfer.getData('text/plain')
                  if (!id) return
                  // ⚠️ 落盘目标优先用【真会话 id】✓（2026-10-24）
                  //   旧哈希组若已反查出真会话（g.matched），就写到真会话名下 ✓
                  //   —— 否则拖进去的文档还挂在老哈希键里 ✗ 名字永远救不回来 ✗
                  var dest
                  if (isOrphan) dest = ''                                    // 移出所有组 ✓
                  else if (g.matched || (g.sid && String(g.sid).indexOf('session-') === 0)) dest = g.sid
                  else dest = (g.key || g.sid)                               // 认不出的旧组：按原键写 ✓
                  moveTo(id, dest)
                } catch (_) {}
              },
              style: Object.assign({}, CCV_ROW_BASE, { cursor: 'pointer' }),
              onMouseEnter: function (e) {
                try { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12)))' } catch (_) {}
              },
              onMouseLeave: function (e) {
                try { e.currentTarget.style.background = '0 0' } catch (_) {}
              },
            },
              // chevron（收起 ▸ / 展开 ▾）—— 用文字三角，跟随主题色 ✓
              h('span', {
                style: {
                  flex: 'none', width: '12px', textAlign: 'center',
                  fontSize: '10px', lineHeight: 1,
                  color: 'var(--dsw-alias-label-tertiary,#6b7280)',
                },
              }, open ? '▾' : '▸'),
              h('span', {
                style: {
                  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontWeight: isCur ? 600 : 400,
                  color: g.legacy ? 'var(--dsw-alias-label-secondary,#8b8b8b)' : undefined,
                },
              }, title),
              h('span', {
                style: {
                  marginLeft: 'auto', flex: 'none', paddingLeft: '8px',
                  fontSize: '12px', color: 'var(--dsw-alias-label-tertiary,#6b7280)',
                },
              }, String(g.items.length)))
            if (!open) return head
            // 展开：组内文档（官方嵌套缩进 18px ✓）
            return h('div', { key: g.sid },
              head,
              h('div', { style: { paddingLeft: '18px' } },
                g.items.map(function (c) {
                  return h(CcvRow, { key: c.id, canvas: c, sessionId: sessionId })   // ← 组件调用 ✓
                })))
          })
          return h('div', {
            style: {
              boxSizing: 'border-box', height: '100%', minHeight: 0,
              display: 'flex', flexDirection: 'column',
              color: 'var(--dsw-alias-label-primary,#1a1a1a)',
              fontSize: 'var(--dsh-content-font-size-secondary,13px)',
              lineHeight: 1.5,
            },
          },
            // ── 表头（官方 .header ✓ 38px + 半像素下边线）──
            h('div', {
              style: {
                boxSizing: 'border-box', flex: 'none',
                display: 'flex', alignItems: 'center', gap: '4px',
                height: '38px', padding: '0 6px 0 16px',
                borderBottom: '.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.28))',
              },
            },
              h('button', {
                type: 'button',
                onClick: function () { go('home') },
                title: '返回功能页',
                // 官方 .tool：28×28 / 圆角 sm / 悬停才有底色 ✓
                style: {
                  width: '28px', height: '28px', flex: 'none',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  padding: '6px', lineHeight: 1,
                  background: '0 0', border: 'none', cursor: 'pointer',
                  borderRadius: 'var(--dsw-radius-sm,4px)',
                  color: 'var(--dsw-alias-label-secondary,#8b8b8b)',
                  fontSize: '15px',
                },
                onMouseEnter: function (e) {
                  try {
                    e.currentTarget.style.color = 'var(--dsw-alias-label-primary,#1a1a1a)'
                    e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))'
                  } catch (_) {}
                },
                onMouseLeave: function (e) {
                  try {
                    e.currentTarget.style.color = 'var(--dsw-alias-label-secondary,#8b8b8b)'
                    e.currentTarget.style.background = '0 0'
                  } catch (_) {}
                },
              }, '‹'),
              h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '话布文档'),
              h('span', {
                style: {
                  marginLeft: 'auto', paddingRight: '4px', flex: 'none',
                  fontSize: '12px', color: 'var(--dsw-alias-label-tertiary,#6b7280)',
                },
              }, (s.loading ? '读取中…' : (model.total + ' 篇')))),
            // ── 正文（官方 .body ✓ 内缩 8px，行自己带 5px 10px 内距）──
            h('div', {
              style: {
                flex: 'auto', minHeight: 0, overflow: 'auto',
                marginRight: '2px', padding: '8px 0 8px 8px',
                scrollbarGutter: 'stable',
              },
            },
              !sessionId ? h('div', {
                style: { padding: '3px 10px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary,#d33)' },
              }, '⚠ 这个标签页没拿到 sessionId，点了会打不开（已记日志）') : null,
              s.err ? h('div', {
                style: { padding: '3px 10px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary,#d33)' },
              }, '读清单失败：' + s.err) : null,
              // 官方 .note：没有内容时的说明行 ✓
              !s.loading && !model.total ? h('div', {
                style: { padding: '3px 10px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary,#6b7280)' },
              }, '还没有话布文档') : null,
              rows))
        }
        // ── 一级页：功能选页（照官方「开始」页的居中卡片布局）──
        var entries = [
          {
            icon: '📄',
            title: '话布文档',
            desc: 'markdown：可编辑 · 自动保存 · 撤销重做 · 划词问 AI',
            onClick: function () { go('docs') },
          },
          { icon: '🌐', title: '网页实时可视编辑', desc: '还没做', disabled: true },
        ]
        return ccvGuideColumn([
          // 英雄图标（官方 .hero 是那个罗盘 ✓ 这里用话布自己的图标 ✓）
          h('div', {
            style: {
              display: 'flex', marginBottom: '16px',
              color: 'var(--dsw-alias-label-secondary,#8b8b8b)',
            },
          }, h(CcvTabGlyph, { size: 26 })),
          // ⚠️ 2026-10-24 主人：「选一个功能这几个字不要」→ 那行说明删掉 ✗
          //   官方「开始」页本来也没有这行字 ✓ 删了反而更像 ✓
        ].concat(entries.map(function (e, i) {
          return h(CcvEntry, { key: 'e' + i, entry: e })
        })))
      }

      // ★ 注册用的包装组件：一律套错误边界 ✓（崩了也看得见原因 ✓）
      function CcvCanvasTab(props) {
        var body = h(CcvFeatureTab, props)
        return CcvErrorBoundary ? h(CcvErrorBoundary, null, body) : body
      }

      try {
        ctx.effect(function () {
          return ctx.sidebarRightTabs.register({
            id: CCV_TAB_ID,
            kind: CCV_TAB_ID,
            priority: 'extension',
            title: function () { return '话布' },
            // 门厅页（右侧栏「开始」）的入口胶囊 —— 官方「工作区文件」是 order 10
            guide: [{
              order: 20,
              title: function () { return '话布' },
              description: function () { return '话布：文档与将来的可视编辑功能，都从这里进'; },
              icon: CcvTabGlyph,
            }],
          })
        }, 'collab-canvas: 右侧栏 tab 类型')
        ccvLog('右侧栏「话布」标签类型已注册（id=' + CCV_TAB_ID + '）')
      } catch (e) { ccvLog('右侧栏 tab 类型注册失败: ' + (e && e.message)) }

      try {
        ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: CCV_TAB_ID }, CcvCanvasTab)
        })
        ccvLog('右侧栏「话布」标签正文已注册')
      } catch (e) { ccvLog('右侧栏 tab 正文注册失败: ' + (e && e.message)) }


    // 区段内定义了 9 个顶层名字 ✓ apply 区段外只用到这一个 ✓
    return { CcvFeatureTab: CcvFeatureTab }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  画布小工具集：地址拼装 / 打开文档 / 文件树行 / 入口卡片 / 错误边界
  //  （2026-10-27 重构 P4b，逐字搬运）
  //
  //  机器核对过（不是目测）：
  //    区段顶层定义 17 个；apply 区段外只用到其中 6 个 → 由返回值交回 ✓
  //    区段内只依赖 ctx（+ 模块级的 h / React / ccvLog / ccvLogic）✓
  //
  //  为什么放这里而不是拆成四个文件：
  //    侧模块不能 require ✗ 拆文件就得靠 window 交接 ✓ 反而更绕 ✓
  //    一个"无状态工具集"工厂已经足够清楚 ✓
  function ccvMakeCanvasKit(D) {
    var ctx = D.ctx

      // ─── 文件路径 → dsh-resource 地址（2026-10-24 重写，照官方算法）───────
      //   ⚠️ 上一版的做法是"等查看器打开过文档后把地址模板登记到 window"✗
      //     → **先有鸡还是先有蛋** ✗ 没打开过文档就永远点不动 ✓
      //       （日志实测：反复报"还没拿到 dsh-resource 地址模板"✓）
      //
      //   ★ 正路：地址可以**自己拼** ✓ 官方源码里就有现成的算法 ★
      //     出处：@deepseek-ai/dsh-client-ui-sidebar-files/lib/client.js
      //       FILE_ADDRESS_PREFIX = "dsh-resource://file/"
      //       encodeSegment(s) = encodeURIComponent(s).replace(/%3A/gi, ":")   ← 盘符冒号保留
      //       encodePath(p)    = p.split("/").map(encodeSegment).join("/")
      //       sessionFileAddress(sid, p) =
      //         PREFIX + "session/" + encodeSegment(sid) + "/" + encodePath(p)
      //       fileAddressFor(sid, cwd, path)：
      //         绝对路径且**在 workspace 根之内** → 转成【相对根】的路径 ✓
      //         否则（根未知 / 在根之外）→ **保留绝对路径** ✓
      //
      //   ★ sessionId 从哪来：不用猜 ✓
      //     官方 FilesBody 的 props 就是 { useTabInfo, sessionId, useStore, actions, … }
      //     —— 也就是说 `sidebar.right.pane.tab` 这个槽**本来就把 sessionId 传给组件** ✓
      //     我原来的 CcvFeatureTab 没接 props ✗ 所以拿不到 ✓（这是第二处疏漏 ✓）
      //
      //   ⚠️ 反斜杠一律用 split/join ✓ 不用正则字面量 ✗（2026-10-22 就是这么崩的 ✓）
      //   ⚠️ 2026-10-26：编码/拼装本体已搬进 lib/ccv-logic.js ✓ 这里只做委托
      //      好处：同一套算法有 60 条 Node 断言守着 ✓ 不再靠"看着像对的" ✓
      var CCV_FILE_PREFIX = 'dsh-resource://file/'
      function ccvSessionFileAddress(sessionId, absPath) {
        var L = ccvLogic()
        if (L) return L.sessionFileAddress(sessionId, absPath)
        // 逻辑层没到（极早期）→ 明确报错并返回空 ✓ 不静默拼错 ✗
        ccvLog('拼地址失败：逻辑层未加载 ✗')
        return ''
      }
      // 打开一篇话布文档 ✓（主人要的"点一下跳过去"✓）
      //   ⚠️ 失败必须**说出来** ✗ 不能静默 ✓（这一轮就是静默才查了半天 ✓）
      function ccvOpenDoc(absPath, title, sessionId) {
        var t0 = Date.now()
        var p = String(absPath || '').trim()
        if (!p) { ccvLog('打开失败：这篇没有磁盘路径（还没落盘）✗'); return }
        var addr = ''
        try {
          addr = ccvSessionFileAddress(sessionId, p)
        } catch (e) { ccvLog('拼地址出错: ' + (e && e.message)) }
        if (!addr) {
          ccvLog('打开失败：拿不到 sessionId ✗（这个标签页的 props.sessionId 是空的 ✓）')
          return
        }
        // ★ 先把真实地址打出来 ✓ 出问题一眼能对照官方的编码形式 ★
        ccvLog('准备打开：' + (title || '') + ' ｜ session=' + String(sessionId).slice(0, 14)
          + '… ｜ 地址=' + addr)
        try {
          ctx.sidebarRight.openResource(addr)
          ccvLog('已请求打开文档 ✓ ' + (title || '') + ' ｜ 调用耗时 ' + (Date.now() - t0) + 'ms')
        } catch (e) {
          // 官方注释：地址不合法 / 没人认领 → 抛异常（那是接线错误）
          ccvLog('打开文档失败 ✗ ' + ((e && e.message) || e) + ' ｜ 地址=' + addr)
          try {
            if (window.__ccvKit && window.__ccvKit.toast) {
              window.__ccvKit.toast('打开失败：' + ((e && e.message) || '地址没被认领'), 'ccv-open-doc')
            }
          } catch (_) {}
        }
      }
      function CcvTabGlyph(props) {
        var size = (props && props.size) ? props.size : 16
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.6,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        },
          h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }),
          h('path', { d: 'M7.5 9.5h9M7.5 13h6' }))
      }
      // ★ 清单每一行 = **独立子组件** ✓（2026-10-23 修空白）★
      //   ⚠️ 原来把 React.useState 写在了 .map() 回调里 ✗✗
      //     React 铁律：**Hooks 只能在组件顶层调用** ✗ 不能在循环/回调/条件里 ✓
      //     → 清单条数一变，hook 数量就变 ✗
      //     → 报「Rendered more hooks than during the previous render」✗
      //     → **这个标签页整个崩掉 → 只剩空白** ✓✓
      //   做法：抽成子组件 → 每个子组件自己管自己的 hover ✓
      //     它也是官方 dsh-client-ui-sidebar-files 的做法 ✓（树节点都是独立组件 ✓）
      // ★ 文件图标（16px，照官方文件树用 FileTypeIcon 的尺寸/颜色）★
      //   官方行里是 primitives 的 FileTypeIcon(size 16) + className fileIcon ✓
      //   我们的侧模块拿不到 primitives ✗ 所以画一个同风格的"文档纸"图标 ✓
      function CcvFileGlyph(props) {
        var size = (props && props.size) || 16
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.6,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        },
          h('path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }),
          h('path', { d: 'M14 3v5h5' }))
      }
      // ★ 清单每一行 = 官方文件树的行样式（2026-10-24 主人要求）★
      //   出处：sidebar-files/lib/client.js 的 FilesBody.module.css ✓ 逐条照抄：
      //     .row  width:100%; min-width:0; color:inherit; font:inherit; text-align:left;
      //           border-radius:var(--dsw-radius-md); cursor:pointer;
      //           background:0 0; border:0; align-items:center; gap:6px;
      //           padding:5px 10px; display:flex
      //     .row:hover  background:var(--dsw-alias-interactive-bg-hover)
      //     .icon  color:var(--dsw-alias-label-tertiary); flex:none   ← 16px svg
      //     .name  white-space:nowrap; text-overflow:ellipsis; min-width:0; overflow:hidden
      //   ⚠️ **不是卡片** ✗ —— 没有边框、没有圆角边框、没有第二行路径 ✓
      //      路径挪到 title（悬停才看）✓ 与文件树一致 ✓
      var CCV_ROW_BASE = {
        width: '100%', minWidth: 0,
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: '5px 10px', textAlign: 'left',
        font: 'inherit',
        color: 'inherit',
        background: '0 0', border: 0,
        borderRadius: 'var(--dsw-radius-md,6px)',
        boxSizing: 'border-box',
      }
      function CcvRow(props) {
        var c = props.canvas || {}
        var sessionId = props.sessionId || ''
        // ⚠️ 清单里那个字段叫 **filePath** ✓ 不是 path ✗
        //   （host 的 canvas.list 原来只回 hasFile ✗ → 前端根本拿不到路径 ✓
        //     2026-10-22 一并补上了 filePath ✓ 见 src/host/06-rpc.js ✓）
        var fp = c.filePath || c.path || ''
        var canOpen = !!String(fp).trim()
        var hover = React.useState(false)      // ← 组件顶层 ✓ 合法 ✓
        var hv = hover[0], setHv = hover[1]
        return h('div', {
          onClick: canOpen ? function () { ccvOpenDoc(fp, c.title, sessionId) } : undefined,
          onMouseEnter: canOpen ? function () { setHv(true) } : undefined,
          onMouseLeave: canOpen ? function () { setHv(false) } : undefined,
          title: canOpen ? ('打开：' + fp + '\n（可以拖到别的分组里）') : '（还没落盘，打不开）',
          role: 'button',
          // ★ 可拖动（2026-10-24 主人要「自由拖动改分组」）★
          //   只带 id ✓ 主机端按 id 改 .sessions/*.json 的 id 数组 ✓ 文件不动 ✓
          draggable: canOpen ? 'true' : 'false',
          onDragStart: canOpen ? function (e) {
            try {
              e.dataTransfer.setData('text/plain', c.id)
              e.dataTransfer.effectAllowed = 'move'
              e.currentTarget.style.opacity = '0.5'
            } catch (_) {}
          } : undefined,
          onDragEnd: canOpen ? function (e) {
            try { e.currentTarget.style.opacity = '1' } catch (_) {}
          } : undefined,
          style: Object.assign({}, CCV_ROW_BASE, {
            cursor: canOpen ? 'pointer' : 'default',
            opacity: canOpen ? 1 : 0.55,
            background: (canOpen && hv) ? 'var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12)))' : '0 0',
          }),
        },
          h('span', { style: { display: 'flex', flex: 'none', color: 'var(--dsw-alias-label-tertiary,#6b7280)' } },
            h(CcvFileGlyph, { size: 16 })),
          h('span', {
            style: {
              whiteSpace: 'nowrap', textOverflow: 'ellipsis',
              minWidth: 0, overflow: 'hidden',
            },
          }, c.title || c.id))
      }
      // ★ 视觉风格 = 照抄官方「开始」页（2026-10-24 主人要求）★
      //   主人原话：「话布选功能的页面风格跟开始页保持一致」
      //   出处：@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js 里的
      //         GuideBody.module.css —— 我把它的关键值原样搬过来 ✓
      //     · 容器：flex 纵向 **居中**（justify-content:center / align-items:center）
      //             gap 14px / min-height 100% / padding 0 24px
      //             末尾再来一个 **flex:0 10% 的占位**（官方 .guide:after ✓ 视觉重心略上）
      //     · 卡片：宽 **380px**（max-width 100%）/ min-height 56px / padding 14px 20px
      //             display:flex / align-items:center / gap:14px / text-align:left
      //             background: var(--dsw-alias-bg-layer-1)
      //             border: **.5px** solid var(--dsw-alias-border-l3)  ← 半像素是官方的做法
      //             border-radius: var(--dsw-radius-xl)
      //             hover → var(--dsw-alias-interactive-bg-hover)
      //     · 图标：26×26 / flex:none / color var(--dsw-alias-label-secondary)
      //     · 标题：**14px** / line-height 1.4 / 不换行 + 省略号
      //     · 描述：**11px** / 不换行 + 省略号 / color var(--dsw-alias-label-tertiary)
      //   ⚠️ 这几个 token（border-l3 / label-tertiary / interactive-bg-hover /
      //      radius-xl / static-neutral-*）**不在主题目录**里 ✓
      //      但官方自己就在用 ✓ 截图里也渲染正常 ✓
      //      → 照用，但都带兜底值 ✓（拿不到也不会变成透明/黑色 ✗）
      var CCV_GUIDE_MAXW = 380
      var CCV_ENTRY_BASE = {
        boxSizing: 'border-box',
        width: CCV_GUIDE_MAXW + 'px',
        maxWidth: '100%',
        minHeight: '56px',
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        padding: '14px 20px',
        textAlign: 'left',
        // font: inherit（官方写法）→ 这里显式给一遍，免得被默认 UA 字体覆盖
        fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-primary,#1a1a1a)',
        background: 'var(--dsw-alias-bg-layer-1,rgba(255,255,255,.04))',
        border: '.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.28))',
        borderRadius: 'var(--dsw-radius-xl,12px)',
      }
      var CCV_ENTRY_ICON = {
        width: '26px', height: '26px', flex: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--dsw-alias-label-secondary,#8b8b8b)',
      }
      var CCV_ENTRY_TEXT = {
        display: 'flex', flexDirection: 'column', flex: '1 1 auto',
        gap: '3px', minWidth: 0,
      }
      var CCV_ENTRY_TITLE = {
        fontSize: '14px', lineHeight: 1.4,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }
      var CCV_ENTRY_DESC = {
        fontSize: '11px', lineHeight: 1.4,
        color: 'var(--dsw-alias-label-tertiary,#6b7280)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }
      // 官方 hover 底色（拿不到就退回 bg-layer-2 ✓）
      var CCV_ENTRY_HOVER_BG = 'var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12)))'
      // 居中的纵向容器（照官方 .guide ✓）
      function ccvGuideColumn(children) {
        return h('div', {
          style: {
            boxSizing: 'border-box',
            display: 'flex', flexDirection: 'column',
            justifyContent: 'center', alignItems: 'center',
            gap: '14px', minHeight: '100%', height: '100%',
            padding: '0 24px', overflow: 'auto',
          },
        },
          children,
          // 官方 .guide:after { flex: 0 10% } ✓ 视觉重心略上（照抄 ✓）
          h('div', { style: { flex: '0 10%', minHeight: 0 } }))
      }

      // ★ 功能入口卡（一级页用）—— 结构照官方 guide 的 entry ★
      function CcvEntry(props) {
        var hover = React.useState(false)      // ← 组件顶层 ✓
        var hv = hover[0], setHv = hover[1]
        var e = props.entry || {}
        return h('div', {
          onClick: e.disabled ? undefined : e.onClick,
          onMouseEnter: e.disabled ? undefined : function () { setHv(true) },
          onMouseLeave: e.disabled ? undefined : function () { setHv(false) },
          title: e.hint || '',
          role: 'button',
          style: Object.assign({}, CCV_ENTRY_BASE, {
            cursor: e.disabled ? 'default' : 'pointer',
            opacity: e.disabled ? 0.55 : 1,
            background: (!e.disabled && hv) ? CCV_ENTRY_HOVER_BG : CCV_ENTRY_BASE.background,
          }),
        },
          h('div', { style: CCV_ENTRY_ICON }, e.icon || '·'),
          h('div', { style: CCV_ENTRY_TEXT },
            h('div', { style: CCV_ENTRY_TITLE }, e.title || ''),
            h('div', { style: CCV_ENTRY_DESC }, e.desc || '')),
          // 官方 entry 右侧没有箭头 ✗ —— 但"能点进去"这件事要有提示 ✓
          //   用小号 chevron，颜色跟描述同级 ✓ 不抢眼 ✓
          e.disabled
            ? h('div', { style: { fontSize: '11px', flex: 'none', color: 'var(--dsw-alias-label-tertiary,#6b7280)' } }, '规划中')
            : h('div', { style: { fontSize: '15px', flex: 'none', color: 'var(--dsw-alias-label-secondary,#8b8b8b)' } }, '›'))
      }

      // ★ 错误边界（2026-10-23 加，10-24 挪到外面）★
      //   上一次标签页纯空白 ✗ —— 里面一点线索都没有 ✓ 查了半天 ✓
      //   有了它：组件崩了会显示"这里出错了：<原因>"✗ 而不是空白 ✓
      //   ⚠️ React 里**只有 class 组件能做错误边界** ✗ 函数组件做不了 ✓
      //      （要 static getDerivedStateFromError / componentDidCatch ✓）
      //   ⚠️ 拿不到 React.Component → 跳过边界 ✓（不能因此再崩一次 ✗）
      var CcvErrorBoundary = null
      try {
        if (React.Component) {
          CcvErrorBoundary = class extends React.Component {
            constructor(p) { super(p); this.state = { err: null } }
            static getDerivedStateFromError(e) { return { err: e } }
            componentDidCatch(e) {
              try { ccvLog('话布标签页渲染出错: ' + ((e && e.message) || e)) } catch (_) {}
            }
            render() {
              if (this.state && this.state.err) {
                return h('div', { style: { padding: '14px', fontSize: '13px', color: 'var(--dsw-alias-state-error-primary,#d33)', wordBreak: 'break-word' } },
                  '话布标签页出错了：' + ((this.state.err && this.state.err.message) || String(this.state.err)),
                  h('div', { style: { marginTop: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary,#6b7280)' } },
                    '（详情见 %TEMP%\\ccv-selbar.log）'))
              }
              return this.props.children
            }
          }
        }
      } catch (e) { ccvLog('错误边界创建失败（跳过）: ' + (e && e.message)); CcvErrorBoundary = null }


    return {
      CcvTabGlyph: CcvTabGlyph, CCV_ROW_BASE: CCV_ROW_BASE, CcvRow: CcvRow,
      ccvGuideColumn: ccvGuideColumn, CcvEntry: CcvEntry,
      CcvErrorBoundary: CcvErrorBoundary,
    }
  }

    function apply(ctx) {
      ccvCtx = ctx;   // tab 正文是另一个组件，用的就是这个引用

      // ─── 侧模块桥接：把根上下文挂到 window ────────────────────
      // 侧模块（docdrop / doclink / selref）由 new Function(src)() 执行，
      // 作用域是全局，拿不到这里的任何局部变量 —— 只能走 window 桥。
      // 握手是双向的：apply 与侧模块加载的先后顺序不固定（两边都异步），
      //   · 这里先跑 → 直接回调侧模块挂出的 boot
      //   · 侧模块先跑 → 它自己会看到 __ccvCtx 并自举
      // 细节见 lib/selref.js 顶部说明。
      try {
        window.__ccvCtx = ctx;
        if (typeof window.__ccvSelRefBoot === 'function') window.__ccvSelRefBoot(ctx);
        // 接管 DSH 自带查看器里的 .md（侧模块 lib/viewer-md.js）：先只读，验契约
        if (typeof window.__ccvViewerBoot === 'function') window.__ccvViewerBoot(ctx);
      } catch (e) { ccvLog('侧模块桥接失败: ' + (e && e.message)); }
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
      // ⚠️ 这份 CSS 文本要**借给查看器**用（见 lib/viewer-md.js）：
      //   面板的 markdown 样式作用域是 `.ccv-panel .ccv-editor`，而查看器的正文
      //   是 `[data-ccv-md-body]` —— 两处渲染用的是**同一个 mdToHtml**，
      //   所以差别只在样式：同一份 <table>，有边框就是表格，没边框就看起来像纯文本。
      //   2026-10-04 主人正是拿两张截图问"为什么两边显示不一样"。
      //   做法：**一份规则两处用**（换掉作用域前缀），不复制、不会漂移。
      var ccvMdCss = [
          '.ccv-panel .ccv-editor > *:first-child{margin-top:0}',
          '.ccv-panel .ccv-editor > *:last-child{margin-bottom:0}',
          '.ccv-panel .ccv-editor h1{font-size:1.6em;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));padding-bottom:.2em;margin:.6em 0 .4em;font-weight:600;line-height:1.3}',
          '.ccv-panel .ccv-editor h2{font-size:1.35em;margin:.7em 0 .45em;font-weight:600;line-height:1.35}',
          '.ccv-panel .ccv-editor h3{font-size:1.18em;margin:.7em 0 .45em;font-weight:600;line-height:1.35}',
          '.ccv-panel .ccv-editor h4{font-size:1.05em;margin:.7em 0 .45em;font-weight:600;line-height:1.35}',
          '.ccv-panel .ccv-editor h5{font-size:1em;margin:.7em 0 .45em;font-weight:600;line-height:1.35}',
          '.ccv-panel .ccv-editor h6{font-size:.95em;margin:.7em 0 .45em;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-secondary,rgba(0,0,0,.65))}',
          '.ccv-panel .ccv-editor p{margin:.5em 0}',
          // 空段落不显示。2026-10-11 主人报「查看器里引用块行距很大」：
          //   引用块原文是带空行的（`> **依据**…` / `> ` / `> **本文件回答一件事**…`），
          //   块渲染器**每一行都变成一个 <p>**（见 renderBlocks 末尾），空行就变成空段落
          //   → 每处多出一整行 + 边距 ≈ 52px，而正常行距只有 24.5px。
          //   面板里看不出来，是因为编辑区是 contentEditable —— 浏览器会把空段落吃掉/合并；
          //   查看器是纯静态 HTML，空段落原样保留，于是全暴露出来。
          //   两条都写上：`:empty` 管 `<p></p>`，`:has(> br:only-child)` 管 `<p><br></p>`。
          '.ccv-panel .ccv-editor p:empty{display:none}',
          '.ccv-panel .ccv-editor p:has(> br:only-child){display:none}',
          '.ccv-panel .ccv-editor blockquote{border-left:3px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));margin:.6em 0;padding:4px 12px;opacity:.9;color:var(--dsw-alias-label-secondary,rgba(0,0,0,.7))}',
          '.ccv-panel .ccv-editor blockquote > *:first-child{margin-top:0}',
          '.ccv-panel .ccv-editor blockquote > *:last-child{margin-bottom:0}',
          '.ccv-panel .ccv-editor mark{background:rgba(250,204,21,.45);color:inherit;padding:0 2px;border-radius:3px}',
          '.ccv-panel .ccv-editor .ccv-hl{background:rgba(250,204,21,.16);border-left:3px solid rgba(234,179,8,.55);border-radius:6px;padding:8px 14px;margin:.6em 0}',
          '.ccv-panel .ccv-editor .ccv-hl > *:first-child{margin-top:0}',
          '.ccv-panel .ccv-editor .ccv-hl > *:last-child{margin-bottom:0}',
          // ⚠️ 2026-10-29 主人：「现在高亮块有问题」
          //   高亮块在**查看器**里没有任何样式 ✗
          //   上面那三条规则写在"面板样式表"（ccvStyle）里 ✗
          //   而查看器拿的是 mdCss（mdCssFor → 作用域替换）✗ → .ccv-hl 变成普通 div ✓
          //   → 高亮块在右侧文档里"没底色、没左边线"，看起来就是普通段落 ✓
          //   所以这里在 **mdCss** 里再写一份（面板与查看器共用同一条规则 ✓）
          '.ccv-panel .ccv-editor .ccv-hl{background:rgba(250,204,21,.16);border-left:3px solid rgba(234,179,8,.55);border-radius:6px;padding:8px 14px;margin:.6em 0}',
          '.ccv-panel .ccv-editor .ccv-hl p{margin:.2em 0}',
          // 行内高亮（==文字== ↔ <mark>）：查看器同样没有这条规则 ✗ → 浏览器默认的
          // 纯黄底 + 黑字，在深色主题里像一块"荧光砖" ✓ 一并收进来 ✓
          '.ccv-panel .ccv-editor mark{background:rgba(250,204,21,.28);color:inherit;padding:0 3px;border-radius:3px}',
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
          // ⚠️ 2026-10-29 主人（截图）：插入表格后**正文行高度塌成一条线**、表头却很高
          //   原因：空的 <td></td> 在 contentEditable 里没有行高 ✗（有文字的 <th> 有 ✓）
          //   双重保险：① 插入时给单元格放 <br>（viewer 的 insertTableHtml 已改）
          //            ② 这里给 :empty 补一条零宽字符 —— 就算 <br> 被删掉也不会塌 ✓
          '.ccv-panel .ccv-editor td:empty::after,.ccv-panel .ccv-editor th:empty::after{content:"\\200b"}',
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
      ensureStyle('ccv-md-style', ccvMdCss);
      // 借给查看器：把作用域前缀换成它正文的标记，同一份规则直接复用
      try {
        if (window.__ccvKit) {
          window.__ccvKit.mdCssFor = function (scope) {
            return ccvMdCss.split('.ccv-panel .ccv-editor').join(scope);
          };
        }
      } catch (_) {}
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

      // ─── 右侧栏「话布」标签页：**功能入口**（2026-10-11 恢复）────────────
      // 定位（主人原话）：话布插件不止编辑 markdown，以后会有 UI 实时可视编辑网页等功能，
      //   所以需要一个**话布标签页**，打开可以**选功能** ✓
      //   —— 所以这里是"功能清单"，**不是某个编辑器的宿主** ✗
      //
      // ⚠️ 历史（2026-10-11 ~ 10-22）：那时查过这个槽（sidebar.right.pane.tab）的
      //    ownerProps 是**空的** ✗ → 结论是"没法从这里打开某个文件"✗
      //    于是清单只列文字，写着"打开它们请走文件树"✗
      //    —— **那个结论是错的** ✗ 漏看了一个服务 ✓
      //
      // ★ 2026-10-22 主人报：「这里点击跳转到文档选择」★
      //   查官方包（dsh-client-ui-sidebar-right/lib/types/client/service.d.ts）找到：
      //     ctx.sidebarRight.openResource(address, options?)  ✓✓
      //       · address 必须是 `dsh-resource://<type>/…` 形式 ✓
      //       · 它会 claim 资源 / 放置标签 / **展开右栏** / 记录导航，一次做完 ✓
      //       · 地址不合法或没人认领 → **抛异常** ✓（官方注释：那是接线错误 ✓）
      //   → 所以**点清单里的一行就能跳到那篇文档** ✓ 不用再走文件树 ✓
      //
      // 两阶段注册（照官方 sidebar-files）：
      //   ① sidebarRightTabs.register —— 声明一个"页面型"标签类型
      //   ② slots.register 到 sidebar.right.pane.tab，key 与上面 id 一致
      //   ⚠️ 这两个服务必须写回 inject 声明（不能运行时 ctx.get 现取 ✗）
      var CCV_TAB_ID = 'collab-canvas'
      // ═══ 画布小工具集（地址 / 打开文档 / 文件树行 / 入口卡片）═══
      //   17 个定义里，apply 只用得到这 6 个 ✓（机器核对）
      var __kit = ccvMakeCanvasKit({ ctx: ctx })
      var CcvTabGlyph = __kit.CcvTabGlyph, CCV_ROW_BASE = __kit.CCV_ROW_BASE
      var CcvRow = __kit.CcvRow, ccvGuideColumn = __kit.ccvGuideColumn
      var CcvEntry = __kit.CcvEntry, CcvErrorBoundary = __kit.CcvErrorBoundary
      // ═══ 右侧栏「话布」标签页（整块 UI 在模块级 ccvMakeCanvasTab ✓）═══
      //   依赖只有 7 个 ✓ 返回也只有 CcvFeatureTab ✓（都是机器算过、非目测）
      var CcvFeatureTab = ccvMakeCanvasTab({
        CCV_ROW_BASE: CCV_ROW_BASE, CCV_TAB_ID: CCV_TAB_ID,
        CcvEntry: CcvEntry, CcvErrorBoundary: CcvErrorBoundary,
        CcvRow: CcvRow, CcvTabGlyph: CcvTabGlyph,
        ccvGuideColumn: ccvGuideColumn,
        ctx: ctx,
      }).CcvFeatureTab
      // ─── 以后加功能：入口就在上面那个 CcvFeatureTab 里 ──────────────
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
