"""Operator-only staging diagnostics. Runs in Provider, reads only its own DB.

A marker proves the named application volume survives replacement; it is NOT
proof of BoxLite VM disk persistence. No credentials or workload data are output.
"""
import json
import os
from pathlib import Path
import platform

import boxlite
import psycopg

volume = Path(os.environ["BOX_ROOT"]).parent
marker = volume / ".phase1-volume-marker"
if os.getenv("PHASE1_WRITE_MARKER") == "1":
    marker.write_text("workflow-agents-phase1-volume-v1")
assert marker.read_text() == "workflow-agents-phase1-volume-v1", "Named volume marker missing"
stat = os.statvfs(volume)
memory = {}
for line in Path("/proc/meminfo").read_text().splitlines():
    key, value = line.split(":", 1)
    if key in {"MemTotal", "MemAvailable"}:
        memory[key] = int(value.strip().split()[0]) * 1024
with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM sandboxes")
        sandboxes = cursor.fetchone()[0]
        cursor.execute("SELECT count(*) FROM audit_events")
        audits = cursor.fetchone()[0]
        cursor.execute("SELECT event_id FROM audit_events ORDER BY occurred_at,event_id LIMIT 1")
        first = cursor.fetchone()
print(json.dumps({"probe":"provider-registry-and-volume", "arch":platform.machine(),
                  "logical_cpus":os.cpu_count(), "uid":os.getuid(), "sdk_version":boxlite.__version__,
                  "kvm_access":os.access("/dev/kvm", os.R_OK | os.W_OK),
                  "persistent_volume_marker":"retained", "volume_free_bytes":stat.f_bavail*stat.f_frsize,
                  "host_memory_bytes":memory,"registry_sandboxes":sandboxes,"durable_audit_rows":audits,
                  "first_audit_id":first[0] if first else None, "vm_disk_retention":"blocked-unverified"}))
