import {describe,it,expect} from 'vitest';
import {sourceDateSpan} from './delivery-summary';
describe('source delivery span remains distinct from proved observed days',()=>{
  it('does not turn first/last observed dates into source duration',()=>{
    expect(sourceDateSpan({firstObservedAt:new Date('2026-10-01'),lastObservedAt:new Date('2026-10-08')})).toEqual({sourceDateSpanDays:null,spanEndAt:null,spanBasis:null});
  });
  it('uses source disclosed dates inclusively and never runs ended ads to today',()=>{
    expect(sourceDateSpan({sourceStartedAt:new Date('2026-10-01'),sourceEndedAt:new Date('2026-10-03'),sourceStatus:'INACTIVE'})).toMatchObject({sourceDateSpanDays:3,spanBasis:'SOURCE_DISCLOSED_RANGE'});
  });
  it('only extends an active span up to its actual status observation',()=>{
    expect(sourceDateSpan({sourceStartedAt:new Date('2026-10-01'),sourceStatus:'ACTIVE',statusObservedAt:new Date('2026-10-04T06:00:00Z')})).toMatchObject({sourceDateSpanDays:4,spanEndAt:'2026-10-04T06:00:00.000Z',spanBasis:'SOURCE_ACTIVE_OBSERVATION'});
    expect(sourceDateSpan({sourceStartedAt:new Date('2026-10-01'),sourceStatus:'UNKNOWN',statusObservedAt:new Date('2026-10-04')})).toMatchObject({sourceDateSpanDays:null});
  });
  it('counts source date labels in UTC while observation calendars remain Shanghai',()=>{
    expect(sourceDateSpan({sourceStartedAt:new Date('2026-10-01T16:00:00Z'),sourceEndedAt:new Date('2026-10-03T00:00:00Z')})).toMatchObject({sourceDateSpanDays:3});
  });
  it('rejects invalid and reversed source ranges',()=>{
    expect(sourceDateSpan({sourceStartedAt:new Date('invalid'),sourceEndedAt:new Date('2026-10-03')})).toMatchObject({sourceDateSpanDays:null});
    expect(sourceDateSpan({sourceStartedAt:new Date('2026-10-04'),sourceEndedAt:new Date('2026-10-03')})).toMatchObject({sourceDateSpanDays:null});
  });
});
