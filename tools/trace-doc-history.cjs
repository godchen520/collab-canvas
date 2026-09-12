const { execSync } = require('child_process')
const ROOT = 'H:/WPSCloud/OneDrive - 星河游/文档/DSH project/DSH Collab Doc'
const F = 'canvas-docs/话布优化.md'

const raw = execSync('git log --format=' + '"%h %cI %s"' + ' -- ' + F, { cwd: ROOT, encoding: 'utf8' }).trim()
const commits = raw.split('\n').map(l => {
  const m = l.match(/^(\w+)\s+(\S+)\s+(.*)$/)
  return m ? { h: m[1], t: m[2], s: m[3] } : null
}).filter(Boolean).reverse()

console.log('=== 话布优化.md 的提交历史（旧 → 新）===')
let prevSize = null
commits.forEach(function (c) {
  let size = '?', ch = '?', hasTen = '', has11 = '', has12 = ''
  try {
    const body = execSync('git show ' + c.h + ':' + F, { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
    size = Buffer.byteLength(body)
    ch = (body.match(/^## /gm) || []).length
    hasTen = body.indexOf('十、已修 bug') >= 0 ? '十' : '  '
    has11 = body.indexOf('十一、') >= 0 ? '十一' : '    '
    has12 = body.indexOf('十二、') >= 0 ? '十二' : '    '
  } catch (e) { }
  const delta = prevSize === null || size === '?' ? '' : (size - prevSize >= 0 ? ' (+' + (size - prevSize) + ')' : ' (' + (size - prevSize) + ')')
  console.log('  ' + c.h + '  ' + c.t.slice(0, 16) + '  ' + String(size).padStart(6) + 'B' + delta.padEnd(9) + String(ch).padStart(2) + '章  含[' + hasTen + '|' + has11 + '|' + has12 + ']  ' + c.s.slice(0, 34))
  if (size !== '?') prevSize = size
})
