import test from 'node:test';
import assert from 'node:assert/strict';
import * as commands from '../frontend/desktop-commands.js';

test('library search keeps same-title results from distinct sources and never fetches content', async () => {
  assert.equal(typeof commands.librarySearchCommands, 'function');
  const calls=[];
  const services={snapshot:()=>({favourites:[
    {id:'one',title:'Blue Garden',url:'https://example.org/title',source:{name:'data:ONE'}},
    {id:'two',title:'Blue Garden',url:'https://example.org/title',source:{name:'data:TWO'}},
    {id:'bad',title:'Blue Garden',url:'javascript:alert(1)',source:{name:'data:ONE'}},
  ]}),request(){assert.fail('search must remain local');}};
  const rows=commands.librarySearchCommands(services,{navigate:(...args)=>calls.push(args)},'blue');
  assert.equal(rows.length,2);
  assert.notEqual(rows[0].id,rows[1].id);
  await rows[1].run();
  assert.deepEqual(calls,[['details',{sid:'data:TWO',url:'https://example.org/title'}]]);
  assert.deepEqual(commands.librarySearchCommands(services,{},''),[]);
});

test('library search matches alternate titles and caps results without changing the saved collection', () => {
  assert.equal(typeof commands.librarySearchCommands, 'function');
  const favourites=Array.from({length:80},(_,i)=>({id:String(i),title:'Title '+i,altTitles:['Garden'],url:'https://example.org/'+i,source:'data:ONE'}));
  const before=structuredClone(favourites);
  const rows=commands.librarySearchCommands({snapshot:()=>({favourites})},{},'Ｇａｒｄｅｎ');
  assert.equal(rows.length,20);
  assert.deepEqual(favourites,before);
});
