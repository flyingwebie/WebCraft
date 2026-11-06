const v="C",N="C · Top bar + tabs",Y=2*1500;const ids=[];
const mk=(i,nm,o={})=>{const r=screen(N+" · "+nm,i*1540,Y,o);ids.push(r);return r;};
{const r=mk(0,"1 Blog posts");entries(shell(v,r,"site"));}
{const r=mk(1,"2 Switching");entries(shell(v,r,"site"));if(v=="B")palette(r,1440,900);else if(v=="C")wsSitesPopover(r,60,52);else wsSitesPopover(r,12,68);}
{const r=mk(2,"3 Workspace Sites");sitesPage(shell(v,r,"ws"));}
{const r=mk(3,"4 Superadmin");installPage(shell(v,r,"install"));}
{const r=mk(4,"5 Domains & Staging",{h:1320});domains(shell(v,r,"settings"));}
{const r=mk(5,"6 Publish all");entries(shell(v,r,"site"));publishOverlay(r,1440,900);}
{const r=mk(6,"7 Dark",{dark:true});entries(shell(v,r,"site"));}
{const r=mk(7,"8 Superadmin dark",{dark:true});installPage(shell(v,r,"install"));}
Export(ids,"png","/tmp/penproto/out2/C");
Print("IDS",ids.join(","));
