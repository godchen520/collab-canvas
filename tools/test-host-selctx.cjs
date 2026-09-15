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
// 按官方 session 的真实形状：
//   · surface.nodes 是一串 seq，eventAt(seq) 取事件；
//   · 每个事件都带 time（官方 append 时写的 Date.now()）；
//   · user/message 的 data 就是消息本身（不是 {message:…}，那是 assistant 那种）；
//   · **另外还有一条"投递记录"**：官方一收到消息就先记一条
//     `agent/inbox/spliced`（data.inserted 装着消息），它**早于**消息写进界面。
//     真机第 1 步求值上下文时，界面上还没有刚发的那条，只有队列里有 →
//     所以这份假数据必须两样都有，否则测的就不是同一件事。
const T0 = 1700000000000                 // 固定基准时间：结果不随运行时刻变化
const STEP = 60000                       // 相邻两条消息隔 1 分钟
const msgTime = (i) => T0 + i * STEP
const PIN_BASE = T0 - 600000             // 上报默认发生在"划选那一刻"（必然早于发送）

function makeAgent(messages, opt) {
  opt = opt || {}
  const surfaceCount = typeof opt.surfaceCount === "number" ? opt.surfaceCount : messages.length
  const nodes = []
  const bySeq = new Map()
  const events = []
  let seq = 0
  messages.forEach((m, i) => {
    const ev = {
      type: "user/message",
      seq: seq++,
      time: msgTime(i),
      data: { id: "m" + i, role: "user", source: m.source || { kind: "user" }, content: m.content },
    }
    if (i < surfaceCount) { nodes.push(ev.seq); bySeq.set(ev.seq, ev) }
  })
  if (!opt.noInboxEvents) {
    // 投递记录：只记"人发出来的"（我们自己注入的那条不走队列，真机也是这样）
    messages.forEach((m, i) => {
      const kind = (m.source && m.source.kind) || "user"
      if (kind !== "user") return
      events.push({
        type: "agent/inbox/spliced",
        seq: seq++,
        time: msgTime(i) - 1000,        // 投递早于进界面（真机就是这个顺序）
        data: { target: "next-turn", start: 0, inserted: [{ id: "m" + i, source: { kind: "user" }, content: m.content }] },
      })
    })
    // 队列里流着的**别的东西**（工具结果带回来的补充上下文等）
    ;(opt.extraInbox || []).forEach((b) => {
      events.push({
        type: "agent/inbox/spliced",
        seq: seq++,
        time: typeof b.time === "number" ? b.time : T0 + 900000,
        data: { target: "next-step", start: 0, inserted: b.messages },
      })
    })
  }
  const session = {
    surface: { nodes },
    eventAt: (s) => bySeq.get(s),
  }
  if (!opt.noInboxEvents) session.snapshotEvents = () => events
  return { session }
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
// 2026-09-15 起正文里**没有标签**了（对话卡片只留文件名）—— 这是新的常态
function refBare(quote, p) {
  return '@"' + (p || DOC.filePath) + '"\n「' + quote + '」'
}
function clearPins() { sandbox.ccvPins.length = 0 }
// 默认 `at` 用"划选那一刻"的固定值 —— 真机上它必然早于消息，
// 不这么写会让"兜底通道的否决"（上报比消息新才否决）被假数据误触发。
function pinIt(o) { return sandbox.ccvPinAdd(Object.assign({ path: DOC.filePath, text: "散步", at: PIN_BASE }, o)) }

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
  has("[22] 说清是第几处", out, "用户要的就是第 2 处")
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

// ═══ 七·五、序数：正文里不写坐标之后，靠什么知道是哪一处 ═════════
// 2026-09-15 主人要求对话里那张卡片只留文件名 → 标签整串去掉了。
// 而"第几处"是服务端**自己算不出**的（要划选那一刻的 DOM 位置），
// 所以改由客户端单独上报。这组用例就是钉住这条通道。
console.log("\n[7b] 序数改走上报通道")
setDocs([DOC])
{
  clearPins()
  // 没上报 → 只能说"分不出"。**绝不替模型挑一处** —— 挑错就是改错地方。
  const out = run([human(refBare("散步"))])
  has("[57] 正文没标签 + 没上报 → 不替模型挑", out, "分不出用户要哪一处")
  hasNot("[58] 更不能瞎标一个 ★", out, "★")
}
{
  clearPins()
  pinIt({ code: 1, ordinal: 2, dupCount: 2 })
  const out = run([human("把这个改一下\n" + refBare("散步"))])
  has("[59] 有上报 → 注入仍能说出「第 2 处」", out, "用户要的就是第 2 处")
  has("[60] 并标出 ★", out, "★")
  has("[61] 结论仍指向 ★ 那一处", out, "照上面标 ★ 的那一处改")
}
{
  clearPins()
  pinIt({ code: 2, ordinal: 0, dupCount: 2 })   // 客户端没算出序数（选在匹配中间）
  const out = run([human(refBare("散步"))])
  has("[62] 上报里序数为 0 → 退回「分不出」", out, "分不出用户要哪一处")
}
{
  clearPins()
  pinIt({ code: 3, ordinal: 2, path: "D:\\proj\\canvas-docs\\别的.md" })
  const out = run([human(refBare("散步"))])
  has("[63] 上报记的是别的文档 → 不误用", out, "分不出用户要哪一处")
}
{
  clearPins()
  pinIt({ code: 4, ordinal: 1 })
  pinIt({ code: 5, ordinal: 2 })
  eq("[64a] 两条都存进去了", sandbox.ccvPins.length, 2)
  eq("[64b] 存进去的序数分别是 1 和 2", [sandbox.ccvPins[0].ordinal, sandbox.ccvPins[1].ordinal], [1, 2])
  const out = run([human(refBare("散步"))])
  has("[64] 两条都在时取最新那条（用户是「先划、后发」）", out, "用户要的就是第 2 处")
  // 🔴 [71]/[72] 钉的是 [64] 暴露出来的**真缺陷**，不是测试写法问题：
  //    同一段原文出现多处时，用户前后两次引用拼出来的正文可以**一字不差**，
  //    memo 只按正文做键就会把第二次挡掉 → 模型拿第一次的序数去改，改错地方。
  //    这两条故意用和 [57] 完全相同的正文，只换上报。
  clearPins()
  pinIt({ code: 6, ordinal: 1 })
  has("[71] 正文一字不差、只换了上报 → 结果必须跟着变（memo 不能挡住）", run([human(refBare("散步"))]), "用户要的就是第 1 处")
  clearPins()
  pinIt({ code: 7, ordinal: 2 })
  has("[72] 再报一次第 2 处 → 又跟着变", run([human(refBare("散步"))]), "用户要的就是第 2 处")
}
{
  clearPins()
  // 兼容路径：老客户端（浏览器缓存）／用户手打的引用，标签还在，照样认
  const out = run([human(refMention("散步", "第 9 行 · 多处（第 2 处）", null))])
  has("[65] 没有上报时，退回认标签里的序数", out, "用户要的就是第 2 处")
}
{
  clearPins()
  // 原文本身含「」→ 解析出来会被截短，但它是上报原文的前缀，仍要配得上
  const doc2 = {
    id: "c5", title: "带引号", filePath: "D:\\proj\\canvas-docs\\带引号.md", version: 1,
    content: "他常说「早睡早起」这句话，后来自己也做到了。\n\n再说一次：他常说「早睡早起」这句话。",
  }
  setDocs([doc2])
  // 上报的时间戳要给准（真机上它必然早于消息）—— 不给就会落成"此刻"，
  // 被测代码会判成"界面没追上"而否决掉，于是这条用例就变成在测别的事了。
  sandbox.ccvPinAdd({ path: doc2.filePath, text: "他常说「早睡早起」这句话", ordinal: 2, dupCount: 2, at: PIN_BASE + 1000 })
  const out = run([human('@"D:\\proj\\canvas-docs\\带引号.md"\n「他常说「早睡早起」这句话」')])
  has("[66] 原文被截短时仍能配上报记录", out, "用户要的就是第 2 处")
  setDocs([DOC])
}
{
  // 通道两端都必须在，缺一边这功能就是死的
  has("[67] host 注册了接收端点", hostSrc, "/api/canvas/selref/pin")
  has("[68] 端点把数据交给 pin 存储", hostSrc, "ccvPinAdd(body)")
  const clientSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "selref.js"), "utf8")
  has("[69] 客户端会往这个端点上报", clientSrc, '"/api/canvas/selref/pin"')
  has("[70] 上报在 capture 时（不是发送时，避开竞态）", clientSrc, "pinUp(rec)")
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
  // 清干净：上面的用例可能留下"时间戳很新"的上报，会把兜底通道的否决误触发
  clearPins()
  const one = ' @"D:\\proj\\canvas-docs\\大文档.md" > 第 1 行 · 多处（第 3 处）\n「' + quote + "」"
  const out = run([human("看看这三处\n" + one + "\n再确认一下\n" + one + "\n最后一遍\n" + one)])
  has("[51] 被截断时明确说了", out, "已截断")
  eq("[52] 截断后长度收在上限附近", out.length <= 1200 + 20, true)
  ok("[53] 截断标记在末尾（是收口，不是中途丢字）", out.trim().endsWith("已截断）"))
}

// ═══ 八·五、「提示到底属于哪条消息」—— 对应关系 ═════════════════
// 2026-09-15 主人报：注入讲的是**上一条**消息里的引用（提示和引用对不上）。
// 根因：官方第 1 步求值上下文时，用户刚发的那条还没写进会话界面
//   （preStep: ① claim ② assemble←我们 ③ append user/message）→ 只看界面必然晚一拍。
// 修法：改读"待处理队列"里那条**更早**的记录（agent/inbox/spliced）。
// 这组用例把「提示 = 这一步要处理的那条消息的引用」钉死。
console.log("\n[7c] 提示必须对应「这一步要处理的那条消息」")
setDocs([DOC])
{
  clearPins()
  // 真机第 1 步：界面上只有上一条（引用「散步」），队列里已经有刚发的（引用「中间一段别的内容」）
  const m1 = human("帮我改一下\n" + refBare("散步"))
  const m2 = human("再看这个\n" + refMention("中间一段别的内容", null, null))
  const out = reg.text({ agent: makeAgent([m1, m2], { surfaceCount: 1 }) })
  // ⚠️ 断言要**认准"这条引用被当成主角"**，不能只搜原文 ——
  //   上一条的上下文摘录里本来就可能顺带出现下一段的字（第一版就是这么蒙对的）。
  has("[73] 界面没追上时，讲的是**刚发的**那条", out, "「中间一段别的内容」在第")
  hasNot("[74] 不许拿上一条的引用充数", out, "「散步」在第")
}
{
  clearPins()
  // 第 2 步：界面追上了 → 两条通道读到同一条，结论不能翻回上一条
  const out = run([
    human("帮我改一下\n" + refBare("散步")),
    human("再看这个\n" + refMention("中间一段别的内容", null, null)),
  ])
  has("[75] 界面追上之后仍然一致", out, "「中间一段别的内容」在第")
  hasNot("[76] 也不会退回上一条的引用", out, "「散步」在第")
}
{
  clearPins()
  // 队列里最新一批是**机器塞的**（工具结果带的补充上下文）→ 必须继续往前翻到人那条
  const mHuman = human("改一下\n" + refMention("中间一段别的内容", null, null))
  const agent = makeAgent([mHuman], {
    surfaceCount: 0,
    extraInbox: [{
      time: msgTime(0) + 5000,
      messages: [{ id: "ctx", source: { kind: "plugin", plugin: "x" }, content: [{ type: "text", text: "工具结果带的补充说明" }] }],
    }],
  })
  const out = reg.text({ agent })
  has("[77] 队列里最新一批是机器塞的 → 继续往前翻，仍找到人那条", out, "「中间一段别的内容」在第")
}
{
  clearPins()
  // 队列里最新一批是**助手/工具**来源（不是 plugin 也不是 user）→ 同样不许当成用户说的话
  const mHuman = human("改一下\n" + refMention("中间一段别的内容", null, null))
  const agent = makeAgent([mHuman], {
    surfaceCount: 0,
    extraInbox: [{
      time: msgTime(0) + 5000,
      messages: [{ id: "t1", source: { kind: "tool", callId: "c1" }, content: [{ type: "text", text: "工具修好的内容" }] }],
    }],
  })
  has("[78] kind=tool 同样不当成人说的话", reg.text({ agent }), "「中间一段别的内容」在第")
}
{
  // 队列那条比界面上那条**旧**（界面已追上）→ 用界面的，结论一样
  clearPins()
  const mHuman = human("改一下\n" + refMention("中间一段别的内容", null, null))
  const out = reg.text({ agent: makeAgent([human("先聊点别的"), mHuman]) })
  has("[79] 界面已追上时用界面的那条（内容一致）", out, "「中间一段别的内容」在第")
}
{
  // 🔴 兜底通道（拿不到队列记录 = 老版本）：界面那条比最新上报还旧
  //    → 说明界面没追上 → **一个字都不说**。宁可不说，也不说错。
  clearPins()
  const agent = makeAgent([human("帮我改\n" + refBare("散步"))], { noInboxEvents: true })
  sandbox.ccvPinAdd({ path: DOC.filePath, text: "散步", ordinal: 2, dupCount: 2, at: msgTime(0) + 5000 })
  eq("[80] 兜底通道：界面没追上 → 不注入（不是注错）", reg.text({ agent }), "")
}
{
  // 同一条通道，但上报比消息旧（正常顺序：先划、后发）→ 照常注入
  clearPins()
  const agent = makeAgent([human("帮我改\n" + refBare("散步"))], { noInboxEvents: true })
  sandbox.ccvPinAdd({ path: DOC.filePath, text: "散步", ordinal: 2, dupCount: 2, at: msgTime(0) - 5000 })
  has("[81] 上报早于消息（正常顺序）→ 照常注入", reg.text({ agent }), "用户要的就是第 2 处")
}
{
  // 用户中途又划了一段新引用（上报更新），界面还没追上 → 立刻改为不注入
  clearPins()
  const agent = makeAgent([human("帮我改\n" + refBare("散步"))], { noInboxEvents: true })
  sandbox.ccvPinAdd({ path: DOC.filePath, text: "散步", ordinal: 1, dupCount: 2, at: msgTime(0) - 5000 })
  has("[82] 先验一次：正常情况能注入", reg.text({ agent }), "【话布选区】")
  sandbox.ccvPinAdd({ path: "D:\\proj\\canvas-docs\\别处.md", text: "另一段", ordinal: 1, at: msgTime(0) + 9000 })
  eq("[83] 之后又上报新引用 → 界面没追上 → 立刻改为不注入", reg.text({ agent }), "")
}
{
  // 一条消息里两次引用同一段原文：两条不许抢同一条上报
  // （抢了第二条就会顶替第一条的序数 —— 正是"改错地方"那种错）
  clearPins()
  pinIt({ code: 9, ordinal: 2, dupCount: 2 })
  eq("[84a] 只上报了一条", sandbox.ccvPins.length, 1)
  const out = run([human(refBare("散步") + "\n另外\n" + refBare("散步"))])
  has("[84] 第一条用掉这条上报", out, "用户要的就是第 2 处")
  has("[85] 第二条拿不到第二条上报 → 老实说分不出，不许重复认领", out, "分不出用户要哪一处")
}
{
  // 诊断：能从日志里看出"这一步的消息是从哪条通道读到的"
  clearPins()
  const m1 = human("帮我改一下\n" + refBare("散步"))
  const m2 = human("再看这个\n" + refMention("中间一段别的内容", null, null))
  reg.text({ agent: makeAgent([m1, m2], { surfaceCount: 1 }) })
  const trace = sandbox.ccvTraceRing.join("\n")
  has("[86] 日志写明了消息来自哪条通道", trace, "来自「队列」")
  has("[87] 日志写明了认出/注入了几条", trace, "条引用")
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
