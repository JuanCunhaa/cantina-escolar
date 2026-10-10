#!/usr/bin/env bash
# Camada "toolchain" de scripts/ci/runner/validate.sh (carregada por ele; usa ok/warn/fail/info). Roda na raiz do repositório,
# com Node 24 e Java 21 já configurados e SEM a suíte: confere só o que difere entre o Ubuntu hospedado e a VPS.
# Escreve apenas em RUNNER_TEMP e nos caches intencionais (~/.npm, ~/.cache/ms-playwright, ~/.cache/firebase, imagem do contêiner).

PIPELINE_SCAN_IMAGE="${PIPELINE_SCAN_IMAGE:-veracode/pipeline-scan@sha256:894fd6d68bb2b2177f1a6931806be426e547ec627a5e750e3d938b23752676da}"

timed() { # timed <rótulo> <segundos-limite> <comando...>: ok/falha com a duração; saída só em caso de falha
  local label="$1" limit="$2" start out rc
  shift 2
  start=$SECONDS
  out="$(timeout "$limit" "$@" 2>&1)"
  rc=$?
  if [ $rc -eq 0 ]; then ok "$label ($((SECONDS - start)) s)"; else fail "$label (código $rc após $((SECONDS - start)) s)"; printf '%s\n' "$out" | tail -n 25 | sed 's/^/         | /'; fi
  return $rc
}

check_gnu_vs_uutils() {
  # Ubuntu 26.04 troca o coreutils por uutils (Rust). Os scripts do CI usam sort -V, tail, find e sha256sum -c.
  local tmp="${RUNNER_TEMP:-/tmp}/validate-coreutils"
  rm -rf "$tmp" && mkdir -p "$tmp/dir-a10" "$tmp/dir-a2" && cd "$tmp" || return 0
  [ "$(printf 'x-a2\nx-a10\nx-a9\n' | sort -V | tail -n 1)" = "x-a10" ] && ok "sort -V | tail -n 1 (ordem de tentativas do quality)" || fail "sort -V diferente do GNU"
  [ "$(find . -maxdepth 1 -type d -name 'dir-a*' | sort -V | tail -n 1)" = "./dir-a2" ] && ok "find -maxdepth/-type/-name" || fail "find diferente do esperado"
  printf 'abc' >f.txt
  echo "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  f.txt" | sha256sum -c - >/dev/null 2>&1 && ok "sha256sum -c - (instaladores com hash fixo)" || fail "sha256sum -c - não conferiu um hash conhecido"
  cd - >/dev/null || true
  rm -rf "$tmp"
}

check_node_stack() {
  info "node $(node --version) · npm $(npm --version) · java $(java -version 2>&1 | head -n 1)"
  case "$(node --version)" in v24.*) ok "Node 24" ;; *) fail "Node diferente de 24" ;; esac
  case "$(java -version 2>&1 | head -n 1)" in *'"21.'*) ok "Java 21 (emuladores)" ;; *) fail "Java diferente de 21" ;; esac
  timed "npm ci (lockfile, sem scripts extras do runner)" 600 npm ci || return 1
  timed "firebase-tools $(npx --no-install firebase --version 2>/dev/null)" 60 npx --no-install firebase --version
}

check_emulators() {
  # Mesmo mecanismo do backend/e2e: JARs do emulador (cache em ~/.cache/firebase) + Java + portas fixas.
  timed "emuladores Auth+Firestore sobem e encerram (projeto demo-cantina)" 300 \
    npx --no-install firebase emulators:exec --only auth,firestore --project demo-cantina "node -e \"fetch('http://127.0.0.1:8080/').then(r=>console.log('firestore HTTP',r.status))\""
  if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq '[:.](9099|8080|4000)$'; then fail "emuladores deixaram portas abertas após encerrar"; else ok "portas dos emuladores livres após encerrar"; fi
}

check_playwright() {
  info "$(npx --no-install playwright --version)"
  timed "playwright install chromium (cache ~/.cache/ms-playwright)" 300 npx --no-install playwright install chromium
  local script="${RUNNER_TEMP:-/tmp}/launch-chromium.mjs"
  cat >"$script" <<EOF
import { chromium } from "$PWD/node_modules/@playwright/test/index.mjs";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<h1>ok</h1>");
console.log("chromium", browser.version(), await page.textContent("h1"));
await browser.close();
EOF
  if ! timed "Chromium headless abre e fecha uma página" 90 node "$script"; then
    warn "bibliotecas do Chromium ausentes? Comando que o Playwright indica para ESTE sistema (rodar como administrador, uma vez):"
    npx --no-install playwright install-deps --dry-run chromium 2>&1 | tail -n 6 | sed 's/^/         | /'
  fi
  rm -f "$script"
}

check_scanners() {
  local bin="${RUNNER_TEMP:-/tmp}/validate-bin"
  mkdir -p "$bin"
  timed "gitleaks fixado (download + SHA-256 + execução)" 120 bash scripts/ci/tools/install-gitleaks.sh "$bin"
  timed "actionlint fixado (download + SHA-256 + execução)" 120 bash scripts/ci/tools/install-actionlint.sh "$bin"
  [ -x "$bin/actionlint" ] && timed "actionlint nos workflows" 60 "$bin/actionlint" -color
  local out="${RUNNER_TEMP:-/tmp}/validate-sast"
  rm -rf "$out" && mkdir -p "$out"
  git archive --format=zip -o "$out/sast.zip" HEAD -- src package.json package-lock.json tsconfig.json next.config.ts \
    && ok "git archive do pacote SAST: $(unzip -Z1 "$out/sast.zip" | grep -c -v '/$') arquivos" || fail "git archive do pacote SAST"
  rm -rf "$out" "$bin"
}

check_container() {
  if ! command -v docker >/dev/null 2>&1; then fail "contêiner: docker/podman ausente (Veracode Pipeline Scan não roda)"; return 0; fi
  info "$(docker --version)"
  timed "imagem fixada do Pipeline Scan (pull por digest)" 600 docker pull "$PIPELINE_SCAN_IMAGE" || return 0
  local dir="${RUNNER_TEMP:-/tmp}/validate-scan" opts
  rm -rf "$dir" && mkdir -p "$dir"
  # Mesma montagem de scripts/ci/veracode-sast.sh: o contêiner precisa gravar no diretório do job.
  # shellcheck source=/dev/null
  source "$(dirname "${BASH_SOURCE[0]}")/../tools/container-user.sh"
  opts="$(container_user_args)"
  info "usuário do contêiner: ${opts:-padrão}"
  # shellcheck disable=SC2086
  timed "contêiner grava no diretório montado (usuário do job)" 120 docker run --rm $opts -e HOME=/tmp -v "$dir:/scan" --entrypoint sh "$PIPELINE_SCAN_IMAGE" -c 'echo ok > /scan/probe.txt'
  [ -f "$dir/probe.txt" ] && ok "arquivo criado pelo contêiner pertence a $(stat -c %U "$dir/probe.txt")" || fail "contêiner não gravou no diretório montado"
  rm -rf "$dir"
}

check_toolchain() {
  check_gnu_vs_uutils
  check_node_stack || return 0
  check_emulators
  check_playwright
  check_scanners
  check_container
  check_ports
}
