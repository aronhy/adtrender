import {describe,expect,it} from 'vitest';
import {dashboardComparison,loadPlatformAdminDashboard} from './platform-admin-dashboard';
describe('platform dashboard scope and truthful comparisons',()=>{
 it('does not fabricate a comparison with missing history or a zero baseline',()=>{expect(dashboardComparison(20,null)).toBeNull();expect(dashboardComparison(20,0)).toBeNull();expect(dashboardComparison(30,20)).toBe(50);expect(dashboardComparison(10,20)).toBe(-50);});
 it('rejects every dashboard section for a revoked admin',async()=>{const db:any={user:{findUnique:async()=>({id:'actor',isAdmin:false,disabledAt:null})}};for(const view of ['overview','trends','distribution','health'])await expect(loadPlatformAdminDashboard(db,'actor',{view,from:'2026-10-05',to:'2026-10-11'})).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});});
});
