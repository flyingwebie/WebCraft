/* PROTOTYPE helpers: Inline editing on a mock bakery Site */
const SF="Fraunces",SB="Inter";
const C={cream:"#FBF7F1",ink:"#2B1D12",soft:"#6B5A4A",line:"#E8DDCF",crust:"#B45309",band:"#F3EBDF"};
const BR="#4F46E5",AMB="#D97706",BLU="#2563EB",RED="#DC2626";
const DK="#18181B",DKF="#FAFAFA",DKM="#A1A1AA",DKL="#3F3F46";
const LANG={
 en:{nav:["Menu","Blog","Visit us","Order"],cta:"Order a cake",eyebrow:"SPRING MENU 2027",h1:"Fresh from our ovens, every morning since 1987",
  intro:"Sourdough, pastries and celebration cakes, baked by hand on Harbour Street, Cork. Order before 2pm for next-day collection.",
  b1:"See the menu",b2:"Find us",bakesH:"Our bakes",bakesS:"Baked this morning, gone by the afternoon.",
  bakes:[["Country sourdough","€6.50"],["Cardamom bun","€3.20"],["Lemon tart","€4.80"],["Seeded rye","€5.90"]],
  blogH:"From the blog",blog:[["Bread","Our sourdough starter, explained"],["Menu","Spring menu 2027"],["People","Behind the ovens: a day at the bakery"]]},
 it:{nav:["Menù","Blog","Dove siamo","Ordina"],cta:"Ordina una torta",eyebrow:"MENÙ DI PRIMAVERA 2027",h1:"Appena sfornato, ogni mattina dal 1987",
  intro:"Pane a lievitazione naturale, pasticceria e torte per le feste, fatti a mano in Harbour Street, Cork. Ordina entro le 14 per il ritiro il giorno dopo.",
  b1:"Scopri il menù",b2:"Dove siamo",bakesH:"I nostri prodotti",bakesS:"Sfornati stamattina, finiti nel pomeriggio.",
  bakes:[["Pane di campagna","€6,50"],["Panino al cardamomo","€3,20"],["Crostata al limone","€4,80"],["Pane di segale ai semi","€5,90"]],
  blogH:"Dal blog",blog:[["Pane","Il nostro lievito madre, spiegato"],["Menù","Menù di primavera 2027"],["Persone","Dietro i forni: una giornata in panetteria"]]}};
function stx(p,c,o={}){return Insert(p,{type:"text",name:o.name||("Text "+String(c).slice(0,24)),content:String(c),fontFamily:SB,fontSize:16,fill:C.ink,...o});}
function dtx(p,c,o={}){return tx(p,c,{fill:DKF,...o});}
const PH=[["#F2D3A2","#9A5B25"],["#F6E2C0","#C2410C"],["#FDF0B5","#CA8A04"],["#E7D3B8","#5B3A1E"],["#EBD9C4","#7C4A24"],["#F4D8B8","#8F4E1C"]];
function photo(p,name,w,h,k=0,o={}){const f=fr(p,"Photo "+name,{layout:"none",width:w,height:h,cornerRadius:o.r??10,clip:true,fill:{type:"gradient",gradientType:"linear",rotation:150,colors:[{color:PH[k%6][0],position:0},{color:PH[k%6][1],position:1}]}});
 Insert(f,{type:"ellipse",name:"Loaf",x:(typeof w=="number"?w:300)*0.18,y:h*0.42,width:(typeof w=="number"?w:300)*0.62,height:h*0.42,fill:"#00000022"});
 Insert(f,{type:"ellipse",name:"Light",x:(typeof w=="number"?w:300)*0.55,y:-h*0.2,width:h*0.7,height:h*0.7,fill:"#FFFFFF33"});return f;}
/* editable wrapper. st: none|hint|hover|sel|ai|hand|out */
const EST={hint:[BR+"40",1],hover:[BR,1.5],sel:[BR,2],ai:[AMB,1.5],hand:[BLU,1.5],out:[RED,1.5]};
function ed(p,name,st,o={}){const s=EST[st];const w=fr(p,"Editable "+name,{layout:"vertical",padding:o.pad??[4,6],cornerRadius:6,width:o.width||"fill_container",gap:o.gap??0,...(o.h?{height:o.h}:{}),...(s?{stroke:s[0],strokeWidth:s[1]}:{}),...(o.fill?{fill:o.fill}:{})});
 const lab=o.label||name;if(s&&st!="hint"){const ch=fr(w,"Label "+lab,{layoutPosition:"absolute",x:-1,y:-22,height:22,padding:[0,7],gap:5,alignItems:"center",cornerRadius:[5,5,0,0],fill:s[0]});if(o.icon)ic(ch,o.icon,{width:12,height:12,fill:"#FFFFFF"});tx(ch,lab,{fontSize:11,fontWeight:"600",fill:"#FFFFFF"});}
 return w;}
/* The Site page. S maps element keys to states; returns wrappers */
function sitePage(vp,W,lang,S={},o={}){const T=LANG[lang],pad=W>=1300?120:56,E={};const g=k=>S[k]||S._||"none";const lb=k=>(o.labels||{})[k];
 const pg=fr(vp,"Site page · acmebakery.ie",{layout:"vertical",width:W,x:0,y:-(o.scroll||0),fill:C.cream});
 const nav=fr(pg,"Site nav",{width:"fill_container",padding:[22,pad],alignItems:"center",gap:28,stroke:C.line,strokeWidth:{bottom:1}});
 const lg=fr(nav,"Logo",{gap:10,alignItems:"center"});Insert(lg,{type:"ellipse",name:"Mark",width:26,height:26,fill:C.crust});stx(lg,"Acme Bakery",{fontFamily:SF,fontSize:22,fontWeight:"600"});
 sp(nav);for(const l of T.nav)stx(nav,l,{fontSize:15,fill:C.soft});const cta=fr(nav,"CTA",{padding:[10,18],cornerRadius:999,fill:C.ink});stx(cta,T.cta,{fontSize:14,fontWeight:"600",fill:C.cream});
 const hero=fr(pg,"Hero",{width:"fill_container",padding:[44,pad,56,pad],gap:W>=1300?64:36,alignItems:"center"});
 const col=fr(hero,"Hero text",{layout:"vertical",width:"fill_container",gap:26});
 E.eyebrow=ed(col,"Eyebrow",g("eyebrow"),{label:lb("eyebrow")||"Eyebrow · Text",width:"fit_content"});stx(E.eyebrow,T.eyebrow,{fontSize:13,fontWeight:"700",fill:C.crust,letterSpacing:1.4});
 E.h1=ed(col,"Headline",g("h1"),{label:lb("h1")||"Headline · Text"});stx(E.h1,T.h1,{fontFamily:SF,fontSize:W>=1300?56:44,fontWeight:"600",lineHeight:1.06,textGrowth:"fixed-width",width:"fill_container",letterSpacing:-1});
 E.intro=ed(col,"Intro",g("intro"),{label:lb("intro")||"Intro · Rich text"});stx(E.intro,o.intro||T.intro,{fontSize:18,fill:C.soft,lineHeight:1.55,textGrowth:"fixed-width",width:"fill_container"});
 const br=fr(col,"Buttons",{gap:12,padding:[8,0,0,0]});
 E.b1=ed(br,"Button 1",g("b1"),{label:"Button · Link",width:"fit_content",pad:3});const b1=fr(E.b1,"Btn",{padding:[13,22],cornerRadius:999,fill:C.crust});stx(b1,T.b1,{fontSize:15,fontWeight:"600",fill:"#FFFFFF"});
 E.b2=ed(br,"Button 2",g("b2"),{label:"Button · Link",width:"fit_content",pad:3});const b2=fr(E.b2,"Btn",{padding:[12,22],cornerRadius:999,stroke:C.ink,strokeWidth:1.5});stx(b2,T.b2,{fontSize:15,fontWeight:"600"});
 const iw=W>=1300?560:440;E.img=ed(hero,"Hero image",g("img"),{label:lb("img")||"Hero image · Image",width:iw+12,pad:6,icon:"image"});photo(E.img,"Hero",iw,W>=1300?400:340,0,{r:18});
 if(o.focal){Insert(E.img,{type:"ellipse",name:"Focal point",layoutPosition:"absolute",x:6+iw*0.45-14,y:6+150-14,width:28,height:28,fill:"#FFFFFF55",stroke:"#FFFFFF",strokeWidth:3});}
 E.bakesSec=ed(pg,"Our bakes",g("bakesSec"),{label:lb("bakesSec")||"Loop · Our bakes · own items",pad:[36,pad,48,pad],gap:22,icon:"repeat",fill:C.cream});
 const bh=fr(E.bakesSec,"Heading",{width:"fill_container",alignItems:"end",gap:20});E.bakesH=ed(bh,"Bakes heading",g("bakesH"),{label:"Heading · Text",width:"fit_content"});stx(E.bakesH,T.bakesH,{fontFamily:SF,fontSize:36,fontWeight:"600"});sp(bh);stx(bh,T.bakesS,{fontSize:15,fill:C.soft});
 const grid=fr(E.bakesSec,"Items",{width:"fill_container",gap:20});E.bake=[];
 const items=o.bakes||T.bakes;items.forEach(([n,pr],i)=>{const c=ed(grid,"Bake "+n,g("bake"+i),{label:lb("bake"+i)||"Item "+(i+1),pad:8,gap:8});photo(c,n,"fill_container",W>=1300?190:150,i+1);const r=fr(c,"Row",{width:"fill_container",alignItems:"center",padding:[4,2,0,2]});stx(r,n,{fontSize:17,fontWeight:"600"});sp(r);stx(r,pr,{fontSize:16,fill:C.soft});E.bake.push(c);});
 if(o.addItem){const a=fr(grid,"Add item",{layout:"vertical",width:140,height:W>=1300?236:196,cornerRadius:10,fill:BR+"0D",stroke:BR+"66",strokeWidth:1.5,alignItems:"center",justifyContent:"center",gap:6});ic(a,"plus",{fill:BR,width:20,height:20});tx(a,"Add bake",{fill:BR,fontWeight:"600"});}
 E.blogSec=ed(pg,"From the blog",g("blogSec"),{label:lb("blogSec")||"Loop · latest 3 Blog posts",pad:[40,pad,56,pad],gap:22,icon:"repeat",fill:C.band});
 stx(E.blogSec,T.blogH,{fontFamily:SF,fontSize:36,fontWeight:"600"});const bg=fr(E.blogSec,"Posts",{width:"fill_container",gap:24});E.blog=[];
 T.blog.forEach(([tag,t],i)=>{const c=ed(bg,"Post "+t,g("blog"+i),{label:"Blog post",pad:8,gap:10});photo(c,t,"fill_container",150,i+3);stx(c,tag.toUpperCase(),{fontSize:12,fontWeight:"700",fill:C.crust,letterSpacing:1.2});stx(c,t,{fontFamily:SF,fontSize:21,fontWeight:"600",textGrowth:"fixed-width",width:"fill_container",lineHeight:1.2});E.blog.push(c);});
 const ft=fr(pg,"Footer",{width:"fill_container",padding:[28,pad],fill:C.ink,gap:20});stx(ft,"Acme Bakery · 12 Harbour Street, Cork",{fill:C.cream,fontSize:14});sp(ft);stx(ft,"Open daily 7:30–17:00",{fill:"#D6C7B5",fontSize:14});
 E.page=pg;return E;}
/* ---------- editor pieces (admin theme) ---------- */
function pop(p,name,o={}){return fr(p,name,{layoutPosition:"absolute",x:o.x||0,y:o.y||0,layout:"vertical",width:o.w||300,fill:o.dark?DK:"$bg",cornerRadius:o.r??10,stroke:o.dark?DKL:"$border",strokeWidth:1,clip:true,padding:o.pad??0,gap:o.gap??0,effect:{type:"shadow",offset:{x:0,y:12},blur:32,color:"#0000002E"},...(o.h?{height:o.h}:{})});}
function dbtn(p,icon,label,o={}){const b=fr(p,"Tool "+(label||icon),{height:30,padding:[0,label?10:7],gap:6,cornerRadius:6,alignItems:"center",...(o.on?{fill:"#3F3F46"}:{}),...(o.primary?{fill:"#FAFAFA"}:{})});if(icon)ic(b,icon,{width:15,height:15,fill:o.primary?DK:(o.muted?DKM:DKF)});if(label)tx(b,label,{fontSize:13,fontWeight:"500",fill:o.primary?DK:(o.muted?DKM:DKF)});if(o.count){const c=fr(b,"Count",{padding:[0,6],height:18,cornerRadius:999,fill:o.primary?DK:"#3F3F46",alignItems:"center"});tx(c,String(o.count),{fontSize:11,fontWeight:"600",fill:o.primary?DKF:DKF});}if(o.caret)ic(b,"chevron-down",{width:13,height:13,fill:o.primary?DK:DKM});return b;}
function dsep(p){return fr(p,"Sep",{width:1,height:20,fill:DKL});}
function toolbar(p,x,y,kind){const t=fr(p,"Floating toolbar",{layoutPosition:"absolute",x,y,height:40,padding:[0,5],gap:2,alignItems:"center",cornerRadius:9,fill:DK,effect:{type:"shadow",offset:{x:0,y:8},blur:24,color:"#00000040"}});
 if(kind=="rich"){for(const i of ["bold","italic","link","list","list-ordered","remove-formatting"])dbtn(t,i,null,{on:i=="bold"});dsep(t);dbtn(t,"undo-2",null,{muted:true});dbtn(t,null,"Done",{primary:true});}
 else if(kind=="text"){dbtn(t,"undo-2",null,{muted:true});dbtn(t,null,"Done",{primary:true});}
 else if(kind=="item"){dbtn(t,"grip-vertical",null,{muted:true});dbtn(t,"pencil",null);dbtn(t,"arrow-left",null);dbtn(t,"arrow-right",null);dbtn(t,"copy",null);dbtn(t,"trash-2",null);}
 return t;}
function hintCard(p,x,y,title,body,o={}){const c=pop(p,"Hint",{x,y,w:o.w||320,pad:16,gap:8,dark:o.dark});const h=fr(c,"Head",{width:"fill_container",gap:8,alignItems:"center"});ic(h,o.icon||"mouse-pointer-click",{fill:o.dark?DKF:"$fg"});tx(h,title,{fontWeight:"600",fill:o.dark?DKF:"$fg"});tx(c,body,{textGrowth:"fixed-width",width:"fill_container",lineHeight:1.5,fill:o.dark?DKM:"$muted-fg"});if(o.btn){const r=fr(c,"Row",{width:"fill_container",justifyContent:"end"});o.dark?dbtn(r,null,o.btn,{primary:true}):btn(r,o.btn,{kind:"primary"});}return c;}
/* image tools popover */
function imagePop(p,x,y){const c=pop(p,"Image tools",{x,y,w:320});const h=fr(c,"Head",{width:"fill_container",padding:[14,16,10,16],gap:8,alignItems:"center"});ic(h,"image",{fill:"$fg"});tx(h,"Hero image",{fontWeight:"600"});sp(h);ic(h,"x");
 const b=fr(c,"Body",{layout:"vertical",width:"fill_container",padding:[0,16,16,16],gap:12});const r=fr(b,"Actions",{width:"fill_container",gap:8});btn(r,"Choose from Media",{icon:"images"});btn(r,"Upload",{icon:"upload"});
 field(b,"Alt text · English","A tray of country sourdough loaves fresh from the oven",{hint:"Read by screen readers and search engines."});
 const fp=fr(b,"Focal",{width:"fill_container",gap:8,alignItems:"center"});ic(fp,"crosshair");tx(fp,"Focal point",{fontWeight:"500"});sp(fp);tx(fp,"Drag the dot on the image",{fontSize:12,fill:"$muted-fg"});
 const m=fr(b,"Meta",{width:"fill_container",gap:6,alignItems:"center"});ic(m,"info",{width:13,height:13});tx(m,"2400 × 1600 · served as AVIF and WebP",{fontSize:12,fill:"$muted-fg"});return c;}
/* item editor popover */
function itemPop(p,x,y,o={}){const c=pop(p,"Item editor",{x,y,w:300});const h=fr(c,"Head",{width:"fill_container",padding:[14,16,10,16],gap:8,alignItems:"center"});ic(h,"repeat",{fill:"$fg"});tx(h,"Our bakes · item 2",{fontWeight:"600"});sp(h);ic(h,"x");
 const b=fr(c,"Body",{layout:"vertical",width:"fill_container",padding:[0,16,16,16],gap:12});field(b,"Name","Cardamom bun");field(b,"Price","€3.20");
 const ph=fr(b,"Photo",{layout:"vertical",gap:6,width:"fill_container"});tx(ph,"Photo",{fontWeight:"500"});const pr=fr(ph,"Row",{gap:10,alignItems:"center",width:"fill_container"});photo(pr,"thumb",56,40,2,{r:6});tx(pr,"cardamom-bun.jpg",{fill:"$muted-fg",fontSize:12});sp(pr);btn(pr,"Change");
 const t=fr(b,"Avail",{width:"fill_container",alignItems:"center",gap:8});tx(t,"Sold out today",{fontWeight:"500"});sp(t);toggle(t,false);return c;}
/* page details panel content */
function detailsBody(b){field(b,"Title","Home");field(b,"Address","acmebakery.ie/",{hint:"The home page has no slug."});
 const seo=fr(b,"SEO",{layout:"vertical",width:"fill_container",gap:12,padding:[12,0,0,0],stroke:"$border",strokeWidth:{top:1}});tx(seo,"SEARCH AND SHARING",{fontSize:11,fontWeight:"600",fill:"$muted-fg",letterSpacing:0.4});
 field(seo,"SEO title","Acme Bakery · Sourdough and cakes in Cork",{hint:"44 of 60 characters"});
 const md=fr(seo,"Field Meta description",{layout:"vertical",gap:6,width:"fill_container"});tx(md,"Meta description",{fontWeight:"500"});const ta=fr(md,"Textarea",{width:"fill_container",height:72,padding:[8,10],cornerRadius:6,stroke:"$border",strokeWidth:1});tx(ta,"Sourdough, pastries and celebration cakes baked by hand on Harbour Street, Cork, every morning since 1987.",{textGrowth:"fixed-width",width:"fill_container",lineHeight:1.45});tx(md,"112 of 160 characters",{fontSize:12,fill:"$muted-fg"});
 const og=fr(seo,"Social image",{layout:"vertical",gap:6,width:"fill_container"});tx(og,"Social image",{fontWeight:"500"});const r=fr(og,"Row",{gap:10,alignItems:"center",width:"fill_container"});photo(r,"og",96,50,0,{r:6});tx(r,"Uses the Hero image",{fill:"$muted-fg",fontSize:12});sp(r);btn(r,"Change");
 const t=fr(seo,"Noindex",{width:"fill_container",alignItems:"center",gap:8});tx(t,"Hide from search engines",{fontWeight:"500"});sp(t);toggle(t,false);
 const sd=fr(seo,"Structured",{width:"fill_container",gap:6,alignItems:"center"});ic(sd,"check",{width:13,height:13,fill:"$success"});tx(sd,"Structured data: LocalBusiness · Bakery (from Site settings)",{fontSize:12,fill:"$muted-fg"});}
/* publish popover content */
function publishBody(c,o={}){const h=fr(c,"Head",{layout:"vertical",width:"fill_container",padding:[14,16,8,16],gap:3});tx(h,"Publish Home",{fontWeight:"600",fontSize:15});tx(h,"Visitors see these changes once you publish.",{fontSize:12,fill:"$muted-fg"});
 const l=fr(c,"Changes",{layout:"vertical",width:"fill_container",padding:[0,10,8,10],gap:2});
 for(const [i,t,m] of [["type","Intro","Text changed · you · 4 min ago"],["image","Hero image","Replaced · you · 2 min ago"],["repeat","Our bakes","1 item added: Seeded rye"]]){const r=fr(l,"Change "+t,{width:"fill_container",padding:[7,6],gap:10,alignItems:"center",cornerRadius:6});ic(r,i);const cc=fr(r,"T",{layout:"vertical",gap:1,width:"fill_container"});tx(cc,t,{fontWeight:"500"});tx(cc,m,{fontSize:12,fill:"$muted-fg"});tx(r,"Undo",{fontSize:12,fill:"$muted-fg",underline:true});}
 const tr=fr(c,"Translations",{width:"fill_container",padding:[10,16],gap:8,alignItems:"center",fill:"$info-bg"});ic(tr,"languages",{width:14,height:14,fill:"$info"});tx(tr,"Italian is re-translated by AI and waits for review. German (Automatic) goes live with this.",{fontSize:12,fill:"$info",textGrowth:"fixed-width",width:"fill_container",lineHeight:1.4});
 const f=fr(c,"Footer",{layout:"vertical",width:"fill_container",padding:[12,16,14,16],gap:10,stroke:"$border",strokeWidth:{top:1}});
 const r=fr(f,"Buttons",{width:"fill_container",gap:8,alignItems:"center"});tx(r,"Discard changes",{fontSize:12,fill:RED,fontWeight:"500"});sp(r);btn(r,"Publish page",{kind:"primary",icon:"upload"});
 const n=fr(f,"Other drafts",{width:"fill_container",gap:6,alignItems:"center"});ic(n,"info",{width:13,height:13});tx(n,"3 other Drafts on this Site.",{fontSize:12,fill:"$muted-fg"});tx(n,"Publish all in admin",{fontSize:12,fontWeight:"500",underline:true});
 const a=fr(f,"Author note",{width:"fill_container",padding:[8,10],gap:8,cornerRadius:6,fill:"$muted",alignItems:"center"});ic(a,"user",{width:13,height:13});tx(a,"Authors see “Saved to Draft” here instead: an Editor or Owner publishes.",{fontSize:12,fill:"$muted-fg",textGrowth:"fixed-width",width:"fill_container",lineHeight:1.4});}
/* language menu content */
function langBody(c){const h=fr(c,"Head",{width:"fill_container",padding:[12,14,6,14]});tx(h,"SITE LANGUAGE",{fontSize:11,fontWeight:"600",fill:"$muted-fg",letterSpacing:0.4});
 for(const [code,name,mode,st,k,on] of [["EN","English","Default language","","",false],["IT","Italiano","Review","3 to check","warn",true],["DE","Deutsch","Automatic","Up to date","success",false],["FR","Français","Manual","12 missing","neutral",false]]){const r=fr(c,"Lang "+code,{width:"fill_container",padding:[8,14],gap:10,alignItems:"center",...(on?{fill:"$accent"}:{})});const b=fr(r,"Code",{width:28,height:20,cornerRadius:4,stroke:"$border",strokeWidth:1,alignItems:"center",justifyContent:"center"});tx(b,code,{fontSize:10,fontWeight:"700"});const cc=fr(r,"T",{layout:"vertical",gap:1,width:"fill_container"});tx(cc,name,{fontWeight:"500"});tx(cc,mode,{fontSize:12,fill:"$muted-fg"});if(st)badge(r,st,k);if(on)ic(r,"check",{fill:"$fg"});}
 const f=fr(c,"Foot",{width:"fill_container",padding:[10,14],gap:6,alignItems:"center",stroke:"$border",strokeWidth:{top:1}});ic(f,"shield-check",{width:13,height:13});tx(f,"Protected terms stay as written: Acme Bakery, Harbour Street",{fontSize:12,fill:"$muted-fg",textGrowth:"fixed-width",width:"fill_container"});}
/* translation banner */
function itBanner(p,x,y,w){const b=fr(p,"Translation banner",{layoutPosition:"absolute",x,y,width:w,height:44,padding:[0,16],gap:10,alignItems:"center",fill:"#FEF3C7",stroke:"#FCD34D",strokeWidth:{bottom:1}});ic(b,"languages",{fill:"#B45309"});tx(b,"Italiano · Review",{fontWeight:"600",fill:"#92400E"});tx(b,"AI translations wait in the Draft until someone publishes them. 3 Fields to check.",{fill:"#92400E"});sp(b);
 const k=(c,l)=>{const x=fr(b,"Key "+l,{gap:5,alignItems:"center"});Insert(x,{type:"rectangle",name:"Swatch",width:10,height:10,cornerRadius:2,fill:c});tx(x,l,{fontSize:12,fill:"#92400E"});};k(AMB,"AI, to check");k(BLU,"Edited by hand");k(RED,"English changed");btn(b,"Compare with English",{icon:"columns-2"});btn(b,"Next to check",{kind:"primary",icon:"arrow-down"});return b;}
const IT_S={_:"hint",h1:"ai",intro:"hand",bake3:"out",eyebrow:"ai"};
const IT_L={h1:"AI · to check",eyebrow:"AI · to check",intro:"Edited by hand · AI won't overwrite",bake3:"English changed · re-translate?"};
