const r=Insert(document,{type:"frame",name:"Filters · 05 On the Site · On submit mode (top bar)",x:1700,y:1100,width:1440,height:1000,fill:"$canvas",layout:"vertical",padding:24,gap:16,clip:true});
const br=browser(r,"acmebakery.ie/shop?category=bread",{h:740});
const stage=fr(br,"Stage",{layout:"none",width:"fill_container",height:"fill_container",clip:true});const pin=Insert(stage,{type:"frame",name:"Page",x:0,y:0,width:1392,height:704,layout:"vertical",clip:true});siteNav(pin,{});
const pc=fr(pin,"Shop body",{layout:"vertical",width:"fill_container",padding:[32,40],gap:18});stx(pc,"Shop",{fontSize:34,fontWeight:"800"});
const bar=fr(pc,"Filter (top bar preset)",{width:"fill_container",gap:10,alignItems:"center"});sSearch(bar,"",{w:240});const cat=sBtn(bar,"Category",{chev:true,count:2});sBtn(bar,"Dietary",{chev:true});sBtn(bar,"Price",{chev:true});sp(bar);sBtn(bar,"Sort: Popular",{chev:true});
const rh=fr(pc,"Results head",{width:"fill_container",gap:12,alignItems:"center"});stx(rh,"12 products",{fontSize:15,fontWeight:"600"});const pd=fr(rh,"Pending",{padding:[3,8],cornerRadius:999,fill:"#FEF3C7"});tx(pd,"1 change not applied",{fontSize:12,fontWeight:"600",fill:"#92400E"});
const wrap=fr(pc,"Results wrap",{width:"fill_container",height:"fill_container"});grid(wrap,4,PRODUCTS.slice(0,8),{ih:120,gap:18});
// dropdown popover (absolute)
const pop=Insert(stage,{type:"frame",name:"Category dropdown (open)",x:314,y:226,width:300,layout:"vertical",padding:16,gap:6,cornerRadius:14,fill:SC.white,stroke:SC.line,strokeWidth:1,effect:{type:"shadow",shadowType:"outer",color:"#2B1D1426",offset:{x:0,y:12},blur:32}});
stx(pop,"Category",{fontSize:15,fontWeight:"700"});sCheck(pop,"Bread",12,true);sCheck(pop,"Pastries",9,true);sCheck(pop,"Cakes",6,false);sCheck(pop,"Gluten-free",4,false);
const pf=fr(pop,"Foot",{width:"fill_container",gap:8,padding:[10,0,0,0]});sBtn(pf,"Reset",{w:"fill_container",h:36});sBtn(pf,"Apply",{primary:true,w:"fill_container",h:36});
const cs=fr(r,"Callouts",{width:"fill_container",gap:12});
callout(cs,1,"Nothing changes until Apply","Ticking Pastries marks the bar as changed. Results, address and counts update only when Apply is pressed, still without a reload.");
callout(cs,2,"Same URL, same server","Live and On submit fetch the same URL and swap the same fragments. Only the moment of fetching differs.");
callout(cs,3,"Top bar preset","Each control is a dropdown button showing how many options are picked. Sort sits at the right.");
Export([r],"png","/tmp/penproto/filter/png/05-site-submit");
