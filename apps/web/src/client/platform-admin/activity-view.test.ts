import {describe,expect,it} from 'vitest';
import {activityValue,activityMetric,isActivityPermissionError,activityError} from './activity-view';
describe('activity presentation preserves unknown evidence and Hong Kong time',()=>{
 it('does not substitute zero for uncollected consent denominator',()=>{expect(activityMetric('consentRate',null)).toContain('无法计算');expect(activityMetric('testRate',0)).toBe('0.0%');});
 it('formats dates consistently in Hong Kong timezone',()=>{expect(activityValue('createdAt','2026-10-10T20:34:00Z')).toContain('2026/10/11');expect(activityValue('createdAt','2026-10-10T20:34:00Z')).toContain('04:34');});
 it('keeps failed or unknown statuses textual',()=>{expect(activityValue('status','UNKNOWN')).toBe('结果未知');expect(activityValue('status','RESERVED')).toBe('预占中');});
 it('separates access revocation and concurrent change from retryable reads',()=>{expect(isActivityPermissionError(new Error('403 PLATFORM_ADMIN_REQUIRED'))).toBe(true);expect(isActivityPermissionError(new Error('offline'))).toBe(false);expect(activityError(new Error('ADMIN_ACTIVITY_CONFLICT'))).toContain('重新确认');});
});

import {activityFiltersFromParams,activityFilterParams,activityPeriodParams,activityTabParams,activityClearParams} from './activity-view';
describe('activity module URL preset and browser-history contracts',()=>{
 it('restores dashboard presets and distinguishes pending default from explicit all-status filter',()=>{
  expect(activityFiltersFromParams('email',new URLSearchParams('module=email&status=FAILED&templateKey=VERIFY'))).toMatchObject({status:'FAILED',templateKey:'VERIFY'});
  expect(activityFiltersFromParams('requests',new URLSearchParams('module=operations&tab=requests'))).toMatchObject({status:'OPEN'});
  expect(activityFiltersFromParams('requests',new URLSearchParams('module=operations&tab=requests&status='))).not.toHaveProperty('status');
 });
 it('preserves language, module and period while resetting pagination on filter change',()=>{
  const next=activityFilterParams(new URLSearchParams('lang=en&module=email&from=2026-10-01&to=2026-10-11&cursor=old'),'status','FAILED');
  expect(next.get('lang')).toBe('en');expect(next.get('module')).toBe('email');expect(next.get('from')).toBe('2026-10-01');expect(next.get('status')).toBe('FAILED');expect(next.has('cursor')).toBe(false);
 });
 it('restores all-date pending presets only for support and mail then exits on date or tab selection',()=>{
  const params=new URLSearchParams('lang=es&module=operations&tab=requests&pending=all&status=OPEN&cursor=old');
  for(const tab of ['feedback','requests','email'] as const)expect(activityFiltersFromParams(tab,params).allDates).toBe(true);
  for(const tab of ['visits','product','usage','audit'] as const)expect(activityFiltersFromParams(tab,params).allDates).toBeUndefined();
  const range=activityPeriodParams(params,{from:'2026-10-05',to:'2026-10-11'});expect(range.has('pending')).toBe(false);expect(range.has('cursor')).toBe(false);expect(range.get('lang')).toBe('es');
  const tab=activityTabParams(params,'audit');expect(tab.has('pending')).toBe(false);expect(tab.has('status')).toBe(false);expect(tab.get('tab')).toBe('audit');
  const clear=activityClearParams(params,'requests');expect(clear.has('pending')).toBe(false);expect(clear.has('cursor')).toBe(false);expect(clear.get('status')).toBe('');expect(clear.get('lang')).toBe('es');
 });
});
