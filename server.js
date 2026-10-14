#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');

const ROOT = path.resolve(__dirname, 'mirror', 'playgta5.com');
const DATA = path.join(ROOT, 'data');
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Accept-Ranges': 'bytes',
};
const MIME = {
  '.bin': 'application/octet-stream', '.cfg': 'text/plain; charset=utf-8', '.dat': 'application/octet-stream',
  '.dll': 'application/octet-stream', '.fxc': 'application/octet-stream', '.gfx': 'application/octet-stream',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.meta': 'application/octet-stream', '.png': 'image/png', '.sps': 'application/octet-stream', '.wasm': 'application/wasm',
  '.webp': 'image/webp', '.woff': 'font/woff', '.xml': 'application/xml; charset=utf-8', '.ymt': 'application/octet-stream',
};

function sendError(res, status, message) {
  const body = Buffer.from(String(message));
  res.writeHead(status, { ...ISOLATION, 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function safePath(base, relative) {
  const decoded = decodeURIComponent(relative);
  if (decoded.includes('\0') || decoded.includes('\\')) throw new Error('Invalid path');
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || part.includes(':'))) throw new Error('Invalid path');
  const target = path.resolve(base, ...parts);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('Invalid path');
  return target;
}

async function readRequestJson(req, maximum = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw new Error('Request body exceeds 1 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveBatch(req, res, url) {
  try {
    const runs = await readRequestJson(req);
    if (!Array.isArray(runs) || runs.length > 1000) throw new Error('Invalid batch');
    const buffers = [];
    const lengths = [];
    let total = 0;
    for (const run of runs) {
      if (!Array.isArray(run) || run.length !== 3) throw new Error('Invalid range');
      const [name, rawStart, rawEnd] = run;
      const start = Number(rawStart), end = Number(rawEnd);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new Error('Invalid range');
      const filePath = safePath(DATA, name);
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) throw new Error('Data path is not a file');
      const length = Math.max(0, Math.min(end + 1, stat.size) - start);
      if (length) {
        const file = await fsp.open(filePath, 'r');
        try {
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await file.read(buffer, 0, length, start);
          buffers.push(buffer.subarray(0, bytesRead));
          lengths.push(bytesRead);
          total += bytesRead;
        } finally { await file.close(); }
      } else lengths.push(0);
      if (total > 64 * 1024 * 1024) throw new Error('Batch exceeds 64 MiB');
    }
    let body = Buffer.concat(buffers);
    const compressed = url.searchParams.get('gz') === '1';
    if (compressed) body = zlib.gzipSync(body, { level: 1 });
    const headers = { ...ISOLATION, 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length), 'X-Run-Lengths': lengths.join(',') };
    if (compressed) headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    res.end(body);
  } catch (error) { sendError(res, 400, `Invalid data batch: ${error.message}`); }
}

async function serveFile(req, res, pathname) {
  let target;
  try { target = safePath(ROOT, pathname); }
  catch { return sendError(res, 400, 'Invalid path'); }
  try {
    let stat = await fsp.stat(target);
    if (stat.isDirectory()) {
      target = path.join(target, 'index.html');
      stat = await fsp.stat(target);
    }
    if (!stat.isFile()) return sendError(res, 404, 'Not found');
    const headers = { ...ISOLATION, 'Cache-Control': 'no-store', 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' };
    const range = req.headers.range;
    let start = 0, end = stat.size - 1, status = 200;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match || (!match[1] && !match[2]) || stat.size === 0) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': '0' });
        return res.end();
      }
      start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
      end = match[2] ? Math.min(stat.size - 1, Number(match[2])) : stat.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': '0' });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = String(end - start + 1);
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target, { start, end }).on('error', (error) => res.destroy(error)).pipe(res);
  } catch (error) {
    if (error.code === 'ENOENT') return sendError(res, 404, 'Not found');
    sendError(res, 500, error.message);
  }
}

function openBrowser(url) {
  let child;
  if (process.platform === 'win32') child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
  else if (process.platform === 'darwin') child = spawn('open', [url], { detached: true, stdio: 'ignore' });
  else child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.on('error', (error) => console.warn(`Could not open a browser automatically: ${error.message}`));
  child.unref();
}

const portArg = process.argv.find((arg) => arg.startsWith('--port='));
const hostArg = process.argv.find((arg) => arg.startsWith('--host='));
const port = Number(portArg?.split('=')[1] || 8000);
const host = hostArg?.split('=')[1] || '127.0.0.1';
const shouldOpen = !process.argv.includes('--no-open');

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return sendError(res, 400, 'Invalid URL'); }
  if (req.method === 'POST' && url.pathname === '/data/batch') return serveBatch(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Method not allowed');
  await serveFile(req, res, url.pathname);
});

server.listen(port, host, () => {
  const address = `http://localhost:${server.address().port}/?local=1&play=1`;
  console.log(`PlayGTA5 local server: ${address} (Ctrl+C to stop)`);
  if (shouldOpen) openBrowser(address);
});
server.on('error', (error) => { console.error(`Server failed: ${error.message}`); process.exitCode = 1; });
