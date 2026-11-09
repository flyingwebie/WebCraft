/**
 * The collection script: the Module's Site script, served as a file from the Site's own domain and
 * loaded deferred on every page where the Module runs (never inline, never in Edit mode). It runs
 * before visitors answer the Consent banner (`beforeConsent`), so it holds back itself what needs
 * Analytics consent (ADR 0020):
 *
 * Nothing is sent from a browser sending Do Not Track or Global Privacy Control (`webcraft.analytics`
 * is still there, so the Site's own code never fails). Otherwise:
 *
 * - always: one page view, with the path, the referring site's host (another site's only; `i` says
 *   the visitor came from the Site itself), the page's `utm_source`, `utm_medium` and
 *   `utm_campaign`, and the window's width. No cookie, no identifier: the server decides from the
 *   visitor's consent cookie whether it may count the visitor;
 * - only once Analytics is accepted (`webcraft.consent.has("analytics")`): clicks on outbound,
 *   download, phone and email links, custom events (`webcraft.analytics.track(name)`), and, when the
 *   visitor accepts on this page, a mark that starts their visit (the page view is already counted).
 *
 * Everything goes to the collection path on the Site's own domain (`connect-src 'self'`), with
 * `navigator.sendBeacon` as text. `c` says whether the page saw Analytics accepted; the server reads
 * the Consent banner's own answer itself, and takes the page's word only with an outside consent
 * service, which only the page can read. Keep it under 2 KB.
 */
export const COLLECTION_PATH = "/_wc/m/analytics/event";

export const COLLECTION_SCRIPT = `(()=>{var d=document,w=window,n=navigator,l=location,o=n.doNotTrack=="1"||n.globalPrivacyControl,k=()=>w.webcraft&&w.webcraft.consent,c=()=>{var x=k();return!x||x.has("analytics")},q=new URLSearchParams(l.search),r="",i=0;try{var u=new URL(d.referrer);u.host!=l.host?r=u.hostname:i=1}catch(e){}var b={p:l.pathname,r:r,i:i,us:q.get("utm_source"),um:q.get("utm_medium"),uc:q.get("utm_campaign"),w:innerWidth},s=(t,x)=>o||n.sendBeacon(${JSON.stringify(COLLECTION_PATH)},JSON.stringify(Object.assign({},b,x,{t:t,c:c()?1:0}))),a=c();s("pageview");d.addEventListener("webcraft:consent",()=>{if(a||!c())return;a=1;var o=k(),i=0,g=()=>o.mode=="outside"||/webcraft\\.consent=/.test(d.cookie)||++i>20?s("consent"):setTimeout(g,250);g()});var L=e=>{var h=e.target&&e.target.closest&&e.target.closest("a[href]");if(!h||!c())return;var p=h.protocol,m=p=="tel:"?"tel":p=="mailto:"?"mailto":!/^https?:$/.test(p)?"":h.host!=l.host?"outbound":h.hasAttribute("download")||/\\.(pdf|zip|docx?|xlsx?|pptx?|csv|txt|rtf|od[tsp]|epub|mp[34]|mov|dmg|exe|msi)$/i.test(h.pathname)?"download":"";if(m)s("link",{n:m,h:m=="outbound"?h.origin+h.pathname:m=="download"?h.pathname:h.href})};d.addEventListener("click",L,!0);d.addEventListener("auxclick",L,!0);w.webcraft=Object.assign(w.webcraft||{},{analytics:{track:e=>{if(c()&&typeof e=="string"&&e)s("event",{n:e.slice(0,100)})}}})})();
`;
