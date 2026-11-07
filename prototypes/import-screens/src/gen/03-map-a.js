const {r,m}=shellI("Import · 03 Map A (table, keys below)",2,"Import",["Import","Old bakery site"]);
wizHead(m,"Old bakery site","WordPress live site · oldsite.acmebakery.ie","Map",{btns:[["Back",{kind:"ghost"}],["Preview",{kind:"primary",icon:"arrow-right"}]]});
const body=fr(m,"Body",{layout:"vertical",width:"fill_container",height:"fill_container",padding:[20,32],gap:14,fill:"$sidebar"});
const h1=fr(body,"h",{width:"fill_container",alignItems:"center",gap:8});tx(h1,"Content types",{fontSize:15,fontWeight:"600"});small(h1,"Only types found on the site are listed");
const W=[230,70,24,300,"fill_container"];
const tgt=(c,v,o={})=>{sel(c,v,{width:"fill_container",icon:o.icon});};
tbl(body,W,["Source type","Found","","Goes into",""],[
 [c=>{typeIc(c,"newspaper");tx(c,"Posts",{fontWeight:"500"});},"142",c=>arrow(c),c=>tgt(c,"Blog posts",{icon:"database"}),c=>small(c,"Body → Body field · 9 keys mapped")],
 [c=>{typeIc(c,"shopping-basket");tx(c,"Products");mono(c,"product");},"64",c=>arrow(c),c=>tgt(c,"Products",{icon:"database"}),c=>{badge(c,"3 keys to check","warn");}],
 [c=>{typeIc(c,"chef-hat");tx(c,"Recipes");mono(c,"recipe");},"37",c=>arrow(c),c=>tgt(c,"+ Create Post Type “Recipes”",{icon:"sparkles"}),c=>small(c,"New: title, slug and Body field")],
 [c=>{typeIc(c,"file-text");tx(c,"Pages");},"18",c=>arrow(c),c=>tgt(c,"Leave unmapped",{icon:"circle-slash"}),c=>small(c,"Rebuild in the visual builder · Redirect rules still made")],
 [c=>{typeIc(c,"folder-tree");tx(c,"Categories");},"12",c=>arrow(c),c=>tgt(c,"Categories",{icon:"database"}),c=>small(c,"Linked to Blog posts by the Category Relationship")],
 [c=>{typeIc(c,"tag");tx(c,"Tags");},"86",c=>arrow(c),c=>tgt(c,"Skip",{icon:"circle-slash"}),c=>small(c,"Listed in the report")],
 [c=>{typeIc(c,"image");tx(c,"Media");},"812",c=>arrow(c),c=>tgt(c,"Media library",{icon:"image"}),c=>small(c,"Featured images, alt text, captions")],
 [c=>{typeIc(c,"user");tx(c,"Authors");},"5",c=>arrow(c),c=>tgt(c,"Text Field “Author name”",{icon:"type"}),c=>small(c,"Authors never become Members")],
],{sel:1,dim:[3,5],rh:46});
const kc=fr(body,"Keys card",{layout:"vertical",width:"fill_container",cornerRadius:10,stroke:"$border",strokeWidth:1,fill:"$bg",clip:true});
const kh=fr(kc,"h",{width:"fill_container",padding:[12,16],gap:10,alignItems:"center",stroke:"$border",strokeWidth:{bottom:1}});ic(kh,"shopping-basket",{fill:"$fg"});tx(kh,"Products · fields",{fontWeight:"600"});small(kh,"11 keys found in 64 products");sp(kh);seg(kh,["All 11","To check 3","Skipped 2"],"All 11");
const KW=[220,90,24,240,"fill_container"];
const kt=fr(kc,"rows",{layout:"vertical",width:"fill_container"});
const rows=[["title / content","64/64","Title + Body",null,"“Sourdough loaf” · 412 words"],["_price","64/64","Price  (Number)",null,"4.50"],["_sku","64/64","SKU  (Text)",null,"SD-800"],["allergens","61/64","? Choose a Field","warn","gluten, sesame"],["_seo_meta_description","58/64","SEO description",null,"Slow-fermented for 36 hours…"],["_thumbnail_id","64/64","Featured image",null,"sourdough.jpg"],["_edit_lock","64/64","Skip","skip","1730912345:1"]];
for(const [k,f,to,st,ex] of rows){const rr=fr(kt,"K "+k,{width:"fill_container",height:40,padding:[0,16],gap:12,alignItems:"center",stroke:"$border",strokeWidth:{top:1},...(st=="skip"?{opacity:0.55}:{})});const a=fr(rr,"c",{width:KW[0]});mono(a,k);const b=fr(rr,"c",{width:KW[1]});small(b,f);const c=fr(rr,"c",{width:KW[2]});arrow(c);const d=fr(rr,"c",{width:KW[3]});const s=input(d,to,{value:st!="warn",trail:"chevron-down",width:"fill_container"});if(st=="warn"){s.stroke="$warn";}const e=fr(rr,"c",{width:KW[4],gap:6,alignItems:"center"});small(e,"e.g.");tx(e,ex,{fontSize:12});}
Export([r],"png","/tmp/penproto/import/png/03-map-a");
