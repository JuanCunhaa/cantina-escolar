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
| Trabalho local (scripts, fixtures, integração local) | 0 | 0 | em andamento |
| P1 artefato/rerun/reconstrução | 12 | — | pendente |
| P2 formas de `needs` | 6 | — | pendente |
| P3 classificação/cancelamento | 3 | — | pendente |
| C comparação dev × compilado (6 execuções) | 80 | — | pendente |
| P4 Veracode | ≤ 20 | — | aguarda credenciais |
| P5 Sonar (análise inicial da main + PR) | 5 | — | aguarda credenciais |
| F execução final do PR | 40 | — | aguarda pré-requisitos |
| **Total** | **166** | **0** | |

Contingências +40 (nova execução final por defeito de infraestrutura) e +11 (rerun de mecanismo) **não autorizadas**.

## 5. Medições locais (sem runner)

- Unit: 327 testes; 5,8 s sem cobertura × 7,7 s com cobertura V8 (Windows, mesma máquina).
- Integração: 416/416 em 725 s sem cobertura (Windows local; no CI a mesma suíte leva 283–423 s).

## 6. Defeitos/intermitências para a etapa seguinte (causa NÃO atribuída)

1. `students.spec.ts:25` — CI da `main` vermelho em `4631bed` (2/2 tentativas).
2. `wallet.spec.ts`, `policies.spec.ts:26`, `shell-photos.spec.ts:139` — falhas intermitentes já registradas (docs/testing/strategy.md).
3. `calendar.spec` na URL publicada (exibição atrasada do dia salvo; ver pendência de listener no PROGRESS).
4. `policies-api.test.ts` A35 "teto SEMANAL" — timeout de 30 s uma vez (F17), não reproduzido isoladamente.
5. Dependências de desenvolvimento: `npm audit` completo aponta 13 vulnerabilidades (11 high, 2 moderate) preexistentes
   na árvore de dev; produção 0.
