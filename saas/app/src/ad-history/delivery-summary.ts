export type DeliverySummary = {
  observedDays?: number;
  activeObservedDays?: number;
  sourceDateSpanDays: number | null;
  spanEndAt: string | null;
  spanBasis: 'SOURCE_DISCLOSED_RANGE' | 'SOURCE_ACTIVE_OBSERVATION' | null;
};
type SourceDates={sourceStartedAt?:Date|null;sourceEndedAt?:Date|null;sourceStatus?:string|null;statusObservedAt?:Date|null;firstObservedAt?:Date|null;lastObservedAt?:Date|null};
const calendarDay=(d:Date)=>Math.floor(d.valueOf()/86400000);
/** A source date span is not a count of continuously active days. Never extend stale evidence to now. */
export function sourceDateSpan(ad:SourceDates):DeliverySummary {
  const start=ad.sourceStartedAt;
  const end=ad.sourceEndedAt??(ad.sourceStatus?.toUpperCase()==='ACTIVE'?ad.statusObservedAt:null);
  if(!start||!end||!Number.isFinite(start.valueOf())||!Number.isFinite(end.valueOf())||end<start)return {sourceDateSpanDays:null,spanEndAt:null,spanBasis:null};
  return {sourceDateSpanDays:calendarDay(end)-calendarDay(start)+1,spanEndAt:end.toISOString(),spanBasis:ad.sourceEndedAt?'SOURCE_DISCLOSED_RANGE':'SOURCE_ACTIVE_OBSERVATION'};
}
