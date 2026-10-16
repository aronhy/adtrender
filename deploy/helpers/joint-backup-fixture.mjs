import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');

// Synthetic public media, private research and one evidence object shared by three reference kinds.
export async function seedJointBackupFixture(db) {
  const suffix = randomUUID().replaceAll('-', '');
  const user = await db.user.create({ data: { email: `joint-${suffix}@example.test` } });
  const organization = await db.organization.create({ data: { name: 'Synthetic restore team', slug: suffix, members: { create: { userId: user.id, role: 'OWNER' } }, workspaces: { create: { name: 'Synthetic workspace', slug: 'fixture' } } }, include: { workspaces: true } });
  const workspace = organization.workspaces[0];
  const dataSource = await db.dataSource.create({ data: { key: suffix, name: 'Synthetic backup evidence', adapterVersion: 'fixture', status: 'DISABLED' } });
  const ad = await db.ad.create({ data: { dataSourceId: dataSource.id, sourceAdId: suffix, sourceUrl: 'https://example.invalid/synthetic', body: 'Synthetic backup record' } });
  const saved = await db.savedAd.create({ data: { organizationId: organization.id, workspaceId: workspace.id, adId: ad.id, savedByUserId: user.id } });
  const note = await db.note.create({ data: { organizationId: organization.id, workspaceId: workspace.id, savedAdId: saved.id, authorUserId: user.id, body: '联合恢复测试私有笔记，不是真实客户数据。' } });
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCykAAAAASUVORK5CYII=', 'base64');
  const video = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
  const evidence = Buffer.from(JSON.stringify({ fixture: true, source: 'synthetic', ad: ad.id }));
  const imageKey = `public-media/${randomUUID()}`, privateKey = `private/${organization.id}/${workspace.id}/${randomUUID()}`, evidenceKey = `private-source-evidence/fixture-run/${randomUUID()}.json`;
  await db.mediaObject.create({ data: { adId: ad.id, sourceUrl: 'https://example.invalid/synthetic.png', type: 'IMAGE', status: 'READY', storageKey: imageKey, mimeType: 'image/png', sizeBytes: BigInt(image.length), sha256: hash(image) } });
  const privateFile = await db.privateFile.create({ data: { organizationId: organization.id, workspaceId: workspace.id, storageKey: privateKey, filename: 'synthetic.mp4', status: 'READY', mimeType: 'video/mp4', sizeBytes: BigInt(video.length), sha256: hash(video) } });
  const task = await db.collectionTask.create({ data: { dataSourceId: dataSource.id, name: 'Synthetic evidence only', query: {}, status: 'PAUSED' } });
  const run = await db.collectionRun.create({ data: { taskId: task.id, dataSourceId: dataSource.id, idempotencyKey: suffix, querySnapshot: {}, adapterVersion: 'fixture', evidenceReference: 's3:' + evidenceKey } });
  await db.runItem.create({ data: { runId: run.id, dataSourceId: dataSource.id, itemKey: 'fixture', parserVersion: 'fixture', evidenceReference: 's3:' + evidenceKey, evidenceSha256: hash(evidence) } });
  await db.adObservation.create({ data: { adId: ad.id, dataSourceId: dataSource.id, collectionRunId: run.id, observedAt: new Date(), snapshot: { fixture: true }, parserVersion: 'fixture', evidenceReference: 's3:' + evidenceKey, evidenceSha256: hash(evidence) } });
  const sourceObjects = new Map([[imageKey, { bytes: image, contentType: 'image/png' }], [privateKey, { bytes: video, contentType: 'video/mp4' }], [evidenceKey, { bytes: evidence, contentType: 'application/json' }]]);
  return { note, privateFile, organization, workspace, user, sourceObjects };
}
