// 格式状态查询（独立模块，供划词栏高亮当前格式）
// 纯函数：不修改 DOM，不依赖 React 组件状态

var FORMAT_HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']

/**
 * 查询当前选区的格式状态
 * @returns {{ bold: boolean, italic: boolean, underline: boolean, heading: string|null }}
 *   heading = null | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
 */
function queryFormatState() {
  var result = { bold: false, italic: false, underline: false, heading: null }
  try {
    result.bold = document.queryCommandState('bold')
    result.italic = document.queryCommandState('italic')
    result.underline = document.queryCommandState('underline')
  } catch (_) {}

  // 从选区向上查找最近的标题元素
  try {
    var sel = document.getSelection()
    if (sel && sel.rangeCount > 0) {
      var node = sel.getRangeAt(0).startContainer
      // 如果是文本节点，取其父元素
      if (node.nodeType === 3) node = node.parentNode
      // 向上遍历直到找到标题元素或到达编辑器边界
      while (node && node.nodeType === 1) {
        var tag = node.tagName ? node.tagName.toLowerCase() : ''
        if (FORMAT_HEADING_TAGS.indexOf(tag) >= 0) {
          result.heading = tag
          break
        }
        // 到达编辑器根节点（.ccv-wysiwyg）则停止
        if (node.classList && node.classList.contains('ccv-wysiwyg')) break
        node = node.parentNode
      }
    }
  } catch (_) {}

  return result
}
