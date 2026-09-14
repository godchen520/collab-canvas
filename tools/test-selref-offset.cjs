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
// 定时器用真的：自动两步的"等菜单就绪再点"就是靠定时器轮询的，
// 用假定时器等于把要测的那段换掉了。
const sandbox = { window: {}, console, setTimeout, clearTimeout, setInterval, clearInterval }

// 预置一个假的 cordis 上下文，让 boot() 在加载时直接跑完并注册引用源。
// 这样我们能拿到真的 source 对象来测翻译规则，而不是照抄一份来测。
// sessions.scope / inputTriggers.sessionOf 两个口子供"自动两步"测试替换，
// 默认不给（= 拿不到会话手柄），需要时用 setController() 装上。
let captured = null
const scopeResult = { current: undefined }   // sessions.scope() 的返回值
const controllerRef = { current: null }      // inputTriggers.sessionOf() 的返回值
sandbox.window.__ccvSessionId = "sess-test"
sandbox.window.__ccvInputState = { draft: "", draftRev: 1, occurrences: [] }
sandbox.window.__ccvCtx = {
  sessions: {
    scope: function () { return scopeResult.current }
  },
  conversation: {},
  inputTriggers: {
    registerSource: function (s) { captured = s; return function () {} },
    sessionOf: function () { return controllerRef.current }
  }
}
sandbox.window.fetch = () => Promise.resolve({ ok: true })
vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: "lib/selref.js" })

const capture = sandbox.window.__ccvSelRefCapture
const auto = sandbox.window.__ccvSelRefAuto
const info = sandbox.window.__ccvSelRefInfo
const flatOf = sandbox.window.__ccvSelRefFlat
if (typeof capture !== "function" || typeof info !== "function" || typeof flatOf !== "function") {
  console.log("✗ 侧模块没有挂出预期的那几个诊断口（__ccvSelRefCapture / Info / Flat）")
  process.exit(1)
}
if (typeof auto !== "function") {
  console.log("✗ 侧模块没有挂出 __ccvSelRefAuto")
  process.exit(1)
}

// ─── 假控制器：把官方那套"先 pending 再 ready"的行为做出来 ───────
// 关键细节：官方 pick 在组没 ready 之前会**静默什么都不做**，
// 所以这里必须能造出"还没就绪"和"永远不就绪"两种状态。
function makeController(opts) {
  opts = opts || {}
  const calls = { toggle: null, picks: [], dismiss: 0 }
  let state = { open: false, groups: [] }
  const ctl = {
    calls,
    menu: { getSnapshot: () => state },
    toggleSource(name, hit) {
      calls.toggle = { name, hit }
      state = { open: true, groups: [{ source: name, status: "pending", items: [] }] }
      if (opts.neverReady) return
      setTimeout(() => {
        if (!state.open) return
        state = {
          open: true,
          groups: [{
            source: name,
            status: "ready",
            items: opts.emptyItems ? [] : [{ name: "某段话", value: "1" }]
          }]
        }
      }, opts.readyAfter || 0)
    },
    pick(name, index) {
      calls.picks.push({ name, index })
      if (opts.pickNoop) return
      // 模拟插入成功：草稿里多出一个胶囊
      const cur = sandbox.window.__ccvInputState
      sandbox.window.__ccvInputState = {
        draft: cur.draft,
        draftRev: (cur.draftRev || 0) + 1,
        occurrences: (cur.occurrences || []).concat([{ ref: "1" }])
      }
    },
    dismiss() { calls.dismiss++; state = { open: false, groups: [] } }
  }
  return ctl
}
function setController(ctl) {
  controllerRef.current = ctl
  scopeResult.current = { fake: "session-scope" }   // 非 undefined 就算拿到了作用域
}
function noSessionScope() {
  controllerRef.current = null
  scopeResult.current = undefined
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

  console.log("\n【8】翻译规则 · 正常路径（要求短、且 @ 打头）")
  withBridge(null, root, fakeRange(tP1, 0, "写入方基于哪一版"))
  rec = capture()
  const text = await captured.codec.serialize(String(rec.code))
  const textLines = text.split("\n")
  // @ 必须打头 —— 官方要靠它把这一行折成一张文件卡片（主人实测的线索）
  eq("首行 = @路径 +「> 小标题 · 行号」", textLines[0], '@"/x/话布优化.md" > 第一节 总览 · 第 2 行')
  eq("第二行 = 原文", textLines[1], "「写入方基于哪一版」")
  eq("总共只有 2 行", textLines.length, 2)
  ok("首字符就是 @", text.charAt(0) === "@")
  ok("不塞前后文指纹（实测它会把表格摊成一串噪音）", text.indexOf("上下文核对") < 0)
  ok("不塞字符偏移 / 字数这类对模型没用的东西", text.indexOf("字起") < 0 && text.indexOf("文中第") < 0)

  console.log("\n【8b】小标题与文档名同名时，只写一次")
  // 实测出现过「话布优化 · 话布优化」—— 文档的 h1 就叫这个名字。
  withBridge({ title: "第一节 总览" }, root, fakeRange(tP1, 0, "写入方基于哪一版"))
  const recSame = capture()
  const textSame = await captured.codec.serialize(String(recSame.code))
  eq("同名不重复", textSame.split("\n")[0], '@"/x/话布优化.md" > 第 2 行')

  console.log("\n【8c】拿不到真实路径时，退回纯文字标签（不丢信息）")
  withBridge({ mention: "" }, root, fakeRange(tP1, 0, "写入方基于哪一版"))
  const recNoPath = capture()
  const textNoPath = await captured.codec.serialize(String(recNoPath.code))
  eq("没有路径 → 退回「【话布选区】文档名 · 小标题 · 行号」",
    textNoPath.split("\n")[0], "【话布选区】话布优化 · 第一节 总览 · 第 2 行")

  console.log("\n【9】翻译规则 · 兜底路径（不许抛错）")
  const orphan = await captured.codec.serialize("99999")
  ok("记录找不到 → 明说没了，并禁止猜", orphan.indexOf("记录已经没了") >= 0 && orphan.indexOf("不要凭猜测定位") >= 0)
  eq("兜底也是一行，不啰嗦", orphan.split("\n").length, 1)

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

  // ═══ 自动两步：点「问AI」直接出胶囊 ═══════════════════════════
  // 这段最容易"看着点了、其实没插进去"（官方 pick 在组没就绪前静默返回），
  // 所以每条失败路径都要单独验一遍。
  console.log("\n【12】自动两步 · 正常路径")
  withBridge(null, root, fakeRange(tP1, 0, "写入方基于哪一版"))
  capture()
  sandbox.window.__ccvInputState = { draft: "", draftRev: 7, occurrences: [] }
  let ctl = makeController({ readyAfter: 10 })
  setController(ctl)
  let result = await auto()
  eq("返回成功", result, true)
  eq("打开的是我们这一栏", ctl.calls.toggle.name, "话布选区")
  eq("选中第 1 条", ctl.calls.picks.length, 1)
  eq("pick 的索引是 0", ctl.calls.picks[0].index, 0)
  eq("菜单初始就是开着的（toggleSource 负责开）", !!ctl.calls.toggle.hit, true)

  console.log("\n【13】自动两步 · 合成出来的「位置」对不对")
  const h = ctl.calls.toggle.hit
  eq("触发器", h.trigger, "@")
  eq("查询词为空（不是用户敲的）", h.query, "")
  eq("不是带引号的 token", h.quoted, false)
  eq("草稿为空 → leading", h.position, "leading")
  ok("零宽选区（起止相同）", h.span.start === h.span.end)
  eq("选区落在草稿末尾", h.span.start, 0)
  eq("带上当前草稿版本号（官方靠它做版本比对）", h.span.draftRev, 7)

  sandbox.window.__ccvInputState = { draft: "前面已经写了字", draftRev: 9, occurrences: [] }
  ctl = makeController({ readyAfter: 10 })
  setController(ctl)
  await auto()
  eq("草稿非空 → inline", ctl.calls.toggle.hit.position, "inline")
  eq("口子开在末尾（14 个字之后）", ctl.calls.toggle.hit.span.start, 7)

  console.log("\n【14】自动两步 · 失败一律返回 false，且绝不抛错")
  // ① 菜单永远是 pending（官方取候选迟迟不回来）
  sandbox.window.__ccvInputState = { draft: "", draftRev: 11, occurrences: [] }
  ctl = makeController({ neverReady: true })
  setController(ctl)
  eq("等不到就绪 → false", await auto(), false)
  ok("放弃时顺手把菜单关掉（不留个空菜单挂在那）", ctl.calls.dismiss > 0)

  // ② 就绪了，但点下去草稿里没多出胶囊（版本对不上之类）
  ctl = makeController({ readyAfter: 5, pickNoop: true })
  setController(ctl)
  eq("点了但没插进去 → false", await auto(), false)

  // ③ 就绪了但候选是空的
  ctl = makeController({ readyAfter: 5, emptyItems: true })
  setController(ctl)
  eq("候选为空 → false", await auto(), false)

  // ④ 拿不到会话手柄（sessionId / 服务没到位）
  noSessionScope()
  eq("拿不到会话手柄 → false", await auto(), false)

  // ⑤ 读不到草稿版本号（输入框状态还没挂上）
  setController(makeController({ readyAfter: 5 }))
  const savedState = sandbox.window.__ccvInputState
  sandbox.window.__ccvInputState = { draft: "" }
  eq("读不到版本号 → false", await auto(), false)
  sandbox.window.__ccvInputState = savedState

  console.log("\n【15】自动两步 · 异常也不许把「问AI」拖垮")
  const boom = {
    menu: { getSnapshot: () => { throw new Error("故意炸一下") } },
    toggleSource: () => {},
    pick: () => {},
    dismiss: () => {}
  }
  setController(boom)
  let threw = false
  let val = null
  try { val = await auto() } catch (e) { threw = true }
  eq("控制器抛错时外侧不抛", threw, false)
  eq("并且老老实实返回 false（让主模块退回老做法）", val, false)

  console.log("\n────────────────────────────────")
  console.log("通过 " + pass + " 项，失败 " + fail + " 项")
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.log("测试自身异常: " + (e && e.stack))
  process.exit(1)
})
