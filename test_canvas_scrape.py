from pathlib import Path

from canvas_scrape import YT, to_md, vtt_to_text


def test_yt():
    s = ('<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0"> '
         'https://youtu.be/abcdefghijk https://www.youtube.com/watch?list=x&v=ZZZZZZZZZZZ')
    assert YT.findall(s) == ["dQw4w9WgXcQ", "abcdefghijk", "ZZZZZZZZZZZ"]


def test_vtt():
    vtt = ("WEBVTT\nKind: captions\nLanguage: en\n\n00:00.000 --> 00:01.000\nhello<00:00.5><c> world</c>\n\n"
           "00:01.000 --> 00:01.010\nhello world\n \n\n00:01.010 --> 00:02.000\nhello world\n10 things &amp; more\n")
    assert vtt_to_text(vtt) == "hello world 10 things & more"


def test_to_md_links():
    root = Path("/c")
    here = root / "pages" / "Week 1.md"
    local = {("files", "42"): root / "files" / "Slides 1.pdf", ("pages", "intro"): root / "pages" / "Intro.md"}
    html = ('<p><a href="https://u.instructure.com/courses/9/files/42/download?wrap=1">slides</a> '
            '<a href="/courses/9/pages/intro">intro</a> <a href="https://example.com">ext</a></p>'
            '<iframe width="560" src="https://www.youtube.com/embed/o-0iIXQ_XHA"></iframe>')
    md = to_md(html, here, lambda k, v: local.get((k, v)), {"o-0iIXQ_XHA": root / "transcripts" / "Myths [o-0iIXQ_XHA].md"})
    assert "[slides](../files/Slides%201.pdf)" in md
    assert "[intro](Intro.md)" in md
    assert "[ext](https://example.com)" in md
    assert "([transcript](../transcripts/Myths%20%5Bo-0iIXQ_XHA%5D.md))" in md


def test_host_protocol(tmp_path):
    import json, struct, subprocess, sys

    (tmp_path / "Source" / "ANTH 101").mkdir(parents=True)
    (tmp_path / "Source" / "ANTH 101" / "notes.txt").write_text("hello")

    def msg(m):
        data = json.dumps(m).encode()
        return struct.pack("<I", len(data)) + data

    stdin = msg({"cmd": "ping"}) + msg({"cmd": "process", "dir": "/nonexistent"}) + msg({"cmd": "process", "dir": str(tmp_path)})
    out = subprocess.run([sys.executable, "-c", "from canvas_scrape.host import host_main; host_main()"],
                         input=stdin, capture_output=True, timeout=60).stdout
    replies = []
    while out:
        n = struct.unpack("<I", out[:4])[0]
        replies.append(json.loads(out[4:4 + n]))
        out = out[4 + n:]
    assert replies[0]["ok"] and replies[0]["version"]
    assert "no Source/ folder" in replies[1]["error"]
    assert any("notes.txt" in r.get("progress", "") for r in replies[2:])
    assert replies[-1]["done"]["copied"] == 1
    assert (tmp_path / "Plaintext" / "ANTH 101" / "files" / "notes.txt").read_text() == "hello"


def test_video_targets_and_rename(tmp_path, monkeypatch):
    import canvas_scrape

    (tmp_path / "videos.md").write_text(
        "# Videos\n\n- [What are Myths](https://youtu.be/o-0iIXQ_XHA) · [transcript](transcripts/What%20are%20Myths.md)\n"
        "- https://youtu.be/abcdefghijk\n")
    names = canvas_scrape.video_targets(tmp_path / "videos.md")
    assert names == {"o-0iIXQ_XHA": "What are Myths.md", "abcdefghijk": "abcdefghijk.md"}

    out = tmp_path / "transcripts"
    out.mkdir()
    (out / "o-0iIXQ_XHA.md").write_text("# What are Myths\n\ntext\n")  # saved under the old id name
    monkeypatch.setattr(canvas_scrape.yt_dlp, "YoutubeDL", None)  # nothing left to fetch for this id
    have = canvas_scrape.transcripts({"o-0iIXQ_XHA"}, out, names=names)
    assert have == {"o-0iIXQ_XHA": out / "What are Myths.md"} and not (out / "o-0iIXQ_XHA.md").exists()
    assert "[What are Myths](What%20are%20Myths.md)" in (out / "README.md").read_text()
