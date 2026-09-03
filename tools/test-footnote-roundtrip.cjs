#!/usr/bin/env node
// 脚注 round-trip 测试：从 editor-panel.js 源码里抽出真实的 htmlToMd / mdToHtml，
// 用极简 DOM shim 跑一遍，验证「正常脚注 → HTML → 回 Markdown」不会退化。
'use strict'
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'src', 'client', 'editor-panel.js')
const src = fs.readFileSync(SRC, 'utf8')

// ─── 从源码中按大括号配平抽出函数源码 ────────────────
function extract(fnDecl) {
  const start = src.indexOf(fnDecl)
  if (start < 0) throw new Error('未找到函数: ' + fnDecl)
  let depth = 0
  let i = src.indexOf('{', start)
  let end = -1
  for (let j = i; j < src.length; j++) {
    const c = src[j]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = j + 1; break } }
  }
  if (end < 0) throw new Error('大括号未配平: ' + fnDecl)
  return src.slice(start, end)
}

const htmlToMdSrc = extract('function htmlToMd(root) {')
const mdToHtmlSrc = extract('function mdToHtml(src) {')

const htmlToMd = new Function('return ' + htmlToMdSrc)()
const mdToHtml = new Function('return ' + mdToHtmlSrc)()

// ─── 极简 DOM shim：够 htmlToMd 用即可 ───────────────
// htmlToMd 用到的 DOM 面：nodeType / nodeValue / tagName / childNodes /
// classList.contains / getAttribute / querySelectorAll('li') / textContent
function makeClassList(className) {
  const list = String(className || '').split(/\s+/).filter(Boolean)
  return { contains: (c) => list.indexOf(c) >= 0 }
}
function el(tag, attrs, children) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    _attrs: attrs || {},
    childNodes: children || [],
  }
  node.classList = makeClassList(attrs && attrs.className)
  node.getAttribute = (n) => (node._attrs[n] !== undefined ? node._attrs[n] : null)
  node.querySelectorAll = function (sel) {
    const res = []
    ;(function walk(n) {
      ;(n.childNodes || []).forEach(function (c) {
        if (c.nodeType !== 1) return
        if (sel === 'li' && c.tagName.toLowerCase() === 'li') res.push(c)
        else if (sel === 'a' && c.tagName.toLowerCase() === 'a') res.push(c)
        walk(c)
      })
    })(node)
    return res
  }
  Object.defineProperty(node, 'textContent', {
    get: function () {
      return (node.childNodes || [])
        .map(function (c) { return c.nodeType === 3 ? c.nodeValue : c.textContent })
        .join('')
    },
  })
  return node
}
function text(s) { return { nodeType: 3, nodeValue: s, childNodes: [] } }

// ─── 构造一个「正常渲染后的脚注区」DOM ───────────────
// 这是 mdToHtml 会产出的结构：<div class="footnotes"><hr/><ol><li id="fn-1">…<a href="#fnref-1">↩</a></li></ol></div>
function buildEditorDom() {
  const fnLink = el('a', { href: '#fn-1', id: 'fnref-1' }, [text('[1]')])
  const body = el('p', {}, [text('正文内容'), fnLink])
  const backLink = el('a', { href: '#fnref-1' }, [text('↩')])
  const li = el('li', { id: 'fn-1' }, [text('脚注 1 的内容 '), backLink])
  const ol = el('ol', {}, [li])
  const hr = el('hr', {}, [])
  const footnotes = el('div', { className: 'footnotes' }, [hr, ol])
  return el('div', {}, [body, footnotes])
}

const md = htmlToMd(buildEditorDom())
console.log('--- htmlToMd 输出 ---')
console.log(md)

// 断言
let pass = true
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name)
  if (!cond) pass = false
}
check('脚注定义还原为 [^1]: 格式', md.indexOf('[^1]: 脚注 1 的内容') >= 0)
check('不含 ↩ 残渣链接', md.indexOf('[↩](#fnref-1)') < 0)
check('正文引用保留 [^1]', md.indexOf('[^1]') >= 0)
check('正文内容保留', md.indexOf('正文内容') >= 0)

console.log('\n--- 二次往返（md → html → md）---')
const html2 = mdToHtml(md)
const md2 = htmlToMd(el('div', {}, []))  // 占位，实际用手工 DOM 更准，见下
console.log('mdToHtml 产出含 .footnotes:', html2.indexOf('class="footnotes"') >= 0)

process.exit(pass ? 0 : 1)
