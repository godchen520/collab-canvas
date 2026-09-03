#!/usr/bin/env node
// 修复源码中的反引号字符，替换为 \x60 转义序列
// 运行: node tools/fix-backticks.cjs
'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const dirs = [path.join(ROOT, 'src', 'client'), path.join(ROOT, 'src', 'host')]

for (const dir of dirs) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'))
  for (const file of files) {
    const fp = path.join(dir, file)
    let content = fs.readFileSync(fp, 'utf8')
    const original = content

    // 1. 把模板字面量 `...` 转为 '\x60...\x60'（非 EDITOR_PANEL_JS 的那些）
    //    先跳过 EDITOR_PANEL_JS = `...` 模板（由 build.cjs 处理）
    //    处理其他模板字面量（如 editor-panel.js 的 CSS 模板）
    content = content.replace(/= `([\s\S]*?)`/g, function(match, inner) {
      if (match.startsWith('const EDITOR_PANEL_JS')) return match // 跳过 EDITOR_PANEL_JS
      // 其他模板字面量：转义内容中的单引号，用单引号包裹
      const escaped = inner.replace(/'/g, "\\'").replace(/\n/g, "\\n")
      return "= '" + escaped + "'"
    })

    // 2. 替换源码中直接使用的反引号字符（字符串中的 ` 用于 markdown）
    //    用 \x60 替换所有裸反引号（在字符串字面量中使用）
    //    只处理 'code' 和 'pre' 相关的返回值中的反引号
    content = content.replace(/return'`'/g, "return'\\x60'")
    content = content.replace(/'\+i\+'`'/g, "'+i+'\\x60'")
    content = content.replace(/return '`'/g, "return '\\x60'")
    content = content.replace(/'` \+ inner \+ '`'/g, "'\\x60' + inner + '\\x60'")
    // 修复 ``` 三反引号
    content = content.replace(/return'\\n`\\`\\`\\n'/g, "return'\\n\\x60\\x60\\x60\\n'")
    content = content.replace(/'\\n\+.*?\\n\\`\\`\\`\\n'/g, function(m) {
      return m.replace(/`/g, '\\x60')
    })

    if (content !== original) {
      fs.writeFileSync(fp, content, 'utf8')
      console.log('fixed:', file)
    }
  }
}
console.log('done')
