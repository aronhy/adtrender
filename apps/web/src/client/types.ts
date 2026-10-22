/** Client/API view models. IDs are targets; the server derives the actor from the Wasp session. */
export type DateValue = string | Date | null;
export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER' | 'NONE';
export type WorkspaceView = { id: string; organizationId: string; name: string }
export type OrganizationView = { id: string; name: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' }
export type SourceHealth = { status: string; message?: string | null; updatedAt?: DateValue }
export type MediaView = { id: string; type: string; status: string; displayUrl?: string | null; displayUrlExpiresAt?: DateValue; posterUrl?: string | null; errorCode?: string | null }
export type AdPlatform = 'facebook' | 'instagram' | 'messenger' | 'audience_network' | 'pinterest' | 'google' | 'youtube' | 'tiktok' | 'snapchat';
export type AdView = {
  advertiserRecordId?: string;
  id: string; sourceAdId: string; advertiserName: string | null; copy?: string | null; headline?: string | null;
  description?: string | null; cta?: string | null; sourceUrl: string; landingPageUrl?: string | null;
  publisherPlatforms: string[]; status: string; mediaType?: string | null; firstObservedAt: DateValue;
  lastObservedAt: DateValue; sourceStartedAt?: DateValue; sourceEndedAt?: DateValue;
  media?: MediaView[]; saved?: boolean; savedAdId?: string;
  advertiserAvatarUrl?:string|null; contentState?:'parsed'|'preview'|'missing'; dataSourceKey?:string|null; advertiserId?:string|null; reportedCountries?:string[]; statusObservedAt?:DateValue;
  deliverySummary?:import('../ad-history/delivery-summary').DeliverySummary;
}
export type SearchFilters = {
  workspaceId: string; query?: string; advertiser?: string; country?: string;
  source?: 'google'; channel?: 'SEARCH'|'YOUTUBE'|'UNKNOWN'; domain?: string; business?: 'ECOMMERCE'|'GAMES'|'COMICS'|'GENERAL'|'UNCLASSIFIED'; category?: string; contentStatus?: 'available'|'parsed'|'preview'|'missing'; exact?: boolean; exclude?: string;
  mediaType?: string; status?: string; observedFrom?: string; observedTo?: string;
  platform?: AdPlatform; startedFrom?: string; startedTo?: string;
  sort?: 'recent'; cursor?: string; limit?: number;
}
export type SearchResult = {
  ads: AdView[]; nextCursor: string | null; categoryOptions?: string[];
  summary: { total: number; images?: number; videos?: number; firstObservedAt?: DateValue; lastObservedAt?: DateValue; unknownMedia?: number; recentNew7Days?: number; asOf?: DateValue; sourceStatus?: {active:number;inactive:number;unknown:number} };
  sourceHealth: SourceHealth;
}
export type AdvertiserSummaryView = {
  name: string | null; sourceAdvertiserId: string; dataSourceKey: string | null; websiteUrl: string | null;
  collectedAds: number; activeAds: number; newAds7Days: number; asOf: string; recentAds: AdView[];
}
export type RelatedAdsQuery = { workspaceId: string; adId: string; cursor?: string; limit?: number };
export type RelatedAdsResult = { ads: AdView[]; nextCursor: string | null; asOf: string; total: number; anchorIdentity: { sourceAdvertiserId: string; dataSourceKey: string | null } | null };
export type AdMediaDownloadQuery = { workspaceId: string; adId: string; mediaId: string };
export type AdMediaDownloadResult = { url: string; expiresAt: DateValue };
export type AdDetailResult = {
  ad: AdView; media: MediaView[]; advertiserSummary: AdvertiserSummaryView | null;
  observations: Array<{ id: string; observedAt: DateValue; sourceStatus: string; queryCountry?: string | null; parserVersion?: string | null }>;
}
export type SavedAdView = { id: string; adId: string; advertiserName: string | null; copy?: string | null; folderId?: string | null; savedAt: DateValue }
export type NoteView = { id: string; savedAdId: string; body: string; updatedAt: DateValue }
export type AnalysisView = {
  id: string; adId: string; advertiserName: string | null; status: string; createdAt: DateValue; attempt?: number;
  errorCode?: string | null; result?: { facts?: string; interpretation?: string; limitations?: string; evidence?: string[] } | null;
}
export type ResearchPageQuery = { workspaceId: string; kind: 'saved' | 'analysis'; folderId?: string; cursor?: string; limit?: number };
export type ResearchPageResult = {
  kind: 'saved' | 'analysis'; total: number; asOf: string; nextCursor: string | null;
  savedAds: Array<SavedAdView & { notes: NoteView[] }>; analyses: AnalysisView[];
};
export type BillingView = {
  organizationId: string;
  planName: string | null; status: string; periodEnd: DateValue; cancelAtPeriodEnd: boolean;
  checkoutEnabled: boolean; hasProviderSubscription?: boolean; canChangePlan?:boolean; providerMode?: 'sandbox' | 'live' | 'unconfigured';
  invoiceStatus?: 'READY' | 'UNAVAILABLE';
  invoices?: Array<{ id: string; number?: string | null; status: string; totalMinor: number; currency: string; issuedAt: DateValue; invoiceUrl?: string | null; receiptUrl?: string | null }>;
  entitlements: Array<{ key: string; label: string; resetAt?: DateValue } & (
    { status: 'ACTIVE'; used: number; limit: number | null } |
    { status: 'UNAVAILABLE'; used: null; limit: null }
  )>;
  plans: Array<{ id: string; name: string; description?: string; priceMinor: number | null; currency: string | null; interval: string; features: string[] }>;
}
export type MemberView = { id: string; displayName: string | null; email: string; organizationRole: string; workspaceRole?: string | null }
export type AdminView = {
  users?: Array<{id:string;email:string|null;disabledAt:DateValue;isAdmin:boolean}>;
  mediaFailures?: Array<{id:string;adId:string;errorCode:string|null}>;
  sources: Array<{ id: string; name: string; status: string; verifiedProfiles?: string[]; lastSuccessAt?: DateValue }>;
  tasks: Array<{ id: string; name: string; dataSourceId: string; status: string; query: string; country: string; intervalMinutes?: number | null }>;
  runs: Array<{ id: string; taskId: string; status: string; startedAt: DateValue; finishedAt?: DateValue; fetchedCount: number; createdCount?: number; updatedCount?: number; coverage?: string; restrictedReason?: string | null; errorCode?: string | null }>;
  customers: Array<{ id: string; name: string; status: string; planName?: string | null; memberCount: number; analysisUsed?: number }>;
  feedback: Array<{ scope?: 'ACCOUNT' | 'ORGANIZATION'; id: string; category: string; message: string; status: string; createdAt: DateValue; subject: string | null; requester: { id: string; email: string | null } | null; organization: { id: string; name: string } | null; workspace: { id: string; name: string } | null }>;
  health: Array<{ key: string; label: string; status: string; message?: string | null }>;
  productEvents?: Array<{ name: string; count: number; organizationCount: number }>;
}
export type AdminPageKind = 'users' | 'customers' | 'tasks' | 'runs' | 'organizationFeedback' | 'accountSupport' | 'mediaFailures';
export type AdminPageQuery = { kind: AdminPageKind; cursor?: string; limit?: number };
export type AdminCustomerView = AdminView['customers'][number] & {
  subscription: { status: string; currentPeriodStart: DateValue; currentPeriodEnd: DateValue; trialEndsAt: DateValue; cancelAtPeriodEnd: boolean } | null;
  quotaCheckedAt: DateValue;
  entitlements: Array<{
    key: 'WORKSPACES' | 'MEMBERS' | 'SAVED_ADS' | 'ANALYSES';
    current: { limit: number; used: number; reserved: number; source: 'PLAN' | 'MANUAL' | 'STRIPE' | 'UNKNOWN'; periodStart: DateValue; periodEnd: DateValue; validFrom: DateValue; validUntil: DateValue } | null;
  }>;
};
export type AdminPageResult = {
  kind: AdminPageKind; total: number; asOf: string; nextCursor: string | null;
  users: NonNullable<AdminView['users']>; customers: AdminCustomerView[]; tasks: AdminView['tasks'];
  runs: Array<AdminView['runs'][number] & { taskName: string }>;
  feedback: AdminView['feedback']; mediaFailures: NonNullable<AdminView['mediaFailures']>;
};
export type AppState = {
  user: { id: string; email: string; displayName: string | null; isAdmin: boolean; emailVerified?: boolean; emailNotifications?: boolean };
  organizations: OrganizationView[]; workspaces: WorkspaceView[]; selectedWorkspace: WorkspaceView | null; role: WorkspaceRole;
  overview: { savedCount: number; analysisCount: number; pendingAnalysisCount: number; dataUpdatedAt: DateValue; sourceHealth: SourceHealth };
  research: { folders: Array<{ id: string; name: string }>; savedAds: SavedAdView[]; notes: NoteView[]; analyses: AnalysisView[] };
  billing: BillingView | null; members: MemberView[];
  invitations?: Array<{ id: string; email: string; role: string; status: string; expiresAt: DateValue }>;
  supportRequests?: Array<{id:string;kind:string;body:string;status:string;createdAt:DateValue;resolvedAt?:DateValue}>;
  organizationSupportRequests?: Array<{id:string;category:string;subject:string;body:string;status:string;createdAt:DateValue;resolvedAt:DateValue;organization:{id:string;name:string};workspace:{id:string;name:string}|null}>;
  admin?: AdminView;
}
export type AppCommand =
  | { type:'SET_ACCOUNT_STATUS'; targetUserId:string; disabled:boolean; reason:string }
  | { type:'RETRY_MEDIA'; mediaId:string }
  | { type: 'CREATE_ORGANIZATION'; name: string; workspaceName: string }
  | { type: 'CREATE_WORKSPACE'; organizationId: string; name: string }
  | { type: 'ARCHIVE_WORKSPACE'; organizationId: string; workspaceId: string }
  | { type: 'REMOVE_WORKSPACE_MEMBER'; organizationId: string; workspaceId: string; memberId: string }
  | { type: 'SAVE_AD'; workspaceId: string; adId: string; folderId?: string }
  | { type: 'REMOVE_SAVED_AD'; workspaceId: string; savedAdId: string }
  | { type: 'MOVE_SAVED_AD'; workspaceId: string; savedAdId: string; folderId: string | null }
  | { type: 'CREATE_FOLDER'; workspaceId: string; name: string }
  | { type: 'SAVE_NOTE'; workspaceId: string; savedAdId: string; noteId?: string; body: string }
  | { type: 'DELETE_NOTE'; workspaceId: string; noteId: string }
  | { type: 'ANALYZE_AD'; workspaceId: string; adId: string; idempotencyKey: string }
  | { type: 'RETRY_ANALYSIS'; workspaceId: string; jobId: string; attemptKey: string }
  | { type: 'CANCEL_ANALYSIS'; workspaceId: string; jobId: string }
  | { type: 'INVITE_MEMBER'; workspaceId: string; email: string; role: 'ADMIN' | 'EDITOR' | 'VIEWER' }
  | { type: 'ACCEPT_INVITATION'; token: string }
  | { type: 'UPDATE_MEMBER'; workspaceId: string; memberId: string; organizationRole: 'ADMIN' | 'MEMBER'; workspaceRole: 'EDITOR' | 'VIEWER' }
  | { type: 'REMOVE_MEMBER'; workspaceId: string; memberId: string }
  | { type: 'TRANSFER_OWNERSHIP'; organizationId: string; memberId: string }
  | { type: 'UPDATE_PROFILE'; displayName: string; emailNotifications: boolean }
  | { type: 'CHECKOUT'; organizationId: string; planVersionId: string }
  | { type: 'CANCEL_SUBSCRIPTION'; organizationId: string }
  | { type: 'CHANGE_PLAN'; organizationId: string; planVersionId: string }
  | { type: 'SUBMIT_FEEDBACK'; workspaceId?: string; category: string; message: string }
  | { type: 'REQUEST_DELETION'; organizationId?: string; scope: 'ACCOUNT' | 'ORGANIZATION'; reason: string }
  | { type: 'CREATE_COLLECTION_TASK'; dataSourceId: string; name: string; query: string; country: string; mediaType: string; maxItems?: number; intervalMinutes: number | null }
  | { type: 'SET_TASK_STATUS'; taskId: string; status: 'ACTIVE' | 'PAUSED' }
  | { type: 'RUN_COLLECTION_TASK'; taskId: string; idempotencyKey: string }
  | { type: 'CANCEL_COLLECTION_RUN'; runId: string }
  | { type: 'SET_DATA_SOURCE_STATUS'; dataSourceId: string; status: 'ACTIVE' | 'PAUSED' }
  | { type: 'ADJUST_ENTITLEMENT'; organizationId: string; key: string; limit: number; reason: string }
  | { type: 'RESOLVE_FEEDBACK'; feedbackId: string; scope?: 'ACCOUNT' | 'ORGANIZATION'; status: 'RESOLVED' }
  | { type: 'PRODUCT_EVENT'; workspaceId: string; adId: string; name: 'ad_detail_open' | 'source_link_click' | 'media_play' };
export type CommandResult = { message?: string; redirectUrl?: string; workspaceId?: string | null; organizationId?: string }
