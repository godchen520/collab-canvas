// 撤销 / 重做的零依赖回归测试（host 侧）。
//
// 为什么要单独一份：这套语义**错了在界面上很难看出来** ——
//   · 撤销时若顺手往 history 里再塞一条，"撤销"本身就变成可撤销的一步，
//     用户按一下栈也跟着长，表现是"撤了 A，栈顶变成刚才那次撤销"，感觉撤不回去；
//   · version 忘了 +1，客户端下一次写入会拿着旧版本号被自己挡下（或被判成冲突）；
//   · redoStack 忘了清，用户改完新内容还能"重做"出被覆盖掉的旧版本。
// 这三种都不会报错、界面也照常跳，所以必须能跑出数值来对。
//
// 做法与另外两份一致：**从构建产物里把真代码切出来跑**，不是照抄一份。
// 切取范围由 src/host/05-mutations.js 里的 [[CCV-UNDO-BEGIN/END]] 标记圈定；
// 标记没了这份测试会立刻报错（而不是悄悄测试一份过期副本）。
//
// 跑法：node tools/test-host-undo.cjs
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

// ─── 从构建产物里切出「历史栈 + 撤销/重做」那段真代码 ─────────────
const hostPath = path.join(__dirname, "..", "dist", "host.js")
if (!fs.existsSync(hostPath)) {
  console.log("✗ 没有 dist/host.js —— 先跑：node tools/build.cjs")
  process.exit(1)
}
const hostSrc = fs.readFileSync(hostPath, "utf8")
const BEGIN = "// [[CCV-UNDO-BEGIN]]"
const END = "// [[CCV-UNDO-END]]"
const ia = hostSrc.indexOf(BEGIN)
const ib = hostSrc.indexOf(END)
if (ia < 0 || ib < 0 || ib <= ia) {
  console.log("✗ dist/host.js 里找不到 [[CCV-UNDO-BEGIN/END]] 标记 ——")
  console.log("  说明标记被挪走或删掉了；这份测试无法确认自己测的是哪段代码，直接失败。")
  process.exit(1)
}
const block = hostSrc.slice(ia, ib)

// ─── 沙箱：只补它真正依赖的那几样 ───────────────────────────────
// debouncedFlush 是这段唯一的副作用（把撤销结果排进落盘队列）。
// 这里换成计数器：既能跑通，又能验证"撤销确实安排了下盘"——
// 少了它，撤销只活在内存里，刷新即白做。
let flushCalls = 0
let seq = 0
const sandbox = {
  console, Map, JSON, Math, String, Number, RegExp, Error, Date, Array,
  idSeq: 0,
  debouncedFlush: function () { flushCalls++ },
}
vm.createContext(sandbox)
vm.runInContext(block, sandbox, { filename: "dist/host.js#undo" })

const { pushHistory, undoCanvas, redoCanvas, canUndo, canRedo, HISTORY_MAX } = sandbox
if (typeof undoCanvas !== "function" || typeof redoCanvas !== "function") {
  console.log("✗ 切出来的那段没有导出 undoCanvas / redoCanvas")
  process.exit(1)
}

function mkCanvas(content) {
  return {
    id: "c" + (++seq), title: "测试", version: 1,
    content: content || "", history: [], redoStack: [], dirty: false, updatedAt: 0,
  }
}
// 模拟一次真实写入：内容变了 + 记一步历史
function write(c, after, source) {
  const before = c.content
  c.content = after
  c.version += 1
  pushHistory(c, before, after, source || "human", c.version)
}

console.log("撤销 / 重做：仓库里的真代码（" + block.length + " 字符）\n")

// ─── 1. 空栈 ────────────────────────────────────────────────
{
  const c = mkCanvas("A")
  const r = undoCanvas(c)
  eq("空栈撤销：不报错，回 noop", [r.ok, r.noop, c.content, c.version], [true, true, "A", 1])
  const r2 = redoCanvas(c)
  eq("空栈重做：回 noop", [r2.ok, r2.noop, c.content], [true, true, "A"])
  eq("空栈撤销不动 flush", flushCalls, 0)
}

// ─── 2. 撤销一步 ─────────────────────────────────────────────
{
  const c = mkCanvas("A")
  write(c, "B")
  eq("写入后 canUndo / canRedo", [canUndo(c), canRedo(c)], [true, false])
  const before = flushCalls
  const r = undoCanvas(c)
  eq("撤销：内容回到 A", r.content, "A")
  eq("撤销：version +1（客户端据此同步 knownVer）", r.version, c.version)
  eq("撤销：version 从 2 变 3", [2, c.version], [2, 3])
  eq("撤销：安排了下盘", flushCalls > before, true)
  eq("撤销：dirty 置位", c.dirty, true)
  // ★ 最关键的一条：撤销**只能 pop，不能又 push**。
  //   若实现写成「先 push 一条再回退」，这里会得到 2（或 1），
  //   界面上表现为"按一次栈还变长了，总觉得撤不回去"。
  eq("★ 撤销只出栈、不新增（历史长度 1 → 0）", c.history.length, 0)
  eq("撤销后 canUndo / canRedo", [canUndo(c), canRedo(c)], [false, true])
}

// ─── 3. 重做一步 ─────────────────────────────────────────────
{
  const c = mkCanvas("A")
  write(c, "B")
  undoCanvas(c)
  eq("撤销后 history 空 / redoStack 1", [c.history.length, c.redoStack.length], [0, 1])
  const r = redoCanvas(c)
  eq("重做：内容回到 B", r.content, "B")
  eq("重做：version 递增（1→2 写，→3 撤，→4 重做）", c.version, 4)
  eq("重做后 history / redoStack", [c.history.length, c.redoStack.length], [1, 0])
  eq("重做后 canUndo / canRedo", [canUndo(c), canRedo(c)], [true, false])
}

// ─── 4. 连续编辑会**合并**成一步（2026-10-11 新契约）─────────────
// 为什么改成这样：接了自动保存之后，"停手 1.5 秒写一次"会不停落历史 ✗
// 所以 pushHistory 现在会把「同来源 + 60 秒内 + 首尾相接」的连续编辑合成一条 ✓
// 这三条判据本身在第 7 节单独测 ✓
{
  const c = mkCanvas("v0")
  write(c, "v1"); write(c, "v2"); write(c, "v3")
  eq("三步之后内容", c.content, "v3")
  eq("★ 连续三次编辑合并成 1 条历史（自动保存不会冲爆撤销栈）", c.history.length, 1)
  eq("合并后起点仍在最初（撤销要能一次退到底）", c.history[0].before, "v0")
  eq("合并后终点是最新", c.history[0].after, "v3")
  undoCanvas(c)
  eq("★ 一次撤销直接回到最初", c.content, "v0")
  eq("撤销后 canUndo / canRedo", [canUndo(c), canRedo(c)], [false, true])
  redoCanvas(c)
  eq("一次重做回到最新", c.content, "v3")
  eq("重做后 history / redoStack", [c.history.length, c.redoStack.length], [1, 0])
}

// ─── 4b. 不该合并的三种情况 ─────────────────────────────────
{
  // ① 首尾不相接（中间隔了一次别的改动）→ 必须分开
  const c = mkCanvas("a")
  write(c, "b")
  write(c, "c")
  eq("首尾相接 → 合并成 1 条", c.history.length, 1)
  // 手动制造"不相接"：把历史终点点改成别的内容
  c.history[c.history.length - 1].after = "b（被别人改过）"
  write(c, "d")
  eq("★ 首尾不相接 → 新开一条", c.history.length, 2)

  // ② 来源不同 → 必须分开（撤销时想分清是 AI 改的还是人改的）
  const c2 = mkCanvas("x")
  write(c2, "y", "human")
  write(c2, "z", "ai")
  eq("★ 来源不同 → 不合并", c2.history.length, 2)

  // ③ 超过时间窗 → 必须分开（撤销粒度不能太粗）
  const c3 = mkCanvas("p")
  write(c3, "q")
  c3.history[c3.history.length - 1].at = Date.now() - (61 * 1000)
  write(c3, "r")
  eq("★ 超过 60 秒 → 不合并", c3.history.length, 2)
}

// ─── 5. 撤销后再写入 → 重做栈必须清空 ────────────────────────
{
  const c = mkCanvas("A")
  write(c, "B")
  undoCanvas(c)
  eq("撤销后还有得重做", canRedo(c), true)
  write(c, "C")            // 新改动 = 另开一条时间线
  eq("★ 新写入清空重做栈（否则能重做回被覆盖的 B）", c.redoStack.length, 0)
  eq("新写入后内容 / 历史长度", [c.content, c.history.length], ["C", 1])
}

// ─── 6. 历史上限 ─────────────────────────────────────────────
{
  const c = mkCanvas("s0")
  // ⚠️ 交替来源，故意**避开合并** —— 这一节测的是"上限"，不是"合并" ✓
  for (let i = 1; i <= HISTORY_MAX + 10; i++) write(c, "s" + i, (i % 2) ? "human" : "ai")
  eq("历史不超过上限", c.history.length, HISTORY_MAX)
  eq("上限常量是 50", HISTORY_MAX, 50)
}

console.log("\n" + "─".repeat(34))
console.log(pass + " 通过 / " + fail + " 失败")
process.exit(fail ? 1 : 0)
