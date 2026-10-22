/** Legacy settings links select existing authenticated settings content only. */
export function showFullSettings(search: string, hash: string) {
  const params = new URLSearchParams(search);
  return params.get('advanced') === '1' || params.has('invite') || params.has('plan')
    || params.get('connect') === 'extension' || params.has('extId')
    || ['#account', '#profile', '#team', '#billing', '#feedback', '#danger', '#security', '#extensions', '#extension-connections-title', '#workspace'].includes(hash);
}
export function fullSettingsHref(workspaceId?: string | null, hash = 'team') {
  const params = new URLSearchParams({ advanced: '1' });
  if (workspaceId) params.set('workspace', workspaceId);
  const section = ['profile', 'team', 'billing', 'feedback', 'danger', 'security', 'extensions', 'workspace'].includes(hash) ? hash : 'team';
  return `/app/settings?${params}#${section}`;
}
