export const SETTINGS_CSS = `
*{box-sizing:border-box}
body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);line-height:1.45}
main{position:relative;max-width:1360px;margin:auto;padding:20px 28px 64px}
h1{font-size:22px;font-weight:600;margin:0}h2{font-size:15px;font-weight:600;margin:0 0 12px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}h3{font-size:13px;font-weight:600;margin:16px 0 6px;display:flex;align-items:baseline;gap:6px}p{margin:6px 0}
button,input,select,textarea{font:inherit}
button{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--vscode-button-border,transparent);border-radius:2px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);padding:4px 11px;cursor:pointer;line-height:18px}
button:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-color:var(--vscode-button-secondaryBorder,var(--vscode-button-border,transparent))}
button.secondary:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}
button.icon{padding:3px;min-width:26px;justify-content:center}
button:disabled{opacity:.5;cursor:default}
input,select,textarea{color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:2px;padding:4px 6px;max-width:100%}
select{color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);border-color:var(--vscode-dropdown-border,var(--vscode-panel-border))}
input::placeholder,textarea::placeholder{color:var(--vscode-input-placeholderForeground)}
input[aria-invalid=true]{border-color:var(--vscode-inputValidation-errorBorder)}
input:focus,select:focus,textarea:focus,button:focus-visible,summary:focus-visible,.listbox:focus,.inline-status:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
textarea{display:block;width:100%;min-height:60px;resize:vertical;font-family:var(--vscode-editor-font-family)}textarea.prose{font-family:inherit;min-height:90px}
input[type=checkbox]{width:auto;margin:0;accent-color:var(--vscode-checkbox-background)}
input[type=search]{min-width:220px}
label{display:block;margin:10px 0 4px}label>input,label>select,label>textarea{display:block;margin-top:4px}label.check{display:inline-flex;align-items:center;gap:6px;margin:0}label.check>input{margin:0}
code,pre{font-family:var(--vscode-editor-font-family);overflow-wrap:anywhere}
pre{white-space:pre-wrap;font-size:12px;margin:6px 0;padding:8px 10px;background:var(--vscode-textCodeBlock-background);border-radius:3px}pre.scroll{max-height:320px;overflow:auto}
.muted{color:var(--vscode-descriptionForeground)}.small{font-size:12px}.error{color:var(--vscode-errorForeground)}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}.toolbar.between{justify-content:space-between}.grow{flex:1;min-width:0}
.add-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}.add-row>input{flex:1;min-width:160px}
.field-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}
.field-pair{display:flex;gap:8px;align-items:flex-start}.field-pair>.field{flex:1;min-width:0}.field-pair>button{margin-top:12px}
.card-head{display:flex;gap:8px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}.card-head>h2{flex:1}
.unsaved{color:var(--vscode-editorWarning-foreground);font-size:10px}
.header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}.header .toolbar{margin:0}
.progress{position:fixed;top:0;left:0;right:0;height:2px;overflow:hidden;z-index:10}.progress::before{content:"";position:absolute;height:100%;width:30%;background:var(--vscode-progressBar-background);animation:progress 1.2s ease-in-out infinite}
@keyframes progress{from{left:-30%}to{left:100%}}
.status{min-height:20px;margin:6px 0}.status:empty{min-height:0;margin:0}.inline-status{min-height:20px;margin-top:6px;display:flex;gap:6px;align-items:flex-start;color:var(--vscode-descriptionForeground)}.inline-status.error{color:var(--vscode-errorForeground)}.inline-status .codicon{flex:none;margin-top:1px}
.notice{border-left:3px solid var(--vscode-textBlockQuote-border,var(--vscode-focusBorder));background:var(--vscode-textBlockQuote-background);padding:4px 12px;margin:10px 0 0}.notice>summary{margin:4px 0}
.hint{display:flex;gap:6px;align-items:center;margin:0 0 16px}
dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 14px;margin:8px 0}dt{color:var(--vscode-descriptionForeground)}dd{margin:0;overflow-wrap:anywhere}
.tabs{display:flex;flex-wrap:wrap;gap:2px;border-bottom:1px solid var(--vscode-panel-border);margin:14px 0 16px}
.tabs button{background:none;color:var(--vscode-panelTitle-inactiveForeground);border:0;border-bottom:1px solid transparent;border-radius:0;padding:6px 12px;margin-bottom:-1px;text-transform:uppercase;font-size:11px;letter-spacing:.04em;white-space:nowrap}
.tabs button:hover:not(:disabled){background:none;color:var(--vscode-panelTitle-activeForeground)}
.tabs button[aria-selected=true]{color:var(--vscode-panelTitle-activeForeground);border-bottom-color:var(--vscode-panelTitle-activeBorder)}
.grid{display:grid;grid-template-columns:minmax(240px,1fr) minmax(320px,2fr);gap:16px;align-items:start}
.card{border:1px solid var(--vscode-panel-border);border-radius:4px;padding:14px 16px;margin-bottom:16px;min-width:0}
.listbox{position:relative;max-height:520px;overflow:auto;border:1px solid var(--vscode-panel-border);border-radius:2px}
.group-label{position:sticky;top:0;z-index:1;padding:4px 10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--vscode-descriptionForeground);background:var(--vscode-sideBarSectionHeader-background,var(--vscode-editor-background))}
.option{padding:5px 10px;cursor:pointer;min-width:0}.option:hover{background:var(--vscode-list-hoverBackground)}
.option.selected{background:var(--vscode-list-inactiveSelectionBackground);color:var(--vscode-list-inactiveSelectionForeground)}
.listbox:focus .option.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);outline:1px solid var(--vscode-list-focusOutline,var(--vscode-focusBorder));outline-offset:-1px}
.listbox:focus .option.selected .muted{color:inherit;opacity:.85}
.option-row{display:flex;align-items:center;gap:6px;min-width:0}.option-row.wrap{flex-wrap:wrap}.option-row>strong{flex:0 1 auto;min-width:0}.option-row>span.ellipsis{flex:1}
.mono{font-family:var(--vscode-editor-font-family)}.push{margin-left:auto;flex:none}
.ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dim{opacity:.6}
.badge{display:inline-block;padding:0 6px;border-radius:9px;font-size:11px;font-weight:400;line-height:16px;border:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);white-space:nowrap}
.badge.accent{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-color:transparent}
.badge.warning{color:var(--vscode-editorWarning-foreground);border-color:currentColor}
.plain-list{margin:4px 0;padding-left:22px}
ol.ordered{list-style:none;margin:8px 0;padding:0;border:1px solid var(--vscode-panel-border);border-radius:2px}ol.ordered li{display:flex;gap:8px;align-items:center;padding:2px 6px;min-width:0}ol.ordered li+li{border-top:1px solid var(--vscode-panel-border)}
ol.ordered li:hover{background:var(--vscode-list-hoverBackground)}ol.ordered li:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px;background:var(--vscode-list-focusBackground,var(--vscode-list-hoverBackground))}ol.ordered li>code{flex:0 1 auto;min-width:0}
.warning-text{color:var(--vscode-editorWarning-foreground);display:inline-flex;gap:4px;align-items:center}
.field-title{font-weight:600}.field-head{display:flex;gap:8px;align-items:center;margin:12px 0 0}
.segmented{display:inline-flex}.segmented>button{border-radius:0}.segmented>button:first-child{border-radius:2px 0 0 2px}.segmented>button:last-child{border-radius:0 2px 2px 0}
button.link{background:none;border:0;padding:0;color:var(--vscode-textLink-foreground);cursor:pointer}button.link:hover:not(:disabled){background:none;color:var(--vscode-textLink-activeForeground);text-decoration:underline}
.ordinal{min-width:18px;text-align:right;color:var(--vscode-descriptionForeground)}
.provider-bar{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin:8px 0}.provider-bar>span{flex:1;min-width:220px}.provider-bar .toolbar{margin:0}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);vertical-align:top}
table.models{table-layout:fixed}table.models td{overflow:hidden}.col-provider{width:16%}.col-num{width:9%}.col-price{width:13%}.col-thinking{width:15%}.col-status{width:11%}
th{font-weight:600;font-size:12px;color:var(--vscode-descriptionForeground);white-space:nowrap}
tbody tr:hover{background:var(--vscode-list-hoverBackground)}
.pager{margin:0;gap:4px}section>.pager:last-child{justify-content:flex-end;margin-top:8px}
.description{margin:0 0 8px}
.preview{margin-top:16px;padding-top:8px;border-top:1px solid var(--vscode-panel-border)}
details>summary{cursor:pointer;margin:8px 0}
fieldset{border:0;margin:0;padding:0;min-width:0}
.empty{padding:24px;text-align:center;color:var(--vscode-descriptionForeground)}.empty .codicon{font-size:24px}
[hidden]{display:none!important}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--vscode-descriptionForeground);font-weight:600}
.mchip{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:100%;font-family:var(--vscode-editor-font-family);font-size:12px}
.mchip .mname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mchip .prov{color:var(--vscode-descriptionForeground)}
.dot{flex:none;width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--vscode-charts-green)}
.mchip.bad{color:var(--vscode-editorWarning-foreground)}.mchip.bad .small{font-family:var(--vscode-font-family);white-space:nowrap}
.mchip.none{font-family:inherit;font-style:italic;color:var(--vscode-descriptionForeground)}
.meter{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:12px}
.meter .bars{display:inline-flex;gap:2px;align-items:flex-end;height:12px}
.meter .bars i{display:block;width:4px;border-radius:1px;background:var(--vscode-panel-border);border:1px solid transparent}
.meter .bars i:nth-child(1){height:4px}.meter .bars i:nth-child(2){height:6px}.meter .bars i:nth-child(3){height:8px}.meter .bars i:nth-child(4){height:10px}.meter .bars i:nth-child(5){height:12px}
.meter .bars i.on{background:var(--vscode-foreground);opacity:.85}
.meter.auto{font-style:italic}.meter.none{color:var(--vscode-descriptionForeground)}
.src{display:inline-flex;align-items:center;padding:0 6px;border-radius:9px;font-size:11px;line-height:16px;white-space:nowrap;border:1px solid currentColor;background:transparent;font-weight:400}
.src.s-global,.src.s-override{color:var(--vscode-charts-blue)}.src.s-project{color:var(--vscode-charts-purple)}.src.s-env,.src.s-overlay{color:var(--vscode-charts-orange)}.src.s-definition{color:var(--vscode-charts-green)}
.src.s-builtin,.src.s-none{color:var(--vscode-descriptionForeground)}.src.s-inherited{color:var(--vscode-descriptionForeground);border-style:dashed}
.listbox:focus .option.selected .src,.listbox:focus .option.selected .mchip.bad,.listbox:focus .option.selected .mchip.none{color:inherit}
.pill{display:inline-block;padding:0 6px;border-radius:9px;font-size:11px;line-height:16px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);white-space:nowrap}
.tag{display:inline-block;margin:0 4px 2px 0;padding:0 5px;border-radius:2px;font-size:11px;line-height:16px;border:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);white-space:nowrap}
.xs{font-size:11px}
.banner{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start;border:1px solid var(--vscode-inputValidation-warningBorder,var(--vscode-editorWarning-foreground));background:var(--vscode-inputValidation-warningBackground);padding:7px 10px;border-radius:3px;margin:8px 0}
.banner>.codicon{color:var(--vscode-editorWarning-foreground);margin-top:2px}.banner>.grow{flex:1 1 240px}.banner.inner{margin:10px 0 0}
.banner.info{border-color:var(--vscode-panel-border);background:var(--vscode-textBlockQuote-background)}.banner.info>.codicon{color:var(--vscode-charts-blue)}
.master-detail{display:grid;grid-template-columns:minmax(260px,340px) minmax(0,1fr);gap:16px;align-items:start}
.list-card{padding:12px 0 12px;overflow:hidden}.list-card>*{margin-left:12px;margin-right:12px}.list-card>.listbox{margin-left:0;margin-right:0;border-left:0;border-right:0;border-radius:0;max-height:640px}
.list-card>h2{margin-bottom:8px}
.lrow{display:grid;gap:2px;min-width:0}.lrow .option-row{flex-wrap:nowrap}
.detail{padding:16px 18px}.detail>h3:first-of-type{margin-top:16px}
.effective{background:var(--vscode-textBlockQuote-background);border-radius:3px;padding:10px 14px;margin:8px 0}
.effective-line{display:flex;gap:6px 14px;align-items:center;flex-wrap:wrap;margin:4px 0}.big{font-size:15px;min-width:0}
.role-strip{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;margin:6px 0 10px;padding:6px 10px;border:1px solid var(--vscode-panel-border);border-radius:3px}
.strip-item{display:inline-flex;gap:6px;align-items:center;min-width:0}
.chips{display:inline-flex;gap:4px;flex-wrap:wrap}.chips button[aria-pressed=true]{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
.inline-label{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}.inline-label>select{margin:0}
.outcome{display:inline-flex;gap:8px;align-items:center;vertical-align:middle}
.depends{grid-template-columns:100px minmax(0,1fr)}
ol.trace{list-style:none;margin:6px 0;padding:0}
ol.trace li{display:grid;grid-template-columns:20px minmax(84px,150px) minmax(0,1fr);gap:0 8px;align-items:start;padding:3px 0;position:relative}
ol.trace li::before{content:"";position:absolute;left:8px;top:21px;bottom:-5px;width:1px;background:var(--vscode-panel-border)}ol.trace li:last-child::before{display:none}
ol.trace .bullet{width:17px;height:17px;border-radius:50%;border:1px solid var(--vscode-descriptionForeground);display:flex;align-items:center;justify-content:center;font-size:10px;margin-top:1px;background:var(--vscode-editor-background);z-index:1}
ol.trace li.used .bullet{background:var(--vscode-button-background);border-color:transparent;color:var(--vscode-button-foreground)}
ol.trace li.shadowed .val{text-decoration:line-through;opacity:.65}ol.trace li.unset{opacity:.7}
ol.trace .lay{font-size:12px;font-weight:600;overflow-wrap:anywhere}ol.trace .why{font-size:11px;color:var(--vscode-descriptionForeground)}
.vscode-high-contrast .option.selected,.vscode-high-contrast-light .option.selected{outline:1px solid var(--vscode-contrastActiveBorder);outline-offset:-1px}
.vscode-high-contrast .tabs button[aria-selected=true],.vscode-high-contrast-light .tabs button[aria-selected=true]{border-bottom:3px solid var(--vscode-contrastActiveBorder);font-weight:700}
.vscode-high-contrast ol.trace li.used .bullet,.vscode-high-contrast-light ol.trace li.used .bullet{background:transparent;border:2px solid var(--vscode-contrastActiveBorder);color:var(--vscode-foreground)}
.vscode-high-contrast .meter .bars i,.vscode-high-contrast-light .meter .bars i{border-color:var(--vscode-foreground)}
.vscode-high-contrast .src,.vscode-high-contrast-light .src{color:var(--vscode-foreground)}
.vscode-high-contrast .banner,.vscode-high-contrast-light .banner{background:transparent}
.vscode-high-contrast .dot,.vscode-high-contrast-light .dot{outline:1px solid var(--vscode-foreground)}
@media(forced-colors:active){
  .option.selected{outline:2px solid Highlight;outline-offset:-2px}
  .tabs button[aria-selected=true]{border-bottom:3px solid Highlight;font-weight:700}
  ol.trace li.used .bullet{border:2px solid Highlight;background:Canvas;color:CanvasText}
  .meter .bars i{border-color:CanvasText}.meter .bars i.on{background:CanvasText}
  .dot{border:1px solid CanvasText}
}
@media(max-width:760px){main{padding:12px 14px 48px}.grid,.master-detail{grid-template-columns:1fr}.listbox{max-height:260px}.optional{display:none}input[type=search]{min-width:0;flex:1}.col-provider{width:30%}.col-status{width:24%}}
@media(max-width:560px){ol.trace li{grid-template-columns:20px minmax(0,1fr)}ol.trace li>span:last-child{grid-column:2}.depends{grid-template-columns:1fr}}
@media(max-width:480px){dl{grid-template-columns:1fr;gap:0}dd{margin-bottom:6px}}
`;
