// Runs inside a logged-in Canvas tab (auto-loaded on *.instructure.com, injected by the popup elsewhere).
// Mirrors courses into Downloads/Canvas/<Course>/ as linked Markdown, same layout as the Python canvas-scrape.
// Exposes window.__canvasSaver = { courses, run } for the popup; shows a daily "Update?" prompt.
if (!window.__canvasSaver) (() => {
  const YT = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:\S*?&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/g;
  const CANVAS = /^(?:https?:\/\/[^/]+)?\/courses\/\d+\/(files|pages|assignments)\/([\w-]+)/;
  const MD_LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;
  const CFG = "cfg:" + location.origin; // {ids, lastRun, asked}
  const today = () => new Date().toLocaleDateString("en-CA");

  const safe = s => (s || "").replace(/[\\/:*?"<>|#^\[\]~\x00-\x1f]+/g, "_").replace(/^[\s.]+|[\s.]+$/g, "").slice(0, 120) || "untitled";
  const rel = (target, here) => {
    const a = here.split("/").slice(0, -1), b = target.split("/");
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return [...Array(a.length - i).fill(".."), ...b.slice(i)].map(encodeURIComponent).join("/");
  };
  const hash = async t => [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(t)))]
    .map(b => b.toString(16).padStart(2, "0")).join("");
  const getCfg = async () => (await chrome.storage.local.get(CFG))[CFG] || {};
  const setCfg = async patch => chrome.storage.local.set({ [CFG]: { ...(await getCfg()), ...patch } });

  // GET all pages of a Canvas API list; null when this user can't see it (hidden tab, locked, etc.)
  async function api(path, onePage) {
    let url = `${location.origin}/api/v1/${path}${path.includes("?") ? "&" : "?"}per_page=100`, out = [];
    while (url) {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) {
        if ([401, 403, 404].includes(r.status)) return null;
        throw new Error(`Canvas said ${r.status} for ${url}`);
      }
      const data = JSON.parse((await r.text()).replace(/^while\(1\);/, ""));
      if (!Array.isArray(data)) return data;
      out.push(...data);
      if (onePage) break;
      url = r.headers.get("Link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    }
    return out;
  }

  // --- floating panel (progress + prompts)
  function panel() {
    document.getElementById("canvas-saver")?.remove();
    const box = el("div", { id: "canvas-saver" });
    Object.assign(box.style, { position: "fixed", bottom: "16px", right: "16px", zIndex: 99999, width: "340px",
      background: "#1f2937", color: "#fff", padding: "14px 16px", borderRadius: "10px", font: "14px/1.4 system-ui",
      boxShadow: "0 6px 24px rgba(0,0,0,.3)" });
    document.body.append(box);
    return box;
  }
  function el(tag, props = {}, ...kids) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...kids);
    return e;
  }
  const btn = (text, onclick, primary) => {
    const b = el("button", { textContent: text, onclick });
    Object.assign(b.style, { marginTop: "10px", marginRight: "8px", padding: "6px 12px", borderRadius: "6px", cursor: "pointer",
      border: "none", background: primary ? "#3b82f6" : "#4b5563", color: "#fff", font: "inherit" });
    return b;
  };

  // YouTube id -> {title, file}; filled per course before rendering (see videoNames)
  let videos = new Map();
  // ![Title](watch url): Obsidian and similar apps show this as an embedded player
  const embed = (id, fallback = "Video") =>
    `![${(videos.get(id)?.title ?? fallback).replace(/[\[\]]/g, "")}](https://www.youtube.com/watch?v=${id})`;

  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  td.addRule("iframe", {
    filter: "iframe",
    replacement: (_, n) => {
      const src = n.getAttribute("src") || "", y = [...src.matchAll(YT)][0];
      return `\n\n${y ? embed(y[1], "Embedded video") : `[Embedded content](${src})`}\n\n`;
    },
  });

  // Video titles from YouTube's oEmbed (no key needed); transcript file names come from them.
  // canvas-process saves each transcript wherever videos.md links it, so this is the only place names are chosen.
  async function videoNames(ids) {
    const out = new Map(), used = new Set();
    for (const id of ids) {
      let title = null;
      try {
        const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${id}`, { credentials: "omit" });
        if (r.ok) title = (await r.json()).title;
      } catch {} // offline or blocked: fall back to the id
      let name = safe(title || id);
      if (used.has(name.toLowerCase())) name += ` (${id})`;
      used.add(name.toLowerCase());
      out.set(id, { title: title || `Video ${id}`, file: `${name}.md` });
    }
    return out;
  }

  // Text that canvas-process (Python) makes from originals; keep in sync with CONVERT / PLAIN in canvas_scrape.
  const CONVERT = /\.(pdf|pptx)$/i, PLAIN = /\.(txt|md|csv|tsv|json|tex|html?|css|js|py|r|java|c|cpp|h)$/i;

  // Scan one course -> {jobs: [{path, url | text, key, label}], due, skipped: [{name, why}]}. Nothing is downloaded here.
  // Paths are relative to the save folder:  Plaintext/<Course>/... (markdown)  and  Source/<Course>/... (original files)
  async function scanCourse(c, maxBytes) {
    const T = `Plaintext/${safe(c.name)}/`, S = `Source/${safe(c.name)}/`;
    const base = `courses/${c.id}`, jobs = [], bundle = [], skipped = [];
    const files = new Map(), pages = new Map(), assignments = new Map(), blobs = [];
    const putText = async (path, text, { inBundle = true, label = null } = {}) => {
      jobs.push({ path, text, key: await hash(text), label });
      if (inBundle) bundle.push(text);
    };
    // where canvas-process puts the text version of an original, if it makes one
    const transcript = id => `${T}transcripts/${videos.get(id)?.file ?? `${id}.md`}`; // written by canvas-process
    const textOf = src => CONVERT.test(src) ? `${T}files/${src.slice(S.length)}.md`
      : PLAIN.test(src) ? `${T}files/${src.slice(S.length)}` : null;

    const folders = new Map((await api(`${base}/folders`) ?? []).map(f => [f.id, f.full_name.replace(/^course files\/?/, "")]));
    async function fileFor(fid, f) {
      if (!files.has(fid)) {
        files.set(fid, null);
        f ??= await api(`${base}/files/${fid}`);
        // skipped files stay as online links
        if (!f) skipped.push({ name: `file #${fid}`, why: "no access (hidden, deleted, or another course)" });
        else if (!f.url) skipped.push({ name: f.display_name, why: "locked by instructor" });
        else if (maxBytes && f.size > maxBytes) skipped.push({ name: f.display_name, why: `${Math.round(f.size / 1e6)} MB, over size limit` });
        else {
          const path = S + [...(folders.get(f.folder_id) ?? "").split("/").filter(Boolean).map(safe), safe(f.display_name)].join("/");
          files.set(fid, path);
          jobs.push({ path, url: f.url, key: `${f.updated_at}|${f.size}`, label: f.display_name,
            meta: { canvas_id: f.id, size: f.size, updated_at: f.updated_at } });
        }
      }
      return files.get(fid);
    }

    for (const f of (await api(`${base}/files`)) ?? []) await fileFor(f.id, f);
    for (const p of (await api(`${base}/pages?include[]=body`)) ?? []) pages.set(p.url, p);
    for (const a of (await api(`${base}/assignments?include[]=submission`)) ?? []) assignments.set(String(a.id), a);
    const news = (await api(`${base}/discussion_topics?only_announcements=true`)) ?? [];
    const modules = (await api(`${base}/modules?include[]=items`)) ?? [];
    for (const m of modules) {
      m.items ??= (await api(`${base}/modules/${m.id}/items`)) ?? [];
      for (const it of m.items) {
        if (it.type === "Page" && !pages.has(it.page_url)) {
          const p = await api(`${base}/pages/${it.page_url}`);
          if (p) pages.set(p.url, p);
        }
        if (it.type === "File") await fileFor(it.content_id);
        blobs.push(it.external_url || "");
      }
    }
    for (const p of pages.values()) {
      if (p.body === undefined) p.body = (await api(`${base}/pages/${p.url}`))?.body;
      p.path = `${T}pages/${safe(p.title)}.md`;
      blobs.push(p.body || "");
    }
    for (const a of assignments.values()) { a.path = `${T}assignments/${safe(a.name)}.md`; blobs.push(a.description || ""); }
    blobs.push(c.syllabus_body || "", ...news.map(n => n.message || ""));
    // files linked from page text (works even when the Files tab is hidden)
    for (const [, id] of blobs.join("\n").matchAll(/\/courses\/\d+\/files\/(\d+)/g)) await fileFor(Number(id));

    const vids = [...new Set([...blobs.join("\n").matchAll(YT)].map(m => m[1]))];
    videos = await videoNames(vids);

    const resolve = (kind, key) =>
      kind === "files" ? files.get(Number(key)) : (kind === "pages" ? pages : assignments).get(key)?.path;
    const toMd = (html, here) => td.turndown(html || "").replace(MD_LINK, (m, bang, text, url) => {
      const hit = url.match(CANVAS), target = hit && resolve(hit[1], hit[2]);
      if (target) return `${bang}[${text}](${rel(target, here)})`;
      const y = [...url.matchAll(YT)][0];
      if (y) return `${m} ([transcript](${rel(transcript(y[1]), here)}))`;
      return url.startsWith("/") ? `${bang}[${text}](${location.origin}${url})` : m; // not saved locally -> link to Canvas
    }).replace(/\n{3,}/g, "\n\n").trim();

    const home = T + "README.md";
    const index = [`# ${c.name}\n`, `[Open in Canvas](${location.origin}/courses/${c.id})\n`];
    if (c.syllabus_body) {
      await putText(T + "syllabus.md", `# Syllabus\n\n${toMd(c.syllabus_body, T + "syllabus.md")}\n`);
      index.push("- [Syllabus](syllabus.md)");
    }

    index.push("\n## Modules\n");
    for (const [i, m] of modules.entries()) {
      const path = `${T}modules/${String(i + 1).padStart(2, "0")} ${safe(m.name)}.md`, lines = [`# ${m.name}\n`];
      for (const it of m.items) {
        const pad = "  ".repeat(it.indent || 0);
        const src = it.type === "File" ? files.get(it.content_id) : null, text = src && textOf(src);
        const target = src ? text ?? src
          : it.type === "Page" ? pages.get(it.page_url)?.path
          : it.type === "Assignment" ? assignments.get(String(it.content_id))?.path : null;
        if (it.type === "SubHeader") lines.push(`\n**${it.title}**\n`);
        else if (target) lines.push(`${pad}- [${it.title}](${rel(target, path)})` + (text ? ` ([original](${rel(src, path)}))` : ""));
        else {
          const y = [...(it.external_url || "").matchAll(YT)][0];
          lines.push(y ? `${pad}- ${embed(y[1], it.title)} ([transcript](${rel(transcript(y[1]), path)}))`
            : `${pad}- [${it.title}](${it.external_url || it.html_url}) _(${it.type})_`);
          if (!["ExternalUrl", "File"].includes(it.type)) skipped.push({ name: it.title, why: `${it.type}, online only` });
        }
      }
      await putText(path, lines.join("\n") + "\n");
      index.push(`- [${m.name}](${rel(path, home)})`);
    }

    for (const p of pages.values())
      await putText(p.path, `# ${p.title}\n\n${toMd(p.body, p.path)}\n`, { label: `${p.title} (page)` });

    const byDue = [...assignments.values()].sort((a, b) => (a.due_at || "~").localeCompare(b.due_at || "~"));
    if (byDue.length) index.push("\n## Assignments\n");
    for (const a of byDue) {
      const due = (a.due_at || "no due date").slice(0, 10);
      await putText(a.path, `# ${a.name}\n\nDue: ${due} · Points: ${a.points_possible ?? "-"} · [Canvas](${a.html_url})\n\n${toMd(a.description, a.path)}\n`,
        { label: `${a.name} (assignment)` });
      index.push(`- ${due} [${a.name}](${rel(a.path, home)})`);
    }

    if (news.length) index.push("\n## Announcements\n");
    for (const n of news) {
      const date = (n.posted_at || "").slice(0, 10), path = `${T}announcements/${date} ${safe(n.title)}.md`;
      await putText(path, `# ${n.title}\n\n${date}\n\n${toMd(n.message, path)}\n`, { label: `${n.title} (announcement)` });
      index.push(`- ${date} [${n.title}](${rel(path, home)})`);
    }

    // NotebookLM / Gemini read YouTube links directly; canvas-process saves transcripts where these link
    if (vids.length) {
      await putText(T + "videos.md", `# Videos\n\nTranscript links work once canvas-process has run.\n\n`
        + vids.map(v => `- [${videos.get(v).title.replace(/[\[\]]/g, "")}](https://youtu.be/${v}) · [transcript](${rel(transcript(v), T + "videos.md")})`).join("\n") + "\n",
        { inBundle: false });
      index.push(`\n## Videos\n\n- [${vids.length} YouTube videos, with transcripts](videos.md)\n- [All transcripts by title](transcripts/README.md)`);
    }
    // everything in one file: fewer sources to add to NotebookLM. Links from depth-1 files lose one "../".
    const all = `# ${c.name}: all course text\n\n` + bundle.map(t => t.trim()).join("\n\n---\n\n").replaceAll("](../", "](");
    await putText(T + "course.md", all, { inBundle: false });
    index.push(`\n## Other\n\n- [Everything in one file](course.md)\n- [What's new](CHANGES.md)\n- [Not downloaded](SKIPPED.md)\n- [Original files](${rel(S, home)})`);
    await putText(home, index.join("\n") + "\n", { inBundle: false });

    const now = Date.now(), week = now + 7 * 864e5;
    const due = byDue.filter(a => a.due_at && Date.parse(a.due_at) > now && Date.parse(a.due_at) < week)
      .map(a => ({ name: a.name, course: c.course_code || c.name, due: a.due_at,
        done: ["submitted", "graded", "pending_review"].includes(a.submission?.workflow_state) }));
    return { jobs, due, skipped, T };
  }

  async function courses() {
    const list = await api("courses?enrollment_state=active&include[]=term");
    return list?.filter(c => c.name).map(c => ({ id: c.id, name: c.name, term: c.term?.name })) ?? null;
  }

  const list = (heading, lines) => lines.length
    ? [el("div", { style: "font-weight:600;margin-top:8px", textContent: heading }),
       el("ul", { style: "margin:2px 0;padding-left:18px;font-size:13px" }, ...lines.map(t => el("li", { textContent: t })))]
    : [];
  const fmtDay = iso => new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  // <root>/manifest.json: every file this extension saved under root, so tools (canvas-process) can verify the folder.
  // files: size/updated_at as Canvas reported them; text: SHA-1 of the UTF-8 content.
  async function writeManifest(root) {
    const all = await chrome.storage.local.get(null), files = {}, me = `${root}/manifest.json`;
    for (const [path, rec] of Object.entries(all).sort()) {
      if (!path.startsWith(root + "/") || path === me) continue;
      const rel = path.slice(root.length + 1);
      if (rec.meta?.canvas_id) files[rel] = { kind: "file", ...rec.meta };
      else if (/^[0-9a-f]{40}$/.test(rec.key)) files[rel] = { kind: "text", sha1: rec.key }; // older records without meta: skip
    }
    const text = JSON.stringify({ canvas: location.origin, files }, null, 1) + "\n";
    await chrome.runtime.sendMessage({ path: me, text, key: await hash(text) });
  }

  // Ask canvas-host (installed with `canvas-process --install-browser-link`) for text versions + transcripts.
  function makeText(box, root) {
    const line = el("div", { style: "font-size:12px;margin-top:8px", textContent: "Text versions: starting…" });
    box.insertBefore(line, box.querySelector("button"));
    const port = chrome.runtime.connect({ name: "process" });
    port.onMessage.addListener(m => {
      if (m.progress) line.textContent = "Text versions: " + m.progress.replace(/^(text|transcript) /, "").split("/").pop();
      else if (m.done) {
        const d = m.done, parts = [d.converted && `${d.converted} converted`, d.copied && `${d.copied} copied`,
          d.transcripts && `${d.transcripts} new transcript(s)`, d.failed.length && `${d.failed.length} failed`].filter(Boolean);
        line.textContent = `Text versions ✓ ${parts.join(", ") || "nothing new"}`;
        port.disconnect();
      } else if (m.error) {
        line.textContent = /not found|No such native application|not installed/i.test(m.error)
          ? "Text versions: not set up (optional, see ? in the extension)" : `Text versions failed: ${m.error}`;
        port.disconnect();
      }
    });
    port.postMessage({ root });
  }

  let running = false;
  async function run(ids) {
    if (running) return;
    running = true;
    const { maxMB = 200, folder = "Canvas", autoText = true } = await getCfg();
    const root = folder.split(/[\\/]+/).filter(p => p.replace(/\./g, "").trim()).map(safe).join("/") || "Canvas";
    let stop = false, saved = 0, failed = 0;
    const fresh = [], due = [], skipped = [];
    const box = panel(), title = el("div", { style: "font-weight:600" }), detail = el("div", { style: "opacity:.8;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" });
    const bar = el("progress", { style: "width:100%;height:10px;margin:8px 0 4px" });
    box.append(title, bar, detail, btn("Stop", () => { stop = true; }));
    const send = async job => {
      const r = await chrome.runtime.sendMessage(job);
      if (r?.error) { failed++; skipped.push({ name: job.path.split("/").pop(), why: `download failed: ${r.error}` }); }
      else if (!r?.skipped) saved++;
      return r && !r.error && !r.skipped;
    };
    try {
      title.textContent = "Checking saved files…";
      const check = await chrome.runtime.sendMessage({ verify: root });
      if (check?.missing?.length) console.info("Canvas saver: missing, will re-download:", check.missing);
      for (const [i, id] of ids.entries()) {
        const c = await api(`courses/${id}?include[]=syllabus_body`);
        if (!c?.name || stop) continue;
        title.textContent = (ids.length > 1 ? `Course ${i + 1} of ${ids.length}: ` : "") + c.name;
        detail.textContent = "Scanning…";
        bar.removeAttribute("value"); // indeterminate while scanning
        const scan = await scanCourse(c, maxMB * 1e6);
        due.push(...scan.due);
        const skipFrom = skipped.length;
        skipped.push(...scan.skipped);
        bar.max = scan.jobs.length;
        const dir = `${root}/${scan.T}`, changed = [];
        for (const [n, job] of scan.jobs.entries()) {
          if (stop) break;
          bar.value = n;
          detail.textContent = job.path.split("/").pop();
          const full = `${root}/${job.path}`; // restored files aren't "new"
          if ((await send({ ...job, path: full })) && job.label && !check?.missing?.includes(full)) changed.push(job.label);
        }
        // CHANGES.md: dated log of what each update brought in (kept in storage, file rewritten whole)
        const logKey = "log:" + dir, { [logKey]: log = [] } = await chrome.storage.local.get(logKey);
        if (changed.length) {
          log.unshift({ date: today(), items: log.length ? changed : [`First download: ${changed.length} items`] });
          await chrome.storage.local.set({ [logKey]: log.slice(0, 100) });
          if (log.length > 1) fresh.push(...changed.map(t => `${t} · ${c.course_code || c.name}`));
        }
        const md = `# What's new: ${c.name}\n\n` + log.map(e => `## ${e.date}\n\n${e.items.map(t => `- ${t}`).join("\n")}`).join("\n\n") + "\n";
        await send({ path: dir + "CHANGES.md", text: md, key: await hash(md) });
        const mine = skipped.slice(skipFrom), skipMd = `# Not downloaded: ${c.name}\n\nAs of ${today()}. These are still available on Canvas.\n\n`
          + (mine.map(x => `- ${x.name}: ${x.why}`).join("\n") || "Nothing skipped.") + "\n";
        await send({ path: dir + "SKIPPED.md", text: skipMd, key: await hash(skipMd) });
        for (const x of mine) x.name += ` · ${c.course_code || c.name}`;
      }
      await writeManifest(root);
      if (!stop) await setCfg({ lastRun: today(), lastRunAt: new Date().toISOString() });
      chrome.runtime.sendMessage({ badge: "" });
      due.sort((a, b) => a.due.localeCompare(b.due));
      box.replaceChildren(
        el("div", { style: "font-weight:600", textContent: stop ? "Stopped" : "Done ✓" }),
        el("div", { textContent: `${saved} new or updated item(s)` + (failed ? `, ${failed} failed` : "") }),
        ...(check?.missing?.length ? [el("div", { textContent: `Restored ${check.missing.length} file(s) that had been deleted or moved` })] : []),
        ...list("What's new", fresh.length > 8 ? [...fresh.slice(0, 8), `…and ${fresh.length - 8} more (see CHANGES.md)`] : fresh),
        ...list("Due in the next 7 days", due.map(a => `${a.done ? "✓ " : ""}${fmtDay(a.due)} · ${a.name} · ${a.course}`)),
        ...list(`Not downloaded (${skipped.length}), see SKIPPED.md`, skipped.slice(0, 6).map(x => `${x.name}: ${x.why}`)),
        el("div", { style: "opacity:.8;font-size:12px;margin-top:8px", textContent: `Saved to Downloads/${root}` }),
        btn("Open folder", () => chrome.runtime.sendMessage({ openFolder: true }), true),
        btn("Close", () => box.remove()));
      if (autoText && !stop) makeText(box, root);
    } catch (e) {
      box.replaceChildren(el("div", { textContent: `Error: ${e.message}\n(Are you logged in to Canvas?)`, style: "white-space:pre-wrap" }),
        btn("Close", () => box.remove()));
      console.error(e);
    } finally {
      running = false;
    }
  }

  // Once a day, on first Canvas visit, offer to refresh the courses picked last time.
  // Canvas's activity stream gives a rough "N new things" count (announcements, discussions, grades; not file edits).
  async function dailyCheck() {
    const cfg = await getCfg();
    if (window.top !== window || !cfg.ids?.length || cfg.lastRun === today() || cfg.asked === today()) return;
    const since = Date.parse(cfg.lastRunAt || 0), ids = new Set(cfg.ids);
    const news = ((await api("users/self/activity_stream", true)) ?? [])
      .filter(a => ids.has(a.course_id) && Date.parse(a.updated_at) > since);
    if (news.length) chrome.runtime.sendMessage({ badge: String(news.length) });
    if (running) return; // an update already started from the popup; don't cover its progress panel
    await setCfg({ asked: today() });
    const box = panel();
    box.append(el("div", { style: "font-weight:600", textContent: "Update your Canvas downloads?" }),
      el("div", { style: "opacity:.8;font-size:12px", textContent:
        `${news.length ? `${news.length} new thing(s) on Canvas · ` : ""}${cfg.ids.length} course(s), last updated ${cfg.lastRun || "never"}` }),
      ...list("New", news.slice(0, 5).map(a => a.title)),
      btn("Update", () => run(cfg.ids), true), btn("Not today", () => box.remove()));
  }

  window.__canvasSaver = { courses, run };
  dailyCheck();
})();
