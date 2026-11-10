/** Necessary local state; no tracking identifier and no network calls. */
export const POPUP_SCRIPT = `(()=>{
 const templates=[...document.querySelectorAll('template[data-wc-popup]')];
 if(!templates.length)return;
 const prefix='webcraft.popups.'+templates[0].dataset.site+'.',memory=new Map();
 const read=key=>{if(memory.has(key))return memory.get(key);try{return localStorage.getItem(prefix+key)}catch{return memory.get(key)||null}};
 const write=(key,value)=>{memory.set(key,value);try{localStorage.setItem(prefix+key,value)}catch{}};
 const now=Date.now(),returning=read('visited')!==null;
 const previousVisit=Number(read('visit')),lastActivity=Number(read('activity'));
 const visit=previousVisit>0&&now-lastActivity<1800000?previousVisit:now;
 write('visited','1');write('visit',String(visit));write('activity',String(now));
 const state=item=>{try{const value=JSON.parse(read(item.id)||'{}');return value&&typeof value==='object'?value:{}}catch{return {}}};
 const record=(item,patch)=>write(item.id,JSON.stringify({...state(item),...patch}));
 const active={bar:null,promotion:null},releases=new Map(),closers=new Map(),queue=[],attempted=new Set(),cleanups=[];
 let stopped=false,answered=false,started=false;
 const consent=window.webcraft&&window.webcraft.consent;
 const device=item=>innerWidth<item.config.phoneWidth?'phone':innerWidth<item.config.tabletWidth?'tablet':'desktop';
 const eligible=item=>{
  const c=item.config,time=Date.now(),s=state(item);
  if(c.start&&time<Date.parse(c.start)||c.end&&time>=Date.parse(c.end))return false;
  if(!c.attached&&!c.rules.devices.includes(device(item)))return false;
  if(!c.attached&&(c.rules.visitors==='new'&&returning||c.rules.visitors==='returning'&&!returning))return false;
  switch(c.frequency.kind){
   case 'visit':return !(Number(s.shownAt)>=visit);
   case 'interval':return !(Number(s.shownAt)>0&&time-Number(s.shownAt)<c.frequency.days*86400000);
   case 'closed':return s.closed!==true;
   case 'submitted':return s.submitted!==true;
   default:return true;
  }
 };
 const track=(item,action)=>{try{window.webcraft?.analytics?.track('popup-'+action+':'+item.config.key)}catch{}};
 const listen=(target,name,fn,options)=>{target.addEventListener(name,fn,options);cleanups.push(()=>target.removeEventListener(name,fn,options));};
 const timer=(fn,ms)=>{const id=setTimeout(fn,ms);cleanups.push(()=>clearTimeout(id));return id;};
 const group=item=>item.config.layout==='bar'?'bar':'promotion';
 const drain=()=>{
  if(stopped||!answered||consent&&!consent.answered)return;
  queue.sort((a,b)=>a.order-b.order);
  for(let i=0;i<queue.length;){
   const item=queue[i],slot=group(item);
   if(active[slot]){i++;continue;}
   queue.splice(i,1);
   if(!eligible(item)||!item.template.isConnected)continue;
   let dialog;
   try{
    const fragment=item.template.content.cloneNode(true);dialog=fragment.querySelector('dialog');if(!dialog)continue;
    const previous=document.activeElement,modal=['modal','full-screen'].includes(item.config.layout);
    active[slot]=dialog;
    const release=()=>{
     if(active[slot]!==dialog)return;
     active[slot]=null;releases.delete(dialog);closers.delete(dialog);dialog.remove();
     if(!stopped&&previous instanceof HTMLElement&&previous.isConnected)previous.focus({preventScroll:true});
     queueMicrotask(drain);
    };
    const close=()=>{record(item,{closed:true});track(item,'closed');dialog.close();};
    const submitted=()=>{record(item,{submitted:true});const seconds=item.config.afterSubmitCloseSeconds;if(seconds!==null)timer(()=>{if(dialog.isConnected)close()},seconds*1000);};
    releases.set(dialog,release);closers.set(dialog,close);dialog.addEventListener('close',release,{once:true});
    dialog.querySelector('[data-wc-popup-close]').addEventListener('click',close);
    dialog.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close();}});
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    dialog.addEventListener('webcraft:form-submitted',submitted);
    dialog.addEventListener('click',event=>{
     const c=item.config;
     if(c.backdropClose&&modal&&event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}
     if(c.mainButton&&event.target.closest?.(c.mainButton)){record(item,{submitted:true});track(item,'clicked');}
    });
    document.body.append(fragment);if(modal)dialog.showModal();else dialog.show();
    record(item,{shownAt:Date.now()});track(item,'shown');
    dialog.dispatchEvent(new CustomEvent('webcraft:mounted',{bubbles:true}));
    if(modal)dialog.querySelector('[data-wc-popup-close]').focus();
    if(item.config.autoCloseSeconds!==null)timer(()=>{if(dialog.isConnected)close()},item.config.autoCloseSeconds*1000);
   }catch{if(dialog){releases.delete(dialog);closers.delete(dialog);dialog.remove();}active[slot]=null;}
  }
 };
 const request=item=>{if(stopped||attempted.has(item.id))return;attempted.add(item.id);queue.push(item);drain();};
 const items=[];
 for(const [order,template] of templates.entries()){
  let config;try{config=JSON.parse(template.dataset.wcPopup)}catch{continue;}
  items.push({template,config,id:template.dataset.popupId,order});
 }
 const start=()=>{
  if(stopped)return;answered=true;if(started){drain();return;}started=true;
  for(const item of items)for(const t of [item.config.trigger,...item.config.additionalTriggers]){
   if(t.kind==='load')request(item);
   if(t.kind==='delay')timer(()=>request(item),t.seconds*1000);
   if(t.kind==='scroll'){
    const scroll=()=>{const height=document.documentElement.scrollHeight-innerHeight;if(height>0&&scrollY/height*100>=t.percent)request(item);};
    listen(window,'scroll',scroll,{passive:true});scroll();
   }
   if(t.kind==='element'&&typeof IntersectionObserver==='function'){
    const element=document.querySelector(t.selector);if(element){const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){request(item);observer.disconnect();}});observer.observe(element);cleanups.push(()=>observer.disconnect());}
   }
   if(t.kind==='exit')listen(document,'mouseout',event=>{if(device(item)==='desktop'&&!event.relatedTarget&&event.clientY<=0)request(item);});
   if(t.kind==='idle'){
    let id;const reset=()=>{clearTimeout(id);id=setTimeout(()=>request(item),t.seconds*1000);};
    for(const name of ['pointerdown','pointermove','keydown','scroll'])listen(document,name,reset,{passive:true});
    reset();cleanups.push(()=>clearTimeout(id));
   }
  }
  drain();
 };
 listen(document,'click',event=>{
  const link=event.target.closest?.('a[href],button[data-popup]');
  if(!link||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||event.button!==0)return;
  const item=items.find(i=>i.id===link.dataset.wcPopupOpen||link.getAttribute('href')==='#popup-'+i.config.key||link.dataset.popup===i.config.key);
  if(!item||![item.config.trigger,...item.config.additionalTriggers].some(t=>t.kind==='click'))return;
  event.preventDefault();request(item);
 });
 listen(document,'keydown',event=>{if(event.key!=='Escape'||event.defaultPrevented)return;const dialog=active.promotion||active.bar,modal=document.querySelector('dialog:modal');if(dialog&&(!modal||modal===dialog)){event.preventDefault();closers.get(dialog)?.();}});
 let touched=now;
 const touch=()=>{const time=Date.now();if(time-touched>60000){touched=time;write('activity',String(time));}};
 for(const name of ['pointerdown','pointermove','keydown','scroll'])listen(document,name,touch,{passive:true});
 const observer=new MutationObserver(()=>{for(const slot of ['bar','promotion'])if(active[slot]&&!active[slot].isConnected)releases.get(active[slot])?.();});
 observer.observe(document.body,{childList:true,subtree:true});cleanups.push(()=>observer.disconnect());
 const stop=()=>{stopped=true;queue.length=0;for(const clean of cleanups)clean();for(const dialog of Object.values(active))if(dialog){dialog.close();dialog.remove();}};
 listen(window,'pagehide',stop);listen(window,'popstate',stop);
 listen(document,'webcraft:consent',event=>{answered=event.detail.answered;if(answered)start();});
 Promise.resolve(consent?consent.whenAnswered():undefined).then(start).catch(()=>{});
})();`;
