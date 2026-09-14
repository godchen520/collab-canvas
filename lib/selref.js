// ═══ DSH Collab-Canvas · 选区引用（独立功能模块，单独一个文件维护）═══
//
// 目标：把话布里选中的一段话，变成 DSH 输入框里一个「引用胶囊」——
//       可点、整块删除、按发送时自动翻译成带定位信息的上下文。
//       设计稿：canvas-docs/话布选区引用方案.md（v3）
//
// 加载方式：与 docdrop / doclink 完全相同 —— host 端点 /api/canvas/selref.js
//           提供源码，client 入口动态执行。**改本文件只需刷新页面，不用重启。**
//
// ── 与主模块的通信（重要）────────────────────────────────────────────
// 侧模块由 new Function(src)() 执行，作用域是**全局**，拿不到主模块的局部变量
// （React / h / ccvLog 等全都不可见）。所以两边只靠 window 上的约定握手：
//
//   window.__ccvKit   主模块提供的共用工具（log / toast），取不到就用自带副本
//   window.__ccvCtx   主模块 apply(ctx) 时挂上的 cordis 根上下文
//
// 侧模块与 apply 的先后顺序**不固定**（两边都是异步启动），故双向握手：
//   · 主模块先 apply   → 侧模块加载时看到 __ccvCtx，立刻自举
//   · 侧模块先加载     → 挂出 __ccvSelRefBoot，等主模块 apply 时来调
//
// ── 分步实施（设计稿第十一节）──────────────────────────────────────
//   第 1 步【本版】空壳 + 加载自检 + 握手骨架 + 依赖服务探活
//   第 2 步  注册「话布选区」引用源（先给假候选）
//   第 3 步  翻译规则（先返回固定文字）
//   第 4 步  自动走官方两步（打开菜单 → 选中）
//   第 5 步  接真实选区数据
//   第 6 步  过期校验（版本号 + 上下文指纹）
//
// 健壮性约定：与 docdrop / doclink 相同 —— 防重复安装、失败静默降级、
//             任何异常都不许影响画布本体。
;(function () {
  try {
    if (window.__ccvSelRefInstalled) return
    window.__ccvSelRefInstalled = true

    var VERSION = 1

    // 日志：优先借用主模块的共用实现，取不到就自带一份同样的 POST。
    function log(msg) {
      var kit = window.__ccvKit
      if (kit && kit.log) { kit.log(msg, "selref"); return }
      try {
        fetch("/api/canvas/log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ line: "[selref] " + msg })
        }).catch(function () {})
      } catch (_) {}
    }

    // 三个依赖服务：sessions（拿会话作用域）、conversation（输入框句柄）、
    // inputTriggers（注册引用源 —— 新方案的地基）。
    // 前两个主模块本来就 inject 了；后一个还没声明，本步就是来探它的。
    function missingServices(ctx) {
      if (!ctx) return ["<空上下文>"]
      var probe = {
        sessions: function () { return ctx.sessions || (ctx.get && ctx.get("sessions")) },
        conversation: function () { return ctx.conversation || (ctx.get && ctx.get("conversation")) },
        inputTriggers: function () { return ctx.inputTriggers || (ctx.get && ctx.get("inputTriggers")) }
      }
      var out = []
      for (var k in probe) {
        var v = null
        try { v = probe[k]() } catch (_) { v = null }
        if (!v) out.push(k)
      }
      return out
    }

    var booted = false

    /**
     * 主模块 apply(ctx) 时调用；本模块也可能自己先走到这里。
     * @param {object} ctx - cordis 根上下文
     */
    function boot(ctx) {
      if (booted) { log("boot 被重复调用，已忽略"); return }
      booted = true

      try {
        if (!ctx) { log("boot 收到空上下文，放弃自举"); return }

        window.__ccvSelRefCtx = ctx
        window.__ccvSelRefReady = true

        var missing = missingServices(ctx)
        if (!missing.length) {
          log("v" + VERSION + " 已就绪：sessions / conversation / inputTriggers 三个服务都在"
            + "（引用源尚未注册，待第 2 步）")
          return
        }

        // apply 那一刻可能还有插件没装载完 —— 2 秒后复检，区分「时机未到」和「真的没有」。
        log("v" + VERSION + " 已就绪，apply 时暂缺: " + missing.join(" / ") + "（2 秒后复检）")
        setTimeout(function () {
          var again = missingServices(ctx)
          if (!again.length) {
            log("复检通过：三个服务已全部就绪（刚才只是加载时机，不是缺失）→ 第 2 步可直接用")
          } else {
            log("复检仍缺: " + again.join(" / ")
              + " → 需要把缺的写进主模块 inject 声明，否则第 2 步会卡住")
          }
        }, 2000)

        // 第 2 步在这里接入：
        //   ctx.inputTriggers.registerSource({ trigger:"@", name:"collab-canvas", ... })
      } catch (e) {
        log("boot 失败: " + (e && e.message))
      }
    }

    if (window.__ccvCtx) {
      // 主模块已经 apply 过了
      boot(window.__ccvCtx)
    } else {
      // 主模块还没 apply —— 挂出去等它来调
      window.__ccvSelRefBoot = boot
      log("v" + VERSION + " 已加载，等待主模块上下文")
      // 兜底自检：主模块始终没来就留个痕迹，便于区分「没加载」和「加载了但没握手」
      setTimeout(function () {
        if (!booted) log("v" + VERSION + " 仍在等待：3 秒内未收到主模块上下文（__ccvCtx 未挂）")
      }, 3000)
    }
  } catch (e) {
    // 最外层兜底：连 log 都可能不可用，直接裸 POST
    try {
      fetch("/api/canvas/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line: "[selref] 模块执行异常: " + (e && e.message) })
      }).catch(function () {})
    } catch (_) {}
  }
})()
