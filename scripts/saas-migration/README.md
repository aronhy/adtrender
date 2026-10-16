# 旧广告只读盘点（S21 第一部分）

`inventory.ts` 读取指定 `ads.json`，生成只含计数和 SHA-256 的 manifest。它不导入旧服务、不连接数据库或网络、不修改输入、不启停任务。`import-public.ts` 提供显式确认后的本机测试库导入；`local-media.ts` 提供单独批准的本地媒体演练。正式切换和旧入口归档未执行。

## 使用

在仓库根目录执行；输出目录须已存在，输出文件必须不存在：

```sh
node --import tsx scripts/saas-migration/inventory.ts \
  --input data/ads.json \
  --output /tmp/ds-meta-legacy-inventory.json \
  --ownership public \
  --media-root data/media
```

- `--input`、`--output` 必填。输入支持 `{ "ads": [...] }` 或广告数组；数字 ID 必须存为字符串，避免精度丢失。
- `--ownership public|unknown` 默认为 `unknown`。`public` 表示操作者已把该输入文件列为公共来源候选；它不证明发布授权，也不会覆盖输入中已有的 tenant/workspace/owner 或私有标记。未声明归属全部隔离。
- `--media-root` 可选，仅列出该目录第一层的普通文件；不跟随文件符号链接、不下载媒体。省略时 `checked=false`、`missingCount=null`，不能解释为媒体完整。
- 输出使用独占创建和 `0600` 权限。重复使用已存在的输出路径报 `INVENTORY_OUTPUT_EXISTS`，不会覆盖源文件、已有 manifest 或符号链接。重跑请另选输出路径。
- CLI 成功无标准输出；失败仅输出固定错误码，不输出原始异常、输入值或路径。

## 统计口径

| 字段 | 含义 |
| --- | --- |
| `sha256` | 输入文件完整原始字节的 SHA-256；空白变化也会变化 |
| `inputCount` / `eligibleCount` | 原始数组项数 / 未命中隔离规则的候选行数；候选不等于已批准导入 |
| `uniqueStableIds` | 可解析的 `libraryId` 或可信来源 URL ID 数量，包含隔离行；不代表可导入广告数 |
| `variants.repeatedStableIdRows` | 同一来源 ID 第一行之外的行数，不等于需要丢弃的重复素材 |
| `variants.multiVariantGroups` | 同一来源 ID 下存在多个不同有效 `variantIndex` 的组数 |
| `variants.duplicateVariantRows` | 同一来源 ID＋同一有效 `variantIndex` 的重复行；缺索引时不猜测重复 |
| `missingObservationTimeCount` | collectedAt / lastCollectedAt / firstCollectedAt 均没有有效 ISO 时间的行数；不以导入时间补齐 |
| `unknownPlatformCount` | 没有可识别来源 publisher platform 的行数；facebook.com 来源链接不会自动补 Facebook |
| `localMedia.references` / `uniqueReferences` | 安全的 `/local-media/<单个文件名>` 引用行数 / 去重引用数，包含隔离行 |
| `localMedia.missingCount` | 明确指定媒体目录后，未找到普通文件的去重引用数；没有检查内容、哈希或远程 URL 可用性 |
| `quarantined.count` / `reasons` | 隔离行数 / 各原因命中数；一行可同时命中多个原因，原因数量不可直接相加 |
| `manifestHash` | 对全部统计、输入 SHA 和声明归属的固定字段序列计算 SHA-256；不含 generatedAt |

可信 Meta 来源目前仅接受 HTTPS 的 `facebook.com`、`www.facebook.com`、`m.facebook.com` 下 `/ads/library`，拒绝其他路径、伪造后缀域名和带登录信息的 URL。超出范围归入 `nonMetaSource`，等待适配器验证，不猜测。缺稳定 ID、ID 冲突、坏记录、归属不明、危险媒体路径均隔离；坏 JSON / 缺 ads 数组则直接失败，不生成报告。

纯函数 `createInventoryManifest(input, { generatedAt, ownership?, localMediaFiles? })` 不读写文件。`generatedAt` 必须显式传入；相同输入字节、相同归属声明和相同媒体存在性结果的 `manifestHash` 一致。manifest 不包含广告 ID、正文、广告主、完整 URL、私有归属值、媒体文件名和文件路径。

## 独立验证

使用临时配置避开旧应用 jsdom/setup，不运行整库测试：

```sh
printf '%s\n' 'export default { test: { environment: "node", include: ["scripts/saas-migration/inventory.test.ts"], maxWorkers: 1 } };' > /tmp/ds-meta-inventory-vitest.config.mjs
node_modules/.bin/vitest run --config /tmp/ds-meta-inventory-vitest.config.mjs
node_modules/.bin/tsc --ignoreConfig --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --skipLibCheck --types node scripts/saas-migration/inventory.ts scripts/saas-migration/inventory.test.ts
```

测试覆盖真实临时文件、禁止覆盖、符号链接、缺媒体、未知来源和归属、来源 ID/素材变体去重、错误输入脱敏及稳定哈希。当前盘点与未执行的切换手册见 legacy-inventory.md。

## 公开数据导入演练

`import-public.ts` 必须显式提供 `--input`、`--manifest`、`--confirm-manifest`、`--target-url`、`--output`；原 manifest 检查过媒体目录时还须提供 `--media-root`。输入文件必须与已确认的 `classification=public` manifest 完全一致。密码只通过 `SAAS_MIGRATION_DATABASE_PASSWORD` 环境变量提供，目标 URL 禁止密码和查询参数。

目标只允许 `127.0.0.1` / `localhost` / `::1`，库名含独立 `test` 或 `rehearsal` 段；连接后再核对实际数据库名、端口和回环地址。目标先部署本项目迁移，业务 / 私有表必须为空，其他数据源存在也拒绝。重复运行只核验已导入的 hash 与逐行映射，不更新原记录；输出文件不覆盖。导入失败输出固定错误码，不透出输入正文、数据库连接信息或供应商异常。

公开导入复验允许媒体从原始 PENDING 合法演进为媒体工具写入的 FAILED / READY，核对原 SHA-256、字节数、生成的 UUID 对象键、状态和必要元数据；任何漂移都拒绝。这里的 `REPLAY_VERIFIED_NO_WRITE` **只说明数据库对账通过，不代表 S3 内容已验证**。READY 内容复验必须另运行下述媒体命令。

源 ID 合并为 Ad，变体按内容 hash 保留，每个输入行有 RunItem 对照。缺时间不创建伪造观测，未知平台保持空数组；旧 country / startDate 不提升为已核实事实。媒体只计算本地内容 hash 并登记为 PENDING，不下载、不上传、不写旧媒体目录、不标 READY。归属不明 / 私有 / 非 Meta / 缺 ID 记录隔离。

指定 `--media-root` 时，CLI 会在访问媒体目录前复核批准的输入/manifest，并要求整批没有隔离行；媒体读取与上传工具共用下述规范路径、无链接、大小、魔数及读取期间变化检查。混合批次只允许不读媒体的数据盘点/隔离流程，不能借媒体哈希阶段读取私有文件。已有历史导入如果不符合新增文件校验会拒绝，须人工核对，不能降低校验重跑。

本轮 870 行→647 来源广告、870 变体的真实公开数据导入与重复核验、36 表备份恢复已在新建的本机演练库通过；详细 hash、计数与命令见 公开迁移及恢复证据。这些结果不代表生产迁移或上线完成。

## 本地媒体上传闭环（仅本机隔离演练）

`local-media.ts` 不自动选取旧文件、不迁移 DS 私有素材，也不连接真实云 S3。操作者必须先准备明确公开的输入及 inventory，再逐份确认摘要。含任何隔离行的批次整体拒绝；不会从混合输入中自动挑选看似公开的部分。缺文件、扩展名与魔数不符、同一个数据库媒体身份映射多个本地文件时也拒绝。远程 URL 媒体不下载，保持原状态。

批准清单绑定原始输入 SHA、inventory hash、公开导入 plan hash、明确数据库身份、对象端点/桶、逐文件相对名/SHA-256/字节数/MIME 和公开来源映射。生成时间不参与 `manifestHash`。它包含用于人工核对的**公共文件名和公共来源 ID**，不是原先的纯计数 manifest；不含广告正文、完整来源媒体 URL、查询 token、私有归属或凭据。清单与报告均独占创建为 `0600`，不能覆盖已有文件。

下面全是显式占位符，不能直接作为真实数据迁移命令。`APPROVED_INPUT`、`APPROVED_INVENTORY`、`ALLOWED_ROOT`、`INVENTORY_HASH`、`MEDIA_MANIFEST_HASH` 均须由操作者逐项指定；媒体根目录须是无符号链接祖先的绝对规范路径，例如 macOS 使用 `/private/tmp/...` 而不是 `/tmp/...`。

```sh
# 1. 离线生成待审媒体清单；不连接数据库或对象服务。
node --import tsx scripts/saas-migration/local-media.ts \
  --mode prepare --input "$APPROVED_INPUT" \
  --inventory "$APPROVED_INVENTORY" --confirm-inventory "$INVENTORY_HASH" \
  --media-root "$ALLOWED_ROOT" \
  --target-url postgresql://saas_local@127.0.0.1:55438/saas_media_test \
  --endpoint http://127.0.0.1:13991 --bucket saas-migration-test-media \
  --output /private/tmp/media-candidate.json

# 2. 按公开导入流程先导入同一 input/inventory/媒体根目录。
#    import-public.ts 的 planHash 必须等于清单 publicPlanHash；媒体命令不会代为导入。

# 3. 人工核对清单后，显式传入它的 manifestHash。先准备独立本机 S3 测试桶。
#    凭据只使用环境变量，不写入 URL、命令参数或清单：
#    SAAS_MIGRATION_DATABASE_PASSWORD（本机无密码时省略）
#    SAAS_MIGRATION_S3_ACCESS_KEY_ID / SAAS_MIGRATION_S3_SECRET_ACCESS_KEY
node --import tsx scripts/saas-migration/local-media.ts \
  --mode upload --input "$APPROVED_INPUT" \
  --inventory "$APPROVED_INVENTORY" --confirm-inventory "$INVENTORY_HASH" \
  --manifest /private/tmp/media-candidate.json --confirm-manifest "$MEDIA_MANIFEST_HASH" \
  --media-root "$ALLOWED_ROOT" \
  --target-url postgresql://saas_local@127.0.0.1:55438/saas_media_test \
  --endpoint http://127.0.0.1:13991 --bucket saas-migration-test-media \
  --output /private/tmp/media-upload-1.json
```

执行约束和结果：

- 数据库沿用公开导入的本机 test/rehearsal 护栏，源任务必须 PAUSED，私有/业务表为空；每个对象事务重新检查，并用同一迁移 advisory lock 串行化。工具不创建数据库、迁移、数据源、导入任务或存储桶。
- S3 端点仅允许明确端口的字面量回环 IP `127.0.0.1` / `[::1]`，不接受 DNS 主机、重定向、路径、查询串或内嵌登录信息。桶名仅接受 `saas-migration-test-*`，凭据必须显式专用环境变量，无默认 AWS 凭据回退。桶名限制不能替代真实权限隔离；该凭据只应有本机专用桶的 GET / PUT 权限。
- 文件仅支持根目录第一层；拒绝根/祖先/文件符号链接、硬链接和路径逃逸。通过 `O_NOFOLLOW` 打开、前后 inode/时间/大小及根目录身份检查，所有内容校验通过后才传给对象 provider。最大单文件 100 MiB；MIME 仅 JPEG/PNG/WebP/GIF/MP4/WebM，并验魔数。上传前重新读取文件与已批准清单精确比较。
- 对象键为 `public-media/<数据库生成的 MediaObject UUID>`。先 GET；已有对象必须字节数、SHA-256、MIME、魔数全部一致，差异对象绝不覆盖。不存在时使用 `If-None-Match: *` PUT；冲突后只 GET 复核。SDK 每次请求 10 秒超时、不自动重试，读回同时限制声明长度和实际流量。
- 只有 GET 读回验证完成才写 READY、对象键、MIME、下载时间。供应商错误仅保留固定错误码，失败记录为 FAILED；原 hash/bytes 不变，可用相同批准清单和新的报告输出路径重试。PUT 成功但读回失败时，重试先 GET 已有对象，不重复覆盖。
- READY 重跑必须重新 GET；内容正确时不改数据库时间、不重复 PUT。READY 对象丢失/损坏会转 FAILED，返回 `INCOMPLETE` 和退出码 1；已经存在的错误对象不会被工具修复或覆盖。数据库元数据漂移直接拒绝，需要人工调查，不能把 `VERIFIED` 当成修复。
- 整批不是一个跨 PostgreSQL/S3 的原子事务。前面已验证的对象会保留；固定键、条件写入和逐对象报告支持安全重跑。清单/报告不包含旧媒体正文，旧 JSON 和媒体目录始终只读。

纯接口为 `prepareLocalMediaManifest(...)`（离线）、`uploadLocalMedia(...)`（注入可信 provider）、`createLocalS3Provider(...)`（锁定 SDK、本机端点）和 `runLocalMediaCli(...)`。provider 的 PUT 必须实现“不存在才写”的语义，不能用无条件覆盖代替。

### 本轮开发验证范围

2026-10-05 02:22:25 HKT 定向结果为 **3 文件 / 41 项通过，0 失败、0 跳过**；限定脚本 strict TypeScript 与 `git diff --check` 通过。RED 阶段先确认新模块缺失，再分别复现媒体身份合并冲突、READY MIME 漂移、非法对象键身份和旧公开导入 CLI 的链接路径测试失败后修正。仅用合成 JPG/恶意路径 fixture、独立本机 `saas_media_test_20261005`（6 个现有迁移）及内存 provider / 回环 HTTP fake S3 验证。未选择或上传现有 647 来源广告的真实素材，未连接远端或云服务。定向测试命令如下；两个环境变量必须指向独立、没有私有数据的本机测试库。未设置时 PostgreSQL 用例会跳过，不能记作 PG 验收通过。

```sh
SAAS_MEDIA_TEST_DATABASE_URL=postgresql://saas_local@127.0.0.1:55438/saas_media_test_20261005 \
SAAS_MIGRATION_TEST_DATABASE_URL=postgresql://saas_local@127.0.0.1:55438/saas_media_test_20261005 \
saas/toolchain/node_modules/.bin/node saas/app/node_modules/vitest/vitest.mjs run \
  --config saas/vitest.config.ts \
  scripts/saas-migration/local-media.test.ts \
  scripts/saas-migration/local-media-provider.test.ts \
  scripts/saas-migration/import-public.test.ts
```

## 原始公共 JSON 与变体证据归档

媒体 READY 还不等于历史数据可联合恢复：旧导入的 `legacy-json-sha256:` 引用只是本地输入标识。`source-evidence.ts` 将批准的公共原始 JSON 及其变体证据保存到同一个本机隔离桶，完整读回后才原子升级引用。它仍只允许本机 test/rehearsal 数据库与 `saas-migration-test-*` 桶，不是远端或生产迁移入口。

归档保存 **1 份原始输入的精确字节 + 每个唯一 variantHash 对应的 1 份 JSON**。CollectionRun / AdObservation 指向原 JSON；RunItem 原本的 hash 是变体 hash，因此指向相应变体 JSON，保留原 hash 与 `row:N`。不同哈希不会强行合并成同一个对象。对象键均为 `private-source-evidence/<数据库生成 run UUID>/<确定性 UUID>.json`，MIME 为 `application/json`，单对象最多 100 MiB。只改广告主 provenance 中等于本次旧引用的指针，后续批次的证据保持原样。

### 先生成可审查的 public-plan 文件

`--public-plan` 不是公开导入的计数报告。它由现有 `buildPublicImportPlan` 生成，包含公开正文和媒体哈希，应以 `0600` 受控保管，不能作为日志或提交到 Git。下面是在仓库根目录可运行的**离线生成方法**，不连接 PG/S3；参数必须替换为操作者明确批准的 input、inventory、规范媒体根目录和 inventory hash。输出路径必须不存在。这里使用已校验的实际媒体字节重建计划；若缺媒体、魔数不符或与原导入媒体内容不同，先调查，不跳过校验。

```sh
node --import tsx --input-type=module - \
  /private/tmp/approved-input.json /private/tmp/approved-inventory.json \
  /private/tmp/approved-media "$INVENTORY_HASH" /private/tmp/public-plan.json <<'NODE'
import { readFile, open } from 'node:fs/promises';
import { buildPublicImportPlan } from './scripts/saas-migration/import-public.ts';
import { prepareLocalMediaManifest } from './scripts/saas-migration/local-media.ts';
const [inputPath, inventoryPath, allowedRoot, confirmInventoryHash, outputPath] = process.argv.slice(2);
const input = await readFile(inputPath);
const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
const media = await prepareLocalMediaManifest(input, inventory, {
  allowedRoot, confirmInventoryHash, generatedAt: new Date().toISOString(),
  targetUrl: 'postgresql://saas_local@127.0.0.1:55438/saas_media_test',
  destination: { endpoint: 'http://127.0.0.1:13991', bucket: 'saas-migration-test-media' },
});
const plan = buildPublicImportPlan(input, inventory, {
  confirmManifestHash: confirmInventoryHash,
  localMediaFiles: media.files.map(file => file.relativePath),
  mediaEvidence: Object.fromEntries(media.files.map(file => [file.relativePath, { sha256: file.sha256, sizeBytes: file.sizeBytes }])),
});
if (plan.planHash !== media.publicPlanHash) throw new Error('SOURCE_EVIDENCE_PLAN_MISMATCH');
const output = await open(outputPath, 'wx', 0o600);
try { await output.writeFile(`${JSON.stringify(plan, null, 2)}\n`); }
finally { await output.close(); }
NODE
```

`planHash` 必须与既有成功公开导入的报告/数据库 coverage 相同。即使手工修改 plan 文件，归档器也会从原输入重新构造全部公开事实，并与成功 run 的原计划核对，不能拿任意 run 或另一批数据归档。仅声明 `public` 不覆盖私有标记；包含未知/DS 私有归属或任何 quarantine 的输入整体拒绝。

### 审批并执行归档

以下 `prepare` 只读本机数据库，不读 S3、不写引用；它不会代为创建公开导入。审批清单绑定 input SHA、inventory hash、publicPlanHash、目标数据库身份、端点/桶、每对象 key/hash/size/MIME、完整引用集合和实际 run UUID，生成时间不参与 hash。核对这些绑定后，再显式传入 `SOURCE_MANIFEST_HASH`。

```sh
node --import tsx scripts/saas-migration/source-evidence.ts \
  --mode prepare --input /private/tmp/approved-input.json \
  --inventory /private/tmp/approved-inventory.json --confirm-inventory "$INVENTORY_HASH" \
  --public-plan /private/tmp/public-plan.json \
  --target-url postgresql://saas_local@127.0.0.1:55438/saas_media_test \
  --endpoint http://127.0.0.1:13991 --bucket saas-migration-test-media \
  --output /private/tmp/source-evidence-candidate.json

# 使用与媒体工具相同的专用环境变量凭据；不把密码/secret写进参数。
node --import tsx scripts/saas-migration/source-evidence.ts \
  --mode archive --input /private/tmp/approved-input.json \
  --inventory /private/tmp/approved-inventory.json --confirm-inventory "$INVENTORY_HASH" \
  --public-plan /private/tmp/public-plan.json \
  --target-url postgresql://saas_local@127.0.0.1:55438/saas_media_test \
  --endpoint http://127.0.0.1:13991 --bucket saas-migration-test-media \
  --manifest /private/tmp/source-evidence-candidate.json --confirm-manifest "$SOURCE_MANIFEST_HASH" \
  --output /private/tmp/source-evidence-archive-1.json
```

每个对象先 GET；内容存在则必须 byte/hash/MIME 全部一致，差异对象禁止覆盖。对象不存在时用条件 PUT，再 GET 复验；全部成功之后，用一个数据库事务重新检查隔离、源 PAUSED、成功导入、完整引用集合，然后一起更新 run/items/observations、适用的广告主指针及 `coverage.sourceEvidenceArchive` receipt。任一对象失败或数据库状态变化，数据库引用全部保持原状；已写出的正确对象不删除，重跑可复用。

归档完成后，相同批准清单重跑只 GET 全部对象、不 PUT、不改数据库。对象丢失/内容变化会失败，不能自动补写后称为历史复验。广告主后来由合法的新批次接管时，旧 receipt 保留其历史绑定，重跑旧归档不会改回广告主来源。原 JSON、本地媒体和对象均不删除。

`importPublicPlan` 的重复导入严格核验原 hash/映射、确定性 s3 引用和归档 receipt，仍然是 **DB-only**；只有 `archiveSourceEvidence` 的成功重跑才表示本轮实际 GET 验证完成。后续必须使用包含这些 s3 引用的**新 PostgreSQL 备份**再做对象备份/联合恢复；归档前的旧 dump 不会被工具回写成新证据。

导出接口：

```ts
prepareSourceEvidenceManifest(db, input, inventory, {
  confirmInventoryHash, publicPlan, targetUrl, destination, generatedAt,
})
archiveSourceEvidence(db, input, inventory, manifest, {
  confirmInventoryHash, confirmManifestHash, publicPlan, targetUrl, destination, provider,
})
```

`provider` 复用 `LocalMediaProvider`，对 JSON 使用同样的条件 PUT、限额 GET 和超时。原始证据必须保存在私有桶，不公开源 JSON；审批清单/结果只含身份、对象键、数量和 hash，不输出正文或供应商原始错误。本轮只验证合成输入、本机独立测试库与 fake S3；没有归档现有真实公开历史数据或操作远端。

归档边界定向测试需要额外显式环境变量，例如 `SAAS_SOURCE_EVIDENCE_TEST_DATABASE_URL=postgresql://saas_local@127.0.0.1:55438/saas_source_evidence_test_20261005`，再运行 `source-evidence.test.ts`。缺少该变量时 PG 用例会跳过，不能记作通过。联合恢复端到端另由 `saas/deploy/legacy-joint-backup.integration.test.mjs` 验证，不能用单纯归档成功替代恢复证据。

2026-10-05 02:55:38 HKT，归档边界 8 项与既有媒体/公开导入回归合计 **4 文件 / 49 项通过，0 失败、0 跳过**；strict TypeScript、差异检查及独立只读复核通过。README 的离线 plan 生成脚本也已用合成 JPG/公共输入实际执行，产出 1 广告 / 1 媒体哈希且不连接数据库。原始定向报告 `/private/tmp/ds-meta-source-evidence-vitest.json` 的 SHA-256 为 `d9ed0512283bf93ab47d345f8485386f52daeedbf983758b77099bb098598350`。这不构成真实历史数据迁移或远端验收。
