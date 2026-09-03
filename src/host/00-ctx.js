// 上下文服务引用（模块共享）——composition 插件用 injected 服务
const fs = ctx.fs
const policy = ctx.get('sandboxPolicy')  // 可选服务，未注入时可能 undefined
