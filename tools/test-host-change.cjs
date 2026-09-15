// 「AI 改了哪儿」的零依赖回归测试（host 侧）。
//
// 为什么要单独一份：这段逻辑**算错了在界面上完全看不出来** ——
// 改动区间圈偏几十个字，画布照样会跳，只是跳到错的地方，
// 主人看到的是一段没变的文字，而 AI 那边一切正常。所以必须能跑出数值来对。
//
// 做法与另外两份一致：**从构建产物里把真代码切出来跑**，不是照抄一份。
// 切取范围由 src/host/05-mutations.js 里的 [[CCV-CHANGE-BEGIN/END]] 两个标记圈定；
// 标记没了这份测试会立刻报错（而不是悄悄测试一份过期副本）。
//
// 跑法：node tools/test-host-change.cjs
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

// ─── 从构建产物里切出「改动记录」那段真代码 ─────────────────────
const hostPath = path.join(__dirname, "..", "dist", "host.js")
if (!fs.existsSync(hostPath)) {
  console.log("✗ 没有 dist/host.js —— 先跑：node tools/build.cjs")
  process.exit(1)
}
const hostSrc = fs.readFileSync(hostPath, "utf8")
const BEGIN = "// [[CCV-CHANGE-BEGIN]]"
const END = "// [[CCV-CHANGE-END]]"
const ia = hostSrc.indexOf(BEGIN)
const ib = hostSrc.indexOf(END)
if (ia < 0 || ib < 0 || ib <= ia) {
  console.log("✗ dist/host.js 里找不到 [[CCV-CHANGE-BEGIN/END]] 标记 ——")
  console.log("  说明标记被挪走或删掉了；这份测试无法确认自己测的是哪段代码，直接失败。")
  process.exit(1)
}
const changeBlock = hostSrc.slice(ia, ib)

// ─── 沙箱：只补它真正依赖的那几样 ───────────────────────────────
const sandbox = { console, Map, JSON, Math, String, Number, RegExp, Error, Date, Array }
vm.createContext(sandbox)
vm.runInContext(changeBlock, sandbox, { filename: "dist/host.js#change" })

const { diffSpan, noteAiChange } = sandbox
if (typeof diffSpan !== "function" || typeof noteAiChange !== "function") {
  console.log("✗ 切出来的那段没有导出 diffSpan / noteAiChange")
  process.exit(1)
}

let seqCanvas = 0
function mkCanvas(title) {
  return { id: "c" + (++seqCanvas), title: title || "测试文档", version: 1, content: "" }
}
function reset() { sandbox.aiChanges.length = 0; sandbox.aiChangeSeq = 0 }

// 独立算一遍"最长公共前缀 / 后缀"，用来交叉验证（不信任被测实现的写法）
function prefixOf(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i }
function suffixOf(a, b, p) {
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return s
}

async function main() {
  console.log("\n【1】改几个字 → 精确圈出那一段（不是整篇）")
  {
    const before = "# 标题\n\n今天天气很好，适合出门散步。\n\n结束。"
    const after = "# 标题\n\n今天天气很好，适合出门跑步。\n\n结束。"
    const d = diffSpan(before, after)
    eq("改动起点与独立实现一致", d.start, prefixOf(before, after))
    eq("改动终点与独立实现一致", d.end, after.length - suffixOf(before, after, prefixOf(before, after)))
    // ⚠️ diffSpan 报的是**最小**区间：这里只会圈出「散」→「跑」，
    //    因为「步」在两边都一样，被算作公共后缀。
    //    这是对的，不是 bug —— 它足以确定"改动点在哪"。
    //    （撑开成够长的搜索键是 noteAiChange 的另一件事，见【8b】）
    eq("最小改动：只圈出「跑」", after.slice(d.start, d.end), "跑")
    eq("被替掉的只圈出「散」", before.slice(d.start, d.beforeEnd), "散")
    ok("起点就是第一个不同的字", after.charAt(d.start) !== before.charAt(d.start))
    ok("起点前一个字是相同的（说明没多圈）", d.start === 0 || after.charAt(d.start - 1) === before.charAt(d.start - 1))
    ok("改动点确实落在「跑」上", after.charAt(d.start) === "跑")
  }

  console.log("\n【2】纯追加 → 改动点在原文末尾")
  {
    const before = "第一段。\n"
    const after = "第一段。\n第二段。\n"
    const d = diffSpan(before, after)
    eq("起点 = 原文长度", d.start, before.length)
    eq("被删掉的长度是 0", d.beforeEnd - d.start, 0)
    eq("新增的是第二段", after.slice(d.start, d.end), "第二段。\n")
  }

  console.log("\n【3】纯删除 → 新增长度是 0，靠前锚点定位")
  {
    const before = "甲乙丙丁戊"
    const after = "甲乙戊"
    const d = diffSpan(before, after)
    eq("起点", d.start, 2)
    eq("新增长度为 0", d.end - d.start, 0)
    eq("被删的是丙丁", before.slice(d.start, d.beforeEnd), "丙丁")
  }

  console.log("\n【4】整篇换成完全不同的 → 从 0 圈到最后（这种情况跳过去就是看到开头）")
  {
    const d = diffSpan("aaa", "bbb")
    eq("起点 0", d.start, 0)
    eq("终点 = 新文本长度", d.end, 3)
  }

  console.log("\n【5】内容没变 → 不记录（免得画布端白跳一次）")
  {
    reset()
    const c = mkCanvas()
    const r = noteAiChange(c, "一样的内容", "一样的内容")
    eq("返回 null", r, null)
    eq("队列没变长", sandbox.aiChanges.length, 0)
    eq("序号没被占用", sandbox.aiChangeSeq, 0)
  }

  console.log("\n【6】记下的一条：字段齐、数值对")
  {
    reset()
    const before = "# 标题\n\n甲甲甲甲甲\n\n结尾。"
    const after = "# 标题\n\n甲甲乙甲甲\n\n结尾。"
    const c = mkCanvas("我的文档")
    const r = noteAiChange(c, before, after)
    ok("记下来了", !!r)
    eq("序号从 1 开始", r.seq, 1)
    eq("落在哪篇文档", r.canvasId, c.id)
    eq("标题", r.title, "我的文档")
    // 真实改动量（最小）—— 这是老实数出来的，用于日志与判断
    eq("删除字数", r.removedChars, 1)
    eq("新增字数", r.addedChars, 1)
    ok("搜索键里含着改动后的那个字", r.added.indexOf("乙") >= 0)
    ok("搜索键在改后文档里找得到", after.indexOf(r.added) >= 0)
    eq("进了队列", sandbox.aiChanges.length, 1)
  }

  console.log("\n【7】🔴 前后锚点**必须改前改后都存在**（这是整套跳转成立的前提）")
  {
    reset()
    const before = "前面一段很长的铺垫文字ABCDEFG，中间原来是旧的，后面还有很长的收尾文字HIJKLMN。"
    const after = "前面一段很长的铺垫文字ABCDEFG，中间换成了新的，后面还有很长的收尾文字HIJKLMN。"
    const c = mkCanvas()
    const r = noteAiChange(c, before, after)
    ok("前锚点非空", r.head.length > 0)
    ok("后锚点非空", r.tail.length > 0)
    ok("前锚点在**改前**的文字里也找得到", before.indexOf(r.head) >= 0)
    ok("前锚点在**改后**的文字里找得到", after.indexOf(r.head) >= 0)
    ok("后锚点在改前也找得到", before.indexOf(r.tail) >= 0)
    ok("后锚点在改后也找得到", after.indexOf(r.tail) >= 0)
    // 前锚点必须**末尾正好落在改动点**上（它后面就该是改动处），否则跳过去会偏
    const trueStart = prefixOf(before, after)
    eq("前锚点末尾正好落在改动点上", after.indexOf(r.head) + r.head.length, trueStart)
    // 撑开后的搜索键要**覆盖**改动点：起点可以在它之前，但不能错过它
    {
      const aStart = after.indexOf(r.added)
      ok("搜索键在改后文档里定位得到", aStart >= 0)
      ok("搜索键从改动点之前（或正处）开始", aStart <= trueStart)
      ok("搜索键覆盖到了改动点", aStart + r.added.length > trueStart)
    }
    eq("前锚点最长 40 字", r.head.length <= 40, true)
    eq("后锚点最长 40 字", r.tail.length <= 40, true)
  }

  console.log("\n【8】锚点长度有上限（不能把整篇文档带过去）")
  {
    reset()
    const long = "一".repeat(500)
    const before = long + "旧内容" + long
    const after = long + "新内容" + long
    const r = noteAiChange(mkCanvas(), before, after)
    eq("前锚点 40 字", r.head.length, 40)
    eq("后锚点 40 字", r.tail.length, 40)
    // ⚠️ added 是**撑开过**的搜索键，长度不等于 addedChars
    //    （addedChars 报真实改动量，added 只管"能在另一侧找到"）
    eq("真实改动量只有 1 个字（旧→新）", r.addedChars, 1)
    ok("但搜索键被撑开了（1 个字的键在全文里太容易撞）", r.added.length >= 8)
    ok("撑开后的搜索键里含着那个新字", r.added.indexOf("新") >= 0)
    ok("而且这段搜索键确实存在于改后的文档里", after.indexOf(r.added) >= 0)
  }

  console.log("\n【8b】🔴 搜索键要撑开：只改一个字时，1 个字的键会撞到别的地方")
  // 这是实测踩到的：diffSpan 给的最小值往往只有 1~2 个字。
  // 画布端是拿这段文字**去全文里找**的 —— 「散」这种字满篇都是，
  // 它会跳到第一处「散」，主人看到一段没变的文字，还以为 AI 改错了。
  {
    reset()
    // 文里到处是「散」字，只有中间一处被改成了「跑」
    const before = "散步的散文，散散地散着。这里是散步。"
    const after = "散步的散文，散散地散着。这里是跑步。"
    const r = noteAiChange(mkCanvas(), before, after)
    ok("真实改动量只有 1 个字", r.addedChars, 1)
    ok("搜索键被撑到 8 字以上", r.added.length >= 8)
    ok("撑开后的搜索键在文档里只出现一次（这才叫能定位）",
      after.split(r.added).length - 1 === 1)
    ok("旧的最小键「散」在文里出现多次（用它必然跳到错的地方）",
      before.split("散").length - 1 > 1)
    ok("改动点被包在搜索键里", r.added.indexOf("跑") >= 0)
  }

  console.log("\n【9】新增内容过长时截断（防止把整篇塞进通知）")
  {
    reset()
    const before = "头。脚。"
    const after = "头。" + "很长的新内容".repeat(60) + "脚。"
    const r = noteAiChange(mkCanvas(), before, after)
    eq("新内容截到 160 字", r.added.length, 160)
    ok("但字数统计仍是真实值", r.addedChars > 160)
  }

  console.log("\n【10】队列有上限，超了丢最旧的")
  {
    reset()
    const c = mkCanvas()
    for (let i = 0; i < 25; i++) noteAiChange(c, "原" + i + "文", "改" + i + "文")
    eq("队列停在 20 条", sandbox.aiChanges.length, 20)
    eq("保留的是最新的那 20 条", sandbox.aiChanges[0].seq, 6)
    eq("最后一条序号", sandbox.aiChanges[19].seq, 25)
    eq("总序号继续增长", sandbox.aiChangeSeq, 25)
  }

  console.log("\n【11】序号单调递增（画布端靠它做增量取，重复或倒退都会漏跳）")
  {
    reset()
    const c = mkCanvas()
    const a = noteAiChange(c, "a", "b")
    noteAiChange(c, "a", "a")          // 没变化，不占号
    const b = noteAiChange(c, "b", "c")
    eq("第一条 seq=1", a.seq, 1)
    eq("第二条 seq=2（中间那次没变化没占号）", b.seq, 2)
    ok("严格递增", b.seq > a.seq)
  }

  console.log("\n【12】中文、多字节、换行都不出错（charAt 按码元走）")
  {
    reset()
    const before = "第一行\n第二行\n😀表情后面\n第四行"
    const after = "第一行\n第二行改了\n😀表情后面\n第四行"
    const r = noteAiChange(mkCanvas(), before, after)
    ok("记下来了", !!r)
    ok("搜索键里含着新增的「改了」", r.added.indexOf("改了") >= 0)
    eq("真实新增 2 个字", r.addedChars, 2)
    ok("前锚点在两边都在", before.indexOf(r.head) >= 0 && after.indexOf(r.head) >= 0)
    ok("后锚点在两边都在", before.indexOf(r.tail) >= 0 && after.indexOf(r.tail) >= 0)
  }

  console.log("\n【13】只记「AI 改的」—— 主人自己打字/自动保存不该触发跳转")
  {
    // 这一条在 applyWrite 里，不在切出来的这段；改用源码文本核对，
    // 因为「有没有那道 source 判断」是**整条功能会不会误跳**的关键。
    ok("applyWrite 里带了 source === 'ai' 的判断",
      hostSrc.indexOf("if (source === 'ai') {") >= 0)
    const n = hostSrc.split("noteAiChange(c, before, c.content)").length - 1
    eq("而且只有一处（不会重复记）", n, 1)
  }

  console.log("\n【15】AI 写入立刻落盘，不等那 1.5 秒防抖")
  {
    // 为什么值得单独钉住：主人改完马上去看磁盘 / 让别的工具读这个文件时，
    // 1.5 秒的空窗会让他看到上一版内容 —— 然后以为「根本没写进去」。
    // 这是**静默的误导**，不是性能问题。
    ok("AI 分支调了立即落盘", hostSrc.indexOf("saveSerial(c).then(") >= 0)
    // 而人的连续打字仍然走防抖（防抖存在的理由就是合并连续输入，别一起砍掉）
    ok("debouncedFlush 仍在（人的输入照旧走防抖）", hostSrc.indexOf("debouncedFlush()") >= 0)
    ok("落盘串成一条链", hostSrc.indexOf("var p = saveChain.then(") >= 0
      && hostSrc.indexOf("saveChain = p.then(") >= 0)
    ok("某一次失败不会把链弄断（后面该写还得写）",
      hostSrc.indexOf("saveChain = p.then(function () {}, function () {})") >= 0)
    ok("防抖那条路径也走同一个串行链", hostSrc.indexOf("await saveSerial(c)") >= 0)
  }

  console.log("\n【14】这个功能的接口在 host 上暴露齐了")
  {
    ok("有查询端点 /api/canvas/changes", hostSrc.indexOf("/api/canvas/changes") >= 0)
    ok("端点只回 since 之后的新条目", hostSrc.indexOf("x.seq > since") >= 0)
    ok("回了 latest 游标（画布端靠它推进）", hostSrc.indexOf("latest: aiChangeSeq") >= 0)
  }

  console.log("\n────────────────────────────────")
  console.log("通过 " + pass + " 项，失败 " + fail + " 项")
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.log("测试自身异常: " + (e && e.stack))
  process.exit(1)
})
