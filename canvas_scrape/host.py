"""Browser link: lets the extension run canvas-process right after a download (native messaging).

The browser starts `canvas-host` itself, so on macOS it inherits the browser's access to Downloads:
no cron job and no Full Disk Access needed. Protocol: 4-byte little-endian length + UTF-8 JSON, both ways.

    extension -> {"cmd": "ping"}                 <- {"ok": true, "version": "..."}
    extension -> {"cmd": "process", "dir": ...}  <- {"progress": "..."} ... then {"done": {...}} or {"error": "..."}
"""
import json
import os
import struct
import sys
from importlib.metadata import version
from pathlib import Path

NAME = "com.canvas_saver.host"
CHROME_ID = "jknaldplfafkadaianplppapladkdfad"  # fixed by the "key" in extension/manifest.json
FIREFOX_ID = "canvas-course-saver@local"  # browser_specific_settings.gecko.id

# where each browser looks for host manifests (only browsers whose profile folder exists get one)
if sys.platform == "darwin":
    _base = Path.home() / "Library/Application Support"
    CHROMIUM = [_base / d for d in ("Google/Chrome", "Chromium", "BraveSoftware/Brave-Browser", "Microsoft Edge")]
    FIREFOX = [_base / "Mozilla", _base / "zen"]
    SUBDIR = "NativeMessagingHosts"
else:  # linux; Windows uses the registry, see install()
    CHROMIUM = [Path.home() / ".config" / d for d in ("google-chrome", "chromium", "BraveSoftware/Brave-Browser", "microsoft-edge")]
    FIREFOX = [Path.home() / ".mozilla"]
    SUBDIR = "native-messaging-hosts"
WIN_KEYS = {"chromium": [r"Software\Google\Chrome", r"Software\Chromium", r"Software\BraveSoftware\Brave-Browser",
                         r"Software\Microsoft\Edge"], "firefox": [r"Software\Mozilla"]}


def host_main():
    """canvas-host: started by the browser, never by hand."""
    from canvas_scrape import process

    proto = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)  # anything else that prints (yt-dlp, libraries) goes to stderr, not into the protocol
    sys.stdout = sys.stderr

    def send(msg):
        data = json.dumps(msg).encode()
        proto.write(struct.pack("<I", len(data)) + data)
        proto.flush()

    while header := sys.stdin.buffer.read(4):
        msg = json.loads(sys.stdin.buffer.read(struct.unpack("<I", header)[0]))
        if msg.get("cmd") == "ping":
            send({"ok": True, "version": version("canvas-scrape")})
        elif msg.get("cmd") == "process":
            try:
                send({"done": process(Path(msg["dir"]), log=lambda t: send({"progress": t.strip()}))})
            except Exception as e:
                send({"error": str(e)})
        else:
            send({"error": f"unknown command {msg.get('cmd')!r}"})


def executable():
    """canvas-host next to the running canvas-process (both live in uv's tool bin folder)."""
    name = "canvas-host.exe" if os.name == "nt" else "canvas-host"
    path = Path(sys.argv[0]).absolute().with_name(name)
    if not path.exists():
        raise FileNotFoundError(f"{path} not found; install with `uv tool install` first")
    return path


def manifest(kind, path):
    m = {"name": NAME, "description": "Canvas Course Saver: make text versions and transcripts",
         "path": str(path), "type": "stdio"}
    if kind == "chromium":
        m["allowed_origins"] = [f"chrome-extension://{CHROME_ID}/"]
    else:
        m["allowed_extensions"] = [FIREFOX_ID]
    return json.dumps(m, indent=2) + "\n"


def install():
    """Register canvas-host with every browser found (canvas-process --setup). Returns exit code."""
    try:
        exe = executable()
    except FileNotFoundError as e:
        print(f"error: {e}")
        return 1
    written = []
    if os.name == "nt":
        import winreg
        folder = Path(os.environ["LOCALAPPDATA"]) / "canvas-scrape"
        folder.mkdir(parents=True, exist_ok=True)
        for kind, keys in WIN_KEYS.items():
            file = folder / f"{NAME}.{kind}.json"
            file.write_text(manifest(kind, exe))
            for key in keys:
                with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"{key}\NativeMessagingHosts\{NAME}") as k:
                    winreg.SetValue(k, "", winreg.REG_SZ, str(file))
                written.append(f"HKCU\\{key}")
    else:
        for kind, bases in (("chromium", CHROMIUM), ("firefox", FIREFOX)):
            for base in bases:
                if base.is_dir():
                    file = base / SUBDIR / f"{NAME}.json"
                    file.parent.mkdir(exist_ok=True)
                    file.write_text(manifest(kind, exe))
                    written.append(str(file))
    if not written:
        print("error: no Chrome, Chromium, Brave, Edge, Firefox or Zen profile found on this computer")
        return 1
    print("Browser link installed for:\n  " + "\n  ".join(written))
    print("Reload the extension (chrome://extensions → ↻); its popup will then show (ready ✓).")
    return 0


def installed():
    """Host manifests on this computer whose program exists -> list of paths (for --check)."""
    if os.name == "nt":
        file = Path(os.environ.get("LOCALAPPDATA", "")) / "canvas-scrape" / f"{NAME}.chromium.json"
        found = [file] if file.exists() else []
    else:
        found = [b / SUBDIR / f"{NAME}.json" for b in CHROMIUM + FIREFOX if (b / SUBDIR / f"{NAME}.json").exists()]
    return [f for f in found if Path(json.loads(f.read_text())["path"]).exists()]
