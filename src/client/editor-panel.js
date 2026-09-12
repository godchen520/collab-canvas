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
    const ReactDOMClient = require("react-dom/client");
    const { createElement: h, useState, useEffect, useRef, useCallback } = React;

    // ─── 布局：只挤压对话列，sidabar 与 shell 一律不动 ───
    // DOM：#root > [ sidebar, [data-dsh-frame] > [data-pane="conversation"] ]
    // 两条铁律（来自 dsh-better-sidebar/src/client/layout.css）：
    //   1. 绝不给 #root 改 display——它是 Grid 容器，改成 flex 会废掉
    //      grid-template-columns，sidebar 变成 flex item 就被压缩、触发折叠。
    //   2. 不要推移 #root（margin-right/width calc 也会牵动 sidebar 的
    //      响应式判断）。改为只给 AppFrame 的中间列加 margin-right：
    //      "A stretched grid item shrinks by its margins"——推挤精确落在
    //      对话区（header + 输出 + 输入框），sidebar 一点不动。
    // 锚点用 data 属性而非 nth-child：frame 内还混着 overlay 层与拖拽手柄。
    var _ccvStyle = null;
    // 对话列锚点 A：data-pane（DSH 0.1.x）；直接子级 + 后代各写一份，兼容多包一层的宿主
    var CCV_COL = '[data-dsh-frame] > [data-pane="conversation"],[data-dsh-frame] [data-pane="conversation"]';
    // 锚点 B：data-slot（rc.8-era shell）。单独成条——混进同一选择器列表的话，
    // 一旦宿主不支持 :has()，整条规则会被连同锚点 A 一起丢弃。
    var CCV_COL_HAS = ':has(> [data-slot="conversation"])';

    function colRules(prefix, body) {
      return prefix + " " + CCV_COL + "{" + body + "}" +
             prefix + " " + CCV_COL_HAS + "{" + body + "}";
    }

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
    var CCV_MODE_KEY = "ccv-open-mode";       // "dock"=停靠右侧栏（默认） / "float"=悬浮窗口
    // ⛔ 自建悬浮模式的开关。2026-09-12 起置 false —— 官方右侧栏本身就两种都行：
    //    停靠（标签页）和"把标签拖出面板就浮出来"，后者还更灵活。
    //    自建悬浮当初唯一的理由是"那时没有官方侧栏"，现在理由没了，且两套浮动机制并存
    //    需要互相回避（切模式得先把另一边收干净），改成纯负债。
    //    ⚠️ 代码一律保留：想找回悬浮，把这个值改成 true 即可（其余一行不用动）。
    var CCV_FLOAT_ENABLED = false;
    // 🔍 高频路径的调试日志开关。默认 false —— 因为"鼠标松开 / 划词判定 / 隐藏划词栏"
    //    这类动作一秒能触发几十次，每次都在拼调用栈并发一条网络请求写盘，属于实打实的卡顿源。
    //    平时静默；排查划词相关问题时把它改成 true，这些日志就会照旧出现。
    //    低频日志（各种 catch 里的失败原因）不受影响，永远都会记。
    var CCV_DEBUG = false;
    var CCV_DRAFT_KEY = "ccv-draft-cache";    // { [canvasId]: { content, at } }
    var ccvCtx = null;                        // 模块级 ctx：tab 正文是独立组件，拿不到 apply 的闭包
    var ccvLiveEditor = null;                 // 当前编辑区 DOM。组件卸载后 React 会把 ref 置空，
    var ccvLiveCanvasId = null;               // 但我们自己留的这份引用仍能读到用户刚敲的字。

    function ccvGetMode() {
      // 悬浮被停用时，历史存过的 "float" 一律按 "dock" 处理，免得老用户一进来落在已停用的模式上
      if (!CCV_FLOAT_ENABLED) return "dock";
      try { return localStorage.getItem(CCV_MODE_KEY) === "float" ? "float" : "dock"; } catch (_) { return "dock"; }
    }
    function ccvSetMode(m) {
      try { localStorage.setItem(CCV_MODE_KEY, m); } catch (_) {}
    }
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
    function draftSet(id, content) {
      if (!id || typeof content !== "string") return;
      if (content.length > CCV_DRAFT_MAX) return;
      try { var all = ccvDrafts(); all[id] = { content: content, at: Date.now() }; localStorage.setItem(CCV_DRAFT_KEY, JSON.stringify(all)); } catch (_) {}
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

    // ⛔ 【当前不可达】给"自建悬浮/分栏"用的：靠给 #root 加 margin-right 把会话区挤窄，
    //    好给浮出来的话布腾地方（配合下面的 _ccvStyle / CCV_COL / colRules）。
    //    悬浮模式 2026-09-12 停用（CCV_FLOAT_ENABLED=false）后，唯一调用方是 CanvasToggle，
    //    于是这一整块连带成了死岛。官方右侧栏自己会重排布局，不需要挤 #root。
    //    留着是因为恢复悬浮时要用；CCV_FLOAT_ENABLED 改回 true 即一并复活。
    function compressMainContent(widthPx) {
      if (!_ccvStyle) {
        _ccvStyle = document.createElement("style");
        _ccvStyle.id = "collab-canvas-layout";
        document.head.appendChild(_ccvStyle);
      }
      if (widthPx > 0) {
        _ccvStyle.textContent =
          // 面板悬浮在右侧，占住对话列让出的空间
          "#collab-canvas-panel{position:fixed!important;top:0!important;right:0!important;bottom:0!important;height:100vh!important;width:" + widthPx + "px!important;display:flex!important;flex-direction:column!important;border-left:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25))!important;z-index:2147483000!important}" +
          // 窄屏直接铺满，不等 JS 判断（避免打开瞬间闪一下分栏宽度）
          // 用 inset:0 而不是 width:100vw——移动端 100vw 常与视觉视口不一致（漏一条边）
          "@media (max-width:768px){#collab-canvas-panel{top:0!important;left:0!important;bottom:0!important;width:100vw!important;min-width:100%!important;border-left:none!important;z-index:2147483000!important}}" +
          // 只挤压中间列，sidebar 完全不动（min-width:0 让 grid item 能真正收窄）
          colRules("#root.ccv-open", "margin-right:" + widthPx + "px!important;min-width:0!important;transition:margin-right .15s ease") +
          colRules("body[data-ccv-dragging] #root", "transition:none!important") +
          // 全屏：取消挤压 + 面板铺满整个视口（盖住 sidebar）
          colRules("#root.ccv-full", "margin-right:0!important") +
          "#collab-canvas-panel.ccv-full{top:0!important;left:0!important;bottom:0!important;width:100vw!important;min-width:100%!important;border-left:none!important;z-index:2147483000!important}";
      } else {
        _ccvStyle.textContent = "";
      }
    }
    // 对话列元素。两套宿主命名（见 dsh-better-sidebar/src/client/layout.css）：
    //   · DSH 0.1.x：中间列自身就是 [data-pane="conversation"]
    //   · rc.8-era ：中间列里包一个 [data-slot="conversation"] 子元素，
    //                真正被挤压的是它的**父元素**（CSS 侧对应 :has(> [data-slot=...])）
    // 顺序不能反——命中 data-slot 时要返回父级，否则量到的是内层容器。
    function conversationColumn() {
      var el = document.querySelector('[data-dsh-frame] [data-pane="conversation"]');
      if (el) return el;
      var slot = document.querySelector('[data-dsh-frame] [data-slot="conversation"]');
      if (slot && slot.parentElement) return slot.parentElement;
      el = document.querySelector('[data-slot="conversation"]');
      if (el) return el.parentElement || el;
      el = document.querySelector('[data-dsh-frame] > [data-pane],[data-dsh-frame] [data-pane]');
      if (el) return el;
      return null;
    }

    // 左侧遮挡物的右边界（一般是 sidebar）。两轮探测：
    //   ① 占位布局：#root 直接子元素里贴在左边、宽度不到视口 60% 的可见元素
    //   ② fixed 悬浮布局：命中测试。命中的往往是 sidebar 内部的小元素，
    //     向上找第一个贴左的祖先作为遮挡根。
    function leftEdge() {
      var vw = window.innerWidth;
      var root = document.getElementById('root');
      if (root) {
        var max = 0;
        Array.prototype.forEach.call(root.children, function (el) {
          if (el.id === 'collab-canvas-panel') return;
          if (el.hasAttribute && el.hasAttribute('data-dsh-frame')) return;
          if (el.querySelector && el.querySelector('[data-dsh-frame]')) return;
          var cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') return;
          var r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.left <= 1 && r.right < vw * 0.6) {
            if (r.right > max) max = r.right;
          }
        });
        if (max > 0) return max;
      }
      var col = conversationColumn();
      var cr = col ? col.getBoundingClientRect() : null;
      var y = cr ? Math.max(2, cr.top + Math.min(cr.height / 2, 160)) : Math.round(window.innerHeight / 2);
      var els = document.elementsFromPoint(2, y) || [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el === document.body || el === document.documentElement) continue;
        if (el.id === 'collab-canvas-panel') continue;
        if (col && (el === col || col.contains(el))) continue;   // 压在上面的就是对话列 → 没被遮挡
        var er = el.getBoundingClientRect();
        // 命中的可能是 sidebar 内部图标，向上找贴左的祖先
        while (el && el !== document.body && er.left > 1) {
          el = el.parentElement;
          if (!el) break;
          er = el.getBoundingClientRect();
        }
        if (el && el !== document.body && er.left <= 1 && er.width > 0 && er.right < vw * 0.6) return er.right;
      }
      return 0;
    }

    // 可用宽度 = 会话区 + 话布这片空间（左侧栏不参与分配）。
    // 用「视觉有效区间」量：右边界取对话列右沿 + 被话布挤掉的 margin，
    // 左边界取 max(对话列左沿, 左侧遮挡右沿)——这样同时兼容两种布局。
    // 找不到对话列时用 frame 宽度兜底。
    function measureAvail() {
      var col = conversationColumn();
      if (!col) {
        // 兜底：用 frame 宽度（它本身通常就是会话+话布的可用空间）
        var frame = document.querySelector('[data-dsh-frame]');
        if (frame) {
          var fr = frame.getBoundingClientRect();
          return Math.max(1, Math.round(fr.width));
        }
        return Math.max(1, Math.round(window.innerWidth - leftEdge()));
      }
      var r = col.getBoundingClientRect();
      var mr = parseFloat(window.getComputedStyle(col).marginRight) || 0;
      var right = r.right + mr;
      return Math.max(1, Math.round(right - Math.max(r.left, leftEdge())));
    }
    // 会话区最小可见宽度：可用空间本来就窄时给对话留条活路
    var MIN_CONV = 360;
    // 左侧栏宽度超过这个值就算「展开」（折叠后的图标条一般 48~72px，展开后 200px+）
    var SIDEBAR_OPEN_MIN = 120;

    // 侧边栏是否展开：三个信号取最大值——
    //   · 对话列自己的 left（侧边栏占位展开时，它会被整体推到右边）★ 最可靠
    //   · frame 的 left（侧边栏在 frame 之外时）
    //   · leftEdge()（#root 下贴在左侧的可见元素右沿，覆盖 fixed 悬浮的情况）
    // 只用「有没有把内容往右推」这一个事实判断，不需要知道侧边栏的具体 class/位置。
    function isSidebarExpanded() {
      var col = conversationColumn();
      var colLeft = col ? col.getBoundingClientRect().left : 0;
      var frame = document.querySelector('[data-dsh-frame]');
      var frameLeft = frame ? frame.getBoundingClientRect().left : 0;
      return Math.max(colLeft, frameLeft, leftEdge()) >= SIDEBAR_OPEN_MIN;
    }

    // 话布最大占比：侧边栏收起 2/3（会话:话布 = 1:2）；侧边栏展开 1/2（会话:话布 = 1:1）
    function maxRatio() { return isSidebarExpanded() ? 1 / 2 : 2 / 3; }

    // 窄屏（手机/平板竖屏）：分栏拖拽没法用，话布一律全屏铺满。
    // 阈值 768 是常见断点；同时认 coarse pointer（触屏）兜底。
    var NARROW_MAX = 768;
    function isNarrow() {
      if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches &&
          window.innerWidth < 1024) return true;
      return window.innerWidth < NARROW_MAX;
    }

    function dragMin(avail) { return Math.floor((avail || measureAvail()) / 3); }
    function dragMax(avail) {
      var a = avail || measureAvail();
      var byRatio = Math.floor(a * maxRatio());
      var byMin = a - MIN_CONV;
      return Math.max(dragMin(a), Math.min(byRatio, byMin));
    }

    // ─── 编辑器面板组件 ─────────────────────────────────
    // embedded=true：画布作为「右侧栏标签正文」渲染。此时它不再是一个 fixed 悬浮层，
    // 宽度/高度由标签页决定，拖拽条和全屏按钮交给侧栏自己，宽度也不再需要挤压对话列。
    function CanvasPanel({ ctx, width, onclose, onresize, embedded }) {
      const [canvases, setCanvases] = useState([]);
      const [activeId, setActiveId] = useState(null);
      // 顶栏两行：creating = 行内新建输入框展开（不弹浮层，直接插在第一行流里）
      // dropOpen = 文件名胶囊下的话布切换下拉（absolute，挂在第一行内）
      const [creating, setCreating] = useState(false);
      const [newTitle, setNewTitle] = useState("");
      const [dropOpen, setDropOpen] = useState(false);
      const [content, setContent] = useState("");
      const [version, setVersion] = useState(0);
      // 窄屏（手机）一开始就是全屏：分栏拖拽在触屏上没法用
      const [isFull, setIsFull] = useState(isNarrow());
      const [narrow, setNarrow] = useState(isNarrow());
      // 停靠模式下没有拖拽条，宽度得自己量（悬浮模式的宽度是拖出来的，见 width prop）
      const [selfW, setSelfW] = useState(0);
      const [restored, setRestored] = useState(false);   // 顶栏显示「已恢复未保存内容」
      const editorRef = useRef(null);
      const saveTimer = useRef(null);
      const panelRef = useRef(null);
      const meterRef = useRef(null);
      const panelW = embedded ? selfW : (width || 500);
      const draftTimer = useRef(null);
      // 停靠模式下，"窄"由面板自己的宽度决定，而不是整个窗口 ——
      // 窗口 1600 宽、侧栏只给 315 时，面板也是窄的，得用紧凑内边距。
      const isNarrowPane = embedded ? (selfW > 0 && selfW < 520) : narrow;
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
      // 一旦变成窄屏就强制全屏（比如宽屏开着分栏，再把窗口缩到手机尺寸）
      useEffect(() => { if (narrow) setIsFull(true); }, [narrow]);

      // 读数直接写 DOM，不走 state——拖拽时每帧 setState 会拖垮手感
      function updateMeter(w, avail) {
        if (!meterRef.current) return;
        // 停靠模式先判：窄屏会被强制 isFull，那时读数写"全屏"是错的 ——
        // 它只是被侧栏给了个窄格子，不是进了全屏。
        if (embedded) { meterRef.current.textContent = Math.round(w) + "px · 侧栏"; return; }
        if (isFull) { meterRef.current.textContent = "全屏"; return; }
        var col = conversationColumn();
        var colLeft = col ? Math.round(col.getBoundingClientRect().left) : -1;
        // L = 对话列左沿，用来判断侧边栏到底有没有把内容推走
        meterRef.current.textContent =
          Math.round(w) + " / " + (avail ? Math.round(avail) : "?") + "px · " +
          (isSidebarExpanded() ? "1:1" : "1:2") + " · L" + colLeft;
      }
      // 挂载后（CSS 已生效）测一次真实宽度。必须现场量 panelRef ——
      // 不能用上面那个渲染时就定住的 width/panelW，首帧它还是 0，会把读数写成 0px。
      useEffect(() => {
        var t = setTimeout(function () {
          var el = panelRef.current;
          var w = el ? el.getBoundingClientRect().width : panelW;
          if (embedded) setSelfW(Math.round(w));
          updateMeter(w, measureAvail());
        }, 0);
        return function () { clearTimeout(t); };
      }, [isFull, embedded]);
      // 对话列尺寸一变（左侧栏收放、窗口缩放）就刷新读数
      useEffect(() => {
        var col = conversationColumn();
        if (!col) return;
        var ro = new ResizeObserver(function () {
          var w = panelRef.current ? panelRef.current.getBoundingClientRect().width : panelW;
          updateMeter(w, measureAvail());
        });
        ro.observe(col);
        return function () { ro.disconnect(); };
      }, [isFull]);

      // 停靠模式：宽度由右侧栏标签页给，自己量。拖宽拖窄标签页时跟着变。
      useEffect(function () {
        if (!embedded) return;
        var el = panelRef.current;
        if (!el) return;
        var measure = function () {
          var w = Math.round(el.getBoundingClientRect().width);
          setSelfW(w);
          updateMeter(w, measureAvail());
        };
        measure();
        if (typeof ResizeObserver === "undefined") return;
        var ro = new ResizeObserver(measure);
        ro.observe(el);
        return function () { ro.disconnect(); };
      }, [embedded, isFull]);

      // 把「正在编辑的 DOM + 它属于哪个话布」记到模块级：卸载后 React 会把 ref 置空，
      // 我们留的这份引用还能读到用户刚敲进去的字，用来抢存草稿。
      useEffect(function () { ccvLiveCanvasId = activeId; }, [activeId]);
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

      // 面板宽度/定位全交给注入的 CSS（!important），这里只切全屏 class
      useEffect(() => {
        if (embedded) return;   // 停靠模式：全屏是右侧栏自己的事，不碰对话列布局
        var panel = panelRef.current;
        if (panel) {
          // 注意：panelRef 是 CanvasPanel 的根 div，#collab-canvas-panel 是它外层的宿主容器，
          // .ccv-full 必须打到宿主上，CSS 选择器 #collab-canvas-panel.ccv-full 才匹配得到
          var host = panel.closest("#collab-canvas-panel") || panel.parentElement;
          if (host) host.classList.toggle("ccv-full", isFull);
        }
        var root = document.getElementById("root");
        if (root) root.classList.toggle("ccv-full", isFull);   // 全屏时取消对话列挤压
      }, [isFull]);

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
            // 有一份没来得及写盘的草稿：它是用户刚敲的，比服务端那版新，优先恢复它。
            // 恢复后按「停止输入 1.5 秒自动存」的同一规矩补写回服务端，
            // 否则用户切走之后，这段内容只活在浏览器里，AI 在对话里看不到。
            ccvLog("恢复未保存草稿: id=" + d.id + " 长度=" + dft.content.length + " 服务端长度=" + d.content.length);
            setActiveId(d.id); setContent(dft.content); setVersion(d.version);
            setRestored(true);
            clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(function () { writeMd(d.id, dft.content); }, 1500);
          } else {
            setActiveId(d.id); setContent(d.content); setVersion(d.version);
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
            if (activeId === id) { setActiveId(null); setContent(""); setVersion(0); }
          } else alert("删除失败: " + (d.error || "未知错误"));
        }).catch(() => alert("删除失败"));
      }

      // 写盘。接受显式的 md：卸载后 / 恢复草稿时编辑器 DOM 已不可靠，
      // 这两种情况下必须用调用方手里那份内容，不能再回头读 DOM。
      function writeMd(id, md) {
        if (!id || typeof md !== "string") return Promise.resolve(null);
        return fetch(canvasApi("/api/canvas/write"), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: id, content: md })
        }).then(r => r.json()).then(function (d) {
          if (d && d.ok) { setVersion(d.version); draftDropIf(id, md); setRestored(false); }
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

      // ─── 拖拽边框 ──────────────────────────────────
      const onDragStart = useCallback((e) => {
        if (isFull) return;
        e.preventDefault();
        const startX = e.clientX;
        const startW = (panelRef.current && panelRef.current.getBoundingClientRect().width) || (width || 500);
        // 拖拽前量一次可用宽度即可：拖动只是把宽度在会话区与话布之间搬来搬去，两者之和恒定
        const avail = measureAvail();
        // 拖拽期间关掉过渡，让布局跟手（对齐 dsh-better-sidebar 的做法）
        document.body.setAttribute("data-ccv-dragging", "1");
        const onMove = (ev) => {
          const newW = Math.max(dragMin(avail), Math.min(dragMax(avail), startW - (ev.clientX - startX)));
          updateMeter(newW, avail);
          if (onresize) onresize(newW);   // 重算注入的 CSS
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          document.body.removeAttribute("data-ccv-dragging");
          document.body.style.cursor = "";
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        document.body.style.cursor = "col-resize";
      }, [isFull, onresize]);

      // ─── 切换全屏 ──────────────────────────────────
      function toggleFullscreen() {
        setIsFull(!isFull);   // class 由上面的 useEffect 切换
      }

      // ─── Markdown ↔ HTML ──────────────────────────
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
            case "pre": return "\n```\n" + (n.textContent || "") + "\n```\n";
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
          var lns = inner.split("\n");
          var out = pad + (isTask ? ("- [" + (checked ? "x" : " ") + "] ") : marker) + lns[0];
          for (var j = 1; j < lns.length; j++) out += "\n" + pad + lns[j];
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
          return esc(s)
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
            .replace(/`([^`]+)`/g, "<code>$1</code>")
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/\*([^*]+)\*/g, "<em>$1</em>")
            .replace(/~~([^~]+)~~/g, "<del>$1</del>")
            .replace(/\+\+([^+]+)\+\+/g, "<u>$1</u>")
            .replace(/==([^=]+)==/g, "<mark>$1</mark>")
            .replace(/\[\^([^\]]+)\](?!:)/g, '<a href="#fn-$1" id="fnref-$1" contenteditable="false" style="vertical-align:super;font-size:.75em;color:#3b82f6;cursor:pointer;text-decoration:none">[$1]</a>');
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
          while (i < lines.length) {
            var l = lines[i];
            if (/^```/.test(l)) { if (!inCode) { inCode = true; codeBuf = []; } else { out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>"); inCode = false; } i++; continue; }
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
        if (inCode) out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>");
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

      // ─── 划词栏（参考豆包样式）──────────────────────
      // 选区保存
      // ⚠️ savedRange 建在组件函数体内，每次重渲染都会被重置为 null。
      //    目前调用链恰好都在同一渲染周期内（saveSelection → 紧接着 restoreSelection），
      //    所以没出问题；若将来把 restoreSelection 挪到异步或跨渲染的位置，必须先把它提到模块级。
      var savedRange = null

      function saveSelection() {
        var sel = document.getSelection()
        if (sel && sel.rangeCount > 0) savedRange = sel.getRangeAt(0).cloneRange()
      }
      function restoreSelection() {
        if (!savedRange) return
        var sel = document.getSelection()
        if (sel) { sel.removeAllRanges(); sel.addRange(savedRange) }
        savedRange = null
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
            if (!dd.contains(ev.target)) { closeDropdowns(); savedRange = null; document.removeEventListener('mousedown', close) }
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
      // 问 AI：选中文本以引用块格式塞进 DSH 输入框（划词栏💬与右键菜单共用）
      function askAiFromSelection() {
        var sel = document.getSelection()
        var text = sel ? sel.toString().trim() : ''
        if (!text) { alert('请先选中要问 AI 的文本'); return }
        hideSelbar()
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
            var quote = '> ' + text + '\n\n'
            var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
            nativeInputValueSetter.call(input, quote + input.value)
            input.dispatchEvent(new Event('input', { bubbles: true }))
          } else {
            // 新版 DSH 用 Lexical 编辑器：优先走官方 inputActions.setDraft（能保留换行）
            var draftState = window.__ccvInputState
            var curDraft = (draftState && draftState.draft) ? draftState.draft : ''
            var newDraft = '> ' + text + '\n\n' + curDraft
            if (window.__ccvInputActions && window.__ccvInputActions.setDraft) {
              window.__ccvInputActions.setDraft(newDraft)
            } else {
              // fallback: 直接写 DOM + 派发 input
              var escTxt = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              var quoteHtml = '<div>> ' + escTxt + '</div><div><br></div><div><br></div>'
              input.innerHTML = quoteHtml + input.innerHTML
              input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '> ' + text }))
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

      // ─── 样式 ──────────────────────────────────────
      var S = {
        // 定位/宽高/边框由注入的 CSS（!important）统一控制，这里只放外观
        // 内层根 div 必须填满 #collab-canvas-panel 宿主（flex 列、高 100vh），
        // 否则它没有确定高度 → 编辑区 flex:1 1 0% 解析成 0 → 内容被压没、overflowY 失效、滚轮滚不动。
        // minWidth/minHeight 必须写 0：flex 子项默认 min-width:auto，会被内容（宽表格、
        // 长代码块）顶着涨，撑出容器 —— 停靠在窄侧栏里尤其明显。
        panel: { flex: "1 1 0%", minHeight: 0, minWidth: 0, background: "var(--dsw-alias-bg-layer-1, #fff)", color: "var(--dsw-alias-label-primary, #1a1a1a)", display: "flex", flexDirection: "column", fontFamily: "var(--font-ui, system-ui, sans-serif)" },
        drag: { position: "absolute", left: -4, top: 0, bottom: 0, width: 8, cursor: "col-resize", zIndex: 10 },
        // overflowX:auto —— 宽表格/长代码块在窄侧栏里自己横向滚动，而不是把面板撑宽
        editor: { flex: "1 1 0%", minHeight: 0, minWidth: 0, overflowY: "auto", overflowX: "auto", padding: compact ? "14px 16px" : "24px 32px", outline: "none", fontSize: 14, lineHeight: 1.75, wordBreak: "break-word" }
      };

      // 当前话布标题：canvases 里找 activeId 对应的那条
      let curTitle = "";
      for (let i = 0; i < canvases.length; i++) {
        if (canvases[i].id === activeId) { curTitle = canvases[i].title; break; }
      }

      return h("div", { ref: panelRef, className: "ccv-panel" + (embedded ? " ccv-docked" : ""), style: S.panel },
        // 窄屏没有分栏，也就不需要拖拽条；停靠模式下宽度由标签页给，同样不需要
        (narrow || embedded) ? null : h("div", { style: S.drag, onMouseDown: onDragStart }),
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
            // 窄屏始终全屏，没有可切换的余地，隐藏这个按钮；
            // 停靠模式下全屏按钮在侧栏自己身上，这里不重复一个
            (narrow || embedded) ? null : h("button", { className: "ccv-ibtn", onClick: toggleFullscreen, title: isFull ? "退出全屏" : "全屏" }, isFull ? "❐" : "⛶"),
            h("button", { className: "ccv-ibtn", onClick: onclose, title: embedded ? "关闭这个标签" : "关闭话布" }, "×")
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
              title: embedded ? "本标签的宽度" : "话布宽度 /（会话区 + 话布）可用宽度 —— 左侧栏不计入"
            }, isFull ? "全屏" : (embedded ? "" : (width || 500) + " / ?px"))
          )
        ),
        h("div", {
          ref: editorRef, className: "ccv-editor", contentEditable: true, suppressContentEditableWarning: true, style: S.editor,
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

      // ─── Header 按钮组件 ─────────────────────────────────
    // ⛔ 【当前不可达 · 死岛】从这里到下面 InputBridge 之前，是早期顶栏「话布」按钮的整套实现：
    //    按钮本体 + 自建悬浮/分栏窗口 + 宽度拖拽 + 全屏键 + dock/float 模式菜单。
    //    2026-09-12 起两件事同时发生，导致它彻底没人调用：
    //      ① 顶栏按钮撤下（入口已挪到右侧栏门厅页）；
    //      ② 自建悬浮停用（CCV_FLOAT_ENABLED = false）。
    //    连带失去调用方的还有：compressMainContent、colRules、CCV_COL(_HAS)、_ccvStyle、
    //    livePanelRoot、ReactDOMClient。
    //    ⚠️ 一律不删：把 CCV_FLOAT_ENABLED 改成 true，这一整块连同它的配套立即复活。
    //       也就是说"停用悬浮"这个开关同时管着两件事，别以为它只管悬浮。
    var livePanelRoot = null
    function CanvasToggle({ ctx }) {
      const [open, setOpen] = useState(false);
      const [panelRoot, setPanelRoot] = useState(null);
      // ratio = 话布宽度 / 可用宽度（会话区 + 话布）。初始 1/3：会话占 2/3。
      const [ratio, setRatio] = useState(1 / 3);
      const [currentW, setCurrentW] = useState(500);
      // dock = 停靠进 DSH 右侧栏（默认） / float = 老的悬浮窗口。选择记在本地，忘了也记得住。
      const [mode, setMode] = useState(ccvGetMode());
      const [menu, setMenu] = useState(false);

      // 根据当前可用宽度把像素宽度换算成 ratio 保存，避免左侧栏展开/收起时比例走样
      const onResize = useCallback((w) => {
        var avail = measureAvail();
        if (avail <= 0) return;
        var r = avail > 0 ? Math.max(1 / 3, Math.min(2 / 3, w / avail)) : 1 / 3;
        setRatio(r);
        var nextW = Math.round(r * avail);
        setCurrentW(nextW);
        compressMainContent(nextW);
      }, []);

      const toggle = useCallback(() => {
        if (open) {
          if (panelRoot) { panelRoot.remove(); setPanelRoot(null); }
          document.getElementById("root").classList.remove("ccv-open", "ccv-full");
          document.body.removeAttribute("data-ccv-dragging");
          compressMainContent(0);
          setOpen(false);
        } else {
          // 先收掉可能残留的旧面板（切会话时旧实例卸载不彻底的遗留），保证全局最多一个
          try { if (livePanelRoot) { livePanelRoot.unmount(); } } catch (_) {}
          livePanelRoot = null;
          var staleOld = document.getElementById("collab-canvas-panel");
          if (staleOld) staleOld.remove();
          var div = document.createElement("div");
          div.id = "collab-canvas-panel";
          // 面板是 fixed 的，直接挂 body：不进 #root 的 Grid，不会成为 grid item
          document.body.appendChild(div);
          var r = ReactDOMClient.createRoot(div);
          livePanelRoot = r;
          var avail = measureAvail();
          var w = Math.max(dragMin(avail), Math.min(dragMax(avail), Math.round(ratio * avail)));
          r.render(h(CanvasPanel, {
            ctx, width: w,
            onclose: () => { r.unmount(); div.remove(); setPanelRoot(null); setOpen(false); document.getElementById("root").classList.remove("ccv-open", "ccv-full"); document.body.removeAttribute("data-ccv-dragging"); compressMainContent(0); },
            onresize: onResize
          }));
          setPanelRoot(div);
          document.getElementById("root").classList.add("ccv-open");
          compressMainContent(w);
          setCurrentW(w);
          setOpen(true);
        }
      }, [open, panelRoot, ctx, ratio]);

      // 关闭悬浮面板（不问当前状态，没开就什么都不做）——切到停靠时要先收掉它，
      // 否则同一个画布会有两块界面，`#ccv-editor`、`#ccv-selbar` 这类 id 会撞车。
      const closeFloat = useCallback(() => {
        if (!open) return false;
        if (panelRoot) { panelRoot.remove(); setPanelRoot(null); }
        try { if (livePanelRoot) livePanelRoot.unmount(); } catch (_) {}
        livePanelRoot = null;
        var stale = document.getElementById("collab-canvas-panel");
        if (stale) stale.remove();
        var el = document.getElementById("root");
        if (el) el.classList.remove("ccv-open", "ccv-full");
        document.body.removeAttribute("data-ccv-dragging");
        compressMainContent(0);
        setOpen(false);
        return true;
      }, [open, panelRoot]);

      // 打开停靠标签。cctx 走模块级引用：这里拿不到 apply 的闭包。
      const openDock = useCallback(() => {
        var svc = null;
        try { svc = ccvCtx && ccvCtx.sidebarRight; } catch (_) {}
        if (!svc || typeof svc.openTab !== "function") {
          window.alert("右侧栏接口拿不到，话布没能打开。\n\n多半是插件没加载完整，刷新一次页面再试。");
          return;
        }
        try { svc.openTab(CCV_DOCK_KIND); }
        catch (e) { window.alert("打开右侧栏话布失败：\n\n" + (e && e.message ? e.message : e)); }
      }, []);

      // 顶栏按钮点下去做什么。悬浮已停用 → 永远开停靠；将来重新启用时按模式走。
      const primary = useCallback(() => {
        if (!CCV_FLOAT_ENABLED || mode === "dock") { closeFloat(); openDock(); }
        else toggle();
      }, [mode, closeFloat, openDock, toggle]);

      // 换模式：把另一边的界面先收干净，再把选中的那边打开
      const switchMode = useCallback((next) => {
        setMenu(false);
        if (next === mode) return;
        ccvSetMode(next);
        setMode(next);
        if (next === "dock") {
          closeFloat();
          openDock();
        } else {
          // 悬浮模式：把停靠标签关掉（侧栏"唯一的常驻引导页"框架会自己保留，不用管）
          try {
            var svc = ccvCtx && ccvCtx.sidebarRight;
            var act = svc && typeof svc.active === "function" ? svc.active() : null;
            if (act && act.kind === CCV_DOCK_KIND && typeof svc.close === "function") svc.close(act.id);
          } catch (_) {}
          toggle();
        }
      }, [mode, closeFloat, openDock, toggle]);

      // 对外桥接：doclink「文档名链接」通过这两个全局量打开话布并切换文档
      useEffect(function () {
        window.__ccvCanvasToggle = primary;
        window.__ccvPanelOpen = open;
      }, [primary, open]);

      // 点空白处收起模式菜单
      useEffect(function () {
        if (!menu) return;
        function onDown(e) {
          if (e.target && e.target.closest && e.target.closest(".ccv-mode-menu")) return;
          if (e.target && e.target.closest && e.target.closest(".ccv-mode-caret")) return;
          setMenu(false);
        }
        document.addEventListener("mousedown", onDown);
        return function () { document.removeEventListener("mousedown", onDown); };
      }, [menu]);

      // 监听左侧栏展开/收起、窗口 resize：保持 ratio，重新计算话布像素宽度
      const lastWRef = useRef(0);
      useEffect(() => {
        if (!open) return;
        function recalc() {
          var avail = measureAvail();
          if (avail <= 1) return;
          var w = Math.max(dragMin(avail), Math.min(dragMax(avail), Math.round(ratio * avail)));
          // 宽度没变就别再写 CSS——我们改 margin-right 会让对话列变宽/变窄从而再次触发
          // ResizeObserver，不短路就会自激死循环
          if (w === lastWRef.current) return;
          lastWRef.current = w;
          setCurrentW(w);
          compressMainContent(w);
        }
        var ro = new ResizeObserver(recalc);
        var frame = document.querySelector('[data-dsh-frame]');
        var col = conversationColumn();
        if (frame) ro.observe(frame);
        if (col) ro.observe(col);   // 左侧栏收放时对话列宽度立刻变化，观察它最灵敏
        window.addEventListener('resize', recalc);
        // DSH 侧栏展开/收起通常会给 body/#root 加 class/attribute；
        // 但 fixed 悬浮侧栏可能不改变对话列尺寸，ResizeObserver 不会触发，
        // 所以再用 MutationObserver 监听 class/attribute 变化兜底。
        var mo = new MutationObserver(recalc);
        mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-dsh-sidebar-collapsed'] });
        var root = document.getElementById('root');
        if (root) mo.observe(root, { attributes: true, attributeFilter: ['class', 'style'] });
        lastWRef.current = 0;       // 强制首帧重算（此时 CSS 已生效，测得才准）
        recalc();
        return () => { ro.disconnect(); mo.disconnect(); window.removeEventListener('resize', recalc); };
      }, [open, ratio]);

      useEffect(() => () => {
        // 切换会话时本组件随旧会话头部卸载：把话布面板连根收起
        //（卸载 React 根 + 移除面板 div + 清布局样式），
        // 不留下失去悬浮定位的面板尸体（之前切会话后面板掉到页面底部的根因）
        try { if (livePanelRoot) { livePanelRoot.unmount(); } } catch (_) {}
        livePanelRoot = null;
        var stale = document.getElementById("collab-canvas-panel");
        if (stale) stale.remove();
        var el = document.getElementById("root");
        if (el) el.classList.remove("ccv-open", "ccv-full");
        document.body.removeAttribute("data-ccv-dragging");
        compressMainContent(0);
      }, []);

      // 模式菜单：悬浮 / 停靠 二选一。做成贴边的小下拉，不占地方。
      function modeMenu() {
        if (!menu) return null;
        var items = [
          { key: "dock", label: "停靠右侧栏", hint: mode === "dock" ? "当前" : "" },
          { key: "float", label: "悬浮窗口", hint: mode === "float" ? "当前" : "" }
        ];
        return h("div", {
          className: "ccv-mode-menu",
          style: {
            position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 2147483001,
            minWidth: 132, padding: 4, display: "flex", flexDirection: "column", gap: 2,
            background: "var(--dsw-alias-bg-overlay, #fff)",
            border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))",
            borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,.12)"
          }
        }, items.map(function (it) {
          return h("button", {
            key: it.key,
            onClick: function () { switchMode(it.key); },
            style: {
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
              padding: "5px 8px", border: "none", borderRadius: 6, background: "transparent",
              color: "var(--dsw-alias-label-primary, #1a1a1a)", cursor: "pointer",
              fontSize: 13, fontFamily: "inherit", textAlign: "left", whiteSpace: "nowrap"
            },
            onMouseEnter: function (e) { e.currentTarget.style.background = "rgba(128,128,128,.12)"; },
            onMouseLeave: function (e) { e.currentTarget.style.background = "transparent"; }
          },
            h("span", null, it.label),
            it.hint ? h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #6b7280)" } }, it.hint) : null
          );
        }));
      }

      return h("div", { style: { position: "relative", display: "inline-flex", alignItems: "center" } },
        h("button", {
          onClick: primary,
          style: {
            padding: "4px 10px", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
            // 只剩一个按钮时用完整圆角；两段式按钮（带 ▾）时左段只圆左侧
            borderRadius: CCV_FLOAT_ENABLED ? "6px 0 0 6px" : 6,
            background: open ? "rgba(128,128,128,.15)" : "transparent",
            color: "var(--dsw-alias-label-primary, #1a1a1a)",
            cursor: "pointer", fontSize: 13, fontFamily: "inherit"
          },
          title: CCV_FLOAT_ENABLED
            ? (mode === "dock" ? "话布编辑器（当前：停靠右侧栏）" : "话布编辑器（当前：悬浮窗口）")
            : "话布编辑器（在右侧栏打开；拖出面板即可浮动）"
        }, "话布"),
        // ▾ 模式菜单只在悬浮重新启用时才出现（见 CCV_FLOAT_ENABLED）
        CCV_FLOAT_ENABLED ? h("button", {
          className: "ccv-mode-caret",
          onClick: function (e) { e.stopPropagation(); setMenu(function (v) { return !v; }); },
          style: {
            marginLeft: -1, padding: "4px 5px", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
            borderTopRightRadius: 6, borderBottomRightRadius: 6, borderTopLeftRadius: 0, borderBottomLeftRadius: 0,
            background: menu ? "rgba(128,128,128,.15)" : "transparent",
            color: "var(--dsw-alias-label-primary, #1a1a1a)", cursor: "pointer", fontSize: 10,
            fontFamily: "inherit", lineHeight: 1
          },
          title: "话布怎么摆：停靠右侧栏 / 悬浮窗口"
        }, "▾") : null,
        CCV_FLOAT_ENABLED ? modeMenu() : null
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
    function CanvasDockBody(props) {
      var tab = null;
      try {
        var info = props && typeof props.useTabInfo === "function" ? props.useTabInfo() : null;
        tab = info ? info.tab : null;
      } catch (e) { ccvLog("dock 正文读 tab 信息失败: " + (e && e.message)); }
      return h("div", {
        style: {
          display: "flex", flexDirection: "column",
          height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden",
          background: "var(--dsw-alias-bg-layer-1, #fff)"
        }
      }, h(CanvasPanel, {
        ctx: ccvCtx,
        embedded: true,
        width: 0,
        onresize: function () {},
        onclose: function () {
          try { if (tab && tab.actions && typeof tab.actions.close === "function") tab.actions.close(); }
          catch (e) { ccvLog("关闭标签失败: " + (e && e.message)); }
        }
      }));
    }

    const inject = ["slots", "conversation", "sidebarRightTabs", "sidebarRight"];

    function apply(ctx) {
      ccvCtx = ctx;   // tab 正文是另一个组件，用的就是这个引用
      // ─── 会话内容限流 ──────────────────────────────
      // DSH 的会话消息不主动给 <img> 设 max-width，AI 生成的大图 / 截图会撑破
      // 会话列宽；右侧一旦打开话布（position:fixed、高 z-index），溢出的图片
      // 就被压在话布底下看不见。在 apply 入口注入一次，按列宽缩放。
      if (typeof document !== 'undefined' && !document.getElementById('ccv-cc-constrain')) {
        var s = document.createElement('style');
        s.id = 'ccv-cc-constrain';
        s.textContent =
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
          '}';
        document.head.appendChild(s);
      }
      // ─── 两行顶栏样式 ────────────────────────────
      // 上行管话布（＋新建 / 文件名切换 / 全屏），下行管当前文档（保存 / 重载 / 关闭）。
      // hover 与 disabled 用内联 style 表达不了（内联优先级还会盖掉 CSS 的 hover），
      // 所以走 className + 注入 CSS；选择器统一带 .ccv-panel 前缀提权（面板根自己的
      // class，悬浮/停靠两种摆法都命中），因此不需要 !important。
      if (typeof document !== 'undefined' && !document.getElementById('ccv-hdr2-style')) {
        var hs = document.createElement('style');
        hs.id = 'ccv-hdr2-style';
        hs.textContent = [
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
        ].join('\n');
        document.head.appendChild(hs);
      }
      // ─── Markdown 渲染样式（新 editor 用 .ccv-editor；旧 03-styles.js 的 .ccv-wysiwyg 已弃用）
      if (typeof document !== 'undefined' && !document.getElementById('ccv-md-style')) {
        var ms = document.createElement('style');
        ms.id = 'ccv-md-style';
        ms.textContent = [
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
        ].join('\n');
        document.head.appendChild(ms);
      }
      // ─── JS 终极兜底 ──────────────────────────────
      // 即使 CSS 选择器漏、即使 inline style 用了 !important (CSS 覆盖不了
      // inline !important) 都能压住。每秒 + 任何 DOM 新增都重扫一遍。
      // ⚠️ JS 必须严格无 inline `//` 注释——下面的代码会被拼成单行，注释到 EOF
      // 行为不可靠。这里用 \n 转义序列替代源换行，并把注释放进函数体内作为可
      // 运行的字符串字面量（不是真的 JS 注释，零运行时开销）。
      if (!document.getElementById('ccv-cc-constrain-js')) {
        try {
          var js = document.createElement('script');
          js.id = 'ccv-cc-constrain-js';
          js.textContent = [
            '(function(){',
            'var fix=function(root){',
            'var scope=root||document;',
            'var imgs=scope.querySelectorAll?scope.querySelectorAll("img"):[];',
            'for(var i=0;i<imgs.length;i++){',
            'var img=imgs[i];',
            'if(!img.isConnected)continue;',
            'var parent=img.parentElement||document.body;',
            'var pw=parent.clientWidth;',
            'if(!pw)continue;',
            'var w=img.offsetWidth||img.naturalWidth||0;',
            'if(w>pw+2){',
            'img.style.maxWidth="100%";',
            'img.style.maxHeight="100vh";',
            'img.style.width="100%";',
            'img.style.height="auto";',
            '}',
            '}',
            '};',
            'if(document.readyState!=="loading")fix();',
            'else document.addEventListener("DOMContentLoaded",fix);',
            'setInterval(fix,1000);',
            'try{',
            'new MutationObserver(function(muts){',
            'for(var i=0;i<muts.length;i++){',
            'var m=muts[i];',
            'if(m.addedNodes&&m.addedNodes.length)fix(document);',
            '}',
            '}).observe(document.body,{childList:true,subtree:true});',
            '}catch(e){}',
            '})();'
          ].join('\n');
          document.head.appendChild(js);
        } catch (e) {}
      }
      // ─── 顶栏「话布」按钮：默认不挂载（入口已在右侧栏门厅页）────────
      // 2026-09-12 撤下。理由：官方右侧栏的「开始」页已有「话布」入口卡片，
      // 顶栏按钮与它功能重复；且悬浮停用后按钮只剩「在右侧栏打开话布」一个作用，
      // 而这一步在门厅页点一下就是。留着只是占地方。
      // 只在 CCV_FLOAT_ENABLED = true（重新启用悬浮）时才注册回来 ——
      // 悬浮开关、拖拽条、停靠/悬浮模式菜单都挂在这个组件上，没有它悬浮无从开启。
      if (CCV_FLOAT_ENABLED) {
        ctx.slots.inject("conversation.session.header.utilities", () =>
          ctx.slots.register({
            name: "conversation.session.header.utilities",
            id: "collab-canvas-toggle",
            order: 50,
            label: () => "话布"
          }, CanvasToggle)
        );
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
