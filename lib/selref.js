// ═══ DSH Collab-Canvas · 选区引用（独立功能模块，单独一个文件维护）═══
//
// 目标：把话布里选中的一段话，变成 DSH 输入框里一个「引用胶囊」——
//       可点、整块删除、按发送时自动翻译成带定位信息的上下文。
//       设计稿：canvas-docs/话布选区引用方案.md（v3）
//
// 加载方式：与 docdrop / doclink 完全相同 —— host 端点 /api/canvas/selref.js
//           提供源码，client 入口动态执行。**改本文件只需刷新页面，不用重启。**
//
// ── 与主模块的通信（重要）────────────────────────────────────────────
// 侧模块由 new Function(src)() 执行，作用域是**全局**，拿不到主模块的局部变量
// （React / h / ccvLog 等全都不可见）。所以两边只靠 window 上的约定握手：
//
//   window.__ccvKit        主模块提供的共用工具（log / toast），取不到就用自带副本
//   window.__ccvCtx        主模块 apply(ctx) 时挂上的 cordis 根上下文
//   window.__ccvSelRefBridge  主模块挂的「取数桥」：doc() / editor() / range()
//   window.__ccvSelRefCapture 本模块挂出去的「记一笔」入口，主模块喊这一声
//
// 分工（设计稿第十节）：**主文件只挂桥、不搬逻辑**；算位置、存记录、写翻译
// 全部留在本文件里。所以主文件那侧永远只有几行，不会随本功能一起长胖。
//
// 侧模块与 apply 的先后顺序**不固定**（两边都是异步启动），故双向握手：
//   · 主模块先 apply   → 侧模块加载时看到 __ccvCtx，立刻自举
//   · 侧模块先加载     → 挂出 __ccvSelRefBoot，等主模块 apply 时来调
//
// ── 分步实施（设计稿第十一节）──────────────────────────────────────
//   第 1 步【已完成 20:19】空壳 + 加载自检 + 握手 + 依赖探活
//   第 2 步【已完成 20:32】注册引用源 + 假候选 + 假翻译
//                         实测：菜单出「话布选区」→ 点选出胶囊 → 发送被翻译
//   第 3 步【已完成】接真实选区数据 + 真翻译
//   第 4 步【已完成】自动两步：点「问AI」→ 替你开菜单 → 替你选中 → 胶囊直接进输入框
//   第 5 步【方案转向】定位不再写进引用正文，改由 host 侧的 canvas_locate 工具按需回答；
//                     「第几处」是唯一跨端一致的位置信号（顺带把过期校验一起做了）
//   第 6 步【已完成】AI 改完**跳过去给你看**：轮询服务端记下的改动 → 切文档（需要的话）
//                 → 在画布里找到改动处 → 滚动 + 选中，主人当场核对
//                 ⚠️ 这一步依赖 host 新增的 /api/canvas/changes 端点 → **必须重启 dsh web**
//   第 7 步【2026-09-15】插入胶囊不再依赖菜单：改成直接派发官方的会话级事件
//                        （'slash/input-insert-reference'，带草稿版本校验）。
//                        起因：草稿里已经有内容时，菜单会被输入状态刷新带关，
//                        第二条引用必然失败 → 退到一条会拍平已有胶囊的老路。
//   第 8 步【本版】把最后的兜底也改成"往末尾追加纯文字"（官方 insert-text 事件），
//                 并且**严禁在草稿里已有胶囊时整体重写草稿** ——
//                 整体重写时胶囊只剩纯文字形态，等于把主人前面所有引用毁掉。
//
// 健壮性约定：与 docdrop / doclink 相同 —— 防重复安装、失败静默降级、
//             任何异常都不许影响画布本体。
;(function () {
  try {
    if (window.__ccvSelRefInstalled) return
    window.__ccvSelRefInstalled = true

    var VERSION = 7

    // 日志：优先借用主模块的共用实现，取不到就自带一份同样的 POST。
    function log(msg) {
      var kit = window.__ccvKit
      if (kit && kit.log) { kit.log(msg, "selref"); return }
      try {
        fetch("/api/canvas/log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ line: "[selref] " + msg })
        }).catch(function () {})
      } catch (_) {}
    }

    // 三个依赖服务：sessions（拿会话作用域）、conversation（输入框句柄）、
    // inputTriggers（注册引用源 —— 新方案的地基）。
    // ⚠️ 它们必须在主模块的 inject 里声明，运行时 ctx.get 是取不到的。
    function missingServices(ctx) {
      if (!ctx) return ["<空上下文>"]
      var probe = {
        sessions: function () { return ctx.sessions || (ctx.get && ctx.get("sessions")) },
        conversation: function () { return ctx.conversation || (ctx.get && ctx.get("conversation")) },
        inputTriggers: function () { return ctx.inputTriggers || (ctx.get && ctx.get("inputTriggers")) }
      }
      var out = []
      for (var k in probe) {
        var v = null
        try { v = probe[k]() } catch (_) { v = null }
        if (!v) out.push(k)
      }
      return out
    }

    // ═══ 一、记录表（编号 → 选区详情）═══════════════════════════════
    // 第一版只存浏览器内存，刷新即清空（设计稿第七节：不落盘、不设 TTL）。
    // 为什么可以这样：翻译发生在浏览器里，而刷新后输入框里的胶囊本身也会
    // 退化成复制文本（设计稿风险 3），不会出现"胶囊还在但记录没了"的哑弹。
    var records = []
    var nextCode = 1
    var MAX_RECORDS = 20   // 防失控上限（设计稿第十二节）
    var LABEL_MAX = 12     // 胶囊显示文字上限，太长会撑爆输入框
    var lastCandCount = -1 // 只为「菜单条数变化时记一行日志」，不参与业务

    function shrink(s, max) {
      s = String(s || "").replace(/\s+/g, " ").trim()
      return s.length > max ? s.slice(0, max) + "…" : s
    }

    function findRecord(code) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].code === code) return records[i]
      }
      return null
    }

    // ═══ 二、把编辑区摊平成纯文字 ═══════════════════════════════════
    // 为什么要自己摊：DOM 的 Range.toString() **不含块与块之间的换行**，
    // 而我们要报的"第几行 / 前后文"必须按人看到的行来算。
    // 做法：从编辑区根节点深度遍历；遇到块级元素补一个换行；
    //       边遍历边记下每个节点在整串里的起始下标（后面 O(1) 定位选区）。
    var BLOCK_TAGS = {
      DIV: 1, P: 1, LI: 1, UL: 1, OL: 1, BLOCKQUOTE: 1, PRE: 1,
      H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
      TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TD: 1, TH: 1,
      SECTION: 1, ARTICLE: 1, FIGURE: 1, FIGCAPTION: 1, HR: 1
    }

    function flatText(root) {
      var text = ""
      var startOf = new Map()   // 任意节点 → 它在整串里的起始下标
      function closeBlock(isBlock) {
        if (isBlock && text.length && text.charAt(text.length - 1) !== "\n") text += "\n"
      }
      function walk(node) {
        if (node.nodeType === 3) { startOf.set(node, text.length); text += node.data; return }
        if (node.nodeType !== 1) return
        var tag = node.tagName
        if (tag === "SCRIPT" || tag === "STYLE") return
        if (tag === "BR") { startOf.set(node, text.length); text += "\n"; return }
        var isBlock = !!BLOCK_TAGS[tag]
        closeBlock(isBlock)                     // 块前的分隔换行
        startOf.set(node, text.length)          // 记在换行之后，两端才自洽
        for (var i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i])
        closeBlock(isBlock)                     // 块后的分隔换行
      }
      walk(root)
      return { text: text, startOf: startOf }
    }

    // 选区起点在整串里的下标。端点是文字节点（绝大多数情况）直接查表；
    // 端点是元素节点（三击选整段之类）就先看它指向的那个子节点。
    function offsetOf(flat, container, offset) {
      if (!container) return -1
      if (container.nodeType === 3) {
        var base = flat.startOf.get(container)
        return (base === undefined) ? -1 : base + (offset || 0)
      }
      if (container.nodeType === 1) {
        var kids = container.childNodes
        var child = (offset >= 0 && offset < kids.length) ? kids[offset] : null
        if (child) {
          var b = flat.startOf.get(child)
          if (b !== undefined) return b
        }
        var s = flat.startOf.get(container)
        if (s === undefined) return -1
        return s + String(container.textContent || "").length
      }
      return -1
    }

    // 最近的小标题：取"起点在选区之前"的最后一个标题；没有就空着。
    function nearestHeading(editor, flat, offset) {
      try {
        var hs = editor.querySelectorAll("h1,h2,h3,h4,h5,h6")
        var best = ""
        for (var i = 0; i < hs.length; i++) {
          var s = flat.startOf.get(hs[i])
          if (s === undefined) continue
          if (offset >= 0 && s > offset) break
          best = String(hs[i].textContent || "").replace(/\s+/g, " ").trim()
        }
        return best
      } catch (_) { return "" }
    }

    // ═══ 三、「记一笔」：把当前选区算成一条记录 ═════════════════════
    // 主模块在点「问AI」的那一刻喊一声（__ccvSelRefCapture），我们从桥上取数。
    // ⚠️ 这一刻过去之后浏览器选区就塌了（输入框抢焦点），所以必须当场算完。
    // 某段文字在全文里出现几次（允许重叠：`aaaa` 里的 `aa` 要数出 3 次）。
    // ⚠️ 只用来决定引用标签里要不要标「多处」——**定位本身不在这里做**：
    // 那交给 host 侧的 canvas_locate 工具（模型按需来问，它读的是当前文档，
    // 顺带还能回答"这段引用是不是已经失效"）。
    function countOcc(text, needle) {
      if (!needle) return 0
      var n = 0, i = 0
      while ((i = text.indexOf(needle, i)) >= 0) { n++; i += 1 }
      return n
    }

    // 用户选中的那处**是第几处**（按出现顺序，从 1 数）。
    // 这是**唯一不靠前后文就能把位置说清**的信息 —— 而且它跨端口径一致：
    // 渲染前后文字的出现顺序不变，所以客户端（按渲染结果数）与 host 侧
    // （按 Markdown 源码数）数出来的"第几处"是同一个数。
    // 对不上（比如选区起点落在某个匹配的中间）就返回 0，此时引用里只标「多处」。
    function ordinalOf(text, needle, off) {
      if (!needle || off < 0) return 0
      var n = 0, i = 0
      while ((i = text.indexOf(needle, i)) >= 0) {
        n++
        if (i === off) return n
        if (i > off) return 0
        i += 1
      }
      return 0
    }

    function capture() {
      try {
        var br = window.__ccvSelRefBridge
        if (!br) { log("capture: 主模块的取数桥还没挂上，本次不记录"); return null }

        var doc = null, editor = null, range = null
        try { doc = br.doc ? br.doc() : null } catch (_) {}
        try { editor = br.editor ? br.editor() : null } catch (_) {}
        try { range = br.range ? br.range() : null } catch (_) {}

        if (!doc || !doc.id) { log("capture: 当前没有打开的话布，本次不记录"); return null }
        if (!editor || !range) { log("capture: 取不到选区，本次不记录"); return null }

        var selected = String(range.toString() || "")
        if (!selected.trim()) { log("capture: 选区是空的，本次不记录"); return null }

        var flat = flatText(editor)
        var off = offsetOf(flat, range.startContainer, range.startOffset)

        var line = -1
        if (off >= 0) line = flat.text.slice(0, off).split("\n").length

        // 原文在全文出现几次 —— 只用来决定"要不要在标签里标「多处」"。
        // 真正的定位交给 host 侧的 canvas_locate 工具：模型按需来问，
        // 那边读的是**当前**文档，顺带还能判断这段引用是不是已经失效。
        var dup = (off >= 0) ? countOcc(flat.text, selected) : 0
        // 「你选的是第几处」—— 有歧义时才算，没歧义时这个数没有意义
        var ord = (dup > 1) ? ordinalOf(flat.text, selected, off) : 0

        var rec = {
          code: nextCode++,
          at: Date.now(),
          doc: {
            id: doc.id,
            title: doc.title || "(未命名)",
            // mention 是主模块按官方引号规则算好的 @"绝对路径"，直接沿用不另写一份
            mention: doc.mention || "",
            version: doc.version
          },
          selected: selected,
          length: selected.length,
          offset: off,
          line: line,
          heading: off >= 0 ? nearestHeading(editor, flat, off) : "",
          dupCount: dup,
          // 用户选的是第几处（0 = 没对上，比如选区起点落在某个匹配的中间）
          ordinal: ord
        }

        records.unshift(rec)                       // 新的排最前
        if (records.length > MAX_RECORDS) records.length = MAX_RECORDS

        log("已记录选区 #" + rec.code + "：《" + rec.doc.title + "》"
          + (rec.heading ? " · " + rec.heading : "")
          + (rec.line > 0 ? " · 第 " + rec.line + " 行" : " · 位置未取到")
          + " · " + rec.length + " 字「" + shrink(rec.selected, 16) + "」"
          + (rec.dupCount > 1
              ? " ⚠️ 原文在全文出现 " + rec.dupCount + " 次"
                + (rec.ordinal > 0 ? "，你选的是第 " + rec.ordinal + " 处" : "（序数没对上，只标「多处」）")
                + " → 随引用一起报给服务端（正文里已经不写坐标了）"
              : ""))
        pinUp(rec)
        return rec
      } catch (e) {
        log("capture 失败: " + (e && e.message))
        return null
      }
    }

    // ── 把「这一段到底是第几处」单独报给服务端 ──────────────────────
    // 为什么非要单独报：引用正文里已经不写坐标了（主人要求卡片只留文件名），
    // 而"第几处"只有**划选那一刻**在浏览器里才算得出来（靠 DOM 选区位置），
    // 服务端自己无论如何算不出 —— 它只知道原文是什么，不知道你选的是哪一处。
    //
    // 时机：capture() 成功时立刻送。比"用户按发送"早得多（中间还要打字），
    //       所以服务端那边早就存好了，**不存在"消息先到、记录后到"的竞态**。
    //       （这正是当初不敢在 serialize 时才上报的原因 —— 那一步离发送太近。）
    // 送不出去不影响任何事：服务端找不到这份记录时会退化成「分不出是哪一处，
    //       请让用户确认」，那是安全的降级，不是错误。
    function pinUp(rec) {
      try {
        var p = fetch("/api/canvas/selref/pin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code: rec.code,
            docId: rec.doc.id,
            path: bareMention(rec.doc.mention),
            title: rec.doc.title || "",
            text: rec.selected,
            ordinal: rec.ordinal || 0,
            dupCount: rec.dupCount || 0,
            line: rec.line || -1,
            heading: rec.heading || ""
          })
        })
        if (p && typeof p.catch === "function") p.catch(function () {})
      } catch (e) { /* 送不出去就算了，服务端按"没收到"降级 */ }
    }

    // mention 是主模块算好的 @"绝对路径"（带 @ 和一对引号），服务端要的是裸路径
    function bareMention(m) {
      var s = String(m || "")
      if (s.charAt(0) === "@") s = s.slice(1)
      if (s.length >= 2 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') s = s.slice(1, -1)
      return s
    }

    // ═══ 四、引用源定义 ═════════════════════════════════════════════
    // 官方机制：想让输入框里出现胶囊，必须先在 inputTriggers 里挂一个 source。
    // 官方自带 @文件 / @会话 两个 —— 这里是第三个。
    //
    // ⚠️ name 有两个身份：① 菜单分组标题 ② 发送时翻译路由的 key
    //    （草稿里每个胶囊记着自己的 source，提交时按它找回本源的 codec）。
    //    它必须与官方及任何其他插件不重名，否则 registerSource 直接抛错。
    var SOURCE_NAME = "话布选区"

    // 胶囊的「出厂设置」。**只有这一处** —— 点菜单插入和直接插入都用它，
    // 否则两条路出来的胶囊会长得不一样（显示的字、退化后的文字都不同）。
    function chipPayload(rec) {
      if (!rec) return { source: SOURCE_NAME, ref: "", label: "话布选区", appearance: "file", clipboardText: "@" + SOURCE_NAME }
      return {
        source: SOURCE_NAME,
        ref: String(rec.code),
        // 胶囊上显示的字：选中文字的前 12 字
        label: shrink(rec.selected, LABEL_MAX),
        appearance: "file",           // 图标：官方只给 file / folder / session
        // 刷新页面后持久化草稿里的胶囊会退化成这行纯文字（设计稿风险 3），
        // 所以写成人类也读得懂的「@文档 > 选中文字」，退化后仍可用。
        clipboardText: "@" + rec.doc.title + " > " + shrink(rec.selected, 40)
      }
    }

    function makeSource() {
      return {
        trigger: "@",
        name: SOURCE_NAME,
        order: 50,              // 排在官方 @文件 / @会话 之后（它们默认 0）
        showGroupTitle: true,   // 菜单里显示分组标题，即上面的 name
        candidates: function () {
          // 一条记录 = 一个候选。菜单显示可以长一点（20 字），
          // 真正进输入框的胶囊再缩到 12 字。
          var items = records.map(function (r) {
            var bits = [r.doc.title]
            if (r.heading) bits.push(r.heading)
            if (r.line > 0) bits.push("第 " + r.line + " 行")
            return {
              name: shrink(r.selected, 20),
              description: bits.join(" · "),
              icon: "file",
              value: String(r.code)
            }
          })
          // 菜单每敲一个字都会来取一次，只在条数变化时记一行 ——
          // 否则「菜单空着」这种情况没法区分是没记到还是没注册上。
          if (items.length !== lastCandCount) {
            lastCandCount = items.length
            log("菜单取候选：当前 " + items.length + " 条"
              + (items.length ? "" : "（还没记过选区 —— 先在话布里划一段字、点「问AI」）"))
          }
          return Promise.resolve(items)
        },
        // 选中一项 → 交给管线插入胶囊。这里返回的每一栏都是胶囊的「出厂设置」。
        onPick: function (pick) {
          var raw = pick && pick.candidate ? pick.candidate.value : ""
          var code = parseInt(String(raw), 10)
          var rec = isNaN(code) ? null : findRecord(code)
          log("onPick 命中，ref=" + raw + (rec ? "（《" + rec.doc.title + "》" + (rec.line > 0 ? " 第 " + rec.line + " 行" : "") + "）" : "（记录已不在，走兜底）"))
          return { insert: chipPayload(rec) }
        },
        // codec = 翻译规则。发送时官方按 source 找到它，把胶囊换成真正发给模型的文字。
        // ⚠️ 必须永不抛错：官方默认「翻译失败就拦住发送」，而发不出去比不精确更糟。
        codec: {
          clipboardText: function (ref) {
            var code = parseInt(String(ref), 10)
            var rec = isNaN(code) ? null : findRecord(code)
            return rec ? "@" + rec.doc.title + " > " + shrink(rec.selected, 40) : "@" + SOURCE_NAME
          },
          serialize: function (ref) {
            // try/catch 是**功能要求**不是防御性编程：任何一条漏网异常都会
            // 让用户的消息发不出去，那比"定位不精确"严重得多。
            try {
              var code = parseInt(String(ref), 10)
              var rec = isNaN(code) ? null : findRecord(code)
              if (!rec) {
                log("serialize: 找不到记录 " + ref + "（胶囊可能是刷新页面之前的），走兜底")
                return Promise.resolve("【话布选区】那段选区的记录已经没了（编号 " + String(ref)
                  + "）。请让用户重新划一次，不要凭猜测定位。")
              }
              // 输出以**短**为准，而且形状要能被折起来。
              // 主人给的关键线索：老流程那套 `@"路径" > 说明` 在对话里会**折成一张文件卡片**
              // （显示成「文件名 › 说明」），前提是 **@ 必须打头**。
              //
              // 🔴 2026-09-15 主人第二次收短（原话：「这还是有很长一段话啊，
              //   可以不可以【二、到底发生了什么 · 第 21 行 · 多处（第 2 处）】这些都不要，都不显示」）：
              //   **标签整串去掉**，卡片上只留文件名。理由：那是**给模型看的坐标**，
              //   主人自己不需要在聊天里读它，而且它把卡片撑得很难看。
              //
              //   ⚠️ 代价与**配套改动**（两处必须一起改，只改一边会让模型彻底失去定位能力）：
              //   这串标签以前是模型判断"是哪一处"的唯一线索。去掉之后改由
              //   ① 下面的 pinUp() 把「你选的是第几处」单独报给服务端；
              //   ② 服务端在注入时用它（src/host/13-selref-context.js）。
              //
              // 仍然只有两行：
              //  · 第 1 行 = @路径（@ 打头才会折成文件卡片，卡片标题就是文件名）
              //  · 第 2 行 = 原文（放过长或多行的原文，不塞进卡片那行）
              var head
              if (rec.doc.mention) {
                head = rec.doc.mention
              } else {
                // 拿不到真实路径（旧 host 没给 path）时退回纯文字抬头，至少不丢信息
                head = "【话布选区】" + (rec.doc.title || "(未命名)")
              }
              var out = head + "\n「" + rec.selected + "」"

              // 正文里不再有定位信息。真正的"到底是哪一处"由服务端**主动注入**给模型 ——
              // 那边读的是**当前**文档，顺带把"这段引用是不是已经失效"也一并告诉它。
              log("serialize 已完成 #" + rec.code + "：共 " + out.length + " 字"
                + (rec.dupCount > 1 ? "（原文重复 " + rec.dupCount + " 次，序数改走上报通道）" : ""))
              return Promise.resolve(out)
            } catch (e) {
              log("serialize 异常（已降级，不拦发送）: " + (e && e.message))
              return Promise.resolve("【话布选区】翻译时出错，已降级。请让用户重新划一次要引用的段落。")
            }
          }
        }
      }
    }

    // ═══ 五、自动两步（点「问AI」→ 替你开菜单 → 替你选中）═════════════
    // 官方把这两个口子用在**它自己的 `/` 命令菜单**上（"传进来的位置是程序合成的，
    // 而不是用户敲出来的"），所以这是官方预留的程序入口，不是钻空子。
    // 最终插入走的是正门 —— 和用户自己打 @、自己点一下，是同一条代码路径。
    //
    // 唯一的技术难点：候选是**异步取**的 —— 菜单先 pending 再 ready，
    // 而 pick 在 ready 之前会**静默返回、什么都不做**。
    // 所以必须等它 ready 再点，这就是设计稿风险 2 说的"打开与选中之间隔着一次异步取候选"。

    // 会话手柄：sessions.scope(sessionId) → 会话作用域 → inputTriggers.sessionOf(它)。
    // 三段任缺一段返回 null（不抛错），调用方按"自动失败"处理。
    // 会话作用域。官方那四个「改动输入框」的事件就挂在它上面
    // （见 dsh-client-ui-conversation 里 actx.on("slash/input-…")），
    // 所以拿到它 = 拿到了官方认可的改动入口。
    function sessionScope() {
      var ctx = window.__ccvSelRefCtx
      var sid = window.__ccvSessionId
      if (!ctx || !sid) return null
      var sessions = null
      try { sessions = ctx.sessions || (ctx.get && ctx.get("sessions")) } catch (_) {}
      if (!sessions || typeof sessions.scope !== "function") return null
      try { return sessions.scope(sid) || null } catch (_) { return null }
    }

    function pipelineController() {
      var ctx = window.__ccvSelRefCtx
      if (!ctx) return null
      var triggers = null
      try { triggers = ctx.inputTriggers || (ctx.get && ctx.get("inputTriggers")) } catch (_) {}
      var actx = sessionScope()
      if (!triggers || !actx) return null
      try { return triggers.sessionOf(actx) } catch (_) { return null }
    }

    // ── 直接往输入框里放东西：走官方**会话级事件**，不必开菜单 ──────────
    // 依据（读官方源码与类型契约得来，不是猜的）：
    //   · 官方把「插入胶囊」「插入纯文字」都定义成带版本校验的会话级事件
    //     （'slash/input-insert-reference' / 'slash/input-insert-text'，bail 模式），
    //     并且明说「业务插件拿到的就是这些事件」；
    //   · 事件处理体就是 shell.insertReference(ref, span) / insertText(text, span)，
    //     跟"用户自己打 @ 再点一下"最终走的是**同一个函数**；
    //   · span 是 {start, end, draftRev}：**版本号对不上就拒绝执行**（CAS）。
    //
    // 为什么值得换这条路（2026-09-15 主人第二次报同一个毛病）：
    //   原来必须"先开菜单 → 等候选就绪 → 再点"，而菜单只要被任何一次
    //   输入状态刷新碰上就会自己关掉。草稿里已经有东西时更容易被关，
    //   于是第二条引用必然失败、退到那条会**把已有胶囊拍平**的老路。
    //   直接派发事件没有菜单，也就没有"被关掉"这回事。
    function dispatchInput(ev, req) {
      var actx = sessionScope()
      if (!actx || typeof actx.bail !== "function") {
        log("派发 " + ev + "：拿不到会话作用域，或它没有 bail")
        return false
      }
      try {
        // 官方自己也是 actx.bail(actx, 事件, 请求) 这么派发的（第一个参数是派发主体）
        return actx.bail(actx, ev, req) === true
      } catch (e) {
        log("派发 " + ev + " 异常: " + (e && e.message))
        return false
      }
    }

    // 当前草稿与它的版本号。版本号必须**派发前现读** —— 官方拿它做比对，
    // 读到旧的就会被拒（这是好事：拒绝总比插到错地方强）。
    function draftNow() {
      var st = window.__ccvInputState
      if (!st || typeof st.draft !== "string" || typeof st.draftRev !== "number") return null
      return { text: st.draft, rev: st.draftRev, occurrences: st.occurrences }
    }

    // 🔴🔴 官方有**两套坐标**，而插件只拿得到其中一套 —— 这就是"第一条能插、第二条插不进"
    //      的真正原因（2026-09-15 主人现场发现"手动 @ 能插第二条"之后定位到的）：
    //
    //   · 给插件看的 `InputState.draft` = **剪贴板投影**：胶囊**展开**成 `@标题 > 摘要`
    //   · 改输入框用的 span 却是**探测投影**（detect）：
    //     一颗胶囊在那儿只算 **1 个字符**（`\uFFFC`，见官方 $composerLayout 的 pushLeaf）
    //
    //   草稿为空时两套坐标一样长 → 第一条永远成功；
    //   一旦有一颗胶囊，两者就差「胶囊文字长度 − 1」→ 我们算出的"末尾"**越过了文末**，
    //   官方 applyEdit 落不下来 → 返回 false。**所以是必然失败，不是偶发。**
    //
    //   换算：探测末尾 = draft 长度 − Σ(每颗胶囊的 length − 1)
    //   `occurrences[].length` 正是那颗胶囊在 draft 里的长度。
    //   对照官方 detectOffsetOfClipboardOffset：落在最末尾时返回的恰好是 detectLength。✅
    function detectLen(draft, occurrences) {
      var len = String(draft || "").length
      if (occurrences && occurrences.length) {
        for (var i = 0; i < occurrences.length; i++) {
          var o = occurrences[i]
          var L = o && o.length
          if (typeof L === "number" && L > 1) len -= (L - 1)
        }
      }
      return len < 0 ? 0 : len
    }

    // 零宽选区：起止都在**草稿末尾**（用探测坐标，不是 draft 长度）。
    // 🔴 这个"零宽 + 落在末尾"是本功能不破坏已有内容的关键：
    //    官方是"把 span 换成胶囊"，span 是零宽的就等于**只往末尾追加**，
    //    前面已有的囊一个字都不会动。
    function tailSpan(d) {
      var at = d.text.length
      var det = detectLen(d.text, d.occurrences)
      // 没有胶囊时 det === at，与从前的行为完全一致
      if (det !== at) log("坐标换算：剪贴板末尾 " + at + " → 探测末尾 " + det
        + "（" + ((d.occurrences || []).length) + " 颗胶囊）")
      return { start: det, end: det, draftRev: d.rev }
    }

    // 直接插入胶囊。成功 = 官方返回 true **且**胶囊数真的多了一个
    // （官方返回 true 只代表"编辑器接受并应用了这次编辑"，仍要数一遍才作数）。
    function insertChipDirect(rec) {
      return new Promise(function (resolve) {
        try {
          if (!rec) return resolve(false)
          var d = draftNow()
          if (!d) return resolve(false)
          var before = chipCount()
          var ok = dispatchInput("slash/input-insert-reference", {
            reference: chipPayload(rec),
            span: tailSpan(d)
          })
          log("直接插入：事件返回 " + String(ok) + "（草稿 " + d.text.length + " 字，版本 " + d.rev
            + "，已有胶囊 " + before + " 条）")
          if (!ok) return resolve(false)
          setTimeout(function () {
            var after = chipCount()
            if (after > before) { log("直接插入成功：胶囊进了输入框（" + before + " → " + after + "）"); return resolve(true) }
            log("直接插入：事件说成功了，但胶囊数没变（" + before + " → " + after + "）")
            resolve(false)
          }, VERIFY_MS)
        } catch (e) {
          log("直接插入异常: " + (e && e.message))
          resolve(false)
        }
      })
    }

    // 最后一道兜底：往末尾插**纯文字**（同样走官方事件，同样零宽、只追加）。
    // 主模块的老做法是 setDraft 整体重写，而草稿里的胶囊在整体重写时
    // 只会剩下纯文字形态 —— **已有胶囊会被一起拍平**。这条不会。
    // @returns {boolean} true = 确实插进去了
    function insertPlainTextDirect(body) {
      try {
        var d = draftNow()
        if (!d) { log("兜底插纯文字：读不到草稿，放弃"); return false }
        var ok = dispatchInput("slash/input-insert-text", { text: String(body), span: tailSpan(d) })
        log("兜底插纯文字：事件返回 " + String(ok))
        return ok
      } catch (e) {
        log("兜底插纯文字异常: " + (e && e.message))
        return false
      }
    }

    function groupOf(state, name) {
      var gs = (state && state.groups) || []
      for (var i = 0; i < gs.length; i++) if (gs[i] && gs[i].source === name) return gs[i]
      return null
    }

    // 草稿里"胶囊"的条数（官方 occurrences = 引用出现位置的清单）。
    // 用它判断"点下去了到底插进去没有" —— 比猜可靠。
    function chipCount() {
      var st = window.__ccvInputState
      return (st && st.occurrences) ? st.occurrences.length : -1
    }

    var READY_WAIT_MS = 1200   // 等菜单就绪的上限
    var VERIFY_MS = 180        // 点完之后等输入机 + 渲染一轮，再数胶囊
    var POLL_MS = 25
    // 菜单从「喊它开」到「快照里真的开着」之间的宽限。
    //
    // 🔴 2026-09-15 实测踩到：草稿为空时一切正常（胶囊稳稳插进去）；草稿里**已经有
    //    一条引用**之后再引用，就报「菜单没打开（或被立刻关掉了）」→ 悄悄退化成本文。
    //    当时的写法是 `toggleSource(...)` 之后**同步**看一眼快照，看到没开就直接判失败，
    //    连轮询都没起 —— 只要菜单是「晚一拍」才出现在快照里，就必然踩中。
    //    所以这里给它一段时间把状态刷上来，超时才认输。
    var OPEN_GRACE_MS = 600

    // 失败时把现场记全 —— 主人开不了控制台，日志是唯一的诊断通道。
    // 只记「没打开」这一个结果，下次还是查不出原因（菜单后来开了？一直没开？开着别家的？）
    function snapInfo(s) {
      try {
        if (!s) return "（快照是空的）"
        var gs = []
        var arr = s.groups || []
        for (var i = 0; i < arr.length; i++) {
          var g = arr[i]
          gs.push(String(g && g.source) + ":" + String(g && g.status)
            + "(" + ((g && g.items) ? g.items.length : 0) + ")")
        }
        return " [open=" + s.open + " groups=[" + gs.join(", ") + "]]"
      } catch (e) { return "（快照读不出来）" }
    }

    /**
     * 替用户走官方两步。
     * @returns {Promise<boolean>} true = 胶囊确实进了输入框；false = 没成（调用方退回老做法）。
     * 无论哪条路都**不抛错** —— 它是主路上的一个可选加速，不能反过来把主路弄坏。
     */
    function autoInsert() {
      return new Promise(function (resolve) {
        var settled = false
        var stopPoll = null
        var timer = null
        function done(ok, why) {
          if (settled) return
          settled = true
          if (stopPoll) stopPoll()
          if (timer) clearTimeout(timer)
          if (why) log("自动插入没成：" + why)
          resolve(ok)
        }

        try {
          var ctl = pipelineController()
          if (!ctl) return done(false, "拿不到输入管线的会话手柄（sessionId 或服务还没到位）")
          if (!records.length) return done(false, "还没有记过选区")
          if (!ctl.menu || typeof ctl.menu.getSnapshot !== "function") return done(false, "控制器形状和预期不一样")
          if (typeof ctl.toggleSource !== "function" || typeof ctl.pick !== "function") return done(false, "控制器缺 toggleSource / pick")

          var st = window.__ccvInputState
          var draft = (st && typeof st.draft === "string") ? st.draft : ""
          var rev = st ? st.draftRev : undefined
          if (typeof rev !== "number") return done(false, "读不到草稿版本号（输入框状态还没挂上）")

          // 合成一个"零宽选区"，口子开在草稿末尾。
          // position 的算法照抄官方 toggleCommandMenu：光标之前全是空白才算 leading。
          var at = draft.length
          var hit = {
            trigger: "@",
            query: "",
            quoted: false,
            position: draft.slice(0, at).trim() === "" ? "leading" : "inline",
            span: { start: at, end: at, draftRev: rev }
          }

          var before = chipCount()
          var openedAt = Date.now()

          function look() {
            if (settled) return "done"
            var s = null
            try { s = ctl.menu.getSnapshot() } catch (_) {}
            if (!s || !s.open) {
              // ⚠️ 不能在这里立刻判负，理由见 OPEN_GRACE_MS 的注释
              if (Date.now() - openedAt < OPEN_GRACE_MS) return "pending"
              done(false, "菜单没打开（或被立刻关掉了）" + snapInfo(s))
              return "done"
            }
            var g = groupOf(s, SOURCE_NAME)
            if (!g || g.status !== "ready") return "pending"   // 还没就绪，接着等
            if (!g.items || !g.items.length) { done(false, "候选是空的" + snapInfo(s)); return "done" }
            stopPoll()
            log("自动插入：菜单已就绪，选中第 1 条（共 " + g.items.length + " 条）")
            ctl.pick(SOURCE_NAME, 0)
            // pick 是同步派发事件，但插入要等输入机处理完、界面再渲染一轮，
            // 所以隔一小会儿数胶囊 —— 数出来才算真的成功。
            timer = setTimeout(function () {
              if (chipCount() > before) { log("自动插入成功：胶囊已进输入框"); return done(true) }
              done(false, "点下去了，但草稿里没多出胶囊（版本对不上？）"
                + " [before=" + before + " after=" + chipCount() + "]")
            }, VERIFY_MS)
            return "ready"
          }

          log("自动插入：打开「" + SOURCE_NAME + "」菜单（草稿 " + draft.length + " 字，版本 " + rev
            + "，口子在 " + at + "，位置 " + hit.position + "，已有胶囊 " + before + " 条）")
          ctl.toggleSource(SOURCE_NAME, hit)

          if (look() !== "pending") return   // 要么已经在等校验，要么已经失败收场
          var waited = 0
          stopPoll = interval(function () {
            waited += POLL_MS
            if (look() !== "pending") return
            if (waited >= READY_WAIT_MS) {
              try { ctl.dismiss() } catch (_) {}
              done(false, "等了 " + READY_WAIT_MS + " 毫秒菜单还没就绪，已把菜单关掉")
            }
          }, POLL_MS)
        } catch (e) {
          done(false, "自动插入异常: " + (e && e.message))
        }
      })
    }

    function interval(fn, ms) {
      var id = setInterval(fn, ms)
      return function () { clearInterval(id) }
    }

    function delay(ms) {
      return new Promise(function (r) { setTimeout(r, ms) })
    }

    // 走菜单那条路失败就**再试一次**，别急着降级。
    //
    // 🔴 为什么要重试（2026-09-15 实测）：菜单那条路失败几乎只发生在
    //    「草稿里已经有内容」时，而一旦降级，主模块会用 setDraft 把整份草稿
    //    **按纯文本重写** —— 纯文本里胶囊只剩 `@标题 > 摘要` 这种样子，
    //    于是**已有的胶囊会被一起拍平**。主人的体感就是「发一条有胶囊，
    //    再发一条胶囊全没了」。重试的代价只是多等几百毫秒，
    //    降级的代价是毁掉他前面所有的引用 —— 划不来。
    //
    // ⚠️ 现在这条路已经降级成**次选**了：首选是上面那条"直接派发官方事件"，
    //    它不需要菜单，所以压根没有"菜单被关掉"这个失败源。
    //    菜单这条路留着是为了在"事件派发不出去"的环境（更老的 DSH）里还能用。
    var RETRY_DELAY_MS = 300

    function menuInsertWithRetry() {
      return autoInsert().then(function (ok) {
        if (ok) return true
        // 先把可能残留的菜单收掉，再重来 —— 否则第二次 toggleSource 会变成"关掉"
        try { var c = pipelineController(); if (c && c.dismiss) c.dismiss() } catch (_) {}
        return delay(RETRY_DELAY_MS).then(function () {
          log("走菜单：第一次没成，重试一次")
          return autoInsert()
        })
      })
    }

    // 主入口：把「刚划的那一段」变成输入框里的一个胶囊。
    //
    // 三条路，从最稳到最退：① 直接派发官方事件（首选，不经菜单）
    //                        ② 走菜单替你点一下（老路，留着兼容）
    // 都失败就返回 false —— 由主模块决定怎么办，**本模块绝不自己去改草稿全文**。
    //
    // @param rec 可选。不传就用最近一次 capture 的那条（正常情况就是它）。
    function autoInsertWithRetry(rec) {
      var use = rec || records[0] || null
      return insertChipDirect(use).then(function (ok) {
        if (ok) return true
        log("直接插入没成，改走「替你开菜单点一下」那条路")
        return menuInsertWithRetry()
      })
    }

    // ═══ 六、AI 改完，跳过去给你看 ═════════════════════════════════
    // 需求（主人 2026-09-15 原话）：「不能直接在画布上操作吗，直接跳转到选区进行操作」
    // → 选定落点：**「改完跳过去给我看」** —— AI 改完文档，画布自动跳到改动处，
    //   主人当场核对它改对没有，不用自己翻半天找。
    //
    // 谁在盯着：服务端在 applyWrite 里把"改前/改后"一比，记下改动区间（只记 AI 改的）；
    // 这里**轮询**取回来。用轮询不用推送的理由见 host 侧那个端点的注释。
    //
    // ⚠️ 最关键的坑：服务端给的是 **Markdown 源码**里的文字，这里手里是**渲染之后**
    //    的文字 —— 两边的记号（`**` `#` 之类）和空白形态完全不同，直接找必然找不到。
    //    所以**两边按同一套规则先"归一化"**（把记号与空白都丢掉）再找，
    //    命中位置再靠一张映射表换回渲染文字里的真实位置。

    // 归一化时一律丢掉的字符：Markdown 记号 + 空白。
    // 必须是**同一套**规则用在两边 —— 规则一致，两边丢掉的东西才一致，才能对上。
    var SQUASH_DROP = " \t\r\n*_~`#>|[]()!\\"

    // 一段文字 → 只剩实义字符的"键"（服务端给的锚点用这个）
    function squashKey(s) {
      var out = "", i, ch
      s = String(s || "")
      for (i = 0; i < s.length; i++) {
        ch = s.charAt(i)
        if (SQUASH_DROP.indexOf(ch) >= 0) continue
        out += ch
      }
      return out
    }

    // 同上，但**记住每个字符原来在第几位**（渲染文字这一侧用）。
    // 只有这一侧需要映射：另一边只是拿来搜的键，不需要换回位置。
    function squashMapped(s) {
      var out = "", map = [], i, ch
      for (i = 0; i < s.length; i++) {
        ch = s.charAt(i)
        if (SQUASH_DROP.indexOf(ch) >= 0) continue
        out += ch
        map.push(i)
      }
      return { s: out, map: map }
    }

    // 摊平文本的下标 → DOM 里的位置。**offsetOf 的反向操作**：
    // 同一张 startOf 表倒着查 —— 找"起点不超过 idx、而且覆盖得到 idx"的那个文字节点。
    function nodeAt(flat, idx) {
      var best = null, bestStart = -1
      flat.startOf.forEach(function (start, node) {
        if (node.nodeType !== 3) return
        if (start > idx) return                      // 整个节点都在目标之后
        if (start + node.data.length < idx) return   // 整个节点都在目标之前
        if (start > bestStart) { bestStart = start; best = node }
      })
      return best ? { node: best, offset: idx - bestStart } : null
    }

    // 在渲染文字里找"改动点在哪"。
    // 三重线索**按可靠性顺序**试：
    //   ① 改动后的新文字 —— 命中点就是改动处（最准）
    //   ② 改动点之前的文字 —— 改动点紧跟在它后面（服务端从公共前缀里取的，一定存在）
    //   ③ 改动点之后的文字 —— 改动点紧挨在它前面
    //
    // 🔴 但「找得到」不等于「找得对」：线索在全文出现两次以上时会撞到别的地方，
    //    而**跳到错的地方比不跳更糟** —— 主人看到一段没变的文字，会以为 AI 改的就是那儿。
    //    所以**优先取"全文唯一"的那一条**；三条都不唯一时才退回"最靠前的那条"，
    //    并把 unique=false 带出去，让调用方在提示里说实话（别假装很准）。
    // @returns {{pos:number, unique:boolean}|null}  null = 三条线索一条都找不到 → **不跳**
    function findChangePos(editor, rec) {
      var flat = flatText(editor)
      var sq = squashMapped(flat.text)
      if (!sq.s) return null

      function countOf(n) {
        var c = 0, i = 0
        while ((i = sq.s.indexOf(n, i)) >= 0) { c++; i++ }
        return c
      }
      // 线索用完之后的下标 → 摊平文本里的位置（锚点之后的那个字）
      function posAfter(i, n) {
        var e = i + n.length
        return e < sq.map.length ? sq.map[e] : flat.text.length
      }
      function posAt(i) { return sq.map[i] }

      var cands = []
      var ak = squashKey(rec.added)
      if (ak) cands.push({ key: ak, pick: function (i) { return posAt(i) } })
      var hk = squashKey(rec.head)
      if (hk) cands.push({ key: hk, pick: function (i) { return posAfter(i, hk) } })
      var tk = squashKey(rec.tail)
      if (tk) cands.push({ key: tk, pick: function (i) { return posAt(i) } })

      var fallback = null
      for (var i = 0; i < cands.length; i++) {
        var idx = sq.s.indexOf(cands[i].key)
        if (idx < 0) continue                       // 这条线索对不上，试下一条
        var pos = cands[i].pick(idx)
        if (fallback === null) fallback = { pos: pos, unique: false }
        if (countOf(cands[i].key) === 1) return { pos: pos, unique: true }   // 全文唯一 → 可信
      }
      return fallback
    }

    // 滚动到改动点并选中它，让主人一眼看见。
    // 选中范围：从改动点到**该行末尾**（改一处通常就在一行里），最多 120 字。
    // 为什么不去凑一个"精确的改动区间"：渲染后的长度和源码长度本来就不一样，
    // 假装精确反而会选错地方 —— 选到整行是**不会错**的粒度。
    function revealAt(editor, idx) {
      var flat = flatText(editor)
      var text = flat.text
      var to = text.indexOf("\n", idx)
      if (to < 0 || to - idx > 120) to = Math.min(text.length, idx + 120)
      var a = nodeAt(flat, idx)
      if (!a) return false
      var b = (to > idx) ? nodeAt(flat, to) : null
      try {
        var rng = document.createRange()
        rng.setStart(a.node, a.offset)
        if (b) rng.setEnd(b.node, b.offset)
        else rng.setEnd(a.node, a.offset)
        var holder = a.node.parentElement || a.node.parentNode
        if (holder && holder.scrollIntoView) {
          holder.scrollIntoView({ behavior: "smooth", block: "center" })
        }
        var sel = document.getSelection()
        if (sel) { sel.removeAllRanges(); sel.addRange(rng) }
        return true
      } catch (e) {
        log("跳转失败（选中没建成）: " + (e && e.message))
        return false
      }
    }

    function bridgeEditor() {
      var br = window.__ccvSelRefBridge
      if (!br || !br.editor) return null
      try { return br.editor() } catch (_) { return null }
    }

    function toast(msg, key) {
      try {
        var kit = window.__ccvKit
        if (kit && kit.toast) kit.toast(msg, key)
      } catch (_) {}
    }

    // 等改动处在画布里出现 —— 用于"刚切完文档，等它渲染出来再跳"。
    // 为什么不用固定延时：切文档要拉网络、React 还要重渲染一轮，耗时不定，
    // 固定睡一会儿要么不够要么白等。**直接盯着目标出现**最稳，而且顺便自校验。
    function waitForPos(rec, timeoutMs) {
      return new Promise(function (resolve) {
        var waited = 0, step = 150
        function look() {
          var ed = bridgeEditor()
          if (ed) {
            var hit = findChangePos(ed, rec)
            if (hit) return resolve(hit)
          }
          waited += step
          if (waited >= timeoutMs) return resolve(null)
          setTimeout(look, step)
        }
        look()
      })
    }

    // 处理一条改动通知。**任何情况都不抛错** —— 它只是个"看得见"的便利，
    // 出问题也绝不能影响画布本体。
    function handleChange(rec) {
      try {
        if (!rec || !rec.canvasId) return Promise.resolve(false)
        if (window.__ccvJumpOff) { log("跳转总开关是关的，本次不跳"); return Promise.resolve(false) }
        var br = window.__ccvSelRefBridge
        if (!br || !br.editor) return Promise.resolve(false)   // 面板没开，没什么可跳

        // 主人正在编辑区里打字 → **本轮不跳**。
        // 跳转会挪走滚动位置、还会抢掉他的选区，正在输入的人会直接骂。
        // 宁可慢一拍，也不能打断输入。
        try {
          if (br.isEditing && br.isEditing()) {
            log("AI 改了《" + rec.title + "》，但主人正在打字 → 本轮不跳（不打断输入）")
            return Promise.resolve(false)
          }
        } catch (_) {}

        var cur = null
        try { cur = br.doc ? br.doc() : null } catch (_) {}

        // 改动可能落在**别的**文档里（主人在看 A，AI 改了 B）→ 先把 B 打开
        var needOpen = !cur || cur.id !== rec.canvasId
        if (needOpen) {
          if (!br.openDoc) { log("想跳到《" + rec.title + "》，但没有切文档的口子"); return Promise.resolve(false) }
          var started = false
          try { started = br.openDoc(rec.canvasId) } catch (_) {}
          if (!started) {
            log("切不到《" + rec.title + "》（文档可能已被关掉或删掉），本次不跳")
            return Promise.resolve(false)
          }
          log("AI 改的是《" + rec.title + "》，正在切过去…")
        }

        return waitForPos(rec, needOpen ? JUMP_WAIT_MS : 400).then(function (hit) {
          if (!hit) {
            log("没能在画布里找到改动处（两边文字对不上），本次不跳 —— 不猜着跳")
            return false
          }
          var ed = bridgeEditor()
          if (!ed) return false
          var line = flatText(ed).text.slice(0, hit.pos).split("\n").length
          if (!revealAt(ed, hit.pos)) return false
          log("已跳到《" + rec.title + "》改动处（画面上第 " + line + " 行）"
            + (hit.unique ? "" : " ⚠️ 锚点在全文不止一处，位置可能不准")
            + " 删除 " + rec.removedChars + " 字 / 新增 " + rec.addedChars + " 字")
          // 不唯一时**如实说**"可能不准" —— 提示里假装很准，等于骗主人去看错的地方
          toast(hit.unique
            ? "AI 刚改了《" + rec.title + "》，已跳到改动处"
            : "AI 刚改了《" + rec.title + "》，已跳到大概位置（请核对）", "ccv-ai-jump")
          return true
        })
      } catch (e) {
        log("跳转处理异常（已忽略）: " + (e && e.message))
        return Promise.resolve(false)
      }
    }

    var POLL_MS = 1200        // 轮询间隔。AI 改完到主人看向屏幕本来就有间隔，这点延迟无感
    var JUMP_WAIT_MS = 4000   // 切完文档后等它渲染出来的上限
    var lastSeq = 0
    var primed = false        // 第一次只对齐游标，不为"页面加载之前"的改动跳
    var busy = false

    function poll() {
      if (busy) return Promise.resolve()
      busy = true
      // fetch 可能整个不存在（老浏览器 / 测试沙箱）→ 必须同步兜住，
      // 否则会在定时器里抛出去，把整个模块带崩。
      var req = null
      try { req = fetch("/api/canvas/changes?since=" + lastSeq) } catch (_) { req = null }
      if (!req) { busy = false; return Promise.resolve() }
      return Promise.resolve(req)
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (!d || !d.ok || typeof d.latest !== "number") return
          var list = d.changes || []
          lastSeq = d.latest
          if (!primed) { primed = true; return }   // 首次只对齐，不跳
          if (!list.length) return
          // 一轮里 AI 可能连着改好几处 → **只跳最后一条**。
          // 跳来跳去只会让人晕，而最后一条通常就是最该核对的那处。
          return handleChange(list[list.length - 1])
        })
        .catch(function () {})     // 网络抖动无所谓，下一轮再问
        .then(function () { busy = false })
    }

    function startPolling() {
      // 首次延迟一下：页面刚起来时前面的请求还没完，别挤在一起。
      setTimeout(function () {
        poll()
        setInterval(poll, POLL_MS)
      }, 900)
    }

    // ═══ 五、自举 ═══════════════════════════════════════════════════

    // 「记一笔」这个口子与引用源注册无关，越早挂越好 ——
    // 万一注册失败（比如名字撞了），至少记录还在，日志能看出是这个功能在跑。
    window.__ccvSelRefCapture = capture
    // 「把这段引用变成输入框里的胶囊」的入口，由主模块在点「问AI」时调用。
    // 返回 Promise<boolean>：false 时主模块才会去走兜底。
    // 传参可选：刚记下的那条记录（不传就用最近一条）。
    window.__ccvSelRefAuto = autoInsertWithRetry
    // 兜底入口：往输入框末尾追加**纯文字**，走官方事件、零宽、只追加。
    // 主模块的老兜底是"整体重写草稿"，那个会把已有胶囊拍平；
    // 所以主模块必须先试这个，只有输入框里一个胶囊都没有时才允许整体重写。
    // @returns {boolean} true = 插进去了，别再动草稿
    window.__ccvSelRefText = insertPlainTextDirect
    // 诊断用：想看看现在记了哪几条，控制台敲 __ccvSelRefInfo()
    window.__ccvSelRefInfo = function () {
      return records.map(function (r) {
        return "#" + r.code + " 《" + r.doc.title + "》" + (r.heading ? " · " + r.heading : "")
          + (r.line > 0 ? " · 第 " + r.line + " 行" : "") + " · " + r.length + " 字"
      })
    }
    // 诊断 + 回归测试用：把编辑区摊平的结果（纯文字 + 下标表）暴露出来。
    // 行号算错不会报错、只会安静地错，所以这个口子必须留着，测试靠它核对。
    window.__ccvSelRefFlat = flatText

    // 「AI 改完跳过去给你看」的诊断口（这个功能最容易"静默不生效"——
    // 两边文字对不上时它只是不跳，界面毫无异常，所以必须能单独问它）：
    //   __ccvSelRefPoll()       立刻问一次服务端，不用等轮询
    //   __ccvSelRefJump(rec)    手工喂一条改动记录，直接看跳转效果
    //   __ccvSelRefSquash(s)    看一段文字归一化之后长什么样（两边对不上时靠它比对）
    //   __ccvSelRefFind(rec[, editor])  返回 {pos, unique} 或 null（null = 找不到，本次不会跳）
    //                                   给 editor 就用它，不给就用当前编辑区（测试/排障都要）
    //   __ccvJumpOff = true     总开关，排障时临时整体停掉跳转
    window.__ccvSelRefPoll = poll
    window.__ccvSelRefJump = handleChange
    window.__ccvSelRefSquash = squashKey
    window.__ccvSelRefFind = function (rec, editor) {
      var ed = editor || bridgeEditor()
      return ed ? findChangePos(ed, rec) : null
    }
    window.__ccvSelRefNodeAt = nodeAt
    // 两套坐标的换算（2026-09-15 新增）。单独挂出来是因为它一旦算错，
    // 表现是"第一条能插、第二条插不进"这种**只在有胶囊时才出现**的怪事，
    // 排障时最需要能单独问它一遍。
    window.__ccvSelRefDetectLen = detectLen

    // 轮询「AI 刚改了哪儿」—— 与引用源注册无关，所以放在自举之外：
    // 就算注册失败（名字撞了之类），"跳过去给我看"这一半照样能用。
    startPolling()

    var booted = false

    /**
     * 主模块 apply(ctx) 时调用；本模块也可能自己先走到这里。
     * @param {object} ctx - cordis 根上下文
     */
    function boot(ctx) {
      if (booted) {
        if (window.__ccvSelRefCtx !== ctx) {
          log("上下文已更换（插件疑似重挂），本模块不重复注册 —— 刷新页面即可")
        }
        return
      }
      booted = true

      try {
        if (!ctx) { log("boot 收到空上下文，放弃自举"); return }

        window.__ccvSelRefCtx = ctx
        window.__ccvSelRefReady = true

        var missing = missingServices(ctx)
        if (missing.length) {
          log("v" + VERSION + " 启动时暂缺: " + missing.join(" / ") + "（2 秒后复检）")
          setTimeout(function () {
            var again = missingServices(ctx)
            if (!again.length) log("复检通过：三个服务已全部就绪 → 注册被跳过，刷新页面即可生效")
            else log("复检仍缺: " + again.join(" / ") + " → 检查主模块 inject 声明")
          }, 2000)
          return
        }

        log("v" + VERSION + " 已就绪：sessions / conversation / inputTriggers 三个服务都在")

        // ─── 注册引用源 ───────────────────────────────────────────
        var register = function () { return ctx.inputTriggers.registerSource(makeSource()) }
        try {
          if (typeof ctx.effect === "function") ctx.effect(register, "collab-canvas: @ " + SOURCE_NAME)
          else register()
          log("已注册「" + SOURCE_NAME + "」引用源（真数据）"
            + " → 划词点「问AI」记一笔，再打 @ 就能看到它")
        } catch (e) {
          log("注册引用源失败: " + (e && e.message)
            + "（若提示 already registered，说明名字与别的源撞了）")
        }
      } catch (e) {
        log("boot 失败: " + (e && e.message))
      }
    }

    if (window.__ccvCtx) {
      // 主模块已经 apply 过了
      boot(window.__ccvCtx)
    } else {
      // 主模块还没 apply —— 挂出去等它来调
      window.__ccvSelRefBoot = boot
      log("v" + VERSION + " 已加载，等待主模块上下文")
      // 兜底自检：主模块始终没来就留个痕迹，便于区分「没加载」和「加载了但没握手」
      setTimeout(function () {
        if (!booted) log("v" + VERSION + " 仍在等待：3 秒内未收到主模块上下文（__ccvCtx 未挂）")
      }, 3000)
    }
  } catch (e) {
    // 最外层兜底：连 log 都可能不可用，直接裸 POST
    try {
      fetch("/api/canvas/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line: "[selref] 模块执行异常: " + (e && e.message) })
      }).catch(function () {})
    } catch (_) {}
  }
})()
