"""Frozen entry point: start the analyzer and open it in the default browser.

Used by the PyInstaller build. The bundled UI is unpacked to sys._MEIPASS and
pointed at through APP_DIST; anything the app writes goes to Library/Application
Support so it survives an app-bundle update.
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import webbrowser
from pathlib import Path


def _free_port() -> int:
    """Ask the OS for a port — a hardcoded one collides with a hand-run server."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _data_dir() -> Path:
    home = Path.home()
    return home / "Library" / "Application Support" / "PicoScope Impedance Analyzer"


def main() -> int:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    os.environ.setdefault("APP_DIST", str(base / "frontend_dist"))
    data = _data_dir()
    data.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("APP_DATA_DIR", str(data))
    os.environ.setdefault("PICO_MODE", "auto")

    port = int(os.environ.get("PORT") or _free_port())
    url = "http://127.0.0.1:%d" % port

    import uvicorn
    from backend.main import app

    # If the shell that launched us dies without running its shutdown hook, this
    # process would keep the port and the (exclusive) scope driver forever.
    if os.environ.get("PARENT_PID") and os.name != "nt":
        parent = int(os.environ["PARENT_PID"])

        def watch_parent():
            while True:
                if os.getppid() != parent:
                    os._exit(0)
                time.sleep(2.0)

        threading.Thread(target=watch_parent, daemon=True).start()

        # the ppid poll can miss (reparenting quirks); a closed stdin pipe cannot:
        # the shell holds the write end, so EOF means the shell is gone
        def watch_stdin():
            try:
                while sys.stdin.buffer.read(1):
                    pass
            except Exception:
                pass
            os._exit(0)

        threading.Thread(target=watch_stdin, daemon=True).start()

    # the Electron shell supplies its own window; only the standalone build
    # should reach for the system browser
    if not os.environ.get("APP_NO_BROWSER"):
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    print("PicoScope Impedance Analyzer")
    print("  %s" % url)
    print("  data: %s" % data, flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
    # a non-daemon thread would otherwise keep the interpreter (and the port) alive
    os._exit(0)


if __name__ == "__main__":
    raise SystemExit(main())
