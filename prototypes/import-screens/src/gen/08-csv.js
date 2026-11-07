const {r,m}=shellI("Import · 08 CSV import (Owner, from Products)",7,"Products",["Products"],{owner:1,role:"Owner · Acme Ltd"});
const body=fr(m,"Body",{width:"fill_container",height:"fill_container"});
const left=fr(body,"List",{layout:"vertical",width:"fill_container",height:"fill_container",opacity:0.45});
const head=fr(left,"Page header",{width:"fill_container",padding:[24,32,16,32],alignItems:"end",gap:12});const l=fr(head,"T",{layout:"vertical",gap:4,width:"fill_container"});tx(l,"Products",{fontSize:22,fontWeight:"600"});small(l,"48 Entries");btn(head,"Import CSV",{icon:"upload"});btn(head,"New product",{kind:"primary",icon:"plus"});
const W=["fill_container",90,110];const tw=fr(left,"tw",{width:"fill_container",padding:[0,32]});tbl(tw,W,["Title","Price","Status"],[["Sourdough loaf","4.50",c=>badge(c,"Published","success")],["Seeded rye","5.20",c=>badge(c,"Published","success")],["Cinnamon knots","2.80",c=>badge(c,"Draft")],["Focaccia al rosmarino","6.00",c=>badge(c,"Published","success")],["Almond croissant","3.20",c=>badge(c,"Published","success")]]);
const S=fr(body,"Sheet",{layout:"vertical",width:600,height:"fill_container",fill:"$bg",stroke:"$border",strokeWidth:{left:1}});
const sh=fr(S,"h",{width:"fill_container",padding:[18,20],gap:10,alignItems:"center",stroke:"$border",strokeWidth:{bottom:1}});const st=fr(sh,"t",{layout:"vertical",gap:2,width:"fill_container"});tx(st,"Import CSV into Products",{fontSize:16,fontWeight:"600"});small(st,"Rows become Drafts. Nothing goes live until it's published.");btn(sh,null,{icon:"x",kind:"ghost"});
const sb=fr(S,"b",{layout:"vertical",width:"fill_container",height:"fill_container",padding:20,gap:14});
const fl=fr(sb,"File",{width:"fill_container",padding:12,gap:10,cornerRadius:8,stroke:"$border",strokeWidth:1,alignItems:"center"});typeIc(fl,"sheet");const ft=fr(fl,"t",{layout:"vertical",gap:1,width:"fill_container"});tx(ft,"products-autumn.csv",{fontWeight:"500"});small(ft,"52 rows · 7 columns · comma separated · UTF-8");btn(fl,"Change",{kind:"ghost"});
const mt=fr(sb,"Match",{width:"fill_container",gap:12});const mm=fr(mt,"m",{layout:"vertical",gap:6,width:"fill_container"});tx(mm,"Match existing Entries by",{fontWeight:"500"});sel(mm,"SKU",{width:"fill_container"});small(mm,"Matched rows update Entries nobody edited by hand");
tx(sb,"Columns",{fontWeight:"600"});
const CW=[150,24,"fill_container",130];
tbl(sb,CW,["Column","","Field","First row"],[
 [c=>mono(c,"name"),c=>arrow(c),c=>sel(c,"Title",{width:"fill_container"}),c=>small(c,"Pumpkin loaf")],
 [c=>mono(c,"sku"),c=>arrow(c),c=>sel(c,"SKU",{width:"fill_container"}),c=>small(c,"PK-700")],
 [c=>mono(c,"price_eur"),c=>arrow(c),c=>sel(c,"Price",{width:"fill_container"}),c=>small(c,"5.50")],
 [c=>mono(c,"description"),c=>arrow(c),c=>sel(c,"Body",{width:"fill_container"}),c=>small(c,"Roasted pumpkin…")],
 [c=>mono(c,"allergens"),c=>arrow(c),c=>sel(c,"Allergens",{width:"fill_container"}),c=>small(c,"gluten; seeds")],
 [c=>mono(c,"image_url"),c=>arrow(c),c=>sel(c,"Featured image",{width:"fill_container"}),c=>small(c,"https://…/pk.jpg")],
 [c=>mono(c,"internal_note"),c=>arrow(c),c=>sel(c,"Skip",{width:"fill_container"}),c=>small(c,"check stock")],
],{rh:42,dim:[6]});
note(sb,"New Fields can only be added by your agency. Columns without a Field are skipped and listed in the report.",{icon:"lock"});
const pv=fr(sb,"Preview",{width:"fill_container",padding:12,gap:10,cornerRadius:8,fill:"$muted",alignItems:"center"});ic(pv,"list-checks",{fill:"$fg"});tx(pv,"Will create 44 Drafts and update 8 · 2 rows have an invalid price",{fontSize:12,fontWeight:"500",textGrowth:"fixed-width",width:"fill_container"});btn(pv,"See rows",{kind:"ghost"});
vsp(sb);
const fb=fr(sb,"Footer",{width:"fill_container",gap:8});sp(fb);btn(fb,"Cancel",{kind:"ghost"});btn(fb,"Import 52 rows",{kind:"primary",icon:"upload"});
Export([r],"png","/tmp/penproto/import/png/08-csv");
