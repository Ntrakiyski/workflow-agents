"""Render reviewed workload configuration; output contains no credentials."""
import argparse
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent


def profile(metadata, image, base_url, model):
    if not re.fullmatch(r'[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}', image):
        raise ValueError('Approved immutable OCI digest required')
    if not re.fullmatch('[a-f0-9]{64}', metadata['sha256']):
        raise ValueError('Built bundle checksum required')
    url = urlsplit(base_url)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('HTTPS LiteLLM endpoint required')
    bootstrap = (ROOT / 'bootstrap.py').read_text()
    sandbox_id, workload_id = 'pi-document-cloud:v1', 'pi-document-agent:v1'
    return {'version': 1, 'sandboxes': {sandbox_id: {
        'image': image, 'cpus': 2, 'memory_mib': 2048, 'disk_mib': 2048,
        'network': 'allowlist', 'allowed_hosts': [url.hostname + ':' + str(url.port or 443)],
        'entrypoint': ['/usr/local/bin/python3', '-c', 'import time; time.sleep(31536000)'], 'cmd': []}},
        'workloads': {workload_id: {
            'sandbox_profiles': [sandbox_id], 'working_directory': '/',
            'max_duration_seconds': 900, 'max_output_bytes': 4096,
            'environment': {'LITELLM_BASE_URL': base_url, 'LITELLM_MODEL_ALIAS': model,
                            'PI_EXECUTION_TIMEOUT_SECONDS': '600'},
            'secret_environment': {'LITELLM_API_KEY': 'WORKLOAD_SECRET_LITELLM_API_KEY'},
            'argv': ['/usr/local/bin/python3', '-c', bootstrap, metadata['sha256'], '${arg:request_id}'],
            'arguments_schema': {'type': 'object', 'properties': {
                'request_id': {'type': 'string', 'pattern': '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'}},
                'required': ['request_id'], 'additionalProperties': False}}}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--metadata', type=Path, default=ROOT / 'output/runtime-bundle.json')
    parser.add_argument('--image', required=True)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--model', required=True)
    args = parser.parse_args()
    print(json.dumps(profile(json.loads(args.metadata.read_text()), args.image, args.base_url, args.model), indent=2))
