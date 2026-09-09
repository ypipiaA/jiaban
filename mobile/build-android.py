"""Build a locally signed release APK. Keep .local/android-signing for future updates."""
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from android_release import release_manifest
ANDROID = ROOT / 'mobile/android'
version = json.loads((ROOT / 'mobile/package.json').read_text(encoding='utf-8'))['version']
if not re.fullmatch(r'\d+\.\d+\.\d+', version): raise RuntimeError('Invalid release version')
if f'<span id="appVersionLabel">v{version}</span>' not in (ROOT / '加班记录.html').read_text(encoding='utf-8'):
    raise RuntimeError('Visible app version must match the release version')
gradle_config = (ANDROID / 'app/build.gradle').read_text(encoding='utf-8')
if f'versionName "{version}"' not in gradle_config: raise RuntimeError('Android and package versions must match')
paths = json.loads((ROOT / '.local/android-tools/paths.json').read_text(encoding='utf-8'))
java, sdk = Path(paths['java']), Path(paths['sdk'])
env = dict(os.environ, JAVA_HOME=str(java), ANDROID_HOME=str(sdk), ANDROID_SDK_ROOT=str(sdk),
           ANDROID_USER_HOME=str(ROOT / '.local/android-user'), GRADLE_USER_HOME=str(ROOT / '.local/gradle'))
env['PATH'] = str(java / 'bin') + os.pathsep + env['PATH']
signing = ROOT / '.local/android-signing'
signing.mkdir(exist_ok=True)
keyfile, configfile = signing / 'jiaban-release.jks', signing / 'signing.json'
previous_apks = sorted((ROOT / 'public/downloads').glob('jiaban-*.apk'))
if previous_apks and (not keyfile.exists() or not configfile.exists()):
    raise RuntimeError('Existing releases found. Restore the original signing key and configuration before building an update.')
if not configfile.exists():
    if keyfile.exists(): raise RuntimeError('Signing configuration missing. Restore it before building an update.')
    configfile.write_text(json.dumps({'password': secrets.token_urlsafe(36), 'alias': 'jiaban-release'}), encoding='utf-8')
config = json.loads(configfile.read_text(encoding='utf-8'))
if not keyfile.exists():
    env['JIABAN_SIGNING_PASS'] = config['password']
    subprocess.run([str(java / 'bin/keytool.exe'), '-genkeypair', '-keystore', str(keyfile), '-storetype', 'JKS',
                    '-storepass:env', 'JIABAN_SIGNING_PASS', '-keypass:env', 'JIABAN_SIGNING_PASS',
                    '-alias', config['alias'], '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
                    '-dname', 'CN=Jiaban Release,O=Jiaban,C=CN'], env=env, check=True)
(ANDROID / 'signing.properties').write_text('storeFile=' + keyfile.as_posix().replace(':', '\\:') + '\nstorePassword=' + config['password'] +
                                           '\nkeyAlias=' + config['alias'] + '\nkeyPassword=' + config['password'] + '\n', encoding='utf-8', newline='\n')
(ANDROID / 'local.properties').write_text('sdk.dir=' + sdk.as_posix().replace(':', '\\:') + '\n', encoding='utf-8', newline='\n')
subprocess.run(['node', 'prepare.mjs'], cwd=ROOT / 'mobile', env=env, check=True)
subprocess.run(['node', 'node_modules/@capacitor/cli/bin/capacitor', 'sync', 'android'], cwd=ROOT / 'mobile', env=env, check=True)
print('Building signed release APK...', flush=True)
subprocess.run([str(ANDROID / 'gradlew.bat'), '--no-daemon', '--console=plain', '--max-workers=2', ':app:assembleRelease', ':app:lintRelease', ':app:testReleaseUnitTest'], cwd=ANDROID, env=env, check=True)
apk = ANDROID / 'app/build/outputs/apk/release/app-release.apk'
if not apk.exists(): raise RuntimeError('Signed release APK was not generated')
subprocess.run([str(sdk / 'build-tools/36.0.0/apksigner.bat'), 'verify', '--verbose', str(apk)], env=env, check=True)
def certificate(file):
    result = subprocess.run([str(sdk / 'build-tools/36.0.0/apksigner.bat'), 'verify', '--print-certs', str(file)],
                            env=env, capture_output=True, text=True, check=True)
    matches = re.findall(r'Signer #\d+ certificate SHA-256 digest: ([a-f0-9]+)', result.stdout)
    if not matches: raise RuntimeError('Cannot verify APK signing identity')
    return sorted(matches)

if previous_apks and certificate(apk) != certificate(previous_apks[-1]):
    raise RuntimeError('APK signing identity differs from the published app. Restore the original signing key.')
badging = subprocess.run([str(sdk / 'build-tools/36.0.0/aapt.exe'), 'dump', 'badging', str(apk)], env=env, capture_output=True, check=True).stdout.decode('utf-8')
build_code = re.search(r'\bversionCode\s+(\d+)', gradle_config)[1]
if f"name='com.jiaban.records' versionCode='{build_code}' versionName='{version}'" not in badging:
    raise RuntimeError('Built APK identity/version does not match the release configuration')
output = ROOT / 'dist/mobile'
output.mkdir(parents=True, exist_ok=True)
target = output / f'jiaban-{version}.apk'
shutil.copy2(apk, target)
(output / (target.name + '.sha256')).write_text(hashlib.sha256(target.read_bytes()).hexdigest() + '  ' + target.name + '\n', encoding='utf-8')
(output / 'android-latest.json').write_text(json.dumps(release_manifest(target), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('APK ready: ' + str(target), flush=True)
