import {test} from 'node:test';
import assert from 'node:assert/strict';
function event(){const listeners=[];return {addListener:fn=>listeners.push(fn),emit:(...args)=>listeners.forEach(fn=>fn(...args))};}
let index=0;
async function setup(stored={}) {
 const state={panelSelections:stored}, calls=[], tabs=new Map(), active=new Map();
 globalThis.chrome={runtime:{id:'own-id',getURL:path=>`chrome-extension://own-id/${path}`},storage:{session:{setAccessLevel:async()=>{},get:async()=>structuredClone(state),set:async value=>Object.assign(state,structuredClone(value))}},sidePanel:{close:async()=>{},open:options=>{calls.push(options);return Promise.resolve();}},tabs:{get:async id=>tabs.get(id),query:async()=>[...tabs.values()].filter(t=>t.active)},windows:{WINDOW_ID_CURRENT:-2,onRemoved:event()}};
 const api=await import(`../extension/lib/panel.mjs?test=${++index}`);await api.panelReady;
 const port=()=>({onMessage:event(),onDisconnect:event(),sent:[],postMessage(message){this.sent.push(message);}});
 return {api,state,calls,tabs,active,port};
}
test('trusted page validation allows own extension tabs/fragments and rejects other paths/origins/frames',async()=>{
 const {api}=await setup();const own={id:'own-id',tab:{id:4},frameId:0,url:'chrome-extension://own-id/options.html#preferences'};
 assert.equal(api.trustedPage(own,'options.html'),true);
 for(const patch of [{id:'other'},{url:'chrome-extension://foreign/options.html'},{url:'https://example.com/options.html'},{url:'chrome-extension://own-id/options.html/evil'},{frameId:2}])assert.equal(api.trustedPage({...own,...patch},'options.html'),false);
 assert.equal(api.trustedPage({...own,url:'chrome-extension://own-id/sidepanel.html?x=1'},'sidepanel.html'),true);
});
test('menu calls open synchronously, replaces old job, aborts prior fetch and reports empty text',async()=>{
 const {api,calls,active}=await setup();let aborted=false;
 active.set('panel:3',{controller:{abort(){aborted=true;}}});
 const promise=api.openSelectionPanel({selectionText:' 原文\n第二行 '},{id:8,windowId:3},active,async()=>{});
 assert.deepEqual(calls,[{windowId:3}]);assert.equal(aborted,true);assert.equal(api.panelJobs.get(3).text,' 原文\n第二行 ');
 const old=api.panelJobs.get(3).requestId;
 await api.openSelectionPanel({selectionText:'replacement'},{id:8,windowId:3},active,async()=>{});
 assert.notEqual(api.panelJobs.get(3).requestId,old);await promise;
 await api.openSelectionPanel({selectionText:' \n '},{id:8,windowId:3},active,async()=>{});assert.equal(calls.length,3);assert.equal(api.panelJobs.has(3),false);
});
test('PDF menu missing tab/window opens current window synchronously before active-tab lookup',async()=>{
 const {api,calls,tabs,active,state}=await setup();tabs.set(8,{id:8,windowId:3,active:true});
 for(const tab of [undefined,{id:-1,windowId:-1},{id:8}]) {
  const expected=tab?.id===8?{tabId:8}:{windowId:-2};
  const promise=api.openSelectionPanel({selectionText:'PDF selection'},tab,active,async()=>{});
  assert.deepEqual(calls.at(-1),expected);await promise;assert.equal(api.panelJobs.get(3).tabId,8);
 }
 await new Promise(r=>setTimeout(r,0));assert.equal(state.lastPanelEvent.stage,'opened');
 assert.ok(!JSON.stringify(state.lastPanelEvent).includes('PDF selection'));
});
test('open rejection and absent selection produce session diagnostics instead of silent returns',async()=>{
 const {api,active,state,tabs}=await setup();const badges=[];tabs.set(8,{id:8,windowId:3,active:true});
 chrome.sidePanel.open=()=>Promise.reject(new Error('may only be called in response to a user gesture'));
 await api.openSelectionPanel({selectionText:'private sample'},undefined,active,async(id,message)=>badges.push({id,message}));
 await new Promise(r=>setTimeout(r,0));assert.equal(state.lastPanelEvent.code,'OPEN_GESTURE');assert.equal(api.panelJobs.has(3),false);assert.ok(badges.at(-1).message.includes('手势'));
 chrome.sidePanel.open=()=>Promise.resolve();await api.openSelectionPanel({},undefined,active,async()=>{});
 await new Promise(r=>setTimeout(r,0));assert.equal(state.lastPanelEvent.code,'NO_SELECTION');assert.equal(state.lastPanelEvent.selectionLength,0);
});
test('late open failure cannot erase a newer successful selection',async()=>{
 const {api,active}=await setup();let reject;
 chrome.sidePanel.open=()=>new Promise((_,bad)=>{reject=bad;});
 const first=api.openSelectionPanel({selectionText:'old'},{id:8,windowId:3},active,async()=>{});
 chrome.sidePanel.open=()=>Promise.resolve();await api.openSelectionPanel({selectionText:'new'},{id:8,windowId:3},active,async()=>{});
 reject(new Error('open failed'));await first;assert.equal(api.panelJobs.get(3).text,'new');
});
test('control-port bootstrap validates source tab, disconnection clears only its own window',async()=>{
 const {api,active,tabs,port}=await setup();tabs.set(8,{id:8,windowId:3,active:true});tabs.set(9,{id:9,windowId:4,active:true});
 for(const [id,windowId] of [[8,3],[9,4]])await api.openSelectionPanel({selectionText:`window ${windowId}`},{id,windowId},active,async()=>{});
 const p=port();api.connectPanel(p,active);p.onMessage.emit({type:'hello',windowId:3});await new Promise(r=>setTimeout(r,0));
 assert.equal(p.sent.at(-1).job.tabId,8);p.onDisconnect.emit();assert.equal(api.panelJobs.has(3),false);assert.equal(api.panelJobs.has(4),true);
 const other=port();tabs.set(9,{id:9,windowId:4,active:false});api.connectPanel(other,active);other.onMessage.emit({type:'hello',windowId:4});await new Promise(r=>setTimeout(r,0));assert.equal(api.panelJobs.has(4),false);assert.equal(other.sent.at(-1).job,null);
});
test('session restores after worker restart; navigation clear prevents stale source reuse',async()=>{
 const saved={windowId:3,tabId:8,requestId:'previous',text:'session only',triggeredAt:1};const {api,active}=await setup({3:saved});
 assert.equal(api.panelJobs.get(3).text,'session only');api.clearPanelForTab(8,active);assert.equal(api.panelJobs.has(3),false);
});
test('closing panel disconnect and stale dismiss cannot erase a replacement request',async()=>{
 const {api,active,tabs,port}=await setup();tabs.set(8,{id:8,windowId:3,active:true});
 await api.openSelectionPanel({selectionText:'old'},{id:8,windowId:3},active,async()=>{});
 const oldId=api.panelJobs.get(3).requestId;
 const control=port();api.connectPanel(control,active);control.onMessage.emit({type:'hello',windowId:3});await new Promise(r=>setTimeout(r,0));
 api.clearPanelForTab(8,active);await new Promise(r=>setTimeout(r,0));
 await api.openSelectionPanel({selectionText:'replacement'},{id:8,windowId:3},active,async()=>{});
 control.onMessage.emit({type:'dismiss',requestId:oldId});assert.equal(api.panelJobs.get(3).text,'replacement');
 control.onDisconnect.emit();assert.equal(api.panelJobs.get(3).text,'replacement');
 const fresh=port();api.connectPanel(fresh,active);fresh.onMessage.emit({type:'hello',windowId:3});await new Promise(r=>setTimeout(r,0));
 fresh.onMessage.emit({type:'dismiss',requestId:api.panelJobs.get(3).requestId});assert.equal(api.panelJobs.has(3),false);
});
