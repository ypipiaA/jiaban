"""发布保护：错误应用、错误项目、同步缺失不能被报告为成功。"""
import copy
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import cf_deploy as deploy
import cloud_setup
from android_release import release_manifest, validate_android_release, publish_android


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        for name in ("加班记录.html", "sync-core.js", "sync-client.js", "app-update.js", "sync-worker.mjs"):
            shutil.copy2(ROOT / name, self.root / name)
        shutil.copytree(ROOT / "public", self.root / "public", ignore=shutil.ignore_patterns("downloads"))
        for name in ('mobile/package.json', 'mobile/android/app/build.gradle', 'mobile/android/variables.gradle', 'mobile/release-notes.txt'):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, target)
        downloads = self.root / 'public/downloads'
        downloads.mkdir()
        version = json.loads((self.root / 'mobile/package.json').read_text(encoding='utf-8'))['version']
        self.apk = downloads / f'jiaban-{version}.apk'
        self.apk.write_bytes(b'isolated-release-fixture')
        self.release = release_manifest(self.apk, self.root)
        self.apk.with_suffix('.apk.sha256').write_text(self.release['sha256'] + '  ' + self.apk.name + '\n')
        (downloads / 'android-latest.json').write_text(json.dumps(self.release, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    def test_correct_release_and_page_replacement(self):
        deploy.validate_release(self.root)
        for name in ("加班记录.html", "public/index.html"):
            (self.root / name).write_text('<title>生活记账</title>', encoding="utf-8")
        with self.assertRaisesRegex(SystemExit, "首页不是加班记录"):
            deploy.validate_release(self.root)

    def test_missing_worker_and_foreign_assets_are_rejected(self):
        worker = self.root / "public/_worker.js"
        original = worker.read_bytes()
        worker.unlink()
        with self.assertRaisesRegex(SystemExit, "缺少.*_worker"):
            deploy.validate_release(self.root)
        worker.write_bytes(original)
        foreign = self.root / "public/static"
        foreign.mkdir()
        (foreign / "other-app.js").write_text("other app")
        with self.assertRaisesRegex(SystemExit, "混入了非加班记录"):
            deploy.validate_release(self.root)

    def test_project_identity_and_original_database_required(self):
        project = {"name": "jiaban", "subdomain": "jiaban-x2m.pages.dev",
                   "deployment_configs": {"production": {"d1_databases": {"DB": {"id": "test-original-db"}}}}}
        with patch.object(deploy, "PROJECT", "jiaban"):
            deploy.validate_project(project)
            wrong = copy.deepcopy(project)
            wrong["subdomain"] = "another-app.pages.dev"
            with self.assertRaisesRegex(SystemExit, "目标不匹配"):
                deploy.validate_project(wrong)
            project["deployment_configs"]["production"]["d1_databases"] = None
            with self.assertRaisesRegex(SystemExit, "缺少原有同步数据库"):
                deploy.validate_project(project)

    def test_success_requires_exact_home_and_json_sync_health(self):
        html = (self.root / "public/index.html").read_bytes()
        healthy = json.dumps({"ready": True, "version": 1}).encode()
        latest = (self.root / 'public/downloads/android-latest.json').read_bytes()
        deploy.verify_production(lambda url: healthy if url.endswith("/api/health") else latest if url.endswith('android-latest.json') else html, self.root)
        with self.assertRaisesRegex(RuntimeError, "正式首页.*不一致"):
            deploy.verify_production(lambda url: b"<title>other app</title>", self.root)
        with self.assertRaisesRegex(RuntimeError, "同步接口返回了网页"):
            deploy.verify_production(lambda url: html, self.root)
        with self.assertRaisesRegex(RuntimeError, "同步接口未就绪"):
            deploy.verify_production(lambda url: b'{"ready":false}' if url.endswith("/api/health") else html, self.root)
        with self.assertRaisesRegex(RuntimeError, '更新清单.*不一致'):
            deploy.verify_production(lambda url: healthy if url.endswith('/api/health') else html, self.root)

    def test_release_metadata_must_match_artifact_and_fixed_channel(self):
        validate_android_release(self.root)
        manifest = self.root / 'public/downloads/android-latest.json'
        for field, value in [('appId', 'com.other.app'), ('url', 'https://other.invalid/app.apk'), ('versionCode', 1), ('sha256', 'a' * 64), ('size', 1)]:
            with self.subTest(field=field):
                changed = dict(self.release, **{field: value})
                manifest.write_text(json.dumps(changed), encoding='utf-8')
                with self.assertRaisesRegex(SystemExit, '安卓更新发布校验失败'):
                    validate_android_release(self.root)
        manifest.write_text(json.dumps(self.release), encoding='utf-8')
        self.apk.write_bytes(b'corrupted artifact')
        with self.assertRaisesRegex(SystemExit, '安卓更新发布校验失败'):
            validate_android_release(self.root)

    def test_staging_rejects_replacing_a_versioned_apk(self):
        output = self.root / 'dist/mobile'
        output.mkdir(parents=True)
        new = output / self.apk.name
        new.write_bytes(b'a different build with the same version')
        (output / 'android-latest.json').write_text(json.dumps(release_manifest(new, self.root)))
        with self.assertRaisesRegex(SystemExit, '已存在且内容不同'):
            publish_android(self.root)

    def test_database_setup_rejects_wrong_project_without_network(self):
        with patch.object(cloud_setup, "PROJECT", "jizhang"), patch.object(cloud_setup, "req") as request, patch.object(sys, "argv", ["cloud_setup.py", "--apply"]):
            with self.assertRaisesRegex(SystemExit, "CF_PROJECT 不匹配"):
                cloud_setup.main()
            request.assert_not_called()

    def test_database_setup_checks_domain_before_any_database_access(self):
        with patch.object(cloud_setup, "PROJECT", "jiaban"), patch.object(deploy, "PROJECT", "jiaban"), patch.object(cloud_setup, "req", return_value={"result": {"name": "jiaban", "subdomain": "wrong.pages.dev"}}) as request, patch.object(sys, "argv", ["cloud_setup.py", "--apply"]):
            with self.assertRaisesRegex(SystemExit, "目标不匹配"):
                cloud_setup.main()
            request.assert_called_once()


if __name__ == "__main__":
    unittest.main()
