const {r,vp}=chrome(0,0,"A1 · On the page · arrange with handles",{count:2});
const E=layoutPage(vp,SW,{header:"lock",bakes:"hint",quote:"sel",blog:"peer",hero:"hint"},{scroll:560,slotBefore:["blog","line"]});
// toolbar on the selected Component (top right)
const t=fr(E.quote,"Component toolbar",{layoutPosition:"absolute",x:SW-372,y:-20,height:40,padding:[0,5],gap:2,alignItems:"center",cornerRadius:9,fill:DK,effect:{type:"shadow",offset:{x:0,y:8},blur:24,color:"#00000040"}});
dbtn(t,"grip-vertical",null,{muted:true});dbtn(t,"arrow-up",null);dbtn(t,"arrow-down",null);dsep(t);dbtn(t,"sliders-horizontal","Props");dbtn(t,"copy",null);dbtn(t,"trash-2",null);dsep(t);dbtn(t,"ellipsis",null,{muted:true});
Export([r],"png",OUT+"A1");
