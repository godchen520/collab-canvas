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
        '【仅在这一种情况下加打开入口】本轮确实创建或修改了话布文档时，才在回复末尾单独写一行「📄 打开话布：<标题>」；只读、只查询、只跑命令、只改代码而没有动过任何话布文档的回合，**不要**加这一行（它指向的是本轮动过的文档，没动就不该出现）。标题直接写、不要加反引号，客户端会把它转成可点入口；标题不足 4 字符时用「」包裹（如「123」）。',
      ].join('\n'),
    })
    console.log('[collab-canvas]', 'prompt section registered')
  }
} catch (e) {
  console.error('[collab-canvas] prompt section failed:', e && e.message)
}
