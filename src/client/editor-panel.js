// 画布编辑器客户端模块——通过 DSH composition 客户端加载器加载
window.__ModuleLoader__.load({
  id: "collab-canvas",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

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
    function ccvLog(msg) {
      try {
        fetch("/api/canvas/log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lines: [String(msg)] })
        }).then(function () {}, function () {});
      } catch (e) {}
    }
    function ccvDesc(el) {
      if (!el) return "null";
      return el.tagName + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.split(/\s+/).slice(0, 2).join(".") : "");
    }

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
    function CanvasPanel({ ctx, width, onclose, onresize }) {
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
      const editorRef = useRef(null);
      const saveTimer = useRef(null);
      const panelRef = useRef(null);
      const meterRef = useRef(null);

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
        if (isFull) { meterRef.current.textContent = "全屏"; return; }
        var col = conversationColumn();
        var colLeft = col ? Math.round(col.getBoundingClientRect().left) : -1;
        // L = 对话列左沿，用来判断侧边栏到底有没有把内容推走
        meterRef.current.textContent =
          Math.round(w) + " / " + (avail ? Math.round(avail) : "?") + "px · " +
          (isSidebarExpanded() ? "1:1" : "1:2") + " · L" + colLeft;
      }
      // 挂载后（CSS 已生效）测一次真实可用宽度
      useEffect(() => {
        var t = setTimeout(function () { updateMeter(width || 500, measureAvail()); }, 0);
        return function () { clearTimeout(t); };
      }, [isFull]);
      // 对话列尺寸一变（左侧栏收放、窗口缩放）就刷新读数
      useEffect(() => {
        var col = conversationColumn();
        if (!col) return;
        var ro = new ResizeObserver(function () {
          var w = panelRef.current ? panelRef.current.getBoundingClientRect().width : (width || 500);
          updateMeter(w, measureAvail());
        });
        ro.observe(col);
        return function () { ro.disconnect(); };
      }, [isFull]);

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

      // contentEditable 中的 <a href="#fn-..."> 默认不会跳转（浏览器只把光标移进去），
      // 用 capture 阶段捕获点击，阻止默认行为后手动 scrollIntoView。
      useEffect(function () {
        var ed = editorRef.current;
        if (!ed) return;
        function onClick(e) {
          var a = e.target.closest && e.target.closest('a[href^="#fn"]');
          if (!a) return;
          var href = a.getAttribute('href') || '';
          if (href.indexOf('#fn') !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          var id = href.slice(1);
          var target = document.getElementById(id) || ed.querySelector('[id="' + id + '"]');
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        ed.addEventListener('click', onClick, true);
        return function () { ed.removeEventListener('click', onClick, true); };
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
        fetch("/api/canvas/list").then(r => r.json()).then(d => {
          if (d.ok) { setCanvases(d.canvases); if (d.activeId) loadCanvas(d.activeId); }
        }).catch(() => {});
      }, []);

      function loadCanvas(id) {
        fetch("/api/canvas/read?id=" + encodeURIComponent(id)).then(r => r.json()).then(d => {
          if (d.ok) { setActiveId(d.id); setContent(d.content); setVersion(d.version); }
        }).catch(() => {});
      }

      function saveCanvas() {
        if (!activeId || !editorRef.current) return;
        const md = htmlToMd(editorRef.current);
        fetch("/api/canvas/write", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: activeId, content: md })
        }).then(r => r.json()).then(d => { if (d.ok) setVersion(d.version); }).catch(() => {});
      }

      // 在系统文件管理器里打开当前文档所在的文件夹（host 端调 explorer/open/xdg-open）
      function openFolder() {
        fetch("/api/canvas/open-folder", { method: "POST" })
          .then(r => r.json())
          .then(d => { ccvLog("open-folder 响应: " + JSON.stringify(d)); })
          .catch(e => { ccvLog("open-folder 请求失败: " + e); });
      }

      // ─── 顶栏：新建话布（行内输入框，替掉原生 prompt）──
      function startCreate() { setDropOpen(false); setNewTitle(""); setCreating(true); }
      function cancelCreate() { setCreating(false); setNewTitle(""); }
      function submitCreate() {
        const t = newTitle.trim();
        if (!t) { cancelCreate(); return; }
        fetch("/api/canvas/create", {
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
            case "div": case "p": return inner + "\n";
            case "h1": return "# " + inner + "\n";
            case "h2": return "## " + inner + "\n";
            case "h3": return "### " + inner + "\n";
            case "h4": return "#### " + inner + "\n";
            case "strong": case "b": return inner ? "**" + inner + "**" : "";
            case "em": case "i": return inner ? "*" + inner + "*" : "";
            case "u": return inner ? "<u>" + inner + "</u>" : "";
            case "strike": case "s": case "del": return inner ? "~~" + inner + "~~" : "";
            case "code": return "`" + inner + "`";
            case "pre": return "\n```\n" + (n.textContent || "") + "\n```\n";
            case "blockquote": return inner.trim() ? inner.trim().split("\n").map(l => "> " + l).join("\n") + "\n" : "";
            case "a":
              var href = n.getAttribute && n.getAttribute("href") || "";
              // 脚注引用链接：<a href="#fn-label">...</a> → [^label]
              if (href.indexOf("#fn-") === 0) {
                return "[^" + href.replace("#fn-", "") + "]";
              }
              return "[" + inner + "](" + href + ")";
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
        function im(s) {
          return esc(s)
            // 兼容旧版 htmlToMd 产生的 [[label]](#fn-label) 手写链接 → 转成规范脚注引用
            .replace(/\[\[([^\]]+)\]\]\(#fn-([^)]+)\)/g, '<a href="#fn-$2" id="fnref-$2" contenteditable="false" style="vertical-align:super;font-size:.75em;color:#3b82f6;cursor:pointer;text-decoration:none">[$2]</a>')
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
            .replace(/`([^`]+)`/g, "<code>$1</code>")
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/\*([^*]+)\*/g, "<em>$1</em>")
            .replace(/~~([^~]+)~~/g, "<del>$1</del>")
            .replace(/\[\^([^\]]+)\](?!:)/g, '<a href="#fn-$1" id="fnref-$1" contenteditable="false" style="vertical-align:super;font-size:.75em;color:#3b82f6;cursor:pointer;text-decoration:none">[$1]</a>');
        }
        var lines = String(src).split("\n"), out = [], i = 0, inCode = false, codeBuf = [];
        var footnotes = {}, fnOrder = [], fnIndex = 0;
        // 第一遍：收集脚注定义
        var mainLines = [];
        while (i < lines.length) {
          var l = lines[i];
          var fnDef = l.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
          if (fnDef) {
            var label = fnDef[1], content = fnDef[2];
            // 多行脚注定义：后续缩进行属于同一脚注
            while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]) && !/^\[\^/.test(lines[i + 1].trim())) {
              i++;
              content += " " + lines[i].trim();
            }
            footnotes[label] = content;
            i++;
            continue;
          }
          mainLines.push(l);
          i++;
        }
        // 第二遍：渲染正文
        i = 0; inCode = false; codeBuf = [];
        while (i < mainLines.length) {
          var l = mainLines[i];
          if (/^```/.test(l)) { if (!inCode) { inCode = true; codeBuf = []; } else { out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>"); inCode = false; } i++; continue; }
          if (inCode) { codeBuf.push(l); i++; continue; }
          var t = l.trim(); if (!t) { i++; continue; }
          var h2 = t.match(/^(#{1,6})\s+(.*)$/); if (h2) { out.push("<h" + h2[1].length + ">" + im(h2[2]) + "</h" + h2[1].length + ">"); i++; continue; }
          if (/^(-{3,}|\*{3,})$/.test(t)) { out.push("<hr/>"); i++; continue; }
          var bq = t.match(/^>\s?(.*)$/); if (bq) { out.push("<blockquote>" + im(bq[1]) + "</blockquote>"); i++; continue; }
          var ul = t.match(/^[-*]\s+(.*)$/); if (ul) { out.push("<ul><li>" + im(ul[1]) + "</li></ul>"); i++; continue; }
          var ol = t.match(/^(\d+)[.)]\s+(.*)$/); if (ol) { out.push("<ol><li>" + im(ol[2]) + "</li></ol>"); i++; continue; }
          out.push("<p>" + im(t) + "</p>"); i++;
        }
        if (inCode) out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>");
        // 渲染脚注区域
        var fnKeys = Object.keys(footnotes);
        if (fnKeys.length > 0) {
          out.push('<div class="footnotes"><hr/><ol>');
          fnKeys.forEach(function(label, idx) {
            var num = idx + 1;
            out.push('<li id="fn-' + label + '">' + im(footnotes[label]) + ' <a href="#fnref-' + label + '" contenteditable="false">↩</a></li>');
          });
          out.push('</ol></div>');
        }
        return out.join("\n");
      }

      // ─── 划词栏（参考豆包样式）──────────────────────
      // 下拉菜单状态 + 选区保存
      var activeDropdown = null
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
        activeDropdown = null
      }

      function showDropdown(anchor, items, onSelect) {
        closeDropdowns()
        saveSelection()
        var dd = document.createElement('div')
        dd.className = 'ccv-dropdown'
        dd.style.cssText = 'position:fixed;z-index:2147483001;background:rgba(255,255,255,.96);backdrop-filter:blur(12px);border:1px solid rgba(128,128,128,.2);border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.15);padding:4px 0;min-width:140px;font-size:13px;color:#1a1a1a'
        // 先添加所有内容
        items.forEach(function(item) {
          if (item.type === 'sep') {
            var sep = document.createElement('div')
            sep.style.cssText = 'height:1px;background:rgba(128,128,128,.15);margin:4px 0'
            dd.appendChild(sep)
            return
          }
          var row = document.createElement('div')
          row.style.cssText = 'padding:6px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;transition:background .1s;border-radius:0'
          row.textContent = item.label
          if (item.style) row.style.cssText += ';' + item.style
          if (item.active) { row.style.background = 'rgba(59,130,246,.1)'; row.style.color = '#3b82f6' }
          row.addEventListener('mouseenter', function() { row.style.background = 'rgba(128,128,128,.1)' })
          row.addEventListener('mouseleave', function() { row.style.background = item.active ? 'rgba(59,130,246,.1)' : 'transparent' })
          row.addEventListener('click', function(e) { e.stopPropagation(); closeDropdowns(); onSelect(item) })
          dd.appendChild(row)
        })
        document.body.appendChild(dd)
        // 再测量并定位
        var rect = anchor.getBoundingClientRect()
        var ddWidth = dd.offsetWidth
        var ddHeight = dd.offsetHeight
        var left = rect.left
        if (left + ddWidth > window.innerWidth - 8) left = rect.right - ddWidth
        if (left < 8) left = 8
        var top = rect.bottom + 4
        if (top + ddHeight > window.innerHeight - 8) top = Math.max(8, rect.top - ddHeight - 4)
        dd.style.left = left + 'px'
        dd.style.top = top + 'px'
        activeDropdown = dd
        // 点击外部关闭
        setTimeout(function() {
          document.addEventListener('mousedown', function close(ev) {
            if (!dd.contains(ev.target)) { closeDropdowns(); document.removeEventListener('mousedown', close) }
          })
        }, 0)
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
        { label: "💬 问AI", title: "将选中文本发送给 AI 问答", isAskAI: true },
        { type: "sep" },
        { label: "H", cmd: "formatBlock", val: "<h2>", title: "标题", isHeading: true, hasDropdown: true },
        { type: "sep" },
        { label: "≡", title: "对齐", hasDropdown: true, showAlign: true },
        { type: "sep" },
        { label: "<b>B</b>", cmd: "bold", title: "粗体" },
        { label: "<i>I</i>", cmd: "italic", title: "斜体" },
        { label: "<s>S</s>", cmd: "strikeThrough", title: "删除线" },
        { label: "U", cmd: "underline", title: "下划线", style: "text-decoration:underline" },
        { type: "sep" },
        { label: "⋮", title: "更多功能", hasDropdown: true, showFullMenu: true },
      ]

      // ─── 完整功能菜单（点击⋮展开）──────────────────────
      function showFullMenu(anchor) {
        var items = [
          { label: "行内代码", cmd: "inlineCode", icon: "`" },
          { label: "代码块", cmd: "codeBlock", icon: "{}" },
          { label: "引用", cmd: "blockquote", icon: "「」" },
          { label: "脚注", cmd: "footnote", icon: "¹" },
          { type: "sep" },
          { label: "无序列表", cmd: "insertUnorderedList", icon: "≡" },
          { label: "有序列表", cmd: "insertOrderedList", icon: "1." },
          { type: "sep" },
          { label: "链接", cmd: "link", icon: "🔗" },
          { label: "分割线", cmd: "insertHorizontalRule", icon: "—" },
        ]
        showDropdown(anchor, items, function(item) {
          restoreSelection()
          if (item.cmd === "inlineCode") {
            var sel = document.getSelection()
            var text = sel ? sel.toString() : "code"
            var html = '<code style="background:rgba(136,136,136,.15);padding:1px 4px;border-radius:3px;font-family:monospace;font-size:.9em">' + text + '</code>'
            document.execCommand("insertHTML", false, html)
          } else if (item.cmd === "codeBlock") {
            var sel = document.getSelection()
            var text = sel ? sel.toString() : "code"
            var html = '<pre style="background:#f5f5f5;padding:12px 16px;border-radius:6px;font-family:monospace;font-size:13px;line-height:1.5;overflow-x:auto;white-space:pre"><code>' + text + '</code></pre><div><br></div>'
            document.execCommand("insertHTML", false, html)
          } else if (item.cmd === "blockquote") {
            var sel = document.getSelection()
            var text = sel ? sel.toString() : "引用内容"
            var html = '<blockquote style="border-left:3px solid #ccc;padding-left:12px;margin:8px 0;color:#666">' + text + '</blockquote><div><br></div>'
            document.execCommand("insertHTML", false, html)
          } else if (item.cmd === "link") {
            var url = prompt("请输入链接地址：", "https://")
            if (url) document.execCommand("createLink", false, url)
          } else if (item.cmd === "footnote") {
            // 脚注：自动生成编号，插入引用标记，并在文末添加定义
            var label = prompt("脚注标签（如 1、2、a）：", "")
            if (label) {
              // 插入脚注引用：显示 [label]，点击跳到脚注
              var html = '<a href="#fn-' + label + '" id="fnref-' + label + '" contenteditable="false" style="vertical-align:super;font-size:.75em;color:#3b82f6;cursor:pointer;text-decoration:none">[' + label + ']</a>'
              document.execCommand("insertHTML", false, html)
              // 在编辑器末尾追加脚注定义（如果不存在）
              var ed = editorRef.current
              if (ed) {
                var existing = ed.querySelector('#fn-' + label)
                if (!existing) {
                  // 找到或创建 .footnotes 容器
                  var fnDiv = ed.querySelector('.footnotes')
                  if (!fnDiv) {
                    fnDiv = document.createElement('div')
                    fnDiv.className = 'footnotes'
                    fnDiv.innerHTML = '<hr/>'
                    var ol = document.createElement('ol')
                    fnDiv.appendChild(ol)
                    ed.appendChild(fnDiv)
                  }
                  var ol = fnDiv.querySelector('ol')
                  var li = document.createElement('li')
                  li.id = 'fn-' + label
                  li.innerHTML = '脚注 ' + label + ' 的内容 <a href="#fnref-' + label + '" contenteditable="false" style="color:#3b82f6;text-decoration:none">↩</a>'
                  ol.appendChild(li)
                  // 滚动到脚注区域
                  li.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }
              }
            }
          } else {
            document.execCommand(item.cmd, false, item.val)
          }
          if (editorRef.current) editorRef.current.focus()
        })
      }
      var selectionFormats = { bold: false, italic: false, underline: false, heading: null }

      function onEditorMouseUp() {
        try {
          ccvLog("mouseup: enter")
          var sel = document.getSelection()
          if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
            ccvLog("mouseup: 选区为空 -> hide (sel=" + (sel ? "collapsed" : "null") + ")")
            hideSelbar(); return
          }
          var rect = sel.getRangeAt(0).getBoundingClientRect()
          ccvLog("mouseup: rect w=" + Math.round(rect.width) + " h=" + Math.round(rect.height) + " l=" + Math.round(rect.left) + " t=" + Math.round(rect.top))
          if (!rect || (!rect.width && !rect.height)) {
            ccvLog("mouseup: rect 空 -> hide")
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
          if (isActive) { btn.dataset.active = '1'; btn.style.background = 'rgba(59,130,246,.15)'; btn.style.color = 'var(--dsw-alias-brand-primary,#3b82f6)' }
          btn.addEventListener('mousedown', function(e) { e.preventDefault() })
          btn.addEventListener('click', function(e) {
            e.stopPropagation()
            if (item.isAskAI) {
              // 问 AI：获取选中文本，设置引用 + 插入到输入框
              var sel = document.getSelection()
              var text = sel ? sel.toString().trim() : ''
              if (!text) { alert('请先选中要问 AI 的文本'); return }
              hideSelbar()
              // 插入到输入框（引用块格式）
              var input = document.querySelector('[data-slot="conversation.input"] textarea') ||
                          document.querySelector('[data-slot="conversation.composer"] textarea') ||
                          document.querySelector('textarea[placeholder*="发消息"]') ||
                          document.querySelector('textarea[placeholder*="说话"]')
              if (input) {
                var quote = '> ' + text + '\n\n'
                var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
                nativeInputValueSetter.call(input, quote + input.value)
                input.dispatchEvent(new Event('input', { bubbles: true }))
                input.focus()
              }
            } else if (item.hasDropdown) {
              if (item.isHeading) showHeadingDropdown(btn)
              else if (item.showAlign) showAlignDropdown(btn)
              else if (item.showFullMenu) showFullMenu(btn)
            } else {
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
        var fin = bar.getBoundingClientRect()
        ccvLog('showSelbar: 完成 bw=' + bw + ' bh=' + bh + ' x=' + x + ' y=' + y +
          ' | display=' + bar.style.display +
          ' | 实际渲染 w=' + Math.round(fin.width) + ' h=' + Math.round(fin.height) +
          ' l=' + Math.round(fin.left) + ' t=' + Math.round(fin.top) +
          ' | offsetParent=' + ccvDesc(bar.offsetParent) +
          ' | parent=' + ccvDesc(bar.parentElement))
        // 沿祖先链找第一个会裁剪 fixed 子元素的容器（有 overflow 且非 visible）
        var n = bar.parentElement, clip = 'none'
        while (n && n !== document.documentElement) {
          var ov = getComputedStyle(n).overflow
          if (ov && ov !== 'visible') { clip = ccvDesc(n) + ' overflow=' + ov; break }
          n = n.parentElement
        }
        ccvLog('showSelbar: 裁剪祖先 ' + clip)
      }
      function hideSelbar() {
        var bar = document.getElementById('ccv-selbar');
        if (bar) bar.style.display = 'none';
        var st = ''
        try { st = (new Error()).stack || '' } catch (e) {}
        var line = st.split('\n')[2] || ''
        ccvLog('hideSelbar: 调用 bar=' + (bar ? 'yes' : 'MISSING') + ' 来自 ' + String(line).trim())
      }

      // ─── 样式 ──────────────────────────────────────
      var S = {
        // 定位/宽高/边框由注入的 CSS（!important）统一控制，这里只放外观
        // 内层根 div 必须填满 #collab-canvas-panel 宿主（flex 列、高 100vh），
        // 否则它没有确定高度 → 编辑区 flex:1 1 0% 解析成 0 → 内容被压没、overflowY 失效、滚轮滚不动。
        panel: { flex: "1 1 0%", minHeight: 0, background: "var(--dsw-alias-bg-layer-1, #fff)", color: "var(--dsw-alias-label-primary, #1a1a1a)", display: "flex", flexDirection: "column", fontFamily: "var(--font-ui, system-ui, sans-serif)" },
        drag: { position: "absolute", left: -4, top: 0, bottom: 0, width: 8, cursor: "col-resize", zIndex: 10 },
        editor: { flex: "1 1 0%", minHeight: 0, overflowY: "auto", padding: narrow ? "14px 16px" : "24px 32px", outline: "none", fontSize: 14, lineHeight: 1.75, wordBreak: "break-word" }
      };

      // 当前话布标题：canvases 里找 activeId 对应的那条
      let curTitle = "";
      for (let i = 0; i < canvases.length; i++) {
        if (canvases[i].id === activeId) { curTitle = canvases[i].title; break; }
      }

      return h("div", { ref: panelRef, style: S.panel },
        // 窄屏没有分栏，也就不需要拖拽条
        narrow ? null : h("div", { style: S.drag, onMouseDown: onDragStart }),
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
                      ? canvases.map(c => h("button", {
                          key: c.id, className: "ccv-drop-item", "data-on": c.id === activeId ? "1" : "0",
                          title: c.title,
                          onClick: () => { loadCanvas(c.id); setDropOpen(false); }
                        }, c.title))
                      : h("div", { className: "ccv-drop-empty" }, "还没有话布，点 ＋ 新建一个")
                  ) : null
                ),
            h("div", { className: "ccv-spacer" }),
            // 窄屏始终全屏，没有可切换的余地，隐藏这个按钮
            narrow ? null : h("button", { className: "ccv-ibtn", onClick: toggleFullscreen, title: isFull ? "退出全屏" : "全屏" }, isFull ? "❐" : "⛶"),
            h("button", { className: "ccv-ibtn", onClick: onclose, title: "关闭话布" }, "×")
          ),
          // ─── 第二行：管当前文档（保存 / 重载）───
          h("div", { className: "ccv-row ccv-row-doc" },
            h("button", { className: "ccv-tbtn", onClick: saveCanvas, disabled: !activeId, title: "保存到服务端（停止输入 1.5 秒后也会自动存）" }, "保存"),
            h("button", { className: "ccv-tbtn", onClick: () => { if (activeId) loadCanvas(activeId); }, disabled: !activeId, title: "从服务端拉取最新内容 —— AI 在对话里改过话布后用它同步" }, "重载"),
            h("button", { className: "ccv-ibtn", onClick: openFolder, title: "在文件管理器中打开本文档所在的文件夹",
              dangerouslySetInnerHTML: { __html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:auto"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>' } }),
            h("div", { className: "ccv-spacer" }),
            h("span", {
              ref: meterRef, className: "ccv-meter",
              title: "话布宽度 /（会话区 + 话布）可用宽度 —— 左侧栏不计入"
            }, isFull ? "全屏" : (width || 500) + " / ?px")
          )
        ),
        h("div", {
          ref: editorRef, contentEditable: true, suppressContentEditableWarning: true, style: S.editor,
          dangerouslySetInnerHTML: { __html: mdToHtml(content) },
          onInput: () => { clearTimeout(saveTimer.current); saveTimer.current = setTimeout(saveCanvas, 1500); },
          onMouseUp: onEditorMouseUp
        }),
        // width:max-content + flexWrap:nowrap —— 让栏按内容取自然宽度，
        // 绝不被 left 位置挤窄；放不下时由 showSelbar 整体左移，而不是内部折行。
        h("div", { id: "ccv-selbar", style: { position: "fixed", zIndex: 100000, display: "none", alignItems: "center", gap: 1, width: "max-content", maxWidth: "none", flexWrap: "nowrap", flexShrink: 0, background: "var(--dsw-specific-menu, var(--dsw-alias-bg-overlay, #fff))", color: "var(--dsw-alias-label-primary, #1a1a1a)", border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))", borderRadius: 10, boxShadow: "0 4px 20px rgba(0,0,0,.15)", padding: "3px 6px", userSelect: "none", WebkitUserSelect: "none", backdropFilter: "blur(12px) saturate(150%)", WebkitBackdropFilter: "blur(12px) saturate(150%)", background: "rgba(255,255,255,.92)" } })
      );
    }

    // ─── Header 按钮组件 ─────────────────────────────────
    function CanvasToggle({ ctx }) {
      const [open, setOpen] = useState(false);
      const [panelRoot, setPanelRoot] = useState(null);
      // ratio = 话布宽度 / 可用宽度（会话区 + 话布）。初始 1/3：会话占 2/3。
      const [ratio, setRatio] = useState(1 / 3);
      const [currentW, setCurrentW] = useState(500);

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
          var div = document.createElement("div");
          div.id = "collab-canvas-panel";
          // 面板是 fixed 的，直接挂 body：不进 #root 的 Grid，不会成为 grid item
          document.body.appendChild(div);
          var r = ReactDOMClient.createRoot(div);
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
        if (panelRoot) { panelRoot.remove(); }
        var el = document.getElementById("root");
        if (el) el.classList.remove("ccv-open", "ccv-full");
        document.body.removeAttribute("data-ccv-dragging");
        compressMainContent(0);
      }, []);

      return h("button", {
        onClick: toggle,
        style: {
          padding: "4px 10px", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
          borderRadius: 6, background: open ? "rgba(59,130,246,.15)" : "transparent",
          color: open ? "var(--dsw-alias-brand-primary, #3b82f6)" : "var(--dsw-alias-label-primary, #1a1a1a)",
          cursor: "pointer", fontSize: 13, fontFamily: "inherit"
        },
        title: "话布编辑器"
      }, "话布");
    }

    // ─── 插件注册 ──────────────────────────────────────
    const inject = ["slots", "conversation"];

    function apply(ctx) {
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
          '#collab-canvas-panel img,' +
          '#collab-canvas-panel .ccv-editor img{' +
            'max-width:100%!important;' +
          '}' +
          // 不让 #root / body / 浮层超出视口横向滚动
          'html,body,#root{' +
            'overflow-x:hidden!important;' +
          '}' +
          '[data-slot="conversation"] pre,' +
          '[data-pane="conversation"] pre,' +
          // 长 <pre> 也按列宽走横向滚动，避免撑破话布面板
          '#collab-canvas-panel .ccv-editor pre{' +
            'max-width:100%!important;' +
            'overflow-x:auto!important;' +
          '}';
        document.head.appendChild(s);
        // ─── 两行顶栏样式 ────────────────────────────
        // 上行管话布（＋新建 / 文件名切换 / 全屏），下行管当前文档（保存 / 重载 / 关闭）。
        // hover 与 disabled 用内联 style 表达不了（内联优先级还会盖掉 CSS 的 hover），
        // 所以走 className + 注入 CSS；选择器统一带 #collab-canvas-panel 前缀提权，
        // 因此不需要 !important。
        if (typeof document !== 'undefined' && !document.getElementById('ccv-hdr2-style')) {
          var hs = document.createElement('style');
          hs.id = 'ccv-hdr2-style';
          hs.textContent = [
            '#collab-canvas-panel .ccv-head{display:flex;flex-direction:column;flex:0 0 auto;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25))}',
            '#collab-canvas-panel .ccv-row{display:flex;align-items:center;gap:6px;padding:5px 8px;flex-wrap:nowrap;overflow:visible;min-width:0}',
            '#collab-canvas-panel .ccv-row-top{position:relative}',
            '#collab-canvas-panel .ccv-row-doc{border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14))}',
            '#collab-canvas-panel .ccv-ibtn{width:26px;height:26px;display:flex;align-items:center;justify-content:center;background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:6px;color:inherit;cursor:pointer;font-size:13px;font-family:inherit;line-height:1;padding:0;flex:0 0 auto;white-space:nowrap}',
            '#collab-canvas-panel .ccv-ibtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15))}',
            '#collab-canvas-panel .ccv-ibtn:disabled{opacity:.35;cursor:default}',
            '#collab-canvas-panel .ccv-ibtn:disabled:hover{background:transparent}',
            '#collab-canvas-panel .ccv-tbtn{padding:4px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:6px;background:transparent;color:inherit;font-size:12px;font-family:inherit;cursor:pointer;flex:0 0 auto;white-space:nowrap;line-height:1.4}',
            '#collab-canvas-panel .ccv-tbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15))}',
            '#collab-canvas-panel .ccv-tbtn:disabled{opacity:.35;cursor:default}',
            '#collab-canvas-panel .ccv-tbtn:disabled:hover{background:transparent}',
            '#collab-canvas-panel .ccv-chip{display:flex;align-items:center;gap:6px;padding:4px 6px 4px 8px;background:var(--dsw-alias-interactive-bg-active,rgba(59,130,246,.16));border:1px solid var(--dsw-alias-brand-primary,rgba(59,130,246,.4));border-radius:7px;max-width:240px;min-width:56px;flex:0 1 auto;font-size:13px;color:inherit;cursor:pointer;user-select:none}',
            '#collab-canvas-panel .ccv-chip:hover{filter:brightness(1.06)}',
            '#collab-canvas-panel .ccv-chipwrap{position:relative;display:flex;min-width:0;flex:0 1 auto}',
            '#collab-canvas-panel .ccv-chip-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}',
            '#collab-canvas-panel .ccv-chip-caret{flex:0 0 auto;font-size:10px;line-height:1;opacity:.65}',
            '#collab-canvas-panel .ccv-spacer{flex:1 1 0%;min-width:6px}',
            '#collab-canvas-panel .ccv-ninput{width:150px;flex:0 1 auto;min-width:64px;padding:4px 8px;border:1px solid var(--dsw-alias-brand-primary,rgba(59,130,246,.5));border-radius:6px;background:transparent;color:inherit;font-size:13px;font-family:inherit;outline:none;line-height:1.4}',
            '#collab-canvas-panel .ccv-drop{position:absolute;top:calc(100% + 3px);left:0;z-index:60;min-width:200px;max-width:min(260px,80vw);max-height:52vh;overflow-y:auto;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:8px;padding:4px;box-shadow:0 4px 14px rgba(0,0,0,.12)}',
            '#collab-canvas-panel .ccv-drop-item{display:block;width:100%;text-align:left;padding:6px 8px;border:none;background:transparent;color:inherit;font-size:13px;font-family:inherit;cursor:pointer;border-radius:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;box-sizing:border-box}',
            '#collab-canvas-panel .ccv-drop-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(59,130,246,.16))}',
            '#collab-canvas-panel .ccv-drop-item[data-on="1"]{font-weight:600;background:var(--dsw-alias-interactive-bg-active,rgba(59,130,246,.2))}',
            '#collab-canvas-panel .ccv-drop-empty{padding:8px;opacity:.6;font-size:12px;text-align:center}',
            '#collab-canvas-panel .ccv-meter{font-size:11px;opacity:0;transition:opacity .15s ease;white-space:nowrap;user-select:none;font-variant-numeric:tabular-nums;flex:0 0 auto}',
            // 脚注区域样式
            '#collab-canvas-panel .ccv-editor .footnotes{margin-top:16px;padding-top:8px;font-size:13px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.85))}',
            '#collab-canvas-panel .ccv-editor .footnotes hr{border:none;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));margin:0 0 8px}',
            '#collab-canvas-panel .ccv-editor .footnotes ol{margin:0;padding-left:20px}',
            '#collab-canvas-panel .ccv-editor .footnotes li{margin:4px 0;line-height:1.6}',
            '#collab-canvas-panel .ccv-editor .footnotes a{color:#3b82f6;text-decoration:none}'
          ].join('\n');
          document.head.appendChild(hs);
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
      }
      // 注册话布按钮
      ctx.slots.inject("conversation.session.header.utilities", () =>
        ctx.slots.register({
          name: "conversation.session.header.utilities",
          id: "collab-canvas-toggle",
          order: 50,
          label: () => "话布"
        }, CanvasToggle)
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
