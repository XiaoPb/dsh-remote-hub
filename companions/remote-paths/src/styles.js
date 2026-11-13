export const pathStyles = `
.rhp-mask{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:20px;background:var(--dsw-alias-bg-mask-1);font-family:var(--dsw-font-family);color:var(--dsw-alias-label-primary)}
.rhp-dialog{box-sizing:border-box;width:min(680px,100%);max-height:88dvh;display:flex;flex-direction:column;gap:16px;padding:24px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);box-shadow:var(--dsw-shadow-lv3);font-size:14px;line-height:1.5;overflow:auto}
.rhp-dialog h2{margin:0;font-size:18px;font-weight:600;letter-spacing:-.2px}.rhp-dialog p{margin:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rhp-dialog button,.rhp-dialog input,.rhp-trigger{font:inherit;box-sizing:border-box}
.rhp-button,.rhp-trigger{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;padding:7px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;transition:background .12s}
.rhp-button:hover,.rhp-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rhp-button:disabled{opacity:.45;cursor:default}.rhp-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);border-color:transparent}.rhp-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.rhp-dialog :is(button,input):focus-visible,.rhp-trigger:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px}
.rhp-row{display:flex;align-items:center;gap:8px}.rhp-input{min-width:0;flex:1;width:100%;height:38px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.rhp-path{font-family:var(--dsh-font-family-code-default);font-size:13px}.rhp-crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:4px}.rhp-crumbs .rhp-button{border:0;min-height:28px;padding:3px 8px;color:var(--dsw-alias-label-secondary)}.rhp-crumbs .rhp-button:not(:last-child)::after{content:'/';margin-left:8px;color:var(--dsw-alias-label-caption)}
.rhp-toggle{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary)}.rhp-toggle input{accent-color:var(--dsw-alias-button-info-fill)}
.rhp-list{min-height:160px;max-height:34dvh;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:4px;scrollbar-width:thin}.rhp-list .rhp-button{width:100%;justify-content:flex-start;border:0;border-radius:var(--dsw-radius-xs);text-align:left;min-height:38px}.rhp-list p{padding:24px;text-align:center}.rhp-directory-icon{width:18px;height:18px;flex:none;color:var(--dsw-alias-label-tertiary)}
.rhp-footer{display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:16px}.rhp-dialog .rhp-error{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}.rhp-dialog .rhp-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}.rhp-trigger{min-height:28px;padding:3px 8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary)}
.rhp-file-row{display:flex;align-items:center;gap:10px;min-height:38px;padding:6px 10px;border-radius:var(--dsw-radius-xs);cursor:pointer;overflow-wrap:anywhere}.rhp-file-row:hover{background:var(--dsw-alias-interactive-bg-hover)}.rhp-file-row input{accent-color:var(--dsw-alias-button-info-fill)}
@media(max-width:520px){.rhp-mask{padding:12px}.rhp-dialog{padding:18px;gap:12px}.rhp-row{flex-wrap:wrap}.rhp-input{flex-basis:180px}}
`
export function installPathStyles(document) {
  if (!document || document.getElementById('remote-paths-styles')) return
  const style = document.createElement('style')
  style.id = 'remote-paths-styles'
  style.textContent = pathStyles
  document.head.append(style)
}
