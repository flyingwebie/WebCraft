const {r,vp}=chrome(0,2,"C1 · Arrange mode · drag in from the library",{count:2,modes:["Edit","Arrange","Preview"],mode:"Arrange",canvas:"#E7E5E4"});
const LW=320;const lp=fr(vp,"Library",{layoutPosition:"absolute",x:0,y:0,width:LW,height:SH,layout:"vertical",fill:"$bg",stroke:"$border",strokeWidth:{right:1},padding:14,gap:10});
const lh=fr(lp,"H",{width:"fill_container",alignItems:"center",gap:8});ic(lh,"component",{fill:"$fg"});tx(lh,"Components",{fontWeight:"600",fontSize:14});sp(lh);badge(lh,"10 allowed");
input(lp,"Search",{icon:"search"});libGrid(lp,2,LIB.slice(0,8),{desc:false,tw:128,th:62});
tx(lp,"Drag a card onto the page, or press Enter on it to add it after the selected Component.",{fontSize:11,fill:"$muted-fg",textGrowth:"fixed-width",width:"fill_container",lineHeight:1.4});
const CW2=640,cx0=LW+(SW-LW-CW2)/2;const P=stackCards(vp,cx0,22,CW2,{"Customer quote":"sel","Latest posts":"peer"},{dropBefore:"Product grid"});
vtool(vp,cx0+CW2+14,P["Customer quote"].y);
// dragged library card
const g=fr(vp,"Dragging Gallery",{layoutPosition:"absolute",x:cx0-150,y:P["Product grid"].y-70,layout:"vertical",padding:8,gap:6,cornerRadius:8,fill:"#FFFFFF",stroke:BR,strokeWidth:2,effect:{type:"shadow",offset:{x:0,y:16},blur:32,color:"#00000040"}});thumb(g,"gallery",150,90);tx(g,"Gallery",{fontSize:12,fontWeight:"600"});
ic(vp,"mouse-pointer-2",{layoutPosition:"absolute",x:cx0+10,y:P["Product grid"].y-20,width:22,height:22,fill:"#18181B"});
Export([r],"png",OUT+"C1");
