const {r,m}=shellI("Import · 05 Preview with real Entries",4,"Import",["Import","Old bakery site"]);
wizHead(m,"Old bakery site","WordPress live site · oldsite.acmebakery.ie","Preview",{btns:[["Back",{kind:"ghost"}],["Start import",{kind:"primary",icon:"play"}]]});
const sum=fr(m,"Summary",{width:"fill_container",padding:[12,32],gap:24,alignItems:"center",fill:"$sidebar",stroke:"$border",strokeWidth:{bottom:1}});
for(const [i,t] of [["file-plus","261 Entries as Drafts"],["sparkles","1 new Post Type: Recipes"],["image","812 Media files"],["corner-down-right","140 Redirect rules"],["circle-slash","86 tags, 18 pages and 2 keys skipped"]]){const g=fr(sum,"S "+t,{gap:6,alignItems:"center"});ic(g,i,{width:14,height:14});tx(g,t,{fontSize:12,fontWeight:"500"});}
const body=fr(m,"Body",{width:"fill_container",height:"fill_container"});
const L=fr(body,"List",{layout:"vertical",width:340,height:"fill_container",padding:[14,12],gap:8,stroke:"$border",strokeWidth:{right:1}});
seg(L,["Products","Blog posts","Recipes","Categories"],"Products",{w:1});input(L,"Search 64 products",{icon:"search"});
for(const [t,b,s] of [["Sourdough loaf","",0],["Seeded rye","1 leftover",1],["Cinnamon knots","",0],["Focaccia al rosmarino","",0],["Spelt & honey loaf","2 images not fetched",0],["Almond croissant","",0],["Gluten-free brown bread","",0],["Brioche burger buns","",0]]){const rr=fr(L,"E "+t,{width:"fill_container",padding:[8,10],gap:10,cornerRadius:8,alignItems:"center",...(s?{fill:"$accent"}:{})});fr(rr,"thumb",{width:32,height:32,cornerRadius:6,fill:"#E9DCCB"});const tt=fr(rr,"t",{layout:"vertical",gap:1,width:"fill_container"});tx(tt,t,{fontWeight:"500"});small(tt,"/products/"+t.toLowerCase().replace(/[^a-z]+/g,"-").replace(/-$/,""),{fontSize:11,fontFamily:"Roboto Mono"});if(b)badge(rr,b.includes("leftover")?"1":"!",b.includes("leftover")?"warn":"danger");}
const R=fr(body,"Detail",{layout:"vertical",width:"fill_container",height:"fill_container",padding:[20,28],gap:14,fill:"$canvas"});
const dh=fr(R,"h",{width:"fill_container",gap:10,alignItems:"center"});tx(dh,"Seeded rye",{fontSize:18,fontWeight:"600"});badge(dh,"Will be a Draft","neutral");sp(dh);small(dh,"Source id  wp:product:2214");
const cols=fr(R,"cols",{width:"fill_container",gap:16});
const f=fr(cols,"Fields",{layout:"vertical",width:300,padding:16,gap:10,cornerRadius:10,fill:"$bg",stroke:"$border",strokeWidth:1});tx(f,"Fields",{fontWeight:"600"});
for(const [l,v] of [["Price","5.20"],["SKU","RY-650"],["Allergens","Gluten, Sesame"],["Featured image","seeded-rye.jpg  ✓ fetched"],["SEO title","Seeded rye | Acme Bakery"],["Author name","Mark O'Brien"],["Published","12 Mar 2024"]]){const g=fr(f,"F "+l,{width:"fill_container",gap:8});small(g,l,{width:110,textGrowth:"fixed-width"});tx(g,v,{fontSize:12,textGrowth:"fixed-width",width:"fill_container"});}
const red=fr(f,"Redirect",{layout:"vertical",gap:4,width:"fill_container",padding:[8,0,0,0],stroke:"$border",strokeWidth:{top:1}});small(red,"Redirect rule");mono(red,"/shop/seeded-rye-loaf/");mono(red,"→ /products/seeded-rye");
const bd=fr(cols,"Body",{layout:"vertical",width:"fill_container",padding:16,gap:10,cornerRadius:10,fill:"$bg",stroke:"$border",strokeWidth:1});
const bh=fr(bd,"h",{width:"fill_container",alignItems:"center",gap:8});tx(bh,"Body",{fontWeight:"600"});small(bh,"6 Blocks");sp(bh);seg(bh,["Blocks","Original HTML"],"Blocks");
const blk=(k,t,o={})=>{const b=fr(bd,"B "+k,{width:"fill_container",gap:10,padding:[6,8],cornerRadius:6,alignItems:"start",...(o.warn?{fill:"$warn-bg"}:{})});const kk=fr(b,"k",{width:80});mono(kk,k,{fs:10});tx(b,t,{fontSize:o.h?15:13,fontWeight:o.h?"600":"400",textGrowth:"fixed-width",width:"fill_container",lineHeight:1.45,...(o.warn?{fill:"$warn"}:{})});};
blk("paragraph","A dense, dark loaf packed with sunflower, pumpkin and flax seeds. We soak the seeds overnight so the crumb stays moist for days.");
blk("heading 2","How we bake it",{h:1});
blk("list","• 40% wholegrain rye  • 24-hour soaker  • Baked in tins at 210°C");
blk("image","seeded-rye-crumb.jpg  ·  alt “Slice of seeded rye showing the crumb”");
blk("paragraph","[product_gallery ids=\"2215,2216,2217\" columns=\"3\"]",{warn:1});
blk("quote","“The best rye in Dublin.” (a regular)");
warnNote(bd,"Import leftover: a shortcode the importer can't read was kept as plain text. Fix it after the run; it's listed in the Import report.");
Export([r],"png","/tmp/penproto/import/png/05-preview");
