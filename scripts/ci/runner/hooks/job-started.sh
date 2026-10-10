#!/usr/bin/env bash
# ACTIONS_RUNNER_HOOK_JOB_STARTED: antes de cada job. Remove restos de um job anterior (cancelado, travado) e recusa começar
# com pouco disco. Falha aqui reprova o job, de propósito, só no caso do disco.
source "$(dirname "${BASH_SOURCE[0]}")/cleanup.sh"
kill_leftovers
stop_containers
wipe_tmp
wipe_workspace
trim_npm_logs
stamp last-job-started
guard_disk
