"""Mirror Canvas courses into a navigable Markdown tree, with YouTube transcripts.

    out/
      README.md                       index of courses
      <Course>/
        README.md                     course home: syllabus, modules, assignments, announcements
        syllabus.md
        modules/01 <Module>.md        items in Canvas order, linked to local copies
        pages/ assignments/ announcements/
        files/<Canvas folder tree>    original files
        transcripts/<title> [id].md   every YouTube video linked or embedded anywhere

Canvas links inside pages are rewritten to the local copies; YouTube links get a
"(transcript)" link next to them. Re-run any time: unchanged files are skipped,
new/changed content is pulled. Stale (deleted on Canvas) content is left in place.

env:   CANVAS_URL=https://<school>.instructure.com  CANVAS_TOKEN=<token>
usage: canvas-scrape [-o OUT] [COURSE_ID ...]       # no ids = all active courses
"""
import argparse
import contextlib
import hashlib
import html
import json
import os
import re
import shutil
import sys
from pathlib import Path
from urllib.parse import quote, unquote

os.environ.setdefault("TQDM_DISABLE", "1")  # pptx2md progress bars
import pptx2md  # noqa: E402
try:  # layout analysis (headers/footers, tables, columns); must be imported before pymupdf4llm
    import pymupdf.layout  # noqa: F401
except ImportError:
    pass
import pymupdf4llm  # noqa: E402
import yt_dlp
from canvasapi import Canvas
from canvasapi.exceptions import CanvasException, Forbidden, InvalidAccessToken, ResourceDoesNotExist, Unauthorized
from markdownify import markdownify

DENIED = (Forbidden, Unauthorized, ResourceDoesNotExist)
YT = re.compile(r"(?:youtube(?:-nocookie)?\.com/(?:watch\?(?:\S*?&)?v=|embed/|shorts/|live/)|youtu\.be/)([\w-]{11})")
IFRAME = re.compile(r"<iframe[^>]*?\bsrc=\"([^\"]+)\"[^>]*>.*?</iframe>", re.S | re.I)
MD_LINK = re.compile(r"(!?)\[([^\]]*)\]\(([^)\s]+)[^)]*\)")
CANVAS_LINK = re.compile(r"(?:https?://[^/]+)?/courses/\d+/(files|pages|assignments)/([\w-]+)")


def safe(name):
    return re.sub(r'[\\/:*?"<>|#^\[\]]+', "_", name or "").strip(" .") or "untitled"


def rel(target, here):
    return quote(os.path.relpath(target, here.parent))


def write(path, text):
    # only touch changed files so mtimes / git diffs show real updates
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_text() != text:
        path.write_text(text)


def save_file(f, dest):
    ts = f.updated_at_date.timestamp()
    if dest.exists() and dest.stat().st_size == f.size and int(dest.stat().st_mtime) == int(ts):
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print("  file", dest)
    f.download(str(dest))
    os.utime(dest, (ts, ts))


def vtt_to_text(vtt):
    # auto-captions repeat each line as it scrolls; drop consecutive repeats
    out = []
    for line in vtt.splitlines():
        line = html.unescape(re.sub(r"<[^>]+>", "", line)).strip()
        if (line and "-->" not in line and not line.isdigit()
                and not line.startswith(("WEBVTT", "Kind:", "Language:", "NOTE"))
                and (not out or out[-1] != line)):
            out.append(line)
    return " ".join(out)


def video_targets(videos_md):
    """videos.md (written by the extension) -> {youtube id: transcript file name}. The extension names files
    after video titles; lines without a transcript link (older versions) fall back to <id>.md."""
    out = {}
    for line in videos_md.read_text().splitlines():
        if y := YT.search(line):
            link = re.search(r"\]\(transcripts/([^)\s]+)\)", line)
            out[y[1]] = unquote(link[1]) if link else f"{y[1]}.md"
    return out


def transcripts(ids, out, verbose=False, log=print, names=None):
    """Fetch English captions for each video id -> {id: md path}, saved as out/<names[id]> (default <id>.md),
    title inside. Videos without captions are retried next run."""
    out.mkdir(parents=True, exist_ok=True)
    target = {v: out / (names or {}).get(v, f"{v}.md") for v in ids}
    for p in out.glob("*.md"):  # earlier names: "<id>.md", "<title> [<id>].md"
        m = re.fullmatch(r"(?:.* \[)?([\w-]{11})\]?\.md", p.name)
        if m and m[1] in target and p != target[m[1]] and not target[m[1]].exists():
            p.rename(target[m[1]])
    have = {v: t for v, t in target.items() if t.exists()}
    opts = {"skip_download": True, "writesubtitles": True, "writeautomaticsub": True, "subtitleslangs": ["en.*"],
            "subtitlesformat": "vtt", "noprogress": True, "ignoreerrors": True, "outtmpl": str(out / "%(id)s.%(ext)s"),
            "quiet": not verbose, "no_warnings": not verbose}
    with yt_dlp.YoutubeDL(opts) if ids - have.keys() else contextlib.nullcontext() as ydl:
        for vid in sorted(ids - have.keys()):
            log(f"  transcript {target[vid].stem}")
            info = ydl.extract_info(f"https://youtu.be/{vid}")
            vtts = sorted(out.glob(f"{vid}.*.vtt"))
            if not info:
                log("    failed: video unavailable or YouTube refused (details: canvas-process --verbose)")
            elif not vtts:
                log("    no English captions on this video")
            else:
                have[vid] = target[vid]
                write(have[vid], f"# {info['title']}\n\nVideo: <https://youtu.be/{vid}>\n\n{vtt_to_text(vtts[0].read_text())}\n")
            for v in vtts:
                v.unlink()
    if have:
        titles = {p: p.read_text().split("\n", 1)[0].removeprefix("# ") for p in have.values()}
        write(out / "README.md", "# Transcripts\n\n" + "\n".join(
            f"- [{t}]({quote(p.name)})" for p, t in sorted(titles.items(), key=lambda x: x[1].lower())) + "\n")
    return have


def to_md(body, here, resolve, yts):
    """Canvas HTML -> markdown; Canvas links -> local relative paths; YouTube links get a transcript link."""
    body = IFRAME.sub(lambda m: f'<p><a href="{m[1]}">Embedded video</a></p>', body or "")
    md = markdownify(body, heading_style="ATX")

    def link(m):
        bang, text, url = m.groups()
        if (y := YT.search(url)) and y[1] in yts:
            return f"{m[0]} ([transcript]({rel(yts[y[1]], here)}))"
        if (c := CANVAS_LINK.match(url)) and (target := resolve(*c.groups())):
            return f"{bang}[{text}]({rel(target, here)})"
        return m[0]

    return re.sub(r"\n{3,}", "\n\n", MD_LINK.sub(link, md)).strip()


def scrape(course, root):
    files, pages, assignments, blobs = {}, {}, {}, []  # canvas id -> local path; blobs = text mined for videos

    try:
        folders = {f.id: f.full_name.removeprefix("course files").strip("/") for f in course.get_folders()}
    except DENIED:
        folders = {}

    def get_file(fid, f=None):
        if fid not in files:
            files[fid] = None
            try:
                f = f or course.get_file(fid)
                files[fid] = root / "files" / folders.get(f.folder_id, "") / safe(f.display_name)
                save_file(f, files[fid])
            except DENIED:
                files[fid] = None
        return files[fid]

    def resolve(kind, key):
        if kind == "files":
            return get_file(int(key)) if key.isdigit() else None
        return (pages if kind == "pages" else assignments).get(key, (None,))[0]

    # --- collect
    try:
        for f in course.get_files():
            get_file(f.id, f)
    except DENIED:
        print("  files tab locked, pulling files linked from modules/pages only")

    def add_page(p):
        pages[p.url] = (root / "pages" / f"{safe(p.title)}.md", p)
        blobs.append(getattr(p, "body", "") or "")

    try:
        for p in course.get_pages(include=["body"]):
            add_page(p)
    except DENIED:
        pass
    try:
        for a in course.get_assignments():
            assignments[str(a.id)] = (root / "assignments" / f"{safe(a.name)}.md", a)
            blobs.append(a.description or "")
    except DENIED:
        pass
    try:
        news = list(course.get_discussion_topics(only_announcements=True))
    except DENIED:
        news = []
    blobs += [n.message or "" for n in news]
    syllabus = getattr(course, "syllabus_body", None)
    blobs.append(syllabus or "")

    modules = []
    for m in course.get_modules():
        items = list(m.get_module_items())
        modules.append((m, items))
        for it in items:
            if it.type == "Page" and it.page_url not in pages:
                try:
                    add_page(course.get_page(it.page_url))
                except DENIED:
                    pass
            blobs.append(getattr(it, "external_url", ""))

    yts = transcripts(set(YT.findall("\n".join(blobs))), root / "transcripts")

    # --- render
    home = root / "README.md"
    index = [f"# {course.name}\n", f"[Open in Canvas]({course.canvas_url})\n"]
    if syllabus:
        write(root / "syllabus.md", f"# Syllabus\n\n{to_md(syllabus, root / 'syllabus.md', resolve, yts)}\n")
        index.append("- [Syllabus](syllabus.md)")

    index.append("\n## Modules\n")
    for i, (m, items) in enumerate(modules, 1):
        path = root / "modules" / f"{i:02d} {safe(m.name)}.md"
        lines = [f"# {m.name}\n"]
        for it in items:
            pad = "  " * getattr(it, "indent", 0)
            target = (get_file(it.content_id) if it.type == "File"
                      else pages.get(getattr(it, "page_url", None), (None,))[0] if it.type == "Page"
                      else assignments.get(str(getattr(it, "content_id", "")), (None,))[0] if it.type == "Assignment"
                      else None)
            if it.type == "SubHeader":
                lines.append(f"\n**{it.title}**\n")
            elif target:
                lines.append(f"{pad}- [{it.title}]({rel(target, path)})")
            else:
                url = getattr(it, "external_url", None) or getattr(it, "html_url", "")
                y = YT.search(url)
                extra = f" ([transcript]({rel(yts[y[1]], path)}))" if y and y[1] in yts else f" _({it.type})_"
                lines.append(f"{pad}- [{it.title}]({url}){extra}")
        write(path, "\n".join(lines) + "\n")
        index.append(f"- [{m.name}]({rel(path, home)})")

    for path, p in pages.values():
        write(path, f"# {p.title}\n\n{to_md(getattr(p, 'body', ''), path, resolve, yts)}\n")

    if assignments:
        index.append("\n## Assignments\n")
    for path, a in sorted(assignments.values(), key=lambda x: x[1].due_at or "~"):
        due = (a.due_at or "no due date")[:10]
        write(path, f"# {a.name}\n\nDue: {due} · Points: {a.points_possible} · [Canvas]({a.html_url})\n\n"
                    f"{to_md(a.description, path, resolve, yts)}\n")
        index.append(f"- {due} [{a.name}]({rel(path, home)})")

    if news:
        index.append("\n## Announcements\n")
    for n in news:
        date = (n.posted_at or "")[:10]
        path = root / "announcements" / f"{date} {safe(n.title)}.md"
        write(path, f"# {n.title}\n\n{date}\n\n{to_md(n.message, path, resolve, yts)}\n")
        index.append(f"- {date} [{n.title}]({rel(path, home)})")

    index.append("\n## Other\n\n- [All files](files/)\n- [Transcripts](transcripts/)")
    write(home, "\n".join(index) + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("course_ids", nargs="*", type=int)
    ap.add_argument("-o", "--out", default="canvas_dump", type=Path)
    a = ap.parse_args()

    url, token = os.environ.get("CANVAS_URL", "").rstrip("/"), os.environ.get("CANVAS_TOKEN")
    if not url or not token:
        sys.exit("error: CANVAS_URL and CANVAS_TOKEN must be set.\n"
                 "  token: Canvas → Account → Settings → + New Access Token\n"
                 "  export CANVAS_URL=https://<school>.instructure.com CANVAS_TOKEN=<token>")
    canvas = Canvas(url, token)
    try:
        canvas.get_current_user()
    except InvalidAccessToken:
        sys.exit("error: Canvas rejected CANVAS_TOKEN (expired, revoked, or wrong CANVAS_URL)")
    except (CanvasException, OSError) as e:
        sys.exit(f"error: can't reach Canvas at {url}: {e}")

    courses = ([canvas.get_course(i, include=["syllabus_body"]) for i in a.course_ids]
               or canvas.get_courses(enrollment_state="active", include=["syllabus_body"]))
    for c in courses:
        if not hasattr(c, "name"):  # access-restricted stubs
            continue
        print(c.name)
        c.canvas_url = f"{url}/courses/{c.id}"
        scrape(c, a.out / safe(c.name))
    # index every course ever scraped into OUT, not just this run's
    write(a.out / "README.md", "# Courses\n\n" + "\n".join(
        f"- [{d.name}]({quote(d.name)}/README.md)" for d in sorted(a.out.iterdir()) if (d / "README.md").exists()) + "\n")


def to_text(src, dest):
    """PDF/PPTX -> markdown file. pymupdf4llm: text-layer PDFs only (scans come out near-empty; docproc --marker for those)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if src.suffix.lower() == ".pdf":
        write(dest, pymupdf4llm.to_markdown(str(src)))
    else:  # ponytail: slide images skipped, add image_dir if the md is read by people not LLMs
        pptx2md.convert(pptx2md.ConversionConfig(pptx_path=src, output_path=dest, image_dir=dest.parent, disable_image=True))


def verify_manifest(root):
    """Check root/manifest.json (written by the extension) against the files on disk -> list of problems."""
    try:
        files = json.loads((root / "manifest.json").read_text())["files"]
    except FileNotFoundError:
        return []
    problems = []
    for rel, info in files.items():
        p = root / rel
        if not p.is_file():
            problems.append(f"missing: {rel}")
        elif info["kind"] == "file" and p.stat().st_size != info["size"]:
            problems.append(f"size differs from Canvas ({p.stat().st_size} != {info['size']}): {rel}")
        elif info["kind"] == "text" and hashlib.sha1(p.read_bytes()).hexdigest() != info["sha1"]:
            problems.append(f"edited locally: {rel}")
    return problems


# keep in sync with CONVERT / PLAIN in extension/content.js
CONVERT = {".pdf", ".pptx"}
PLAIN = {".txt", ".md", ".csv", ".tsv", ".json", ".tex", ".html", ".htm", ".css", ".js", ".py", ".r", ".java", ".c", ".cpp", ".h"}


def process(root, verbose=False, log=print):
    """Fill root/Plaintext from root/Source and fetch transcripts; see process_main. Returns a summary dict."""
    if not (root / "Source").is_dir():
        raise FileNotFoundError(f"no Source/ folder in {root}; point this at the extension's save folder (e.g. ~/Downloads/Canvas)")
    done = {"converted": 0, "copied": 0, "failed": [], "transcripts": 0, "problems": verify_manifest(root)}
    if done["problems"]:
        log(f"manifest: {len(done['problems'])} problem(s). Missing files come back on the next extension Update;"
            " edited files are kept (delete one to get Canvas's version back):")
        for p in done["problems"][:20]:
            log(f"   {p}")
    for src in sorted((root / "Source").rglob("*")):
        ext, parts = src.suffix.lower(), src.relative_to(root / "Source").parts
        if not src.is_file() or ext not in CONVERT | PLAIN or len(parts) < 2:
            continue
        dest = root / "Plaintext" / parts[0] / "files" / Path(*parts[1:])
        if ext in CONVERT:
            dest = dest.with_name(dest.name + ".md")
        if dest.exists() and dest.stat().st_mtime >= src.stat().st_mtime:
            continue
        log(f"  text {src.relative_to(root)}")
        try:
            if ext in CONVERT:
                to_text(src, dest)
                done["converted"] += 1
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
                done["copied"] += 1
        except Exception as e:  # one broken file shouldn't stop the rest
            log(f"    failed: {e}")
            done["failed"].append(src.name)
    for videos in (root / "Plaintext").rglob("videos.md"):
        log(videos.parent.name)
        out = videos.parent / "transcripts"
        names = video_targets(videos)
        before = sum((out / n).exists() for n in names.values())
        done["transcripts"] += len(transcripts(set(names), out, verbose, log, names)) - before
    return done


def process_main():
    """canvas-process DIR: fill DIR/Plaintext from DIR/Source (the extension's save folder).

    Source/<Course>/x.pdf|pptx -> Plaintext/<Course>/files/x.pdf.md   (converted)
    Source/<Course>/x.txt|csv|.. -> Plaintext/<Course>/files/x.txt     (copied; tiny, and copies survive
                                                                         Drive sync + drag-and-drop, symlinks don't)
    Plaintext/<Course>/videos.md -> Plaintext/<Course>/transcripts/
    """
    from canvas_scrape import host

    ap = argparse.ArgumentParser(description=process_main.__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dir", type=Path, nargs="?", default=Path.home() / "Downloads" / "Canvas",
                    help="the extension's save folder (default: ~/Downloads/Canvas)")
    ap.add_argument("--check", action="store_true", help="test conversions, YouTube and the folder; print what's broken")
    ap.add_argument("--install-browser-link", action="store_true",
                    help="let the browser extension run this automatically after each download")
    ap.add_argument("-v", "--verbose", action="store_true", help="show yt-dlp's own warnings and errors")
    a = ap.parse_args()
    root = a.dir.expanduser()
    if a.install_browser_link:
        sys.exit(host.install())
    if a.check:
        sys.exit(check(root))
    try:
        process(root, a.verbose)
    except FileNotFoundError as e:
        sys.exit(f"error: {e}")


TEST_VIDEO = "dQw4w9WgXcQ"  # long-lived, has manual English captions


def check(root):
    """canvas-process --check: run each step on this computer and say what's broken. Returns exit code."""
    import platform
    import subprocess
    import tempfile
    from importlib.metadata import version

    failed = 0

    def step(name, fn):
        nonlocal failed
        try:
            detail = fn()
            print(f"  ✓ {name}" + (f": {detail}" if detail else ""))
        except Exception as e:
            failed += 1
            print(f"  ✗ {name}: {e}")

    def note(text):
        print(f"  ! {text}")

    print("Tools")
    step("installed", lambda: f"Python {platform.python_version()}, yt-dlp {version('yt-dlp')}, "
                              f"pptx2md {version('pptx2md')}, pymupdf4llm {version('pymupdf4llm')}, "
                              f"PDF layout mode {'on' if 'pymupdf.layout' in sys.modules else 'off'}")
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)

        def pptx():
            from pptx import Presentation
            prs = Presentation()
            prs.slides.add_slide(prs.slide_layouts[1]).shapes.title.text = "Check slide"
            prs.save(tmp / "t.pptx")
            to_text(tmp / "t.pptx", tmp / "t.pptx.md")
            assert "Check slide" in (tmp / "t.pptx.md").read_text(), "slide text missing from the output"

        def pdf():
            import pymupdf
            doc = pymupdf.open()
            doc.new_page().insert_text((72, 72), "Check page")
            doc.save(tmp / "t.pdf")
            to_text(tmp / "t.pdf", tmp / "t.pdf.md")
            assert "Check page" in (tmp / "t.pdf.md").read_text(), "page text missing from the output"

        def youtube():
            have = transcripts({TEST_VIDEO}, tmp / "tr")
            if TEST_VIDEO not in have:
                raise RuntimeError("no transcript. YouTube changes often: run `uv tool upgrade canvas-scrape`, "
                                   "then `canvas-process --check --verbose` for yt-dlp's error")
            return f"{len(have[TEST_VIDEO].read_text().split())} words"

        step("PowerPoint -> Markdown", pptx)
        step("PDF -> Markdown", pdf)
        step("YouTube transcript", youtube)

    print(f"Folder {root}")
    if not (root / "Source").is_dir():
        failed += 1
        print("  ✗ no Source/ folder: download a course with the extension first, or pass the right folder")
    else:
        step("courses", lambda: ", ".join(sorted(p.name for p in (root / "Plaintext").iterdir() if p.is_dir())) or "none yet")
        problems = verify_manifest(root)
        (note if problems else lambda t: print(f"  ✓ {t}"))(
            f"manifest: {len(problems)} problem(s), run canvas-process to list them" if problems else "manifest matches the files")
        todo = [s for s in (root / "Source").rglob("*") if s.suffix.lower() in CONVERT and s.is_file()
                and not (root / "Plaintext" / s.relative_to(root / "Source").parts[0] / "files"
                         / Path(*s.relative_to(root / "Source").parts[1:])).with_name(s.name + ".md").exists()]
        (note if todo else lambda t: print(f"  ✓ {t}"))(
            f"{len(todo)} PDF/PPTX not converted yet, run canvas-process" if todo else "every PDF/PPTX has a text version")
        for videos in (root / "Plaintext").rglob("videos.md"):
            names = video_targets(videos)
            ids = set(names)
            done = {i for i in ids if (videos.parent / "transcripts" / names[i]).exists()}
            (note if done != ids else lambda t: print(f"  ✓ {t}"))(
                f"{videos.parent.name}: {len(done)}/{len(ids)} transcripts" + (", run canvas-process" if done != ids else ""))

    print("Browser link (runs this automatically after each download)")
    from canvas_scrape import host
    links = host.installed()
    if links:
        print("  ✓ installed for: " + ", ".join(str(f.parents[1].name) for f in links))
    else:
        note("not installed; optional: canvas-process --install-browser-link")

    print("Schedule")
    try:
        cron = subprocess.run(["crontab", "-l"], capture_output=True, text=True).stdout
        if "canvas-process" in cron:
            print("  ✓ hourly cron job installed (if nothing ever updates, give /usr/sbin/cron Full Disk Access)")
        else:
            note("not scheduled; optional if the browser link is installed, see README")
    except FileNotFoundError:
        note("no crontab on this system; use Task Scheduler (see README)")

    print("All good." if not failed else f"{failed} problem(s) above.")
    return 1 if failed else 0
