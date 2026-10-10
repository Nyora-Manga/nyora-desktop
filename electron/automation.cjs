'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const TASKS=['updates','sync','backup'];
const INTERVALS={updates:[0,60,360,720,1440],sync:[0,15,30,60],backup:[0,1440,10080]};
function validateAutomation(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([key,n])=>!INTERVALS[key]?.includes(n)))throw new Error('Invalid automation preferences');
}
class Automation {
  #state;#pending;#timer;#closed=false;
  constructor({directory,preferences,run,changed=()=>{},now=Date.now}){
    if(!path.isAbsolute(directory))throw new Error('Invalid automation directory');
    Object.assign(this,{directory,preferences,run,changed,now});
  }
  async #load(){
    if(this.#state)return;
    try {
      const file=path.join(this.directory,'schedule.json'),info=await fs.lstat(file);
      if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw new Error('Invalid automation journal');
      const state=JSON.parse(await fs.readFile(file,'utf8'));
      if(!state||Array.isArray(state)||Object.entries(state).some(([key,value])=>!TASKS.includes(key)||!value||!Number.isSafeInteger(value.at)||value.at<0||!['running','completed','failed'].includes(value.result)))throw new Error('Invalid automation journal');
      this.#state=state;
    }catch(error){if(error.code!=='ENOENT')throw error;this.#state={};}
  }
  async #save(){
    await fs.mkdir(this.directory,{recursive:true,mode:0o700});
    if((await fs.lstat(this.directory)).isSymbolicLink())throw new Error('Invalid automation directory');
    const temporary=path.join(this.directory,`.schedule-${randomUUID()}.pending`);
    try{
      const file=await fs.open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(this.#state));await file.sync();}finally{await file.close();}
      await fs.rename(temporary,path.join(this.directory,'schedule.json'));
    }finally{await fs.rm(temporary,{force:true});}
  }
  status(){return structuredClone(this.#state||{});}
  tick(){
    if(this.#closed)return Promise.resolve();
    if(this.#pending)return this.#pending;
    this.#pending=(async()=>{
      await this.#load();
      for(const task of TASKS){
        if(this.#closed)break;
        const config=(await this.preferences()).automation||{};validateAutomation(config);
        const minutes=config[task]||0,last=this.#state[task];
        if(!minutes||last&&this.now()-last.at<minutes*60000)continue;
        // Persist the attempt before dispatch; a crash must not cause a retry loop.
        this.#state[task]={at:this.now(),result:'running'};await this.#save();
        try{await this.run(task);this.#state[task].result='completed';}
        catch{this.#state[task].result='failed';}
        // A failed response can follow a committed write; refresh native caches either way.
        if(task!=='backup')this.changed();
        await this.#save();
      }
    })().finally(()=>{this.#pending=null;});return this.#pending;
  }
  start(){if(this.#timer||this.#closed)return;this.#timer=setInterval(()=>{void this.tick().catch(()=>{});},60000);this.#timer.unref?.();}
  async close(){this.#closed=true;clearInterval(this.#timer);await this.#pending?.catch(()=>{});}
}
module.exports={Automation,validateAutomation};
