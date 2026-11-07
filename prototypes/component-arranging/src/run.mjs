// PROTOTYPE runner: node run.mjs <snippet.js>...  -> each snippet becomes one execute() call on ../components.prototype.pen
import {readFileSync,writeFileSync} from 'fs';
import {execSync} from 'child_process';
const D=new URL('.',import.meta.url).pathname;
const file=D+'../components.prototype.pen';
const lib=['lib.js','ie_libie.js','cx.js'].map(f=>readFileSync(D+f,'utf8')).join('\n');
const lines=process.argv.slice(2).map(s=>`execute({ input: ${JSON.stringify(lib+'\n'+readFileSync(s,'utf8'))} })`);
writeFileSync(D+'gen/cmds.txt',lines.join('\n'));
const out=execSync(`bash ${D}pr.sh ${file} ${D}gen/cmds.txt`,{encoding:'utf8',maxBuffer:1e8});
console.log(out.split('\n').filter(l=>l.trim()).slice(-30).join('\n'));
