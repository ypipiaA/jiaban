"""通过 Cloudflare API 直接把 public/ 部署到 Pages（无需 Node/wrangler）。

用法：
    set CF_TOKEN=xxx & set CF_ACC=xxx & python cf_deploy.py
"""

import base64
import hashlib
import json
import mimetypes
import os
import re
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
if (ROOT / ".cf_env").exists():
    for line in (ROOT / ".cf_env").read_text(encoding="utf-8-sig").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())
PROJECT = os.environ.get("CF_PROJECT", "jiaban")
TOKEN = os.environ.get("CF_TOKEN", "")
ACCOUNT = os.environ.get("CF_ACC", "")
BASE = "https://api.cloudflare.com/client/v4"
EXPECTED_PROJECT = "jiaban"
EXPECTED_HOST = "jiaban-x2m.pages.dev"
mimetypes.add_type("application/vnd.android.package-archive", ".apk")


def req(url, method="GET", data=None, token=None, headers=None, raw=False):
    """走 curl 发请求（本机 Python 的 SSL 栈连不上 Cloudflare）。"""
    import subprocess
    import tempfile

    if not TOKEN or not ACCOUNT:
        raise SystemExit("请在 .cf_env 中配置 CF_TOKEN 和 CF_ACC")
    cmd = ["curl", "-sS", "--connect-timeout", "20", "--max-time", "180", "-X", method, url,
           "-H", f"Authorization: Bearer {token or TOKEN}"]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]

    tmp = None
    if data is not None:
        if raw:
            body = data
        else:
            cmd += ["-H", "Content-Type: application/json"]
            body = json.dumps(data).encode()
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".bin")
        tmp.write(body)
        tmp.close()
        cmd += ["--data-binary", "@" + tmp.name]

    try:
        result = subprocess.run(cmd, capture_output=True, timeout=200)
        if result.returncode:
            raise SystemExit(f"网络请求失败（curl {result.returncode}）：{result.stderr.decode(errors='replace')[:200]}")
        out = result.stdout.decode()
    finally:
        if tmp:
            os.unlink(tmp.name)

    try:
        res = json.loads(out)
    except json.JSONDecodeError:
        raise SystemExit(f"响应无法解析 @ {method} {url}\n{out[:600]}")
    if not res.get("success", True):
        raise SystemExit(f"API 报错 @ {method} {url}\n{json.dumps(res.get('errors'), ensure_ascii=False)[:600]}")
    return res


def collect_files():
    """返回 [(站点路径, 本地路径)]，站点路径以 / 开头。_worker.js 不算静态资源。"""
    out = []
    for p in sorted(PUBLIC.rglob("*")):
        if p.is_file() and p.name != "_worker.js":
            rel = "/" + p.relative_to(PUBLIC).as_posix()
            out.append((rel, p))
    return out


def content_hash(b64: str, ext: str) -> str:
    return hashlib.sha256((b64 + ext).encode()).hexdigest()[:32]


def validate_release(root=ROOT):
    """发布前核对应用身份和完整同步资源，拒绝混入其他程序的页面。"""
    public = root / "public"
    required = {"index.html", "install.html", "sync-core.js", "sync-client.js", "app-update.js", "sw.js", "downloads/android-latest.json",
                "manifest.json", "icon.svg", "icon-192.png", "icon-512.png", "_worker.js"}
    present = {p.relative_to(public).as_posix() for p in public.rglob("*") if p.is_file()}
    if not required <= present:
        raise SystemExit("发布文件不完整，缺少：" + ", ".join(sorted(required - present)))
    unexpected = [name for name in present - required
                  if not re.fullmatch(r"downloads/jiaban-\d+\.\d+\.\d+\.apk(?:\.sha256)?", name)]
    if unexpected:
        raise SystemExit("public 中混入了非加班记录文件，停止发布：" + ", ".join(sorted(unexpected)))
    html = (public / "index.html").read_bytes()
    if html != (root / "加班记录.html").read_bytes():
        raise SystemExit("发布首页与加班记录源文件不一致，停止发布")
    text = html.decode("utf-8")
    if not all(marker in text for marker in ("<title>加班记录</title>", 'id="calGrid"', 'id="dayCard"', 'id="v-rep"')):
        raise SystemExit("首页不是加班记录程序，停止发布")
    manifest = json.loads((public / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("name") != "加班记录" or manifest.get("start_url") not in ("./", "/"):
        raise SystemExit("手机桌面入口不是加班记录，停止发布")
    for name in ("sync-core.js", "sync-client.js", "app-update.js"):
        if (public / name).read_bytes() != (root / name).read_bytes():
            raise SystemExit("同步脚本与源文件不一致，停止发布：" + name)
    expected_worker = (root / "sync-core.js").read_text(encoding="utf-8") + "\n" + (root / "sync-worker.mjs").read_text(encoding="utf-8")
    if (public / "_worker.js").read_text(encoding="utf-8") != expected_worker:
        raise SystemExit("云同步 Worker 缺失或被替换，停止发布")
    from android_release import validate_android_release
    validate_android_release(root)


def validate_project_identity(project):
    if PROJECT != EXPECTED_PROJECT or project.get("name") != EXPECTED_PROJECT or project.get("subdomain") != EXPECTED_HOST:
        raise SystemExit("此脚本仅发布 jiaban-x2m.pages.dev，当前目标不匹配，停止发布")


def validate_project(project):
    validate_project_identity(project)
    binding = (project.get("deployment_configs", {}).get("production", {}).get("d1_databases") or {}).get("DB")
    if not binding or not binding.get("id"):
        raise SystemExit("正式站缺少原有同步数据库绑定，停止发布；请先检查 Cloudflare 配置")


def fetch_public(url):
    import subprocess
    try:
        result = subprocess.run(["curl", "-f", "-sS", "-L", "--connect-timeout", "10", "--max-time", "30", url],
                                capture_output=True, timeout=40)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("正式网址访问超时：" + url) from error
    if result.returncode:
        raise RuntimeError("正式网址暂时无法访问：" + url)
    return result.stdout


def verify_production(fetch=fetch_public, root=ROOT):
    if fetch(f"https://{EXPECTED_HOST}/") != (root / "public/index.html").read_bytes():
        raise RuntimeError("正式首页与本次加班记录页面不一致，发布验证未通过")
    try:
        health = json.loads(fetch(f"https://{EXPECTED_HOST}/api/health"))
    except (ValueError, UnicodeError) as error:
        raise RuntimeError("同步接口返回了网页或无效内容，发布验证未通过") from error
    if health != {"ready": True, "version": 1}:
        raise RuntimeError("同步接口未就绪，发布验证未通过")
    if fetch(f"https://{EXPECTED_HOST}/downloads/android-latest.json") != (root / 'public/downloads/android-latest.json').read_bytes():
        raise RuntimeError("正式安卓更新清单与本次发布不一致，发布验证未通过")


def multipart(fields: dict, files: dict | None = None) -> tuple[bytes, str]:
    """fields: 文本字段；files: {表单名: (文件名, bytes, Content-Type)}"""
    boundary = uuid.uuid4().hex
    buf = b""
    for name, value in fields.items():
        buf += f"--{boundary}\r\n".encode()
        buf += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        buf += value.encode() + b"\r\n"
    for name, (fname, content, ftype) in (files or {}).items():
        buf += f"--{boundary}\r\n".encode()
        buf += f'Content-Disposition: form-data; name="{name}"; filename="{fname}"\r\n'.encode()
        buf += f"Content-Type: {ftype}\r\n\r\n".encode()
        buf += content + b"\r\n"
    buf += f"--{boundary}--\r\n".encode()
    return buf, f"multipart/form-data; boundary={boundary}"


def main():
    from sync_public import sync_public
    sync_public()
    validate_release()
    if PROJECT != EXPECTED_PROJECT:
        raise SystemExit("此脚本仅发布 jiaban，当前 CF_PROJECT 不匹配，停止发布")
    project = req(f"{BASE}/accounts/{ACCOUNT}/pages/projects/{PROJECT}")["result"]
    validate_project(project)
    files = collect_files()
    if not files:
        raise SystemExit("public/ 目录为空")
    print(f"待上传 {len(files)} 个文件")

    # 1. 取上传令牌
    jwt = req(f"{BASE}/accounts/{ACCOUNT}/pages/projects/{PROJECT}/upload-token")["result"]["jwt"]

    # 2. 计算内容哈希
    payloads, manifest = [], {}
    for site_path, local in files:
        b64 = base64.b64encode(local.read_bytes()).decode()
        ext = local.suffix.lstrip(".")
        key = content_hash(b64, ext)
        manifest[site_path] = key
        ctype = mimetypes.guess_type(local.name)[0] or "application/octet-stream"
        payloads.append({
            "key": key,
            "value": b64,
            "metadata": {"contentType": ctype},
            "base64": True,
        })

    # 3. 查询哪些还没上传过
    missing = req(f"{BASE}/pages/assets/check-missing", "POST",
                  {"hashes": list(manifest.values())}, token=jwt)["result"]
    missing_set = set(missing)
    todo = [p for p in payloads if p["key"] in missing_set]
    print(f"需要上传 {len(todo)} 个（其余已存在）")

    # 4. 上传资源
    if todo:
        # APK 的 Base64 体积较大，分批上传，避免旧版与新版一起超过请求时限。
        batches, batch, size = [], [], 0
        for asset in todo:
            asset_size = len(asset["value"]) + 512
            if batch and size + asset_size > 5 * 1024 * 1024:
                batches.append(batch)
                batch, size = [], 0
            batch.append(asset)
            size += asset_size
        if batch:
            batches.append(batch)
        for index, batch in enumerate(batches, 1):
            req(f"{BASE}/pages/assets/upload", "POST", batch, token=jwt)
            print(f"已上传第 {index}/{len(batches)} 批资源", flush=True)
        print("资源上传完成")

    # 5. 创建部署（附带 _worker.js 启用同步接口）
    extra_files = {}
    worker = PUBLIC / "_worker.js"
    if worker.exists():
        extra_files["_worker.js"] = ("_worker.js", worker.read_bytes(),
                                     "application/javascript+module")
        print("包含 _worker.js（云同步接口）")
    body, ctype = multipart({"manifest": json.dumps(manifest)}, extra_files)
    res = req(f"{BASE}/accounts/{ACCOUNT}/pages/projects/{PROJECT}/deployments",
              "POST", body, headers={"Content-Type": ctype}, raw=True)
    d = res["result"]
    print("部署已提交，正在核对正式首页和同步接口", flush=True)
    for attempt in range(3):
        try:
            verify_production()
            break
        except (RuntimeError, TimeoutError) as error:
            if attempt == 2:
                raise SystemExit(str(error)) from error
            time.sleep(3)
    print("部署成功：正式首页内容一致，同步接口已就绪")
    print("  预览地址:", d.get("url"))
    for domain in d.get("aliases") or []:
        print("  别名:", domain)


if __name__ == "__main__":
    sys.exit(main())
