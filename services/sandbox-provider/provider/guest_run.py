"""Fixed Cloud execution wrapper with an explicit complete-result envelope.

A silent child still emits an envelope. Missing stream data plus exit zero can
therefore never become a successful workload result. The bounded result journal
is retained in the same guest; it is not a VM snapshot or an off-host backup.
"""
import hashlib
import json
import os
import subprocess
import sys
import threading


def run(argv, nonce, reference, maximum, secret_names):
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    streams = {}
    def drain(name, pipe):
        value = bytearray()
        count = 0
        checksum = hashlib.sha256()
        while True:
            part = pipe.read(65536)
            if not part:
                break
            count += len(part)
            checksum.update(part)
            value.extend(part[:max(0, maximum - len(value))])
        streams[name] = (value.decode('utf-8', errors='replace'), count, checksum.hexdigest())
    workers = [threading.Thread(target=drain, args=(name, pipe)) for name, pipe in (('stdout', process.stdout), ('stderr', process.stderr))]
    for worker in workers:
        worker.start()
    code = process.wait()
    for worker in workers:
        worker.join()
    result = {'exit_code': code, 'stdout': streams['stdout'][0], 'stderr': streams['stderr'][0],
              'output_truncated': any(v[1] > maximum for v in streams.values()), 'artifacts': []}
    for name in secret_names:
        value = os.environ.get(name)
        if value:
            for stream in ('stdout', 'stderr'):
                result[stream] = result[stream].replace(value, '[redacted]')
    encoded = json.dumps(result, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
    envelope = {'version': 1, 'nonce': nonce, 'result': result, 'sha256': hashlib.sha256(encoded.encode()).hexdigest()}
    # Descriptor-relative no-follow creation prevents an earlier guest workload
    # from redirecting the Provider's journal into unrelated guest locations.
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in ('opt', 'workflow-transfer', '.executions', reference):
            try:
                os.mkdir(component, 0o700, dir_fd=fd)
            except FileExistsError:
                pass
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        journal = os.open('result.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            raw = json.dumps(envelope, separators=(',', ':'), ensure_ascii=True).encode()
            with os.fdopen(journal, 'wb', closefd=False) as output:
                output.write(raw)
                output.flush()
                os.fsync(journal)
        finally:
            os.close(journal)
        os.fsync(fd)
    finally:
        os.close(fd)
    print(json.dumps(envelope, separators=(',', ':'), ensure_ascii=True), flush=True)


if __name__ == '__main__':
    nonce, reference, maximum, secret_names = sys.argv[1:5]
    run(sys.argv[5:], nonce, reference, int(maximum), json.loads(secret_names))
