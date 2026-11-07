dedupe("P1 · Phone · all three variants");
const r=screen("P1 · Phone · all three variants",1540*2,1100,{layout:"horizontal",h:900,fill:"$canvas"});r.layout="horizontal";
const row=fr(r,"Phones",{width:"fill_container",height:"fill_container",gap:60,justifyContent:"center",alignItems:"center"});
function phone(title,cap){const w=fr(row,"Phone "+title,{layout:"vertical",gap:10,alignItems:"center",width:340});tx(w,title,{fontWeight:"600",fontSize:15});const ph=fr(w,"Device",{layout:"vertical",width:340,height:700,cornerRadius:36,stroke:"#18181B",strokeWidth:8,fill:C.cream,clip:true});
 const bar=fr(ph,"Bar",{width:"fill_container",height:50,padding:[8,12,0,12],gap:6,alignItems:"center",fill:DK});tx(bar,"Home",{fontWeight:"600",fill:DKF});const st=fr(bar,"S",{padding:[2,7],cornerRadius:99,fill:"#3B2A06"});tx(st,"Draft · 2",{fontSize:11,fill:"#FBBF24"});sp(bar);pav(bar,"MO",PEER,{s:22});dbtn(bar,"upload","Publish",{primary:true});
 tx(w,cap,{fontSize:12,fill:"$muted-fg",textGrowth:"fixed-width",width:340,lineHeight:1.45,textAlign:"center"});return ph;}
function pageThumbs(p,sel){for(const [k,h] of [["header",44],["hero",190],["grid",150],["quote",120],["blog",150]]){const f=fr(p,"Sec "+k,{width:340,height:h,layout:"none",...(k==sel?{stroke:BR,strokeWidth:2.5}:{})});thumb(f,k,328,h,{r:0,stroke:false});if(k==sel)chip(f,"Customer quote",BR);}}
// A
const a=phone("A · On the page","Tap a Component's label to select it. Its actions open in a bottom sheet instead of the floating toolbar.");
const av=fr(a,"Page",{layout:"none",width:"fill_container",height:"fill_container"});const pg=fr(av,"Scroll",{layoutPosition:"absolute",x:0,y:-200,layout:"vertical",width:340});pageThumbs(pg,"quote");
const sh=fr(av,"Sheet",{layoutPosition:"absolute",x:0,y:400,width:324,height:250,layout:"vertical",fill:"$bg",cornerRadius:[16,16,0,0],padding:16,gap:12,effect:{type:"shadow",offset:{x:0,y:-6},blur:24,color:"#00000030"}});
fr(sh,"Grab",{width:36,height:4,cornerRadius:2,fill:"$border"});const hh=fr(sh,"H",{width:"fill_container",gap:8,alignItems:"center"});ic(hh,"component",{fill:BR});tx(hh,"Customer quote",{fontWeight:"600",fontSize:14});sp(hh);tx(hh,"3 of 5",{fill:"$muted-fg",fontSize:12});
const g1=fr(sh,"Row1",{width:"fill_container",gap:8});btn(g1,"Move up",{icon:"arrow-up"});btn(g1,"Move down",{icon:"arrow-down"});
const g2=fr(sh,"Row2",{width:"fill_container",gap:8});btn(g2,"Props",{icon:"sliders-horizontal"});btn(g2,"Duplicate",{icon:"copy"});btn(g2,null,{icon:"trash-2"});
btn(sh,"Add component below",{icon:"plus",kind:"primary"});
// B
const b=phone("B · Layout drawer","The drawer becomes a full-screen sheet. Rows move with ↑ ↓ buttons, so no dragging is needed on a phone.");
const bs=fr(b,"Sheet",{layout:"vertical",width:"fill_container",height:"fill_container",fill:"$bg",padding:12,gap:6});const bh=fr(bs,"H",{width:"fill_container",alignItems:"center",gap:8,padding:[4,4,8,4]});ic(bh,"layers",{fill:BR});tx(bh,"Page layout",{fontWeight:"600",fontSize:14});sp(bh);ic(bh,"x");
for(const [k,n,s] of ROWS_B){const rr=fr(bs,"Row "+n,{width:"fill_container",padding:[8,6],gap:8,alignItems:"center",cornerRadius:8,...(n=="Customer quote"?{fill:BR+"12",stroke:BR,strokeWidth:1.5}:{})});thumb(rr,k,48,30,{r:4});const t=fr(rr,"T",{layout:"vertical",width:"fill_container"});tx(t,n,{fontWeight:"600",fontSize:12});tx(t,s,{fontSize:10,fill:"$muted-fg"});if(n=="Latest posts")pav(rr,"MO",PEER,{s:20});ic(rr,"arrow-up",{width:14,height:14});ic(rr,"arrow-down",{width:14,height:14});ic(rr,"ellipsis",{width:14,height:14});}
btn(bs,"Add component",{icon:"plus",kind:"primary"});vsp(bs);lockNote(bs,"Header and footer come from the Page template.");
// C
const c=phone("C · Arrange mode","Arrange turns the page into a list of cards. The selected card shows its actions underneath; Props open as a sheet.");
const cs=fr(c,"Canvas",{layout:"vertical",width:"fill_container",height:"fill_container",fill:"#E7E5E4",padding:16,gap:12});
const seg=fr(cs,"Mode",{padding:3,gap:2,cornerRadius:8,fill:"#27272A",width:"fill_container"});for(const m of ["Edit","Arrange","Preview"])dbtn(seg,null,m,{on:m=="Arrange",muted:m!="Arrange"});
for(const [k,n,h] of [["hero","Hero split",110],["grid","Product grid",90],["quote","Customer quote",80],["blog","Latest posts",90]]){const f=fr(cs,"Card "+n,{width:"fill_container",height:h,layout:"none",cornerRadius:8,...(n=="Customer quote"?{stroke:BR,strokeWidth:2.5}:{})});thumb(f,k,292,h,{r:8,stroke:false});chip(f,n,n=="Customer quote"?BR:"#3F3F46",{r:[8,0,6,0]});
 if(n=="Customer quote"){const t=fr(cs,"Actions",{width:"fill_container",padding:5,gap:2,cornerRadius:9,fill:DK,justifyContent:"center"});for(const i of ["arrow-up","arrow-down","sliders-horizontal","copy","trash-2"])dbtn(t,i,null);}}
Export([r],"png",OUT+"P1");
