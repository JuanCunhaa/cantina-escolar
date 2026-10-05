#!/usr/bin/env bash
# Instantâneo leve de recursos do runner para diagnóstico do e2e (sem variáveis de ambiente, sem argumentos de processo).
# Uso: scripts/ci/resource-snapshot.sh <rótulo> >> ci-diagnostics/resources.txt
echo "=== $1 $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo "cpus_disponiveis: $(nproc)"
echo "loadavg: $(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
free -m 2>/dev/null | sed -n '1,2p'
for f in /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.current; do [ -r "$f" ] && echo "$f: $(cat "$f")"; done
echo "processos (nome, pid, %cpu, rss_MB) — maiores por memória:"
ps -eo pid=,pcpu=,rss=,comm= --sort=-rss 2>/dev/null | head -8 | awk '{printf "  %s pid=%s cpu=%s rss_MB=%d\n", $4, $1, $2, $3/1024}'
echo
