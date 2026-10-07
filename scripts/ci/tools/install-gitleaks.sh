#!/usr/bin/env bash
# Gitleaks fixado por versão e SHA-256 (binário oficial). Uso: bash scripts/ci/tools/install-gitleaks.sh <diretório-destino>
set -euo pipefail
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
dest="${1:?destino}"
mkdir -p "$dest"
tmp="$(mktemp -d)"
curl --proto '=https' --tlsv1.2 -sSfL -o "$tmp/gitleaks.tar.gz" "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
echo "${GITLEAKS_SHA256}  $tmp/gitleaks.tar.gz" | sha256sum -c -
tar -xzf "$tmp/gitleaks.tar.gz" -C "$dest" gitleaks
"$dest/gitleaks" version
