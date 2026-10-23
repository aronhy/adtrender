// Sent to Node stdin in the API container; imports use the packaged application.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { S3Storage, putPrivateFile, signPrivateFile, deletePrivateFile } from './src/media/storage.ts';

assert.equal(process.env.SELFHOST_SMOKE, '1');
assert.equal(process.env.WASP_SERVER_URL, 'https://api.localhost');
assert.equal(process.env.SMTP_HOST, 'mailpit');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'postgres');
const db = new PrismaClient();
const storage = new S3Storage({ bucket: process.env.S3_BUCKET, region: process.env.S3_REGION, endpoint: process.env.S3_ENDPOINT, forcePathStyle: true, maxAttempts: 1, requestHandler: { requestTimeout: 10000, connectionTimeout: 5000 } });
let stage = 'fixtures';
try {
  const owner = await db.user.findUniqueOrThrow({ where: { email: 'owner@example.test' } });
  const outsider = await db.user.findUniqueOrThrow({ where: { email: 'member@example.test' } });
  const workspace = await db.workspace.findFirstOrThrow({ where: { name: 'Smoke owner@example.test' } });
  assert.equal(owner.isAdmin, true);
  assert.equal(outsider.isAdmin, false);
  assert.equal(await db.auditEvent.count({ where: { action: 'PLATFORM_ADMIN_GRANTED', targetId: owner.id } }), 1);
  const mail = await db.emailDelivery.findMany({ where: { recipientEmail: { in: [owner.email, outsider.email] } } });
  assert.equal(mail.length, 2);
  assert(mail.every(row => row.status === 'SENT' && row.encryptedPayload === null));
  console.log('SELFHOST_PASS delivered-mail-payloads-cleared-and-admin-grant-audited');

  stage = 'private-upload';
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6xksAAAAASUVORK5CYII=', 'base64');
  const file = await putPrivateFile(db, owner.id, workspace.id, { bytes, mimeType: 'image/png', filename: 'smoke.png' }, storage);
  const signed = await signPrivateFile(db, owner.id, file.id, storage);
  const url = new URL(signed.url);
  assert.equal(url.origin, process.env.S3_ENDPOINT);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  const received = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(received).digest('hex'), file.sha256);
  assert.deepEqual(received, bytes);
  console.log('SELFHOST_PASS real-garage-private-upload-and-signed-download');

  stage = 'access-denial';
  await assert.rejects(() => signPrivateFile(db, outsider.id, file.id, storage), { status: 403 });
  const unsigned = new URL(url.pathname, url.origin);
  assert.equal((await fetch(unsigned, { signal: AbortSignal.timeout(10000) })).status, 403);
  console.log('SELFHOST_PASS cross-organization-signing-and-unsigned-storage-access-denied');

  stage = 'delete';
  await deletePrivateFile(db, owner.id, file.id, storage);
  await assert.rejects(() => signPrivateFile(db, owner.id, file.id, storage), { status: 409 });
  assert.equal((await fetch(url, { signal: AbortSignal.timeout(10000) })).status, 404);
  console.log('SELFHOST_PASS garage-object-deleted-and-file-no-longer-signable');
} catch (error) {
  console.error(`SELFHOST_STORAGE_FAILED stage=${stage} kind=${error.name}`);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
