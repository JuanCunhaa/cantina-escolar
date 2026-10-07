# CI/CD — linha de base, medições e orçamento (tarefa de infraestrutura, out/2026)

Escopo: workflows, scripts de automação, execução dos testes, relatórios e instruções para a IA. Código funcional,
cenários e expectativas dos testes **não** mudam nesta tarefa; defeitos da aplicação ficam registrados para a etapa seguinte.

## 1. Estado de partida (06–07/10/2026)

- `main` em `4631bed` (merge do PR #25, F18). F18 integrada ao sandbox do Mercado Pago e à homologação; **não credita a
  carteira** (F19).
- **CI da `main` vermelho**: run [37552886769](https://github.com/JuanCunhaa/cantina-escolar/actions/runs/37552886769),
  tentativas 1 e 2 falharam em `tests/e2e/students.spec.ts:25` (linha 35: `toBeVisible` — célula da turma recém-criada
  não encontrada em 5 s). **Causa não comprovada**; não reexecutado de novo para obter verde. Fica para a etapa de correção.
- Workflows: `ci.yml` (jobs `check` — tudo em série —, `security` — Gitleaks + Semgrep registry — e `semgrep-appsec`) e
  `listener-diagnostic.yml` (pontual, inoperante).
- Proteção da `main`: **inexistente**, comprovada com token de escopo `repo` e permissão `admin`: `GET branches/main` →
  `protected: false`, `required_status_checks.enforcement_level: off`; `GET rules/branches/main` → `[]`; `GET
  branches/main/protection` → 404 "Branch not protected". **Não verificado** se o plano da conta permite ativar proteção
  em repositório privado (plano não legível sem ampliar escopo, o que não foi feito). Portanto o `check` é **gate
  implementado, não exigido pelo GitHub**.

## 2. Linha de base medida (metadados da API do Actions; coletor `scripts/ci/metrics/collect.ts`)

Amostra: 20 execuções concluídas mais recentes do `ci` (05–07/10/2026). Tempo de parede = da criação do run ao fim do
último job executado. Minutos brutos = soma das durações dos jobs com runner, cada execução contada uma vez.

| Medida (n=20) | Mediana | p95 |
|---|---|---|
| Espera até o resultado da 1ª tentativa | 16m42s | 21m25s |
| Espera até o resultado final (inclui espera humana entre tentativas) | 19m50s | 70m09s |
| Minutos brutos somados | 22,4 | 43,2 |
| Estimativa arredondada (por job, minuto superior) | 24 | 45 |

- Execuções verdes na 1ª tentativa sem reexecução: 5/20 (879–1328 s de espera). Conclusões: 10 success, 5 failure,
  5 cancelled (substituídas por novo push). **8/20 tiveram reexecução**; as reexecuções somaram de 1 a 42 min brutos por run.
- Etapas do antigo `check` (faixa nas execuções completas): npm ci 16–34 s; lint 13–19; typecheck 10–13; unit 6–9; Rules
  34–44; **integração 283–423 s**; Playwright install 22–33 s (104 s uma vez); **e2e 299–774 s**; propagação 28–35;
  build 31–40. `security` 39–47 s; `semgrep-appsec` 122–296 s.
- Soma dos tempos dos testes e2e (run 37551157123): ~400 s de 508 s da etapa. Por spec: students 52 s, wallet 33,
  cancellation 32, pos 31, my-orders 27, topups 26, fulfillment 26, checkout 24, online-topup 22, menu 21, amend 20,
  policies 19, access 19, shell-photos 18, inventory 12, catalog 10, foundation 7, calendar 5.

### Fatos da API que mudam a contabilidade (medidos)

- **Reexecução parcial**: a tentativa nova lista os jobs NÃO reexecutados com **ID novo** e `run_attempt` da tentativa
  nova, mas com `started_at`/`completed_at`/runner da execução original (run 37552886769: `security` 112572282049 →
  112577680455). Deduplicar só pelo ID duplicaria o consumo; o coletor identifica a execução por (nome, runner, início,
  fim) e a atribui à tentativa mais antiga.
- **Jobs sem runner** (incidente do Actions em 05/10, run 37371742988): cancelados após 15 min na fila, 0 etapas,
  `runner_name` vazio. Não são consumo de runner; o coletor os registra à parte.
- `updated_at` do run não é horário de conclusão (run 37264081311: atualizado 10 h depois por reexecução).
- `GET runs/{id}/timing` devolve `billable.total_ms = 0` para todos os jobs; **cobrança oficial indisponível** (não foi
  ampliado escopo de conta para consultá-la).
- A Vercel publica no commit só o status final (`created_at = updated_at`): **duração da Vercel indisponível** pelo GitHub.

### Hipóteses (não comprovadas)

- Parte dos ~100 s entre a soma dos testes e a etapa e2e seria inicialização de emuladores/servidor e compilação sob
  demanda do `next dev`.
- As intermitências e2e não têm causa atribuída (ver §6). Nada aqui as atribui a carga, listener ou outra causa.

## 3. Desenho novo (9 jobs no `ci` + 1 no `ci-metrics`)

`changes` → (`fast`, `backend`, `build`, `security`, `semgrep-appsec` em paralelo) → `e2e (g1)`, `e2e (g2)` (após
`build`) → `quality` (após `fast` + `backend`) → `check` (sempre). Detalhes e justificativas: docs/testing/ci.md.

- Caminho crítico esperado: `changes` (~0,3 min) + `backend` (npm ci + Java + Rules + integração ≈ 8–9 min) +
  `quality` (~2 min) + `check`. Em paralelo, `build` (~2,5 min) + e2e por grupo (~5–7 min, a medir).
- Custo: os minutos brutos sobem (instalação repetida por job) e a estimativa arredondada sobe mais (9–10 jobs
  arredondados em vez de 3). A comparação antes/depois mede as duas coisas.
- `semgrep-appsec` é transitório (sai quando o Veracode for validado): durante a transição o `ci` tem 10 jobs.

## 4. Orçamento de runner aprovado (base 166 min arredondados)

| Etapa | Previsto (arred.) | Consumido (arred.) | Situação |
|---|---|---|---|
| Trabalho local (scripts, fixtures, integração local) | 0 | 0 | concluído |
| P1 artefato/rerun/reconstrução | 12 | 22 (4 runs; 2 reprovaram por achados reais) | concluído |
| P2 formas de `needs` | 6 | 6 | concluído |
| P3 classificação/cancelamento (+ referência validada) | 3 | 10 | concluído |
| Recusa por configuração ausente (P4/P5, parte sem credencial) | — | 2 | concluído |
| C comparação dev × compilado (6 execuções) | 80 | 53 (48 brutos) | concluído |
| P4 Veracode (com credenciais) | ≤ 20 | 18 | concluído (§5) |
| P5 Sonar (análise inicial da main + PR) | 5 | 8 | concluído (§5) |
| F execução final do PR | 40 | 32 | concluída — vermelha (§4c) |
| Probe Gitleaks (exceção revisada) | — | 1 | concluído |
| **Total** | **166** | **≈153** | contingência para nova execução completa NÃO autorizada |

Probes de infraestrutura (branch descartável `ci/probe-infra`, 11 runs): 40 min arredondados, 12,1 brutos. A diferença
mostra o custo do arredondamento por job: jobs de segundos custam 1 min cada.

Contingências +40 (nova execução final por defeito de infraestrutura) e +11 (rerun de mecanismo) **não autorizadas**.

## 4b. Comparação e2e: dev × compilado (run 37574882223, mesmo commit `d1fa7c6`, `ubuntu-24.04`, suíte completa de 72 testes, 1 worker)

**Muda DUAS variáveis**: modo (`next dev` × `next build` + `next start`) e bundler (webpack × Turbopack, este igual à Vercel).
O resultado compara as configurações completas; não atribui todo o ganho ao modo de produção. Mesmos testes, asserções,
timeouts e retries; dados fictícios e emuladores locais nos dois modos (`APP_ENV=emulator`).

| Medida (3 + 3 execuções) | dev (webpack) | compilado (Turbopack) |
|---|---|---|
| Custo completo por repetição (build + e2e) | 584 / 612 / 701 s | 338 / 306 / 339 s (build 66–93 s + e2e 240–248 s) |
| Estimativa arredondada | 10 / 11 / 12 min | 7 / 6 / 7 min |
| Etapa e2e (emuladores + servidor + testes) | 523–631 s | 155–172 s |
| Duração dos testes (Playwright) | 508–617 s | 137–154 s |
| Servidor pronto ("Ready") | 462–574 ms | 237–304 ms |
| `npm ci` / Playwright install | 20–32 s / 24–25 s | 42–60 s (2 jobs) / 27–37 s |
| Pacote: empacotar / Gitleaks / upload / download / validar | — | 2–3 s / 5–9 s / 1 s / 2–3 s / 1–2 s |
| CPU (vmstat us+sy): mediana / máximo | 86–89% / 100% | 71–75% / 85–89% |
| Fila de execução máx. (`r`) / memória livre mínima | 21–35 / 764–922 MB | 9–13 / ~4,9 GB |
| Falhas | 1/3 (`students.spec.ts:25`, `dev r1`) | 0/3 |

Regra fixada antes (mediana do custo total menor e não mais falhas): **compilado** (mediana 338 s × 612 s; 0 × 1 falha).
Com 3 amostras isso é indicativo; a falha de `dev r1` é o mesmo defeito intermitente da `main` e NÃO é atribuída ao modo.
Decisão: o `ci` usa o build compartilhado + `next start` nos 2 grupos (já no `ci.yml`).

## 4c. Execução final no PR #27 (run 37580206257, commit `f230542`) — antes × depois

| Medida | Antes (mediana n=20) | Depois (1 execução) |
|---|---|---|
| Espera até o resultado (1ª tentativa) | 16m42s | **10m08s** |
| Minutos brutos somados | 22,4 | 26,5 |
| Estimativa arredondada | 24 | 32 (10 jobs) |

Jobs: `changes` 7 s · `fast` 90 s · `backend` 491 s (caminho crítico) · `build` 83 s · `e2e (g1)` 335 s · `e2e (g2)` 179 s
(com o diagnóstico de propagação) · `security` 200 s · `semgrep-appsec` 104 s · `quality` 89 s · `check` 10 s; criação→início
2–3 s em todos. Artefatos: build 14,5 MB (1 dia), coberturas 0,1 MB (1 dia), resumos/relatórios pequenos (30 dias);
transferências 1–2 s. e2e: 72/72 verdes (36 + 36). Integração/Rules/unit verdes; LCOV mesclado 62% (unit 25,7%,
integração 47,5%; 263 arquivos).

Vermelho por 2 problemas do código de CI desta tarefa (não da aplicação), corrigidos em commits locais ainda não
publicados (nova execução completa excede o orçamento sem autorização):
- `security`: Gitleaks acusou a impressão digital PÚBLICA da chave GPG da Veracode em `install-srcclr.sh` — exceção por
  fingerprint em `.gitleaksignore`, validada no probe 37580802980 (sem achados; sem a exceção o mesmo achado volta).
- `quality`: Quality Gate do código novo com cobertura 86,1% e confiabilidade A, mas segurança B por 1 achado *minor*
  (S5145, mensagem de erro do coletor) — saída sem CR/LF.
O `check` reprovou listando exatamente esses jobs/etapas com links. Desequilíbrio a ajustar: g1 335 s × g2 179 s
(rebalancear pelos tempos medidos, ex.: mover `students.spec.ts` ou `pos.spec.ts` para g2).

Consumo total da tarefa: ≈153 min arredondados de 166 (probes 40, comparação 53, P4 18, P5 8, probe Gitleaks 1, final 32).

## 4d. Integração em 2 grupos (run 37643124577, commit `934138a`) × run 37639559121 (`df4474b`)

Mesmo PR, sem mudança de teste; entre as duas execuções também saiu o Semgrep (`71d5360`).

| Medida | Antes (37639559121) | Depois (37643124577) |
|---|---|---|
| Espera até o resultado | 10m30s | **6m53s** |
| Minutos brutos somados | 25,0 | 22,9 |
| Estimativa arredondada | 31 (10 jobs) | 27 (10 jobs) |
| `backend` | 502 s (1 job) | g1 268 s · g2 285 s |

Integração: g1 215 s (180 testes) · g2 204 s (236 testes) + Rules 39 s (56); g1 + g2 = 416 listados. Demais jobs: `fast` 92 s,
`build` 89 s, `e2e` g1 180 s / g2 172 s, `security` 167 s (sem Semgrep), `quality` 100 s, `check` 8 s. Cobertura mesclada
62,1% (unit 25,9%, integração g1 30%, g2 38,9%); Sonar OK (código novo 85,7%). Caminho crítico agora: `backend (g2)` →
`quality`; build + e2e (~4,5 min) fica logo abaixo. Uma execução só: não é mediana.

## 4e. Pós-merge (07/10/2026)

- PR #27 mesclado (`6e9945e`). Ruleset 24668643 na branch padrão: `check` (GitHub Actions) obrigatório, `deletion` e
  `non_fast_forward` bloqueados, sem bypass; `GET rules/branches/main` confirma as 3 regras (o plano permitiu no repositório
  privado).
- CI da `main` (run 37664506782): `changes`, `fast`, `build`, `security`, `backend` g1/g2 e `quality` verdes; `e2e` g1/g2
  presos em `npx playwright install --with-deps chromium` (normal 25–28 s): g1 baixou 32,5 MB do `azure.archive.ubuntu.com`
  em 13m50s (39 kB/s), g2 parou no `apt-get update`. Cancelado pelo dono após ~15 min. Causa externa (espelho apt), não do
  código. Correção: `timeout-minutes: 5` no passo; reexecutar só o job falho. Cache do navegador não ajudaria (o lento foi o apt).
- `ci-metrics` (1ª execução real, run 37666916222): `ERR_MODULE_NOT_FOUND` em `scripts/ci/lib/bin.ts` — checkout esparso só
  com `scripts/ci/metrics`. Reproduzido localmente (sem `lib` falha; com `lib` carrega) e corrigido.

## 5. Evidências dos probes (Actions real)

- **Vercel**: 0 status/deploy nos commits de `ci/probe-*` (`git.deploymentEnabled` no `vercel.json`).
- **P1** (run 37573638385, 3 tentativas): build Turbopack → pacote `build-<run>-a1` (1395 arquivos, 14,5 MB; 63 MB sem
  compressão; `.next/cache` de 112 MB fora), upload 2 s, download 1–2 s; consumidor validou o manifesto e o `next start`
  respondeu `GET /` 200 (pronto em 337 ms). Tentativa 2 = **só o job falho** reexecutado, consumindo `build-…-a1`.
  Tentativa 3 = reexecução do `build` → novo `build-…-a3` (o `a1` preservado), consumido pelo dependente.
  Achados reais corrigidos: Gitleaks precisava varrer o **pacote** (6 achados no `.next` inteiro, 3 deles no cache não
  enviado); o Turbopack cria links `.next/node_modules/<pacote>-<hash>` → `node_modules/` (firebase-admin,
  @aws-sdk/client-s3) exigidos pelo `next start`; no pacote restam só as chaves aleatórias por build do Next (exceção
  revisada) e os 2 controles negativos (segredo injetado em outro arquivo; mesma chave fora dos 2 arquivos) foram detectados.
- **P2** (run 37574220378): `needs.*.result` reais — `success`, `failure`, `skipped` (condição falsa e dependente de job
  falho) e **`cancelled` para job que estoura `timeout-minutes`**; `job.check_run_id` disponível (links por job).
- **P3**: só `PROGRESS.md` ⇒ `docs`; `docs/tasks/index.md` ⇒ `full`; push novo cancelou o run em andamento do mesmo ref.
  Achado: comparar com o `before` deixaria sem validação o código de um run cancelado/vermelho; corrigido (referência =
  último run verde) e validado em evento real (run 37574746006: `before` daria `docs`, referência validada deu `full`).
- **P4 Veracode** (runs 37576673238, 37576862992, 37577293364, 37578859703): pacote do fonte com 260 arquivos (166 .ts,
  68 .tsx, 22 .gitkeep, 3 .json, 1 .css; ~602 KB) **enviado ao motor remoto**; resultados não publicados na plataforma.
  Rodadas 1–3 revelaram: credencial por arquivo não lida pela imagem (→ parâmetros documentados); credenciais iniciais
  recusadas (HTTP 401 e SCA "problem authenticating" — trocadas pelo dono); a imagem não gravava `results.json` no
  diretório montado (→ usuário do runner). **Rodada 4 (verde)**: `SCAN_STATUS: SUCCESS`, "Analyzed 1 modules"
  ("JS files within sast.zip"), 14 achados (13 Medium, 1 Low) em arquivos `.ts`/`.tsx` da aplicação — análise efetiva de
  TypeScript/TSX nesta stack, apesar do suporte documentado só até TS 5/Node 22; nenhum Very High/High. Pacote semeado
  (só no ZIP): **2 Very High detectados** — CWE-78 `child_process.exec` e CWE-95 `eval` num `.ts` com `satisfies` — e o
  passo reprova, como deve. A detecção semeada prova esse cenário, não cobertura completa de TS 6.
  SCA `--no-upload` (srcclr 3.8.120, cadeia de integridade verificada): 268 bibliotecas (nome@versão), **0
  vulnerabilidades**; árvore de produção pelo `npm ls` = 303: os 35 fora do inventário são opcionais/de outra plataforma
  (binários `@img/sharp-*` e `@next/swc-*` não instalados no Linux, *aliases* `devOptional`) e 0 inesperados (o avaliador
  passa a conferir isso a cada execução). Consumo P4: 12 min arredondados.
- **P5 Sonar — main** (run 37576673238): 341 arquivos TS/JS/CSS analisados, **21.180 ncloc** (`src` + `scripts`);
  cobertura 0 (a `main` ainda não tem instrumentação). Quality Gate **NONE** (o Sonar way só avalia código novo e a
  1ª análise não tem período novo); o scanner o reporta como FAILED e o `sonar-gate.ts` também reprova `NONE` (sem
  aprovação silenciosa). A análise AUTOMÁTICA disparada na importação do projeto (antes de ser desligada) falhou por
  limite: contou 65.022 LOC (24.925 de JSON) > 50.000 do plano Free — por isso a análise fica restrita ao fonte pelo CI.
- **P5 Sonar — PR** (PR rascunho descartável #26, só com o workflow do Sonar; runs 37577040633, 37578914016,
  37579577640): análise de PR com destino `main` **funciona no Free** e o gate efetivo é lido pela API. O gate reprovou o
  **código novo desta tarefa**: 1ª rodada confiabilidade D, segurança C, cobertura 43,6% (os `main()` das CLIs só eram
  exercitados em subprocesso). Corrigido sem mudar critério nem excluir arquivos — executáveis por caminho fixo, URL/caminho
  validados e reconstruídos, sort com comparador, CLIs testáveis em processo (96% de `scripts/ci`): 2ª rodada cobertura
  86,1%, confiabilidade A, segurança C (3 achados de fluxo); 3ª rodada 86,2%, A, segurança B (3 *minor* de injeção em log).
  A correção desses 3 (saída linha a linha sem CR/LF) entra no commit `89984b0` e é verificada na execução final.
- **Recusa** (run 37575192561): o mesmo `scripts/ci/require-config.ts` do `ci.yml` recusou Veracode SAST, Veracode SCA e
  SonarQube Cloud (configuração então inexistente); Semgrep AppSec presente.

## 6. Medições locais (sem runner)

- Unit: 327 testes; 5,8 s sem cobertura × 7,7 s com cobertura V8 (Windows, mesma máquina).
- Integração: 416/416 em 725 s sem cobertura e 660 s com cobertura (Windows local, ruído alto; no CI a suíte leva 283–423 s).
- LCOV mesclado real (local): unit 19,2% + integração 48,5% ⇒ 56,0% das linhas de 259 arquivos (`src` + `scripts`).
- actionlint 1.7.12 com shellcheck 0.11.0: workflows sem achados; controle negativo (injeção de expressão, SC2086) detectado.

## 7. Defeitos/intermitências para a etapa seguinte (causa NÃO atribuída)

1. `students.spec.ts:25` — CI da `main` vermelho em `4631bed` (2/2 tentativas).
2. `wallet.spec.ts`, `policies.spec.ts:26`, `shell-photos.spec.ts:139` — falhas intermitentes já registradas (docs/testing/strategy.md).
3. `calendar.spec` na URL publicada (exibição atrasada do dia salvo; ver pendência de listener no PROGRESS).
4. `policies-api.test.ts` A35 "teto SEMANAL" — timeout de 30 s uma vez (F17), não reproduzido isoladamente.
5. Dependências de desenvolvimento: `npm audit` completo aponta 13 vulnerabilidades (11 high, 2 moderate) preexistentes
   na árvore de dev; produção 0.
6. SonarQube Cloud (main, 1ª análise): 19 achados preexistentes — 11 bugs S2871 (sort sem função de comparação:
   `use-order-history.ts:60-61`, `policies/commands.ts:70-71`, `policies/model.ts:24`, `policies/usage.ts:25-26`,
   `wallet/use-wallets.ts:46`, `menu/model.ts:185`, `catalog/model.ts:44`, `scripts/lib/demo-seed.ts:139`); 1 bug S9383
   (promessa sem tratamento, `components/ui/product-photo.tsx:21`); vulnerabilidades: S4790 hash fraco
   (`lib/storage/local.ts:37,56`, `catalog/photo.ts:71` — avaliar contexto), S4036 PATH (`scripts/staging/run.ts:33,50`),
   S5145 injeção em log (`scripts/seed.ts:22`), S6389 caractere bidirecional (`tests/unit/students.test.ts:20`). 60 code
   smells. Nada corrigido nesta tarefa.
7. Veracode Pipeline Scan (fonte da main + este PR): 14 achados Medium/Low preexistentes — CWE-73 controle externo de
   caminho (`lib/storage/local.ts`, 7), CWE-918 SSRF (`components/ui/product-photo.tsx`, `lib/api-client.ts`,
   `catalog/components/photo-upload.tsx`, `payments/online/mercadopago.ts`), CWE-80 (`product-photo.tsx`,
   `payments/components/online-topup.tsx`), CWE-201 (`payments/online/mercadopago.ts`). Não bloqueiam pelo critério
   (só Very High/High); triagem na etapa seguinte.
