const ids=[];const W=1440,H=852;
function chromeA(i,name,o={}){const r=screen("A · Top bar · "+name,i*1540,0,{layout:"vertical"});ids.push(r);
 const bar=fr(r,"Edit bar",{width:"fill_container",height:48,padding:[0,10],gap:4,alignItems:"center",fill:DK});
 const lg=fr(bar,"Logo",{width:28,height:28,cornerRadius:7,fill:DKF,alignItems:"center",justifyContent:"center"});tx(lg,"W",{fontWeight:"700",fill:DK});
 dbtn(bar,null,"Acme Bakery",{muted:true});tx(bar,"/",{fill:DKL,fontSize:16});dbtn(bar,"file-text","Home",{caret:true});
 const st=fr(bar,"Status",{padding:[3,9],cornerRadius:999,fill:o.count?"#3B2A06":"#27272A"});tx(st,o.count?("Draft · "+o.count+(o.count>1?" changes":" change")):"No changes",{fontSize:12,fontWeight:"500",fill:o.count?"#FBBF24":DKM});
 if(o.count)tx(bar,"  Saved to Draft · just now",{fontSize:12,fill:DKM});
 sp(bar);const seg=fr(bar,"Mode",{padding:3,gap:2,cornerRadius:8,fill:"#27272A"});dbtn(seg,"pencil","Edit",{on:true});dbtn(seg,"eye","Preview",{muted:true});
 dsep(bar);dbtn(bar,"monitor",null,{on:true});dbtn(bar,"tablet",null,{muted:true});dbtn(bar,"smartphone",null,{muted:true});
 sp(bar);dbtn(bar,"languages",o.lang||"EN",{caret:true,on:o.langOpen});dbtn(bar,"panel-right","Page details",{on:o.details});dbtn(bar,"layout-dashboard",null,{muted:true});
 dbtn(bar,"upload","Publish",{primary:true,caret:true});avatar(bar,"GR",{size:28,fill:"#64748B"});
 const vp=fr(r,"Viewport",{layout:"none",width:W,height:H,clip:true,fill:C.cream});return {r,bar,vp};}
{const {r,vp}=chromeA(0,"1 Edit mode on");sitePage(vp,W,"en",{_:"hint",h1:"hover"});
 hintCard(vp,W-360,H-190,"You're editing the Draft of Home","Click outlined text or images to change them. Changes save to the Draft as you go; visitors see nothing until you publish.",{btn:"Got it",w:330});}
{const {r,vp}=chromeA(1,"2 Editing text",{count:1});const E=sitePage(vp,W,"en",{intro:"sel"},{intro:"Sourdough, pastries and celebration cakes, baked by hand on Harbour Street, Cork. Order before 2pm for next-day collection, or call us on 021 455 0199."});toolbar(E.intro,0,-66,"rich");}
{const {r,vp}=chromeA(2,"3 Image",{count:2});const E=sitePage(vp,W,"en",{img:"sel"},{focal:true});imagePop(E.img,-336,30);}
{const {r,vp}=chromeA(3,"4 Loop items",{count:3});const E=sitePage(vp,W,"en",{bakesSec:"hover",bake1:"sel",blogSec:"hint"},{scroll:540,addItem:true,bakes:LANG.en.bakes});
 toolbar(E.bake[1],0,-66,"item");itemPop(E.bakesSec,642,96);
 hintCard(E.blogSec,W-120-330,10,"Posts come from a query","Latest 3 Blog posts. Click a post to edit it on its own page; the Loop decides the order.",{icon:"repeat",w:330});}
{const {r,vp}=chromeA(4,"5 Page details",{count:3,details:true});sitePage(vp,W,"en",{});
 const d=fr(vp,"Page details drawer",{layoutPosition:"absolute",x:W-400,y:0,width:400,height:H,layout:"vertical",fill:"$bg",stroke:"$border",strokeWidth:{left:1},effect:{type:"shadow",offset:{x:-8,y:0},blur:24,color:"#0000001F"}});
 const h=fr(d,"Head",{width:"fill_container",padding:[16,20],alignItems:"center",gap:8,stroke:"$border",strokeWidth:{bottom:1}});ic(h,"panel-right",{fill:"$fg"});tx(h,"Page details",{fontWeight:"600",fontSize:15});sp(h);ic(h,"x");
 const b=fr(d,"Body",{layout:"vertical",width:"fill_container",padding:20,gap:14});tx(b,"Fields that don't show on the page.",{fill:"$muted-fg"});detailsBody(b);}
{const {r,vp}=chromeA(5,"6 Save & publish",{count:3});sitePage(vp,W,"en",{});const c=pop(r,"Publish popover",{x:W-400,y:52,w:388});publishBody(c);}
{const {r,vp}=chromeA(6,"7 Switching language",{count:3,lang:"IT",langOpen:true});sitePage(vp,W,"it",IT_S,{labels:IT_L,scroll:-44});itBanner(vp,0,0,W);const c=pop(r,"Language menu",{x:W-520,y:52,w:340});langBody(c);}
Export(ids,"png","/tmp/penproto-ie/out/A");Print("A done",ids.length);
