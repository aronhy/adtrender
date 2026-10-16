import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { DomainError, requirePlatformAdmin } from '../team/access';

const DAY_MS = 86_400_000;
const rangeSchema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();
export type GrowthSummaryQuery = { from: string; to: string };
export type GrowthCounts = {
  visitors: number; pageViews: number; clickedVisitors: number;
  registeredVisitors: number; registeredUsers: number; verifiedUsers: number; firstUseUsers: number;
};
export type GrowthSourceRow = GrowthCounts & { source: string | null; medium: string | null; campaign: string | null; content: string | null };
export type GrowthSummary = {
  from: string; to: string; timeZone: 'UTC+8'; asOf: string; collectionEnabled: boolean;
  firstUseEnabled: boolean; excludedTestTraffic: true; regionStatus: 'not_collected';
  totals: GrowthCounts;
  byDay: Array<GrowthCounts & { day: string }>;
  bySource: GrowthSourceRow[]; sourceRowsTruncated: boolean;
  byLanding: Array<GrowthCounts & { landingPath: string }>;
};

export function parseGrowthRange(input: unknown, now = new Date()) {
  const query = rangeSchema.parse(input);
  const start = new Date(`${query.from}T00:00:00+08:00`);
  const last = new Date(`${query.to}T00:00:00+08:00`);
  const localDate = (date: Date) => new Date(date.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(last.getTime())
    || localDate(start) !== query.from || localDate(last) !== query.to) throw new DomainError(400, 'INVALID_GROWTH_DATE');
  const days = (last.getTime() - start.getTime()) / DAY_MS + 1;
  if (days < 1 || days > 90 || query.to > localDate(now)) throw new DomainError(400, 'INVALID_GROWTH_RANGE');
  return { ...query, start, end: new Date(last.getTime() + DAY_MS), days };
}

type RawCounts = { [K in keyof GrowthCounts]: bigint | number };
type RawRow = RawCounts & { day?: string; source?: string | null; medium?: string | null; campaign?: string | null; content?: string | null; landingPath?: string };
const emptyCounts = (): GrowthCounts => ({ visitors: 0, pageViews: 0, clickedVisitors: 0, registeredVisitors: 0, registeredUsers: 0, verifiedUsers: 0, firstUseUsers: 0 });
function counts(row?: RawCounts): GrowthCounts {
  if (!row) return emptyCounts();
  const result = emptyCounts();
  for (const key of Object.keys(result) as Array<keyof GrowthCounts>) {
    const value = Number(row[key]);
    if (!Number.isSafeInteger(value) || value < 0) throw new DomainError(500, 'GROWTH_AGGREGATION_INVALID');
    result[key] = value;
  }
  return result;
}

/** One row per anonymous browser credential; every stage stays in this visit cohort.
 * ACCOUNT_CREATED binds a user once. Counting distinct users within each bound visit
 * therefore remains distinct across all groups (enforced by ConversionEvent's unique key).
 * Revoked/expired visits keep their already collected history; test visits never enter.
 */
function cohortSql(start: Date, end: Date, asOf: Date) {
  return Prisma.sql`
    WITH cohort AS (
      SELECT id, "createdAt", "landingPath", source, medium, campaign, content
      FROM "GrowthVisit"
      WHERE "createdAt" >= ${start} AND "createdAt" < ${end} AND "createdAt" <= ${asOf} AND "isTest" = false
    ), event_counts AS (
      SELECT event."visitId", COUNT(*) FILTER (WHERE event.name = 'PAGE_VIEW') AS "pageViews",
             BOOL_OR(event.name = 'CTA_CLICK') AS clicked
      FROM "GrowthEvent" event JOIN cohort ON cohort.id = event."visitId"
      WHERE event."createdAt" <= ${asOf}
      GROUP BY event."visitId"
    ), conversion_counts AS (
      SELECT account."visitId", COUNT(DISTINCT account."userId") AS registered,
             COUNT(DISTINCT verified."userId") AS verified,
             COUNT(DISTINCT first_use."userId") AS first_use
      FROM "ConversionEvent" account JOIN cohort ON cohort.id = account."visitId"
      LEFT JOIN "ConversionEvent" verified ON verified."userId" = account."userId" AND verified."visitId" = account."visitId"
        AND verified.name = 'REGISTRATION_VERIFIED' AND verified."createdAt" >= account."createdAt" AND verified."createdAt" <= ${asOf}
      LEFT JOIN "ConversionEvent" first_use ON first_use."userId" = verified."userId" AND first_use."visitId" = account."visitId"
        AND first_use.name = 'FIRST_AD_SAVED' AND first_use."createdAt" >= verified."createdAt" AND first_use."createdAt" <= ${asOf}
      WHERE account.name = 'ACCOUNT_CREATED' AND account."createdAt" <= ${asOf}
      GROUP BY account."visitId"
    ), metrics AS (
      SELECT cohort.*, COALESCE(event_counts."pageViews", 0) AS "pageViews", COALESCE(event_counts.clicked, false) AS clicked,
        COALESCE(conversion_counts.registered, 0) AS registered, COALESCE(conversion_counts.verified, 0) AS verified,
        COALESCE(conversion_counts.first_use, 0) AS first_use
      FROM cohort LEFT JOIN event_counts ON event_counts."visitId" = cohort.id
      LEFT JOIN conversion_counts ON conversion_counts."visitId" = cohort.id
    )`;
}
const aggregateSql = Prisma.sql`
  COUNT(*) AS visitors, COALESCE(SUM("pageViews"), 0) AS "pageViews",
  COUNT(*) FILTER (WHERE clicked) AS "clickedVisitors", COUNT(*) FILTER (WHERE registered > 0) AS "registeredVisitors",
  COALESCE(SUM(registered), 0) AS "registeredUsers", COALESCE(SUM(verified), 0) AS "verifiedUsers", COALESCE(SUM(first_use), 0) AS "firstUseUsers"`;

export async function loadGrowthSummary(db: PrismaClient, input: GrowthSummaryQuery & { userId: string }, now = new Date()): Promise<GrowthSummary> {
  const { userId, ...query } = input;
  const range = parseGrowthRange(query, now);
  return db.$transaction(async tx => {
    // Check the persisted platform role on every query; tenant ownership is insufficient.
    await requirePlatformAdmin(tx, userId);
    const cte = cohortSql(range.start, range.end, now);
    const totals = await tx.$queryRaw<RawRow[]>(Prisma.sql`${cte} SELECT ${aggregateSql} FROM metrics`);
    const daily = await tx.$queryRaw<RawRow[]>(Prisma.sql`${cte}
      SELECT to_char("createdAt" + INTERVAL '8 hours', 'YYYY-MM-DD') AS day, ${aggregateSql}
      FROM metrics GROUP BY day ORDER BY day`);
    const sources = await tx.$queryRaw<RawRow[]>(Prisma.sql`${cte}
      SELECT source, medium, campaign, content, ${aggregateSql} FROM metrics
      GROUP BY source, medium, campaign, content
      ORDER BY visitors DESC, source NULLS LAST, medium NULLS LAST, campaign NULLS LAST, content NULLS LAST LIMIT 101`);
    const landings = await tx.$queryRaw<RawRow[]>(Prisma.sql`${cte}
      SELECT "landingPath", ${aggregateSql} FROM metrics GROUP BY "landingPath" ORDER BY visitors DESC, "landingPath" LIMIT 20`);
    const byDay: GrowthSummary['byDay'] = [];
    for (let index = 0; index < range.days; index++) {
      const day = new Date(range.start.getTime() + 8 * 3_600_000 + index * DAY_MS).toISOString().slice(0, 10);
      byDay.push({ day, ...counts(daily.find(row => row.day === day)) });
    }
    return {
      from: range.from, to: range.to, timeZone: 'UTC+8', asOf: now.toISOString(), collectionEnabled: process.env.GROWTH_ATTRIBUTION_ENABLED === 'true',
      // First use is the first successful saved ad, recorded by the authenticated business transaction.
      firstUseEnabled: true, excludedTestTraffic: true, regionStatus: 'not_collected', totals: counts(totals[0]), byDay,
      bySource: sources.slice(0, 100).map(row => ({ source: row.source ?? null, medium: row.medium ?? null, campaign: row.campaign ?? null, content: row.content ?? null, ...counts(row) })),
      sourceRowsTruncated: sources.length > 100,
      byLanding: landings.map(row => ({ landingPath: row.landingPath!, ...counts(row) })),
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
