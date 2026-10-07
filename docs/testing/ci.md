# CI/CD — desenho, gate, reprodução e FinOps

Workflows: `.github/workflows/ci.yml` (funcional) e `.github/workflows/ci-metrics.yml` (observabilidade, depois do `ci`).
Linha de base, medições e orçamento: docs/status/ci-baseline.md.

## Jobs e dependências

```
changes ─┬─ fast ──────────────┬─ quality ─┐
         ├─ backend ───────────┘           │
         ├─ build ── e2e (g1), e2e (g2) ───┼─ check  (if: always())
         ├─ security, semgrep-appsec ──────┘
```

| Job | Faz | Por que separado |
|---|---|---|
| `changes` | classifica as mudanças (`docs` ou `full`), sem instalar dependências (~15 s) | decide o que roda sem atrasar o resto |
| `fast` | JSON estruturado, actionlint, partição e2e, lint, typecheck, unit (+cobertura) | falha rápida; fora do caminho crítico |
| `backend` | Rules + integração (emuladores), cobertura da integração | caminho crítico (~7 min de integração); mantido agrupado |
| `build` | `npm run build` (Turbopack, como a Vercel) com ambiente hermético, Gitleaks no `.next`, pacote + manifesto | um build por run/tentativa, compartilhado |
| `e2e (g1/g2)` | cada grupo com emuladores, servidor, dados e armazenamento próprios; usa o build compartilhado | divide a etapa mais longa |
| `security` | Gitleaks, `npm audit` (produção), Semgrep registry, Veracode Pipeline Scan e SCA | independente do código compilado |
| `semgrep-appsec` | Semgrep AppSec (transitório até o Veracode ser validado) | precisa do token git só neste job |
| `quality` | LCOV unit+integração mesclado → SonarQube Cloud → Quality Gate efetivo | depende das coberturas |
| `check` | gate final (nome preservado) | sempre roda e decide |

`needs` só onde há dependência real. Integração, Rules e scanners usam o fonte/manifestos, nunca o bundle do Next.
Concorrência: `ci-${{ github.ref }}` com cancelamento — novo push no mesmo PR/ref cancela o anterior; PRs distintos não.

## Modo `docs` (dispensa de aplicação e deploy)

Lista explícita e conservadora (`scripts/ci/classify-changes.ts`): **só** `PROGRESS.md` e `docs/status/*.md`.
Nesse modo rodam `changes`, `fast` (JSON estruturado) e `security` (Gitleaks); os demais ficam `skipped` e o `check`
exige exatamente isso. `docs/tasks/**`, `CLAUDE.md`, `AGENTS.md`, `.claude/**`, `docs/*.json`, workflows, scripts e
configurações exigem o fluxo completo. Diferença entre ÁRVORES, da referência **já validada** até o commit testado,
cobrindo vários commits e merges: no PR, a base do PR; no push, o head do último run **verde** do `ci` naquele ref
(`scripts/ci/reference-sha.ts`) — não o `before`, porque o run do push anterior pode ter sido cancelado pela concorrência
e o código dele ficaria sem validação (achado do probe P3). Sem referência, SHA inexistente, erro ou diff vazio ⇒ `full`.
Mudar a lista é mudança de gate.

**Vercel** (`vercel.json` → `ignoreCommand: node scripts/ci/vercel-ignore.ts`): a mesma classificação entre
`VERCEL_GIT_PREVIOUS_SHA` (último deploy bem-sucedido da branch) e `VERCEL_GIT_COMMIT_SHA`. Código de saída: **0 = ignora
o build/deploy**; **1 = faz o build**. Erro, SHA ausente ou fora do clone raso, ou Node sem suporte a TypeScript ⇒ 1
(build normal). `git.deploymentEnabled` desliga deploy só das branches descartáveis `ci/probe-*`; main e homologação não
mudam. `.vercelignore` não é usado para isso.

## Build compartilhado (manifesto)

- Pacote `build.tar.gz` = `.next/` **sem** `.next/cache/` (cache incremental da compilação) e `.next/trace*` (rastros de
  diagnóstico); todo o resto do `.next` vai. Sem `node_modules` (o consumidor já faz `npm ci` para Playwright e
  firebase-tools), sem fonte (o consumidor tem o checkout do MESMO commit, verificado), sem `.env`, chaves ou logs:
  `pack` recusa nomes proibidos, links simbólicos e conteúdo com chave privada; Gitleaks roda no `.next` antes.
- Artefato `build-<run>-a<tentativa produtora>` (nome único, sem sobrescrita), `retention-days: 1`, `compression-level: 0`.
- `manifest.json`: SHA compilado (no PR é o commit de merge de teste; head e base do PR registrados à parte), run e
  tentativa produtora, Node/npm/Next, SHA-256 do lockfile, `mode: emulator` + ambiente público do build, comando,
  SHA-256/tamanho/arquivos do pacote.
- O consumidor (`verify`) exige o mesmo run, o mesmo SHA do próprio checkout, mesmo `GITHUB_SHA`, lockfile, Node major,
  ambiente hermético e checksum; só então lista (sem `..`/absolutos) e extrai, recusando `.next` pré-existente. O resumo
  do job diz qual artefato foi consumido e de qual tentativa.
- **Reexecução**: reexecutar só um grupo e2e consome o artefato da tentativa produtora original (nome vem de
  `needs.build.outputs`). **Expirado** (1 dia): o download falha com a instrução de reexecutar o job `build`; isso gera
  `build-<run>-a<nova>` do MESMO commit e reexecuta os dependentes. Nunca se usa build de outro push.

## Modo do e2e (medido)

Build Turbopack compartilhado + `next start` foi escolhido pela comparação 3+3 no mesmo commit (docs/status/ci-baseline.md
§4b): custo completo mediano 338 s contra 612 s do `next dev` webpack, menos CPU e memória, 0 falhas contra 1. A comparação
muda modo e bundler ao mesmo tempo; o ganho é da configuração completa. Localmente (Windows) o build é webpack.

## Grupos e2e

Partição em `scripts/ci/e2e-groups.json`, por arquivo/jornada, equilibrada pelos tempos medidos (g1: cadastro e operação;
g2: família e financeiro + diagnóstico de propagação). Um worker por runner, sequência interna preservada. O job lista a
suíte e o grupo com o Playwright e o gate exige executados = listados, sem skip, e g1 + g2 = suíte. Spec novo sem grupo
reprova (`node scripts/ci/e2e-groups.ts verify`). A propagação entre sessões segue diagnóstico **não bloqueante**.

## Gate `check`

`scripts/ci/gate.ts`: para o modo, cada job exigido = `success`, cada dispensado = `skipped`; falha, cancelamento ou skip
indevido reprovam; job sem regra reprova; cada suíte (unit, rules, integration, e2e-g1, e2e-g2) precisa de resumo `ok` do
commit testado (ausente, ilegível, skip, contagem divergente reprovam). Em reexecução vale o resumo mais recente de cada
suíte: grupos já aprovados no mesmo commit continuam válidos; commit novo exige tudo de novo. Credencial ausente nos
scanners reprova o job (nunca aprovação silenciosa). **Gate implementado ≠ exigido pelo GitHub**: a `main` não tem
proteção de branch (docs/status/ci-baseline.md); exigir o `check` depende de configuração/plano do repositório.

## Segurança

- Gitleaks 8.30.1 (SHA-256 fixado), `npm audit --omit=dev --audit-level=high --package-lock-only`.
- Semgrep (registry + AppSec): mantidos até o Veracode ser validado; depois saem num commit próprio.
- **Veracode Pipeline Scan (SAST)**: `git archive` do commit (só `src/`, `package*.json`, `tsconfig.json`,
  `next.config.ts`; sem `.next`, `node_modules`, `.env`, testes) **enviado ao motor remoto da Veracode** para análise; o
  resultado volta ao job e não é publicado na plataforma (sem Upload and Scan, sem importação). Imagem oficial
  `veracode/pipeline-scan:cmd-26.9.0` fixada por digest. Bloqueia: Very High/High; `scan_status` ≠ SUCCESS; relatório ausente.
- **Veracode SCA (agente `srcclr` 3.8.120, `--no-upload`)**: não publica resultados, mas **não é offline** (consulta a base
  da Veracode). Instalação com cadeia de integridade (impressão digital da chave, assinatura do índice, SHA-256 do pacote).
  Bloqueia: CVSS ≥ 7 em pacote da árvore de produção (`npm ls --omit=dev`); lista os de desenvolvimento sem bloquear;
  nenhuma biblioteca identificada ou estrutura desconhecida reprova.
- Limitação documentada pela Veracode: TypeScript até 5 e Node até 22 (o projeto usa TS 6.0.3 e Node 24; React 19 e
  Next 16 constam). Medido no probe P4: 1 módulo analisado, achados em arquivos `.ts`/`.tsx` e as 2 vulnerabilidades
  semeadas (CWE-78/CWE-95, Very High) detectadas — prova esse cenário, não cobertura completa de TS 6. O SCA confere a
  cada execução que pacotes de produção fora do inventário do agente são só opcionais/de outra plataforma.

## Qualidade (SonarQube Cloud, plano Free)

Fonte original (`src`, `scripts`), testes à parte (`tests`), `.d.ts` excluídos, cobertura LCOV real mesclada de **unit +
integração** (`scripts/ci/lcov-merge.ts`: uma entrada por linha/ramo/função, contagens somadas, só arquivos instrumentados).
**Rules não entra** (exercita `firestore.rules` no emulador, sem código de `src/`); **e2e não entra** (servidor em outro
processo, sem instrumentação). O scanner **envia o código-fonte** ao SonarQube Cloud. `sonar.qualitygate.wait=true` e
`scripts/ci/sonar-gate.ts` confirmam o status efetivo do gate (Sonar way, o disponível no plano) depois do processamento.
Análise automática do serviço deve ficar desligada.

## FinOps (`ci-metrics`)

Roda após cada tentativa do `ci` (`workflow_run`), com `actions: read`, `contents: read`, `statuses: read`, código da
branch padrão, checkout esparso, sem npm, sem artefatos/código do PR, sem segredos. Gera resumo no Actions e
`ci-metrics-<run>-a<tentativa>` (JSON + Markdown, 30 dias):

- espera do desenvolvedor (1ª tentativa e final, esta incluindo o intervalo humano entre tentativas, que não é runner);
- minutos brutos (soma das durações com runner), estimativa arredondada por job (não é cobrança) e cobrança oficial =
  **indisponível**; consumo das reexecuções; jobs sem runner à parte;
- por job/tentativa: criação→início (inclui fila; **não separa** fila do runner de espera de dependência), duração,
  etapas, runner (rótulos); artefatos (tamanho, retenção) e transferências (etapas `Artefato:`); status da Vercel separado;
- histórico de execuções equivalentes (mesmo evento e mesmo conjunto de jobs executados): mediana com n ≥ 5, p95 com n ≥ 20;
- consumo do próprio coletor: parcial na execução corrente; total final das execuções anteriores.

Versões de Node/Next ficam no manifesto do build (resumo do job `build`); o coletor não lê artefatos do PR.

## Fluxo para a IA (e para quem desenvolve)

1. Antes do push: `npm run ci:precheck` (JSON, partição e2e, lint, typecheck, unit) + testes afetados
   (`npm run test:integration`/`test:rules` se tocou backend; `npm run test:e2e:group -- g1|g2` se tocou a jornada).
2. Agrupe as correções e faça um push só; cada push em PR roda o fluxo completo (~9 jobs).
3. Status: `npm run ci:status -- --pr <n>` (ou `--run <id>`): jobs, etapa que falhou, teste:linha + erro principal, log
   completo salvo em `.agent-logs/`, artefatos, comando de reprodução e de reexecução.
4. Acompanhar: **uma** chamada limitada, ex. `gh run watch <id> --exit-status --interval 60` com timeout da ferramenta;
   nada de laços/cron/processos periódicos abandonados.
5. Reexecutar **só o job falho no mesmo commit**: `gh run rerun <run> --job <job-id>` (ou `--failed`). Não reexecutar
   para "conseguir verde": falha intermitente é registrada (docs/status/ci-baseline.md §6) e investigada à parte.

| Job | Reproduzir localmente |
|---|---|
| fast | `npm run ci:precheck` |
| backend | `npm run test:rules` e `npm run test:integration` (Java 21) |
| build | `npm run build` (CI/Vercel, Turbopack); nesta máquina Windows: `npm run build:webpack` |
| e2e (gN) | modo dev: `npm run test:e2e:group -- gN`; compilado: `npm run build:webpack` e `$env:E2E_SERVER_MODE='start'; npm run test:e2e:group -- gN` (local usa webpack; o CI usa Turbopack) |
| security | `npm run audit:prod` (Gitleaks/Veracode só no CI) |
| quality | `npm test -- --coverage` (gate só no SonarQube Cloud) |

## Configuração externa (não versionada)

| Serviço | Onde | Nome | Obter em |
|---|---|---|---|
| Veracode | Secrets do repositório (Actions) | `VERACODE_API_ID`, `VERACODE_API_KEY` | Plataforma Veracode → API Credentials de uma conta de serviço com papel mínimo para Pipeline Scan ("Upload API - Submit Only") e licença de Static Analysis |
| Veracode | Secret | `SRCCLR_API_TOKEN` | Veracode SCA → workspace → Agents → criar agente CLI (token do agente) |
| Veracode | Variável do repositório | `VERACODE_REGION` = `commercial` | região da conta (EU/Federal exigem ajuste antes de usar) |
| SonarQube Cloud | Secret | `SONAR_TOKEN` | sonarcloud.io → My Account → Security (token de análise) |
| SonarQube Cloud | Variáveis do repositório | `SONAR_ORGANIZATION`, `SONAR_PROJECT_KEY` | organização ligada ao GitHub e projeto importado (plano Free); **desligar Automatic Analysis** |
| GitHub | Branch protection/ruleset | exigir o check `check` | depende do plano para repositório privado |
| Vercel | Project Settings | confirmar que o Ignored Build Step do painel não conflita (o `vercel.json` prevalece) | painel da Vercel |
