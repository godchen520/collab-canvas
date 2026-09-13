#!/usr/bin/env node
// round-trip 测试：从 editor-panel.js 源码里抽出真实的 htmlToMd / mdToHtml，
// 用极简 DOM shim 跑一遍，验证「脚注 / 表格 / 引用 / 代码块」在往返中不退化。
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
  node.hasAttribute = (n) => (node._attrs[n] !== undefined && node._attrs[n] !== null)
  // 支持 tag 与 tag[attr="val"] / tag[attr^="val"] 形式的选择器
  function parseSel(s) {
    const m = String(s).trim().match(/^([a-zA-Z0-9]+)(?:\[([a-zA-Z-]+)(\^?)=["']?([^"'\]]*)["']?\])?$/)
    if (!m) return null
    return { tag: m[1].toLowerCase(), attr: m[2] ? m[2].toLowerCase() : null, op: m[3] || '=', val: m[4] }
  }
  node.querySelectorAll = function (sel) {
    const parts = String(sel).split(',').map(parseSel).filter(Boolean)
    const res = []
    ;(function walk(n) {
      ;(n.childNodes || []).forEach(function (c) {
        if (c.nodeType !== 1) return
        const tag = c.tagName.toLowerCase()
        for (let pi = 0; pi < parts.length; pi++) {
          const p = parts[pi]
          if (p.tag !== tag) continue
          if (p.attr) {
            const av = c.getAttribute ? c.getAttribute(p.attr) : null
            if (p.op === '^') { if (!(av && av.indexOf(p.val) === 0)) continue }
            else if (av !== p.val) continue
          }
          res.push(c)
          break
        }
        walk(c)
      })
    })(node)
    return res
  }
  node.querySelector = function (sel) {
    const all = node.querySelectorAll(sel)
    return all.length ? all[0] : null
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

let pass = true
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name)
  if (!cond) pass = false
}

// ─── 1. 脚注 round-trip ──────────────────────────────
function buildFootnoteDom() {
  const fnLink = el('a', { href: '#fn-1', id: 'fnref-1' }, [text('[1]')])
  const body = el('p', {}, [text('正文内容'), fnLink])
  const backLink = el('a', { href: '#fnref-1' }, [text('↩')])
  const li = el('li', { id: 'fn-1' }, [text('脚注 1 的内容 '), backLink])
  const ol = el('ol', {}, [li])
  const footnotes = el('div', { className: 'footnotes' }, [el('hr', {}, []), ol])
  return el('div', {}, [body, footnotes])
}
console.log('--- 1. 脚注 ---')
const mdFn = htmlToMd(buildFootnoteDom())
check('脚注定义还原为 [^1]: 格式', mdFn.indexOf('[^1]: 脚注 1 的内容') >= 0)
check('不含 ↩ 残渣链接', mdFn.indexOf('[↩](#fnref-1)') < 0)
check('正文引用保留 [^1]', /\[\^1\](?!:)/.test(mdFn))

// ─── 2. 表格：DOM → md ───────────────────────────────
console.log('--- 2. 表格（htmlToMd）---')
function buildTableDom() {
  const th1 = el('th', {}, [text('路径')])
  const th2 = el('th', {}, [text('目的')])
  const trHead = el('tr', {}, [th1, th2])
  const code = el('code', {}, [text('H2')])
  const td1 = el('td', {}, [el('strong', {}, [text('快捷键')]), text('切换')])
  const td2 = el('td', {}, [code])
  const trBody = el('tr', {}, [td1, td2])
  const table = el('table', {}, [trHead, trBody])
  return el('div', {}, [el('p', {}, [text('前置段落')]), table])
}
const mdTbl = htmlToMd(buildTableDom())
console.log(mdTbl)
check('表头行还原', mdTbl.indexOf('| 路径 | 目的 |') >= 0)
check('分隔行存在', /\| --- \| --- \|/.test(mdTbl))
check('单元格行内格式保留（**快捷键**）', mdTbl.indexOf('**快捷键**') >= 0)
check('单元格行内代码保留（`H2`）', mdTbl.indexOf('`H2`') >= 0)
check('不含裸 <table> 残留', mdTbl.indexOf('<table') < 0)

// ─── 3. mdToHtml：表格 / 引用嵌套 / 代码块 ────────────
console.log('--- 3. mdToHtml 块级 ---')
const tblMd = [
  '| # | 原则 |',
  '|---|------|',
  '| 1 | **AI 置顶** |',
  '| 2 | 图标即操作 |',
].join('\n')
const tblHtml = mdToHtml(tblMd)
check('表格渲染成 <table>', tblHtml.indexOf('<table>') >= 0)
check('首行是表头 <th>', tblHtml.indexOf('<th>') >= 0)
check('正文行是 <td>', tblHtml.indexOf('<td>') >= 0)
check('行内粗体保留', tblHtml.indexOf('<strong>AI 置顶</strong>') >= 0)
check('不再输出裸管道符 <p>|', tblHtml.indexOf('<p>|') < 0)

const bqMd = ['> 引用标题', '> - 列表项 A', '> - 列表项 B'].join('\n')
const bqHtml = mdToHtml(bqMd)
check('引用整体一个 <blockquote>', (bqHtml.match(/<blockquote>/g) || []).length === 1)
check('引用内列表渲染 <li>', bqHtml.indexOf('<li>列表项 A</li>') >= 0)

const bqTblHtml = mdToHtml('> | A | B |\n> |---|---|\n> | 1 | 2 |')
check('引用内表格也渲染', bqTblHtml.indexOf('<table>') >= 0)

const codeHtml = mdToHtml('```\n| 不是表格 |\n```')
check('代码块内 | 不被当表格', codeHtml.indexOf('<pre><code>| 不是表格 |</code></pre>') >= 0)

const listHtml = mdToHtml('- 甲\n- 乙\n- 丙')
check('连续列表合成一个 <ul>', (listHtml.match(/<ul>/g) || []).length === 1 && (listHtml.match(/<li>/g) || []).length === 3)

// ─── 4. md → html → DOM → md 全链路（表格）────────────
console.log('--- 4. 表格全链路 ---')
// 把 mdToHtml 产出的表格 HTML 手工搭回 DOM，验证 htmlToMd 能还原
function buildTableDom2() {
  const trHead = el('tr', {}, [el('th', {}, [text('A')]), el('th', {}, [text('B')])])
  const trBody = el('tr', {}, [el('td', {}, [text('1')]), el('td', {}, [text('2')])])
  return el('div', {}, [el('table', {}, [trHead, trBody])])
}
const mdTbl2 = htmlToMd(buildTableDom2())
check('全链路还原表头', mdTbl2.indexOf('| A | B |') >= 0)
const htmlTbl2 = mdToHtml(mdTbl2)
check('还原后再渲染仍是 <table>', htmlTbl2.indexOf('<table>') >= 0)

// ─── 5. 列表 round-trip ─────────────────────────────
console.log('--- 5. 列表 ---')
function buildUlDom() {
  return el('div', {}, [
    el('ul', {}, [
      el('li', {}, [text('甲')]),
      el('li', {}, [el('strong', {}, [text('乙')]), text('说明')]),
      el('li', {}, [text('丙')]),
    ]),
  ])
}
const mdUl = htmlToMd(buildUlDom())
console.log(JSON.stringify(mdUl))
check('无序列表还原 - 标记', mdUl.indexOf('- 甲') >= 0)
check('列表项行内粗体保留', mdUl.indexOf('- **乙**说明') >= 0)
check('三项都保留（不是拼成一坨）', (mdUl.match(/^- /gm) || []).length === 3)

const mdOl = htmlToMd(el('div', {}, [
  el('ol', {}, [el('li', {}, [text('一')]), el('li', {}, [text('二')])]),
]))
check('有序列表还原 1./2.', mdOl.indexOf('1. 一') >= 0 && mdOl.indexOf('2. 二') >= 0)

const mdNested = htmlToMd(el('div', {}, [
  el('ul', {}, [
    el('li', {}, [text('甲'), el('ul', {}, [el('li', {}, [text('子项')])])]),
  ]),
]))
check('嵌套列表缩进 2 空格', mdNested.indexOf('  - 子项') >= 0)

const mdSiblingUl = htmlToMd(el('div', {}, [
  el('ul', {}, [
    el('li', {}, [text('甲')]),
    el('ul', {}, [el('li', {}, [text('乙')])]),
  ]),
]))
check('兄弟节点形式的子列表也能还原', mdSiblingUl.indexOf('  - 乙') >= 0)

// ─── 6. 标题层级 h5/h6 ──────────────────────────────
console.log('--- 6. 标题层级 ---')
check('h5 还原 #####', htmlToMd(el('div', {}, [el('h5', {}, [text('五级')])])).indexOf('##### 五级') >= 0)
check('h6 还原 ######', htmlToMd(el('div', {}, [el('h6', {}, [text('六级')])])).indexOf('###### 六级') >= 0)

// ─── 7. 图片 ────────────────────────────────────────
console.log('--- 7. 图片 ---')
check('md 图片渲染成 <img>', mdToHtml('![图](x.png)').indexOf('<img') >= 0)
check('图片不被链接规则啃掉', mdToHtml('![图](x.png)').indexOf('!<a') < 0)
const mdImg = htmlToMd(el('div', {}, [el('img', { src: 'data:image/png;base64,AAA', alt: '图' }, [])]))
check('img 还原 ![alt](src)', mdImg.indexOf('![图](data:image/png;base64,AAA)') >= 0)

// ─── 8. 任务列表 + 嵌套 ─────────────────────────────
console.log('--- 8. 任务列表 / 嵌套 ---')
const taskHtml = mdToHtml('- [ ] 待办\n- [x] 完成')
// 复选框是有意做成「可点击」的（不带 disabled，CSS 给了 cursor:pointer），
// 所以这里断言不带 disabled；勾选状态靠 htmlToMd 读 .checked 回写。
check('未勾选渲染成复选框', taskHtml.indexOf('<input type="checkbox"> 待办') >= 0)
check('已勾选渲染成 checked 复选框', taskHtml.indexOf('<input type="checkbox" checked> 完成') >= 0)
check('任务项仍在同一个 <ul>', (taskHtml.match(/<ul>/g) || []).length === 1)

function buildTaskDom() {
  const cbDone = el('input', { type: 'checkbox', checked: '' }, [])
  const cbTodo = el('input', { type: 'checkbox' }, [])
  return el('div', {}, [
    el('ul', {}, [
      el('li', {}, [cbTodo, text('待办')]),
      el('li', {}, [cbDone, text('完成')]),
    ]),
  ])
}
const mdTask = htmlToMd(buildTaskDom())
check('未勾选还原 - [ ]', mdTask.indexOf('- [ ] 待办') >= 0)
check('已勾选还原 - [x]', mdTask.indexOf('- [x] 完成') >= 0)
check('两项都保留（不是拼成一坨）', (mdTask.match(/^- \[[ x]\] /gm) || []).length === 2)

const nestedHtml = mdToHtml('- 甲\n  - 子a\n  - 子b\n- 乙')
check('嵌套渲染出两个 <ul>', (nestedHtml.match(/<ul>/g) || []).length === 2)
check('子列表嵌在父 <li> 内', nestedHtml.indexOf('<li>甲<ul>') >= 0)
const mdNested2 = htmlToMd(el('div', {}, [
  el('ul', {}, [
    el('li', {}, [text('甲'), el('ul', {}, [el('li', {}, [text('子a')]), el('li', {}, [text('子b')])])]),
    el('li', {}, [text('乙')]),
  ]),
]))
check('多层嵌套还原 2 空格缩进', mdNested2.indexOf('  - 子a') >= 0 && mdNested2.indexOf('  - 子b') >= 0)

// 混合：嵌套 + 任务列表
const mixedHtml = mdToHtml('- [ ] 主任务\n  - 子说明\n  - [x] 子任务')
check('混合嵌套 + 任务列表渲染两个 <ul>', (mixedHtml.match(/<ul>/g) || []).length === 2)
const mdMixed = htmlToMd(el('div', {}, [
  el('ul', {}, [
    el('li', {}, [
      el('input', { type: 'checkbox' }, []), text('主任务'),
      el('ul', {}, [
        el('li', {}, [text('子说明')]),
        el('li', {}, [el('input', { type: 'checkbox', checked: '' }, []), text('子任务')]),
      ]),
    ]),
  ]),
]))
check('混合还原 - [ ] 主任务', mdMixed.indexOf('- [ ] 主任务') >= 0)
check('混合还原嵌套 - 子说明', mdMixed.indexOf('  - 子说明') >= 0)
check('混合还原嵌套 - [x] 子任务', mdMixed.indexOf('  - [x] 子任务') >= 0)

console.log(pass ? '\nALL PASS' : '\nHAS FAILURES')
process.exit(pass ? 0 : 1)
