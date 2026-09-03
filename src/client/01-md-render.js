// Markdown → HTML 渲染器（转义优先防 XSS + 白名单内联标签还原）
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function inlineMd(s) {
  let out = escapeHtml(s)
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  out = out.replace(/\[\[([^\]]+)\]\]/g, '<span class="ccv-wikilink" title="文件跳转（V2 接入代码画布后启用）">$1</span>')
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  return out
}
// Markdown 原生没有下划线/字号/字体，这些样式以白名单内联标签存储，渲染时还原
function unescapeWhitelist(s) {
  return s
    .replace(/&lt;(\/?)(u|sub|sup)&gt;/g, '<$1$2>')
    .replace(/&lt;(\/?)font((?:\s+(?:size|face|color)=&quot;[^&]*&quot;)*)&gt;/g, function (m, slash, attrs) {
      return '<' + slash + 'font' + attrs.replace(/&quot;/g, '"') + '>'
    })
}
function mdToHtml(src) {
  const lines = String(src || '').split(/\r?\n/)
  const out = []
  let i = 0
  let inCode = false
  let codeBuf = []
  let listMode = null
  function closeList() { if (listMode) { out.push('</' + listMode + '>'); listMode = null } }
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      if (!inCode) { closeList(); inCode = true; codeBuf = [] }
      else { inCode = false; out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>') }
      i++; continue
    }
    if (inCode) { codeBuf.push(line); i++; continue }
    const trimmed = line.trim()
    if (!trimmed) { closeList(); i++; continue }
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (h) { closeList(); const n = h[1].length; out.push('<h' + n + '>' + inlineMd(h[2]) + '</h' + n + '>'); i++; continue }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) { closeList(); out.push('<hr/>'); i++; continue }
    const bq = trimmed.match(/^>\s?(.*)$/)
    if (bq) { closeList(); out.push('<blockquote>' + inlineMd(bq[1]) + '</blockquote>'); i++; continue }
    const ul = trimmed.match(/^[-*]\s+(.*)$/)
    const ol = trimmed.match(/^(\d+)[.、)]\s+(.*)$/)
    if (ul) {
      if (listMode !== 'ul') { closeList(); out.push('<ul>'); listMode = 'ul' }
      out.push('<li>' + inlineMd(ul[1]) + '</li>'); i++; continue
    }
    if (ol) {
      if (listMode !== 'ol') { closeList(); out.push('<ol>'); listMode = 'ol' }
      out.push('<li>' + inlineMd(ol[2]) + '</li>'); i++; continue
    }
    closeList()
    out.push('<p>' + inlineMd(line) + '</p>')
    i++
  }
  if (inCode) out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>')
  closeList()
  return unescapeWhitelist(out.join('\n'))
}
