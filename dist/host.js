// DSH Collab-Canvas · host bundle — GENERATED — DO NOT EDIT
// 改源码 src/host/*.js 后重新构建：node tools/build.cjs
import { defineTool } from "@deepseek-ai/dsh-tools"
import nodefs from "node:fs"
import path from "node:path"
import { exec, execFile, spawn } from "node:child_process"
export const name = 'collab-canvas-host'
export const inject = ["timer","tools","fs","webServer","systemPrompt"]
export function apply(ctx, config) {

    // ==================== 00-ctx.js ====================
// 上下文服务引用（模块共享）——composition 插件用 injected 服务
const fs = ctx.fs
const policy = ctx.get('sandboxPolicy')  // 可选服务，未注入时可能 undefined

    // ==================== 01-utils.js ====================
// 通用工具函数
function joinPath(a, b) {
  return String(a || '.').replace(/[\\/]+$/, '') + '/' + b
}
function baseName(p) {
  const s = String(p)
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(i + 1) : s
}
function slugify(title) {
  const s = String(title || '').replace(/[\\/:*?"<>|#%]+/g, '').trim().replace(/\s+/g, '-')
  return s || 'untitled'
}
function err(code, message) { return { ok: false, error: { code: code, message: message } } }

    // ==================== 03-state.js ====================
// 画布注册表状态 + 存储根多级探测
var canvases = new Map()   // id -> {id,title,type,content,version,filePath,history[],redoStack[],dirty,updatedAt}
var activeId = null
var idSeq = 0
var rootOverride = null   // 用户显式固定的存储根（持久化于 meta）

// 插件自己的用户级目录。**关键性质：与 DSH 无关。**
// 为什么必须有它：DSH 升级可能把 sessions / workspaceRegistry / policy.workspaceRoot
// **全部**改指向新的默认工作区 —— 2026-09-28 实测升级后三个源都变成
// ~/.zcode/workspace/default，于是 meta 的两个候选位置里都不再包含真正的存储根，
// restore 读不到 rootOverride，插件当成"首次运行"在错误目录里新建了一份空的。
// 只有这里不受影响，所以它同时是①存储根彻底探测不到时的兜底、
// ②meta 的第三个落点（见 04-persistence 的 metaTargets）。
function userHome() {
  return (typeof process !== 'undefined' && process.env
    && (process.env.USERPROFILE || process.env.HOME)) || ''
}
function fallbackBase() {
  const home = userHome()
  return home ? joinPath(home, '.dsh-collab-canvas') : '.'
}
function fallbackDocsDir() { return joinPath(fallbackBase(), 'canvas-docs') }

function docsDirBase() {
  // 多级探测：显式覆盖 > 活跃会话 cwd > workspace 注册表 > 部署根兜底
  if (rootOverride) return rootOverride
  try {
    const svc = ctx.get('sessions')
    const arr = svc && svc.list ? svc.list() : []
    for (const s of arr) {
      const holder = s && (s.header || s.meta || s)
      const cwd = holder && holder.cwd
      if (typeof cwd === 'string' && cwd.length > 2) return cwd
    }
  } catch (e) { console.error('[collab-canvas] session-cwd probe failed:', e && e.message) }
  try {
    const reg = ctx.get('workspaceRegistry')
    const list = reg && reg.list ? reg.list() : []
    if (list[0] && typeof list[0].path === 'string' && list[0].path.length > 2) return list[0].path
  } catch (e) { console.error('[collab-canvas] workspace-registry probe failed:', e && e.message) }
  if (policy !== undefined && policy.workspaceRoot) return policy.workspaceRoot
  // ⚠️ 兜底绝不能用 '.'（进程 cwd）：DSH 的 cwd 可能就在它自己的安装目录里。
  // 实测 2026-09-12 20:28 落到 node_modules/@deepseek-ai/dsh/lib —— 插件把
  // file-registry.json 和 canvas-docs/.canvases.json 写进了 DSH 的包目录。
  // 改用一个稳定的、与 DSH 无关的用户级目录。
  const fallback = fallbackBase()
  console.error('[collab-canvas] 存储根探测全部失败（sessions / workspaceRegistry / policy 都不可用），'
    + '退到兜底目录:', fallback, '——请检查会话工作区是否正常')
  return fallback
}
function docsDir() { return joinPath(docsDirBase(), 'canvas-docs') }
function metaPath() { return joinPath(docsDir(), '.canvases.json') }

// 画布对应的 md 文件「真实路径」（绝对、正斜杠）。
// filePath 为空时按存储根 + slugify(标题) 推算（与 saveCanvas 的落盘规则一致）。
//
// ⚠️ 别再让调用方自己拼 "canvas-docs/<标题>.md"：那是**相对**路径，只有当
//    「会话工作区 == 存储根」时才成立。存储根被 canvas_configure 固定到别处后
//    （rootOverride），它指向的是工作区里的残留目录 —— 文件根本不在那儿。
//    2026-09-14 另一会话据此报过一次「引用给出的路径不存在」。
function canvasMdPath(c) {
  if (!c) return ''
  let p = c.filePath
  if (!p) { try { p = joinPath(docsDir(), slugify(c.title) + '.md') } catch (_) { p = '' } }
  return String(p).replace(/\\/g, '/')
}

    // ==================== 04-persistence.js ====================
// 持久化：多策略沙箱写入、保存（含认可区回退）、meta 双写、防抖冲刷、启动恢复
function candidatePolicies() {
  const list = []
  list.push({ tag: 'literal-danger', ep: { mode: 'danger-full-access' } })
  try {
    const r = policy && typeof policy.resolve === 'function' ? policy.resolve({ mode: 'danger-full-access' }) : null
    if (r) list.push({ tag: 'resolve-danger', ep: r })
  } catch (e) { console.error('[collab-canvas] resolve({mode}) rejected:', e && e.message) }
  try {
    const r2 = policy && typeof policy.resolve === 'function' ? policy.resolve({}) : null
    if (r2) list.push({ tag: 'resolve-default', ep: r2 })
  } catch (_) { /* ignore */ }
  list.push({ tag: 'bare', ep: null })
  return list
}

async function writeFile(path, content) {
  if (!fs) throw new Error('fs 服务不可用')
  const target = await fs.resolve(path)
  let lastErr = null
  for (const cand of candidatePolicies()) {
    try {
      if (cand.ep) await fs.writeText(target, content, undefined, undefined, cand.ep)
      else await fs.writeText(target, content)
      console.log('[collab-canvas]', 'write ok via', cand.tag, '->', path)
      return true
    } catch (e) {
      lastErr = e
      console.error('[collab-canvas]', 'write fail via', cand.tag, ':', e && e.message)
    }
  }
  throw lastErr || new Error('写入失败')
}

function sanctionedDocsDir() {
  return joinPath((policy !== undefined && policy.workspaceRoot) ? policy.workspaceRoot : '.', 'canvas-docs')
}

// meta 的落点清单。**persistMeta 与 restore 必须用同一份** ——
// 两边各写一份清单，一旦漂移就会出现「写进去了，但冷启动读不到」这种最难查的故障。
//
// 第三个落点（用户级、与 DSH 无关）是 2026-09-28 补的：
// DSH 升级后 sessions / workspaceRegistry / policy.workspaceRoot **全部**改指向
// ~/.zcode/workspace/default，前两个落点里都不再包含真正的存储根，
// 于是 rootOverride 读不回来、插件在错误目录里当成首次运行。
// 加了它之后，DSH 再怎么换默认工作区，rootOverride 都还在。
function metaTargets() {
  const list = [metaPath(), joinPath(sanctionedDocsDir(), '.canvases.json')]
  try {
    const f = fallbackDocsDir()
    if (f && f !== '.') {
      const p = joinPath(f, '.canvases.json')
      if (list.indexOf(p) < 0) list.push(p)
    }
  } catch (_) { /* 拿不到 home 就只用前两个 */ }
  return list
}

async function saveCanvas(c, filePath) {
  const primary = filePath || c.filePath || joinPath(docsDir(), slugify(c.title) + '.md')
  try {
    await writeFile(primary, c.content)
    c.filePath = primary
    c.dirty = false
    return { path: primary, relocated: false }
  } catch (e) {
    // 显式指定路径失败不静默改道；默认目录被拒则回退到沙箱认可区
    if (filePath || c.filePath) throw e
    const p2 = joinPath(sanctionedDocsDir(), slugify(c.title) + '.md')
    await writeFile(p2, c.content)
    c.filePath = p2
    c.dirty = false
    return { path: p2, relocated: true }
  }
}

async function persistMeta() {
  const payload = JSON.stringify({ activeId: activeId, rootOverride: rootOverride, canvases: Array.from(canvases.values()).map(function (c) {
    return { id: c.id, title: c.title, type: c.type, filePath: c.filePath }
  }) }, null, 2)
  // 同步写所有候选位置：冷启动时无论读到哪一份都带 rootOverride
  const targets = metaTargets()
  let okCount = 0
  for (const mp of targets) {
    try { await writeFile(mp, payload); okCount++ } catch (e) { console.error('[collab-canvas] meta persist miss:', mp, e && e.message) }
  }
  if (!okCount) console.error('[collab-canvas] meta persist failed at all locations')
}

// 所有落盘**串成一条链**。为什么必须串：
//   `saveCanvas` 是 async，写的是 c.content。两次写并发时，如果「第二次先完成、
//   第一次后完成」，文件最后会停在**旧内容**上 —— 而且两边都报成功，没人会发现。
//   串起来之后一次只写一个，顺序就是调用顺序。
// 返回的还是**原始** promise（调用方仍能 catch 到失败），只是把链接续上了 ——
// 链本身不因某一次失败而断掉，后面的写该发还得发。
var saveChain = Promise.resolve()
function saveSerial(c) {
  var p = saveChain.then(function () { return saveCanvas(c) })
  saveChain = p.then(function () {}, function () {})
  return p
}

async function flushDirty() {
  const dirty = []
  canvases.forEach(function (c) { if (c.dirty) dirty.push(c) })
  let failed = 0
  for (const c of dirty) {
    try { await saveSerial(c) } catch (e) { failed++; console.error('[collab-canvas] autosave failed:', c.title, e.message) }
  }
  if (dirty.length > failed) persistMeta()
}
const debouncedFlush = ctx.debounce(function () { flushDirty() }, 1500)
ctx.effect(function () { return function () { flushDirty() } }, 'final-flush')

async function restore() {
  if (!fs) { console.error('[collab-canvas]', 'fs service unavailable — persistence disabled'); return }
  const metaCandidates = metaTargets()
  const metas = []
  for (const mp of metaCandidates) {
    try {
      const raw = await fs.readText(await fs.resolve(mp))
      metas.push(JSON.parse(raw))
      console.log('[collab-canvas]', 'meta found at', mp)
    } catch (e) { /* try next */ }
  }
  // 多份 meta 并存时，优先采信带 rootOverride 的那份
  const meta = metas.find(function (m) { return m && typeof m.rootOverride === 'string' && m.rootOverride.length > 2 }) || metas[0] || null
  if (!meta) { console.log('[collab-canvas]', 'no previous meta (first run)'); return }
  try {
    if (typeof meta.rootOverride === 'string' && meta.rootOverride.length > 2) rootOverride = meta.rootOverride
    // 兜底去重：历史 meta 里可能已经存了「同一文件挂多条记录」。
    // 两条记录各自持有内存内容，过期的旧记录一旦保存就会把文件覆盖回去，
    // 所以恢复阶段就要把重复挡掉（按归一化后的 filePath 判重，先到先得）。
    const seenFiles = new Set()
    let skippedDup = 0
    for (const m of meta.canvases || []) {
      if (m.filePath) {
        let key
        try { key = path.resolve(String(m.filePath)) } catch (_) { key = String(m.filePath) }
        if (seenFiles.has(key)) {
          skippedDup++
          console.error('[collab-canvas] restore: 跳过重复文件记录', m.id, '->', m.filePath)
          continue
        }
        seenFiles.add(key)
      }
      let content = ''
      if (m.filePath) {
        try { content = await fs.readText(await fs.resolve(m.filePath)) }
        catch (e) { console.error('[collab-canvas] restore miss:', m.filePath, e.message); continue }
      }
      canvases.set(m.id, {
        id: m.id, title: m.title, type: m.type || 'document', content: content,
        version: 1, filePath: m.filePath || null, history: [], redoStack: [],
        dirty: false, updatedAt: Date.now(),
      })
    }
    if (skippedDup) console.error('[collab-canvas] restore: 共跳过', skippedDup, '条重复记录')
    activeId = meta.activeId && canvases.has(meta.activeId) ? meta.activeId : (meta.canvases && meta.canvases[0] && meta.canvases[0].id) || null
    console.log('[collab-canvas]', 'restored', canvases.size, 'canvas(es), root =', docsDirBase())
    // 自愈：本次若是从别的落点读到 rootOverride，立刻把 meta 写回**全部**落点。
    // 否则那几份仍停在旧根上，下次探测顺序一变又会被带偏。
    // 失败不致命（本次内存里的根已经是对的），所以只记日志。
    if (typeof meta.rootOverride === 'string' && meta.rootOverride.length > 2) {
      try { await persistMeta() } catch (e) { console.error('[collab-canvas] restore 后回写 meta 失败:', e && e.message) }
    }
  } catch (e) {
    console.log('[collab-canvas]', 'restore failed:', e.message)
  }
}

    // ==================== 05-mutations.js ====================
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
  if (source === 'ai') {
    noteAiChange(c, before, c.content)
    // 🔴 AI 的改动**立刻落盘**，不等那 1.5 秒防抖。
    // 为什么要区别对待：防抖是为「人在连续打字」准备的（合并成一次写），
    // 而 AI 一次改动就是一次，没有可合并的东西，等 1.5 秒只有坏处 ——
    // 主人改完马上去看磁盘、或让别的工具读这个文件，看到的还是上一版，
    // 会以为「根本没写进去」（2026-09-15 实测报告过）。这是**静默的误导**。
    // 失败不影响内存结果（内存里已经是新内容），防抖那次还会兜底重试一遍。
    saveSerial(c).then(function () { return persistMeta() }).catch(function (e) {
      console.error('[collab-canvas] ai 立即落盘失败（防抖那次会重试）:', c.title, e && e.message)
    })
  }
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

    // ==================== 06-rpc.js ====================
// Client→Host 包级私有 RPC（composition 无 harness 沙箱，仅动态系统存在）
// Phase 1（纯 Host 工具）跳过这些 RPC；若 harness 存在则注册（Phase 2 WYSIWYG 用）
if (typeof harness !== 'undefined') {
harness.handle('canvas.list', async function () {
  const arr = []
  canvases.forEach(function (c) {
    arr.push({ id: c.id, title: c.title, type: c.type, updatedAt: c.updatedAt, hasFile: !!c.filePath })
  })
  return { ok: true, canvases: arr, activeId: activeId, docsDir: docsDir() }
})

harness.handle('canvas.create', async function (args) {
  const title = args && typeof args.title === 'string' && args.title.trim()
  if (!title) return err('E_BAD_ARGS', '需要非空 title')
  const c = createCanvasDoc(title)
  return { ok: true, id: c.id }
})

harness.handle('canvas.open', async function (args) {
  const c = canvases.get(args && args.canvasId)
  if (!c) return err('E_NOT_FOUND', '画布不存在')
  activeId = c.id
  return { ok: true, id: c.id, title: c.title, type: c.type, content: c.content, version: c.version, filePath: c.filePath }
})

harness.handle('canvas.edit', async function (args) {
  const c = canvases.get(args && args.canvasId)
  if (!c) return err('E_NOT_FOUND', '画布不存在')
  if (typeof args.content !== 'string') return err('E_BAD_ARGS', 'content 必须是字符串')
  const r = applyWrite(c, args.content, 'replace', typeof args.baseVersion === 'number' ? args.baseVersion : undefined, 'human')
  if (r.conflict) return Object.assign(err('E_CONFLICT', '版本冲突：服务端已是 v' + r.currentVersion), { currentVersion: r.currentVersion, currentContent: r.currentContent })
  let othersAfter = 0
  if (typeof args.knownVer === 'number') {
    for (const h of c.history) {
      if (h.source === 'ai' && typeof h.version === 'number' && h.version > args.knownVer) othersAfter++
    }
  }
  return { ok: true, version: r.version, othersAfter: othersAfter }
})

harness.handle('canvas.undo', async function (args) {
  const c = canvases.get(args && args.canvasId)
  if (!c) return err('E_NOT_FOUND', '画布不存在')
  if (!c.history.length) return { ok: true, noop: true }
  const rec = c.history.pop()
  c.redoStack.push(rec)
  c.content = rec.before
  c.version += 1
  c.dirty = true
  c.updatedAt = Date.now()
  debouncedFlush()
  return { ok: true, content: c.content, version: c.version }
})

harness.handle('canvas.redo', async function (args) {
  const c = canvases.get(args && args.canvasId)
  if (!c) return err('E_NOT_FOUND', '画布不存在')
  if (!c.redoStack.length) return { ok: true, noop: true }
  const rec = c.redoStack.pop()
  c.history.push(rec)
  c.content = rec.after
  c.version += 1
  c.dirty = true
  c.updatedAt = Date.now()
  debouncedFlush()
  return { ok: true, content: c.content, version: c.version }
})

harness.handle('canvas.save', async function (args) {
  const c = canvases.get(args && args.canvasId)
  if (!c) return err('E_NOT_FOUND', '画布不存在')
  if (!fs) return err('E_IO', 'fs 服务不可用，无法保存')
  try {
    const r = await saveCanvas(c, args && args.filePath)
    persistMeta()
    return { ok: true, filePath: r.path, relocated: r.relocated }
  } catch (e) {
    return err('E_IO', '写入失败：' + e.message)
  }
})

harness.handle('canvas.loadFile', async function (args) {
  const p = args && args.filePath
  if (!p || typeof p !== 'string') return err('E_BAD_ARGS', '需要 filePath')
  if (!fs) return err('E_IO', 'fs 服务不可用')
  try {
    const c = await loadFileDoc(p, args && args.title)
    return { ok: true, canvasId: c.id, title: c.title }
  } catch (e) {
    return err(e.message.indexOf('ENOENT') >= 0 ? 'E_NOT_FOUND' : 'E_IO', '读取失败：' + e.message)
  }
})

harness.handle('canvas.getRoot', async function () {
  return { ok: true, root: docsDirBase(), override: rootOverride, docsDir: docsDir() }
})

harness.handle('canvas.setRoot', async function (args) {
  const r = args && typeof args.root === 'string' ? args.root.trim() : ''
  if (r.length < 3) return err('E_BAD_ARGS', '需要有效的 root 目录绝对路径')
  try {
    const out = await setRootDoc(r)
    return { ok: true, root: out.root, migrated: out.migrated }
  } catch (e) {
    return err('E_IO', '设置失败：' + e.message)
  }
})

harness.handle('canvas.delete', async function (args) {
  const c = canvases.get(args && args.canvasId)
  if (!c) return err('E_NOT_FOUND', '画布不存在')
  canvases.delete(c.id)
  if (activeId === c.id) {
    const first = canvases.keys().next()
    activeId = first.done ? null : first.value
  }
  await persistMeta()
  return { ok: true, activeId: activeId, note: '文件保留在磁盘' + (c.filePath ? '：' + c.filePath : '（未落盘）') + '，可手动清理' }
})
}

    // ==================== 07-tools.js ====================
// 模型可见动态工具（execute 直调 store，写入标记 source:'ai'）
function toolOutput(v) { return JSON.stringify(v) }
function resolveCanvas(args) {
  const id = args && args.canvasId ? args.canvasId : activeId
  const c = id ? canvases.get(id) : undefined
  if (!c) return { error: err('E_NOT_FOUND', '未找到目标画布' + (id ? '：' + id : '（当前无活跃画布，可先 canvas_create）')) }
  return { c: c }
}

ctx.tools.register(defineTool({
  name: 'canvas_list',
  description: '列出共创话布（DSH 画布插件）中的全部画布及当前活跃画布。当用户提到"画布/共创话布/话布/canvas"时先调用它了解现状。',
  parameters: {},
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function () {
    const arr = []
    canvases.forEach(function (c) { arr.push({ id: c.id, title: c.title, type: c.type, version: c.version, chars: c.content.length, hasFile: !!c.filePath }) })
    return toolOutput({ ok: true, activeId: activeId, canvases: arr, docsDir: docsDir(), hint: '需要新画布用 canvas_create；读取内容用 canvas_read。' })
  },
}))

ctx.tools.register(defineTool({
  name: 'canvas_create',
  description: '新建一个 Markdown 文档画布并设为活跃画布。用户说"开个新画布写XX/在共创话布上起草XX"时调用。',
  parameters: { title: { type: 'string', required: true, description: '画布标题，同时用作默认文件名' } },
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function (args) {
    const title = args && typeof args.title === 'string' && args.title.trim()
    if (!title) return toolOutput(err('E_BAD_ARGS', 'title 必须为非空字符串'))
    const c = createCanvasDoc(title)
    // 会话清单登记：AI 建的画布归入浏览器最近在看的会话清单（面板轮询可见）
    try { sessAdd(lastBrowserSid, c.id) } catch (_) {}
    return toolOutput({ ok: true, canvasId: c.id, title: title, hint: '已创建并设为活跃画布，接着可用 canvas_write 写入内容。本轮结束前记得调用 present 声明 "canvas-docs/' + slugify(c.title) + '.md"——它会在回复末尾生成一张可点卡片，点开就是话布面板。' })
  },
}))

ctx.tools.register(defineTool({
  name: 'canvas_read',
  description: '读取一个画布的标题与完整 Markdown 内容（含版本号）。写入前务必先读；用户问"画布里有什么"也用它。',
  parameters: {
    canvasId: { type: 'string', description: '画布 id，缺省读活跃画布' },
    head: { type: 'number', description: '只返回前 N 个字符（大文档粗看用）' },
  },
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function (args) {
    const r = resolveCanvas(args)
    if (r.error) return toolOutput(r.error)
    let content = r.c.content
    if (args && typeof args.head === 'number' && args.head > 0 && content.length > args.head) {
      content = content.slice(0, args.head) + '…(截断，共 ' + r.c.content.length + ' 字符)'
    }
    return toolOutput({ ok: true, canvasId: r.c.id, title: r.c.title, version: r.c.version, content: content })
  },
}))

ctx.tools.register(defineTool({
  name: 'canvas_write',
  description: '向画布写入 Markdown 内容（AI 编辑直接生效，用户可撤销）。replace 需先 canvas_read 取最新 baseVersion 强一致检查；append/prepend 无需 baseVersion。',
  parameters: {
    content: { type: 'string', required: true, description: '要写入的 Markdown 文本' },
    mode: { type: 'string', description: "写入模式：'replace'(默认整文替换) | 'append' 追加到末尾 | 'prepend' 插入开头" },
    canvasId: { type: 'string', description: '画布 id，缺省写活跃画布' },
    baseVersion: { type: 'number', description: '期望的当前版本号；与服务端不符将拒绝以防覆盖他人修改' },
  },
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function (args) {
    if (!args || typeof args.content !== 'string') return toolOutput(err('E_BAD_ARGS', 'content 必须为字符串'))
    const mode = args.mode || 'replace'
    const r = resolveCanvas(args)
    if (r.error) return toolOutput(r.error)
    const w = applyWrite(r.c, args.content, mode, typeof args.baseVersion === 'number' ? args.baseVersion : undefined, 'ai')
    if (w.badMode) return toolOutput(err('E_BAD_ARGS', "mode 仅支持 'replace'|'append'|'prepend'"))
    if (w.conflict) return toolOutput(Object.assign(err('E_CONFLICT', '版本冲突：服务端已是 v' + w.currentVersion + '，请先 canvas_read 再重试'), { currentVersion: w.currentVersion }))
    return toolOutput({ ok: true, canvasId: r.c.id, title: r.c.title, version: w.version, mode: mode, hint: '已写入画布「' + r.c.title + '」v' + w.version + '，用户可撤销。内容约 1.5 秒后自动落盘。本轮结束前记得调用 present 声明 "canvas-docs/' + slugify(r.c.title) + '.md"——它会在回复末尾生成一张可点卡片，点开就是话布面板。' })
  },
}))

ctx.tools.register(defineTool({
  name: 'canvas_save',
  description: '立即保存画布到文件（自动保存之外的手动落盘）。首次保存外部项目文件或用户明说"保存"时调用。',
  parameters: {
    canvasId: { type: 'string', description: '画布 id，缺省保存活跃画布' },
    filePath: { type: 'string', description: '目标文件路径；缺省用已关联路径或 <workspace>/canvas-docs/<标题>.md' },
  },
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function (args) {
    const r0 = resolveCanvas(args)
    if (r0.error) return toolOutput(r0.error)
    try {
      const r = await saveCanvas(r0.c, args && args.filePath)
      persistMeta()
      return toolOutput({ ok: true, canvasId: r0.c.id, filePath: r.path, relocated: r.relocated, hint: r.relocated ? '注意：目标目录被文件沙箱拒绝，内容已保存到沙箱认可区 ' + r.path : '已保存。' })
    } catch (e) {
      return toolOutput(err('E_IO', '写入失败：' + e.message))
    }
  },
}))

ctx.tools.register(defineTool({
  name: 'canvas_load',
  description: '把一个已有的本地 Markdown 文件加载为新画布（如打开项目里的 README/方案文档进行协作改写）。',
  parameters: {
    filePath: { type: 'string', required: true, description: '文件绝对路径' },
    title: { type: 'string', description: '画布标题，缺省用文件名' },
  },
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function (args) {
    const p = args && args.filePath
    if (!p || typeof p !== 'string') return toolOutput(err('E_BAD_ARGS', 'filePath 必须为字符串'))
    try {
      const c = await loadFileDoc(p, args && args.title)
      // 会话清单登记：AI 加载的文档归入浏览器最近在看的会话清单（面板轮询可见）
      try { sessAdd(lastBrowserSid, c.id) } catch (_) {}
      return toolOutput({ ok: true, canvasId: c.id, title: c.title, chars: c.content.length, hint: '已加载为画布并设为活跃。' })
    } catch (e) {
      return toolOutput(err(e.message.indexOf('ENOENT') >= 0 ? 'E_NOT_FOUND' : 'E_IO', '读取失败：' + e.message))
    }
  },
}))

ctx.tools.register(defineTool({
  name: 'canvas_configure',
  description: '查询或固定共创话布插件的存储根目录。传入 root 则固定（自动迁移已有画布文件并持久化），不传则仅查询当前生效目录。用户要求"把画布存到XX目录"时调用。',
  parameters: {
    root: { type: 'string', description: '要固定的存储根目录绝对路径；缺省仅查询' },
  },
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function (args) {
    if (args && typeof args.root === 'string' && args.root.trim().length > 2) {
      try {
        const out = await setRootDoc(args.root.trim())
        return toolOutput({ ok: true, root: out.root, migrated: out.migrated, hint: '存储根已固定并持久化，迁移了 ' + out.migrated + ' 个画布文件。' })
      } catch (e) {
        return toolOutput(err('E_IO', '设置失败：' + e.message))
      }
    }
    return toolOutput({ ok: true, root: docsDirBase(), docsDir: docsDir(), hint: '当前存储根如上；传 root 参数可固定到其他目录。' })
  },
}))

ctx.tools.register(defineTool({
  name: 'canvas_delete',
  description: '删除一个画布记录（内存 + meta 落盘）。删除后文件保留在磁盘可手动清理；用户说"删除/清理某个画布"时调用。',
  parameters: {
    canvasId: { type: 'string', required: true, description: '要删除的画布 id（来自 canvas_list）' },
  },
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function (args) {
    const id = args && typeof args.canvasId === 'string' ? args.canvasId : ''
    if (!id) return toolOutput(err('E_BAD_ARGS', 'canvasId 必须为字符串'))
    const c = canvases.get(id)
    if (!c) return toolOutput(err('E_NOT_FOUND', '画布不存在：' + id))
    canvases.delete(id)
    if (activeId === id) {
      const first = canvases.keys().next()
      activeId = first.done ? null : first.value
    }
    try { await persistMeta() } catch (e) { console.error('[collab-canvas] delete persist failed:', e.message) }
    return toolOutput({ ok: true, canvasId: id, activeId: activeId, note: '文件保留在磁盘' + (c.filePath ? '：' + c.filePath : '（未落盘）') + '，可手动清理' })
  },
}))

// ═══ canvas_locate：把「这段原文到底是哪一处」讲清楚 ═══════════════
// 为什么要有它（2026-09-14 主人拍板）：
//   @话布选区 的引用本身只有「路径 + 行号 + 原文」两行。同一段原文在文档里
//   出现多次时，**模型没法只凭行号认出是哪一处** —— 而把"前后文坐标"塞进
//   引用正文既长又难读（主人原话：不够优雅），模型照样得自己数。
//   所以改成"模型按需来问"：它想问的时候问一次，我们当场算给它。
// 顺带的好处：这里读的是**当前**文档，所以"这段引用是不是已经失效"也一并答了。
//
// [[CCV-LOCATE-BEGIN]] —— 下面到 END 之间是这块功能的全部代码。
//   tools/test-host-locate.cjs 靠这两个标记把这段**真代码**切出来单独跑，
//   不是照抄一份来测。挪动或删除标记会让那份测试失效。
function occIndexes(text, needle) {
  const out = []
  let i = 0
  while ((i = text.indexOf(needle, i)) >= 0) { out.push(i); i += 1 }   // 允许重叠
  return out
}
// 某一处在 Markdown 源码里的行号 / 列号（都从 1 数）。
function lineColOf(text, idx) {
  const before = text.slice(0, idx)
  return { line: before.split('\n').length, col: idx - (before.lastIndexOf('\n') + 1) + 1 }
}
// 摘要里出现换行会把结构拆散，换成看得见的符号；长度不变、意思不丢。
function asOneLine(s) { return String(s).replace(/\n/g, '↵') }

// 按 canvasId / path 找文档；都没给就用活跃画布。
// 引用里给的是**文件路径**，所以要支持按路径匹配。
function findCanvasByArg(args) {
  const id = args && typeof args.canvasId === 'string' ? args.canvasId : ''
  if (id) return canvases.get(id) || null
  const raw = args && typeof args.path === 'string' ? args.path : ''
  if (raw) {
    const norm = (s) => String(s).replace(/\\/g, '/').replace(/^"+|"+$/g, '')
    const want = norm(raw)
    let hit = null
    canvases.forEach(function (c) { if (!hit && c.filePath && norm(c.filePath) === want) hit = c })
    if (hit) return hit
    // 兜底：模型可能只给了文件名的一部分 —— 用标题去认
    canvases.forEach(function (c) {
      if (!hit && c.title && want.indexOf(norm(c.title).replace(/\.md$/i, '')) >= 0) hit = c
    })
    if (hit) return hit
  }
  return activeId ? canvases.get(activeId) || null : null
}

ctx.tools.register(defineTool({
  name: 'canvas_locate',
  description: '在话布文档里精确找出「一段原文」所处的位置（第几处、每处长什么样），'
    + '并在原文已不在文档里时明确告知这段引用已经失效。'
    + '⚠️ 用户用 @话布选区 引用了一段文字、且引用标签上标着「多处」时，动手改之前必须先调用它确认是哪一处；'
    + '标签里的「第 N 处」直接传 ordinal 就能定住（它比行号可靠 —— 同一行里可能有好几处一模一样的文字）。'
    + '没标「多处」时也可以用它复核。原文重复时不要自己挑一处改 —— 改错地方比不回答更糟。',
  parameters: {
    text: { type: 'string', required: true, description: '要定位的原文（引用里「」中的内容，请一字不差地照抄）' },
    canvasId: { type: 'string', description: '画布 id；缺省用活跃画布' },
    path: { type: 'string', description: '文档路径（引用里的 @ 路径）；给了它就不必给 canvasId' },
    line: { type: 'number', description: '引用标签里给的第几行，用于优先核对' },
    ordinal: { type: 'number', description: '引用标签里给的「第 N 处」；给了它就直接定位到这一处，优先于 line' },
  },
  output: { schema: { type: 'string' }, render: function (_a, v) { return [{ type: 'text', text: v }] } },
  execute: async function (args) {
    const text = args && typeof args.text === 'string' ? args.text : ''
    if (!text) return toolOutput(err('E_BAD_ARGS', 'text 必须为非空字符串（引用里「」中的那段原文）'))
    const c = findCanvasByArg(args)
    if (!c) return toolOutput(err('E_NOT_FOUND', '没找到对应的话布文档；可先用 canvas_list 看看有哪些'))
    const content = String(c.content || '')
    const idxs = occIndexes(content, text)

    // 找不到 → 引用已经失效。这时候**绝不能**让它去找"相似内容"照着改。
    if (!idxs.length) {
      return toolOutput({
        ok: false,
        error: { code: 'E_GONE', message: '这段原文已经不在《' + c.title + '》里了' },
        canvasId: c.id, title: c.title, version: c.version,
        hint: '这段引用很可能已经失效（用户发出引用之后文档被改过）。'
          + '请让用户重新划一次要引用的段落，**不要**去找相似的内容按猜测改。',
      })
    }

    const askedLine = args && typeof args.line === 'number' ? args.line : -1
    const askedOrd = args && typeof args.ordinal === 'number' ? args.ordinal : -1
    const CTX = 20    // 每处前后各带多少字
    const MAX = 8     // 最多列几处，避免输出爆炸
    const spots = idxs.map(function (idx) {
      const lc = lineColOf(content, idx)
      const a = Math.max(0, idx - CTX)
      const b = Math.min(content.length, idx + text.length + CTX)
      return {
        line: lc.line,
        col: lc.col,
        excerpt: (a > 0 ? '…' : '') + asOneLine(content.slice(a, idx))
          + '【' + asOneLine(text) + '】'
          + asOneLine(content.slice(idx + text.length, b)) + (b < content.length ? '…' : ''),
        likelyTarget: false,   // 下面统一算：只有**恰好一处**吻合行号时才置 true
      }
    })
    // 定位优先级：
    //   ① 引用给的「第 N 处」最可靠 —— 同一行里可能有好几处一模一样的文字，行号根本分不开
    //   ② 退而用行号，且只有**恰好一处**吻合时才认
    //   ③ 都定不住 → 一处都不标，把每一处摆出来让用户确认
    if (askedOrd > 0 && askedOrd <= spots.length) {
      spots[askedOrd - 1].likelyTarget = true
    } else {
      const nearIdx = []
      if (askedLine > 0) spots.forEach(function (s, i) { if (Math.abs(s.line - askedLine) <= 2) nearIdx.push(i) })
      if (nearIdx.length === 1) spots[nearIdx[0]].likelyTarget = true
    }
    const shown = spots.slice(0, MAX)
    const near = spots.filter(function (s) { return s.likelyTarget })
    let hint
    if (spots.length === 1) {
      hint = '原文在文中只有这一处，就是它。'
    } else if (askedOrd > 0 && askedOrd <= spots.length) {
      hint = '按引用标签给的「第 ' + askedOrd + ' 处」（全文共 ' + spots.length + ' 处），目标就是标了 likelyTarget 的那一处；'
        + '请照 excerpt 核对一次再动手。'
    } else if (near.length === 1) {
      hint = '共 ' + spots.length + ' 处；与引用给出的第 ' + askedLine + ' 行对得上的那一处已标 likelyTarget，多半就是它 ——'
        + '但仍请照 excerpt 核对一次再动手。'
    } else {
      hint = '共 ' + spots.length + ' 处，仅凭行号分不出来。请把每处的 excerpt 摆给用户，让他确认改哪一处，不要自己挑一处改。'
    }
    return toolOutput({
      ok: true,
      canvasId: c.id, title: c.title, version: c.version,
      total: spots.length, shown: shown.length,
      note: spots.length > shown.length ? '只列了前 ' + shown.length + ' 处。' : '',
      lineNote: '这里的行号按 Markdown 源码数；引用标签里的行号按编辑器渲染结果数，两者可能有偏差，请以 excerpt 为准。',
      spots: shown,
      hint: hint,
    })
  },
}))
// [[CCV-LOCATE-END]]

    // ==================== 08-prompt.js ====================
// 模型使用指南 prompt section
try {
  const sp = ctx.get('systemPrompt')
  if (sp && typeof sp.section === 'function') {
    sp.section({
      id: 'collab-canvas-usage',
      title: '话布工具使用指南',
      order: 200,
      text: [
        '用户提到"话布/画布/共创话布/canvas"时，使用 canvas_* 工具组操作话布，不要把长内容直接贴在聊天里。',
        'canvas_write 的 replace 模式覆盖全文，写入前必须先 canvas_read；追加用 append 模式（无需 baseVersion）。',
        'AI 写入直接生效，用户可在话布面板撤销；大改动建议分段 append。',
        '用户未明说"保存"时不主动 canvas_save（自动保存已在后台进行）。',
        '引用话布内容进对话时只摘必要片段。',
        // ⚠️ 这里刻意不再规定「在回复末尾手写一行打开入口」。
        // 实测两次：只要写成「满足条件 Y 时输出 X」的约定，模型就会把它当仪式执行
        // —— 记住「每轮末尾加一行」，条件被跳过。改措辞救不了（收紧后仍复发）。
        // 现在入口完全由工具驱动：调了 present 才有卡片，不调就没有，
        // 没有可被误触发的余地。正文里提到标题时，客户端本来就会自动转成链接。
        '【可点入口】本轮确实创建或修改了话布文档时，调用 present 声明 "canvas-docs/<标题>.md"（标题用 slugify 规则：空格换 -、去掉路径非法字符；中文标题恒等）。它会在回复末尾生成一张可点卡片，点开即话布面板。',
        '不要在正文里手写「打开话布」「点击查看」之类的入口行——入口只由 present 卡片承担，正文不提。',
      ].join('\n'),
    })
    console.log('[collab-canvas]', 'prompt section registered')
  }
} catch (e) {
  console.error('[collab-canvas] prompt section failed:', e && e.message)
}

    // ==================== 09-http.js ====================
// 画布 HTTP 端点——供浏览器编辑器通过 fetch 读写画布数据
// 路由：GET /api/canvas/list|read?id=xxx，POST /api/canvas/write|save|create
// 用 ctx.inject(['webServer']) 确保 webServer 服务就绪后再注册

// ─── 会话独立清单：每个会话记录自己新建/打开过的画布 ───
// 元数据存 canvas-docs/.sessions/<sid>.json；文档 md 文件仍在共享池 canvas-docs/
var sessStore = new Map()   // sid -> { activeId, ids: [] }
var lastBrowserSid = 'default'   // 浏览器最近在看的会话键（AI 工具创建的画布归入它的清单）
// 一次性迁移的持久化标记（.sessions/.migrated）：迁移执行过一次就永久生效，
// 重启不再把全局画布重新挂回清单（之前标记是内存变量，重启清零导致删掉的清单复原）
function sessMigratedAlready() {
  try { return nodefs.existsSync(joinPath(sessDirPath(), '.migrated')) } catch (_) { return true }
}
function sessMarkMigrated() {
  try { nodefs.writeFileSync(joinPath(sessDirPath(), '.migrated'), String(Date.now())) } catch (_) {}
}
var sessMigrated = false
function sessDirPath() {
  const d = joinPath(docsDir(), '.sessions')
  try { nodefs.mkdirSync(d, { recursive: true }) } catch (_) {}
  return d
}
function sessSafe(sid) { return String(sid || '').replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 80) || 'default' }
function sessLoad(sid) {
  try {
    const j = JSON.parse(nodefs.readFileSync(joinPath(sessDirPath(), sessSafe(sid) + '.json'), 'utf8'))
    if (j && Array.isArray(j.ids)) return { activeId: j.activeId || null, ids: j.ids.filter(x => canvases.has(x)) }
  } catch (_) {}
  return { activeId: null, ids: [] }
}
function sessPersist(sid, st) {
  try { nodefs.writeFileSync(joinPath(sessDirPath(), sessSafe(sid) + '.json'), JSON.stringify({ activeId: st.activeId, ids: st.ids }, null, 2)) } catch (_) {}
}
function sessState(sid) {
  sid = sessSafe(sid)
  if (!sessStore.has(sid)) {
    let st = sessLoad(sid)
    // 一次性迁移：旧全局清单挂到重启后第一个使用的会话名下。
    // 标记用持久化文件（.sessions/.migrated），内存标记会在重启后丢失、
    // 导致每次重启都把全局画布重新挂回清单（用户删了又复现的根因）
    if (!st.ids.length && canvases.size && !sessMigratedAlready()) {
      st = { activeId: activeId, ids: Array.from(canvases.keys()) }
      sessMarkMigrated()
      sessPersist(sid, st)
      console.log('[collab-canvas] 会话清单迁移:', sid, '<-', st.ids.join(','))
    }
    sessStore.set(sid, st)
  }
  return sessStore.get(sid)
}
function sessAdd(sid, id) {
  const st = sessState(sid)
  if (st.ids.indexOf(id) < 0) { st.ids.push(id); sessPersist(sid, st) }
  if (st.activeId !== id) { st.activeId = id; sessPersist(sid, st) }
}
function sessRemove(sid, id) {
  const st = sessState(sid)
  st.ids = st.ids.filter(x => x !== id)
  if (st.activeId === id) st.activeId = null
  sessPersist(sid, st)
}

function initCanvasHttpEndpoints(ctx, webServer) {
  // JSON 响应辅助
  function json(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }
  function error(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }
  // 解析 POST body 为 JSON
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (e) { reject(new Error('Invalid JSON')) }
      })
      req.on('error', reject)
    })
  }
  // GET /api/canvas/list?sid=xxx —— 只返回该会话清单里的画布
  //                      ?scope=all —— 返回全部画布（跨会话）。客户端做「标题 → 可点链接」
  //                                    匹配时用：会话清单只含「本会话开过/建过的」，
  //                                    没登记过的文档标题会匹配不到、转不成链接。
  // 每条都带 path：md 文件的**真实绝对路径**（正斜杠）。客户端生成 @ 引用、
  // 显示位置都要用真实路径，不能自己拼相对路径 —— 存储根被 rootOverride
  // 固定到别处后，相对路径会指向工作区里的残留目录。
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/list', handler: async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.searchParams.get('scope') === 'all') {
      const all = []
      canvases.forEach((c) => all.push({ id: c.id, title: c.title, version: c.version, path: canvasMdPath(c) }))
      json(res, { ok: true, canvases: all, activeId: activeId, scope: 'all' })
      return
    }
    const sid = sessSafe(url.searchParams.get('sid'))
    lastBrowserSid = sid
    const st = sessState(sid)
    const arr = []
    st.ids.forEach((id) => { const c = canvases.get(id); if (c) arr.push({ id: c.id, title: c.title, version: c.version, path: canvasMdPath(c) }) })
    json(res, { ok: true, canvases: arr, activeId: st.activeId })
  }}))
  // GET /api/canvas/read?id=xxx —— 打开过就记入该会话清单
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/read', handler: async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const id = url.searchParams.get('id')
    const c = id ? canvases.get(id) : (activeId ? canvases.get(activeId) : null)
    if (!c) { error(res, 404, { ok: false, error: '画布不存在' }); return }
    sessAdd(url.searchParams.get('sid'), c.id)
    lastBrowserSid = sessSafe(url.searchParams.get('sid'))
    json(res, { ok: true, id: c.id, title: c.title, content: c.content, version: c.version, path: canvasMdPath(c) })
  }}))
  // GET /api/canvas/changes?since=N —— 画布端轮询「AI 刚改了哪儿」
  // 为什么用轮询而不是推送：客户端已经有现成的取数习惯（读文档、报日志都是普通请求），
  // 加一条推送通道要新增一套连接生命周期管理，收益不值当。
  // 轮询间隔 1.2 秒 —— AI 改完到主人看向屏幕本来就有间隔，这点延迟无感。
  // 只回 since **之后**的新条目：画布端记住自己处理到的 seq，取过的不会再要一次。
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/changes', handler: async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const raw = url.searchParams.get('since')
    const since = (raw === null || raw === '') ? 0 : parseInt(raw, 10)
    if (isNaN(since)) { error(res, 400, { ok: false, error: 'since 必须是数字' }); return }
    const out = aiChanges.filter((x) => x.seq > since)
    json(res, { ok: true, latest: aiChangeSeq, changes: out })
  }}))
  // POST /api/canvas/selref/pin —— 客户端报「你刚才划的是第几处」
  // 为什么需要：引用正文里**已经不写坐标了**（2026-09-15 主人要求对话里那张
  // 卡片只留文件名），而"第几处"靠的是**划选那一刻的 DOM 位置** —— 只有浏览器
  // 那边知道，服务端自己无论如何算不出。所以单独送一份过来，
  // 供 host 侧的「位置主动注入」（13-selref-context.js）使用。
  // 只存内存、不落盘：它是**当下的**输入，重启后就该丢。
  // 实现在 13-selref-context.js（那边有 [[CCV-SELCTX]] 标记，测试切得出来）。
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/selref/pin', handler: async (req, res) => {
    try {
      if (req.method !== 'POST') { error(res, 405, { ok: false, error: '只收 POST' }); return }
      const body = await readBody(req)
      const taken = ccvPinAdd(body)
      json(res, { ok: taken, n: ccvPins.length })
    } catch (e) { error(res, 400, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/write
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/write', handler: async (req, res) => {
    try {
      const body = await readBody(req)
      const id = body.id || activeId
      const c = id ? canvases.get(id) : null
      if (!c) { error(res, 404, { ok: false, error: '画布不存在' }); return }
      const result = applyWrite(c, body.content, 'replace', body.knownVer, 'human')
      // ⚠️ 冲突必须显式回传。applyWrite 检出并发冲突时返回
      //    { conflict, currentVersion, currentContent }，此时 result.version 是 undefined；
      //    若照原样 json({ ok: true, version: result.version })，
      //    undefined 会被 JSON.stringify 丢掉 → 响应变成 {"ok":true} ——
      //    冲突被伪装成成功，浏览器编辑器无从察觉，只能继续用旧内容写。
      if (result && result.conflict) {
        json(res, { ok: false, conflict: true, currentVersion: result.currentVersion, currentContent: result.currentContent })
        return
      }
      json(res, { ok: true, version: result.version })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/create?sid=xxx —— 新建即记入当前会话清单
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/create', handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const body = await readBody(req)
      const c = createCanvasDoc(body.title || '新话布')
      sessAdd(url.searchParams.get('sid'), c.id)
      json(res, { ok: true, id: c.id, title: c.title })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // ─── 客户端诊断日志（排障用）─────────────────────────
  // 环境里用户开不了浏览器控制台，客户端把关键判定点 POST 到这里，
  // 落盘到 %TEMP%/ccv-selbar.log，不用 console 也能复盘当时发生了什么。
  const DEBUG_LOG = (process.env.TEMP || process.env.TMPDIR || '.') + '/ccv-selbar.log'
  let _dbg = []
  const DBG_MAX = 400
  function ts() {
    const d = new Date()
    const p = function (n) { return String(n).padStart(2, '0') }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0')
  }
  function dbgWrite() {
    try {
      if (typeof nodefs !== 'undefined' && nodefs && nodefs.writeFileSync) {
        nodefs.writeFileSync(DEBUG_LOG, _dbg.join('\n') + '\n', 'utf8')
      }
    } catch (e) { /* 落盘失败不影响主流程 */ }
  }
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/log', handler: async (req, res) => {
    try {
      if (req.method === 'POST') {
        const body = await readBody(req)
        const lines = Array.isArray(body.lines) ? body.lines : [String(body.line || '')]
        lines.forEach(function (l) { _dbg.push(ts() + ' ' + String(l)) })
        if (_dbg.length > DBG_MAX) _dbg = _dbg.slice(_dbg.length - DBG_MAX)
        dbgWrite()
        json(res, { ok: true, n: _dbg.length, file: DEBUG_LOG })
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(_dbg.join('\n') + '\n')
      }
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // ─── 打开文档所在文件夹 ─────────────────────────────
  // 客户端「📁」按钮调用；host 是 Node 主进程，用 explorer/open/xdg-open
  // 在系统文件管理器里打开当前画布文档所在的目录。
  // 注意：不要用 fs.resolve —— 它返回的是沙箱内部标记，不是文件系统路径，
  // explorer 收到无效参数会默认打开「文档」库。这里用 path 模块自己归一化。
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/open-folder', handler: async (req, res) => {
    const c = activeId ? canvases.get(activeId) : null
    const raw = (c && c.filePath) ? path.dirname(c.filePath) : docsDir()
    let dir = path.isAbsolute(raw) ? raw : path.join(docsDirBase(), raw)
    dir = dir.replace(/[\\/]+$/, '')
    const plat = process.platform
    // explorer 对 / 与 \ 混用的路径解析不可靠（session cwd 常带正斜杠），
    // Windows 下一律归一成反斜杠 + path.win32.normalize
    if (plat === 'win32') dir = path.win32.normalize(dir.replace(/\//g, '\\'))
    const info = { dir: dir, raw: raw, exists: null, cwd: null, platform: plat, strategy: null, pid: null, err: null, exit: null }
    try { info.exists = nodefs.existsSync(dir) } catch (e) { info.err = 'existsSync: ' + (e && e.message) }
    try { info.cwd = process.cwd() } catch (e) { info.err = 'cwd: ' + (e && e.message) }
    try {
      if (plat === 'win32') {
        // explorer 从带 stdio 管道的子进程里启动时，偶尔会忽略参数、打开默认目录。
        // 用 detached + stdio:'ignore' 起，是最稳的传法。
        const child = spawn('explorer', [dir], { detached: true, stdio: 'ignore' })
        child.unref()
        info.strategy = 'spawn-explorer-detached'
        info.pid = child.pid
        child.on('error', function (e) { info.err = 'spawn error: ' + (e && e.message) })
        child.on('exit', function (code) { info.exit = code })
      } else {
        const child = spawn(plat === 'darwin' ? 'open' : 'xdg-open', [dir], { detached: true, stdio: 'ignore' })
        child.unref()
        info.strategy = 'spawn-open'
        info.pid = child.pid
        child.on('error', function (e) { info.err = 'spawn error: ' + (e && e.message) })
      }
    } catch (e) {
      info.err = 'spawn throw: ' + (e && e.message)
      try {
        exec(plat === 'win32' ? 'cmd /c start "" "' + dir + '"' : 'xdg-open "' + dir + '"', function (e2) {
          info.strategy = 'cmd-start-fallback'
          info.err = e2 ? ('cmd start: ' + e2.message) : null
        })
      } catch (e3) { info.err = 'fallback throw: ' + (e3 && e3.message) }
    }
    setTimeout(function () {
      _dbg.push(ts() + ' open-folder ' + JSON.stringify(info))
      if (_dbg.length > DBG_MAX) _dbg = _dbg.slice(_dbg.length - DBG_MAX)
      dbgWrite()
    }, 1200)
    console.log('[collab-canvas] open-folder', JSON.stringify(info))
    json(res, { ok: true, dir: dir, raw: raw, exists: info.exists, pid: info.pid, strategy: info.strategy })
  }}))
  console.log('[collab-canvas] HTTP endpoints registered: /api/canvas/* (debug log -> ' + DEBUG_LOG + ')')
}

    // ==================== 10-editor-code.js ====================
// 这里原本有一段 12,999 字符的 EDITOR_PANEL_JS 字符串：早期"浮层面板式编辑器"的
    // 整份浏览器端代码（自带一套 mdToHtml/htmlToMd、划词栏，还有一段把「话布」按钮
    // 硬塞进侧栏设置区的 findSettingsArea + setInterval 逻辑）。
    // 2026-09-12 代码体检确认：全包零引用（只有定义、没有任何读取），实际对外提供的是
    // lib/client.js，所以整段是纯死代码，已删除。
    // 需要考古可查：git 历史中的 src/host/10-editor-code.js（v0.3.0 及以前）

    // ==================== 11-canvas-extras.js ====================
// 画布扩展端点：外部文档拖拽 / 文件登记表 / 删除 / 模块源码服务
// 依赖同作用域：docsDirBase, docsDir, canvases, createCanvasDoc, applyWrite,
//               saveCanvas, persistMeta, nodefs, path（均由其他模块提供）
function initCanvasExtraEndpoints(ctx, webServer) {
  // JSON 响应辅助（与 09-http 同款，本文件自包含）
  function json(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }
  function error(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (limit && size > limit) { reject(new Error('文件超过大小上限')); try { req.destroy() } catch (_) {} ; return }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  // 会话工作区目录（@ 文件选择器索引的目录）
  function sessionWorkspaceDir() {
    try {
      const svc = ctx.get('sessions')
      const arr = svc && svc.list ? svc.list() : []
      for (const s of arr) {
        const holder = s && (s.header || s.meta || s)
        const cwd = holder && holder.cwd
        if (typeof cwd === 'string' && cwd.length > 2) return cwd
      }
    } catch (e) { console.error('[collab-canvas] session-cwd probe failed:', e && e.message) }
    return docsDirBase()
  }

  // ─── 文件登记表：让拖拽按“真实路径”引用外部文档 ───
  const REG_CONFIG_FILE = () => path.join(docsDirBase(), 'file-registry.json')
  const REG_SKIP_DIRS = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information'])
  const REG_MAX_FILES = 150000
  const regFolders = []
  const regIndex = new Map()      // folder -> Map(basename -> [fullPath])
  const regWatchers = new Map()
  let regTotal = 0

  function regLoadConfig() {
    try {
      const f = REG_CONFIG_FILE()
      if (nodefs.existsSync(f)) {
        const j = JSON.parse(nodefs.readFileSync(f, 'utf8'))
        if (Array.isArray(j.folders)) return j.folders.filter(p => typeof p === 'string' && path.isAbsolute(p))
      }
    } catch (e) { console.error('[collab-canvas] registry config read failed:', e && e.message) }
    return []
  }
  function regSaveConfig(folders) {
    try {
      nodefs.writeFileSync(REG_CONFIG_FILE(), JSON.stringify({ folders: folders }, null, 2))
    } catch (e) { console.error('[collab-canvas] registry config write failed:', e && e.message) }
  }
  function regScanFolder(folder) {
    const map = new Map()
    let count = 0
    function walk(dir, depth) {
      if (depth > 16 || count > REG_MAX_FILES) return
      let entries = []
      try { entries = nodefs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
      for (const ent of entries) {
        try {
          if (ent.isSymbolicLink()) continue
          const full = path.join(dir, ent.name)
          if (ent.isDirectory()) {
            if (REG_SKIP_DIRS.has(ent.name)) continue
            walk(full, depth + 1)
          } else if (ent.isFile()) {
            count++
            if (count > REG_MAX_FILES) return
            const arr = map.get(ent.name) || []
            arr.push(full)
            map.set(ent.name, arr)
          }
        } catch (_) {}
      }
    }
    walk(folder, 0)
    return map
  }
  function regRescanFolder(folder) {
    try {
      const map = regScanFolder(folder)
      let n = 0
      const sigs = []
      map.forEach(arr => { n += arr.length; arr.forEach(p => sigs.push(p)) })
      sigs.sort()
      const sig = n + '|' + sigs.join(',')
      // 无变化的重扫（OneDrive 触碰文件、临时文件增删）静默处理，只留真正变化日志
      const changed = sig !== regLastSig.get(folder)
      regLastSig.set(folder, sig)
      regIndex.set(folder, map)
      regTotal = 0
      regIndex.forEach(m => { m.forEach(arr => { regTotal += arr.length }) })
      if (changed) console.log('[collab-canvas] registry scanned', folder, '->', n, 'files')
    } catch (e) { console.error('[collab-canvas] registry scan failed:', folder, e && e.message) }
  }
  const regLastSig = new Map()   // folder -> 上次索引签名（文件数+路径集），无变化的重扫静默处理
  const regRescanTimers = new Map()
  function regScheduleRescan(folder) {
    if (regRescanTimers.has(folder)) return
    const t = setTimeout(function () { regRescanTimers.delete(folder); regRescanFolder(folder) }, 3000)
    regRescanTimers.set(folder, t)
  }
  function regWatch(folder) {
    if (regWatchers.has(folder)) return
    try {
      const w = nodefs.watch(folder, { recursive: true }, function () { regScheduleRescan(folder) })
      w.on('error', function () {})
      regWatchers.set(folder, w)
    } catch (e) { console.error('[collab-canvas] registry watch failed:', folder, e && e.message) }
  }
  function regUnwatch(folder) {
    const w = regWatchers.get(folder)
    if (w) { try { w.close() } catch (_) {} regWatchers.delete(folder) }
  }
  // 空登记表自愈：配置为空/被清空时，自动补登记会话工作区（拖拽最常见来源）
  function regSeedIfEmpty() {
    if (regFolders.length) return false
    try {
      let cfg = regLoadConfig()
      if (!cfg.length) cfg = [sessionWorkspaceDir()]
      regFolders.push(...cfg)
      cfg.forEach(function (f) { regRescanFolder(f); regWatch(f) })
      console.log('[collab-canvas] registry: 空登记表自动补登记 ->', cfg.join(' | '))
      return true
    } catch (_) { return false }
  }

  const UPLOAD_LIMIT = 100 * 1024 * 1024

  // /api/canvas/registry —— GET 查看登记文件夹与索引规模；POST 设置登记文件夹
  //（须存在的绝对路径目录）。注意：DSH exact 路由同路径只允许注册一次，
  // GET/POST 必须合并在同一个 handler 里按 method 分流
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/registry', handler: async (req, res) => {
    try {
      if (req.method === 'POST') {
        const body = await readBody(req)
        const folders = Array.isArray(body.folders) ? body.folders.map(s => String(s).trim()).filter(Boolean) : []
        const invalid = folders.filter(f => !path.isAbsolute(f) || !nodefs.existsSync(f) || !nodefs.statSync(f).isDirectory())
        if (invalid.length) { error(res, 400, { ok: false, error: '以下路径无效或不是文件夹: ' + invalid.join(', ') }); return }
        const uniq = Array.from(new Set(folders))
        regFolders.length = 0
        regFolders.push(...uniq)
        regSaveConfig(regFolders)
        Array.from(regIndex.keys()).forEach(function (f) { if (!regFolders.includes(f)) regIndex.delete(f) })
        Array.from(regWatchers.keys()).forEach(function (f) { if (!regFolders.includes(f)) regUnwatch(f) })
        uniq.forEach(function (f) {
          regWatch(f)
          setTimeout(function () { regRescanFolder(f) }, 0)
        })
        json(res, { ok: true, folders: regFolders.slice(), files: regTotal, note: '索引构建中' })
        return
      }
      json(res, { ok: true, folders: regFolders.slice(), files: regTotal })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // GET /api/canvas/locate?name=xxx —— 按文件名查登记索引，返回真实路径
  //（rel = 会话工作区相对路径；docsRel = 画布文档目录相对路径，形如 canvas-docs/xxx.md）
  // 查询前先做空登记表自愈，避免“忘了登记 → 永远查不到”的死循环
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/locate', handler: async (req, res) => {
    try {
      regSeedIfEmpty()
      const url = new URL(req.url, 'http://x')
      const name = url.searchParams.get('name') || ''
      const ws = sessionWorkspaceDir().replace(/[\\/]+$/, '')
      const docsDirN = docsDir().replace(/[\\/]+$/, '')
      const matches = []
      regIndex.forEach(function (map) {
        const arr = map.get(name)
        if (arr) arr.forEach(function (p) {
          const norm = p.replace(/\//g, '\\')
          let rel = null, docsRel = null
          const low = norm.toLowerCase()
          if (low.indexOf(ws.toLowerCase() + '\\') === 0) rel = norm.slice(ws.length + 1).replace(/\\/g, '/')
          if (low.indexOf(docsDirN.toLowerCase() + '\\') === 0) docsRel = 'canvas-docs/' + norm.slice(docsDirN.length + 1).replace(/\\/g, '/')
          matches.push({ path: norm, rel: rel, docsRel: docsRel })
        })
      })
      json(res, { ok: true, name: name, matches: matches, folders: regFolders.length })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // GET /api/canvas/load-doc?rel=canvas-docs/xxx.md —— 把 canvas-docs 里的 md
  // 注册为话布（按标题找已有，找不到新建）并返回画布 id——即 canvas_load 的最小实现
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/load-doc', handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const rel = String(url.searchParams.get('rel') || '')
      if (!/^canvas-docs\/[^\\/]+\.md$/i.test(rel)) { error(res, 400, { ok: false, error: '仅支持 canvas-docs/ 下的 .md 文件' }); return }
      const full = path.join(docsDir(), rel.slice('canvas-docs/'.length))
      if (!nodefs.existsSync(full)) { error(res, 404, { ok: false, error: '文件不存在' }); return }
      const content = nodefs.readFileSync(full, 'utf8')
      const title = rel.split('/').pop().replace(/\.(md|markdown)$/i, '')
      let c = null
      // 先按标题找；找不到再按「已绑定到同一个文件」找。
      // 只按标题去重是不够的：标题不同但指向同一文件时仍会新建一条，
      // 于是同一文件挂两条记录，旧的那条内容过期、保存即覆盖。
      let fullKey
      try { fullKey = path.resolve(full) } catch (_) { fullKey = full }
      canvases.forEach(function (x) {
        if (c || !x.filePath) return
        let k
        try { k = path.resolve(String(x.filePath)) } catch (_) { k = String(x.filePath) }
        if (k === fullKey) c = x
      })
      canvases.forEach(function (x) { if (!c && x.title === title) c = x })
      let created = false
      if (!c) {
        c = createCanvasDoc(title)
        applyWrite(c, content, 'replace', undefined, 'human')
        try { await saveCanvas(c) } catch (e) { console.error('[collab-canvas] load-doc save failed:', e && e.message) }
        created = true
      }
      sessAdd(url.searchParams.get('sid'), c.id)   // 登记即记入当前会话清单
      json(res, { ok: true, id: c.id, title: c.title, created: created })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // ─── 白名单：本地文档「就地」登记为话布 ───────────────────────────
  // 允许范围 = 会话工作区 ∪ 画布目录 ∪ 文件登记表里登记的文件夹。
  // 路径先 resolve 归一化再比较，防止 ../ 逃逸；不满足即拒绝（不开全盘口子）。
  function pathAllowedInTarget(target) {
    let t
    try { t = path.resolve(String(target || '')) } catch (_) { return false }
    const roots = []
    try { roots.push(path.resolve(sessionWorkspaceDir())) } catch (_) {}
    try { roots.push(path.resolve(docsDirBase())) } catch (_) {}
    regFolders.forEach(function (f) { try { roots.push(path.resolve(f)) } catch (_) {} })
    for (let i = 0; i < roots.length; i++) {
      const rel = path.relative(roots[i], t)
      if (rel === '' || (rel.indexOf('..') !== 0 && !path.isAbsolute(rel))) return true
    }
    return false
  }
  // GET /api/canvas/load-path?path=<绝对路径|工作区相对路径>&sid=xxx
  // —— 把白名单内的本地文档就地登记为话布：**绑定原路径，保存即写回原文件**（不是副本）。
  //    与 load-doc 的区别：load-doc 只认 canvas-docs/ 下的文件、复制内容另存；
  //    这里支持工作区/登记文件夹内的任意 .md/.markdown/.txt，且保持就地编辑语义。
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/load-path', handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const raw = String(url.searchParams.get('path') || '').trim()
      if (!raw) { error(res, 400, { ok: false, error: '缺少 path 参数' }); return }
      if (!/\.(md|markdown|txt|text)$/i.test(raw)) { error(res, 400, { ok: false, error: '仅支持 .md/.markdown/.txt' }); return }
      const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(sessionWorkspaceDir(), raw)
      if (!pathAllowedInTarget(abs)) {
        error(res, 403, { ok: false, error: '路径不在允许范围内（会话工作区 / 画布目录 / 已登记文件夹）' })
        return
      }
      if (!nodefs.existsSync(abs)) { error(res, 404, { ok: false, error: '文件不存在' }); return }
      let c = null
      canvases.forEach(function (x) {
        if (!c && x.filePath) { try { if (path.resolve(x.filePath) === abs) c = x } catch (_) {} }
      })
      let created = false
      if (!c) { c = await loadFileDoc(abs); created = true }
      sessAdd(url.searchParams.get('sid'), c.id)
      json(res, { ok: true, id: c.id, title: c.title, filePath: c.filePath, created: created })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // GET /api/canvas/delete?id=xxx&sid=xxx —— 从当前会话清单移除画布；
  // 若其他会话清单仍引用该画布则只摘引用保留文件，无人引用才连 md 一起删
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/delete', handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const id = url.searchParams.get('id')
      const sid = sessSafe(url.searchParams.get('sid'))
      const c = id ? canvases.get(id) : null
      if (!c) { error(res, 404, { ok: false, error: '画布不存在' }); return }
      sessRemove(sid, id)
      let referenced = false
      try {
        const files = nodefs.readdirSync(sessDirPath())
        for (const f of files) {
          if (!f.endsWith('.json') || f === sessSafe(sid) + '.json') continue
          try {
            const j = JSON.parse(nodefs.readFileSync(path.join(sessDirPath(), f), 'utf8'))
            if (Array.isArray(j.ids) && j.ids.indexOf(id) >= 0) { referenced = true; break }
          } catch (_) {}
        }
      } catch (_) {}
      if (!referenced) {
        canvases.delete(id)
        if (activeId === id) activeId = null
        try {
          if (c.filePath && nodefs.existsSync(c.filePath)) nodefs.unlinkSync(c.filePath)
        } catch (e) { console.error('[collab-canvas] delete file failed:', e && e.message) }
        persistMeta()
      }
      json(res, { ok: true, id: id, title: c.title, fileDeleted: !referenced })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/import-doc?name=xxx —— 外部文档拖入/上传：复制到会话工作区
  // 的 uploads/ 文件夹（@ 文件选择器可索引到），返回相对路径供 @ 引用
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/import-doc', handler: async (req, res) => {
    try {
      if (req.method !== 'POST') { error(res, 405, { ok: false, error: 'POST only' }); return }
      const url = new URL(req.url, 'http://x')
      let name = url.searchParams.get('name') || 'doc.md'
      name = String(name).replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || 'doc.md'
      const body = await readBody(req, UPLOAD_LIMIT)
      if (!body || !body.length) { error(res, 400, { ok: false, error: '空文件' }); return }
      const dir = path.join(sessionWorkspaceDir(), 'uploads')
      try { nodefs.mkdirSync(dir, { recursive: true }) } catch (e) {}
      const fname = Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '-' + name
      nodefs.writeFileSync(path.join(dir, fname), body)
      console.log('[collab-canvas] import-doc:', fname, body.length + 'B')
      json(res, { ok: true, path: 'uploads/' + fname, name: name, size: body.length })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // GET /api/canvas/open-upload?name=xxx —— 把拖入上传的文档变成/打开话布：
  // 已有同名（去掉时间戳前缀后的标题，含/不含 .md 扩展名）话布 → 直接返回其 id；
  // 否则新建话布并写入文件内容。只允许读 uploads/ 目录、文件名限本插件生成的格式
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/open-upload', handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const fname = String(url.searchParams.get('name') || '')
      if (!/^\d{13}-[a-z0-9]{2,8}-[^\r\n\\/:"*?<>|]{1,120}$/i.test(fname)) { error(res, 400, { ok: false, error: '非法文件名' }); return }
      const upDir = path.join(sessionWorkspaceDir(), 'uploads')
      const full = path.join(upDir, fname)
      if (path.resolve(full).indexOf(path.resolve(upDir) + path.sep) !== 0) { error(res, 403, { ok: false, error: '非法路径' }); return }
      if (!nodefs.existsSync(full)) { error(res, 404, { ok: false, error: '文件不存在' }); return }
      const content = nodefs.readFileSync(full, 'utf8')
      const title = fname.replace(/^\d{13}-[a-z0-9]{2,8}-/i, '')
      const baseTitle = title.replace(/\.(md|markdown)$/i, '')
      // 查重按“路径”判断：拖拽拿不到源文件真实路径（安全限制），但拖进来
      // 的文件名就是路径的最后一段，而画布文档的存盘名 = 标题 + .md，
      // 因此“文件名(含/不含扩展名) = 画布标题”即视为同一篇文档，不按内容判断
      let c = null, matched = 'created'
      canvases.forEach(function (x) {
        if (!c && (x.title === title || x.title === baseTitle)) { c = x; matched = 'title' }
      })
      let created = false
      if (!c) {
        c = createCanvasDoc(title)
        applyWrite(c, content, 'replace', undefined, 'human')
        try { await saveCanvas(c) } catch (e) { console.error('[collab-canvas] open-upload save failed:', e && e.message) }
        created = true
      }
      sessAdd(url.searchParams.get('sid'), c.id)   // 导入即记入当前会话清单
      json(res, { ok: true, id: c.id, title: c.title, created: created, matched: matched })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // 画布附件与独立模块源码服务（file / docdrop.js / doclink.js）
  function canvasDocDir() {
    const c = activeId ? canvases.get(activeId) : null
    const raw = (c && c.filePath) ? path.dirname(c.filePath) : docsDir()
    let dir = path.isAbsolute(raw) ? raw : path.join(docsDirBase(), raw)
    dir = dir.replace(/[\\/]+$/, '')
    if (process.platform === 'win32') dir = path.win32.normalize(dir.replace(/\//g, '\\'))
    return dir
  }
  const MIME_MAP = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8',
  }
  // GET /api/canvas/file?name=attachments/xxx.png —— 读画布附件（路径限制在画布目录内）
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/file', handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const rel = url.searchParams.get('name') || ''
      const base = path.resolve(canvasDocDir())
      const full = path.resolve(base, rel)
      const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
      if (norm(full) !== norm(base) && norm(full).indexOf(norm(base) + path.sep) !== 0) {
        error(res, 403, { ok: false, error: '非法路径' }); return
      }
      if (!nodefs.existsSync(full) || !nodefs.statSync(full).isFile()) {
        error(res, 404, { ok: false, error: '文件不存在' }); return
      }
      const ext = (full.split('.').pop() || '').toLowerCase()
      const mime = MIME_MAP[ext] || 'application/octet-stream'
      const buf = nodefs.readFileSync(full)
      const disp = /^(image|video|audio)\//.test(mime) || ext === 'pdf' ? 'inline' : 'attachment'
      const fname = path.basename(full)
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': buf.length,
        'Content-Disposition': disp + "; filename*=UTF-8''" + encodeURIComponent(fname),
        'Cache-Control': 'no-cache',
      })
      res.end(buf)
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/upload?name=xxx —— 画布附件上传（图片粘贴等），存 canvas-docs/attachments/
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/upload', handler: async (req, res) => {
    try {
      if (req.method !== 'POST') { error(res, 405, { ok: false, error: 'POST only' }); return }
      const url = new URL(req.url, 'http://x')
      let name = url.searchParams.get('name') || 'file.bin'
      name = String(name).replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || 'file.bin'
      const body = await readRawBody(req, UPLOAD_LIMIT)
      if (!body || !body.length) { error(res, 400, { ok: false, error: '空文件' }); return }
      const dir = path.join(canvasDocDir(), 'attachments')
      try { nodefs.mkdirSync(dir, { recursive: true }) } catch (e) {}
      const fname = Date.now() + '-' + name
      nodefs.writeFileSync(path.join(dir, fname), body)
      console.log('[collab-canvas] upload:', fname, body.length + 'B')
      json(res, { ok: true, path: 'attachments/' + fname, name: name, size: body.length })
    } catch (e) { error(res, 500, { ok: false, error: e.message }) }
  }}))
  function readRawBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > limit) { reject(new Error('文件超过大小上限')); try { req.destroy() } catch (_) {} ; return }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }
  // GET /api/canvas/docdrop.js、doclink.js、selref.js —— 提供独立客户端模块源码
  //（client 入口动态挂载；每次读盘，改完刷新页面即生效，无需重启）。
  // 注意：运行时路径相对于部署目录的 dist/host.js 解析（../lib/…）
  // ⚠️ 这个名单是服务端常量，新增一项需要重启 dsh web 才认得出该端点。
  ;['docdrop.js', 'doclink.js', 'selref.js'].forEach(function (modFile) {
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/' + modFile, handler: async (req, res) => {
      try {
        const srcPath = new URL('../lib/' + modFile, import.meta.url)
        const src = nodefs.readFileSync(srcPath, 'utf8')
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
        res.end(src)
      } catch (e) { error(res, 500, { ok: false, error: e.message }) }
    }}))
  })

  // 启动文件登记表：无配置文件则先写默认（会话工作区），再自愈补登记 + 异步扫描
  setTimeout(function () {
    try {
      if (!nodefs.existsSync(REG_CONFIG_FILE())) {
        regSaveConfig([sessionWorkspaceDir()])
        console.log('[collab-canvas] registry: 首次运行，默认登记会话工作区 ->', sessionWorkspaceDir())
      }
      regSeedIfEmpty()
      console.log('[collab-canvas] file registry:', regFolders.length ? regFolders.join(' | ') : '(未登记文件夹)', '索引', regTotal, '文件')
    } catch (e) { console.error('[collab-canvas] registry init failed:', e && e.message) }
  }, 0)
}

    // ==================== 13-selref-context.js ====================
// ═══ 话布选区 · 把「用户引用的那段到底在哪」主动告诉模型 ═════════════════
// 为什么要有它（2026-09-15 主人拍板）：
//   canvas_locate 是「模型自己来问」。实测靠不住 —— 模型看到引用标签上的
//   「多处（第 2 处）」很可能**不问**，凭感觉挑一处就改，改错了比不回答更糟。
//   所以改成「先把答案送到它手上」：用户一旦把引用发出来，位置就已经在
//   它的上下文里躺着了，它不需要知道有这么个工具也能改对地方。
//
// canvas_locate 不撤：注入可能因为各种原因没覆盖到（用户手打引用、格式怪、
//   解析失败），那时它仍是兜底。两条路是**互补**的，不是替代。
//
// 位置怎么来的：不新算一套。复用 07-tools.js 里 canvas_locate 的 occIndexes /
//   lineColOf（同一作用域，直接可用），保证"注入说的"和"工具说的"永远一致。
//
// 生命周期：**完全交给官方**，自己一个定时器都不加。
//   官方每个 step 都会重新求值下面这个 provider，只有文本变了才推一条新的
//   上下文消息、文本变空就把上一条抹掉（RuntimeContextProjection 的替换机制）。
//   于是：
//     · 用户这轮发了引用   → 算出内容 → 注入
//     · 同一轮里模型跑很多步 → 文本没变 → 不重复刷屏
//     · 下一轮用户没引用    → 文本变空 → 官方自动抹掉，不留残影
//   ⚠️ 所以**千万别加 TTL / 别自己清** —— 那不是帮忙，是跟官方机制打架。
//
// ⚠️ 这条消息会以一行「注入」的样子出现在聊天里（跟时间上下文一模一样，
//    label 是插件名）。不是隐形注入，主人看得见。
//
// [[CCV-SELCTX-BEGIN]] —— 下面到 END 之间是这块功能的全部代码。
//   tools/test-host-selctx.cjs 靠这两个标记把这段**真代码**切出来单独跑，
//   不是照抄一份来测。挪动或删除标记会让那份测试失效。

// ── 一、取「用户这一步要处理的那条消息」─────────────────────────
// 官方求值 provider 时会把当前 agent 交给我们（assembleContextFor 里
// 返回 {agent, scope, signal}），顺着 agent.session 就能读到这次对话。
// ⚠️ 必须**同步**：官方求值不带 await（`entry.text(context)` 直接调用），
//   返回 Promise 只会被当成一个奇怪的字符串塞进 prompt。
//
// 🔴🔴 为什么要**两条通道**（2026-09-15 主人报「提示讲的是上一条消息」）
//
// 官方第 1 步求值上下文的顺序是死的（dsh-agent-loop 的 preStep）：
//     ① claim()                             把待处理消息从队列里取走
//     ② systemPrompt.assemble()   ← 我们在这里求值
//     ③ session.append("user/message", …)   消息**这时**才写进会话界面
// 所以第 1 步里"会话界面上的最后一条人消息"**就是上一条**，怎么看都晚一拍
// （一天四次实测都是这个规律，同一回合的第 2 步才追上）。
//
// → **不能只看界面。** 还有一条更早的记录：官方**一收到**消息就把它放进
//   待处理队列（`agent/inbox/spliced` 事件里的 data.inserted），那一步在整轮
//   开始之前，所以第 1 步也读得到 —— 它才是"这一步正在处理的那条消息"。
//
// 两条通道都读，取**新的那条**：
//   · 队列那条更新 → 界面还没追上，用队列的（第 1 步就靠它）
//   · 界面那条更新 → 界面已追上，两条内容一样，用界面那条更省事
// 兜底通道（只能看界面时）再加一道**否决**，见 ccvTurnMsg。

// ── 诊断：服务端这一侧怎么判断的，也落盘 ─────────────────────────
// 客户端那份日志在 %TEMP%/ccv-selbar.log（09-http.js 落盘）。
// 这里另写一份 %TEMP%/ccv-selctx.log —— **不抢同一个文件**，复盘时两边对得上。
// 「为什么没注入」和「注入了什么」都写在这条线上；全部 try/catch，
// 诊断绝不能影响注入本身。
var CCV_TRACE_FILE = ''
try {
  if (typeof process !== 'undefined' && process && process.env) {
    CCV_TRACE_FILE = (process.env.TEMP || process.env.TMPDIR || '.') + '/ccv-selctx.log'
  }
} catch (e) { CCV_TRACE_FILE = '' }
var ccvTraceRing = []

function ccvClock(t) {
  try {
    var d = new Date(t)
    function p(n) { return n < 10 ? '0' + n : '' + n }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  } catch (e) { return String(t) }
}

function ccvTrace(msg) {
  try {
    ccvTraceRing.push(ccvClock(Date.now()) + ' ' + String(msg))
    if (ccvTraceRing.length > 300) ccvTraceRing = ccvTraceRing.slice(ccvTraceRing.length - 300)
    if (!CCV_TRACE_FILE) return
    if (typeof nodefs === 'undefined' || !nodefs || !nodefs.writeFileSync) return
    nodefs.writeFileSync(CCV_TRACE_FILE, ccvTraceRing.join('\n') + '\n', 'utf8')
  } catch (e) { /* 落盘失败不影响注入 */ }
}

// 「不是人打的字」的来源。这些一律跳过，继续往前找。
var CCV_INJECT_KINDS = {
  'plugin': true,               // 插件注入的上下文（包括我们自己这条）
  'session-reference': true,    // 跨会话引用
  'agent-instructions': true,
  'skill-invocation': true
}

// 一条消息里的纯文字。content 可能是字符串，也可能是分块的数组。
function ccvMsgText(msg) {
  if (!msg) return ''
  var content = msg.content
  if (typeof content === 'string') return content
  if (!content || !content.length) return ''
  var out = []
  for (var i = 0; i < content.length; i++) {
    var b = content[i]
    if (b && b.type === 'text' && typeof b.text === 'string') out.push(b.text)
  }
  return out.join('\n')
}

// 这条消息算不算"人打的"。是 → 返回正文；不是 → null。
function ccvHumanTextOf(msg) {
  if (!msg) return null
  var kind = msg.source && msg.source.kind
  if (kind && CCV_INJECT_KINDS[kind]) return null
  var t = ccvMsgText(msg)
  return t || null
}

// ── 通道 A：会话界面（可能晚一拍）────────────────────────────────
// ⚠️ 必须**往前找**而不是只看最后一条：我们自己注入的那条也是 user/message，
//   只看最后一条会看到自己，那就永远解析不出引用了。
// 反过来这也给了我们一个好性质：用户发了新的、不带引用的消息时，
//   最近这条就变成它 → 解析不出引用 → 返回空 → 官方把注入抹掉。
function ccvFromSurface(agent) {
  var session = agent && agent.session
  if (!session) return null
  var nodes = session.surface && session.surface.nodes
  if (!nodes || !nodes.length) return null
  for (var i = nodes.length - 1; i >= 0; i--) {
    var ev = session.eventAt(nodes[i])
    if (!ev || ev.type !== 'user/message') continue
    var t = ccvHumanTextOf(ev.data)
    if (!t) continue
    return { text: t, time: typeof ev.time === 'number' ? ev.time : 0, src: '界面' }
  }
  return null
}

// ── 通道 B：待处理队列的记录（更早，不晚拍）───────────────────────
// 事件名与形状照抄官方（dsh-agent-loop 的 ReactLoopInbox.mutate）：
//   session.append('agent/inbox/spliced', { target, start, inserted, … })
// 认领/取消只带 removedCount、inserted 为空 → 跳过（那是噪音，不是新消息）。
//
// 🔴 这里用**白名单**：只有 source.kind === 'user' 才算人打的。
//   理由：这条队列里还流着别的东西（工具结果带回来的补充上下文等），
//   用"排除法"容易漏掉没见过的 kind，那就把机器塞的东西当成用户说的话了。
//   （界面那条通道仍用排除法 —— 它本来就工作正常，不动它。）
var CCV_INBOX_EVENT = 'agent/inbox/spliced'

function ccvInboxHumanText(msg) {
  var kind = msg && msg.source && msg.source.kind
  if (kind !== 'user') return null
  var t = ccvMsgText(msg)
  return t || null
}

function ccvFromInbox(agent) {
  var session = agent && agent.session
  if (!session || typeof session.snapshotEvents !== 'function') return null
  var events = null
  try { events = session.snapshotEvents() } catch (e) { return null }
  if (!events || !events.length) return null
  for (var i = events.length - 1; i >= 0; i--) {
    var ev = events[i]
    if (!ev || ev.type !== CCV_INBOX_EVENT) continue
    var ins = ev.data && ev.data.inserted
    if (!ins || !ins.length) continue
    // 这一批里没有"人打的字"（多半是工具结果带进来的补充上下文）→ 继续往前翻。
    // 往前翻是安全的：翻出来的**一定不比界面那条更旧**（提交必然早于进界面），
    // 所以不会退化成"讲上一条消息"。
    for (var k = ins.length - 1; k >= 0; k--) {
      var t = ccvInboxHumanText(ins[k])
      if (t) return { text: t, time: typeof ev.time === 'number' ? ev.time : 0, src: '队列' }
    }
  }
  return null
}

// 挑出「这一步要处理的那条消息」→ {text, time, src}；拿不到 → null。
// 🔴 兜底通道（只能看界面）上多一道**否决**：界面这条消息，比我收到的最新一次
//   选区上报还旧 → 说明用户在这条之后又引用过东西、界面还没追上 → 我看的不是
//   这一步的消息 → **一个字都不说**。宁可不说，也不说错。
//   （队列通道不需要这道：队列那条就是提交本身，不可能比上报旧。）
function ccvTurnMsg(agent) {
  var byInbox = ccvFromInbox(agent)
  var bySurface = ccvFromSurface(agent)
  if (byInbox && bySurface) return byInbox.time >= bySurface.time ? byInbox : bySurface
  if (byInbox) return byInbox
  if (!bySurface) return null
  var newestPinAt = ccvPins.length ? (ccvPins[ccvPins.length - 1].at || 0) : 0
  if (bySurface.time > 0 && newestPinAt > bySurface.time) {
    ccvTrace('否决：界面这条消息（' + ccvClock(bySurface.time) + '）比我收到的最新上报（'
      + ccvClock(newestPinAt) + '）还旧 → 界面没追上，本轮不注入')
    return null
  }
  return bySurface
}

// ── 一·五、客户端报上来的「你划的是第几处」──────────────────────
// 为什么服务端自己算不出：序数靠的是**划选那一刻的 DOM 位置**，
// 只有浏览器那边知道 —— 服务端只知道原文长什么样，不知道你指的是哪一处。
//
// 🔴 而引用正文里现在**也不写坐标了**（2026-09-15 主人要求卡片只留文件名），
//   所以这条上报通道成了"第几处"的**唯一来源**。它和 lib/selref.js 里的
//   pinUp() 是一对，**必须一起改**：只改一边，模型就彻底不知道用户指哪儿了。
//
// 上报时机是 capture()（用户点「问AI」/划选那一刻），比发送早得多，
// 所以这里不会出现"消息先到、记录后到"的竞态。
var CCV_PINS_MAX = 8      // 只留最近几条，覆盖式；不清理也不会涨
var ccvPins = []
// 每收一条上报就 +1。**专供下面那份 memo 失效用**，见 ccvBuildSelContext。
// 没有它会出一个很难发现又很致命的错：用户前后两次引用同一段原文
// （这段文字在文档里出现多处），两次的引用正文**一字不差**，
// memo 会把第二次挡掉、继续用第一次的序数 → 模型改错地方。
var ccvPinSeq = 0

function ccvPinAdd(p) {
  try {
    if (!p || typeof p !== 'object') return false
    var text = String(p.text || '')
    if (!text) return false
    ccvPins.push({
      code: p.code,
      path: ccvNormPathForRef(p.path),
      title: String(p.title || ''),
      text: text,
      ordinal: typeof p.ordinal === 'number' ? p.ordinal : 0,
      dupCount: typeof p.dupCount === 'number' ? p.dupCount : 0,
      line: typeof p.line === 'number' ? p.line : -1,
      heading: String(p.heading || ''),
      // 时间戳默认取"此刻"；允许上报里自带（诊断与测试要造"更旧/更新"的场景）。
      at: typeof p.at === 'number' && p.at > 0 ? p.at : Date.now(),
    })
    if (ccvPins.length > CCV_PINS_MAX) ccvPins = ccvPins.slice(ccvPins.length - CCV_PINS_MAX)
    ccvPinSeq++
    return true
  } catch (e) {
    return false
  }
}

// 找出这条引用对应的上报记录。取**最新**的一条 —— 用户的操作顺序天然是
// 「先划选、再发送」，所以最新那条就是这次的。
// ⚠️ 已知边界：同一段原文连着划两次、却只发出第一条引用时，会取到后一条的序数。
//   罕见，且注入文案里保留了每处的上下文供核对，不会静默改错。
//
// 🔴 `used` 是**本次拼装里已经用掉的上报**：一条消息里引用了两段不同的原文、
//   但它们被解析成同一个 `q`（比如原文本身含「」被截短）时，两条会抢同一条上报
//   → 第二条拿到第一条的序数 → 改错地方。所以用过的不能再给下一条用。
function ccvPinFind(path, quote, used) {
  var want = ccvNormPathForRef(path)
  var q = String(quote || '')
  if (!q) return null
  for (var i = ccvPins.length - 1; i >= 0; i--) {
    var p = ccvPins[i]
    if (used && used.length && used.indexOf(p) >= 0) continue
    // 精确相等最好；但解析出来的原文在"原文本身含「」"时会被截短，
    // 所以也接受"它是上报原文的前缀"（截短只会往前截，不会变形）。
    if (p.text !== q && p.text.indexOf(q) !== 0) continue
    if (want && p.path && p.path !== want) continue
    return p
  }
  return null
}

// ── 二、从消息正文里认出「话布选区引用」──────────────────────────
// 引用正文的形状由 lib/selref.js 的 codec.serialize 生成，**只有两行**：
//   @"D:\...\canvas-docs\话布优化.md"
//   「原文」
// 拿不到真实路径时第 1 行退化成：
//   【话布选区】文档名
//   「原文」
//
// 🔴 2026-09-15 起标签**整串没有了**（主人要求对话里那张卡片只留文件名）。
//   于是"第几处"改从上报记录拿（ccvPinFind）。但抬头仍然要认、也仍然要
//   **兼容带标签的老形态** —— 浏览器缓存里的旧客户端、以及用户手打的引用，
//   都可能还带着「> 小标题 · 第 21 行 · 多处（第 2 处）」。
//
// 只有上面这两种抬头才认。**用户自己在正文里写**
//   他说：
//   「你好」
// **绝不能被当成引用** —— 那会让我们凭空定位一段用户根本没引用的话。
var CCV_REF_LINE_RE = /(^|\n)([^\n]*)\n「([\s\S]*?)」/g

// 抬头是不是引用。返回 'mention' / 'plain' / null（null = 不认）。
function ccvRefHeadKind(head) {
  var h = String(head || '').trim()
  if (!h) return null
  if (h.charAt(0) === '@') return 'mention'
  if (h.indexOf('【话布选区】') === 0) return 'plain'
  return null
}

// 从 @"路径" 里取出路径。没写引号就截到 " > " 之前。
// ⚠️ 先 trim：抬头行前面可能带空格（用户手工复制粘贴引用时会），
//   不 trim 就会认不出路径 → 安静地退化成"没找到文档"。实测踩过。
function ccvRefPath(head) {
  var h = String(head || '').trim()
  if (h.charAt(0) !== '@') return ''
  var rest = h.slice(1)
  if (rest.charAt(0) === '"') {
    var end = rest.indexOf('"', 1)
    if (end > 0) return rest.slice(1, end)
  }
  var gt = rest.indexOf(' > ')
  return (gt >= 0 ? rest.slice(0, gt) : rest).trim()
}

// 从 【话布选区】文档名 · 标签 里取文档名。（同样要先 trim）
function ccvRefTitle(head) {
  var h = String(head || '').trim()
  var tag = '【话布选区】'
  if (h.indexOf(tag) !== 0) return ''
  var rest = h.slice(tag.length)
  var cut = rest.indexOf(' · ')
  return (cut >= 0 ? rest.slice(0, cut) : rest).trim()
}

// 标签里的「多处（第 2 处）」→ 2。没写「第几处」→ 0（不编数字）。
function ccvRefOrdinal(head) {
  var m = /多处（第\s*(\d+)\s*处）/.exec(String(head || ''))
  if (!m) return 0
  var n = parseInt(m[1], 10)
  return isFinite(n) && n > 0 ? n : 0
}

// 「多处」两个字在不在。标记存在但序数没对上时，仍然要告诉模型别猜。
function ccvRefHasDup(head) {
  return /多处/.test(String(head || ''))
}

// 把一条消息里所有引用块抠出来 → [{head, kind, quote, ordinal, dup}]
// ⚠️ 原文本身可能含「」：非贪婪先截到第一个「」，交给下面 ccvQuoteVariants
//   在文档里找不到时再往下一个「」延长。这里只负责"先给最短的那个"。
function ccvParseRefs(text) {
  var src = String(text || '')
  if (src.indexOf('「') < 0) return []
  var out = []
  CCV_REF_LINE_RE.lastIndex = 0
  var m
  while ((m = CCV_REF_LINE_RE.exec(src)) !== null) {
    var head = m[2]
    var kind = ccvRefHeadKind(head)
    if (!kind) continue                       // 抬头不像引用 → 用户自己写的，跳过
    var quote = m[3]
    if (!quote || !quote.replace(/\s/g, '')) continue
    out.push({
      head: head,
      kind: kind,
      quote: quote,
      path: kind === 'mention' ? ccvRefPath(head) : '',
      title: kind === 'plain' ? ccvRefTitle(head) : '',
      ordinal: ccvRefOrdinal(head),
      dup: ccvRefHasDup(head)
    })
    if (out.length >= 5) break                // 一条消息里引用太多就不再认了
  }
  return out
}

// 原文含「」时，上面会截短。给出"截短版 + 逐个延长版"，让定位去试。
// 正常情况下第一个就命中，延长版根本不看。
function ccvQuoteVariants(text, start) {
  var out = []
  var from = start
  for (var i = 0; i < 3; i++) {
    var end = String(text).indexOf('」', from)
    if (end < 0) break
    out.push(String(text).slice(start, end))
    from = end + 1
  }
  return out.length ? out : [String(text).slice(start)]
}

// ── 三、找文档 ──────────────────────────────────────────────────
// ⚠️ 刻意**不用** findCanvasByArg：它在路径匹配不上时会退回「当前活跃文档」，
//   而那很可能**不是**引用说的那份 —— 拿错文档算出来的位置比不注入更糟。
//   这里宁可认不出（说"没找到"），也不猜。
function ccvNormPathForRef(s) {
  return String(s || '').replace(/\\/g, '/').replace(/^"+|"+$/g, '').replace(/\/+$/, '')
}

function ccvFindDoc(ref) {
  if (ref.path) {
    var want = ccvNormPathForRef(ref.path)
    if (!want) return null
    var hit = null
    canvases.forEach(function (c) {
      if (!hit && c.filePath && ccvNormPathForRef(c.filePath) === want) hit = c
    })
    if (!hit) {
      // 路径对不上时，用文件名兜一次（大小写与分隔符差异）
      var tail = want.slice(want.lastIndexOf('/') + 1)
      canvases.forEach(function (c) {
        if (hit || !c.filePath) return
        var cw = ccvNormPathForRef(c.filePath)
        if (cw.slice(cw.lastIndexOf('/') + 1) === tail) hit = c
      })
    }
    return hit
  }
  if (ref.title) {
    var byTitle = null
    canvases.forEach(function (c) { if (!byTitle && c.title === ref.title) byTitle = c })
    return byTitle
  }
  return null
}

// ── 四、算定位，拼成给模型看的一段话 ─────────────────────────────
var CCV_SEL_CTX_PAD = 24      // 每处前后各带多少字
var CCV_SEL_MAX_SPOTS = 5     // 最多列几处
var CCV_SEL_QUOTE_MAX = 40    // 摘要里原文最多显示几个字
var CCV_SEL_TOTAL_MAX = 1200  // 整段注入的长度上限

function ccvShortQuote(s, max) {
  var t = String(s || '')
  return t.length <= max ? t : t.slice(0, max) + '…'
}

// 一处长这样：…前文【原文】后文…
function ccvSpotExcerpt(content, idx, quote) {
  var a = Math.max(0, idx - CCV_SEL_CTX_PAD)
  var b = Math.min(content.length, idx + quote.length + CCV_SEL_CTX_PAD)
  return (a > 0 ? '…' : '')
    + asOneLine(content.slice(a, idx))
    + '【' + asOneLine(ccvShortQuote(quote, CCV_SEL_QUOTE_MAX)) + '】'
    + asOneLine(content.slice(idx + quote.length, b))
    + (b < content.length ? '…' : '')
}

// 单条引用 → 一段话。返回 '' 表示这条不值得注入（比如找不到文档）。
// `used` 见 ccvPinFind：同一次拼装里上报记录不许被两条引用重复认领。
function ccvDescribeRef(ref, used) {
  var who = ref.path || ref.title || '（未标注）'
  var c = ccvFindDoc(ref)
  if (!c) {
    return '· 用户引用了「' + ccvShortQuote(ref.quote, CCV_SEL_QUOTE_MAX)
      + '」（' + who + '），但没找到这份话布文档（可能已改名或删掉）。'
      + '先 canvas_list 看看，别在别的文档里找相似内容改。'
  }
  var content = String(c.content || '')

  // 原文含「」时会被截短 —— 逐个延长版去试，谁在文档里出现就用谁
  var quote = ''
  var idxs = []
  var variants = ccvQuoteVariants(ref.quote, 0)
  for (var i = 0; i < variants.length; i++) {
    var tryQ = variants[i]
    if (!tryQ) continue
    var hits = occIndexes(content, tryQ)
    if (hits.length) { quote = tryQ; idxs = hits; break }
  }

  // 全文都找不到 → 引用已经失效。这是最要紧的一种，必须说死。
  if (!idxs.length) {
    return '· 用户引用了《' + c.title + '》里的「' + ccvShortQuote(ref.quote, CCV_SEL_QUOTE_MAX)
      + '」，但这段原文**现在全文都找不到了** —— 这段引用已经失效'
      + '（多半是引用发出之后文档被改过）。'
      + '动手前请让用户重新划一次要引用的段落，**不要**去找相似的内容照着改。'
  }

  var shown = idxs.slice(0, CCV_SEL_MAX_SPOTS)

  // 只有一处：直接说死
  if (idxs.length === 1) {
    var lc1 = lineColOf(content, idxs[0])
    return '· 《' + c.title + '》「' + ccvShortQuote(quote, CCV_SEL_QUOTE_MAX)
      + '」在第 ' + lc1.line + ' 行，**全文只有这一处**：\n  '
      + ccvSpotExcerpt(content, idxs[0], quote)
  }

  // 多处：把目标那一处标出来，其余只报行号（够模型核对，又不啰嗦）
  //
  // 序数从哪来：**客户端刚报上来的**优先（引用正文里已经不写了）；
  // 拿不到才退回看抬头标签（兼容没更新的客户端 / 用户手打的引用）。
  // 两个都没有 → 绝不替模型挑一处，让它把每处摆给用户确认。
  var pin = ccvPinFind(ref.path, quote, used)
  if (pin && used && used.indexOf(pin) < 0) used.push(pin)
  var ordinal = (pin && pin.ordinal > 0) ? pin.ordinal : ref.ordinal

  var head = '· 《' + c.title + '》「' + ccvShortQuote(quote, CCV_SEL_QUOTE_MAX)
    + '」全文共 ' + idxs.length + ' 处'
  if (ordinal > 0 && ordinal <= idxs.length) {
    head += '，**用户要的就是第 ' + ordinal + ' 处**（他划中的是这一处）'
  } else {
    head += '，仅凭行号分不出来'
  }
  head += '：'

  var lines = [head]
  var target = ordinal > 0 && ordinal <= idxs.length ? ordinal - 1 : -1
  for (var k = 0; k < shown.length; k++) {
    var lc = lineColOf(content, shown[k])
    var isTarget = k === target
    lines.push('  ' + (isTarget ? '★第 ' + (k + 1) + ' 处（第 ' + lc.line + ' 行）'
                                : '  第 ' + (k + 1) + ' 处（第 ' + lc.line + ' 行）')
      + '：' + ccvSpotExcerpt(content, shown[k], quote))
  }
  if (idxs.length > shown.length) {
    lines.push('  （后面还有 ' + (idxs.length - shown.length) + ' 处，略）')
  }

  if (target >= 0) {
    lines.push('  → 动这段文字时照上面标 ★ 的那一处改，别的几处不要碰。')
  } else {
    lines.push('  → 分不出用户要哪一处。请把上面每处的上下文摆给用户，让他确认改哪一处，不要自己挑一处改。')
  }
  return lines.join('\n')
}

// 把最近一条人消息里的引用整体描述出来。没有引用 / 出错 → 空串（= 不注入）。
// ⚠️ 这个函数会被官方**每个 step 调一次**，而且**同步**调。所以：
//   · 全程 try/catch，任何异常都退化成一件事：不注入。
//     （provider 抛错会毁掉整个 prompt 组装 —— 那比不注入严重得多。）
//   · 结果按正文做一次 memo：同一轮里正文没变就直接复用。
//     ⚠️ 键里**必须**带上上报计数和记录条数（见下），不能只看正文 ——
//     同一段原文出现多处时，用户前后两次引用拼出来的正文可以一字不差，
//     只按正文做键就会把第二次挡掉，让模型拿着第一次的序数去改。
var ccvSelCtxMemo = { key: null, val: '' }

function ccvBuildSelContext(context) {
  try {
    var agent = context && context.agent
    var picked = ccvTurnMsg(agent)
    if (!picked) { ccvSelCtxMemo = { key: null, val: '' }; return '' }
    var text = picked.text
    // ⚠️ 键里**必须**带上报计数与记录条数（见下），也带"这是哪条消息"（来源+时间）——
    // 少一个维度就会把"消息换了、内容恰好一样"的两次当成同一次，拿旧序数去改。
    var memoKey = picked.src + '#' + picked.time + '#' + text + '#' + ccvPinSeq + '#' + ccvPins.length
    if (ccvSelCtxMemo.key === memoKey) return ccvSelCtxMemo.val

    var refs = ccvParseRefs(text)
    var blocks = []
    var usedPins = []
    for (var i = 0; i < refs.length && i < 3; i++) {
      var one = ccvDescribeRef(refs[i], usedPins)
      if (one) blocks.push(one)
    }
    var out = ''
    if (blocks.length) {
      out = '【话布选区】用户这轮引用了话布里的文字。它**到底在哪一处**已经先替你查好了，'
        + '按下面的位置改就行，不必再问：\n' + blocks.join('\n')
      if (out.length > CCV_SEL_TOTAL_MAX) out = out.slice(0, CCV_SEL_TOTAL_MAX) + '\n（内容过长，已截断）'
    }
    ccvTrace('这一步的消息来自「' + picked.src + '」（' + ccvClock(picked.time) + '），'
      + '认出 ' + refs.length + ' 条引用，注入 ' + blocks.length + ' 条；'
      + '手上上报 ' + ccvPins.length + ' 条')
    ccvSelCtxMemo = { key: memoKey, val: out }
    return out
  } catch (e) {
    try { console.error('[collab-canvas] sel-context failed:', e && e.message) } catch (_) {}
    return ''
  }
}

// ── 五、注册成官方动态上下文 ────────────────────────────────────
// name 必须全局唯一（重名官方直接抛错）；order 只要是个有限数，
// 排在其他上下文（沙箱策略 110 / 审批 115 / 子代理 120）之后。
try {
  var spSel = ctx.get('systemPrompt')
  if (spSel && typeof spSel.context === 'function') {
    spSel.context({
      name: 'collab-canvas-selection',
      order: 160,
      text: ccvBuildSelContext,
    })
    console.log('[collab-canvas]', 'selection context registered')
  }
} catch (e) {
  console.error('[collab-canvas] selection context failed:', e && e.message)
}
// [[CCV-SELCTX-END]]

    // ==================== 99-tail.js ====================
// 启动引导：恢复持久化状态 + 注册 HTTP 端点
;(async function () {
  await restore()
  console.log('[collab-canvas]', 'host half ready, docsDir =', docsDir())

  // 注册画布 HTTP 端点
  try {
    const webServer = ctx.get('webServer')
    if (webServer) {
      initCanvasHttpEndpoints(ctx, webServer)
      initCanvasExtraEndpoints(ctx, webServer)   // 11-canvas-extras.js：拖拽/登记表/删除/模块服务
    } else {
      console.warn('[collab-canvas]', 'webServer 服务未找到，跳过')
    }
  } catch (e) {
    console.error('[collab-canvas]', '初始化失败:', e && e.message)
  }
})()
}
