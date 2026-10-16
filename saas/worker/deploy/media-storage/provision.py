#!/usr/bin/env python3
"""Host owner provisions one media-only role/config; never emits credentials."""
import os
import pathlib
import re
import secrets
import subprocess
import tempfile

PSQL = ['docker', 'exec', '-i', 'ds-meta-saas-test-database-1', 'psql', '-X', '-At', '-v',
        'ON_ERROR_STOP=1', '-U', 'saas_migrator', '-d', 'ad_research_test']
ROLE = 'media_storage_runtime'
GRANTS = '''GRANT CONNECT ON DATABASE ad_research_test TO media_storage_runtime;
GRANT USAGE ON SCHEMA public TO media_storage_runtime;
GRANT SELECT ON public."MediaObject" TO media_storage_runtime;
GRANT SELECT (id,"dataSourceId") ON public."Ad" TO media_storage_runtime;
GRANT SELECT (id,key) ON public."DataSource" TO media_storage_runtime;
GRANT UPDATE ("updatedAt",status,"errorCode","storageKey","mimeType","sizeBytes",sha256,type,"downloadedAt","expiresAt","downloadAttempts","lastDownloadAttemptAt","nextDownloadAttemptAt") ON public."MediaObject" TO media_storage_runtime;'''


def _write_exclusive(path, content):
    """Only complete, owner-readable files become visible; existing files are preserved."""
    fd, temporary_name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def provision(configuration=pathlib.Path('/etc/ad-media-storage.env'),
              application_environment=pathlib.Path('/etc/ad-research-test/app.env'),
              runtime_configuration=pathlib.Path('/etc/ad-media-storage-runtime.env'),
              command_runner=subprocess.check_output):
    def sql(value):
        return command_runner(PSQL, input=value, text=True).strip()

    # Resolve every prerequisite before creating a login or changing private files.
    allowed = {'S3_BUCKET', 'S3_REGION', 'S3_ENDPOINT', 'S3_FORCE_PATH_STYLE',
               'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'}
    environment = {}
    for line in application_environment.read_text().splitlines():
        if '=' in line:
            key, value = line.split('=', 1)
            if key in allowed:
                environment[key] = value
    if not all(environment.get(key) for key in ['S3_BUCKET', 'S3_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']):
        raise RuntimeError('STORAGE_CONFIGURATION_MISSING')
    # The general worker may carry an independent hotfix. Use the unchanged
    # API image as the dependency baseline for this standalone media service.
    image = command_runner(['docker', 'inspect', 'ds-meta-saas-test-api-1', '--format', '{{.Image}}'], text=True).strip()
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
        raise RuntimeError('IMMUTABLE_IMAGE_REQUIRED')
    runtime_content = 'MEDIA_IMAGE=' + image + '\n'
    if configuration.is_symlink() or runtime_configuration.is_symlink():
        raise RuntimeError('PRIVATE_CONFIGURATION_PATH_REJECTED')
    if runtime_configuration.exists() and runtime_configuration.read_text() != runtime_content:
        raise RuntimeError('PINNED_IMAGE_DRIFT_REQUIRES_REVIEW')
    exists = sql("SELECT count(*) FROM pg_roles WHERE rolname='media_storage_runtime';") == '1'
    if exists and not configuration.is_file():
        raise RuntimeError('ROLE_EXISTS_WITHOUT_PRIVATE_CONFIG')
    if not exists and configuration.exists():
        raise RuntimeError('PRIVATE_CONFIG_EXISTS_WITHOUT_ROLE')

    role_created = configuration_created = runtime_created = False
    try:
        if not exists:
            password = secrets.token_urlsafe(36)
            # A failure during CREATE/ALTER leaves no partially created role.
            sql("BEGIN; CREATE ROLE media_storage_runtime LOGIN PASSWORD '" + password + "' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 8; ALTER ROLE media_storage_runtime SET statement_timeout='150s'; ALTER ROLE media_storage_runtime SET idle_in_transaction_session_timeout='180s'; COMMIT;")
            role_created = True
            content = 'DATABASE_URL=postgresql://media_storage_runtime:' + password + '@database:5432/ad_research_test?schema=public&connection_limit=4&pool_timeout=10\nMEDIA_STATE_DIR=/data\n'
            content += ''.join(key + '=' + value + '\n' for key, value in sorted(environment.items()))
            _write_exclusive(configuration, content)
            configuration_created = True
        configuration.chmod(0o600)
        sql('BEGIN; ' + GRANTS + ' COMMIT;')
        if not runtime_configuration.exists():
            _write_exclusive(runtime_configuration, runtime_content)
            runtime_created = True
        runtime_configuration.chmod(0o600)
    except Exception:
        # Never remove a role or configuration that predated this invocation.
        if role_created:
            try:
                sql('BEGIN; DROP OWNED BY media_storage_runtime; DROP ROLE media_storage_runtime; COMMIT;')
            except Exception:
                raise RuntimeError('PROVISION_CLEANUP_REQUIRED') from None
        if configuration_created:
            configuration.unlink(missing_ok=True)
        if runtime_created:
            runtime_configuration.unlink(missing_ok=True)
        raise
    print('MEDIA_ROLE_AND_PRIVATE_CONFIGURATION_READY')


if __name__ == '__main__':
    provision()
