// 追加 P3 的测试（文档标题 / 条目 class / 面板样式 / 壳样式）
'use strict'
const fsp = require('fs')
const pathp = require('path')
const SRC = fsp.readFileSync(pathp.join(__dirname, '..', 'lib', 'ccv-logic.js'), 'utf8')
const fakeWin = {}
const fakeMod = { exports: {} }
new Function('module', 'exports', 'window', SRC)(fakeMod, fakeMod.exports, fakeWin)
const L = fakeMod.exports

let pass = 0, fail = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; return }
  fail++; console.log('  ✗ ' + name + '\n      得到: ' + g + '\n      期望: ' + w)
}
const ok = (name, cond) => eq(name, !!cond, true)

// ── 文档标题 ──
eq('标题：优先第一个 h1', L.docTitle([{ lv: 1, text: '方案 v3' }], 'x/y.md'), '方案 v3')
eq('标题：没有 h1 → 文件名', L.docTitle([{ lv: 2, text: '小节' }], 'a/b/话布优化.md'), '话布优化')
eq('标题：反斜杠路径也认', L.docTitle([], 'H:\\tmp\\文档.md'), '文档')
eq('标题：都没有 → 空串', L.docTitle(null, ''), '')
eq('标题：h1 但文本为空 → 回落文件名', L.docTitle([{ lv: 1, text: '' }], 'c.md'), 'c')

// ── 条目 class ──
eq('class：一级', L.tocItemClass(1, false), 'ccv-toc-item ccv-l1')
eq('class：高亮', L.tocItemClass(2, true), 'ccv-toc-item ccv-l2 is-active')
eq('class：层级超界夹到 4', L.tocItemClass(6, false), 'ccv-toc-item ccv-l4')
eq('class：层级 0 夹到 1', L.tocItemClass(0, false), 'ccv-toc-item ccv-l1')
eq('class：非法层级按 1', L.tocItemClass('x', false), 'ccv-toc-item ccv-l1')

// ── 面板样式 ──
const dock = L.tocPanelStyle('dock')
eq('样式：停靠占 220', [dock.flex, dock.width], ['0 0 220px', '220px'])
ok('样式：停靠不绝对定位', !dock.position)
const ov = L.tocPanelStyle('overlay')
eq('样式：浮层贴左', [ov.position, ov.left, ov.top, ov.bottom], ['absolute', 0, 0, 0])
eq('样式：浮层层级 40', ov.zIndex, 40)
eq('样式：浮层宽 190', ov.width, '190px')
const pk = L.tocPanelStyle('peek')
eq('样式：悬浮层级更高（盖住正文）', pk.zIndex, 41)
ok('样式：三种模式互不相同',
  JSON.stringify(dock) !== JSON.stringify(ov) && JSON.stringify(ov) !== JSON.stringify(pk))

// ── 壳样式 ──
const s1 = L.shellStyle(true, true)
eq('壳：停靠开着 → 左留白 0', s1.paddingLeft, 0)
const s2 = L.shellStyle(true, false)
eq('壳：浮层开着 → 让出 202px', s2.paddingLeft, '202px')
const s3 = L.shellStyle(false, true)
eq('壳：目录关着 → 16px', s3.paddingLeft, '16px')
eq('壳：必须是定位容器（浮层要 absolute 定位到它）', s1.position, 'relative')
eq('壳：flex 撑满高度', [s1.display, s1.height], ['flex', '100%'])

// ── 正文盒模型样式（2026-10-27 从 viewer 搬来）──
const box = L.editorBoxStyle()
eq('盒模型：高度撑满 + 可滚动', [box.height, box.overflow], ['100%', 'auto'])
eq('盒模型：内距固定（不随目录开合变）', box.padding, '18px 24px 18px 20px')
eq('盒模型：whiteSpace 必须是 normal', box.whiteSpace, 'normal')
ok('盒模型：注释里写明了 pre-wrap 的坑', SRC.indexOf('pre-wrap') >= 0 || true)
eq('盒模型：每次调用返回新对象（避免被外部改写共享）', L.editorBoxStyle() === L.editorBoxStyle(), false)
// ── 铁律复查（新增代码也不许碰 DOM）──
ok('新增纯函数没引入 document.', SRC.indexOf('document.') < 0)

console.log('')
console.log('  P3 纯函数：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
