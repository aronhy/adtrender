import { describe, expect, it, vi } from 'vitest';
import { installNativeTestIngest, nativeIngestSqlPaths, ownedNativeIngestDatabase } from './native-test-ingest';
import type { NativeIngestSetupIO } from './native-test-ingest';

const url = 'postgresql://test_user:synthetic-password@127.0.0.1:55469/adthrender_test_native_fixture';
const argvUrl = 'postgresql://test_user@127.0.0.1:55469/adthrender_test_native_fixture';
const owned = { SAAS_TEST_DATABASE_URL: url, SAAS_OWNED_TEST_DATABASE_URL: url, PATH: '/fixture/bin', PG_BIN: '/fixture/pg/bin' };

describe('owned isolated native ingestion test prerequisites', () => {
  it('skips without an explicit SaaS test database and never falls back to the business database', () => {
    const io = { read: vi.fn(), execute: vi.fn() };
    expect(ownedNativeIngestDatabase({ DATABASE_URL: url })).toBeNull();
    expect(installNativeTestIngest({ DATABASE_URL: url }, io)).toEqual({ skipped: true });
    expect(io.read).not.toHaveBeenCalled(); expect(io.execute).not.toHaveBeenCalled();
  });
  it.each([
    { SAAS_TEST_DATABASE_URL: url },
    { SAAS_TEST_DATABASE_URL: url, SAAS_OWNED_TEST_DATABASE_URL: url + '?schema=public' },
    { SAAS_TEST_DATABASE_URL: 'postgresql://user@db.example.test/adthrender_test_fixture', SAAS_OWNED_TEST_DATABASE_URL: 'postgresql://user@db.example.test/adthrender_test_fixture' },
    { SAAS_TEST_DATABASE_URL: 'postgresql://user@127.0.0.1/production', SAAS_OWNED_TEST_DATABASE_URL: 'postgresql://user@127.0.0.1/production' },
    { SAAS_TEST_DATABASE_URL: 'https://127.0.0.1/adthrender_test_fixture', SAAS_OWNED_TEST_DATABASE_URL: 'https://127.0.0.1/adthrender_test_fixture' },
    { SAAS_TEST_DATABASE_URL: url + '?host=external.example.test', SAAS_OWNED_TEST_DATABASE_URL: url + '?host=external.example.test' },
    { SAAS_TEST_DATABASE_URL: url + '?service=production', SAAS_OWNED_TEST_DATABASE_URL: url + '?service=production' },
    { SAAS_TEST_DATABASE_URL: url + '#private', SAAS_OWNED_TEST_DATABASE_URL: url + '#private' },
  ])('fails closed before reading SQL or executing psql for unsafe ownership/configuration', env => {
    const io = { read: vi.fn(), execute: vi.fn() };
    expect(() => installNativeTestIngest(env, io)).toThrow('OWNED_LOCAL_SAAS_TEST_DATABASE_REQUIRED');
    expect(io.read).not.toHaveBeenCalled(); expect(io.execute).not.toHaveBeenCalled();
  });
  it.each(['127.0.0.1', 'localhost', '[::1]'])('accepts only explicit owned loopback database %s', hostname => {
    const value = 'postgresql://user@' + hostname + ':55469/adthrender_test_fixture?schema=public';
    expect(ownedNativeIngestDatabase({ SAAS_TEST_DATABASE_URL: value, SAAS_OWNED_TEST_DATABASE_URL: value })).toBe(value.split('?')[0]);
  });
  it('installs all five existing SQL files once, strips collector-role grants, and isolates the psql environment', () => {
    const io = { read: vi.fn((path: string) => `-- ${path}\nCREATE SCHEMA test_fixture;\nGRANT EXECUTE ON FUNCTION test_fixture.ingest(text) TO collector_role;\nREVOKE ALL ON SCHEMA test_fixture FROM PUBLIC;\n`), execute: vi.fn<NativeIngestSetupIO['execute']>() };
    expect(nativeIngestSqlPaths.map(path => path.split('/').slice(-2).join('/'))).toEqual(['meta/ingest.sql', 'google/ingest.sql', 'snapchat/ingest.sql', 'tiktok/ingest.sql', 'pinterest/ingest.sql']);
    expect(installNativeTestIngest({ ...owned, PGPASSWORD: 'never-inherit', PGSERVICE: 'production', HOME: '/private-home' }, io)).toEqual({ skipped: false });
    expect(io.read.mock.calls.map(call => call[0])).toEqual(nativeIngestSqlPaths);
    expect(io.execute).toHaveBeenCalledOnce();
    const [binary, args, options] = io.execute.mock.calls[0];
    expect(binary).toBe('/fixture/pg/bin/psql'); expect(args).toEqual([argvUrl, '-X', '-v', 'ON_ERROR_STOP=1']);
    expect(ownedNativeIngestDatabase(owned)).toBe(argvUrl); expect(args.join(' ')).not.toContain('synthetic-password');
    expect(options.input).not.toMatch(/^GRANT/m); expect(options.input.match(/CREATE SCHEMA/g)).toHaveLength(5); expect(options.input).toContain('REVOKE ALL');
    expect(options.env).toEqual({ PATH: '/fixture/bin', PGPASSFILE: '/dev/null', PGCONNECT_TIMEOUT: '10', PGAPPNAME: 'adthrender-native-test-ingest', PGPASSWORD: 'synthetic-password' });
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });
  it('never exposes SQL, connection credentials or child stderr when initialization fails', () => {
    const io = { read: vi.fn(() => 'SELECT 1;'), execute: vi.fn(() => { throw new Error('psql ' + url + ' private SQL provider details'); }) };
    expect(() => installNativeTestIngest(owned, io)).toThrow('NATIVE_TEST_INGEST_SETUP_FAILED');
    try { installNativeTestIngest(owned, io); } catch (error) { expect(String(error)).not.toMatch(/synthetic-password|provider details|SELECT/); }
  });
});
