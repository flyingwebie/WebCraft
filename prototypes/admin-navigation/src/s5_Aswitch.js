const r=screen("Variant A · Switcher open",1540,1000);sidebarA(r,SITE_A("Blog posts"));const m=mainCol(r);topbarA(m,["Acme Ltd","Acme Bakery","Blog posts"]);entries(m);
const pop=fr(r,"Switcher popover",{layoutPosition:"absolute",x:12,y:68,width:560,layout:"vertical",fill:"$bg",cornerRadius:10,stroke:"$border",strokeWidth:1,clip:true,effect:{type:"shadow",offset:{x:0,y:12},blur:32,color:"#0000002E"}});
const top=fr(pop,"Install row",{width:"fill_container",padding:[10,12],gap:10,alignItems:"center",fill:"$sidebar",stroke:"$border",strokeWidth:{bottom:1}});ic(top,"shield");tx(top,"Northwind Studio",{fontWeight:"500"});badge(top,"Install","outline");sp(top);tx(top,"Superadmin area →",{fontSize:12,fill:"$muted-fg"});
const cols=fr(pop,"Columns",{width:"fill_container"});
const c1=fr(cols,"Workspaces column",{layout:"vertical",width:"fill_container",padding:8,gap:2,stroke:"$border",strokeWidth:{right:1}});
input(c1,"Find Workspace",{icon:"search"});tx(c1,"Workspaces",{fontSize:11,fontWeight:"500",fill:"$muted-fg"});
for(const [a,n,f,on] of [["AC","Acme Ltd","#D97706",1],["NB","Nimbus Bikes","#059669"],["VT","Verde Travel","#7C3AED"],["OS","Oakfield School","#DB2777"]]){const row=fr(c1,"WS "+n,{width:"fill_container",height:34,padding:[0,8],gap:8,alignItems:"center",cornerRadius:6,...(on?{fill:"$accent"}:{})});avatar(row,a,{square:true,size:22,fill:f,fs:9});tx(row,n,{fontWeight:on?"500":"400"});sp(row);if(on)ic(row,"chevron-right",{width:14,height:14});}
nav(c1,"plus","New Workspace");
const c2=fr(cols,"Sites column",{layout:"vertical",width:"fill_container",padding:8,gap:2});
tx(c2,"Sites in Acme Ltd",{fontSize:11,fontWeight:"500",fill:"$muted-fg"});
for(const [n,d,on,s] of [["Acme Bakery","acmebakery.ie",1,"success"],["Acme Careers","careers.acme.ie",0,"success"],["Acme Catering","acmecatering.ie",0,"warn"]]){const row=fr(c2,"Site "+n,{width:"fill_container",padding:[6,8],gap:8,alignItems:"center",cornerRadius:6,...(on?{fill:"$accent"}:{})});const cc=fr(row,"Names",{layout:"vertical",width:"fill_container",gap:1});tx(cc,n,{fontWeight:"500"});tx(cc,d,{fontSize:12,fill:"$muted-fg"});if(s=="warn")badge(row,"DNS","warn");if(on)ic(row,"check",{width:14,height:14,fill:"$fg"});}
nav(c2,"plus","New Site");hr(c2);nav(c2,"building-2","Workspace settings");
Export([r],"png","/tmp/penproto/out");
