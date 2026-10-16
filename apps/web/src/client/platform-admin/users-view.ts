import type { AdminEntitlement } from '../../server/platform-admin-users';

export const quotaNames = { WORKSPACES: '工作区', MEMBERS: '成员席位', SAVED_ADS: '收藏', ANALYSES: '每月分析次数' } as const;
export const quotaShortNames = { WORKSPACES: '工作区', MEMBERS: '席位', SAVED_ADS: '收藏', ANALYSES: '分析' } as const;
export function quotaSummary(item: AdminEntitlement) {
  if (!item.current) return { text: '未配置', occupied: null, tone: 'neutral' };
  const occupied = item.current.used + item.current.reserved;
  return { text: `${occupied} / ${item.current.limit}`, occupied, tone: occupied > item.current.limit || occupied > 0 && occupied === item.current.limit ? 'conflict' : item.current.limit > 0 && occupied / item.current.limit >= 0.9 ? 'unknown' : 'neutral' };
}
