const $ = id => document.getElementById(id);
$("folder").onclick = () => chrome.downloads.showDefaultFolder();
$("helpbtn").onclick = () => ($("help").hidden = !$("help").hidden);

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const exec = async (func, ...args) => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args }))[0]?.result;
  let courses, origin;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["turndown.js", "content.js"] });
    origin = await exec(() => location.origin);
    courses = await exec(() => window.__canvasSaver.courses());
  } catch (e) {
    console.warn(e);
  }
  if (!courses?.length) {
    $("msg").textContent = "Open your Canvas site in this tab and log in, then click the icon again.";
    $("help").hidden = false;
    return;
  }

  const key = "cfg:" + origin;
  const cfg = (await chrome.storage.local.get(key))[key] || {};
  const chosen = new Set(cfg.ids ?? courses.map(c => c.id)); // first time: everything ticked
  $("msg").textContent = cfg.lastRun ? `Last updated ${cfg.lastRun}` : "Pick the courses to save:";
  for (const c of courses) {
    const box = Object.assign(document.createElement("input"), { type: "checkbox", value: c.id, checked: chosen.has(c.id) });
    const text = document.createElement("span");
    text.append(c.name, Object.assign(document.createElement("small"), { textContent: c.term || "" }));
    const row = document.createElement("label");
    row.append(box, text);
    $("list").append(row);
  }
  const boxes = [...$("list").querySelectorAll("input")];
  const sync = () => {
    const n = boxes.filter(b => b.checked).length;
    $("all").checked = n === boxes.length;
    $("go").disabled = !n;
    $("go").textContent = `Download ${n} course${n === 1 ? "" : "s"}`;
  };
  boxes.forEach(b => (b.onchange = sync));
  $("all").onchange = () => { boxes.forEach(b => (b.checked = $("all").checked)); sync(); };
  $("maxmb").value = cfg.maxMB ?? 200;
  $("dest").value = cfg.folder ?? "Canvas";
  $("allrow").hidden = $("sizerow").hidden = $("folderrow").hidden = $("desthint").hidden = $("go").hidden = false;
  sync();

  $("go").onclick = async () => {
    const ids = boxes.filter(b => b.checked).map(b => Number(b.value));
    await chrome.storage.local.set({ [key]: { ...cfg, ids, maxMB: Math.max(0, Number($("maxmb").value) || 0),
      folder: $("dest").value.trim() || "Canvas" } });
    exec(ids => window.__canvasSaver.run(ids), ids); // runs in the page; popup can close
    window.close();
  };
})();
