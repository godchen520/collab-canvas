// HTML → Markdown 序列化（contentEditable DOM → 存储格式）
function htmlToMd(root) {
  function attrsOf(node, names) {
    const parts = []
    for (const n of names) {
      const v = node.getAttribute && node.getAttribute(n)
      if (v) parts.push(' ' + n + '="' + v + '"')
    }
    return parts.join('')
  }
  function walk(node) {
    if (node.nodeType === 3) return node.nodeValue.replace(/\u00a0/g, ' ')
    if (node.nodeType !== 1) return ''
    const tag = node.tagName ? node.tagName.toLowerCase() : ''
    if (tag === 'br') return '\n'
    const inner = Array.prototype.map.call(node.childNodes || [], walk).join('')
    switch (tag) {
      case 'div': case 'p': return inner + '\n'
      case 'h1': return '# ' + inner + '\n'
      case 'h2': return '## ' + inner + '\n'
      case 'h3': return '### ' + inner + '\n'
      case 'h4': return '#### ' + inner + '\n'
      case 'h5': return '##### ' + inner + '\n'
      case 'h6': return '###### ' + inner + '\n'
      case 'strong': case 'b': return inner ? '**' + inner + '**' : ''
      case 'em': case 'i': return inner ? '*' + inner + '*' : ''
      case 'u': return inner ? '<u>' + inner + '</u>' : ''
      case 'sub': return inner ? '<sub>' + inner + '</sub>' : ''
      case 'sup': return inner ? '<sup>' + inner + '</sup>' : ''
      case 'strike': case 's': case 'del': return inner ? '~~' + inner + '~~' : ''
      case 'font': return inner ? '<font' + attrsOf(node, ['size', 'face', 'color']) + '>' + inner + '</font>' : ''
      case 'code': return '\x60' + inner + '\x60'
      case 'pre': return '\n\x60\x60\x60\n' + (node.textContent || '') + '\n\x60\x60\x60\n'
      case 'blockquote': return inner.trim() ? inner.trim().split('\n').map(function (l) { return '> ' + l }).join('\n') + '\n' : ''
      case 'ul': return inner
      case 'ol': return inner
      case 'li': return inner
      case 'a': { const href = node.getAttribute && node.getAttribute('href'); return '[' + inner + '](' + (href || '') + ')' }
      case 'hr': return '\n---\n'
      case 'span': return inner
      default: return inner
    }
  }
  // 列表项需要 ul/ol 上下文加前缀，单独遍历
  function walkList(listNode, ordered) {
    let s = ''
    let idx = 1
    for (const li of listNode.childNodes || []) {
      if (!li.tagName || li.tagName.toLowerCase() !== 'li') continue
      const itemHtml = Array.prototype.map.call(li.childNodes || [], walk).join('').trim()
      const prefix = ordered ? (idx + '. ') : '- '
      s += prefix + itemHtml.replace(/\n+/g, ' ') + '\n'
      idx++
    }
    return s
  }
  function walk2(node) {
    if (node.nodeType === 3) return node.nodeValue.replace(/\u00a0/g, ' ')
    if (node.nodeType !== 1) return ''
    const tag = node.tagName ? node.tagName.toLowerCase() : ''
    if (tag === 'ul') return walkList(node, false)
    if (tag === 'ol') return walkList(node, true)
    return walk(node)
  }
  return walk2(root).replace(/\n{3,}/g, '\n\n').trim()
}
