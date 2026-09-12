// 这里原本有一段 12,999 字符的 EDITOR_PANEL_JS 字符串：早期"浮层面板式编辑器"的
    // 整份浏览器端代码（自带一套 mdToHtml/htmlToMd、划词栏，还有一段把「话布」按钮
    // 硬塞进侧栏设置区的 findSettingsArea + setInterval 逻辑）。
    // 2026-09-12 代码体检确认：全包零引用（只有定义、没有任何读取），实际对外提供的是
    // lib/client.js，所以整段是纯死代码，已删除。
    // 需要考古可查：git 历史中的 src/host/10-editor-code.js（v0.3.0 及以前）
