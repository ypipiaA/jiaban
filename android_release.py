"""Generate and validate the single Android update channel from the signed build."""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ORIGIN = 'https://jiaban-x2m.pages.dev'


def release_manifest(apk, root=ROOT):
    version = json.loads((root / 'mobile/package.json').read_text(encoding='utf-8'))['version']
    gradle = (root / 'mobile/android/app/build.gradle').read_text(encoding='utf-8')
    code = re.search(r'\bversionCode\s+(\d+)\b', gradle)
    if not re.fullmatch(r'\d{1,4}\.\d{1,4}\.\d{1,4}', version) or f'versionName "{version}"' not in gradle or not code or not 0 < int(code[1]) <= 2147483647:
        raise ValueError('安卓版本配置不一致')
    if 'applicationId "com.jiaban.records"' not in gradle:
        raise ValueError('安卓应用身份不一致')
    if apk.name != f'jiaban-{version}.apk' or not 0 < apk.stat().st_size <= 25 * 1024 * 1024:
        raise ValueError('安卓安装包文件名或大小不正确')
    variables = (root / 'mobile/android/variables.gradle').read_text(encoding='utf-8')
    minimum = re.search(r'\bminSdkVersion\s*=\s*(\d+)', variables)
    notes = (root / 'mobile/release-notes.txt').read_text(encoding='utf-8').strip()
    if not minimum or not 24 <= int(minimum[1]) <= 100 or len(notes) > 2000 or not notes:
        raise ValueError('安卓最低系统或更新说明不正确')
    return {'schemaVersion': 1, 'appId': 'com.jiaban.records', 'version': version,
            'versionCode': int(code[1]), 'minSdk': int(minimum[1]),
            'url': ORIGIN + '/downloads/' + apk.name, 'sha256': hashlib.sha256(apk.read_bytes()).hexdigest(),
            'size': apk.stat().st_size, 'notes': notes}


def validate_android_release(root=ROOT):
    public = root / 'public'
    try:
        actual = json.loads((public / 'downloads/android-latest.json').read_text(encoding='utf-8'))
        version = json.loads((root / 'mobile/package.json').read_text(encoding='utf-8'))['version']
        apk = public / 'downloads' / f'jiaban-{version}.apk'
        expected = release_manifest(apk, root)
        checksum = apk.with_suffix('.apk.sha256').read_text(encoding='utf-8').strip()
        install = (public / 'install.html').read_text(encoding='utf-8')
        if actual != expected or checksum != expected['sha256'] + '  ' + apk.name:
            raise ValueError('更新清单与本次安装包不一致')
        if f'href="downloads/{apk.name}"' not in install:
            raise ValueError('手机安装入口未指向当前版本')
        if f'<span id="appVersionLabel">v{version}</span>' not in (public / 'index.html').read_text(encoding='utf-8'):
            raise ValueError('网页显示的版本与手机发布版本不一致')
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise SystemExit('安卓更新发布校验失败：' + str(error)) from error


def publish_android(root=ROOT):
    """Stage APK and metadata together. Never replace an already published version."""
    version = json.loads((root / 'mobile/package.json').read_text(encoding='utf-8'))['version']
    source = root / 'dist/mobile' / f'jiaban-{version}.apk'
    manifest = release_manifest(source, root)
    build_manifest = json.loads((source.parent / 'android-latest.json').read_text(encoding='utf-8'))
    if manifest != build_manifest:
        raise SystemExit('构建后版本配置发生变化，请重新构建再发布')
    downloads = root / 'public/downloads'
    downloads.mkdir(parents=True, exist_ok=True)
    previous_manifest = downloads / 'android-latest.json'
    if previous_manifest.exists():
        previous = json.loads(previous_manifest.read_text(encoding='utf-8'))
        if previous['version'] != manifest['version'] and previous['versionCode'] >= manifest['versionCode']:
            raise SystemExit('新版 versionCode 必须高于已发布版本')
    target = downloads / source.name
    content = source.read_bytes()
    if target.exists() and target.read_bytes() != content:
        raise SystemExit('该版本安装包已存在且内容不同，请增加版本号后重新构建')
    target.write_bytes(content)
    target.with_suffix('.apk.sha256').write_text(manifest['sha256'] + '  ' + source.name + '\n', encoding='utf-8')
    (downloads / 'android-latest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    validate_android_release(root)
    print(f'Android {version}: signed APK and update metadata staged together.')


if __name__ == '__main__':
    publish_android()
