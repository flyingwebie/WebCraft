const X=0,Y=2000;
const r=screen("Screens · 08 Translations",X,Y,{h:960});sidebarA(r,SITE_A("Translations"));const m=mainCol(r);topbarA(m,["Acme Ltd","Acme Bakery","Translations"]);
const head=fr(m,"Page header",{width:"fill_container",padding:[24,32,12,32],alignItems:"end",gap:10});
const tb=fr(head,"Title block",{layout:"vertical",gap:4,width:"fill_container"});tx(tb,"Translations",{fontSize:22,fontWeight:"600"});tx(tb,"Default language: English. AI translation fills the other languages; values a person wrote are never overwritten.",{fill:"$muted-fg",textGrowth:"fixed-width",width:"fill_container"});
btn(head,"Languages",{icon:"settings"});btn(head,"Translate now",{kind:"primary",icon:"sparkles"});
const col=fr(m,"Body",{layout:"vertical",width:"fill_container",padding:[12,32,24,32],gap:16});
// usage strip
const us=fr(col,"AI usage",{width:"fill_container",gap:16,alignItems:"center",padding:[12,16],cornerRadius:10,fill:"$warn-bg"});ic(us,"gauge",{fill:"$warn"});
const ut=fr(us,"Text",{layout:"vertical",gap:6,width:"fill_container"});const u1=fr(ut,"Row",{gap:8,alignItems:"center"});tx(u1,"AI usage this month: 82% of the cap",{fontWeight:"600",fill:"$warn"});tx(u1,"17.0M tokens across 3 Sites · about $8.20 of $10.00",{fontSize:12,fill:"$fg"});
const bar=fr(ut,"Bar",{width:"fill_container",height:6,cornerRadius:999,fill:"#FFFFFF80"});fr(bar,"Fill",{width:560,height:6,cornerRadius:999,fill:"$warn"});
tx(ut,"At the cap, AI translation stops and queued work waits for next month or a raised cap. Owner and Staff were notified at 80%.",{fontSize:12,fill:"$fg"});
const key=fr(us,"Key",{layout:"vertical",gap:2,width:270,padding:[8,12],cornerRadius:8,fill:"$bg"});const k1=fr(key,"Row",{gap:6,alignItems:"center"});ic(k1,"key-round",{width:14,height:14});tx(k1,"Acme Ltd's own AI key",{fontWeight:"500"});tx(key,"Workspace key · used before the shared Install key",{fontSize:11,fill:"$muted-fg",textGrowth:"fixed-width",width:"fill_container"});
// language cards
const lc=fr(col,"Languages",{width:"fill_container",gap:16});
for(const [code,name,mode,pct,rev,out,miss] of [["IT","Italian","Review",92,6,2,3],["DE","German","Automatic",100,0,0,0],["FR","French","Manual",41,0,1,48]]){
 const c=fr(lc,"Lang "+code,{layout:"vertical",width:"fill_container",gap:12,padding:16,cornerRadius:12,stroke:"$border",strokeWidth:1});
 const h=fr(c,"Head",{width:"fill_container",gap:8,alignItems:"center"});const cb=fr(h,"Code",{padding:[2,6],cornerRadius:4,stroke:"$border",strokeWidth:1});tx(cb,code,{fontSize:11,fontWeight:"600"});tx(h,name,{fontSize:15,fontWeight:"600"});sp(h);tx(h,pct+"%",{fontWeight:"600"});
 const b=fr(c,"Bar",{width:"fill_container",height:6,cornerRadius:999,fill:"$muted"});fr(b,"Fill",{width:Math.round(3.1*pct),height:6,cornerRadius:999,fill:pct==100?"$success":"$primary"});
 tx(c,"Translation mode",{fontSize:12,fontWeight:"500",fill:"$muted-fg"});
 const seg=fr(c,"Mode",{width:"fill_container",padding:3,gap:2,cornerRadius:8,fill:"$muted"});["Automatic","Review","Manual"].forEach(t=>{const s=fr(seg,"Seg "+t,{width:"fill_container",padding:[5,6],cornerRadius:6,justifyContent:"center",...(t==mode?{fill:"$bg"}:{})});tx(s,t,{fontSize:12,fontWeight:"500",fill:t==mode?"$fg":"$muted-fg"});});
 tx(c,{Automatic:"Changed Fields are translated and published with the English publish.",Review:"The AI translates into the Draft; a person publishes it.",Manual:"No AI. People write every value."}[mode],{fontSize:12,fill:"$muted-fg",textGrowth:"fixed-width",width:"fill_container",lineHeight:1.4});
 const st=fr(c,"Stats",{width:"fill_container",gap:6});badge(st,rev+" to review",rev?"warn":"neutral");badge(st,out+" outdated",out?"info":"neutral");badge(st,miss+" missing","neutral");}
// review queue
const q=card(col,"Review queue","AI-written values waiting for a person, and Outdated translations whose English source changed after a person wrote them.");
const qa=fr(q.h,"Filters",{gap:8,alignItems:"center"});btn(qa,"Language: All",{icon:"languages"});btn(qa,"Approve all 6",{icon:"check-check"});
const t=fr(q.b,"Table",{layout:"vertical",width:"fill_container",cornerRadius:8,stroke:"$border",strokeWidth:1,clip:true});
const cols=[["Entry","fill_container"],["Field",130],["Language",90],["Written by",130],["Status",130],["",90]];
const th=fr(t,"Th",{width:"fill_container",padding:[8,12],gap:12,fill:"$muted"});cols.forEach(([l,w])=>{const c=fr(th,"C",{width:w});tx(c,l,{fontSize:12,fontWeight:"500",fill:"$muted-fg"});});
function row(e,f,l,by,s,open){const tr=fr(t,"Row "+e+f,{width:"fill_container",padding:[10,12],gap:12,alignItems:"center",stroke:"$border",strokeWidth:{top:1},...(open?{fill:"$sidebar"}:{})});
 const a=fr(tr,"C",{width:"fill_container",gap:6,alignItems:"center"});ic(a,open?"chevron-down":"chevron-right",{width:14,height:14});tx(a,e,{fontWeight:"500"});
 const b=fr(tr,"C",{width:130});tx(b,f,{fontSize:12,fill:"$muted-fg"});const c=fr(tr,"C",{width:90});const cb=fr(c,"Code",{padding:[1,6],cornerRadius:4,stroke:"$border",strokeWidth:1});tx(cb,l,{fontSize:11,fontWeight:"600"});
 const d=fr(tr,"C",{width:130,gap:6,alignItems:"center"});ic(d,by=="AI"?"sparkles":"user",{width:13,height:13});tx(d,by=="AI"?"AI":by,{fontSize:12});
 const e2=fr(tr,"C",{width:130});badge(e2,s,s=="To review"?"warn":"info");const f2=fr(tr,"C",{width:90,justifyContent:"end"});ic(f2,"ellipsis");return tr;}
row("Spring menu 2027","Body","IT","AI","To review",true);
const det=fr(t,"Detail",{width:"fill_container",padding:[4,16,16,40],gap:16,fill:"$sidebar"});
function pane(title,txt,o={}){const p=fr(det,"Pane "+title,{layout:"vertical",width:"fill_container",gap:8,padding:12,cornerRadius:8,fill:"$bg",stroke:o.hl?"$primary":"$border",strokeWidth:1});const h=fr(p,"H",{gap:6,alignItems:"center",width:"fill_container"});tx(h,title,{fontSize:12,fontWeight:"600",fill:"$muted-fg"});if(o.tag){sp(h);badge(h,o.tag,"outline");}tx(p,txt,{textGrowth:"fixed-width",width:"fill_container",lineHeight:1.5});return p;}
pane("English source","Our spring menu brings back the Acme Sourdough Loaf, plus three new pastries baked with Irish butter every morning.");
const it=pane("Italian · AI translation","Il nostro menu di primavera riporta l'Acme Sourdough Loaf, più tre nuovi dolci preparati ogni mattina con burro irlandese.",{hl:1,tag:"Protected term kept: Acme Sourdough Loaf"});
const ab=fr(it,"Actions",{gap:8,width:"fill_container"});btn(ab,"Approve",{kind:"primary",icon:"check"});btn(ab,"Edit",{icon:"pencil"});btn(ab,"Re-translate",{icon:"refresh-cw"});
row("Spring menu 2027","SEO description","IT","AI","To review");
row("About us","Intro","IT","Giulia Romano","Outdated");
row("Gluten-free range: what's new","Title","IT","AI","To review");
row("Footer (Globals)","Opening hours note","FR","Aoife Kelly","Outdated");
Export([r],"png","/tmp/penproto/final/08-translations");
