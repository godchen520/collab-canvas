#!/usr/bin/env node
// DSH Collab-Canvas · 回归测试总入口
//
// 为什么要有这个文件：
//   以前 5 个测试得手打 5 条命令，实践中必然漏跑；而 tools/verify-all.cjs 看着像
//   总入口，其实**一个测试都不跑**（只做十几条写死的文本匹配），于是"一键全绿"
//   给了假的安心。这个文件是**真的总入口**：自动发现 tools/test-*.cjs 全部跑一遍。
//
// 用法：
//   node tools/test-all.cjs              # 跑全部，只报每份的摘要
//   node tools/test-all.cjs --verbose    # 失败时连完整输出一起打
//   node tools/test-all.cjs 子串          # 只跑文件名含该子串的（如 test-all.cjs host）
//
// 退出码：全过 0；有任何一份失败或异常退出 1。
// 新增测试**不用改这个文件** —— 命名成 tools/test-*.cjs 就会被自动收进来。
'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const TOOLS = path.join(ROOT, 'tools')

const argv = process.argv.slice(2)
const VERBOSE = argv.includes('--verbose') || argv.includes('-v')
const filters = argv.filter(function (a) { return a.charAt(0) !== '-' })

/* 每个测试的超时上限。host 侧的测试要反复跑 translate/locate，留宽一点。 */
const TIMEOUT_MS = 180000

/* 从输出里抓「通过 N 项，失败 M 项」/「N 通过 / M 失败」/「ALL PASS」，只为了显示。 */
function summarize(out) {
  let m = out.match(/通过\s*(\d+)\s*项[，,]\s*失败\s*(\d+)\s*项/)
  if (m) return { pass: +m[1], fail: +m[2] }
  m = out.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/)
  if (m) return { pass: +m[1], fail: +m[2] }
  if (/ALL PASS/.test(out)) return { pass: null, fail: 0 }
  return null
}

/* 抓失败明细行，方便不跑 --verbose 也能看到问题在哪。 */
function failureLines(out) {
  return out.split('\n')
    .filter(function (l) { return /✗|★|FAIL|失败|Error|error:/.test(l) && !/失败 0 项|0 失败/.test(l) })
    .slice(0, 6)
}

function main() {
  let files = fs.readdirSync(TOOLS)
    .filter(function (f) { return /^test-.*\.cjs$/.test(f) })
    .filter(function (f) { return f !== path.basename(__filename) })
    .sort()
  if (filters.length) {
    files = files.filter(function (f) {
      return filters.some(function (k) { return f.indexOf(k) >= 0 })
    })
  }

  if (!files.length) {
    console.log('没有找到任何测试文件（tools/test-*.cjs）')
    process.exit(1)
  }

  console.log('══ 回归测试总入口 ══')
  console.log('发现 ' + files.length + ' 份测试，开始运行…')
  console.log('（node ' + process.version + '，单份上限 ' + (TIMEOUT_MS / 1000) + ' 秒）')
  console.log('')

  const results = []
  for (const f of files) {
    const t0 = Date.now()
    // process.execPath = 正在跑本脚本的那个 node，PATH 里没有 node 也能用
    const r = spawnSync(process.execPath, [path.join(TOOLS, f)], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024
    })
    const out = (r.stdout || '') + (r.stderr || '')
    const ms = Date.now() - t0
    const timedOut = r.error && r.error.code === 'ETIMEDOUT'
    const code = typeof r.status === 'number' ? r.status : -1
    const ok = !timedOut && code === 0

    results.push({ file: f, ok: ok, code: code, ms: ms, out: out, timedOut: timedOut, sum: summarize(out) })

    const mark = ok ? '✓' : '✗'
    const sum = results[results.length - 1].sum
    const detail = sum && sum.pass !== null
      ? sum.pass + ' 通过 / ' + sum.fail + ' 失败'
      : (sum ? 'ALL PASS' : (ok ? '通过' : '退出码 ' + code))
    console.log('  ' + mark + ' ' + f.padEnd(30) + detail.padEnd(20) + (ms / 1000).toFixed(1) + 's')
    if (!ok) {
      if (timedOut) console.log('      ⚠ 超时（超过 ' + (TIMEOUT_MS / 1000) + ' 秒被中止）')
      failureLines(out).forEach(function (l) { console.log('      ' + l.trim().slice(0, 100)) })
    }
  }

  const bad = results.filter(function (r) { return !r.ok })
  // 通过了但没报条数的：不点名就会让"断言合计"静默少算 —— 少报比不报更误导。
  const noCount = results.filter(function (r) {
    return r.ok && (!r.sum || r.sum.pass === null)
  })
  const totalPass = results.reduce(function (a, r) { return a + (r.sum && r.sum.pass ? r.sum.pass : 0) }, 0)
  const totalFail = results.reduce(function (a, r) { return a + (r.sum && r.sum.fail ? r.sum.fail : 0) }, 0)

  console.log('')
  console.log('────────────────────────────────')
  console.log(results.length + ' 份测试：' + (results.length - bad.length) + ' 通过 / ' + bad.length + ' 失败')
  if (totalPass) console.log('断言合计：' + totalPass + ' 通过 / ' + totalFail + ' 失败')
  if (noCount.length) {
    console.log('⚠ 这 ' + noCount.length + ' 份没报条数，未计入上面的合计：' +
      noCount.map(function (r) { return r.file }).join(', '))
    console.log('  （想让它们计入，在该测试结尾打出「通过 N 项，失败 M 项」即可）')
  }
  console.log('总耗时 ' + (results.reduce(function (a, r) { return a + r.ms }, 0) / 1000).toFixed(1) + 's')

  if (bad.length) {
    console.log('')
    console.log('失败清单：' + bad.map(function (r) { return r.file }).join(', '))
    if (VERBOSE) {
      bad.forEach(function (r) {
        console.log('')
        console.log('════════ ' + r.file + ' 完整输出 ════════')
        console.log(r.out)
      })
    } else {
      console.log('（加 --verbose 可看完整输出）')
    }
  }

  process.exit(bad.length ? 1 : 0)
}

main()
