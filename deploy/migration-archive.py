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
from base64 import b64encode, b64decode

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


def unseal(envelope, password):
    if (envelope.get("archive") != "workflow-agents-database-archive" or
            envelope.get("version") != 1 or envelope.get("service") != SERVICE or
            envelope.get("cipher") != "aes-256-cbc+hmac-sha256" or
            envelope.get("kdf") != "pbkdf2-hmac-sha256" or
            envelope.get("iterations") != ITERATIONS):
        raise ValueError("archive_envelope_invalid")
    salt = b64decode(envelope["salt_b64"], validate=True)
    mac_salt = b64decode(envelope["mac_salt_b64"], validate=True)
    ciphertext = b64decode(envelope["ciphertext_b64"], validate=True)
    if len(salt) != 8 or len(mac_salt) != 16 or not ciphertext or len(ciphertext) % 16 or len(ciphertext) > 64 * 1024 * 1024:
        raise ValueError("archive_envelope_invalid")
    mac_key = hashlib.pbkdf2_hmac("sha256", password.encode(), mac_salt, ITERATIONS, 32)
    expected = hmac.new(mac_key, mac_input(envelope), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, envelope.get("hmac_sha256", "")):
        raise ValueError("archive_authentication_failed")
    # Pinned Debian Bookworm OpenSSL uses the8-byte salt format. Newer external
    # envelopes must be decrypted/resealed offline to this supported format.
    result = subprocess.run(
        ["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", str(ITERATIONS),
         "-md", "sha256", "-S", salt.hex(), "-pass", "env:PHASE1_ARCHIVE_PASSWORD"],
        input=ciphertext, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=dict(os.environ, PHASE1_ARCHIVE_PASSWORD=password), timeout=30, check=True,
    ).stdout
    snapshot = json.loads(result)
    if snapshot.get("service") != SERVICE:
        raise ValueError("archive_service_mismatch")
    return snapshot


def row_digest(rows):
    return hashlib.sha256("\n".join(rows).encode()).hexdigest()


def normalized_row(raw, ignored):
    value = json.loads(raw)
    for field in ignored:
        value.pop(field, None)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def restore(connection, snapshot, *, allow_bootstrap_metadata=False, allow_retained_runtime_records=False):
    if (snapshot.get("format") != "workflow-agents-logical-snapshot" or snapshot.get("version") != 1 or
            snapshot.get("service") != SERVICE or snapshot.get("schemas") != ["public"] or
            not isinstance(snapshot.get("tables"), list) or not isinstance(snapshot.get("sequences"), list)):
        raise ValueError("archive_snapshot_invalid")
    by_name = {table["schema"] + "." + table["name"]: table for table in snapshot["tables"]}
    if len(by_name) != len(snapshot["tables"]):
        raise ValueError("archive_snapshot_invalid")
    for table in snapshot["tables"]:
        if (table["schema"] != "public" or not isinstance(table.get("rows"), list) or
                table.get("row_count") != len(table["rows"]) or row_digest(table["rows"]) != table.get("rows_sha256")):
            raise ValueError("archive_snapshot_invalid")
        if table["name"] == "runs" and any(json.loads(row)["status"] in {"queued", "running", "cancelling"} for row in table["rows"]):
            raise ValueError("archive_source_not_quiescent")
        # Destroyed identities are audit tombstones; no guest disk is expected
        # to exist. Retained live identities still require a coordinated set.
        if table["name"] == "sandboxes" and not allow_retained_runtime_records and any(
                json.loads(row).get("runtime_id") and json.loads(row).get("status") != "destroyed"
                for row in table["rows"]):
            raise ValueError("archive_requires_coordinated_runtime_volume")
    with connection.transaction():
        connection.execute("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        connection.execute("SET LOCAL TIME ZONE 'UTC'")
        connection.execute("SET LOCAL extra_float_digits=3")
        connection.execute("SET LOCAL lock_timeout='15s'")
        connection.execute("SELECT pg_advisory_xact_lock(hashtextextended('workflow-agents-migration-restore:sandbox-provider',0))")
        targets = connection.execute("SELECT n.nspname AS schema,c.relname AS name,c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY c.relname").fetchall()
        if [table["schema"] + "." + table["name"] for table in targets] != sorted(by_name):
            raise ValueError("archive_destination_schema_mismatch")
        connection.execute(sql.SQL("LOCK TABLE {} IN ACCESS EXCLUSIVE MODE").format(sql.SQL(",").join(sql.Identifier(table["schema"], table["name"]) for table in targets)))
        destination_sequences = connection.execute("SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' ORDER BY c.relname").fetchall()
        if destination_sequences != [{key: value[key] for key in ("schema", "name")} for value in snapshot["sequences"]]:
            raise ValueError("archive_destination_sequence_mismatch")
        reconciled = 0
        for target in targets:
            table = by_name[target["schema"] + "." + target["name"]]
            columns = connection.execute("SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,a.attidentity AS identity,a.attgenerated AS generated FROM pg_attribute a WHERE a.attrelid=%s::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", (target["oid"],)).fetchall()
            fields = ("name", "type", "not_null", "identity", "generated")
            if columns != [{key: value[key] for key in fields} for value in table["columns"]]:
                raise ValueError("archive_destination_schema_mismatch")
            target_rows = [row["row_json"] for row in connection.execute(sql.SQL('SELECT to_jsonb(t)::text AS row_json FROM {} t ORDER BY to_jsonb(t)::text COLLATE "C"').format(sql.Identifier(target["schema"], target["name"]))).fetchall()]
            source_set = set(table["rows"])
            mismatches = [row for row in target_rows if row not in source_set]
            if mismatches:
                if not allow_bootstrap_metadata or target["name"] != "schema_migrations":
                    raise ValueError("archive_destination_rows_conflict")
                ignored = ["applied_at"]
                if sorted(normalized_row(row, ignored) for row in target_rows) != sorted(normalized_row(row, ignored) for row in table["rows"]):
                    raise ValueError("archive_bootstrap_semantics_mismatch")
                primary = [row["name"] for row in connection.execute("SELECT a.attname AS name FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY p(attnum,ord) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=p.attnum WHERE k.conrelid=%s::oid AND k.contype='p' ORDER BY p.ord", (target["oid"],)).fetchall()]
                if not primary:
                    raise ValueError("archive_bootstrap_primary_key_missing")
                statement = sql.SQL("UPDATE {} t SET {} FROM json_populate_record(NULL::{},%s::json) s WHERE {}").format(
                    sql.Identifier(target["schema"], target["name"]),
                    sql.SQL(",").join(sql.SQL("{}=s.{}").format(sql.Identifier(field), sql.Identifier(field)) for field in ignored),
                    sql.Identifier(target["schema"], target["name"]),
                    sql.SQL(" AND ").join(sql.SQL("t.{} IS NOT DISTINCT FROM s.{}").format(sql.Identifier(field), sql.Identifier(field)) for field in primary),
                )
                for row in table["rows"]:
                    connection.execute(statement, (row,))
                reconciled += len(mismatches)
        remaining, ordered = dict(by_name), []
        while remaining:
            progress = False
            for name, table in list(remaining.items()):
                if all(foreign["referenced_schema"] + "." + foreign["referenced_table"] not in remaining or foreign["referenced_schema"] + "." + foreign["referenced_table"] == name for foreign in table.get("foreign_keys", [])):
                    ordered.append(table)
                    del remaining[name]
                    progress = True
            if not progress:
                raise ValueError("archive_foreign_key_cycle")
        for table in ordered:
            columns = [column["name"] for column in table["columns"] if not column["generated"]]
            column_sql = sql.SQL(",").join(sql.Identifier(column) for column in columns)
            relation = sql.Identifier(table["schema"], table["name"])
            statement = sql.SQL("INSERT INTO {}({}) OVERRIDING SYSTEM VALUE SELECT {} FROM json_populate_record(NULL::{},%s::json) ON CONFLICT DO NOTHING").format(relation, column_sql, column_sql, relation)
            for row in table["rows"]:
                connection.execute(statement, (row,))
        results = []
        for table in ordered:
            rows = [row["row_json"] for row in connection.execute(sql.SQL('SELECT to_jsonb(t)::text AS row_json FROM {} t ORDER BY to_jsonb(t)::text COLLATE "C"').format(sql.Identifier(table["schema"], table["name"]))).fetchall()]
            if len(rows) != table["row_count"] or row_digest(rows) != table["rows_sha256"]:
                raise ValueError("archive_restored_rows_mismatch")
            results.append({"table": table["schema"] + "." + table["name"], "rows": len(rows), "rows_sha256": table["rows_sha256"]})
        # setval is not transactional. Keep destination quiescent until success;
        # replay the same archive after any interrupted/failed restore.
        for sequence in snapshot["sequences"]:
            if not isinstance(sequence["last_value"], str) or not sequence["last_value"].isdigit() or not isinstance(sequence["is_called"], bool):
                raise ValueError("archive_sequence_invalid")
            connection.execute("SELECT setval(%s::regclass,%s::bigint,%s)", (sql.Identifier(sequence["schema"], sequence["name"]).as_string(connection), sequence["last_value"], sequence["is_called"]))
    return {"operation": "logical-database-restore", "service": SERVICE, "outcome": "passed", "tables": results,
            "sequences": len(snapshot["sequences"]), "bootstrap_timestamp_rows_reconciled": reconciled,
            "scope": "logical rows only; no VM disk or host recovery proof"}


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
            if "--restore" in sys.argv:
                raw = os.getenv("PHASE1_ARCHIVE_ENVELOPE") or sys.stdin.read(100 * 1024 * 1024 + 1)
                if len(raw) > 100 * 1024 * 1024:
                    raise ValueError("archive_envelope_invalid")
                snapshot = unseal(json.loads(raw), archive_password())
                result = restore(connection, snapshot, allow_bootstrap_metadata="--allow-bootstrap-metadata" in sys.argv,
                                 allow_retained_runtime_records="--allow-retained-runtime-records" in sys.argv)
            else:
                result = seal(collect(connection), archive_password())
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and str(error).startswith("archive_") and all(character.islower() or character == "_" for character in str(error)) else "archive_operation_failed"
        print(json.dumps({"archive": "workflow-agents-database-archive", "service": SERVICE,
                          "error": code}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
