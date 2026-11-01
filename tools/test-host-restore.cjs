// 「恢复画布」的零依赖回归测试（host 侧）。
//
// 为什么必须有这一份：2026-10-14 主人**两次丢数据** ✗ ——
//   ① 登记丢了（meta 没落盘）② 内容丢了（文件没落盘）
//   同一个根因：会话重启会让 restore() **在同一个进程里重跑**，
//   而它原本无条件「从文件读内容 + 覆盖内存」✗ —— 内存里比文件新的那份就被吃掉了 ✗✗
//   这种错**跑起来不报错、事后才发现**，所以必须有能跑出数值的测试 ✓
//
// 做法与另几份 host 测试一致：**从构建产物里切真代码跑**（不是照抄一份）。
// 切取范围由 src/host/04-persistence.js 的 [[CCV-RESTORE]] 圈定。
//
// ⚠️ 依赖 dist/host.js —— 改完 src/host/*.js 要先 node tools/build.cjs
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let pass = 0, fail = 0
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want)
  if (a === b) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + '  期望 ' + b + '，实得 ' + a) }
}
function ok(name, cond) { eq(name, !!cond, true) }

const HOST = fs.readFileSync(path.join(__dirname, '..', 'dist', 'host.js'), 'utf8')
// ⚠️ 从**标记本身**开始切（不是标记之后）—— 标记写在一行注释里，
//    从标记开始切的话开头就是一条合法注释 ✓；从标记之后切会把注释尾巴
//    （「—— 到 END 之间是…」）当成代码 ✗（第一版就是这么错的 ✓）
const ia = HOST.indexOf('// [[CCV-RESTORE-BEGIN]]')
const ib = HOST.indexOf('// [[CCV-RESTORE-END]]')
if (ia < 0 || ib < 0 || ib <= ia) {
  console.error('✗ dist/host.js 里找不到 [[CCV-RESTORE]] 标记 —— 先 node tools/build.cjs')
  process.exit(1)
}
const block = HOST.slice(ia, ib)

// ─── 沙箱 ────────────────────────────────────────────────────
const files = {}          // 假文件系统：路径 → 内容
const logs = []
const sandbox = {
  console: { log: function () {}, error: function () { logs.push([].slice.call(arguments).join(' ')) } },
  JSON, Math, String, Number, RegExp, Error, Date, Array, Object, Set, Promise,
  path: { resolve: function (p) { return String(p) } },
  canvases: new Map(),
  activeId: null,
  rootOverride: '',
  metaTargets: function () { return ['/meta/.canvases.json'] },
  docsDirBase: function () { return '/docs' },
  flushDirty: function () { sandbox.__flushCalls++ },
  persistMeta: function () { sandbox.__metaWrites++ },
  __flushCalls: 0,
  __metaWrites: 0,
  fs: {
    resolve: async function (p) { return String(p) },
    readText: async function (p) {
      if (files[p] === undefined) throw new Error('ENOENT ' + p)
      return files[p]
    },
  },
}
sandbox.__flushCalls = 0
sandbox.__metaWrites = 0
vm.createContext(sandbox)
vm.runInContext(block, sandbox, { filename: 'dist/host.js#restore' })

const restore = sandbox.restore
if (typeof restore !== 'function') { console.error('✗ 切出来的那段没有 restore'); process.exit(1) }

function reset() {
  sandbox.canvases.clear()
  sandbox.activeId = null
  sandbox.rootOverride = ''
  sandbox.__flushCalls = 0
  sandbox.__metaWrites = 0
  for (const k in files) delete files[k]
  logs.length = 0
}

console.log('\n[1] 冷启动：内存是空的 → 从文件读进来')
{
  reset()
  files['/meta/.canvases.json'] = JSON.stringify({
    activeId: 'cv-1', rootOverride: '/docs',
    canvases: [{ id: 'cv-1', title: '任务书', type: 'document', filePath: '/docs/a.md', version: 5 }],
  })
  files['/docs/a.md'] = '文件里的内容'
  return restore().then(function () {
    const c = sandbox.canvases.get('cv-1')
    eq('[1a] 读到了', !!c, true)
    eq('[1b] 内容是文件里的', c.content, '文件里的内容')
    eq('[1c] 版本号跟着 meta（不是重置成 1）', c.version, 5)
    eq('[1d] 干净（dirty=false）', c.dirty, false)
    eq('[1e] 先落过一次盘（冷启动时是空操作，但顺序必须对）', sandbox.__flushCalls >= 1, true)

    // ── [2] 🔴 核心：重跑 restore（会话重启）时，**不许用旧文件覆盖新内存** ──
    console.log('\n[2] 🔴 会话重启：内存里有未落盘的改动 → 绝不覆盖')
    reset()
    files['/meta/.canvases.json'] = JSON.stringify({
      activeId: 'cv-1', rootOverride: '/docs',
      canvases: [{ id: 'cv-1', title: '任务书', type: 'document', filePath: '/docs/a.md', version: 5 }],
    })
    files['/docs/a.md'] = '9752 字节的原始版（附录还没落盘）'
    // 内存里这份 = 追加了附录 A/B/C 的新版，且 dirty
    sandbox.canvases.set('cv-1', {
      id: 'cv-1', title: '任务书', type: 'document',
      content: '9752 字节的原始版（附录还没落盘）\n\n附录 A\n附录 B\n附录 C',
      version: 6, filePath: '/docs/a.md', history: [], redoStack: [],
      dirty: true, updatedAt: 0,
    })
    return restore().then(function () {
      const c = sandbox.canvases.get('cv-1')
      ok('[2a] ★ 内存里的新内容**没有被旧文件覆盖**', c.content.indexOf('附录 A') >= 0)
      ok('[2b] ★ 附录 B/C 也都还在', c.content.indexOf('附录 B') >= 0 && c.content.indexOf('附录 C') >= 0)
      eq('[2c] dirty 保持 true（还没落盘这件事不能被抹掉）', c.dirty, true)
      eq('[2d] version 没被 meta 的旧版本号降级', c.version, 6)
      ok('[2e] 记了一条日志（不静默）', logs.join('\n').indexOf('保留内存里未落盘的改动') >= 0)

      // ── [3] 干净的内存 → 照常从文件读（别把正常路径也挡了）──
      console.log('\n[3] 内存里那份是干净的 → 照常从文件读（不能一刀切挡住）')
      reset()
      files['/meta/.canvases.json'] = JSON.stringify({
        activeId: 'cv-1', rootOverride: '/docs',
        canvases: [{ id: 'cv-1', title: '任务书', type: 'document', filePath: '/docs/a.md', version: 5 }],
      })
      files['/docs/a.md'] = '文件是最新的'
      sandbox.canvases.set('cv-1', {
        id: 'cv-1', title: '任务书', type: 'document', content: '内存里的旧内容',
        version: 5, filePath: '/docs/a.md', history: [], redoStack: [], dirty: false, updatedAt: 0,
      })
      return restore()
    }).then(function () {
      eq('[3a] 干净的内存被文件内容更新（正常路径没被挡）', sandbox.canvases.get('cv-1').content, '文件是最新的')

      // ── [4] 文件读不到 → 跳过这一条（不炸、不建空画布）──
      console.log('\n[4] 文件读不到 → 跳过这条记录（不建空画布）')
      reset()
      files['/meta/.canvases.json'] = JSON.stringify({
        activeId: 'cv-x', rootOverride: '/docs',
        canvases: [{ id: 'cv-x', title: '没了', type: 'document', filePath: '/docs/gone.md', version: 2 }],
      })
      return restore()
    }).then(function () {
      eq('[4a] 没建出空画布', sandbox.canvases.size, 0)

      console.log('\n' + (fail ? '✗' : '✓') + ' ' + (fail ? '有失败' : '全部通过') + '：' + pass + ' 通过 / ' + fail + ' 失败')
      process.exit(fail ? 1 : 0)
    })
  })
}
