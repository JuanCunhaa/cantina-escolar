#!/usr/bin/env bash
# Veracode SCA (agente srcclr) com --no-upload: os resultados NÃO são publicados na plataforma, mas a análise NÃO é
# offline (o agente consulta o serviço da Veracode). Critério avaliado localmente (scripts/ci/veracode-report.ts).
# Uso: bash scripts/ci/veracode-sca.sh   (VERACODE_OUT=dir de saída, padrão "veracode")
set -euo pipefail
node scripts/ci/require-config.ts "Veracode SCA" SRCCLR_API_TOKEN VERACODE_REGION=commercial
out="${VERACODE_OUT:-veracode}"
mkdir -p "$out"
bash scripts/ci/tools/install-srcclr.sh
# Árvore de PRODUÇÃO pelo lockfile (base do critério de bloqueio). Código de saída do npm ls não decide nada aqui.
npm ls --omit=dev --all --json --package-lock-only > "$out/npm-ls-prod.json" || true
srcclr scan . --no-upload --json="$out/sca.json"
node scripts/ci/veracode-report.ts sca "$out/sca.json" "$out/npm-ls-prod.json" package-lock.json
