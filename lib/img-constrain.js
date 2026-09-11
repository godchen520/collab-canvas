/* global collab-canvas / 话布 · 图片约束兜底
   即使 CSS 选择器漏、即使 inline style 用了 !important (CSS 覆盖不了
   inline !important) 都能压住。每秒 + 任何 DOM 新增都重扫一遍。
*/
(function () {
  var fix = function (root) {
    var scope = root || document;
    var imgs = scope.querySelectorAll ? scope.querySelectorAll('img') : [];
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (!img.isConnected) continue;
      var parent = img.parentElement || document.body;
      var pw = parent.clientWidth;
      if (!pw) continue;
      var w = img.offsetWidth || img.naturalWidth || 0;
      if (w > pw + 2) {
        img.style.maxWidth = '100%';
        img.style.maxHeight = '100vh';
        img.style.width = '100%';
        img.style.height = 'auto';
      }
    }
  };
  if (document.readyState !== 'loading') fix();
  else document.addEventListener('DOMContentLoaded', fix);
  setInterval(fix, 1000);
  try {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.addedNodes && m.addedNodes.length) fix(document);
      }
    }).observe(document.body, { childList: true, subtree: true });
  } catch (e) {}
})();
