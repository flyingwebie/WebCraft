import {readFileSync,writeFileSync} from 'fs';
import {execSync} from 'child_process';
const D='/tmp/penproto-ie';
const [file,...snips]=process.argv.slice(2);
const lib=readFileSync(D+'/lib.js','utf8')+'\n'+readFileSync(D+'/libie.js','utf8');
const lines=snips.map(s=>`execute({ input: ${JSON.stringify(lib+'\n'+readFileSync(s,'utf8'))} })`);
writeFileSync(D+'/gen/cmds.txt',lines.join('\n'));
const out=execSync(`${D}/pr.sh ${file} ${D}/gen/cmds.txt`,{encoding:'utf8',maxBuffer:1e8});
console.log(out.split('\n').filter(l=>l.trim()).slice(-40).join('\n'));
