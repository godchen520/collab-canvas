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
//   第 1 步【已完成 20:19】空壳 + 加载自检 + 握手 + 依赖探活
//                         实测：sessions / conversation / inputTriggers 三服务齐备
//   第 2 步【本版】注册「话布选区」引用源 + 假候选 + 假翻译
//                  验证：打 @ 能看到这一栏 → 选中变胶囊 → 发送被翻译
//   第 3 步  接真实选区数据（划词）
//   第 4 步  自动走官方两步（打开菜单 → 选中）
//   第 5 步  过期校验（版本号 + 上下文指纹）
//
// 健壮性约定：与 docdrop / doclink 相同 —— 防重复安装、失败静默降级、
//             任何异常都不许影响画布本体。
;(function () {
  try {
    if (window.__ccvSelRefInstalled) return
    window.__ccvSelRefInstalled = true

    var VERSION = 2

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
    // ⚠️ 它们必须在主模块的 inject 里声明，运行时 ctx.get 是取不到的。
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

    // ─── 引用源定义（第 2 步）───────────────────────────────────────
    // 官方机制：想让输入框里出现胶囊，必须先在 inputTriggers 里挂一个 source。
    // 官方自带 @文件 / @会话 两个 —— 这里是第三个。
    //
    // ⚠️ name 有两个身份：① 菜单分组标题 ② 发送时翻译路由的 key
    //    （草稿里每个胶囊记着自己的 source，提交时按它找回本源的 codec）。
    //    它必须与官方及任何其他插件不重名，否则 registerSource 直接抛错。
    var SOURCE_NAME = "话布选区"

    // 第 2 步的假候选：只为把「菜单 → 胶囊 → 翻译」这条链走通。
    // 第 3 步换成真实选区后，这里改为「当前待引用的选区列表」。
    var probeCandidates = [{
      name: "测试选区",
      description: "选中后会变成输入框里的胶囊",
      icon: "file",
      value: "probe-1"
    }]

    function makeSource() {
      return {
        trigger: "@",
        name: SOURCE_NAME,
        order: 50,              // 排在官方 @文件 / @会话 之后（它们默认 0）
        showGroupTitle: true,   // 菜单里显示分组标题，即上面的 name
        candidates: function () {
          return Promise.resolve(probeCandidates)
        },
        // 选中一项 → 交给管线插入胶囊。这里返回的每一栏都是胶囊的「出厂设置」。
        onPick: function (pick) {
          var ref = String((pick && pick.candidate && pick.candidate.value) || "probe")
          log("onPick 命中，ref=" + ref)
          return { insert: {
            source: SOURCE_NAME,
            ref: ref,
            label: "话布选区 · 待接入",   // 胶囊上显示的字
            appearance: "file",           // 图标：官方只给 file / folder / session
            clipboardText: "@" + SOURCE_NAME + " " + ref
          } }
        },
        // codec = 翻译规则。发送时官方按 source 找到它，把胶囊换成真正发给模型的文字。
        // ⚠️ 必须永不抛错：官方默认「翻译失败就拦住发送」，而发不出去比不精确更糟。
        codec: {
          clipboardText: function (ref) { return "@" + SOURCE_NAME + " " + ref },
          serialize: function (ref) {
            log("serialize 被调用，ref=" + ref)
            return Promise.resolve("【话布选区·自检】翻译通路正常，ref=" + ref)
          }
        }
      }
    }

    var booted = false

    /**
     * 主模块 apply(ctx) 时调用；本模块也可能自己先走到这里。
     * @param {object} ctx - cordis 根上下文
     */
    function boot(ctx) {
      if (booted) {
        if (window.__ccvSelRefCtx !== ctx) {
          log("上下文已更换（插件疑似重挂），本模块不重复注册 —— 刷新页面即可")
        }
        return
      }
      booted = true

      try {
        if (!ctx) { log("boot 收到空上下文，放弃自举"); return }

        window.__ccvSelRefCtx = ctx
        window.__ccvSelRefReady = true

        var missing = missingServices(ctx)
        if (missing.length) {
          log("v" + VERSION + " 启动时暂缺: " + missing.join(" / ") + "（2 秒后复检）")
          setTimeout(function () {
            var again = missingServices(ctx)
            if (!again.length) log("复检通过：三个服务已全部就绪 → 注册被跳过，刷新页面即可生效")
            else log("复检仍缺: " + again.join(" / ") + " → 检查主模块 inject 声明")
          }, 2000)
          return
        }

        log("v" + VERSION + " 已就绪：sessions / conversation / inputTriggers 三个服务都在")

        // ─── 注册引用源 ───────────────────────────────────────────
        var register = function () { return ctx.inputTriggers.registerSource(makeSource()) }
        try {
          if (typeof ctx.effect === "function") ctx.effect(register, "collab-canvas: @ " + SOURCE_NAME)
          else register()
          log("已注册「" + SOURCE_NAME + "」引用源（假候选）"
            + " → 到输入框打 @ 应能看到这一栏，选中会变成胶囊")
        } catch (e) {
          log("注册引用源失败: " + (e && e.message)
            + "（若提示 already registered，说明名字与别的源撞了）")
        }
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
