import {buildQueryLedger,type LedgerDatabase,type QueryLedgerRow} from '../../web/src/seed-library/metrics';
export interface LedgerWatermark {from:string;through:string}
/** Rebuild an observation window from committed facts: a late commit cannot be lost to a creation-time cursor. */
export async function reconcileSeedLedger(db:LedgerDatabase,watermark:LedgerWatermark):Promise<{nextWatermark:LedgerWatermark;reconciledRunIds:string[];rows:QueryLedgerRow[]}>{
 const rows=await buildQueryLedger(db,{from:watermark.from,to:watermark.through});return {nextWatermark:watermark,reconciledRunIds:[...new Set(rows.flatMap(r=>r.runIds))],rows};
}
