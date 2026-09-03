// 校验两行顶栏：JSX 里用到的 .ccv-* 类名 与 注入 CSS 里的选择器 必须双向对齐。
// 用法：node tools/check-hdr2-css.cjs
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'src', 'client', 'editor-panel.js')
const src = fs.readFileSync(SRC, 'utf8')

// 1) 抽出 hs.textContent = [ ... ].join('\n') 里的 CSS 数组
const m = src.match(/hs\.textContent = \[([\s\S]*?)\]\.join\('\\n'\);/)
if (!m) {
  console.error('!! 找不到 hs.textContent 的 CSS 数组')
  process.exit(1)
}
let cssLines
try {
  cssLines = eval('[' + m[1] + ']')
} catch (e) {
  console.error('!! CSS 数组 eval 失败:', e.message)
  process.exit(1)
}
const css = cssLines.join('\n')
console.log('CSS 规则条数:', cssLines.length, '| 总长:', css.length)

// 2) CSS 里定义的类名
const defined = new Set()
let x
const reDef = /#collab-canvas-panel \.(ccv-[a-z0-9-]+)/g
while ((x = reDef.exec(css))) defined.add(x[1])

// 3) JSX / 事件委托里实际用到的类名
const used = new Set()
const reUse = /className:\s*"([^"]+)"/g
while ((x = reUse.exec(src))) {
  x[1].split(/\s+/).forEach(function (c) { if (c.indexOf('ccv-') === 0) used.add(c) })
}
const reClosest = /closest\("([^"]+)"\)/g
while ((x = reClosest.exec(src))) {
  x[1].split(/\s+/).forEach(function (c) {
    if (c.indexOf('ccv-') === 0) used.add(c)
  })
}

// 4) 双向比对
let bad = 0
const missing = [...used].filter(function (c) { return !defined.has(c) }).sort()
const unused = [...defined].filter(function (c) { return !used.has(c) }).sort()
console.log('CSS 定义:', defined.size, '| JSX 使用:', used.size)
if (missing.length) {
  console.log('!! 用了但没写样式:', missing.join(', '))
  bad++
} else {
  console.log('✓ 无缺样式')
}
if (unused.length) {
  console.log('!! 写了样式但没用:', unused.join(', '))
  bad++
} else {
  console.log('✓ 无冗余样式')
}

// 5) 每条规则都得带面板前缀（否则提权不够，可能被主题样式盖掉）
const noPrefix = cssLines.filter(function (l) { return l.indexOf('#collab-canvas-panel ') !== 0 })
if (noPrefix.length) {
  console.log('!! 缺少 #collab-canvas-panel 前缀的规则:', noPrefix.length)
  noPrefix.forEach(function (l) { console.log('   ' + l.slice(0, 60)) })
  bad++
} else {
  console.log('✓ 全部规则带面板前缀')
}

// 6) 花括号平衡 + 每条规则必须以 } 结尾
const bal = [...css].reduce(function (n, ch) { return n + (ch === '{' ? 1 : ch === '}' ? -1 : 0) }, 0)
if (bal !== 0) {
  console.log('!! 花括号不平衡:', bal)
  bad++
} else {
  console.log('✓ 花括号平衡')
}
cssLines.forEach(function (l, i) {
  if (l.charAt(l.length - 1) !== '}') {
    console.log('!! 第 ' + (i + 1) + ' 条规则没有以 } 结尾:', l.slice(0, 60))
    bad++
  }
})

// 7) 不允许 !important（选择器带前缀已经够提权）
const imp = cssLines.filter(function (l) { return l.indexOf('!important') >= 0 })
if (imp.length) {
  console.log('!! 含 !important 的规则:', imp.length)
  bad++
} else {
  console.log('✓ 无 !important')
}

console.log(bad ? '\nFAIL — ' + bad + ' 项问题' : '\nPASS — 全部通过')
process.exit(bad ? 1 : 0)
