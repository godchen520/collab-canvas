#!/usr/bin/env node
// DSH Collab-Canvas · 文档保鲜检查
//
// 为什么要有这个：
//   2026-09-16 发现 docs/DEV-GUIDE.md 里 **8 处**写着 `node tools/build.js` ——
//   这个文件**从来不存在**（真名 tools/build.cjs，且这句错话还被 build.cjs 的
//   模板写进了 dist/host.js 的产物头部）。文档不会自己报错，只会静静地教错东西。
//   所以把"文档里提到的命令是否真的存在"变成一条自动检查。
//
// 只检查**命令行形式**的引用（`node tools/xxx.cjs`），不检查正文里提名字的地方 ——
//   否则像 "tools/xxx"、"tools/test-*.cjs" 这类**占位写法**会被误报成缺失，
//   而假红比不报更糟：它会训练人忽略输出。
//
// 用法：node tools/check-docs.cjs
// 退出码：0 = 全部存在；1 = 有引用了不存在的文件。
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

/* 只扫"流程文档"，不扫 canvas-docs/ —— 那是用户自己的内容，会天然出现占位写法。 */
function docFiles() {
  const out = []
  const push = function (d) {
    let e
    try { e = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { return }
    for (const f of e) {
      if (f.isDirectory()) continue
      if (/\.md$/i.test(f.name)) out.push(path.join(d, f.name))
    }
  }
  push(ROOT)                       // 根目录的 README / CHANGELOG 之类
  push(path.join(ROOT, 'docs'))    // 流程文档
  return out
}

/* 命令行形式：node tools/名字.cjs  —— 名字里允许 . - _ 和字母数字 */
const CMD_RE = /node\s+(tools\/[A-Za-z0-9_.-]+\.cjs)/g

function main() {
  const docs = docFiles()
  if (!docs.length) {
    console.log('没找到任何流程文档（根目录 *.md 或 docs/*.md）')
    process.exit(0)
  }

  console.log('══ 文档保鲜检查 ══')
  console.log('扫描 ' + docs.length + ' 份文档…')
  console.log('')

  let bad = 0, good = 0, total = 0
  for (const d of docs) {
    const rel = path.relative(ROOT, d).replace(/\\/g, '/')
    const s = fs.readFileSync(d, 'utf8')
    const names = [...new Set([...s.matchAll(CMD_RE)].map(function (m) { return m[1] }))].sort()
    if (!names.length) continue

    console.log('── ' + rel)
    for (const n of names) {
      total++
      const p = path.join(ROOT, n)
      /* 带 * 的是通配写法，跳过（不是具体文件） */
      if (n.indexOf('*') >= 0) { console.log('   － ' + n + '  （通配，跳过）'); continue }
      const ok = fs.existsSync(p)
      if (ok) { good++; console.log('   ✓ ' + n) }
      else { bad++; console.log('   ★ ' + n + '  —— 文档里让跑它，但文件不存在') }
    }
    console.log('')
  }

  console.log('────────────────────────────────')
  console.log('引用的命令 ' + total + ' 处：' + good + ' 存在 / ' + bad + ' 不存在')
  if (bad) {
    console.log('')
    console.log('修法：把文档里的旧文件名改成实际存在的；或把命令补进 tools/。')
    process.exit(1)
  }
  console.log('文档里的命令都对得上 ✓')
  process.exit(0)
}

main()
