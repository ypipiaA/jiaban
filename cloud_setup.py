"""检查 / 配置现有 Pages 项目的 D1 同步数据库。默认只读，--apply 才写入。"""
import argparse
from cf_deploy import req, BASE, ACCOUNT, PROJECT, ROOT, EXPECTED_PROJECT, validate_project_identity


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="创建数据库、初始化表并绑定到现有站点")
    args = parser.parse_args()
    if PROJECT != EXPECTED_PROJECT:
        raise SystemExit("数据库配置仅用于 jiaban，当前 CF_PROJECT 不匹配，停止操作")
    project_url = f"{BASE}/accounts/{ACCOUNT}/pages/projects/{PROJECT}"
    database_url = f"{BASE}/accounts/{ACCOUNT}/d1/database"
    project = req(project_url)["result"]
    validate_project_identity(project)
    databases = req(database_url + "?per_page=100")["result"]
    name = PROJECT + "-sync"
    matching = [db for db in databases if db["name"] == name]
    db = matching[0] if matching else None
    print("站点:", project["subdomain"])
    print("数据库权限检查通过")
    print("同步数据库:", name, "（已存在）" if db else "（待创建）")
    if not args.apply:
        return
    if not db:
        db = req(database_url, "POST", {"name": name})["result"]
        print("同步数据库已创建")
    dbid = db["uuid"]
    configs = {}
    for env in ("production", "preview"):
        current = project.get("deployment_configs", {}).get(env, {}).get("d1_databases") or {}
        if "DB" in current and current["DB"]["id"] != dbid:
            raise SystemExit(f"{env} 的 DB 已绑定其他数据库，未覆盖；请先核实配置")
        configs[env] = {"d1_databases": {**current, "DB": {"id": dbid}}}
    result = req(f"{database_url}/{dbid}/query", "POST", {"sql": (ROOT / "schema.sql").read_text(encoding="utf-8")})
    if any(not item.get("success", False) for item in result["result"]):
        raise SystemExit("数据表初始化失败")
    req(project_url, "PATCH", {"deployment_configs": configs})
    verified = req(project_url)["result"]
    for env in configs:
        if verified["deployment_configs"][env]["d1_databases"]["DB"]["id"] != dbid:
            raise SystemExit("数据库绑定校验失败")
    print("数据表及生产 / 预览环境绑定已完成")


if __name__ == "__main__":
    main()
