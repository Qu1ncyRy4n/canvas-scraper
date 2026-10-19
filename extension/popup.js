const $ = id => document.getElementById(id);
$("folder").onclick = () => chrome.downloads.showDefaultFolder();
$("helpbtn").onclick = () => ($("help").hidden = !$("help").hidden);

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const exec = async (func, ...args) => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args }))[0]?.result;
  const getCourses = past => exec(past => window.__canvasSaver.courses(past), past);
  let origin, courses;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["turndown.js", "content.js"] });
    origin = await exec(() => location.origin);
  } catch (e) {
    console.warn(e);
  }
  const key = "cfg:" + origin;
  const cfg = (origin && (await chrome.storage.local.get(key))[key]) || {};
  try {
    courses = origin && (await getCourses(!!cfg.showPast));
  } catch (e) {
    console.warn(e);
  }
  if (!courses?.length) {
    $("msg").textContent = "Open your Canvas site in this tab and log in, then click the icon again.";
    $("help").hidden = false;
    return;
  }

  // first time: current courses ticked, past ones not
  let chosen = new Set(cfg.ids ?? courses.filter(c => !c.past).map(c => c.id));
  const boxes = () => [...$("list").querySelectorAll("input")];
  const sync = () => {
    const n = boxes().filter(b => b.checked).length;
    $("all").checked = n === boxes().length;
    $("go").disabled = !n;
    $("go").textContent = `Download ${n} course${n === 1 ? "" : "s"}`;
  };
  const render = () => {
    $("list").replaceChildren();
    for (const [i, c] of courses.entries()) {
      if (c.past && !courses[i - 1]?.past) $("list").append(Object.assign(document.createElement("h2"), { textContent: "Past courses" }));
      const box = Object.assign(document.createElement("input"), { type: "checkbox", value: c.id, checked: chosen.has(c.id), onchange: sync });
      const text = document.createElement("span");
      text.append(c.name, Object.assign(document.createElement("small"), { textContent: c.term || "" }));
      const row = document.createElement("label");
      row.append(box, text);
      $("list").append(row);
    }
    sync();
  };
  $("all").onchange = () => { boxes().forEach(b => (b.checked = $("all").checked)); sync(); };
  $("showpast").checked = !!cfg.showPast;
  $("showpast").onchange = async () => {
    chosen = new Set(boxes().filter(b => b.checked).map(b => Number(b.value)));
    $("msg").textContent = "Loading courses…";
    courses = (await getCourses($("showpast").checked)) || courses;
    $("msg").textContent = "Pick the courses to save:";
    render();
  };

  $("msg").textContent = cfg.lastRun ? `Last updated ${cfg.lastRun}` : "Pick the courses to save:";
  $("maxmb").value = cfg.maxMB ?? 200;
  $("dest").value = cfg.folder ?? "Canvas";
  $("autotext").checked = cfg.autoText ?? true;
  for (const id of ["allrow", "pastrow", "sizerow", "folderrow", "desthint", "textrow", "go"]) $(id).hidden = false;
  chrome.runtime.sendNativeMessage("com.canvas_saver.host", { cmd: "ping" }).then(
    r => ($("textstatus").textContent = `(ready ✓, helper ${r.version})`),
    () => ($("textstatus").textContent = "(not set up yet, see ?)"));
  render();

  $("go").onclick = async () => {
    // hidden past courses aren't kept: unticking "show past" stops updating them
    const ids = boxes().filter(b => b.checked).map(b => Number(b.value));
    await chrome.storage.local.set({ [key]: { ...cfg, ids, showPast: $("showpast").checked,
      maxMB: Math.max(0, Number($("maxmb").value) || 0), folder: $("dest").value.trim() || "Canvas",
      autoText: $("autotext").checked } });
    exec(ids => window.__canvasSaver.run(ids), ids); // runs in the page; popup can close
    window.close();
  };
})();
