const ids=[];const W=1440,H=900;
function chromeC(i,name,o={}){const r=screen("C · Floating dock · "+name,i*1540,2200,{layout:"none"});ids.push(r);
 const vp=fr(r,"Viewport",{layout:"none",x:0,y:0,width:W,height:H,clip:true,fill:C.cream});
 const wrap=fr(r,"Dock row",{layoutPosition:"absolute",x:0,y:H-72,width:W,height:56,justifyContent:"center",alignItems:"center"});
 const d=fr(wrap,"Dock",{height:52,padding:[0,8],gap:4,alignItems:"center",cornerRadius:14,fill:DK,stroke:DKL,strokeWidth:1,effect:{type:"shadow",offset:{x:0,y:12},blur:32,color:"#00000047"}});
 const lg=fr(d,"Logo",{width:28,height:28,cornerRadius:7,fill:DKF,alignItems:"center",justifyContent:"center"});tx(lg,"W",{fontWeight:"700",fill:DK});
 dbtn(d,"file-text","Home",{caret:true});dsep(d);const seg=fr(d,"Mode",{padding:3,gap:2,cornerRadius:8,fill:"#27272A"});dbtn(seg,"pencil","Edit",{on:true});dbtn(seg,"eye","Preview",{muted:true});
 dsep(d);dbtn(d,"languages",o.lang||"EN",{caret:true,on:o.langOpen});dbtn(d,"sliders-horizontal","Details",{on:o.details});dsep(d);
 const st=fr(d,"Status",{padding:[0,8],gap:6,alignItems:"center"});Insert(st,{type:"ellipse",name:"Dot",width:8,height:8,fill:o.count?"#FBBF24":"#4ADE80"});tx(st,o.count?(o.count+(o.count>1?" changes":" change")+" · saved"):"No changes",{fontSize:12,fill:DKM});
 dbtn(d,"upload","Publish",{primary:true,on:o.pub});dbtn(d,"x",null,{muted:true});return {r,vp};}
{const {r,vp}=chromeC(0,"1 Edit mode on");sitePage(vp,W,"en",{_:"hint",h1:"hover"});hintCard(r,W/2-175,H-72-150,"You're editing the Draft of Home","Click outlined text or images to change them. Changes save as you go; visitors see nothing until you publish.",{btn:"Got it",w:350,dark:true});}
{const {r,vp}=chromeC(1,"2 Editing text",{count:1});const E=sitePage(vp,W,"en",{intro:"sel"},{intro:"Sourdough, pastries and celebration cakes, baked by hand on Harbour Street, Cork. Order before 2pm for next-day collection, or call us on 021 455 0199."});toolbar(E.intro,0,-66,"rich");}
{const {r,vp}=chromeC(2,"3 Image",{count:2});const E=sitePage(vp,W,"en",{img:"sel"},{focal:true});imagePop(E.img,-336,30);}
{const {r,vp}=chromeC(3,"4 Loop items",{count:3});const E=sitePage(vp,W,"en",{bakesSec:"hover",bake1:"sel",blogSec:"hint"},{scroll:540,addItem:true});toolbar(E.bake[1],0,-66,"item");itemPop(E.bakesSec,642,96);
 hintCard(E.blogSec,W-120-330,10,"Posts come from a query","Latest 3 Blog posts. Click a post to edit it on its own page; the Loop decides the order.",{icon:"repeat",w:330});}
{const {r,vp}=chromeC(4,"5 Page details",{count:3,details:true});sitePage(vp,W,"en",{});const d=pop(r,"Details sheet",{x:W-424,y:16,w:408,r:14});
 const h=fr(d,"Head",{width:"fill_container",padding:[16,20],alignItems:"center",gap:8,stroke:"$border",strokeWidth:{bottom:1}});ic(h,"sliders-horizontal",{fill:"$fg"});tx(h,"Page details",{fontWeight:"600",fontSize:15});sp(h);ic(h,"x");const b=fr(d,"Body",{layout:"vertical",width:"fill_container",padding:20,gap:14});detailsBody(b);}
{const {r,vp}=chromeC(5,"6 Save & publish",{count:3,pub:true});sitePage(vp,W,"en",{});const c=pop(r,"Publish popover",{x:W/2+20,y:H-72-486,w:388,r:14});publishBody(c);}
{const {r,vp}=chromeC(6,"7 Switching language",{count:3,lang:"IT",langOpen:true});sitePage(vp,W,"it",IT_S,{labels:IT_L,scroll:-44});itBanner(vp,0,0,W);const c=pop(r,"Language menu",{x:W/2-200,y:H-72-292,w:360,r:14});langBody(c);}
Export(ids,"png","/tmp/penproto-ie/out/C");Print("C done",ids.length);
