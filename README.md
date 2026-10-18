# canvas-scraper

Save Canvas courses to your computer as linked Markdown plus the original files, ready to read offline or hand to an AI tool (NotebookLM, Claude, ChatGPT).

Three parts:

| Part | What it does | Needs |
|---|---|---|
| **Browser extension** (`extension/`) | Saves files, modules, pages, assignments, announcements and the syllabus from the Canvas tab you're logged into. | Chrome or Firefox. No Canvas access token. |
| **`canvas-process`** | Turns the saved PDFs and slides into Markdown, fetches YouTube transcripts, and checks the folder against `manifest.json`. | [uv](https://docs.astral.sh/uv/) |
| **`canvas-scrape`** (optional) | Same idea as the extension, as a command line tool using a Canvas API token. | A token, which many schools don't allow students to create. |

## Install the extension

**Chrome**
1. Download the repo as a zip (GitHub → Code → Download ZIP) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `extension` folder.
3. Pin the extension: puzzle-piece icon → pin **Canvas Course Saver**.
4. In Chrome settings → Downloads, turn off **Ask where to save each file**.

**Firefox** (temporary, removed when Firefox restarts)
1. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `extension/manifest.json`.
2. In Settings → Downloads, turn off **Always ask you where to save files**.

For a permanent Firefox install, sign it as unlisted: `npx web-ext sign -s extension --channel unlisted --api-key=… --api-secret=…` (keys from addons.mozilla.org → Developer Hub). Then drag the resulting `.xpi` into Firefox.

## Use it

1. Open Canvas and log in.
2. Click the extension icon. Tick the courses you want. Optionally set the size limit and the folder name.
3. Click **Download**. Keep the tab open until the panel in its corner says **Done**.

The **?** in the popup explains all of this too.

The done panel shows:
- what's new since the last run
- assignments due in the next 7 days (✓ if submitted)
- anything that wasn't downloaded, and why

**Updating.** Click **Download** again any time; only new or changed items are saved. Once a day, the first Canvas page you open asks **Update your Canvas downloads?** and the icon shows a count of new Canvas activity.

That daily prompt only works on `*.instructure.com`. If your school uses its own Canvas address, add it to `content_scripts.matches` in `extension/manifest.json`.

## What you get

```
Downloads/Canvas/                  (folder name is set in the popup)
  manifest.json                    every saved file, with size or SHA-1 for verification
  Plaintext/<Course>/              everything as text: drag this folder into an AI tool
    README.md                      start here: syllabus, modules, assignments, announcements, videos
    course.md                      all course text in one file
    CHANGES.md                     dated log of what each update brought in
    SKIPPED.md                     what wasn't downloaded and why (too big, locked, quiz, ...)
    syllabus.md
    modules/01 Week 1.md           items in Canvas order, linked to local copies
    pages/  assignments/  announcements/
    videos.md                      every YouTube link found in the course
    files/…/Slides.pdf.md          text of each PDF/PPTX           (made by canvas-process)
    transcripts/                   YouTube transcripts             (made by canvas-process)
  Source/<Course>/…                original files, in the same folders as Canvas's Files page
```

- **Links.** Links between pages, files and assignments point at the local copies. File links in module pages go to the text version, with an **(original)** link beside it.
- **Skipped items.** Anything not downloaded stays as a link to Canvas: files over the size limit, locked files, quizzes and discussions.
- **Text files.** Small text originals (`.txt`, `.csv`, code) are copied into `Plaintext/`, not symlinked. Copies survive Google Drive sync and drag-and-drop uploads; symlinks don't.

## Turn files into text: `canvas-process`

```bash
uv tool install git+https://github.com/Qu1ncyRy4n/canvas-scraper   # or: uv tool install ./canvas-scraper
canvas-process ~/Downloads/Canvas
```

Each run does three things:

1. **Checks `manifest.json` against the disk.** It reports files that are missing, a different size from Canvas's copy, or edited locally.
   - Missing files come back on the next extension update.
   - Edited files are left alone. Delete one to get Canvas's version back.
2. **Fills `Plaintext/<Course>/files/` from `Source/`.**
   - PDFs are converted with [pymupdf4llm](https://pypi.org/project/pymupdf4llm/). It only reads text that's already in the PDF, so scanned PDFs come out nearly empty; use an OCR tool for those.
   - PPTX files are converted with [pptx2md](https://github.com/ssine/pptx2md). Titles, lists, tables and speaker notes are kept; images aren't.
   - Text files are copied as they are.
   - A file is only converted again when the original is newer than its text version.
3. **Fetches YouTube transcripts** for every `videos.md`, using yt-dlp to get English captions (manual or auto-generated). Videos without captions are retried on the next run.

**Run it every hour (macOS).** Run `crontab -e` and add:

```
0 * * * * ~/.local/bin/canvas-process ~/Downloads/Canvas
```

macOS blocks background jobs from reading `~/Downloads`. Give `/usr/sbin/cron` **Full Disk Access** in System Settings → Privacy & Security. On Windows, create a Task Scheduler task that runs `canvas-process` with the folder as its argument.

## Using it with AI tools

- **NotebookLM.**
  - Upload `course.md` and the `files/*.md` texts.
  - Paste the links from `videos.md` as YouTube sources; NotebookLM fetches the transcripts itself.
- **Claude / ChatGPT.** Drag `Plaintext/<Course>` (or just `course.md`) into a project.
- **Keeping it synced online.** Install Google Drive for desktop. Then Preferences → My Computer → **Add folder** → `Downloads/Canvas`. To run `canvas-process` on another computer, share that folder and point `canvas-process` at the synced copy.

## `canvas-scrape` (with an API token)

If your school lets you create a token (Canvas → Account → Settings → **New Access Token**):

```bash
export CANVAS_URL=https://<school>.instructure.com CANVAS_TOKEN=<token>
canvas-scrape -o ~/canvas                 # all active courses
canvas-scrape -o ~/canvas 12345 67890     # specific course ids
```

It writes an older, flat layout: one folder per course, with files and Markdown side by side and transcripts included. It exits with an error if the token is missing or rejected.

## How it works

- **No token needed.** The extension runs in the logged-in Canvas tab and calls the same `/api/v1` endpoints Canvas's own pages use. It pages through results with the `Link` header.
- **Saving files.** Saves go through the browser's downloads API, so they can only land inside the download folder.
- **Change tracking.** Extension storage keeps one record per saved path: a version key, the download id and metadata.
  - The version key is Canvas's `updated_at` and size for files, and a SHA-1 hash of the text for Markdown.
  - Unchanged items are skipped.
  - Before each run, the extension asks the browser whether every recorded download still exists. Missing ones are downloaded again.
  - `manifest.json` is written from these records.
- **HTML to Markdown.** Turndown (vendored, `extension/turndown.js`, v7.2.0) does the conversion. Canvas file, page and assignment links are rewritten to relative local paths.

## Development

```
extension/          browser extension (Manifest V3; one folder works in Chrome and Firefox)
  manifest.json     permissions: activeTab, scripting, downloads, storage
  popup.html/.js    course picker, settings, ? help
  content.js        runs in the Canvas tab: scan, convert, progress panel, daily prompt, manifest
  background.js     saves downloads, skips unchanged files, verifies before each run
canvas_scrape/      Python package: canvas-scrape and canvas-process
test_canvas_scrape.py
```

- **Tests:** `uv run --with pytest pytest -q`
- **Lint the extension:** `npx web-ext lint -s extension`. One warning about `background.service_worker` is expected; Firefox ignores that key and uses `background.scripts`.
- **After editing the extension:** reload it (`chrome://extensions` or `about:debugging`), then refresh the Canvas tab.
- **File types:** which files get a text version is defined twice. Keep `CONVERT` / `PLAIN` in `content.js` and `canvas_scrape/__init__.py` in sync.

## Limitations

- **Not saved:** discussion threads and quizzes. They're listed in `SKIPPED.md` as online-only.
- **Deletions:** content deleted on Canvas stays in the local copy.
- **Word files:** `.docx` isn't converted to text yet.
- **Badge count:** it comes from Canvas's activity stream, so it counts announcements, discussions and grades, not file changes.
