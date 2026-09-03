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
