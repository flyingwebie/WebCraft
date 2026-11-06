const r=screen("Variant C · Top bar + tabs, no sidebar",3080,0,{layout:"vertical"});
const t=fr(r,"Top bar",{width:"fill_container",height:56,padding:[0,20],alignItems:"center",gap:10});
const lg=fr(t,"Logo",{width:28,height:28,cornerRadius:7,fill:"$primary",alignItems:"center",justifyContent:"center"});tx(lg,"W",{fontWeight:"700",fill:"$primary-fg"});
const sl=()=>tx(t,"/",{fill:"$border",fontSize:20});
sl();const ws=fr(t,"Workspace switch",{gap:8,alignItems:"center",padding:[4,8],cornerRadius:6});avatar(ws,"AC",{square:true,size:22,fill:"#D97706",fs:9});tx(ws,"Acme Ltd",{fontWeight:"500"});ic(ws,"chevrons-up-down",{width:14,height:14});
sl();const si=fr(t,"Site switch",{gap:8,alignItems:"center",padding:[4,8],cornerRadius:6});tx(si,"Acme Bakery",{fontWeight:"500"});badge(si,"Live","success");ic(si,"chevrons-up-down",{width:14,height:14});
sp(t);input(t,"Search",{icon:"search",kbd:"⌘K",width:220});btn(t,"Edit on site",{icon:"mouse-pointer-click"});btn(t,"Publish all",{kind:"primary",icon:"upload",count:5});ic(t,"bell");avatar(t,"DD",{fill:"#0EA5E9"});
const tabs=fr(r,"Tabs",{width:"fill_container",padding:[0,20],gap:4,stroke:"$border",strokeWidth:{bottom:1}});
for(const [l,o] of [["Overview"],["Content",{a:1}],["Media"],["Forms",{n:"5"}],["Translations",{n:"2"}],["Build",{staff:1}],["Settings"]]){const tb=fr(tabs,"Tab "+l,{layout:"vertical",gap:0});const lb=fr(tb,"Label",{padding:[10,10],gap:6,alignItems:"center"});tx(lb,l,{fontWeight:"500",fill:o&&o.a?"$fg":"$muted-fg"});if(o&&o.n)badge(lb,o.n,"neutral");if(o&&o.staff)ic(lb,"lock",{width:12,height:12});fr(tb,"Underline",{width:"fill_container",height:2,...(o&&o.a?{fill:"$fg"}:{})});}
const body=fr(r,"Body",{width:"fill_container",height:"fill_container"});
const sub=fr(body,"Post Type list",{layout:"vertical",width:220,height:"fill_container",padding:[20,12],gap:2,stroke:"$border",strokeWidth:{right:1}});
const P=section(sub,"Post Types");for(const [i,l,o] of [["file-text","Pages",{badge:12}],["newspaper","Blog posts",{badge:24,active:true}],["users","Team",{badge:8}]])nav(P,i,l,o);
const G=section(sub,"Site-wide");nav(G,"sliders-horizontal","Globals");nav(G,"repeat","Loop items");
const m=fr(body,"Main",{layout:"vertical",width:"fill_container",height:"fill_container"});entries(m);
Export([r],"png","/tmp/penproto/out");
