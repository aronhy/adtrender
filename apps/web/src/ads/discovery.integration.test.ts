import { randomUUID, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { searchAds } from "./service";
describe.skipIf(!process.env.SAAS_TEST_DATABASE_URL)(
  "Google discovery filters against PostgreSQL",
  () => {
    let db: PrismaClient,
      userId: string,
      workspaceId: string,
      sourceId: string,
      keyword: string;
    const ids: Record<string, string> = {};
    const search = (extra: any = {}) =>
      searchAds(db, {
        userId,
        workspaceId,
        keyword,
        source: "google",
        ...extra,
      } as any);
    beforeAll(async () => {
      db = new PrismaClient({
        datasources: { db: { url: process.env.SAAS_TEST_DATABASE_URL } },
      });
      const tag = randomUUID();
      keyword = tag;
      userId = (
        await db.user.create({ data: { email: tag + "@example.test" } })
      ).id;
      const org = await db.organization.create({
        data: {
          name: tag,
          slug: tag,
          members: { create: { userId, role: "OWNER" } },
        },
      });
      workspaceId = (
        await db.workspace.create({
          data: {
            name: "Discovery fixture",
            slug: "discovery",
            organizationId: org.id,
          },
        })
      ).id;
      sourceId = (
        await db.dataSource.upsert({
          where: { key: "google_ads_transparency" },
          update: {},
          create: {
            key: "google_ads_transparency",
            name: "Google fixture",
            adapterVersion: "fixture-1",
            status: "ACTIVE",
          },
        })
      ).id;
      for (const [name, type, platform, body, url] of [
        [
          "parsed",
          "TEXT",
          "SEARCH",
          "Actual source copy",
          "https://www.example.com/page",
        ],
        ["preview", "TEXT", "SEARCH", null, "https://evil-example.com/page"],
        ["poster", "VIDEO", "YOUTUBE", null, "https://shop.example.com/watch"],
        ["missing", "UNKNOWN", "SEARCH", "Available copy", null],
        ["image", "IMAGE", "SEARCH", null, "https://images.example.test/"],
      ] as const) {
        ids[name] = (
          await db.ad.create({
            data: {
              sourceAdId: tag + name,
              sourceUrl: "https://adstransparency.google.com/",
              dataSourceId: sourceId,
              mediaType: type,
              publisherPlatforms: [platform],
              body,
              landingPageUrl: url,
              firstObservedAt: new Date("2026-10-01T00:00:00Z"),
              lastObservedAt: new Date("2026-10-11T00:00:00Z"),
            },
          })
        ).id;
      }
      await db.ad.update({
        where: { id: ids.parsed },
        data: {
          fieldProvenance: {
            description: { value: keyword + " Exclusive source description" },
          },
        },
      });
      for (const name of ["parsed", "preview", "poster", "image"])
        await db.mediaObject.create({
          data: {
            adId: ids[name],
            type: "IMAGE",
            status: "READY",
            sourceUrl: "https://media.example.test/" + tag + name + ".png",
          },
        });
      const other = await db.dataSource.create({
        data: { key: tag, name: tag, adapterVersion: "fixture-1" },
      });
      ids.other = (
        await db.ad.create({
          data: {
            dataSourceId: other.id,
            sourceAdId: tag,
            sourceUrl: "https://other.example.test/",
            mediaType: "TEXT",
            publisherPlatforms: ["SEARCH"],
            body: "not a Google source",
          },
        })
      ).id;
      const seed = await db.seedDefinition.create({
        data: {
          kind: "NAME",
          namespace: "fixture",
          rawValue: tag,
          normalizedValue: tag,
          language: "en",
          purposeTags: [{ family: "ECOMMERCE", category: "beauty" }],
          targetScope: { kind: "EXPLICIT_COUNTRIES", countries: ["US"] },
          targetPlatforms: ["google_ads_transparency"],
        },
      });
      const task = await db.collectionTask.create({
        data: { name: tag, dataSourceId: sourceId, query: {}, maxItems: 20 },
      });
      const run = await db.collectionRun.create({
        data: {
          taskId: task.id,
          dataSourceId: sourceId,
          idempotencyKey: tag,
          adapterVersion: "fixture-1",
          status: "SUCCEEDED",
          querySnapshot: {},
        },
      });
      const attempt = await db.seedAttempt.create({
        data: {
          dataSourceId: sourceId,
          sourceKey: "google_ads_transparency",
          runId: run.id,
          batchSha256: createHash("sha256").update(tag).digest("hex"),
          bindingSnapshot: [],
          outcome: "HAS_RESULTS",
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      });
      await db.seedAttemptMatch.create({
        data: {
          attemptId: attempt.id,
          seedId: seed.id,
          adId: ids.parsed,
          dataSourceId: sourceId,
          matchRole: "PRIMARY",
        },
      });
    });
    afterAll(async () => {
      await db?.$disconnect();
    });
    it("keeps incomplete records in their own view", async () => {
      expect(
        (await search({ contentStatus: "available" })).ads
          .map((a) => a.id)
          .sort(),
      ).toEqual([ids.parsed, ids.preview, ids.poster, ids.image].sort());
    });
    it("filters logical TEXT without counting its screenshots as image ads", async () => {
      expect(
        (await search({ mediaType: "text" })).ads.map((a) => a.id).sort(),
      ).toEqual([ids.parsed, ids.preview].sort());
      expect(
        (await search({ mediaType: "image" })).ads.map((a) => a.id),
      ).toEqual([ids.image]);
      expect(
        (await search({ mediaType: "video" })).ads.map((a) => a.id),
      ).toEqual([ids.poster]);
    });
    it("separates parsed copy, original previews and incomplete content", async () => {
      expect(
        (await search({ contentStatus: "parsed" })).ads.map((a) => a.id),
      ).toEqual([ids.parsed]);
      expect(
        (await search({ contentStatus: "missing" })).ads.map((a) => a.id),
      ).toEqual([ids.missing]);
      expect(
        (await search({ mediaType: "text", contentStatus: "preview" })).ads.map(
          (a) => a.id,
        ),
      ).toEqual([ids.preview]);
    });
    it("matches website host boundaries and filters the original publishing channel independently", async () => {
      expect(
        (await search({ domain: "example.com" })).ads.map((a) => a.id).sort(),
      ).toEqual([ids.parsed, ids.poster].sort());
      expect(
        (await search({ channel: "YOUTUBE" })).ads.map((a) => a.id),
      ).toEqual([ids.poster]);
      expect((await search()).ads.some((a) => a.id === ids.other)).toBe(false);
    });
    it("uses linked seed tags for business filtering and retains unclassified records", async () => {
      expect(
        (await search({ business: "ECOMMERCE", category: "beauty" })).ads.map(
          (a) => a.id,
        ),
      ).toEqual([ids.parsed]);
      expect(
        (await search({ business: "UNCLASSIFIED" })).ads.some(
          (a) => a.id === ids.parsed,
        ),
      ).toBe(false);
    });
    it("searches and excludes parsed description text", async () => {
      expect(
        (
          await search({
            keyword: keyword + " Exclusive source description",
            exact: true,
          })
        ).ads.map((a) => a.id),
      ).toEqual([ids.parsed]);
      expect(
        (
          await search({ exclude: keyword + " Exclusive source description" })
        ).ads.some((a) => a.id === ids.parsed),
      ).toBe(false);
    });
    it("binds new filters into cursor fingerprints and rejects unsupported input", async () => {
      const first = await search({ limit: 1 });
      expect(first.nextCursor).toBeTruthy();
      await expect(
        search({ limit: 1, cursor: first.nextCursor, domain: "example.com" }),
      ).rejects.toMatchObject({ code: "INVALID_SEARCH_CURSOR" });
      await expect(search({ exclude: 42 })).rejects.toMatchObject({
        status: 400,
      });
      await expect(search({ category: 42 })).rejects.toMatchObject({
        status: 400,
      });
      await expect(search({ domain: 42 })).rejects.toMatchObject({
        status: 400,
      });
      await expect(search({ domain: "*.example.com" })).rejects.toMatchObject({
        status: 400,
      });
      await expect(
        search({ domain: "example.com/path" }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(search({ contentStatus: "invented" })).rejects.toMatchObject(
        { status: 400 },
      );
    });
  },
);
