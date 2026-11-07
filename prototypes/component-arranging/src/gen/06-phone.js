const r=Insert(document,{type:"frame",name:"Filters · 06 On the Site · Phone drawer",x:1700,y:2200,width:1440,height:1000,fill:"$canvas",layout:"vertical",padding:24,gap:20,clip:true});
const row=fr(r,"Phones",{width:"fill_container",gap:40,justifyContent:"center"});
function phone(p,title){const w=fr(p,"Phone "+title,{layout:"vertical",gap:10,alignItems:"center"});tx(w,title,{fontWeight:"600"});const ph=fr(w,"Device",{layout:"vertical",width:360,height:740,cornerRadius:36,stroke:"#18181B",strokeWidth:8,fill:SC.bg,clip:true});return ph;}
// 1 closed
const p1=phone(row,"1 · Results, drawer closed");siteNav(p1,{small:1,px:18,h:56});const b1=fr(p1,"Body",{layout:"vertical",width:"fill_container",padding:[16,18],gap:14});stx(b1,"Shop",{fontSize:26,fontWeight:"800"});sSearch(b1,"");
const tb=fr(b1,"Bar",{width:"fill_container",gap:8});sBtn(tb,"Filters",{icon:"sliders-horizontal",count:4,w:"fill_container",h:38});sBtn(tb,"Sort",{icon:"arrow-up-down",w:"fill_container",h:38});
stx(b1,"14 products",{fontSize:14,fontWeight:"600"});grid(b1,2,PRODUCTS.slice(0,4),{ih:100,fs:13,gap:12});
// 2 drawer open
const p2=phone(row,"2 · Drawer open");const sc=fr(p2,"Dim",{layout:"vertical",width:"fill_container",height:"fill_container",fill:"#2B1D1499",justifyContent:"end"});
const dr=fr(sc,"Drawer",{layout:"vertical",width:"fill_container",height:640,fill:SC.bg,cornerRadius:[20,20,0,0]});
const dh=fr(dr,"Head",{width:"fill_container",padding:[16,18],alignItems:"center",stroke:SC.line,strokeWidth:{bottom:1}});stx(dh,"Filters",{fontSize:18,fontWeight:"800"});sp(dh);ic(dh,"x",{width:20,height:20,fill:SC.ink});
const db=fr(dr,"Controls",{layout:"vertical",width:"fill_container",height:"fill_container",padding:[14,18],gap:14,clip:true});
const g1=sGroup(db,"Category");sCheck(g1,"Bread",12,true);sCheck(g1,"Pastries",9,true);sCheck(g1,"Cakes",6,false);
const g2=sGroup(db,"Dietary");sToggle(g2,"Vegan only",true);const g3=sGroup(db,"Price",{last:1});sRange(g3,"€2","€10");
const df=fr(dr,"Sticky footer",{width:"fill_container",padding:[12,18,22,18],gap:10,stroke:SC.line,strokeWidth:{top:1}});sBtn(df,"Reset",{w:110});sBtn(df,"Show 14 products",{primary:true,w:"fill_container"});
// 3 no results
const p3=phone(row,"3 · No results");siteNav(p3,{small:1,px:18,h:56});const b3=fr(p3,"Body",{layout:"vertical",width:"fill_container",padding:[16,18],gap:14});stx(b3,"Shop",{fontSize:26,fontWeight:"800"});sSearch(b3,"rye cake");
const tb3=fr(b3,"Bar",{width:"fill_container",gap:8});sBtn(tb3,"Filters",{icon:"sliders-horizontal",count:2,w:"fill_container",h:38});sBtn(tb3,"Sort",{icon:"arrow-up-down",w:"fill_container",h:38});
const chips=fr(b3,"Chips",{gap:8});sChip(chips,"Cakes");sChip(chips,"Vegan");
const nr=fr(b3,"No results",{layout:"vertical",width:"fill_container",padding:[40,12],gap:10,alignItems:"center"});ic(nr,"search-x",{width:36,height:36,fill:SC.soft});stx(nr,"No products match",{fontSize:17,fontWeight:"700"});tx(nr,"Try removing a filter or searching for something else.",{fontSize:13,fill:SC.soft,textGrowth:"fixed-width",width:260,textAlign:"center"});sBtn(nr,"Clear all filters",{});
const cap=fr(nr,"Content tag",{padding:[2,8],cornerRadius:999,fill:"$info-bg"});tx(cap,"No-results text is Content",{fontSize:11,fill:"$info"});
Export([r],"png","/tmp/penproto/filter/png/06-phone");
