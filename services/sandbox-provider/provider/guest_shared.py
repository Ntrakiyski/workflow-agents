"""Trusted Linux per-run supervisor for opt-in shared sandboxes.

Each supervisor is a child subreaper. Cancellation terminates and reaps its
descendants, including children which changed process groups. No box-wide stop
or account-wide process matching is used. A nonce-bound durable fence prevents
a delayed dispatch from starting after cancellation.
"""
import ctypes
import fcntl
import hashlib
import json
import os
import signal
import subprocess
import sys
import threading
import time


def directory(reference):
    if not reference.startswith('run_') or not reference[4:].isalnum() or len(reference) > 128:
        raise ValueError('invalid_reference')
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
        return fd
    except BaseException:
        os.close(fd)
        raise


def read(fd, name):
    try:
        raw = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    except FileNotFoundError:
        return None
    with os.fdopen(raw, 'rb') as stream:
        value = stream.read(1048577)
    if len(value) > 1048576:
        raise ValueError('oversized_journal')
    return json.loads(value)


def write(fd, name, value):
    temporary = name + '.pending-' + str(os.getpid())
    raw = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        with os.fdopen(raw, 'w') as stream:
            json.dump(value, stream, separators=(',', ':'), ensure_ascii=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
    finally:
        os.unlink(temporary, dir_fd=fd)
    os.fsync(fd)


def identity(pid):
    try:
        stat = open('/proc/' + str(pid) + '/stat').read().rsplit(')', 1)[1].split()
        return int(stat[1]), stat[19], stat[0]
    except (FileNotFoundError, ProcessLookupError):
        return None


def descendants(parent):
    processes = {}
    for entry in os.listdir('/proc'):
        if entry.isdigit():
            item = identity(int(entry))
            if item:
                processes[int(entry)] = item
    result, frontier = {}, {parent}
    while frontier:
        children = {pid: value for pid, value in processes.items() if value[0] in frontier and pid not in result}
        result.update(children)
        frontier = set(children)
    return result


def terminate_tree():
    # Freezing before killing bounds forking races. The subreaper adopts
    # orphaned grandchildren, so changed process groups do not evade cleanup.
    end = time.monotonic() + 10
    while time.monotonic() < end:
        children = descendants(os.getpid())
        for sig in (signal.SIGSTOP, signal.SIGKILL):
            for pid, expected in children.items():
                current = identity(pid)
                if current and current[1] == expected[1]:
                    try:
                        os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
        while True:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0:
                    break
            except ChildProcessError:
                break
        if not descendants(os.getpid()):
            return
        time.sleep(.025)
    raise RuntimeError('descendant_termination_unverified')


def control(reference, nonce, cancel=False):
    fd = directory(reference)
    try:
        lock = os.open('control.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(lock, 'r+') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            state = read(fd, 'state.json')
            if state and state['nonce'] != nonce:
                raise ValueError('nonce_mismatch')
            fence = read(fd, 'cancel.json')
            if fence and fence['nonce'] != nonce:
                raise ValueError('nonce_mismatch')
            if cancel and not fence:
                write(fd, 'cancel.json', {'nonce': nonce})
            result = read(fd, 'result.json')
            if result:
                if result['nonce'] != nonce:
                    raise ValueError('nonce_mismatch')
                return {'status': 'finished', 'envelope': result}
            if state:
                current = identity(state['pid'])
                if current and current[1] == state['start_time'] and current[2] != 'Z':
                    return {'status': 'running'}
                raise RuntimeError('supervisor_interrupted')
            return {'status': 'fenced' if cancel or fence else 'pending'}
    finally:
        os.close(fd)


def run(argv, nonce, reference, maximum, secret_names):
    # PR_SET_CHILD_SUBREAPER: Linux keeps every orphaned descendant below this
    # supervisor until reaped, even if it creates a fresh session/process group.
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('subreaper_unavailable')
    fd = directory(reference)
    try:
        lock = os.open('control.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(lock, 'r+') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            if read(fd, 'state.json') or read(fd, 'result.json'):
                raise RuntimeError('execution_already_started')
            fence = read(fd, 'cancel.json')
            if fence and fence['nonce'] != nonce:
                raise ValueError('nonce_mismatch')
            write(fd, 'state.json', {'nonce': nonce, 'pid': os.getpid(), 'start_time': identity(os.getpid())[1]})
            process = None if fence else subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        streams = {}
        def drain(name, pipe):
            value, count = bytearray(), 0
            while True:
                part = pipe.read(65536)
                if not part:
                    break
                count += len(part)
                value.extend(part[:max(0, maximum - len(value))])
            streams[name] = (value.decode('utf-8', errors='replace'), count)
        workers = [] if process is None else [threading.Thread(target=drain, args=(name, pipe)) for name, pipe in (('stdout', process.stdout), ('stderr', process.stderr))]
        for worker in workers:
            worker.start()
        cancelled = process is None
        while process is not None and process.poll() is None:
            fence = read(fd, 'cancel.json')
            if fence:
                if fence['nonce'] != nonce:
                    raise ValueError('nonce_mismatch')
                cancelled = True
                break
            time.sleep(.025)
        code = -signal.SIGKILL if cancelled else process.returncode
        # Also remove background descendants after ordinary leader completion;
        # terminal status is never reported while this run still owns processes.
        terminate_tree()
        for worker in workers:
            worker.join(timeout=2)
            if worker.is_alive():
                raise RuntimeError('stream_termination_unverified')
        result = {'exit_code': code, 'stdout': streams.get('stdout', ('', 0))[0], 'stderr': streams.get('stderr', ('', 0))[0],
                  'output_truncated': any(v[1] > maximum for v in streams.values()), 'artifacts': []}
        for name in secret_names:
            value = os.environ.get(name)
            if value:
                for stream in ('stdout', 'stderr'):
                    result[stream] = result[stream].replace(value, '[redacted]')
        encoded = json.dumps(result, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
        envelope = {'version': 1, 'nonce': nonce, 'result': result, 'sha256': hashlib.sha256(encoded.encode()).hexdigest()}
        write(fd, 'result.json', envelope)
        print(json.dumps(envelope, separators=(',', ':'), ensure_ascii=True), flush=True)
    finally:
        os.close(fd)


if __name__ == '__main__':
    if sys.argv[1] == 'control':
        print(json.dumps(control(sys.argv[2], sys.argv[3], sys.argv[4] == 'cancel')), flush=True)
    else:
        nonce, reference, maximum, secret_names = sys.argv[2:6]
        run(sys.argv[6:], nonce, reference, int(maximum), json.loads(secret_names))
