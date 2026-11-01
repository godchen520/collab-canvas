// ═══ 选区编辑区的拼接（实施步骤 3）══════════════════════════════════
// 规格：canvas-docs/话布选区编辑区方案.md 第六节 + 实施步骤 3
//   · 纯字符串手术：newDoc = doc[0..偏移] + 编辑区内容 + doc[偏移+长度..]
//   · 落成【一个】撤销步骤（走 applyWrite —— 它自己 push 一条历史）
//   · 本步**先不销毁**编辑区（销毁是第 4 步）
//   · **定位不了就报给主人，不猜、不硬拼**（设计稿第九节：不静默兜底）
//
// ═══ 钩子为什么是 agent/turn-stopping ═══════════════════════════════
// 设计稿写的是 "turn/end"，但 DSH 里**没有**叫 turn/end 的事件（查过事件目录）。
// 对应的是 agent/turn-stopping —— 原话 "The turn is about to close: the model owes
// no response"，而且是 **serial 模式**：会被 await ✓ 正好保证"拼完才关这一轮"。
//
// ═══ 目标 = 本轮【引用到的】编辑区（设计稿第八节）═══════════════════
//   1 条引用 → 改 1 个；N 条 → N 个；0 条 → 不拼（普通聊天）。
//   靠的是与「位置主动注入」**同一套配对**（ccvParseRefs + ccvPinFind + scratchForPin）——
//   两边必须一致，否则"注入说的"和"实际拼的"不是同一个地方 ✗（那正是最坏的情况）。
//
// ⚠️ 一个前提：编辑区必须**在同一个宿主进程里**活着。它是内存对象（不落盘 ✗）——
//    重启就没了 ✓ 这是设计要的（一次性）。重启后引用还在、编辑区没了 → 这里查不到
//    就**什么都不做**（不报错、不猜位置）。

// 报给主人看的痕迹（走 ccvTrace，客户端日志里能看到）
// [[CCV-SPLICE-BEGIN]]
function ccvSpliceTrace(m) { try { ccvTrace('[拼接] ' + m) } catch (_) {} }

// 找这一条引用对应的编辑区（配对口径与注入完全一致）
function ccvScratchForRef(ref, used, remaining) {
  // ⚠️ 这里传的是 ref.quote（可能被「」截短），而 ccvPinFind 接受"上报原文的前缀" ✓
  //    —— 所以不需要再做一次变体解析（注入那边做变体是为了在文档里定位 ✗ 这里不用）。
  var pin = ccvPinFind(ref.path, ref.quote, used, remaining)
  if (!pin) return null
  if (used && used.indexOf(pin) < 0) used.push(pin)
  var area = scratchForPin(pin.code)
  return area ? { area: area, pin: pin } : null
}

// 拼一个编辑区。返回 { ok, why } —— why 是给人看的一句话
function ccvSpliceArea(area) {
  try {
    var b = (area && area.scratch) || {}
    var doc = b.docId ? canvases.get(b.docId) : null
    if (!doc) return { ok: false, why: '主文档不在了（可能被删/改名）' }
    if (b.spliced) return { ok: false, why: '这个编辑区已经拼过了' }

    var cur = String(doc.content || '')
    var orig = String(b.origQuote || '')
    var off = (typeof b.offset === 'number') ? b.offset : -1
    var len = (typeof b.length === 'number') ? b.length : orig.length

    // ── 过期校验（设计稿第十一节：版本 → 指纹 → 序数重定位，失败就报）──
    var why = ''
    var at = -1
    if (off >= 0 && off + len <= cur.length && cur.slice(off, off + len) === orig) {
      at = off                                   // ① 原位还在：直接用
    } else if (orig) {
      // ② 原位不在了 → 按「引文 + 序数」重定位（与建区时同一套算法）
      var hits = occIndexes(cur, orig)
      var ord = (typeof b.ordinal === 'number' && b.ordinal > 0) ? b.ordinal : 0
      if (ord > 0 && ord <= hits.length) { at = hits[ord - 1]; why = '原位已变，按序数重定位到第 ' + ord + ' 处' }
      else if (hits.length === 1) { at = hits[0]; why = '原位已变，全文只剩一处，用它' }
      else if (!hits.length) return { ok: false, why: '这段原文在主文档里已经找不到了（引用失效）' }
      else return { ok: false, why: '这段原文出现 ' + hits.length + ' 次、序数也对不上 —— 分不出该改哪一处，**没有拼**' }
    } else {
      return { ok: false, why: '没有原始引文可比对（老编辑区缺这个字段）' }
    }

    var newDoc = cur.slice(0, at) + String(area.content || '') + cur.slice(at + len)
    if (newDoc === cur) return { ok: false, why: '拼完和原文一样（编辑区没改动）' }

    // 落成**一个**撤销步骤：applyWrite 自己 push 一条历史 ✓
    var res = applyWrite(doc, newDoc, 'replace', doc.version, 'ai')
    if (!res || res.conflict) return { ok: false, why: '版本冲突，没拼' }

    b.spliced = true
    b.splicedAt = Date.now()
    b.splicedVersion = res.version
    return { ok: true, why: why || '原位拼入', doc: doc, at: at, len: len, version: res.version }
  } catch (e) {
    return { ok: false, why: '拼接出错：' + ((e && e.message) || e) }
  }
}

// 这一轮结束时把所有"本轮引用到的"编辑区拼回去
//
// ⚠️ 入口**必须留痕**（2026-10-11 补）：处理函数"没事可做时静默返回"✗，
//    于是"钩子没触发"和"触发了但没活干"在日志里**长得一模一样** ✗ ——
//    主人报"根本没改"时我就是卡在这儿分不清是哪种。只记前几次，不刷屏。
var ccvSpliceFires = 0
async function ccvSpliceTurn(payload) {
  try {
    var fresh = ccvSpliceFires < 5
    if (fresh) {
      ccvSpliceFires++
      ccvSpliceTrace('钩子触发第 ' + ccvSpliceFires + ' 次（turn=' + ((payload && payload.turn !== undefined) ? payload.turn : '?') + '）')
    }
    var agent = payload && payload.agent
    // ⚠️ 没有 agent 也要能走：引用优先从**注入时留下的那份**取（见下），
    //    那条路不需要 agent。只有退回"现解析"时才必须有 agent。
    if (!agent && !(ccvLastTurnRefs && ccvLastTurnRefs.refs && ccvLastTurnRefs.refs.length)) {
      if (fresh) ccvSpliceTrace('既没有 agent、也没有注入时留下的引用，跳过')
      return
    }

    // 🔴 引用从**注入时留下的那份**取，不在轮末重新解析（2026-10-11 实测的坑）：
    //   轮次一开始，队列那条消息就被 claim 走了（'agent/inbox/claimed' ——
    //   "One message left the inbox inside its open turn"），轮末 ccvTurnMsg 只能
    //   退回读「界面」那条 —— 而**它不带引用** ✗。
    //   实测：注入看到 1 条引用 ✓ 拼接看到 0 条 ✗，就卡在这儿。
    var refs = []
    var remainingOf = []
    if (ccvLastTurnRefs && ccvLastTurnRefs.refs && ccvLastTurnRefs.refs.length) {
      refs = ccvLastTurnRefs.refs
      remainingOf = ccvLastTurnRefs.remaining || []
      if (fresh) ccvSpliceTrace('用注入时留下的引用 ' + refs.length + ' 条（来自「' + ccvLastTurnRefs.src + '」）')
    } else {
      var picked = ccvTurnMsg(agent)
      if (!picked) { if (fresh) ccvSpliceTrace('取不到本轮的人消息，跳过'); return }
      refs = ccvParseRefs(picked.text)
      if (fresh) ccvSpliceTrace('没有注入时留下的引用，退回现解析：' + refs.length + ' 条')
      // remaining 的口径必须与注入一致（两条一模一样的引用靠它各归各位）
      for (var a = 0; a < refs.length; a++) {
        var n = 0
        for (var b2 = a; b2 < refs.length; b2++) {
          if (String(refs[a].quote) === String(refs[b2].quote)
            && (refs[a].path || refs[a].title) === (refs[b2].path || refs[b2].title)) n++
        }
        remainingOf.push(n)
      }
    }
    // ★ 读出来就立刻清空 —— 无论后面怎么走（早退 / 失败 / 没配上），
    //   这一轮的引用都不该留给下一轮 ✗（否则下一轮没引用时会拿旧引用乱拼 ✗✗）
    try { ccvLastTurnRefs = null } catch (_) {}
    if (!refs.length) { if (fresh) ccvSpliceTrace('本轮没有引用，跳过'); return }

    // 配到了几个编辑区 —— 留一行痕：万一下一环（配对）出问题，一眼能看到 ✗→✓
    if (fresh) {
      var probe = 0
      var probeUsed = []
      for (var pi = 0; pi < refs.length && pi < 3; pi++) {
        if (ccvScratchForRef(refs[pi], probeUsed, remainingOf[pi] || 1)) probe++
      }
      ccvSpliceTrace('引用 ' + refs.length + ' 条，其中配到编辑区 ' + probe + ' 个'
        + (probe ? '' : '（配不上 → 检查 pinCode 绑定）'))
    }

    // ── 先把「引用 ↔ 编辑区」全配好（**配对口径不能乱** ✗）──────────────
    // 配对必须按引用在消息里的顺序做（第 N 条引用 ↔ 第 N 笔上报，见 ccvPinFind ✓），
    // 但**拼接的顺序不能跟着它** —— 见下面的排序。
    var used = []
    var jobs = []
    for (var i = 0; i < refs.length && i < 3; i++) {
      var hit = ccvScratchForRef(refs[i], used, remainingOf[i])
      if (!hit) continue                    // 这一条引用没开过编辑区 → 不拼（普通引用）
      var sb = hit.area.scratch || {}
      jobs.push({
        area: hit.area,
        off: (typeof sb.offset === 'number') ? sb.offset : -1,
        docId: sb.docId || '',
      })
    }

    // ★ 设计稿第 5 步的「串行」（2026-10-11 补）：**同一篇文档里多个编辑区，
    //   按偏移从大到小拼** ✓
    //   为什么必须这样：拼接是"换掉文档 [偏移, 偏移+长度) 那一段"，
    //   先拼**前面**那个会让**后面**那个的偏移整体前移/后移 ✗ ——
    //   接着拼第二个时，"原位那段还在吗"的校验会失败 ✗，然后退回按序数重定位；
    //   而序数是"这段文字第几次出现"——第一个区已经被换掉了，计数跟着变 ✗
    //   → 可能重定位到**错误的**那一处，静默改错地方 ✗✗
    //   从大到小拼就没有这个问题：动后面那一段，不影响前面任何偏移 ✓
    jobs.sort(function (a, b) { return b.off - a.off })

    var tried = 0
    var done = 0
    var failed = []
    for (var j = 0; j < jobs.length; j++) {
      var area = jobs[j].area
      tried++
      var r = ccvSpliceArea(area)
      if (r.ok) {
        done++
        ccvSpliceTrace('拼入《' + (r.doc ? r.doc.title : '?') + '》第 ' + r.at + ' 字处（'
          + r.len + ' 字 → ' + String(area.content || '').length + ' 字），'
          + r.why + '，现在 v' + r.version)
        // ★ 第 4 步：拼接成功 → **立刻销毁**编辑区（设计稿第四节：一次性对象，全自动）
        //   它是内存对象（不落盘 ✓），删掉即消失 ✓ 主人不需要做任何操作 ✓
        //   ⚠️ 只在**成功**时销毁：失败时留着 —— 第九节是"报给主人"，不是"偷偷丢掉证据" ✗
        try {
          canvases.delete(area.id)
          ccvSpliceTrace('编辑区 ' + area.id + ' 已销毁（一次性对象）')
        } catch (_) {}
      } else {
        failed.push(r.why)
        ccvSpliceTrace('没拼：' + r.why + '（编辑区 ' + area.id + ' 留着）')
      }
    }
    // 用掉就清空 —— 现在改成"读出来就清"（见上），这里不再重复。
    // 失败也清：设计稿第九节是"报给主人"，不是"下轮偷偷重试" ✓
    if (!tried) return
    if (failed.length) {
      // ⚠️ 设计稿第九节：**不静默兜底** —— 定位不了就报给主人
      try {
        console.warn('[collab-canvas] 选区编辑区未拼入：' + failed.join('；'))
      } catch (_) {}
    }
    ccvSpliceTrace('本轮结束：引用 ' + refs.length + ' 条，带编辑区 ' + tried + ' 个，拼入 ' + done
      + ' 个' + (failed.length ? '，没拼 ' + failed.length + ' 个' : ''))
  } catch (e) {
    try { console.error('[collab-canvas] scratch splice failed:', e && e.message) } catch (_) {}
  }
}

// 注册成宿主事件监听。
//
// 🔴 为什么注册在 **ctx.root** 而不是插件自己的 ctx（2026-10-11 实测定位）：
//   作用域是一棵树 ——
//        根
//        ├── 插件 ctx（我们的插件挂在 profile 级，是**兄弟分支**）
//        └── 会话 / agent 作用域  ← agent/turn-stopping 从这里派发
//   事件只往上冒到**祖先** ✓，兄弟分支收不到 ✗ —— 所以挂在自己的 ctx 上**一次都不会触发**
//   （实测：注册留痕在 ✓ 但"钩子触发"一行都没有 ✗）。
//   官方那些插件能收到，是因为它们挂在**会话作用域**里（agent preset 内）；我们不是，
//   所以必须显式挂到根上。
//
// 注册处**必须留痕**：主人报"根本没改"时，我分不清
//   ① 跑着的宿主里有没有这个模块（重启了没）
//   ② 有模块、但事件没触发
// 两者表现**一模一样** ✗。留一行痕就一眼分得清。
//
// 两个钩子都挂（重复触发是安全的：编辑区上有 `spliced` 标记，拼过的不会再拼 ✓）：
//   · agent/turn-stopping —— 语义最准（"这一轮就要关了"），serial 模式会被 await ✓
//   · agent/status → idle —— 兜底
try {
  var evCtx = (ctx && ctx.root) ? ctx.root : ctx
  var onRoot = !!(ctx && ctx.root && evCtx === ctx.root)
  if (evCtx && typeof evCtx.on === 'function') {
    // ★ 主力：官方的**持久事件流**（post-commit），turn/end 是轮末的权威信号。
    //   抄的是官方插件 dsh-workspace-changes 的写法（它干的正是"一轮结束后收尾"）。
    //   为什么它比 agent/turn-stopping 可靠：
    //     · 它是**持久**事件 —— 不依赖收件箱那条消息还在不在（那条会被 claim 走 ✗）
    //     · 它带 turn 号 —— 出问题时能对着会话日志查
    evCtx.on('session/event', function (session, event) {
      try {
        if (!event || event.type !== 'turn/end') return
        var turn = (event.data && event.data.turn !== undefined) ? event.data.turn : '?'
        if (ccvSpliceFires < 5) ccvSpliceTrace('session/event: turn/end（turn=' + turn + '）→ 触发拼接')
        return ccvSpliceTurn({ session: session, turn: turn, fromSessionEvent: true })
      } catch (_) {}
    })
    // 次选：agent 侧那两个（语义也准，但实测依赖收件箱/作用域，容易哑火）
    evCtx.on('agent/turn-stopping', ccvSpliceTurn)
    evCtx.on('agent/status', function (payload) {
      try {
        if (payload && payload.status === 'idle') return ccvSpliceTurn(payload)
      } catch (_) {}
    })
    ccvSpliceTrace('已注册（挂到 ' + (onRoot ? 'ctx.root ✓' : '插件自己的 ctx ✗ 收不到 agent 事件')
      + '；主力 session/event:turn/end + 次选 agent/turn-stopping、agent/status:idle）—— 模块已加载')
    console.log('[collab-canvas]', 'scratch splice registered on ' + (onRoot ? 'ctx.root' : 'own ctx'))
  } else {
    ccvSpliceTrace('没注册上：ctx.on 不可用')
    console.error('[collab-canvas] ctx.on 不可用，编辑区拼接没注册上')
  }
} catch (e) {
  ccvSpliceTrace('注册失败：' + ((e && e.message) || e))
  console.error('[collab-canvas] scratch splice register failed:', e && e.message)
}
// [[CCV-SPLICE-END]]
