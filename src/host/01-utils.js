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
