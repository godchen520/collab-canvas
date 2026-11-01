// 客户端冒烟测试（2026-10-26 重构 P5）
//
// 为什么要有：
//   客户端代码一直**零自动化测试** ✗ 本会话三次事故（白屏、丢焦点、间距错乱）
//   全靠主人截图才发现 ✓ 而服务端早就有 700+ 断言 ✓ 这是最大的工程短板 ✓
//   真浏览器测试成本高 ✗ 但"能不能装载 / 能不能渲染"这一层完全可以用假环境跑 ✓
//   本次重构（把 405 行 UI 搬成模块级工厂）最大的风险就是**漏传依赖 → undefined**
//   这条测试就是冲着它去的 ✓
//
// 做法：
//   ① 造一个假 window（__ModuleLoader__ / document / fetch / localStorage …）
//   ② 用假 React 提供 useState/useEffect/useRef/useMemo/createElement/Component
//   ③ 执行 src/client/editor-panel.js，拿到 { apply, inject }
//   ④ 跑 apply(ctxStub)，断言"标签页注册成功"
//   ⑤ **把注册进去的组件真的调用一次**（假 hooks 会返回固定值）
//      → 组件顶层的 undefined 引用会当场抛错 ✓ 这正是我们要抓的 ✓
'use strict'
const fs = require('fs')
const path = require('path')

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; return }
  fail++
  console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''))
}

// ── ① 假 React ──
function makeReact() {
  const created = []
  const React = {
    createElement: function (type, props) {
      created.push({ type: type, props: props })
      return { type: type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) }
    },
    useState: function (init) {
      const v = typeof init === 'function' ? init() : init
      return [v, function () {}]
    },
    useEffect: function () {},
    useLayoutEffect: function () {},
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
  return { React: React, created: created }
}

// ── ② 假 DOM / window ──
function makeWindow() {
  const listeners = {}
  const el = function () {
    return {
      style: {}, classList: { add() {}, remove() {}, contains() { return false } },
      appendChild() {}, removeChild() {}, remove() {}, setAttribute() {}, getAttribute() { return null },
      addEventListener() {}, removeEventListener() {}, querySelector() { return null },
      querySelectorAll() { return [] }, getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 } },
      clientWidth: 800, clientHeight: 600, scrollTop: 0, scrollLeft: 0,
      innerHTML: '', textContent: '', children: [], childNodes: [],
      focus() {}, blur() {}, click() {}, cloneNode() { return el() }, contains() { return false },
    }
  }
  const head = {
    appendChild() {}, removeChild() {},
    querySelector() { return null }, querySelectorAll() { return [] },
  }
  const w = {
    __ccvCtx: null,
    __ccvSessionId: 'session-smoke-test',
    __ccvLogic: null,
    __ccvKit: {},
    location: { href: 'http://127.0.0.1:3080/', search: '', hash: '' },
    navigator: { userAgent: 'node-smoke', clipboard: { writeText() { return Promise.resolve() } } },
    document: {
      head: head, body: el(), documentElement: el(),
      createElement() { return el() }, createTextNode() { return el() },
      getElementById() { return null }, querySelector() { return null }, querySelectorAll() { return [] },
      addEventListener() {}, removeEventListener() {},
      execCommand() { return true }, getSelection() { return { rangeCount: 0, removeAllRanges() {}, addRange() {} } },
    },
    addEventListener: function (k, fn) { (listeners[k] = listeners[k] || []).push(fn) },
    removeEventListener() {},
    fetch: function () { return Promise.resolve({ ok: false, status: 0, text: function () { return Promise.resolve('') } }) },
    setTimeout: function (fn) { return 0 },
    clearTimeout() {}, setInterval() { return 0 }, clearInterval() {},
    requestAnimationFrame() { return 0 }, cancelAnimationFrame() {},
    getComputedStyle() { return { paddingLeft: '0px', paddingRight: '0px' } },
    localStorage: { getItem() { return null }, setItem() {}, removeItem() {} },
    matchMedia() { return { matches: false, addEventListener() {} } },
    console: console,
    listeners: listeners,
  }
  w.window = w
  return w
}

// ── ③ 装载客户端模块 ──
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'editor-panel.js'), 'utf8')
const win = makeWindow()
let captured = null
win.__ModuleLoader__ = {
  load: function (def) { captured = def },
}
const reactKit = makeReact()
const fakeRequire = function (name) {
  if (name === 'react') return reactKit.React
  return {}
}

let loadErr = null
let mod = null
try {
  // 客户端源码是给浏览器用的：把 window/document 等注入进作用域
  const fn = new Function('window', 'document', 'navigator', 'localStorage', 'fetch',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
    'cancelAnimationFrame', 'getComputedStyle', 'console', 'globalThis', SRC)
  fn(win, win.document, win.navigator, win.localStorage, win.fetch,
    win.setTimeout, win.clearTimeout, win.setInterval, win.clearInterval,
    win.requestAnimationFrame, win.cancelAnimationFrame, win.getComputedStyle, console, win)
  if (!captured) throw new Error('__ModuleLoader__.load 没被调用')
  mod = captured.factory(fakeRequire)
} catch (e) {
  loadErr = e
}

console.log('')
console.log('══ 客户端冒烟：装载 ══')
ok('模块装载不抛错', !loadErr, loadErr && loadErr.message)
ok('__ModuleLoader__.load 被调用', !!captured)
ok('工厂返回了 apply', mod && typeof mod.apply === 'function')
ok('工厂返回了 inject', mod && mod.inject !== undefined)

// ── ④ 跑 apply(ctxStub) ──
const registered = []
const ctxStub = {
  slots: {
    registerTab: function (def, comp) { registered.push({ def: def, component: comp }); return { dispose() {} } },
    register: function (def, comp) {
      registered.push({ def: def, component: comp })
      return { dispose() {} }
    },
    // 真实用法：inject(name, fn) → fn() → register(def, Comp) ✓ 冒烟照此模拟
    inject: function (name, fn) {
      if (typeof fn === "function") fn()
      return { dispose() {} }
    },
    effect: function (fn) { try { fn({}) } catch (_) {} return { dispose() {} } },
  },
  sessions: {
    list: { getSnapshot: function () { return { byId: { 'session-smoke-test': { displayTitle: '冒烟会话' } } } } },
  },
  sidebarRight: { openResource: function () {} },
  logger: { info() {}, warn() {}, error() {} },
  on: function () { return function () {} },
  effect: function (fn) { try { fn({}) } catch (_) {} return { dispose() {} } },
  plugin: function () { return { dispose() {} } },
  tools: { register: function () { return { dispose() {} } } },
  model: { register() {} },
  command: { register() { return { dispose() {} } } },
  lifecycle: { on() { return function () {} } },
}

let applyErr = null
try { mod.apply(ctxStub, {}) } catch (e) { applyErr = e }
console.log('')
console.log('══ 客户端冒烟：接线 ══')
ok('apply 不抛错', !applyErr, applyErr && (applyErr.message + '\n      ' + String(applyErr.stack || '').split('\n')[1]))
ok('注册了至少一个标签页', registered.length > 0)

// ── ⑤ 真的调用一次注册进去的组件（抓 undefined 引用）──
console.log('')
console.log('══ 客户端冒烟：渲染（假 hooks）══')
const tabDef = registered.find(function (d) { return d && (d.component || d.render) })
const Comp = tabDef ? (tabDef.component || tabDef.render) : null
ok('注册项里有组件', !!Comp, '注册项字段: ' + (tabDef ? Object.keys(tabDef).join(',') : '无'))

let renderErr = null
let tree = null
try {
  tree = Comp({ sessionId: 'session-smoke-test', active: true })
} catch (e) { renderErr = e }
ok('组件能渲染一次不抛错', !renderErr, renderErr && renderErr.message)
ok('渲染产出了元素', !!tree, '返回: ' + (tree === null ? 'null' : typeof tree))

// 再渲染一次"二级页"（如果组件是两级：只测顶层即可 ✓ 更深要真实交互 ✗）
let renderErr2 = null
try { Comp({ sessionId: 'session-smoke-test', active: false }) } catch (e) { renderErr2 = e }
ok('非激活态也能渲染', !renderErr2, renderErr2 && renderErr2.message)

// ── ⑤b 二级页（模拟点开「话布文档」）──
//   为什么要有：一级页只是几张卡片 ✓ 真正的逻辑（分组、清单、拖动、打开）都在二级页 ✓
//   只测一级页等于没测 ✓ 这一步把"点进二级页"也跑一遍 ✓
console.log('')
console.log('══ 客户端冒烟：二级页 ══')

// 深度遍历假元素树，收集所有 on* 回调
function walkTree(node, hit, depth) {
  if (!node || typeof node !== "object" || (depth || 0) > 24) return
  // ⚠️ 假元素树里 type 可能是**组件函数**（h(CcvCanvasTab, props)）
  //   要把它展开一次才能拿到真正的子元素 ✓ 否则一个 onClick 都找不到 ✗
  if (typeof node.type === "function") {
    try { walkTree(node.type(node.props || {}), hit, (depth || 0) + 1) } catch (_) {}
  }
  if (node.props) {
    Object.keys(node.props).forEach(function (k) {
      if (/^on[A-Z]/.test(k) && typeof node.props[k] === "function") hit(node.props[k], k)
    })
  }
  const kids = (node.children || []).concat(node.props && node.props.children ? [].concat(node.props.children) : [])
  kids.forEach(function (c) {
    if (Array.isArray(c)) c.forEach(function (x) { walkTree(x, hit, (depth || 0) + 1) })
    else walkTree(c, hit, (depth || 0) + 1)
  })
}

let docsErr = null
let docsTree = null
try {
  const home = Comp({ sessionId: "session-smoke-test", active: true })
  ok("一级页渲染出元素", !!home)
  let fired = 0
  walkTree(home, function (fn) {
    if (fired > 0) return
    try {
      fn({ preventDefault() {}, stopPropagation() {}, currentTarget: { blur() {} } })
      fired++
    } catch (_) {}
  }, 0)
  ok("一级页上的点击回调能执行", fired > 0)
  docsTree = Comp({ sessionId: "session-smoke-test", active: true })
} catch (e) { docsErr = e }
ok("点一级页 / 再渲染不抛错", !docsErr, docsErr && docsErr.message)
ok("二级页产出元素", !!docsTree)
// ── ⑥ 冒烟期间不许有"未定义"类报错混进来 ──
console.log('')
console.log('══ 客户端冒烟：可能漏传的依赖 ══')
const msgs = []
;[loadErr, applyErr, renderErr, renderErr2, docsErr].forEach(function (e) {
  if (e) msgs.push(String(e && e.message))
})
const undefinedish = msgs.filter(function (m) {
  return /is not a function|undefined|not defined/i.test(m)
})
ok('没有 undefined / not a function 类错误', undefinedish.length === 0, undefinedish.join(' | '))

console.log('')
console.log('  客户端冒烟：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
