const {r,body}=cmChrome(0,1,"B1 · One column: page left, tree, settings and code stacked right",{});r.height=1010;
const M=fr(body,"Page side",{layout:"vertical",width:"fill_container",height:"fill_container"});crumbLine(M);
const {vp,E}=pageBox(M,940,830,{S:{quote:"sel"},scroll:600});
outlineBox(vp,80,322,780,80,"blockquote.quote__text",{mono:true});
insertBar(vp,{x:80,y:412,float:true,where:"After",w:"fit_content",items:[["heading","Heading"],["pilcrow","Paragraph"],["image","Image"],["link","Link"],["list","List"],["box","Div"],["repeat","Loop"],["git-branch","Condition"],["component","Component"]]})
const RC=dfr(body,"Right column",{layout:"vertical",width:500,height:"fill_container",stroke:K.line,strokeWidth:{left:1}});
const top=fr(RC,"Tree and settings",{layout:"vertical",width:"fill_container",height:470,stroke:K.line,strokeWidth:{bottom:1}});
const th=fr(top,"Tabs",{width:"fill_container",height:36,padding:[0,10],gap:8,alignItems:"center",stroke:K.line,strokeWidth:{bottom:1}});dseg(th,["Layers","Element"],"Layers");sp(th);dic(th,"search");dic(th,"chevrons-down-up");
const split=fr(top,"Split",{width:"fill_container",height:"fill_container"});
const T=fr(split,"Tree",{layout:"vertical",width:"fill_container",padding:[6,0],clip:true,height:"fill_container"});homeTree(T);
const cd=fr(RC,"Code",{layout:"vertical",width:"fill_container",height:"fill_container"});
const ch=fr(cd,"Code tabs",{width:"fill_container",height:36,padding:[0,10],gap:8,alignItems:"center",stroke:K.line,strokeWidth:{bottom:1}});dseg(ch,["HTML","CSS","JS"],"HTML");dt(ch,"Customer quote",{fill:K.muted});sp(ch);dic(ch,"wand-sparkles");dic(ch,"save");dic(ch,"maximize-2");
editor(cd,QHTML);
notes(r,[["Page keeps the width it can","Everything Code mode adds lives in one column on the right, like a browser's developer tools."],["Layers or Element","One tab at a time: the tree, or the settings of what is selected."],["One code panel at a time","HTML, CSS or JS as tabs; expand to fill the column."],["Insert floats on the page","Appears under the selected element: After, or Inside for containers."]]);
Export([r],"png",OUT+"B1");
