import json
import os
import re
import secrets
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit
from jsonschema import Draft202012Validator
from .errors import ServiceError

ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')
ARG = re.compile(r'^\$\{arg:([A-Za-z_][A-Za-z0-9_]*)\}$')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


@dataclass(frozen=True)
class Identity:
    actor: str
    owner: str
    policy: dict


class Settings:
    def __init__(self, database_url, auth, profiles, box_root='/var/lib/sandbox-provider/boxlite',
                 max_sandboxes=20, max_body=65536, max_output=32768, poll_seconds=.25,
                 audit_retention_days=90, max_concurrent_runs=4, runtime_mode='local',
                 boxlite_rest_url=None, boxlite_api_key=None, boxlite_account_scope=None,
                 boxlite_rest_path_prefix=None, runtime_request_timeout=30):
        self.database_url, self.auth, self.profiles = database_url, auth, profiles
        self.box_root = Path(box_root)
        self.max_sandboxes, self.max_body, self.max_output = max_sandboxes, max_body, max_output
        self.poll_seconds, self.audit_retention_days = poll_seconds, audit_retention_days
        self.max_concurrent_runs = max_concurrent_runs
        self.runtime_mode = runtime_mode
        self.boxlite_rest_url, self.boxlite_api_key = boxlite_rest_url, boxlite_api_key
        self.boxlite_account_scope, self.boxlite_rest_path_prefix = boxlite_account_scope, boxlite_rest_path_prefix
        self.runtime_request_timeout = runtime_request_timeout
        if runtime_mode not in ('local', 'cloud'):
            raise ValueError('SANDBOX_RUNTIME_MODE must be local or cloud.')
        if not isinstance(runtime_request_timeout, (float, int)) or not 1 <= runtime_request_timeout <= 120:
            raise ValueError('RUNTIME_REQUEST_TIMEOUT_SECONDS must be between 1 and 120.')
        if runtime_mode == 'cloud':
            parsed = urlsplit(boxlite_rest_url or '')
            if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                    or parsed.query or parsed.fragment or parsed.path not in ('', '/')):
                raise ValueError('BOXLITE_REST_URL must be an HTTPS origin without credentials or a path.')
            self.boxlite_rest_url = boxlite_rest_url.rstrip('/')
            if not isinstance(boxlite_api_key, str) or len(boxlite_api_key) < 24:
                raise ValueError('BOXLITE_API_KEY must be configured through secret management.')
            if not isinstance(boxlite_account_scope, str) or not ID.fullmatch(boxlite_account_scope):
                raise ValueError('BOXLITE_ACCOUNT_SCOPE must be a stable configured account identity.')
            if boxlite_rest_path_prefix and not re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*', boxlite_rest_path_prefix):
                raise ValueError('BOXLITE_REST_PATH_PREFIX is invalid.')
        if not isinstance(max_concurrent_runs, int) or isinstance(max_concurrent_runs, bool) or not 1 <= max_concurrent_runs <= 4:
            raise ValueError('MAX_CONCURRENT_RUNS must be between 1 and 4 for the bounded connection pool.')
        Draft202012Validator(json.loads(Path(__file__).with_name('profiles.schema.json').read_text())).validate(profiles)
        if not auth or any(len(p.get('token', '')) < 24 for p in auth):
            raise ValueError('Credentials must be configured and at least 24 characters.')
        for p in auth:
            if 'delegate_owners' in p and (not isinstance(p['delegate_owners'], list) or not p['delegate_owners'] or any(not isinstance(v, str) or not ID.fullmatch(v) for v in p['delegate_owners'])):
                raise ValueError('Invalid delegated owner policy.')
            if not ID.fullmatch(p.get('actor_id', '')) or not ID.fullmatch(p.get('owner_id', '')):
                raise ValueError('Invalid configured identity.')
            for k in ('permissions', 'sandbox_profiles', 'workload_profiles'):
                if not isinstance(p.get(k), list):
                    raise ValueError('Missing credential policy lists.')
        if not (1 <= max_sandboxes <= 10000 and 1024 <= max_body <= 65536 and 1 <= max_output <= 32768 and .05 <= poll_seconds <= 30):
            raise ValueError('Invalid configured limits.')
        for name, profile in profiles['workloads'].items():
            Draft202012Validator.check_schema(profile['arguments_schema'])
            if '$ref' in canonical(profile['arguments_schema']):
                raise ValueError('External and recursive argument schema references are not supported.')
            for token in profile['argv']:
                if '${' in token and not ARG.fullmatch(token):
                    raise ValueError('Only whole argument tokens may be substituted.')
            if ARG.fullmatch(profile['argv'][0]):
                raise ValueError('Executable cannot come from arguments.')
            if any(s not in profiles['sandboxes'] for s in profile['sandbox_profiles']):
                raise ValueError('Unknown sandbox profile.')
        for profile in profiles['sandboxes'].values():
            if profile['disk_mib'] % 1024:
                raise ValueError('BoxLite disk caps must be whole GiB.')

    @classmethod
    def from_env(cls):
        return cls(os.environ['DATABASE_URL'], json.loads(os.environ['PROVIDER_AUTH_JSON']),
                   json.loads(os.environ['PROVIDER_PROFILES_JSON']), os.getenv('BOX_ROOT', '/var/lib/sandbox-provider/boxlite'),
                   int(os.getenv('MAX_SANDBOXES_PER_OWNER', '20')), int(os.getenv('MAX_BODY_BYTES', '65536')),
                   int(os.getenv('MAX_OUTPUT_BYTES', '32768')), float(os.getenv('RUN_POLL_SECONDS', '.25')),
                   int(os.getenv('AUDIT_RETENTION_DAYS', '90')), int(os.getenv('MAX_CONCURRENT_RUNS', '4')),
                   os.getenv('SANDBOX_RUNTIME_MODE', 'local'), os.getenv('BOXLITE_REST_URL'),
                   os.getenv('BOXLITE_API_KEY'), os.getenv('BOXLITE_ACCOUNT_SCOPE'),
                   os.getenv('BOXLITE_REST_PATH_PREFIX'), float(os.getenv('RUNTIME_REQUEST_TIMEOUT_SECONDS', '30')))

    def authenticate(self, authorization, delegated):
        token = authorization[7:] if authorization and authorization.startswith('Bearer ') else ''
        policy = next((p for p in self.auth if secrets.compare_digest(p['token'].encode('utf-8'), token.encode('utf-8'))), None)
        if policy is None:
            raise ServiceError(401, 'unauthorized', 'Valid bearer credentials are required.')
        allowed = policy.get('delegate_owners')
        if allowed is not None:
            if not delegated or delegated not in allowed:
                raise ServiceError(403, 'forbidden', 'Delegated owner is not permitted.')
            owner = delegated
        else:
            if delegated is not None:
                raise ServiceError(403, 'forbidden', 'Owner delegation is not permitted.')
            owner = policy['owner_id']
        return Identity(policy['actor_id'], owner, policy)

    def sandbox_profile(self, identity, name):
        if name not in identity.policy['sandbox_profiles'] or name not in self.profiles['sandboxes']:
            raise ServiceError(403, 'forbidden', 'Sandbox profile is not permitted.')
        return self.profiles['sandboxes'][name]

    def workload(self, identity, name, sandbox_profile, arguments, timeout):
        if name not in identity.policy['workload_profiles'] or name not in self.profiles['workloads']:
            raise ServiceError(403, 'forbidden', 'Workload profile is not permitted.')
        p = self.profiles['workloads'][name]
        if sandbox_profile not in p['sandbox_profiles']:
            raise ServiceError(403, 'forbidden', 'Workload is not permitted in this environment.')
        if len(canonical(arguments).encode()) > 16384 or not Draft202012Validator(p['arguments_schema']).is_valid(arguments):
            raise ServiceError(422, 'invalid_request', 'Workload arguments do not match the approved schema.')
        if timeout > p['max_duration_seconds']:
            raise ServiceError(422, 'invalid_request', 'Execution timeout exceeds profile policy.')
        argv = []
        for token in p['argv']:
            m = ARG.fullmatch(token)
            if m:
                v = arguments.get(m[1])
                if not isinstance(v, (str, int, float, bool)):
                    raise ServiceError(422, 'invalid_request', 'Workload requires a scalar argument.')
                token = str(v) if not isinstance(v, bool) else str(v).lower()
            argv.append(token)
        return p, argv
