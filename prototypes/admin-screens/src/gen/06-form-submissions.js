const X=7700,Y=0;
const r=screen("Screens · 06 Form submissions",X,Y,{h:900});sidebarA(r,SITE_A("Forms"));const m=mainCol(r);topbarA(m,["Acme Ltd","Acme Bakery","Forms","Wedding cake enquiry"]);
const body=fr(m,"Body",{width:"fill_container",height:"fill_container"});
// forms + folders column
const fc=fr(body,"Forms column",{layout:"vertical",width:216,height:"fill_container",padding:[20,12],gap:2,stroke:"$border",strokeWidth:{right:1}});
tx(fc,"FORMS",{fontSize:11,fontWeight:"500",fill:"$muted-fg",letterSpacing:0.3});fr(fc,"g",{width:1,height:6});
nav(fc,"clipboard-list","Wedding cakes",{active:true,tag:"3 new",tagKind:"info"});nav(fc,"clipboard-list","Contact",{tag:"2 new",tagKind:"info"});nav(fc,"clipboard-list","Bread subscription",{badge:41});nav(fc,"clipboard-list","Newsletter",{badge:310});
fr(fc,"g",{width:1,height:14});tx(fc,"FOLDERS",{fontSize:11,fontWeight:"500",fill:"$muted-fg",letterSpacing:0.3});fr(fc,"g",{width:1,height:6});
nav(fc,"inbox","Inbox",{active:true,badge:58});nav(fc,"shield-alert","Spam",{badge:7});
fr(fc,"g",{width:1,height:6});
const sn=fr(fc,"Spam note",{layout:"vertical",width:"fill_container",padding:10,gap:4,cornerRadius:8,fill:"$sidebar",stroke:"$border",strokeWidth:1});tx(sn,"Spam is deleted after 30 days. It never sends Notifications, Auto-replies or Webhooks.",{fontSize:11,fill:"$muted-fg",textGrowth:"fixed-width",width:"fill_container",lineHeight:1.4});
// list column
const lc=fr(body,"List",{layout:"vertical",width:"fill_container",height:"fill_container",padding:[20,24],gap:14});
const hd=fr(lc,"Header",{width:"fill_container",alignItems:"center",gap:10});const tb=fr(hd,"Title",{layout:"vertical",gap:2,width:"fill_container"});tx(tb,"Wedding cake enquiry",{fontSize:22,fontWeight:"600"});tx(tb,"58 Submissions · 3 unread · kept forever",{fill:"$muted-fg"});btn(hd,"Export CSV",{icon:"download"});
const tl=fr(lc,"Toolbar",{width:"fill_container",gap:8,alignItems:"center"});input(tl,"Search Submissions",{icon:"search",width:220});
const seg=fr(tl,"Read filter",{padding:3,gap:2,cornerRadius:8,fill:"$muted"});["All","Unread","Read"].forEach((t,i)=>{const b=fr(seg,"Seg "+t,{padding:[4,10],cornerRadius:6,...(i==0?{fill:"$bg"}:{})});tx(b,t,{fontSize:12,fontWeight:"500",fill:i==0?"$fg":"$muted-fg"});});
sp(tl);btn(tl,"All languages",{icon:"languages"});
const tbl=fr(lc,"Table",{layout:"vertical",width:"fill_container",cornerRadius:10,stroke:"$border",strokeWidth:1,clip:true});
const cols=[["Submitter","fill_container"],["Cake type",110],["Date",92],["Lang",48],["Received",90]];
const th=fr(tbl,"Head",{width:"fill_container",padding:[0,14],height:38,gap:12,alignItems:"center",fill:"$muted"});
for(const [c,w] of cols){const cl=fr(th,"H "+c,{width:w});tx(cl,c,{fontSize:12,fontWeight:"500",fill:"$muted-fg"});}
const rows=[["Siobhán Murphy","siobhan.m@example.ie","Tiered","14 Jun 2027","EN","10 min ago",1,1],["Luca Bianchi","luca.b@example.it","Tiered","2 Aug 2027","IT","1 hour ago",1,0],["Hannah Weber","h.weber@example.de","Cupcake tower","20 Sep 2027","DE","3 hours ago",1,0],["Conor Walsh","conor@example.ie","Single tier","5 Jul 2027","EN","Yesterday",0,0],["Emma Byrne","emma.b@example.com","Tiered","11 Oct 2027","EN","2 days ago",0,0],["Giorgia Rossi","g.rossi@example.it","Tiered","30 May 2027","IT","3 days ago",0,0],["Niamh Kelly","niamhk@example.ie","Cupcake tower","19 Jun 2027","EN","4 days ago",0,0],["Paul Schmidt","paul.s@example.de","Single tier","8 Aug 2027","DE","5 days ago",0,0]];
for(const [n,e,t,d,l,rc,unread,sel] of rows){const rw=fr(tbl,"Row "+n,{width:"fill_container",padding:[0,14],height:52,gap:12,alignItems:"center",stroke:"$border",strokeWidth:{top:1},...(sel?{fill:"$accent"}:{})});
const c1=fr(rw,"Who",{width:"fill_container",gap:8,alignItems:"center"});Insert(c1,{type:"ellipse",name:"Unread dot",width:7,height:7,fill:unread?"$primary":"#00000000"});const nm=fr(c1,"Names",{layout:"vertical",gap:1});tx(nm,n,{fontWeight:unread?"600":"400"});tx(nm,e,{fontSize:12,fill:"$muted-fg"});
const c2=fr(rw,"c2",{width:110});tx(c2,t,{fontSize:12});const c3=fr(rw,"c3",{width:92});tx(c3,d,{fontSize:12});const c4=fr(rw,"c4",{width:48});langChip(c4,l,"done");const c5=fr(rw,"c5",{width:90});tx(c5,rc,{fontSize:12,fill:"$muted-fg"});}
const pg=fr(lc,"Pager",{width:"fill_container",alignItems:"center",gap:8});tx(pg,"Showing 1–8 of 58",{fontSize:12,fill:"$muted-fg"});sp(pg);btn(pg,"Previous");btn(pg,"Next");
// detail panel
const dp=fr(body,"Detail",{layout:"vertical",width:360,height:"fill_container",padding:20,gap:12,stroke:"$border",strokeWidth:{left:1},fill:"$bg"});
const dh=fr(dp,"Head",{width:"fill_container",alignItems:"center",gap:8});tx(dh,"Siobhán Murphy",{fontSize:15,fontWeight:"600"});sp(dh);btn(dh,null,{icon:"mail",kind:"ghost"});btn(dh,null,{icon:"shield-alert",kind:"ghost"});btn(dh,null,{icon:"trash-2",kind:"ghost"});
tx(dp,"10 min ago · English · from /weddings · Mark as unread",{fontSize:12,fill:"$muted-fg"});
const fl=fr(dp,"Fields",{layout:"vertical",width:"fill_container",gap:8,padding:12,cornerRadius:10,fill:"$sidebar",stroke:"$border",strokeWidth:1});
for(const [k,v] of [["Email","siobhan.m@example.ie"],["Phone","+353 87 123 4567"],["Wedding date","14 Jun 2027"],["Guests","140"],["Cake type","Tiered"],["Number of tiers","4"],["Message","Lemon and elderflower, naked style, with fresh flowers."],["Consent","Yes"]]){const rw=fr(fl,"KV "+k,{width:"fill_container",gap:10});const kk=fr(rw,"k",{width:110});tx(kk,k,{fontSize:12,fill:"$muted-fg"});tx(rw,v,{fontSize:12,textGrowth:"fixed-width",width:"fill_container",lineHeight:1.4});}
const fi=fr(dp,"Files",{layout:"vertical",width:"fill_container",gap:6});tx(fi,"Inspiration photos · 2 files",{fontWeight:"500"});
for(const f of ["moodboard.jpg · 2.1 MB","grandmas-cake.png · 4.8 MB"]){const rw=fr(fi,"File",{width:"fill_container",gap:8,alignItems:"center",padding:[6,10],cornerRadius:8,stroke:"$border",strokeWidth:1});ic(rw,"lock",{width:13,height:13});tx(rw,f,{fontSize:12});sp(rw);ic(rw,"download",{width:14,height:14,fill:"$fg"});}
tx(fi,"Private: signed-in people with access only, no public URL.",{fontSize:11,fill:"$muted-fg"});
const dl=fr(dp,"Delivery log",{layout:"vertical",width:"fill_container",gap:6});tx(dl,"Delivery log",{fontWeight:"500"});
for(const [i,l,s,k] of [["mail","Notification → cakes@acmebakery.ie","Sent","success"],["reply","Auto-reply → submitter (EN)","Sent","success"],["webhook","Webhook · form submitted","Failed · retry in 4 min","warn"]]){const rw=fr(dl,"Log",{width:"fill_container",gap:8,alignItems:"center"});ic(rw,i,{width:13,height:13});tx(rw,l,{fontSize:12});sp(rw);badge(rw,s,k);}
vsp(dp);
const sp2=fr(dp,"Spam hint",{width:"fill_container",gap:8,alignItems:"center",padding:10,cornerRadius:8,fill:"$warn-bg"});ic(sp2,"shield-alert",{width:14,height:14,fill:"$warn"});tx(sp2,"In Spam, this panel shows Not spam: it then runs the Notifications, Auto-reply and Webhooks.",{fontSize:11,fill:"$warn",textGrowth:"fixed-width",width:"fill_container",lineHeight:1.4});
Export([r],"png","/tmp/penproto/final/06-form-submissions");
