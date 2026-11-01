// DSH 会话文件的正确读法：它是**多个 zstd 帧拼接**的 jsonl
// （zstdDecompressSync 只解第一帧 —— 只拿到 session 头那一行）
//
// 帧边界靠 magic 0x28B52FFD 找。压缩数据里偶尔也会出现同样的字节序列，
// 所以不是"见到 magic 就切"，而是**逐帧试解**：切出来的片段解不开就把边界往后挪，
// 直到解开为止 —— 这样假 magic 不会把帧切坏。
const fs = require('fs')
const zlib = require('zlib')

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decompressFrames(buf) {
  const parts = []
  const stats = { frames: 0, falseMagic: 0, failed: 0 }
  let pos = 0
  while (pos < buf.length) {
    const start = buf.indexOf(MAGIC, pos)
    if (start < 0) break
    let next = buf.indexOf(MAGIC, start + 4)
    let ok = false
    for (;;) {
      const end = (next < 0) ? buf.length : next
      let out = null
      try { out = zlib.zstdDecompressSync(buf.slice(start, end)) } catch (_) { out = null }
      if (out !== null) {
        parts.push(out)
        stats.frames++
        pos = end
        ok = true
        break
      }
      if (next < 0) break
      stats.falseMagic++
      next = buf.indexOf(MAGIC, next + 4)
    }
    if (!ok) { stats.failed++; pos = start + 4 }
  }
  return { text: Buffer.concat(parts).toString('utf8'), stats }
}

module.exports = { decompressFrames }

if (require.main === module) {
  const p = process.argv[2]
  if (!p) { console.error('用法: node tools/zstd-jsonl.cjs <session.v4.jsonl.zstd>'); process.exit(1) }
  const t0 = Date.now()
  const buf = fs.readFileSync(p)
  const { text, stats } = decompressFrames(buf)
  const lines = text.split('\n').filter(Boolean)
  console.log('压缩 ' + Math.round(buf.length / 1024) + 'KB → 解出 ' + stats.frames + ' 帧 / ' + lines.length + ' 行 / '
    + Math.round(text.length / 1024) + 'KB   (' + (Date.now() - t0) + 'ms)')
  console.log('假 magic ' + stats.falseMagic + ' 次，无法解开的帧 ' + stats.failed + ' 个')
}
