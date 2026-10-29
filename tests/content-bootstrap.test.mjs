import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../extension/content.js',import.meta.url),'utf8');
const {version}=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url),'utf8'));
function load(previous,nodes=[]) {
  let listeners=0;
  const context={__selectedLineTranslator:previous,document:{querySelectorAll:()=>nodes},chrome:{runtime:{onMessage:{addListener(){listeners++;}}}}};
  vm.runInNewContext(source,context);
  return {context,listeners};
}
test('current content build is reused without adding listeners or disposing itself',()=>{
  const previous={version,dispose(){throw new Error('must not dispose current build');}};
  const {context,listeners}=load(previous);assert.equal(context.__selectedLineTranslator,previous);assert.equal(listeners,0);
});
test('invalidated old runtime cannot prevent new content build from replacing its own stale popup',()=>{
  const own={shadowRoot:{querySelector:()=>({})},hidden:false,removed:false,remove(){this.removed=true;}};
  const unrelated={shadowRoot:{querySelector:()=>null},removed:false,remove(){this.removed=true;}};
  const {context,listeners}=load({version:'old',dispose(){throw new Error('Extension context invalidated');}},[own,unrelated]);
  assert.equal(context.__selectedLineTranslator.version,version);assert.equal(listeners,1);
  assert.equal(own.hidden,true);assert.equal(own.removed,true);assert.equal(unrelated.removed,false);
});
