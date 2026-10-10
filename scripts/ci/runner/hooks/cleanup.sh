#!/usr/bin/env bash
# Funções de limpeza do runner próprio, usadas pelos hooks job-started.sh e job-completed.sh (instalados em /opt/cantina-ci/hooks,
# de propriedade do root: o job não os edita). Atuam SÓ sobre o que o usuário do runner possui; nunca usam sudo.
#
# Preservado de propósito (caches intencionais): ~/.npm, ~/.cache/ms-playwright, ~/.cache/firebase (JARs dos emuladores),
# $RUNNER_TOOL_CACHE (_work/_tool: Node e JDK do setup-*), imagens do contêiner do Veracode e o próprio runner.
set -u

STATE_DIR="${CANTINA_CI_STATE:-$HOME/.cantina-ci}"
MIN_FREE_KB="${CANTINA_CI_MIN_FREE_KB:-10485760}" # 10 GB

log() { printf '[cantina-ci-hook] %s\n' "$*"; }

# Processos que pertencem ao job e podem ter sobrado (emuladores Java, firebase-tools, servidor Next, Chromium do Playwright,
# scanners). Ancestrais deste script (Runner.Worker, Runner.Listener) e o Node embutido do runner (externals/) são poupados.
is_job_process() { # is_job_process <pid> <ancestrais>: 0 se for resto de job que pode ser encerrado
  local pid="$1" comm exe
  case "$2" in *" $pid "*) return 1 ;; esac
  comm="$(cat "/proc/$pid/comm" 2>/dev/null)" || return 1
  exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
  [ "$comm" = "node" ] && [ "${exe#*/externals/}" != "$exe" ] && return 1
  case "$comm" in
    java|firebase*|node|npm*|npx*|next-server*|vitest*|playwright*|chrome*|chromium*|headless_shell|gitleaks|srcclr|docker|podman|esbuild|tsx) return 0 ;;
  esac
  return 1
}

kill_leftovers() {
  local protected=" " pid n=0
  pid=$$
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
    protected="$protected$pid "
    pid="$(awk '/^PPid:/{print $2}' "/proc/$pid/status" 2>/dev/null)"
  done
  for pid in $(pgrep -u "$(id -u)" 2>/dev/null); do
    is_job_process "$pid" "$protected" && kill -TERM "$pid" 2>/dev/null && n=$((n + 1))
  done
  [ "$n" -gt 0 ] && sleep 3
  for pid in $(pgrep -u "$(id -u)" 2>/dev/null); do
    is_job_process "$pid" "$protected" && kill -KILL "$pid" 2>/dev/null
  done
  log "processos de job encerrados: $n"
}

# Contêineres do job (Veracode Pipeline Scan) que sobreviveram ao cliente morto. O daemon rootless é do próprio usuário.
stop_containers() {
  command -v docker >/dev/null 2>&1 || return 0
  local ids
  ids="$(docker ps -q 2>/dev/null || true)"
  [ -n "$ids" ] && { log "contêineres encerrados: $(echo "$ids" | wc -l)"; docker kill $ids >/dev/null 2>&1 || true; }
  return 0
}

# Espaço de trabalho do job: some tudo (checkout, node_modules, .next, ci-results, veracode/sast.zip, .local-storage). O próximo
# job faz checkout novo. O diretório em si fica (o runner o espera). Caminho validado: só dentro de /_work/.
wipe_workspace() {
  local ws="${GITHUB_WORKSPACE:-}"
  case "$ws" in
    */_work/*/*) ;;
    *) log "workspace '$ws' fora do padrão _work/<repo>/<repo>: nada removido"; return 0 ;;
  esac
  [ -d "$ws" ] || return 0
  chmod -R u+rwX "$ws" 2>/dev/null || true
  find "$ws" -mindepth 1 -delete 2>/dev/null || true
  log "workspace limpo: $ws"
}

# Temporários próprios em /tmp (mktemp dos instaladores, Playwright, Firebase CLI, JVM). Só do usuário e só por padrão conhecido.
wipe_tmp() {
  find /tmp -maxdepth 1 -mindepth 1 -user "$(id -un)" \( -name 'tmp.*' -o -name 'playwright*' -o -name 'firebase*' -o -name 'hsperfdata_*' -o -name 'pw-*' -o -name 'next-*' -o -name 'vitest*' -o -name '.org.chromium.*' -o -name 'scoped_dir*' \) -exec rm -rf {} + 2>/dev/null || true
  rm -rf "$HOME/.config/firebase/ci-" 2>/dev/null || true
  log "temporários próprios de /tmp removidos"
}

# Logs do próprio npm acumulam; mantém os 20 mais recentes. Os caches (cacache) ficam.
trim_npm_logs() {
  [ -d "$HOME/.npm/_logs" ] || return 0
  ls -1t "$HOME/.npm/_logs" 2>/dev/null | tail -n +21 | while read -r f; do rm -f "$HOME/.npm/_logs/$f"; done
}

guard_disk() {
  local dir="${GITHUB_WORKSPACE:-$HOME}" free_kb
  free_kb="$(df -Pk "$dir" 2>/dev/null | awk 'NR==2{print $4}')"
  [ -n "$free_kb" ] || return 0
  if [ "$free_kb" -lt "$MIN_FREE_KB" ]; then
    log "ERRO: disco livre $((free_kb / 1048576)) GB < $((MIN_FREE_KB / 1048576)) GB mínimos. Libere espaço (docs/testing/runner-proprio.md, manutenção)."
    return 1
  fi
  log "disco livre: $((free_kb / 1048576)) GB"
}

stamp() { # stamp <nome> [detalhe]
  mkdir -p "$STATE_DIR" 2>/dev/null || return 0
  printf '%s run=%s job=%s %s\n' "$(date -u +%FT%TZ)" "${GITHUB_RUN_ID:-?}" "${GITHUB_JOB:-?}" "${2:-}" >"$STATE_DIR/$1"
}
