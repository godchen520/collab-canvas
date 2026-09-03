// 注册会话视图 Tab（与聊天平级）+ 工具栏入口按钮
const slots = ctx.get('slots')
if (slots === undefined) {
  console.error('[collab-canvas]', 'slots service unavailable — UI disabled.')
  return
}
slots.inject('conversation.view', function () {
  return slots.register(
    { name: 'conversation.view', id: 'collab-canvas', order: 80, label: '话布' },
    function () { return React.createElement(CanvasPanel) },
  )
})

// 注册工具栏入口按钮（session 级别，跨切换不丢）
slots.inject('conversation.session.header.utilities', function () {
  return slots.register(
    { name: 'conversation.session.header.utilities', id: 'collab-canvas-entry', order: 90 },
    function () {
      return React.createElement('button', {
        onClick: function () {
          // 触发话布面板打开：切换到话布 tab
          var tabEl = document.querySelector('[data-tab="collab-canvas"]')
          if (tabEl) tabEl.click()
          else console.warn('[collab-canvas] tab not found')
        },
        style: { padding: '4px 12px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))', borderRadius: '6px', background: 'transparent', color: 'var(--dsw-alias-label-primary, #1a1a1a)', cursor: 'pointer', fontSize: '13px', fontFamily: 'inherit' },
        title: '打开话布编辑器'
      }, '话布')
    },
  )
})

console.log('[collab-canvas]', 'client half ready', VERSION)
