// P1 验收：拿**真实文档**跑 md → Doc → md
//   标准（主人选的"乙"）：语义等价 + **规范化一次后稳定**（幂等 ✓）
//   所以这里验两件事：
//     ① 第二次往返必须与第一次【逐字节一致】✓（稳定 ✓）
//     ② 把第一次的差异**列出来给人看** ✓（那是一次性的规范化 ✓ 得让你过目 ✓）
//   纯逻辑 ✓ 不需要浏览器 ✓
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'doc-model.js'), 'utf8')
const M = new Function(src + '\nreturn CCV_DOC_MODEL')()
console.log('  模型已加载：' + Object.keys(M).join(' / '))

let bad = 0
const ck = (n, ok) => { if (!ok) bad++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + n) }

// ── 一、合成用例（覆盖每种块 ✓ 验幂等 ✓）──
console.log('')
console.log('=== 一、合成用例：每种块各来一份 ===')
const cases = [
  ['标题', '# 一级\n\n## 二级\n\n###### 六级\n'],
  ['段落与空行', '第一段第一行\n第一段第二行\n\n\n\n第二段\n'],
  ['代码块', '```js\nvar a = 1\n\nvar b = 2\n```\n'],
  ['引用（含嵌套）', '> 引用第一行\n> 引用第二行\n>\n> > 里层引用\n'],
  ['无序列表', '* 甲\n* 乙\n  * 乙一\n  * 乙二\n+ 丙\n'],
  ['有序列表', '1. 一\n2. 二\n3) 三\n'],
  ['表格', '| a | b |\n| :--- | ---: |\n| 1 | 2 |\n'],
  ['表格带列宽行高', '| a | b |\n| --- | --- |\n| 1 | 2 |\n<!-- ccv-table: 40,60 -->\n<!-- ccv-table-h: 32,auto -->\n'],
  ['分隔线', '上文\n\n***\n\n下文\n'],
  ['原始 HTML', '<div class="ccv-hl">\n<p>高亮块</p>\n</div>\n'],
  ['脚注', '正文[^1]\n\n[^1]: 脚注内容\n'],
  ['列表里套代码块', '- 甲\n\n  ```\n  code\n  ```\n\n- 乙\n'],
  ['引用里套表格', '> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n']
]
cases.forEach(function (c) {
  const r = M.roundTrip(c[1])
  ck(c[0] + '  → 第二次往返与第一次一致（稳定 ✓）', r.stable)
  if (!r.stable) {
    console.log('      第一次：' + JSON.stringify(r.once.slice(0, 90)))
    console.log('      第二次：' + JSON.stringify(r.twice.slice(0, 90)))
  }
})

// ── 二、真实文档（最重要的验收 ✓）──
console.log('')
console.log('=== 二、真实文档（canvas-docs 里的）===')
const dir = path.join(__dirname, '..', 'canvas-docs')
// canvas-docs/ 在 .gitignore 里（用户的真实文档，不进仓库）。
// 所以「本机有就跑、CI 上没有就跳过」—— 否则干净检出上会直接 ENOENT，
// 让整条 CI（进而 npm 发布）永远红着。
// 2026-11-01 实际踩到：本地 769 断言全过，CI 上这两份测试直接抛 ENOENT。
let files = []
if (fs.existsSync(dir)) {
  files = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.md') })
} else {
  console.log('  （跳过：canvas-docs 是本地真实文档，不在仓库里 —— 本机有就会自动跑这一段）')
}
let allStable = true
files.forEach(function (f) {
  const md = fs.readFileSync(path.join(dir, f), 'utf8')
  const r = M.roundTrip(md)
  const changed = r.once !== md
  const dOnce = changed ? diffLines(md, r.once) : null
  console.log('  ' + (r.stable ? '✓' : '✗') + ' ' + f
    + '  ' + md.length + ' 字'
    + (changed ? '  ← 会规范化：' + dOnce.changed + ' 行（一次性的 ✓）' : '  ← 完全一致 ✓'))
  if (!r.stable) { allStable = false; console.log('      ✗ 不稳定！第二次又与第一次不同 ✗') }
})
ck('所有真实文档都【稳定】（幂等 ✓）', allStable)

console.log('')
console.log((bad ? '✗ ' : '✓ ') + '通过 ' + (cases.length + files.length - bad) + ' 项，失败 ' + bad + ' 项')
process.exit(bad ? 1 : 0)

// 简单行差异统计（只看行数与不同的行数 ✓）
function diffLines(a, b) {
  const la = a.split('\n'), lb = b.split('\n')
  let changed = 0
  const n = Math.max(la.length, lb.length)
  for (let i = 0; i < n; i++) if ((la[i] || '') !== (lb[i] || '')) changed++
  return { changed, from: la.length, to: lb.length }
}
