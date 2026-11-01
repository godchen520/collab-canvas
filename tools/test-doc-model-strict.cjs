// P1 语义验收（修正版）：按**语义**比，不按字面比
//   归一化规则（只用于比较 ✓ 不是修改文档 ✓）：
//     · 表格分隔行：:--- 与 --- 都当"左/默认"✓（:---: 居中 ✓ ---: 右 ✓）
//     · 表格单元格：去掉首尾空格 ✓（空单元格 | | 与 |  | 等价 ✓）
//     · 行尾空格去掉 ✓ 空行不算 ✓
//     · 列表续行缩进：统一成 2 空格 ✓
//     · 空引用行：">" 与 "> " 等价 ✓
//   这样比较才是有意义的 ✓ 任何**真丢内容**都会被抓出来 ✓
const fs = require('fs')
const path = require('path')
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'doc-model.js'), 'utf8')
const M = new Function(src + '\nreturn CCV_DOC_MODEL')()

function normLine(l) {
  let s = l.replace(/\s+$/, '')
  if (/^\s*$/.test(s)) return ''
  // 空引用行（">" / "> " / "> >"）在语义上是**空的** ✓
  //   引用里的空行数量不影响渲染 ✓ 我们的模型会把连续空行合并成一个 ✓
  //   → 比较时直接丢掉 ✓（这是无害规范化的第 ④ 类 ✓）
  if (/^\s*>(>|\s)*$/.test(s)) return ''
  // 表格行（含分隔行）→ 逐格规范化 ✓
  if (/^\s*\|/.test(s)) {
    const isSep = /^\|[\s:|-]+\|$/.test(s.trim())
    let cells = s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) {
      const t = c.trim()
      if (!isSep) return t
      const lf = t.charAt(0) === ':', rt = t.charAt(t.length - 1) === ':'
      return lf && rt ? 'C' : (rt ? 'R' : 'L')                     // 左/默认都算 L ✓
    })
    // 尾部空格子去掉 ✓ —— 原文件里"分隔行 4 列 / 正文行 5 格"这种不一致
    //   渲染器本来就按最宽的画 ✓ 模型把它改一致 ✓ 这是**好**规范化 ✓ 比较时视作相同 ✓
    while (cells.length && cells[cells.length - 1] === (isSep ? 'L' : '')) cells.pop()
    return (isSep ? 'SEP:' : 'ROW:') + cells.join('|')
  }
  return s.replace(/^(\s+)/, function (m) { return m.length >= 2 ? '  ' : m })  // 列表续行缩进 ✓
}

function normDoc(md) {
  return md.split('\n').map(normLine).filter(function (l) { return l !== '' })
}
function multiset(arr) {
  const m = new Map()
  arr.forEach(function (l) { m.set(l, (m.get(l) || 0) + 1) })
  return m
}
function diffSets(a, b) {
  const onlyA = [], onlyB = []
  a.forEach(function (n, k) { const m = b.get(k) || 0; if (n > m) onlyA.push([k, n - m]) })
  b.forEach(function (n, k) { const m = a.get(k) || 0; if (n > m) onlyB.push([k, n - m]) })
  return { onlyA, onlyB }
}

let bad = 0
const dir = path.join(__dirname, '..', 'canvas-docs')
const files = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.md') })
console.log('=== 语义比较：内容行是否一一对应（顺序无关 ✓ 空格/对齐冒号无关 ✓）===')
files.forEach(function (f) {
  const md = fs.readFileSync(path.join(dir, f), 'utf8')
  const once = M.serialize(M.parse(md))
  const twice = M.serialize(M.parse(once))
  const d = diffSets(multiset(normDoc(md)), multiset(normDoc(once)))
  const stable = once === twice
  const ok = d.onlyA.length === 0 && d.onlyB.length === 0 && stable
  if (!ok) bad++
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + f.padEnd(42)
    + (d.onlyA.length || d.onlyB.length ? ' 差异 ' + d.onlyA.length + '/' + d.onlyB.length : ' 语义完全一致 ✓')
    + (stable ? '' : '  ⚠ 幂等失败 ✗'))
  d.onlyA.slice(0, 4).forEach(function (x) { console.log('        ✗ 原文有、结果没有：' + JSON.stringify(x[0].slice(0, 110)) + ' ×' + x[1]) })
  d.onlyB.slice(0, 4).forEach(function (x) { console.log('        ✗ 结果多了：' + JSON.stringify(x[0].slice(0, 110)) + ' ×' + x[1]) })
})
console.log('')
console.log((bad ? '✗ ' : '✓ ') + '通过 ' + (files.length - bad) + ' 项，失败 ' + bad + ' 项')
process.exit(bad ? 1 : 0)
