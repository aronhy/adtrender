import {describe,expect,it} from 'vitest';
import {adminCopy,translateAdminCopy} from './admin-copy-core';
import {activityCopy} from './activity-copy';
import {activityCaveats,activityColumns,buildActivityCsv} from '../../server/platform-admin-activity';
import {activityMetric,activityValue} from './activity-view';
describe('admin four-language copy and exports',()=>{
 it('keeps a common key structure in all four languages',()=>{
  for(const dictionary of [adminCopy,activityCopy])for(const [key,value] of Object.entries(dictionary)){expect(key.length).toBeGreaterThan(0);expect(Object.keys(value).sort()).toEqual(['en','es','zh-TW']);for(const locale of ['zh-TW','en','es'] as const)expect(value[locale]).not.toBeUndefined();}
 });
 it('translates every activity caveat and exported column without removing methodology',()=>{
  for(const locale of ['zh-TW','en','es'] as const)for(const tab of Object.keys(activityCaveats) as Array<keyof typeof activityCaveats>){for(const text of activityCaveats[tab])expect(translateAdminCopy(locale,text,undefined,activityCopy)).not.toBe(text);for(const column of activityColumns[tab]){expect(activityCopy[column.label]??adminCopy[column.label]).toBeDefined();if(locale!=='zh-TW')expect(translateAdminCopy(locale,column.label,undefined,activityCopy)).not.toMatch(/[\u4e00-\u9fff]/);}}
 });
 it('interpolates user names once and does not translate dynamic values',()=>{
  expect(translateAdminCopy('en','记录已变更：{status}，请关闭后核对',{status:'用户'},activityCopy)).toBe('Record changed: 用户. Close and review it.');
  expect(translateAdminCopy('es','unknown-source-name')).toBe('unknown-source-name');
 });
 it('formats localized unknown metrics, statuses and Hong Kong dates',()=>{
  expect(activityMetric('consentRate',null,'en')).toBe('Not collected / unavailable');expect(activityValue('status','FAILED','es')).toBe('Fallido');expect(activityValue('createdAt','2026-10-10T20:34:00Z','en')).toContain('04:34');expect(activityValue('organization','用户','en')).toBe('用户');
 });
 it('exports the selected interface language with BOM and formula escaping',()=>{
  const csv=buildActivityCsv('usage',[{id:'internal',createdAt:'2026-10-11T00:00:00Z',cells:{organization:'=SUM(1)',key:'ANALYSES',quantity:1,status:'SETTLED'}}],{},'2026-10-11T00:00:00Z','en');expect(csv.startsWith('\uFEFF"# Exported')).toBe(true);expect(csv.split('\r\n')[0]).toContain('08:00');expect(csv.split('\r\n')[0]).not.toContain('2026-10-11T00:00:00Z');expect(csv).toContain('Release reason');expect(csv).toContain('An unsettled reservation does not mean an analysis is complete');expect(csv).toContain("'=SUM(1)");expect(csv).not.toMatch(/[\u4e00-\u9fff]/);
 });
});
