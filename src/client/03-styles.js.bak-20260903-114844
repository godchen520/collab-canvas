// 面板样式（全部使用 --dsw-* 主题 token，换肤即跟随）
styles.insert(
  '.ccv-root{display:flex;flex-direction:column;height:100%;min-height:0;font-family:var(--font-ui,system-ui,sans-serif)}' +
  '.ccv-bar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));flex-wrap:wrap}' +
  '.ccv-tabs{display:flex;gap:4px;flex-wrap:wrap;flex:1;min-width:120px;align-items:center}' +
  '.ccv-tabwrap{display:flex;align-items:center;border-radius:6px}' +
  '.ccv-tab{padding:3px 10px;border-radius:6px 0 0 6px;border:1px solid transparent;border-right:none;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));cursor:pointer;font-size:12px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:inherit}' +
  '.ccv-tab[data-active="1"]{background:var(--dsw-alias-interactive-bg-active,rgba(59,130,246,.22));border-color:var(--dsw-alias-brand-primary,rgba(59,130,246,.55));font-weight:600}' +
  '.ccv-tabx{padding:3px 6px;border-radius:0 6px 6px 0;border:1px solid transparent;border-left:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));cursor:pointer;font-size:11px;line-height:1;color:inherit;opacity:.55}' +
  '.ccv-tabx:hover{opacity:1;background:rgba(239,68,68,.18)}' +
  '.ccv-tabx[data-armed="1"]{color:var(--dsw-alias-state-error-primary,#ef4444);border-color:var(--dsw-alias-state-error-primary,#ef4444);opacity:1;font-weight:700}' +
  '.ccv-btn{padding:3px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:inherit;cursor:pointer;font-size:12px;font-family:inherit}' +
  '.ccv-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15))}' +
  '.ccv-input{padding:3px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font-size:12px;width:140px}' +
  '.ccv-badge{font-size:10px;opacity:.45;margin-left:auto;user-select:none}' +
  '.ccv-wysiwyg{flex:1;min-height:0;overflow-y:auto;padding:18px 24px;outline:none;font-size:14px;line-height:1.75;word-break:break-word}' +
  '.ccv-wysiwyg h1{font-size:1.6em;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));padding-bottom:.2em;margin:.5em 0 .4em}' +
  '.ccv-wysiwyg h2{font-size:1.35em;margin:.5em 0 .4em}' +
  '.ccv-wysiwyg h3{font-size:1.18em;margin:.5em 0 .4em}' +
  '.ccv-wysiwyg blockquote{border-left:3px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));margin:.5em 0;padding:2px 12px;opacity:.85}' +
  '.ccv-wysiwyg pre{background:var(--dsw-alias-markdown-code-block,rgba(128,128,128,.12));padding:10px 12px;border-radius:6px;overflow-x:auto;white-space:pre-wrap}' +
  '.ccv-wysiwyg code{background:var(--dsw-alias-markdown-inline-code,rgba(128,128,128,.16));padding:1px 4px;border-radius:3px;font-family:var(--font-mono,ui-monospace,Menlo,monospace);font-size:.95em}' +
  '.ccv-wysiwyg pre code{background:transparent;padding:0}' +
  '.ccv-wysiwyg ul,.ccv-wysiwyg ol{padding-left:1.6em}' +
  '.ccv-wysiwyg a{color:var(--dsw-alias-brand-primary,#3b82f6)}' +
  '.ccv-wysiwyg:empty:before{content:attr(data-placeholder);opacity:.35}' +
  '.ccv-menu{position:fixed;z-index:9999;background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay,#ffffff));color:var(--dsw-alias-label-primary,#1a1a1a);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.4));border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.25);padding:4px;min-width:150px;max-width:min(260px,80vw);max-height:60vh;overflow-y:auto}' +
  '.ccv-menu[data-delayed="1"]{opacity:0;pointer-events:none;animation:ccvMenuShow .15s ease 1s forwards}' +
  '@keyframes ccvMenuShow{to{opacity:1;pointer-events:auto}}' +
  '.ccv-selbar{position:fixed;z-index:9998;display:flex;align-items:center;gap:2px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay,#ffffff));color:var(--dsw-alias-label-primary,#1a1a1a);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.4));border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.25);padding:2px 6px;user-select:none;-webkit-user-select:none;touch-action:manipulation}' +
  '.ccv-selbar button{border:none;background:transparent;color:inherit;cursor:pointer;font-size:13px;min-width:30px;height:30px;border-radius:6px;font-family:inherit}' +
  '.ccv-selbar button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.2))}' +
  '.ccv-selbar button[data-active="1"]{background:rgba(59,130,246,.22);color:var(--dsw-alias-brand-primary,#3b82f6)}' +
  '.ccv-selbar .ccv-minibar-more{font-size:16px;letter-spacing:1px}' +
  '.ccv-menu-head{display:flex;align-items:center;justify-content:space-between;padding:2px 6px 4px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));margin-bottom:4px}' +
  '.ccv-menu-title{font-size:11px;opacity:.55;user-select:none}' +
  '.ccv-menu-close{border:none;background:transparent;color:inherit;cursor:pointer;font-size:14px;padding:2px 6px;border-radius:4px;opacity:.7}' +
  '.ccv-menu-close:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.2))}' +
  '.ccv-menu-item{display:block;width:100%;text-align:left;padding:6px 12px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:13px;border-radius:5px;font-family:inherit}' +
  '.ccv-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(59,130,246,.18))}' +
  '.ccv-menu-sep{height:1px;background:var(--dsw-alias-border-l1,rgba(128,128,128,.3));margin:4px 6px}' +
  '.ccv-status{padding:4px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));font-size:11px;opacity:.75;min-height:18px;font-family:var(--font-ui,system-ui,sans-serif)}' +
  '.ccv-status[data-kind="error"]{color:var(--dsw-alias-state-error-primary,#ef4444);opacity:1}'
)
