#!/usr/bin/env node
// DSH Collab-Canvas · 上线前总检
//
// ⚠️ 这个脚本的历史教训（2026-09-16 修）：
//   1) 它以前**一个回归测试都不跑** —— 只做十几条写死的文本匹配。
//      于是"一键全绿"给了假的安心，而真正那 485 条断言可能一条都没过。
//      → 现在第 2 节会**真的去跑 tools/test-all.cjs**，失败则整体退出码为 1。
//   2) 它以前拿「工作区文件」和「git show HEAD:文件」做**原始字节比较**，
//      而本仓库 git 设了 core.autocrlf=true（检出转 CRLF）+ 自带工具写 LF，
//      两种换行符混着 → 永远报"不一致"，其实文件根本没改过。
//      → 现在一律**先统一换行符再比**。假红比不报还糟：它会训练人忽略输出。
//
// 用法：node tools/verify-all.cjs          （npm run verify）
// 退出码：0 = 全绿；1 = 有测试失败 / 部署不一致 / 文档缺失。
'use strict'

const fs = require('fs')
const path = require('path')
const { execSync, spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const WS = ROOT
// 部署目录与 deploy.cjs 保持同一推导规则：DSH_HOME 优先，CCV_DEPLOY_DIR 可覆盖。
const DSH_HOME = process.env.DSH_HOME || path.join(require('os').homedir(), '.dsh')
const DP = process.env.CCV_DEPLOY_DIR ||
  path.join(DSH_HOME, 'profiles', 'web', 'node_modules', 'collab-canvas')

let problems = []

/** 读文本并把换行符统一成 \n —— 跨 git/工作区比较前必须先过这一道。 */
function readNorm(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
}
function hasCrlf(p) {
  try { return fs.readFileSync(p, 'utf8').indexOf('\r\n') >= 0 } catch (e) { return false }
}

/* ═══ 1. git 状态 ═══ */
console.log('══ 1. git 状态 ══')
try {
  const st = execSync('git status --short', { cwd: WS, encoding: 'utf8' }).trim()
  console.log(st ? st.split('\n').map(function (l) { return '  ' + l }).join('\n')
    : '  工作区干净（无未提交改动）')
} catch (e) {
  console.log('  读不到 git 状态：' + (e && e.message))
  problems.push('git 状态读不到')
}

/* ═══ 2. 回归测试（真跑）═══ */
console.log('')
console.log('══ 2. 回归测试（真跑 tools/test-all.cjs）══')
const runner = path.join(WS, 'tools', 'test-all.cjs')
if (!fs.existsSync(runner)) {
  console.log('  ★ 找不到 ' + runner)
  problems.push('回归测试总入口缺失')
} else {
  const r = spawnSync(process.execPath, [runner], {
    cwd: WS, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024
  })
  const out = (r.stdout || '') + (r.stderr || '')
  // 只把汇总段打出来，明细太长
  const lines = out.split('\n')
  const cut = lines.findIndex(function (l) { return /^[─═]/.test(l) || /份测试：/.test(l) })
  lines.slice(cut >= 0 ? cut : 0).forEach(function (l) { if (l.trim()) console.log('  ' + l) })
  if (r.status !== 0) problems.push('回归测试未全过')
}

/* ═══ 3. 工作区 ↔ 部署 一致性 ═══ */
console.log('')
console.log('══ 3. 工作区 ↔ 部署 一致性（忽略换行符差异）══')
// lib/selref.js 以前漏在这个名单外 —— 它是运行期按需拉取的侧模块，
// 漏拷的后果是"改了却没生效"，所以必须一起比。
// ⚠️ 2026-10-22 又栽了一次（lib/doc-model.js ✗）→ 见下面 PAIRS 里的注释 ✓
// ★ 新增"侧模块必须四处齐全"的守卫（这次事故换来的 ✓）★
const PAIRS = [
  'dist/host.js',
  'lib/client.js',
  'lib/selref.js',
  'lib/viewer-md.js',
  // ⚠️ 2026-10-22 事故：lib/doc-model.js 以前漏在这份名单外 ✗✗
  //   → 从来没被搬到部署副本 → /api/canvas/doc-model.js 返回 500 ✗
  //   → 浏览器加载不到模型 → **A4 的按块转换一次都没生效过** ✓✓（静默失效 ✓）
  //   所以它必须在这里 ✓（这条守卫就是那次事故换来的 ✓）
  'lib/doc-model.js',
  'lib/ccv-logic.js',
  // doclink.js / docdrop.js 于 2026-10-11 随画布面板删除（面板专属）
  'package.json',
  'cordis.patch.yml'
]
PAIRS.forEach(function (rel) {
  const a = path.join(WS, rel)
  const b = path.join(DP, rel)
  if (!fs.existsSync(a)) { console.log('  ★ ' + rel.padEnd(20) + '工作区没有'); problems.push(rel + ' 工作区缺失'); return }
  if (!fs.existsSync(b)) { console.log('  ★ ' + rel.padEnd(20) + '部署副本没有（没拷？）'); problems.push(rel + ' 部署副本缺失'); return }
  const same = readNorm(a) === readNorm(b)
  const crlfNote = (hasCrlf(a) !== hasCrlf(b)) ? '  [换行符不同，已忽略]' : ''
  if (!same) problems.push(rel + ' 内容不一致')
  console.log('  ' + rel.padEnd(20) + (same ? '一致 ✓' : '不一致 ★') +
    '  ' + Buffer.byteLength(readNorm(a)) + ' 字节' + crlfNote)
})

/* ═══ 3b. 侧模块"五处齐全"（2026-10-22 事故换来的守卫）═══ */
//   事故：lib/doc-model.js 建了 ✓ 但漏在【搬运清单】里 ✗
//     → 部署副本没有它 → 服务端读盘失败 → /api/canvas/doc-model.js 返回 500 ✗
//     → 浏览器加载不到模型 → 那套"按块转换"**从上线起一次都没生效过** ✓✓
//     —— 全链路**一句报错都没有** ✗ 只是功能不发生 ✓（最难查的那种 ✓）
//   所以：lib/ 下每有一个侧模块，就必须在**五个地方**都出现 ✓
//     少任何一处 = 静默失效 ✗ → 这里当场报"★ 缺"✓
console.log('')
console.log('══ 3b. 侧模块五处齐全 ══')
;(function () {
  let sides = []
  try { sides = fs.readdirSync(path.join(WS, 'lib')).filter(function (f) { return /\.js$/.test(f) && f !== 'client.js' }) } catch (_) {}
  if (!sides.length) { console.log('  （lib 下没读到侧模块）'); problems.push('侧模块扫描失败'); return }
  const spots = [
    ['搬运清单', 'tools/deploy.cjs'],
    ['一致性清单', 'tools/verify-all.cjs'],
    ['服务端名单', 'src/host/11-canvas-extras.js'],
    ['浏览器加载', 'src/client/editor-panel.js'],
  ]
  sides.forEach(function (f) {
    const missing = []
    spots.forEach(function (sp) {
      let txt = ''
      try { txt = fs.readFileSync(path.join(WS, sp[1]), 'utf8') } catch (_) { missing.push(sp[0] + '(读不到)'); return }
      if (txt.indexOf(f) < 0) missing.push(sp[0])
    })
    const ok = missing.length === 0
    console.log('  ' + f.padEnd(18) + (ok ? '五处齐全 ✓' : ('★ 缺：' + missing.join(' / '))))
    if (!ok) problems.push('侧模块 ' + f + ' 缺：' + missing.join('/'))
  })
  console.log('  （共 ' + sides.length + ' 个侧模块：' + sides.join(' / ') + '）')
})()

/* ═══ 3d. 结构纪律（2026-10-26 重构 P1/P2）═══ */
//   ① HTTP 响应辅助只能有**一份实现**（01-utils.js）
//      原来 09-http 与 11-extras 各写一份 ✗ 且语义不同（Buffer vs JSON）✓
//   ② 纯逻辑层必须存在且保持"纯"（不许出现 document./setTimeout/fetch()）
//   ③ 纯逻辑层必须被测试覆盖（tools/test-ccv-logic.cjs）
//   ④ 分组/地址/判据的实现**不许回退**到客户端巨石文件里（防重构被改回去）
console.log('')
console.log('══ 3d. 结构纪律 ══')
;(function () {
  // ① HTTP 辅助唯一实现
  const helpers = ['httpJson', 'httpError', 'httpReadBody', 'httpReadJson']
  let hostFiles = []
  try { hostFiles = fs.readdirSync(path.join(WS, 'src', 'host')).filter((f) => /\.js$/.test(f)) } catch (_) {}
  helpers.forEach(function (h) {
    const owners = hostFiles.filter(function (f) {
      let t = ''
      try { t = fs.readFileSync(path.join(WS, 'src', 'host', f), 'utf8') } catch (_) { return false }
      return t.indexOf('function ' + h + '(') >= 0
    })
    const ok = owners.length === 1 && owners[0] === '01-utils.js'
    console.log('  ' + h.padEnd(16) + (ok ? '唯一实现 ✓' : ('★ 实现数量/位置不对：' + owners.join(','))))
    if (!ok) problems.push('HTTP 辅助 ' + h + ' 不是唯一实现')
  })

  // ② 纯逻辑层存在且纯净
  let logic = ''
  try { logic = fs.readFileSync(path.join(WS, 'lib', 'ccv-logic.js'), 'utf8') } catch (_) {}
  if (!logic) { console.log('  ★ lib/ccv-logic.js 缺失'); problems.push('纯逻辑层缺失') }
  else {
    const body = logic.slice(logic.indexOf('var CCV_LOGIC'), logic.indexOf('})(\r\n\r\n//') > 0 ? logic.indexOf('})(\r\n\r\n//') : logic.indexOf('})()'))
    const impure = ['document.', 'setTimeout', 'fetch('].filter(function (k) { return body.indexOf(k) >= 0 })
    console.log('  ' + 'ccv-logic 纯净'.padEnd(16) + (impure.length ? ('★ 混入副作用：' + impure.join(',')) : '不碰 DOM/定时器/fetch ✓'))
    if (impure.length) problems.push('纯逻辑层混入副作用')
    const want = ['hashStr', 'sessionFileAddress', 'pickDocked', 'hashKeyMap', 'buildGroups', 'normalizeOwnership', 'splitOutline']
    const missing = want.filter(function (k) { return logic.indexOf(k + ': ' + k) < 0 })
    console.log('  ' + 'ccv-logic 导出'.padEnd(16) + (missing.length ? ('★ 缺：' + missing.join(',')) : want.length + ' 个纯函数齐全 ✓'))
    if (missing.length) problems.push('纯逻辑层导出不全')
  }

  // ③ 纯逻辑层有测试
  const hasTest = fs.existsSync(path.join(WS, 'tools', 'test-ccv-logic.cjs'))
  console.log('  ' + '纯逻辑层测试'.padEnd(16) + (hasTest ? 'tools/test-ccv-logic.cjs ✓' : '★ 缺失'))
  if (!hasTest) problems.push('纯逻辑层没有测试')

  // ④ 关键算法不许回退到客户端（防重构被改回去）
  let cl = ''
  try { cl = fs.readFileSync(path.join(WS, 'src', 'client', 'editor-panel.js'), 'utf8') } catch (_) {}
  const noRollback = [
    ['分组实现未回退', 'var byEff = {}'],
    ['地址编码未回退', 'function ccvEncSeg'],
  ]
  noRollback.forEach(function (x) {
    const bad = cl.indexOf(x[1]) >= 0
    console.log('  ' + x[0].padEnd(16) + (bad ? ('★ 又在客户端里出现了：' + x[1]) : '仍走纯逻辑层 ✓'))
    if (bad) problems.push(x[0] + '：' + x[1])
  })
})()

/* ═══ 3g. 客户端必须有冒烟测试（2026-10-27）═══ */
//   2026-10-27 的真实事故：
//     我把标签页 405 行搬到模块级，搬运时漏了 ctx（apply 的参数）✗
//     工厂里 ctx.slots 抛错 → 被 try/catch 吞掉 → "标签页整个消失"✓
//     而当时总检**全绿** ✗ 因为总检根本不跑客户端 ✓
//   → 从此加一条硬要求：客户端必须有冒烟测试，且它必须在 test-all 里 ✓
console.log('')
console.log('══ 3g. 客户端冒烟 ══')
;(function () {
  const has = fs.existsSync(path.join(WS, 'tools', 'test-client-smoke.cjs'))
  console.log('  ' + '冒烟测试存在'.padEnd(16) + (has ? 'tools/test-client-smoke.cjs ✓' : '★ 缺失（客户端没有任何自动验证）'))
  if (!has) problems.push('客户端缺少冒烟测试')
  // 冒烟必须真的"注册标签页 + 渲染"这两步都验（防止退化成一个只会 loaded 的空测试）
  let t = ''
  try { t = fs.readFileSync(path.join(WS, 'tools', 'test-client-smoke.cjs'), 'utf8') } catch (_) {}
  const hasV = fs.existsSync(path.join(WS, 'tools', 'test-viewer-smoke.cjs'))
  console.log('  ' + '查看器冒烟'.padEnd(16) + (hasV ? 'tools/test-viewer-smoke.cjs ✓' : '★ 缺失'))
  if (!hasV) problems.push('查看器缺少冒烟测试')
  const need = [['注册标签页', '注册了至少一个标签页'], ['渲染组件', '组件能渲染一次不抛错'], ['点击一级页', '点击回调能执行']]
  need.forEach(function (x) {
    const okk = t.indexOf(x[1]) >= 0
    console.log('  ' + x[0].padEnd(16) + (okk ? '有断言 ✓' : '★ 缺断言'))
    if (!okk) problems.push('客户端冒烟缺断言：' + x[0])
  })
})()

/* ═══ 3f. 依赖传递（2026-10-26 重构 P4）═══ */
//   背景：标签页 UI 从 apply() 搬到模块级工厂 ccvMakeFeatureTab(D) 之后，
//   "工厂里用到的依赖"和"调用处传进来的"必须**一一对上** ✗
//   漏一个不会报错，而是静默 undefined ✓ 最难查的那类 bug ✓
//   → 这条守卫把它变成"当场红" ✓
console.log('')
console.log('══ 3f. 依赖传递 ══')
;(function () {
  let src = ''
  try { src = fs.readFileSync(path.join(WS, 'src', 'client', 'editor-panel.js'), 'utf8') } catch (_) {}
  if (!src) { console.log('  ★ 读不到 editor-panel.js'); problems.push('依赖传递：读不到源码'); return }
  const lines = src.split(/\r?\n/)
  const s = lines.findIndex(function (l) { return /function ccvMakeFeatureTab\(/.test(l) })
  if (s < 0) { console.log('  （当前没有模块级 UI 工厂，跳过）'); return }
  let e = -1
  for (let i = s + 1; i < lines.length; i++) { if (lines[i] === '  }') { e = i; break } }
  const body = lines.slice(s, e + 1).join('\n')

  // ① 工厂内声明的别名
  const need = []
  const re = /([A-Za-z_$][\w$]*)\s*=\s*D\.([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(body))) need.push(m[1])
  const uniqNeed = [...new Set(need)]

  // ② 调用处传的键（ccvMakeFeatureTab({ ... }) 那一段）
  const callIdx = lines.findIndex(function (l) { return l.indexOf('var CcvFeatureTab = ccvMakeFeatureTab({') >= 0 })
  let callText = ''
  if (callIdx >= 0) {
    for (let i = callIdx; i < Math.min(lines.length, callIdx + 30); i++) {
      callText += lines[i] + '\n'
      if (lines[i].indexOf('})') >= 0) break
    }
  }
  const passed = []
  const reKey = /([A-Za-z_$][\w$]*)\s*:/g
  while ((m = reKey.exec(callText))) passed.push(m[1])
  const uniqPassed = new Set(passed)

  const missing = uniqNeed.filter(function (n) { return !uniqPassed.has(n) })
  console.log('  工厂依赖 ' + uniqNeed.length + ' 个 / 调用处传入 ' + uniqPassed.size + ' 个')
  if (missing.length) {
    console.log('  ★ 漏传（会静默 undefined）：' + missing.join(', '))
    problems.push('依赖传递：漏传 ' + missing.join(','))
  } else {
    console.log('  依赖对齐 ✓（每个 D.x 都有对应的 x: x）')
  }
  // ③ 别名必须覆盖所有 D.x（防止工厂里出现 D.y 却没别名 —— 那种反而会真的 undefined）
  const declared = new Set()
  const reVar = /(?:var|let|const)\s+([^\n]+)/g
  while ((m = reVar.exec(body))) {
    m[1].split(',').forEach(function (part) {
      const mm = part.match(/^\s*([A-Za-z_$][\w$]*)/)
      if (mm) declared.add(mm[1])
    })
  }
  const ghost = [...new Set((body.match(/D\.[A-Za-z_$][\w$]*/g) || []).map(function (x) { return x.slice(2) }))]
    .filter(function (n) { return !declared.has(n) })
  if (ghost.length) {
    console.log('  ★ 用了 D.' + ghost.join('/D.') + ' 但没起别名')
    problems.push('依赖传递：D.' + ghost.join(',D.'))
  }
})()

/* ═══ 3e. 体积纪律（2026-10-26 重构）═══ */
//   为什么要有：巨石函数是**慢慢长出来的** ✗ 不会有人一次写 1000 行 ✓
//   只靠"这次重构一下"没用 ✓ 必须有守卫盯着它别再长 ✓
//   规则：超上限就报警 ✓ 允许逐步下降，不允许反弹 ✗
console.log('')
console.log('══ 3e. 体积纪律 ══')
;(function () {
  function fnLines(file, name) {
    let src = ''
    try { src = fs.readFileSync(path.join(WS, file), 'utf8') } catch (_) { return null }
    const lines = src.split(/\r?\n/)
    const start = lines.findIndex(function (l) { return l.indexOf('function ' + name + '(') >= 0 })
    if (start < 0) return null
    const indent = (lines[start].match(/^\s*/) || [''])[0].length
    const closeMark = new Array(indent + 1).join(' ') + '}'
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i] === closeMark || lines[i] === closeMark + '\r') return { n: i - start + 1, line: start + 1 }
    }
    return null
  }
  const budget = [
    ['src/client/editor-panel.js', 'apply', 350, 'apply()（客户端接线）'],
    ['lib/viewer-md.js', 'BodyInner', 770, 'BodyInner（查看器正文）'],
  ]
  budget.forEach(function (b) {
    const r = fnLines(b[0], b[1])
    if (!r) { console.log('  ★ 找不到 ' + b[1] + '（改名了？）'); problems.push('体积纪律：找不到 ' + b[1]); return }
    const ok = r.n <= b[2]
    console.log('  ' + b[3].padEnd(24) + r.n + ' 行（上限 ' + b[2] + '）' + (ok ? ' ✓' : ' ★ 超了'))
    if (!ok) problems.push(b[3] + ' 超过 ' + b[2] + ' 行（现 ' + r.n + '）')
  })
})()

/* ═══ 3h. hook 抽取进度（2026-10-27）═══ */
//   为什么要这条：BodyInner 的瘦身是"一个个 hook 抽出去"做的 ✓
//   最怕的是**又往里增加新的 r.useEffect** ✗ 那样前面几轮就白干了 ✓
//   规则：BodyInner 里的 r.use* 调用数不许超过当前值（只许降）
console.log('')
console.log('══ 3h. hook 抽取进度 ══')
;(function () {
  let src = ''
  try { src = fs.readFileSync(path.join(WS, 'lib', 'viewer-md.js'), 'utf8') } catch (_) { return }
  const lines = src.split(/\r?\n/)
  const s = lines.findIndex(function (l) { return /function BodyInner\(props, r\)/.test(l) })
  if (s < 0) { console.log('  ★ 找不到 BodyInner'); problems.push('hook 抽取：找不到 BodyInner'); return }
  let e = -1
  for (let i = s + 1; i < lines.length; i++) { if (lines[i] === '  }') { e = i; break } }
  let inBody = 0
  for (let i = s; i < e; i++) if (/r\.use[A-Z]/.test(lines[i])) inBody++
  const budget = 21
  const okk = inBody <= budget
  console.log('  ' + 'BodyInner 内 hook 调用'.padEnd(24) + inBody + ' 处（上限 ' + budget + '）' + (okk ? ' ✓' : ' ★ 超了'))
  if (!okk) problems.push('BodyInner 内 hook 调用 ' + inBody + ' 处，超过上限 ' + budget)
  // 已抽出的 hook 必须还在（防止被合回去）
  const want = []   // 查看器 hook 已整体回滚（2026-10-27 渲染出错），清单暂时为空
  const missing = want.filter(function (n) { return src.indexOf('function ' + n + '(D)') < 0 })
  console.log('  ' + '已抽出 hook'.padEnd(24) + (missing.length ? ('★ 丢了: ' + missing.join(',')) : want.length + ' 个都在 ✓'))
  if (missing.length) problems.push('已抽出的 hook 不见了: ' + missing.join(','))
})()

/* ═══ 3c. hook 不许写进循环/回调（2026-10-23 空白事故）═══ */
//   这不是文本匹配能查的 ✗ 要按**结构**判：
//     .map(function (x) { …React.useState… })  ← 这种一律是错 ✓
//   做法：扫每个 .map/.forEach/… 的回调体，看里面有没有 React.use*
console.log('')
console.log('══ 3c. hook 不在循环/回调里 ══')
;(function () {
  const targets = ['src/client/editor-panel.js']
  targets.forEach(function (rel) {
    let src = ''
    try { src = fs.readFileSync(path.join(WS, rel), 'utf8') } catch (_) { console.log('  ★ 读不到 ' + rel); problems.push('hook 检查读不到 ' + rel); return }
    const re = /\.(map|forEach|filter|reduce|some|every)\(\s*function\s*\(\w*\)\s*\{/g
    let m
    let hits = 0
    while ((m = re.exec(src))) {
      const s0 = m.index + m[0].length
      let d = 1, i = s0
      while (i < src.length && d > 0) { if (src[i] === '{') d++; else if (src[i] === '}') d--; i++ }
      const body = src.slice(s0, i)
      const mm = body.match(/React\.use(State|Effect|Ref|Memo|Callback|Context|Reducer)/)
      if (mm) {
        hits++
        const line = src.slice(0, m.index).split('\n').length
        console.log('  ★ ' + rel + ':' + line + ' 的 .' + m[1] + '() 回调里有 ' + mm[0] + ' ✗')
        problems.push(rel + ' 第 ' + line + ' 行：hook 写进了 .' + m[1] + '() 回调')
      }
    }
    console.log('  ' + (hits ? ('★ ' + hits + ' 处违规') : '没有违规 ✓') + '  （' + rel + '）')
  })
})()

/* ═══ 4. 历史修复守卫（源码文本匹配）═══ */
// 说明：这些是历次修复留下的"别被改回去"的守卫，查的是源码里还认不认那些关键写法。
// 它们是**文本匹配**，不是行为测试 —— 真正的行为由第 2 节那 485 条断言负责。
console.log('')
console.log('══ 4. 历史修复守卫（源码文本匹配，非行为测试）══')
const clPath = path.join(WS, 'src/client/editor-panel.js')
const cl = fs.existsSync(clPath) ? readNorm(clPath) : ''
if (!cl) { console.log('  ★ 读不到 src/client/editor-panel.js'); problems.push('客户端源码缺失') }
const GUARDS = [
  // ⚠️ 2026-10-11：画布面板（CanvasPanel，1617 行）整体删除，"改文档"这件事整体搬到了
  //    自带查看器（lib/viewer-md.js）。下面这几条的**不变量没变**（并发保护、冲突不静默
  //    覆盖、操作有反馈），只是**实现位置变了** —— 所以守卫要跟着改指向 ✓
  //    写死查面板 = 永远报"缺失"（假警报比没有守卫更糟 ✗ 这条注释是项目里的老规矩）
  ['P0 knownVer 回传（保存带版本号）', /knownVer:\s*d\.ver/, 'lib/viewer-md.js'],
  ['P0 版本号存进小状态（保存要用）', /ver:\s*ver,/, 'lib/viewer-md.js'],
  // ── ★ hook 不许写进循环/回调（2026-10-23「话布标签页纯空白」事故换来的）★ ──
  //   事故：我在清单的 .map() 回调里写了 React.useState ✗✗
  //     → 清单条数一变，hook 数量就变 ✗
  //     → 「Rendered more hooks than during the previous render」✗
  //     → **整个标签页崩掉 → 只剩空白** ✓✓（里面一点线索都没有 ✓ 查了半天 ✓）
  //   React 铁律：**Hooks 只能在组件顶层调用** ✗ 这属于源码文本里很难看出的错 ✓
  //   → 两条守卫：
  //      ① 清单行是**独立子组件**（CcvRow ✓）不是回调里调 hook ✓
  //      ② 整个文件里"回调体内出现 React.use*"是**零** ✗
  ['P0 清单行是独立子组件（不是 .map 回调里调 hook）',
    /function CcvRow\(props\)/, 'src/client/editor-panel.js'],
  ['P0 标签页有错误边界（崩了看得见原因，不再纯空白）',
    /extends React\.Component/, 'src/client/editor-panel.js'],
  // 2026-10-15 第三次修：把"猜内容变没变"的四道守卫**全摘掉**了 ✗
  //   原因：只要猜错一次 → React 重设 innerHTML → 闪一下 ✗
  //     （主人现场：插入表格时闪一下 → execCommand 落空 → 要重插 ✗）
  //   换成**显式渲染序号**：只有"内容来自外部"时才允许重设正文 ✓
  //   所以守卫也跟着升级 —— 现在钉的是这套新模型 ✓
  // 2026-10-15 卡死事故的守卫（回退到 fd733e2 之后单独补的 ✓）：
  //   noteLiveEditState 里是**全文 TreeWalker** ✗ 挂在每次 selectionchange 上必然卡死 ✓
  //   现在必须走 rAF 节流版 + 超大文档不算偏移 ✓ 少一条就会再卡一次 ✓
  ['P0 热路径不许全文遍历：selectionchange 必须走 rAF 节流版',
    /noteLiveEditStateSoon\(\)/, 'lib/viewer-md.js'],
  ['P0 大文档保护：超大文档不算光标偏移',
    /var LIVE_STATE_MAX_CHARS = 60000/, 'lib/viewer-md.js'],
  ['P0 重渲染由 renderSeq 显式决定（不再猜内容）',
    /if \(renderedSeqRef\.current !== seqNow \|\| !renderedRef\.current\)/, 'lib/viewer-md.js'],
  ['P0 打字/表格操作不动 renderSeq（所以不会闪）',
    /docPatch\(absPath, \{ dirty: dirty, md: md, saved: savedRef\.current, buf: md \}\)/, 'lib/viewer-md.js'],
  ['P0 外部改动才 +1 renderSeq',
    /renderSeq: \(prev0\.renderSeq \|\| 0\) \+ 1/, 'lib/viewer-md.js'],
  ['P0 撤销/重做也 +1（否则正文不更新）',
    /patch0\.renderSeq = \(\(d0 && d0\.renderSeq\) \|\| 0\) \+ 1/, 'lib/viewer-md.js'],
  ['P0 渲染源是缓冲（props 只当输入）',
    /if \(dsBodyBuf && typeof dsBodyBuf\.buf === 'string'\) text = dsBodyBuf\.buf/, 'lib/viewer-md.js'],
  // 2026-10-15 防清空：主人现场「点重做 → 文档空白」✗ 三道闸都要在 ✓
  ['P0 保存拒绝空内容（用编辑区真实内容判定）',
    /if \(!mdToSave && domNow\)/, 'lib/viewer-md.js'],
  ['P0 撤销/重做拒绝空内容',
    /撤销\/重做返回了空内容 → 拒绝采用/, 'lib/viewer-md.js'],
  ['P0 noop 不动正文',
    /if \(dd\.noop\) \{[\s\S]{0,200}?newTxt = null/, 'lib/viewer-md.js'],
  ['P0 撤销快捷键用 dirty 判定（不用文本比对）',
    /if \(d0 && d0\.dirty\) return/, 'lib/viewer-md.js'],
  ['P0 撤销/重做按钮读 store（否则按钮状态不刷新）',
    /toolBtn\('undo', ICON_UNDO, !!\(ds && \(ds\.canUndo \|\| ds\.dirty\)\)/, 'lib/viewer-md.js'],
  // ── C 方案 P1：文档模型（2026-10-15）──────────────────────────────
  //   为什么要有守卫：模型是后面几期的地基 ✓ 一旦被改坏，
  //   "往返无损"这条会**静默失效** ✗ —— 而它是这轮重构唯一的验收标准 ✓
  // ── ★ 侧模块"四处齐全"守卫（2026-10-22 事故换来的）★ ──────────────
  //   事故：lib/doc-model.js 建了 ✓ 但**漏在搬运清单里** ✗
  //     → 部署副本没有它 → 服务端读不到 → /api/canvas/doc-model.js **500** ✗
  //     → 浏览器加载不到 → 那套"按块转换"**从上线起一次都没生效过** ✓✓
  //     —— 全链路**一句报错都没有** ✗ 只是功能不发生 ✓（最难查的那种 ✓）
  //   规矩：**新增一个侧模块 = 五处同时改** ✓ 少一处就是静默失效 ✗
  //     lib/ 里真建了 ✓ tools/deploy.cjs ✓ tools/verify-all.cjs ✓
  //     src/host/11-canvas-extras.js ✓ src/client/editor-panel.js ✓
  //   （这几条由下面的 5 个专门检查跑 ✓ 见 "侧模块齐全" 一节 ✓）
  ['P1 模型：parse/serialize/roundTrip 都在',
    /var API = \{ parse: parse, serialize: serialize, roundTrip: roundTrip/, 'lib/doc-model.js'],
  ['P1 模型：暴露到 window（浏览器侧要用）',
    /window\.__ccvDocModel = API/, 'lib/doc-model.js'],
  ['P1 表格拆分与渲染器一致（见 | 就拆，不搞反引号特例）',
    /if \(ch === '\|'\) \{ cells\.push\(cur\.trim\(\)\); cur = ''; continue \}/, 'lib/doc-model.js'],
  ['P1 有序列表保留起始序号（4. 不能写成 1.）',
    /var startN = b\.ordered \? \(b\.start \|\| 1\) : 1/, 'lib/doc-model.js'],
  ['P1 列表续行：空行后缩进更深仍属该项（否则代码块被拉出列表）',
    /if \(nxIndent > baseIndent\) \{ itemLines\.push\(''\); i\+\+; continue \}/, 'lib/doc-model.js'],
  // 2026-10-17：写盘会触发宿主重建组件 ✗ → 闪 ✓ → 频率从 1.5 秒降到 5 秒 ✓
  //   同时补上"离开页面立刻存"这条保险 ✓（否则那 5 秒的改动会丢 ✗）
  ['P0 自动保存只在长时间空闲后写盘（写盘触发宿主重建 ✗ 放宽到 20 秒）',
    /var AUTOSAVE_MS = 20000/, 'lib/viewer-md.js'],
  ['P0 草稿照旧勤快（只写 localStorage ✓ 无副作用 ✓）',
    /var DRAFT_MS = 800/, 'lib/viewer-md.js'],
  // 2026-10-17 主人点出的窗口：「卡着第五秒打字」✗
  //   定时写盘可能正好落在打字中间 → 闪会打断你 ✓
  //   → 发之前再确认一次"最近 1.2 秒有没有输入"，有就【跳过】✗（不重排 ✗ 不循环 ✓）
  ['P0 在打字就不写盘（发之前再确认一次，跳过而不是重排）',
    // 2026-10-29：窗口放宽到 3 秒，并且"人还停在编辑区"再加一道 8 秒 ✓
    /if \(!opts\.manual && \(\(lastInputAt && \(Date\.now\(\) - lastInputAt\) < 3000\)/, 'lib/viewer-md.js'],
  ['P0 记下最后一次输入的时刻',
    /lastInputAt = Date\.now\(\)/, 'lib/viewer-md.js'],
  ['P0 离开页面/切后台必须立刻存',
    /document\.addEventListener\('visibilitychange'/, 'lib/viewer-md.js'],
  ['P0 beforeunload 只写草稿（fetch 关页会被丢 ✗）',
    /window\.addEventListener\('beforeunload'/, 'lib/viewer-md.js'],
  ['P1 缩进不叠加', /ln === "" \? "" : \(\/\^\[ \\t\]\/\.test\(ln\) \? ln : pad \+ ln\)/],
  ['P2 任务项剥空白', /if \(isTask\) inner = inner\.replace\(\/\^\[ \\t\]\+\/, ""\)/],
  // 2026-10-04 立、2026-10-11 改指向：保存/撤销成功后必须给反馈。
  // 少了它，主人按过自己也不确定、AI 那边更查不到 —— 那次误判就是这么来的。
  // 现在保存按钮兼状态灯（灰=已保存/亮=有改动/品牌色=保存中），手动保存还给一次提示 ✓
  ['保存成功给提示', /已保存 ✓/, 'lib/viewer-md.js'],
  ['保存状态可见（三态）', /保存中…/, 'lib/viewer-md.js'],
  // 2026-10-04：版本号必须跟着 meta 一起存（这两条查的是 **host** 源，见下面的 which 字段）。
  // 不存的话 restore 一律 version:1 → 靠版本号的保护（草稿基准、knownVer 并发校验）
  // 在重启后全部失效，而且"撤了几次"这条追溯线索也一起没了。
  ['版本号持久化', /version:\s*c\.version/, 'host'],
  ['版本号恢复', /typeof m\.version === 'number'/, 'host'],
  // 2026-10-11：选区编辑区（type='scratch'）的两条硬约束 ——
  //   **不进任何清单、不写进 meta**（一次性对象，拼接成功即销毁、重启即消失）。
  //   规格：canvas-docs/话布选区编辑区方案.md 第九节「明确不做」。
  //   这两条一旦被改回去，编辑区就会变成"永久画布"，方案的前提就塌了。
  ['编辑区不落 meta', /return c && c\.type !== 'scratch'/, 'host'],
  ['编辑区不进清单', /c\.type !== 'scratch'/, 'src/host/09-http.js'],
  // 2026-10-11：连续编辑必须合并成一步（自动保存的前提 —— 否则撤销栈被冲爆 ✗）
  ['连续编辑合并', /HISTORY_MERGE_MS/, 'src/host/05-mutations.js'],
  ['合并判据：首尾相接', /last\.after === before/, 'src/host/05-mutations.js'],
  // 2026-10-11：编辑区拼接 —— 分不出该改哪一处时必须**不拼**（不静默兜底）
  ['拼接：分不出就不拼', /没有拼/, 'src/host/14-scratch-splice.js'],
  ['拼接：钩子挂根上下文', /ctx\.root/, 'src/host/14-scratch-splice.js'],
  // 2026-10-14：**两次丢数据**换来的三道守卫（别的项目里 AI 追加的附录全丢 ✗）
  //   根因：会话重启会让 restore() 在**同一个进程里重跑**，而它原本无条件
  //   「从文件读内容 + 覆盖内存」→ 内存里比文件新的那份被吃掉 ✗
  //   这三条一旦被改回去就是**静默丢内容**，必须钉死 ✓
  ['恢复前先落盘（别拿旧文件覆盖新内存）', /await flushDirty\(\)[\s\S]{0,900}metaTargets\(\)/, 'src/host/04-persistence.js'],
  ['恢复时不覆盖有未保存改动的那份', /if \(live && live\.dirty\)/, 'src/host/04-persistence.js'],
  ['每轮结束落盘（把暴露窗口缩到一轮内）', /turn-end flush registered/, 'src/host/04-persistence.js'],
  // 2026-10-14：inject 声明的**跨文件依赖** —— 删了 conversation 就炸 ✗
  //   症状：聊天里报「slash: no serializer for reference source "话布选区"」
  //   原因：lib/selref.js 的 missingServices() 要 sessions/conversation/inputTriggers
  //         三个齐了才注册引用源 ✗ 缺一个 → **静默不注册** → DSH 找不到序列化器
  //   守卫写成"三项都在 inject 里" ✓ 以后再"清理未用声明"会被这条挡住 ✓
  ['inject 含 selref 要的三个服务', /const inject = \[[^\]]*"sessions"[^\]]*"conversation"[^\]]*"inputTriggers"/]
]
// which：'client'（默认，src/client/editor-panel.js）、'host'（src/host/04-persistence.js），
// 或一条相对路径（如 'src/host/09-http.js'）。
// 加这个字段是因为这一节原先只查客户端 —— 而"版本号持久化""编辑区不进清单"这类修复
// 在别的文件里，写进 GUARDS 会永远报"缺失"（假警报比没有守卫更糟）。
const hostSrcPath = path.join(WS, 'src/host/04-persistence.js')
const hostSrc = fs.existsSync(hostSrcPath) ? readNorm(hostSrcPath) : ''
if (!hostSrc) { console.log('  ★ 读不到 src/host/04-persistence.js'); problems.push('持久化源码缺失') }
const guardSrcCache = {}
function guardSrc(which) {
  if (which === 'host') return hostSrc
  if (which && which.indexOf('/') >= 0) {
    if (guardSrcCache[which] === undefined) {
      const p = path.join(WS, which)
      guardSrcCache[which] = fs.existsSync(p) ? readNorm(p) : ''
      if (!guardSrcCache[which]) { console.log('  ★ 读不到 ' + which); problems.push('守卫源缺失：' + which) }
    }
    return guardSrcCache[which]
  }
  return cl
}
GUARDS.forEach(function (g) {
  const src = guardSrc(g[2])
  const ok = src ? g[1].test(src) : false
  if (!ok) problems.push('历史守卫失效：' + g[0])
  console.log('  ' + g[0].padEnd(24) + (ok ? '✓' : '★ 缺失')
    + (g[2] === 'host' ? '  [host]' : (g[2] ? '  [' + g[2] + ']' : '')))
})
// setVersion 之后必须同步 versionRef —— 逐个调用点检查
if (cl) {
  const lines = cl.split('\n')
  let syncOk = 0, syncBad = 0
  lines.forEach(function (l, i) {
    if (l.indexOf('setVersion(') < 0) return
    const near = lines.slice(i, i + 4).join('\n')
    if (/versionRef\.current\s*=/.test(near)) syncOk++
    else { syncBad++; console.log('    ★ L' + (i + 1) + ' setVersion 后未同步 versionRef: ' + l.trim().slice(0, 50)) }
  })
  if (syncBad) problems.push('setVersion 有 ' + syncBad + ' 处未同步 versionRef')
  console.log('  setVersion 调用点：' + syncOk + ' 已同步 / ' + syncBad + ' 未同步')
}
const hoPath = path.join(WS, 'src/host/09-http.js')
if (fs.existsSync(hoPath)) {
  const ok = /if \(result && result\.conflict\)/.test(readNorm(hoPath))
  if (!ok) problems.push('历史守卫失效：host 冲突回传')
  console.log('  ' + 'P0 host 冲突回传'.padEnd(24) + (ok ? '✓' : '★ 缺失'))
}

/* ═══ 5. 文档完好性 ═══ */
console.log('')
console.log('══ 5. 文档完好性（换行符已统一后再比）══')
const DOC = 'canvas-docs/话布优化.md'
const docPath = path.join(WS, DOC)
if (!fs.existsSync(docPath)) {
  console.log('  ⚠ ' + DOC + ' 不在（跳过；以前这里会直接崩）')
} else {
  const disk = readNorm(docPath)
  let head = null
  try {
    head = execSync('git show HEAD:' + DOC, { cwd: WS, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
      .replace(/\r\n/g, '\n')
  } catch (e) { console.log('  ⚠ git 里读不到该文档（新文件？）') }
  if (head !== null) {
    const same = disk === head
    if (!same) problems.push(DOC + ' 与 git 不一致')
    console.log('  与 git 一致: ' + (same ? '✓' : '★ 不一致（确实被改过，不是换行符问题）'))
  }
  console.log('  含测试串 THIS-SHOULD-NOT: ' + (disk.indexOf('THIS-SHOULD-NOT') >= 0 ? '★ 是（不该有）' : '否 ✓'))
  console.log('  章节数: ' + (disk.match(/^## /gm) || []).length)
}

/* ═══ 6. 文档保鲜（文档里让跑的命令是否真的存在）═══ */
console.log('')
console.log('══ 6. 文档保鲜（docs/ 里提到的命令是否存在）══')
const docChecker = path.join(WS, 'tools', 'check-docs.cjs')
if (!fs.existsSync(docChecker)) {
  console.log('  ⚠ 没有 tools/check-docs.cjs，跳过')
} else {
  const r = spawnSync(process.execPath, [docChecker], {
    cwd: WS, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024
  })
  const out = (r.stdout || '') + (r.stderr || '')
  out.split('\n').filter(function (l) { return l.indexOf('── ') === 0 || /^\s+[✓★－]/.test(l) || /处：/.test(l) })
    .forEach(function (l) { console.log('  ' + l) })
  if (r.status !== 0) problems.push('文档里有让跑但不存在的命令')
}

/* ═══ 汇总 ═══ */
console.log('')
console.log('════════════════════════════════')
if (problems.length) {
  console.log('总检不通过，' + problems.length + ' 个问题：')
  problems.forEach(function (p) { console.log('  ★ ' + p) })
  process.exit(1)
} else {
  console.log('总检通过 ✓')
  process.exit(0)
}
