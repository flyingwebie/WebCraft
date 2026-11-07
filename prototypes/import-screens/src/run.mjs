// usage: node run.mjs <file.pen> <snippet.js>...  -> each snippet becomes one execute() call (libx.js prepended)
import {readFileSync,writeFileSync} from 'fs';
import {execSync} from 'child_process';
const [file,...snips]=process.argv.slice(2);
const lib=readFileSync(new URL('./libx.js',import.meta.url),'utf8');
const lines=snips.map(s=>`execute({ input: ${JSON.stringify(lib+'\n'+readFileSync(s,'utf8'))} })`);
const cmds=`/tmp/penproto/gen/cmds-${process.pid}.txt`;
writeFileSync(cmds,lines.join('\n'));
const out=execSync(`/tmp/penproto/pr.sh ${file} ${cmds}`,{encoding:'utf8',maxBuffer:1e8});
console.log(out.split('\n').filter(l=>l.trim()).slice(-40).join('\n'));
