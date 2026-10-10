#!/usr/bin/env bash
# ACTIONS_RUNNER_HOOK_JOB_COMPLETED: depois de cada job (também cancelado). Melhor esforço: nunca reprova o job.
source "$(dirname "${BASH_SOURCE[0]}")/cleanup.sh"
kill_leftovers
stop_containers
wipe_tmp
wipe_workspace
stamp last-job-completed "workflow=${GITHUB_WORKFLOW:-?}"
exit 0
