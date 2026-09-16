#!/usr/bin/env node
// DSH Collab-Canvas · 上线前总检
//
// ⚠️ 这个脚本的历史教训（2026-09-16 修）：
//   1) 它以前**一个回归测试都不跑** —— 只做十几条写死的文本匹配。
//      于是"一键全绿"给了假的安心，而真正那 485 条断言可能一条都没过。
//      → 现在第 2 节会**真的去跑 tools/test-all.cjs**，失败则整体退出码为 1。
//   2) 它以前拿「工作区文件」和「git show HEAD:文件」做**原始字节比较**，
//      而本仓库 git 设了 core.autocrlf=true（检出转 CRLF）+ 自带工具写 LF，
//      两种换行符混着 → 永远报"不一致"，其实文件根本没改过。
//      → 现在一律**先统一换行符再比**。假红比不报还糟：它会训练人忽略输出。
//
// 用法：node tools/verify-all.cjs          （npm run verify）
// 退出码：0 = 全绿；1 = 有测试失败 / 部署不一致 / 文档缺失。
'use strict'

const fs = require('fs')
const path = require('path')
const { execSync, spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const WS = ROOT
const DP = 'E:/DeepSeek Harness/.dsh/profiles/web/node_modules/collab-canvas'

let problems = []

/** 读文本并把换行符统一成 \n —— 跨 git/工作区比较前必须先过这一道。 */
function readNorm(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
}
function hasCrlf(p) {
  try { return fs.readFileSync(p, 'utf8').indexOf('\r\n') >= 0 } catch (e) { return false }
}

/* ═══ 1. git 状态 ═══ */
console.log('══ 1. git 状态 ══')
try {
  const st = execSync('git status --short', { cwd: WS, encoding: 'utf8' }).trim()
  console.log(st ? st.split('\n').map(function (l) { return '  ' + l }).join('\n')
    : '  工作区干净（无未提交改动）')
} catch (e) {
  console.log('  读不到 git 状态：' + (e && e.message))
  problems.push('git 状态读不到')
}

/* ═══ 2. 回归测试（真跑）═══ */
console.log('')
console.log('══ 2. 回归测试（真跑 tools/test-all.cjs）══')
const runner = path.join(WS, 'tools', 'test-all.cjs')
if (!fs.existsSync(runner)) {
  console.log('  ★ 找不到 ' + runner)
  problems.push('回归测试总入口缺失')
} else {
  const r = spawnSync(process.execPath, [runner], {
    cwd: WS, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024
  })
  const out = (r.stdout || '') + (r.stderr || '')
  // 只把汇总段打出来，明细太长
  const lines = out.split('\n')
  const cut = lines.findIndex(function (l) { return /^[─═]/.test(l) || /份测试：/.test(l) })
  lines.slice(cut >= 0 ? cut : 0).forEach(function (l) { if (l.trim()) console.log('  ' + l) })
  if (r.status !== 0) problems.push('回归测试未全过')
}

/* ═══ 3. 工作区 ↔ 部署 一致性 ═══ */
console.log('')
console.log('══ 3. 工作区 ↔ 部署 一致性（忽略换行符差异）══')
// lib/selref.js 以前漏在这个名单外 —— 它是运行期按需拉取的侧模块，
// 漏拷的后果是"改了却没生效"，所以必须一起比。
const PAIRS = [
  'dist/host.js',
  'lib/client.js',
  'lib/selref.js',
  'lib/doclink.js',
  'lib/docdrop.js',
  'package.json',
  'cordis.patch.yml'
]
PAIRS.forEach(function (rel) {
  const a = path.join(WS, rel)
  const b = path.join(DP, rel)
  if (!fs.existsSync(a)) { console.log('  ★ ' + rel.padEnd(20) + '工作区没有'); problems.push(rel + ' 工作区缺失'); return }
  if (!fs.existsSync(b)) { console.log('  ★ ' + rel.padEnd(20) + '部署副本没有（没拷？）'); problems.push(rel + ' 部署副本缺失'); return }
  const same = readNorm(a) === readNorm(b)
  const crlfNote = (hasCrlf(a) !== hasCrlf(b)) ? '  [换行符不同，已忽略]' : ''
  if (!same) problems.push(rel + ' 内容不一致')
  console.log('  ' + rel.padEnd(20) + (same ? '一致 ✓' : '不一致 ★') +
    '  ' + Buffer.byteLength(readNorm(a)) + ' 字节' + crlfNote)
})

/* ═══ 4. 历史修复守卫（源码文本匹配）═══ */
// 说明：这些是历次修复留下的"别被改回去"的守卫，查的是源码里还认不认那些关键写法。
// 它们是**文本匹配**，不是行为测试 —— 真正的行为由第 2 节那 485 条断言负责。
console.log('')
console.log('══ 4. 历史修复守卫（源码文本匹配，非行为测试）══')
const clPath = path.join(WS, 'src/client/editor-panel.js')
const cl = fs.existsSync(clPath) ? readNorm(clPath) : ''
if (!cl) { console.log('  ★ 读不到 src/client/editor-panel.js'); problems.push('客户端源码缺失') }
const GUARDS = [
  ['P0 knownVer 回传', /knownVer:\s*versionRef\.current/],
  ['P0 versionRef 声明', /const versionRef = useRef\(0\)/],
  ['P0 lastSyncedMd 声明', /const lastSyncedMd = useRef\(null\)/],
  ['P0 resolveConflict 定义', /function resolveConflict\(/],
  ['P0 conflict 分支调用', /else if \(d && d\.conflict\)/],
  ['P1 缩进不叠加', /ln === "" \? "" : \(\/\^\[ \\t\]\/\.test\(ln\) \? ln : pad \+ ln\)/],
  ['P2 任务项剥空白', /if \(isTask\) inner = inner\.replace\(\/\^\[ \\t\]\+\/, ""\)/]
]
GUARDS.forEach(function (g) {
  const ok = cl ? g[1].test(cl) : false
  if (!ok) problems.push('历史守卫失效：' + g[0])
  console.log('  ' + g[0].padEnd(24) + (ok ? '✓' : '★ 缺失'))
})
// setVersion 之后必须同步 versionRef —— 逐个调用点检查
if (cl) {
  const lines = cl.split('\n')
  let syncOk = 0, syncBad = 0
  lines.forEach(function (l, i) {
    if (l.indexOf('setVersion(') < 0) return
    const near = lines.slice(i, i + 4).join('\n')
    if (/versionRef\.current\s*=/.test(near)) syncOk++
    else { syncBad++; console.log('    ★ L' + (i + 1) + ' setVersion 后未同步 versionRef: ' + l.trim().slice(0, 50)) }
  })
  if (syncBad) problems.push('setVersion 有 ' + syncBad + ' 处未同步 versionRef')
  console.log('  setVersion 调用点：' + syncOk + ' 已同步 / ' + syncBad + ' 未同步')
}
const hoPath = path.join(WS, 'src/host/09-http.js')
if (fs.existsSync(hoPath)) {
  const ok = /if \(result && result\.conflict\)/.test(readNorm(hoPath))
  if (!ok) problems.push('历史守卫失效：host 冲突回传')
  console.log('  ' + 'P0 host 冲突回传'.padEnd(24) + (ok ? '✓' : '★ 缺失'))
}

/* ═══ 5. 文档完好性 ═══ */
console.log('')
console.log('══ 5. 文档完好性（换行符已统一后再比）══')
const DOC = 'canvas-docs/话布优化.md'
const docPath = path.join(WS, DOC)
if (!fs.existsSync(docPath)) {
  console.log('  ⚠ ' + DOC + ' 不在（跳过；以前这里会直接崩）')
} else {
  const disk = readNorm(docPath)
  let head = null
  try {
    head = execSync('git show HEAD:' + DOC, { cwd: WS, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
      .replace(/\r\n/g, '\n')
  } catch (e) { console.log('  ⚠ git 里读不到该文档（新文件？）') }
  if (head !== null) {
    const same = disk === head
    if (!same) problems.push(DOC + ' 与 git 不一致')
    console.log('  与 git 一致: ' + (same ? '✓' : '★ 不一致（确实被改过，不是换行符问题）'))
  }
  console.log('  含测试串 THIS-SHOULD-NOT: ' + (disk.indexOf('THIS-SHOULD-NOT') >= 0 ? '★ 是（不该有）' : '否 ✓'))
  console.log('  章节数: ' + (disk.match(/^## /gm) || []).length)
}

/* ═══ 6. 文档保鲜（文档里让跑的命令是否真的存在）═══ */
console.log('')
console.log('══ 6. 文档保鲜（docs/ 里提到的命令是否存在）══')
const docChecker = path.join(WS, 'tools', 'check-docs.cjs')
if (!fs.existsSync(docChecker)) {
  console.log('  ⚠ 没有 tools/check-docs.cjs，跳过')
} else {
  const r = spawnSync(process.execPath, [docChecker], {
    cwd: WS, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024
  })
  const out = (r.stdout || '') + (r.stderr || '')
  out.split('\n').filter(function (l) { return l.indexOf('── ') === 0 || /^\s+[✓★－]/.test(l) || /处：/.test(l) })
    .forEach(function (l) { console.log('  ' + l) })
  if (r.status !== 0) problems.push('文档里有让跑但不存在的命令')
}

/* ═══ 汇总 ═══ */
console.log('')
console.log('════════════════════════════════')
if (problems.length) {
  console.log('总检不通过，' + problems.length + ' 个问题：')
  problems.forEach(function (p) { console.log('  ★ ' + p) })
  process.exit(1)
} else {
  console.log('总检通过 ✓')
  process.exit(0)
}
