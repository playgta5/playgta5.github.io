/* Static-host adapter for GitHub Pages. Imported game files stay in this origin's OPFS. */
const STORE = 'playgta5-mirror';
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const MIME = {
  '.bin': 'application/octet-stream', '.cfg': 'text/plain; charset=utf-8', '.dat': 'application/octet-stream',
  '.dll': 'application/octet-stream', '.fxc': 'application/octet-stream', '.gfx': 'application/octet-stream',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.meta': 'application/octet-stream', '.png': 'image/png', '.sps': 'application/octet-stream', '.wasm': 'application/wasm',
  '.webp': 'image/webp', '.woff': 'font/woff', '.xml': 'application/xml; charset=utf-8', '.ymt': 'application/octet-stream',
};

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function responseWithIsolation(response) {
  if (response.type === 'opaque' || response.status === 0) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(ISOLATION)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function cleanRelativePath(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0')) throw new Error('Invalid path');
  const parts = value.replace(/^\/+/, '').split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes(':'))) throw new Error('Invalid path');
  return parts;
}

async function directoryAt(root, parts, create = false) {
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

async function fileAt(root, relativePath) {
  const parts = cleanRelativePath(relativePath);
  const parent = await directoryAt(root, parts.slice(0, -1));
  return parent.getFileHandle(parts.at(-1));
}

async function mirrorRoot() {
  const originRoot = await navigator.storage.getDirectory();
  return originRoot.getDirectoryHandle(STORE);
}

function headersForFile(file, extra = {}) {
  const ext = (file.name.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
  const headers = new Headers({
    ...ISOLATION,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Length': String(file.size),
    'Content-Type': MIME[ext] || 'application/octet-stream',
    ...extra,
  });
  return headers;
}

async function serveMirrorFile(request, relativePath) {
  try {
    const handle = await fileAt(await mirrorRoot(), relativePath);
    const file = await handle.getFile();
    const rangeHeader = request.headers.get('Range');
    if (!rangeHeader) {
      const headers = headersForFile(file);
      return responseWithIsolation(new Response(request.method === 'HEAD' ? null : file.stream(), { status: 200, headers }));
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match || (!match[1] && !match[2]) || file.size === 0) {
      return responseWithIsolation(new Response(null, { status: 416, headers: headersForFile(file, { 'Content-Range': `bytes */${file.size}`, 'Content-Length': '0' }) }));
    }
    const start = match[1] ? Number(match[1]) : Math.max(0, file.size - Number(match[2]));
    const end = match[2] ? Math.min(file.size - 1, Number(match[2])) : file.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= file.size) {
      return responseWithIsolation(new Response(null, { status: 416, headers: headersForFile(file, { 'Content-Range': `bytes */${file.size}`, 'Content-Length': '0' }) }));
    }
    const length = end - start + 1;
    const headers = headersForFile(file, { 'Content-Length': String(length), 'Content-Range': `bytes ${start}-${end}/${file.size}` });
    return responseWithIsolation(new Response(request.method === 'HEAD' ? null : file.slice(start, end + 1).stream(), { status: 206, headers }));
  } catch (error) {
    return responseWithIsolation(new Response(`Mirror file not found: ${error.message}`, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }));
  }
}

async function serveBatch(request) {
  try {
    const runs = await request.json();
    if (!Array.isArray(runs) || runs.length > 1000) throw new Error('Invalid batch');
    const dataRoot = await directoryAt(await mirrorRoot(), ['data']);
    const pieces = [];
    const lengths = [];
    let total = 0;
    for (const run of runs) {
      if (!Array.isArray(run) || run.length !== 3) throw new Error('Invalid run');
      const [name, rawStart, rawEnd] = run;
      const start = Number(rawStart), end = Number(rawEnd);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new Error('Invalid byte range');
      const handle = await fileAt(dataRoot, name);
      const file = await handle.getFile();
      const length = Math.max(0, Math.min(end + 1, file.size) - start);
      lengths.push(length);
      total += length;
      if (total > 64 * 1024 * 1024) throw new Error('Batch exceeds 64 MiB');
      pieces.push(length ? file.slice(start, start + length) : null);
    }
    let index = 0;
    let reader = null;
    const body = new ReadableStream({
      async pull(controller) {
        try {
          while (index < pieces.length) {
            if (!pieces[index]) { index++; continue; }
            if (!reader) reader = pieces[index].stream().getReader();
            const result = await reader.read();
            if (result.done) { reader = null; index++; continue; }
            controller.enqueue(result.value);
            return;
          }
          controller.close();
        } catch (error) { controller.error(error); }
      },
      async cancel() { if (reader) await reader.cancel(); },
    });
    return responseWithIsolation(new Response(body, {
      status: 200,
      headers: {
        ...ISOLATION,
        'Cache-Control': 'no-store',
        'Content-Type': 'application/octet-stream',
        'X-Run-Lengths': lengths.join(','),
      },
    }));
  } catch (error) {
    return responseWithIsolation(new Response(`Invalid data batch: ${error.message}`, { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }));
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const pathname = url.pathname;
  if (pathname === '/data/batch' && request.method === 'POST') {
    event.respondWith(serveBatch(request));
    return;
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    const prefix = pathname.startsWith('/data/') ? '/data/' : pathname.startsWith('/b/') ? '/b/' : null;
    if (prefix) {
      event.respondWith(serveMirrorFile(request, decodeURIComponent(pathname.slice(1))));
      return;
    }
  }
  event.respondWith(fetch(request).then(responseWithIsolation).catch((error) =>
    responseWithIsolation(new Response(`Static request failed: ${error.message}`, { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))));
});
