#!/usr/bin/env bash
# Veracode Pipeline Scan (SAST) do FONTE do commit testado. O pacote (git archive: src, package*.json, tsconfig.json,
# next.config.ts — sem .env, node_modules, .next, testes) é ENVIADO ao motor remoto da Veracode para análise; o resultado
# volta ao job e NÃO é publicado na plataforma (sem Upload and Scan, sem importação). Imagem oficial fixada por digest.
# Uso: bash scripts/ci/veracode-sast.sh   (VERACODE_OUT=dir de saída, padrão "veracode"; VERACODE_SEED_DIR só no probe)
set -euo pipefail
node scripts/ci/require-config.ts "Veracode Pipeline Scan" VERACODE_API_ID VERACODE_API_KEY VERACODE_REGION=commercial
out="${VERACODE_OUT:-veracode}"
mkdir -p "$out"
git archive --format=zip -o "$out/sast.zip" HEAD -- src package.json package-lock.json tsconfig.json next.config.ts
if [ -n "${VERACODE_SEED_DIR:-}" ]; then
  # Probe: acrescenta ao ZIP (nunca ao repositório) um arquivo semeado para conferir detecção.
  (cd "$VERACODE_SEED_DIR" && zip -qr "$OLDPWD/$out/sast.zip" .)
fi
echo "Pacote enviado à análise: $(unzip -Z1 "$out/sast.zip" | grep -c -v '/$') arquivos"
unzip -Z1 "$out/sast.zip" | grep -v '/$' | sed -E 's/.*\.([A-Za-z0-9]+)$/\1/' | sort | uniq -c | sort -rn | head -10
status=0
# Credenciais pelos parâmetros documentados do Pipeline Scan (o Actions mascara os valores no log). Um arquivo de
# credenciais montado no container NÃO foi lido pela imagem (probe P4: "Missing value for credential: 'ID'").
docker run --rm -v "$PWD/$out:/scan" -w /scan \
  veracode/pipeline-scan@sha256:894fd6d68bb2b2177f1a6931806be426e547ec627a5e750e3d938b23752676da \
  --veracode_api_id "$VERACODE_API_ID" --veracode_api_key "$VERACODE_API_KEY" \
  --file sast.zip --fail_on_severity="Very High, High" --json_output_file results.json --filtered_json_output_file filtered_results.json || status=$?
echo "Pipeline Scan terminou com código $status (o critério é avaliado abaixo)"
node scripts/ci/veracode-report.ts sast "$out/results.json"
