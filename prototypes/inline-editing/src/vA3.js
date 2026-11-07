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
 if(o.strip)o.strip(p);codeLines(p,lines,hl);return p;}
function codeScreen(i,name,sel,pathItems,warn,html,htmlHl,css,cssHl,cssSub,extra){const r=screen("A · Top bar · "+name,i*1540,0,{layout:"vertical"});ids.push(r);barA(r);
 const vp=fr(r,"Viewport",{layout:"none",width:W,height:sel.vpH||430,clip:true,fill:C.cream});sitePage(vp,W,"en",sel.S,{labels:sel.L,scroll:sel.scroll||0});
 const dock=fr(r,"Code dock",{layout:"vertical",width:"fill_container",height:"fill_container",fill:DK,stroke:DKL,strokeWidth:{top:1}});
 const cr=fr(dock,"Path",{width:"fill_container",height:38,padding:[0,12],gap:8,alignItems:"center"});const sb=fr(cr,"Staff only",{padding:[2,8],cornerRadius:999,stroke:"#52525B",strokeWidth:1});tx(sb,"Staff only",{fontSize:11,fill:DKM,fontWeight:"500"});
 pathItems.forEach((t,k)=>{const last=k==pathItems.length-1;tx(cr,t,{fontSize:12,fill:last?DKF:DKM,fontWeight:last?"600":"400",fontFamily:MONO});if(!last)ic(cr,"chevron-right",{width:12,height:12,fill:"#52525B"});});
 sp(cr);if(warn){const w=fr(cr,"Warn",{gap:6,alignItems:"center",padding:[3,10],cornerRadius:6,fill:"#3B2A06"});ic(w,"triangle-alert",{width:13,height:13,fill:"#FBBF24"});tx(w,warn,{fontSize:12,fill:"#FBBF24"});}dbtn(cr,"panel-bottom-close",null,{muted:true});
 const row=fr(dock,"Panels",{width:"fill_container",height:"fill_container"});
 const ph=panel(row,"HTML","code-xml",pathItems[1],html,htmlHl,{first:true});
 const pc=panel(row,"CSS","paintbrush",cssSub,css,cssHl,{scope:[["Class",true],["Site CSS",false]],strip:sel.strip});
 const pj=panel(row,"JS","braces","Page script",[[["// No script on this page yet.",CM]]],null,{scope:[["Page",true],["Site",false]]});Update(pj,{width:260});
 const ft=fr(dock,"Footer",{width:"fill_container",height:30,padding:[0,12],gap:14,alignItems:"center",stroke:DKL,strokeWidth:{top:1}});
 for(const t of ["Ctrl+Space for suggestions","Tab to accept","Esc to close"]){tx(ft,t,{fontSize:11,fill:DKM});}sp(ft);tx(ft,"Saved to Draft · just now",{fontSize:11,fill:DKM});
 extra(ph,pc);return r;}
function ac(panelFrame,x,y,w,groups,o={}){
 const a=fr(panelFrame,"Autocomplete",{layoutPosition:"absolute",x,y,width:w,layout:"vertical",fill:"#1C1C21",cornerRadius:8,stroke:"#3F3F46",strokeWidth:1,clip:true,padding:[4,0],effect:{type:"shadow",offset:{x:0,y:12},blur:28,color:"#00000080"}});
 groups.forEach(([g,items],gi)=>{const gh=fr(a,"Group "+g,{width:"fill_container",padding:[gi?8:4,10,3,10],gap:6,alignItems:"center"});tx(gh,g,{fontSize:10,fontWeight:"700",fill:"#71717A",letterSpacing:0.6});
  items.forEach(([icon,label,hint,on,sw])=>{const r=fr(a,"Item "+label,{width:"fill_container",height:26,padding:[0,10],gap:8,alignItems:"center",...(on?{fill:"#4F46E540",stroke:BR,strokeWidth:{left:2}}:{})});
   if(sw)Insert(r,{type:"rectangle",name:"Swatch",width:12,height:12,cornerRadius:3,fill:sw,stroke:"#FFFFFF33",strokeWidth:1});else ic(r,icon,{width:13,height:13,fill:on?DKF:"#A1A1AA"});
   tx(r,label,{fontFamily:MONO,fontSize:12,fill:on?DKF:"#E4E4E7"});sp(r);tx(r,hint,{fontSize:11,fill:"#71717A"});});});
 if(o.foot){const f=fr(a,"Foot",{width:"fill_container",padding:[7,10],gap:6,alignItems:"center",stroke:"#3F3F46",strokeWidth:{top:1}});ic(f,"info",{width:12,height:12,fill:"#71717A"});tx(f,o.foot,{fontSize:11,fill:"#A1A1AA",textGrowth:"fixed-width",width:"fill_container"});}return a;}
const L=(i)=>10+36+21*i; /* y of line i inside a panel: head 36 + code padding 10 */
function iconStrip(p){const s=fr(p,"Property icons",{width:"fill_container",height:44,padding:[0,10],gap:10,alignItems:"center",fill:"#141417",stroke:DKL,strokeWidth:{bottom:1}});
 const grp=(label,icons,on)=>{const g=fr(s,"Group "+label,{gap:4,alignItems:"center"});tx(g,label,{fontSize:10,fontWeight:"600",fill:"#71717A"});const b=fr(g,"Buttons",{padding:2,gap:1,cornerRadius:6,fill:"#27272A"});icons.forEach((ico,k)=>{const x=fr(b,"Btn "+ico,{width:24,height:22,cornerRadius:4,alignItems:"center",justifyContent:"center",...(k==on?{fill:"#4F46E5"}:{})});ic(x,ico,{width:13,height:13,fill:k==on?"#FFFFFF":"#A1A1AA"});});};
 grp("Display",["square","columns-3","layout-grid","eye-off"],1);grp("Direction",["arrow-right","arrow-down"],0);grp("Justify",["align-horizontal-justify-start","align-horizontal-justify-center","align-horizontal-justify-end","align-horizontal-space-between"],0);grp("Align",["align-vertical-justify-start","align-vertical-justify-center","align-vertical-justify-end"],1);grp("Wrap",["corner-down-left"],0);}
/* 10 HTML autocomplete */
codeScreen(9,"10 Code mode · HTML suggestions",{S:{intro:"sel"},L:{intro:"div.hero__intro · Hero (Component)"},vpH:280,scroll:120},["Home","Hero · Component","div.hero__text","div.hero__intro"],"Hero is used on 3 pages",
 [[["<section ",TG],["class",AT],["=",PL],["\"hero\"",STR],[">",TG]],
  [["  <div ",TG],["class",AT],["=",PL],["\"hero__text\"",STR],[">",TG]],
  [["    <h1 ",TG],["class",AT],["=",PL],["\"hero__title\"",STR],[">",TG],["{headline}",VA],["</h1>",TG]],
  [["    <div ",TG],["class",AT],["=",PL],["\"hero__intro\"",STR],[">",TG],["{intro}",VA],["</div>",TG]],
  [["    <p ",TG],["class",AT],["=",PL],["\"hero__note\"",STR],[">",TG],["Call us on ",PL],["{si",VA],["</p>",TG]],
    [["  </div>",TG]],
  [["</section>",TG]]],[4],
 [[[".hero__intro",PR],[" {",PL]],[["  max-width",AT],[": ",PL],["60ch",STR],[";",PL]],[["  color",AT],[": ",PL],["var(--color-soft)",VA],[";",PL]],[["}",PL]]],null,".hero__intro",
 (ph,pc)=>{ac(ph,250,L(5)-2,340,[["THIS ENTRY · Home",[["type","{headline}","Text"],["pilcrow","{intro}","Rich text"],["image","{image}","Image"]]],["SITE OPTIONS · Globals",[["phone","{site.phone}","021 455 0199",true],["map-pin","{site.address}","12 Harbour St"]]],["LOOPS",[["repeat","<loop> Blog posts","query"],["repeat","<loop> Our bakes","own items"]]],["COMPONENTS",[["component","<Button>","label, url"]]]],{foot:"Placeholder syntax is not decided yet"});
});
/* 11 CSS autocomplete + property icons */
const Sx=codeScreen(10,"11 Code mode · CSS suggestions and property icons",{S:{b1:"hint",b2:"hint"},L:{},strip:iconStrip,vpH:280,scroll:120},["Home","Hero · Component","div.hero__text","div.hero__actions"],null,
 [[["<div ",TG],["class",AT],["=",PL],["\"hero__actions\"",STR],[">",TG]],[["  <Button ",TG],["label",AT],["=",PL],["\"{button1.label}\"",STR],[" />",TG]],[["  <Button ",TG],["label",AT],["=",PL],["\"{button2.label}\"",STR],[" />",TG]],[["  <ul ",TG],["class",AT],["=",PL],["\"bad",STR],[">",TG]],[["</div>",TG]]],[3],
 [[[".hero__actions",PR],[" {",PL]],[["  display",AT],[": ",PL],["flex",STR],[";",PL]],[["  flex-wrap",AT],[": ",PL],["wrap",STR],[";",PL]],[["  align-items",AT],[": ",PL],["center",STR],[";",PL]],[["  gap",AT],[": ",PL],["var(--sp",VA]],[["}",PL]]],[4],".hero__actions",
 (ph,pc)=>{ac(ph,280,L(4)-2,250,[["CLASSES · Site",[["hash","badge","Design system",true],["hash","badge--soft","Design system"],["hash","badge-list","Design system"]]]]);
  ac(pc,150,L(5)+44-2,290,[["SPACING TOKENS",[["ruler","--space-xs","0.5–0.75rem"],["ruler","--space-s","0.75–1rem",true],["ruler","--space-m","1–1.5rem"],["ruler","--space-l","1.5–2.25rem"]]],["COLOURS",[["","--color-crust","#B45309",false,"#B45309"],["","--color-ink","#2B1D12",false,"#2B1D12"]]]],{foot:"Values from the Site's Design system"});});
Export(ids,"png","/tmp/penproto-ie/out/A3");Print("A3 done",ids.length);
