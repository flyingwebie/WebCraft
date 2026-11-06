// usage: node run.mjs <file.pen> <snippet.js>...  -> each snippet becomes one execute() call
import {readFileSync,writeFileSync} from 'fs';
import {execSync} from 'child_process';
const [file,...snips]=process.argv.slice(2);
const lib=readFileSync(new URL('./lib.js',import.meta.url),'utf8');
const lines=snips.map(s=>`execute({ input: ${JSON.stringify(lib+'\n'+readFileSync(s,'utf8'))} })`);
writeFileSync('/tmp/penproto/gen/cmds.txt',lines.join('\n'));
const out=execSync(`/tmp/penproto/pr.sh ${file} /tmp/penproto/gen/cmds.txt`,{encoding:'utf8',maxBuffer:1e8});
console.log(out.split('\n').filter(l=>l.trim()).slice(-60).join('\n'));
