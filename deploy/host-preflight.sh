#!/bin/sh
# Run read-only on the selected execution host BEFORE enabling BoxLite.
set -u
printf 'timestamp='; date -u +%FT%TZ
uname -a
id
printf '\nKVM device and access\n'
ls -l /dev/kvm 2>&1 || true
if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then echo 'kvm_access=read-write'; else echo 'kvm_access=unavailable'; fi
printf '\nCPU and virtualization\n'
lscpu 2>/dev/null || true
printf '\nCapacity\n'
free -h
# Set BOX_STORAGE_ROOT to the narrow filesystem intended for Provider storage.
df -h "${BOX_STORAGE_ROOT:-/data}"
printf '\nContainer runtime\n'
docker version --format '{{.Server.Version}}' 2>/dev/null || true
# A successful device listing is not proof: execute the real-runtime service test
# with the exact non-privileged deployment settings before accepting BoxLite.
