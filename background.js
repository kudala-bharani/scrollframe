import {putSession, putTile, listSessions} from './store.js';
import {mapThroughFrames, intersect, cropPixels, normalizeOptions} from './geometry.js';

const scans = new Map();
let activeJob = null;
let picking = null;
let lastScreenshotAt = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanError = error => String(error?.message || error || 'Unknown error');
const unique = items => [...new Set(items)];

// A terminated worker cannot continue a capture, but already saved tiles remain useful.
const recovered = (async () => {
  const sessions = await listSessions();
  for (const session of sessions.filter(s => s.status === 'capturing')) {
    session.status = session.sections?.some(s => s.tiles > 0) ? 'partial' : 'error';
    session.warnings = unique([...(session.warnings || []), 'The browser interrupted this capture. Only the saved portion is available. Start another capture for the remaining content.']);
    await putSession(session);
    if (Number.isInteger(session.sourceTabId)) {
      await chrome.scripting.executeScript({
        target: {tabId:session.sourceTabId, allFrames:true},
        func: () => globalThis.__SCROLLFRAME__?.dispatch('cleanup', {})
      }).catch(() => {});
    }
  }
  const {activeCapture} = await chrome.storage.session.get('activeCapture');
  if (activeCapture && ['capturing','paused'].includes(activeCapture.status)) {
    await chrome.storage.session.set({activeCapture:{...activeCapture,status:'partial',detail:'Capture was interrupted. Open Saved captures to recover it.'}});
  }
})().catch(() => {});

async function rpc(tabId, frameId, command, payload = {}) {
  const result = await chrome.scripting.executeScript({
    target: {tabId, frameIds: [frameId]},
    func: (cmd, data) => {
      if (!globalThis.__SCROLLFRAME__) throw new Error('This frame changed. Scan the page again.');
      return globalThis.__SCROLLFRAME__.dispatch(cmd, data);
    },
    args: [command, payload]
  });
  if (!result.length) throw new Error('The embedded frame is no longer available.');
  return result[0].result;
}

async function broadcast(scan, command, payload = {}) {
  const results = await Promise.allSettled(scan.frames.map(f => rpc(scan.tabId, f.frameId, command, payload)));
  return results;
}

function frameDepth(frame, frames) {
  let depth = 0, current = frame, seen = new Set();
  while (current && current.parentFrameId >= 0 && !seen.has(current.frameId)) {
    seen.add(current.frameId); depth++;
    current = frames.find(f => f.frameId === current.parentFrameId);
  }
  return depth;
}

async function scanTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:|^file:/.test(tab.url || '')) throw new Error('Open a regular web page. Chrome internal pages and the built-in PDF viewer are not supported.');
  if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(tab.url)) throw new Error('Chrome does not allow capture scripts on the Chrome Web Store.');
  let nav = await chrome.webNavigation.getAllFrames({tabId});
  nav = (nav || [{frameId:0,parentFrameId:-1,url:tab.url}]).slice(0,100);
  const frames = [], warnings = [];
  const injected = await Promise.allSettled(nav.map(async info => {
    await chrome.scripting.executeScript({target:{tabId,frameIds:[info.frameId]},files:['content.js']});
    const hello = await rpc(tabId,info.frameId,'hello');
    return {...info,...hello,frameId:info.frameId,parentFrameId:info.parentFrameId};
  }));
  for (let i=0;i<injected.length;i++) {
    const result=injected[i];
    if(result.status==='fulfilled')frames.push(result.value);
    else warnings.push(`An embedded frame could not be inspected (${shortOrigin(nav[i].url)}). ${cleanError(result.reason)}`);
  }
  if(!frames.some(f=>f.frameId===0))throw new Error('Chrome could not access this page. In the extension’s site-access settings, allow this website, then try again.');
  const scan={tabId,windowId:tab.windowId,title:tab.title||'Web capture',url:tab.url,frames,candidates:[],warnings,createdAt:Date.now()};
  await broadcast(scan,'announce');
  await sleep(100);
  await broadcast(scan,'announce');
  await sleep(60);
  const found=await Promise.allSettled(frames.map(async frame=>{
    const candidates=await rpc(tabId,frame.frameId,'scan');
    return candidates.map(c=>({...c,frameId:frame.frameId,frameUrl:frame.url,
      label:c.id==='document' ? (frame.frameId===0?'Main page':`Embedded page · ${shortOrigin(frame.url)}`) : c.label}));
  }));
  for(let i=0;i<found.length;i++){
    if(found[i].status==='fulfilled')scan.candidates.push(...found[i].value);
    else warnings.push(`Could not inspect scrolling areas in ${shortOrigin(frames[i].url)}.`);
  }
  // Interleave embedded documents at their iframe's position in the parent DOM.
  const childFrames=frames.filter(f=>f.frameId!==0 && frames.some(p=>p.frameId===f.parentFrameId));
  const positions=await Promise.allSettled(childFrames.map(async child=>{
    const info=await rpc(tabId,child.parentFrameId,'frameInfo',{token:child.token,fit:false});
    return {frameId:child.frameId,order:info.order};
  }));
  for(const result of positions){
    if(result.status==='fulfilled'){
      const frame=frames.find(f=>f.frameId===result.value.frameId);frame.hostOrder=result.value.order;
    }
  }
  for(const candidate of scan.candidates){
    const path=[candidate.order||0];let frame=frames.find(f=>f.frameId===candidate.frameId);let guard=0;
    while(frame?.frameId!==0 && frame && guard++<100){path.unshift(frame.hostOrder??100000);frame=frames.find(f=>f.frameId===frame.parentFrameId);}
    candidate.orderPath=path;
  }
  scan.candidates.sort((a,b)=>{
    for(let i=0;i<Math.max(a.orderPath.length,b.orderPath.length);i++){
      const difference=(a.orderPath[i]??-1)-(b.orderPath[i]??-1);if(difference)return difference;
    }
    return 0;
  });
  scans.set(tabId,scan);
  return scan;
}

function shortOrigin(url) {try{return new URL(url).hostname||'local frame';}catch{return 'embedded frame';}}

async function publish(job, detail, status='capturing') {
  if(activeJob!==job)return;
  job.status=status;
  await chrome.storage.session.set({activeCapture:{id:job.id,tabId:job.tabId,status,detail,tiles:job.tiles}});
  await chrome.action.setBadgeText({text:status==='paused'?'Ⅱ':String(job.tiles||'…'),tabId:job.tabId}).catch(()=>{});
  await chrome.action.setBadgeBackgroundColor({color:status==='paused'?'#b77c20':'#137d77',tabId:job.tabId}).catch(()=>{});
  await rpc(job.tabId,0,'status',{text:status==='paused'?'Capture paused':'ScrollFrame PDF',detail}).catch(()=>{});
}

function assertRunning(job) {
  if(job.cancelled)throw new Error('CAPTURE_CANCELLED');
  if(job.tiles>=job.options.maxTiles)throw new Error('CAPTURE_LIMIT');
}

async function waitForTab(job) {
  const start=Date.now();
  while(true){
    assertRunning(job);
    const tab=await chrome.tabs.get(job.tabId);
    const win=await chrome.windows.get(job.windowId);
    if(tab.active && win.state!=='minimized'){
      if(job.status==='paused')await publish(job,'Continuing capture…');
      return;
    }
    await publish(job,'Return to the original tab to continue. Only that tab will be captured.','paused');
    if(Date.now()-start>120000)throw new Error('Capture stopped because the original tab was inactive for two minutes.');
    await sleep(800);
  }
}

function frameChain(scan, frameId) {
  const chain=[], seen=new Set();
  let current=scan.frames.find(f=>f.frameId===frameId);
  while(current && current.frameId!==0){
    if(seen.has(current.frameId))throw new Error('Invalid embedded frame hierarchy.');
    seen.add(current.frameId);
    const parent=scan.frames.find(f=>f.frameId===current.parentFrameId);
    if(!parent)throw new Error('This frame is inside another frame Chrome cannot access.');
    chain.push({child:current,parent});current=parent;
  }
  return chain;
}

async function prepareRegion(scan, candidate) {
  const chain=frameChain(scan,candidate.frameId);
  for(const {child,parent} of [...chain].reverse()){
    await rpc(scan.tabId,parent.frameId,'frameInfo',{token:child.token,fit:true,ensureVisible:true});
    await sleep(80);
  }
  const hello=await rpc(scan.tabId,candidate.frameId,'hello');
  await rpc(scan.tabId,candidate.frameId,'prepare',{
    id:candidate.id,maxHeight:Math.max(80,hello.viewport.height-24),maxWidth:Math.max(80,hello.viewport.width-24)
  });
  // Reposition enclosing frames after fitting the target, without scrolling its content.
  for(const {child,parent} of [...chain].reverse()){
    await rpc(scan.tabId,parent.frameId,'frameInfo',{token:child.token,fit:false,ensureVisible:true});
  }
}

async function worldGeometry(scan,candidate,metrics) {
  const mapped=[];
  for(const {child,parent} of frameChain(scan,candidate.frameId)){
    const host=await rpc(scan.tabId,parent.frameId,'frameInfo',{token:child.token,fit:false,ensureVisible:false});
    const childInfo=await rpc(scan.tabId,child.frameId,'hello');
    mapped.push({...host,childViewport:childInfo.viewport});
  }
  const world=mapThroughFrames(metrics,mapped);
  const top=await rpc(scan.tabId,0,'hello');
  world.clip=intersect(world.clip,{x:0,y:0,width:top.viewport.width,height:top.viewport.height});
  world.sx*=metrics.scaleX || metrics.box.width/metrics.clientWidth || 1;
  world.sy*=metrics.scaleY || metrics.box.height/metrics.clientHeight || 1;
  return {...world,viewport:top.viewport};
}

async function screenshotTile(job, candidate, metrics, cutX, cutY) {
  await waitForTab(job);
  const geometry=await worldGeometry(job.scan,candidate,metrics);
  if(geometry.clip.width<2 || geometry.clip.height<2)throw new Error('This section is hidden or completely clipped by another container.');
  const baseX=metrics.scrollX+(geometry.clip.x-geometry.box.x)/geometry.sx;
  const baseY=metrics.scrollY+(geometry.clip.y-geometry.box.y)/geometry.sy;
  const x=Math.max(baseX,cutX), y=Math.max(baseY,cutY);
  const endX=Math.min(metrics.contentWidth,baseX+geometry.clip.width/geometry.sx);
  const endY=Math.min(metrics.contentHeight,baseY+geometry.clip.height/geometry.sy);
  const width=endX-x, height=endY-y;
  if(width<.5 || height<.5)return {empty:true,baseX,baseY,endX,endY,geometry};
  const crop={
    x:geometry.clip.x+(x-baseX)*geometry.sx,
    y:geometry.clip.y+(y-baseY)*geometry.sy,
    width:width*geometry.sx,height:height*geometry.sy
  };
  let dataURL;
  for(let attempt=0;attempt<3;attempt++){
    await waitForTab(job);
    await broadcast(job.scan,'hud',{hidden:true});
    await sleep(60);
    // Chrome permits at most two captureVisibleTab calls each second.
    await sleep(Math.max(0,650-(Date.now()-lastScreenshotAt)));
    const before=await chrome.tabs.get(job.tabId);
    if(!before.active)continue;
    lastScreenshotAt=Date.now();
    try {dataURL=await chrome.tabs.captureVisibleTab(job.windowId,{format:'png'});}
    catch(error){
      if(attempt===2)throw error;
      await sleep(700);continue;
    }
    const after=await chrome.tabs.get(job.tabId);
    if(after.active && before.url===after.url)break;
    dataURL=null;
  }
  if(!dataURL)throw new Error('The tab changed during the screenshot. Return to the original page and try again.');
  const source=await createImageBitmap(await (await fetch(dataURL)).blob());
  try {
    const pixels=cropPixels(crop,source.width/geometry.viewport.width,source.height/geometry.viewport.height,source.width,source.height);
    if(pixels.width<1 || pixels.height<1)throw new Error('This scrolling section has no visible pixels.');
    const canvas=new OffscreenCanvas(pixels.width,pixels.height);
    const ctx=canvas.getContext('2d',{alpha:false});
    ctx.fillStyle='#ffffff';ctx.fillRect(0,0,pixels.width,pixels.height);
    ctx.drawImage(source,pixels.x,pixels.y,pixels.width,pixels.height,0,0,pixels.width,pixels.height);
    const blob=await canvas.convertToBlob({type:'image/jpeg',quality:.95});
    return {x,y,width,height,pixelWidth:pixels.width,pixelHeight:pixels.height,blob,baseX,baseY,endX,endY,geometry};
  } finally {source.close();await broadcast(job.scan,'hud',{hidden:false});}
}

async function restoreFrames(scan) {
  // Children first, then their enclosing hosts and top document.
  const frames=[...scan.frames].sort((a,b)=>frameDepth(b,scan.frames)-frameDepth(a,scan.frames));
  for(const frame of frames)await rpc(scan.tabId,frame.frameId,'restore').catch(()=>{});
}

async function captureRegion(job,candidate,index,total) {
  const section={id:crypto.randomUUID(),label:candidate.label,frameUrl:candidate.frameUrl,width:0,height:0,tiles:0,complete:false,warnings:[]};
  job.session.sections.push(section);
  try {
    await prepareRegion(job.scan,candidate);
    await broadcast(job.scan,'hideRepeated',{enabled:false});
    let coveredY=0, requestY=0, previousY=-1;
    let sectionTile=0;
    while(true){
      assertRunning(job);
      let metrics=await rpc(job.tabId,candidate.frameId,'scroll',{id:candidate.id,x:0,y:requestY,settleMs:job.options.settleMs});
      section.expectedWidth=metrics.contentWidth;section.expectedHeight=metrics.contentHeight;
      let coveredX=0,requestX=0,previousX=-1,rowBottom=Infinity;
      while(true){
        assertRunning(job);
        if(requestX!==0)metrics=await rpc(job.tabId,candidate.frameId,'scroll',{id:candidate.id,x:requestX,y:requestY,settleMs:job.options.settleMs});
        await publish(job,`Section ${index+1} of ${total}: ${candidate.label} · ${job.tiles} screenshots`);
        const tile=await screenshotTile(job,candidate,metrics,coveredX,coveredY);
        if(tile.empty)throw new Error('Scrolling stopped before the rest of this section became visible.');
        if(tile.baseX>coveredX+2 || tile.baseY>coveredY+2){
          section.warnings.push('An ancestor clipped part of this section. Check its top/left edge in the preview.');
        }
        await putTile({id:`${job.id}:${section.id}:${sectionTile}`,sessionId:job.id,sectionId:section.id,order:sectionTile,
          x:tile.x,y:tile.y,width:tile.width,height:tile.height,pixelWidth:tile.pixelWidth,pixelHeight:tile.pixelHeight,blob:tile.blob});
        job.tiles++;section.tiles++;sectionTile++;
        section.width=Math.max(section.width,tile.x+tile.width);section.height=Math.max(section.height,tile.y+tile.height);
        coveredX=Math.max(coveredX,tile.x+tile.width);
        rowBottom=Math.min(rowBottom,tile.y+tile.height);
        section.warnings=unique(section.warnings);
        await putSession(job.session);
        if(job.options.hideFixed && sectionTile===1)await broadcast(job.scan,'hideRepeated',{enabled:true});
        if(coveredX>=metrics.contentWidth-1)break;
        const next=Math.min(Math.max(0,metrics.contentWidth-metrics.clientWidth),metrics.scrollX+Math.max(24,tile.geometry.clip.width/tile.geometry.sx-24));
        if(next<=metrics.scrollX+.5 || Math.abs(next-previousX)<.5)throw new Error('The right edge is clipped by a containing element and could not be reached.');
        previousX=requestX;requestX=next;
      }
      if(!Number.isFinite(rowBottom) || rowBottom<=coveredY+.5)throw new Error('This section did not move when scrolled.');
      coveredY=rowBottom;
      // Re-read after the final tile in each row to notice appended/lazy-loaded content.
      metrics=await rpc(job.tabId,candidate.frameId,'measure',{id:candidate.id});
      section.expectedHeight=metrics.contentHeight;
      if(coveredY>=metrics.contentHeight-1){section.complete=true;break;}
      const visibleHeight=Math.max(24,rowBottom-(requestY||0));
      const next=Math.min(Math.max(0,metrics.contentHeight-metrics.clientHeight),metrics.scrollY+Math.max(24,visibleHeight-24));
      if(next<=metrics.scrollY+.5 || Math.abs(next-previousY)<.5)throw new Error('The bottom edge is clipped by a containing element and could not be reached.');
      previousY=requestY;requestY=next;
    }
  }catch(error){
    const detail=cleanError(error);
    if(detail==='CAPTURE_CANCELLED')section.warnings.push('Stopped by you. This section is incomplete.');
    else if(detail==='CAPTURE_LIMIT')section.warnings.push(`The ${job.options.maxTiles}-screenshot limit was reached. This section is incomplete. Increase the limit for longer pages.`);
    else section.warnings.push(detail);
    job.session.warnings.push(`${candidate.label}: ${section.warnings.at(-1)}`);
    if(detail==='CAPTURE_CANCELLED' || detail==='CAPTURE_LIMIT')throw error;
  }finally{
    await restoreFrames(job.scan);
    await putSession(job.session);
  }
}

async function runCapture(job,requestedRegions,mode) {
  let finalStatus='complete';
  try {
    await chrome.tabs.update(job.tabId,{active:true});
    await chrome.windows.update(job.windowId,{focused:true}).catch(()=>{});
    await broadcast(job.scan,'picker',{enabled:false});
    let regions;
    if(mode==='page')regions=job.scan.candidates.filter(c=>c.frameId===0 && c.id==='document');
    else if(mode==='all')regions=job.scan.candidates.filter(c=>(c.frameId===0&&c.id==='document')||c.hasScroll);
    else regions=(requestedRegions||[]).map(ref=>job.scan.candidates.find(c=>c.frameId===ref.frameId&&c.id===ref.regionId)).filter(Boolean);
    if(!regions.length)throw new Error('The selected section is no longer on this page. Scan again.');
    const seen=new Set();regions=regions.filter(r=>{const key=`${r.frameId}:${r.id}`;if(seen.has(key))return false;seen.add(key);return true;});
    if(regions.length>job.options.maxSections){
      job.session.warnings.push(`Found ${regions.length} sections. Only the first ${job.options.maxSections} are included. Select the remaining sections in a separate capture.`);
      regions=regions.slice(0,job.options.maxSections);finalStatus='partial';
    }
    job.session.requestedSections=regions.length;
    for(let i=0;i<regions.length;i++){assertRunning(job);await captureRegion(job,regions[i],i,regions.length);}
    if(job.session.sections.some(s=>!s.complete || s.warnings.length) || job.session.warnings.length)finalStatus='partial';
  }catch(error){
    const detail=cleanError(error);
    if(detail==='CAPTURE_CANCELLED')finalStatus='cancelled';
    else if(detail==='CAPTURE_LIMIT'){finalStatus='partial';job.session.warnings.push('Capture stopped at the configured screenshot limit. Some sections may not be included.');}
    else {finalStatus=job.tiles?'partial':'error';job.session.warnings.push(detail);}
  }finally{
    await restoreFrames(job.scan);
    await broadcast(job.scan,'cleanup');
    job.session.status=finalStatus;job.session.finishedAt=Date.now();job.session.warnings=unique(job.session.warnings);
    await putSession(job.session);
    await chrome.storage.session.set({activeCapture:{id:job.id,tabId:job.tabId,status:finalStatus,tiles:job.tiles,detail:'Capture finished'}});
    await chrome.action.setBadgeText({text:job.tiles?'PDF':'!',tabId:job.tabId}).catch(()=>{});
    if(activeJob===job)activeJob=null;
    scans.delete(job.tabId);
    await chrome.tabs.create({url:chrome.runtime.getURL(`viewer.html?id=${encodeURIComponent(job.id)}`)});
  }
}

async function startCapture(tabId,regions,mode,options) {
  if(activeJob)throw new Error('Another capture is already running. Stop it before starting a new one.');
  const scan=scans.get(tabId) || await scanTab(tabId);
  const id=crypto.randomUUID();
  const session={id,title:scan.title,url:scan.url,sourceTabId:tabId,createdAt:Date.now(),status:'capturing',options:normalizeOptions(options),sections:[],warnings:mode==='all'?[...scan.warnings]:[]};
  const job={id,tabId,windowId:scan.windowId,scan,session,options:session.options,tiles:0,cancelled:false,status:'capturing'};
  activeJob=job;picking=null;
  await putSession(session);
  await publish(job,'Preparing the selected scrolling sections…');
  // The worker remains active through frequent extension API calls during capture.
  runCapture(job,regions,mode).catch(async error=>{
    session.status='error';session.warnings.push(cleanError(error));await putSession(session).catch(()=>{});
    await broadcast(scan,'cleanup');if(activeJob===job)activeJob=null;
  });
  return {id};
}

async function startPicker(tabId,options) {
  if(activeJob)throw new Error('A capture is already running.');
  if(picking){const old=scans.get(picking.tabId);if(old)await broadcast(old,'picker',{enabled:false});}
  const scan=await scanTab(tabId);picking={tabId,options:normalizeOptions(options)};
  await broadcast(scan,'picker',{enabled:true});
  return {candidates:scan.candidates};
}

async function onMessage(message,sender) {
  await recovered;
  if(sender.id!==chrome.runtime.id)throw new Error('Unrecognized sender.');
  const extensionPage=(sender.url||'').startsWith(chrome.runtime.getURL(''));
  if(message.type==='STOP_CAPTURE'){
    if(activeJob && (extensionPage || sender.tab?.id===activeJob.tabId))activeJob.cancelled=true;
    if(picking){const scan=scans.get(picking.tabId);if(scan)await broadcast(scan,'cleanup');picking=null;}
    return {};
  }
  if(message.type==='PICK_CANCEL'){
    if(picking?.tabId===sender.tab?.id){const scan=scans.get(picking.tabId);if(scan)await broadcast(scan,'picker',{enabled:false});picking=null;}
    return {};
  }
  if(message.type==='REGION_PICKED'){
    if(!picking || picking.tabId!==sender.tab?.id)throw new Error('Start the section picker from the extension first.');
    const selected=picking;
    const scan=scans.get(selected.tabId);
    if(!scan.candidates.some(c=>c.frameId===sender.frameId&&c.id===message.regionId)){
      const frame=scan.frames.find(f=>f.frameId===sender.frameId);
      const candidates=await rpc(selected.tabId,sender.frameId,'scan');
      scan.candidates.push(...candidates.filter(c=>c.id===message.regionId).map(c=>({...c,frameId:sender.frameId,frameUrl:frame.url})));
    }
    return startCapture(selected.tabId,[{frameId:sender.frameId,regionId:message.regionId}],'selected',selected.options);
  }
  if(!extensionPage)throw new Error('This action must start from the extension.');
  if(message.type==='SCAN_TAB'){
    if(activeJob)throw new Error('Wait for the current capture to finish.');
    const scan=await scanTab(message.tabId);return {candidates:scan.candidates,warnings:scan.warnings};
  }
  if(message.type==='PICK_REGION')return startPicker(message.tabId,message.options);
  if(message.type==='START_CAPTURE')return startCapture(message.tabId,message.regions,message.mode||'page',message.options);
  if(message.type==='GET_STATUS')return {active:activeJob?{id:activeJob.id,tiles:activeJob.tiles,status:activeJob.status}:null};
  throw new Error('Unknown extension command.');
}

chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(!message || typeof message.type!=='string')return false;
  onMessage(message,sender).then(result=>sendResponse({ok:true,...result}),error=>sendResponse({ok:false,error:cleanError(error)}));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId=>{if(activeJob?.tabId===tabId)activeJob.cancelled=true;scans.delete(tabId);if(picking?.tabId===tabId)picking=null;});
