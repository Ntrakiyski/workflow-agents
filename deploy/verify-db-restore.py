#!/usr/bin/env python3
"""Disposable LOCAL test-DB dump/restore drill; never targets Coolify resources.

Usage: python3 deploy/verify-db-restore.py /tmp/.../job-runner.json
The JSON must contain a database_url and a workflow-phase1-test-* container.
Only prints table counts, never credentials, dumps, or payloads.
"""
import json
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit
import uuid

config = json.loads(Path(sys.argv[1]).read_text())
container = config["container"]
if not container.startswith("workflow-phase1-test-"):
    raise SystemExit("Refusing a non-test container")
url = urlsplit(config["database_url"])
database = url.path.lstrip("/")
user = url.username
admin = config.get("admin_user", user)
restored = "restore_drill_" + uuid.uuid4().hex[:12]
base = ["docker", "exec", "-i", container]

def psql(sql, db=database):
    return subprocess.run(base + ["psql", "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1", "-At"],
                          input=sql.encode(), capture_output=True, check=True).stdout.decode().strip()

dump = subprocess.run(base + ["pg_dump", "-U", user, "-d", database, "-Fc", "--no-owner", "--no-acl"],
                      capture_output=True, check=True).stdout
subprocess.run(base + ["createdb", "-U", admin, "-O", user, restored], capture_output=True, check=True)
try:
    subprocess.run(base + ["pg_restore", "-U", user, "-d", restored, "--no-owner", "--no-acl", "--exit-on-error"],
                   input=dump, capture_output=True, check=True)
    tables = psql("SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1;").splitlines()
    counts = {}
    for table in tables:
        # Names came from PostgreSQL, but still quote each identifier safely.
        schema, name = table.split(".", 1)
        quoted = '"' + schema.replace('"', '""') + '"."' + name.replace('"', '""') + '"'
        source_count = psql("SELECT count(*) FROM " + quoted)
        restored_count = psql("SELECT count(*) FROM " + quoted, restored)
        assert source_count == restored_count, f"Restored count differs for {table}: source={source_count}, restored={restored_count}"
        counts[table] = int(source_count)
    print(json.dumps({"outcome":"passed", "source":database, "tables":counts,
                      "scope":"local PostgreSQL logical backup/restore only; BoxLite disks excluded"}, indent=2))
finally:
    subprocess.run(base + ["dropdb", "-U", admin, restored], capture_output=True, check=True)
