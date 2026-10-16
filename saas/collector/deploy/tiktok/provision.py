#!/usr/bin/env python3
"""Run as deployment owner on the existing collector host. Never prints secrets."""
import os
import pathlib
import re
import secrets
import stat
import subprocess

ROLE = "tiktok_collector_runtime"
CONFIG = pathlib.Path("/etc/tiktok-collector.env")
RUNTIME = pathlib.Path("/etc/tiktok-collector-runtime.env")
PSQL = ["docker", "exec", "-i", "ds-meta-saas-test-database-1", "psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-U", "saas_migrator", "-d", "ad_research_test"]


def sql(statement):
    result = subprocess.run(PSQL, input=statement, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError("PROVISION_SQL_FAILED")
    return result.stdout.strip()


def private_existing(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise RuntimeError("CONFIG_MUST_BE_OWNER_ONLY_REGULAR_FILE")
    return path.read_text()


def atomic_private(path, content):
    pending = path.with_name(path.name + ".pending-" + secrets.token_hex(6))
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(pending, path)
    finally:
        pending.unlink(missing_ok=True)


def main():
    # Pin an existing trusted application image before creating credentials.
    image = os.environ.get("TIKTOK_IMAGE")
    if not image and RUNTIME.exists():
        runtime_text = private_existing(RUNTIME)
        image = next((line.removeprefix("TIKTOK_IMAGE=") for line in runtime_text.splitlines() if line.startswith("TIKTOK_IMAGE=")), None)
    if not image:
        for container in ("meta-collector", "pinterest-collector"):
            result = subprocess.run(["docker", "inspect", container, "--format", "{{.Image}}"], text=True, capture_output=True)
            if result.returncode == 0:
                image = result.stdout.strip()
                break
    if not image or not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise RuntimeError("IMMUTABLE_IMAGE_REQUIRED")

    exists = sql(f"SELECT count(*) FROM pg_roles WHERE rolname='{ROLE}';") == "1"
    if exists:
        if not CONFIG.exists():
            raise RuntimeError("ROLE_EXISTS_WITHOUT_CONFIG")
        config = private_existing(CONFIG)
        if not re.search(r"^DATABASE_URL=postgresql://tiktok_collector_runtime:[^\s@]+@database:5432/ad_research_test\?schema=public$", config, re.M):
            raise RuntimeError("EXISTING_CONFIG_INVALID")
        if "TIKTOK_STATE_DIR=/data" not in config.splitlines():
            raise RuntimeError("EXISTING_STATE_DIR_INVALID")
    else:
        if CONFIG.exists() or CONFIG.is_symlink():
            raise RuntimeError("CONFIG_EXISTS_WITHOUT_ROLE")
        password = secrets.token_urlsafe(36)
        # Persist first so interruption can be repaired without rotating another
        # role's password. A stale config fails closed on the next invocation.
        atomic_private(CONFIG, f"DATABASE_URL=postgresql://{ROLE}:{password}@database:5432/ad_research_test?schema=public\nTIKTOK_STATE_DIR=/data\n")
        sql(f"BEGIN; CREATE ROLE {ROLE} LOGIN PASSWORD '{password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3; ALTER ROLE {ROLE} SET statement_timeout='30s'; ALTER ROLE {ROLE} SET idle_in_transaction_session_timeout='60s'; COMMIT;")

    unsafe = sql(f"""SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls OR NOT rolcanlogin
      OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid)
      OR has_schema_privilege('{ROLE}','public','CREATE')
      OR has_database_privilege('{ROLE}',current_database(),'TEMP')
      OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
       AND has_table_privilege('{ROLE}',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
      FROM pg_roles r WHERE rolname='{ROLE}';""")
    if unsafe != "f":
        raise RuntimeError("RUNTIME_ROLE_PRIVILEGES_UNSAFE")
    sql("""INSERT INTO public."DataSource"(id,"updatedAt",key,name,status,"adapterVersion",capabilities)
      VALUES(gen_random_uuid()::text,now(),'tiktok_commercial_library','TikTok Commercial Content Library','PAUSED','tiktok-public-dom-1','{"automatedCollectorVerified":false}'::jsonb)
      ON CONFLICT (key) DO NOTHING;""")
    sql(pathlib.Path(__file__).with_name("ingest.sql").read_text())
    atomic_private(RUNTIME, f"TIKTOK_IMAGE={image}\n")
    print("tiktok_runtime_role_and_function_ready")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never leak subprocess input, database URLs, passwords or page content.
        print(str(error) if isinstance(error, RuntimeError) else "TIKTOK_PROVISION_FAILED", file=__import__("sys").stderr)
        raise SystemExit(1)
