# Independent shared-sandbox review — 4 November 2026

The candidate changes the application to one retained prepared sandbox per authenticated account and an independent Pi session/folder for every request. Infrastructure concurrency is an explicit immutable-profile opt-in; omitted capacity remains one. This review does not approve a stable infrastructure release.

## Review status

Final application source review covered integrated commit `cf40bbf3eeec172ce496288bfc341c2499a713c4`, including application `43668fc`, infrastructure `9ce7df3` and workload `4fb123d` (integrated as `819ea63`). A focused follow-up reviewed Provider deadline correction `6b4e0be`, integrated by `a156ee8`; that follow-up found the two open faults below. Deployed hosted qualification remains separate. The independent reviewer made no GCC changes, Cloud calls or model calls.

Two cross-service faults were found and reported to the integration lead and application implementer before deployment:

1. Preparation submitted the normal 900-second execution limit to a profile capped at 180 seconds. Runner correctly rejected that payload, which would have failed preparation after uploading the runtime. The application now bounds preparation to `min(180, configured execution limit)` and its HTTP-adapter regression checks the actual profile, arguments, idempotency key and limit.
2. Provider interrupted-transfer recovery can stop a shared sandbox after its last active run finishes. The application previously kept its workspace `ready` and retried transfers forever against the stopped sandbox. The application now inspects the same authorized sandbox on lifecycle/busy errors, records an observed stop, and resumes the same disk through its existing workspace path, retaining request/job identities and avoiding another runtime upload. A regression exercises that transition.

Both application fixes were inspected and independently exercised against the integrated source. The subsequent original-deadline correction remains blocked on these independently reproduced Provider faults:

1. The guest computes `remaining` before acquiring `control.lock` and reuses it when launching the child. In a real local Linux subprocess probe, the reviewer held that lock for 0.4 seconds while the absolute deadline was 0.15 seconds away. After unlocking, `/bin/sh` created its marker after expiry in all ten trials; two even published exit zero. The deadline must be checked immediately before launch after the journal write/fsync, with a lock-contention regression.
2. Timeout classification depends on when output is collected. An actual shared child explicitly exiting 124 before its deadline produced one verified envelope; immediate collection returned exit124, while late collection and late journal recovery returned `deadline_exceeded` for those identical bytes. The guest must retain a checksum-bound completion reason so an ordinary workload exit124 does not become a timeout merely because the Provider recovered later.

These findings were reported to the integration lead and infrastructure implementer. This is not a stable-release or hosted-feature acceptance decision.

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
| Original-deadline follow-up shared/envelope suites at `6b4e0be` | 19 passed | Fresh disposable PostgreSQL, mocked runtime/SDK and actual local supervisor subprocesses; existing tests do not cover the separately reproduced lock contention and late exit124 classification faults |
| Final seven-table encrypted backup/isolated restore | 2 passed | Real newly created PostgreSQL databases/RustFS buckets, three immutable objects, workspace/settings/request prompt retention, exact audits/sequences, replay, no-overwrite and quiescence guards; no worker/runtime client |

Provider and Runner independent tests used new `workflow_shared_qa_*` databases inside the existing labeled disposable test PostgreSQL containers; only those newly created databases were dropped afterwards. They did not truncate shared implementation-test schemas or touch retained state. The initial full Provider/Runner runs used the evolving implementation worktree. The final seven-test Provider suite, 17-test application suite and two-test seven-table backup/restore were rerun from the QA merge of integrated source `cf40bbf` (the backup drill consumed the matching application build from `43668fc`). All temporary databases/buckets were removed by the checked cleanup paths.

The focused deadline follow-up ran only `tests/test_shared_execution.py` and `tests/test_result_envelope.py` from the QA merge of `a156ee8`; all 19 passed in 7.11 seconds. Its fresh database `workflow_shared_qa_233d4c9d9e90` was dropped. The two additional probes used temporary directories and actual local supervisor processes, without any service deployment, Cloud/model call or implementation change.

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
