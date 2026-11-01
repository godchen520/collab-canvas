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
