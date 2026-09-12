const fs = require('fs')
const { execSync } = require('child_process')
const WS = 'H:/WPSCloud/OneDrive - 星河游/文档/DSH project/DSH Collab Doc'
const DP = 'E:/DeepSeek Harness/.dsh/profiles/web/node_modules/collab-canvas'

console.log('=== 1. git 状态 ===')
const st = execSync('git status --short', { cwd: WS, encoding: 'utf8' }).trim()
console.log(st ? st : '  工作区干净（无未提交改动）')

console.log('')
console.log('=== 2. 工作区 ↔ 部署 一致性 ===')
;[['dist/host.js', 'dist/host.js'], ['lib/client.js', 'lib/client.js'],
  ['lib/doclink.js', 'lib/doclink.js'], ['lib/docdrop.js', 'lib/docdrop.js'],
  ['package.json', 'package.json'], ['cordis.patch.yml', 'cordis.patch.yml']
].forEach(function (p) {
  const a = fs.readFileSync(WS + '/' + p[0], 'utf8')
  const b = fs.readFileSync(DP + '/' + p[1], 'utf8')
  console.log('  ' + p[0].padEnd(20) + (a === b ? '一致 ✓' : '不一致 ★') + '  ' + Buffer.byteLength(a) + ' 字节')
})

console.log('')
console.log('=== 3. P0 客户端并发保护 各项是否到位 ===')
const cl = fs.readFileSync(WS + '/src/client/editor-panel.js', 'utf8')
const lines = cl.split('\n')
const checks = [
  ['knownVer 回传', /knownVer:\s*versionRef\.current/],
  ['versionRef 声明', /const versionRef = useRef\(0\)/],
  ['lastSyncedMd 声明', /const lastSyncedMd = useRef\(null\)/],
  ['resolveConflict 定义', /function resolveConflict\(/],
  ['conflict 分支调用', /else if \(d && d\.conflict\)/],
]
checks.forEach(function (c) {
  console.log('  ' + c[0].padEnd(22) + (c[1].test(cl) ? '✓' : '✗ 缺失'))
})
console.log('  setVersion 调用点逐个检查（其后 3 行内是否同步 versionRef）：')
let syncOk = 0, syncBad = 0
lines.forEach(function (l, i) {
  if (l.indexOf('setVersion(') < 0) return
  const near = lines.slice(i, i + 4).join('\n')
  const ok = /versionRef\.current\s*=/.test(near)
  if (ok) syncOk++; else syncBad++
  console.log('    L' + (i + 1) + ': ' + (ok ? '✓ 已同步' : '★ 未同步') +
    '   ' + l.trim().slice(0, 58))
})
console.log('  合计: ' + syncOk + ' 已同步 / ' + syncBad + ' 未同步')

console.log('')
console.log('=== 4. P0 host 冲突回传 ===')
const ho = fs.readFileSync(WS + '/src/host/09-http.js', 'utf8')
console.log('  result.conflict 分支: ' + (/if \(result && result\.conflict\)/.test(ho) ? '✓' : '✗'))

console.log('')
console.log('=== 5. P1/P2 列表修复 ===')
console.log('  P1 缩进不叠加: ' + (/ln === "" \? "" : \(\/\^\[ \\t\]\/\.test\(ln\) \? ln : pad \+ ln\)/.test(cl) ? '✓' : '✗'))
console.log('  P2 任务项剥空白: ' + (/if \(isTask\) inner = inner\.replace\(\/\^\[ \\t\]\+\/, ""\)/.test(cl) ? '✓' : '✗'))

console.log('')
console.log('=== 6. 文档完好性 ===')
const doc = fs.readFileSync(WS + '/canvas-docs/话布优化.md', 'utf8')
const gitDoc = execSync('git show HEAD:canvas-docs/话布优化.md', { cwd: WS, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
console.log('  文件与 git 一致: ' + (doc === gitDoc ? '✓' : '★ 不一致'))
console.log('  含我的测试串 THIS-SHOULD-NOT: ' + (doc.indexOf('THIS-SHOULD-NOT') >= 0 ? '★ 是' : '否 ✓'))
console.log('  章节数: ' + (doc.match(/^## /gm) || []).length)
