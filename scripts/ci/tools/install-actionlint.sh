#!/usr/bin/env bash
# actionlint fixado por versão e SHA-256 (binário oficial). Uso: bash scripts/ci/tools/install-actionlint.sh <diretório-destino>
set -euo pipefail
ACTIONLINT_VERSION=1.7.12
ACTIONLINT_SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
dest="${1:?destino}"
mkdir -p "$dest"
tmp="$(mktemp -d)"
curl -sSfL -o "$tmp/actionlint.tar.gz" "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz"
echo "${ACTIONLINT_SHA256}  $tmp/actionlint.tar.gz" | sha256sum -c -
tar -xzf "$tmp/actionlint.tar.gz" -C "$dest" actionlint
"$dest/actionlint" -version
