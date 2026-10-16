import * as legacy from './collector-api';

export { collectorMiddleware } from './collector-api';

type LegacyHandler = typeof legacy.collectorConfig;
type WaspHandler = (
  req: Parameters<LegacyHandler>[0],
  res: Parameters<LegacyHandler>[1],
  context: unknown,
) => ReturnType<LegacyHandler>;

/** Wasp calls API functions with a third context argument. These machine APIs
 * authenticate their unchanged Express request and own their response. Keep
 * the Wasp context separate from the collector protocol's request.body.context.
 */
function adapt(handler: LegacyHandler): WaspHandler {
  return (req, res, _context) => handler(req, res);
}

export const collectorConfig = adapt(legacy.collectorConfig);
export const collectorConfigReceipt = adapt(legacy.collectorConfigReceipt);
export const collectorPlatformGrant = adapt(legacy.collectorPlatformGrant);
export const collectorClaim = adapt(legacy.collectorClaim);
export const collectorPermit = adapt(legacy.collectorPermit);
export const collectorPrepare = adapt(legacy.collectorPrepare);
export const collectorSubmit = adapt(legacy.collectorSubmit);
export const collectorRecover = adapt(legacy.collectorRecover);
export const collectorHeartbeat = adapt(legacy.collectorHeartbeat);
export const collectorStart = adapt(legacy.collectorStart);
export const collectorRenew = adapt(legacy.collectorRenew);
export const collectorStopped = adapt(legacy.collectorStopped);
export const collectorRestriction = adapt(legacy.collectorRestriction);
export const collectorCheckpoint = adapt(legacy.collectorCheckpoint);
export const collectorControlHandoff = adapt(legacy.collectorControlHandoff);
export const collectorSourceStopContext = adapt(legacy.collectorSourceStopContext);
