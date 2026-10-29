import {test} from 'node:test';
import assert from 'node:assert/strict';
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);},emit(...args){for(const fn of this.listeners)fn(...args);}});
test('automatic menu keeps restricted pages out of sidebar, detects MIME, and discards a probe after navigation',async()=>{
 const state={},opened=[],probes=[],injected=[],badges=[];
 const tab={id:12,windowId:3,active:true,url:'https://example.test/download?id=1'};
 const area={setAccessLevel:async()=>{},get:async()=>structuredClone(state),set:async value=>Object.assign(state,structuredClone(value))};
 globalThis.chrome={
  runtime:{id:'own',getURL:p=>'chrome-extension://own/'+p,onInstalled:event(),onStartup:event(),onConnect:event(),onMessage:event(),lastError:undefined},
  storage:{local:area,session:area,onChanged:event()},
  action:{onClicked:event(),setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async value=>badges.push(value.title)},
  contextMenus:{onClicked:event()},commands:{onCommand:event()},
  tabs:{onRemoved:event(),onUpdated:event(),onDetached:event(),onReplaced:event(),onActivated:event(),sendMessage:async()=>{},query:(_query,cb)=>cb?cb([tab]):Promise.resolve([tab]),get:async()=>tab},
  windows:{WINDOW_ID_CURRENT:-2,onRemoved:event(),onFocusChanged:event()},
  sidePanel:{close:async()=>{},open:options=>{opened.push(options);return Promise.resolve();}},
  scripting:{executeScript:(options,cb)=>{if(cb){probes.push(cb);return;}injected.push(options);return Promise.resolve([{result:'text/html'}]);}}
 };
 const {handleContextMenu}=await import('../extension/background.js');
 const info={menuItemId:'translate-selection',selectionText:'selected text'};
 let promise=handleContextMenu(info,tab);assert.equal(opened.length,0);
 chrome.runtime.lastError={message:'Cannot access a restricted page'};probes.shift()();chrome.runtime.lastError=undefined;await promise;
 assert.equal(opened.length,0);assert.match(badges.at(-1),/无法识别/);
 promise=handleContextMenu(info,tab);probes.shift()([{result:'application/pdf'}]);await promise;assert.equal(opened.length,1);
 promise=handleContextMenu(info,tab);chrome.tabs.onUpdated.emit(tab.id,{status:'loading'});probes.shift()([{result:'application/pdf'}]);await promise;assert.equal(opened.length,1);
 promise=handleContextMenu({...info,pageUrl:'https://example.test/login.pdf'},tab);probes.shift()([{result:'text/html'}]);await promise;assert.equal(opened.length,1);assert.ok(injected.some(item=>item.files?.includes('content.js')));
 promise=handleContextMenu({...info,srcUrl:'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/pdf'}, {id:-1,windowId:-1});assert.equal(opened.length,2);assert.deepEqual(opened.at(-1),{windowId:-2});await promise;
 const before=probes.length;await handleContextMenu({...info,selectionText:'  '},tab);assert.equal(probes.length,before);assert.equal(opened.length,2);
});
