#!/usr/bin/env node
// 从已构建的 dist/host.js 反向拆分出 src/host/*.js 源文件
// build.cjs 的输出格式：
//   <header 2 行> <imports> export const name/inject ... export function apply(ctx, config) {
//   <body: 每个源文件前插 "\n    // ==== <name> ====\n" + content.trim()，join("\n")>
//   }
'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src', 'host')
const built = fs.readFileSync(process.argv[2], 'utf8')

// 定位 apply 函数体
const openMark = 'export function apply(ctx, config) {\n'
const openIdx = built.indexOf(openMark)
if (openIdx < 0) throw new Error('未找到 apply 函数开头')
const bodyStart = openIdx + openMark.length
const bodyEnd = built.lastIndexOf('\n}\n')
if (bodyEnd < bodyStart) throw new Error('未找到 apply 函数结尾')
const body = built.slice(bodyStart, bodyEnd)

// 按分节标记切分
const markerRe = /^ {4}\/\/ ={20} (.+?) ={20}$/gm
const marks = []
let m
while ((m = markerRe.exec(body)) !== null) {
  marks.push({ name: m[1], start: m.index, contentStart: m.index + m[0].length })
}
if (!marks.length) throw new Error('未找到任何分节标记')

const written = []
for (let i = 0; i < marks.length; i++) {
  const cur = marks[i]
  const nextStart = i + 1 < marks.length ? marks[i + 1].start : body.length
  // 当前块 = contentStart .. nextStart，去掉尾部 join 产生的空行
  let content = body.slice(cur.contentStart, nextStart)
  content = content.replace(/\n+$/, '')
  // 首行紧跟标记换行，去掉开头的 \n
  content = content.replace(/^\n/, '')
  fs.writeFileSync(path.join(SRC, cur.name), content + '\n')
  written.push(cur.name)
}

console.log('反向拆分出', written.length, '个源文件:')
written.forEach(function (n) { console.log('  ' + n) })

// 报告哪些旧源文件不在新列表里（即被删除的模块）
const existing = fs.readdirSync(SRC).filter(function (f) { return f.endsWith('.js') })
const stale = existing.filter(function (f) { return written.indexOf(f) < 0 })
if (stale.length) {
  console.log('\n以下源文件已不在构建产物中（应删除）:')
  stale.forEach(function (f) { console.log('  ' + f) })
}
