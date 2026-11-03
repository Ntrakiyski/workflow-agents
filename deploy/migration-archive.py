#!/usr/bin/env python3
"""Operator-only Provider logical archive; stdout contains encrypted JSON only.

Run inside the owning Provider container. DATABASE_URL is the only DB accessed.
Archive password defaults to the direct, non-delegated operator credential in
PROVIDER_AUTH_JSON; PHASE1_ARCHIVE_PASSWORD may select a separate operator key.

Envelope format matches migration-archive.mjs. AES256CBC uses PBKDF2-SHA256 with
200000 iterations and 48 derived bytes (key32 + IV16). An independently salted
PBKDF2 key authenticates the newline-delimited mac_input() header/ciphertext.
Verify HMAC before decrypting. OpenSSL is used only as a cipher implementation;
the password is passed in the child's environment, never command arguments.

Rows remain raw PostgreSQL JSON text so timestamps and bigint values can be
restored through PostgreSQL json_populate_record without client-side rounding.
Apply the pinned service migrations first; restore into a quiescent fresh DB
in foreign-key order. For identity fields use OVERRIDING SYSTEM VALUE; omit
generated columns. Audit triggers permit inserts and must remain enabled.
No schema definitions, external blobs or BoxLite disks are archived here.
"""
import hashlib
import hmac
import json
import os
import subprocess
import sys
from base64 import b64encode

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

SERVICE = "sandbox-provider"
ITERATIONS = 200000


def mac_input(envelope):
    return "\n".join(str(value) for value in (
        "workflow-agents-database-archive", envelope["version"], envelope["service"],
        envelope["cipher"], envelope["kdf"], envelope["iterations"],
        envelope["salt_b64"], envelope["mac_salt_b64"], envelope["ciphertext_b64"],
    )).encode()


def seal(snapshot, password):
    if not isinstance(password, str) or len(password) < 24:
        raise ValueError("Invalid archive key")
    plaintext = json.dumps(snapshot, separators=(",", ":"), ensure_ascii=False).encode()
    if len(plaintext) > 64 * 1024 * 1024:
        raise ValueError("Snapshot exceeds operator archive bound")
    environment = dict(os.environ, PHASE1_ARCHIVE_PASSWORD=password)
    encrypted = subprocess.run(
        ["openssl", "enc", "-aes-256-cbc", "-salt", "-pbkdf2", "-iter", str(ITERATIONS),
         "-md", "sha256", "-pass", "env:PHASE1_ARCHIVE_PASSWORD"],
        input=plaintext, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=environment, timeout=30, check=True,
    ).stdout
    # OpenSSL 3.0 defaults to 8 salt bytes; newer versions may default to16.
    # CBC ciphertext has a16-byte block size, making these formats distinct.
    salt_length = 8 if len(encrypted) % 16 == 0 else 16
    if encrypted[:8] != b"Salted__" or (len(encrypted) - 8 - salt_length) % 16:
        raise ValueError("Unsupported OpenSSL salted format")
    salt, ciphertext = encrypted[8:8 + salt_length], encrypted[8 + salt_length:]
    mac_salt = os.urandom(16)
    envelope = {
        "archive": "workflow-agents-database-archive", "version": 1,
        "service": SERVICE, "cipher": "aes-256-cbc+hmac-sha256",
        "kdf": "pbkdf2-hmac-sha256", "iterations": ITERATIONS,
        "salt_b64": b64encode(salt).decode(),
        "mac_salt_b64": b64encode(mac_salt).decode(),
        "ciphertext_b64": b64encode(ciphertext).decode(),
    }
    mac_key = hashlib.pbkdf2_hmac("sha256", password.encode(), mac_salt, ITERATIONS, 32)
    envelope["hmac_sha256"] = hmac.new(mac_key, mac_input(envelope), hashlib.sha256).hexdigest()
    return envelope


def collect(connection):
    with connection.transaction():
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        connection.execute("SET LOCAL TIME ZONE 'UTC'")
        connection.execute("SET LOCAL extra_float_digits=3")
        metadata = connection.execute("SELECT current_database() AS database, transaction_timestamp()::text AS snapshot_at, txid_current_snapshot()::text AS transaction_snapshot").fetchone()
        relations = connection.execute("SELECT n.nspname AS schema,c.relname AS name,c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY c.relname").fetchall()
        sequence_names = connection.execute("SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' ORDER BY c.relname").fetchall()

        def sequences():
            result = []
            for sequence in sequence_names:
                value = connection.execute(sql.SQL("SELECT last_value::text AS last_value,is_called FROM {}.{}").format(sql.Identifier(sequence["schema"]), sql.Identifier(sequence["name"]))).fetchone()
                result.append({**sequence, **value})
            return result

        before_sequences = sequences()
        tables = []
        for table in relations:
            columns = connection.execute("SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,a.attidentity AS identity,a.attgenerated AS generated,pg_get_expr(d.adbin,d.adrelid) AS default_expression FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=%s::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", (table["oid"],)).fetchall()
            foreign_keys = connection.execute("SELECT pn.nspname AS referenced_schema,pc.relname AS referenced_table,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class pc ON pc.oid=k.confrelid JOIN pg_namespace pn ON pn.oid=pc.relnamespace WHERE k.conrelid=%s::oid AND k.contype='f' ORDER BY k.conname", (table["oid"],)).fetchall()
            rows = [row["row_json"] for row in connection.execute(sql.SQL('SELECT to_jsonb(t)::text AS row_json FROM {}.{} t ORDER BY to_jsonb(t)::text COLLATE "C"').format(sql.Identifier(table["schema"]), sql.Identifier(table["name"]))).fetchall()]
            tables.append({"schema": table["schema"], "name": table["name"], "columns": columns,
                           "foreign_keys": foreign_keys, "row_count": len(rows),
                           "rows_sha256": hashlib.sha256("\n".join(rows).encode()).hexdigest(), "rows": rows})
        after_sequences = sequences()
        if before_sequences != after_sequences:
            raise RuntimeError("Sequence activity during export")
        return {"format": "workflow-agents-logical-snapshot", "version": 1, "service": SERVICE,
                **metadata, "schemas": ["public"], "tables": tables, "sequences": after_sequences,
                "scope": "logical database rows and sequence state only; no VM disks or schema definitions"}


def archive_password():
    explicit = os.getenv("PHASE1_ARCHIVE_PASSWORD")
    if explicit:
        return explicit
    policies = json.loads(os.environ["PROVIDER_AUTH_JSON"])
    policy = next(p for p in policies if "delegate_owners" not in p and "sandbox:destroy" in p.get("permissions", []))
    return policy["token"]


def main():
    try:
        with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row, connect_timeout=10) as connection:
            snapshot = collect(connection)
        print(json.dumps(seal(snapshot, archive_password()), separators=(",", ":")))
        return 0
    except Exception:
        print(json.dumps({"archive": "workflow-agents-database-archive", "service": SERVICE,
                          "error": "Logical archive export failed; no plaintext data emitted"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
