# Independent shared-sandbox review — 4 November 2026

The candidate changes the application to one retained prepared sandbox per authenticated account and an independent Pi session/folder for every request. Infrastructure concurrency is an explicit immutable-profile opt-in; omitted capacity remains one. This review does not approve a stable infrastructure release.

## Review status

Final source review covered integrated commit `cf40bbf3eeec172ce496288bfc341c2499a713c4`, including application `43668fc`, infrastructure `9ce7df3` and workload `4fb123d` (integrated as `819ea63`). Deployed hosted qualification remains separate. The independent reviewer made no GCC changes, Cloud calls or model calls.

Two cross-service faults were found and reported to the integration lead and application implementer before deployment:

1. Preparation submitted the normal 900-second execution limit to a profile capped at 180 seconds. Runner correctly rejected that payload, which would have failed preparation after uploading the runtime. The application now bounds preparation to `min(180, configured execution limit)` and its HTTP-adapter regression checks the actual profile, arguments, idempotency key and limit.
2. Provider interrupted-transfer recovery can stop a shared sandbox after its last active run finishes. The application previously kept its workspace `ready` and retried transfers forever against the stopped sandbox. The application now inspects the same authorized sandbox on lifecycle/busy errors, records an observed stop, and resumes the same disk through its existing workspace path, retaining request/job identities and avoiding another runtime upload. A regression exercises that transition.

Both fixes were inspected and independently exercised against the integrated source. No remaining source-level blocker was found for a scoped candidate deployment. This is not a stable-release or hosted-feature acceptance decision.

## Independently executed checks

| Check | Result | What it establishes |
| --- | --- | --- |
| `contracts/tests/test_contracts.py` | 7 passed | OpenAPI/schema examples and optional bounded capacity; no running services |
| `node --test deploy/coolify-scope.test.mjs` | 2 passed | Exact project/environment membership guards without optional nested app fields; no control-plane calls |
| Workload `npm test` | 2 Node + 15 Python passed | Prompt/reference separation, archive identity/immutability checks, constrained tool arguments and two real overlapping guest subprocesses with a mocked Pi executable |
| Provider `pytest -q -m 'not real_runtime'` | 82 passed, 1 deselected | Real newly created disposable PostgreSQL; fake runtime or actual SDK against loopback; includes actual local Linux supervisor/setsid-descendant subprocess cancellation |
| Runner `npm test` | 22 passed, no skips | Real newly created disposable PostgreSQL and Graphile Worker with mocked Provider HTTP, including capacity two, queued third run, independent cancellation and migration replay with active rows |
| Final integrated application `npm test` | 17 passed, no skips | Real disposable PostgreSQL/RustFS with mocked execution, including both reported faults' regressions, owner prompts/idempotency and admission during an in-flight idle stop |
| Final integrated Provider shared-execution suite | 7 passed | Real newly created disposable PostgreSQL plus mocked runtime and real local Linux subprocesses; includes backend refusal, persisted nonce/deadline recovery and sibling-safe cancellation/transfer recovery |
| Final seven-table encrypted backup/isolated restore | 2 passed | Real newly created PostgreSQL databases/RustFS buckets, three immutable objects, workspace/settings/request prompt retention, exact audits/sequences, replay, no-overwrite and quiescence guards; no worker/runtime client |

Provider and Runner independent tests used new `workflow_shared_qa_*` databases inside the existing labeled disposable test PostgreSQL containers; only those newly created databases were dropped afterwards. They did not truncate shared implementation-test schemas or touch retained state. The initial full Provider/Runner runs used the evolving implementation worktree. The final seven-test Provider suite, 17-test application suite and two-test seven-table backup/restore were rerun from the QA merge of integrated source `cf40bbf` (the backup drill consumed the matching application build from `43668fc`). All temporary databases/buckets were removed by the checked cleanup paths.

The implementer separately supplied a direct actual Cloud feasibility result: two supervised commands shared one sandbox, cancellation reaped a detached descendant of one while the other completed, and the fixture was destroyed. This is implementer evidence, not an independently repeated hosted application journey. The final source additionally contains implementer [local-service/actual-Cloud evidence](../../services/sandbox-provider/evidence/shared-cloud-local-services-2026-11-04.json): two running jobs, transfer during execution, sibling-safe cancellation/deadline with detached-descendant reap, Provider SIGKILL journal recovery without replay and retained sandbox liveness. It ran local services against disposable PostgreSQL and actual Cloud, with synthetic Python workloads; it records dirty-source attribution and fixture destruction. It is not independently repeated or GCC/Pi application evidence.

## Source review conclusions and limits

- Provider capacity is claimed under the sandbox row lock, with a durable database trigger and persisted run identities/nonces. Stop/destroy check all active/cancelling runs. The representative `active_run_id` is updated when one sibling finishes and is not treated as an exhaustive list for shared profiles.
- Shared cancellation uses an identity-bound Linux subreaper journal, including descendants which create a new process group. Uncertain termination retains active/cancelling ownership; it must never fall back to stopping siblings. Single-run behavior remains the default.
- File transfer keeps immutable publication, path/checksum bounds and pending-operation generations. Recovery waits for active shared runs before stopping the same retained box.
- Application admission, durable idle-stop intent and same-disk restart coordinate through the per-owner workspace lifecycle lock. A new request admitted during an external stop waits for that retained disk to restart. No stop is authorized merely because one sibling exported.
- The editable default is owner scoped and snapshotted into each request. Request instructions join the system prompt; attachments remain untrusted user/reference data. The fixed workload binds the actual UUID directory and OfficeCLI target independently of an edited prompt.
- Workload request HOME, session, agent configuration, caches and temporary files are separate. Shared runtime publication is read-only and normal requests do not reinstall or rehash the archive.
- New application snapshots contain seven tables, including user workspace/settings and prompt snapshots. Historical five-table archives require their matching historical source helper followed by a separately reviewed migration. Logical snapshot/restore is not Cloud guest-disk recovery.

The implementer separately passed desktop/mobile browser checks for collapsed prompt, autosave/reload and request snapshots. Stable feature acceptance still requires a hosted two-request journey proving same-sandbox overlap, distinct Pi sessions/UUID folders, validated export and safe idle stop/restart; and persistence verification against the final deployed commits. These checks do not qualify general semantic accuracy, rendered layout, sustained multitenant load, comprehensive network/escape isolation, host restart or full Cloud disk restore. `ready_for_phase2` and stable release remain false.
