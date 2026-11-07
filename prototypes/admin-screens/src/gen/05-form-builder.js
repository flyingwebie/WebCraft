const X=6160,Y=0;
const r=screen("Screens · 05 Form builder",X,Y,{h:960});sidebarA(r,SITE_A("Form builder"));const m=mainCol(r);topbarA(m,["Acme Ltd","Acme Bakery","Form builder","Wedding cake enquiry"]);
// form header
const head=fr(m,"Form header",{width:"fill_container",padding:[18,24,0,24],gap:12,alignItems:"center"});
btn(head,null,{icon:"arrow-left",kind:"ghost"});
const tb=fr(head,"Title",{layout:"vertical",gap:2,width:"fill_container"});const tl=fr(tb,"Line",{gap:8,alignItems:"center"});tx(tl,"Wedding cake enquiry",{fontSize:20,fontWeight:"600"});badge(tl,"Draft · 3 changes","warn");badge(tl,"Structure","outline");
tx(tb,"Placed on: Weddings (Page) · Contact (Component) · Last published 4 Mar by Davide Del Gatto",{fontSize:12,fill:"$muted-fg"});
btn(head,"Preview",{icon:"eye"});btn(head,"Export",{icon:"download",kind:"ghost"});btn(head,"Publish Form",{kind:"primary",icon:"upload"});
tabsRow(m,[["Build"],["Emails",{n:"2"}],["Settings"],["Translations",{n:"DE 4",k:"warn"}]],"Build",{px:24});
const body=fr(m,"Builder body",{width:"fill_container",height:"fill_container"});
// palette
const pal=fr(body,"Field palette",{layout:"vertical",width:196,height:"fill_container",padding:[16,12],gap:4,stroke:"$border",strokeWidth:{right:1},fill:"$sidebar"});
tx(pal,"ADD FIELD",{fontSize:11,fontWeight:"500",fill:"$muted-fg",letterSpacing:0.3});fr(pal,"g",{width:1,height:4});
for(const [i,l] of [["type","Text"],["at-sign","Email"],["phone","Phone"],["link","URL"],["file-text","Textarea"],["hash","Number"],["calendar","Date"],["chevron-down","Select"],["circle-dot","Radio"],["list-checks","Checkboxes"],["square-check","Consent"],["eye-off","Hidden"],["paperclip","File upload"]]){const it=fr(pal,"Pal "+l,{width:"fill_container",height:28,padding:[0,8],gap:8,alignItems:"center",cornerRadius:6,stroke:"$border",strokeWidth:1,fill:"$bg"});ic(it,i,{width:14,height:14});tx(it,l,{fontSize:12});sp(it);ic(it,"grip-vertical",{width:12,height:12});}
fr(pal,"g",{width:1,height:8});tx(pal,"LAYOUT",{fontSize:11,fontWeight:"500",fill:"$muted-fg",letterSpacing:0.3});
for(const [i,l] of [["square-dashed","Section"],["footprints","Step"]]){const it=fr(pal,"Pal "+l,{width:"fill_container",height:28,padding:[0,8],gap:8,alignItems:"center",cornerRadius:6,stroke:"$border",strokeWidth:1,fill:"$bg"});ic(it,i,{width:14,height:14});tx(it,l,{fontSize:12});}
// canvas
const cv=fr(body,"Canvas",{layout:"vertical",width:"fill_container",height:"fill_container",padding:[20,28],gap:14,fill:"$canvas"});
const steps=fr(cv,"Steps",{width:"fill_container",gap:8,alignItems:"center"});
[["1","Your event",1],["2","The cake",2],["3","Contact",0]].forEach(([n,l,s],i)=>{if(i)fr(steps,"Line",{width:"fill_container",height:2,fill:s?"$primary":"$border"});const st=fr(steps,"Step "+n,{gap:8,alignItems:"center",padding:[6,12],cornerRadius:999,...(s==2?{fill:"$bg",stroke:"$primary",strokeWidth:1}:{})});const c=fr(st,"Num",{width:22,height:22,cornerRadius:999,alignItems:"center",justifyContent:"center",fill:s?"$primary":"$muted"});if(s==1)ic(c,"check",{width:12,height:12,fill:"$primary-fg"});else tx(c,n,{fontSize:11,fontWeight:"600",fill:s?"$primary-fg":"$muted-fg"});tx(st,l,{fontWeight:s==2?"600":"500",fill:s?"$fg":"$muted-fg"});});
const page=fr(cv,"Step 2 card",{layout:"vertical",width:"fill_container",padding:20,gap:14,cornerRadius:12,fill:"$bg",stroke:"$border",strokeWidth:1});
const ph=fr(page,"Step head",{width:"fill_container",alignItems:"center",gap:8});tx(ph,"Step 2 · The cake",{fontSize:15,fontWeight:"600"});sp(ph);tx(ph,"Validates before Next",{fontSize:12,fill:"$muted-fg"});
function fieldRow(p,icon,label,type,o={}){const f=fr(p,"F "+label,{layout:"vertical",width:"fill_container",padding:[10,12],gap:6,cornerRadius:8,...(o.sel?{stroke:"$primary",strokeWidth:2,fill:"$bg"}:{stroke:"$border",strokeWidth:1,fill:"$bg"})});const h=fr(f,"h",{width:"fill_container",gap:8,alignItems:"center"});ic(h,"grip-vertical",{width:14,height:14});tx(h,label+(o.req?" *":""),{fontWeight:"500"});badge(h,type,"neutral");if(o.cond){const cb=badge(h,o.cond,"info");}sp(h);if(o.sel){ic(h,"copy",{width:14,height:14});ic(h,"trash-2",{width:14,height:14});}
const pv=fr(f,"Preview",{width:"fill_container",height:30,padding:[0,10],cornerRadius:6,stroke:"$border",strokeWidth:1,fill:"$sidebar",alignItems:"center"});tx(pv,o.ph||"",{fontSize:12,fill:"$muted-fg"});if(o.chev){sp(pv);ic(pv,"chevron-down",{width:14,height:14});}return f;}
const s1=fr(page,"Section Cake",{layout:"vertical",width:"fill_container",padding:14,gap:10,cornerRadius:10,stroke:"$border",strokeWidth:1});
const s1h=fr(s1,"Legend",{gap:8,alignItems:"center"});ic(s1h,"square-dashed",{width:14,height:14});tx(s1h,"Section · Cake details",{fontWeight:"600",fontSize:13});badge(s1h,"fieldset","outline");
fieldRow(s1,"chevron-down","Cake type","Select",{req:1,ph:"Single tier, Tiered, Cupcake tower",chev:1});
fieldRow(s1,"hash","Number of tiers","Number",{req:1,ph:"2 – 6",sel:1,cond:"Shown when Cake type = Tiered"});
const two=fr(s1,"Two",{width:"fill_container",gap:10});fieldRow(two,"hash","Guests","Number",{ph:"e.g. 120"});fieldRow(two,"calendar","Wedding date","Date",{req:1,ph:"dd/mm/yyyy"});
const s2=fr(page,"Section Inspiration",{layout:"vertical",width:"fill_container",padding:14,gap:10,cornerRadius:10,stroke:"$border",strokeWidth:1});
const s2h=fr(s2,"Legend",{gap:8,alignItems:"center"});ic(s2h,"square-dashed",{width:14,height:14});tx(s2h,"Section · Inspiration",{fontWeight:"600"});badge(s2h,"fieldset","outline");
fieldRow(s2,"paperclip","Inspiration photos","File upload",{ph:"Up to 5 images · 10 MB each · stored privately"});
const drop=fr(page,"Drop hint",{width:"fill_container",height:40,cornerRadius:8,stroke:"$primary",strokeWidth:1,fill:"$sidebar",alignItems:"center",justifyContent:"center",gap:6});ic(drop,"plus",{width:14,height:14,fill:"$primary"});tx(drop,"Drag a field or Section here",{fontSize:12,fill:"$primary"});
const nav2=fr(page,"Step nav",{width:"fill_container",gap:8});btn(nav2,"Back",{icon:"arrow-left"});sp(nav2);btn(nav2,"Next: Contact",{kind:"primary"});
const oth=fr(cv,"Other tabs",{width:"fill_container",gap:12});
function tabHint(p,icon,title,lines){const c=fr(p,"Hint "+title,{layout:"vertical",width:"fill_container",padding:14,gap:6,cornerRadius:10,stroke:"$border",strokeWidth:1,fill:"$bg"});const h=fr(c,"h",{gap:6,alignItems:"center",width:"fill_container"});ic(h,icon,{width:14,height:14,fill:"$fg"});tx(h,title,{fontWeight:"600"});sp(h);tx(h,"Open tab",{fontSize:12,fill:"$primary"});for(const l of lines){tx(c,"· "+l,{fontSize:12,fill:"$muted-fg"});}}
tabHint(oth,"mail","Emails tab",["2 Notifications via the Site's SMTP","Routed by Cake type to the right baker","Auto-reply in the submitter's language"]);
tabHint(oth,"settings","Settings tab",["Success: inline message (or redirect)","Keep forever · 5/min, 30/hour per IP","CAPTCHA off · attachments up to 10 MB"]);
// right panel
const rp=fr(body,"Field panel",{layout:"vertical",width:320,height:"fill_container",padding:20,gap:14,stroke:"$border",strokeWidth:{left:1},fill:"$bg"});
const rh=fr(rp,"h",{width:"fill_container",alignItems:"center",gap:8});ic(rh,"hash",{width:16,height:16,fill:"$fg"});tx(rh,"Number of tiers",{fontSize:15,fontWeight:"600"});sp(rh);badge(rh,"Number");
field(rp,"Label","Number of tiers",{hint:"Translated per language (Translations tab)"});
field(rp,"Field key","tiers",{hint:"Used in Notifications, CSV export and Webhooks"});
const rq=fr(rp,"Required",{width:"fill_container",alignItems:"center"});tx(rq,"Required",{fontWeight:"500"});sp(rq);toggle(rq,true);
const vr=fr(rp,"Validation",{layout:"vertical",width:"fill_container",gap:6});tx(vr,"Validation",{fontWeight:"500"});const mm=fr(vr,"mm",{width:"fill_container",gap:8});input(mm,"Min 2",{value:1});input(mm,"Max 6",{value:1});
tx(vr,"Error: \"Choose between 2 and 6 tiers\"",{fontSize:12,fill:"$muted-fg"});
hr(rp);
const cd=fr(rp,"Condition",{layout:"vertical",width:"fill_container",gap:8});const cdh=fr(cd,"h",{width:"fill_container",alignItems:"center",gap:6});ic(cdh,"git-branch",{width:14,height:14,fill:"$fg"});tx(cdh,"Show this field when",{fontWeight:"500"});sp(cdh);toggle(cdh,true);
const rule=fr(cd,"Rule",{layout:"vertical",width:"fill_container",padding:10,gap:6,cornerRadius:8,fill:"$sidebar",stroke:"$border",strokeWidth:1});
const r1=fr(rule,"r1",{width:"fill_container",gap:6});input(r1,"Cake type",{value:1,trail:"chevron-down"});input(r1,"equals",{value:1,trail:"chevron-down",width:90});
input(rule,"Tiered",{value:1,trail:"chevron-down"});
const ad=fr(rule,"add",{gap:6,alignItems:"center"});ic(ad,"plus",{width:12,height:12});tx(ad,"AND / OR rule",{fontSize:12,fill:"$muted-fg"});
tx(cd,"Hidden fields are neither validated nor stored.",{fontSize:12,fill:"$muted-fg",textGrowth:"fixed-width",width:"fill_container"});
hr(rp);
const fl=fr(rp,"File limits",{layout:"vertical",width:"fill_container",gap:4});const flh=fr(fl,"h",{gap:6,alignItems:"center"});tx(flh,"File limits",{fontWeight:"500"});badge(flh,"File upload fields only","outline");
tx(fl,"Allowed types, max size and max count appear here when a File upload field is selected.",{fontSize:12,fill:"$muted-fg",textGrowth:"fixed-width",width:"fill_container"});
Export([r],"png","/tmp/penproto/final/05-form-builder");
