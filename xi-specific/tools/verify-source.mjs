import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=JSON.parse(fs.readFileSync(new URL('../source-manifest.json',import.meta.url),'utf8'));
if(manifest.format!=='xi-public-source-manifest-v1')throw Error('Unknown source manifest');
for(const item of manifest.files){
  const file=path.resolve(root,item.path),relative=path.relative(root,file);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Invalid source path');
  const bytes=fs.readFileSync(file);
  if(bytes.length!==item.bytes||createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('Source differs: '+item.path);
}
console.log(JSON.stringify({verifiedSourceFiles:manifest.files.length,accountOrNativeVerification:false,startedServices:false}));
