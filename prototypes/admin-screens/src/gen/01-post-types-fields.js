const X=0,Y=0;
const r=screen("Screens · 01 Post Types & Fields",X,Y,{h:1000});sidebarA(r,SITE_A("Post Types & Fields"));const m=mainCol(r);topbarA(m,["Acme Ltd","Acme Bakery","Post Types & Fields","Blog posts"]);
const body=fr(m,"Body",{width:"fill_container",height:"fill_container"});
// left: post types
const L=fr(body,"Post Types list",{layout:"vertical",width:220,height:"fill_container",padding:[20,12],gap:4,stroke:"$border",strokeWidth:{right:1}});
const lh=fr(L,"Head",{width:"fill_container",padding:[0,8,8,8],alignItems:"center"});tx(lh,"Post Types",{fontWeight:"600"});sp(lh);btn(lh,null,{icon:"plus",kind:"ghost"});
for(const [i,l,n,o] of [["file-text","Pages",12,{built:1}],["newspaper","Blog posts",24,{active:1}],["users","Team",8,{}],["utensils","Menu items",31,{}]]){const it=fr(L,"PT "+l,{width:"fill_container",height:34,gap:8,padding:[0,8],cornerRadius:8,alignItems:"center",...(o.active?{fill:"$accent"}:{})});ic(it,i,{width:15,height:15,fill:o.active?"$fg":"$muted-fg"});tx(it,l,{fontWeight:o.active?"500":"400",fill:o.active?"$fg":"$muted-fg"});sp(it);if(o.built)badge(it,"Built-in","outline");else tx(it,String(n),{fontSize:12,fill:"$muted-fg"});}
vsp(L);const io=fr(L,"Import export",{layout:"vertical",width:"fill_container",gap:6});btn(io,"Import file",{icon:"upload"});btn(io,"Export Blog posts",{icon:"download"});
// centre: field builder
const C=fr(body,"Field builder",{layout:"vertical",width:"fill_container",height:"fill_container",padding:[24,28],gap:16});
const ch=fr(C,"Header",{width:"fill_container",alignItems:"center",gap:10});const ct=fr(ch,"Titles",{layout:"vertical",gap:4,width:"fill_container"});const t1=fr(ct,"T",{gap:8,alignItems:"center"});tx(t1,"Blog posts",{fontSize:22,fontWeight:"600"});badge(t1,"Structure · Staff only","outline");tx(ct,"24 Entries use these Fields. Changes go into the Draft until you Publish all.",{fill:"$muted-fg"});
const up=fr(C,"URL pattern",{width:"fill_container",gap:12,alignItems:"center"});
const g1=fr(up,"URL",{layout:"vertical",gap:6,width:200});tx(g1,"URL pattern",{fontWeight:"500"});const ui=input(g1,"/blog/{slug}",{value:1});
const g2=fr(up,"Tpl",{layout:"vertical",gap:6,width:"fill_container"});tx(g2,"Entry template",{fontWeight:"500"});input(g2,"Blog post",{value:1,trail:"chevron-down"});
const g3=fr(up,"Arch",{layout:"vertical",gap:6,width:"fill_container"});tx(g3,"Archive template",{fontWeight:"500"});input(g3,"Blog archive",{value:1,trail:"chevron-down"});
// built-in
const B=fr(C,"Built-in",{layout:"vertical",width:"fill_container",gap:6});
const bh=fr(B,"bh",{gap:6,alignItems:"center"});ic(bh,"lock",{width:12,height:12});tx(bh,"Built-in Fields (every Entry has these)",{fontSize:12,fontWeight:"500",fill:"$muted-fg"});
const bw=fr(B,"chips",{gap:6,width:"fill_container"});for(const b of ["Title","Slug","Status","Author","Created","Updated","Published"]){const c=fr(bw,"Chip "+b,{padding:[4,10],cornerRadius:8,fill:"$muted"});tx(c,b,{fontSize:12,fill:"$muted-fg"});}
// custom fields
const typeIcon={"Text":"type","Rich text":"pilcrow","Media · image":"image","Relationship":"link-2","Repeater":"list-ordered","Group":"brackets","Select":"list","Date/time":"calendar","Number":"hash","True/false":"toggle-left","Link":"link"};
const list=fr(C,"Custom Fields",{layout:"vertical",width:"fill_container",cornerRadius:12,stroke:"$border",strokeWidth:1,clip:true});
const lhd=fr(list,"List head",{width:"fill_container",padding:[8,14],gap:10,fill:"$sidebar",stroke:"$border",strokeWidth:{bottom:1},alignItems:"center"});[["Field",0],["Type",150],["",150]].forEach(([l,w])=>{const c=fr(lhd,"H",{width:w||"fill_container"});tx(c,l,{fontSize:12,fontWeight:"500",fill:"$muted-fg"});});
function row(label,name,type,flags,o={}){const rw=fr(list,"Field "+label,{width:"fill_container",padding:[9,14,9,14+(o.ind||0)],gap:10,alignItems:"center",stroke:"$border",strokeWidth:{bottom:1},...(o.sel?{fill:"$accent"}:{}),...(o.sel?{}:{})});
 ic(rw,"grip-vertical",{width:14,height:14,fill:"$muted-fg"});if(o.ind)ic(rw,"corner-down-right",{width:13,height:13,fill:"$muted-fg"});
 const ib=fr(rw,"Type icon",{width:26,height:26,cornerRadius:6,fill:o.sel?"$primary":"$muted",alignItems:"center",justifyContent:"center"});ic(ib,typeIcon[type]||"type",{width:14,height:14,fill:o.sel?"$primary-fg":"$fg"});
 const nc=fr(rw,"Names",{layout:"vertical",gap:1,width:"fill_container"});tx(nc,label,{fontWeight:"500"});tx(nc,name,{fontSize:11,fill:"$muted-fg",fontFamily:"Geist Mono"});
 const tc=fr(rw,"Type",{width:150});tx(tc,type,{fill:"$muted-fg",fontSize:12});
 const fc=fr(rw,"Flags",{width:150,gap:4,justifyContent:"end"});for(const f of flags)badge(fc,f[0],f[1]);
 ic(rw,"ellipsis",{width:14,height:14});return rw;}
row("Excerpt","excerpt","Text",[["Translatable","info"]]);
row("Body","body","Rich text",[["Required","neutral"],["Translatable","info"]]);
row("Cover image","cover","Media · image",[["Required","neutral"]]);
row("Written by","written_by","Relationship",[["Two-way","outline"]],{sel:1});
row("Recipe","recipe","Group",[]);
row("Prep time","prep_minutes","Number",[],{ind:28});
row("Difficulty","difficulty","Select",[["Translatable","info"]],{ind:28});
row("Steps","steps","Repeater",[["Translatable","info"]]);
row("Step text","text","Rich text",[["Translatable","info"]],{ind:28});
row("Step photo","photo","Media · image",[],{ind:28});
const add=fr(list,"Add field",{width:"fill_container",padding:[10,14],gap:8,alignItems:"center"});ic(add,"plus",{width:14,height:14,fill:"$primary"});tx(add,"Add Field",{fontWeight:"500",fill:"$primary"});tx(add,"12 types, from Text to Repeater",{fontSize:12,fill:"$muted-fg"});
// right: settings panel
const R=fr(body,"Field settings",{layout:"vertical",width:340,height:"fill_container",padding:[20,20],gap:14,fill:"$sidebar",stroke:"$border",strokeWidth:{left:1}});
const rh=fr(R,"Head",{width:"fill_container",alignItems:"center",gap:8});const rib=fr(rh,"ic",{width:28,height:28,cornerRadius:6,fill:"$primary",alignItems:"center",justifyContent:"center"});ic(rib,"link-2",{width:14,height:14,fill:"$primary-fg"});const rt=fr(rh,"t",{layout:"vertical",width:"fill_container"});tx(rt,"Written by",{fontSize:15,fontWeight:"600"});tx(rt,"Relationship Field",{fontSize:12,fill:"$muted-fg"});btn(rh,null,{icon:"x",kind:"ghost"});
hr(R);
const two=fr(R,"Row",{width:"fill_container",gap:10});field(two,"Label","Written by");field(two,"Name","written_by",{hint:"Used in Templates"});
field(R,"Help text","Who wrote this post.");
const tp=fr(R,"Targets",{layout:"vertical",gap:6,width:"fill_container"});tx(tp,"Points at",{fontWeight:"500"});const tps=fr(tp,"chips",{gap:6,width:"fill_container",padding:6,cornerRadius:8,stroke:"$border",strokeWidth:1,fill:"$bg",alignItems:"center"});const chp=fr(tps,"chip",{padding:[2,8],gap:4,cornerRadius:6,fill:"$muted",alignItems:"center"});tx(chp,"Team",{fontSize:12,fontWeight:"500"});ic(chp,"x",{width:11,height:11});tx(tps,"Add Post Type…",{fontSize:12,fill:"$muted-fg"});
const mn=fr(R,"minmax",{width:"fill_container",gap:10});field(mn,"Min Entries","1");field(mn,"Max Entries","2");
const dir=fr(R,"Direction",{layout:"vertical",gap:6,width:"fill_container"});tx(dir,"Direction",{fontWeight:"500"});const seg=fr(dir,"Seg",{width:"fill_container",padding:3,gap:2,cornerRadius:8,fill:"$muted"});[["Two-way",1],["One-way",0]].forEach(([l,a])=>{const s=fr(seg,"S "+l,{width:"fill_container",padding:[5,8],cornerRadius:6,justifyContent:"center",...(a?{fill:"$bg"}:{})});tx(s,l,{fontSize:12,fontWeight:"500",fill:a?"$fg":"$muted-fg"});});tx(dir,"Team members show \"Posts written\" back-link, named:",{fontSize:12,fill:"$muted-fg"});input(dir,"Posts written",{value:1});
hr(R);
for(const [l,d,on] of [["Required","An Entry can't be published without it. Blocks deleting the Team member.",true],["Translatable","Holds a separate value per language.",false]]){const rw=fr(R,"T "+l,{width:"fill_container",gap:10,alignItems:"center"});const c=fr(rw,"c",{layout:"vertical",gap:2,width:"fill_container"});tx(c,l,{fontWeight:"500"});tx(c,d,{fontSize:12,fill:"$muted-fg",textGrowth:"fixed-width",width:"fill_container"});toggle(rw,on);}
vsp(R);const ft=fr(R,"Footer",{width:"fill_container",gap:8});btn(ft,"Delete Field",{icon:"trash-2"});sp(ft);btn(ft,"Done",{kind:"primary"});
Export([r],"png","/tmp/penproto/final/01-post-types-fields");
