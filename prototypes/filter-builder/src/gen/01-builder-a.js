const r=screen("Filters · 01 Builder A (list | settings | preview)",0,0,{w:1600,h:1000});sidebarA(r,SITE_F());const m=mainCol(r);topbarA(m,["Acme Ltd","Acme Bakery","Filters","Shop filter"]);
fHeader(m,{});
const body=fr(m,"Builder body",{width:"fill_container",height:"fill_container"});
const list=fr(body,"Control list",{layout:"vertical",width:270,height:"fill_container",padding:[16,12],gap:6,fill:"$sidebar",stroke:"$border",strokeWidth:{right:1}});
const lh=fr(list,"h",{width:"fill_container",alignItems:"center"});tx(lh,"CONTROLS",{fontSize:11,fontWeight:"500",fill:"$muted-fg",letterSpacing:0.3});sp(lh);btn(lh,"Add",{icon:"plus",kind:"ghost"});
CONTROLS.forEach((c,i)=>ctrlRow(list,c,i==1));
fr(list,"g",{width:1,height:6});note(list,"Options inside a control match ANY (OR). Controls combine with AND.",{icon:"git-merge"});
vsp(list);
const add=fr(list,"Add menu hint",{layout:"vertical",width:"fill_container",padding:10,gap:6,cornerRadius:8,stroke:"$border",strokeWidth:1,fill:"$bg"});tx(add,"Add control",{fontSize:12,fontWeight:"600"});
for(const [i,l] of [["search","Search box"],["list-checks","Checkboxes"],["circle-dot","Radio or select"],["toggle-right","Toggle"],["move-horizontal","Range"],["arrow-up-down","Sort"],["x-circle","Active filters & Reset"],["hash","Result count"]]){const it=fr(add,"A "+l,{gap:8,alignItems:"center"});ic(it,i,{width:13,height:13});tx(it,l,{fontSize:12,fill:"$muted-fg"});}
// settings
const st=fr(body,"Control settings",{layout:"vertical",width:340,height:"fill_container",padding:20,gap:14,stroke:"$border",strokeWidth:{right:1},fill:"$bg"});
const sh=fr(st,"h",{width:"fill_container",alignItems:"center",gap:8});ic(sh,"list-checks",{width:16,height:16,fill:"$fg"});tx(sh,"Category",{fontSize:15,fontWeight:"600"});sp(sh);badge(sh,"Checkboxes");
field(st,"Source Field","Category  (Relationship → Categories)",{trail:"chevron-down",hint:"Choice Field, Relationship or Post Type"});
field(st,"Label","Category",{hint:"Content: clients can edit and translate it"});
const uk=fr(st,"URL key",{layout:"vertical",gap:6,width:"fill_container"});tx(uk,"URL key",{fontWeight:"500"});input(uk,"category",{value:1});const ukh=fr(uk,"eg",{gap:4,alignItems:"center"});tx(ukh,"Same in every language ·",{fontSize:12,fill:"$muted-fg"});mono(ukh,"?category=bread,pastries");
const cb=fr(st,"Combine",{layout:"vertical",gap:6,width:"fill_container"});tx(cb,"Match options",{fontWeight:"500"});seg(cb,["Any (OR)","All (AND)"],"Any (OR)",{w:1});
hr(st);
const ct=fr(st,"Counts",{layout:"vertical",gap:4,width:"fill_container"});const cth=fr(ct,"h",{width:"fill_container",alignItems:"center"});tx(cth,"Show counts",{fontWeight:"500"});sp(cth);toggle(cth,true);tx(ct,"Counts ignore this control's own selection, so ticking Bread doesn't zero Pastries.",{fontSize:12,fill:"$muted-fg",textGrowth:"fixed-width",width:"fill_container"});
const em=fr(st,"Empty",{layout:"vertical",gap:6,width:"fill_container"});tx(em,"Options with no results",{fontWeight:"500"});seg(em,["Hide","Disable","Show"],"Disable",{w:1});
const sm=fr(st,"More",{width:"fill_container",gap:10});field(sm,"Show first","10",{width:"fill_container"});field(sm,"Order","By count",{trail:"chevron-down",width:"fill_container"});
tx(st,"Longer lists end in \"Show more\".",{fontSize:12,fill:"$muted-fg"});
// preview
const br=previewPane(body,{});const pin=fr(br,"Page",{layout:"vertical",width:"fill_container",height:"fill_container",clip:true});siteNav(pin,{px:28});
const pc=fr(pin,"Shop body",{width:"fill_container",padding:[24,28],gap:28});sidebarFilter(pc,{w:220,selCat:1});
const res=fr(pc,"Results",{layout:"vertical",width:"fill_container",gap:16});resultsHead(res,"14 products");grid(res,3,PRODUCTS.slice(0,6),{ih:110,fs:13,gap:16});
Export([r],"png","/tmp/penproto/filter/png/01-builder-a");
