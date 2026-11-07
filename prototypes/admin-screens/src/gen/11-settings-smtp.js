const X=4620,Y=2000;
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
const r=screen("Screens · 11 Site settings · Email (SMTP)",X,Y,{h:1200});
const col=settingsLayout(r,"Email (SMTP)");
heading(col,"Email (SMTP)","How this Site sends Form Notifications, Auto-replies and other email. Secrets are stored encrypted.");
const src=card(col,"Sending server","Choose which SMTP server sends this Site's email.");
const opts=row(src.b,"Options",{gap:12,alignItems:"start"});
radioOpt(opts,"Use the Install SMTP","Sent through Northwind Studio's server as noreply@northwind.studio. Good for testing; mail may look less trustworthy to clients' visitors.",false,{width:"fill_container"});
radioOpt(opts,"Use this Site's own SMTP","Sent from the client's own domain. If it fails, email falls back to the Install SMTP and the delivery log says so.",true,{width:"fill_container",badge:["Recommended","success"]});
const sv=card(col,"Server details",null);
const r1=row(sv.b,"Host row",{gap:12,alignItems:"start"});field(r1,"Host","smtp.acmebakery.ie");field(r1,"Port","587",{width:110});
const en=fr(r1,"Field Encryption",{layout:"vertical",gap:6,width:200});tx(en,"Encryption",{fontWeight:"500"});select(en,"STARTTLS");
const r2=row(sv.b,"Auth row",{gap:12,alignItems:"start"});field(r2,"Username","mailer@acmebakery.ie");
const pw=fr(r2,"Field Password",{layout:"vertical",gap:6,width:"fill_container"});tx(pw,"Password",{fontWeight:"500"});const pr=row(pw,"Pw",{gap:8});input(pr,"•••••••••••••• (set 12 Feb by Davide Del Gatto)",{value:1,icon:"lock"});btn(pr,"Replace");muted(pw,"Stored encrypted. It can be replaced but never shown again.");
const fm=card(col,"Sender",null);
const r3=row(fm.b,"From row",{gap:12,alignItems:"start"});field(r3,"From name","Acme Bakery");field(r3,"From address","hello@acmebakery.ie",{hint:"Must be allowed by your server, or mail may be rejected."});
field(fm.b,"Reply-to (optional)","orders@acmebakery.ie",{hint:"Form Notifications use the submitter's email as reply-to instead."});
const ts=card(col,"Test","Send a test message using the settings above, before you save them.");
const tr=row(ts.b,"Test row",{gap:8});input(tr,"davide@northwind.studio",{value:1,icon:"mail"});btn(tr,"Send test email",{icon:"send"});
const last=row(ts.b,"Last test",{gap:10,padding:[10,12],cornerRadius:8,fill:"$success-bg"});ic(last,"circle-check",{fill:"$success",width:16,height:16});tx(last,"Delivered to davide@northwind.studio",{fontWeight:"500",fill:"$success"});muted(last,"Today 09:42 · 250 OK · 0.8 s",{fill:"$success"});
const ft=row(col,"Footer",{gap:8,justifyContent:"end"});muted(ft,"Changes to Site settings take effect when saved; they aren't part of Publish all.");fr(ft,"Spacer",{width:"fill_container",height:1});btn(ft,"Discard");btn(ft,"Save",{kind:"primary"});
Export([r],"png","/tmp/penproto/final/11-settings-smtp");
