#!/usr/bin/env node
// DSH Collab-Canvas · 一键搬运（本仓库 → dsh 的部署副本）
//
// 为什么要有这个脚本（2026-09-16）：
//   在此之前"让改动生效"要靠人手做两件最容易做错的事：
//     ① 客户端源码 src/client/editor-panel.js 手工拷成 lib/client.js
//        —— 因为 tools/build.cjs 只构建 host，不构建客户端；
//     ② 再把 7 份文件挨个拷进部署目录，然后凭记忆判断有没有漏。
//   漏一份的表现是"界面毫无异常、就是没生效"，最难查。
//     ③ dist/host.js 忘了重新构建就搬运 —— 会把旧的服务端推上去。
//
// 本脚本做三件事：
//   1. 先同步客户端（src/client/editor-panel.js → lib/client.js，纯拷贝）；
//   2. 检查 dist/host.js 是否比 src/host/*.js 旧（旧 = 忘了构建，直接拒绝搬运）；
//   3. 把 7 份挨个搬到部署目录，搬完再读回来逐个校验，不给"搬了但没生效"留缝。
//
// 用法：
//   node tools/deploy.cjs           # 搬运 + 逐个校验（npm run deploy）
//   node tools/deploy.cjs --check   # 只看差哪几份，一个字节都不动
//
// 部署目录默认由 DSH_HOME 推导：$DSH_HOME/profiles/web/node_modules/collab-canvas，
// 可用环境变量 CCV_DEPLOY_DIR 覆盖（换机器 / 换 profile 时用）。
//
// 生效方式（脚本会再提醒一次，因为这两种别混）：
//   动了 src/host/*.js → 搬运后必须**完全重启 dsh web**（刷新页面不够）
//   动了客户端 / 侧模块 → 搬运后**刷新页面**即可
//
// 退出码：0 = 搬运完成且校验通过；1 = 有文件缺失 / 构建过期 / 搬运后仍不一致。
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.join(__dirname, '..')
// 部署目录：默认从 DSH_HOME 推导（$DSH_HOME/profiles/web/node_modules/collab-canvas），
// 可用环境变量 CCV_DEPLOY_DIR 显式覆盖。
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DP = process.env.CCV_DEPLOY_DIR ||
  path.join(DSH_HOME, 'profiles', 'web', 'node_modules', 'collab-canvas')

const CHECK_ONLY = process.argv.includes('--check')

// 客户端源文件 → 它在线上的那份（纯拷贝，无构建步骤）
const CLIENT_SRC = 'src/client/editor-panel.js'
const CLIENT_OUT = 'lib/client.js'

// 要和工作区保持一致的全部文件（与 verify-all.cjs 第 3 节同一份清单）
const FILES = [
  'dist/host.js',
  'lib/client.js',
  'lib/selref.js',
  'lib/doclink.js',
  'lib/docdrop.js',
  'package.json',
  'cordis.patch.yml',
]

const problems = []

/** 读文本并把换行符统一成 \n —— 比内容前必须先过这一道，
 *  否则 CRLF 与 LF 混着会永远报"不一致"（本仓库踩过这个假警报）。 */
function readNorm(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
}

function same(pa, pb) {
  if (!fs.existsSync(pa) || !fs.existsSync(pb)) return false
  return readNorm(pa) === readNorm(pb)
}

function copy(rel) {
  fs.copyFileSync(path.join(ROOT, rel), path.join(DP, rel))
}

console.log('══ 一键搬运：本仓库 → 部署副本 ══')
console.log('  源：' + ROOT)
console.log('  目标：' + DP + (CHECK_ONLY ? '   （--check 只看不动）' : ''))

if (!fs.existsSync(DP)) {
  console.log('\n★ 部署目录不存在，先确认 dsh 装在哪儿。')
  console.log('  若确实在别处，设环境变量 CCV_DEPLOY_DIR 指向它再跑。')
  process.exit(1)
}

/* ═══ 1. 先同步客户端（那步以前"必须手工"的） ═══ */
console.log('\n══ 1. 客户端同步（build.cjs 不管这一半）══')
const csPath = path.join(ROOT, CLIENT_SRC)
const coPath = path.join(ROOT, CLIENT_OUT)
if (!fs.existsSync(csPath)) {
  problems.push(CLIENT_SRC + ' 不存在')
  console.log('  ★ 找不到 ' + CLIENT_SRC)
} else if (same(csPath, coPath)) {
  console.log('  已一致，无需同步 ✓')
} else if (CHECK_ONLY) {
  problems.push(CLIENT_OUT + ' 待同步')
  console.log('  ★ ' + CLIENT_OUT + ' 与源文件不一致（需要同步）')
} else {
  try {
    fs.copyFileSync(csPath, coPath)
    const ok = same(csPath, coPath)
    console.log('  已从 ' + CLIENT_SRC + ' 同步 → ' + CLIENT_OUT +
      (ok ? '  ✓' : '  ★ 同步后仍不一致'))
    if (!ok) problems.push(CLIENT_OUT + ' 同步后仍不一致')
  } catch (e) {
    problems.push('同步 ' + CLIENT_OUT + ' 失败：' + e.message)
    console.log('  ★ 同步失败：' + e.message)
  }
}

/* ═══ 2. 构建是否过期（旧产物别往线上搬） ═══ */
console.log('\n══ 2. dist/host.js 是否比源码新 ══')
const hostOutPath = path.join(ROOT, 'dist/host.js')
const srcHostDir = path.join(ROOT, 'src/host')
let newestSrc = 0
let newestName = ''
if (fs.existsSync(srcHostDir)) {
  fs.readdirSync(srcHostDir).filter(function (f) { return f.endsWith('.js') })
    .forEach(function (f) {
      const m = fs.statSync(path.join(srcHostDir, f)).mtimeMs
      if (m > newestSrc) { newestSrc = m; newestName = f }
    })
}

if (!fs.existsSync(hostOutPath)) {
  problems.push('dist/host.js 不存在，先跑 node tools/build.cjs')
  console.log('  ★ dist/host.js 不存在 —— 先跑：node tools/build.cjs')
} else if (newestSrc && fs.statSync(hostOutPath).mtimeMs < newestSrc) {
  problems.push('dist/host.js 比 src/host/' + newestName + ' 旧，需要重新构建')
  console.log('  ★ 构建过期：' + newestName + ' 比 dist/host.js 新')
  console.log('    → 先跑：node tools/build.cjs，再重新搬运')
} else {
  console.log('  产物不比源码旧 ✓')
}

/* ═══ 3. 搬运 7 份 ═══ */
console.log('\n══ 3. 搬运（7 份）══')
console.log('  ' + '文件'.padEnd(22) + '结果')
let copied = 0
let skipped = 0

FILES.forEach(function (rel) {
  const a = path.join(ROOT, rel)
  const b = path.join(DP, rel)
  if (!fs.existsSync(a)) {
    problems.push(rel + ' 在仓库里不存在')
    console.log('  ' + rel.padEnd(22) + '★ 仓库里没有这份')
    return
  }
  if (same(a, b)) {
    skipped++
    console.log('  ' + rel.padEnd(22) + '已一致，跳过')
    return
  }
  if (CHECK_ONLY) {
    problems.push(rel + ' 待搬运')
    console.log('  ' + rel.padEnd(22) + '★ 不一致（需要搬运）')
    return
  }
  try {
    copy(rel)
    copied++
    console.log('  ' + rel.padEnd(22) + '已搬运 →')
  } catch (e) {
    problems.push('搬运 ' + rel + ' 失败：' + e.message)
    console.log('  ' + rel.padEnd(22) + '★ 失败：' + e.message)
  }
})

/* ═══ 4. 搬完读回来逐个校验（不给"搬了没生效"留缝） ═══ */
if (!CHECK_ONLY) {
  console.log('\n══ 4. 搬运后校验（重新读盘比对）══')
  FILES.forEach(function (rel) {
    const ok = same(path.join(ROOT, rel), path.join(DP, rel))
    console.log('  ' + rel.padEnd(22) + (ok ? '一致 ✓' : '★ 仍不一致'))
    if (!ok) problems.push(rel + ' 搬运后仍不一致')
  })
}

/* ═══ 汇总 ═══ */
console.log('\n' + '─'.repeat(34))
if (CHECK_ONLY) {
  if (problems.length === 0) {
    console.log('两边已经一致，没有需要搬的 ✓')
  } else {
    console.log('有 ' + problems.length + ' 处需要处理：')
    problems.forEach(function (p) { console.log('  · ' + p) })
    console.log('\n去掉 --check 再跑一次即可搬运（会先补上客户端同步）。')
  }
} else if (problems.length === 0) {
  console.log('搬运完成 ✓   本次搬了 ' + copied + ' 份，' + skipped + ' 份本来就一致')
} else {
  console.log('搬运有问题（' + problems.length + ' 处）：')
  problems.forEach(function (p) { console.log('  · ' + p) })
}

// 生效提示：只在真的搬了东西时说，避免变成每次都跳过的啰嗦
if (copied > 0 || problems.length === 0) {
  console.log('\n生效方式（别混）：')
  console.log('  · 若这次动了服务端（dist/host.js）→ 必须完全重启 dsh web，刷新页面不够')
  console.log('  · 若这次动了客户端或侧模块 → 刷新页面即可')
}
console.log('上线前再跑一次总检：node tools/verify-all.cjs')

process.exit(problems.length === 0 ? 0 : 1)
