#!/usr/bin/env bash
# Validação SOMENTE LEITURA do runner próprio (cantina-vps-01) contra o que o CI exige. Não instala nada e não usa sudo.
# Uso: bash scripts/ci/runner/validate.sh base       (inventário leve: usuário, host, ferramentas, portas, escrita, hooks)
#      bash scripts/ci/runner/validate.sh toolchain  (após `npm ci`, Node 24 e Java 21: emulador, Chromium, scanners, contêiner)
# Saída: uma linha por verificação (OK / AVISO / FALHA) e, no fim, o resumo; código de saída 1 se houver FALHA.
set -u
mode="${1:-base}"
fails=0
warns=0
lines=()

ok() { printf 'OK     %s\n' "$*"; lines+=("OK|$*"); }
warn() { printf 'AVISO  %s\n' "$*"; lines+=("AVISO|$*"); warns=$((warns + 1)); }
fail() { printf 'FALHA  %s\n' "$*"; lines+=("FALHA|$*"); fails=$((fails + 1)); }
info() { printf 'INFO   %s\n' "$*"; lines+=("INFO|$*"); }
need() { # need <comando> [versão-cmd...]: obrigatório
  if command -v "$1" >/dev/null 2>&1; then
    shift
    ok "$1 $("$@" 2>&1 | head -n 1)"
  else
    fail "ferramenta ausente: $1"
  fi
}

# ---------------------------------------------------------------- identidade e privilégios
check_identity() {
  local user groups
  user="$(id -un)"
  groups="$(id -nG)"
  if [ "$(id -u)" -eq 0 ]; then fail "executando como root (os jobs não podem ser root)"; else ok "usuário do job: $user (uid $(id -u)), grupos: $groups"; fi
  for g in sudo admin wheel root docker lxd disk adm; do
    case " $groups " in *" $g "*) warn "grupo '$g' concede privilégio além do necessário para o CI" ;; esac
  done
  if sudo -n true >/dev/null 2>&1; then fail "sudo sem senha disponível para $user: o job poderia virar root"; else ok "sem sudo sem senha"; fi
  if [ "${RUNNER_ENVIRONMENT:-}" = "self-hosted" ]; then ok "RUNNER_ENVIRONMENT=self-hosted (runner ${RUNNER_NAME:-?}, ${RUNNER_OS:-?}/${RUNNER_ARCH:-?})"; else warn "RUNNER_ENVIRONMENT='${RUNNER_ENVIRONMENT:-vazio}' (fora do Actions ou runner hospedado)"; fi
}

# ---------------------------------------------------------------- host
check_host() {
  local pretty mem_kb swap_kb free_kb dir
  pretty="$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-desconhecido}")"
  info "sistema: $pretty, kernel $(uname -r)"
  [ "$(uname -m)" = "x86_64" ] && ok "arquitetura x86_64" || fail "arquitetura $(uname -m) (o CI baixa binários linux x64)"
  local cpus
  cpus="$(nproc)"
  [ "$cpus" -ge 4 ] && ok "CPUs: $cpus" || warn "CPUs: $cpus (< 4)"
  mem_kb="$(awk '/^MemTotal:/{print $2}' /proc/meminfo)"
  swap_kb="$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)"
  [ "$mem_kb" -ge 7000000 ] && ok "memória: $((mem_kb / 1024)) MB, swap: $((swap_kb / 1024)) MB" || warn "memória: $((mem_kb / 1024)) MB (< 7 GB)"
  [ "$swap_kb" -gt 0 ] || warn "sem swap: estouro de memória no e2e mata o job sem aviso (considere 4 GB)"
  dir="${GITHUB_WORKSPACE:-$PWD}"
  free_kb="$(df -Pk "$dir" | awk 'NR==2{print $4}')"
  if [ "$free_kb" -ge 20000000 ]; then ok "disco livre em $dir: $((free_kb / 1048576)) GB"; elif [ "$free_kb" -ge 10000000 ]; then warn "disco livre baixo: $((free_kb / 1048576)) GB"; else fail "disco livre insuficiente: $((free_kb / 1048576)) GB"; fi
  info "timezone: $(date +%Z) ($(cat /etc/timezone 2>/dev/null || echo ?)); relógio: $(date -u +%FT%TZ)"
}

# ---------------------------------------------------------------- ferramentas de sistema
check_tools() {
  need git git --version
  need curl curl --version
  need tar tar --version
  need gzip gzip --version
  need unzip unzip -v
  command -v zip >/dev/null 2>&1 && ok "zip $(zip -v | sed -n 2p)" || info "zip ausente (só o probe com VERACODE_SEED_DIR usa; o pacote SAST é feito por git archive)"
  need gpg gpg --version
  need gpgv gpgv --version
  need sha256sum sha256sum --version
  need awk awk --version
  need ps ps --version
  need free free -V
  command -v jq >/dev/null 2>&1 && ok "jq $(jq --version)" || info "jq ausente (o CI não usa)"
  command -v ss >/dev/null 2>&1 && ok "ss disponível" || warn "ss ausente (verificação de portas limitada)"
  command -v dpkg >/dev/null 2>&1 && ok "dpkg disponível" || fail "dpkg ausente"
  command -v srcclr >/dev/null 2>&1 && ok "srcclr: $(dpkg -s srcclr 2>/dev/null | awk '/^Version:/{print $2}')" || warn "srcclr (Veracode SCA) não instalado: instalar como administrador (ver docs/testing/runner-proprio.md)"
  if command -v docker >/dev/null 2>&1; then
    local rootless sec
    rootless="$(docker info --format '{{.Host.Security.Rootless}}' 2>/dev/null || true)"
    sec="$(docker info --format '{{.SecurityOptions}}' 2>/dev/null || true)"
    if [ "$rootless" = "true" ]; then ok "Podman rootless ($(docker --version))"
    elif [ -n "$sec" ]; then case "$sec" in *rootless*) ok "docker rootless ($sec)" ;; *) warn "docker NÃO rootless ($sec): acesso ao daemon equivale a root" ;; esac
    else fail "docker/podman presente, mas indisponível para este usuário (XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-vazio})"; fi
  else
    fail "docker/podman ausente (o Veracode Pipeline Scan roda em contêiner)"
  fi
}

# ---------------------------------------------------------------- portas fixas dos emuladores e do servidor e2e
check_ports() {
  local port listening
  if ! command -v ss >/dev/null 2>&1; then return 0; fi
  listening="$(ss -ltnH 2>/dev/null | awk '{print $4}')"
  # 9099 auth, 8080 firestore, 4000 UI, 4400 hub, 4500 logging, 9150 websocket do firestore, 3100 servidor e2e
  for port in 9099 8080 4000 4400 4500 9150 3100; do
    if printf '%s\n' "$listening" | grep -Eq "[:.]${port}\$"; then fail "porta $port já em uso por outro processo (conflito com emuladores/e2e)"; else ok "porta $port livre"; fi
  done
}

# ---------------------------------------------------------------- escrita
check_writes() {
  local d probe
  for d in "${GITHUB_WORKSPACE:-$PWD}" "${RUNNER_TEMP:-/tmp}" "${RUNNER_TOOL_CACHE:-$HOME/.cache}" "$HOME/.npm" "$HOME/.cache" /tmp; do
    mkdir -p "$d" 2>/dev/null || true
    if probe="$(mktemp "$d/.validate-XXXXXX" 2>/dev/null)"; then rm -f "$probe"; ok "escrita permitida em $d"; else fail "sem permissão de escrita em $d"; fi
  done
}

# ---------------------------------------------------------------- hooks de limpeza
check_hooks() {
  local state="${CANTINA_CI_STATE:-$HOME/.cantina-ci}" f
  if [ -n "${ACTIONS_RUNNER_HOOK_JOB_STARTED:-}" ] && [ -x "$ACTIONS_RUNNER_HOOK_JOB_STARTED" ]; then ok "hook job-started configurado: $ACTIONS_RUNNER_HOOK_JOB_STARTED"; else warn "hook job-started não configurado no ambiente do runner"; fi
  if [ -n "${ACTIONS_RUNNER_HOOK_JOB_COMPLETED:-}" ] && [ -x "$ACTIONS_RUNNER_HOOK_JOB_COMPLETED" ]; then ok "hook job-completed configurado: $ACTIONS_RUNNER_HOOK_JOB_COMPLETED"; else warn "hook job-completed não configurado no ambiente do runner"; fi
  for f in last-job-started last-job-completed; do
    if [ -r "$state/$f" ]; then info "$f: $(cat "$state/$f")"; else info "$f: ainda não registrado em $state"; fi
  done
}

# ---------------------------------------------------------------- estado ocioso (nada de job anterior consumindo recursos)
check_idle() {
  local owner n names containers
  owner="$(ps -eo user=,comm= | awk '$2=="Runner.Listener"{print $1}' | sort -u | tr '\n' ' ')"
  case "$owner" in
    "") warn "Runner.Listener não visível neste job" ;;
    "$(id -un) ") ok "serviço do runner (Runner.Listener) executa como $(id -un)" ;;
    *) fail "Runner.Listener executa como: $owner" ;;
  esac
  info "carga (1/5/15 min): $(cut -d' ' -f1-3 /proc/loadavg); processos do usuário: $(ps -u "$(id -u)" --no-headers | wc -l)"
  names="$(ps -u "$(id -u)" -o comm= | grep -E '^(java|firebase|chrome|chromium|headless_shell|next-server|gitleaks|srcclr|vitest|playwright)' | sort | uniq -c | tr '\n' ' ')"
  n="$(printf '%s' "$names" | wc -w)"
  if [ "$n" -eq 0 ]; then ok "sem processos de job remanescentes (java/firebase/chromium/next/scanners)"; else fail "processos remanescentes de job anterior: $names"; fi
  if command -v docker >/dev/null 2>&1; then
    if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
      ok "docker acessível como $(id -un) (servidor $(docker version --format '{{.Server.Version}}'))"
      containers="$(docker ps -q | wc -l)"
      if [ "$containers" -eq 0 ]; then ok "nenhum contêiner em execução ($(docker ps -aq | wc -l) parado(s) no total)"; else fail "$containers contêiner(es) em execução de job anterior"; fi
    else
      fail "docker sem acesso ao daemon como $(id -un)"
    fi
  fi
}

case "$mode" in
  base)
    check_identity
    check_host
    check_tools
    check_ports
    check_writes
    check_hooks
    check_idle
    ;;
  toolchain)
    # shellcheck source=/dev/null
    source "$(dirname "${BASH_SOURCE[0]}")/validate-toolchain.sh"
    check_toolchain
    ;;
  *)
    echo "Uso: bash scripts/ci/runner/validate.sh base|toolchain"
    exit 2
    ;;
esac

echo
echo "Resumo ($mode): $fails falha(s), $warns aviso(s)"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Validação do runner ($mode)"
    echo
    echo "| Resultado | Verificação |"
    echo "|---|---|"
    for l in "${lines[@]}"; do printf '| %s | %s |\n' "${l%%|*}" "$(printf '%s' "${l#*|}" | sed 's/|/\\|/g')"; done
    echo
    echo "**$fails falha(s), $warns aviso(s)**"
  } >>"$GITHUB_STEP_SUMMARY"
fi
[ "$fails" -eq 0 ]
