// 查看器冒烟测试（2026-10-27 重构 P7）
//
// 为什么要有：
//   BodyInner 是第二个巨石函数（713 行）✗ 要拆它，必须先有"能跑"的判据 ✗
//   否则会重演 8c019f0 的事故：搬完总检全绿、功能其实已经坏了 ✓
//
// 做法（与客户端冒烟同构）：
//   假 window + 假 React → 执行 lib/viewer-md.js → 它会自举（window.__ccvCtx 存在时）
//   → 拦截 reg.register / ctx.slots.register → 拿到正文组件 → 渲染一次
'use strict'
const fs = require('fs')
const path = require('path')

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; return }
  fail++
  console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''))
}

// ── 假 React ──
function makeReact() {
  const React = {
    createElement: function (type, props) {
      return { type: type, props: props || {} }
    },
    useState: function (init) { return [typeof init === 'function' ? init() : init, function () {}] },
    // ⚠️ 关键：effect 必须**真的执行** ✗ 否则抽 hook 时 effect 里写错完全测不出来 ✓
    //   做法：渲染时把 fn 收进队列，测试在渲染结束后按序执行（含 cleanup）✓
    _effects: [],
    useEffect: function (fn) { React._effects.push(fn) },
    useLayoutEffect: function (fn) { React._effects.push(fn) },
    useRef: function (init) { return { current: init } },
    useMemo: function (fn) { return fn() },
    useCallback: function (fn) { return fn },
    useContext: function () { return {} },
    useReducer: function (r, init) { return [init, function () {}] },
    useImperativeHandle: function () {},
    Fragment: 'Fragment',
    Component: (function () {
      function C(props) { this.props = props || {}; this.state = {} }
      C.prototype.setState = function () {}
      C.prototype.render = function () { return null }
      return C
    })(),
  }
  React.default = React
  return React
}

// ── 假 DOM ──
function el() {
  return {
    style: {}, classList: { add() {}, remove() {}, contains() { return false }, toggle() {} },
    appendChild(c) { return c }, removeChild() {}, remove() {}, setAttribute() {}, getAttribute() { return null },
    addEventListener() {}, removeEventListener() {}, querySelector() { return null },
    querySelectorAll() { return [] }, getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 900, height: 600 } },
    clientWidth: 900, clientHeight: 600, scrollTop: 0, scrollLeft: 0, scrollHeight: 1200,
    innerHTML: '', textContent: '', value: '', children: [], childNodes: [], dataset: {},
    focus() {}, blur() {}, click() {}, cloneNode() { return el() }, contains() { return false },
    insertBefore(c) { return c }, firstChild: null, parentElement: null,
  }
}

// 浏览器观察器桩：effect 里会 new ResizeObserver / IntersectionObserver
class FakeObserver {
  constructor(cb) { this.cb = cb }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function makeWindow() {
  const w = {
    __ccvSessionId: 'session-viewer-smoke',
    __ccvKit: {},
    __ccvCtx: null,
    location: { href: 'http://127.0.0.1:3080/', search: '' },
    navigator: { userAgent: 'node-smoke', clipboard: { writeText() { return Promise.resolve() } } },
    document: {
      head: { appendChild() {}, removeChild() {}, querySelector() { return null } },
      body: el(),
      documentElement: el(),
      createElement() { return el() },
      createTextNode() { return el() },
      getElementById() { return null },
      querySelector() { return null },
      querySelectorAll() { return [] },
      addEventListener() {}, removeEventListener() {},
      execCommand() { return true },
      getSelection() { return { rangeCount: 0, removeAllRanges() {}, addRange() {}, getRangeAt() { return { cloneRange() { return {} } } } } },
      createRange() { return { setStart() {}, setEnd() {}, cloneRange() { return {} }, collapse() {}, selectNodeContents() {}, toString() { return '' } } },
    },
    addEventListener() {}, removeEventListener() {},
    fetch() { return Promise.resolve({ ok: false, status: 0, text() { return Promise.resolve('') } }) },
    setTimeout() { return 0 }, clearTimeout() {}, setInterval() { return 0 }, clearInterval() {},
    requestAnimationFrame() { return 0 }, cancelAnimationFrame() {},
    getComputedStyle() { return { paddingLeft: '0px', paddingRight: '0px' } },
    localStorage: { getItem() { return null }, setItem() {}, removeItem() {} },
    matchMedia() { return { matches: false, addEventListener() {} } },
    console: console,
    Promise: Promise,
  }
  w.ResizeObserver = FakeObserver
  w.IntersectionObserver = FakeObserver
  w.MutationObserver = FakeObserver
  w.window = w
  return w
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'viewer-md.js'), 'utf8')
const win = makeWindow()
const React = makeReact()

// ── ctx 桩：viewer 需要 documentPreviews + slots ──
const registered = { previews: [], slot: [] }
const ctxStub = {
  get: function (name) {
    if (name === 'documentPreviews') {
      return { register: function (def) { registered.previews.push(def); return { dispose() {} } } }
    }
    return null
  },
  slots: {
    inject: function (name, fn) { if (typeof fn === 'function') fn(); return { dispose() {} } },
    register: function (def, comp) { registered.slot.push({ def: def, component: comp }); return { dispose() {} } },
  },
  effect: function (fn) { if (typeof fn === 'function') fn(); return { dispose() {} } },
  sessions: { list: { getSnapshot: function () { return { byId: { 'session-viewer-smoke': { displayTitle: '冒烟会话' } } } } } },
  logger: { info() {}, warn() {}, error() {} },
  on: function () { return function () {} },
  sidebarRight: { openResource() {} },
}
// ⚠️ 关键：查看器的 React 是**从主模块借的**（ensureR → window.__ccvKit.React）
//   不提供它，Body 第一行就 `if (!r) return null` ✗ 怎么改 props 都渲染不出来 ✓
win.__ccvKit = win.__ccvKit || {}
win.__ccvKit.React = React
win.__ccvKit.log = function () {}

win.__ccvCtx = ctxStub

let loadErr = null
try {
  const fn = new Function('window', 'document', 'navigator', 'localStorage', 'fetch',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
    'cancelAnimationFrame', 'getComputedStyle', 'console', 'globalThis', 'Promise', SRC)
  fn(win, win.document, win.navigator, win.localStorage, win.fetch,
    win.setTimeout, win.clearTimeout, win.setInterval, win.clearInterval,
    win.requestAnimationFrame, win.cancelAnimationFrame, win.getComputedStyle, console, win, Promise)
} catch (e) { loadErr = e }

console.log('')
console.log('══ 查看器冒烟：装载 ══')
ok('viewer-md.js 装载不抛错', !loadErr, loadErr && loadErr.message)
ok('声明接管 .md（documentPreviews.register 被调用）', registered.previews.length > 0)
ok('注册了正文组件（slots.register 被调用）', registered.slot.length > 0)
ok('注册的组件是个函数', registered.slot.length > 0 && typeof registered.slot[0].component === 'function')

// ── 渲染：正文组件需要 props（内容/路径/sessionId）──
console.log('')
console.log('══ 查看器冒烟：渲染 ══')

// 执行本轮渲染收集到的 effects（含 cleanup），effect 里的错误必须被看见 ✓
function runEffects(label) {
  var list = React._effects.slice()
  React._effects.length = 0
  var err = null
  list.forEach(function (fn) {
    try {
      var cleanup = fn()
      if (typeof cleanup === "function") { try { cleanup() } catch (e) { err = err || e } }
    } catch (e) { err = err || e }
  })
  ok(label + "：effects 执行不抛错（共 " + list.length + " 个）", !err, err && (err.message + ' @ ' + String(err.stack || '').split(String.fromCharCode(10))[1]))
  return { count: list.length, err: err }
}
const Body = registered.slot.length ? registered.slot[0].component : null
const sampleMd = [
  '# 冒烟文档',
  '',
  '一段正文。',
  '',
  '## 第一节',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '## 第二节',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
].join('\n')

let renderErr = null
let tree = null
try {
  tree = Body({
    sessionId: 'session-viewer-smoke',
    path: 'docs/smoke.md',
    absPath: 'H:/tmp/smoke.md',
    // 真实形状：props.content.text ✓（框架按 text-pages 模式加载后就是这个结构）
    content: { text: sampleMd },
    // 路径来源：BodyInner 是从 props.resourceAddress 反推 absPath 的（见源码）
    // 只给 absPath 不够 ✗ 它不信这个字段 ✓
    resourceAddress: 'dsh-resource://file/session/session-viewer-smoke/H:/tmp/smoke.md',
    useInput: null,
    useResource: null,
  })
} catch (e) { renderErr = e }
ok('正文组件渲染不抛错', !renderErr, renderErr && (renderErr.message + '\n      ' + String(renderErr.stack || '').split('\n')[1]))
ok('渲染产出元素（正文真的被构建出来）', !!tree, '返回 ' + (tree === null ? 'null' : typeof tree))
var ef1 = runEffects('首次渲染')
ok('首次渲染至少跑到一个 effect（说明 hook 编排真的执行了）', ef1.count > 0, '数量: ' + ef1.count)

let renderErr2 = null
try {
  Body({ sessionId: 'session-viewer-smoke', path: 'docs/empty.md', absPath: 'H:/tmp/empty.md', content: { text: '' } })
} catch (e) { renderErr2 = e }
ok('空内容也能渲染', !renderErr2, renderErr2 && renderErr2.message)
var ef2 = runEffects('空内容渲染')
ok('空内容渲染的 effects 也不抛错', !ef2.err, ef2.err && ef2.err.message)

// ── 未定义类错误汇总 ──
console.log('')
console.log('══ 查看器冒烟：可能漏传的依赖 ══')
const msgs = [loadErr, renderErr, renderErr2].filter(Boolean).map(function (e) { return String(e && e.message) })
const bad = msgs.filter(function (m) { return /is not a function|is not defined|undefined/i.test(m) })
ok('没有 undefined / not a function 类错误', bad.length === 0, bad.join(' | '))

console.log('')
console.log('  查看器冒烟：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
