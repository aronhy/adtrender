import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => {
  const names = ['collectorConfig', 'collectorConfigReceipt', 'collectorPlatformGrant', 'collectorClaim', 'collectorPermit', 'collectorPrepare', 'collectorSubmit', 'collectorRecover', 'collectorHeartbeat', 'collectorStart', 'collectorRenew', 'collectorStopped', 'collectorRestriction', 'collectorCheckpoint', 'collectorControlHandoff', 'collectorSourceStopContext'] as const;
  const handlers = Object.fromEntries(names.map(name => [name, vi.fn<(req: unknown, res: unknown) => unknown>()]));
  return { names, handlers, middleware: vi.fn<(config: unknown) => unknown>() };
});

vi.mock('./collector-api', () => ({ ...mocked.handlers, collectorMiddleware: mocked.middleware }));
import * as adapter from './collector-api-wasp-adapter';

beforeEach(() => vi.resetAllMocks());

describe('Wasp collector API signature compatibility', () => {
  // Real Express references suffice here: the adapter must never read or alter
  // the request or response, and no collector service or database is invoked.
  const req = express.request;
  const res = express.response;
  const context: unknown = { user: { isAdmin: true }, entities: {} };
  const expectForwarded = (name: typeof mocked.names[number]) => {
    expect(mocked.handlers[name]).toHaveBeenCalledTimes(1);
    const args = mocked.handlers[name].mock.calls[0];
    expect(args).toHaveLength(2);
    expect(args[0]).toBe(req);
    expect(args[1]).toBe(res);
  };

  it.each(mocked.names)('%s forwards the original request, response and result', async name => {
    const value = { sentinel: name };
    const pending = Promise.resolve(value);
    mocked.handlers[name].mockReturnValue(pending);
    const returned = adapter[name](req, res, context);
    expectForwarded(name);
    expect(returned).toBe(pending);
    await expect(returned).resolves.toBe(value);
  });

  it('preserves synchronous failures without turning them into response data', () => {
    const failure = new Error('SYNTHETIC_SYNC_FAILURE');
    mocked.handlers.collectorPermit.mockImplementation(() => { throw failure; });
    expect(() => adapter.collectorPermit(req, res, context)).toThrow(failure);
    expectForwarded('collectorPermit');
  });

  it('preserves rejected promises for the Express error handling chain', async () => {
    const failure = new Error('SYNTHETIC_ASYNC_FAILURE');
    const pending = Promise.reject(failure);
    mocked.handlers.collectorSubmit.mockReturnValue(pending);
    const returned = adapter.collectorSubmit(req, res, context);
    expect(returned).toBe(pending);
    await expect(returned).rejects.toBe(failure);
  });

  it('re-exports the exact middleware configuration function', () => {
    expect(adapter.collectorMiddleware).toBe(mocked.middleware);
  });
});
