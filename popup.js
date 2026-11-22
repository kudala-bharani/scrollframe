const $ = id => document.getElementById(id);
let tabId = null;
let candidates = [];

async function send(type, extra = {}) {
  const reply = await chrome.runtime.sendMessage({type, tabId, ...extra});
  if (!reply?.ok) throw new Error(reply?.error || 'The extension did not respond. Reload it from chrome://extensions.');
  return reply;
}

function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function updateSelectionLabel() {
  const boxes=[...$('regions').querySelectorAll('input[type="checkbox"]')];
  $('toggle-all').textContent=boxes.length && boxes.every(box=>box.checked)?'Clear selection':'Select all';
}
function options() { return {settleMs:Number($('settle').value),hideFixed:$('hide-fixed').checked,maxTiles:Number($('max-tiles').value),maxSections:40}; }
async function remember() { await chrome.storage.local.set({captureOptions:options()}); }
function busy(flag) { for (const b of document.querySelectorAll('#actions button')) b.disabled = flag; }

async function perform(action) {
  busy(true); message('');
  try { await remember(); await action(); } catch (error) { message(error.message, true); }
  finally { busy(false); }
}

async function start(mode, regions) {
  await send('START_CAPTURE', {mode, regions, options:options()});
  window.close();
}

function renderRegions(items) {
  candidates = items; $('regions').replaceChildren();
  if (!items.length) {
    const p = document.createElement('p'); p.className='empty'; p.textContent='No capturable sections found.'; $('regions').append(p);
  }
  for (let i=0;i<items.length;i++) {
    const item=items[i], label=document.createElement('label'); label.className='region';
    const input=document.createElement('input'); input.type='checkbox';input.value=String(i);input.checked=item.hasScroll;input.addEventListener('change',updateSelectionLabel);
    const text=document.createElement('span');text.className='region-text';
    const title=document.createElement('strong');title.textContent=item.label;
    const meta=document.createElement('small');
    let host='';try {host=new URL(item.frameUrl).hostname;}catch{}
    meta.textContent=`${Math.round(item.scrollWidth)} × ${Math.round(item.scrollHeight)} · ${item.frameId===0?'Main page':host || 'Embedded frame'}`;
    text.append(title,meta);label.append(input,text);$('regions').append(label);
  }
  $('list-actions').hidden=!items.length;
  updateSelectionLabel();
}

$('pick').addEventListener('click',()=>perform(async()=>{await send('PICK_REGION',{options:options()});window.close();}));
$('page').addEventListener('click',()=>perform(()=>start('page')));
$('all').addEventListener('click',()=>perform(()=>start('all')));
$('scan').addEventListener('click',()=>perform(async()=>{
  message('Finding scrolling panels and embedded frames…');
  const result=await send('SCAN_TAB');renderRegions(result.candidates);
  message(`${result.candidates.length} sections found.${result.warnings?.length?' Some embedded frames could not be inspected.':''}`);
}));
$('toggle-all').addEventListener('click',()=>{
  const boxes=[...$('regions').querySelectorAll('input')];const select=boxes.some(x=>!x.checked);
  boxes.forEach(x=>x.checked=select);$('toggle-all').textContent=select?'Clear selection':'Select all';
});
$('capture-selected').addEventListener('click',()=>perform(async()=>{
  const selected=[...$('regions').querySelectorAll('input:checked')].map(x=>candidates[Number(x.value)]).map(x=>({frameId:x.frameId,regionId:x.id}));
  if(!selected.length)throw new Error('Select at least one section.');
  await start('selected',selected);
}));
$('history').addEventListener('click',()=>chrome.tabs.create({url:chrome.runtime.getURL('viewer.html')}));
$('stop').addEventListener('click',()=>perform(async()=>{await send('STOP_CAPTURE');message('Stopping after the current screenshot…');}));

async function updateStatus() {
  const {activeCapture}=await chrome.storage.session.get('activeCapture');
  const active=activeCapture && !['complete','partial','cancelled','error'].includes(activeCapture.status);
  $('active-job').hidden=!active;$('actions').hidden=!!active;
  if(active){$('job-title').textContent=activeCapture.status==='paused'?'Capture paused':'Capturing your page';$('job-detail').textContent=activeCapture.detail || 'Starting…';}
}

async function init() {
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});tabId=tab?.id;
    const stored=await chrome.storage.local.get('captureOptions');
    if(stored.captureOptions){const o=stored.captureOptions;$('settle').value=String(o.settleMs||350);$('hide-fixed').checked=o.hideFixed!==false;$('max-tiles').value=String(o.maxTiles||250);}
    await updateStatus();
    if(!/^https?:|^file:/.test(tab?.url||'')){busy(true);message('Open a regular web page first. Chrome settings, the Web Store, and built-in PDF viewers cannot be captured with this tool.',true);}
  } catch(e){message(e.message,true);}
}
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='session'&&changes.activeCapture)updateStatus();});
init();
