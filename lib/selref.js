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
//   第 4 步【本版】自动两步：点「问AI」→ 替你开菜单 → 替你选中 → 胶囊直接进输入框
//   第 5 步  过期校验（版本号 + 上下文指纹）
//
// 健壮性约定：与 docdrop / doclink 相同 —— 防重复安装、失败静默降级、
//             任何异常都不许影响画布本体。
;(function () {
  try {
    if (window.__ccvSelRefInstalled) return
    window.__ccvSelRefInstalled = true

    var VERSION = 4

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
    var FINGERPRINT = 24   // 前后各留多少个字当"指纹"，用于将来校验选区是否还在
    var ANCHOR_MAX = 60    // 为了"唯一确定"最多往外扩多少个字

    // 某段文字在全文里出现几次。**这是定位精度的关键**：
    // 出现 1 次 → 报原文就够；出现多次 → 只报原文和行号，AI 仍然只能猜是哪一处
    //（主人举的例子：想改 `1111111111111`，可一行里可能有好几段一模一样的0/1）。
    function countOcc(text, needle) {
      if (!needle) return 0
      var n = 0, i = 0
      while ((i = text.indexOf(needle, i)) >= 0) { n++; i += 1 }   // 允许重叠
      return n
    }

    /**
     * 算出「能唯一确定这一段」所需的最小上下文。
     * 做法：从选区往外一个字一个字地扩，扩到「扩出来的整串在全文只出现一次」为止。
     *
     * ⚠️ 每一步都要试**三种扩法**，先试短的那两种：
     *   ① 只往前带  ② 只往后带  ③ 前后都带
     * 主人 09-14 举的例子：「小明在笑，小明在闹」选**第二个**小明 ——
     * 往前带一个逗号（「，小明」）就已经唯一，没必要把右边的「在」也拖进来。
     * 老写法只会"前后同时扩"，结果白白多带一个字。
     *
     * @returns {{count:number, ok:boolean, before:string, after:string}}
     *   count = 原文在全文出现几次
     *   ok    = 是否成功拿到唯一上下文（原文本身就唯一时也算成功，前后为空）
     */
    function anchorFor(text, off, selected) {
      var count = countOcc(text, selected)
      if (count <= 1) return { count: count, ok: true, before: "", after: "" }
      var end = off + selected.length
      var len = text.length
      for (var k = 1; k <= ANCHOR_MAX; k++) {
        var cands = [
          [Math.max(0, off - k), end],                    // 只往前带
          [off, Math.min(len, end + k)],                  // 只往后带
          [Math.max(0, off - k), Math.min(len, end + k)]  // 前后都带
        ]
        for (var c = 0; c < cands.length; c++) {
          var a = cands[c][0], b = cands[c][1]
          if (b - a <= selected.length) continue   // 没扩出去，还是原文，不可能唯一
          if (countOcc(text, text.slice(a, b)) === 1) {
            return { count: count, ok: true, before: text.slice(a, off), after: text.slice(end, b) }
          }
        }
      }
      // 扩到上限还不唯一（极端情况：整篇都是同一种字符）→ 老实说"定不住"，别让 AI 猜
      return { count: count, ok: false, before: "", after: "" }
    }

    // 选区起点在它那一行里的第几个字（从 1 数）。只在"定不住"时用来兜底。
    function columnOf(text, off) {
      if (off < 0) return -1
      return off - (text.lastIndexOf("\n", off - 1) + 1) + 1
    }

    // 定位行必须**始终是一行** —— 否则选区正好卡在行尾时，
    // 下文里那个换行会把句尾的省略号顶到下一行去（主人 09-14 截图实测：
    // 末尾孤零零一个「…」）。换行换成可见符号 ↵，长度不变、意思不丢。
    function oneLine(s) {
      return String(s === undefined || s === null ? "" : s).replace(/\n/g, "↵")
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

        // 定位精度：原文唯一吗？不唯一就把"能唯一确定它"的那几个字也算出来
        var anch = (off >= 0) ? anchorFor(flat.text, off, selected)
                              : { count: 0, ok: true, before: "", after: "" }

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
          col: off >= 0 ? columnOf(flat.text, off) : -1,
          before: off >= 0 ? flat.text.slice(Math.max(0, off - FINGERPRINT), off) : "",
          after: off >= 0 ? flat.text.slice(off + selected.length, off + selected.length + FINGERPRINT) : "",
          heading: off >= 0 ? nearestHeading(editor, flat, off) : "",
          // 定位锚：原文不唯一时，前后各带上几个字，让「原文」在全文里只出现一次
          dupCount: anch.count,
          anchorOk: anch.ok,
          anchorBefore: anch.before,
          anchorAfter: anch.after
        }

        records.unshift(rec)                       // 新的排最前
        if (records.length > MAX_RECORDS) records.length = MAX_RECORDS

        log("已记录选区 #" + rec.code + "：《" + rec.doc.title + "》"
          + (rec.heading ? " · " + rec.heading : "")
          + (rec.line > 0 ? " · 第 " + rec.line + " 行" : " · 位置未取到")
          + " · " + rec.length + " 字「" + shrink(rec.selected, 16) + "」"
          + (rec.dupCount > 1
              ? " ⚠️ 这段原文在全文出现 " + rec.dupCount + " 次"
                + (rec.anchorOk ? " → 已扩到唯一上下文" : " → 扩到上限仍不唯一，报列号兜底")
              : ""))
        return rec
      } catch (e) {
        log("capture 失败: " + (e && e.message))
        return null
      }
    }

    // ═══ 四、引用源定义 ═════════════════════════════════════════════
    // 官方机制：想让输入框里出现胶囊，必须先在 inputTriggers 里挂一个 source。
    // 官方自带 @文件 / @会话 两个 —— 这里是第三个。
    //
    // ⚠️ name 有两个身份：① 菜单分组标题 ② 发送时翻译路由的 key
    //    （草稿里每个胶囊记着自己的 source，提交时按它找回本源的 codec）。
    //    它必须与官方及任何其他插件不重名，否则 registerSource 直接抛错。
    var SOURCE_NAME = "话布选区"

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
          return { insert: {
            source: SOURCE_NAME,
            ref: String(raw),
            // 胶囊上显示的字：选中文字的前 12 字
            label: rec ? shrink(rec.selected, LABEL_MAX) : "话布选区",
            appearance: "file",           // 图标：官方只给 file / folder / session
            // 刷新页面后持久化草稿里的胶囊会退化成这行纯文字（设计稿风险 3），
            // 所以写成人类也读得懂的「@文档 > 选中文字」，退化后仍可用。
            clipboardText: rec
              ? "@" + rec.doc.title + " > " + shrink(rec.selected, 40)
              : "@" + SOURCE_NAME
          } }
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
              // 所以：
              //  · 第 1 行 = @路径 + " > " + 一句短标签（小标题 · 第 N 行）
              //  · 第 2 行 = 原文（放过长或多行的原文，不塞进卡片那行）
              //  · 小标题与文档名同名就不写（文档 h1 往往就叫文档名，实测会变成「话布优化 · 话布优化」）
              //  · 前后文指纹**只留给第 5 步做过期校验**，不往正文里塞 ——
              //    实测它还会把表格摊成一串没意义的词，纯噪音
              var bits = []
              if (rec.heading && rec.heading !== rec.doc.title) bits.push(rec.heading)
              if (rec.line > 0) bits.push("第 " + rec.line + " 行")
              var label = bits.join(" · ")
              var head
              if (rec.doc.mention) {
                head = rec.doc.mention + (label ? " > " + label : "")
              } else {
                // 拿不到真实路径（旧 host 没给 path）时退回纯文字标签，至少不丢信息
                head = "【话布选区】" + (rec.doc.title || "(未命名)") + (label ? " · " + label : "")
              }
              var out = head + "\n「" + rec.selected + "」"

              // 原文在全文里不是唯一的 → 必须补一句"到底是哪一处"，否则 AI 只能猜。
              // ⚠️ 只在**不唯一时**才多这一行：常见情况（原文唯一）输出一个字都不变。
              //    主人举的例子：想把 `1111111111111` 改成 `1111121111111`，
              //    可一行里可能有好几段一模一样的 —— 只报原文和行号，AI 定不住。
              if (rec.dupCount > 1) {
                if (rec.anchorOk && (rec.anchorBefore || rec.anchorAfter)) {
                  // 把选区往外扩到"整串在全文只出现一次"，用【】标出原文那一段
                  // ⚠️ 换行一律换成 ↵：选区卡在行尾时，下文里那个换行会把句尾的
                  //    省略号顶到下一行去（主人 09-14 截图实测：末尾孤零零一个「…」）
                  // ⚠️ 哪边为空就不加哪边的省略号，别摆一个指向虚空的「…」
                  out += "\n定位："
                    + (rec.anchorBefore ? "…" + oneLine(rec.anchorBefore) : "")
                    + "【" + oneLine(rec.selected) + "】"
                    + (rec.anchorAfter ? oneLine(rec.anchorAfter) + "…" : "")
                    // 这句是给模型看的、不是客套：前后文只是"路标"，
                    // 不说明白它可能把路标一起替换掉（多删几个字）。
                    + "（只改【】里的）"
                } else {
                  out += "\n⚠️ 这段原文在全文里出现 " + rec.dupCount + " 次，靠上下文也分不开"
                    + (rec.line > 0 && rec.col > 0 ? "（第 " + rec.line + " 行第 " + rec.col + " 字起）" : "")
                    + "。请让用户确认要改哪一处，不要猜。"
                }
              }
              log("serialize 已完成 #" + rec.code + "：共 " + out.length + " 字"
                + (rec.dupCount > 1 ? "（原文重复 " + rec.dupCount + " 次，已附定位）" : ""))
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
    function pipelineController() {
      var ctx = window.__ccvSelRefCtx
      var sid = window.__ccvSessionId
      if (!ctx || !sid) return null
      var sessions = null, triggers = null
      try { sessions = ctx.sessions || (ctx.get && ctx.get("sessions")) } catch (_) {}
      try { triggers = ctx.inputTriggers || (ctx.get && ctx.get("inputTriggers")) } catch (_) {}
      if (!sessions || !triggers || typeof sessions.scope !== "function") return null
      var actx = null
      try { actx = sessions.scope(sid) } catch (_) {}
      if (!actx) return null
      try { return triggers.sessionOf(actx) } catch (_) { return null }
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

          function look() {
            if (settled) return "done"
            var s = null
            try { s = ctl.menu.getSnapshot() } catch (_) {}
            if (!s || !s.open) { done(false, "菜单没打开（或被立刻关掉了）"); return "done" }
            var g = groupOf(s, SOURCE_NAME)
            if (!g || g.status !== "ready") return "pending"   // 还没就绪，接着等
            if (!g.items || !g.items.length) { done(false, "候选是空的"); return "done" }
            stopPoll()
            log("自动插入：菜单已就绪，选中第 1 条（共 " + g.items.length + " 条）")
            ctl.pick(SOURCE_NAME, 0)
            // pick 是同步派发事件，但插入要等输入机处理完、界面再渲染一轮，
            // 所以隔一小会儿数胶囊 —— 数出来才算真的成功。
            timer = setTimeout(function () {
              if (chipCount() > before) { log("自动插入成功：胶囊已进输入框"); return done(true) }
              done(false, "点下去了，但草稿里没多出胶囊（版本对不上？）")
            }, VERIFY_MS)
            return "ready"
          }

          log("自动插入：打开「" + SOURCE_NAME + "」菜单（草稿 " + draft.length + " 字，版本 " + rev + "）")
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

    // ═══ 五、自举 ═══════════════════════════════════════════════════

    // 「记一笔」这个口子与引用源注册无关，越早挂越好 ——
    // 万一注册失败（比如名字撞了），至少记录还在，日志能看出是这个功能在跑。
    window.__ccvSelRefCapture = capture
    // 「替用户走官方两步」的入口，由主模块在点「问AI」时调用。
    // 返回 Promise<boolean>：false 时主模块会退回老做法（塞引用块）。
    window.__ccvSelRefAuto = autoInsert
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
