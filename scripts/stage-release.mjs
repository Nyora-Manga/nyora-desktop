import {readFile,readdir,mkdir,copyFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const {version}=JSON.parse(await readFile('package.json','utf8'));
const {platform,arch}=process;
const validationName=`runtime-validation-${platform}-${arch}.json`;
const validation=JSON.parse(await readFile(join('release',validationName),'utf8'));
if(validation.platform!==platform||validation.arch!==arch||!validation.frontend?.passed)throw new Error('Missing target validation');
const destination='release-assets';await mkdir(destination,{recursive:true});
const files=[];
for(const name of await readdir('release')){
 if(!name.startsWith(`Nyora-${version}-`)||!name.includes(`-${arch}.`)||!/(\.dmg|\.zip|\.exe|\.AppImage|\.tar\.gz)$/.test(name))continue;
 const data=await readFile(join('release',name));
 files.push({name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
 await copyFile(join('release',name),join(destination,name));
}
const primary={darwin:'.dmg',win32:'.exe',linux:'.AppImage'}[platform];
if(!files.some(f=>f.name.endsWith(primary)))throw new Error('Primary installer missing');
await copyFile(join('release',validationName),join(destination,validationName));
await writeFile(join(destination,`target-${platform}-${arch}.json`),JSON.stringify({schema:1,platform,arch,version,commit:process.env.GITHUB_SHA,files},null,2)+'\n');
console.log(`Staged ${platform}/${arch}: ${files.map(f=>f.name).join(', ')}`);
