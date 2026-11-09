/* PROTOTYPE: Code mode as a full builder. Dark panels match today's Code mode stylesheet. */
const K={panel:"#121214",raised:"#1b1b1f",ed:"#0c0c0e",line:"#2a2a30",text:"#e4e4e7",muted:"#a1a1aa",dim:"#71717a",focus:"#fb923c",acc:"#a5b4fc",comp:"#a78bfa",loop:"#fbbf24",cond:"#60a5fa",sel:"#23214d",selLine:"#6366f1",warnBg:"#422006",warnTx:"#fde68a",tag:"#f9a8d4",attr:"#93c5fd",str:"#86efac",val:"#fcd34d",prop:"#c4b5fd"};
const MONO="Roboto Mono";
function dfr(p,name,o={}){return fr(p,name,{fill:K.panel,...o});}
function dt(p,c,o={}){return tx(p,c,{fill:K.text,...o});}
function mono(p,c,o={}){return tx(p,c,{fontFamily:MONO,fontSize:12,fill:K.text,...o});}
function dic(p,icon,o={}){return ic(p,icon,{width:14,height:14,fill:K.muted,...o});}
function dline(p,o={}){return fr(p,"Line",{width:o.v?1:"fill_container",height:o.v?"fill_container":1,fill:K.line});}

/* Edit bar with the Code mode switch on */
function cmChrome(col,row,name,o={}){dedupe(name);const r=screen(name,col*1540,row*1100,{layout:"vertical",h:900});
 const bar=fr(r,"Edit bar",{width:"fill_container",height:48,padding:[0,10],gap:4,alignItems:"center",fill:DK});
 const lg=fr(bar,"Logo",{width:28,height:28,cornerRadius:7,fill:DKF,alignItems:"center",justifyContent:"center"});tx(lg,"W",{fontWeight:"700",fill:DK});
 dbtn(bar,null,"Acme Bakery",{muted:true});tx(bar,"/",{fill:DKL,fontSize:16});dbtn(bar,"file-text","Home",{caret:true});
 const st=fr(bar,"Status",{padding:[3,9],cornerRadius:999,fill:"#3B2A06"});tx(st,"Draft · 3 changes",{fontSize:12,fontWeight:"500",fill:"#FBBF24"});
 sp(bar);const seg=fr(bar,"Mode",{padding:3,gap:2,cornerRadius:8,fill:"#27272A"});const M={Edit:"pencil",Code:"code-xml",Preview:"eye"};for(const m of ["Edit","Code","Preview"])dbtn(seg,M[m],m,{on:m=="Code",muted:m!="Code"});
 dsep(bar);dbtn(bar,"monitor",null,{on:true});dbtn(bar,"tablet",null,{muted:true});dbtn(bar,"smartphone",null,{muted:true});
 sp(bar);if(o.cmdk!==false){const k=fr(bar,"Command menu",{height:30,padding:[0,10],gap:8,cornerRadius:6,fill:"#27272A",alignItems:"center"});ic(k,"search",{width:14,height:14,fill:DKM});tx(k,"Find or do anything",{fontSize:12,fill:DKM});tx(k,"⌘K",{fontSize:11,fill:DKM,fontFamily:MONO});}
 dbtn(bar,"undo-2",null,{muted:true});dbtn(bar,"redo-2",null,{muted:true});
 dbtn(bar,"upload","Publish",{primary:true,caret:true});avatar(bar,"GR",{size:28,fill:"#64748B"});
 const body=fr(r,"Body",{width:"fill_container",height:"fill_container",layout:o.vertical?"vertical":"horizontal",fill:K.panel});return {r,bar,body};}

/* the live page, clipped into a box, with the selected element outlined */
function pageBox(p,w,h,o={}){const vp=fr(p,"Page viewport",{layout:"none",width:w,height:h,clip:true,fill:C.cream});
 const E=layoutPage(vp,w,o.S||{},{scroll:o.scroll||0});return {vp,E};}
function outlineBox(vp,x,y,w,h,label,o={}){const col=o.color||K.selLine;const b=fr(vp,"Outline "+label,{layoutPosition:"absolute",x,y,width:w,height:h,stroke:col,strokeWidth:o.sw||2,cornerRadius:2,layout:"none",...(o.fill?{fill:o.fill}:{})});
 if(label){const c=fr(vp,"Label "+label,{layoutPosition:"absolute",x,y:y-22,height:22,padding:[0,7],gap:5,alignItems:"center",fill:col,cornerRadius:[4,4,0,0]});if(o.icon)ic(c,o.icon,{width:11,height:11,fill:"#FFFFFF"});tx(c,label,{fontSize:11,fontWeight:"600",fill:"#FFFFFF",fontFamily:o.mono?MONO:F});}return b;}

/* panel head inside a dark panel */
function dhead(p,title,o={}){const h=fr(p,"Head "+title,{width:"fill_container",height:36,padding:[0,10],gap:8,alignItems:"center",stroke:K.line,strokeWidth:{bottom:1}});if(o.icon)dic(h,o.icon,{fill:K.text});dt(h,title,{fontWeight:"700"});if(o.sub)dt(h,o.sub,{fill:K.muted});sp(h);for(const t of (o.tools||[]))dic(h,t);return h;}
function dseg(p,items,active){const s=fr(p,"Segments",{padding:2,gap:2,cornerRadius:6,fill:K.ed});for(const it of items){const a=it==active;const b=fr(s,"Seg "+it,{height:22,padding:[0,8],cornerRadius:4,alignItems:"center",...(a?{fill:K.raised,stroke:K.line,strokeWidth:1}:{})});dt(b,it,{fontSize:12,fontWeight:"500",fill:a?K.text:K.muted});}return s;}

/* one layers-tree row.
   kind: el | place | loop | cond | outlet | text | value | src (a "comes from" divider)
   o: d depth, label, meta, exp(true/false/undefined), sel, hover, faded, locked, pages, else */
const KIND={place:["component",K.comp],loop:["repeat",K.loop],cond:["git-branch",K.cond],outlet:["square-dashed-bottom",K.muted],text:["type",K.dim],value:["braces",K.prop],el:["code",K.dim]};
function trow(p,kind,o={}){
 if(kind=="src"){const s=fr(p,"From "+o.label,{width:"fill_container",height:24,padding:[0,10,0,8+(o.d||0)*14],gap:6,alignItems:"center"});dic(s,o.icon||"file-code-2",{width:12,height:12,fill:K.dim});dt(s,o.label.toUpperCase(),{fontSize:10,fontWeight:"700",fill:K.dim,letterSpacing:0.8});if(o.note){sp(s);dt(s,o.note,{fontSize:10,fill:K.dim});}return s;}
 const r=fr(p,"Row "+o.label,{width:"fill_container",height:26,padding:[0,8,0,6+(o.d||0)*14],gap:6,alignItems:"center",...(o.sel?{fill:K.sel,stroke:K.selLine,strokeWidth:{left:2}}:o.hover?{fill:K.raised}:{}),...(o.faded?{opacity:0.5}:{})});
 if(o.exp===undefined)fr(r,"No chevron",{width:12,height:12});else dic(r,o.exp?"chevron-down":"chevron-right",{width:12,height:12});
 const k=KIND[kind];dic(r,k[0],{width:13,height:13,fill:k[1]});
 if(kind=="el"&&!o.label.includes(" "))mono(r,o.label,{fill:K.tag});else dt(r,o.label,{fontWeight:kind=="place"?"600":"500",fill:kind=="place"?K.text:(kind=="text"?K.muted:K.text)});
 if(o.meta)mono(r,o.meta,{fontSize:11,fill:K.dim});sp(r);
 if(o.pages){const b=fr(r,"Used",{padding:[1,6],cornerRadius:999,fill:K.warnBg});dt(b,o.pages,{fontSize:10,fontWeight:"600",fill:K.warnTx});}
 if(o.repeat){const b=fr(r,"Repeats",{padding:[1,6],cornerRadius:999,fill:"#3a2a05"});dt(b,o.repeat,{fontSize:10,fontWeight:"600",fill:K.loop});}
 if(o.faded)dic(r,"eye-off",{width:12,height:12});if(o.locked)dic(r,"lock",{width:12,height:12});
 if(o.hover){if(kind=="place")dic(r,"eye",{width:12,height:12});dic(r,"copy-plus",{width:12,height:12});dic(r,"trash-2",{width:12,height:12});}
 return r;}

/* the Home page tree, with the quote's blockquote selected */
function homeTree(p,o={}){const sel=o.sel||"blockquote";const S=k=>sel==k;
 trow(p,"src",{label:"Page template · Main",note:"Structure"});
 trow(p,"el",{d:0,label:"header",meta:".site-header",exp:false,hover:o.hoverHeader});
 trow(p,"el",{d:0,label:"main",meta:".page",exp:true});
 trow(p,"outlet",{d:1,label:"Page layout",meta:"{{@outlet}}",exp:true});
 trow(p,"src",{d:1,label:"Page layout · Home",icon:"layers"});
 trow(p,"place",{d:2,label:"Hero split",exp:false,locked:o.locked});
 trow(p,"place",{d:2,label:"Product grid",exp:false});
 trow(p,"place",{d:2,label:"Customer quote",exp:true,pages:"4 pages",sel:S("quote")});
 trow(p,"src",{d:3,label:"Component · Customer quote",icon:"component"});
 trow(p,"el",{d:3,label:"section",meta:".quote",exp:true});
 trow(p,"el",{d:4,label:"blockquote",meta:".quote__text",exp:true,sel:S("blockquote")});
 trow(p,"value",{d:5,label:"props.quote"});
 trow(p,"el",{d:4,label:"figure",meta:".quote__person",exp:true});
 trow(p,"cond",{d:5,label:"If props.photo",exp:false});
 trow(p,"el",{d:5,label:"cite",meta:".quote__name",exp:false});
 trow(p,"place",{d:2,label:"Latest posts",exp:true});
 trow(p,"loop",{d:3,label:"Loop posts",meta:"limit 3",exp:false,repeat:"×3"});
 trow(p,"place",{d:2,label:"Call to action",exp:false,faded:true});
 trow(p,"el",{d:0,label:"footer",meta:".site-footer",exp:false});}

/* code editor with a gutter. lines: [text, colour?, highlighted?] */
function editor(p,lines,o={}){const e=fr(p,"Editor",{layout:"vertical",width:"fill_container",height:"fill_container",fill:K.ed,padding:[8,0],clip:true});
 lines.forEach((l,i)=>{const [t,c,hl]=Array.isArray(l)?l:[l];const row=fr(e,"L"+(i+1),{width:"fill_container",height:19,gap:10,padding:[0,10,0,0],alignItems:"center",...(hl?{fill:hl===true?K.sel:hl}:{})});
  mono(row,String(i+1+(o.start||0)),{fill:K.dim,width:30,textAlign:"right",textGrowth:"fixed-width",fontSize:11});mono(row,t,{fill:c||K.text});});return e;}
function codePanel(p,title,o={}){const c=fr(p,"Panel "+title,{layout:"vertical",width:o.w||"fill_container",height:"fill_container",stroke:K.line,strokeWidth:{right:1}});
 const h=fr(c,"Head",{width:"fill_container",height:36,padding:[0,10],gap:8,alignItems:"center",stroke:K.line,strokeWidth:{bottom:1}});dt(h,title,{fontWeight:"700"});if(o.sub)dt(h,o.sub,{fill:K.muted});sp(h);if(o.seg)dseg(h,o.seg[0],o.seg[1]);for(const t of (o.tools||[]))dic(h,t);
 if(o.strip)o.strip(c);editor(c,o.lines,o);return c;}

/* the quote Component's markup and CSS */
const QHTML=[["<section class=\"quote\">",K.tag],["  <span class=\"quote__mark\">“</span>",K.tag],["  <blockquote class=\"quote__text\">",K.tag,true],["    {{ props.quote }}",K.prop,true],["  </blockquote>",K.tag,true],["  <figure class=\"quote__person\">",K.tag],["    {{@if props.photo}}",K.cond],["      <img src=\"{{ props.photo }}\" alt=\"\">",K.tag],["    {{/if}}",K.cond],["    <cite class=\"quote__name\">{{ props.name }}</cite>",K.tag],["  </figure>",K.tag],["</section>",K.tag]];
const QCSS=[[".quote__text {",K.attr],["  font-family: var(--font-display);",K.text],["  font-size: var(--step-3);",K.text],["  line-height: 1.3;",K.text],["  text-align: center;",K.text],["  max-inline-size: 32ch;",K.text],["  margin-inline: auto;",K.text],["}",K.attr]];
const QJS=[["// Page script · Home",K.dim],["const quote = document.querySelector(",K.text],["  \".quote__text\");",K.str],["quote?.addEventListener(\"click\", () => {",K.text],["  quote.classList.toggle(\"is-open\");",K.text],["});",K.text]];

/* Code mode's breadcrumb line, as today */
function crumbLine(p,o={}){const t=fr(p,"Top line",{width:"fill_container",height:36,padding:[0,10],gap:6,alignItems:"center",stroke:K.line,strokeWidth:{bottom:1},fill:K.panel});
 const b=fr(t,"Badge",{padding:[1,8],cornerRadius:999,stroke:"#52525b",strokeWidth:1});dt(b,"Code mode",{fontSize:11});
 const cs=o.crumbs||["main","Customer quote","section.quote","blockquote.quote__text"];const last=cs.length-1;for(const [i,c] of cs.entries()){if(i)dt(t,"›",{fill:K.dim});(c.includes(".")||c=="main"?mono:dt)(t,c,{fontSize:12,fill:i==last?K.text:K.muted,fontWeight:i==last?"700":"500"});}
 sp(t);if(o.usage!==false){const u=fr(t,"Usage",{padding:[3,9],gap:6,cornerRadius:6,fill:K.warnBg,alignItems:"center"});ic(u,"triangle-alert",{width:12,height:12,fill:K.warnTx});dt(u,"On 4 pages · edits change all",{fontSize:12,fill:K.warnTx});}
 if(o.tools)o.tools(t);dic(t,"chevron-down");return t;}

/* element settings box. kind: el | place */
function dfield(p,label,o={}){const g=fr(p,"Field "+label,{layout:"vertical",gap:5,width:"fill_container"});const h=fr(g,"Label",{width:"fill_container",gap:6,alignItems:"center"});dt(h,label,{fontSize:12,fontWeight:"600",fill:K.muted});if(o.hint){sp(h);dt(h,o.hint,{fontSize:11,fill:K.dim});}return g;}
function dinput(p,val,o={}){const i=fr(p,"Input",{width:"fill_container",height:30,padding:[0,9],gap:6,cornerRadius:6,fill:K.ed,stroke:o.focus?K.focus:K.line,strokeWidth:1,alignItems:"center"});(o.mono?mono:dt)(i,val,{fill:o.ph?K.dim:K.text});if(o.caret){sp(i);dic(i,"chevron-down",{width:12,height:12});}return i;}
function classChip(p,name,o={}){const c=fr(p,"Class "+name,{height:24,padding:[0,8],gap:5,cornerRadius:5,fill:o.on?"#1e1b4b":K.raised,stroke:o.on?K.selLine:K.line,strokeWidth:1,alignItems:"center"});mono(c,"."+name,{fontSize:11,fill:o.on?K.acc:K.text});if(o.x)dic(c,"x",{width:10,height:10});return c;}
function settingsBox(p,o={}){const b=fr(p,"Element settings",{layout:"vertical",width:"fill_container",padding:12,gap:14});
 if(o.kind=="place"){const h=fr(b,"Placement",{width:"fill_container",gap:8,alignItems:"center"});dic(h,"component",{fill:K.comp});dt(h,"Customer quote",{fontWeight:"700"});sp(h);dt(h,"Placement",{fontSize:11,fill:K.dim});
  dt(b,"Prop values for this Placement only. To change its markup, open the Component.",{fontSize:12,fill:K.muted,textGrowth:"fixed-width",width:"fill_container",lineHeight:1.4});
  dinput(dfield(b,"Quote",{hint:"props.quote"}),"The cardamom buns are the reason…");dinput(dfield(b,"Name",{hint:"props.name"}),"Aoife Murphy");dinput(dfield(b,"Photo",{hint:"props.photo"}),"aoife.jpg",{caret:true});
  const a=fr(b,"Open",{width:"fill_container",height:30,cornerRadius:6,stroke:K.line,strokeWidth:1,alignItems:"center",justifyContent:"center",gap:6});dic(a,"square-pen",{fill:K.text});dt(a,"Edit the Component",{fontWeight:"600"});return b;}
 const row=fr(b,"Tag and label",{width:"fill_container",gap:8});const t=dfield(row,"Tag");t.width=110;dinput(t,"blockquote",{mono:true,caret:true});dinput(dfield(row,"Layer label",{hint:"tree only"}),"Quote text",{ph:false});
 const cl=dfield(b,"Classes",{hint:"CSS edits the chosen one"});const cr=fr(cl,"Chips",{width:"fill_container",gap:6,alignItems:"center"});classChip(cr,"quote__text",{on:true,x:true});classChip(cr,"is-large",{x:true});const add=fr(cr,"Add class",{height:24,padding:[0,7],gap:4,cornerRadius:5,stroke:K.line,strokeWidth:1,alignItems:"center"});dic(add,"plus",{width:11,height:11});dt(add,"Class",{fontSize:11,fill:K.muted});
 const at=dfield(b,"Attributes");for(const [n,v] of [["cite","{{ props.source }}"],["lang","ga"]]){const r=fr(at,"Attr "+n,{width:"fill_container",gap:6});const a=dinput(r,n,{mono:true});a.width=90;dinput(r,v,{mono:true});dic(r,"x",{width:12,height:12});}
 const aa=fr(at,"Add attribute",{gap:5,alignItems:"center",padding:[2,0]});dic(aa,"plus",{width:12,height:12});dt(aa,"Add attribute",{fontSize:12,fill:K.muted});
 if(o.more!==false){const m=fr(b,"From",{width:"fill_container",padding:[8,10],gap:8,cornerRadius:6,fill:K.raised,alignItems:"center"});dic(m,"component",{fill:K.comp});dt(m,"Inside the Customer quote Component",{fontSize:12,fill:K.muted});}
 return b;}

/* insert toolbar: where, then the common elements, then everything */
function insertBar(p,o={}){const t=fr(p,"Insert toolbar",{width:o.w||"fill_container",height:o.h||38,padding:[0,8],gap:2,alignItems:"center",...(o.x!==undefined?{layoutPosition:"absolute",x:o.x,y:o.y}:{}),...(o.float?{fill:K.raised,cornerRadius:9,stroke:K.line,strokeWidth:1,effect:{type:"shadow",offset:{x:0,y:8},blur:24,color:"#00000060"}}:{stroke:K.line,strokeWidth:{bottom:1}}),...(o.vertical?{layout:"vertical",width:38,height:"fit_content",padding:[6,0]}:{})});
 if(!o.vertical){dic(t,"plus",{fill:K.text});if(o.where!==false)dseg(t,["Inside","After"],o.where||"After");fr(t,"Gap",{width:4,height:1});}
 for(const [icon,label] of (o.items||[["heading","Heading"],["pilcrow","Paragraph"],["image","Image"],["link","Link"],["list","List"],["box","Div"],["repeat","Loop"],["git-branch","Condition"],["component","Component"]])){const b=fr(t,"Insert "+label,{width:28,height:28,cornerRadius:6,alignItems:"center",justifyContent:"center",...(o.on==label?{fill:K.sel,stroke:K.selLine,strokeWidth:1}:{})});dic(b,icon,{fill:icon=="repeat"?K.loop:icon=="git-branch"?K.cond:icon=="component"?K.comp:K.text});}
 if(!o.vertical){const m=fr(t,"More",{height:28,padding:[0,8],gap:4,cornerRadius:6,alignItems:"center"});dt(m,"More",{fontSize:12,fill:K.muted});dic(m,"chevron-down",{width:12,height:12});}
 return t;}

/* numbered callouts under a screen */
function notes(r,items){const n=fr(r,"Notes",{width:"fill_container",padding:[12,16],gap:16,fill:"#09090b",stroke:K.line,strokeWidth:{top:1}});items.forEach((it,i)=>{const c=fr(n,"Note "+(i+1),{width:"fill_container",gap:8});const d=fr(c,"Num",{width:20,height:20,cornerRadius:99,fill:K.focus,alignItems:"center",justifyContent:"center"});tx(d,String(i+1),{fontSize:11,fontWeight:"700",fill:"#09090b"});const tt=fr(c,"T",{layout:"vertical",gap:2,width:"fill_container"});dt(tt,it[0],{fontWeight:"700",fontSize:12});dt(tt,it[1],{fontSize:11,fill:K.muted,textGrowth:"fixed-width",width:"fill_container",lineHeight:1.4});});return n;}

/* layout A, shared by the detail screens */
function aLayout(col,row,name,o={}){const {r,body}=cmChrome(col,row,name,{});r.height=1010;
 const L=dfr(body,"Left · Layers",{layout:"vertical",width:280,height:"fill_container",stroke:K.line,strokeWidth:{right:1}});
 dhead(L,"Layers",{icon:"layers",tools:["search","chevrons-down-up"]});insertBar(L,{where:o.where||"After",on:o.insOn,items:[["heading","Heading"],["pilcrow","Paragraph"],["image","Image"],["repeat","Loop"],["component","Component"]],w:"fill_container"});
 const T=fr(L,"Tree",{layout:"vertical",width:"fill_container",padding:[6,0]});(o.tree||homeTree)(T,o);
 const M=fr(body,"Middle",{layout:"vertical",width:"fill_container",height:"fill_container"});crumbLine(M,{usage:o.usage,crumbs:o.crumbs});
 const {vp,E}=pageBox(M,860,520,{S:o.S||{quote:"sel"},scroll:790});
 const D=fr(M,"Code dock",{width:"fill_container",height:"fill_container",fill:K.panel,stroke:K.line,strokeWidth:{top:1}});
 codePanel(D,"HTML",{sub:"Customer quote",tools:["wand-sparkles","save"],lines:o.html||QHTML});codePanel(D,"CSS",{seg:[["Class","Site"],o.cssSeg||"Class"],tools:["save"],lines:o.css||QCSS});codePanel(D,"JS",{seg:[["Page","Site"],"Page"],tools:["save"],lines:QJS});
 const RC=dfr(body,"Right · Element",{layout:"vertical",width:300,height:"fill_container",stroke:K.line,strokeWidth:{left:1}});
 dhead(RC,"Element",{icon:"sliders-horizontal"});settingsBox(RC,{kind:o.kind});return {r,vp,L,M,D,RC};}
