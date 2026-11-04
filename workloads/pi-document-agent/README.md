# Pi document agent 0.1.0-rc.3

An approved workload for text requests and constrained editing of one DOCX working copy, with optional UTF-8 TXT/Markdown reference files. It uses the existing externally configured LiteLLM service. There are no infrastructure imports or database clients.

This shared-runtime candidate has not yet passed hosted qualification. The preceding rc2 package passed one uninterrupted synthetic DOCX journey through the actual hosted application, Runner, Provider, BoxLite Cloud, Pi/LiteLLM and OfficeCLI, with verified output/session export, protected download and same-sandbox stop. [Verification](VERIFICATION.md) records its exact scope and identities. Stable-release approval and broader Phase 1 readiness remain separate and incomplete.

## Runtime bundle

`runtime-lock.json` pins Linux x86_64 Node 24.22.2 and OfficeCLI 1.0.160 by vendor-published SHA256. `package-lock.json` pins Pi 1.5.0 and transitive npm package integrity. The bundle also includes ICU 72.1-3+deb12u1 (amd64), extracted using Docker from the immutable Debian bookworm Python image pinned in the lock. Each library and its copyright are checked against recorded hashes; host libraries are never copied. The builder requires Docker and access to that pinned source image. It downloads the exact binaries, runs npm's integrity-checked install with lifecycle scripts disabled and emits a normalized archive plus metadata. It does not create, snapshot, export or clone a VM.

```sh
npm ci --ignore-scripts
npm test
python3 build_runtime.py
```

Output is ignored under `output/runtime-bundle.tar.gz` and `output/runtime-bundle.json`. The bundle must remain within Provider's 256 MiB transfer limit; expansion is limited to 2 GiB and 40,000 regular entries. Archive links, traversal and absolute paths are rejected. The separate preparation workload verifies the full archive SHA256 before extraction, makes shared files and directories read-only, and atomically publishes a matching bundle marker. Replayed preparation verifies all installed bytes against the archive. Normal requests require the prepared marker and immutable runtime paths; they never extract, rescan or mutate the shared tools. A failed/interrupted installation must be reconciled explicitly, not accepted as a healthy runtime.

Extract for the local actual-binary smoke:

```sh
python3 - <<'PY'
import json
from pathlib import Path
from bootstrap import install
p = Path('output')
m = json.loads((p / 'runtime-bundle.json').read_text())
install(p / 'runtime-bundle.tar.gz', p / 'runtime', m['sha256'])
PY
python3 tests/runtime-smoke.py --runtime output/runtime
```

The guest image must supply compatible glibc, libstdc++/libgcc and Python 3. OfficeCLI receives a fixed library path pointing at the bundled ICU libraries; invariant globalization is never enabled. The exact cached slim image `docker.io/library/python@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337` passed the actual-binary smoke locally in Docker, including persisted Unicode edits through the constrained extension and the bundled guest validator. The previous host-only smoke missed the slim image's absent ICU; that earlier bundle failed OfficeCLI startup in the guest. Local Docker proof remains separate from BoxLite Cloud and application acceptance.

For the exact-image check, mount the extracted runtime at `/runtime` and this package at `/workload`, both read-only, then execute `python3 -B /workload/tests/runtime-smoke.py --runtime /runtime` in that immutable image with `--network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --cpus 2 --memory 2048m --pids-limit 128 --tmpfs /tmp:rw,nosuid,nodev,size=256m`.

## Approved profile and credentials

```sh
python3 render_profile.py \
  --image 'APPROVED_REPOSITORY@sha256:VERIFIED_DIGEST' \
  --base-url 'https://APPROVED_LITELLM_HOST/v1' \
  --model 'APPROVED_ALIAS' > output/profile.json
```

Placeholders fail validation; supply actual verified values. Merge the emitted sandbox/workload entries into operator configuration. The profile's constant Python bootstrap contains the fixed bundle checksum; request arguments contain only a canonical UUID. Configure the sandbox profile before use; changing runtime bytes requires a new immutable profile version for an existing deployment.

The nonsecret environment holds `LITELLM_BASE_URL`, `LITELLM_MODEL_ALIAS` and a bounded execution timeout. `secret_environment` maps `LITELLM_API_KEY` to Provider runtime variable `WORKLOAD_SECRET_LITELLM_API_KEY`. The Provider resolves it immediately before execution. It is not a literal profile value or archive member. Pi configuration contains the environment reference `$LITELLM_API_KEY`; OfficeCLI subprocesses receive a minimal environment without the key. Required session/output files are scanned for a literal key before successful publication.

The rc3 renderer emits immutable profiles `pi-document-cloud:v3`, `pi-document-prepare:v3` and `pi-document-agent:v3`. The Cloud sandbox opts into a maximum of two concurrent runs; legacy sandbox profiles retain a one-run default. Provisioning submits the preparation profile with empty arguments and verifies its completed JSON `{schema_version:1,prepared:true,runtime_sha256:<pinned digest>}` before dispatching requests. Preparation has no model credentials. Each request runs its independent Pi process in the same prepared user sandbox. It accepts only an HTTPS LiteLLM URL using the default port or explicit 443. The sandbox disables inbound and its outbound rule uses the LiteLLM hostname only: Cloud matching does not accept `hostname:443` as an effective hostname rule. This rule does not prove destination-port enforcement. BoxLite hostname allowlists also have documented DNS/UDP limitations; metadata alone is not network qualification. Do not replace the rule with unrestricted egress if a vendor restriction blocks the model connection. Exact effective-policy and traffic checks belong in hosted evidence.

## Scoped files and request contract

All paths are below `/opt/workflow-transfer`:

| Relative path | Purpose |
| --- | --- |
| `runtime/runtime-bundle.tar.gz` | Trusted exact-checksum upload, one per sandbox |
| `runtime/<bundle-sha256>/` | Verified extracted runtime |
| `requests/<uuid>/request.json` | Version 2 request document |
| `requests/<uuid>/inputs/<safe-basename>` | Immutable uploaded original files |
| `requests/<uuid>/outputs/result.json` | Structured result and artifact/checkpoint manifest |
| `requests/<uuid>/outputs/document.docx` | Separate working copy, when a DOCX input exists |
| `requests/<uuid>/session/*.jsonl` | Required retained independent Pi session checkpoint |
| `requests/<uuid>/agent/`, `tmp/`, `cache/`, `config/` | Request-local configuration and temporary data |

The application stages all files through Provider's scoped upload API, then submits Runner workload `pi-document-agent:v3` with `arguments:{request_id:<uuid>}` and the retained sandbox reference. The application must never accept client-selected runtime archives, profiles or guest roots.

Request JSON is `{schema_version:2,request_id,system_prompt,instructions,inputs:[{name,path,media_type,size_bytes,sha256}]}`. Input `path` is a safe single basename under `inputs/`; `name` is display metadata. Up to eight inputs are supported, each <=10 MiB and combined <=20 MiB, with at most one DOCX plus TXT/Markdown references. Reference text is bounded to 100,000 characters per file and 200,000 total. Both the saved system prompt and request instructions are 1–16,000 characters. They enter Pi as system-prompt additions. Fixed workload guidance adds the actual request directory. TXT/Markdown references remain explicitly untrusted user-message data. Pi keeps its base operational prompt; the user policy and request instructions are appended as system content. With no DOCX, Pi returns text without tools. With a DOCX, only the assigned copied output may be edited.

The model has no built-in shell, file, network or installation tool. Its explicit OfficeCLI extension supports bounded read/outline/get/help/issues/validate, exact replacements and paragraph changes through direct argv. Inputs are never overwritten. The prompt describes the folder boundary, while the tool path checks enforce access to the assigned DOCX working copy. Prompt text alone is not a filesystem security boundary. Arbitrary file creation and general shell access remain outside this workload. Request dispatch writes a durable `.execution-started` fence before any model side effect. A subsequent uncertain or already-delivered dispatch is refused; the existing files remain available for controller reconciliation.

## Results, validation and safe stopping

Result JSON always contains `schema_version:1`, the same `request_id`, `outcome:completed|failed`, `text`, `artifacts`, `validations` and `session_files`. Artifact/checkpoint entries contain safe single-basename `path`, `media_type`, `size_bytes` and `sha256`; checkpoint `media_type` is exactly `application/x-ndjson`, including in the application's strict manifest schema; artifact paths resolve under `outputs/`, checkpoints under `session/`. Validation findings use category `structural|content|rendered_layout`, status `passed|failed|not_performed`, plus `code` and `message`.

The workload requires a completed, nonempty Pi final response, checks actual OfficeCLI schema results in nonresident mode, validates the OOXML package and records advisory issue counts. It does not assert semantic accuracy, translation quality, rendered layout or pagination. Those findings remain `not_performed`. A headless HTML preview would not change that status.

Stdout contains only a bounded manifest pointer `{schema_version:1,result_path:"outputs/result.json",size_bytes,sha256}` after the file has been flushed. Missing output or exit zero alone cannot prove delivery. Failure writes an actionable safe result where possible and returns nonzero. An interruption may leave only the durable fence; that is uncertain execution, not permission to rerun.

The application must independently fetch/verify the result, checksums and actual file structure. `python3 validation.py <downloaded-output-directory>` provides a separate controller check; the application may implement equivalent checks in its own runtime. Treat the guest's report as data. After export of results, inputs and required session files to application-owned object storage is durable, the application may stop the same user sandbox only after all sibling jobs and exports are idle. Completing one request must not stop another Pi session. This package neither stops nor destroys it.

A completed external job whose result export fails must retain its request, job, sandbox and execution identities. Use only a reviewed, audited export-only reconciliation procedure against the existing result; never remove the guest fence or dispatch a new execution to repair a controller contract mismatch. See the [application operations skill](../../apps/application/.agents/skills/application-operations/SKILL.md).

File checkpoints support an explicit future reconstruction procedure into a new isolated sandbox with a newly recorded identity. They are not a full Cloud disk backup, clone or proof of coordinated registry restore. Do not reopen an old registry mapping against a new disk silently.

## Reviewed source and deferred scope

The user supplied `pi_demo.py`, `docx_support.py` and `officecli_tool.ts`. Their source was reviewed for session flags, external model setup, working-copy behavior, OfficeCLI argv and package checks. Required `boxlite_exec.py`, `prepare_pi_runtime.py` and original runtime archives were unavailable. This package implements its own reviewed builder, bounded process collector and constrained extension; it does not claim those missing helpers or any original document outputs were recovered.

The prototype's unrestricted outbound example was not adopted. No HPE template, screenshot collection, SRT skill or known-good document baseline was available to this package. Tests generate synthetic fixtures only. Revision/feedback, clarification, approvals, editors, template/skill selection and project/account management remain deferred under the minimal first release.

## Shared runtime verification

Run `python3 -B tests/shared-runtime-smoke.py --runtime <extracted-runtime>` in the same exact immutable slim image and with the isolation flags described above. It launches two actual Node/Pi-version/OfficeCLI Unicode-edit sessions against one read-only runtime, with independent working directories and homes, and checks that every shared runtime file remains unchanged. It performs no model calls. The Python regression suite separately runs two overlapping guest processes with a fake Pi executable to verify UUID session identity, prompt placement, result paths and per-request temporary/cache directories. Neither check establishes hosted Cloud concurrency; that needs separate real-service evidence.
