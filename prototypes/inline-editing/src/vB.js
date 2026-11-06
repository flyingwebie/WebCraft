const ids=[];const W=1060,H=900,P=380;
const FIELDS=[["type","Eyebrow","Text","Spring menu 2027","eyebrow"],["heading","Headline","Text","Fresh from our ovens, every morning…","h1"],["text","Intro","Rich text","Sourdough, pastries and celebration…","intro"],["link","Buttons","2 links","See the menu · Find us","b1"],["image","Hero image","Image","sourdough-tray.jpg","img"],["repeat","Our bakes","Loop · own items","4 items","bakesSec"],["repeat","From the blog","Loop · query","Latest 3 Blog posts · read only","blogSec"]];
function fieldRow(b,f,o={}){const [i,l,t,v,k]=f;const st=(o.st||{})[k];const col={ai:AMB,hand:BLU,out:RED}[st];
 const w=fr(b,"Field "+l,{layout:"vertical",width:"fill_container",cornerRadius:8,stroke:o.open?BR:(col||"$border"),strokeWidth:o.open?1.5:1,fill:"$bg",clip:true});
 const h=fr(w,"Row",{width:"fill_container",padding:[9,12],gap:10,alignItems:"center"});ic(h,i,{fill:o.open?BR:"$muted-fg"});const c=fr(h,"T",{layout:"vertical",width:"fill_container",gap:1});
 const tl=fr(c,"L",{gap:6,alignItems:"center"});tx(tl,l,{fontWeight:"500"});tx(tl,t,{fontSize:11,fill:"$muted-fg"});if(!o.open)tx(c,o.val||v,{fontSize:12,fill:"$muted-fg"});
 if(st)badge(h,{ai:"AI, to check",hand:"Edited by hand",out:"English changed"}[st],{ai:"warn",hand:"info",out:"neutral"}[st]);ic(h,o.open?"chevron-up":"chevron-down",{width:14,height:14});
 if(o.open){const body=fr(w,"Body",{layout:"vertical",width:"fill_container",padding:[0,12,12,12],gap:10});o.open(body);}return w;}
function chromeB(i,name,o={}){const r=screen("B · Side panel · "+name,i*1540,1100,{layout:"horizontal"});ids.push(r);
 const p=fr(r,"Edit panel",{layout:"vertical",width:P,height:"fill_container",fill:"$bg",stroke:"$border",strokeWidth:{right:1}});
 const h=fr(p,"Head",{width:"fill_container",padding:[10,12],gap:6,alignItems:"center",stroke:"$border",strokeWidth:{bottom:1}});btn(h,null,{icon:"arrow-left",kind:"ghost"});tx(h,"Acme Bakery",{fill:"$muted-fg"});sp(h);btn(h,o.lang||"EN",{icon:"languages"});btn(h,null,{icon:"eye",kind:"ghost"});btn(h,null,{icon:"monitor",kind:"ghost"});
 const t=fr(p,"Title",{layout:"vertical",width:"fill_container",padding:[14,16,10,16],gap:6});const tr=fr(t,"Row",{width:"fill_container",gap:8,alignItems:"center"});tx(tr,"Home",{fontSize:18,fontWeight:"600"});ic(tr,"chevrons-up-down",{width:14,height:14});sp(tr);badge(tr,o.count?("Draft · "+o.count+(o.count>1?" changes":" change")):"No changes",o.count?"warn":"neutral");tx(t,"Page · acmebakery.ie/",{fontSize:12,fill:"$muted-fg"});
 tabsRow(p,["Content","Details"],o.tab||"Content",{px:12});
 const b=fr(p,"Body",{layout:"vertical",width:"fill_container",height:"fill_container",padding:12,gap:8,clip:true});
 const f=fr(p,"Footer",{width:"fill_container",padding:[12,14],gap:8,alignItems:"center",stroke:"$border",strokeWidth:{top:1}});tx(f,o.count?"Saved to Draft · just now":"All changes saved",{fontSize:12,fill:"$muted-fg"});sp(f);btn(f,"Publish",{kind:"primary",icon:"upload"});
 const vp=fr(r,"Viewport",{layout:"none",width:W,height:H,clip:true,fill:C.cream});return {r,b,vp};}
function rich(b,txt){const tb=fr(b,"Rich toolbar",{width:"fill_container",padding:3,gap:1,cornerRadius:6,fill:"$muted"});for(const i of ["bold","italic","link","list","list-ordered","remove-formatting"])btn(tb,null,{icon:i,kind:"ghost"});
 const ta=fr(b,"Editor",{width:"fill_container",padding:[10,12],cornerRadius:6,stroke:BR,strokeWidth:1.5});tx(ta,txt,{textGrowth:"fixed-width",width:"fill_container",lineHeight:1.5});}
const INTRO2="Sourdough, pastries and celebration cakes, baked by hand on Harbour Street, Cork. Order before 2pm for next-day collection, or call us on 021 455 0199.";
{const {r,b,vp}=chromeB(0,"1 Edit mode on");sitePage(vp,W,"en",{_:"hint",h1:"hover"});
 const n=fr(b,"Hint",{width:"fill_container",padding:[10,12],gap:8,cornerRadius:8,fill:"$info-bg"});ic(n,"mouse-pointer-click",{fill:"$info"});tx(n,"You're editing the Draft of Home. Click anything on the page to jump to its Field, or edit it here. Visitors see nothing until you publish.",{fontSize:12,fill:"$info",textGrowth:"fixed-width",width:"fill_container",lineHeight:1.45});
 for(const f of FIELDS)fieldRow(b,f);}
{const {r,b,vp}=chromeB(1,"2 Editing text",{count:1});sitePage(vp,W,"en",{intro:"sel"},{intro:INTRO2});
 for(const f of FIELDS)fieldRow(b,f,f[1]=="Intro"?{open:bb=>rich(bb,INTRO2)}:{});}
{const {r,b,vp}=chromeB(2,"3 Image",{count:2});sitePage(vp,W,"en",{img:"sel"},{focal:true});
 for(const f of FIELDS)fieldRow(b,f,f[1]=="Hero image"?{open:bb=>{const ph=photo(bb,"preview","fill_container",150,0,{r:6});Insert(ph,{type:"ellipse",name:"Focal",x:140,y:56,width:22,height:22,fill:"#FFFFFF55",stroke:"#FFFFFF",strokeWidth:3});const r2=fr(bb,"Actions",{gap:8});btn(r2,"Choose from Media",{icon:"images"});btn(r2,"Upload",{icon:"upload"});field(bb,"Alt text · English","A tray of country sourdough loaves fresh from the oven");tx(bb,"Drag the dot to set the focal point.",{fontSize:12,fill:"$muted-fg"});}}:{});}
{const {r,b,vp}=chromeB(3,"4 Loop items",{count:3});sitePage(vp,W,"en",{bakesSec:"hover",bake1:"sel",blogSec:"hint"},{scroll:500});
 for(const f of FIELDS.slice(0,5))fieldRow(b,f);
 fieldRow(b,FIELDS[5],{open:bb=>{LANG.en.bakes.forEach(([n,pr],i)=>{const it=fr(bb,"Item "+n,{layout:"vertical",width:"fill_container",cornerRadius:6,stroke:i==1?BR:"$border",strokeWidth:i==1?1.5:1});const rr=fr(it,"Row",{width:"fill_container",padding:[6,8],gap:8,alignItems:"center"});ic(rr,"grip-vertical",{width:14,height:14});photo(rr,"t",36,26,i+1,{r:4});tx(rr,n,{fontWeight:"500"});sp(rr);tx(rr,pr,{fill:"$muted-fg"});ic(rr,i==1?"chevron-up":"chevron-down",{width:14,height:14});
   if(i==1){const ib=fr(it,"Item body",{layout:"vertical",width:"fill_container",padding:[0,10,10,10],gap:8});const two=fr(ib,"Two",{width:"fill_container",gap:8});field(two,"Name","Cardamom bun");field(two,"Price","€3.20",{width:90});const t=fr(ib,"Avail",{width:"fill_container",alignItems:"center",gap:8});tx(t,"Sold out today",{fontWeight:"500"});sp(t);toggle(t,false);const a=fr(ib,"A",{gap:8});btn(a,"Duplicate",{icon:"copy"});btn(a,"Delete",{icon:"trash-2"});}});
  btn(bb,"Add bake",{icon:"plus"});}});
 fieldRow(b,FIELDS[6]);}
{const {r,b,vp}=chromeB(4,"5 Page details",{count:3,tab:"Details"});sitePage(vp,W,"en",{});detailsBody(b);}
{const {r,b,vp}=chromeB(5,"6 Save & publish",{count:3});sitePage(vp,W,"en",{});for(const f of FIELDS)fieldRow(b,f);const c=pop(r,"Publish popover",{x:12,y:H-62-470,w:356});publishBody(c);}
{const {r,b,vp}=chromeB(6,"7 Switching language",{count:3,lang:"IT"});sitePage(vp,W,"it",IT_S,{labels:IT_L,scroll:-44});
 const ib=fr(vp,"Translation banner",{layoutPosition:"absolute",x:0,y:0,width:W,height:44,padding:[0,16],gap:10,alignItems:"center",fill:"#FEF3C7",stroke:"#FCD34D",strokeWidth:{bottom:1}});ic(ib,"languages",{fill:"#B45309"});tx(ib,"Italiano · Review · AI translations wait in the Draft. 3 Fields to check.",{fill:"#92400E",fontWeight:"500"});sp(ib);btn(ib,"Compare with English",{icon:"columns-2"});
 const ITV={eyebrow:"Menù di primavera 2027",h1:"Appena sfornato, ogni mattina dal 1987",intro:"Pane a lievitazione naturale, pasticceria…",b1:"Scopri il menù · Dove siamo",bakesSec:"4 items · 1 changed in English"};
 for(const f of FIELDS)fieldRow(b,f,{st:{eyebrow:"ai",h1:"ai",intro:"hand",bakesSec:"out"},val:ITV[f[4]]});const c=pop(r,"Language menu",{x:120,y:52,w:340});langBody(c);}
Export(ids,"png","/tmp/penproto-ie/out/B");Print("B done",ids.length);
