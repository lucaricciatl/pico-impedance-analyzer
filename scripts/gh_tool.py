"""GitHub operations for this repo, reading the token from the macOS keychain.

The token is fetched at runtime so it never appears in a command line, a file, or
a shell history entry.
"""
from __future__ import annotations

import json
import mimetypes
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

def _ssl_ctx():
    """python.org builds ship no CA bundle; macOS keeps one at /etc/ssl/cert.pem."""
    for cafile in ("/etc/ssl/cert.pem",):
        try:
            return ssl.create_default_context(cafile=cafile)
        except Exception:
            continue
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


SSL_CTX = _ssl_ctx()

API = "https://api.github.com"


def token() -> str:
    out = subprocess.run(
        ["git", "credential-osxkeychain", "get"],
        input="protocol=https\nhost=github.com\n\n",
        capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("no github credential in the keychain")


def api(method: str, path: str, payload: dict | None = None, raw: bytes | None = None,
        ctype: str = "application/json"):
    url = path if path.startswith("http") else API + path
    data = raw if raw is not None else (json.dumps(payload).encode() if payload is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token())
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data is not None:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, context=SSL_CTX) as r:
            body = r.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        sys.stderr.write(e.read().decode() + "\n")
        raise SystemExit("HTTP %s on %s %s" % (e.code, method, url))


def whoami():
    u = api("GET", "/user")
    print(u["login"], "|", u.get("name"), "|", u.get("email"))


def create_repo(name: str, description: str):
    u = api("GET", "/user")
    body = {"name": name, "description": description, "private": False,
            "has_issues": True, "has_wiki": False, "auto_init": False}
    repo = api("POST", "/user/repos", body)
    print(repo["full_name"])
    print(repo["clone_url"])
    return repo


def create_release(repo: str, tag: str, name: str, notes: str):
    body = {"tag_name": tag, "name": name, "body": notes, "draft": False,
            "prerelease": False}
    rel = api("POST", "/repos/%s/releases" % repo, body)
    print(rel["html_url"])
    return rel


def upload_asset(repo: str, release: dict, path: Path):
    upload_url = release["upload_url"].split("{")[0]
    ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    url = "%s?name=%s" % (upload_url, urllib.parse.quote(path.name))
    data = path.read_bytes()
    boundary = uuid.uuid4().hex
    body = b"".join([
        b"--" + boundary.encode() + b"\r\n",
        b'Content-Disposition: form-data; name="file"; filename="' + path.name.encode() + b'"\r\n',
        b"Content-Type: " + ctype.encode() + b"\r\n\r\n",
        data, b"\r\n--" + boundary.encode() + b"--\r\n",
    ])
    asset = api("POST", url, raw=body,
                ctype="multipart/form-data; boundary=" + boundary)
    print("uploaded %s (%d bytes) state=%s" % (asset["name"], asset["size"], asset["state"]))
    return asset


if __name__ == "__main__":
    import urllib.parse  # noqa: F401  (used inside upload_asset)

    cmd = sys.argv[1] if len(sys.argv) > 1 else "whoami"
    if cmd == "whoami":
        whoami()
