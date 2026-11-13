/** Progressive enhancement: native disclosures and static galleries need no script. Tabs keep
 * their headings and become an ARIA tabset only after Media consent. Maps keep their usable link. */
export const SCRIPT = `(() => {
 const doc = document;
 let sequence = 0;
 const enhance = () => {
 for (const root of doc.querySelectorAll('[data-extra-block="tabs"]')) {
  if (root.dataset.enhanced) continue;
  const panels = Array.from(root.children).filter(node => node instanceof HTMLElement && node.tagName === "SECTION");
  if (!panels.length) continue;
  root.dataset.enhanced = "true";
  const list = doc.createElement("div");
  list.setAttribute("role", "tablist");
  list.setAttribute("aria-label", root.getAttribute("aria-label") || "Tabs");
  const buttons = panels.map((panel, index) => {
   const button = doc.createElement("button");
   button.type = "button";
   let id;
   do { id = "wc-extra-tabs-" + ++sequence; }
   while (doc.getElementById(id + "-tab") || doc.getElementById(id + "-panel"));
   button.id = id + "-tab";
   panel.id = id + "-panel";
   button.textContent = panel.querySelector("h2")?.textContent || String(index + 1);
   button.setAttribute("role", "tab");
   button.setAttribute("aria-controls", panel.id);
   panel.setAttribute("role", "tabpanel");
   panel.setAttribute("aria-labelledby", button.id);
   panel.tabIndex = 0;
   list.append(button);
   return button;
  });
  const select = (index, focus = false) => {
   buttons.forEach((button, i) => {
    button.setAttribute("aria-selected", String(i === index));
    button.tabIndex = i === index ? 0 : -1;
    panels[i].hidden = i !== index;
   });
   if (focus) buttons[index]?.focus();
  };
  buttons.forEach((button, index) => {
   button.addEventListener("click", () => select(index));
   button.addEventListener("keydown", event => {
    const next = event.key === "Home" ? 0
     : event.key === "End" ? buttons.length - 1
     : event.key === "ArrowRight" ? (index + 1) % buttons.length
     : event.key === "ArrowLeft" ? (index + buttons.length - 1) % buttons.length : null;
    if (next !== null) { event.preventDefault(); select(next, true); }
   });
  });
  root.prepend(list);
  select(0);
 }
 for (const root of doc.querySelectorAll('[data-extra-block="map"]')) {
  if (root.dataset.enhanced) continue;
  const link = root.querySelector("a");
  if (!link) continue;
  let url;
  try { url = new URL(link.href); } catch { continue; }
  if (url.protocol !== "https:" || url.hostname !== "www.openstreetmap.org" || url.port ||
   url.username || url.password || url.pathname !== "/export/embed.html") continue;
  root.dataset.enhanced = "true";
  const frame = doc.createElement("iframe");
  frame.title = link.textContent || "Map";
  frame.loading = "lazy";
  frame.referrerPolicy = "no-referrer";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.height = "400";
  const fit = () => { frame.width = String(Math.max(1, Math.min(600, root.clientWidth))); };
  fit();
  if (typeof ResizeObserver === "function") new ResizeObserver(fit).observe(root);
  frame.src = url.href;
  root.append(frame);
 }
 };
 doc.addEventListener('webcraft:mounted', enhance);
 enhance();
})();`;
