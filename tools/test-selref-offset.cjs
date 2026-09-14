// ═══ 选区引用 · 位置计算 + 翻译规则 回归测试 ═══
//
// 测什么：lib/selref.js 里两处"看不见却必须准"的逻辑。
//
// ① 把编辑区摊平成纯文字、再算选区下标
//    · 块与块之间要补换行，否则行号全错 —— 而且错得很安静（数字看着挺像样）
//    · 行内元素（<b>/<span>）**不能**补换行，补了行号就虚高
//    · 前后文指纹要恰好卡在选区两侧，错一格 AI 就对不上原文
//
// ② 发送时的翻译规则（codec.serialize）
//    官方默认「翻译失败就拦住发送」，所以这里有一条硬要求：
//    **任何输入都不许抛错** —— 用户的消息发不出去比定位不精确严重得多。
//
// 这两样在真机上都不报错，只能靠测试盯住。
//
// 跑法：node tools/test-selref-offset.cjs

const fs = require("fs")
const path = require("path")
const vm = require("vm")

let pass = 0
let fail = 0
function eq(name, got, want) {
  if (got === want) { pass++; console.log("  ✓ " + name); return }
  fail++
  console.log("  ✗ " + name + "\n      期望: " + JSON.stringify(want) + "\n      实得: " + JSON.stringify(got))
}
function ok(name, cond) { eq(name, !!cond, true) }

// ─── 极简假 DOM ───────────────────────────────────────────────
// 只实现 selref 真正用到的那几样：nodeType / data / tagName /
// childNodes / textContent / querySelectorAll。不引 jsdom，保持零依赖。
function T(data) { this.nodeType = 3; this.data = data }
function E(tag, children) {
  this.nodeType = 1
  this.tagName = tag
  this.childNodes = children || []
}
E.prototype._all = function (out) {
  for (const c of this.childNodes) {
    if (c.nodeType === 1) { out.push(c); c._all(out) }
  }
  return out
}
Object.defineProperty(E.prototype, "textContent", {
  get() {
    return this.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join("")
  }
})
E.prototype.querySelectorAll = function (sel) {
  const tags = sel.split(",").map((s) => s.trim().toUpperCase())
  return this._all([]).filter((n) => tags.indexOf(n.tagName) >= 0)
}

// ─── 造一段像真编辑区的 DOM ───────────────────────────────────
// 结构：h1 / 普通段落 / 含行内加粗的段落 / 无序列表
//       └ 关键：块之间要断行，行内 <b> 不能断行
const LONG = "这是一段特意写得很长很长的选中文字用来验证胶囊标签会不会被正确截断"
const tH1 = new T("第一节 总览")
const tP1 = new T("写入方基于哪一版")
const tP2a = new T("前面")
const tP2b = new T("加粗")
const tP2c = new T("后面")
const tLi1 = new T("列表甲")
const tLi2 = new T("列表乙")
const tLong = new T(LONG)
const p2 = new E("DIV", [tP2a, new E("B", [tP2b]), tP2c])
const root = new E("DIV", [
  new E("H1", [tH1]),
  new E("DIV", [tP1]),
  p2,
  new E("UL", [new E("LI", [tLi1]), new E("LI", [tLi2])]),
  new E("DIV", [tLong])
])

// 期望的纯文字：换行只出现在块与块之间，末尾也有一个（块后断行）
const EXPECT_TEXT = [
  "第一节 总览",
  "写入方基于哪一版",
  "前面加粗后面",
  "列表甲",
  "列表乙",
  LONG,
  ""
].join("\n")

// ⚠️ 期望值一律**用程序算**，不手数汉字个数。
//    第一版这里是手写的，把「写入方基于哪一版」（8 字）数成了 9 字，
//    一下子错掉 6 条 —— 而失败指向的是代码，白排查一轮。
//    测试本身的算错比代码错更贵，所以能算就别数。
const L1 = "第一节 总览\n".length          // 第 1 行含换行
const L2 = "写入方基于哪一版\n".length      // 第 2 行
const L3 = "前面加粗后面\n".length          // 第 3 行
const L4 = "列表甲\n".length                // 第 4 行

// ─── 载入侧模块（沙箱里跑，不碰真 window / fetch / document）───
const src = fs.readFileSync(path.join(__dirname, "..", "lib", "selref.js"), "utf8")
const sandbox = { window: {}, console, setTimeout: () => 0, clearTimeout: () => {} }

// 预置一个假的 cordis 上下文，让 boot() 在加载时直接跑完并注册引用源。
// 这样我们能拿到真的 source 对象来测翻译规则，而不是照抄一份来测。
let captured = null
sandbox.window.__ccvCtx = {
  sessions: {},
  conversation: {},
  inputTriggers: {
    registerSource: function (s) { captured = s; return function () {} }
  }
}
sandbox.window.fetch = () => Promise.resolve({ ok: true })
vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: "lib/selref.js" })

const capture = sandbox.window.__ccvSelRefCapture
const info = sandbox.window.__ccvSelRefInfo
const flatOf = sandbox.window.__ccvSelRefFlat
if (typeof capture !== "function" || typeof info !== "function" || typeof flatOf !== "function") {
  console.log("✗ 侧模块没有挂出预期的那几个诊断口（__ccvSelRefCapture / Info / Flat）")
  process.exit(1)
}

// 用主模块的取数桥把假 DOM 喂进去（bridge 的接口是 doc/editor/range）
function withBridge(docPatch, editor, range) {
  sandbox.window.__ccvSelRefBridge = {
    doc: () => Object.assign({ id: "c1", title: "话布优化", mention: '@"/x/话布优化.md"', version: 7 }, docPatch || {}),
    editor: () => editor,
    range: () => range
  }
}
// 一个最小的 range 替身：只给 startContainer / startOffset / toString
function fakeRange(startContainer, startOffset, text) {
  return { startContainer, startOffset, toString: () => text }
}

async function main() {
  console.log("\n【0】还没记过选区时，菜单里必须是空的")
  // 第 2 步用的那条假候选「测试选区」不能留在这里 ——
  // 它会让人以为真数据接上了，实际点进去是个空壳。
  eq("初始候选为空", (await captured.candidates()).length, 0)

  console.log("\n【1】块边界 / 行内元素 / 行号")
  eq("整串文字（块之间断行、行内不断行）", flatOf(root).text, EXPECT_TEXT)

  withBridge(null, root, fakeRange(tP1, 0, "写入方基于哪一版"))
  let rec = capture()
  ok("记录成功", rec)
  eq("选中文字", rec.selected, "写入方基于哪一版")
  eq("选区起点下标 = 第 2 行开头", rec.offset, L1)
  eq("行号（第 2 行）", rec.line, 2)
  eq("最近小标题", rec.heading, "第一节 总览")
  eq("前文指纹（不足 24 字 → 取到全文开头）", rec.before, "第一节 总览\n")
  const restOfDoc = ["", "前面加粗后面", "列表甲", "列表乙", LONG, ""].join("\n")
  eq("后文指纹（24 字截断）", rec.after, restOfDoc.slice(0, 24))

  console.log("\n【2】行内加粗不虚增行号")
  // tP2b 是 <b> 里的文字节点：第 3 行开头 = L1+L2，再跳过「前面」2 字
  withBridge(null, root, fakeRange(tP2b, 0, "加粗"))
  rec = capture()
  eq("选区起点下标（<b> 内）", rec.offset, L1 + L2 + 2)
  eq("行号仍是第 3 行（没有被 <b> 顶到第 4 行）", rec.line, 3)
  eq("前文指纹", rec.before, "第一节 总览\n写入方基于哪一版\n前面")
  const tailAfterP2 = "后面\n列表甲\n列表乙\n" + LONG + "\n"
  eq("后文指纹", rec.after, tailAfterP2.slice(0, 24))

  console.log("\n【3】列表项之间要断行")
  const li2Start = L1 + L2 + L3 + L4
  withBridge(null, root, fakeRange(tLi2, 0, "列表乙"))
  rec = capture()
  eq("列表乙起点下标", rec.offset, li2Start)
  eq("行号（第 5 行）", rec.line, 5)
  eq("最近小标题仍取前面的 H1（后面的正文没有标题）", rec.heading, "第一节 总览")

  console.log("\n【4】同一段里点选（起点在行内文字节点偏移 1）")
  withBridge(null, root, fakeRange(tP2a, 1, "面加粗后"))
  rec = capture()
  eq("偏移 1 → 下标 +1", rec.offset, L1 + L2 + 1)
  eq("行号第 3 行", rec.line, 3)

  console.log("\n【5】异常与兜底：绝不抛错")
  const before = info().length
  withBridge(null, root, null)                       // 取不到选区
  eq("取不到选区时不记录", capture(), null)
  eq("记录条数没变", info().length, before)
  sandbox.window.__ccvSelRefBridge = null            // 桥还没挂
  eq("没挂桥时不记录（且不抛错）", capture(), null)
  withBridge(null, root, fakeRange(tP1, 0, "   "))   // 空白选区
  eq("空白选区不记录", capture(), null)
  withBridge({ id: null }, root, fakeRange(tP1, 0, "x"))   // 没打开文档
  eq("没打开话布时不记录", capture(), null)

  console.log("\n【6】记录上限（防失控）")
  withBridge(null, root, fakeRange(tP1, 0, "写入方基于哪一版"))
  for (let i = 0; i < 40; i++) capture()
  ok("条数被压在上限内（20）", info().length <= 20)
  ok("最新一条排在最前", info()[0].indexOf("#") === 0)

  // ═══ 下面是翻译规则（codec）—— 真机日志里看不到的第二处风险 ═══
  console.log("\n【7】引用源登记结果")
  ok("引用源已注册（boot 时走通）", captured)
  eq("触发器", captured.trigger, "@")
  eq("名号（同时是菜单分组标题与翻译路由 key）", captured.name, "话布选区")
  eq("排序在官方之后", captured.order, 50)
  eq("显示分组标题", captured.showGroupTitle, true)

  console.log("\n【8】翻译规则 · 正常路径")
  withBridge(null, root, fakeRange(tP1, 0, "写入方基于哪一版"))
  rec = capture()
  const text = await captured.codec.serialize(String(rec.code))
  ok("含来源（文档名 + 小标题）", text.indexOf("【话布选区】引用来源：话布优化 · 第一节 总览") === 0)
  ok("含文件 @ 路径（带引号，路径含空格也不会被截断）", text.indexOf('文件：@"/x/话布优化.md"') >= 0)
  ok("含选中原文", text.indexOf("选中文字：「写入方基于哪一版」") >= 0)
  ok("含行号", text.indexOf("约第 2 行") >= 0)
  ok("含上下文指纹（供 AI 核对是不是这一处）", text.indexOf("上下文核对：") >= 0)

  console.log("\n【9】翻译规则 · 兜底路径（不许抛错）")
  const orphan = await captured.codec.serialize("99999")
  ok("记录找不到 → 明说未取到，并禁止猜", orphan.indexOf("未取到精确位置") >= 0 && orphan.indexOf("不要凭猜测定位") >= 0)

  const weird = [null, undefined, "", "abc", "{}", "1e999", "-1"].map(String)
  let allResolved = true
  for (const w of weird) {
    try {
      const r = await captured.codec.serialize(w)
      if (typeof r !== "string" || !r.length) allResolved = false
    } catch (e) { allResolved = false }
  }
  ok("畸形编号一律返回文字、绝不抛错（否则用户消息发不出去）", allResolved)

  const cbt = captured.codec.clipboardText(String(rec.code))
  ok("复制文本可读（刷新后退化成它，仍能看懂）", cbt.indexOf("话布优化") >= 0 && cbt.indexOf(">") >= 0)

  console.log("\n【10】胶囊出厂设置")
  const pick = captured.onPick({ candidate: { value: String(rec.code) } })
  ok("返回 insert", pick && pick.insert)
  eq("归属本源（发送时靠它找回翻译规则）", pick.insert.source, "话布选区")
  eq("图标用官方允许的 file", pick.insert.appearance, "file")
  eq("引用值 = 记录编号", pick.insert.ref, String(rec.code))
  ok("胶囊文字 = 选中文字前 12 字", pick.insert.label === "写入方基于哪一版")
  withBridge(null, root, fakeRange(tLong, 0, LONG))
  const longRec = capture()
  const longPick = captured.onPick({ candidate: { value: String(longRec.code) } })
  eq("超长选中文字 → 胶囊标签截断到 12 字 + 省略号", longPick.insert.label.length, 13)
  ok("胶囊标签以省略号结尾", longPick.insert.label.slice(-1) === "…")
  const longCand = (await captured.candidates()).filter((c) => c.value === String(longRec.code))[0]
  ok("菜单里的名字可以长一点（20 字），但仍带省略号", longCand.name.length === 21 && longCand.name.slice(-1) === "…")
  ok("菜单项带上文档名与行号，便于区分同名的多段", longCand.description.indexOf("话布优化") === 0)

  console.log("\n【11】onPick 拿到不存在的编号也不许抛错")
  let pickOk = true
  try {
    const p = captured.onPick({ candidate: { value: "" } })
    pickOk = !!(p && p.insert && p.insert.label)
  } catch (e) { pickOk = false }
  ok("畸形候选 → 仍有可插入的胶囊，不抛错", pickOk)

  console.log("\n────────────────────────────────")
  console.log("通过 " + pass + " 项，失败 " + fail + " 项")
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.log("测试自身异常: " + (e && e.stack))
  process.exit(1)
})
