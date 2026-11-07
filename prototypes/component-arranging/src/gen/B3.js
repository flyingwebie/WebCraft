const {r,vp}=chrome(2,1,"B3 · Layout drawer · Props inline and row menu",{count:3,layoutBtn:"on"});
const DW=380;layoutPage(vp,SW-DW,{quote:"sel",blog:"peer"},{x:DW,scroll:540});
const {b}=drawer(vp,DW,"Page layout","Home · 5 Components");
layRow(b,...ROWS_B[0]);layRow(b,...ROWS_B[1]);
const box=fr(b,"Expanded",{layout:"vertical",width:"fill_container",cornerRadius:8,stroke:BR,strokeWidth:1.5,clip:true});layRow(box,...ROWS_B[2],{open:true});
const pb=fr(box,"Props",{layout:"vertical",width:"fill_container",padding:[4,12,12,12],gap:10});
field(pb,"Name","Aoife Murphy");field(pb,"Line under the name","Customer since 2009");const st=fr(pb,"Style",{layout:"vertical",gap:6,width:"fill_container"});tx(st,"Background",{fontWeight:"500"});segm(st,["Light","Dark"],"Light");
tx(pb,"Quote text and photo are edited on the page.",{fontSize:11,fill:"$muted-fg"});
layRow(b,...ROWS_B[3],{peer:true});layRow(b,...ROWS_B[4]);
// row menu
const m=pop(vp,"Row menu",{x:DW-60,y:250,w:220,pad:6,gap:2});
for(const [i,l,o] of [["arrow-up","Move up"],["arrow-down","Move down"],["arrow-up-to-line","Move to top"],["copy","Duplicate"],["eye-off","Hide on this page"],["trash-2","Remove",1]]){const it=fr(m,"Item "+l,{width:"fill_container",padding:[7,8],gap:8,alignItems:"center",cornerRadius:6,...(l=="Move up"?{fill:"$muted"}:{})});ic(it,i,{width:14,height:14,fill:o?"$danger":"$fg"});tx(it,l,{fill:o?"$danger":"$fg"});}
Export([r],"png",OUT+"B3");
