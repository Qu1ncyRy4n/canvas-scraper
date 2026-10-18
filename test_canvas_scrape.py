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
