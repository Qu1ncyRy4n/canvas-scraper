// Content script runs inside the Canvas tab (existing login, no token) and sends {path, url | text, key} to save.
// Skip if the same version was already saved and the file still exists.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.openFolder) return void chrome.downloads.showDefaultFolder();
  if ("badge" in msg) return void chrome.action.setBadgeText({ text: msg.badge });
  save(msg).then(reply, e => reply({ error: String(e) }));
  return true;
});

async function save({ path, url, text, key }) {
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
  await chrome.storage.local.set({ [path]: { key, id } });
  return { id };
}
