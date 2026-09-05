// 启动引导：恢复持久化状态 + 注册 HTTP 端点
;(async function () {
  await restore()
  console.log('[collab-canvas]', 'host half ready, docsDir =', docsDir())

  // 注册画布 HTTP 端点
  try {
    const webServer = ctx.get('webServer')
    if (webServer) {
      initCanvasHttpEndpoints(ctx, webServer)
      initCanvasExtraEndpoints(ctx, webServer)   // 11-canvas-extras.js：拖拽/登记表/删除/模块服务
    } else {
      console.warn('[collab-canvas]', 'webServer 服务未找到，跳过')
    }
  } catch (e) {
    console.error('[collab-canvas]', '初始化失败:', e && e.message)
  }
})()
