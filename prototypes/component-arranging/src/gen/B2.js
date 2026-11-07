const {r,vp}=chrome(1,1,"B2 · Layout drawer · add a Component",{count:2,layoutBtn:"on"});
const DW=380;layoutPage(vp,SW-DW,{bakes:"hint"},{x:DW,scroll:300,slotBefore:["quote","drop","New component goes here"]});
const {b}=drawer(vp,DW,"Add component","Allowed on this Site by Northwind Studio",{back:true,icon:"plus"});
const pos=fr(b,"Position",{width:"fill_container",gap:8,alignItems:"center",padding:[0,0,6,0]});tx(pos,"Goes after",{fill:"$muted-fg"});input(pos,"Product grid",{value:true,trail:"chevrons-up-down"});
input(b,"Search components",{icon:"search"});
for(const [k,n,d] of LIB.slice(0,8)){const row=fr(b,"Lib row "+n,{width:"fill_container",padding:[6,8],gap:10,alignItems:"center",cornerRadius:8,...(n=="Customer quote"?{fill:BR+"12"}:{})});thumb(row,k,64,38,{r:4});const t=fr(row,"T",{layout:"vertical",gap:1,width:"fill_container"});tx(t,n,{fontWeight:"600"});tx(t,d,{fontSize:11,fill:"$muted-fg"});btn(row,null,{icon:"plus"});}
tx(b,"Showing 10 of 10 · drag a row onto the page to place it anywhere",{fontSize:11,fill:"$muted-fg"});
Export([r],"png",OUT+"B2");
