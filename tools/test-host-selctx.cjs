// 「选区位置主动注入」的零依赖回归测试（host 侧）。
//
// 为什么要单独一份：这块代码在真机上**不会报错，只会安静地注入错内容** ——
//   ① 把用户自己写的「」当成引用 → 凭空定位一段他根本没引用的话；
//   ② 路径对不上时退回"当前打开的文档" → 拿错文档算位置，模型照着改 → 改错文件；
//   ③ 原文已被改掉却不说 → 模型去找"相似内容"猜着改。
// 三种都是界面完全看不出来的错，所以必须有一份能跑出数值的测试。
//
// 做法与另两份 host 测试一致：**从构建产物里把真代码切出来跑**，不是照抄一份。
// 切取范围由 src/host/13-selref-context.js 的 [[CCV-SELCTX-BEGIN/END]] 圈定；
// 标记没了这份测试会立刻失败（而不是悄悄测一份过期副本）。
// 另外还要切 07-tools.js 的 [[CCV-LOCATE]] 块 —— 因为定位算法是复用的，
// 注入和 canvas_locate 说出来的位置必须出自同一段代码。
//
// 跑法：node tools/test-host-selctx.cjs
//   ⚠️ 依赖 dist/host.js —— 改完 src/host/*.js 要先 node tools/build.cjs
const fs = require("fs")
const path = require("path")
const vm = require("vm")

let pass = 0
let fail = 0
function eq(name, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) { pass++; console.log("  ✓ " + name) }
  else { fail++; console.log("  ✗ " + name + "\n      期望: " + w + "\n      实得: " + g) }
}
function ok(name, cond) { eq(name, !!cond, true) }
function has(name, hay, needle) { eq(name, String(hay).indexOf(needle) >= 0, true) }
function hasNot(name, hay, needle) { eq(name, String(hay).indexOf(needle) < 0, true) }

// ─── 从构建产物里切出两段真代码 ────────────────────────────────
const hostPath = path.join(__dirname, "..", "dist", "host.js")
if (!fs.existsSync(hostPath)) {
  console.log("✗ 没有 dist/host.js —— 先跑：node tools/build.cjs")
  process.exit(1)
}
const hostSrc = fs.readFileSync(hostPath, "utf8")

function cut(beginMark, endMark, what) {
  const ia = hostSrc.indexOf(beginMark)
  const ib = hostSrc.indexOf(endMark)
  if (ia < 0 || ib < 0 || ib <= ia) {
    console.log("✗ dist/host.js 里找不到 " + beginMark + " / " + endMark + " 标记 ——")
    console.log("  说明标记被挪走或删掉了；这份测试无法确认自己测的是哪段代码，直接失败。")
    process.exit(1)
  }
  return hostSrc.slice(ia, ib)
}
const locateBlock = cut("// [[CCV-LOCATE-BEGIN]]", "// [[CCV-LOCATE-END]]", "locate")
const selctxBlock = cut("// [[CCV-SELCTX-BEGIN]]", "// [[CCV-SELCTX-END]]", "selctx")

// ─── 沙箱 ──────────────────────────────────────────────────────
const sandbox = {
  console,
  Map,
  JSON,
  Math,
  String,
  Number,
  RegExp,
  Error,
  isFinite,
  parseInt,
}
sandbox.__tools = []
sandbox.__contexts = []
sandbox.ctx = {
  get: function (name) {
    if (name !== "systemPrompt") return undefined
    return {
      context: function (cfg) { sandbox.__contexts.push(cfg); return function () {} },
      section: function () { return function () {} },
    }
  },
  tools: {
    register: function (def) { sandbox.__tools.push(def); return function () {} },
    restrict: function () { return function () {} },
  },
}
sandbox.defineTool = function (def) { return def }
sandbox.canvases = new Map()
sandbox.activeId = null

const prelude = [
  "function toolOutput(v) { return JSON.stringify(v) }",
  "function err(code, message) { return { ok: false, error: { code: code, message: message } } }",
].join("\n")

vm.createContext(sandbox)
// 顺序要紧：SELCTX 复用 LOCATE 里的 occIndexes / lineColOf / asOneLine
vm.runInContext(prelude + "\n" + locateBlock, sandbox, { filename: "dist/host.js#locate" })
vm.runInContext(selctxBlock, sandbox, { filename: "dist/host.js#selctx" })

const reg = sandbox.__contexts.find((c) => c.name === "collab-canvas-selection")
if (!reg) {
  console.log("✗ 那段代码没有注册出 collab-canvas-selection 动态上下文")
  process.exit(1)
}
if (typeof reg.text !== "function") {
  console.log("✗ 注册的 text 不是函数 —— 官方是按函数求值的")
  process.exit(1)
}

// ─── 造一个假会话 ──────────────────────────────────────────────
// 按官方 session 的真实形状：surface.nodes 是一串 seq，eventAt(seq) 取事件，
// user/message 的 data 就是消息本身（不是 {message:…}，那是 assistant 那种）。
function makeAgent(messages) {
  const nodes = messages.map((_, i) => i)
  const bySeq = new Map()
  messages.forEach((m, i) => {
    bySeq.set(i, {
      type: "user/message",
      seq: i,
      data: { id: "m" + i, role: "user", source: m.source || { kind: "user" }, content: m.content },
    })
  })
  return {
    session: {
      surface: { nodes },
      eventAt: (seq) => bySeq.get(seq),
    },
  }
}
function human(text) {
  return { content: [{ type: "text", text: text }], source: { kind: "user" } }
}
function injected(text) {
  return { content: [{ type: "text", text: text }], source: { kind: "plugin", plugin: "collab-canvas" } }
}

// 跑一次 provider。每次传入不同的最后一条正文，天然绕开内部 memo。
function run(messages) {
  return reg.text({ agent: makeAgent(messages) })
}

function setDocs(list) {
  sandbox.canvases.clear()
  for (const d of list) sandbox.canvases.set(d.id, d)
  sandbox.activeId = list[0] ? list[0].id : null
}

const DOC = {
  id: "c1",
  title: "话布优化",
  filePath: "D:\\proj\\canvas-docs\\话布优化.md",
  version: 3,
  content: "# 话布优化\n\n每天晚饭后散步的习惯要保持。\n\n## 小标题\n\n中间一段别的内容。\n\n这里又提到散步这件事。\n",
}
// 上面 content 里「散步」出现 2 处（第 3 行、第 9 行）

// 引用正文的形状，与 lib/selref.js 的 codec.serialize 一致
function refMention(quote, label, p) {
  return '@"' + (p || DOC.filePath) + '"' + (label ? " > " + label : "") + "\n「" + quote + "」"
}
function refPlain(quote, label, title) {
  return "【话布选区】" + (title || DOC.title) + (label ? " · " + label : "") + "\n「" + quote + "」"
}

// ═══ 一、引用识别：认什么、不认什么 ═══════════════════════════
console.log("\n[1] 引用识别（认错 = 凭空定位一段没被引用的文字）")
setDocs([DOC])
{
  const out = run([human("帮我改一下\n" + refMention("散步", "小标题 · 第 9 行", null) + "\n就这样")])
  has("[1] 认 @路径 形态的引用", out, "【话布选区】")
}
{
  const out = run([human(refPlain("散步", "第 9 行", null))])
  has("[2] 认 【话布选区】 形态的引用", out, "话布优化")
}
{
  // 最容易误判的一种：用户自己在正文里写引号
  const out = run([human("他昨天跟我说：\n「散步」这个习惯挺好\n你觉得呢")])
  eq("[3] 用户自己写的「」绝不认成引用", out, "")
}
{
  const out = run([human("帮我看看这段话\n「散步」\n再顺便做点别的")])
  eq("[4] 抬头不像引用 → 不认", out, "")
}
eq("[5] 没有引号的消息", run([human("普通的聊天内容，没有任何引用")]), "")
eq("[6] 空消息", run([human("")]), "")
{
  const two = "先看这个\n" + refMention("散步", "第 9 行", null) + "\n再看这个\n" + refMention("散步", "第 3 行", null)
  const out = run([human(two)])
  eq("[7] 一条消息里两条引用都被算进去", (out.match(/《话布优化》/g) || []).length, 2)
}
{
  const out = run([human('对着这个：\n@"D:\\x\\a.md" > 第 1 行\n没有引号包起来')])
  eq("[8] 有抬头但没「」→ 不认", out, "")
}
{
  // 端到端确认一次：抬头带前导空格时整条链路仍然通（不是只有那三个小函数修好了）
  const out = run([human("看看这段\n " + refMention("中间一段别的内容", "第 7 行", null))])
  has("[8b] 抬头带前导空格 → 整条链路仍能定位", out, "话布优化")
  hasNot("[8c] 不该退化成「没找到」", out, "没找到")
}

// ═══ 二、抬头解析 ═════════════════════════════════════════════
console.log("\n[2] 抬头解析")
const S = sandbox
eq("[9] 取 @\"路径\"", S.ccvRefPath('@"D:\\a\\b.md" > 第 3 行'), "D:\\a\\b.md")
eq("[10] 路径里带空格不被截断", S.ccvRefPath('@"D:\\my docs\\b.md" > 标题'), "D:\\my docs\\b.md")
eq("[11] 没写引号也能取到路径", S.ccvRefPath("@D:\\a\\b.md > 第 3 行"), "D:\\a\\b.md")
eq("[12] 取【话布选区】后面的文档名", S.ccvRefTitle("【话布选区】话布优化 · 第 9 行"), "话布优化")
eq("[13] 只有文档名时", S.ccvRefTitle("【话布选区】话布优化"), "话布优化")
eq("[14] 取「多处（第 2 处）」", S.ccvRefOrdinal("小标题 · 多处（第 2 处）"), 2)
eq("[15] 只写「多处」→ 不编数字", S.ccvRefOrdinal("小标题 · 多处"), 0)
eq("[16] 没有「多处」→ 0", S.ccvRefOrdinal("小标题 · 第 9 行"), 0)
// 🔴 实测踩过：抬头行前面多一个空格，路径就解析不出来，
//    于是安静地退化成"没找到文档" —— 界面毫无异常，只是注入失效。
eq("[9b] 抬头带前导空格也要认出路径", S.ccvRefPath(' @"D:\\a\\b.md" > 第 3 行'), "D:\\a\\b.md")
eq("[12b] 抬头带前导空格也要认出文档名", S.ccvRefTitle(" 【话布选区】话布优化 · 第 9 行"), "话布优化")
eq("[12c] 抬头带制表符也认", S.ccvRefPath('\t@"D:\\a\\b.md" > 第 3 行'), "D:\\a\\b.md")
eq("[17] 三种抬头判定", [S.ccvRefHeadKind('@"a" > b'), S.ccvRefHeadKind("【话布选区】a"), S.ccvRefHeadKind("他说：")],
  ["mention", "plain", null])

// ═══ 三、定位与文案（核心）═══════════════════════════════════
console.log("\n[3] 定位与文案")
setDocs([DOC])
{
  const out = run([human(refMention("中间一段别的内容", "第 7 行", null))])
  has("[18] 只有一处 → 说死", out, "全文只有这一处")
  has("[19] 带上行号", out, "第 7 行")
  has("[20] 给出上下文", out, "【中间一段别的内容】")
}
{
  const out = run([human(refMention("散步", "第 9 行 · 多处（第 2 处）", null))])
  has("[21] 多处 → 标出用户要的那一处", out, "★")
  has("[22] 说清是第几处", out, "用户要的是第 2 处")
  has("[23] 结论指向 ★ 那一处", out, "照上面标 ★ 的那一处改")
  has("[24] 提醒别碰其他处", out, "不要碰")
}
{
  const out = run([human(refMention("散步", "第 9 行 · 多处", null))])
  has("[25] 只写「多处」→ 不替模型挑一处", out, "分不出用户要哪一处")
  has("[26] 要求摆给用户确认", out, "不要自己挑一处改")
}
{
  // 引用发出后文档被改掉了
  const out = run([human(refMention("这句话已经没有了", "第 3 行", null))])
  has("[27] 原文不在文里 → 明说失效", out, "已经失效")
  has("[28] 禁止照着相似内容改", out, "不要")
  has("[29] 要求用户重新划", out, "重新划一次")
}
{
  const out = run([human(refMention("散步", "第 3 行", "D:\\proj\\canvas-docs\\别的文档.md"))])
  has("[30] 文档找不到 → 明说没找到", out, "没找到")
  has("[31] 不许在别的文档里找相似内容", out, "别在别的文档里找相似内容改")
}

// ═══ 四、找文档的边界（关键回归）═════════════════════════════
console.log("\n[4] 找文档：宁可认不出，也不拿错文档")
{
  // 反斜杠 / 正斜杠写法不同也要能对上
  const out = run([human(refMention("散步", "第 3 行", "D:/proj/canvas-docs/话布优化.md"))])
  has("[32] 斜杠方向不同也能对上", out, "话布优化")
}
{
  // ⚠️ 最危险的一条：路径对不上时，绝不能退回"当前打开的文档"。
  //    如果退回，模型会拿着另一份文档的位置去改 —— 改错文件，界面毫无异常。
  const other = { id: "c2", title: "另一份", filePath: "D:\\proj\\canvas-docs\\另一份.md", version: 1, content: "散步散步散步" }
  setDocs([other, DOC])   // activeId 落在 other 上
  const out = run([human(refMention("散步", "第 3 行", "D:\\proj\\canvas-docs\\根本不存在.md"))])
  has("[33] 路径对不上不拿活跃文档顶包", out, "没找到")
  hasNot("[34] 更不能按活跃文档的内容算位置", out, "另一份")
}
{
  // 只有文件名对得上、目录不同 → 允许兜住（用户从别处复制路径的情况）
  const out = run([human(refMention("散步", "第 3 行", "E:\\别的盘\\canvas-docs\\话布优化.md"))])
  has("[35] 目录不同但文件名相同 → 兜住", out, "话布优化")
}
setDocs([DOC])

// ═══ 五、原文本身含引号 ═══════════════════════════════════════
console.log("\n[5] 原文里含「」时")
{
  const doc2 = {
    id: "c3", title: "带引号", filePath: "D:\\proj\\canvas-docs\\带引号.md", version: 1,
    content: "他常说「早睡早起」这句话，后来自己也做到了。",
  }
  setDocs([doc2])
  // serialize 出来是 head + 「他常说「早睡早起」这句话」—— 第一个「」会截短
  const out = run([human('@"D:\\proj\\canvas-docs\\带引号.md" > 第 1 行\n「他常说「早睡早起」这句话」')])
  has("[36] 原文含引号 → 延长后仍能定位", out, "带引号")
  hasNot("[37] 不应误报失效", out, "已经失效")
}

// ═══ 六、会话读取 ═════════════════════════════════════════════
console.log("\n[6] 会话读取")
setDocs([DOC])
{
  // 我们自己注入的那条也是 user/message —— 必须跳过它继续往前找
  const out = run([
    human(refMention("散步", "第 3 行 · 多处（第 2 处）", null)),
    injected("【话布选区】上一轮注入的内容"),
  ])
  has("[38] 跳过自己注入的消息，往前找到真人消息", out, "话布优化")
}
{
  // 用户发了新的、不带引用的消息 → 注入必须消失（返回空 → 官方抹掉上一条）
  const out = run([
    human(refMention("散步", "第 3 行", null)),
    injected("【话布选区】上一轮注入的内容"),
    human("那我们聊点别的吧"),
  ])
  eq("[39] 新一轮没引用 → 注入变空（官方据此抹掉旧注入）", out, "")
}
eq("[40] 只有注入消息、没有真人消息", run([injected("x")]), "")
eq("[41] 没有 session", reg.text({ agent: {} }), "")
eq("[42] 完全没有 agent 参数", reg.text(undefined), "")
eq("[43] agent 是畸形对象", reg.text({ agent: { session: { surface: {} } } }), "")
{
  // content 是纯字符串（不是分块数组）也要能读
  const agent = {
    session: {
      surface: { nodes: [0] },
      eventAt: () => ({ type: "user/message", data: { content: refMention("散步", "第 3 行", null), source: { kind: "user" } } }),
    },
  }
  has("[44] content 是字符串也能读", reg.text({ agent }), "话布优化")
}
{
  // 只有 assistant/tool 事件，没有真人消息
  const agent = {
    session: {
      surface: { nodes: [0, 1] },
      eventAt: (s) => ({ type: s === 0 ? "assistant/message" : "tool/result", data: { message: { content: [] } } }),
    },
  }
  eq("[45] 没有真人消息 → 空", reg.text({ agent }), "")
}

// ═══ 七、注册与安全 ═══════════════════════════════════════════
console.log("\n[7] 注册与安全")
eq("[46] 上下文名字唯一", reg.name, "collab-canvas-selection")
ok("[47] order 是有限数（官方要求）", Number.isFinite(reg.order))
{
  const cfg = sandbox.__contexts.filter((c) => c.name === "collab-canvas-selection")
  eq("[48] 只注册一次", cfg.length, 1)
}
{
  // provider 抛错会毁掉整个 prompt 组装 —— 必须自己吞掉，退化成一件事：不注入
  const boom = {
    session: {
      get surface() { throw new Error("boom") },
      eventAt() { throw new Error("boom") },
    },
  }
  let threw = false
  let out = null
  try { out = reg.text({ agent: boom }) } catch (e) { threw = true }
  eq("[49] 内部抛错时不往外抛", threw, false)
  eq("[50] 内部抛错时返回空（= 不注入）", out, "")
}

// ═══ 八、长度上限 ═════════════════════════════════════════════
console.log("\n[8] 长度上限")
{
  // 造一份"长原文出现很多次、每次周围都有内容"的文档，再一条消息里塞三条引用，
  // 把注入撑过上限，看它会不会自己收口。（三种形态各来一个用例更稳，但这里只要总量够大）
  const pad = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未"
  const quote = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十"
  const chunks = []
  for (let i = 0; i < 6; i++) chunks.push(pad + quote + pad)
  const doc3 = {
    id: "c4", title: "大文档", filePath: "D:\\proj\\canvas-docs\\大文档.md", version: 1,
    content: chunks.join("\n\n"),
  }
  setDocs([doc3])
  const one = ' @"D:\\proj\\canvas-docs\\大文档.md" > 第 1 行 · 多处（第 3 处）\n「' + quote + "」"
  const out = run([human("看看这三处\n" + one + "\n再确认一下\n" + one + "\n最后一遍\n" + one)])
  has("[51] 被截断时明确说了", out, "已截断")
  eq("[52] 截断后长度收在上限附近", out.length <= 1200 + 20, true)
  ok("[53] 截断标记在末尾（是收口，不是中途丢字）", out.trim().endsWith("已截断）"))
}

// ═══ 九、与 canvas_locate 说的是同一套位置 ════════════════════
// （这段要等异步：工具本身是 async 的）
;(async function () {
  console.log("\n[9] 注入与 canvas_locate 必须同源")
  setDocs([DOC])
  const tool = sandbox.__tools.find((t) => t.name === "canvas_locate")
  ok("[54] canvas_locate 仍在（注入只是提前送答案，不是替代它）", !!tool)
  const viaTool = JSON.parse(await tool.execute({ text: "散步", path: DOC.filePath, ordinal: 2 }))
  const viaCtx = run([human(refMention("散步", "第 9 行 · 多处（第 2 处）", null))])
  eq("[55] 两边的总处数一致", viaTool.total, 2)
  has("[56] 两边的目标行号一致", viaCtx, "第 " + viaTool.spots[1].line + " 行")

  console.log("\n" + (fail === 0 ? "✓ 全部通过" : "✗ 有失败") + "：" + pass + " 通过 / " + fail + " 失败")
  process.exit(fail === 0 ? 0 : 1)
})()
