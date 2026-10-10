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
| Contêiner (Veracode SAST) | Docker | **Podman rootless** (`podman-docker`) | `scripts/ci/tools/container-user.sh`: em rootless o usuário do host é o root do contêiner (`--user 0:0`); imagem qualificada `docker.io/…@sha256:…` (mesmo digest) |
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
`uidmap`, `zip`; subuid/subgid e `loginctl enable-linger` para o `ghrunner`; `srcclr` fixado; hooks em `/opt/cantina-ci/hooks`
(root, 755); `ACTIONS_RUNNER_HOOK_JOB_STARTED/COMPLETED` e `XDG_RUNTIME_DIR` no `.env` do runner; swap opcional; reinicia o
serviço **somente se não houver job executando**. Verificação: executar o `runner-smoke` (push na branch ou `workflow_dispatch`).

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

- Jobs rodam como `ghrunner`: não é root, não tem sudo (`validate.sh` falha se tiver), não está no grupo `docker` (Podman rootless).
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
- **Fila na máquina própria** (soma e maior): início − momento em que o job ficou pronto (criação ou fim das dependências). A API só
  informa criação→início, que mistura espera por dependência; o coletor lê o grafo `needs` do `ci.yml` da branch padrão (como
  dado). Sem o grafo ou para job fora dele: "indisponível", nunca zero. Job copiado de tentativa anterior não tem fila.
- Colunas **Origem**, **Criação→início** e **Fila do runner** por job. O histórico de execuções equivalentes **inclui a origem na
  chave**: execuções hospedadas (paralelas) e na VPS (seriais) não se misturam nas medianas.
- Cobrança oficial segue indisponível; faturamento não foi alterado.

## Manutenção

- Disco: `df -h /home/ghrunner`; o hook recusa jobs com < 10 GB livres. Imagem do Pipeline Scan e caches ocupam poucos GB.
- Atualização do runner: automática pelo serviço; reiniciar o serviço só ocioso (`./svc.sh stop|start`).
- Atualizar hooks/pacotes: repetir `setup-vps.sh` com os scripts da versão revisada.
- Conferência periódica: `runner-smoke` (workflow_dispatch) — inventário e toolchain, sem suíte.
