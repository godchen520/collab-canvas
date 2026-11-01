// 「选区编辑区拼接」的零依赖回归测试（host 侧）。
//
// 为什么必须有这一份：拼接是**唯一会动主人文档正文**的自动行为 ✗
//   · 拼错地方 → 静默改坏文档（界面上看不出来）
//   · 落成两条撤销步骤 → 主人按一次撤销退不干净
//   · 定位不了却硬拼 → 把内容塞到错误的偏移上
// 这三种都是"跑起来不报错、事后才发现"的错，所以必须有能跑出数值的测试。
//
// 做法与另几份 host 测试一致：**从构建产物里切真代码跑**（不是照抄一份）。
// 切取范围由 src/host/14-scratch-splice.js 的 [[CCV-SPLICE]] 圈定。
//
// ⚠️ 依赖 dist/host.js —— 改完 src/host/*.js 要先 node tools/build.cjs
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let pass = 0, fail = 0
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want)
  if (a === b) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + '  期望 ' + b + '，实得 ' + a) }
}
function has(name, hay, needle) { eq(name, String(hay).indexOf(needle) >= 0, true) }
function ok(name, cond) { eq(name, !!cond, true) }

const HOST = fs.readFileSync(path.join(__dirname, '..', 'dist', 'host.js'), 'utf8')
function cut(tag) {
  const m = HOST.match(new RegExp('// \\[\\[' + tag + '-BEGIN\\]\\]([\\s\\S]*?)// \\[\\[' + tag + '-END\\]\\]'))
  if (!m) { console.error('切不到 ' + tag + ' 块（标记是不是没了？）'); process.exit(1) }
  return m[1]
}

// ─── 沙箱：只给被切代码真正用到的东西 ────────────────────────
const sandbox = {}
sandbox.console = { log: function () {}, warn: function () {}, error: function () {} }
sandbox.cvTrace = []
sandbox.ccvTrace = function (m) { sandbox.cvTrace.push(String(m)) }
sandbox.canvases = new Map()
sandbox.__applied = []
// applyWrite 的桩：记下调用 + 真的改内容（"只落一条历史"是 applyWrite 自己的性质，
// 由 test-host-undo.cjs 负责；这里只验"拼出来的内容对不对、有没有乱拼"）
sandbox.applyWrite = function (c, content, mode, baseVersion, source) {
  sandbox.__applied.push({ id: c.id, content: content, mode: mode, base: baseVersion, source: source })
  c.content = content
  c.version = (c.version || 0) + 1
  return { version: c.version }
}
// 定位与配对：真代码在别的块里，这里给等价的桩（口径与实现一致）
sandbox.occIndexes = function (text, needle) {
  const out = []; if (!needle) return out
  let i = -1
  while ((i = String(text).indexOf(needle, i + 1)) >= 0) out.push(i)
  return out
}
sandbox.ccvTurnMsg = function (agent) { return agent && agent.__msg ? agent.__msg : null }
sandbox.ccvParseRefs = function (text) { return (sandbox.__refs && sandbox.__refs[text]) || [] }
sandbox.ccvPinFind = function (p, q, used, remaining) {
  const list = sandbox.__pins || []
  const matched = list.filter(function (x) { return (!used || used.indexOf(x) < 0) && x.text === q && (!p || x.path === p) })
  if (!matched.length) return null
  const back = (typeof remaining === 'number' && remaining > 0) ? remaining : 1
  let k = matched.length - back
  if (k < 0) k = 0
  return matched[k]
}
sandbox.scratchForPin = function (code) {
  let hit = null
  sandbox.canvases.forEach(function (c) {
    if (!hit && c && c.type === 'scratch' && c.scratch && c.scratch.pinCode === code) hit = c
  })
  return hit
}
sandbox.ctx = { on: function (ev, fn) { (sandbox.__ons = sandbox.__ons || []).push({ ev: ev, fn: fn }); return function () {} } }
// 注入时留下的引用缓存。真身是 13-selref-context.js 的模块级变量 —— 不在本测试切的
// 那一块里，所以得在这儿声明；否则拼接块一读它就 ReferenceError ✗（实测踩过）。
sandbox.ccvLastTurnRefs = null
vm.createContext(sandbox)
vm.runInContext(cut('CCV-SPLICE'), sandbox, { filename: 'dist/host.js#splice' })

// ─── 夹具 ────────────────────────────────────────────────────
const DOCID = 'cv-doc'
const AREAID = 'scratch-1'
function reset(opts) {
  opts = opts || {}
  sandbox.canvases.clear()
  sandbox.__applied = []
  sandbox.cvTrace = []
  sandbox.canvases.set(DOCID, {
    id: DOCID, title: '主文档', type: 'document', version: opts.docVersion || 5,
    content: opts.docContent === undefined ? '前段 AAA 后段' : opts.docContent,
  })
  sandbox.canvases.set(AREAID, {
    id: AREAID, title: '选区片段', type: 'scratch', version: 2,
    content: opts.areaContent === undefined ? 'BBB' : opts.areaContent,
    scratch: {
      docId: DOCID, offset: opts.offset === undefined ? 3 : opts.offset,
      length: opts.length === undefined ? 3 : opts.length,
      ordinal: opts.ordinal || 0, pinCode: opts.pinCode || 7,
      origQuote: opts.origQuote === undefined ? 'AAA' : opts.origQuote,
      spliced: !!opts.spliced,
    },
  })
}
function doc() { return sandbox.canvases.get(DOCID) }
function area() { return sandbox.canvases.get(AREAID) }

console.log('\n[1] 原位拼接：内容对不对、落在哪儿')
{
  reset()
  const r = sandbox.ccvSpliceArea(area())
  eq('[1a] 拼成功', r.ok, true)
  eq('[1b] 文档内容 = 前段 + 编辑区 + 后段', doc().content, '前段 BBB 后段')
  eq('[1c] 正好落一个撤销步骤（applyWrite 一次）', sandbox.__applied.length, 1)
  eq('[1d] 走的是 ai 来源（撤销里能看出是谁改的）', sandbox.__applied[0].source, 'ai')
  eq('[1e] 版本号带上了（并发校验）', sandbox.__applied[0].base, 5)
  eq('[1f] 标记为已拼（第 4 步销毁要用）', area().scratch.spliced, true)
  eq('[1g] 单拼不负责销毁（销毁在"整轮"那一步统一做）', !!sandbox.canvases.get(AREAID), true)
}

console.log('\n[2] 长度变了也要对（替换成更短/更长的内容）')
{
  reset({ areaContent: 'B' })
  sandbox.ccvSpliceArea(area())
  eq('[2a] 换成 1 个字', doc().content, '前段 B 后段')
  reset({ areaContent: 'BBBBBBB' })
  sandbox.ccvSpliceArea(area())
  eq('[2b] 换成 7 个字', doc().content, '前段 BBBBBBB 后段')
}

console.log('\n[3] 🔴 过期校验：原位变了 → 按序数重定位，绝不硬拼')
{
  // 主文档在前面插了字 → 原来的偏移已经不对了；"AAA" 只剩一处
  reset({ docContent: '新加的字 前段 AAA 后段', offset: 3 })
  const r = sandbox.ccvSpliceArea(area())
  eq('[3a] 仍能拼（重定位成功）', r.ok, true)
  eq('[3b] 拼到了正确的位置（不是原来的偏移 3）', doc().content, '新加的字 前段 BBB 后段')
  has('[3c] 说清了"原位已变"', r.why, '原位已变')
}
{
  // 原位变了 + 原文出现多处 → 走**序数重定位**那条分支
  reset({ docContent: 'AAA 中 AAA 尾 AAA', offset: 99, ordinal: 2 })
  const r = sandbox.ccvSpliceArea(area())
  eq('[3c2] 按序数重定位成功', r.ok, true)
  eq('[3c3] 拼到了第 2 处（不是第 1 处）', doc().content, 'AAA 中 BBB 尾 AAA')
  has('[3c4] 说清了是"按序数重定位"', r.why, '重定位')
}
{
  // 多处 + 序数对不上 → 必须**不拼**并说明
  reset({ docContent: 'AAA 中 AAA 后', offset: 3, ordinal: 0 })
  const r = sandbox.ccvSpliceArea(area())
  eq('[3d] 分不出哪一处 → 不拼', r.ok, false)
  has('[3e] 明确说了没拼', r.why, '没有拼')
  eq('[3f] 文档一个字没动', doc().content, 'AAA 中 AAA 后')
  eq('[3g] 一次写入都没发生', sandbox.__applied.length, 0)
}
{
  // 原文彻底找不到了 → 不拼
  reset({ docContent: '这段已经没了', offset: 3 })
  const r = sandbox.ccvSpliceArea(area())
  eq('[3h] 原文失效 → 不拼', r.ok, false)
  has('[3i] 说清了失效', r.why, '找不到')
}

console.log('\n[4] 幂等与边界')
{
  reset({ spliced: true })
  const r = sandbox.ccvSpliceArea(area())
  eq('[4a] 已拼过的不再拼', r.ok, false)
  has('[4b] 说清了原因', r.why, '已经拼过')
}
{
  reset({ areaContent: 'AAA' })            // 拼完和原文一样
  const r = sandbox.ccvSpliceArea(area())
  eq('[4c] 内容没变 → 不写（不制造空撤销步骤）', r.ok, false)
  eq('[4d] 一次写入都没发生', sandbox.__applied.length, 0)
}
{
  reset()
  sandbox.canvases.delete(DOCID)
  const r = sandbox.ccvSpliceArea(area())
  eq('[4e] 主文档不在了 → 不拼', r.ok, false)
}

console.log('\n[5] 🔴 一轮结束：只拼「本轮引用到的」那些编辑区')
{
  reset()
  sandbox.__pins = [{ code: 7, path: 'D:\\d\\主文档.md', text: 'AAA', ordinal: 0 }]
  sandbox.__refs = { 'msg1': [{ quote: 'AAA', path: 'D:\\d\\主文档.md', title: '', ordinal: 0 }] }
  const agent = { __msg: { text: 'msg1' } }
  return sandbox.ccvSpliceTurn({ agent: agent }).then(function () {
    eq('[5a] 拼了一次', sandbox.__applied.length, 1)
    eq('[5b] 内容正确', doc().content, '前段 BBB 后段')
    // ★ 第 4 步：拼接成功 → 编辑区立刻销毁（一次性对象，全自动）
    eq('[5b2] 编辑区已销毁（第 4 步）', sandbox.canvases.get(AREAID), undefined)

    // 没有开过编辑区的普通引用 → 什么都不做
    reset()
    sandbox.__pins = [{ code: 99, path: 'D:\\d\\主文档.md', text: 'AAA', ordinal: 0 }]  // 没有对应的 scratch
    return sandbox.ccvSpliceTurn({ agent: agent })
  }).then(function () {
    eq('[5c] 引用没开过编辑区 → 不拼（普通聊天不动文档）', sandbox.__applied.length, 0)

    // 注册检查：两个钩子都要在（turn-stopping 语义最准；status:idle 是兜底）
    const evs = (sandbox.__ons || []).map(function (x) { return x.ev })
    ok('[5d] 注册了 agent/turn-stopping', evs.indexOf('agent/turn-stopping') >= 0)
    ok('[5d2] 还注册了 agent/status（兜底：scoped 事件根上下文未必收得到）', evs.indexOf('agent/status') >= 0)
    ok('[5e] 两个钩子都挂了处理函数', (sandbox.__ons || []).every(function (x) { return typeof x.fn === 'function' }))

    // 兜底钩子的过滤：running 不管，idle 才拼
    const statusHook = (sandbox.__ons || []).filter(function (x) { return x.ev === 'agent/status' })[0]
    reset()
    sandbox.__pins = [{ code: 7, path: 'D:\\d\\主文档.md', text: 'AAA', ordinal: 0 }]
    statusHook.fn({ agent: agent, status: 'running' })
    eq('[5f] status=running 时不管（不是轮末）', sandbox.__applied.length, 0)
    statusHook.fn({ agent: agent, status: 'idle' })
    eq('[5g] status=idle 时拼（兜底生效）', sandbox.__applied.length, 1)

    // ── [6] 🔴 引用优先取「注入时留下的那份」────────────────────────
    // 为什么必须有这条：轮次一开始，队列那条消息就被 claim 走了
    //（'agent/inbox/claimed'），轮末 ccvTurnMsg 只能退回读「界面」那条 —— 而它不带引用 ✗。
    // 实测现场：注入看到 1 条引用 ✓ 拼接看到 0 条 ✗，主人报"根本没改"。
    reset()
    sandbox.__pins = [{ code: 7, path: 'D:\\d\\主文档.md', text: 'AAA', ordinal: 0 }]
    sandbox.__refs = {}                       // ← 故意让"现解析"拿不到东西
    sandbox.ccvLastTurnRefs = {
      refs: [{ quote: 'AAA', path: 'D:\\d\\主文档.md', title: '', ordinal: 0 }],
      remaining: [1], src: '队列', time: 1, at: 1,
    }
    return sandbox.ccvSpliceTurn({ agent: { __msg: { text: 'msg1' } } })
  }).then(function () {
    eq('[6a] 用注入留下的引用也拼得成（不依赖轮末重新解析）', sandbox.__applied.length, 1)
    eq('[6b] 内容正确', doc().content, '前段 BBB 后段')
    sandbox.ccvLastTurnRefs = null

    // ── [7] 🔴 同一篇里两个编辑区：必须按**偏移从大到小**拼 ──────────────
    // 设计稿第 5 步的「串行」+ 它自己给的验收方式：「开两个区绑同一篇、
    // 选**同一个词的两处**，先后替换都对」。
    //
    // 夹具为什么这么挑（第一版夹具写错了，改了）：
    //   第一版用 "0123456789" + 两个不相交的区间 —— 结论是**证明不了排序** ✗：
    //   先拼前面那个之后，第二个区靠「按序数重定位」照样能找到 ✓（因为它的原文
    //   在文档里仍然唯一 ✓）→ 两种顺序结果一样 ✗
    //   要证明排序，必须让"重定位也救不了" ✗：
    //     文档 "A1A2A"（A 出现 3 次）
    //     区1 = 第 1 个 A（偏移 0）→ 换成 "ZZZ"（**变长** ✓ 会把后面整体推走 ✗）
    //     区2 = 第 3 个 A（偏移 4，序数 3）→ 换成 "C"
    //   · 从大到小（对 ✓）：先区2（偏移 4 没被动 ✓）→ "A1A2C"，再区1 → "ZZZ1A2C" ✓
    //   · 从小到大（错 ✗）：先区1 → "ZZZ1A2A"，区2 的偏移 4 现在指着 "2" ✗
    //     → 重定位：A 只剩 2 处（索引 4、6），而区2 的序数是 3 ✗ 对不上
    //     → **不拼**（报给主人）✗ —— 这正是"静默改错地方"要防的那类
    reset({ docContent: 'A1A2A' })
    const a1 = area()
    a1.scratch.offset = 0; a1.scratch.length = 1; a1.scratch.origQuote = 'A'; a1.scratch.ordinal = 1
    a1.content = 'ZZZ'
    sandbox.canvases.set('scratch-2', {
      id: 'scratch-2', title: '选区片段', type: 'scratch', version: 1, content: 'C',
      scratch: { docId: DOCID, offset: 4, length: 1, origQuote: 'A', ordinal: 3, pinCode: 8, spliced: false },
    })
    sandbox.__refs = { m2: [
      { quote: 'A', path: 'D:\\d\\主文档.md', title: '', ordinal: 0 },
      { quote: 'A', path: 'D:\\d\\主文档.md', title: '', ordinal: 0 },
    ] }
    sandbox.__pins = [
      { code: 7, path: 'D:\\d\\主文档.md', text: 'A', ordinal: 0 },
      { code: 8, path: 'D:\\d\\主文档.md', text: 'A', ordinal: 0 },
    ]
    sandbox.ccvLastTurnRefs = null
    return sandbox.ccvSpliceTurn({ agent: { __msg: { text: 'm2' } } })
  }).then(function () {
    eq('[7a] ★ 两处都拼对了（从大到小拼 → 第二个区的偏移不被推走）', doc().content, 'ZZZ1A2C')
    if (doc().content !== 'ZZZ1A2C') {
      console.log('    —— 拼接痕迹 ——')
      ;(sandbox.cvTrace || []).forEach(function (t) { console.log('      ' + t) })
      console.log('    —— 实际写入 ——')
      ;(sandbox.__applied || []).forEach(function (a) { console.log('      ' + JSON.stringify(a)) })
    }
    eq('[7b] 两个编辑区都销毁了', sandbox.canvases.get(AREAID), undefined)
    eq('[7c] 两次写入（两个区各一次，各落一个撤销步骤）', sandbox.__applied.length, 2)

    console.log('\n' + (fail ? '✗' : '✓') + ' ' + (fail ? '有失败' : '全部通过') + '：' + pass + ' 通过 / ' + fail + ' 失败')
    process.exit(fail ? 1 : 0)
  })
}
