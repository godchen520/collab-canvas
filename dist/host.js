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

// ── HTTP 响应辅助（2026-10-26 重构 P2：从 09-http / 11-extras 各一份合并到这里）──
//   原来的问题是两个文件各写一份同名函数 ✗ 改一处忘一处就行为不一致 ✓
//   注意两者的**语义差异**（合并时必须保留 ✓）：
//     · httpReadBody(req)      → 返回 **Buffer**（上传要用原始字节 ✓ 支持大小上限）
//     · httpReadJson(req)      → 返回**解析后的对象**（普通 RPC 用 ✓ 解析失败抛错）
function httpJson(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}
function httpError(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}
function httpReadBody(req, limit) {
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
function httpReadJson(req) {
  return httpReadBody(req).then((buf) => JSON.parse(buf.toString('utf8')))
}

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
  const payload = JSON.stringify({ activeId: activeId, rootOverride: rootOverride, canvases: Array.from(canvases.values()).filter(function (c) {
    // ⚠️ 选区编辑区（type='scratch'）**不落盘**（2026-10-11 加）。
    //   它是一次性对象：拼接成功后立刻销毁；重启即消失。
    //   规格见 canvas-docs/话布选区编辑区方案.md 第四、九节。
    //   一旦写进 meta 就不再"一次性"了 —— 实施步骤 6 专门验这条。
    return c && c.type !== 'scratch'
  }).map(function (c) {
    // ⚠️ version 必须存 —— 2026-10-04 补。
    //   它原本不存，于是 restore 时一律 `version: 1`，后果有两个：
    //     ① **所有靠版本号的保护在重启后失效**：草稿基准校验（草稿记的 base=1、
    //        服务端重启后也是 1 → 误判成"基准相符" → 把过期草稿写回去覆盖新内容）、
    //        并发冲突校验（knownVer 走的是同一套版本号）都形同虚设；
    //     ② **事后无法追溯**：撤销每次都会把版本 +1，本来能数出"被撤了几次"，
    //        重启一重置就再也看不出来（2026-10-04 那次误判就是这么丢的线索 ——
    //        把"主人点了 3 次撤销"误判成了"面板覆盖"）。
    return { id: c.id, title: c.title, type: c.type, filePath: c.filePath, version: c.version }
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

// ── 每轮结束落一次盘（2026-10-14 加）─────────────────────────────
// 为什么：AI 用 canvas_write 写画布走的是 applyWrite → debouncedFlush（**1.5 秒** ✗），
//   进程/会话在那一秒半里重启就丢 ✗。而"一轮结束"是很自然的检查点 ✓
//   —— 把暴露窗口从"几轮"缩到"一轮之内" ✓
// 主人 2026-10-14 的现场：AI 追加的附录因会话重启全丢 ✗（根因是 restore 覆盖，
//   但"更早落盘"能把这个坑填得更死 ✓ 两道一起上 ✓）
//
// ⚠️ 挂 **ctx.root**，不是插件自己的 ctx —— 作用域树上插件 ctx 是 agent 作用域的
//    **兄弟分支** ✗ 事件只往上冒到祖先 ✓（2026-10-11 在拼接那边踩过这个坑 ✓）
try {
  var flushEvCtx = (ctx && ctx.root) ? ctx.root : ctx
  if (flushEvCtx && typeof flushEvCtx.on === 'function') {
    flushEvCtx.on('agent/turn-stopping', function () { try { flushDirty() } catch (_) {} })
    flushEvCtx.on('session/event', function (session, event) {
      try { if (event && event.type === 'turn/end') flushDirty() } catch (_) {}
    })
    console.log('[collab-canvas]', 'turn-end flush registered')
  }
} catch (e) { console.error('[collab-canvas] turn-end flush 注册失败:', e && e.message) }

// [[CCV-RESTORE-BEGIN]] —— 到 END 之间是「启动/重载时恢复画布」的全部代码。
// tools/test-host-restore.cjs 会把这一段切出来跑（标记没了它立刻报错，不会悄悄测过期副本）。
async function restore() {
  if (!fs) { console.error('[collab-canvas]', 'fs service unavailable — persistence disabled'); return }

  // 🔴🔴 **先把内存里没落盘的改动写下去，再读文件**（2026-10-14 加，修数据丢失）
  //
  // 为什么必须放在最前面：restore() 会在**同一个进程里被重跑** ——
  //   会话重启 / 插件重载都会让它再跑一次 ✓ 而那时 canvases 里**还留着**上一轮的
  //   内容（可能比文件新 ✓ 因为落盘是 1.5 秒防抖的 ✗）。
  //   它下面无条件 `content = 读文件` + `canvases.set(...)` ——
  //   等于**拿旧文件覆盖新内存** ✗✗
  //
  // 主人 2026-10-14 的现场（别的项目里）：
  //   AI 用 canvas_write 追加了附录 A/B/C，几轮之后会话重启 →
  //   插件重新初始化 → restore 从文件读回 9752 字节的**原始版** →
  //   覆盖掉内存里的新版 → **附录全丢** ✗ 而且 dirty 被设成 false，
  //   连"还没存"这件事都看不出来了 ✗
  //   同一个根因还造成了"话布登记被重置"（meta 也没落盘 ✓）
  //
  // 冷启动时内存是空的 → 这一步是空操作 ✓ 不会有副作用 ✓
  try { await flushDirty() } catch (e) { console.error('[collab-canvas] restore 前落盘失败:', e && e.message) }

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
      // 🔴 **绝不拿文件覆盖"内存里有未保存改动"的那一份**（2026-10-14 加）
      //   上面已经 flushDirty 过一次 ✓ 正常情况这里不会命中；
      //   但落盘可能失败（OneDrive 占用、磁盘满、权限 ✗）—— 那时 dirty 还是 true ✓
      //   这份内存内容比文件新 ✓ 用文件覆盖它就是**丢数据** ✗✗
      //   所以：保留内存那份（内容/历史/脏标记都不动），只把 meta 里能补的补上 ✓
      const live = canvases.get(m.id)
      if (live && live.dirty) {
        if (m.filePath && !live.filePath) live.filePath = m.filePath
        if (typeof m.version === 'number' && m.version > live.version) live.version = m.version
        console.error('[collab-canvas] restore: 保留内存里未落盘的改动（不覆盖）', m.id, m.title)
        continue
      }
      canvases.set(m.id, {
        id: m.id, title: m.title, type: m.type || 'document', content: content,
        // 版本号跟着 meta 一起存（见 persistMeta 的注释）：拿不到才退回 1
        version: (typeof m.version === 'number' && m.version > 0) ? m.version : 1,
        filePath: m.filePath || null, history: [], redoStack: [],
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
// [[CCV-RESTORE-END]]

    // ==================== 05-mutations.js ====================
// 共享变更逻辑（RPC 与模型工具共用同一套历史栈）
// [[CCV-UNDO-BEGIN]] —— 到 END 之间是「历史栈 + 撤销/重做」的全部代码，
// tools/test-host-undo.cjs 会把这一段切出来跑（标记没了它立刻报错，不会悄悄测过期副本）。
var HISTORY_MAX = 50
// 连续编辑合并的时间窗（见 pushHistory 里的说明）
var HISTORY_MERGE_MS = 60 * 1000
function pushHistory(c, before, after, source, version) {
  // ★ 合并连续编辑（2026-10-11 加）—— **自动保存的前提** ✓
  //   为什么要它：接了自动保存之后，停手 1.5 秒就可能写一次 ✓ 若每次都落一条历史 ✗
  //   撤销栈会被冲爆（按一次撤销只退一小步 ✗ 主人会以为"撤不动"✗）。
  //   成熟文档软件都做这件事（Google Docs 把短时间内的连续编辑合成一个版本 ✓）。
  //
  //   判据三条，缺一不可：
  //     ① 来源相同 —— AI 改的与人改的不该合成一步 ✗（撤销时想分清是谁改的 ✓）
  //     ② 时间相近 —— 隔太久的两段编辑该分开，否则撤销粒度太粗 ✗
  //     ③ **首尾相接**：新一次的 before === 上一条的 after ✓✓ —— 这条最硬，
  //        它证明中间**没有任何别的改动**（撤销 / 重做 / 别处的写入都会破坏它 ✓）
  var last = c.history.length ? c.history[c.history.length - 1] : null
  if (last && last.source === source
    && (Date.now() - (last.at || 0)) < HISTORY_MERGE_MS
    && last.after === before) {
    last.after = after            // 终点往后延 ✓ 起点不动 ✓
    last.at = Date.now()
    last.version = version
    c.redoStack.length = 0
    return
  }
  c.history.push({ opId: 'op-' + Date.now().toString(36) + '-' + (++idSeq), source: source, before: before, after: after, at: Date.now(), version: version })
  if (c.history.length > HISTORY_MAX) c.history.shift()
  c.redoStack.length = 0
}

// ═══ 撤销 / 重做 ══════════════════════════════════════════════════
// 为什么抽成函数：包级 RPC（06-rpc）和 HTTP 端点（09-http）都要用它。
// 两处各写一套的话，日后改一处漏一处 —— meta 落点那次故障就是这么来的
// （persistMeta 与 restore 各持一份候选清单，DSH 升级后两者都没包含真正的存储根）。
//
// ⚠️ 只回退 content，**不往 history 里塞新条目**：否则「撤销」本身变成一步可撤销的操作，
//    按一次栈也跟着长，用户会觉得撤不回去（撤了 A，栈顶又变成刚才那次撤销）。
// ⚠️ version 必须 +1：客户端靠 knownVer 做并发保护，版本不动的话它下一次写入
//    还是拿着旧版本号 → 被自己挡下或误判成冲突。返回新版本号，客户端据此同步。
// ⚠️ dirty + debouncedFlush：撤销的结果要落盘，否则刷新后撤销白做。
function undoCanvas(c) {
  if (!c) return { ok: false, error: '画布不存在' }
  if (!c.history.length) return { ok: true, noop: true, content: c.content, version: c.version }
  const rec = c.history.pop()
  c.redoStack.push(rec)
  c.content = rec.before
  c.version += 1
  c.dirty = true
  c.updatedAt = Date.now()
  debouncedFlush()
  return { ok: true, content: c.content, version: c.version, source: rec.source || null, at: rec.at || null }
}
function redoCanvas(c) {
  if (!c) return { ok: false, error: '画布不存在' }
  if (!c.redoStack.length) return { ok: true, noop: true, content: c.content, version: c.version }
  const rec = c.redoStack.pop()
  c.history.push(rec)
  c.content = rec.after
  c.version += 1
  c.dirty = true
  c.updatedAt = Date.now()
  debouncedFlush()
  return { ok: true, content: c.content, version: c.version, source: rec.source || null, at: rec.at || null }
}
// 给界面用：按钮该不该灰掉。调用方在 read/write/undo/redo 的响应里带上它。
function canUndo(c) { return !!(c && c.history && c.history.length) }
function canRedo(c) { return !!(c && c.redoStack && c.redoStack.length) }
// [[CCV-UNDO-END]]


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

// ─── 选区编辑区（scratch 画布）─────────────────────────────────────
// 规格：canvas-docs/话布选区编辑区方案.md（第三、四节）
//
// 形态：一个**临时画布**，type='scratch'。借画布的壳只为两件事 ——
//   ① 给 AI 一条**现成的写入通道**（canvas_write，不用给它造新工具）
//   ② 白得一套版本号与历史栈（撤销直接可用）
// 三条约束（第九节「明确不做」）：
//   · 不进任何清单（list 端点过滤 type==='scratch'）
//   · 不写进 meta（persistMeta 过滤）—— 一次性对象，重启即消失
//   · 不给人看、不给人改（没有界面）
//
// ⚠️ 刻意**不调用** persistMeta / debouncedFlush —— 它是内存对象，
//    一旦落盘就不再"一次性"了（步骤 6 专门验这条）。
let scratchSeq = 0
function createScratchCanvas(b) {
  b = b || {}
  const id = 'scratch-' + Date.now().toString(36) + '-' + (++scratchSeq)
  const quote = String(b.quote || '')
  const c = {
    id: id, title: '选区片段', type: 'scratch',
    content: quote, version: 1, filePath: null,
    history: [], redoStack: [], dirty: false, updatedAt: Date.now(),
    // 绑定：主文档 + 位置 + 指纹。位置由 host 侧按**引文与序数**解析
    //（与「位置主动注入」用同一套算法 —— 渲染前后出现顺序不变，口径一致）。
    scratch: {
      docId: b.docId || null,
      docPath: b.docPath || null,
      offset: (typeof b.offset === 'number') ? b.offset : -1,
      length: (typeof b.length === 'number' && b.length >= 0) ? b.length : quote.length,
      docVersion: (typeof b.docVersion === 'number') ? b.docVersion : 0,
      ordinal: (typeof b.ordinal === 'number') ? b.ordinal : 0,
      dupCount: (typeof b.dupCount === 'number') ? b.dupCount : 0,
      // 哪一笔上报建的这个区 —— 注入时靠它把「这一轮引用到的」认出来
      pinCode: (typeof b.pinCode === 'number') ? b.pinCode : 0,
      // ⚠️ **建区时的原始引文**（2026-10-11 加，拼接要用）。
      //   为什么必须单独留一份：编辑区的内容会被 AI 改掉 ✗，而拼接前要校验
      //   "主文档 [偏移, 偏移+长度) 那一段还是不是原来那段" —— 拿被改过的内容去比
      //   必然比不过 ✗。
      origQuote: quote,
      spliced: false,
      at: Date.now(),
    },
  }
  canvases.set(id, c)
  return c
}

// 找某个 pin 建出来的编辑区（没有就返回 null）
function scratchForPin(pinCode) {
  if (!pinCode) return null
  let hit = null
  canvases.forEach(function (c) {
    if (hit) return
    if (c && c.type === 'scratch' && c.scratch && c.scratch.pinCode === pinCode) hit = c
  })
  return hit
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
    // ★ 2026-10-22：补上 filePath ✓（主人要在右侧栏「话布」清单里【点一下跳到文档】✓）
    //   原来只回 hasFile ✗ → 前端拿不到路径 → 那个清单只能是死文字 ✓
    //   ⚠️ 没必要藏它：它本来就是本机路径 ✓ 而这个接口只有本机 UI 在用 ✓
    arr.push({ id: c.id, title: c.title, type: c.type, updatedAt: c.updatedAt, hasFile: !!c.filePath, filePath: c.filePath || null })
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
  // 逻辑在 05-mutations 的 undoCanvas —— 与 HTTP 端点共用同一份（别在这儿另写一套）
  return undoCanvas(c)
})

harness.handle('canvas.redo', async function (args) {
  const c = canvases.get(args && args.canvasId)
  if (!c) return err('E_NOT_FOUND', '画布不存在')
  return redoCanvas(c)
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
    try { sessAddExclusive(lastBrowserSid, c.id) } catch (_) {}
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
      try { sessAddExclusive(lastBrowserSid, c.id) } catch (_) {}
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
// ★ 2026-10-24：分组改成【唯一归属】（一篇文档只属于一个会话）★
//   事故（主人现场）：「我拖动换组怎么成这样了」
//   根因：sessAdd 只往新组**追加**，从不把文档从旧组摘掉 ✗
//     → 同一篇文档同时挂在好几个 .json 里 ✓
//     → 界面按"先遇到的组"显示它 ✗ → 它跑到没预期的组里 / 拖走以后旧组那份还在 ✓
//   现在：登记到某组时，顺手把它从**其它所有组**里摘掉 ✓
//   代价：要读一遍 .json（21 个，实测 11~16ms ✓）—— 只在打开/新建文档时发生 ✓
function sessAddExclusive(sid, id) {
  // ⚠️ 没有会话键、或键就是历史兜底桶 'default' → **不登记** ✓
  //   别再把文档塞进那个假会话里 ✗（2026-10-24 那批就是这么进去的 ✓）
  if (!sid || String(sid) === 'default') return
  const target = sessSafe(sid)
  // ① 先从其它组里摘掉 ✓（不碰目标组 ✓）
  let files = []
  try { files = nodefs.readdirSync(sessDirPath()).filter(f => /\.json$/i.test(f)) } catch (_) {}
  for (const f of files) {
    const key = String(f).replace(/\.json$/i, '')
    if (key === target) continue                    // 目标组不动 ✓
    const fp = joinPath(sessDirPath(), f)
    let j = null
    try { j = JSON.parse(nodefs.readFileSync(fp, 'utf8')) } catch (_) { continue }
    if (!j || !Array.isArray(j.ids) || j.ids.indexOf(id) < 0) continue
    j.ids = j.ids.filter(x => x !== id)
    const nextActive = (j.activeId === id) ? (j.ids[0] || null) : (j.activeId || null)
    try { nodefs.writeFileSync(fp, JSON.stringify({ activeId: nextActive, ids: j.ids }, null, 2)) } catch (_) {}
    sessStore.delete(key)
  }
  // ② 再登记到目标组 ✓
  sessAdd(sid, id)
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
  // HTTP 响应辅助：2026-10-26 重构 P2 起统一由 01-utils.js 提供
  //   httpJson / httpError / httpReadBody(Buffer) / httpReadJson(解析对象)
  //   原来是本文件与 11-canvas-extras 各写一份 ✗ 语义还不完全一致（Buffer vs JSON）
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
      // ⚠️ 选区编辑区（type='scratch'）**不进任何清单**（2026-10-11 加）。
      //   它不是给人看的，是 AI 的工作台（规格第九节「明确不做」：不加分组、不加行）。
      canvases.forEach((c) => { if (c && c.type !== 'scratch') all.push({ id: c.id, title: c.title, version: c.version, path: canvasMdPath(c) }) })
      httpJson(res, { ok: true, canvases: all, activeId: activeId, scope: 'all' })
      return
    }
    // ★ ?scope=groups —— 按【会话】分组（2026-10-24 主人要求）★
    //   为什么新增一个 scope 而不是改老的两个：
    //     老的 scope=all / scope=sid 都有人在用（客户端做标题链接、会话清单）✗
    //     改它们的返回形状 = 静默弄坏别处 ✓ 所以只**新增**一个分支 ✓
    //   数据来源：canvas-docs/.sessions/<sid>.json 里的 { activeId, ids } ✓
    //     —— 这份归属关系早就有（09-http.js 顶部那套 sessState），
    //        只是一直没有"把全部会话一起返回"的接口 ✓
    //   返回：
    //     groups   [{ sid, activeId, ids: [...] }]   按 .json 的修改时间**倒序**（最近用过的在前）
    //     canvases 全量元数据（id/title/path/updatedAt），客户端按 id 拼装
    //   规则：
    //     · 跳过 type='scratch' ✓（AI 工作台，不进任何清单 ✓）
    //     · 跳过 ids 全都不存在的空组 ✓（不显示空会话 ✓）
    if (url.searchParams.get('scope') === 'groups') {
      const dir = sessDirPath()
      let files = []
      try { files = nodefs.readdirSync(dir).filter((f) => /\.json$/i.test(f)) } catch (_) {}
      // ① 先全部读出来 ✓
      const entries = []
      for (const f of files) {
        let mt = 0
        let j = null
        try {
          mt = nodefs.statSync(joinPath(dir, f)).mtimeMs || 0
          j = JSON.parse(nodefs.readFileSync(joinPath(dir, f), 'utf8'))
        } catch (_) { continue }
        if (!j || !Array.isArray(j.ids)) continue
        entries.push({ f, key: String(f).replace(/\.json$/i, ''), mt, j, fp: joinPath(dir, f) })
      }
      // ② ★ 归一：每篇文档只留【一个】归属，并写回磁盘（2026-10-24）★
      //   主人症状：「我移动文档改分组，怎么乱变分组」
      //   根因（实测）：25 篇里 10 篇同时挂在多个组 ✗（有一篇挂了 5 个组 ✓）
      //     而我上一版是**按文件修改时间去决定归属** ✗
      //     → 每拖动一次，目标文件的时间戳变新 ✓
      //     → 下一次读，其它重复文档的归属也跟着变 ✓ → 界面"乱变"✓✓
      //   修法：在**服务端**把重复彻底收敛掉 ✓ 规则稳定、与时间无关：
      //     真会话键优先（session-…）→ 其次键名升序（确定性 ✓ 不随写入漂移 ✓）
      //     归谁就写回磁盘：从其它组的 ids 里摘掉 ✓ 以后再也不重复 ✓
      const ranked = entries.slice().sort((a, b) => {
        const ar = /^session-/.test(a.key) ? 1 : 0
        const br = /^session-/.test(b.key) ? 1 : 0
        if (ar !== br) return br - ar                 // 真会话优先 ✓
        return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0)   // 其余按键名 ✓ 稳定 ✓
      })
      const ownerOf = {}
      for (const e of ranked) {
        for (const id of e.j.ids) { if (!ownerOf[id]) ownerOf[id] = e.key }
      }
      let normalized = 0
      for (const e of entries) {
        const keep = e.j.ids.filter((id) => ownerOf[id] === e.key)
        if (keep.length === e.j.ids.length) continue
        const nextActive = (e.j.activeId && keep.indexOf(e.j.activeId) >= 0) ? e.j.activeId : (keep[0] || null)
        try { nodefs.writeFileSync(e.fp, JSON.stringify({ activeId: nextActive, ids: keep }, null, 2)) } catch (_) {}
        sessStore.delete(e.key)
        e.j = { activeId: nextActive, ids: keep }
        normalized++
      }
      if (normalized) {
        console.log('[collab-canvas] 分组归一：' + normalized + ' 个组的重复归属已收敛（每篇文档只留一个归属）')
      }
      // ③ 组装分组（顺序只影响客户端默认排序 ✓ 客户端会自己按更新时间和当前会话重排 ✓）
      const withTime = []
      for (const e of entries) {
        const ids = e.j.ids.filter((id) => {
          const c = id ? canvases.get(id) : null
          return !!(c && c.type !== 'scratch')
        })
        if (!ids.length) continue          // 空组不返回 ✓
        withTime.push({ mtime: e.mt, g: { sid: e.key, activeId: e.j.activeId || null, ids } })
      }
      withTime.sort((a, b) => b.mtime - a.mtime)
      const groupsOut = withTime.map((x) => x.g)
      const all = []
      canvases.forEach((c) => {
        if (!c || c.type === 'scratch') return
        all.push({ id: c.id, title: c.title, version: c.version, path: canvasMdPath(c), updatedAt: c.updatedAt || 0 })
      })
      httpJson(res, {
        ok: true,
        scope: 'groups',
        // real: 这个键是不是【真会话 id】（session-… 形式）。
        //   2026-10-24 之前客户端用的是 hash(会话名) 当键 ✗ → 那些组查不到会话名 ✓
        //   客户端会拿 hash(会话名) 反着撞一遍，能撞上的就当那个会话 ✓（见客户端注释）
        groups: groupsOut.map((g) => Object.assign({ real: /^session-/.test(g.sid) }, g)),
        canvases: all,
        activeId: activeId,
      })
      return
    }
    const sid = sessSafe(url.searchParams.get('sid'))
    lastBrowserSid = sid
    const st = sessState(sid)
    const arr = []
    st.ids.forEach((id) => { const c = canvases.get(id); if (c && c.type !== 'scratch') arr.push({ id: c.id, title: c.title, version: c.version, path: canvasMdPath(c) }) })
    httpJson(res, { ok: true, canvases: arr, activeId: st.activeId })
  }}))
  // GET /api/canvas/read?id=xxx —— 打开过就记入该会话清单
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/read', handler: async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const id = url.searchParams.get('id')
    const c = id ? canvases.get(id) : (activeId ? canvases.get(activeId) : null)
    if (!c) { httpError(res, 404, { ok: false, error: '画布不存在' }); return }
    // ★ 2026-10-24 事故防线 ★
    //   「打开的文档都跑到旧记录.default 里去了，打开一个进去一个」
    //   根因：查看器那两处请求**没带 sid** ✗ → sessSafe(null) 退成 'default' ✗
    //     → 每打开一篇就默默堆进 default ✓（和 12 篇老文档混在一起 ✓）
    //   客户端已修（补 sid）✓ 这里再加一道：
    //     **sid 没带就别登记** ✓ —— 宁可让它落在「未归属」（看得见 ✓）
    //     也不要静默塞进一个假会话 ✓
    const sidRaw = url.searchParams.get('sid')
    if (sidRaw) {
      sessAddExclusive(sidRaw, c.id)
      lastBrowserSid = sessSafe(sidRaw)
    }
    httpJson(res, { ok: true, id: c.id, title: c.title, content: c.content, version: c.version, path: canvasMdPath(c), canUndo: canUndo(c), canRedo: canRedo(c) })
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
    if (isNaN(since)) { httpError(res, 400, { ok: false, error: 'since 必须是数字' }); return }
    const out = aiChanges.filter((x) => x.seq > since)
    httpJson(res, { ok: true, latest: aiChangeSeq, changes: out })
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
      if (req.method !== 'POST') { httpError(res, 405, { ok: false, error: '只收 POST' }); return }
      const body = await httpReadJson(req)
      const taken = ccvPinAdd(body)
      httpJson(res, { ok: taken, n: ccvPins.length })
    } catch (e) { httpError(res, 400, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/scratch —— 开一个「选区编辑区」
  // 规格：canvas-docs/话布选区编辑区方案.md（第二、三、七节）
  // 客户端点「问 AI」时调它。body: { pinCode, docId, docPath, quote, ordinal, dupCount }
  //
  // 🔴 偏移由 **host 侧**按「引文 + 序数」解析，客户端不必把 DOM 偏移硬换算成
  //    markdown 偏移 —— 那一步最容易错（渲染会吃掉 `**`、拆并段落）。
  //    口径与「位置主动注入」完全一致：**渲染前后文字的出现顺序不变**，
  //    所以两边数出来的"第几处"是同一个数（见 13-selref-context.js 的注释）。
  // 解析不出来（序数越界 / 引文找不到）→ offset 记 -1，**不猜**；
  //    实施步骤 3（拼接）遇到 -1 会报给主人，而不是硬拼。
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/scratch', handler: async (req, res) => {
    try {
      if (req.method !== 'POST') { httpError(res, 405, { ok: false, error: '只收 POST' }); return }
      const body = await httpReadJson(req)
      const quote = String(body.quote || '')
      if (!quote.trim()) { httpError(res, 400, { ok: false, error: '没有引文' }); return }

      // 找主文档：优先 id，其次按真实路径（正斜杠、忽略大小写）
      let doc = body.docId ? canvases.get(body.docId) : null
      if (!doc && body.docPath) {
        const want = String(body.docPath).replace(/\\/g, '/').toLowerCase()
        canvases.forEach(function (c) {
          if (doc || !c || c.type === 'scratch') return
          const p = String(c.filePath || '').replace(/\\/g, '/').toLowerCase()
          if (p && p === want) doc = c
        })
      }

      let offset = -1
      let dup = 0
      if (doc) {
        const hits = occIndexes(String(doc.content || ''), quote)
        dup = hits.length
        const ord = (typeof body.ordinal === 'number' && body.ordinal > 0) ? body.ordinal : 0
        if (ord > 0 && ord <= hits.length) offset = hits[ord - 1]
        else if (hits.length === 1) offset = hits[0]
      }

      const c = createScratchCanvas({
        docId: doc ? doc.id : null,
        docPath: doc ? canvasMdPath(doc) : (body.docPath || null),
        offset: offset,
        length: quote.length,
        docVersion: doc ? doc.version : 0,
        ordinal: body.ordinal,
        dupCount: dup || body.dupCount,
        pinCode: body.pinCode,
        quote: quote,
      })
      ccvTrace('开了选区编辑区 ' + c.id + '（主文档=' + (doc ? doc.title : '没找到')
        + '，偏移=' + offset + '，全文 ' + dup + ' 处，序数=' + (body.ordinal || 0) + '）')
      httpJson(res, { ok: true, areaId: c.id, offset: offset, dupCount: dup })
    } catch (e) { httpError(res, 400, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/write
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/write', handler: async (req, res) => {
    try {
      const body = await httpReadJson(req)
      const id = body.id || activeId
      const c = id ? canvases.get(id) : null
      if (!c) { httpError(res, 404, { ok: false, error: '画布不存在' }); return }
      const result = applyWrite(c, body.content, 'replace', body.knownVer, 'human')
      // ⚠️ 冲突必须显式回传。applyWrite 检出并发冲突时返回
      //    { conflict, currentVersion, currentContent }，此时 result.version 是 undefined；
      //    若照原样 httpJson({ ok: true, version: result.version })，
      //    undefined 会被 JSON.stringify 丢掉 → 响应变成 {"ok":true} ——
      //    冲突被伪装成成功，浏览器编辑器无从察觉，只能继续用旧内容写。
      if (result && result.conflict) {
        httpJson(res, { ok: false, conflict: true, currentVersion: result.currentVersion, currentContent: result.currentContent })
        return
      }
      httpJson(res, { ok: true, version: result.version, canUndo: canUndo(c), canRedo: canRedo(c) })
    } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/undo | /api/canvas/redo
  //
  // 为什么必须加 HTTP 这一层：撤销栈（history/redoStack）和 canvas.undo RPC
  // **早就在了**，但那是走 harness.handle 的包级 RPC，而画布面板只走 HTTP
  // （/api/canvas/*）—— 两边根本不连通，于是"有撤销"这件事在界面上等于不存在
  // （2026-09-28 核对：lib/client.js 里 undo|redo 零命中，09-http.js 也一个端点都没有）。
  //
  // 语义：把 content 换成快照里的 before/after，version+1（客户端靠它同步 knownVer），
  // 结果落盘。栈空时回 { ok:true, noop:true } 而不是报错 —— 界面据此提示"没有可撤销的了"。
  function undoRedoEndpoint(path, fn) {
    ctx.effect(() => webServer.register({ kind: 'exact', path: path, handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { httpError(res, 405, { ok: false, error: '只收 POST' }); return }
        const body = await httpReadJson(req)
        const id = body.id || activeId
        const c = id ? canvases.get(id) : null
        if (!c) { httpError(res, 404, { ok: false, error: '画布不存在' }); return }
        const r = fn(c)
        if (!r.ok) { httpError(res, 404, { ok: false, error: r.error }); return }
        // ⚠️ **立刻落盘**（2026-10-11 加，修"撤销有延迟"）
        //   默认路径是 applyWrite → debouncedFlush（1500ms ✗），而查看器是**等文件变化**
        //   才刷新正文的 → 两段延迟叠起来手感很明显（主人报"撤回重做有延迟"）。
        //   撤销/重做是**人的一次性动作**，没有连打的场景 —— 不值得为它省一次写盘 ✓
        //   所以这里跳过 debounce 直接 flush（写盘量很小，就一篇文档 ✓）。
        try { await flushDirty() } catch (_) {}
        httpJson(res, { ok: true, noop: !!r.noop, content: r.content, version: r.version, source: r.source || null, canUndo: canUndo(c), canRedo: canRedo(c) })
      } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
    }}))
  }
  undoRedoEndpoint('/api/canvas/undo', undoCanvas)
  undoRedoEndpoint('/api/canvas/redo', redoCanvas)
  // POST /api/canvas/create?sid=xxx —— 新建即记入当前会话清单
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/create', handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const body = await httpReadJson(req)
      const c = createCanvasDoc(body.title || '新话布')
      // 同上：sid 没带就别登记 ✓（别塞进假会话 'default' ✗）
      const sidCreate = url.searchParams.get('sid')
      if (sidCreate) sessAddExclusive(sidCreate, c.id)
      httpJson(res, { ok: true, id: c.id, title: c.title })
    } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
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
        const body = await httpReadJson(req)
        const lines = Array.isArray(body.lines) ? body.lines : [String(body.line || '')]
        lines.forEach(function (l) { _dbg.push(ts() + ' ' + String(l)) })
        if (_dbg.length > DBG_MAX) _dbg = _dbg.slice(_dbg.length - DBG_MAX)
        dbgWrite()
        httpJson(res, { ok: true, n: _dbg.length, file: DEBUG_LOG })
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(_dbg.join('\n') + '\n')
      }
    } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
  }}))
  // ─── POST /api/canvas/move-group —— 把一篇文档挪到另一个分组 ──────────
  //   2026-10-24 主人要求「我要能自由拖动改分组」✓
  //   分组**只是索引** ✓ 这里只动 .sessions/*.json 里的 id 数组 ✓
  //   **绝不碰 md 文件、绝不碰 filePath、绝不碰内容** ✓（主人确认过这条 ✓）
  //   body: { id, toSid }   toSid 为空字符串 = 移出所有组（回到「未归属」）✓
  //   ⚠️ 改完必须清 sessStore 缓存 ✗ 否则内存里还是旧清单 ✓
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/move-group', handler: async (req, res) => {
    try {
      if (req.method !== 'POST') { httpError(res, 405, { ok: false, error: '只收 POST' }); return }
      const body = await httpReadJson(req)
      const id = String((body && body.id) || '').trim()
      const toSid = String((body && body.toSid) || '').trim()
      if (!id) { httpError(res, 400, { ok: false, error: '缺 id' }); return }
      const c = canvases.get(id)
      if (!c) { httpError(res, 404, { ok: false, error: '文档不存在' }); return }
      if (c.type === 'scratch') { httpError(res, 400, { ok: false, error: 'scratch 不进任何分组' }); return }
      const dir = sessDirPath()
      let files = []
      try { files = nodefs.readdirSync(dir).filter((f) => /\.json$/i.test(f)) } catch (_) {}
      let removed = 0
      for (const f of files) {
        const fp = joinPath(dir, f)
        let j = null
        try { j = JSON.parse(nodefs.readFileSync(fp, 'utf8')) } catch (_) { continue }
        if (!j || !Array.isArray(j.ids) || j.ids.indexOf(id) < 0) continue
        j.ids = j.ids.filter((x) => x !== id)
        const nextActive = (j.activeId === id) ? (j.ids[0] || null) : (j.activeId || null)
        try { nodefs.writeFileSync(fp, JSON.stringify({ activeId: nextActive, ids: j.ids }, null, 2)) } catch (_) {}
        sessStore.delete(String(f).replace(/\.json$/i, ''))
        removed++
      }
      let targetSid = ''
      if (toSid) {
        targetSid = sessSafe(toSid)
        const st = sessLoad(targetSid)          // 从盘读，别用可能过期的缓存 ✓
        if (st.ids.indexOf(id) < 0) st.ids.push(id)
        const keepActive = (st.activeId && st.ids.indexOf(st.activeId) >= 0) ? st.activeId : id
        sessPersist(targetSid, { activeId: keepActive, ids: st.ids })
        sessStore.delete(targetSid)
      }
      httpJson(res, { ok: true, id, removed, toSid: targetSid })
    } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
  }}))
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
    httpJson(res, { ok: true, dir: dir, raw: raw, exists: info.exists, pid: info.pid, strategy: info.strategy })
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
    } catch (e) { console.httpError('[collab-canvas] session-cwd probe failed:', e && e.message) }
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
    } catch (e) { console.httpError('[collab-canvas] registry config read failed:', e && e.message) }
    return []
  }
  function regSaveConfig(folders) {
    try {
      nodefs.writeFileSync(REG_CONFIG_FILE(), JSON.stringify({ folders: folders }, null, 2))
    } catch (e) { console.httpError('[collab-canvas] registry config write failed:', e && e.message) }
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
    } catch (e) { console.httpError('[collab-canvas] registry scan failed:', folder, e && e.message) }
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
    } catch (e) { console.httpError('[collab-canvas] registry watch failed:', folder, e && e.message) }
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
        const body = await httpReadBody(req)
        const folders = Array.isArray(body.folders) ? body.folders.map(s => String(s).trim()).filter(Boolean) : []
        const invalid = folders.filter(f => !path.isAbsolute(f) || !nodefs.existsSync(f) || !nodefs.statSync(f).isDirectory())
        if (invalid.length) { httpError(res, 400, { ok: false, error: '以下路径无效或不是文件夹: ' + invalid.join(', ') }); return }
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
        httpJson(res, { ok: true, folders: regFolders.slice(), files: regTotal, note: '索引构建中' })
        return
      }
      httpJson(res, { ok: true, folders: regFolders.slice(), files: regTotal })
    } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
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
      httpJson(res, { ok: true, name: name, matches: matches, folders: regFolders.length })
    } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
  }}))
  // GET /api/canvas/load-doc?rel=canvas-docs/xxx.md —— 把 canvas-docs 里的 md
  // 注册为话布（按标题找已有，找不到新建）并返回画布 id——即 canvas_load 的最小实现
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/load-doc', handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const rel = String(url.searchParams.get('rel') || '')
      if (!/^canvas-docs\/[^\\/]+\.md$/i.test(rel)) { httpError(res, 400, { ok: false, error: '仅支持 canvas-docs/ 下的 .md 文件' }); return }
      const full = path.join(docsDir(), rel.slice('canvas-docs/'.length))
      if (!nodefs.existsSync(full)) { httpError(res, 404, { ok: false, error: '文件不存在' }); return }
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
        try { await saveCanvas(c) } catch (e) { console.httpError('[collab-canvas] load-doc save failed:', e && e.message) }
        created = true
      }
      sessAddExclusive(url.searchParams.get('sid'), c.id)   // 登记即记入当前会话清单
      httpJson(res, { ok: true, id: c.id, title: c.title, created: created })
    } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
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
      if (!raw) { httpError(res, 400, { ok: false, error: '缺少 path 参数' }); return }
      if (!/\.(md|markdown|txt|text)$/i.test(raw)) { httpError(res, 400, { ok: false, error: '仅支持 .md/.markdown/.txt' }); return }
      const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(sessionWorkspaceDir(), raw)
      if (!pathAllowedInTarget(abs)) {
        httpError(res, 403, { ok: false, error: '路径不在允许范围内（会话工作区 / 画布目录 / 已登记文件夹）' })
        return
      }
      if (!nodefs.existsSync(abs)) { httpError(res, 404, { ok: false, error: '文件不存在' }); return }
      let c = null
      canvases.forEach(function (x) {
        if (!c && x.filePath) { try { if (path.resolve(x.filePath) === abs) c = x } catch (_) {} }
      })
      let created = false
      if (!c) { c = await loadFileDoc(abs); created = true }
      sessAddExclusive(url.searchParams.get('sid'), c.id)
      httpJson(res, { ok: true, id: c.id, title: c.title, filePath: c.filePath, created: created })
    } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
  }}))
  // GET /api/canvas/delete?id=xxx&sid=xxx —— 从当前会话清单移除画布；
  // 若其他会话清单仍引用该画布则只摘引用保留文件，无人引用才连 md 一起删
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/delete', handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const id = url.searchParams.get('id')
      const sid = sessSafe(url.searchParams.get('sid'))
      const c = id ? canvases.get(id) : null
      if (!c) { httpError(res, 404, { ok: false, error: '画布不存在' }); return }
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
        } catch (e) { console.httpError('[collab-canvas] delete file failed:', e && e.message) }
        persistMeta()
      }
      httpJson(res, { ok: true, id: id, title: c.title, fileDeleted: !referenced })
    } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/import-doc?name=xxx —— 外部文档拖入/上传：复制到会话工作区
  // 的 uploads/ 文件夹（@ 文件选择器可索引到），返回相对路径供 @ 引用
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/import-doc', handler: async (req, res) => {
    try {
      if (req.method !== 'POST') { httpError(res, 405, { ok: false, error: 'POST only' }); return }
      const url = new URL(req.url, 'http://x')
      let name = url.searchParams.get('name') || 'doc.md'
      name = String(name).replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || 'doc.md'
      const body = await httpReadBody(req, UPLOAD_LIMIT)
      if (!body || !body.length) { httpError(res, 400, { ok: false, error: '空文件' }); return }
      const dir = path.join(sessionWorkspaceDir(), 'uploads')
      try { nodefs.mkdirSync(dir, { recursive: true }) } catch (e) {}
      const fname = Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '-' + name
      nodefs.writeFileSync(path.join(dir, fname), body)
      console.log('[collab-canvas] import-doc:', fname, body.length + 'B')
      httpJson(res, { ok: true, path: 'uploads/' + fname, name: name, size: body.length })
    } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
  }}))
  // GET /api/canvas/open-upload?name=xxx —— 把拖入上传的文档变成/打开话布：
  // 已有同名（去掉时间戳前缀后的标题，含/不含 .md 扩展名）话布 → 直接返回其 id；
  // 否则新建话布并写入文件内容。只允许读 uploads/ 目录、文件名限本插件生成的格式
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/open-upload', handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const fname = String(url.searchParams.get('name') || '')
      if (!/^\d{13}-[a-z0-9]{2,8}-[^\r\n\\/:"*?<>|]{1,120}$/i.test(fname)) { httpError(res, 400, { ok: false, error: '非法文件名' }); return }
      const upDir = path.join(sessionWorkspaceDir(), 'uploads')
      const full = path.join(upDir, fname)
      if (path.resolve(full).indexOf(path.resolve(upDir) + path.sep) !== 0) { httpError(res, 403, { ok: false, error: '非法路径' }); return }
      if (!nodefs.existsSync(full)) { httpError(res, 404, { ok: false, error: '文件不存在' }); return }
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
        try { await saveCanvas(c) } catch (e) { console.httpError('[collab-canvas] open-upload save failed:', e && e.message) }
        created = true
      }
      sessAddExclusive(url.searchParams.get('sid'), c.id)   // 导入即记入当前会话清单
      httpJson(res, { ok: true, id: c.id, title: c.title, created: created, matched: matched })
    } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
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
        httpError(res, 403, { ok: false, error: '非法路径' }); return
      }
      if (!nodefs.existsSync(full) || !nodefs.statSync(full).isFile()) {
        httpError(res, 404, { ok: false, error: '文件不存在' }); return
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
    } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
  }}))
  // POST /api/canvas/upload?name=xxx —— 画布附件上传（图片粘贴等），存 canvas-docs/attachments/
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/upload', handler: async (req, res) => {
    try {
      if (req.method !== 'POST') { httpError(res, 405, { ok: false, error: 'POST only' }); return }
      const url = new URL(req.url, 'http://x')
      let name = url.searchParams.get('name') || 'file.bin'
      name = String(name).replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || 'file.bin'
      const body = await readRawBody(req, UPLOAD_LIMIT)
      if (!body || !body.length) { httpError(res, 400, { ok: false, error: '空文件' }); return }
      const dir = path.join(canvasDocDir(), 'attachments')
      try { nodefs.mkdirSync(dir, { recursive: true }) } catch (e) {}
      const fname = Date.now() + '-' + name
      nodefs.writeFileSync(path.join(dir, fname), body)
      console.log('[collab-canvas] upload:', fname, body.length + 'B')
      httpJson(res, { ok: true, path: 'attachments/' + fname, name: name, size: body.length })
    } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
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
  // GET /api/canvas/selref.js、viewer-md.js、doc-model.js —— 提供独立客户端模块源码
  //（client 入口动态挂载；每次读盘，改完刷新页面即生效，无需重启）。
  // 注意：运行时路径相对于部署目录的 dist/host.js 解析（../lib/…）
  // ⚠️ 这个名单是服务端常量，新增一项需要重启 dsh web 才认得出该端点。
  // ⚠️ docdrop.js / doclink.js 于 2026-10-11 随画布面板一起删除（面板专属 ✗）。
  // ⚠️ doc-model.js 于 2026-10-15 加入（A4：按块转换要用它 ✓ 必须排在 viewer-md 之前 ✓）
  ;['ccv-logic.js', 'doc-model.js', 'selref.js', 'viewer-md.js'].forEach(function (modFile) {
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/canvas/' + modFile, handler: async (req, res) => {
      try {
        const srcPath = new URL('../lib/' + modFile, import.meta.url)
        const src = nodefs.readFileSync(srcPath, 'utf8')
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
        res.end(src)
      } catch (e) { httpError(res, 500, { ok: false, error: e.message }) }
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
    } catch (e) { console.httpError('[collab-canvas] registry init failed:', e && e.message) }
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

// 找出这条引用对应的上报记录。
//
// 🔴 2026-10-04 修正：**不再无脑取最新**，改成取「从后往前第 remaining 条」。
//
//   为什么：一条消息里出现两条**文字完全相同**的引用时（同一篇里同一个词选两处），
//   无脑取最新会让两条引用抢同一条上报、最后**正好互换**：
//       划第 5 处  → 上报 A(序数 5)     消息里第 1 条引用 → 从最新找 → 拿到 B(10) ✗
//       划第 10 处 → 上报 B(序数 10)    消息里第 2 条引用 → B 用过了 → 拿到 A(5)  ✗
//   主人 2026-10-04 实测的「改反了」就是这个 —— 而且是**静默改错**，界面上看不出来。
//   （旧注释把它判成"罕见、不会静默改错"，判错了。）
//
//   remaining = 这条消息里与它**文字相同**的引用还剩几条（含自己）：
//     · 只有 1 条引用（哪怕手上有历史上报）→ remaining=1 → 取最后一条 = 最新 ✓
//       保持原来的正确行为：重新引用同一段时，不会取到上次那条旧上报。
//     · 两条相同 → 第 1 条取倒数第 2 条、第 2 条取最后一条 ✓ 两条各归各位。
//
// 🔴 `used` 是**本次拼装里已经用掉的上报**：一条消息里引用了两段不同的原文、
//   但它们被解析成同一个 `q`（比如原文本身含「」被截短）时，两条会抢同一条上报
//   → 第二条拿到第一条的序数 → 改错地方。所以用过的不能再给下一条用。
function ccvPinFind(path, quote, used, remaining) {
  var want = ccvNormPathForRef(path)
  var q = String(quote || '')
  if (!q) return null
  // 先按**时间顺序**（旧 → 新）把所有匹配且没用过的收集起来，再按 remaining 从后往前取
  var matched = []
  for (var i = 0; i < ccvPins.length; i++) {
    var p = ccvPins[i]
    if (used && used.length && used.indexOf(p) >= 0) continue
    // 精确相等最好；但解析出来的原文在"原文本身含「」"时会被截短，
    // 所以也接受"它是上报原文的前缀"（截短只会往前截，不会变形）。
    if (p.text !== q && p.text.indexOf(q) !== 0) continue
    if (want && p.path && p.path !== want) continue
    matched.push(p)
  }
  if (!matched.length) return null
  var back = (typeof remaining === 'number' && remaining > 0) ? remaining : 1
  var k = matched.length - back
  if (k < 0) k = 0
  return matched[k]
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
function ccvDescribeRef(ref, used, remaining) {
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

  // 定位这一条引用对应的**上报**（拿它换序数，也拿它查"有没有开过编辑区"）。
  // 🔴 2026-10-11 起**提到分支之前** —— 单处引用也要查编辑区（编辑区与处数无关）。
  var pin = ccvPinFind(ref.path, quote, used, remaining)
  if (pin && used && used.indexOf(pin) < 0) used.push(pin)

  // 这一条引用开过「选区编辑区」吗？（实施步骤 1：建区 + 绑定 + 注入）
  var area = pin ? scratchForPin(pin.code) : null
  var areaAt = -1
  if (area) {
    var ordA = (pin.ordinal > 0) ? pin.ordinal : 0
    areaAt = (area.scratch && area.scratch.offset >= 0) ? area.scratch.offset
      : ((ordA > 0 && ordA <= idxs.length) ? idxs[ordA - 1] : (idxs.length === 1 ? idxs[0] : -1))
  }
  var tail = area ? ('\n' + ccvScratchBlock(area, c, areaAt, quote.length)) : ''

  var shown = idxs.slice(0, CCV_SEL_MAX_SPOTS)

  // 只有一处：直接说死
  if (idxs.length === 1) {
    var lc1 = lineColOf(content, idxs[0])
    return '· 《' + c.title + '》「' + ccvShortQuote(quote, CCV_SEL_QUOTE_MAX)
      + '」在第 ' + lc1.line + ' 行，**全文只有这一处**：\n  '
      + ccvSpotExcerpt(content, idxs[0], quote) + tail
  }

  // 多处：把目标那一处标出来，其余只报行号（够模型核对，又不啰嗦）
  //
  // 序数从哪来：**客户端刚报上来的**优先（引用正文里已经不写了）；
  // 拿不到才退回看抬头标签（兼容没更新的客户端 / 用户手打的引用）。
  // 两个都没有 → 绝不替模型挑一处，让它把每处摆给用户确认。
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
  return lines.join('\n') + tail
}

// ─── 选区编辑区的注入（实施步骤 1：建区 + 绑定 + 注入，先不拼接）──────
// 规格：canvas-docs/话布选区编辑区方案.md 第七节
//
// 为什么必须补语境：AI 只看到那一小段，你说"改成和上面一致"，它没有"上面"。
// 为什么最后那条要求是**硬要求**：AI 的习惯是写"以下是修改后的版本"、加代码块围栏 ——
//   将来拼回原文时那些说明文字就变成文档内容了 ✗（本步不拼接，但约束现在就立好）。
var CCV_SCRATCH_CTX = 60   // 上文/下文各取多少字符

function ccvScratchBlock(area, doc, offset, quoteLen) {
  if (!area) return ''
  var lines = []
  lines.push('· 上面这一段已经开成了**选区编辑区**（它不是给你看的，是给你改的工作台）。')
  lines.push('  改它就用现成的 canvas_write 写这个画布：id = ' + area.id
    + '（现在 v' + area.version + '）。**不要去改主文档**。')
  lines.push('  它现在的内容（原样）：')
  String(area.content || '').split('\n').forEach(function (l) { lines.push('  │ ' + l) })
  if (doc && offset >= 0) {
    var content = String(doc.content || '')
    var before = content.slice(Math.max(0, offset - CCV_SCRATCH_CTX), offset)
    var after = content.slice(offset + (quoteLen || 0), offset + (quoteLen || 0) + CCV_SCRATCH_CTX)
    if (before.replace(/\s/g, '')) lines.push('  上文：…' + before.replace(/\s+/g, ' '))
    if (after.replace(/\s/g, '')) lines.push('  下文：' + after.replace(/\s+/g, ' ') + '…')
  } else {
    lines.push('  （它在原文里的位置没解析出来 —— **别自己猜**，需要定位就问用户）')
  }
  lines.push('  ⚠️ 要求：**只写替换后的内容本身**。不要写"以下是修改后的版本"这类说明，')
  lines.push('     不要加代码块围栏，不要加前后缀 —— 你写的就是要放回原文那一段的东西。')
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

// 这一轮认到的引用（注入时留下，拼接时取用）。见 ccvBuildSelContext 里的注释：
// 轮末再解析已经来不及 —— 队列那条消息被 claim 走了，界面那条不带引用 ✗。
var ccvLastTurnRefs = null

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
    // 每条引用的 remaining = **从它起**（含自己）还有几条"同一篇 + 同一段原文"的引用。
    // 用途见 ccvPinFind：一条消息里两条文字完全相同的引用，靠它各归各位。
    var remainingOf = []
    for (var a = 0; a < refs.length; a++) {
      var n = 0
      for (var b = a; b < refs.length; b++) {
        if (String(refs[a].quote) === String(refs[b].quote)
          && (refs[a].path || refs[a].title) === (refs[b].path || refs[b].title)) n++
      }
      remainingOf.push(n)
    }
    // 🔴 把这一轮认到的引用**记下来**（2026-10-11 加，拼接要用）。
    //   为什么不能等轮末再解析：轮次一开始，队列那条消息就被 claim 走了
    //   （'agent/inbox/claimed' —— "One message left the inbox inside its open turn"），
    //   轮末只能退回读「界面」那条 —— 而**它不带引用** ✗。
    //
    //   ⚠️⚠️ 覆盖规则是踩出来的（2026-10-11 实测两轮）：
    //     同一轮里本函数会被调多次，而**不同通道读出来的结果不一样** ——
    //       17:50:52 来自「队列」→ 1 条引用 ✓
    //       17:51:11 来自「界面」→ 0 条引用 ✗
    //       17:51:25 来自「界面」（**时间自己往前走了**：17:50:52 → 17:51:11）→ 0 条 ✗
    //     第一版我用"时间相同 = 同一条消息"来判断 —— 失效 ✗（界面那条的时间会变）。
    //     最终规则（不依赖时间，最简单也最稳）：
    //       **只在看到引用时才写缓存** ✓ —— 永远不用"空的"去覆盖"有引用的" ✗
    //     清空交给拼接那边：**每轮结束都清**（包括没有引用的轮次）。
    try {
      if (refs.length) {
        ccvLastTurnRefs = { refs: refs, remaining: remainingOf, text: text, src: picked.src, time: picked.time, at: Date.now() }
      }
    } catch (_) {}
    var blocks = []
    var usedPins = []
    for (var i = 0; i < refs.length && i < 3; i++) {
      var one = ccvDescribeRef(refs[i], usedPins, remainingOf[i])
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

    // ==================== 14-scratch-splice.js ====================
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
