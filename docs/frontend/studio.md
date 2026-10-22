# Studio frontend

The customer site and workspace use the Studio interface in `apps/web/src/client/studio`.
The public repository contains the homepage, authentication presentation, advertisement and advertiser research, channel and landing-page views, collections, notes, team, account, preferences, and billing presentation.

## Runtime contracts

Wasp registers `getStudioCatalog`, `getStudioState`, `studioCommand`, and `getStudioPublicOverview`. Catalog aggregates are calculated from the configured database, including the full matching set before pagination. Workspace reads and preference writes require an active workspace membership. Existing search, detail, history, research, account, and billing operations remain in use.

Apply the normal Wasp database migrations before starting this version. The additive Studio migration stores preferences and followed advertisers per user and workspace. It also adds the nullable advertisement quarantine marker used by catalog reads. No customer records or initial advertising dataset are included.

`getCustomerSnapshot` returns disabled in the self-hosted implementation. `CustomerSnapshotProvider` retains the optional publication/pinning UI contract for deployments that supply snapshot-aware APIs. The public frontend does not publish snapshots, copy production databases, or contain the Cloud snapshot publisher. A deployment enabling this contract must make every catalog, detail, history, and saved-ad reader resolve the same authorized version.

Unconnected product data and notifications display their actual empty/unavailable state. Automatic renewal can be cancelled through the existing billing operation; resuming renewal is not exposed until the deployment supports it.

## Assets and configuration

The frontend includes the project brand, original Antarctic footer image, and original error illustrations. Advertiser images come from the configured API; missing logos use initials. Production captures, collection evidence, supplier exports, credentials, and production configuration are excluded. Existing instance-origin and consent-based analytics configuration continues to apply.

## Verification

Use the pinned Node toolchain and the repository's Wasp bootstrap instructions. Run source typechecking, Studio/authentication interaction tests, and the Wasp production build. Database integration tests require an explicitly owned, isolated test database; the frontend test fixtures are synthetic.
