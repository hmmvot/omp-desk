/**
 * The frame document of a reply's HTML page (docs/decisions/0079-*): the constant page a loopback listener serves
 * (`host/html-page-server.ts`) and the Chat embeds as `<iframe sandbox="allow-scripts" src>` (`webview/components/HtmlPageBlock.tsx`).
 *
 * The document is the same bytes for every page and holds no model text. Its Content-Security-Policy arrives as a response header,
 * so the policy is the document's own and nothing is inherited from the Chat: scripts are only the one bootstrap below (by hash)
 * plus `eval` (`'unsafe-eval'`), no source is named for any request, no frame, form or navigation target exists. The model's page
 * is delivered afterwards by `postMessage` from the Chat window and rebuilt here: its scripts are run with indirect `eval`, its
 * `on…=` attributes become listeners made with `new Function`. There is no nonce anywhere, so nothing a page can read lets it
 * load a script, a stylesheet or an image from anywhere.
 *
 * Messages (key {@link HTML_PAGE_CHANNEL}):
 * - frame → parent: `{ready}` once the bootstrap listens, `{size,height}` after layout changes.
 * - parent → frame: `{page,html,dark,variables}` once (the page to show), `{theme,dark,variables}` any time. The frame takes a message
 *   only when `event.source` is its parent window.
 */

/** The key of every message between the Chat and its frame. */
export const HTML_PAGE_CHANNEL = "ompHtmlPage";
/** The one path the frame server answers. */
export const HTML_PAGE_FRAME_PATH = "/page";
/** The `<meta name>` of a Chat document that carries the frame's URL; absent when this window has no page server. */
export const HTML_PAGE_FRAME_META = "omp-html-page-frame";

const MAX_HANDLERS = 2000;

/**
 * The bootstrap the frame runs. Plain text, no template holes: its hash is part of the policy the server sends, so the served text
 * and the hashed text are one string.
 */
export const HTML_PAGE_BOOTSTRAP = `(function(){
"use strict";
var CHANNEL=${JSON.stringify(HTML_PAGE_CHANNEL)},MAX_HANDLERS=${MAX_HANDLERS},SAFE=/^[#A-Za-z0-9 ,.'_()%-]{1,200}$/,NAME=/^--[a-z0-9-]{1,40}$/;
var WINDOW_EVENTS={load:1,resize:1,scroll:1,blur:1,focus:1,message:1,hashchange:1,popstate:1,pageshow:1,pagehide:1,beforeunload:1,unload:1,error:1,online:1,offline:1};
var parentWindow=parent,run=eval,started=false;
["RTCPeerConnection","webkitRTCPeerConnection","RTCSessionDescription","RTCIceCandidate"].forEach(function(name){try{Object.defineProperty(window,name,{value:undefined,configurable:false,writable:false})}catch(error){}});
function post(message){try{parentWindow.postMessage(message,"*")}catch(error){}}
function applyTheme(theme){
	var root=document.documentElement;
	if(theme.variables&&typeof theme.variables==="object"){
		for(var name in theme.variables){
			var value=theme.variables[name];
			if(NAME.test(name)&&typeof value==="string"&&SAFE.test(value))root.style.setProperty(name,value);
		}
	}
	if(typeof theme.dark==="boolean")root.style.setProperty("color-scheme",theme.dark?"dark":"light");
}
function carry(from,to){
	for(var n=0;n<from.attributes.length;n++){
		var one=from.attributes[n];
		if(/^on/i.test(one.name))continue;
		if(one.name==="class")to.className=(to.className?to.className+" ":"")+one.value;
		else to.setAttribute(one.name,one.value);
	}
}
var CLASSIC=/^(?:|text\\/javascript|application\\/javascript|text\\/ecmascript|application\\/ecmascript)$/i;
function show(html){
	var parsed=new DOMParser().parseFromString(html,"text/html");
	var handlers=[],scripts=[];
	var all=parsed.querySelectorAll("*");
	for(var i=0;i<all.length;i++){
		var element=all[i],attributes=element.attributes;
		for(var j=attributes.length-1;j>=0;j--){
			var attribute=attributes[j];
			if(/^on/i.test(attribute.name)){
				if(handlers.length<MAX_HANDLERS)handlers.push({element:element,type:attribute.name.slice(2).toLowerCase(),code:attribute.value});
				element.removeAttribute(attribute.name);
			}
		}
	}
	var removable=parsed.querySelectorAll("base,meta[http-equiv]");
	for(var k=0;k<removable.length;k++)removable[k].remove();
	var found=parsed.querySelectorAll("script");
	for(var s=0;s<found.length;s++){
		var script=found[s];
		if(!script.hasAttribute("src")&&CLASSIC.test((script.getAttribute("type")||"").trim()))scripts.push(script.textContent||"");
		if(CLASSIC.test((script.getAttribute("type")||"").trim()))script.remove();
	}
	carry(parsed.documentElement,document.documentElement);
	carry(parsed.body,document.body);
	if(parsed.title)document.title=parsed.title;
	while(parsed.head.firstChild)document.head.appendChild(parsed.head.firstChild);
	while(parsed.body.firstChild)document.body.appendChild(parsed.body.firstChild);
	handlers.forEach(function(handler){
		var compiled;
		try{compiled=new Function("event",handler.code)}catch(error){console.error(error);return}
		var onWindow=Object.prototype.hasOwnProperty.call(WINDOW_EVENTS,handler.type)&&(handler.element===parsed.body||handler.element===parsed.documentElement);
		(onWindow?window:handler.element).addEventListener(handler.type,function(event){
			var result=compiled.call(this,event);
			if(result===false)event.preventDefault();
		});
	});
	document.addEventListener("click",function(event){
		var target=event.target,link=target&&target.closest?target.closest("a[href]"):null;
		if(link&&link.getAttribute("href").charAt(0)!=="#")event.preventDefault();
	},true);
	scripts.forEach(function(code){try{run(code)}catch(error){console.error(error)}});
	document.dispatchEvent(new Event("DOMContentLoaded",{bubbles:true}));
	window.dispatchEvent(new Event("load"));
}
addEventListener("message",function(event){
	var data=event.data;
	if(event.source!==parentWindow||!data||typeof data!=="object")return;
	if(data[CHANNEL]==="theme"){applyTheme(data);return}
	if(data[CHANNEL]==="page"&&!started&&typeof data.html==="string"){
		started=true;
		applyTheme(data);
		try{show(data.html)}catch(error){document.body.textContent="This page could not be shown."}
	}
});
var pending=false,last=-1;
function measure(){
	pending=false;
	var height=Math.ceil(document.documentElement.getBoundingClientRect().height);
	if(height!==last){last=height;post({[CHANNEL]:"size",height:height})}
}
function schedule(){if(!pending){pending=true;requestAnimationFrame(measure)}}
if(typeof ResizeObserver==="function"){var observer=new ResizeObserver(schedule);observer.observe(document.documentElement);observer.observe(document.body)}
post({[CHANNEL]:"ready"});
})();`;

/** The frame's document. `HTML_PAGE_BOOTSTRAP` is its only script. */
export function htmlPageFrameDocument(): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title></title><style>@layer omp-page{body{margin:8px;color:var(--fg);background:var(--bg);font-family:var(--font);font-size:var(--font-size)}}</style></head><body><script>${HTML_PAGE_BOOTSTRAP}</script></body></html>`;
}

/**
 * The policy header of the frame document, for the base64 SHA-256 of {@link HTML_PAGE_BOOTSTRAP}. Everything is `'none'` unless
 * listed: no network request of any kind, no frame, worker, form or navigation; images, fonts and media only from `data:`/`blob:`
 * (values made in the page itself). `sandbox` repeats what the embedding `<iframe>` says, so the document is opaque-origin even
 * when opened some other way.
 */
export function htmlPageFramePolicy(bootstrapSha256: string): string {
	return [
		"default-src 'none'",
		`script-src 'sha256-${bootstrapSha256}' 'unsafe-eval'`,
		"style-src 'unsafe-inline'",
		"img-src data: blob:",
		"font-src data:",
		"media-src data: blob:",
		"connect-src 'none'",
		"frame-src 'none'",
		"child-src 'none'",
		"worker-src 'none'",
		"object-src 'none'",
		"manifest-src 'none'",
		"form-action 'none'",
		"base-uri 'none'",
		"sandbox allow-scripts",
	].join("; ");
}
