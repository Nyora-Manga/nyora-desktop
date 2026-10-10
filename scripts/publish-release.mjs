import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {verifyRelease,writeReleaseManifest} from './release-manifest.mjs';
const directory=process.argv[2]||'release-assets',repo=process.env.GITHUB_REPOSITORY,token=process.env.GH_TOKEN;
if(!/^Nyora-Manga\/nyora-desktop$/.test(repo||'')||!token)throw new Error('Release repository/token missing');
const manifest=await verifyRelease(directory,{commit:process.env.GITHUB_SHA});
await writeReleaseManifest(directory,manifest);
async function api(path,options={}){
 const response=await fetch(`https://api.github.com/repos/${repo}${path}`,{...options,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json',...options.headers}});
 if(response.status===404&&options.allowMissing)return null;
 if(!response.ok)throw new Error(`GitHub release API ${response.status}`);
 return response.status===204?null:response.json();
}
let release=await api(`/releases/tags/${manifest.tag}`,{allowMissing:true});
if(release&&!release.draft){
 if(release.target_commitish!==manifest.commit)throw new Error('Published release belongs to another commit');
 console.log(`Already published: ${release.html_url}`);process.exit(0);
}
const downloads=manifest.targets.map(t=>`| ${{darwin:'macOS',win32:'Windows',linux:'Linux'}[t.platform]} | ${t.arch} | ${t.files.map(f=>`[${f.name}](https://github.com/${repo}/releases/download/${manifest.tag}/${f.name})`).join(' · ')} |`).join('\n');
const body=`Nyora ${manifest.tag} — Electron desktop release. All six native target builds passed before publication.\n\n| Platform | CPU | Downloads |\n|---|---|---|\n${downloads}\n\nSee [installation and migration instructions](https://github.com/${repo}/blob/${manifest.commit}/docs/INSTALL.md). Java and Chromium are bundled; no separate server is needed. These builds are unsigned/not notarized. Native Compose desktop clients are deprecated.\n\nVerify downloads with SHA256SUMS.txt. Built from ${manifest.commit}. Platform repositories mirror these exact files.\n`;
if(!release)release=await api('/releases',{method:'POST',body:JSON.stringify({tag_name:manifest.tag,target_commitish:manifest.commit,name:`Nyora ${manifest.tag}`,body,draft:true,prerelease:false})});
for(const asset of release.assets||[])await api(`/releases/assets/${asset.id}`,{method:'DELETE'});
const files=(await readdir(directory)).filter(name=>manifest.targets.some(t=>t.files.some(f=>f.name===name))||/^(release-manifest\.json|SHA256SUMS\.txt|runtime-validation-(darwin|win32|linux)-(x64|arm64)\.json)$/.test(name));
for(const name of files){
 const bytes=await readFile(join(directory,name));
 const response=await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream'},body:bytes});
 if(!response.ok)throw new Error(`Upload failed: ${name} (${response.status})`);
}
release=await api(`/releases/${release.id}`,{method:'PATCH',body:JSON.stringify({draft:false,make_latest:'true',body})});
console.log(release.html_url);
