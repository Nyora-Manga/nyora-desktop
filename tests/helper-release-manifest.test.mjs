import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyRelease,canonicalArtifactName} from '../scripts/release-manifest.mjs';
test('release gate requires all six matching targets and verifies artifact bytes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'nyora-release-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await assert.rejects(verifyRelease(root));
 for(const platform of ['darwin','win32','linux'])for(const arch of ['x64','arm64']){
  const name=`Nyora-0.3.1-${platform}-${arch}${{darwin:'.dmg',win32:'.exe',linux:'.AppImage'}[platform]}`;
  const bytes=Buffer.from(platform+arch);await writeFile(join(root,name),bytes);
  await writeFile(join(root,`target-${platform}-${arch}.json`),JSON.stringify({schema:1,platform,arch,version:'0.3.1',commit:'fixture',files:[{name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]}));
 }
 const result=await verifyRelease(root,{commit:'fixture'});assert.equal(result.targets.length,6);assert.equal(result.complete,true);
 await assert.rejects(verifyRelease(root,{commit:'another'}),/identity/);
 await writeFile(join(root,result.targets[0].files[0].name),'changed');
 await assert.rejects(verifyRelease(root),/checksum/);
});

test('AppImage architecture naming is normalized only for native Linux x64 staging',()=>{
 const input='Nyora-3.0.7-linux-x86_64.AppImage';
 assert.equal(canonicalArtifactName(input,{platform:'linux',arch:'x64'}),'Nyora-3.0.7-linux-x64.AppImage');
 for(const target of [{platform:'linux',arch:'arm64'},{platform:'darwin',arch:'x64'},{platform:'win32',arch:'x64'}])assert.equal(canonicalArtifactName(input,target),input);
 for(const input of ['Nyora-3.0.7-linux-arm64.AppImage','Nyora-3.0.7-linux-x64.tar.gz'])assert.equal(canonicalArtifactName(input,{platform:'linux',arch:'x64'}),input);
});
