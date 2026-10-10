import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export const platforms=['darwin','win32','linux'];
export const architectures=['x64','arm64'];
export async function verifyRelease(directory,{commit}={}){
 const targets=[];const names=new Set();let version;
 for(const platform of platforms)for(const arch of architectures){
  const row=JSON.parse(await readFile(join(directory,`target-${platform}-${arch}.json`),'utf8'));
  if(row.schema!==1||row.platform!==platform||row.arch!==arch||!/^\d+\.\d+\.\d+$/.test(row.version)||!row.commit||commit&&row.commit!==commit)throw new Error('Target identity mismatch');
  if(version&&version!==row.version)throw new Error('Mixed release versions');version=row.version;
  if(targets.length&&row.commit!==targets[0].commit)throw new Error('Mixed source commits');
  if(!Array.isArray(row.files)||!row.files.length)throw new Error('Empty target');
  for(const file of row.files){
   if(!/^Nyora-[A-Za-z0-9._-]+$/.test(file.name)||!file.name.startsWith(`Nyora-${version}-`)||!file.name.includes(`-${arch}.`)||names.has(file.name))throw new Error('Invalid or duplicate asset');
   names.add(file.name);
   const bytes=await readFile(join(directory,file.name));
   if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('Artifact checksum mismatch');
  }
  if(!row.files.some(f=>f.name.endsWith({darwin:'.dmg',win32:'.exe',linux:'.AppImage'}[platform])))throw new Error('Missing installer');
  targets.push(row);
 }
 return {schema:1,complete:true,version,tag:`v${version}`,commit:targets[0].commit,targets};
}
export async function writeReleaseManifest(directory,manifest){
 await writeFile(join(directory,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 await writeFile(join(directory,'SHA256SUMS.txt'),manifest.targets.flatMap(t=>t.files.map(f=>`${f.sha256}  ${f.name}`)).sort().join('\n')+'\n');
}
