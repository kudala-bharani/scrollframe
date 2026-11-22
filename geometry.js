// Coordinates in this module are CSS pixels, not screenshot/device pixels.
export function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return {x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y)};
}

export function mapRect(rect, transform) {
  return {
    x: transform.x + rect.x * transform.sx,
    y: transform.y + rect.y * transform.sy,
    width: rect.width * transform.sx,
    height: rect.height * transform.sy
  };
}

export function mapThroughFrames(metrics, frames) {
  let box = {...metrics.box}, clip = {...metrics.clip}, sx = 1, sy = 1;
  // frames are child-to-parent. Each host's viewport is its child's viewport.
  for (const frame of frames) {
    const tx = {
      x: frame.rect.x, y: frame.rect.y,
      sx: frame.rect.width / frame.childViewport.width,
      sy: frame.rect.height / frame.childViewport.height
    };
    if (!(tx.sx > 0 && tx.sy > 0)) throw new Error('An embedded frame has no visible size.');
    box = mapRect(box, tx);
    clip = intersect(mapRect(clip, tx), frame.clip);
    sx *= tx.sx; sy *= tx.sy;
  }
  return {box, clip, sx, sy};
}

export function normalizeOptions(options = {}) {
  const number = (v, d, min, max) => Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : d;
  return {
    settleMs: number(options.settleMs, 350, 100, 2500),
    hideFixed: options.hideFixed !== false,
    maxTiles: Math.round(number(options.maxTiles, 250, 10, 1000)),
    maxSections: Math.round(number(options.maxSections, 40, 1, 150)),
    paper: options.paper === 'letter' ? 'letter' : 'a4',
    orientation: options.orientation === 'landscape' ? 'landscape' : 'portrait'
  };
}

export function cropPixels(rect, scaleX, scaleY, bitmapWidth, bitmapHeight) {
  const x = Math.max(0, Math.round(rect.x * scaleX));
  const y = Math.max(0, Math.round(rect.y * scaleY));
  const right = Math.min(bitmapWidth, Math.round((rect.x + rect.width) * scaleX));
  const bottom = Math.min(bitmapHeight, Math.round((rect.y + rect.height) * scaleY));
  return {x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y)};
}
