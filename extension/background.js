// Click icon -> run scraper inside the Canvas tab (uses the existing login, no token needed).
chrome.action.onClicked.addListener(tab =>
  chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["turndown.js", "content.js"] }));

// Content script asks us to save {path, url, key}. Skip if same version was already saved and the file still exists.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  save(msg).then(reply, e => reply({ error: String(e) }));
  return true;
});

async function save({ path, url, key }) {
  const { [path]: prev } = await chrome.storage.local.get(path);
  if (prev?.key === key) {
    const [item] = await chrome.downloads.search({ id: prev.id });
    if (item?.exists && item.state === "complete") return { skipped: true };
  }
  const id = await chrome.downloads.download({ url, filename: path, conflictAction: "overwrite", saveAs: false });
  await chrome.storage.local.set({ [path]: { key, id } });
  return { id };
}
