// canvas_locate 的零依赖回归测试（host 侧）。
//
// 为什么要单独一份：这个工具的返回内容**在真机上不报错、只会安静地答错** ——
// 行号列号算偏一位、该报"三处"只报了一处，界面上完全看不出来，
// 而模型会照着错答案去改文档。所以必须有一份能跑出数值的测试。
//
// 做法与 client 那份一致：**从构建产物里把真代码切出来跑**，不是照抄一份。
// 切取范围由 src/host/07-tools.js 里的 [[CCV-LOCATE-BEGIN/END]] 两个标记圈定；
// 标记没了这份测试会立刻报错（而不是悄悄测试一份过期副本）。
//
// 跑法：node tools/test-host-locate.cjs
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

// ─── 从构建产物里切出 canvas_locate 那段真代码 ─────────────────
const hostPath = path.join(__dirname, "..", "dist", "host.js")
if (!fs.existsSync(hostPath)) {
  console.log("✗ 没有 dist/host.js —— 先跑：node tools/build.cjs")
  process.exit(1)
}
const hostSrc = fs.readFileSync(hostPath, "utf8")
const BEGIN = "// [[CCV-LOCATE-BEGIN]]"
const END = "// [[CCV-LOCATE-END]]"
const ia = hostSrc.indexOf(BEGIN)
const ib = hostSrc.indexOf(END)
if (ia < 0 || ib < 0 || ib <= ia) {
  console.log("✗ dist/host.js 里找不到 [[CCV-LOCATE-BEGIN/END]] 标记 ——")
  console.log("  说明标记被挪走或删掉了；这份测试无法确认自己测的是哪段代码，直接失败。")
  process.exit(1)
}
const locateBlock = hostSrc.slice(ia, ib)

// ─── 沙箱：只补它真正依赖的那几样 ───────────────────────────────
// toolOutput / err 用与真文件相同的实现（它们不是被测对象，被测的是定位逻辑）。
// canvases / activeId 就是 host 里那两个顶层状态，这里换成可控的假数据。
const sandbox = {
  console,
  Map,
  JSON,
  Math,
  String,
  Number,
  RegExp,
  Error,
}
sandbox.__tools = []
sandbox.ctx = {
  tools: {
    register: function (def) { sandbox.__tools.push(def); return function () {} },
    // 其余注册口不涉及本工具，给空实现即可
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
vm.runInContext(prelude + "\n" + locateBlock, sandbox, { filename: "dist/host.js#locate" })

const tool = sandbox.__tools.find((t) => t.name === "canvas_locate")
if (!tool) {
  console.log("✗ 那段代码没有注册出 canvas_locate")
  process.exit(1)
}

// 每个用例前重设假文档库
function setDocs(list, active) {
  sandbox.canvases.clear()
  for (const d of list) sandbox.canvases.set(d.id, d)
  sandbox.activeId = active === undefined ? (list[0] ? list[0].id : null) : active
}
async function call(args) {
  return JSON.parse(await tool.execute(args))
}

// ─── 测试用的假文档（Markdown 源码口径） ────────────────────────
// 行号（从 1 数）：
//   1 '# 测试文档'
//   2 ''
//   3 '小明在笑，小明在闹。'
//   4 ''
//   5 '这里有 11111111111111111111 一串。'
//   6 ''
//   7 '甲小明乙'
//   8 ''
const DOC = [
  "# 测试文档",
  "",
  "小明在笑，小明在闹。",
  "",
  "这里有 11111111111111111111 一串。",
  "",
  "甲小明乙",
  "",
].join("\n")

// 独立算一遍"某串在全文出现几次"和"某下标在第几行第几列"，用来交叉验证
function occ(t, n) { let c = 0, i = 0; while ((i = t.indexOf(n, i)) >= 0) { c++; i++ } return c }
function lineOf(t, idx) { return t.slice(0, idx).split("\n").length }
function colOf(t, idx) { const b = t.slice(0, idx); return idx - (b.lastIndexOf("\n") + 1) + 1 }

async function main() {
  const DOC1 = { id: "c1", title: "测试文档", type: "markdown", content: DOC, version: 3, filePath: "H:/x/测试文档.md" }

  console.log("\n【1】工具注册出来了，且参数声明齐全")
  eq("名字", tool.name, "canvas_locate")
  ok("描述了「多处时必须先用它」", tool.description.indexOf("多处") >= 0 && tool.description.indexOf("必须") >= 0)
  ok("描述了「不要自己挑一处改」", tool.description.indexOf("不要自己挑") >= 0)
  eq("text 是必填", tool.parameters.text.required, true)

  console.log("\n【2】原文唯一 → 直接告诉它「就是这一处」")
  setDocs([DOC1])
  let r = await call({ text: "小明在笑" })
  ok("成功", r.ok)
  eq("只有一处", r.total, 1)
  eq("与独立实现算出的出现次数一致", r.total, occ(DOC, "小明在笑"))
  eq("行号（独立算）", r.spots[0].line, lineOf(DOC, DOC.indexOf("小明在笑")))
  eq("列号（独立算）", r.spots[0].col, colOf(DOC, DOC.indexOf("小明在笑")))
  ok("明确说「只有这一处」", r.hint.indexOf("只有这一处") >= 0)
  ok("带出是哪篇文档", r.title === "测试文档" && r.canvasId === "c1")

  console.log("\n【3】一处摘要：用【】框出原文、前后各带一点")
  ok("摘要里用【】框住了原文", r.spots[0].excerpt.indexOf("【小明在笑】") >= 0)
  ok("摘要右侧带出了后文", r.spots[0].excerpt.indexOf("，小明在闹") >= 0)

  console.log("\n【4】原文多处 → 每一处都要列出来，行号列号都要准")
  r = await call({ text: "小明" })
  eq("总数与独立实现一致", r.total, occ(DOC, "小明"))
  eq("原文确实出现三次", r.total, 3)
  eq("三处都列了出来", r.spots.length, 3)
  const wantIdx = []
  { let i = 0; while ((i = DOC.indexOf("小明", i)) >= 0) { wantIdx.push(i); i++ } }
  eq("每处的行号都对（独立算）", r.spots.map((s) => s.line), wantIdx.map((i) => lineOf(DOC, i)))
  eq("每处的列号都对（独立算）", r.spots.map((s) => s.col), wantIdx.map((i) => colOf(DOC, i)))
  ok("行号确实是 3、3、7", r.spots.map((s) => s.line).join(",") === "3,3,7")
  ok("没给行号时，不硬指一处", r.hint.indexOf("分不出来") >= 0)
  ok("没给行号时，要求交给用户确认", r.hint.indexOf("不要自己挑") >= 0)
  ok("没有一处被标成 likelyTarget", r.spots.every((s) => !s.likelyTarget))

  console.log("\n【5】给了引用里的行号 → 只有一处能对上时才敢说「多半是它」")
  r = await call({ text: "小明", line: 7 })
  eq("标记出恰好一处", r.spots.filter((s) => s.likelyTarget).length, 1)
  eq("被标的是第 7 行那处", r.spots.filter((s) => s.likelyTarget)[0].line, 7)
  ok("仍要求照摘要核对一次", r.hint.indexOf("核对") >= 0)
  // 行号给在第 3 行：第 3 行本来就有两处，凑不出"恰好一处" → 必须退回让人确认
  r = await call({ text: "小明", line: 3 })
  eq("行号落在有两处的那一行 → 不标任何一处", r.spots.filter((s) => s.likelyTarget).length, 0)
  ok("退回让用户确认", r.hint.indexOf("不要自己挑") >= 0)

  console.log("\n【5b】引用给了「第 N 处」→ 同一行里也能直接定住")
  // 这是主人 09-14 那句追问的正解：两个「小明」在同一行，行号根本分不开，
  // 但「第 1 处 / 第 2 处」分得开 —— 引用标签里带的就是这个数。
  r = await call({ text: "小明", ordinal: 2 })
  eq("恰好标一处", r.spots.filter((s) => s.likelyTarget).length, 1)
  eq("标的是第 2 处", r.spots[1].likelyTarget, true)
  eq("第 1 处没被标", r.spots[0].likelyTarget, false)
  eq("这两处确实同一行（可见光凭行号是没用的）", r.spots[0].line, r.spots[1].line)
  ok("hint 说清了是按第 2 处定的", r.hint.indexOf("第 2 处") >= 0)
  ok("仍要求照摘要核对一次", r.hint.indexOf("核对") >= 0)

  r = await call({ text: "小明", ordinal: 1 })
  eq("给 1 时标第 1 处", r.spots[0].likelyTarget, true)
  eq("第 2 处不再被标", r.spots[1].likelyTarget, false)

  r = await call({ text: "小明", ordinal: 99 })
  eq("序数超出范围 → 一个都不标", r.spots.filter((s) => s.likelyTarget).length, 0)
  ok("退回让用户确认", r.hint.indexOf("不要自己挑") >= 0)

  r = await call({ text: "小明", ordinal: 3, line: 3 })
  eq("序数与行号矛盾时以序数为准（同一行里行号没有分辨力）", r.spots[2].likelyTarget, true)
  eq("第 3 处落在第 7 行", r.spots[2].line, 7)

  console.log("\n【6】原文已不在文档里 → 明说是「失效」，并禁止照着相似内容改")
  r = await call({ text: "这段文字早就不在文档里了" })
  eq("失败", r.ok, false)
  eq("错误码", r.error.code, "E_GONE")
  ok("说清了原因（引用失效 / 文档被改过）", r.error.message.indexOf("已经不在") >= 0)
  ok("要求用户重新划一次", r.hint.indexOf("重新划") >= 0)
  ok("明确禁止照着相似内容按猜测改", r.hint.indexOf("不要") >= 0 && r.hint.indexOf("猜测改") >= 0)

  console.log("\n【7】参数不合法 / 文档找不到")
  r = await call({})
  eq("没给原文 → 参数错误", r.error.code, "E_BAD_ARGS")
  r = await call({ text: "   " })
  ok("空串也算参数错误", r.ok === false)
  setDocs([], null)
  r = await call({ text: "小明" })
  eq("没有活跃画布 → 找不到文档", r.error.code, "E_NOT_FOUND")

  console.log("\n【8】按「路径」认文档（引用里给的就是路径，不是 id）")
  setDocs([{ id: "c9", title: "别的东西", content: "无关内容", version: 1, filePath: "H:/other/别的东西.md" }, DOC1], null)
  r = await call({ text: "小明", path: "H:/x/测试文档.md" })
  ok("按路径命中", r.ok && r.canvasId === "c1")
  r = await call({ text: "小明", path: "H:\\x\\测试文档.md" })
  ok("反斜杠路径也能命中（要归一化）", r.ok && r.canvasId === "c1")
  r = await call({ text: "小明", path: "H:/随便/测试文档.md" })
  ok("路径对不上时退回标题兜底", r.ok && r.canvasId === "c1")
  r = await call({ text: "小明", canvasId: "c1" })
  ok("直接给 id 也认", r.ok && r.canvasId === "c1")

  console.log("\n【9】重叠匹配不能漏（`aaaa` 里的 `aa` 有 3 处）")
  setDocs([{ id: "ov", title: "重叠", content: "aaaa", version: 1, filePath: "" }])
  r = await call({ text: "aa" })
  eq("数出 3 处", r.total, 3)
  eq("列号分别是 1、2、3", r.spots.map((s) => s.col).join(","), "1,2,3")

  console.log("\n【10】摘要里的换行要现形（否则结构会被拆散）")
  setDocs([{ id: "nl", title: "换行", content: "甲乙\n丙丁\n戊己", version: 1, filePath: "" }])
  r = await call({ text: "丙丁" })
  ok("换行显示成 ↵", r.spots[0].excerpt.indexOf("↵") >= 0)
  ok("摘要里没有真换行", r.spots[0].excerpt.indexOf("\n") < 0)

  console.log("\n【11】重复得太多时不许把输出撑爆")
  const many = new Array(30).fill("同样一段").join("、")
  setDocs([{ id: "many", title: "很多", content: many, version: 1, filePath: "" }])
  r = await call({ text: "同样一段" })
  eq("总数如实报", r.total, occ(many, "同样一段"))
  eq("最多只列 8 处", r.spots.length, 8)
  ok("说明了只列了一部分", r.note.indexOf("只列了前 8 处") >= 0)
  ok("仍然要求用户确认", r.hint.indexOf("不要自己挑") >= 0)

  console.log("\n【12】行号口径差异必须提前讲明，不能让人误信")
  setDocs([DOC1])
  r = await call({ text: "小明在笑" })
  ok("明确提示：这里按源码数、引用标签按渲染结果数", r.lineNote.indexOf("Markdown 源码") >= 0 && r.lineNote.indexOf("渲染") >= 0)
  ok("并指明以摘要为准", r.lineNote.indexOf("以 excerpt 为准") >= 0)

  console.log("\n────────────────────────────────")
  console.log("通过 " + pass + " 项，失败 " + fail + " 项")
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.log("测试自身异常: " + (e && e.stack))
  process.exit(1)
})
