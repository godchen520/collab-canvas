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
// eq 是严格 === 比较，数组永远不相等 —— 要比较一串值时用这个
function eqj(name, got, want) { eq(name, JSON.stringify(got), JSON.stringify(want)) }

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
// 网络层：selref.js 里用的是**裸 fetch**（浏览器里它是全局的）。沙箱里必须显式给一个，
// 否则 log 与「序数上报」都会抛 —— 而它们各自带 try/catch 把异常吞掉，
// 表现成"什么都没发生"。这类静默失效正是测试最容易漏掉的。
sandbox.__net = []
function fakeFetch(url, opt) {
  sandbox.__net.push({ url: String(url), opt: opt || null })
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
}
sandbox.fetch = fakeFetch
sandbox.window.fetch = fakeFetch
vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: "lib/selref.js" })

const capture = sandbox.window.__ccvSelRefCapture
const auto = sandbox.window.__ccvSelRefAuto
const textInsert = sandbox.window.__ccvSelRefText
const info = sandbox.window.__ccvSelRefInfo
const flatOf = sandbox.window.__ccvSelRefFlat
const findOf = sandbox.window.__ccvSelRefFind
const squashOf = sandbox.window.__ccvSelRefSquash
const nodeAtOf = sandbox.window.__ccvSelRefNodeAt
const detectLen = sandbox.window.__ccvSelRefDetectLen
if (typeof findOf !== "function" || typeof squashOf !== "function" || typeof nodeAtOf !== "function") {
  console.log("✗ 侧模块没有挂出「AI 改完跳过去」的那几个诊断口（Find / Squash / NodeAt）")
  process.exit(1)
}
if (typeof detectLen !== "function") {
  console.log("✗ 侧模块没有挂出 __ccvSelRefDetectLen（两套坐标的换算，第二条引用能不能插进去全靠它）")
  process.exit(1)
}
if (typeof capture !== "function" || typeof info !== "function" || typeof flatOf !== "function") {
  console.log("✗ 侧模块没有挂出预期的那几个诊断口（__ccvSelRefCapture / Info / Flat）")
  process.exit(1)
}
if (typeof auto !== "function") {
  console.log("✗ 侧模块没有挂出 __ccvSelRefAuto")
  process.exit(1)
}
if (typeof textInsert !== "function") {
  console.log("✗ 侧模块没有挂出 __ccvSelRefText（兜底插纯文字用，主模块靠它避免整体重写）")
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

// ─── 假会话作用域：记录官方「输入框改动」事件的派发 ───────────────
// 官方把"插入胶囊 / 插入纯文字"做成会话级事件（带草稿版本校验），
// 事件处理体就是 shell.insertReference / insertText。
// 这里把它做出来，好验证"往哪儿插、插什么、失败时有没有乱动草稿"。
function makeScope(opts) {
  opts = opts || {}
  const calls = []
  const actx = {
    calls,
    bail(self, ev, req) {
      calls.push({ ev, req, self })
      if (opts.refuse) return false          // 官方拒绝（版本对不上 / 当前不许改）
      if (opts.silent) return true           // 说成功但什么事都没发生
      const cur = sandbox.window.__ccvInputState
      if (ev === "slash/input-insert-reference") {
        // 忠实还原官方 insertReference：把 span 换成一颗胶囊，后面再补一个空格。
        // ⚠️ 胶囊在 occurrences 里必须带 `length` —— 官方给的是 clipboardLength
        //   （胶囊在"剪贴板投影"里占几个字）。**少了这个字段就测不出坐标换算的错**，
        //   这正是 2026-09-15 那个"第二条永远插不进"漏网的原因。
        sandbox.window.__ccvInputState = {
          draft: cur.draft + "@话布优化 > 新一段 ",
          draftRev: (cur.draftRev || 0) + 1,
          occurrences: (cur.occurrences || []).concat([
            { ref: req.reference.ref, length: "@话布优化 > 新一段".length }
          ])
        }
        return true
      }
      if (ev === "slash/input-insert-text") {
        sandbox.window.__ccvInputState = {
          draft: cur.draft + req.text,
          draftRev: (cur.draftRev || 0) + 1,
          occurrences: cur.occurrences || []
        }
        return true
      }
      return false
    }
  }
  return actx
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
  // 前后文指纹**有意不再记录**：定位已交给 host 侧的 canvas_locate 按需回答，
  // 记录里留着它等于存了一份没人用的死数据（而且它会被表格摊成一串噪音）。
  ok("不再记录前后文指纹（定位改由 canvas_locate 回答）",
    rec.before === undefined && rec.after === undefined)

  console.log("\n【2】行内加粗不虚增行号")
  // tP2b 是 <b> 里的文字节点：第 3 行开头 = L1+L2，再跳过「前面」2 字
  withBridge(null, root, fakeRange(tP2b, 0, "加粗"))
  rec = capture()
  eq("选区起点下标（<b> 内）", rec.offset, L1 + L2 + 2)
  eq("行号仍是第 3 行（没有被 <b> 顶到第 4 行）", rec.line, 3)

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

  console.log("\n【8】翻译规则 · 正常路径（只有两行：@路径 + 原文）")
  withBridge(null, root, fakeRange(tP1, 0, "写入方基于哪一版"))
  rec = capture()
  const text = await captured.codec.serialize(String(rec.code))
  const textLines = text.split("\n")
  // @ 必须打头 —— 官方要靠它把这一行折成一张文件卡片（主人实测的线索）
  eq("首行 = @路径（不带标签）", textLines[0], '@"/x/话布优化.md"')
  eq("第二行 = 原文", textLines[1], "「写入方基于哪一版」")
  eq("总共只有 2 行", textLines.length, 2)
  ok("首字符就是 @", text.charAt(0) === "@")
  ok("不塞前后文指纹（实测它会把表格摊成一串噪音）", text.indexOf("上下文核对") < 0)
  ok("不塞字符偏移 / 字数这类对模型没用的东西", text.indexOf("字起") < 0 && text.indexOf("文中第") < 0)

  console.log("\n【8b】🔴 主人要求：卡片上那一串坐标一个都不许有（2026-09-15）")
  // 原话：「这还是有很长一段话啊，可以不可以【二、到底发生了什么 · 第 21 行 ·
  //        多处（第 2 处）】这些都不要，都不显示」
  // 所以这四样必须彻底消失：小标题、行号、「多处」、「第 N 处」。
  ok("首行没有「> 说明」那一段", textLines[0].indexOf(">") < 0)
  ok("没有小标题", text.indexOf("第一节 总览") < 0)
  ok("没有行号", text.indexOf("行") < 0)
  ok("没有「多处」", text.indexOf("多处") < 0)
  ok("没有「第 N 处」", !/第\s*\d+\s*处/.test(text))
  ok("整条引用很短（只剩路径 + 原文）", text.length < 60)

  console.log("\n【8c】拿不到真实路径时，退回纯文字抬头（同样不带标签）")
  withBridge({ mention: "" }, root, fakeRange(tP1, 0, "写入方基于哪一版"))
  const recNoPath = capture()
  const textNoPath = await captured.codec.serialize(String(recNoPath.code))
  eq("没有路径 → 退回「【话布选区】文档名」",
    textNoPath.split("\n")[0], "【话布选区】话布优化")
  ok("同样不塞小标题 / 行号",
    textNoPath.indexOf("第一节 总览") < 0 && textNoPath.indexOf("第 2 行") < 0)

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

  // ═══ 定位：引用要「优雅」（两行），但两行里必须带够信息 ═══════════
  // 主人举的例子：想把 `1111111111111` 改成 `1111121111111`，可一行里
  // 可能有好几段一模一样的 —— 只报行号 + 原文，AI 只能猜。
  // 做法：标签里标出「多处（第 N 处）」，正文不塞坐标；
  // 「每一处长什么样」交给 host 侧的 canvas_locate 工具。

  console.log("\n【16】原文重复 → 引用里标「多处（第 N 处）」，正文仍只有两行")
  const DUP = "1111111111111"
  const d1 = new T("甲乙" + DUP + "丙丁")
  const d2 = new T("戊己" + DUP + "庚辛")
  const dupEditor = new E("DIV", [new E("DIV", [d1]), new E("DIV", [d2])])

  withBridge(null, dupEditor, fakeRange(d1, 2, DUP))
  rec = capture()
  eq("选中文字", rec.selected, DUP)
  eq("原文在全文出现几次", rec.dupCount, 2)
  eq("你选的是第 1 处", rec.ordinal, 1)
  eq("行号仍是第 1 行", rec.line, 1)

  const dTextA = await captured.codec.serialize(String(rec.code))
  const dLinesA = dTextA.split("\n")
  eq("第一行 = @路径（坐标一个都不写）", dLinesA[0], '@"/x/话布优化.md"')
  eq("第二行 = 原文", dLinesA[1], "「" + DUP + "」")
  eq("**永远只有两行** —— 定位完全不进正文", dLinesA.length, 2)
  ok("正文里不再出现定位坐标", dTextA.indexOf("定位：") < 0)
  ok("正文里也不再出现方括号", dTextA.indexOf("【") < 0)
  ok("更没有「多处」（主人明确不要这串字）", dTextA.indexOf("多处") < 0)
  ok("也没有行号", dTextA.indexOf("行") < 0)
  const ordA = rec.ordinal    // 【17】要拿它跟第二处对比

  console.log("\n【17】选第二处 → 序数跟着变（正文不体现，改走上报通道）")
  withBridge(null, dupEditor, fakeRange(d2, 2, DUP))
  rec = capture()
  eq("同一段原文的第二次出现", rec.ordinal, 2)
  eq("行号变成第 2 行", rec.line, 2)
  eq("总次数不变", rec.dupCount, 2)
  const dTextB = await captured.codec.serialize(String(rec.code))
  // 🔴 2026-09-15 起，两次引用的**正文完全一样** —— 坐标不再写进正文了。
  //    区分"是哪一处"的责任转交给 capture 时上报的那份记录。
  //    所以这里要断言的是**记录里的序数不同**，而不是正文不同。
  eq("两次正文本来就一样了（坐标不进正文）", dTextB, dTextA)
  eqj("区别落在上报的序数上", [ordA, rec.ordinal], [1, 2])
  eq("第二处也是干净的文件引用", dTextB.split("\n")[0], '@"/x/话布优化.md"')

  console.log("\n【18】原文唯一 → 正文里同样一个坐标都不带")
  withBridge(null, dupEditor, fakeRange(d1, 0, "甲乙"))
  rec = capture()
  eq("原文唯一", rec.dupCount, 1)
  eq("唯一时不算序数（没有意义）", rec.ordinal, 0)
  const uText = await captured.codec.serialize(String(rec.code))
  eq("仍是两行", uText.split("\n").length, 2)
  ok("正文里没有「多处」", uText.indexOf("多处") < 0)
  eq("第一行就是干净的文件引用", uText.split("\n")[0], '@"/x/话布优化.md"')

  console.log("\n【19】重复次数与序数都要数得准（允许重叠）")
  // 独立实现算一遍做交叉验证 —— 这两个数决定引用标签怎么写
  function occ(t, n) { let c = 0, i = 0; while ((i = t.indexOf(n, i)) >= 0) { c++; i++ } return c }
  const OV = "aaaa"
  const ovNode = new T(OV)
  const ovEditor = new E("DIV", [new E("DIV", [ovNode])])
  withBridge(null, ovEditor, fakeRange(ovNode, 1, "aa"))
  rec = capture()
  eq("`aaaa` 里的 `aa` 有 3 处（重叠也要算）", rec.dupCount, occ(OV, "aa"))
  eq("确实是 3", rec.dupCount, 3)
  eq("从下标 1 起选 → 是第 2 处", rec.ordinal, 2)

  console.log("\n【20】取不到偏移时不许谎报「多处」")
  withBridge(null, root, fakeRange(new T("野节点"), 0, "写入方基于哪一版"))
  rec = capture()
  eq("偏移取不到 → 行号为 -1", rec.line, -1)
  eq("偏移取不到 → 重复次数记 0，不编一个出来", rec.dupCount, 0)
  eq("序数同样记 0", rec.ordinal, 0)
  const gText = await captured.codec.serialize(String(rec.code))
  ok("因此也不会误标「多处」", gText.indexOf("多处") < 0)

  console.log("\n【21】主人举的反例：一句话里同一个名字出现两次")
  // 主人 09-14 追问：「我觉得你这个方法不行，如果一句话是【小明在笑，小明在闹】
  // 我选第一个小明，又要怎么办呢」
  // 客户端的责任是**如实记下歧义和序数，并把它报给服务端**；
  // 「每一处长什么样」由 host 侧回答（见 tools/test-host-locate.cjs 与 test-host-selctx.cjs）。
  // 两个数合起来就把位置说清了，而引用正文保持干净。
  const SENT = "小明在笑，小明在闹"
  const sNode = new T(SENT)
  const sentEditor = new E("DIV", [new E("DIV", [sNode])])

  withBridge(null, sentEditor, fakeRange(sNode, 0, "小明"))
  rec = capture()
  eq("两个小明 → 记下来了", rec.dupCount, 2)
  eq("选第一个 → 第 1 处", rec.ordinal, 1)
  const t1 = await captured.codec.serialize(String(rec.code))

  withBridge(null, sentEditor, fakeRange(sNode, 5, "小明"))
  const rec2 = capture()
  eq("选第二个 → 第 2 处", rec2.ordinal, 2)
  const t2 = await captured.codec.serialize(String(rec2.code))

  ok("正文里两个都不带坐标（主人不要那些字）", t1.indexOf("多处") < 0 && t2.indexOf("多处") < 0)
  eq("两次正文一样 —— 分辨靠的是上报的序数", t1, t2)
  eq("第一个小明的引用", t1.split("\n")[0], '@"/x/话布优化.md"')
  ok("而两次上报的序数确实不同（服务端据此就能分辨）", rec.ordinal !== rec2.ordinal)

  console.log("\n【21b】🔴 序数上报：正文里不写坐标之后，「第几处」只能靠它")
  // 这条通道是 2026-09-15 加的：主人要求对话卡片只留文件名 → 标签整串去掉
  // → 服务端再也读不到坐标。而"第几处"只有划选那一刻在浏览器里才算得出，
  // 所以必须单独报一份。**它和 host 侧的注入是一对，只改一边这功能就是死的。**
  {
    sandbox.__net.length = 0
    withBridge(null, sentEditor, fakeRange(sNode, 5, "小明"))
    const r3 = capture()
    const hit = sandbox.__net.filter((x) => x.url === "/api/canvas/selref/pin")
    eq("capture 时确实发出了上报", hit.length, 1)
    const body = hit.length ? JSON.parse(hit[0].opt.body) : {}
    eq("用 POST", hit.length ? hit[0].opt.method : null, "POST")
    eq("报的是原文", body.text, "小明")
    eq("报上了序数（选的是第二个 → 2）", body.ordinal, 2)
    eq("也报了总次数（服务端据此判断是否有多处）", body.dupCount, 2)
    eq("报的是裸路径（不带 @ 和引号）", body.path, "/x/话布优化.md")
    eq("行号也一并带上", body.line, 1)
    ok("上报失败也不影响 capture（它只是补充通道）", !!r3)
  }
  {
    // 原文唯一时也要报 —— 服务端靠"没有序数"来区分"只有一处"
    sandbox.__net.length = 0
    withBridge(null, root, fakeRange(tP1, 0, "写入方基于哪一版"))
    capture()
    const hit = sandbox.__net.filter((x) => x.url === "/api/canvas/selref/pin")
    const body = hit.length ? JSON.parse(hit[0].opt.body) : {}
    eq("唯一一处 → 序数报 0（不编数字）", body.ordinal, 0)
    eq("总次数报 1", body.dupCount, 1)
  }

  console.log("\n【22】归一化：两边（源码 vs 渲染后）靠它才能对上")
  // 服务端给的是 **Markdown 源码**里的文字，客户端手里是**渲染之后**的文字。
  // 记号（`**` `#` 之类）与空白在两边的形态不同 —— 不归一化就永远找不到。
  eq("去掉了加粗记号", squashOf("这一段**加粗**了"), "这一段加粗了")
  eq("去掉了标题记号", squashOf("# 话布优化"), "话布优化")
  eq("去掉了空白", squashOf("甲 乙\n丙"), "甲乙丙")
  eq("去掉了行内码记号", squashOf("看 `这段` 代码"), "看这段代码")
  eq("去掉了引用记号", squashOf("> 引用"), "引用")
  eq("两边归一化之后一样（这就是能对上的原因）",
    squashOf("这一段**加粗**了"), squashOf("这一段加粗了"))

  console.log("\n【23】改动后的新文字找得到 → 跳转点就是它的起点")
  // 造一段"渲染后"的编辑区：标题 + 段落（源码里**加粗**了，渲染后没有记号）
  const rH1 = new T("话布优化")
  const rP = new T("这一段加粗了，改动在这里：新文字。")
  const rRoot = new E("DIV", [new E("H1", [rH1]), new E("DIV", [rP])])
  const rFlat = flatOf(rRoot).text
  {
    // 这一条记录的形状**完全按服务端产出的来**：源码里带 ** 记号
    const rec = { added: "新文字", head: "这一段**加粗**了，改动在这里：", tail: "。", removedChars: 3, addedChars: 3 }
    const hit = findOf(rec, rRoot)
    ok("找得到", !!hit)
    // 独立算一遍期望值：渲染文字里「新文字」的真实位置
    eq("找到的位置 = 新文字在渲染文字里的真实位置", hit.pos, rFlat.indexOf("新文字"))
    // 最强断言：位置自带校验 —— 从它开始切出来就该是那段新文字
    eq("从该位置切出来正好是新文字", rFlat.slice(hit.pos, hit.pos + 3), "新文字")
    eq("全文唯一 → 标记为可信", hit.unique, true)
  }

  console.log("\n【24】新文字为空（纯删除）→ 退回用「改动点之前的文字」")
  {
    const rec = { added: "", head: "改动在这里：", tail: "新文字。", removedChars: 5, addedChars: 0 }
    const hit = findOf(rec, rRoot)
    ok("找得到", !!hit)
    ok("位置落在前锚点之后（也就是被删掉的地方）", rFlat.slice(0, hit.pos).endsWith("改动在这里："))
    eq("前锚点用完后紧接着就是它", rFlat.slice(hit.pos, hit.pos + 3), "新文字")
    eq("唯一", hit.unique, true)
  }

  console.log("\n【25】前锚点也对不上 → 再退一步，用「改动点之后的文字」")
  {
    const rec = { added: "", head: "这段文字服务端有、渲染后没有", tail: "改动在这里", removedChars: 5, addedChars: 0 }
    const hit = findOf(rec, rRoot)
    ok("找得到", !!hit)
    eq("位置 = 后锚点的起点", hit.pos, rFlat.indexOf("改动在这里"))
  }

  console.log("\n【26】🔴 三条线索全对不上 → 返回 null，**绝不猜着跳**")
  // 这是这个功能最危险的失败方式：随便挑个位置跳过去，
  // 主人看到的是一段没变的文字，会以为 AI 没改对。
  {
    const rec = { added: "完全不存在的文字", head: "也不存在", tail: "还是不存文字", removedChars: 1, addedChars: 1 }
    eq("返回 null（不是 0，也不是随便挑一处）", findOf(rec, rRoot), null)
  }

  console.log("\n【27】改动落在文档最开头（前锚点为空）→ 也能找到")
  {
    const rec = { added: "话布优化", head: "", tail: "这一段加粗了", removedChars: 0, addedChars: 4 }
    const hit = findOf(rec, rRoot)
    eq("找到开头", hit.pos, rFlat.indexOf("话布优化"))
  }

  console.log("\n【27b】🔴 线索在全文重复时，取**唯一**的那条，而不是最靠前的那条")
  // 「找到」不等于「找对」：拿一段在文里出现两次的文字去 indexOf，
  // 只会拿到第一次出现的位置 —— 跳到那儿就是错的。所以要先判"唯不唯一"。
  const dA = new T("重复词")
  const dB = new T("中间文字")
  const dC = new T("重复词")
  const dD = new T("独一的尾巴")
  const dRoot = new E("DIV", [
    new E("DIV", [dA]), new E("DIV", [dB]), new E("DIV", [dC]), new E("DIV", [dD])
  ])
  const dFlat = flatOf(dRoot).text
  {
    // added 是重复的（出现两次），head 是唯一的 → 必须听 head 的
    const rec = { added: "重复词", head: "中间文字", tail: "", removedChars: 1, addedChars: 3 }
    const hit = findOf(rec, dRoot)
    ok("找得到", !!hit)
    eq("取的是唯一那条线索定出的位置（不是最靠前的那个「重复词」）",
      hit.pos, dFlat.indexOf("重复词", 5))
    ok("而且不是文档开头那个", hit.pos !== dFlat.indexOf("重复词"))
    eq("全文唯一 → 标记为可信", hit.unique, true)
  }
  {
    // 三条线索全都重复 → 只能退回最靠前的那条，但**必须如实说不准**
    const rec = { added: "重复词", head: "重复词", tail: "", removedChars: 1, addedChars: 3 }
    const hit = findOf(rec, dRoot)
    ok("仍然给出一个位置（不唯一也比不给强，但要说实话）", !!hit)
    eq("退回最靠前的那条", hit.pos, dFlat.indexOf("重复词"))
    eq("并如实标记为不可信（提示里会写「请核对」）", hit.unique, false)
  }

  console.log("\n【28】摊平下标 → DOM 位置（offsetOf 的反向操作）")
  {
    const flat = flatOf(rRoot)
    // 期望：文档开头的下标 0 落在标题那个文字节点里，偏移 0
    const a = nodeAtOf(flat, 0)
    eq("下标 0 → 标题节点", a.node, rH1)
    eq("节点内偏移 0", a.offset, 0)
    // 段落里的某个位置
    const pOff = flat.text.indexOf("改动")
    const b = nodeAtOf(flat, pOff)
    eq("段落里的下标 → 段落节点", b.node, rP)
    eq("节点内偏移对得上", rP.data.charAt(b.offset), "改")
    // 正向反向来回一趟必须回到原处（这才是真正要保证的不变量）
    const back = flat.startOf.get(b.node) + b.offset
    eq("换算回下标 = 原下标", back, pOff)
  }

  // ═══ 第二条引用为什么必须能成功 ═══════════════════════════════════
  // 主人 2026-09-15 第二次报同一个毛病：「第二条还是会把已经做好的胶囊
  // 压成一堆普通文字」。上一版给菜单加宽限+重试没打中，因为真正的失败源
  // 在别处：菜单会被输入状态刷新带关，草稿里已经有东西时尤其容易。
  // 所以改成**直接派发官方的会话级事件**，不经菜单。
  //
  // 这一段要钉住的不是"能不能插进去"，而是**失败时绝不许破坏已有内容** ——
  // 那才是主人真正的损失（前面的引用全变成普通文字，还没任何提示）。

  console.log("\n【29】🔴 第二条引用：直接派发官方事件，不依赖菜单")
  {
    withBridge(null, root, fakeRange(tP1, 0, "写入方基于哪一版"))
    const r = capture()
    // 现场还原：草稿里已经有一条胶囊了（正是主人点第二条时的状态）
    const seenChip = "@话布优化 > 前一段"
    const seen = seenChip + " "
    sandbox.window.__ccvInputState = {
      draft: seen, draftRev: 21,
      occurrences: [{ ref: "1", length: seenChip.length }]
    }
    noSessionScope()                 // 连菜单手柄都不给 → 证明这条新路不需要它
    const scope = makeScope()
    scopeResult.current = scope

    const okVal = await auto(r)
    eq("插入成功", okVal, true)
    eq("只派发了一次事件", scope.calls.length, 1)
    eq("派发的是官方的「插入胶囊」事件", scope.calls[0].ev, "slash/input-insert-reference")
    eq("派发主体是会话作用域自己（官方 execute 也是这么传的）", scope.calls[0].self, scope)

    const req = scope.calls[0].req
    eq("归属本源（发送时靠它找回翻译规则）", req.reference.source, "话布选区")
    eq("引用值 = 记录编号", req.reference.ref, String(r.code))
    eq("胶囊文字 = 选中文字前 12 字", req.reference.label, "写入方基于哪一版")
    eq("图标用官方允许的 file", req.reference.appearance, "file")
    eq("退化形态是「@文档 > 原文」", req.reference.clipboardText, "@话布优化 > 写入方基于哪一版")

    // 🔴 坐标必须是**探测投影**的末尾，不是 draft 长度（draft 里胶囊是展开的）
    eq("span 起点 = 探测坐标的末尾（不是草稿字符串长度）", req.span.start, 2)
    eq("span 终点 = 起点（零宽）", req.span.end, req.span.start)
    eq("带上**现读**的草稿版本号（官方靠它做比对）", req.span.draftRev, 21)

    const after = sandbox.window.__ccvInputState
    eq("已有胶囊还在（1 → 2）", after.occurrences.length, 2)
    eq("原来那段草稿一个字没动", after.draft.indexOf(seen), 0)
  }

  console.log("\n【30】🔴 失败时绝不许破坏已有内容（这才是主人的损失）")
  {
    withBridge(null, root, fakeRange(tP1, 0, "写入方基于哪一版"))
    const r = capture()
    const seen = "@话布优化 > 前一段 "
    const seenOcc = [{ ref: "1", length: "@话布优化 > 前一段".length }]
    const before = { draft: seen, draftRev: 30, occurrences: seenOcc }

    // ① 官方拒绝这次改动（版本对不上 / 当前不许改）
    sandbox.window.__ccvInputState = { draft: seen, draftRev: 30, occurrences: seenOcc }
    noSessionScope()
    let scope = makeScope({ refuse: true })
    scopeResult.current = scope
    eq("被拒 → 老老实实返回 false", await auto(r), false)
    ok("确实尝试过官方事件", scope.calls.length > 0)
    eqj("草稿一个字都没被动过", sandbox.window.__ccvInputState, before)

    // ② 官方说成功，但胶囊数没变 → 同样不许谎报成功
    sandbox.window.__ccvInputState = { draft: seen, draftRev: 31, occurrences: seenOcc }
    scope = makeScope({ silent: true })
    scopeResult.current = scope
    eq("说了成功但胶囊没多 → false", await auto(r), false)
    eq("草稿仍然没被动过", sandbox.window.__ccvInputState.draft, seen)

    // ③ 作用域根本没有 bail（更老的 DSH / 服务没到位）
    sandbox.window.__ccvInputState = { draft: seen, draftRev: 32, occurrences: seenOcc }
    scopeResult.current = { 没有bail: true }
    let threw = false
    let val = null
    try { val = await auto(r) } catch (e) { threw = true }
    eq("作用域没有 bail 时不抛错", threw, false)
    eq("返回 false", val, false)
    eq("草稿没被动过", sandbox.window.__ccvInputState.draft, seen)

    // ④ 读不到草稿版本号
    sandbox.window.__ccvInputState = { draft: seen }
    scopeResult.current = makeScope()
    eq("读不到版本号 → false", await auto(r), false)
  }

  console.log("\n【31】最后的兜底：往末尾追加纯文字（同样不碰已有内容）")
  {
    const seenChip = "@话布优化 > 前一段"
    const seen = seenChip + " "
    sandbox.window.__ccvInputState = {
      draft: seen, draftRev: 40,
      occurrences: [{ ref: "1", length: seenChip.length }]
    }
    noSessionScope()
    const scope = makeScope()
    scopeResult.current = scope

    eq("插进去了", textInsert("> 一段引用\n\n"), true)
    eq("派发的是官方的「插入纯文字」事件", scope.calls[0].ev, "slash/input-insert-text")
    eq("span 起点 = 探测坐标的末尾（不是草稿字符串长度）", scope.calls[0].req.span.start, 2)
    eq("span 零宽（只追加，不替换）", scope.calls[0].req.span.end, scope.calls[0].req.span.start)
    eq("带上现读的版本号", scope.calls[0].req.span.draftRev, 40)
    eq("原有内容一个字没动", sandbox.window.__ccvInputState.draft.indexOf(seen), 0)
    eq("胶囊还在（没被文字顶掉）", sandbox.window.__ccvInputState.occurrences.length, 1)

    // 拿不到作用域 → 返回 false，交给主模块处置（主模块会拒绝整体重写）
    noSessionScope()
    eq("拿不到作用域 → false", textInsert("> 一段引用\n\n"), false)
    // 读不到草稿 → 同样 false，不许抛错
    sandbox.window.__ccvInputState = { draft: seen }
    scopeResult.current = makeScope()
    eq("读不到草稿 → false", textInsert("> 一段引用\n\n"), false)
  }

  // 主模块那半没法在这里跑（要 React），但它有一条**结构**规矩必须钉住：
  // 整体重写草稿 = 把已有胶囊拍平。所以它必须被"没有胶囊"挡住。
  // 这里读源码做结构守卫 —— 以后谁把顺序改回去，这条会立刻红。
  console.log("\n【32】🔴 结构守卫：主模块的整体重写必须被「没有胶囊」挡住")
  {
    const client = fs.readFileSync(path.join(__dirname, "..", "lib", "client.js"), "utf8")
    const iFn = client.indexOf("function insertQuoteBlock")
    ok("找得到 insertQuoteBlock", iFn >= 0)
    const iNext = client.indexOf("function runCanvasCmd", iFn)
    const body = (iFn >= 0 && iNext > iFn) ? client.slice(iFn, iNext) : ""
    ok("取到了它的函数体", body.length > 200)
    const iEvent = body.indexOf("__ccvSelRefText")
    const iGuard = body.indexOf("ccvInputChipCount() > 0")
    const iWrite = body.indexOf("setDraft(newDraft)")
    ok("兜底先试官方的「追加纯文字」事件", iEvent >= 0)
    ok("整体重写前有「输入框里没有胶囊」的把关", iGuard >= 0)
    ok("顺序必须是：先试事件 → 再过把关 → 最后才整体重写",
      iEvent >= 0 && iGuard > iEvent && iWrite > iGuard)
  }

  // ═══ 两套坐标的换算 ═══════════════════════════════════════════════
  // 主人 2026-09-15 的现场线索：「插入第二条失败，但是我手动 @ 可以引用第二条」。
  // 手动能插 → 编辑器本身没问题；那失败就一定出在"我们给的位置"上。
  //
  // 读官方源码找到的两套坐标（dsh-client-ui-conversation）：
  //   · $composerLayout 里 pushLeaf("chip", kid, "\uFFFC", kid.getTextContent())
  //     → 同一颗胶囊：探测投影占 **1** 个字，剪贴板投影占 **一整串**字
  //   · 发布给插件的 InputState.draft 用的是 clipboardText（胶囊**展开**）
  //   · 而事件里的 span 走 detectText（insertReference 就是拿 detectText 切片的）
  //
  // 草稿空着时两套长度相等 → 第一条永远成功；有胶囊就差「串长 − 1」→ 必然失败。
  // 所以这里要钉住的是一条**公式**，不是某个具体数字。
  console.log("\n【33】🔴 坐标换算：胶囊在两套投影里长度不同（第二条插不进的真正原因）")
  {
    const stOf = (draft, occ) => ({ draft: draft, occurrences: occ })
    // 一颗胶囊：剪贴板里 11 字，探测里 1 字
    const chip = "@话布优化 > 前一段"           // 11 字
    const one = stOf(chip + " ", [{ ref: "1", length: chip.length }])
    eq("一颗胶囊：剪贴板末尾是 12", one.draft.length, 12)
    eq("一颗胶囊：探测末尾是 2（胶囊算 1 个字 + 后面那个空格）",
      detectLen(one.draft, one.occurrences), 2)

    // 两颗胶囊（主人发第二条时就是走到这里）
    const two = stOf(chip + " " + chip + " ", [
      { ref: "1", length: chip.length },
      { ref: "2", length: chip.length }
    ])
    eq("两颗胶囊：剪贴板末尾是 24", two.draft.length, 24)
    eq("两颗胶囊：探测末尾是 4", detectLen(two.draft, two.occurrences), 4)

    // 没有胶囊时**必须与从前的行为一模一样**（否则会把第一条也弄坏）
    const none = stOf("就是一段普通文字", [])
    eq("没有胶囊时两套坐标相等", detectLen(none.draft, none.occurrences), none.draft.length)
    eq("occurrences 整个缺失也不许算错", detectLen(none.draft, undefined), none.draft.length)

    // 只打字不插胶囊：长度守恒
    const plain = stOf("没有任何胶囊的一串字", [])
    eq("纯文字：换算前后一致", detectLen(plain.draft, plain.occurrences), plain.draft.length)

    // 🔴 边界：万一 length 比 1 还离谱，也绝不许把位置算成负数
    const weird = stOf("ab", [{ ref: "1", length: 999 }])
    eq("length 不合理时夹到 0，不出负数", detectLen(weird.draft, weird.occurrences), 0)

    // 端到端：走一遍真实插入，落在末尾（零宽），且前面一个字没动
    withBridge(null, root, fakeRange(tP1, 0, "写入方基于哪一版"))
    const r2 = capture()
    // ⚠️ 端到端必须带 draftRev —— 少了它 draftNow() 直接返回 null，
    //    测出来的是"读不到版本号"，根本走不到坐标那一步（第一版就踩了这个坑）
    sandbox.window.__ccvInputState = {
      draft: two.draft, draftRev: 55, occurrences: two.occurrences
    }
    noSessionScope()
    const scope2 = makeScope()
    scopeResult.current = scope2
    eq("第二条也插进去了", await auto(r2), true)
    eq("span 落在探测末尾（4），不是剪贴板末尾（24）",
      scope2.calls[0].req.span.start, 4)
    eq("零宽 → 只追加", scope2.calls[0].req.span.end, 4)
    eq("胶囊从 2 条变成 3 条", sandbox.window.__ccvInputState.occurrences.length, 3)
    eq("前面两条一个字没动", sandbox.window.__ccvInputState.draft.indexOf(chip + " " + chip + " "), 0)
  }

  console.log("\n────────────────────────────────")
  console.log("通过 " + pass + " 项，失败 " + fail + " 项")
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.log("测试自身异常: " + (e && e.stack))
  process.exit(1)
})
