"""Download verified official build tools into .local/; do not change system settings."""
import concurrent.futures
import hashlib
import json
import os
import subprocess
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / '.local' / 'android-tools'
TOOLS.mkdir(parents=True, exist_ok=True)


def download(url, target, checksum=None, algorithm='sha256'):
    if not target.exists() or (checksum and hashlib.new(algorithm, target.read_bytes()).hexdigest() != checksum):
        subprocess.run(['curl.exe', '--fail', '--silent', '--show-error', '--location', '--retry', '3',
                        '--connect-timeout', '25', '--max-time', '900', url, '-o', str(target)], check=True)
    if checksum and hashlib.new(algorithm, target.read_bytes()).hexdigest() != checksum:
        raise RuntimeError('Download checksum mismatch: ' + target.name)
    return target


def extract(archive, target):
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            (target / entry.filename).resolve().relative_to(target.resolve())
        source.extractall(target)


def main():
    repository = download('https://dl.google.com/android/repository/repository2-1.xml', TOOLS / 'android-repository.xml')
    package = next(p for p in ET.parse(repository).getroot() if p.get('path') == 'cmdline-tools;19.0')
    sdk_archive = next(a for a in package.findall('./archives/archive') if a.findtext('host-os') == 'windows').find('complete')
    print('Preparing official Microsoft OpenJDK 21 and checksum-verified Android tools...', flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        j = pool.submit(download, 'https://aka.ms/download-jdk/microsoft-jdk-21.0.12.1-windows-x64.zip', TOOLS / 'microsoft-jdk.zip')
        a = pool.submit(download, 'https://dl.google.com/android/repository/' + sdk_archive.findtext('url'), TOOLS / 'commandline-19.zip', sdk_archive.findtext('checksum'), 'sha1')
        jdk_zip, sdk_zip = j.result(), a.result()
    with zipfile.ZipFile(jdk_zip) as archive:
        if archive.testzip() is not None: raise RuntimeError('JDK archive is incomplete')
    if not list((TOOLS / 'jdk').glob('*/bin/java.exe')):
        extract(jdk_zip, TOOLS / 'jdk')
    java_home = next((TOOLS / 'jdk').glob('*/bin/java.exe')).parents[1]
    sdk = TOOLS / 'sdk'
    manager = sdk / 'cmdline-tools' / '19.0' / 'bin' / 'sdkmanager.bat'
    if not manager.exists():
        extract(sdk_zip, TOOLS / 'commandline19')
        manager.parent.parent.parent.mkdir(parents=True, exist_ok=True)
        source = (TOOLS / 'commandline19' / 'cmdline-tools').resolve()
        destination = manager.parent.parent.resolve()
        source.relative_to(TOOLS.resolve()); destination.relative_to(TOOLS.resolve())
        source.rename(destination)
    env = dict(os.environ, JAVA_HOME=str(java_home), ANDROID_HOME=str(sdk), ANDROID_SDK_ROOT=str(sdk), ANDROID_USER_HOME=str(ROOT / '.local' / 'android-user'))
    env['PATH'] = str(java_home / 'bin') + os.pathsep + env['PATH']
    print('Installing Android API 36 and build tools; detailed log: .local/android-tools/sdk-install.log', flush=True)
    with (TOOLS / 'sdk-install.log').open('w', encoding='utf-8') as log:
        subprocess.run([str(manager), '--sdk_root=' + str(sdk), '--licenses'], input='y\n' * 100, text=True, stdout=log, stderr=subprocess.STDOUT, env=env, check=True)
        package_list = TOOLS / 'packages.txt'
        package_list.write_text('platform-tools\nplatforms;android-36\nbuild-tools;36.0.0\n', encoding='utf-8')
        subprocess.run([str(manager), '--sdk_root=' + str(sdk), '--package_file=' + str(package_list)], input='y\n' * 100, text=True, stdout=log, stderr=subprocess.STDOUT, env=env, check=True)
    (TOOLS / 'paths.json').write_text(json.dumps({'java': str(java_home), 'sdk': str(sdk)}, indent=2), encoding='utf-8')
    print('Android build tools ready.', flush=True)


if __name__ == '__main__':
    main()
