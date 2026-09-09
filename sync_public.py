"""同步单文件页面，并按资源内容更新离线缓存版本。无需第三方依赖。"""
import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def sync_public(root=ROOT):
    public = root / "public"
    public.mkdir(exist_ok=True)
    (public / "index.html").write_bytes((root / "加班记录.html").read_bytes())
    for name in ("sync-core.js", "sync-client.js", "app-update.js"):
        (public / name).write_bytes((root / name).read_bytes())
    (public / "_worker.js").write_text(
        (root / "sync-core.js").read_text(encoding="utf-8") + "\n" +
        (root / "sync-worker.mjs").read_text(encoding="utf-8"), encoding="utf-8", newline="\n")
    worker = public / "sw.js"
    template = re.sub(r"const CACHE = '[^']+';", "const CACHE = '__VERSION__';", worker.read_text(encoding="utf-8"))
    digest = hashlib.sha256(template.encode("utf-8"))
    for name in ("index.html", "sync-core.js", "sync-client.js", "app-update.js", "manifest.json", "icon.svg", "icon-192.png", "icon-512.png"):
        digest.update(name.encode("utf-8"))
        digest.update((public / name).read_bytes())
    version = "jiaban-" + digest.hexdigest()[:12]
    worker.write_text(template.replace("__VERSION__", version), encoding="utf-8", newline="\n")
    print(f"public/index.html updated; offline cache: {version}")


if __name__ == "__main__":
    sync_public()
