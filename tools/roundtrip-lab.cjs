#!/usr/bin/env node
// 往返实验室：抽出编辑器真实的 mdToHtml / htmlToMd，配最小 DOM 垫片，
// 实测「markdown → HTML → markdown」的保真度。
// 用法：node tools/roundtrip-lab.cjs
'use strict'
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'src', 'client', 'editor-panel.js')
const code = fs.readFileSync(SRC, 'utf8')

// ─── 1. 按大括号配对抽出函数全文 ──────────────────────────────
function extractFn(source, header) {
  const start = source.indexOf(header)
  if (start < 0) throw new Error('未找到: ' + header)
  let i = source.indexOf('{', start)
  let depth = 0
  for (; i < source.length; i++) {
    const c = source[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error('大括号不配对: ' + header)
}

const fnHtmlToMd = extractFn(code, 'function htmlToMd(root) {')
const fnMdToHtml = extractFn(code, 'function mdToHtml(src) {')

// ─── 2. 最小 DOM：解析 mdToHtml 产出的 HTML 子集 ────────────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: '\u00a0' }
function decode(s) {
  return s.replace(/&(#39|amp|lt|gt|quot|nbsp);/g, function (_, k) { return ENT[k] })
}

function parseHTML(html) {
  const root = mkEl('#root')
  const stack = [root]
  let i = 0
  const top = () => stack[stack.length - 1]
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) { addText(top(), html.slice(i)); break }
    if (lt > i) addText(top(), html.slice(i, lt))
    const gt = findTagEnd(html, lt)
    if (gt < 0) { addText(top(), html.slice(lt)); break }
    const raw = html.slice(lt + 1, gt).trim()
    i = gt + 1
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase()
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tagName.toLowerCase() === name) { stack.length = k; break }
      }
      continue
    }
    const selfClose = raw.endsWith('/')
    const body = selfClose ? raw.slice(0, -1).trim() : raw
    const sp = body.search(/\s/)
    const tagName = (sp < 0 ? body : body.slice(0, sp)).toLowerCase()
    const attrs = sp < 0 ? '' : body.slice(sp)
    const el = mkEl(tagName)
    parseAttrs(attrs, el)
    top().childNodes.push(el)
    el.parentElement = top()
    const VOID = { br: 1, hr: 1, img: 1, input: 1 }
    if (!selfClose && !VOID[tagName]) stack.push(el)
  }
  return root
}
function findTagEnd(s, from) {
  let q = null
  for (let i = from + 1; i < s.length; i++) {
    const c = s[i]
    if (q) { if (c === q) q = null; continue }
    if (c === '"' || c === "'") { q = c; continue }
    if (c === '>') return i
  }
  return -1
}
function parseAttrs(s, el) {
  // 有名属性 name="value"
  const re = /([\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let m
  while ((m = re.exec(s)) !== null) el._attrs[m[1].toLowerCase()] = decode(m[3] != null ? m[3] : m[4])
  // 无值属性（disabled / checked 等）：先剔掉已有名属性，剩下的裸词就是
  const bare = s.replace(/([\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, ' ')
  const re2 = /(?:^|\s)([\w-]+)(?=\s|$)/g
  while ((m = re2.exec(bare)) !== null) {
    const k = m[1].toLowerCase()
    if (!Object.prototype.hasOwnProperty.call(el._attrs, k)) el._attrs[k] = ''
  }
}
function addText(parent, text) {
  if (!text) return
  const n = { nodeType: 3, nodeValue: decode(text), parentElement: parent }
  parent.childNodes.push(n)
}
function mkEl(tagName) {
  const el = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    childNodes: [],
    parentElement: null,
    _attrs: {},
    get id() { return this._attrs.id || '' },
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null },
    hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) },
    // 浏览器里 checkbox 的 checked 是「属性 + 用户状态」；这里按属性镜像，够用
    get checked() { return Object.prototype.hasOwnProperty.call(this._attrs, 'checked') },
    get classList() {
      const set = String(this._attrs.class || '').split(/\s+/).filter(Boolean)
      return { contains: (c) => set.indexOf(c) >= 0 }
    },
    get textContent() {
      let out = ''
      const walk = (n) => {
        if (n.nodeType === 3) { out += n.nodeValue; return }
        ;(n.childNodes || []).forEach(walk)
      }
      ;(this.childNodes || []).forEach(walk)
      return out
    },
    querySelector(sel) { const r = queryAll(this, sel); return r.length ? r[0] : null },
    querySelectorAll(sel) { return queryAll(this, sel) }
  }
  return el
}
// 支持：tag、tag, tag、tag[attr^="v"]
function matchSimple(el, sel) {
  const m = /^([\w-]+)(?:\[([\w-]+)\^?=\s*"([^"]*)"\])?$/.exec(sel.trim())
  if (!m || el.nodeType !== 1) return false
  if (el.tagName.toLowerCase() !== m[1].toLowerCase()) return false
  if (m[2]) {
    const v = el.getAttribute(m[2]) || ''
    if (v.indexOf(m[3]) !== 0) return false
  }
  return true
}
function queryAll(root, sel) {
  const parts = String(sel).split(',').map(s => s.trim()).filter(Boolean)
  const out = []
  const walk = (n) => {
    ;(n.childNodes || []).forEach(c => {
      if (c.nodeType === 1) {
        if (parts.some(p => matchSimple(c, p))) out.push(c)
        walk(c)
      }
    })
  }
  walk(root)
  return out
}

// ─── 3. 装配 ────────────────────────────────────────────────
global.document = {
  createElement(tag) { return mkEl(tag) }
}
const build = new Function(
  'document',
  fnMdToHtml + '\n' + fnHtmlToMd + '\nreturn { mdToHtml: mdToHtml, htmlToMd: htmlToMd };'
)(global.document)
const { mdToHtml, htmlToMd } = build

// ─── 4. 测试用例 ─────────────────────────────────────────────
const CASES = [
  ['标题', '# H1\n\n## H2\n\n### H3'],
  ['段落', '第一段\n\n第二段'],
  ['粗体斜体删除线', '**粗** *斜* ~~删~~'],
  ['行内代码', '这是 `code` 用法'],
  ['代码块', '```\nline1\nline2\n```'],
  ['引用', '> 引用内容'],
  ['无序列表', '- 甲\n- 乙\n- 丙'],
  ['有序列表', '1. 甲\n2. 乙\n3. 丙'],
  ['嵌套无序', '- 甲\n  - 甲一\n  - 甲二\n- 乙'],
  ['嵌套有序', '1. 甲\n   1. 甲一\n   2. 甲二\n2. 乙'],
  ['列表套列表(混合)', '- 甲\n  1. 甲一\n  2. 甲二\n- 乙'],
  ['任务列表', '- [ ] 未完成\n- [x] 已完成'],
  ['表格', '| A | B |\n| --- | --- |\n| 1 | 2 |'],
  ['表格三列', '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |'],
  ['链接', '[文字](https://x.com)'],
  ['图片', '![alt](a.png)'],
  ['分割线', '上\n\n---\n\n下'],
  ['引用套表格', '> | A | B |\n> | --- | --- |\n> | 1 | 2 |'],
  ['引用套列表', '> - 甲\n> - 乙'],
  ['列表套代码块', '- 甲\n\n  ```\n  code\n  ```\n\n- 乙'],
  ['脚注', '正文[^1]\n\n[^1]: 脚注内容'],
  ['表格单元格含代码', '| A | B |\n| --- | --- |\n| `x` | `y` |'],
  ['表格单元格含粗体', '| A | B |\n| --- | --- |\n| **x** | *y* |'],
  ['粗体里嵌代码含星号', '**反拆分回 `src/host/*.js`**'],
  ['多级嵌套列表', '- 一\n  - 二\n    - 三'],
]

// 归一化：去掉行尾空格、折叠 3+ 空行
function norm(s) {
  return String(s).split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

console.log('往返保真测试：md → mdToHtml → HTML → htmlToMd → md')
console.log('（每个用例跑两轮，判断漂移是「收敛」还是「累积恶化」）')
console.log('='.repeat(70))
let ok = 0, bad = 0, unstable = 0
const failures = []
CASES.forEach(function (c) {
  const name = c[0], md = c[1]
  let r1, r2
  try {
    const trip = (src) => htmlToMd(parseHTML(mdToHtml(src)))
    r1 = norm(trip(md))
    r2 = norm(trip(r1))
  } catch (e) {
    console.log('✗ ' + name + '  —— 抛错: ' + e.message)
    failures.push({ name: name, md: md, out: '(抛错) ' + e.message })
    bad++
    return
  }
  const a = norm(md)
  const lossless = a === r1
  const stable = r1 === r2
  if (!stable) unstable++
  if (lossless) { console.log('✓ ' + name); ok++ }
  else {
    console.log('✗ ' + name + (stable ? '   [漂移已收敛]' : '   ⚠️ [仍在变化！]'))
    console.log('    1 轮: ' + JSON.stringify(r1))
    console.log('    2 轮: ' + JSON.stringify(r2))
    failures.push({ name: name, md: a, out: r1, out2: r2, stable: stable })
    bad++
  }
})
console.log('='.repeat(70))
console.log('无损 ' + ok + ' / 有损 ' + bad + ' / 共 ' + CASES.length)
console.log('其中漂移未收敛的: ' + unstable + ' 个' + (unstable ? '  ⚠️ 属累积恶化，需优先处理' : '  （有损项均一轮收敛，属一次性格式漂移）'))

if (process.argv.indexOf('--detail') >= 0 && failures.length) {
  console.log('\n=== 失败明细 ===')
  failures.forEach(f => {
    console.log('\n【' + f.name + '】')
    console.log('输入:\n' + f.md)
    console.log('输出:\n' + f.out)
  })
}
