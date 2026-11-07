const X=3080,Y=2000;
const WSB=act=>({av:"AC",avFill:"#D97706",title:"Acme Ltd",subtitle:"Workspace · 3 Sites",sections:WS_SECTIONS,footer:[["settings","Workspace settings"]],active:act});
const SUBNAV=[["settings","General"],["globe","Domains & Staging"],["languages","Languages"],["mail","Email (SMTP)"],["sparkles","AI translation"],["webhook","Webhooks"],["pencil-line","Edit mode & layout"],["triangle-alert","Danger zone"]];
function settingsLayout(r,active){sidebarA(r,SITE_A("Site settings"));const m=mainCol(r);topbarA(m,["Acme Ltd","Acme Bakery","Settings",active]);const body=fr(m,"Settings body",{width:"fill_container",height:"fill_container"});const sub=fr(body,"Settings nav",{layout:"vertical",width:220,height:"fill_container",padding:[24,12],gap:2,stroke:"$border",strokeWidth:{right:1}});for(const [i,l] of SUBNAV)nav(sub,i,l,{active:l==active});return fr(body,"Content",{layout:"vertical",width:"fill_container",padding:[28,40],gap:20});}
function wsLayout(r,active,crumb){sidebarA(r,WSB(active));const m=mainCol(r);topbarA(m,["Acme Ltd",crumb||active],{site:false});return m;}
function heading(col,title,desc,right){const h=fr(col,"Heading",{width:"fill_container",gap:16,alignItems:"end"});const l=fr(h,"Titles",{layout:"vertical",gap:4,width:"fill_container"});tx(l,title,{fontSize:22,fontWeight:"600"});tx(l,desc,{fill:"$muted-fg",textGrowth:"fixed-width",width:"fill_container",lineHeight:1.45});if(right)right(h);return h;}
function muted(p,t,o={}){return tx(p,t,{fontSize:12,fill:"$muted-fg",...o});}
function wrapTx(p,t,o={}){return tx(p,t,{textGrowth:"fixed-width",width:"fill_container",lineHeight:1.45,...o});}
function row(p,name,o={}){return fr(p,name,{width:"fill_container",gap:12,alignItems:"center",...o});}
function select(p,val,o={}){return input(p,val,{value:1,trail:"chevron-down",...o});}
function radioOpt(p,title,desc,on,o={}){const c=fr(p,"Option "+title,{width:o.width||"fill_container",gap:12,padding:14,cornerRadius:10,stroke:on?"$primary":"$border",strokeWidth:on?2:1,fill:on?"$sidebar":"$bg"});const dot=fr(c,"Radio",{width:16,height:16,cornerRadius:999,stroke:on?"$primary":"$border",strokeWidth:on?5:1,fill:"$bg"});const t=fr(c,"Text",{layout:"vertical",gap:3,width:"fill_container"});const tr=fr(t,"Title row",{gap:8,alignItems:"center"});tx(tr,title,{fontWeight:"600"});if(o.badge)badge(tr,o.badge[0],o.badge[1]);if(desc)wrapTx(t,desc,{fontSize:12,fill:"$muted-fg"});return c;}
function banner(p,kind,icon,title,desc,act){const m={warn:["$warn-bg","$warn"],info:["$info-bg","$info"],success:["$success-bg","$success"],danger:["$danger-bg","$danger"]}[kind];const b=fr(p,"Banner "+title,{width:"fill_container",gap:12,padding:[12,16],cornerRadius:10,fill:m[0],alignItems:"center"});ic(b,icon,{fill:m[1],width:18,height:18});const t=fr(b,"Text",{layout:"vertical",gap:2,width:"fill_container"});tx(t,title,{fontWeight:"600",fill:m[1]});if(desc)wrapTx(t,desc,{fontSize:12,fill:m[1]});if(act)btn(b,act);return b;}
function table(p,cols,rows,o={}){const t=fr(p,"Table",{layout:"vertical",width:"fill_container",cornerRadius:12,stroke:"$border",strokeWidth:1,clip:true,fill:"$bg"});const h=fr(t,"Head",{width:"fill_container",padding:[0,16],height:40,gap:12,alignItems:"center",fill:"$muted"});for(const [l,w] of cols){const c=fr(h,"Col "+l,{width:w});muted(c,l,{fontWeight:"500"});}for(const r of rows){const rr=fr(t,"Row",{width:"fill_container",padding:[0,16],height:o.rh||52,gap:12,alignItems:"center",stroke:"$border",strokeWidth:{top:1}});r.forEach((cell,i)=>{const c=fr(rr,"Cell",{width:cols[i][1],gap:8,alignItems:"center"});if(typeof cell=="function")cell(c);else tx(c,cell);});}return t;}
function bar(p,frac,w,kind){const b=fr(p,"Bar",{width:w,height:8,cornerRadius:999,fill:"$muted"});fr(b,"Fill",{width:Math.round(w*frac),height:8,cornerRadius:999,fill:kind=="warn"?"$warn":"$primary"});return b;}
function stat(p,label,val,sub){const s=fr(p,"Stat "+label,{layout:"vertical",gap:4,width:"fill_container",padding:16,cornerRadius:10,stroke:"$border",strokeWidth:1});muted(s,label);tx(s,val,{fontSize:20,fontWeight:"600"});if(sub)muted(s,sub);return s;}
const r=screen("Screens · 10 Members",X,Y,{h:900});
const m=wsLayout(r,"Members");
const body=fr(m,"Body",{width:"fill_container",height:"fill_container",padding:[24,32],gap:24});
const col=fr(body,"Main",{layout:"vertical",width:"fill_container",gap:16});
heading(col,"Members","People from Acme Ltd who can sign in to this Workspace. Each Membership has one role and reaches all Sites or chosen ones.",h=>btn(h,"Invite Member",{kind:"primary",icon:"user-plus"}));
const tools=row(col,"Tools",{gap:8});input(tools,"Search Members",{icon:"search",width:280});fr(tools,"Spacer",{width:"fill_container",height:1});select(tools,"All roles",{width:140});
const who=(ini,f,n,e)=>c=>{avatar(c,ini,{fill:f});const v=fr(c,"Who",{layout:"vertical",gap:1});tx(v,n,{fontWeight:"500"});muted(v,e);};
const role=l=>c=>badge(c,l,l=="Owner"?"info":"neutral");
const fa=(on,t)=>c=>{ic(c,on?"shield-check":"shield-alert",{width:14,height:14,fill:on?"$success":"$warn"});tx(c,t,{fontSize:12,fill:on?"$fg":"$warn"});};
const sites=(t,n)=>c=>{tx(c,t);if(n)badge(c,n,"outline");};
table(col,[["Member","fill_container"],["Role",80],["Site access",170],["2FA",110],["Last active",100],["",20]],[
 [who("SM","#0EA5E9","Sarah Murphy","sarah@acmeltd.ie"),role("Owner"),sites("All Sites"),fa(true,"Passkey"),"Today",c=>ic(c,"ellipsis")],
 [who("GR","#64748B","Giulia Romano","giulia@acmeltd.ie"),role("Editor"),sites("Acme Bakery","+1"),fa(true,"Authenticator"),"2 hours ago",c=>ic(c,"ellipsis")],
 [who("MO","#64748B","Mark O'Brien","mark@acmeltd.ie"),role("Editor"),sites("All Sites"),fa(true,"Passkey"),"Yesterday",c=>ic(c,"ellipsis")],
 [who("AK","#64748B","Aoife Kelly","aoife@acmeltd.ie"),role("Author"),sites("Acme Bakery"),fa(false,"Not set up"),"3 Mar",c=>ic(c,"ellipsis")],
 [who("TB","#64748B","Tom Byrne","tom@acmeltd.ie"),role("Author"),sites("Acme Catering"),fa(true,"Authenticator"),"28 Feb",c=>ic(c,"ellipsis")]]);
tx(col,"Pending invites",{fontSize:15,fontWeight:"600"});
table(col,[["Email","fill_container"],["Role",80],["Site access",170],["Invited",170],["",150]],[
 ["niamh@acmeltd.ie",role("Editor"),sites("Acme Bakery"),c=>muted(c,"by Sarah Murphy · 2 days ago"),c=>{btn(c,"Resend");btn(c,"Revoke",{kind:"ghost"});}],
 ["orders@acmeltd.ie",role("Author"),sites("All Sites"),c=>muted(c,"by you · expires in 5 days"),c=>{btn(c,"Resend");btn(c,"Revoke",{kind:"ghost"});}]]);
const side=fr(body,"Side",{layout:"vertical",width:300,gap:16});
const n1=card(side,"Agency Staff aren't Members","Staff from Northwind Studio are managed by the Superadmin at Install level and reach this Workspace through their assignment, not a Membership.");
const st=row(n1.b,"Staff",{gap:-6});["DD","LC","PW"].forEach(i=>avatar(st,i,{fill:"#18181B"}));muted(n1.b,"3 Staff assigned to Acme Ltd");
const n2=card(side,"What each role can do",null);
for(const [l,d] of [["Owner","Manages Members, edits and publishes."],["Editor","Edits and publishes Content."],["Author","Edits and saves Drafts. An Editor or Owner publishes."]]){const x=fr(n2.b,"Role "+l,{layout:"vertical",gap:2,width:"fill_container"});tx(x,l,{fontWeight:"600"});wrapTx(x,d,{fontSize:12,fill:"$muted-fg"});}
// dialog
const ov=fr(r,"Overlay",{layoutPosition:"absolute",x:0,y:0,width:1440,height:900,fill:"$overlay",justifyContent:"end"});
const d=fr(ov,"Invite sheet",{layout:"vertical",width:520,height:"fill_container",fill:"$bg",stroke:"$border",strokeWidth:{left:1},clip:true,effect:{type:"shadow",offset:{x:0,y:20},blur:48,color:"#00000040"}});
const dh=row(d,"Header",{padding:[20,24,8,24],alignItems:"start"});const dt=fr(dh,"Titles",{layout:"vertical",gap:4,width:"fill_container"});tx(dt,"Invite a Member",{fontSize:17,fontWeight:"600"});muted(dt,"They get an email in their Admin language with a link valid for 7 days.",{fontSize:13});ic(dh,"x");
const db=fr(d,"Body",{layout:"vertical",width:"fill_container",padding:[12,24,20,24],gap:16});
field(db,"Email","niamh@acmeltd.ie");
const rg=fr(db,"Role",{layout:"vertical",gap:8,width:"fill_container"});tx(rg,"Role",{fontWeight:"500"});
radioOpt(rg,"Owner","Manages Members and settings like AI keys and form recipients; edits and publishes.",false);
radioOpt(rg,"Editor","Edits and publishes Content on the Sites they reach.",true);
radioOpt(rg,"Author","Edits Content and saves Drafts; can't publish.",false);
const sa=fr(db,"Site access",{layout:"vertical",gap:8,width:"fill_container"});tx(sa,"Site access",{fontWeight:"500"});
const seg=fr(sa,"Segmented",{padding:3,gap:2,cornerRadius:8,fill:"$muted"});["All Sites","Chosen Sites"].forEach((t,i)=>{const b=fr(seg,"Seg "+t,{padding:[5,12],cornerRadius:6,...(i==1?{fill:"$bg"}:{})});tx(b,t,{fontSize:12,fontWeight:"500",fill:i==1?"$fg":"$muted-fg"});});
for(const [s,on,dis] of [["Acme Bakery · acmebakery.ie",true],["Acme Catering · acmecatering.ie",false],["Acme Careers · careers.acmeltd.ie",false]]){const x=row(sa,"Site "+s,{gap:10,...(dis?{opacity:0.45}:{})});check(x,on);tx(x,s);if(dis){fr(x,"Spacer",{width:"fill_container",height:1});ic(x,"lock",{width:12,height:12});muted(x,"You don't reach this Site");}}
const nt=row(db,"Note",{gap:8,padding:[8,12],cornerRadius:8,fill:"$sidebar"});ic(nt,"info",{width:14,height:14});wrapTx(nt,"You can't grant more access than you hold. An Owner can only offer the Sites they reach.",{fontSize:12,fill:"$muted-fg"});
fr(d,"Grow",{width:"fill_container",height:"fill_container"});
const df=row(d,"Footer",{padding:[14,24],gap:8,justifyContent:"end",fill:"$sidebar",stroke:"$border",strokeWidth:{top:1}});btn(df,"Cancel");btn(df,"Send invite",{kind:"primary",icon:"send"});
Export([r],"png","/tmp/penproto/final/10-members");
