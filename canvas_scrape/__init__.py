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
import html
import os
import re
import sys
from pathlib import Path
from urllib.parse import quote

import pptx2md
import pymupdf4llm
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


def transcripts(ids, out):
    """Fetch English captions for each video id -> {id: md path}. Missing captions retry next run."""
    out.mkdir(parents=True, exist_ok=True)
    have = {m[1]: p for p in out.glob("*.md") if (m := re.search(r"\[([\w-]{11})\]\.md$", p.name))}
    opts = {"skip_download": True, "writesubtitles": True, "writeautomaticsub": True,
            "subtitleslangs": ["en.*"], "subtitlesformat": "vtt", "quiet": True, "noprogress": True, "no_warnings": True,
            "ignoreerrors": True, "outtmpl": str(out / "%(id)s.%(ext)s")}
    with yt_dlp.YoutubeDL(opts) as ydl:
        for vid in sorted(ids - have.keys()):
            print("  transcript", vid)
            info = ydl.extract_info(f"https://youtu.be/{vid}")
            vtts = sorted(out.glob(f"{vid}.*.vtt"))
            if info and vtts:
                p = out / f"{safe(info['title'])} [{vid}].md"
                write(p, f"# {info['title']}\n\nVideo: <https://youtu.be/{vid}>\n\n{vtt_to_text(vtts[0].read_text())}\n")
                have[vid] = p
            for v in vtts:
                v.unlink()
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
    if src.suffix.lower() == ".pdf":
        write(dest, pymupdf4llm.to_markdown(str(src)))
    else:  # ponytail: slide images skipped, add image_dir if the md is read by people not LLMs
        pptx2md.convert(pptx2md.ConversionConfig(pptx_path=src, output_path=dest, image_dir=dest.parent, disable_image=True))


def process_main():
    """canvas-process DIR: add <file>.md text next to every PDF/PPTX, and transcripts for every videos.md, under DIR."""
    ap = argparse.ArgumentParser(description=process_main.__doc__)
    ap.add_argument("dir", type=Path)
    root = ap.parse_args().dir
    for src in sorted(root.rglob("*")):
        dest = src.with_name(src.name + ".md")
        if src.suffix.lower() not in (".pdf", ".pptx") or (dest.exists() and dest.stat().st_mtime >= src.stat().st_mtime):
            continue
        print("  text", src.relative_to(root))
        try:
            to_text(src, dest)
        except Exception as e:  # one broken file shouldn't stop the rest
            print("    failed:", e)
    for videos in root.rglob("videos.md"):
        out = videos.parent / "transcripts"
        have = transcripts(set(YT.findall(videos.read_text())), out)
        if have:
            write(out / "README.md", "# Transcripts\n\n" + "\n".join(
                f"- [{p.stem}]({quote(p.name)})" for p in sorted(have.values(), key=lambda p: p.name)) + "\n")
