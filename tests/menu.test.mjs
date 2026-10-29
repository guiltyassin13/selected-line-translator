import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectionMenu, nativePdfFrame, localPdfUrl} from '../extension/lib/menu.mjs';
test('one root selection entry is independent of legacy preferences',()=>{
  for(const mode of [undefined,'popup','sidepanel']) assert.deepEqual(selectionMenu(mode), {id:'translate-selection',title:'翻译选中内容',contexts:['selection']});
});
test('PDF metadata uses exact viewer identity and local PDF paths',()=>{
  assert.equal(nativePdfFrame({frameUrl:'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html'}),true);
  assert.equal(nativePdfFrame({srcUrl:'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/document-id'}),true);
  for(const frameUrl of ['chrome://settings/','https://example.com/a.pdf','chrome-extension://unknown/index.html','https://mhjfbmdgcfjbbpaeojofohoefgiehjai/']) assert.equal(nativePdfFrame({frameUrl}),false);
  assert.equal(localPdfUrl('file:///fixtures/a%20b.PDF?x=1#page=2'),true);
  for(const url of ['https://example.com/a.pdf','file:///fixtures/a.html','file:///fixtures/a.pdf.html']) assert.equal(localPdfUrl(url),false);
});
