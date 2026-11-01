// 纯逻辑层测试（2026-10-26 重构 P1）
//   为什么要它：这些算法是本会话出错最多的地方（分组、地址、会话键、目录切分）
//   以前它们埋在 4000 行的 viewer-md.js / 1649 行的 editor-panel.js 里 ✗
//   现在抽成 lib/ccv-logic.js ✓ 可以像服务端那样直接跑断言 ✓
'use strict'
const fs = require('fs')
const path = require('path')

// ⚠️ 装载方式有讲究：
//   本包的 package.json 是 "type":"module" ✗ → lib/*.js 会被 Node 当成 ESM ✓
//   那样 module.exports 根本不生效 ✓ require 回来是个空命名空间 ✗
//   但**浏览器**不受影响：侧模块是 host 端点供源码后 new Function(src)() 执行 ✓
//   所以这里用显式装载 ✓ 并且**两条通路都验**（CJS 导出 + window 全局）✓
const SRC_PATH = path.join(__dirname, '..', 'lib', 'ccv-logic.js')
const src = fs.readFileSync(SRC_PATH, 'utf8')
const fakeWindow = {}
const fakeModule = { exports: {} }
new Function('module', 'exports', 'window', src)(fakeModule, fakeModule.exports, fakeWindow)
const L = (fakeModule.exports && Object.keys(fakeModule.exports).length)
  ? fakeModule.exports
  : fakeWindow.__ccvLogic

let pass = 0, fail = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; return }
  fail++; console.log('  ✗ ' + name + '\n      得到: ' + g + '\n      期望: ' + w)
}
const ok = (name, cond) => eq(name, !!cond, true)

// ── 0. 两条装载通路都要通 ──
ok('CJS 导出可用', fakeModule.exports && typeof fakeModule.exports.hashStr === 'function')
ok('window.__ccvLogic 可用', fakeWindow.__ccvLogic && typeof fakeWindow.__ccvLogic.hashStr === 'function')
ok('两条通路是同一份实现', fakeModule.exports === fakeWindow.__ccvLogic)

// ── 1. hashStr：与历史日志实证对齐（这两个值是真实证据 ✓）──
eq('hash("DeepSeek Harness") = qberq7', L.hashStr('DeepSeek Harness'), 'qberq7')
eq('hash("默认会话") = 1nbvho8', L.hashStr('默认会话'), '1nbvho8')
eq('hash("") 有值且稳定', L.hashStr(''), L.hashStr(''))
eq('hash(null) 按空串处理（不抛）', L.hashStr(null), L.hashStr(''))
eq('hash 不同输入不同值', L.hashStr('a') === L.hashStr('b'), false)

// ── 2. 地址拼装（照官方 fileAddressFor）──
ok('真会话 id 判定', L.isRealSessionId('session-abc'))
ok('哈希键不是真 id', !L.isRealSessionId('sess-13yo9lb'))
ok('空串不是真 id', !L.isRealSessionId(''))
eq('段编码保留盘符冒号', L.encSeg('H:'), 'H:')
eq('段编码中文', L.encSeg('文档'), '%E6%96%87%E6%A1%A3')
eq('路径逐段编码', L.encPath('H:/a b/c.md'), 'H:/a%20b/c.md')
eq('反斜杠归一 + 编码',
  L.sessionFileAddress('session-x', 'H:\\a b\\c.md'),
  'dsh-resource://file/session/session-x/H:/a%20b/c.md')
eq('去掉开头 ./', L.sessionFileAddress('session-x', './a/b.md'),
  'dsh-resource://file/session/session-x/a/b.md')
eq('没有 sid → 空地址', L.sessionFileAddress('', 'a/b.md'), '')
eq('没有路径 → 空地址', L.sessionFileAddress('session-x', ''), '')

// ── 3. 宽高判据 ──
eq('宽>高 → 停靠', L.pickDocked(900, 700), true)
eq('宽=高 → 停靠', L.pickDocked(700, 700), true)
eq('窄高 → 浮层', L.pickDocked(700, 900), false)
eq('尺寸未知 → 不判断', L.pickDocked(30, 900), null)
eq('尺寸为 0 → 不判断', L.pickDocked(0, 0), null)

// ── 4. 旧键反查表 ──
const byId = {
  'session-a': { displayTitle: '共创话布' },
  'session-b': { title: '另一个会话', displayTitle: '' },
}
const map = L.hashKeyMap(byId)
eq('反查表：sess- 前缀命中', map['sess-' + L.hashStr('共创话布')], 'session-a')
eq('反查表：t 前缀也建', map['t' + L.hashStr('共创话布')], 'session-a')
eq('反查表：title 兜底', map['sess-' + L.hashStr('另一个会话')], 'session-b')
eq('反查表：空对象', L.hashKeyMap(null), {})

// ── 5. 分组拼装（重点）──
const canvases = [
  { id: 'c1', title: 'A', updatedAt: 300 },
  { id: 'c2', title: 'B', updatedAt: 200 },
  { id: 'c3', title: 'C', updatedAt: 100 },
  { id: 'c4', title: 'D', updatedAt: 50 },
]
const titleOf = (sid) => (byId[sid] ? (byId[sid].displayTitle || byId[sid].title) : '')
const g1 = L.buildGroups({
  canvases,
  groups: [
    // 旧键必须用**真实哈希**构造 ✓ 否则反查当然不中 ✗（我第一版测试就写错过 ✓）
    { sid: 'sess-' + L.hashStr('共创话布'), real: false, ids: ['c2'] },
    { sid: 'session-b', real: true, ids: ['c3'] },             // 真会话
    { sid: 'default', real: false, ids: ['c1'] },              // 认不出的旧键
  ],
}, 'session-b', byId, titleOf)
eq('分组：未归属 c4 最后', g1.groups[g1.groups.length - 1].sid, '__orphan__')
eq('分组：当前会话置顶', g1.groups[0].sid, 'session-b')
eq('分组：旧键反查成功 → 归到真会话', g1.groups.filter(x => x.sid === 'session-a').length, 1)
eq('分组：反查成功的组带 matched', g1.groups.filter(x => x.sid === 'session-a')[0].matched, true)
eq('分组：认不出的旧键带 legacy', g1.groups.filter(x => x.sid === 'default')[0].legacy, true)
eq('分组：认不出的旧键垫底（除未归属）',
  g1.groups[g1.groups.length - 2].sid, 'default')
eq('分组：总数', g1.total, 4)
eq('分组：组内按 updatedAt 倒序',
  g1.groups.filter(x => x.sid === '__orphan__')[0].items[0].id, 'c4')

// 同一真会话被多个旧键反查到 → 必须合并成一组（上次的 bug ✓）
const g2 = L.buildGroups({
  canvases,
  groups: [
    { sid: 'sess-' + L.hashStr('共创话布'), real: false, ids: ['c2'] },
    { sid: 't' + L.hashStr('共创话布'), real: false, ids: ['c1'] },
    { sid: 'session-a', real: true, ids: ['c3'] },
  ],
}, 'session-a', byId, titleOf)
eq('合并：三份指向同一会话 → 合成一组', g2.groups.filter(x => x.sid === 'session-a').length, 1)
eq('合并：组内条目 3 篇', g2.groups.filter(x => x.sid === 'session-a')[0].items.length, 3)
eq('合并：keys 记下所有原键', g2.groups.filter(x => x.sid === 'session-a')[0].keys.length, 3)
eq('合并：不重复出同名组', g2.groups.length, 2)   // session-a + 未归属

// 空数据
eq('空数据不炸', L.buildGroups(null, '', null, null), { groups: [], total: 0 })

// ── 6. 归属归一（服务端同一套规则的镜像）──
const n1 = L.normalizeOwnership([
  { key: 'default', ids: ['x', 'y'] },
  { key: 'session-z', ids: ['x'] },
  { key: 'sess-1', ids: ['y'] },
])
eq('归一：真会话优先拿到 x', n1.owner['x'], 'session-z')
eq('归一：y 按键名升序给 default', n1.owner['y'], 'default')
eq('归一：default 只留 y', n1.keep['default'], ['y'])
eq('归一：session-z 留 x', n1.keep['session-z'], ['x'])
eq('归一：sess-1 被清空', n1.keep['sess-1'], [])
eq('归一：每篇只有一个归属',
  Object.keys(n1.owner).length, 2)

// ── 7. 目录切分 ──
const sp = L.splitOutline([
  { lv: 1, text: '文档标题' },
  { lv: 1, text: '一、甲' },
  { lv: 2, text: '1. 乙' },
])
eq('切分：顶部标题 = 第一个 h1', sp.headTitle, '文档标题')
eq('切分：列表跳过它', sp.listStart, 1)
eq('切分：列表剩 2 条', sp.rest.length, 2)
const sp2 = L.splitOutline([{ lv: 2, text: '只有二级' }])
eq('切分：没有 h1 时顶部标题为空', sp2.headTitle, '')
eq('切分：没有 h1 时不跳过', sp2.listStart, 0)
eq('切分：空列表', L.splitOutline(null), { headTitle: '', listStart: 0, rest: [] })

// ── 8. 路宽换算 ──
eq('目录宽：停靠', L.tocWidth(true), 220)
eq('目录宽：浮层', L.tocWidth(false), 190)
eq('外层留白：目录关着', L.shellPadLeft(false, true), '16px')
eq('外层留白：停靠开着', L.shellPadLeft(true, true), 0)
eq('外层留白：浮层开着', L.shellPadLeft(true, false), '202px')

// ── 9. 铁律：这个模块不许碰 DOM/window ──
const logicBody = src.slice(src.indexOf('var CCV_LOGIC'), src.indexOf('})(\n\n//'))
ok('纯函数层不出现 document.', logicBody.indexOf('document.') < 0)
ok('纯函数层不出现 setTimeout', logicBody.indexOf('setTimeout') < 0)
ok('纯函数层不出现 fetch(', logicBody.indexOf('fetch(') < 0)

console.log('')
console.log('  纯逻辑层：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
