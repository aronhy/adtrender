import type {AdHistoryResult as CoreAdHistoryResult} from './types';
import type {DeliverySummary} from './delivery-summary';
export type HistorySummary = DeliverySummary & {
  observedDays:number;
  activeObservedDays:number;
  conflictDays:number;
  firstObservedAt:string|null;
  lastObservedAt:string|null;
  sourceStartedAt:string|null;
  sourceEndedAt:string|null;
  scope:'selected-window';
};
export type AdHistoryResult = CoreAdHistoryResult & {summary:HistorySummary;projectionPending:boolean};
export type AdHistoryQuery = {workspaceId:string;adId:string;from:string;to:string;scopeHash?:string;eventCursor?:string};
