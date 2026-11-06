const ids=[];const W=1440,MONO="Geist Mono";
function barA(r,o={}){const bar=fr(r,"Edit bar",{width:"fill_container",height:48,padding:[0,10],gap:4,alignItems:"center",fill:DK});
 const lg=fr(bar,"Logo",{width:28,height:28,cornerRadius:7,fill:DKF,alignItems:"center",justifyContent:"center"});tx(lg,"W",{fontWeight:"700",fill:DK});
 dbtn(bar,null,"Acme Bakery",{muted:true});tx(bar,"/",{fill:DKL,fontSize:16});dbtn(bar,"file-text","Home",{caret:true});
 const st=fr(bar,"Status",{padding:[3,9],cornerRadius:999,fill:"#3B2A06"});tx(st,"Draft · 4 changes",{fontSize:12,fontWeight:"500",fill:"#FBBF24"});tx(bar,"  Saved to Draft · just now",{fontSize:12,fill:DKM});
 sp(bar);const seg=fr(bar,"Mode",{padding:3,gap:2,cornerRadius:8,fill:"#27272A"});dbtn(seg,"pencil","Edit");dbtn(seg,"eye","Preview",{muted:true});dbtn(seg,"code-xml","Code",{on:true});
 dsep(bar);dbtn(bar,"monitor",null,{on:true});dbtn(bar,"tablet",null,{muted:true});dbtn(bar,"smartphone",null,{muted:true});
 sp(bar);dbtn(bar,"languages","EN",{caret:true});dbtn(bar,"panel-right","Page details");dbtn(bar,"layout-dashboard",null,{muted:true});dbtn(bar,"upload","Publish",{primary:true,caret:true});avatar(bar,"DD",{size:28,fill:"#0EA5E9"});return bar;}
function codeLines(p,lines,hl){const b=fr(p,"Code",{layout:"vertical",width:"fill_container",height:"fill_container",padding:[10,0],gap:0,fill:"#0F0F12",clip:true});
 lines.forEach((l,i)=>{const on=hl&&hl.includes(i);const r=fr(b,"Line "+(i+1),{width:"fill_container",height:21,gap:14,alignItems:"center",padding:[0,12],...(on?{fill:"#4F46E52E",stroke:BR,strokeWidth:{left:2}}:{})});tx(r,String(i+1),{fontFamily:MONO,fontSize:12,fill:"#52525B",width:18,textGrowth:"fixed-width",textAlign:"right"});
  const segs=Array.isArray(l)?l:[[l,"#E4E4E7"]];const lr=fr(r,"Src",{gap:0});for(const [t,c] of segs)tx(lr,t,{fontFamily:MONO,fontSize:12.5,fill:c});});return b;}
const TG="#F472B6",AT="#A5B4FC",STR="#86EFAC",PL="#E4E4E7",CM="#71717A",PR="#7DD3FC",VA="#FCD34D";
function panel(row,title,icon,sub,lines,hl,o={}){const p=fr(row,"Panel "+title,{layout:"vertical",width:"fill_container",height:"fill_container",fill:"#0F0F12",stroke:DKL,strokeWidth:{left:o.first?0:1}});
 const h=fr(p,"Head",{width:"fill_container",height:36,padding:[0,10],gap:8,alignItems:"center",fill:"#18181B",stroke:DKL,strokeWidth:{bottom:1}});ic(h,icon,{width:14,height:14,fill:DKF});tx(h,title,{fontWeight:"600",fill:DKF,fontSize:12});tx(h,sub,{fontSize:12,fill:DKM});sp(h);if(o.scope){const s=fr(h,"Scope",{padding:2,gap:2,cornerRadius:6,fill:"#27272A"});for(const [l,on] of o.scope){const b=fr(s,"S "+l,{padding:[2,8],cornerRadius:4,...(on?{fill:"#3F3F46"}:{})});tx(b,l,{fontSize:11,fill:on?DKF:DKM,fontWeight:"500"});}}ic(h,"maximize-2",{width:13,height:13,fill:DKM});
 codeLines(p,lines,hl);return p;}
/* 8 Code mode */
{const r=screen("A · Top bar · 8 Code mode (Staff)",7*1540,0,{layout:"vertical"});ids.push(r);barA(r);
 const vp=fr(r,"Viewport",{layout:"none",width:W,height:470,clip:true,fill:C.cream});const E=sitePage(vp,W,"en",{h1:"sel"},{labels:{h1:"h1.hero__title · Hero (Component)"}});
 const dock=fr(r,"Code dock",{layout:"vertical",width:"fill_container",height:"fill_container",fill:DK,stroke:DKL,strokeWidth:{top:1}});
 const cr=fr(dock,"Path",{width:"fill_container",height:38,padding:[0,12],gap:8,alignItems:"center"});
 const sb=fr(cr,"Staff only",{padding:[2,8],cornerRadius:999,stroke:"#52525B",strokeWidth:1});tx(sb,"Staff only",{fontSize:11,fill:DKM,fontWeight:"500"});
 for(const [t,last] of [["Home",0],["Hero · Component",0],["div.hero__text",0],["h1.hero__title",1]]){tx(cr,t,{fontSize:12,fill:last?DKF:DKM,fontWeight:last?"600":"400",fontFamily:MONO});if(!last)ic(cr,"chevron-right",{width:12,height:12,fill:"#52525B"});}
 sp(cr);const w=fr(cr,"Warn",{gap:6,alignItems:"center",padding:[3,10],cornerRadius:6,fill:"#3B2A06"});ic(w,"triangle-alert",{width:13,height:13,fill:"#FBBF24"});tx(w,"Hero is used on 3 pages: changes apply to all of them",{fontSize:12,fill:"#FBBF24"});
 dbtn(cr,"panel-bottom-close",null,{muted:true});
 const row=fr(dock,"Panels",{width:"fill_container",height:"fill_container"});
 panel(row,"HTML","code-xml","Hero · Component",[
  [["<section ",TG],["class",AT],["=",PL],["\"hero\"",STR],[">",TG]],
  [["  <div ",TG],["class",AT],["=",PL],["\"hero__text\"",STR],[">",TG]],
  [["    <p ",TG],["class",AT],["=",PL],["\"hero__eyebrow\"",STR],[">",TG],["{eyebrow}",VA],["</p>",TG]],
  [["    <h1 ",TG],["class",AT],["=",PL],["\"hero__title\"",STR],[">",TG],["{headline}",VA],["</h1>",TG]],
  [["    <div ",TG],["class",AT],["=",PL],["\"hero__intro\"",STR],[">",TG],["{intro}",VA],["</div>",TG]],
  [["    <div ",TG],["class",AT],["=",PL],["\"hero__actions\"",STR],[">",TG]],
  [["      <a ",TG],["class",AT],["=",PL],["\"btn btn--primary\"",STR],[" href",AT],["=",PL],["\"{button1.url}\"",STR],[">",TG]],
  [["        {button1.label}",VA]],
  [["      </a>",TG]],
  [["    </div>",TG]],
  [["  </div>",TG]],
  [["  <img ",TG],["class",AT],["=",PL],["\"hero__image\"",STR],[" src",AT],["=",PL],["\"{image}\"",STR],[" />",TG]],
  [["</section>",TG]]],[3],{first:true});
 panel(row,"CSS","paintbrush",".hero__title",[
  [[".hero__title",PR],[" {",PL]],
  [["  font-family",AT],[": ",PL],["var(--font-display)",VA],[";",PL]],
  [["  font-size",AT],[": ",PL],["var(--text-5xl)",VA],[";",PL]],
  [["  line-height",AT],[": ",PL],["1.05",STR],[";",PL]],
  [["  letter-spacing",AT],[": ",PL],["-0.02em",STR],[";",PL]],
  [["  color",AT],[": ",PL],["var(--color-ink)",VA],[";",PL]],
  [["  text-wrap",AT],[": ",PL],["balance",STR],[";",PL]],
  [["}",PL]],
  [["",PL]],
  [["@media",TG],[" (width < 48rem) {",PL]],
  [["  .hero__title",PR],[" { ",PL],["font-size",AT],[": ",PL],["var(--text-4xl)",VA],["; }",PL]],
  [["}",PL]]],[2],{scope:[["Class",true],["Site CSS",false]]});
 panel(row,"JS","braces","Page script",[
  [["// Runs on this page only, after the page loads.",CM]],
  [["const",TG],[" hero ",PL],["=",PL],[" document",PR],[".",PL],["querySelector",PR],["(",PL],["\".hero\"",STR],[")",PL],[";",PL]],
  [["",PL]],
  [["const",TG],[" hour ",PL],["=",PL],[" new ",TG],["Date",PR],["().",PL],["getHours",PR],["()",PL],[";",PL]],
  [["if",TG],[" (hour ",PL],[">=",PL],[" 14",STR],[") {",PL]],
  [["  hero",PL],[".",PL],["dataset",PR],[".",PL],["orders ",PR],["=",PL],[" \"tomorrow\"",STR],[";",PL]],
  [["}",PL]]],null,{scope:[["Page",true],["Site",false]]});
 const ft=fr(dock,"Footer",{width:"fill_container",height:30,padding:[0,12],gap:14,alignItems:"center",stroke:DKL,strokeWidth:{top:1}});
 for(const [i,t] of [["circle-check","HTML valid"],["circle-check","CSS valid"],["git-branch","Saved to Draft · Hero Component"]]){const x=fr(ft,"S "+t,{gap:5,alignItems:"center"});ic(x,i,{width:12,height:12,fill:"#4ADE80"});tx(x,t,{fontSize:11,fill:DKM});}
 sp(ft);tx(ft,"Click any element on the page to open its code",{fontSize:11,fill:DKM});}
/* 9 Phone */
function phoneSite(vp,S={}){const pg=fr(vp,"Site page",{layout:"vertical",width:390,x:0,y:0,fill:C.cream});const E={};
 const nav=fr(pg,"Nav",{width:"fill_container",padding:[16,20],alignItems:"center",gap:8,stroke:C.line,strokeWidth:{bottom:1}});Insert(nav,{type:"ellipse",name:"Mark",width:22,height:22,fill:C.crust});stx(nav,"Acme Bakery",{fontFamily:SF,fontSize:19,fontWeight:"600"});sp(nav);ic(nav,"menu",{fill:C.ink,width:22,height:22});
 const h=fr(pg,"Hero",{layout:"vertical",width:"fill_container",padding:[24,20],gap:16});
 E.eyebrow=ed(h,"Eyebrow",S.eyebrow||"none",{width:"fit_content",label:"Eyebrow"});stx(E.eyebrow,"SPRING MENU 2027",{fontSize:12,fontWeight:"700",fill:C.crust,letterSpacing:1.3});
 E.h1=ed(h,"Headline",S.h1||"none",{label:"Headline · Text"});stx(E.h1,"Fresh from our ovens, every morning since 1987",{fontFamily:SF,fontSize:36,fontWeight:"600",lineHeight:1.06,textGrowth:"fixed-width",width:"fill_container"});
 E.intro=ed(h,"Intro",S.intro||"none",{label:"Intro · Rich text"});stx(E.intro,"Sourdough, pastries and celebration cakes, baked by hand on Harbour Street, Cork.",{fontSize:16,fill:C.soft,lineHeight:1.5,textGrowth:"fixed-width",width:"fill_container"});
 E.img=ed(h,"Image",S.img||"none",{label:"Hero image",pad:4});photo(E.img,"Hero","fill_container",220,0,{r:14});return E;}
function phone(r,x,title){const cap=fr(r,"Caption "+title,{layoutPosition:"absolute",x,y:24,width:390});tx(cap,title,{fontWeight:"600",fontSize:15});
 const f=fr(r,"Phone "+title,{layoutPosition:"absolute",x,y:60,width:390,height:800,cornerRadius:36,clip:true,stroke:"#27272A",strokeWidth:8,strokeAlignment:"outer",fill:C.cream,layout:"none"});return f;}
function phoneBar(f){const b=fr(f,"Edit bar",{layoutPosition:"absolute",x:0,y:0,width:390,height:92,padding:[44,12,0,12],gap:6,alignItems:"center",fill:DK});const lg=fr(b,"Logo",{width:26,height:26,cornerRadius:7,fill:DKF,alignItems:"center",justifyContent:"center"});tx(lg,"W",{fontWeight:"700",fill:DK});dbtn(b,null,"Home",{caret:true});const st=fr(b,"Status",{padding:[3,8],cornerRadius:999,fill:"#3B2A06"});tx(st,"Draft · 2",{fontSize:11,fontWeight:"500",fill:"#FBBF24"});sp(b);dbtn(b,"ellipsis",null);return b;}
{const r=screen("A · Top bar · 9 Phone",8*1540,0,{layout:"none",fill:"$canvas"});ids.push(r);
 {const f=phone(r,60,"Edit mode on");const vp=fr(f,"VP",{layout:"none",x:0,y:92,width:390,height:708,clip:true});phoneSite(vp,{h1:"hover",eyebrow:"hint",intro:"hint",img:"hint"});phoneBar(f);
  const hn=pop(f,"Hint",{x:16,y:800-150,w:358,pad:14,gap:6,dark:true,r:14});tx(hn,"Tap outlined text or images to change them.",{fill:DKF,fontWeight:"600"});tx(hn,"Changes save to the Draft as you go.",{fill:DKM});}
 {const f=phone(r,525,"Editing text");const vp=fr(f,"VP",{layout:"none",x:0,y:92,width:390,height:708,clip:true});phoneSite(vp,{intro:"sel"});phoneBar(f);
  const kb=fr(f,"Keyboard",{layoutPosition:"absolute",x:0,y:800-290,width:390,height:290,layout:"vertical",fill:"#D1D3D9"});
  const tb=fr(kb,"Toolbar",{width:"fill_container",height:46,padding:[0,8],gap:2,alignItems:"center",fill:DK});for(const i of ["bold","italic","link","list"])dbtn(tb,i,null,{on:i=="bold"});sp(tb);dbtn(tb,null,"Done",{primary:true});
  for(const row of ["qwertyuiop","asdfghjkl","zxcvbnm"]){const kr=fr(kb,"Row",{width:"fill_container",padding:[8,4,0,4],gap:6,justifyContent:"center"});for(const k of row){const key=fr(kr,"Key",{width:32,height:42,cornerRadius:5,fill:"#FFFFFF",alignItems:"center",justifyContent:"center"});tx(key,k,{fontSize:18,fill:"#09090B"});}}}
 {const f=phone(r,990,"Menu: language, details, publish");const vp=fr(f,"VP",{layout:"none",x:0,y:92,width:390,height:708,clip:true});phoneSite(vp,{});phoneBar(f);
  fr(f,"Scrim",{layoutPosition:"absolute",x:0,y:0,width:390,height:800,fill:"#00000059"});
  const sh=fr(f,"Sheet",{layoutPosition:"absolute",x:0,y:800-470,width:390,height:470,layout:"vertical",fill:"$bg",cornerRadius:[20,20,0,0],padding:[10,16,24,16],gap:4});
  const gr=fr(sh,"Grab",{width:"fill_container",justifyContent:"center",padding:[0,0,8,0]});fr(gr,"Handle",{width:40,height:5,cornerRadius:999,fill:"$border"});
  for(const [i,l,v] of [["eye","Preview",""],["languages","Language","English"],["sliders-horizontal","Page details",""],["monitor","Open in admin",""]]){const row=fr(sh,"Item "+l,{width:"fill_container",height:48,gap:12,alignItems:"center",padding:[0,4],stroke:"$border",strokeWidth:{bottom:1}});ic(row,i,{fill:"$fg",width:18,height:18});tx(row,l,{fontSize:15,fontWeight:"500"});sp(row);if(v)tx(row,v,{fill:"$muted-fg"});ic(row,"chevron-right",{width:16,height:16});}
  const ch=fr(sh,"Changes",{layout:"vertical",width:"fill_container",padding:[14,4,6,4],gap:4});tx(ch,"2 changes on this page",{fontWeight:"600"});tx(ch,"Intro · Hero image",{fill:"$muted-fg"});
  const pb=fr(sh,"Publish",{width:"fill_container",height:46,cornerRadius:10,fill:"$primary",alignItems:"center",justifyContent:"center",gap:8});ic(pb,"upload",{fill:"$primary-fg"});tx(pb,"Publish page",{fontSize:15,fontWeight:"600",fill:"$primary-fg"});}}
Export(ids,"png","/tmp/penproto-ie/out/A2");Print("A2 done",ids.length);
