const X=1540,Y=2000;
const r=screen("Screens · 09 Protected terms",X,Y,{h:900});
sidebarA(r,{av:"AC",avFill:"#D97706",title:"Acme Ltd",subtitle:"Workspace · 3 Sites",sections:WS_SECTIONS,footer:[["settings","Workspace settings"]],active:"Protected terms"});
const m=mainCol(r);topbarA(m,["Acme Ltd","Protected terms"],{site:false});
const head=fr(m,"Page header",{width:"fill_container",padding:[24,32,12,32],alignItems:"end",gap:10});
const tb=fr(head,"Title block",{layout:"vertical",gap:4,width:"fill_container"});tx(tb,"Protected terms",{fontSize:22,fontWeight:"600"});tx(tb,"Words AI translation leaves exactly as written in every language: brand names, product names, people. Workspace terms apply to all 3 Sites; a Site can add its own.",{fill:"$muted-fg",textGrowth:"fixed-width",width:"fill_container"});
btn(head,"Import CSV",{icon:"upload"});
const col=fr(m,"Body",{layout:"vertical",width:"fill_container",padding:[12,32,24,32],gap:16});
// add form
const add=fr(col,"Add term",{width:"fill_container",gap:10,alignItems:"end",padding:16,cornerRadius:12,stroke:"$border",strokeWidth:1,fill:"$sidebar"});
field(add,"Term","e.g. Acme Croissant Club",{ph:1});
const sc=fr(add,"Field Scope",{layout:"vertical",gap:6,width:240});tx(sc,"Applies to",{fontWeight:"500"});input(sc,"Whole Workspace",{value:1,trail:"chevron-down",width:240});
const cs=fr(add,"Case",{gap:8,alignItems:"center",height:32});check(cs,true);tx(cs,"Match case");
btn(add,"Add term",{kind:"primary",icon:"plus"});
// filters
const fl=fr(col,"Filters",{width:"fill_container",gap:8,alignItems:"center"});input(fl,"Search 23 terms",{icon:"search",width:300});
const seg=fr(fl,"Scope",{padding:3,gap:2,cornerRadius:8,fill:"$muted"});["All 23","Workspace 14","Acme Bakery 6","Acme Catering 3"].forEach((t,i)=>{const b=fr(seg,"Seg "+t,{padding:[4,10],cornerRadius:6,...(i==0?{fill:"$bg"}:{})});tx(b,t,{fontSize:12,fontWeight:"500",fill:i?"$muted-fg":"$fg"});});
// table
const t=fr(col,"Table",{layout:"vertical",width:"fill_container",cornerRadius:10,stroke:"$border",strokeWidth:1,clip:true});
const cols=[["Term","fill_container"],["Applies to",200],["Match case",110],["Kept in",130],["Added by",180],["",40]];
const th=fr(t,"Th",{width:"fill_container",padding:[10,16],gap:12,fill:"$muted"});cols.forEach(([l,w])=>{const c=fr(th,"C",{width:w});tx(c,l,{fontSize:12,fontWeight:"500",fill:"$muted-fg"});});
for(const [term,scope,cs,kept,by,init] of [["Acme","Workspace",true,"412 values","Staff · Davide Del Gatto","DD"],["Acme Sourdough Loaf","Workspace",true,"38 values","Owner · Sinéad Byrne","SB"],["Bread Club","Workspace",true,"21 values","Editor · Giulia Romano","GR"],["Northwind Studio","Workspace",true,"3 values","Staff · Davide Del Gatto","DD"],["Panettone Sunday","Site: Acme Bakery",false,"9 values","Editor · Mark O'Brien","MO"],["Kilkenny","Site: Acme Bakery",true,"6 values","Editor · Giulia Romano","GR"],["Party Platter XL","Site: Acme Catering",true,"4 values","Owner · Sinéad Byrne","SB"]]){
 const tr=fr(t,"Row "+term,{width:"fill_container",padding:[10,16],gap:12,alignItems:"center",stroke:"$border",strokeWidth:{top:1}});
 const a=fr(tr,"C",{width:"fill_container",gap:8,alignItems:"center"});ic(a,"shield-check",{width:14,height:14});tx(a,term,{fontWeight:"500"});
 const b=fr(tr,"C",{width:200});badge(b,scope,scope=="Workspace"?"neutral":"outline");
 const c=fr(tr,"C",{width:110});tx(c,cs?"Yes":"No",{fontSize:12,fill:cs?"$fg":"$muted-fg"});
 const d=fr(tr,"C",{width:130});tx(d,kept,{fontSize:12,fill:"$muted-fg"});
 const e=fr(tr,"C",{width:180,gap:8,alignItems:"center"});avatar(e,init,{size:22,fs:9,fill:"#71717A"});tx(e,by,{fontSize:12});
 const f=fr(tr,"C",{width:40,justifyContent:"end"});ic(f,"ellipsis");}
const note=fr(col,"Note",{width:"fill_container",gap:10,padding:[10,14],cornerRadius:10,fill:"$info-bg",alignItems:"center"});ic(note,"info",{fill:"$info"});tx(note,"In this version a Protected term only means \"leave as written\". Forcing a fixed word per language is not supported yet. Editors, Owners and Staff can change this list.",{fontSize:12,fill:"$fg",textGrowth:"fixed-width",width:"fill_container",lineHeight:1.45});
Export([r],"png","/tmp/penproto/final/09-protected-terms");
