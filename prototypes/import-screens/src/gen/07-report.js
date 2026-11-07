const {r,m}=shellI("Import · 07 Import report",6,"Import",["Import","Old bakery site","Report"]);
wizHead(m,"Import report","Run 1 · 7 Nov 2026 · kept 90 days","Report",{btns:[["Run again",{icon:"refresh-cw"}],["Staging",{icon:"eye",kind:"primary"}]]});
const body=fr(m,"Body",{width:"fill_container",height:"fill_container",padding:[20,32],gap:24,fill:"$sidebar"});
const L=fr(body,"Main",{layout:"vertical",width:"fill_container",gap:14});
const st=fr(L,"Stats",{width:"fill_container",gap:10});
stat(st,"261","Created",{icon:"file-plus",c:"$success",sub:"All Drafts"});stat(st,"0","Updated",{icon:"refresh-cw",sub:"First run"});stat(st,"806","Media",{icon:"image",sub:"of 812"});stat(st,"6","Not fetched",{icon:"ban",c:"$danger",sub:"4 refused · 2 gone"});stat(st,"14","Import leftovers",{icon:"triangle-alert",c:"$warn",sub:"in 11 Entries"});stat(st,"140","Redirect rules",{icon:"corner-down-right",sub:"31 for Media"});
const card0=fr(L,"Tabs card",{layout:"vertical",width:"fill_container",cornerRadius:12,fill:"$bg",stroke:"$border",strokeWidth:1,clip:true});
tabsRow(card0,[["Import leftovers",{n:"14",k:"warn"}],["Not fetched",{n:"6"}],["Skipped",{n:"3 types · 2 keys"}],["Created",{n:"261"}],["Redirect rules",{n:"140"}]],"Import leftovers",{px:12});
const W=[200,"fill_container",120,90];
const t=fr(card0,"T",{layout:"vertical",width:"fill_container",padding:12});
tbl(t,W,["Entry","What was kept as plain text","Post Type",""],[
 [c=>tx(c,"Seeded rye",{fontWeight:"500"}),c=>mono(c,"[product_gallery …]"),"Products",c=>btn(c,"Open",{icon:"external-link",kind:"ghost"})],
 [c=>tx(c,"Easter hours",{fontWeight:"500"}),c=>mono(c,"[contact_form id=\"88\"]"),"Blog posts",c=>btn(c,"Open",{icon:"external-link",kind:"ghost"})],
 [c=>tx(c,"Wedding cakes",{fontWeight:"500"}),c=>mono(c,"<div class=\"pb-section\">…"),"Blog posts",c=>btn(c,"Open",{icon:"external-link",kind:"ghost"})],
 [c=>tx(c,"Lemon drizzle",{fontWeight:"500"}),c=>mono(c,"[recipe-card id=\"41\"]"),"Recipes",c=>btn(c,"Open",{icon:"external-link",kind:"ghost"})],
 [c=>tx(c,"Our story",{fontWeight:"500"}),c=>mono(c,"[row][column]…"),"Blog posts",c=>btn(c,"Open",{icon:"external-link",kind:"ghost"})],
],{rh:46});
small(t,"Leftovers are plain-text paragraphs flagged in the editor. Rewrite them as Blocks or Components, then the flag clears.",{textGrowth:"fixed-width",width:"fill_container"});
const R=fr(body,"Side",{layout:"vertical",width:340,gap:12});
const ok=fr(R,"Next",{layout:"vertical",width:"fill_container",padding:16,gap:8,cornerRadius:12,fill:"$bg",stroke:"$border",strokeWidth:1});tx(ok,"Next steps",{fontWeight:"600"});
for(const [i,t] of [["eye","Check the Drafts on the Staging address"],["triangle-alert","Fix the 14 Import leftovers"],["upload","Release everything with Publish all"]]){const rr=fr(ok,"N",{gap:8,alignItems:"center",width:"fill_container"});ic(rr,i,{width:14,height:14});tx(rr,t,{fontSize:12,textGrowth:"fixed-width",width:"fill_container"});}
const un=fr(R,"Undo",{layout:"vertical",width:"fill_container",padding:16,gap:8,cornerRadius:12,fill:"$bg",stroke:"$border",strokeWidth:1});tx(un,"Undo this run",{fontWeight:"600"});small(un,"Removes its 261 Entries, 806 Media files, 140 Redirect rules and the Recipes Post Type.",{textGrowth:"fixed-width",width:"fill_container",lineHeight:1.4});
const ub=fr(un,"b",{width:"fill_container",padding:[0,12],height:32,gap:6,cornerRadius:8,alignItems:"center",justifyContent:"center",stroke:"$danger",strokeWidth:1});ic(ub,"undo-2",{width:14,height:14,fill:"$danger"});tx(ub,"Undo run",{fontWeight:"500",fill:"$danger"});
small(un,"Available until anything from it is published or edited.",{textGrowth:"fixed-width",width:"fill_container",fill:"$muted-fg"});
const rr=fr(R,"Rerun",{layout:"vertical",width:"fill_container",padding:16,gap:6,cornerRadius:12,fill:"$bg",stroke:"$border",strokeWidth:1});tx(rr,"Running again",{fontWeight:"600"});small(rr,"Matches items by Source id: updates the ones nobody edited, skips hand-edited ones, adds new ones.",{textGrowth:"fixed-width",width:"fill_container",lineHeight:1.4});
note(R,"Login details for oldsite.acmebakery.ie are removed on 7 Dec, 30 days after the last run.",{icon:"key-round"});
Export([r],"png","/tmp/penproto/import/png/07-report");
