# Independent shared-sandbox review — 4 November 2026

The candidate changes the application to one retained prepared sandbox per authenticated account and an independent Pi session/folder for every request. Infrastructure concurrency is an explicit immutable-profile opt-in; omitted capacity remains one. This review does not approve a stable infrastructure release.

## Review status

Initial review covered root integration `819ea63`, workload `4fb123d` (integrated as `819ea63`), and the evolving application and infrastructure implementation worktrees. Final source/deployment attribution and hosted qualification remain to be added after integration. The independent reviewer made no GCC changes, Cloud calls or model calls.

Two cross-service faults were found and reported to the integration lead and application implementer before deployment:

1. Preparation submitted the normal 900-second execution limit to a profile capped at 180 seconds. Runner correctly rejected that payload, which would have failed preparation after uploading the runtime. The application now bounds preparation to `min(180, configured execution limit)` and its HTTP-adapter regression checks the actual profile, arguments, idempotency key and limit.
2. Provider interrupted-transfer recovery can stop a shared sandbox after its last active run finishes. The application previously kept its workspace `ready` and retried transfers forever against the stopped sandbox. The application now inspects the same authorized sandbox on lifecycle/busy errors, records an observed stop, and resumes the same disk through its existing workspace path, retaining request/job identities and avoiding another runtime upload. A regression exercises that transition.

Both fixes were inspected in the implementation worktree. Independent final application regression is pending while the implementer finishes coordinated browser and checkpoint checks.

## Independently executed checks

| Check | Result | What it establishes |
| --- | --- | --- |
| `contracts/tests/test_contracts.py` | 7 passed | OpenAPI/schema examples and optional bounded capacity; no running services |
| `node --test deploy/coolify-scope.test.mjs` | 2 passed | Exact project/environment membership guards without optional nested app fields; no control-plane calls |
| Workload `npm test` | 2 Node + 15 Python passed | Prompt/reference separation, archive identity/immutability checks, constrained tool arguments and two real overlapping guest subprocesses with a mocked Pi executable |
| Provider `pytest -q -m 'not real_runtime'` | 82 passed, 1 deselected | Real newly created disposable PostgreSQL; fake runtime or actual SDK against loopback; includes actual local Linux supervisor/setsid-descendant subprocess cancellation |
| Runner `npm test` | 22 passed, no skips | Real newly created disposable PostgreSQL and Graphile Worker with mocked Provider HTTP, including capacity two, queued third run, independent cancellation and migration replay with active rows |
| Application HTTP-adapter regression | 1 passed | Published request shapes/auth, bounded checksummed transfers and the corrected 180-second preparation payload; remote services mocked |

Provider and Runner independent tests used new `workflow_shared_qa_*` databases inside the existing labeled disposable test PostgreSQL containers; only those newly created databases were dropped afterwards. They did not truncate shared implementation-test schemas or touch retained state. Their source was still uncommitted at execution, so final commit attribution requires integration readback and relevant rechecks.

The implementer separately supplied a direct actual Cloud feasibility result: two supervised commands shared one sandbox, cancellation reaped a detached descendant of one while the other completed, and the fixture was destroyed. This is implementer evidence, not an independently repeated hosted application journey. Any later full local-service/Cloud or GCC browser evidence must retain its distinct scope and identities.

## Source review conclusions and limits

- Provider capacity is claimed under the sandbox row lock, with a durable database trigger and persisted run identities/nonces. Stop/destroy check all active/cancelling runs. The representative `active_run_id` is updated when one sibling finishes and is not treated as an exhaustive list for shared profiles.
- Shared cancellation uses an identity-bound Linux subreaper journal, including descendants which create a new process group. Uncertain termination retains active/cancelling ownership; it must never fall back to stopping siblings. Single-run behavior remains the default.
- File transfer keeps immutable publication, path/checksum bounds and pending-operation generations. Recovery waits for active shared runs before stopping the same retained box.
- Application admission, durable idle-stop intent and same-disk restart coordinate through the per-owner workspace lifecycle lock. A new request admitted during an external stop waits for that retained disk to restart. No stop is authorized merely because one sibling exported.
- The editable default is owner scoped and snapshotted into each request. Request instructions join the system prompt; attachments remain untrusted user/reference data. The fixed workload binds the actual UUID directory and OfficeCLI target independently of an edited prompt.
- Workload request HOME, session, agent configuration, caches and temporary files are separate. Shared runtime publication is read-only and normal requests do not reinstall or rehash the archive.
- New application snapshots contain seven tables, including user workspace/settings and prompt snapshots. Historical five-table archives require their matching historical source helper followed by a separately reviewed migration. Logical snapshot/restore is not Cloud guest-disk recovery.

Still required for this feature candidate: exact integrated-source regression and browser/checkpoint results; a hosted two-request journey proving same-sandbox overlap, distinct Pi sessions/UUID folders, validated export and safe idle stop/restart; and persistence verification against the final deployed commits. These checks do not qualify general semantic accuracy, rendered layout, sustained multitenant load, comprehensive network/escape isolation, host restart or full Cloud disk restore. `ready_for_phase2` and stable release remain false.
