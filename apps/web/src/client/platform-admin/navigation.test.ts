import { describe, expect, it } from 'vitest';
import { adminModule, moduleParams, defaultRange, permissionError, validAdminRange, pendingParams } from './navigation';
describe('platform admin URL and request boundaries', () => {
  it('defaults invalid routes and preserves the existing seed module', () => {
    expect(adminModule('unknown')).toBe('dashboard');
    expect(adminModule('seeds')).toBe('seeds');
    expect(adminModule('customers')).toBe('users');
  });
  it('drops module-specific cursors and filters but keeps language and context', () => {
    const p=moduleParams(new URLSearchParams('module=ads&lang=en&workspace=w&cursor=old&view=media&status=FAILED&seedId=x'), 'users');
    expect(Object.fromEntries(p)).toEqual({module:'users',lang:'en',workspace:'w'});
  });
  it('uses inclusive Hong Kong dates for the seven day range', () => {
    expect(defaultRange(7,new Date('2026-10-10T20:00:00Z'))).toEqual({from:'2026-10-05',to:'2026-10-11'});
  });
  it('recognizes permissions without rendering stale sensitive data', () => {
    expect(permissionError({statusCode:403})).toBe(true);
    expect(permissionError(new Error('PLATFORM_ADMIN_REQUIRED'))).toBe(true);
    expect(permissionError(new Error('network'))).toBe(false);
  });
  it('rejects nonexistent calendar dates, future days and ranges over 90 days',()=>{
    const now=new Date('2026-10-11T04:00:00Z');
    expect(validAdminRange({from:'2026-02-30',to:'2026-03-02'},now)).toBe(false);
    expect(validAdminRange({from:'2026-10-05',to:'2026-10-11'},now)).toBe(true);
    expect(validAdminRange({from:'2026-10-05',to:'2026-10-12'},now)).toBe(false);
    expect(validAdminRange({from:'2026-01-01',to:'2026-10-11'},now)).toBe(false);
  });
});

it('keeps global pending links unrestricted and failed run links within their counted period',()=>{
 const source=new URLSearchParams('module=dashboard&lang=en&workspace=w&from=2026-10-05&to=2026-10-11');const range={from:'2026-10-05',to:'2026-10-11'};
 for(const item of [{module:'operations' as const,tab:'feedback',status:'OPEN'},{module:'operations' as const,tab:'requests',status:'OPEN'},{module:'email' as const,tab:'email',status:'FAILED'},{module:'ads' as const,tab:'media',status:'FAILED'}]){const next=pendingParams(source,item,range);expect(next.get('pending')).toBe('all');expect(next.has('from')).toBe(false);expect(next.has('to')).toBe(false);expect(next.get('lang')).toBe('en');}
 const runs=pendingParams(source,{module:'ads',tab:'runs',status:'FAILED'},range);expect(runs.get('from')).toBe(range.from);expect(runs.get('to')).toBe(range.to);expect(runs.has('pending')).toBe(false);
 expect(moduleParams(new URLSearchParams('module=email&pending=all'),'users').has('pending')).toBe(false);
});
