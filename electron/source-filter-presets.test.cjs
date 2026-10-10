const test = require('node:test');
const assert = require('node:assert/strict');
const {DevicePreferences, validatePatch} = require('./preferences.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const preset = {sourceId:'data:mangadex',name:'Completed adventure',query:'',filters:[{name:'Tags',type:'text',value:'opaque-id'},{name:'State',type:'text',value:'FINISHED'}]};
test('source presets survive native preferences reload', async () => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nyora-preset-test-'));
 try { await new DevicePreferences(dir).save({sourceFilterPresets:[preset]}); assert.deepEqual((await new DevicePreferences(dir).get()).sourceFilterPresets,[preset]); }
 finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('native presets reject oversized, malformed, and duplicate entries', () => {
 for(const items of [[{...preset,sourceId:''}],[{...preset,filters:[{name:'Tags',type:'script',value:'x'}]}],[{...preset,name:'a'.repeat(81)}],Array(21).fill(preset),[preset,preset]]) assert.throws(()=>validatePatch({sourceFilterPresets:items}));
});
