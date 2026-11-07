const {r,vp}=chrome(1,2,"C2 · Arrange mode · Props inspector",{count:3,modes:["Edit","Arrange","Preview"],mode:"Arrange",canvas:"#E7E5E4"});
const PW=380,CW2=640,cx0=(SW-PW-CW2)/2;const P=stackCards(vp,cx0,22,CW2,{"Customer quote":"sel","Latest posts":"peer"});vtool(vp,cx0+CW2+14,P["Customer quote"].y);
const d=fr(vp,"Inspector",{layoutPosition:"absolute",x:SW-PW,y:0,width:PW,height:SH,layout:"vertical",fill:"$bg",stroke:"$border",strokeWidth:{left:1}});
panelHead(d,"component","Customer quote","3rd of 5 · Arrange mode");const b=fr(d,"Body",{layout:"vertical",width:"fill_container",padding:20,gap:16});quoteProps(b,{});
const e=fr(b,"Edit content",{width:"fill_container",gap:8});btn(e,"Edit text on the page",{icon:"pencil"});
lockNote(b,"Arrange mode shows the page as cards. Switch back to Edit to change text and images in place.",{icon:"info"});
Export([r],"png",OUT+"C2");
