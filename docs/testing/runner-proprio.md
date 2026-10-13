# Runner próprio do CI (cantina-vps-01)

Estado: o CI (`ci`, `ci-metrics`, `runner-smoke`) executa no runner próprio. **Uma única instância**; mais runners só com medição
que justifique (ver "Capacidade"). Desenho dos jobs, gate e FinOps: docs/testing/ci.md.

| Item | Valor |
|---|---|
| Repositório / runner | `JuanCunhaa/cantina-escolar` · `cantina-vps-01` (registrado no repositório, não na organização) |
| Rótulos | `self-hosted`, `linux`, `x64`, `cantina-ci` (`runs-on: [self-hosted, linux, x64, cantina-ci]`) |
| Máquina | Ubuntu 26.04.1 LTS, kernel 7.0, 4 CPUs, ~7,9 GB RAM, sem swap (padrão), ~91 GB livres |
| Usuário / diretório | `ghrunner` (uid 1001, sem sudo e sem grupos extras) · `/home/ghrunner/actions-runner` |
| Fuso da VPS | Europe/Berlin; os workflows fixam `TZ=UTC` (como o hospedado) |

## Quais jobs rodam onde

| Workflow / job | Runner | Motivo |
|---|---|---|
| `ci`: changes, fast, backend (g1, g2), build, e2e (g1, g2), security, quality, check | **próprio** | migração pedida; gates, partições, build compartilhado, artefatos e retenções iguais |
| `ci-metrics` (collect) | **próprio** | só metadados da API; sem segredos da aplicação |
| `runner-smoke` (smoke, toolchain) | **próprio** | valida o próprio runner |
| `listener-diagnostic` (`diagnostico-listener`) | **hospedado** (`ubuntu-latest`) | experimento de homologação sobre o comportamento do listener **no ambiente hospedado**; mudar o ambiente invalidaria a comparação; roda só na branch de diagnóstico, usa segredos da HML (ambiente restrito) e a cota do Firestore da HML está esgotada |

Nada mais permanece hospedado. **Reversão**: trocar `runs-on` de volta para `ubuntu-24.04` (uma linha por job) e restaurar
`cache: npm` e `--with-deps` (histórico do Git); o runner pode ficar parado.

## Diferenças em relação ao Ubuntu hospedado (medidas no smoke)

| Tema | Hospedado (`ubuntu-24.04`) | VPS | Tratamento |
|---|---|---|---|
| Sistema | Ubuntu 24.04 | Ubuntu 26.04.1, **uutils-coreutils** (Rust) no lugar do GNU | `sort -V`, `find`, `sha256sum -c -` verificados (`validate.sh toolchain`); os instaladores com hash fixo funcionam |
| Usuário | `runner` com sudo | `ghrunner` sem sudo | nada no CI usa sudo, exceto `install-srcclr.sh`, agora idempotente e instalado pelo administrador |
| Fuso | UTC | Europe/Berlin | `TZ: UTC` no `env` do workflow |
| Node / Java | `setup-node`/`setup-java` | os mesmos actions (Node 24.21, Temurin 21.0.12 no `_work/_tool`, persistente) | sem mudança |
| npm | `setup-node` com cache do Actions | cache local `~/.npm` persistente | `cache: npm` removido (restauro/salvamento via GitHub deixa de ser necessário) |
| Chromium | `playwright install --with-deps` (apt) | sem sudo | bibliotecas instaladas uma vez pelo administrador; o job só baixa o navegador (`~/.cache/ms-playwright`) |
| Contêiner (Veracode SAST) | Docker | **Docker 29.9** instalado pelo administrador (daemon com privilégio; `ghrunner` no grupo `docker`) | `scripts/ci/tools/container-user.sh` escolhe `--user`: usuário do job em Docker comum (medido: `1001:1001`, arquivos do contêiner pertencem ao `ghrunner`) e `0:0` em runtime rootless; imagem qualificada `docker.io/…@sha256:…` (mesmo digest). **Ver o risco em Segurança** |
| Veracode SCA (`srcclr`) | instalado a cada job (`sudo dpkg`) | instalado uma vez (versão e hash fixados) | `install-srcclr.sh` pula se a versão fixada já existe; sem root/sudo e sem o pacote, reprova com instrução |
| Recursos | 2–4 CPUs | 4 CPUs, 7,9 GB, sem swap | swap de 4 GB opcional (`--swap 4G`); `resource-snapshot.sh` segue gravando os recursos |
| Portas fixas | máquina nova a cada job | máquina compartilhada | `validate.sh` confere 9099, 8080, 4000, 4400, 4500, 9150, 3100; hooks encerram restos |
| Estado entre jobs | nenhum | persistente | hooks de limpeza (abaixo) |
| actionlint | — | rótulo `cantina-ci` desconhecido | `.github/actionlint.yaml` |

## Provisionamento (administrador, uma vez)

Nada disto roda dentro de um job. Copie os scripts **da sua máquina** (não use arquivos de `_work/`, que o job controla) e
execute como administrador:

```bash
ssh ADMIN@VPS 'mkdir -p ~/cantina-ci-setup'
scp -r scripts/ci/runner scripts/ci/tools ADMIN@VPS:~/cantina-ci-setup/
ssh -t ADMIN@VPS 'sudo bash ~/cantina-ci-setup/runner/setup-vps.sh --dry-run --swap 4G'   # mostra o que faria
ssh -t ADMIN@VPS 'sudo bash ~/cantina-ci-setup/runner/setup-vps.sh --swap 4G'
```

`setup-vps.sh` (idempotente): pacotes do Chromium (lista que o Playwright indicou para esta VPS), `podman`, `podman-docker`,
`passt`, `uidmap`, `zip` (o Podman fica pronto como alternativa; a VPS hoje usa o Docker instalado pelo administrador); subuid/subgid e `loginctl enable-linger` para o `ghrunner`; `srcclr` fixado; hooks em `/opt/cantina-ci/hooks`
(root, 755); `ACTIONS_RUNNER_HOOK_JOB_STARTED/COMPLETED` e `XDG_RUNTIME_DIR` no `.env` do runner; swap opcional; reinicia o
serviço **somente se não houver job executando**. Verificação: executar o `runner-smoke` (push na `main` que altere o smoke ou `scripts/ci/runner/**`, ou `workflow_dispatch`).

## Limpeza entre jobs (hooks do runner)

`scripts/ci/runner/hooks/` (instalados em `/opt/cantina-ci/hooks`, de propriedade do root):

- **job-started**: encerra processos de job deixados pelo usuário (java/firebase/node/next/chromium/scanners — poupa o runner e seus
  ancestrais), para contêineres, apaga temporários próprios de `/tmp` por padrão conhecido, esvazia o workspace, apara logs do npm e
  **reprova o job se o disco livre for < 10 GB**.
- **job-completed** (também em job cancelado): mesma limpeza, nunca reprova o job; grava `~/.cantina-ci/last-job-*`.
- **Preservados de propósito**: `~/.npm`, `~/.cache/ms-playwright`, `~/.cache/firebase` (JARs dos emuladores), `_work/_tool`
  (Node/JDK), imagem do Pipeline Scan e o próprio runner. O checkout de cada job é novo (workspace apagado), então um job nunca
  herda `node_modules`, `.next` ou resultados do anterior.

## Segurança e limitações

- Jobs rodam como `ghrunner`: não é root e não tem sudo (`validate.sh` falha se tiver). **Exceção medida (smoke 38017538721): `ghrunner` está no grupo `docker` e o Docker NÃO é rootless** — acesso ao daemon equivale a root na VPS (um job pode montar `/` em um contêiner). É risco aceito pelo dono para o Veracode SAST, não isolamento; o `validate.sh` o mantém como AVISO. Alternativas sem root efetivo, por ordem de esforço: (1) Podman rootless (`podman`, `podman-docker`, `passt`, `uidmap`, `loginctl enable-linger`; `setup-vps.sh` já prepara), com `ghrunner` fora do grupo `docker`; (2) Docker rootless (`dockerd-rootless-setuptool.sh`); (3) deixar só o job `security` em runner hospedado. `container-user.sh` já cobre rootless.
- **Runner persistente executa código de quem puder abrir PR/branch no repositório**, com os segredos do `ci`
  (Veracode, SonarQube Cloud). Aceitável porque o repositório é **privado** e de um dono; condição: sem colaboradores externos e,
  se houver, *Settings → Actions → Fork pull request workflows*: exigir aprovação. Guarda dentro do workflow não protege (o PR
  altera o workflow); só a configuração do repositório protege. Não registrar este runner em repositório público.
- Um job malicioso poderia envenenar caches persistentes (`~/.npm`, `_work/_tool`, `~/.cache`). `npm ci` confere a integridade do
  lockfile; os instaladores de scanners conferem SHA-256; o risco residual (PR de colaborador confiável) é aceito e registrado.
- Hooks são de propriedade do root, mas o `.env` do runner pertence ao `ghrunner`: não é isolamento contra job hostil.
- O Veracode SAST envia o fonte ao motor remoto e o SCA consulta a Veracode (inalterado).

## Capacidade

Uma instância executa **um job por vez**: o que no hospedado era paralelo (backend g1/g2, build, e2e g1/g2, security) passa a ser
serial. O tempo de parede cresce até quase a soma dos tempos dos jobs; a fila aparece no FinOps. **Não criar segundo runner nem
rodar jobs pesados em paralelo na mesma VPS sem medição**: o critério é a fila mediana e a soma/espera medidas no `ci-metrics`
(abaixo) com n ≥ 5 execuções equivalentes.

## FinOps

`ci-metrics` distingue a origem pelo rótulo `self-hosted` de cada job:

- **Soma dos tempos** de todos os runners, e separada por origem: *hospedado* (brutos + estimativa arredondada por job, que
  continua sendo estimativa, não cobrança) e *máquina própria* (tempo medido, **sem arredondamento e sem virar minuto hospedado**).
- **Fila na máquina própria** (soma e maior): início − momento em que o job ficou pronto (criação ou fim das dependências). Medido no
  run 38019996252: o `created_at` do job na API **já é** o instante em que ele ficou pronto (o `e2e` foi criado quando o `build`
  terminou), então criação→início e fila coincidem; o coletor ainda lê o grafo `needs` do `ci.yml` da branch padrão (como dado) como
  conferência independente, e sem o grafo a fila fica "indisponível", nunca zero. Job copiado de tentativa anterior não tem fila.
  A **soma das filas** é soma de esperas que se sobrepõem (vários jobs esperam ao mesmo tempo): não é tempo decorrido.
- Colunas **Origem**, **Criação→início** e **Fila do runner** por job. O histórico de execuções equivalentes **inclui a origem na
  chave**: execuções hospedadas (paralelas) e na VPS (seriais) não se misturam nas medianas.
- Cobrança oficial segue indisponível; faturamento não foi alterado.

## Manutenção

- Disco: `df -h /home/ghrunner`; o hook recusa jobs com < 10 GB livres. Imagem do Pipeline Scan e caches ocupam poucos GB.
- Atualização do runner: automática pelo serviço; reiniciar o serviço só ocioso (`./svc.sh stop|start`).
- Atualizar hooks/pacotes: repetir `setup-vps.sh` com os scripts da versão revisada.
- Conferência periódica: `runner-smoke` (workflow_dispatch) — inventário e toolchain, sem suíte.

## Evidências (PR #36)

**Execução completa** — `ci` 38019996252, commit `390c9c6`, evento `pull_request`, tentativa 1: **success** (10 jobs, gate `check` verde).
Todos os 10 jobs em `[self-hosted, linux, x64, cantina-ci]`; **0 jobs em runner hospedado**.

| Medida | Valor | Natureza |
|---|---|---|
| Duração total (criação do run → fim do `check`) | 35m55s | tempo de parede |
| Soma dos tempos executados (máquina própria) | 35m39s | medido; ocupação do runner de 99,3% (2139 s de 2155 s) |
| Soma das filas por job | 78m59s | soma de esperas **sobrepostas**, não é tempo decorrido |
| Maior fila | 16m34s (`backend (g2)`) | medido |
| Minutos hospedados (GitHub) | 0 jobs | estimativa de arredondamento = 0; consumo/cobrança oficial **indisponível** (API de cobrança sem escopo) |

Por job (duração · fila): changes 13s · 1s; backend g1 8m32s · 1s; fast 2m35s · 8m35s; security 3m06s · 11m11s; build 2m13s · 14m19s;
backend g2 7m35s · 16m34s; e2e g2 4m22s · 7m37s; e2e g1 4m13s · 12m00s; quality 2m35s · 8m39s; check 15s · 2s. Execução: o runner
rodou um job por vez, com 1–2 s entre eles (a espera acima é fila, não execução).

**Comparação com o hospedado** (3 execuções completas verdes, mesmos 10 jobs: 37956346980, 37957400207, 37959552356):
parede 7m14s–7m35s; soma 24,8–26,7 min; estimativa arredondada 31–33 min hospedados por execução. Na VPS: parede ≈ 4,8× maior e
soma ≈ 1,4× maior. Jobs de CPU ficaram ~1,5× mais lentos por job (ex.: backend g1 8m32s × ~5m17s; build 2m13s × ~1m33s); o
`security` empatou (3m06s × ~3m11s, dominado por serviços externos). A causa da lentidão por job **não foi diagnosticada**.
Estas são 3 amostras hospedadas e 1 na VPS: indicam ordem de grandeza, não mediana (a estatística do coletor exige n ≥ 5).

**Primeira execução** (38017730740, commit `ccee68f`): `security` reprovou por minha mudança (a linha da impressão digital
pública da Veracode saiu da linha 8 do `install-srcclr.sh` e a exceção revisada do Gitleaks é por linha — corrigido movendo o
comentário, sem tocar em `.gitleaksignore`); `backend (g1)` reprovou em 2 testes de `amend-api` por corrida de virada do dia (BASE
calculada às 23:5x BRT no carregamento do arquivo, rota às 00:0x BRT): falha do teste, não do runner; nenhum teste, gate,
timeout ou retry foi alterado. Os passos Veracode SAST (Docker) e SCA (`srcclr` pré-instalado) já passaram nessa execução.

**Smoke** (`runner-smoke`): 38015414070 → 38017538721, o último com `smoke` e `toolchain` verdes: Node 24.21, Java 21.0.12,
`npm ci` 38 s, emuladores Auth+Firestore 22 s, Chromium 1 s, Gitleaks/actionlint com SHA-256, contêiner do Pipeline Scan grava
no diretório montado (`--user 1001:1001`, arquivos do `ghrunner`), hooks configurados e executando (processos de job
encerrados: 0; disco livre 86 GB), swap 4 GB. Usuário do job: `ghrunner` (uid 1001); Docker 29.9 funciona nesse usuário.

**`ci-metrics`**: as execuções recentes do `ci-metrics` da `main` (hospedado) **falharam sem iniciar** (0 etapas, sem runner): o
GitHub recusou o job por pagamento/limite de gastos da conta (anotação "recent account payments have failed or your spending limit
needs to be increased"; 9 falhas nas últimas 30 execuções, incluindo as deste PR). É o bloqueio de cobrança que motiva a
migração; faturamento **não** foi alterado. Como `workflow_run` usa a definição da branch padrão, a versão migrada só roda após o
merge; antes disso, o job `metrics` do `runner-smoke` ensaia os mesmos passos na máquina própria. As métricas deste PR foram
geradas com o mesmo coletor (`scripts/ci/metrics/collect.ts --gh`).

**Estado ocioso do runner** (dono do serviço, Docker acessível, nenhum contêiner nem processo de job remanescente, carga): verificado
por `validate.sh base` (função `check_idle`) no `runner-smoke` do HEAD do PR; o resultado está no comentário de fechamento do PR.

