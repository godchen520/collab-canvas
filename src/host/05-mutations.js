// 共享变更逻辑（RPC 与模型工具共用同一套历史栈）
var HISTORY_MAX = 50
function pushHistory(c, before, after, source, version) {
  c.history.push({ opId: 'op-' + Date.now().toString(36) + '-' + (++idSeq), source: source, before: before, after: after, at: Date.now(), version: version })
  if (c.history.length > HISTORY_MAX) c.history.shift()
  c.redoStack.length = 0
}

function createCanvasDoc(title) {
  // 标题净化：AI/导入可能把 "xxx.md" 当标题传入，canvas_save 落盘时会变成
  // "xxx.md.md" 双扩展名文件——这里统一剥掉尾扩展名
  title = String(title || '').replace(/\.(md|markdown)$/i, '') || '未命名话布'
  const id = 'cv-' + Date.now().toString(36) + '-' + (++idSeq)
  const c = { id: id, title: title, type: 'document', content: '', version: 1, filePath: null, history: [], redoStack: [], dirty: true, updatedAt: Date.now() }
  canvases.set(id, c)
  activeId = id
  persistMeta()
  debouncedFlush()
  return c
}

// ═══ AI 改动记录（喂给画布端的「跳过去给我看」）══════════════════════
// 需求（主人 2026-09-15）：AI 改完文档后，画布自动跳到改动处，让主人当场核对。
//
// 为什么要在这里记：applyWrite 是所有改动的必经之路，而且它手里同时握着
// **改前**（before）与**改后**（after）两份完整内容 —— 只有这里才知道"改在哪了"。
//
// 为什么只记 source==='ai'：同一条路还走用户的输入（'human'：界面自动保存、
// 外部回写）。那些是**主人自己**在改，跳给自己看毫无意义，还会打断输入。
// [[CCV-CHANGE-BEGIN]]
var AI_CHANGES_MAX = 20   // 队列上限，防失控（画布端按 seq 增量取，取过的就不再要）
var aiChanges = []
var aiChangeSeq = 0

// 锚点长度。为什么是 40：太短容易在正文里撞到别的地方（撞了就跳错位置），
// 太长则可能横跨被改动的内容 —— 锚点**必须改前改后都存在**才可靠，
// 所以只能从"公共前缀/后缀"里取（那部分逐字相同）。
var ANCHOR_CHARS = 40
// 新内容最多带多少字给画布端。太长对"找地方"没有帮助，只增加传输。
var ADDED_MAX = 160
// 搜索键**最少**几个字。见 widenSpan 的注释：不撑开的话，
// AI 只改一个字时搜索键就只有 1 个字，在全文里太容易撞到别处。
var MIN_SPAN = 8

// 找 before / after 的最长公共前缀与后缀，中间那段就是改动区间。
//
// 为什么不用正经的逐行 diff：AI 改话布绝大多数是**整篇 replace、实际只动几处**，
// 公共前后缀能**精确圈出**那几处。
// 它唯一的偏差是"改动分散在两处以上"时会圈得偏大（从第一处一直圈到最后一处），
// 但那种情况跳过去仍然看得见（跳到第一处），可以接受 —— 先用最简的换最稳的。
function diffSpan(before, after) {
  var p = 0
  var minLen = Math.min(before.length, after.length)
  while (p < minLen && before.charAt(p) === after.charAt(p)) p++
  var s = 0   // 从末尾往前数的公共长度
  var maxS = Math.min(before.length - p, after.length - p)
  while (s < maxS
    && before.charAt(before.length - 1 - s) === after.charAt(after.length - 1 - s)) s++
  return { start: p, end: after.length - s, beforeEnd: before.length - s }
}

// 把改动区间往两边撑开到至少 min 个字。
//
// 🔴 为什么非撑不可（实测踩到的）：公共前后缀算出来的是**最小**区间。
//    「散步」→「跑步」只会圈出「散」→「跑」，因为「步」被算成公共后缀；
//    只换一个字时区间更是只有 1 个字。而画布端是拿这个区间的文字**去全文里找**的
//    —— 1 个字的键到处都能撞上，它会跳到错的地方，主人看到一段没变的文字，
//    还以为 AI 改错了。**我们只需要"跳对地方"，不需要"精确到字"**，
//    所以宁可多圈几个字。
function widenSpan(start, end, len, min) {
  var need = min - (end - start)
  if (need <= 0) return { start: start, end: end }
  var ns = Math.max(0, start - Math.ceil(need / 2))
  var ne = Math.min(len, end + (need - (start - ns)))
  if (ne - ns < min) ns = Math.max(0, ne - min)   // 右边先顶到头了，剩下的额度补给左边
  return { start: ns, end: ne }
}

/**
 * 记一笔「AI 把这篇文档改在哪了」。
 * @returns {object|null} 记录；没变化或出错都返回 null（调用方不关心，静默）
 */
function noteAiChange(c, before, after) {
  try {
    if (before === after) return null        // 内容没变 → 不记，免得画布端白跳一次
    var d = diffSpan(before, after)          // 最小区间（纯计算，别在这里动手脚）
    var w = widenSpan(d.start, d.end, after.length, MIN_SPAN)   // 搜索键要撑开，理由见上
    var rec = {
      seq: ++aiChangeSeq,
      at: Date.now(),
      canvasId: c.id,
      title: c.title,
      version: c.version,
      // 改动点**之前**的文字（取自公共前缀 → 改前改后都在，可靠）
      head: after.slice(Math.max(0, d.start - ANCHOR_CHARS), d.start),
      // 改动点**之后**的文字（取自公共后缀 → 同理）
      tail: after.slice(d.end, d.end + ANCHOR_CHARS),
      // ⚠️ added 是**撑开过**的，它的长度**不等于** addedChars —— 两个数用途不同：
      //    · added      给画布端"去全文里找地方"（越长越不容易撞，见 widenSpan）
      //    · addedChars 报"真实改了几个字"（老实数，给日志和判断用）
      //    别把它们当成同一个数，也别据此以为撑开是 bug。
      added: after.slice(w.start, w.end).slice(0, ADDED_MAX),
      // 规模。注意这里是**最小**改动量，不是撑开后的长度
      removedChars: d.beforeEnd - d.start,
      addedChars: d.end - d.start
    }
    aiChanges.push(rec)
    if (aiChanges.length > AI_CHANGES_MAX) aiChanges.shift()
    return rec
  } catch (e) { return null }                // 记录失败绝不影响写入本身
}
// [[CCV-CHANGE-END]]

function applyWrite(c, content, mode, baseVersion, source) {
  if (typeof baseVersion === 'number' && baseVersion !== c.version) {
    return { conflict: true, currentVersion: c.version, currentContent: c.content }
  }
  const before = c.content
  if (!mode || mode === 'replace') c.content = content
  else if (mode === 'append') c.content = before + content
  else if (mode === 'prepend') c.content = content + before
  else return { badMode: true }
  c.version += 1
  c.dirty = true
  c.updatedAt = Date.now()
  pushHistory(c, before, c.content, source, c.version)
  // 只记 AI 的改动 —— 主人自己打字/自动保存不该触发"跳过去给你看"
  if (source === 'ai') noteAiChange(c, before, c.content)
  debouncedFlush()
  return { version: c.version }
}

async function loadFileDoc(filePath, title) {
  const target = await fs.resolve(filePath)
  let key
  try { key = path.resolve(String(target)) } catch (_) { key = String(target) }
  // ⚠️ 同一文件已经有画布 → 直接复用，绝不再新建一条。
  // 否则每加载一次就多一条指向同一 filePath 的记录，两条各自持有内存内容：
  // 旧的那条是过期的，它一旦保存就把文件覆盖回旧内容 ——
  // 用户以为改好了，实际被静默回滚（2026-09-13 另一会话实测到的重复画布即此）。
  let existing = null
  canvases.forEach(function (x) {
    if (existing || !x.filePath) return
    let k2
    try { k2 = path.resolve(String(x.filePath)) } catch (_) { k2 = String(x.filePath) }
    if (k2 === key) existing = x
  })
  if (existing) {
    activeId = existing.id
    return existing
  }
  const content = await fs.readText(target)
  const id = 'cv-' + Date.now().toString(36) + '-' + (++idSeq)
  const t = title || baseName(filePath).replace(/\.[^.]+$/, '') || 'loaded'
  const c = { id: id, title: t, type: 'document', content: content, version: 1, filePath: filePath, history: [], redoStack: [], dirty: false, updatedAt: Date.now() }
  canvases.set(id, c)
  activeId = id
  persistMeta()
  return c
}

async function setRootDoc(newRoot) {
  const oldBase = docsDirBase()
  rootOverride = newRoot
  let migrated = 0
  for (const c of Array.from(canvases.values())) {
    if (c.filePath && oldBase && c.filePath.indexOf(oldBase) === 0) {
      try {
        const np = joinPath(joinPath(newRoot, 'canvas-docs'), baseName(c.filePath))
        await writeFile(np, c.content)
        c.filePath = np
        migrated++
      } catch (e) { console.error('[collab-canvas] migrate fail:', c.title, e && e.message) }
    }
  }
  await persistMeta()
  return { root: docsDirBase(), migrated: migrated }
}
