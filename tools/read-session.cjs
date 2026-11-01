// 读 DSH 会话（zstd 多帧 jsonl），报告最近几条用户消息，并检查零宽字符。
//
// 用途：验证「插件插进输入框的零宽标记，能不能活着到达服务端」。
// 输入框那边由客户端日志证明"插了什么"，这边证明"到了没有"——
// 两头一对，就知道零宽字符能不能穿过 DSH 的输入框与消息管道。
//
// 用法：
//   node tools/read-session.cjs                 列出工作区
//   node tools/read-session.cjs <slug>          读该工作区最新的会话
const fs = require('fs')
const path = require('path')
const { decompressFrames } = require('./zstd-jsonl.cjs')

const ROOT = 'E:/DeepSeek Harness/.dsh/sessions'
const SLUG = process.argv[2]

const ZW = {
  0x200b: 'ZWSP(零宽空格)', 0x200c: 'ZWNJ', 0x200d: 'ZWJ',
  0xfeff: 'ZWNBSP/BOM', 0x2060: 'WJ(词连接符)', 0x00ad: 'SHY(软连字符)',
  0x2063: 'INVISIBLE-SEP',
}

function scan(s) {
  const hits = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (ZW[c]) hits.push({ at: i, name: ZW[c], hex: 'U+' + c.toString(16).toUpperCase().padStart(4, '0') })
  }
  return hits
}

function msgText(e) {
  let text = ''
  const c = e && e.data && e.data.content
  if (typeof c === 'string') text = c
  else if (Array.isArray(c)) c.forEach(b => { if (b && typeof b.text === 'string') text += b.text })
  return text
}

if (!SLUG) {
  console.log('工作区（传一个作为参数来读它的会话）：')
  fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).forEach(d => {
    const subs = fs.readdirSync(path.join(ROOT, d.name), { withFileTypes: true }).filter(x => x.isDirectory())
    let newest = 0, name = ''
    subs.forEach(s => {
      const dir = path.join(ROOT, d.name, s.name)
      fs.readdirSync(dir).forEach(f => {
        const st = fs.statSync(path.join(dir, f))
        if (st.mtimeMs > newest) { newest = st.mtimeMs; name = s.name + '/' + f }
      })
    })
    console.log('  ' + d.name)
    console.log('      ' + subs.length + ' 个会话，最新 ' + (newest ? new Date(newest).toLocaleString('zh-CN') : '—'))
    if (name) console.log('      ' + name)
  })
  process.exit(0)
}

const base = path.join(ROOT, SLUG)
if (!fs.existsSync(base)) { console.error('没有这个工作区：' + SLUG); process.exit(1) }
let target = null, best = 0
fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).forEach(d => {
  const dir = path.join(base, d.name)
  fs.readdirSync(dir).forEach(f => {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    if (st.mtimeMs > best) { best = st.mtimeMs; target = p }
  })
})
if (!target) { console.error('该工作区下没有会话文件'); process.exit(1) }

console.log('会话: ' + target.replace(ROOT + '/', ''))
console.log('改于: ' + new Date(best).toLocaleString('zh-CN') + '\n')

const { text, stats } = decompressFrames(fs.readFileSync(target))
const lines = text.split('\n').filter(Boolean)
console.log('解出 ' + stats.frames + ' 帧 / ' + lines.length + ' 行\n')

const users = []
lines.forEach((ln, i) => {
  let e
  try { e = JSON.parse(ln) } catch (_) { return }
  if (!e || e.type !== 'user/message') return
  const t = msgText(e)
  if (!t) return
  users.push({ line: i + 1, len: t.length, zw: scan(t), head: t.slice(0, 40).replace(/\n/g, '⏎') })
})

console.log('用户消息 ' + users.length + ' 条。最后 4 条：')
users.slice(-4).forEach((u, k) => {
  const no = users.length - Math.min(4, users.length) + k + 1
  console.log('  #' + no + '  长度 ' + String(u.len).padStart(5) + '  零宽=' + (u.zw.length ? '★' + u.zw.length + ' 个' : '无'))
  console.log('       ' + u.head)
  if (u.zw.length) u.zw.slice(0, 6).forEach(z => console.log('        位置 ' + z.at + '  ' + z.name + '  ' + z.hex))
})
const withZw = users.filter(u => u.zw.length)
console.log('\n含零宽字符的用户消息共 ' + withZw.length + ' 条')
