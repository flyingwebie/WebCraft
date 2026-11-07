const {r,vp}=chrome(1,0,"A2 · On the page · add a Component",{count:2});
const E=layoutPage(vp,SW,{header:"lock",hero:"hint",bakes:"hint"},{slotBefore:["bakes","drop","New component goes here"]});
const c=pop(vp,"Add a component",{x:SW/2-350,y:150,w:700});panelHead(c,"plus","Add a component","Goes after Hero split · drag a card onto the page to place it elsewhere");
const b=fr(c,"Body",{layout:"vertical",width:"fill_container",padding:16,gap:12});input(b,"Search components",{icon:"search"});chips(b,["All","Text","Media","Lists","Calls to action"],"All");
libGrid(b,5,LIB,{on:"Customer quote"});
lockNote(b,"Only the Components Northwind Studio allows on this Site are listed. The header, footer and page design are part of the template and stay as they are.");
Export([r],"png",OUT+"A2");
