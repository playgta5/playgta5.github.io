/* ZIP is read by zip.js; RAR is read by the bundled libarchive WASM module. All writes stay in OPFS. */
const STORE = 'playgta5-mirror';
const MAX_FILES = 50000;
const MAX_TOTAL_BYTES = 64 * 1024 ** 3;
const REQUIRED = ['b/8b0b5899ed/game.js', 'b/8b0b5899ed/game.wasm', 'data/manifest.json'];
let totalBytes = 0;
let filesDone = 0;
let lastReport = 0;
let seen = new Set();
let found = new Set();

function send(type, extra = {}) {
  postMessage({ type, filesDone, bytesWritten: totalBytes, ...extra });
}

function mirrorPath(archiveName) {
  if (typeof archiveName !== 'string') return null;
  const clean = archiveName.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = clean.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..' || part.includes(':') || part.includes('\0'))) throw new Error(`Unsafe archive path: ${archiveName}`);
  const rootIndex = parts.findIndex((part) => part === 'b' || part === 'data');
  if (rootIndex < 0) return null;
  const result = parts.slice(rootIndex).join('/');
  if (!result || result.split('/').some((part) => !part || part === '..')) return null;
  return result;
}

async function ensureParent(root, relativePath) {
  const parts = relativePath.split('/');
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  return { dir, name: parts.at(-1) };
}

async function createFileSink(root, relativePath) {
  const { dir, name } = await ensureParent(root, relativePath);
  const handle = await dir.getFileHandle(name, { create: true });
  const target = await handle.createWritable({ keepExistingData: false });
  const writer = target.getWriter();
  let pendingReport = 0;
  const sink = new WritableStream({
    async write(chunk) {
      if (totalBytes + chunk.byteLength > MAX_TOTAL_BYTES) throw new Error('The extracted mirror is larger than the 64 GiB safety limit.');
      await writer.write(chunk);
      totalBytes += chunk.byteLength;
      pendingReport += chunk.byteLength;
      if (pendingReport >= 8 * 1024 * 1024 || performance.now() - lastReport > 700) {
        pendingReport = 0;
        lastReport = performance.now();
        send('progress', { currentFile: relativePath });
      }
    },
    close() { return writer.close(); },
    abort(reason) { return writer.abort(reason); },
  });
  return sink;
}

async function prepareStore() {
  const originRoot = await navigator.storage.getDirectory();
  try { await originRoot.removeEntry(STORE, { recursive: true }); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
  return originRoot.getDirectoryHandle(STORE, { create: true });
}

async function writeEntry(root, archiveName, size, streamTo) {
  const path = mirrorPath(archiveName);
  if (!path) return false;
  if (++filesDone > MAX_FILES) throw new Error(`Archive exceeds the ${MAX_FILES.toLocaleString()} file safety limit.`);
  if (seen.has(path)) throw new Error(`Duplicate archive path: ${path}`);
  seen.add(path);
  if (Number.isFinite(size) && size > 0 && totalBytes + size > MAX_TOTAL_BYTES) throw new Error('The extracted mirror is larger than the 64 GiB safety limit.');
  const sink = await createFileSink(root, path);
  await streamTo(sink);
  found.add(path);
  send('progress', { currentFile: path });
  return true;
}

async function extractZip(file, root) {
  importScripts('/vendor/zip/zip.min.js');
  if (!self.zip?.ZipReader || !self.zip?.BlobReader) throw new Error('Could not load the bundled ZIP reader.');
  const reader = new self.zip.ZipReader(new self.zip.BlobReader(file), { useWebWorkers: false });
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      if (entry.directory) continue;
      const path = mirrorPath(entry.filename);
      if (!path) continue;
      await writeEntry(root, entry.filename, Number(entry.uncompressedSize), (sink) => entry.getData(sink));
    }
  } finally {
    await reader.close();
  }
}

async function extractRar(file, root) {
  importScripts('/vendor/libarchive/archive.js');
  if (typeof self.createLibarchiveModule !== 'function') throw new Error('Could not load the bundled RAR reader.');
  const module = await self.createLibarchiveModule({
    locateFile: (name) => new URL(`/vendor/libarchive/${name}`, self.location.origin).href,
  });
  const fs = module.FS;
  fs.mkdir('/input');
  const workfs = module.WORKERFS || fs.filesystems?.WORKERFS;
  if (!workfs) throw new Error('This RAR build is missing Emscripten WorkerFS.');
  fs.mount(workfs, { files: [file] }, '/input');
  const inputPath = `/input/${file.name}`;
  const pathBuffer = module._malloc(new TextEncoder().encode(inputPath).length + 1);
  const chunkSize = 1024 * 1024;
  const outputBuffer = module._malloc(chunkSize);
  try {
    module.stringToUTF8(inputPath, pathBuffer, new TextEncoder().encode(inputPath).length + 1);
    if (module._rar_open(pathBuffer) !== 1) throw new Error(module.UTF8ToString(module._rar_error()));
    for (;;) {
      const next = module._rar_next();
      if (next === 0) break;
      if (next < 0) throw new Error(module.UTF8ToString(module._rar_error()));
      const rawPath = module.UTF8ToString(module._rar_path());
      const type = module._rar_type();
      const size = module._rar_size();
      const relativePath = mirrorPath(rawPath);
      if (type !== 1 || !relativePath) continue;
      await writeEntry(root, rawPath, size, async (sink) => {
        const writer = sink.getWriter();
        try {
          for (;;) {
            const count = module._rar_read(outputBuffer, chunkSize);
            if (count === 0) break;
            if (count < 0) throw new Error(module.UTF8ToString(module._rar_error()));
            await writer.write(module.HEAPU8.slice(outputBuffer, outputBuffer + count));
          }
        } finally {
          await writer.close();
        }
      });
    }
  } finally {
    module._rar_close();
    module._free(outputBuffer);
    module._free(pathBuffer);
  }
}

async function writeState(root, archiveName) {
  const missing = REQUIRED.filter((path) => !found.has(path));
  if (missing.length) throw new Error(`This archive is missing required mirror files: ${missing.join(', ')}`);
  const record = {
    format: 1,
    importedAt: new Date().toISOString(),
    archiveName,
    files: filesDone,
    bytes: totalBytes,
    required: REQUIRED,
  };
  const handle = await root.getFileHandle('.mirror-state.json', { create: true });
  const writer = await handle.createWritable();
  await writer.write(JSON.stringify(record, null, 2));
  await writer.close();
}

self.onmessage = async (event) => {
  if (event.data?.type !== 'import' || !(event.data.file instanceof Blob)) return;
  const { file } = event.data;
  const ext = file.name.toLowerCase().split('.').pop();
  try {
    if (ext !== 'zip' && ext !== 'rar') throw new Error('Choose a .zip or .rar mirror archive.');
    if (!navigator.storage?.getDirectory) throw new Error('This browser does not support persistent Origin Private File System storage. Use current Chrome or Edge over HTTPS.');
    totalBytes = 0; filesDone = 0; seen = new Set(); found = new Set(); lastReport = performance.now();
    send('start', { archiveName: file.name, archiveBytes: file.size });
    const root = await prepareStore();
    if (ext === 'zip') await extractZip(file, root);
    else await extractRar(file, root);
    await writeState(root, file.name);
    send('complete', { archiveName: file.name });
  } catch (error) {
    send('error', { message: error?.message || String(error) });
  }
};
