// ═══ 话布文档模型（P1：块级模型 + markdown 无损往返）═══════════════════
//
// 目标（2026-10-15 主人选定"乙"）：
//   **语义等价 + 规范化一次后稳定** ✓
//     · 第一次 parse→serialize 可能整理写法（列表标记统一成 - ✓ 空行统一成一个 ✓）
//     · 之后【再往返完全一致】✓（幂等 ✓）—— 也就是"最多动一次，之后不再漂"
//
// 为什么只做块级 ✗（P1 的范围）：
//   这次的"有损"是**块级漂移** ✗（日志：行数 308→311，差 100 行 ✓）
//   —— 多行段落被拆、列表套代码块漂移之类 ✓ 那都是块级 ✓
//   行内（**粗体** / 链接 / 脚注）目前往返是好的 ✓ 先当**原始文本**存 ✓
//   等 P2 编辑器需要行内结构时再加 ✓（范围小、风险低 ✓）
//
// 自包含 ✓ 零依赖 ✓ —— 与 lib/ 下其它侧模块同一种写法 ✓
// 浏览器：window.__ccvDocModel = CCV_DOC_MODEL ✓
// node  ：new Function(src + '\nreturn CCV_DOC_MODEL')() ✓（测试就这么用 ✓）
var CCV_DOC_MODEL = (function () {
  'use strict'

  // ─── 解析：markdown → Doc ───────────────────────────────────────
  // Doc = { blocks: [ Block ] }
  // Block:
  //   { type:'h', level:1-6, text }
  //   { type:'p', text }                       ← text 是**原始 markdown 行**（行内不建模 ✓）
  //   { type:'code', lang, text }
  //   { type:'quote', blocks:[Block] }         ← 递归 ✓
  //   { type:'list', ordered, items:[{blocks:[Block]}] }
  //   { type:'table', align:[…], rows:[[cell,…]], widths:null|[%…], heights:null|[…] }
  //   { type:'hr' }
  //   { type:'html', text }                    ← 原始 HTML 块（脚注 / div / mark 等 ✓）
  function parse(md) {
    var lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n')
    var blocks = parseBlocks(lines)
    return { blocks: blocks }
  }

  function isBlank(l) { return /^\s*$/.test(l) }
  function fenceOpen(l) { var m = l.match(/^\s*(```+|~~~+)\s*([^\s`]*)\s*$/); return m ? { fence: m[1], lang: m[2] || '' } : null }
  function isHr(l) { return /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(l) }
  function headingOf(l) { var m = l.match(/^\s{0,3}(#{1,6})\s+(.*)$/); return m ? { level: m[1].length, text: m[2].replace(/\s+$/, '') } : null }
  function isQuote(l) { return /^\s{0,3}>/.test(l) }
  function isTableSep(l) { return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.indexOf('-') >= 0 && l.indexOf('|') >= 0 }
  function isTableRow(l) { return l.indexOf('|') >= 0 && !isBlank(l) }
  // 列表项：- / * / + 或 1. / 1) ；带缩进
  function listItemOf(l) {
    var m = l.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/)
    if (!m) return null
    var ordered = /\d/.test(m[2])
    return { indent: m[1].replace(/\t/g, '    ').length, ordered: ordered, text: m[3], marker: m[2] }
  }
  // 原始 HTML 块：以 <tag 或 <!-- 开头（到空行为止；不做完整 HTML 解析 ✓ 够用 ✓）
  function isHtmlStart(l) {
    return /^\s*<(div|p|table|details|summary|section|figure|blockquote|ul|ol|pre|mark|span|a|img|br|hr|sub|sup|kbd|dl|dt|dd|aside|nav|header|footer|video|audio|iframe|script|style)\b/i.test(l) ||
      /^\s*<!--/.test(l)
  }

  function parseBlocks(lines) {
    var out = []
    var i = 0
    while (i < lines.length) {
      var l = lines[i]
      if (isBlank(l)) { i++; continue }

      // ① 围栏代码块
      var fo = fenceOpen(l)
      if (fo) {
        var buf = []
        i++
        while (i < lines.length && !new RegExp('^\\s*' + fo.fence.charAt(0) + '{3,}\\s*$').test(lines[i])) { buf.push(lines[i]); i++ }
        if (i < lines.length) i++   // 吃掉收尾围栏
        out.push({ type: 'code', lang: fo.lang, text: buf.join('\n') })
        continue
      }

      // ② 标题
      var h = headingOf(l)
      if (h) { out.push({ type: 'h', level: h.level, text: h.text }); i++; continue }

      // ③ 分隔线
      if (isHr(l)) { out.push({ type: 'hr' }); i++; continue }

      // ④ 表格：本行含 | 且下一行是分隔行
      if (isTableRow(l) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var rows = [], align = []
        var sepCells = splitRow(lines[i + 1])
        for (var a = 0; a < sepCells.length; a++) {
          var s = sepCells[a].trim()
          var lf = s.charAt(0) === ':', rt = s.charAt(s.length - 1) === ':'
          align.push(lf && rt ? 'center' : (rt ? 'right' : (lf ? 'left' : '')))
        }
        rows.push(splitRow(l))
        i += 2
        while (i < lines.length && isTableRow(lines[i]) && !isBlank(lines[i])) { rows.push(splitRow(lines[i])); i++ }
        // 紧跟的列宽/行高注释 ✓（我们自己的标记 ✓ 不算正文 ✓）
        var widths = null, heights = null
        while (i < lines.length) {
          var c = lines[i].trim()
          var mw = c.match(/^<!--\s*ccv-table:\s*([\d.,\s]+?)\s*-->$/)
          var mh = c.match(/^<!--\s*ccv-table-h:\s*([\d.,auto\s]+?)\s*-->$/)
          if (mw) { widths = mw[1].split(',').map(function (x) { return parseFloat(x) || 0 }); i++; continue }
          if (mh) { heights = mh[1].split(',').map(function (x) { var v = String(x).trim(); return (v === 'auto' || !(parseFloat(v) > 0)) ? 0 : Math.round(parseFloat(v)) }); i++; continue }
          break
        }
        out.push({ type: 'table', align: align, rows: rows, widths: widths, heights: heights })
        continue
      }

      // ⑤ 引用（连续 > 行 → 内部递归 ✓）
      if (isQuote(l)) {
        var q = []
        while (i < lines.length && (isQuote(lines[i]) || (q.length && !isBlank(lines[i]) && !headingOf(lines[i]) && !isHr(lines[i]) && !listItemOf(lines[i]) && !fenceOpen(lines[i])))) {
          q.push(lines[i].replace(/^\s{0,3}>\s?/, ''))
          i++
        }
        out.push({ type: 'quote', blocks: parseBlocks(q) })
        continue
      }

      // ⑥ 列表（含嵌套缩进 ✓ 连续项算一个列表 ✓）
      var li = listItemOf(l)
      if (li) {
        var items = []
        var ordered = li.ordered
        var startNo = li.ordered ? (parseInt(String(li.marker).replace(/[.)]$/, ''), 10) || 1) : 1
        while (i < lines.length) {
          var it = listItemOf(lines[i])
          if (!it) break
          var itemLines = [it.text]
          var baseIndent = it.indent
          i++
          // 该项的续行
          //   ⚠️ 空行后面只要**缩进更深**就仍属于这一项 ✓
          //      —— 2026-10-15 修：原来只认"下一行还是列表项"✗
          //         于是「- 项\n\n  ```代码块```」里的代码块被拉出列表 ✗
          while (i < lines.length) {
            if (isBlank(lines[i])) {
              var nx = lines[i + 1] || ''
              if (isBlank(nx)) break
              var nxIndent = (nx.match(/^\s*/) || [''])[0].replace(/\t/g, '    ').length
              if (nxIndent > baseIndent) { itemLines.push(''); i++; continue }
              break
            }
            var nIt = listItemOf(lines[i])
            if (nIt && nIt.indent <= baseIndent) break
            var lineIndent = (lines[i].match(/^\s*/) || [''])[0].replace(/\t/g, '    ').length
            if (lineIndent <= baseIndent && !/^\s{2,}/.test(lines[i])) break
            // 保留相对缩进 ✓（至少去掉 baseIndent+2 的前缀 ✓）
            itemLines.push(lines[i].replace(new RegExp('^\\s{0,' + (baseIndent + 2) + '}'), ''))
            i++
          }
          // 去掉尾部空行 ✓
          while (itemLines.length && isBlank(itemLines[itemLines.length - 1])) itemLines.pop()
          items.push({ blocks: parseBlocks(itemLines) })
          // 跳过一个空行继续找下一项 ✓
          var save = i
          while (i < lines.length && isBlank(lines[i])) i++
          var after = listItemOf(lines[i] || '')
          if (!after) { i = save; break }
        }
        out.push({ type: 'list', ordered: ordered, start: startNo, items: items })
        continue
      }

      // ⑦ 原始 HTML 块
      if (isHtmlStart(l)) {
        var hb = []
        while (i < lines.length && !isBlank(lines[i])) { hb.push(lines[i]); i++ }
        out.push({ type: 'html', text: hb.join('\n') })
        continue
      }

      // ⑧ 段落：连续非空行（到空行/其它块开头为止 ✓）
      var pb = [l]
      i++
      while (i < lines.length && !isBlank(lines[i]) &&
        !headingOf(lines[i]) && !isHr(lines[i]) && !fenceOpen(lines[i]) &&
        !isQuote(lines[i]) && !listItemOf(lines[i]) && !isHtmlStart(lines[i]) &&
        !(isTableRow(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
        pb.push(lines[i]); i++
      }
      out.push({ type: 'p', text: pb.join('\n') })
    }
    return out
  }

  // 拆一行表格：| a | b | → ['a','b']（保留转义 \| ✓）
  //   ⚠️ **必须与渲染器一致**（2026-10-15 结论 ✓）：
  //      lib/client.js 的 buildTable 是 `raw.split("|")` —— **见 | 就拆** ✗
  //      我一度加了"反引号里不拆" ✗ → 模型与视图各说各话 ✗
  //      → 这里保持"见 | 就拆"✓ 与渲染器一字不差 ✓
  function splitRow(l) {
    var s = String(l).trim().replace(/^\|/, '').replace(/\|$/, '')
    var cells = [], cur = ''
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i)
      if (ch === '\\' && s.charAt(i + 1) === '|') { cur += '\\|'; i++; continue }
      if (ch === '|') { cells.push(cur.trim()); cur = ''; continue }
      cur += ch
    }
    cells.push(cur.trim())
    return cells
  }

  // ─── 序列化：Doc → markdown（规范形式 ✓ 幂等的关键 ✓）────────────
  function serialize(doc) {
    var blocks = (doc && doc.blocks) || []
    var parts = []
    for (var i = 0; i < blocks.length; i++) {
      var s = serBlock(blocks[i])
      if (s !== '') parts.push(s)
    }
    return parts.join('\n\n') + '\n'
  }

  function serBlock(b) {
    if (!b) return ''
    switch (b.type) {
      case 'h': return repeat('#', Math.max(1, Math.min(6, b.level || 1))) + ' ' + b.text
      case 'hr': return '---'
      case 'p': return b.text
      case 'code': return '```' + (b.lang || '') + '\n' + b.text + '\n```'
      case 'html': return b.text
      case 'quote': {
        var inner = serialize({ blocks: b.blocks }).replace(/\n$/, '')
        return inner.split('\n').map(function (l) { return l === '' ? '>' : '> ' + l }).join('\n')
      }
      case 'list': {
        var marker = b.ordered ? null : '-'
        var out = []
        var startN = b.ordered ? (b.start || 1) : 1   // ★ 起始序号要保 ✓（4. 不能写成 1. ✗）
        for (var i = 0; i < b.items.length; i++) {
          var mk = b.ordered ? (startN + i) + '. ' : marker + ' '
          var body = serialize({ blocks: b.items[i].blocks }).replace(/\n$/, '')
          var ls = body.split('\n')
          out.push(mk + ls[0])
          for (var j = 1; j < ls.length; j++) out.push(ls[j] === '' ? '' : '  ' + ls[j])
        }
        return out.join('\n')
      }
      case 'table': {
        var rows = b.rows || []
        var cols = 0
        // 列数取所有行的**最大值** ✓（不截断 ✗ —— 截断会静默丢格子内容 ✗✗）
        //   与渲染器一致：渲染器也是按最宽的那行画 ✓
        //   → 若原文件的分隔行列数少于正文行 ✓ 规范化后会补齐 ✓（这是**好**的规范化 ✓）
        for (var r = 0; r < rows.length; r++) if (rows[r].length > cols) cols = rows[r].length
        if (!cols) return ''
        var lines = []
        for (var r2 = 0; r2 < rows.length; r2++) {
          var row = rows[r2].slice()
          while (row.length < cols) row.push('')
          lines.push('| ' + row.join(' | ') + ' |')
          if (r2 === 0) {
            var sep = []
            for (var c = 0; c < cols; c++) {
              var al = (b.align && b.align[c]) || ''
              sep.push(al === 'center' ? ':---:' : (al === 'right' ? '---:' : '---'))
            }
            lines.push('| ' + sep.join(' | ') + ' |')
          }
        }
        var txt = lines.join('\n')
        if (b.widths && b.widths.length) {
          var any = false
          for (var w = 0; w < b.widths.length; w++) if (b.widths[w] > 0) { any = true; break }
          if (any) txt += '\n<!-- ccv-table: ' + b.widths.map(function (x) { return Math.round(x) || 0 }).join(',') + ' -->'
        }
        if (b.heights && b.heights.length) {
          var anyH = false
          for (var hh = 0; hh < b.heights.length; hh++) if (b.heights[hh] > 0) { anyH = true; break }
          if (anyH) txt += '\n<!-- ccv-table-h: ' + b.heights.map(function (x) { return x > 0 ? Math.round(x) : 'auto' }).join(',') + ' -->'
        }
        return txt
      }
      default: return ''
    }
  }
  function repeat(s, n) { var o = ''; for (var i = 0; i < n; i++) o += s; return o }

  // ─── 幂等自检（P1 的验收工具 ✓）────────────────────────────────
  // 返回 { once, twice, stable } —— stable 为 true 才算过关 ✓
  function roundTrip(md) {
    var once = serialize(parse(md))
    var twice = serialize(parse(once))
    return { once: once, twice: twice, stable: once === twice }
  }

  var API = { parse: parse, serialize: serialize, roundTrip: roundTrip, splitRow: splitRow }
  try { if (typeof window !== 'undefined') window.__ccvDocModel = API } catch (_) {}
  return API
})()
