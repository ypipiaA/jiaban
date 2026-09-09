"""验证资源更新会可靠地刷新离线缓存版本，重复同步不会制造新版本。"""
import contextlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("sync_public", ROOT / "sync_public.py")
SYNC = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SYNC)


class SyncTests(unittest.TestCase):
    def test_content_versions_and_exact_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            public = root / "public"
            public.mkdir()
            source = root / "加班记录.html"
            source.write_text("中文页面\n", encoding="utf-8")
            for name in ("sync-core.js", "sync-client.js", "app-update.js", "sync-worker.mjs"):
                (root / name).write_bytes((ROOT / name).read_bytes())
            for name in ("manifest.json", "icon.svg", "icon-192.png", "icon-512.png"):
                (public / name).write_bytes(name.encode("utf-8"))
            worker = public / "sw.js"
            worker.write_bytes((ROOT / "public/sw.js").read_bytes())

            def sync():
                with contextlib.redirect_stdout(io.StringIO()):
                    SYNC.sync_public(root)
                self.assertEqual(source.read_bytes(), (public / "index.html").read_bytes())
                return worker.read_bytes()

            initial = sync()
            self.assertEqual(sync(), initial)
            source.write_text("更新页面\n", encoding="utf-8")
            changed_page = sync()
            self.assertNotEqual(changed_page, initial)
            (public / "icon.svg").write_text("new icon", encoding="utf-8")
            changed_icon = sync()
            self.assertNotEqual(changed_icon, changed_page)
            worker.write_bytes(worker.read_bytes() + b"\n// changed cache strategy\n")
            changed_worker = sync()
            self.assertNotEqual(changed_worker.splitlines()[1], changed_icon.splitlines()[1])
            self.assertEqual(sync(), changed_worker)


if __name__ == "__main__":
    unittest.main()
