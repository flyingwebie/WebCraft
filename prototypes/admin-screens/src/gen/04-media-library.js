const X=4620,Y=0;
const r=screen("Screens · 04 Media library",X,Y,{h:900});sidebarA(r,SITE_A("Media"));const m=mainCol(r);topbarA(m,["Acme Ltd","Acme Bakery","Media"]);
const body=fr(m,"Media body",{width:"fill_container",height:"fill_container"});
// folders column
const fc=fr(body,"Folders",{layout:"vertical",width:208,height:"fill_container",padding:[20,12],gap:2,stroke:"$border",strokeWidth:{right:1}});
tx(fc,"FOLDERS",{fontSize:11,fontWeight:"500",fill:"$muted-fg",letterSpacing:0.3});fr(fc,"gap",{width:1,height:6});
for(const [i,l,n,a] of [["images","All media",248,true],["folder","Products",86],["folder","Blog",64],["folder","Team",12],["folder","Weddings",41],["file-text","Documents",9],["folder-plus","New folder"]]){const row=nav(fc,i,l,{active:!!a,badge:n});}
vsp(fc);
const st=fr(fc,"Storage",{layout:"vertical",width:"fill_container",gap:8,padding:12,cornerRadius:8,stroke:"$border",strokeWidth:1,fill:"$bg"});
const sh=fr(st,"h",{width:"fill_container",alignItems:"center",gap:6});tx(sh,"Storage",{fontWeight:"500"});sp(sh);badge(sh,"Placeholder","warn");
const bar=fr(st,"Bar",{width:"fill_container",height:6,cornerRadius:999,fill:"$muted"});fr(bar,"Fill",{width:62,height:6,cornerRadius:999,fill:"$primary"});
tx(st,"1.2 GB of 5 GB",{fontSize:12,fill:"$muted-fg"});
tx(st,"Backend and quotas not decided yet",{fontSize:11,fill:"$muted-fg",textGrowth:"fixed-width",width:"fill_container"});
// grid column
const g=fr(body,"Grid column",{layout:"vertical",width:"fill_container",height:"fill_container",padding:[20,24],gap:16});
const hd=fr(g,"Header",{width:"fill_container",alignItems:"center",gap:10});const tb=fr(hd,"Title",{layout:"vertical",gap:2,width:"fill_container"});tx(tb,"Media",{fontSize:22,fontWeight:"600"});tx(tb,"248 files · images, documents and video",{fill:"$muted-fg"});btn(hd,"Upload",{kind:"primary",icon:"upload"});
const tl=fr(g,"Toolbar",{width:"fill_container",gap:8,alignItems:"center"});input(tl,"Search name or alt text",{icon:"search",width:230});
const seg=fr(tl,"Type filter",{padding:3,gap:2,cornerRadius:8,fill:"$muted"});["All","Images","Documents","Video"].forEach((t,i)=>{const b=fr(seg,"Seg "+t,{padding:[4,10],cornerRadius:6,...(i==0?{fill:"$bg"}:{})});tx(b,t,{fontSize:12,fontWeight:"500",fill:i==0?"$fg":"$muted-fg"});});
sp(tl);btn(tl,null,{icon:"arrow-down-up"});btn(tl,null,{icon:"layout-grid"});btn(tl,null,{icon:"list",kind:"ghost"});
const dz=fr(g,"Drop zone",{width:"fill_container",height:56,cornerRadius:10,stroke:"$border",strokeWidth:1,fill:"$sidebar",alignItems:"center",justifyContent:"center",gap:8});ic(dz,"cloud-upload");tx(dz,"Drop files anywhere to upload",{fill:"$muted-fg"});tx(dz,"· JPG, PNG, WebP, AVIF, SVG, PDF, MP4",{fontSize:12,fill:"$muted-fg"});
const tiles=[["Sourdough loaf","sourdough-loaf.jpg","#E7C9A0","image",1],["Croissants","croissants-tray.jpg","#F2D6A2","image"],["Wedding cake","wedding-3-tier.jpg","#F5E6E0","image"],["Shop front","shop-front.webp","#C9D6DF","image"],["Head baker","head-baker.jpg","#D8C3B0","image"],["Rye","rye-bread.avif","#B89878","image"],["Allergens","allergen-guide.pdf","$muted","file-text"],["Spring menu","spring-menu-2027.pdf","$muted","file-text"],["Oven video","behind-the-ovens.mp4","#3F3F46","video"],["Gluten free","gf-range.jpg","#EADBC0","image"],["Cupcakes","cupcakes.jpg","#F3C4CF","image"],["Logo","acme-bakery-logo.svg","#FFF7ED","image"]];
const grid=fr(g,"Grid",{layout:"vertical",width:"fill_container",gap:14});
for(let rI=0;rI<3;rI++){const row=fr(grid,"Row",{width:"fill_container",gap:14});for(let c=0;c<4;c++){const t=tiles[rI*4+c];const sel=t[4];const tile=fr(row,"Tile "+t[0],{layout:"vertical",width:"fill_container",gap:6});const th=fr(tile,"Thumb",{width:"fill_container",height:118,cornerRadius:10,fill:t[2],alignItems:"center",justifyContent:"center",...(sel?{stroke:"$primary",strokeWidth:2}:{stroke:"$border",strokeWidth:1})});ic(th,t[3],{width:28,height:28,fill:t[3]=="video"?"#FFFFFF":"#00000040"});if(sel){const ck=fr(th,"Sel",{width:20,height:20,cornerRadius:999,fill:"$primary",alignItems:"center",justifyContent:"center",layoutPosition:"absolute",x:8,y:8});ic(ck,"check",{width:12,height:12,fill:"$primary-fg"});}
const cap=fr(tile,"Caption",{width:"fill_container",gap:4,alignItems:"center"});tx(cap,t[1],{fontSize:12,fontWeight:sel?"600":"400",fill:sel?"$fg":"$muted-fg"});}}
// detail panel
const dp=fr(body,"Detail panel",{layout:"vertical",width:320,height:"fill_container",padding:20,gap:14,stroke:"$border",strokeWidth:{left:1},fill:"$bg"});
const dh=fr(dp,"Head",{width:"fill_container",alignItems:"center"});tx(dh,"Details",{fontSize:15,fontWeight:"600"});sp(dh);ic(dh,"x");
const pv=fr(dp,"Preview",{width:"fill_container",height:170,cornerRadius:10,fill:"#E7C9A0",alignItems:"center",justifyContent:"center"});ic(pv,"image",{width:36,height:36,fill:"#00000040"});
const meta=fr(dp,"Meta",{layout:"vertical",width:"fill_container",gap:6});tx(meta,"sourdough-loaf.jpg",{fontWeight:"600"});
for(const [k,v] of [["Size","1.8 MB"],["Dimensions","2400 × 1600"],["Uploaded","12 Mar by Giulia Romano"]]){const rw=fr(meta,"Meta "+k,{width:"fill_container"});tx(rw,k,{fontSize:12,fill:"$muted-fg"});sp(rw);tx(rw,v,{fontSize:12});}
hr(dp);
const al=fr(dp,"Alt text",{layout:"vertical",width:"fill_container",gap:8});const alh=fr(al,"h",{width:"fill_container",alignItems:"center",gap:6});tx(alh,"Alt text",{fontWeight:"500"});badge(alh,"Translatable","outline");sp(alh);
const lt=fr(al,"Lang tabs",{padding:3,gap:2,cornerRadius:8,fill:"$muted"});[["EN",1],["IT",0],["DE",0]].forEach(([t,a])=>{const b=fr(lt,"Lang "+t,{padding:[3,10],cornerRadius:6,gap:4,alignItems:"center",...(a?{fill:"$bg"}:{})});tx(b,t,{fontSize:12,fontWeight:"600",fill:a?"$fg":"$muted-fg"});if(t=="DE")Insert(b,{type:"ellipse",name:"dot",width:6,height:6,fill:"$warn"});});
const ta=fr(al,"Textarea",{width:"fill_container",height:56,padding:10,cornerRadius:8,stroke:"$border",strokeWidth:1});tx(ta,"A round sourdough loaf with a dark, blistered crust on a floured board.",{textGrowth:"fixed-width",width:"fill_container",lineHeight:1.4});
const ai=fr(al,"AI row",{width:"fill_container",gap:6,alignItems:"center"});ic(ai,"sparkles",{width:13,height:13});tx(ai,"DE missing · Translate now",{fontSize:12,fill:"$muted-fg"});
hr(dp);
const us=fr(dp,"Used in",{layout:"vertical",width:"fill_container",gap:6});tx(us,"Used in 3 Entries",{fontWeight:"500"});
for(const e of ["Our sourdough starter, explained · Blog post","Sourdough loaf · Product","Home · Page"]){const rw=fr(us,"Use",{width:"fill_container",gap:6,alignItems:"center"});ic(rw,"link",{width:12,height:12});tx(rw,e,{fontSize:12,fill:"$muted-fg"});}
vsp(dp);
const act=fr(dp,"Actions",{width:"fill_container",gap:8});btn(act,"Replace file",{icon:"replace"});sp(act);const del=btn(act,"Delete",{icon:"trash-2"});
tx(dp,"Delete is blocked while the file is in use.",{fontSize:11,fill:"$muted-fg"});
Export([r],"png","/tmp/penproto/final/04-media-library");
