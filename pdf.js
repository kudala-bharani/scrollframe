/**
 * Small, dependency-free PDF writer for JPEG screenshot tiles.
 * Each image is embedded once; pages use clipping to paginate it.
 * It does not require a giant canvas, a network service, or a print dialog.
 */
const encoder = new TextEncoder();
const PAPERS = { a4: [595.276, 841.89], letter: [612, 792] };
const MAX_PAGES = 4000;

function number(value) {
  if (!Number.isFinite(value)) throw new Error('Invalid screenshot dimensions.');
  return String(Math.round(value * 1000) / 1000);
}

function ascii(value, limit = 140) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function literal(value) {
  return `(${ascii(value, 1000).replace(/([\\()])/g, '\\$1')})`;
}

// Widths of the PDF core Helvetica font, in thousandths of an em.
const FONT_WIDTHS = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278,
  J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
  S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222,
  j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333,
  s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584
};

function fitText(value, size, available) {
  const text = ascii(value, 1000);
  const width = character => (FONT_WIDTHS[character] || 556) / 1000 * size;
  if ([...text].reduce((sum, character) => sum + width(character), 0) <= available) return text;
  let used = width('.') * 3;
  let result = '';
  for (const character of text) {
    if (used + width(character) > available) break;
    used += width(character);
    result += character;
  }
  return `${result.trimEnd()}...`;
}

function unicode(value) {
  let hex = 'FEFF';
  for (let i = 0; i < String(value ?? '').length; i++) {
    hex += String(value).charCodeAt(i).toString(16).padStart(4, '0');
  }
  return `<${hex}>`;
}

function dateString(date) {
  const safeDate = Number.isFinite(Number(date)) ? new Date(Number(date)) : new Date();
  if (Number.isNaN(safeDate.getTime())) return 'D:20000101000000Z';
  return `D:${safeDate.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
}

class Writer {
  constructor() { this.objects = [null]; }
  reserve() { this.objects.push(null); return this.objects.length - 1; }
  set(id, body) { this.objects[id] = Array.isArray(body) ? body : [body]; }
  add(body) { const id = this.reserve(); this.set(id, body); return id; }
  stream(dictionary, data) {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    const length = bytes.size === undefined ? bytes.byteLength : bytes.size;
    return this.add([`<< ${dictionary} /Length ${length} >>\nstream\n`, bytes, '\nendstream']);
  }
  finish(rootId, infoId) {
    const chunks = [new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 37, 226, 227, 207, 211, 10])];
    let offset = chunks[0].byteLength;
    const offsets = [0];
    const append = part => {
      const bytes = typeof part === 'string' ? encoder.encode(part) : part;
      chunks.push(bytes);
      offset += bytes.size === undefined ? bytes.byteLength : bytes.size;
    };
    for (let id = 1; id < this.objects.length; id++) {
      if (!this.objects[id]) throw new Error('PDF object was not completed.');
      offsets[id] = offset;
      append(`${id} 0 obj\n`);
      for (const part of this.objects[id]) append(part);
      append('\nendobj\n');
    }
    const xref = offset;
    append(`xref\n0 ${this.objects.length}\n0000000000 65535 f \n`);
    for (let id = 1; id < this.objects.length; id++) {
      if (offsets[id] > 9999999999) throw new Error('This PDF exceeds the supported file size.');
      append(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    }
    append(`trailer\n<< /Size ${this.objects.length} /Root ${rootId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: 'application/pdf' });
  }
}

async function imageSize(tile) {
  if (!tile.blob || typeof tile.blob.arrayBuffer !== 'function') {
    throw new Error('A captured image is missing. Capture the section again.');
  }
  const head = new Uint8Array(await tile.blob.slice(0, 131072).arrayBuffer());
  if (head[0] !== 255 || head[1] !== 216) {
    throw new Error('PDF export expects JPEG capture tiles.');
  }
  let at = 2;
  while (at + 8 < head.length) {
    if (head[at] !== 255) { at++; continue; }
    while (head[at] === 255) at++;
    const marker = head[at++];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xda || marker === 0xd9) break;
    const length = (head[at] << 8) + head[at + 1];
    if (length < 2) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      const height = (head[at + 3] << 8) + head[at + 4];
      const width = (head[at + 5] << 8) + head[at + 6];
      const components = head[at + 7];
      if (width && height && (components === 1 || components === 3)) return { width, height, components };
      throw new Error('This JPEG colour format cannot be exported.');
    }
    at += length;
  }
  throw new Error('Could not read the captured JPEG dimensions.');
}

function validTile(tile) {
  return tile && Number.isFinite(tile.x) && Number.isFinite(tile.y)
    && Number.isFinite(tile.width) && tile.width > 0
    && Number.isFinite(tile.height) && tile.height > 0;
}

function textLine(text, x, y, size = 9, colour = '0.22 0.26 0.30') {
  return `BT /F1 ${number(size)} Tf ${colour} rg 1 0 0 1 ${number(x)} ${number(y)} Tm ${literal(text)} Tj ET\n`;
}

/** Export a session into one paginated PDF. Image positions are logical CSS pixels. */
export async function buildPDF(session, tiles, settings = {}, onProgress = () => {}) {
  if (!session || !Array.isArray(tiles)) throw new Error('No capture is available to export.');
  const paper = PAPERS[settings.paper] || PAPERS.a4;
  const [pageWidth, pageHeight] = settings.orientation === 'landscape' ? [paper[1], paper[0]] : paper;
  const includeHeader = settings.includeHeader !== false;
  const sections = (session.sections || []).map(section => {
    const images = tiles.filter(tile => tile.sectionId === section.id && validTile(tile)).map(tile => ({ ...tile }))
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    const right = Math.max(0, ...images.map(tile => tile.x + tile.width));
    const bottom = Math.max(0, ...images.map(tile => tile.y + tile.height));
    return {
      ...section, images,
      width: Math.max(1, Number(section.width) || 0, right),
      height: section.complete ? Math.max(bottom, Number(section.height) || 0) : bottom
    };
  }).filter(section => section.images.length && section.height > 0);
  if (!sections.length) throw new Error('There are no captured images to export yet.');

  const writer = new Writer();
  const catalogId = writer.reserve();
  const pagesId = writer.reserve();
  const fontId = writer.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const infoId = writer.add(`<< /Title ${unicode(session.title || 'ScrollFrame capture')} /Creator (ScrollFrame PDF) /Producer (ScrollFrame PDF - local export) /CreationDate ${literal(dateString(session.createdAt))} >>`);
  const outlinesId = writer.reserve();
  const pageIds = [];
  const outlines = [];
  const margin = 28;
  const usableWidth = pageWidth - 2 * margin;
  const partial = session.status !== 'complete' || sections.some(section => !section.complete);
  const headerHeight = includeHeader ? (partial ? 46 : 32) : 0;
  const contentTop = pageHeight - margin - headerHeight;
  const contentBottom = margin + 14;
  const usableHeight = contentTop - contentBottom;
  const title = fitText(session.title || 'Webpage capture', 10, usableWidth) || 'Webpage capture';
  let totalPages = 0;
  for (const section of sections) {
    section.scale = usableWidth / section.width;
    section.sliceHeight = usableHeight / section.scale;
    section.pageCount = Math.max(1, Math.ceil((section.height - 0.001) / section.sliceHeight));
    totalPages += section.pageCount;
  }
  if (totalPages > MAX_PAGES) throw new Error('This capture is too long for one export. Capture smaller sections.');
  let processed = 0;
  const imageCount = sections.reduce((sum, section) => sum + section.images.length, 0);
  for (const section of sections) {
    for (const tile of section.images) {
      const dimensions = await imageSize(tile);
      tile.pdfImageId = writer.stream(`/Type /XObject /Subtype /Image /Width ${dimensions.width} /Height ${dimensions.height} /ColorSpace /${dimensions.components === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode`, tile.blob);
      processed++;
      onProgress({ stage: 'images', completed: processed, total: imageCount });
      // Yield periodically so the viewer stays responsive during large exports.
      if (processed % 12 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const section = sections[sectionIndex];
    const label = fitText(section.label || `Section ${sectionIndex + 1}`, 8, usableWidth) || `Section ${sectionIndex + 1}`;
    for (let sliceIndex = 0; sliceIndex < section.pageCount; sliceIndex++) {
      const pageId = writer.reserve();
      pageIds.push(pageId);
      if (sliceIndex === 0) outlines.push({ id: writer.reserve(), title: section.label || label, pageId });
      const startY = sliceIndex * section.sliceHeight;
      const endY = Math.min(section.height, startY + section.sliceHeight);
      let commands = '1 1 1 rg 0 0 ' + number(pageWidth) + ' ' + number(pageHeight) + ' re f\n';
      if (includeHeader) {
        commands += textLine(title, margin, pageHeight - margin - 2, 10);
        commands += textLine(label, margin, pageHeight - margin - 17, 8, '0.38 0.42 0.46');
        if (partial) commands += textLine('PARTIAL CAPTURE - review the capture warnings before using this PDF.', margin, pageHeight - margin - 31, 7.5, '0.65 0.25 0.08');
      }
      commands += `q\n${number(margin)} ${number(contentBottom)} ${number(usableWidth)} ${number(usableHeight)} re W n\n`;
      const resources = [];
      let imageIndex = 0;
      for (const tile of section.images) {
        if (tile.y >= endY || tile.y + tile.height <= startY || tile.x >= section.width || tile.x + tile.width <= 0) continue;
        const name = `Im${imageIndex++}`;
        resources.push(`/${name} ${tile.pdfImageId} 0 R`);
        const x = margin + tile.x * section.scale;
        const y = contentTop - (tile.y + tile.height - startY) * section.scale;
        commands += `q ${number(tile.width * section.scale)} 0 0 ${number(tile.height * section.scale)} ${number(x)} ${number(y)} cm /${name} Do Q\n`;
      }
      commands += 'Q\n';
      commands += textLine(`Section ${sectionIndex + 1} of ${sections.length}  |  Page ${pageIds.length} of ${totalPages}`, margin, margin - 3, 8, '0.42 0.45 0.48');
      const contentId = writer.stream('', commands);
      writer.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${number(pageWidth)} ${number(pageHeight)}] /Resources << /Font << /F1 ${fontId} 0 R >> /XObject << ${resources.join(' ')} >> >> /Contents ${contentId} 0 R >>`);
      onProgress({ stage: 'pages', completed: pageIds.length, total: totalPages });
    }
  }
  outlines.forEach((outline, index) => {
    writer.set(outline.id, `<< /Title ${unicode(outline.title)} /Parent ${outlinesId} 0 R ${index ? `/Prev ${outlines[index - 1].id} 0 R` : ''} ${index < outlines.length - 1 ? `/Next ${outlines[index + 1].id} 0 R` : ''} /Dest [${outline.pageId} 0 R /Fit] >>`);
  });
  writer.set(outlinesId, `<< /Type /Outlines /First ${outlines[0].id} 0 R /Last ${outlines.at(-1).id} 0 R /Count ${outlines.length} >>`);
  writer.set(pagesId, `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`);
  writer.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R /Outlines ${outlinesId} 0 R >>`);
  onProgress({ stage: 'done', completed: totalPages, total: totalPages });
  return writer.finish(catalogId, infoId);
}
