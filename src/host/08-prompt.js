// 模型使用指南 prompt section
try {
  const sp = ctx.get('systemPrompt')
  if (sp && typeof sp.section === 'function') {
    sp.section({
      id: 'collab-canvas-usage',
      title: '话布工具使用指南',
      order: 200,
      text: [
        '用户提到"话布/画布/共创话布/canvas"时，使用 canvas_* 工具组操作话布，不要把长内容直接贴在聊天里。',
        'canvas_write 的 replace 模式覆盖全文，写入前必须先 canvas_read；追加用 append 模式（无需 baseVersion）。',
        'AI 写入直接生效，用户可在话布面板撤销；大改动建议分段 append。',
        '用户未明说"保存"时不主动 canvas_save（自动保存已在后台进行）。',
        '引用话布内容进对话时只摘必要片段。',
      ].join('\n'),
    })
    console.log('[collab-canvas]', 'prompt section registered')
  }
} catch (e) {
  console.error('[collab-canvas] prompt section failed:', e && e.message)
}
