// 事件总线骨架（V2 跨面板联动的接缝；on() 返回 disposer）
var listeners = new Map()
function on(ev, fn) {
  if (!listeners.has(ev)) listeners.set(ev, new Set())
  listeners.get(ev).add(fn)
  return function () { listeners.get(ev).delete(fn) }
}
function emit(ev, payload) {
  var set = listeners.get(ev)
  if (!set) return
  set.forEach(function (fn) { try { fn(payload) } catch (e) { console.error('[collab-canvas] listener failed', e) } })
}
var EV = {
  CONTENT_CHANGED: 'collab-canvas/content-changed',
  CANVAS_CREATED: 'collab-canvas/canvas-created',
  CANVAS_CLOSED: 'collab-canvas/canvas-closed',
  FILE_SAVED: 'collab-canvas/file-saved',
  FILE_LOADED: 'collab-canvas/file-loaded',
  AI_EDIT_APPLIED: 'collab-canvas/ai-edit-applied',
}
