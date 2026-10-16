import { createServer, type RequestListener } from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalS3Provider } from './local-media';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function server(handler: RequestListener) {
  const instance = createServer(handler); await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { instance.closeAllConnections(); instance.close(error => error ? reject(error) : resolve()); }));
  return `http://127.0.0.1:${(instance.address() as { port: number }).port}`;
}
const credentials = { accessKeyId: 'local-fixture-only', secretAccessKey: 'synthetic-fixture-only' };
const fixture = Buffer.from([0xff, 0xd8, 0xff, 4, 5, 6]);
const sha256 = createHash('sha256').update(fixture).digest('hex');
describe('local S3 SDK transport boundary', () => {
  it('uses path-style isolated storage and conditional PUT, then reads the stored bytes', async () => {
    let value: Buffer | undefined; let conditional: string | undefined; let checksum: string | undefined; const paths: string[] = [];
    const endpoint = await server(async (req, res) => {
      paths.push(req.url!);
      if (req.method === 'PUT') {
        conditional = req.headers['if-none-match'] as string; checksum = req.headers['x-amz-checksum-sha256'] as string;
        if (value) { res.writeHead(412, { 'content-type': 'application/xml' }).end('<Error><Code>PreconditionFailed</Code></Error>'); return; }
        const chunks = []; for await (const chunk of req) chunks.push(chunk); value = Buffer.concat(chunks); res.writeHead(200).end();
      } else if (!value) res.writeHead(404).end();
      else res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': value.length }).end(value);
    });
    const provider = createLocalS3Provider({ endpoint, bucket: 'saas-migration-test-transport' }, credentials); cleanup.push(() => provider.close());
    const args = { key: 'public-media/fixture', maxBytes: fixture.length };
    expect(await provider.get(args)).toBeNull();
    expect(await provider.putIfAbsent({ ...args, bytes: fixture, mimeType: 'image/jpeg', sha256 })).toBe('CREATED');
    expect(conditional).toBe('*'); expect(checksum).toBe(Buffer.from(sha256, 'hex').toString('base64'));
    expect(await provider.get(args)).toEqual({ bytes: fixture, mimeType: 'image/jpeg' });
    expect(await provider.putIfAbsent({ ...args, bytes: Buffer.from('replacement'), mimeType: 'image/jpeg', sha256 })).toBe('EXISTS');
    expect(value).toEqual(fixture); expect(paths.every(path => path.startsWith('/saas-migration-test-transport/public-media/fixture'))).toBe(true);
  });
  it.each([true, false])('limits readback using both declared and streamed bytes (length header=%s)', async declared => {
    const endpoint = await server((_req, res) => { res.writeHead(200, { 'content-type': 'image/jpeg', ...(declared ? { 'content-length': 1000 } : {}) }); res.write(Buffer.alloc(40)); res.end(); });
    const provider = createLocalS3Provider({ endpoint, bucket: 'saas-migration-test-transport' }, credentials); cleanup.push(() => provider.close());
    await expect(provider.get({ key: 'public-media/fixture', maxBytes: 10 })).rejects.toThrow('LEGACY_MEDIA_SIZE_LIMIT');
  });
  it('does not follow an HTTP redirect out of the explicitly supplied endpoint', async () => {
    let leaked = 0; const other = await server((_req, res) => { leaked++; res.end('wrong'); });
    const endpoint = await server((_req, res) => { res.writeHead(302, { location: `${other}/not-allowed` }).end(); });
    const provider = createLocalS3Provider({ endpoint, bucket: 'saas-migration-test-transport' }, credentials); cleanup.push(() => provider.close());
    await expect(provider.get({ key: 'public-media/fixture', maxBytes: 10 })).rejects.toThrow(); expect(leaked).toBe(0);
  });
  it('does not fall back to ambient cloud credentials', () => {
    expect(() => createLocalS3Provider({ endpoint: 'http://127.0.0.1:13991', bucket: 'saas-migration-test-transport' }, { accessKeyId: '', secretAccessKey: '' })).toThrow('MEDIA_CREDENTIALS_REQUIRED');
  });
});
