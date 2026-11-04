# Initial application release scope

The 3 November 2026 continuation authorizes application scaffolding alongside
remaining reusable infrastructure work. Mandatory Phase 1 gates still control
stable readiness. This scope narrows the original Phase 2 requirements.

The authenticated application has three functions:

1. Submit instructions and permitted attachments, with confirmation or an error.
2. List every authorized request with creation time and status, using pagination.
3. Open a request to read its final text, download validated files, or see an
   actionable failure. Pending and running requests remain visible.

Requests, original inputs, results and audits persist in application-owned
PostgreSQL and private object storage. Only the authenticated application is
exposed over HTTPS. Runner, Provider, databases and storage stay private.

## Deferred features

Dashboards, analytics, workflow editors, infrastructure controls, chat,
revision feedback, approvals, clarification dialogs, skill management, project
administration and document editors are deferred. No hidden implementation of
these features is part of this release. Authentication and ownership checks
remain required; account management is outside scope.

## Storage and recovery decision

The owner requested self-hosted storage in the existing GCC Coolify project
and declined Coolify S3 backup destination integration. Private RustFS provides
the application's S3-compatible file API. Its named volume is persistence on
the GCC host, not an off-host backup. Encrypted database and required file
exports must also be copied to independent storage and restored in isolation.
Cloud snapshots, image exports and VM cloning are not assumed available.

## Release decision

Source, deployed versions and executed evidence are recorded independently.
An application preview does not establish a stable infrastructure release.
Host reboot and vendor host persistence remain unverified unless demonstrated.
