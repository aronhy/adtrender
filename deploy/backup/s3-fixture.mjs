import { createServer } from 'node:http';

export const probeKey = key => key.startsWith('.adtrender-restore-probe/');

// An HTTP fixture deliberately exercising the real SDK, including its headers.
export async function s3Fixture(t, { mode = 'supported', bucket = 'protocol-restore-test', objects = new Map() } = {}) {
  const traffic = [], violations = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const [, requestedBucket, ...parts] = url.pathname.split('/'), key = decodeURIComponent(parts.join('/'));
    const probe = probeKey(key);
    traffic.push({ method: req.method, key });
    const error = (status, code) => { res.writeHead(status, { 'content-type': 'application/xml' }); res.end(`<Error><Code>${code}</Code><Message>PRIVATE_PROVIDER_BODY</Message></Error>`); };
    try {
      if (requestedBucket !== bucket) return error(404, 'NoSuchBucket');
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${[...objects.keys()].map(key => `<Contents><Key>${key}</Key></Contents>`).join('')}</ListBucketResult>`); return;
      }
      if (req.method === 'GET') {
        const item = objects.get(key);
        if (!item) return error(404, 'NoSuchKey');
        res.writeHead(200, { 'content-type': item.contentType, 'content-length': item.bytes.length }); res.end(item.bytes); return;
      }
      if (req.method === 'PUT') {
        if (req.headers['if-none-match'] !== '*') { violations.push('MissingPrecondition'); return error(400, 'MissingPrecondition'); }
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const item = { bytes: Buffer.concat(chunks), contentType: req.headers['content-type'] };
        if (probe && mode === 'denied') return error(403, 'AccessDenied');
        if (probe && mode === 'first-disconnect') { objects.set(key, item); req.socket.destroy(); return; }
        if (objects.has(key) && mode !== 'ignored' && mode !== 'cleanup-denied') {
          if (mode === 'false-412') objects.set(key, item);
          if (mode === 'foreign-bytes') objects.set(key, { ...item, bytes: Buffer.from('belongs to another writer') });
          if (mode === 'server-error') return error(500, 'InternalError');
          if (mode === 'second-disconnect') { req.socket.destroy(); return; }
          return error(412, 'PreconditionFailed');
        }
        objects.set(key, item); res.writeHead(200, { ETag: '"fixture"' }); res.end(); return;
      }
      if (req.method === 'DELETE' && probe) {
        if (mode === 'cleanup-denied') return error(403, 'AccessDenied');
        if (mode !== 'delete-ignored') objects.delete(key);
        res.writeHead(204); res.end(); return;
      }
      violations.push('UnexpectedMutation'); error(405, 'MethodNotAllowed');
    } catch { violations.push('FixtureError'); if (!res.headersSent) error(500, 'InternalError'); else res.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { endpoint: `http://127.0.0.1:${server.address().port}`, bucket, objects, traffic, violations };
}
