// ═══ 话布选区 · 把「用户引用的那段到底在哪」主动告诉模型 ═════════════════
// 为什么要有它（2026-09-15 主人拍板）：
//   canvas_locate 是「模型自己来问」。实测靠不住 —— 模型看到引用标签上的
//   「多处（第 2 处）」很可能**不问**，凭感觉挑一处就改，改错了比不回答更糟。
//   所以改成「先把答案送到它手上」：用户一旦把引用发出来，位置就已经在
//   它的上下文里躺着了，它不需要知道有这么个工具也能改对地方。
//
// canvas_locate 不撤：注入可能因为各种原因没覆盖到（用户手打引用、格式怪、
//   解析失败），那时它仍是兜底。两条路是**互补**的，不是替代。
//
// 位置怎么来的：不新算一套。复用 07-tools.js 里 canvas_locate 的 occIndexes /
//   lineColOf（同一作用域，直接可用），保证"注入说的"和"工具说的"永远一致。
//
// 生命周期：**完全交给官方**，自己一个定时器都不加。
//   官方每个 step 都会重新求值下面这个 provider，只有文本变了才推一条新的
//   上下文消息、文本变空就把上一条抹掉（RuntimeContextProjection 的替换机制）。
//   于是：
//     · 用户这轮发了引用   → 算出内容 → 注入
//     · 同一轮里模型跑很多步 → 文本没变 → 不重复刷屏
//     · 下一轮用户没引用    → 文本变空 → 官方自动抹掉，不留残影
//   ⚠️ 所以**千万别加 TTL / 别自己清** —— 那不是帮忙，是跟官方机制打架。
//
// ⚠️ 这条消息会以一行「注入」的样子出现在聊天里（跟时间上下文一模一样，
//    label 是插件名）。不是隐形注入，主人看得见。
//
// [[CCV-SELCTX-BEGIN]] —— 下面到 END 之间是这块功能的全部代码。
//   tools/test-host-selctx.cjs 靠这两个标记把这段**真代码**切出来单独跑，
//   不是照抄一份来测。挪动或删除标记会让那份测试失效。

// ── 一、从会话里取「用户这一轮说的话」────────────────────────────
// 官方求值 provider 时会把当前 agent 交给我们（assembleContextFor 里
// 返回 {agent, scope, signal}），顺着 agent.session 就能读到这次对话。
// ⚠️ 必须**同步**：官方求值不带 await（`entry.text(context)` 直接调用），
//   返回 Promise 只会被当成一个奇怪的字符串塞进 prompt。

// 「不是人打的字」的来源。这些一律跳过，继续往前找。
var CCV_INJECT_KINDS = {
  'plugin': true,               // 插件注入的上下文（包括我们自己这条）
  'session-reference': true,    // 跨会话引用
  'agent-instructions': true,
  'skill-invocation': true
}

// 一条消息里的纯文字。content 可能是字符串，也可能是分块的数组。
function ccvMsgText(msg) {
  if (!msg) return ''
  var content = msg.content
  if (typeof content === 'string') return content
  if (!content || !content.length) return ''
  var out = []
  for (var i = 0; i < content.length; i++) {
    var b = content[i]
    if (b && b.type === 'text' && typeof b.text === 'string') out.push(b.text)
  }
  return out.join('\n')
}

// 最近一条「人打的」消息，找不到就返回空串。
// ⚠️ 这里必须**往前找**而不是只看最后一条：我们自己注入的那条也是
//   user/message，只看最后一条会看到自己，那就永远解析不出引用了。
// 反过来这也给了我们一个好性质：用户发了新的、不带引用的消息时，
// 最近这条就变成它 → 解析不出引用 → 返回空 → 官方把注入抹掉。
function ccvLastHumanText(agent) {
  var session = agent && agent.session
  if (!session) return ''
  var nodes = session.surface && session.surface.nodes
  if (!nodes || !nodes.length) return ''
  for (var i = nodes.length - 1; i >= 0; i--) {
    var ev = session.eventAt(nodes[i])
    if (!ev || ev.type !== 'user/message') continue
    var msg = ev.data                       // user/message 的 data 就是消息本身
    var kind = msg && msg.source && msg.source.kind
    if (kind && CCV_INJECT_KINDS[kind]) continue
    return ccvMsgText(msg)
  }
  return ''
}

// ── 一·五、客户端报上来的「你划的是第几处」──────────────────────
// 为什么服务端自己算不出：序数靠的是**划选那一刻的 DOM 位置**，
// 只有浏览器那边知道 —— 服务端只知道原文长什么样，不知道你指的是哪一处。
//
// 🔴 而引用正文里现在**也不写坐标了**（2026-09-15 主人要求卡片只留文件名），
//   所以这条上报通道成了"第几处"的**唯一来源**。它和 lib/selref.js 里的
//   pinUp() 是一对，**必须一起改**：只改一边，模型就彻底不知道用户指哪儿了。
//
// 上报时机是 capture()（用户点「问AI」/划选那一刻），比发送早得多，
// 所以这里不会出现"消息先到、记录后到"的竞态。
var CCV_PINS_MAX = 8      // 只留最近几条，覆盖式；不清理也不会涨
var ccvPins = []
// 每收一条上报就 +1。**专供下面那份 memo 失效用**，见 ccvBuildSelContext。
// 没有它会出一个很难发现又很致命的错：用户前后两次引用同一段原文
// （这段文字在文档里出现多处），两次的引用正文**一字不差**，
// memo 会把第二次挡掉、继续用第一次的序数 → 模型改错地方。
var ccvPinSeq = 0

function ccvPinAdd(p) {
  try {
    if (!p || typeof p !== 'object') return false
    var text = String(p.text || '')
    if (!text) return false
    ccvPins.push({
      code: p.code,
      path: ccvNormPathForRef(p.path),
      title: String(p.title || ''),
      text: text,
      ordinal: typeof p.ordinal === 'number' ? p.ordinal : 0,
      dupCount: typeof p.dupCount === 'number' ? p.dupCount : 0,
      line: typeof p.line === 'number' ? p.line : -1,
      heading: String(p.heading || ''),
      at: Date.now(),
    })
    if (ccvPins.length > CCV_PINS_MAX) ccvPins = ccvPins.slice(ccvPins.length - CCV_PINS_MAX)
    ccvPinSeq++
    return true
  } catch (e) {
    return false
  }
}

// 找出这条引用对应的上报记录。取**最新**的一条 —— 用户的操作顺序天然是
// 「先划选、再发送」，所以最新那条就是这次的。
// ⚠️ 已知边界：同一段原文连着划两次、却只发出第一条引用时，会取到后一条的序数。
//   罕见，且注入文案里保留了每处的上下文供核对，不会静默改错。
function ccvPinFind(path, quote) {
  var want = ccvNormPathForRef(path)
  var q = String(quote || '')
  if (!q) return null
  for (var i = ccvPins.length - 1; i >= 0; i--) {
    var p = ccvPins[i]
    // 精确相等最好；但解析出来的原文在"原文本身含「」"时会被截短，
    // 所以也接受"它是上报原文的前缀"（截短只会往前截，不会变形）。
    if (p.text !== q && p.text.indexOf(q) !== 0) continue
    if (want && p.path && p.path !== want) continue
    return p
  }
  return null
}

// ── 二、从消息正文里认出「话布选区引用」──────────────────────────
// 引用正文的形状由 lib/selref.js 的 codec.serialize 生成，**只有两行**：
//   @"D:\...\canvas-docs\话布优化.md"
//   「原文」
// 拿不到真实路径时第 1 行退化成：
//   【话布选区】文档名
//   「原文」
//
// 🔴 2026-09-15 起标签**整串没有了**（主人要求对话里那张卡片只留文件名）。
//   于是"第几处"改从上报记录拿（ccvPinFind）。但抬头仍然要认、也仍然要
//   **兼容带标签的老形态** —— 浏览器缓存里的旧客户端、以及用户手打的引用，
//   都可能还带着「> 小标题 · 第 21 行 · 多处（第 2 处）」。
//
// 只有上面这两种抬头才认。**用户自己在正文里写**
//   他说：
//   「你好」
// **绝不能被当成引用** —— 那会让我们凭空定位一段用户根本没引用的话。
var CCV_REF_LINE_RE = /(^|\n)([^\n]*)\n「([\s\S]*?)」/g

// 抬头是不是引用。返回 'mention' / 'plain' / null（null = 不认）。
function ccvRefHeadKind(head) {
  var h = String(head || '').trim()
  if (!h) return null
  if (h.charAt(0) === '@') return 'mention'
  if (h.indexOf('【话布选区】') === 0) return 'plain'
  return null
}

// 从 @"路径" 里取出路径。没写引号就截到 " > " 之前。
// ⚠️ 先 trim：抬头行前面可能带空格（用户手工复制粘贴引用时会），
//   不 trim 就会认不出路径 → 安静地退化成"没找到文档"。实测踩过。
function ccvRefPath(head) {
  var h = String(head || '').trim()
  if (h.charAt(0) !== '@') return ''
  var rest = h.slice(1)
  if (rest.charAt(0) === '"') {
    var end = rest.indexOf('"', 1)
    if (end > 0) return rest.slice(1, end)
  }
  var gt = rest.indexOf(' > ')
  return (gt >= 0 ? rest.slice(0, gt) : rest).trim()
}

// 从 【话布选区】文档名 · 标签 里取文档名。（同样要先 trim）
function ccvRefTitle(head) {
  var h = String(head || '').trim()
  var tag = '【话布选区】'
  if (h.indexOf(tag) !== 0) return ''
  var rest = h.slice(tag.length)
  var cut = rest.indexOf(' · ')
  return (cut >= 0 ? rest.slice(0, cut) : rest).trim()
}

// 标签里的「多处（第 2 处）」→ 2。没写「第几处」→ 0（不编数字）。
function ccvRefOrdinal(head) {
  var m = /多处（第\s*(\d+)\s*处）/.exec(String(head || ''))
  if (!m) return 0
  var n = parseInt(m[1], 10)
  return isFinite(n) && n > 0 ? n : 0
}

// 「多处」两个字在不在。标记存在但序数没对上时，仍然要告诉模型别猜。
function ccvRefHasDup(head) {
  return /多处/.test(String(head || ''))
}

// 把一条消息里所有引用块抠出来 → [{head, kind, quote, ordinal, dup}]
// ⚠️ 原文本身可能含「」：非贪婪先截到第一个「」，交给下面 ccvQuoteVariants
//   在文档里找不到时再往下一个「」延长。这里只负责"先给最短的那个"。
function ccvParseRefs(text) {
  var src = String(text || '')
  if (src.indexOf('「') < 0) return []
  var out = []
  CCV_REF_LINE_RE.lastIndex = 0
  var m
  while ((m = CCV_REF_LINE_RE.exec(src)) !== null) {
    var head = m[2]
    var kind = ccvRefHeadKind(head)
    if (!kind) continue                       // 抬头不像引用 → 用户自己写的，跳过
    var quote = m[3]
    if (!quote || !quote.replace(/\s/g, '')) continue
    out.push({
      head: head,
      kind: kind,
      quote: quote,
      path: kind === 'mention' ? ccvRefPath(head) : '',
      title: kind === 'plain' ? ccvRefTitle(head) : '',
      ordinal: ccvRefOrdinal(head),
      dup: ccvRefHasDup(head)
    })
    if (out.length >= 5) break                // 一条消息里引用太多就不再认了
  }
  return out
}

// 原文含「」时，上面会截短。给出"截短版 + 逐个延长版"，让定位去试。
// 正常情况下第一个就命中，延长版根本不看。
function ccvQuoteVariants(text, start) {
  var out = []
  var from = start
  for (var i = 0; i < 3; i++) {
    var end = String(text).indexOf('」', from)
    if (end < 0) break
    out.push(String(text).slice(start, end))
    from = end + 1
  }
  return out.length ? out : [String(text).slice(start)]
}

// ── 三、找文档 ──────────────────────────────────────────────────
// ⚠️ 刻意**不用** findCanvasByArg：它在路径匹配不上时会退回「当前活跃文档」，
//   而那很可能**不是**引用说的那份 —— 拿错文档算出来的位置比不注入更糟。
//   这里宁可认不出（说"没找到"），也不猜。
function ccvNormPathForRef(s) {
  return String(s || '').replace(/\\/g, '/').replace(/^"+|"+$/g, '').replace(/\/+$/, '')
}

function ccvFindDoc(ref) {
  if (ref.path) {
    var want = ccvNormPathForRef(ref.path)
    if (!want) return null
    var hit = null
    canvases.forEach(function (c) {
      if (!hit && c.filePath && ccvNormPathForRef(c.filePath) === want) hit = c
    })
    if (!hit) {
      // 路径对不上时，用文件名兜一次（大小写与分隔符差异）
      var tail = want.slice(want.lastIndexOf('/') + 1)
      canvases.forEach(function (c) {
        if (hit || !c.filePath) return
        var cw = ccvNormPathForRef(c.filePath)
        if (cw.slice(cw.lastIndexOf('/') + 1) === tail) hit = c
      })
    }
    return hit
  }
  if (ref.title) {
    var byTitle = null
    canvases.forEach(function (c) { if (!byTitle && c.title === ref.title) byTitle = c })
    return byTitle
  }
  return null
}

// ── 四、算定位，拼成给模型看的一段话 ─────────────────────────────
var CCV_SEL_CTX_PAD = 24      // 每处前后各带多少字
var CCV_SEL_MAX_SPOTS = 5     // 最多列几处
var CCV_SEL_QUOTE_MAX = 40    // 摘要里原文最多显示几个字
var CCV_SEL_TOTAL_MAX = 1200  // 整段注入的长度上限

function ccvShortQuote(s, max) {
  var t = String(s || '')
  return t.length <= max ? t : t.slice(0, max) + '…'
}

// 一处长这样：…前文【原文】后文…
function ccvSpotExcerpt(content, idx, quote) {
  var a = Math.max(0, idx - CCV_SEL_CTX_PAD)
  var b = Math.min(content.length, idx + quote.length + CCV_SEL_CTX_PAD)
  return (a > 0 ? '…' : '')
    + asOneLine(content.slice(a, idx))
    + '【' + asOneLine(ccvShortQuote(quote, CCV_SEL_QUOTE_MAX)) + '】'
    + asOneLine(content.slice(idx + quote.length, b))
    + (b < content.length ? '…' : '')
}

// 单条引用 → 一段话。返回 '' 表示这条不值得注入（比如找不到文档）。
function ccvDescribeRef(ref) {
  var who = ref.path || ref.title || '（未标注）'
  var c = ccvFindDoc(ref)
  if (!c) {
    return '· 用户引用了「' + ccvShortQuote(ref.quote, CCV_SEL_QUOTE_MAX)
      + '」（' + who + '），但没找到这份话布文档（可能已改名或删掉）。'
      + '先 canvas_list 看看，别在别的文档里找相似内容改。'
  }
  var content = String(c.content || '')

  // 原文含「」时会被截短 —— 逐个延长版去试，谁在文档里出现就用谁
  var quote = ''
  var idxs = []
  var variants = ccvQuoteVariants(ref.quote, 0)
  for (var i = 0; i < variants.length; i++) {
    var tryQ = variants[i]
    if (!tryQ) continue
    var hits = occIndexes(content, tryQ)
    if (hits.length) { quote = tryQ; idxs = hits; break }
  }

  // 全文都找不到 → 引用已经失效。这是最要紧的一种，必须说死。
  if (!idxs.length) {
    return '· 用户引用了《' + c.title + '》里的「' + ccvShortQuote(ref.quote, CCV_SEL_QUOTE_MAX)
      + '」，但这段原文**现在全文都找不到了** —— 这段引用已经失效'
      + '（多半是引用发出之后文档被改过）。'
      + '动手前请让用户重新划一次要引用的段落，**不要**去找相似的内容照着改。'
  }

  var shown = idxs.slice(0, CCV_SEL_MAX_SPOTS)

  // 只有一处：直接说死
  if (idxs.length === 1) {
    var lc1 = lineColOf(content, idxs[0])
    return '· 《' + c.title + '》「' + ccvShortQuote(quote, CCV_SEL_QUOTE_MAX)
      + '」在第 ' + lc1.line + ' 行，**全文只有这一处**：\n  '
      + ccvSpotExcerpt(content, idxs[0], quote)
  }

  // 多处：把目标那一处标出来，其余只报行号（够模型核对，又不啰嗦）
  //
  // 序数从哪来：**客户端刚报上来的**优先（引用正文里已经不写了）；
  // 拿不到才退回看抬头标签（兼容没更新的客户端 / 用户手打的引用）。
  // 两个都没有 → 绝不替模型挑一处，让它把每处摆给用户确认。
  var pin = ccvPinFind(ref.path, quote)
  var ordinal = (pin && pin.ordinal > 0) ? pin.ordinal : ref.ordinal

  var head = '· 《' + c.title + '》「' + ccvShortQuote(quote, CCV_SEL_QUOTE_MAX)
    + '」全文共 ' + idxs.length + ' 处'
  if (ordinal > 0 && ordinal <= idxs.length) {
    head += '，**用户要的就是第 ' + ordinal + ' 处**（他划中的是这一处）'
  } else {
    head += '，仅凭行号分不出来'
  }
  head += '：'

  var lines = [head]
  var target = ordinal > 0 && ordinal <= idxs.length ? ordinal - 1 : -1
  for (var k = 0; k < shown.length; k++) {
    var lc = lineColOf(content, shown[k])
    var isTarget = k === target
    lines.push('  ' + (isTarget ? '★第 ' + (k + 1) + ' 处（第 ' + lc.line + ' 行）'
                                : '  第 ' + (k + 1) + ' 处（第 ' + lc.line + ' 行）')
      + '：' + ccvSpotExcerpt(content, shown[k], quote))
  }
  if (idxs.length > shown.length) {
    lines.push('  （后面还有 ' + (idxs.length - shown.length) + ' 处，略）')
  }

  if (target >= 0) {
    lines.push('  → 动这段文字时照上面标 ★ 的那一处改，别的几处不要碰。')
  } else {
    lines.push('  → 分不出用户要哪一处。请把上面每处的上下文摆给用户，让他确认改哪一处，不要自己挑一处改。')
  }
  return lines.join('\n')
}

// 把最近一条人消息里的引用整体描述出来。没有引用 / 出错 → 空串（= 不注入）。
// ⚠️ 这个函数会被官方**每个 step 调一次**，而且**同步**调。所以：
//   · 全程 try/catch，任何异常都退化成一件事：不注入。
//     （provider 抛错会毁掉整个 prompt 组装 —— 那比不注入严重得多。）
//   · 结果按正文做一次 memo：同一轮里正文没变就直接复用。
//     ⚠️ 键里**必须**带上上报计数和记录条数（见下），不能只看正文 ——
//     同一段原文出现多处时，用户前后两次引用拼出来的正文可以一字不差，
//     只按正文做键就会把第二次挡掉，让模型拿着第一次的序数去改。
var ccvSelCtxMemo = { key: null, val: '' }

function ccvBuildSelContext(context) {
  try {
    var agent = context && context.agent
    var text = ccvLastHumanText(agent)
    if (!text) { ccvSelCtxMemo = { key: null, val: '' }; return '' }
    var memoKey = text + '#' + ccvPinSeq + '#' + ccvPins.length
    if (ccvSelCtxMemo.key === memoKey) return ccvSelCtxMemo.val

    var refs = ccvParseRefs(text)
    var blocks = []
    for (var i = 0; i < refs.length && i < 3; i++) {
      var one = ccvDescribeRef(refs[i])
      if (one) blocks.push(one)
    }
    var out = ''
    if (blocks.length) {
      out = '【话布选区】用户这轮引用了话布里的文字。它**到底在哪一处**已经先替你查好了，'
        + '按下面的位置改就行，不必再问：\n' + blocks.join('\n')
      if (out.length > CCV_SEL_TOTAL_MAX) out = out.slice(0, CCV_SEL_TOTAL_MAX) + '\n（内容过长，已截断）'
    }
    ccvSelCtxMemo = { key: memoKey, val: out }
    return out
  } catch (e) {
    try { console.error('[collab-canvas] sel-context failed:', e && e.message) } catch (_) {}
    return ''
  }
}

// ── 五、注册成官方动态上下文 ────────────────────────────────────
// name 必须全局唯一（重名官方直接抛错）；order 只要是个有限数，
// 排在其他上下文（沙箱策略 110 / 审批 115 / 子代理 120）之后。
try {
  var spSel = ctx.get('systemPrompt')
  if (spSel && typeof spSel.context === 'function') {
    spSel.context({
      name: 'collab-canvas-selection',
      order: 160,
      text: ccvBuildSelContext,
    })
    console.log('[collab-canvas]', 'selection context registered')
  }
} catch (e) {
  console.error('[collab-canvas] selection context failed:', e && e.message)
}
// [[CCV-SELCTX-END]]
