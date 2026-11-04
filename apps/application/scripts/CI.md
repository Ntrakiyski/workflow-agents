# Application CI

`.github/workflows/application.yml` runs Node 22.22.3 type/format checks, all
application Node tests, the production build, encrypted checkpoint/restore
tests, approved public runtime cache boundary tests, and the existing
desktop/mobile Playwright journey. PostgreSQL and
RustFS are actual digest-pinned GitHub service containers; Runner, Provider
and document execution are test doubles. No Cloud/model/deployment credentials
are needed. The backup test's configuration is explicitly set so its real
database/object restore drill cannot silently skip.

CI uses fresh service containers and generated host ports. The setup helper
requires those explicit ports, validates the configuration through the actual
application schema, waits for SQL and authenticated S3 responses, and writes
the existing `private/test/config.json` path with mode 600. It does not invoke
the local `test-services.mjs`, bind host directories, run `chown` or start Docker.
Only browser diagnostics are uploaded on failure; private configuration and
checkpoint/credential files are excluded.

The pinned RustFS image declares user `rustfs`, entrypoint `/entrypoint.sh`,
default command `rustfs`, `RUSTFS_VOLUMES=/data`, and an anonymous `/data` volume.
The workflow retains these defaults and writes logs under that volume. It
does not require GitHub's nonroot runner to chown a host directory.

Existing local verification is recorded in `../VERIFICATION.md` and the
independent release review: ten backend checks with real PostgreSQL/RustFS,
two browser checks with mocked execution, and separate real encrypted
checkpoint/restore tests. These results do not claim a GitHub Actions run.
Workflow syntax/setup checks must be reported separately from the first
completed CI job. Passing this workflow will not qualify BoxLite Cloud,
Pi/LiteLLM/OfficeCLI, hosted deployment, rendered documents or host recovery.

## CI setup validation — 3 November 2026

Prepared from source `b371427f9cd040feb7c77a71cba087641a91dc05`. The local
equivalent ran with Node 22.22.3 against two newly named, session-labeled
containers with the exact workflow images, generated host ports and anonymous
volumes. RustFS retained its default `rustfs` command and nonroot user; no host
directory ownership change was needed. Existing local test resources were
not used or changed. Both new containers and their volumes were removed.

| Executed local check | Result |
| --- | --- |
| `actionlint` 1.7.7 on the workflow | Passed Actions syntax, expressions and action inputs |
| CI helper through actual application schema and SQL/S3 readiness | Passed; config file created with mode 600 |
| `npm ci`, typecheck, format check and production build | Passed |
| `npm test` | 10 passed, zero skipped; real DB/S3, execution mocked |
| `node --test scripts/application-backup.test.mjs` with both required config variables | 2 passed, zero skipped; encrypted archive and real isolated DB/object restore |
| `npm run test:browser` | 2 passed; desktop/mobile browser, real DB/S3, execution mocked |
| `node --test deploy/tests/cache-approved-runtime.test.mjs` from integration source | 5 passed; filesystem/checksum/size boundaries, no network |
| First GitHub Actions job | Not run; requires reviewed commit publication |

Browser dependencies were already present locally. The workflow's
`playwright install --with-deps chromium` installation on an Ubuntu GitHub
runner remains part of the unexecuted CI environment, not this local result.

The cache test command targets the integration lead's `fccebd5` addition,
which postdates the setup's `b371427` base. Publish the workflow only with that
module and test integrated. Its five standalone checks were executed against
the integration worktree separately from the service-container run above.
