// Content script runs inside the Canvas tab (existing login, no token) and sends {path, url | text, key, meta} to save.
// Storage: one record per saved path, {key, id, meta}; key = Canvas version (files) or SHA-1 (text), id = download id.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.openFolder) return void chrome.downloads.showDefaultFolder();
  if ("badge" in msg) return void chrome.action.setBadgeText({ text: msg.badge });
  (msg.verify ? verify(msg.verify) : save(msg)).then(reply, e => reply({ error: String(e) }));
  return true;
});

// Skip if the same version was already saved and the file still exists.
async function save({ path, url, text, key, meta }) {
  const { [path]: prev } = await chrome.storage.local.get(path);
  if (prev?.key === key) {
    const [item] = await chrome.downloads.search({ id: prev.id });
    if (item?.exists && item.state === "complete") return { skipped: true };
  }
  // Firefox (event page) can't download data: URLs but has createObjectURL; Chrome's service worker is the reverse
  if (text != null) url = globalThis.URL.createObjectURL
    ? URL.createObjectURL(new Blob([text], { type: "text/markdown" }))
    : "data:text/markdown;charset=utf-8," + encodeURIComponent(text);
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
    if (!item?.exists) missing.push(path);
  }
  await chrome.storage.local.remove(missing);
  return { checked: paths.length, missing };
}
