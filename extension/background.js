// Content script runs inside the Canvas tab (existing login, no token) and sends {path, url | text, key, meta} to save.
// Storage: one record per saved path, {key, id, meta}; key = Canvas version (files) or SHA-1 (text), id = download id.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.openFolder) return void chrome.downloads.showDefaultFolder();
  if ("badge" in msg) return void chrome.action.setBadgeText({ text: msg.badge });
  (msg.verify ? verify(msg.verify) : save(msg)).then(reply, e => reply({ error: String(e) }));
  return true;
});

// A recorded download still on disk under the name we asked for (browsers may rename by content type).
const intact = (item, path) => item?.exists && item.state === "complete" && item.filename.endsWith(path.split("/").pop());

// Skip if the same version was already saved and the file is still there.
async function save({ path, url, text, key, meta }) {
  const { [path]: prev } = await chrome.storage.local.get(path);
  if (prev?.key === key) {
    const [item] = await chrome.downloads.search({ id: prev.id });
    if (intact(item, path)) return { skipped: true };
  }
  // the browser picks the file extension from the content type, so it must match the path
  const type = path.endsWith(".json") ? "application/json" : "text/markdown";
  // Firefox (event page) can't download data: URLs but has createObjectURL; Chrome's service worker is the reverse
  if (text != null) url = globalThis.URL.createObjectURL
    ? URL.createObjectURL(new Blob([text], { type }))
    : `data:${type};charset=utf-8,` + encodeURIComponent(text);
  const id = await chrome.downloads.download({ url, filename: path, conflictAction: "overwrite", saveAs: false });
  await chrome.storage.local.set({ [path]: { key, id, meta } });
  return { id };
}

// Before a run: check every recorded file under root still exists on disk (search() refreshes `exists`).
// Missing ones lose their record, so this run downloads them again.
async function verify(root) {
  const all = await chrome.storage.local.get(null), missing = [];
  const paths = Object.keys(all).filter(p => p.startsWith(root + "/"));
  for (const path of paths) {
    const [item] = await chrome.downloads.search({ id: all[path].id });
    if (!intact(item, path)) missing.push(path);
  }
  await chrome.storage.local.remove(missing);
  return { checked: paths.length, missing };
}

// After a run: wait for this run's downloads to finish, then have canvas-host (Python, via native messaging)
// make text versions and transcripts. Progress goes back to the Canvas tab over the port; if the tab closes,
// processing still finishes.
const HOST = "com.canvas_saver.host";
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "process") return;
  port.onMessage.addListener(async ({ root }) => {
    let open = true;
    port.onDisconnect.addListener(() => (open = false));
    const relay = m => { try { if (open) port.postMessage(m); } catch { open = false; } };
    try {
      relay({ progress: "Waiting for downloads to finish…" });
      const dir = await waitForDownloads(root);
      const host = chrome.runtime.connectNative(HOST);
      host.onMessage.addListener(m => {
        relay(m);
        if (m.done || m.error) host.disconnect();
      });
      host.onDisconnect.addListener(() => chrome.runtime.lastError && relay({ error: chrome.runtime.lastError.message }));
      host.postMessage({ cmd: "process", dir });
    } catch (e) {
      relay({ error: String(e.message || e) });
    }
  });
});

// Absolute path of the save folder (from where manifest.json landed), once nothing in it is still downloading.
async function waitForDownloads(root) {
  const { [`${root}/manifest.json`]: rec } = await chrome.storage.local.get(`${root}/manifest.json`);
  const [item] = rec ? await chrome.downloads.search({ id: rec.id }) : [];
  if (!item?.filename) throw new Error("can't find the save folder; run Download once more");
  const dir = item.filename.replace(/[\\/][^\\/]*$/, ""); // folder the manifest landed in
  for (let waited = 0; waited < 1800; waited++) { // ponytail: 30 min cap for huge course folders
    const busy = (await chrome.downloads.search({ state: "in_progress" })).filter(d => d.filename.startsWith(dir));
    if (!busy.length) return dir;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("downloads still running after 30 minutes");
}
