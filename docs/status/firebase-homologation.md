# Homologação integrada (Firebase real + Cloudflare R2) — F01–F05

Data: 01/10/2026. Escopo: funcionalidades existentes até F05, rodando **localmente** (`next dev --webpack`, porta 3300) contra serviços **reais** de homologação. Não é validação em servidor publicado (Vercel): ver "Pendências". F06 não foi iniciada.

## Destinos (confirmados antes de qualquer alteração)

| Item | Valor |
| --- | --- |
| Projeto Firebase | `cantina-escolar-hml` (criado em 01/10/2026 para esta etapa; exclusivo de homologação; plano Spark, **sem faturamento**) |
| App web | `1:176046749647:web:772de5239b4c01b4f144ba` |
| Firestore | banco `(default)`, `southamerica-east1`, regras e índices de `firebase/` publicados |
| Auth | provedor e-mail/senha habilitado; nenhum outro |
| Firebase Storage | **não habilitado** (arquivos ficam no R2) |
| Bucket R2 | `cantina-fotos-staging` (privado), conta conferida por hash; a mesma credencial restrita ao bucket usada pelos testes `R2_TEST_*` |
| Não usados | `cantina-claude` (projeto do `.env` local, sem “staging” no nome — **não** foi tocado; o app o recusa em `APP_ENV=staging`), produção, dados da escola |

Preflight read-only antes da validação: Auth com 0 usuários, bucket vazio, login e-mail/senha respondendo (`INVALID_LOGIN_CREDENTIALS` para conta inexistente), Firestore real negando leitura anônima (403 em `users`, `students`, `settings`).

## O que foi configurado (e como)

Comandos executados com o login do desenvolvedor no `firebase` CLI (nenhuma credencial passou pelo chat):

```
firebase projects:create cantina-escolar-hml --display-name "Cantina Escolar HML"
firebase apps:create web "Cantina HML Web" --project cantina-escolar-hml
firebase deploy --only firestore --project cantina-escolar-hml     # 1ª tentativa habilitou a API; 403 de propagação
firebase firestore:databases:create "(default)" --location southamerica-east1 --project cantina-escolar-hml
firebase deploy --only firestore --project cantina-escolar-hml     # regras + índices (vazio: nenhuma consulta exige índice composto)
firebase deploy --only auth --config <json temporário com auth.providers.emailPassword=true>   # arquivo removido depois
```

Ações **manuais do dono**: gerar a chave da conta de serviço (Console → Contas de serviço) e salvá-la em `.secrets/` (ignorado pelo Git). A chave não pode ser criada pela CLI.

Configuração local independente (nada disso toca o `.env` nem o modo emulador):

- `.env.staging.local` (ignorado pelo Git; modelo em `.env.staging.example`): config web pública do projeto, `FIREBASE_SERVICE_ACCOUNT_FILE` e `R2_*` da aplicação (copiados dos `R2_TEST_*` sem imprimir). Nenhum valor secreto foi impresso nem versionado.
- `scripts/staging/target.ts` valida tudo antes de subir qualquer coisa: lê **só** `.env.staging.local`; `STAGING_CONFIRM_PROJECT` precisa repetir o ID do projeto; a conta de serviço precisa pertencer ao mesmo projeto; só o bucket `cantina-fotos-staging` é aceito; mesmas validações fechadas do app. O launcher envia em branco todo nome presente nos `.env*` do desenvolvedor (o Next descarta variáveis vazias), então o `.env` fica inerte no servidor de homologação.
- `src/lib/env.ts` (endurecimento): em `APP_ENV=staging` o `FIREBASE_PROJECT_ID` precisa conter `staging|homolog|hml|test` e em `production` não pode conter (mesma regra do bucket); variável de emulador em branco vale como ausente. Testes unitários em `tests/unit/env.test.ts`.

Comandos (`package.json`):

| Comando | O que faz |
| --- | --- |
| `npm run staging:preflight` | Somente leitura: destino, Auth, Firestore, login e-mail/senha e R2 |
| `npm run staging:deploy` | Publica regras/índices do Firestore no projeto confirmado (login do CLI) |
| `npm run staging:fixtures` | Contas fictícias `@hml.example.test` (idempotente; senhas aleatórias só em `.staging-fixtures.<projeto>.local.json`). Desde a F06 o catálogo fictício é garantido no `verify` pelas rotas do app (ver abaixo) |
| `npm run staging:dev` | Servidor Next (webpack, porta 3300) conectado ao staging, para prova manual |
| `npm run staging:verify` | Suíte completa (e2e existente + `tests/staging/*`) contra o staging real |
| `npm run staging:cleanup` | Remove contas efêmeras (`@*.example.test` que não sejam fixtures) e seus perfis |
| `npm run staging:selftest` | Ensaio do próprio harness em emuladores (`demo-cantina`); nunca toca a nuvem |

Os scripts de seed/reset dos emuladores (`npm run seed`, `emulators`) **não** foram usados na nuvem (recusam alvo não local).

Fixtures duráveis (`staging:fixtures`): admin, secretaria, cantina, familia-a, familia-b, aluno (login de aluno), semperfil, desativada — todas `@hml.example.test`, sem caixa de correio real; mais 4 produtos fictícios (`demoProducts`) com 3 fotos no R2 (até a F05). **Desde a F06 (02/10/2026)**: o catálogo de exemplo — turnos `Manhã/Tarde (exemplo)`, 3 categorias e 5 produtos `(exemplo)` (3 com foto, 1 só de balcão sem foto, 1 desativado) — é garantido pelo `global-setup` do `verify` através das rotas autorizadas do app com a fixture `admin` (`tests/helpers/catalog-fixtures.ts`): só cria o que falta, reativa/desativa e envia foto ausente; nunca reseta por Admin SDK nem grava direto no R2. Os testes não alteram esses produtos; quem precisa mudar foto/preço/situação cria um produto temporário (sufixo aleatório) pela API e o deixa desativado. Consequência: cada `verify` deixa alguns produtos/categorias temporários **desativados/arquivados** (nada é apagado, por regra do produto). Contas efêmeras de cada execução (`@e2e.example.test`, senha fictícia fixa) são apagadas no teardown.

## Resultado

`npm run staging:verify` (execução final, após a última mudança de código): **28 passaram, 0 falharam, 4,7 min**; teardown removeu 33 contas efêmeras. Ensaio equivalente em emulador (`staging:selftest`): 27 passaram + 1 pulado (bucket anônimo, só existe no R2 real).

Uma primeira execução real falhou (10 falhas, todas `400 invalid_input`): causa única — o Next entrega ao servidor as variáveis vazias de emulador que o launcher enviava para neutralizar o `.env`, e a validação do app recusava `""`. Corrigido em `src/lib/env.ts` (branco = ausente) com teste; reexecução completa passou. Nenhuma proteção foi enfraquecida (a recusa de emulador com credencial e de emulador em staging/production continua).

### O que foi validado pelo fluxo real

| Requisito | Evidência (serviços reais) |
| --- | --- |
| Login, logout, papéis | e2e `access.spec.ts`: mensagens genéricas, login por papel, sem perfil → “Acesso ainda não liberado” e logout, aluno não alcança a operação, “Sair de todos os dispositivos” revoga o token (401 depois) |
| Isolamento entre famílias | `isolation.spec.ts`: REST com ID token real nas Rules **publicadas** — família A lê o próprio aluno/política/vínculo/perfil e recebe 403 para os da família B (documento e listagens), sem login 403, 6 escritas de cliente negadas (aluno, política, papel, vínculo alheio, escola, saldo); rotas administrativas/diretório 403 para a família e 401 sem token (10 rotas); política de aluno alheio 403 e do próprio 200 |
| Conta desativada | e2e `access.spec.ts` (revogação ao vivo: rebaixar/devolver/desativar encerra a sessão e o login informa o motivo) + `isolation.spec.ts` (token vigente → 401, Rules fecham, novo login não reabre) + `photos-r2.spec.ts` (perfil desativado → 403 `account_inactive`) |
| Vínculo revogado | `isolation.spec.ts`: após revogar, o mesmo token perde leitura de aluno/política (403) e a política por rota (403); o outro responsável não é afetado |
| Cadastros, convites, calendário | e2e `students.spec.ts` (turmas/turnos/alunos/importação CSV; convite de uso único com conta criada de verdade; perfis sem permissão), `calendar.spec.ts`, `isolation.spec.ts` (convite criado/resgatado/reuso 422, token ausente na listagem; settings + janela de compra) |
| Consultas, índices, listeners | busca por prefixo e por matrícula, paginação por cursor, ficha administrativa e janela do calendário sem pedir índice composto (`indexes: []` basta); listeners de perfil, vínculos e saldo de prova nos e2e; `foundation.spec.ts` |
| Comandos transacionais | `transactions.spec.ts` (prova de fundação): idempotência (mesma chave → mesmo resultado; payload diferente → 409), 12 escritores no mesmo documento: 12×200, saldo conservado, 12 lançamentos no livro, 4,2 s; cliente não escreve saldo (403) |
| Upload/leitura de fotos pelo app com R2 | `photos-r2.spec.ts` + `shell-photos.spec.ts`: cantina envia PNG → objeto no R2 (HEAD: tipo e tamanho), leitura por família devolve os mesmos bytes com `nosniff`/`private`/ETag e 304, troca remove a foto anterior (nova chave), cardápio mostra 3 fotos + 1 fallback via blob autenticado |
| Rejeições | sem token/token inválido 401; responsável e conta sem perfil 403; perfil desativado 403; texto, SVG com script, PNG truncado, corpo vazio, tipo divergente, > 2 MB, sem `productId`, path traversal e produto inexistente recusados (400/404/413/415/422) e **a listagem do bucket ficou idêntica**; endpoint S3 anônimo e listagem anônima do bucket → 4xx sem imagem |

Estado final conferido por consulta direta: Auth só com as 8 fixtures; R2 só com as 3 fotos de demonstração (fotos enviadas pelos testes removidas).

## Homologação publicada (Vercel) — 01/10/2026

| Item | Valor |
| --- | --- |
| Repositório | https://github.com/JuanCunhaa/cantina-escolar (privado; histórico local enviado após Gitleaks local em histórico e árvore: 0 achados) |
| CI | GitHub Actions `ci` — run 36954778551 (commit `561c8ff`) verde: lint, typecheck, unit 89, rules 24, integration 101, e2e 17, build padrão (Turbopack), audit:prod 0, Gitleaks v8.30.1 0, Semgrep 1.179.0 0 |
| Projeto Vercel | `cantina-escolar-hml` (time pessoal, plano **Hobby**, sem domínio próprio), ligado ao repositório; branch de produção `main`; região de Functions `gru1` (São Paulo, perto do Firestore `southamerica-east1`); Node 24.x |
| URL | https://cantina-escolar-hml.vercel.app (alias de produção do projeto de homologação) |
| Proteção | Vercel Authentication em **All Deployments** (produção, branch e deployment URLs exigem login Vercel com acesso ao time; anônimo → 302). Senha por deployment não existe no Hobby. "Protection Bypass for Automation" criado só para a suíte; segredo em `.secrets/vercel-hml-bypass.txt` (ignorado) |
| Variáveis | 15 variáveis em **Production e Preview** (Development vazio): `APP_ENV=staging`, `FIREBASE_PROJECT_ID`/`NEXT_PUBLIC_*` = `cantina-escolar-hml`, `R2_BUCKET=cantina-fotos-staging`, credenciais (`FIREBASE_PRIVATE_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) como *Sensitive*; enviadas pela API da Vercel a partir de `.env.staging.local` sem impressão. Nada commitado |

Por que “Production” da Vercel não alcança a escola: este projeto só contém valores de homologação; o build roda com `NODE_ENV=production`, mas o app decide pelo `APP_ENV=staging`, e `src/lib/env.ts`/`src/lib/storage/config.ts` recusam em staging projeto Firebase ou bucket sem `staging|homolog|hml|test` no nome. Produção real exigirá **outro** projeto Vercel.

Diferença de ambiente encontrada e corrigida: no 1º deploy toda rota com Admin SDK respondia 500 (`ERR_REQUIRE_ESM` ao carregar `firebase-admin/auth`: `jwks-rsa@4` faz `require('jose')` e o jose 6 é só ESM; local em dev não aparece). Correção: override `jwks-rsa>jose` 5.10.0 + teste `tests/unit/runtime-compat.test.ts` (detalhes em docs/status/dependency-audit.md). Também corrigidos 3 achados do Semgrep (`unsafe-formatstring` em `console.error`).

Validação pela URL publicada: `npm run staging:verify:published` (mesma suíte de 28 testes do item anterior; harness com `STAGING_PUBLISHED_URL` restrita a `https://cantina-escolar-hml*.vercel.app`, sem servidor local; o bypass vira cookie do host, nunca vai a Google/Cloudflare): **28 passaram, 0 falharam, 5,5 min**, teardown removeu 33 contas efêmeras; o setup confirmou antes que o acesso anônimo é bloqueado (302). Cobre login/logout e papéis, isolamento e Rules publicadas, conta desativada e vínculo revogado, cadastros/convites, calendário, consultas e listeners, comandos transacionais (12 escritores) e upload/leitura/troca/rejeições de fotos no R2. Logs de runtime da Vercel durante a execução: nenhum 5xx. Log local: `.agent-logs/staging-published-1.log`.

## Limites e pendências (não concluir mais do que foi provado)

1. **Servidor publicado (Vercel): executado em 01/10/2026** — ver “Homologação publicada (Vercel)” abaixo. Continuam pendentes para F24: projeto/variáveis de produção, WAF/rate limit, plano Vercel adequado ao uso comercial. Domínio nos “Domínios autorizados” do Auth não é necessário hoje (o app não usa `continueUrl`, popup nem redirect).
2. **E-mail de redefinição de senha real: não testado** (fixtures sem caixa de correio; a recuperação com conta existente é pulada em staging para não enviar e-mail). O fluxo com e-mail desconhecido (mensagem genérica) rodou. Requer um endereço do dono.
3. **Auto-cadastro público do Auth não foi desabilitado** (Console → Authentication → Configurações → ações do usuário). Mitigado: conta sem perfil não acessa nada (e2e e Rules acima). Convite usa o Admin SDK e não depende dessa opção.
4. **Primeiro administrador real e bootstrap**: aqui o admin é fixture criada pelo Admin SDK; script de bootstrap segue em F24.
5. **R2**: ausência de `r2.dev`/domínio público ainda precisa ser conferida no painel (o endpoint S3 anônimo foi negado); checksum padrão do SDK não testado. Credencial R2 usada passou pelo chat em etapa anterior: rotacionar após a homologação.
6. **Concorrência**: 1 execução de 12 escritores (4,2 s, 0 falhas) no Firestore real; não prova capacidade maior nem substitui medição com a carteira (F08).
7. **Dados de teste persistem** no projeto HML (turmas, alunos, vínculos, convites, `auditLog`, `foundationProbes`); só contas efêmeras e fotos enviadas são removidas. Sem scripts de reset da nuvem por segurança; apagar o projeto/coleções é decisão manual.
8. Limites conhecidos mantidos (F03): “sair de todos os dispositivos” não derruba na hora listeners de outra aba com ID token vigente (≤ 1 h); desativar a conta sim.
9. Backup/PITR/restauração, quotas do plano Spark e monitoramento: não avaliados. Gitleaks/Semgrep: executados no CI do GitHub em 01/10/2026 (0 achados após correção).
10. A recuperação de senha e login com contas efêmeras usam a senha fictícia fixa `senha-fake-123`: aceitável só neste projeto exclusivo e pelo tempo da execução (apagadas no teardown).

## Reproduzir

```
# uma vez: .env.staging.local (ver .env.staging.example) + chave da conta de serviço em .secrets/
npm run staging:preflight
npm run staging:deploy      # só se firebase/firestore.rules ou índices mudarem
npm run staging:verify      # cria fixtures, roda 28 testes, remove contas efêmeras
npm run staging:verify:published   # mesma suíte contra https://cantina-escolar-hml.vercel.app (ou STAGING_PUBLISHED_URL)
npm run staging:selftest    # ensaio local sem nuvem
```

Logs locais (ignorados pelo Git): `.agent-logs/staging-real-1.log` (falha corrigida), `.agent-logs/staging-real-2.log` (28/28), `.agent-logs/staging-selftest-2.log`.

## F13 — índices publicados e smoke (04/10/2026)

- `npm run staging:deploy` (expandir antes de mesclar): Rules INALTERADAS ("already up to date") e índice composto novo `orders (status asc, consumptionDate asc)` publicado no `cantina-escolar-hml`; compatível com a main publicada (a main não o consulta). O CLI não mostra o estado do índice: o smoke abaixo consulta `status in [...]` + `consumptionDate <` no Firestore real, o que só responde 200 com o índice pronto.
- `tests/staging/fulfillment-smoke.spec.ts` (servidor local + Firestore HML): 1ª execução FALHOU em `GET /api/operations/preparation?shiftId=…` — `shiftId ==` + intervalo de `consumptionDate` pede composto que o emulador não cobra. A consulta de previsão passou a filtrar o turno em memória (sem índice novo); 2ª execução 5/5 (`.agent-logs/f13-staging-hml-local-2.log`). Sem pedido, saldo ou crédito criados; contas efêmeras removidas.

## F14 — smoke de cancelamento (04/10/2026)

- Rules e índices INALTERADOS (nada a publicar; `orders/{id}/cancellations` é coberto pelo default-deny e as consultas novas são de campo único ou já indexadas). Ensaio em emuladores: `staging:verify --emulator` dos smokes de cancelamento e entrega 10/10 (`.agent-logs/f14-staging-selftest.log`).
- `tests/staging/cancellation-smoke.spec.ts` (servidor local + Firestore HML `cantina-escolar-hml`): 5/5 (`.agent-logs/f14-staging-hml-local-1.log`): autorização (401/403/404), validação do corpo (valor/aluno recusados), `cancel_refund` e `reschedule` em pedido inexistente, aba Cancelados e extrato vazios (200), Rules fechadas. Sem pedido, saldo ou crédito criados; sem pagamento real. NÃO prova reembolso, liberação de reserva/cota/uso, prazo, descarte nem corridas no Firestore real. Validação pela URL publicada: após o merge, registrada no PR.

## F15 — smoke do PDV e venda direta (05/10/2026)

- Rules e índices INALTERADOS (nada a publicar): `directSales` e o pedido de balcão são cobertos pelo default-deny; as consultas novas são de campo único, duas igualdades (exceções `status`+`consumptionDate`) ou já usadas. O Firestore real confirmou que nenhuma pede índice composto.
- `tests/staging/pos-smoke.spec.ts` (6 testes), ensaiado em emuladores (6/6, `.agent-logs/f15-staging-pos-selftest-2.log`), em servidor local × Firestore HML `cantina-escolar-hml` (6/6, `.agent-logs/f15-staging-hml-local-1.log`) e na URL publicada da Vercel após o deployment de produção do merge `ffc4f57` (6/6, `.agent-logs/f15-staging-published-1.log`; proteção ativa confirmada: anônimo 302).
- Suíte completa contra a URL publicada (`staging:verify:published`, 05/10/2026): 84 passaram, 0 falharam, 8,0 min; teardown removeu 104 contas efêmeras (`.agent-logs/f15-staging-published-full.log`).
- O que o smoke comprova na nuvem: papéis (401/403/200), lista de alunos ativos com turma/turno, aluno com saldo/restrições, cardápio do balcão com estoque e sem custo, ordem das recusas da venda com saldo (nada gravado), VENDA DIRETA real (produto fictício próprio com entrada própria; replay; estoque 20 → 18; reconciliação fecha; carteira e pedidos intocados), Rules e a tela. Dados da HML desta tarefa (fictícios): família/aluno e produto temporário (desativado ao fim), exceção de calendário de hoje aberta e removida pelo próprio teste, política de balcão do aluno fictício ligada pelo responsável fictício.
- NÃO comprovado na nuvem (continua só no emulador): venda com saldo (débito + livro + baixa + entregue), limite com consumo comprometido, concorrência (PDV × checkout × entrega) e disputas por saldo/último estoque — a HML segue sem saldo (nenhum crédito artificial; recarga real só em F17–F19).

## F16 — smoke de reagendamento e troca (05/10/2026)

- `tests/staging/amend-smoke.spec.ts` (6 testes) e `tests/staging/cancellation-smoke.spec.ts` atualizado (a resolução `reschedule` passou a exigir destino), ensaiados em emuladores (11/11, `.agent-logs/f16-staging-selftest.log`) e em servidor local × Firestore HML `cantina-escolar-hml` (preflight OK; 11/11, `.agent-logs/f16-staging-hml-local-1.log`). URL publicada: após o deployment de produção do merge, ver o PR.
- Rules e índices INALTERADOS (nada a publicar): `orders/{id}/reschedules`, `orders/{id}/exchanges` e o lançamento `order_exchange` são cobertos pelo default-deny; as leituras novas são por ID ou consultas já existentes (extrato por tipo, cardápio).
- O que o smoke comprova na nuvem: 401 anônimo; 403 do responsável nas quatro rotas novas (inclusive com `overrideCutoff`); 404 de pedido inexistente para cantina e administração (reagendar, trocar, prévia, opções); validação (motivo, destino, diferença confirmada obrigatória, campos de valor recusados); resolução `reschedule` só da administração e com destino; extrato filtrado por `order_exchange` vazio (200); Rules fechadas ao cliente.
- NÃO comprovado na nuvem (só emulador): reagendamento e troca com pedido e saldo (liberação/reserva no destino, cota, limites, diferença cobrada/devolvida), replay e corridas — a HML segue sem saldo nem pedido (sem crédito artificial).

## F17 — recarga manual com recebimentos SIMULADOS (05/10/2026)

- `npm run staging:preflight` OK e `npm run staging:deploy` (expandir antes de mesclar): Rules INALTERADAS ("already up to date"); índice composto novo `topups (studentId asc, createdAt desc)` publicado no `cantina-escolar-hml`; a main publicada não o consulta.
- `tests/staging/topups-hml.spec.ts` (8 testes) ensaiado em emuladores (8/8, `.agent-logs/f17-staging-selftest-2.log`). Usa SÓ o fluxo normal da aplicação: secretaria fictícia registra recebimentos simulados (Pix R$ 50 com taxa R$ 1,50; cartão de débito R$ 10; dinheiro R$ 5), referência `HML-TESTE-…` e observação "TESTE HML (recebimento simulado, sem dinheiro)"; nenhum dinheiro transferido, nenhum provedor, nenhum saldo/pedido gravado pelo Admin SDK (o Admin só lê `auditLog`). Os movimentos ficam na HML para auditoria; os produtos temporários são desativados e as contas efêmeras removidas no teardown.
- Resultado na URL publicada (05/10/2026, depois do deployment de produção da Vercel do merge `46fa443` do PR #22; proteção ativa confirmada — anônimo 302, bypass por cookie do host): **8/8** em 57,5 s (`npm run staging:verify:published -- tests/staging/topups-hml.spec.ts`, log `.agent-logs/f17-staging-published-1.log`; teardown removeu 5 contas efêmeras). Integração com os serviços reais (Auth, Firestore, Rules, índice novo, Vercel) usando recebimentos SIMULADOS:
  - recarga Pix R$ 50 com taxa R$ 1,50 → crédito R$ 50, líquido R$ 48,50, auditoria `topup.manual.register` lida; replay devolve o mesmo comprovante; a mesma referência com outra chave/grafia = 409; cartão de débito com liquidação `pending` e taxa pendente; dinheiro `cash_on_hand`;
  - autorização na nuvem (responsável/cantina 403, anônimo 401, secretaria sem `topup.reverse` 403, secretaria sem estoque/custos) e Rules publicadas fechando `topups` (família, secretaria e administração 403) com o lançamento legível pela família vinculada;
  - transferência COM SALDO (R$ 10 entre irmãos), checkout antecipado com saldo (2 un., reserva no estoque), reagendamento pela cantina (sem lançamento), troca com diferença +R$ 1,50, cancelamento total pela família com reembolso de R$ 8,50 e reservas liberadas, estorno parcial de R$ 15 com permissão separada (novo movimento; segundo estorno com a mesma visão = 409 `stale_topup`; acima do saldo = 409) — reconciliação carteira × livro OK a cada passo; consulta pelo índice `topups (studentId, createdAt)` respondeu; tela publicada da secretaria (conferência do dia e comprovante sem botão de estorno).
- Releitura independente SOMENTE LEITURA (Admin, `.agent-logs/f17-hml-readback.log`): 3 recargas de teste persistidas (`tpm_e870451e3c990ea29d4c` Pix 5000/creditado 5000/líquido 4850/estornado 1500/`partially_reversed`; `tpm_a7a1fc2fe6c7b5e804e4` cartão 1000 `pending`; `tpm_d7319d8f84a5ed4b5729` dinheiro 500); carteiras `stu_31afdaff4ebb3047f835` (topup +5000, transfer_out −1000, advance_purchase −700, order_exchange −150, order_refund +850, topup_reversal −1500 → 2500, versão 6) e `stu_2e9e37028c024570b2cf` (topup +1000, topup +500, transfer_in +1000 → 2500, versão 3), ambas reconciliadas. Movimentos preservados na HML para auditoria.
- NÃO comprovado: pagamento real (nenhum Pix/cartão/provedor; os recebimentos são simulados), concorrência e latência em escala no Firestore real (as disputas seguem provadas só no emulador).

## F18 — recarga online (06/10/2026)

- `npm run staging:preflight` OK e `npm run staging:deploy` antes do merge: Rules INALTERADAS ("already up to date"); índices compostos novos `topupIntents (studentId asc, createdAt desc)` e `(studentId asc, status asc)` publicados no `cantina-escolar-hml` (só acréscimo; a main publicada não os consulta).
- A HML NÃO tem provedor de pagamento configurado (nenhum escolhido/aprovado; `PAYMENTS_*_PROVIDER` ausentes): a recarga online fica indisponível, por desenho.
- `tests/staging/online-topup-smoke.spec.ts` (4): ensaio no emulador 4/4 (`.agent-logs/f18-staging-selftest-1.log`). Servidor local × Firestore HML: 1ª e 2ª execuções falharam SÓ na consulta do histórico (500) — causa verificada por consulta somente leitura: `FAILED_PRECONDITION … index is currently building`; o índice ficou pronto ~90 s depois e a 3ª execução passou **4/4** (`.agent-logs/f18-staging-hml-local-3.log`): configuração sem meio disponível, criação 503 `payment_unavailable` (Pix e cartão) sem gravar, histórico vazio pelo índice novo, 400 para parcelas/número de cartão/valor fracionado, 403 outra família, 404 intenção inexistente, Rules fechando `topupIntents`, tela sem formulário nem botão de simular.
- NÃO comprovado: criação de cobrança, QR, cartão e conciliação com provedor real (sem provedor aprovado, sem sandbox). Resultado na URL publicada: registrado no PR após o deployment do merge.
