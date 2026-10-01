const fs = require('fs')
const path = require('path')
const os = require('os')

// DSH 部署根：由 DSH_HOME 的父目录推导（DSH_HOME 通常就是 <部署根>/.dsh），
// 可用环境变量 DSH_ROOT 显式覆盖。
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const ROOT = process.env.DSH_ROOT || path.dirname(DSH_HOME)
// 我预期会写的地方（插件部署目录）
const PLUGIN = path.join(ROOT, '.dsh/profiles/web/node_modules/collab-canvas').replace(/\\/g, '/')

// 本次会话大致起点（提交 384f8a5 之前就开始了，取今天 0 点保守些）
const TODAY = new Date()
TODAY.setHours(0, 0, 0, 0)
const SINCE = TODAY.getTime()

// 不扫这些（体量大且与问题无关）
const SKIP = new Set(['node_modules', '.git', '.pnpm'])
// 但 node_modules/@deepseek-ai 是重点，单独扫
const TARGETS = [
  { label: 'DSH 根目录（顶层文件）', dir: ROOT, depth: 0 },
  { label: 'DSH 本体包 node_modules/@deepseek-ai', dir: path.join(ROOT, 'node_modules/@deepseek-ai'), depth: 3 },
  { label: 'DSH 配置 .dsh（顶层）', dir: path.join(ROOT, '.dsh'), depth: 1 },
  { label: 'DSH 本体源码/脚本（顶层）', dir: path.join(ROOT, 'packages'), depth: 2 },
]

let total = 0
const hits = []

TARGETS.forEach(function (t) {
  let base
  try { base = fs.statSync(t.dir) } catch (_) { console.log('  跳过（不存在）: ' + t.dir); return }
  if (!base.isDirectory()) return
  const walk = (dir, depth) => {
    if (depth > t.depth) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      const norm = p.replace(/\\/g, '/')
      if (norm.indexOf(PLUGIN) === 0) continue          // 插件部署目录：预期会写
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue
        walk(p, depth + 1)
      } else {
        let st
        try { st = fs.statSync(p) } catch (_) { continue }
        if (st.mtimeMs >= SINCE) { hits.push({ p: norm, t: st.mtime, size: st.size }); total++ }
      }
    }
  }
  walk(t.dir, 0)
})

console.log('=== 扫描起点: ' + TODAY.toLocaleString('zh-CN') + ' 之后被修改的文件 ===')
console.log('')
if (!hits.length) {
  console.log('  （无）—— DSH 本体与配置均未被改动 ✓')
} else {
  hits.sort((a, b) => b.t - a.t).forEach(function (h) {
    console.log('  ' + h.t.toLocaleString('zh-CN') + '  ' + String(h.size).padStart(8) + 'B  ' + h.p.replace(ROOT + '/', ''))
  })
}
console.log('')
console.log('合计: ' + total + ' 个')
