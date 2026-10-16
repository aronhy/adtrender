/// <reference lib="dom" />
/// <reference types="vite/client" />

import { app, page, route, query, action, api } from '@wasp.sh/spec';
import { App } from './src/client/App' with { type: 'ref' };
import { LandingPage,PricingPage,HelpPage,TermsPage,PrivacyPage,WorkspaceEntryPage,WorkspacePage,AdsPage,AdDetailPage,ResearchPage,SettingsPage,AdminPage,NotFoundPage } from './src/client/Pages' with { type: 'ref' };
import { LoginPage, SignupPage, RequestPasswordResetPage, PasswordResetPage, EmailVerificationPage } from './src/auth/Pages' with { type: 'ref' };
import { GoogleCallbackPage } from './src/auth/GoogleCallbackPage' with { type: 'ref' };
import { getVerificationEmailContent, getPasswordResetEmailContent } from './src/auth/emails' with { type: 'ref' };
import { getEmailUserFields } from './src/auth/signup' with { type: 'ref' };
import { getGoogleUserFields } from './src/auth/google-signup' with { type: 'ref' };
import { getGoogleAuthConfig } from './src/auth/google' with { type: 'ref' };
import { serverSetup } from './src/server/setup' with { type: 'ref' };
import { middlewareConfig } from './src/server/middleware' with { type: 'ref' };
import { onBeforeSignup,onAfterSignup,onBeforeLogin,onAfterLogin } from './src/auth/hooks' with { type: 'ref' };
import { getPlatformAdminData,platformAdminCommand } from './src/server/platform-admin-operations' with { type: 'ref' };
import { getAppState,getPublicPricing,searchPublicAds,getPublicAd,getPublicRelatedAds,getPublicAdMediaDownload,getPublicAdHistory,getPublicAdHistoryEvidence,getResearchPage,getAdminPage,getGrowthOverview,appCommand } from './src/server/operations' with { type: 'ref' };
import { health,stripeWebhook,stripeMiddleware } from './src/server/api' with { type: 'ref' };
import { growthConsent,growthEvents,growthMiddleware } from './src/growth/api' with { type: 'ref' };
import {getSeedPage,getSeedImportPreview,getSeedDetail,getSeedDispatchPage,getSeedOverview,getSeedCoverage,getSeedRules,exportSeedLibrary,seedCommand} from './src/server/seed-operations' with {type:'ref'};
import {collectorConfig,collectorConfigReceipt,collectorPlatformGrant,collectorClaim,collectorPermit,collectorPrepare,collectorSubmit,collectorRecover,collectorHeartbeat,collectorStart,collectorRenew,collectorStopped,collectorRestriction,collectorCheckpoint,collectorControlHandoff,collectorSourceStopContext,collectorMiddleware} from './src/server/collector-api-wasp-adapter' with {type:'ref'};

export default app({
  name: 'AdResearch',
  wasp: { version: '0.25.0' },
  title: 'AdThrender',
  head: ['<link rel="icon" type="image/svg+xml" href="/favicon.svg" />', '<meta name="description" content="搜索公开 Facebook 广告，查看素材与文案，在团队工作区保存有依据的广告研究。" />'],
  auth: {
    userEntity: 'User',
    methods: { email: {
      fromField: { name: 'AdThrender', email: 'research@example.com' },
      emailVerification: { clientRoute: 'EmailVerificationRoute', getEmailContentFn: getVerificationEmailContent },
      passwordReset: { clientRoute: 'PasswordResetRoute', getEmailContentFn: getPasswordResetEmailContent },
      userSignupFields: getEmailUserFields,
    }, google: { userSignupFields: getGoogleUserFields, configFn: getGoogleAuthConfig } },
    onAuthFailedRedirectTo: '/login', onAuthSucceededRedirectTo: '/app',
    onBeforeSignup,onAfterSignup,onBeforeLogin,onAfterLogin,
  },
  client: { rootComponent: App },
  server: { setupFn: serverSetup, middlewareConfigFn: middlewareConfig },
  emailSender: { provider: 'SMTP', defaultFrom: { name: 'AdThrender', email: 'research@example.com' } },
  spec: [
    route('LandingRoute', '/', page(LandingPage)),
    route('PricingRoute','/pricing',page(PricingPage)),
    route('HelpRoute','/help',page(HelpPage)),
    route('TermsRoute','/terms',page(TermsPage)),
    route('PrivacyRoute','/privacy',page(PrivacyPage)),
    route('WorkspaceRoute', '/app', page(WorkspaceEntryPage, {authRequired: true})),
    route('OverviewRoute', '/app/overview', page(WorkspacePage, {authRequired: true})),
    route('AdsRoute','/app/ads',page(AdsPage,{authRequired:true})),
    route('AdDetailRoute','/app/ads/:adId',page(AdDetailPage,{authRequired:true})),
    route('ResearchRoute','/app/research',page(ResearchPage,{authRequired:true})),
    route('SettingsRoute','/app/settings',page(SettingsPage,{authRequired:true})),
    route('AdminRoute','/app/admin',page(AdminPage,{authRequired:true})),
    route('LoginRoute', '/login', page(LoginPage)),
    route('SignupRoute', '/signup', page(SignupPage)),
    route('GoogleCallbackRoute', '/login/google/callback', page(GoogleCallbackPage)),
    route('RequestPasswordResetRoute', '/request-password-reset', page(RequestPasswordResetPage)),
    route('PasswordResetRoute', '/password-reset', page(PasswordResetPage)),
    route('EmailVerificationRoute', '/email-verification', page(EmailVerificationPage)),
    query(getAppState,{entities:['User','Organization','Workspace','OrganizationMember','WorkspaceMember','SavedAd','AnalysisJob','Entitlement','Subscription','PlanVersion','AccountSupportRequest','Feedback','MediaObject']}),
    query(getPublicPricing,{entities:['PlanVersion']}),
    query(searchPublicAds,{entities:['Ad','AdObservation','MediaObject','DataSource','SavedAd']}),
    query(getPublicAd,{entities:['Ad','Advertiser','AdObservation','MediaObject','SavedAd','DataSource','Workspace','Organization','OrganizationMember','WorkspaceMember','User']}),
    query(getPublicRelatedAds,{entities:['Ad','Advertiser','MediaObject','SavedAd','DataSource','Workspace','Organization','OrganizationMember','WorkspaceMember','User']}),
    query(getPublicAdMediaDownload,{entities:['Ad','MediaObject','Workspace','Organization','OrganizationMember','WorkspaceMember','User']}),
    query(getPublicAdHistoryEvidence,{entities:['Ad','AdObservation','ArchiveMediaCapture','Workspace','Organization','OrganizationMember','WorkspaceMember','User']}),
    query(getPublicAdHistory,{entities:['Ad','AdObservation','AdDailySnapshot','AdHistoryEvent','AdHistoryProjectionTask','Workspace','Organization','OrganizationMember','WorkspaceMember','User']}),
    query(getResearchPage,{entities:['User','Organization','Workspace','OrganizationMember','WorkspaceMember','Folder','SavedAd','Note','AnalysisJob','AnalysisResult']}),
    query(getPlatformAdminData,{entities:['User','Organization','Subscription','Entitlement','Ad','MediaObject','CollectionRun','DataSource','Feedback','AccountSupportRequest','EmailDelivery','ProductEvent','GrowthVisit','UsageLedger','AuditEvent','WorkerHeartbeat']}),
    action(platformAdminCommand,{entities:['User','Organization','Entitlement','MediaObject','DataSource','CollectionTask','CollectionRun','Feedback','AccountSupportRequest','EmailDelivery','AuditEvent']}),
    query(getAdminPage,{entities:['User','Organization','OrganizationMember','Subscription','PlanVersion','Entitlement','CollectionTask','CollectionRun','Feedback','AccountSupportRequest','MediaObject']}),
    query(getGrowthOverview,{entities:['User','GrowthVisit','GrowthEvent','ConversionEvent']}),
    query(getSeedPage,{entities:['User','SeedDefinition','SeedRelation','SeedEvidence','SeedPublication','AuditEvent','SeedScanPlan']}),
    query(getSeedImportPreview,{entities:['User','SeedImportJob']}),
    query(getSeedDetail,{entities:['User','SeedDefinition','SeedEvidence','SeedRelation','SeedQueryBinding','SeedAttempt']}),
    query(getSeedDispatchPage,{entities:['User','SeedQuery','SeedQueryBinding','SeedRuntimeState','SeedExecutionTask','SeedTaskAttempt','SeedPublication','SeedCollectorReceipt']}),
    query(getSeedOverview,{entities:['User','SeedDefinition','CollectionRun','RunItem','DataSource','SeedPublication','CollectorNode']}),
    query(getSeedCoverage,{entities:['User','CollectionRun','RunItem','DataSource','SeedAttempt']}),
    query(getSeedRules,{entities:['User','DataSource','CollectorSourceControl','SeedPublication','SeedCollectorReceipt','SeedScanPlan']}),
    query(exportSeedLibrary,{entities:['User','SeedDefinition']}),
    action(seedCommand,{entities:['User','SeedDefinition','SeedScanPlan','SeedEvidence','SeedRelation','SeedImportJob','SeedPublication','SeedQuery','SeedQueryBinding','LegacyJobMapping','SeedRuntimeState','SeedExecutionTask','DataSource','AuditEvent']}),
    action(appCommand,{entities:['User','Organization','Workspace','OrganizationMember','WorkspaceMember','Invitation','Folder','SavedAd','Note','AnalysisJob','Subscription','Entitlement','CollectionTask','CollectionRun','DataSource','Feedback','AccountSupportRequest','MediaObject','ProductEvent']}),
    api('GET','/health',health),
    api('GET','/api/internal/seeds/config',collectorConfig,{auth:false,middlewareConfigFn:collectorMiddleware}),
    api('POST','/api/internal/seeds/receipt',collectorConfigReceipt,{auth:false,middlewareConfigFn:collectorMiddleware}),
    api('GET','/api/internal/collection/platform-grant',collectorPlatformGrant,{auth:false,middlewareConfigFn:collectorMiddleware}),
    api('POST','/api/internal/collection/claim',collectorClaim,{auth:false,middlewareConfigFn:collectorMiddleware}),
    api('POST','/api/internal/collection/permit',collectorPermit,{auth:false,middlewareConfigFn:collectorMiddleware}),
    api('POST','/api/internal/collection/prepare-submit',collectorPrepare,{auth:false,middlewareConfigFn:collectorMiddleware}),
    api('POST','/api/internal/collection/submit',collectorSubmit,{auth:false,middlewareConfigFn:collectorMiddleware}),
    api('POST','/api/internal/collection/recover-submit',collectorRecover,{auth:false,middlewareConfigFn:collectorMiddleware}),
    api('POST','/api/internal/collection/heartbeat',collectorHeartbeat,{auth:false,middlewareConfigFn:collectorMiddleware}),
    api('POST','/api/internal/collection/start',collectorStart,{auth:false,middlewareConfigFn:collectorMiddleware}),
    api('POST','/api/internal/collection/renew',collectorRenew,{auth:false,middlewareConfigFn:collectorMiddleware}),
    api('POST','/api/internal/collection/stop',collectorStopped,{auth:false,middlewareConfigFn:collectorMiddleware}),
    api('POST','/api/internal/collection/restriction',collectorRestriction,{auth:false,middlewareConfigFn:collectorMiddleware}),
    api('POST','/api/internal/collection/checkpoint',collectorCheckpoint,{auth:false,middlewareConfigFn:collectorMiddleware}),
    api('POST','/api/internal/collection/control-handoff',collectorControlHandoff,{auth:false,middlewareConfigFn:collectorMiddleware}),
    api('GET','/api/internal/collection/source-stop-context',collectorSourceStopContext,{auth:false,middlewareConfigFn:collectorMiddleware}),
    api('POST','/growth/consent',growthConsent,{middlewareConfigFn:growthMiddleware}),
    api('POST','/growth/events',growthEvents,{middlewareConfigFn:growthMiddleware}),
    api('POST','/billing/stripe/webhook',stripeWebhook,{middlewareConfigFn:stripeMiddleware}),
    route('NotFoundRoute', '*', page(NotFoundPage)),
  ],
});
