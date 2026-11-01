// 把插件搬运到**所有装了它的 profile**，而不是写死一个。
//
// ═══ 为什么要有这个（2026-10-11 踩的坑）═══════════════════════════
// tools/deploy.cjs 的默认目标是 `$DSH_HOME/profiles/web/node_modules/collab-canvas`，
// 写死一个。而这台机器上 `profiles/desktop` **也装了一份**（停在 10-02 的 v5）。
// 哪个 profile 在跑取决于启动方式 —— 于是出现最恶心的那种鬼打墙：
//   改了 ✓ 构建了 ✓ 部署了 ✓ 自检全绿 ✓ —— **界面里就是没变** ✗
// 当时客户端版本还停在 v5，查了半天才发现加载的是另一份。
//
// 所以：**能装几份就同步几份**。多同步一份的代价是零，漏同步一份的代价是几小时。
//
// 用法：node tools/deploy-all.cjs [--check]
//   （--check 只看不动，交给 deploy.cjs 自己的 --check 语义）
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROFILES = path.join(DSH_HOME, 'profiles')
const CHECK = process.argv.includes('--check')

// 显式指定就只用它（保留原来的逃生口）
const forced = process.env.CCV_DEPLOY_DIR

function findTargets() {
  if (forced) return [forced]
  const out = []
  try {
    for (const name of fs.readdirSync(PROFILES)) {
      const dir = path.join(PROFILES, name, 'node_modules', 'collab-canvas')
      try { if (fs.statSync(dir).isDirectory()) out.push(dir) } catch (_) {}
    }
  } catch (_) {}
  if (!out.length) out.push(path.join(PROFILES, 'web', 'node_modules', 'collab-canvas'))
  return out
}

const targets = findTargets()
console.log('══ 多 profile 搬运 ══')
console.log('  发现 ' + targets.length + ' 份安装：')
targets.forEach(t => {
  let v = '?'
  try {
    const s = fs.readFileSync(path.join(t, 'lib', 'client.js'), 'utf8')
    const m = s.match(/CCV_CLIENT_VERSION\s*=\s*(\d+)/)
    v = m ? m[1] : '?'
  } catch (_) {}
  console.log('    - ' + t.replace(DSH_HOME, '$DSH_HOME') + '   （当前客户端 v' + v + '）')
})
console.log('')

let failed = 0
targets.forEach((t, i) => {
  console.log('── [' + (i + 1) + '/' + targets.length + '] ' + t.replace(DSH_HOME, '$DSH_HOME') + ' ──')
  try {
    const args = [path.join(ROOT, 'tools', 'deploy.cjs')]
    if (CHECK) args.push('--check')
    execFileSync(process.execPath, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: Object.assign({}, process.env, { CCV_DEPLOY_DIR: t }),
    })
  } catch (e) {
    failed++
    console.log('  ★ 这一份搬运失败：' + (e && e.message))
  }
  console.log('')
})

console.log('══ 汇总 ══')
console.log('  ' + (targets.length - failed) + ' 份成功 / ' + failed + ' 份失败')
process.exit(failed ? 1 : 0)
