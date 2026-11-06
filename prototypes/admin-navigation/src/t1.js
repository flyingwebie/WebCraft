SetVariables({bg:V("#FFFFFF","#09090B"),fg:V("#09090B","#FAFAFA")});
const a=Insert(document,{type:"frame",name:"T light",x:0,y:0,width:200,height:80,fill:"$bg",padding:16,theme:{mode:"light"}});
Insert(a,{type:"text",name:"t",content:"Hello Geist",fontFamily:"Geist",fontSize:20,fill:"$fg"});
const b=Copy(a,document,{name:"T dark",x:240,y:0,theme:{mode:"dark"}});
Export([a,b],"png","/tmp/penproto/out");
