// Runs inside a logged-in Canvas tab. Mirrors the course into Downloads/Canvas/<Course>/ as linked Markdown,
// same layout as the Python canvas-scrape. Re-run any time: unchanged files are skipped.
(async () => {
  if (window.__canvasSaverRunning) return;
  window.__canvasSaverRunning = true;

  const ROOT = "Canvas";
  const YT = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:\S*?&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/g;
  const CANVAS = /^(?:https?:\/\/[^/]+)?\/courses\/\d+\/(files|pages|assignments)\/([\w-]+)/;
  const MD_LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;

  const box = document.createElement("div");
  Object.assign(box.style, { position: "fixed", bottom: "16px", right: "16px", zIndex: 99999, background: "#1f2937",
    color: "#fff", padding: "12px 16px", borderRadius: "8px", font: "14px system-ui", maxWidth: "380px", whiteSpace: "pre-wrap" });
  document.body.append(box);
  const say = t => (box.textContent = t);

  const safe = s => (s || "").replace(/[\\/:*?"<>|#^\[\]~\x00-\x1f]+/g, "_").replace(/^[\s.]+|[\s.]+$/g, "").slice(0, 120) || "untitled";
  const rel = (target, here) => {
    const a = here.split("/").slice(0, -1), b = target.split("/");
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return [...Array(a.length - i).fill(".."), ...b.slice(i)].map(encodeURIComponent).join("/");
  };
  const hash = async t => [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(t)))]
    .map(b => b.toString(16).padStart(2, "0")).join("");

  // GET all pages of a Canvas API list; null when this user can't see it (hidden tab, locked, etc.)
  async function api(path) {
    let url = `/api/v1/${path}${path.includes("?") ? "&" : "?"}per_page=100`, out = [];
    while (url) {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) {
        if ([401, 403, 404].includes(r.status)) return null;
        throw new Error(`Canvas said ${r.status} for ${url}`);
      }
      const data = JSON.parse((await r.text()).replace(/^while\(1\);/, ""));
      if (!Array.isArray(data)) return data;
      out.push(...data);
      url = r.headers.get("Link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    }
    return out;
  }

  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  td.addRule("iframe", {
    filter: "iframe",
    replacement: (_, n) => {
      const y = [...(n.getAttribute("src") || "").matchAll(YT)][0];
      return `\n\n[Embedded video](${y ? `https://youtu.be/${y[1]}` : n.getAttribute("src")})\n\n`;
    },
  });

  async function scrapeCourse(c) {
    const base = `courses/${c.id}`, dir = `${ROOT}/${safe(c.name)}`;
    const files = new Map(), pages = new Map(), assignments = new Map(), blobs = [];
    let saved = 0;
    const put = async (path, url, key) => {
      const r = await chrome.runtime.sendMessage({ path: `${dir}/${path}`, url, key });
      if (r?.error) console.warn("Canvas saver:", path, r.error);
      else if (!r?.skipped) saved++;
    };
    const putText = async (path, text) =>
      put(path, "data:text/markdown;charset=utf-8," + encodeURIComponent(text), await hash(text));

    say(`${c.name}\nlisting…`);
    const folders = new Map((await api(`${base}/folders`) ?? []).map(f => [f.id, f.full_name.replace(/^course files\/?/, "")]));
    async function fileFor(fid, f) {
      if (!files.has(fid)) {
        files.set(fid, null);
        f ??= await api(`${base}/files/${fid}`);
        if (f?.url) { // url is empty for locked files
          const path = ["files", ...(folders.get(f.folder_id) ?? "").split("/").filter(Boolean).map(safe), safe(f.display_name)].join("/");
          files.set(fid, path);
          say(`${c.name}\nfile ${files.size}: ${f.display_name}`);
          await put(path, f.url, `${f.updated_at}|${f.size}`);
        }
      }
      return files.get(fid);
    }

    // --- collect
    for (const f of (await api(`${base}/files`)) ?? []) await fileFor(f.id, f);
    for (const p of (await api(`${base}/pages?include[]=body`)) ?? []) pages.set(p.url, p);
    for (const a of (await api(`${base}/assignments`)) ?? []) assignments.set(String(a.id), a);
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
      p.path = `pages/${safe(p.title)}.md`;
      blobs.push(p.body || "");
    }
    for (const a of assignments.values()) { a.path = `assignments/${safe(a.name)}.md`; blobs.push(a.description || ""); }
    blobs.push(c.syllabus_body || "", ...news.map(n => n.message || ""));
    // files linked from page text (works even when the Files tab is hidden)
    for (const [, id] of blobs.join("\n").matchAll(/\/courses\/\d+\/files\/(\d+)/g)) await fileFor(Number(id));

    // --- render
    const resolve = (kind, key) =>
      kind === "files" ? files.get(Number(key)) : (kind === "pages" ? pages : assignments).get(key)?.path;
    const toMd = (html, here) => td.turndown(html || "").replace(MD_LINK, (m, bang, text, url) => {
      const hit = url.match(CANVAS), target = hit && resolve(hit[1], hit[2]);
      return target ? `${bang}[${text}](${rel(target, here)})` : m;
    }).replace(/\n{3,}/g, "\n\n").trim();

    const home = "README.md";
    const index = [`# ${c.name}\n`, `[Open in Canvas](${location.origin}/courses/${c.id})\n`];
    if (c.syllabus_body) {
      await putText("syllabus.md", `# Syllabus\n\n${toMd(c.syllabus_body, "syllabus.md")}\n`);
      index.push("- [Syllabus](syllabus.md)");
    }

    index.push("\n## Modules\n");
    for (const [i, m] of modules.entries()) {
      const path = `modules/${String(i + 1).padStart(2, "0")} ${safe(m.name)}.md`, lines = [`# ${m.name}\n`];
      for (const it of m.items) {
        const pad = "  ".repeat(it.indent || 0);
        const target = it.type === "File" ? files.get(it.content_id)
          : it.type === "Page" ? pages.get(it.page_url)?.path
          : it.type === "Assignment" ? assignments.get(String(it.content_id))?.path : null;
        if (it.type === "SubHeader") lines.push(`\n**${it.title}**\n`);
        else if (target) lines.push(`${pad}- [${it.title}](${rel(target, path)})`);
        else lines.push(`${pad}- [${it.title}](${it.external_url || it.html_url}) _(${it.type})_`);
      }
      await putText(path, lines.join("\n") + "\n");
      index.push(`- [${m.name}](${rel(path, home)})`);
    }

    for (const p of pages.values()) await putText(p.path, `# ${p.title}\n\n${toMd(p.body, p.path)}\n`);

    const byDue = [...assignments.values()].sort((a, b) => (a.due_at || "~").localeCompare(b.due_at || "~"));
    if (byDue.length) index.push("\n## Assignments\n");
    for (const a of byDue) {
      const due = (a.due_at || "no due date").slice(0, 10);
      await putText(a.path, `# ${a.name}\n\nDue: ${due} · Points: ${a.points_possible ?? "-"} · [Canvas](${a.html_url})\n\n${toMd(a.description, a.path)}\n`);
      index.push(`- ${due} [${a.name}](${rel(a.path, home)})`);
    }

    if (news.length) index.push("\n## Announcements\n");
    for (const n of news) {
      const date = (n.posted_at || "").slice(0, 10), path = `announcements/${date} ${safe(n.title)}.md`;
      await putText(path, `# ${n.title}\n\n${date}\n\n${toMd(n.message, path)}\n`);
      index.push(`- ${date} [${n.title}](${rel(path, home)})`);
    }

    // transcripts: NotebookLM / Gemini read YouTube links directly, so just collect them in one place
    const vids = [...new Set([...blobs.join("\n").matchAll(YT)].map(m => m[1]))];
    if (vids.length) {
      await putText("videos.md", `# Videos\n\n${vids.map(v => `- https://youtu.be/${v}`).join("\n")}\n`);
      index.push(`\n## Videos\n\n- [${vids.length} YouTube videos](videos.md)`);
    }
    await putText(home, index.join("\n") + "\n");
    return saved;
  }

  try {
    const id = location.pathname.match(/^\/courses\/(\d+)/)?.[1];
    const courses = id ? [await api(`courses/${id}?include[]=syllabus_body`)]
      : (await api("courses?enrollment_state=active&include[]=syllabus_body")).filter(c => c.name);
    let total = 0;
    for (const c of courses) total += await scrapeCourse(c);
    say(`Done ✓  ${courses.length} course(s), ${total} new/updated item(s)\nSaved to Downloads/${ROOT}`);
  } catch (e) {
    say(`Error: ${e.message}\n(Are you logged in to Canvas in this tab?)`);
    console.error(e);
  } finally {
    window.__canvasSaverRunning = false;
    setTimeout(() => box.remove(), 15000);
  }
})();
