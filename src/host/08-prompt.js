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
        // ⚠️ 这里刻意不再规定「在回复末尾手写一行打开入口」。
        // 实测两次：只要写成「满足条件 Y 时输出 X」的约定，模型就会把它当仪式执行
        // —— 记住「每轮末尾加一行」，条件被跳过。改措辞救不了（收紧后仍复发）。
        // 现在入口完全由工具驱动：调了 present 才有卡片，不调就没有，
        // 没有可被误触发的余地。正文里提到标题时，客户端本来就会自动转成链接。
        '【可点入口】本轮确实创建或修改了话布文档时，调用 present 声明 "canvas-docs/<标题>.md"（标题用 slugify 规则：空格换 -、去掉路径非法字符；中文标题恒等）。它会在回复末尾生成一张可点卡片，点开即话布面板。',
        '不要在正文里手写「打开话布」「点击查看」之类的入口行——入口只由 present 卡片承担，正文不提。',
      ].join('\n'),
    })
    console.log('[collab-canvas]', 'prompt section registered')
  }
} catch (e) {
  console.error('[collab-canvas] prompt section failed:', e && e.message)
}
