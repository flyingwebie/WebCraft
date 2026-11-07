const r=screen("Filters · 03 Layout presets",0,2200,{w:1600,h:1000});sidebarA(r,SITE_F());const m=mainCol(r);topbarA(m,["Acme Ltd","Acme Bakery","Filters","Shop filter"]);
fHeader(m,{tab:"Layout",mode:"On submit"});
const body=fr(m,"Builder body",{width:"fill_container",height:"fill_container"});
const lp=fr(body,"Layout panel",{layout:"vertical",width:380,height:"fill_container",padding:20,gap:14,fill:"$sidebar",stroke:"$border",strokeWidth:{right:1}});
tx(lp,"LAYOUT PRESET",{fontSize:11,fontWeight:"500",fill:"$muted-fg",letterSpacing:0.3});
function preset(p,name,desc,kind,sel){const c=fr(p,"Preset "+name,{width:"fill_container",padding:12,gap:12,cornerRadius:10,fill:"$bg",alignItems:"center",...(sel?{stroke:"$primary",strokeWidth:2}:{stroke:"$border",strokeWidth:1})});
 const th=fr(c,"Thumb",{width:92,height:62,cornerRadius:6,fill:SC.bg,stroke:SC.line,strokeWidth:1,padding:6,gap:4,layout:kind=="top"?"vertical":"horizontal"});
 if(kind=="side"){fr(th,"f",{width:22,height:"fill_container",cornerRadius:3,fill:SC.accSoft});const g=fr(th,"g",{layout:"vertical",width:"fill_container",gap:3});for(let i=0;i<3;i++)fr(g,"r",{width:"fill_container",height:14,cornerRadius:2,fill:SC.surf});}
 else if(kind=="top"){const t=fr(th,"t",{width:"fill_container",gap:3});for(let i=0;i<4;i++)fr(t,"b",{width:"fill_container",height:8,cornerRadius:999,fill:SC.accSoft});for(let i=0;i<2;i++){const rw=fr(th,"r",{width:"fill_container",gap:3});for(let j=0;j<3;j++)fr(rw,"c",{width:"fill_container",height:16,cornerRadius:2,fill:SC.surf});}}
 else {const ph=fr(th,"ph",{layout:"vertical",width:34,height:"fill_container",cornerRadius:4,stroke:SC.line,strokeWidth:1,padding:3,gap:2});fr(ph,"btn",{width:"fill_container",height:6,cornerRadius:999,fill:SC.ink});fr(ph,"c",{width:"fill_container",height:"fill_container",fill:SC.surf});const dr=fr(th,"dr",{layout:"vertical",width:34,height:"fill_container",cornerRadius:4,fill:SC.accSoft,padding:3,gap:2});for(let i=0;i<4;i++)fr(dr,"l",{width:"fill_container",height:4,fill:SC.line});}
 const t=fr(c,"T",{layout:"vertical",gap:3,width:"fill_container"});const tl=fr(t,"l",{gap:6,alignItems:"center"});tx(tl,name,{fontWeight:"600"});if(sel)badge(tl,"In use","success");tx(t,desc,{fontSize:12,fill:"$muted-fg",textGrowth:"fixed-width",width:"fill_container"});return c;}
preset(lp,"Sidebar","Controls stacked beside the results. Good for many controls.","side",false);
preset(lp,"Top bar","One row of dropdown buttons above the results. Good for 2–5 controls.","top",true);
preset(lp,"Phone drawer","A Filters button that opens a drawer with Apply. Phones only.","drawer",false);
hr(lp);
field(lp,"On phones (under 768 px)","Phone drawer",{trail:"chevron-down",hint:"Any preset can switch to the drawer on small screens"});
const own=fr(lp,"Own element tree",{layout:"vertical",gap:8,width:"fill_container"});tx(own,"Element tree",{fontWeight:"500"});tx(own,"The preset is a starting point. Its elements, Classes and design tokens are edited in the visual builder like any Component.",{fontSize:12,fill:"$muted-fg",textGrowth:"fixed-width",width:"fill_container",lineHeight:1.4});btn(own,"Open in visual builder",{icon:"square-pen"});
note(lp,"Controls can also be placed one by one anywhere on the page, e.g. the search box in the header.",{icon:"move"});
const br=previewPane(body,{url:"acmebakery.ie/shop?category=bread,pastries"});const pin=fr(br,"Page",{layout:"vertical",width:"fill_container",height:"fill_container",clip:true});siteNav(pin,{px:32});
const pc=fr(pin,"Shop body",{layout:"vertical",width:"fill_container",padding:[24,32],gap:18});
stx(pc,"Shop",{fontSize:28,fontWeight:"800"});
const bar=fr(pc,"Filter (top bar preset)",{width:"fill_container",gap:10,alignItems:"center"});sSearch(bar,"",{w:220});sBtn(bar,"Category",{chev:true,count:2});sBtn(bar,"Dietary",{chev:true});sBtn(bar,"Price",{chev:true});sp(bar);sBtn(bar,"Sort: Popular",{chev:true});
grid(pc,4,PRODUCTS.slice(0,8),{ih:110,fs:13,gap:16});
Export([r],"png","/tmp/penproto/filter/png/03-layout");
