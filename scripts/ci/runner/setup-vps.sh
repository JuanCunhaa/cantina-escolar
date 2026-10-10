#!/usr/bin/env bash
# Provisionamento ÚNICO e idempotente da VPS do runner próprio (Ubuntu 26.04, usuário do serviço `ghrunner`). Roda como ADMINISTRADOR
# (sudo), nunca dentro de um job. O que muda no sistema fica listado aqui; o usuário do runner continua sem sudo e sem grupos extras.
# Uso: sudo bash setup-vps.sh [--swap 4G] [--runner-dir /home/ghrunner/actions-runner] [--user ghrunner] [--dry-run]
# Estrutura esperada ao lado deste arquivo (copie com scp, não execute nada de dentro de _work, que o job controla):
#   runner/setup-vps.sh, runner/hooks/*.sh   tools/install-srcclr.sh
set -euo pipefail

RUNNER_USER=ghrunner
RUNNER_DIR=/home/ghrunner/actions-runner
SWAP=""
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --swap) SWAP="$2"; shift 2 ;;
    --runner-dir) RUNNER_DIR="$2"; shift 2 ;;
    --user) RUNNER_USER="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "argumento desconhecido: $1"; exit 2 ;;
  esac
done
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_SRC="$HERE/hooks"
SRCCLR_INSTALLER="$HERE/../tools/install-srcclr.sh"
HOOKS_DST=/opt/cantina-ci/hooks

step() { printf '\n==> %s\n' "$*"; }
run() { if [ "$DRY" -eq 1 ]; then printf '   [dry-run] %s\n' "$*"; else "$@"; fi; }

[ "$(id -u)" -eq 0 ] || { echo "Execute com sudo (como administrador)."; exit 1; }
id "$RUNNER_USER" >/dev/null 2>&1 || { echo "usuário $RUNNER_USER não existe"; exit 1; }
[ "$RUNNER_USER" != root ] || { echo "o usuário do runner não pode ser root"; exit 1; }
[ -d "$RUNNER_DIR" ] || { echo "diretório do runner não encontrado: $RUNNER_DIR"; exit 1; }
[ -f "$HOOKS_SRC/job-started.sh" ] || { echo "hooks não encontrados em $HOOKS_SRC"; exit 1; }
RUNNER_UID="$(id -u "$RUNNER_USER")"

# Playwright 1.63 / Chromium: lista que `playwright install-deps --dry-run chromium` indicou nesta VPS (Ubuntu 26.04), run 38015789323.
PLAYWRIGHT_DEPS="at-spi2-common fontconfig fontconfig-config fonts-freefont-ttf fonts-ipafont-gothic fonts-liberation fonts-noto-color-emoji fonts-tlwg-loma-otf fonts-unifont fonts-wqy-zenhei libasound2-data libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libavahi-client3 libavahi-common-data libavahi-common3 libcairo2 libcups2t64 libdatrie1 libdrm-intel1 libfontconfig1 libfontenc1 libgbm1 libgl1 libgl1-mesa-dri libglvnd0 libglx-mesa0 libglx0 libgraphite2-3 libharfbuzz0b libice6 libpango-1.0-0 libpciaccess0 libpixman-1-0 libsm6 libthai-data libthai0 libvulkan1 libx11-xcb1 libxaw7 libxcb-dri3-0 libxcb-glx0 libxcb-present0 libxcb-randr0 libxcb-render0 libxcb-shm0 libxcb-sync1 libxcb-xfixes0 libxcomposite1 libxdamage1 libxfixes3 libxfont2 libxi6 libxkbfile1 libxmu6 libxpm4 libxrandr2 libxrender1 libxres1 libxshmfence1 libxt6t64 libxxf86vm1 mesa-libgallium x11-common x11-xkb-utils xfonts-cyrillic xfonts-encodings xfonts-scalable xfonts-utils xserver-common xvfb"

step "1/7 Pacotes: Chromium do Playwright, contêiner rootless (Podman) e utilitários"
run apt-get update -qq
# shellcheck disable=SC2086
run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $PLAYWRIGHT_DEPS podman podman-docker uidmap zip

step "2/7 Podman rootless para $RUNNER_USER (sem grupo docker, sem daemon com privilégio)"
run touch /etc/containers/nodocker
if ! grep -q "^$RUNNER_USER:" /etc/subuid 2>/dev/null || ! grep -q "^$RUNNER_USER:" /etc/subgid 2>/dev/null; then
  run usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$RUNNER_USER"
fi
run loginctl enable-linger "$RUNNER_USER"

step "3/7 Veracode SCA (srcclr) fixado por versão e hash — instalação feita aqui, uma vez, e não a cada job"
if [ -f "$SRCCLR_INSTALLER" ]; then run bash "$SRCCLR_INSTALLER"; else echo "   instalador não encontrado ($SRCCLR_INSTALLER): pulado"; fi

step "4/7 Hooks de limpeza em $HOOKS_DST (de propriedade do root: o job não os edita)"
run install -d -m 755 -o root -g root /opt/cantina-ci "$HOOKS_DST"
for f in cleanup.sh job-started.sh job-completed.sh; do run install -m 755 -o root -g root "$HOOKS_SRC/$f" "$HOOKS_DST/$f"; done
run install -d -m 700 -o "$RUNNER_USER" -g "$RUNNER_USER" "/home/$RUNNER_USER/.cantina-ci"

step "5/7 Ambiente do serviço do runner ($RUNNER_DIR/.env)"
ENV_FILE="$RUNNER_DIR/.env"
set_env() { # set_env CHAVE VALOR: acrescenta ou atualiza
  if [ "$DRY" -eq 1 ]; then echo "   [dry-run] $1=$2"; return; fi
  touch "$ENV_FILE"
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s#^$1=.*#$1=$2#" "$ENV_FILE"; else echo "$1=$2" >>"$ENV_FILE"; fi
  chown "$RUNNER_USER:$RUNNER_USER" "$ENV_FILE"
}
set_env ACTIONS_RUNNER_HOOK_JOB_STARTED "$HOOKS_DST/job-started.sh"
set_env ACTIONS_RUNNER_HOOK_JOB_COMPLETED "$HOOKS_DST/job-completed.sh"
set_env XDG_RUNTIME_DIR "/run/user/$RUNNER_UID"

if [ -n "$SWAP" ]; then
  step "6/7 Swap de $SWAP (/swapfile)"
  if swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then echo "   /swapfile já ativo"; else
    run fallocate -l "$SWAP" /swapfile
    run chmod 600 /swapfile
    run mkswap /swapfile
    run swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || { [ "$DRY" -eq 1 ] || echo '/swapfile none swap sw 0 0' >>/etc/fstab; }
  fi
else
  step "6/7 Swap: não solicitado (a VPS está sem swap; use --swap 4G se quiser)"
fi

step "7/7 Reiniciar o serviço do runner para ler o novo ambiente (só se estiver ocioso)"
if pgrep -u "$RUNNER_USER" -f 'Runner.Worker' >/dev/null 2>&1; then
  echo "   HÁ UM JOB EXECUTANDO: serviço NÃO reiniciado. Reinicie depois: cd $RUNNER_DIR && sudo ./svc.sh stop && sudo ./svc.sh start"
else
  (cd "$RUNNER_DIR" && run ./svc.sh stop && run ./svc.sh start && ./svc.sh status | head -n 5) || echo "   falha ao reiniciar: faça manualmente em $RUNNER_DIR (svc.sh stop/start)"
fi

echo
echo "Concluído. Confira como $RUNNER_USER (deve imprimir true):"
echo "  sudo -u $RUNNER_USER -H env XDG_RUNTIME_DIR=/run/user/$RUNNER_UID docker info --format '{{.Host.Security.Rootless}}'"
