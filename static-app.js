const STORE = 'playgta5-mirror';
const $ = (id) => document.getElementById(id);
const chooseButton = $('mirror-choose');
const exportButton = $('mirror-export');
const fileInput = $('mirror-file');
const labelEl = $('label');
const consoleEl = $('console');
const dataEl = $('data');
const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
const fmtBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return 'unknown size';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i >= 3 ? 2 : 1)} ${units[i]}`;
};
const setStatus = (message, isError = false) => {
  labelEl.textContent = message;
  labelEl.style.color = isError ? '#e66' : '';
  if (isError) consoleEl.textContent = message;
};

async function inspectStoredMirror() {
  if (isLocalHost) return { ready: true, local: true };
  const originRoot = await navigator.storage.getDirectory();
  let mirror;
  try { mirror = await originRoot.getDirectoryHandle(STORE); }
  catch (error) { if (error.name === 'NotFoundError') return { ready: false, local: false }; throw error; }
  let record;
  try {
    const markerHandle = await mirror.getFileHandle('.mirror-state.json');
    record = JSON.parse(await (await markerHandle.getFile()).text());
  } catch (error) {
    if (error.name === 'NotFoundError' || error instanceof SyntaxError) return { ready: false, local: false, warning: 'No complete mirror is saved in this browser yet.' };
    throw error;
  }
  if (record.format !== 1 || !record.files || !record.bytes) return { ready: false, local: false, warning: 'The saved mirror is incomplete. Import the archive again.' };
  try {
    await getFileAt(mirror, 'data/manifest.json');
    await getFileAt(mirror, 'b/8b0b5899ed/game.wasm');
    await getFileAt(mirror, 'b/8b0b5899ed/game.js');
  } catch (error) {
    if (error.name === 'NotFoundError') return { ready: false, local: false, warning: 'The saved mirror is incomplete. Import the archive again.' };
    throw error;
  }
  return { ready: true, local: false, record };
}

async function getFileAt(root, relative) {
  const parts = relative.split('/');
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
  return dir.getFileHandle(parts.at(-1));
}

async function storageSummary() {
  try {
    const estimate = await navigator.storage.estimate();
    const free = Math.max(0, (estimate.quota || 0) - (estimate.usage || 0));
    return `Browser storage available: ${fmtBytes(free)} (reported quota ${fmtBytes(estimate.quota || 0)}). The extracted mirror can require 20+ GB.`;
  } catch { return 'The browser could not estimate local storage. The mirror can require 20+ GB.'; }
}

function showState(state) {
  if (state.error) {
    setStatus('Mirror storage is unavailable', true);
    consoleEl.textContent = state.error;
    dataEl.textContent = 'Open this page in a supported browser over HTTPS.';
    chooseButton.hidden = true;
    exportButton.hidden = true;
    return;
  }
  if (state.ready) {
    setStatus('Starting the game…');
    consoleEl.textContent = '';
    dataEl.textContent = state.local
      ? 'Using mirror files from this local build.'
      : `${Number(state.record.files).toLocaleString()} mirror files saved in this browser.`;
    chooseButton.hidden = true;
    exportButton.hidden = !!state.local;
    document.getElementById('loading').classList.remove('mirror-gate');
  } else {
    setStatus('Choose your mirror archive to begin');
    consoleEl.textContent = state.warning || 'The archive stays in this browser; nothing is uploaded.';
    dataEl.textContent = state.storageMessage || 'The mirror can require 20+ GB of free storage.';
    chooseButton.hidden = false;
    chooseButton.disabled = false;
    exportButton.hidden = true;
    document.getElementById('loading').classList.add('mirror-gate');
  }
}

let importWorker = null;
function beginImport(file) {
  if (!file) return;
  if (!/\.(zip|rar)$/i.test(file.name)) { setStatus('Choose a .zip or .rar file.', true); return; }
  if (window.__mirrorReady?.ready && !window.__mirrorReady.local && !confirm('Replace the mirror already stored in this browser? This removes the old local copy first.')) return;
  importWorker?.terminate();
  importWorker = new Worker('/import-worker.js');
  chooseButton.disabled = true;
  exportButton.hidden = true;
  document.getElementById('loading').classList.add('mirror-importing');
  setStatus('Preparing your mirror archive…');
  consoleEl.textContent = `${file.name} · ${fmtBytes(file.size)} · processed on this device`;
  importWorker.onmessage = (event) => {
    const message = event.data;
    if (message.type === 'start') {
      setStatus('Reading mirror archive…');
      consoleEl.textContent = `${message.archiveName} · ${fmtBytes(message.archiveBytes)}`;
    }
    if (message.type === 'progress') {
      setStatus('Importing mirror data…');
      dataEl.textContent = `${Number(message.filesDone).toLocaleString()} files · ${fmtBytes(message.bytesWritten)} saved`;
      consoleEl.textContent = (message.currentFile || 'Mirror files') + ' · Keep this tab open';
    }
    if (message.type === 'error') {
      document.getElementById('loading').classList.remove('mirror-importing');
      chooseButton.disabled = false;
      setStatus('Mirror import failed', true);
      consoleEl.textContent = `${message.message}. Choose the archive again to retry.`;
      importWorker.terminate(); importWorker = null;
    }
    if (message.type === 'complete') {
      document.getElementById('loading').classList.remove('mirror-importing');
      setStatus('Mirror ready — starting the game…');
      dataEl.textContent = `${Number(message.filesDone).toLocaleString()} files · ${fmtBytes(message.bytesWritten)} saved`;
      importWorker.terminate(); importWorker = null;
      setTimeout(() => { const url = new URL(location.href); url.searchParams.set('play', '1'); location.replace(url.href); }, 900);
    }
  };
  importWorker.onerror = (event) => {
    document.getElementById('loading').classList.remove('mirror-importing');
    chooseButton.disabled = false;
    setStatus('Mirror import failed', true);
    consoleEl.textContent = event.message || 'The import worker stopped unexpectedly.';
  };
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => false);
  importWorker.postMessage({ type: 'import', file });
}

async function* walkFiles(directory, prefix = '') {
  for await (const [name, handle] of directory.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') yield* walkFiles(handle, path);
    else if (path !== '.mirror-state.json' && !path.endsWith('.part')) yield { path, handle };
  }
}

const PACKAGE_FILES = [
  ['README.md', 'README.md'],
  ['Launch-Local.cmd', 'Launch-Local.cmd'],
  ['Start-Local.ps1', 'Start-Local.ps1'],
  ['serve_local.py', 'serve_local.py'],
  ['server.js', 'server.js'],
  ['index.html', 'mirror/playgta5.com/index.html'],
  ['favicon.ico', 'mirror/playgta5.com/favicon.ico'],
  ['static-app.js', 'mirror/playgta5.com/static-app.js'],
  ['sw.js', 'mirror/playgta5.com/sw.js'],
  ['import-worker.js', 'mirror/playgta5.com/import-worker.js'],
  ['vendor/zip/zip.min.js', 'mirror/playgta5.com/vendor/zip/zip.min.js'],
  ['vendor/zip/LICENSE', 'mirror/playgta5.com/vendor/zip/LICENSE'],
  ['vendor/libarchive/archive.js', 'mirror/playgta5.com/vendor/libarchive/archive.js'],
  ['vendor/libarchive/archive.wasm', 'mirror/playgta5.com/vendor/libarchive/archive.wasm'],
  ['vendor/libarchive/COPYING-libarchive.txt', 'mirror/playgta5.com/vendor/libarchive/COPYING-libarchive.txt'],
  ['runtime/LICENSE.txt', 'runtime/LICENSE.txt'],
  ['runtime/python.exe', 'runtime/python.exe'],
  ['runtime/python3.dll', 'runtime/python3.dll'],
  ['runtime/python312._pth', 'runtime/python312._pth'],
  ['runtime/python312.dll', 'runtime/python312.dll'],
  ['runtime/python312.zip', 'runtime/python312.zip'],
  ['runtime/vcruntime140.dll', 'runtime/vcruntime140.dll'],
  ['runtime/vcruntime140_1.dll', 'runtime/vcruntime140_1.dll'],
];

async function downloadPortableBuild() {
  if (!window.showSaveFilePicker || !window.zip?.ZipWriter || !window.zip?.BlobReader) {
    throw new Error('Large ZIP64 export requires a current Chrome or Edge browser with File System Access API support.');
  }
  const outputHandle = await window.showSaveFilePicker({
    suggestedName: 'playgta5-local.zip',
    types: [{ description: 'ZIP64 archive', accept: { 'application/zip': ['.zip'] } }],
  });
  const originRoot = await navigator.storage.getDirectory();
  const mirror = await originRoot.getDirectoryHandle(STORE);
  const output = await outputHandle.createWritable();
  const writer = new window.zip.ZipWriter(output, { zip64: true });
  let added = 0;
  let total = 0;
  let closed = false;
  const addBlob = async (archivePath, blob) => {
    await writer.add(archivePath, new window.zip.BlobReader(blob), { level: 0, compressionMethod: 0 });
    added++;
    total += blob.size || 0;
    setStatus(`Building ZIP64 — ${added} entries, ${fmtBytes(total)} processed. Keep this tab open.`);
  };
  try {
    for (const [sourcePath, destinationPath] of PACKAGE_FILES) {
      const response = await fetch(`/${sourcePath}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Could not read ${sourcePath} from this site (HTTP ${response.status}).`);
      await addBlob(`playgta5/${destinationPath}`, await response.blob());
    }
    for await (const item of walkFiles(mirror)) {
      const file = await item.handle.getFile();
      await writer.add(`playgta5/mirror/playgta5.com/${item.path}`, new window.zip.BlobReader(file), { level: 0, compressionMethod: 0 });
      added++; total += file.size;
      if (added % 10 === 0 || total % (512 * 1024 * 1024) < file.size) setStatus(`Building ZIP64 — ${added.toLocaleString()} entries, ${fmtBytes(total)} processed. Current file: ${item.path}`);
    }
    await writer.close();
    closed = true;
    setStatus(`Build download complete: ${added.toLocaleString()} entries, ${fmtBytes(total)}. Extract the ZIP and run Launch-Local.cmd.`);
  } catch (error) {
    if (!closed) {
      try { await output.abort(error); } catch {}
    }
    throw error;
  }
}

async function initialize() {
  const boot = await (window.__siteBoot || Promise.resolve({ error: 'Static site bootstrap was not loaded.' }));
  let state;
  try {
    if (boot.error) throw new Error(boot.error);
    state = await inspectStoredMirror();
  } catch (error) {
    state = { ready: false, error: error.message };
  }
  if (!state.ready && !state.error && !state.local) state.storageMessage = await storageSummary();
  window.__mirrorReady = state;
  if (window.__resolveMirrorState) window.__resolveMirrorState(state);
  showState(state);

  chooseButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { beginImport(fileInput.files?.[0]); fileInput.value = ''; });
  exportButton.addEventListener('click', async () => {
    exportButton.disabled = true;
    try { await downloadPortableBuild(); }
    catch (error) { setStatus(error.name === 'AbortError' ? 'Build export canceled' : 'Build export failed', error.name !== 'AbortError'); consoleEl.textContent = error.message; }
    finally { exportButton.disabled = false; }
  });
}

initialize().catch((error) => {
  const state = { ready: false, error: `Could not initialize browser storage: ${error.message}` };
  window.__mirrorReady = state;
  if (window.__resolveMirrorState) window.__resolveMirrorState(state);
  showState(state);
});
