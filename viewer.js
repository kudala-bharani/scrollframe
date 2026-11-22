import { getSession, listSessions, getTiles, deleteSession, deleteAll } from './store.js';
import { buildPDF } from './pdf.js';

const $ = id => document.getElementById(id);
const objectURLs = new Set();
let currentSession;
let currentTiles = [];
let poll;
const requestedId = new URL(location.href).searchParams.get('id');

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showPanel(name) {
  for (const id of ['loading', 'error', 'capture', 'history']) $(id).hidden = id !== name;
}

function releaseImages() {
  for (const url of objectURLs) URL.revokeObjectURL(url);
  objectURLs.clear();
}

function dateLabel(value) {
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function safeSource(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'file:'].includes(url.protocol) ? url : null;
  } catch { return null; }
}

function statusLabel(status) {
  return ({ complete: 'Capture complete', partial: 'Partial capture', cancelled: 'Stopped early', error: 'Capture interrupted', capturing: 'Capturing…' })[status] || 'Saved capture';
}

function errorMessage(error) {
  return error?.message || String(error || 'An unexpected error occurred.');
}

function fail(error) {
  $('error-text').textContent = errorMessage(error);
  showPanel('error');
}

function sizeLabel(bytes) {
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1 ? `${megabytes.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function warningsFor(session) {
  const warnings = new Set((session.warnings || []).map(warning => typeof warning === 'string' ? warning : warning.message || String(warning)));
  if (session.status === 'capturing') warnings.add('The capture is still running. Return to the source tab until it finishes.');
  if (['partial', 'cancelled', 'error'].includes(session.status)) warnings.add('This capture stopped before every requested section was completed. The PDF will contain the images captured so far.');
  if (session.status === 'complete' && (session.sections || []).some(section => !section.complete)) warnings.add('At least one section is incomplete. Review its preview before exporting.');
  for (const section of session.sections || []) {
    for (const warning of section.warnings || []) warnings.add(`${section.label || 'Section'}: ${typeof warning === 'string' ? warning : warning.message || String(warning)}`);
  }
  return [...warnings];
}

function renderCapture(session, tiles) {
  currentSession = session;
  currentTiles = tiles;
  releaseImages();
  document.title = `${session.title || 'Capture'} · ScrollFrame PDF`;
  $('capture-title').textContent = session.title || 'Webpage capture';
  const source = safeSource(session.url);
  $('source-link').textContent = source ? (source.hostname || source.pathname) : 'Captured webpage';
  if (source) $('source-link').href = source.href;
  else $('source-link').removeAttribute('href');
  $('capture-date').textContent = dateLabel(session.createdAt);
  $('capture-status').textContent = statusLabel(session.status);
  $('capture-status').className = `badge ${session.status || ''}`;
  const warnings = warningsFor(session);
  $('warning-list').replaceChildren(...warnings.map(warning => element('li', '', warning)));
  $('warnings').hidden = warnings.length === 0;
  const sections = session.sections || [];
  const bytes = tiles.reduce((total, tile) => total + (tile.blob?.size || 0), 0);
  const capturedSections = sections.filter(section => tiles.some(tile => tile.sectionId === section.id)).length;
  $('capture-summary').textContent = `${capturedSections} ${capturedSections === 1 ? 'section' : 'sections'} · ${tiles.length} captured ${tiles.length === 1 ? 'image' : 'images'} · ${sizeLabel(bytes)}`;
  $('download').disabled = !tiles.length || session.status === 'capturing';
  $('delete-capture').disabled = session.status === 'capturing';
  const cards = [];
  sections.forEach((section, index) => {
    const images = tiles.filter(tile => tile.sectionId === section.id);
    const details = element('details', 'section');
    details.open = index === 0;
    const summary = element('summary');
    summary.append(element('span', 'section-number', String(index + 1).padStart(2, '0')));
    const copy = element('div');
    copy.append(element('div', 'section-title', section.label || `Section ${index + 1}`));
    const maxRight = Math.max(1, ...images.map(tile => Number(tile.x) + Number(tile.width)));
    const maxBottom = Math.max(1, ...images.map(tile => Number(tile.y) + Number(tile.height)));
    const width = Math.max(1, Number(section.width) || 0, maxRight);
    const height = section.complete ? Math.max(1, Number(section.height) || 0, maxBottom) : maxBottom;
    copy.append(element('div', 'section-meta', `${Math.round(width).toLocaleString()} × ${Math.round(height).toLocaleString()} px${section.complete ? '' : ' · incomplete'}`));
    summary.append(copy, element('span', 'section-chevron', '⌄'));
    details.append(summary);
    if (images.length) {
      const preview = element('div', 'section-preview');
      const canvas = element('div', 'preview-canvas');
      canvas.style.aspectRatio = `${width} / ${height}`;
      for (const tile of images) {
        if (!tile.blob || tile.width <= 0 || tile.height <= 0) continue;
        const image = element('img');
        const url = URL.createObjectURL(tile.blob);
        objectURLs.add(url);
        image.src = url;
        image.alt = `${section.label || 'Captured section'}, image ${Number(tile.order || 0) + 1}`;
        image.loading = 'lazy';
        image.decoding = 'async';
        image.style.left = `${tile.x / width * 100}%`;
        image.style.top = `${tile.y / height * 100}%`;
        image.style.width = `${tile.width / width * 100}%`;
        image.style.height = `${tile.height / height * 100}%`;
        canvas.append(image);
      }
      preview.append(canvas);
      details.append(preview);
    } else details.append(element('div', 'section-missing', 'No images were saved for this section.'));
    if (section.warnings?.length) details.append(element('div', 'section-warning', section.warnings.map(warning => typeof warning === 'string' ? warning : warning.message || String(warning)).join(' ')));
    cards.push(details);
  });
  $('sections').replaceChildren(...cards);
  showPanel('capture');
}

async function loadCapture(id) {
  const session = await getSession(id);
  if (!session) throw new Error('This capture was deleted or is not available in this browser.');
  const tiles = await getTiles(id);
  renderCapture(session, tiles);
  clearTimeout(poll);
  if (session.status === 'capturing') poll = setTimeout(() => loadCapture(id).catch(fail), 2500);
}

async function loadHistory() {
  clearTimeout(poll);
  releaseImages();
  const sessions = await listSessions();
  document.title = 'Saved captures · ScrollFrame PDF';
  $('history-empty').hidden = sessions.length !== 0;
  $('delete-all').hidden = sessions.length === 0;
  $('delete-all').disabled = sessions.some(session => session.status === 'capturing');
  $('delete-all').title = $('delete-all').disabled ? 'Wait for the current capture to finish.' : '';
  const cards = sessions.map(session => {
    const card = element('a', 'history-card');
    card.href = `viewer.html?id=${encodeURIComponent(session.id)}`;
    card.append(element('span', 'history-card-icon', '▤'));
    const copy = element('div', 'history-card-copy');
    copy.append(element('div', 'history-card-title', session.title || 'Webpage capture'));
    const source = safeSource(session.url);
    copy.append(element('div', 'history-card-meta', `${source?.hostname || 'Webpage'} · ${dateLabel(session.createdAt)} · ${(session.sections || []).length} sections`));
    card.append(copy, element('span', `badge ${session.status || ''}`, statusLabel(session.status)), element('span', 'history-card-arrow', '→'));
    return card;
  });
  $('history-list').replaceChildren(...cards);
  showPanel('history');
}

function filename(session) {
  const title = String(session.title || 'webpage').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 90) || 'webpage';
  const date = new Date(Number(session.createdAt) || Date.now()).toISOString().slice(0, 10);
  return `${title} - ${date}.pdf`;
}

$('download').addEventListener('click', async () => {
  if (!currentSession || !currentTiles.length) return;
  const button = $('download');
  const progress = $('export-progress');
  button.disabled = true;
  progress.hidden = false;
  progress.textContent = 'Preparing your PDF…';
  try {
    const settings = { paper: $('paper').value, orientation: $('orientation').value, includeHeader: $('include-header').checked };
    const blob = await buildPDF(currentSession, currentTiles, settings, update => {
      progress.textContent = update.stage === 'images' ? `Preparing image ${update.completed} of ${update.total}…`
        : update.stage === 'pages' ? `Building page ${update.completed} of ${update.total}…` : 'Saving your PDF…';
    });
    const url = URL.createObjectURL(blob);
    if (globalThis.chrome?.downloads?.download) {
      await chrome.downloads.download({ url, filename: filename(currentSession), saveAs: true });
    } else {
      const link = element('a');
      link.href = url;
      link.download = filename(currentSession);
      document.body.append(link);
      link.click();
      link.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    progress.textContent = `Your PDF is ready (${sizeLabel(blob.size)}).`;
  } catch (error) {
    progress.textContent = `Couldn’t export: ${errorMessage(error)}`;
  } finally { button.disabled = false; }
});

$('delete-capture').addEventListener('click', async () => {
  if (!currentSession || !confirm('Delete this capture and its saved images?')) return;
  try {
    await deleteSession(currentSession.id);
    location.href = 'viewer.html';
  } catch (error) { fail(error); }
});

$('delete-all').addEventListener('click', async () => {
  if (!confirm('Delete all captures saved by ScrollFrame in this browser?')) return;
  try { await deleteAll(); await loadHistory(); } catch (error) { fail(error); }
});

window.addEventListener('pagehide', () => { releaseImages(); clearTimeout(poll); });
async function initialize() {
  // Wake the worker so an interrupted capture is recovered before reading history.
  if (globalThis.chrome?.runtime?.id) {
    await chrome.runtime.sendMessage({type:'GET_STATUS'}).catch(() => {});
  }
  return requestedId ? loadCapture(requestedId) : loadHistory();
}
initialize().catch(fail);
