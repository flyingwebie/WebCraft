const {r,vp}=chrome(2,0,"A3 · On the page · Props panel",{count:3});
const E=layoutPage(vp,SW-400,{quote:"sel",blog:"peer"},{scroll:540});
const d=fr(vp,"Props panel",{layoutPosition:"absolute",x:SW-400,y:0,width:400,height:SH,layout:"vertical",fill:"$bg",stroke:"$border",strokeWidth:{left:1},effect:{type:"shadow",offset:{x:-8,y:0},blur:24,color:"#0000001F"}});
panelHead(d,"component","Customer quote","Component · 3rd of 5 on Home");
const b=fr(d,"Body",{layout:"vertical",width:"fill_container",padding:20,gap:16});quoteProps(b,{focus:true});
const a=fr(b,"Actions",{width:"fill_container",gap:8,padding:[8,0,0,0]});btn(a,"Move up",{icon:"arrow-up"});btn(a,"Move down",{icon:"arrow-down"});sp(a);btn(a,null,{icon:"copy"});btn(a,null,{icon:"trash-2"});
lockNote(b,"Spacing, fonts and colours come from the Component. Ask Northwind Studio to change them.");
Export([r],"png",OUT+"A3");
