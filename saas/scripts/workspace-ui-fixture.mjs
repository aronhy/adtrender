/** Synthetic view models for workspace-ui-smoke. Never connects to a database. */
export const ids = Object.fromEntries(['user', 'organization', 'workspace', 'otherWorkspace', 'ad', 'otherAd', 'folder', 'saved', 'note', 'member', 'analysis'].map((key, index) => [key, `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
const timestamp = '2026-10-07T08:00:00.000Z';
export function workspaceFixture(origin, { empty = false, noWorkspace = false, role = 'OWNER', long = false } = {}) {
  const name = long ? 'Synthetic international research team / Equipo de investigación internacional '.repeat(4) : 'Synthetic research team';
  const workspace = { id: ids.workspace, organizationId: ids.organization, name: long ? 'Long workspace name — '.repeat(8) : 'Creative research' };
  const health = { status: 'DEGRADED', updatedAt: timestamp, message: null };
  const ad = { id: ids.ad, sourceAdId: 'synthetic-source-1', advertiserName: long ? 'Independent brand with a deliberately long advertiser name '.repeat(4) : 'Synthetic Studio', copy: long ? 'Synthetic public copy. Evidence has limits; test this idea with your own data. '.repeat(35) : 'Thoughtful everyday products. Explore a different approach to everyday work.', headline: 'Made for everyday research', cta: 'LEARN_MORE', sourceUrl: 'https://example.test/source', landingPageUrl: 'https://example.test/landing', publisherPlatforms: ['Facebook', 'Instagram'], status: 'active', mediaType: 'IMAGE', firstObservedAt: timestamp, lastObservedAt: timestamp, saved: false, media: [{ id: 'synthetic-image', type: 'IMAGE', status: 'READY', displayUrl: `${origin.replace(/^http:/, 'https:')}/__workspace-fixture__/ad.svg` }, { id: 'synthetic-video', type: 'VIDEO', status: 'FAILED' }] };
  const saved = { id: ids.saved, adId: ids.ad, advertiserName: ad.advertiserName, copy: ad.copy, folderId: ids.folder, savedAt: timestamp, notes: [{ id: ids.note, savedAdId: ids.saved, body: long ? 'A deliberately long synthetic research note. '.repeat(80) : 'Compare the message with the original source before drawing conclusions.', updatedAt: timestamp }] };
  const analyses = ['SUCCEEDED', 'FAILED', 'QUEUED', 'CANCELED'].map((status, index) => ({ id: `${ids.analysis}-${index}`, adId: ids.ad, advertiserName: ad.advertiserName, status, attempt: 1, createdAt: timestamp, errorCode: status === 'FAILED' ? 'ANALYSIS_NOT_CONFIGURED' : null, result: status === 'SUCCEEDED' ? { facts: 'The source includes a product description.', interpretation: 'The copy may address practical daily needs.', limitations: 'Only public text was reviewed. No performance data is available.', evidence: ['[body] Thoughtful everyday products.'] } : null }));
  const state = {
    user: { id: ids.user, email: 'workspace-fixture@example.test', displayName: 'Synthetic reviewer', isAdmin: false, emailVerified: true, emailNotifications: true },
    organizations: noWorkspace ? [] : [{ id: ids.organization, name, role: role === 'OWNER' || role === 'ADMIN' ? role : 'MEMBER' }],
    workspaces: noWorkspace ? [] : [workspace, { ...workspace, id: ids.otherWorkspace, name: 'Second research space' }], selectedWorkspace: noWorkspace ? null : workspace, role: noWorkspace ? 'NONE' : role,
    overview: { savedCount: empty ? 0 : 25, analysisCount: empty ? 0 : 4, pendingAnalysisCount: empty ? 0 : 1, dataUpdatedAt: timestamp, sourceHealth: health },
    research: { folders: empty ? [] : [{ id: ids.folder, name: long ? 'Synthetic folder name '.repeat(12) : 'Opening messages' }], savedAds: empty ? [] : [saved], notes: empty ? [] : saved.notes, analyses: empty ? [] : analyses },
    billing: noWorkspace ? null : { organizationId: ids.organization, planName: 'Synthetic trial', status: 'TRIALING', periodEnd: '2026-11-07T08:00:00.000Z', cancelAtPeriodEnd: false, checkoutEnabled: false, hasProviderSubscription: false, canChangePlan: false, providerMode: 'unconfigured', invoices: [], plans: [], entitlements: ['WORKSPACES', 'MEMBERS', 'SAVED_ADS', 'ANALYSES'].map((key, index) => ({ key, label: key, status: 'ACTIVE', used: index + 1, limit: 30, resetAt: '2026-11-07T08:00:00.000Z' })) },
    members: role === 'OWNER' || role === 'ADMIN' ? [{ id: ids.member, displayName: 'Synthetic reviewer', email: 'workspace-fixture@example.test', organizationRole: 'OWNER', workspaceRole: null }, { id: 'second-member', displayName: 'Synthetic editor', email: 'editor@example.test', organizationRole: 'MEMBER', workspaceRole: 'EDITOR' }] : [],
    invitations: [], supportRequests: [], organizationSupportRequests: [],
  };
  function search(args = {}) {
    const ads = empty ? [] : [{ ...ad, id: args.cursor ? ids.otherAd : ids.ad, saved: state.research.savedAds.some(row => row.adId === ad.id), savedAdId: state.research.savedAds.find(row => row.adId === ad.id)?.id }];
    return { ads, nextCursor: empty || args.cursor ? null : 'synthetic-search-page-2', sourceHealth: health, summary: { total: empty ? 0 : 25, images: empty ? 0 : 25, videos: 0, firstObservedAt: timestamp, lastObservedAt: timestamp, recentNew7Days: empty ? 0 : 25, asOf: timestamp, sourceStatus: { active: empty ? 0 : 25, inactive: 0, unknown: 0 } } };
  }
  function research(args = {}) { return { kind: args.kind ?? 'saved', total: empty ? 0 : args.kind === 'analysis' ? analyses.length : 25, asOf: timestamp, nextCursor: empty || args.cursor || args.kind === 'analysis' ? null : 'synthetic-research-page-2', savedAds: args.kind === 'analysis' ? [] : state.research.savedAds, analyses: args.kind === 'analysis' ? state.research.analyses : [] }; }
  function command(args) {
    if (args.type === 'CREATE_ORGANIZATION' || args.type === 'CREATE_WORKSPACE' || args.type === 'ACCEPT_INVITATION') {
      state.organizations = [{ id: ids.organization, name: args.name ?? name, role: 'OWNER' }]; state.workspaces = [workspace]; state.selectedWorkspace = workspace; state.role = 'OWNER';
      return { workspaceId: workspace.id, message: 'Synthetic operation completed.' };
    }
    if (args.type === 'CREATE_FOLDER') state.research.folders.push({ id: `${ids.folder}-new`, name: args.name });
    if (args.type === 'SAVE_AD' && !state.research.savedAds.some(row => row.adId === args.adId)) state.research.savedAds.push(saved);
    if (args.type === 'UPDATE_PROFILE') state.user.displayName = args.displayName;
    return { message: 'Synthetic operation completed.' };
  }
  return { state, ad, search, research, command, detail: { ad, media: ad.media, observations: [{ id: 'synthetic-observation', observedAt: timestamp, sourceStatus: 'ACTIVE', queryCountry: 'US', parserVersion: 'fixture' }] } };
}

export const syntheticCreative = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="720" viewBox="0 0 640 720"><rect width="640" height="720" fill="#e7e4de"/><rect x="60" y="100" width="520" height="430" rx="30" fill="#254637"/><circle cx="320" cy="320" r="135" fill="#d7e5b5"/><text x="320" y="603" font-family="sans-serif" font-size="27" text-anchor="middle" fill="#254637">SYNTHETIC RESEARCH FIXTURE</text></svg>`;
