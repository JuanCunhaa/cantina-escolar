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
| `npm run staging:fixtures` | Contas fictícias `@hml.example.test` + catálogo fictício (idempotente; senhas aleatórias só em `.staging-fixtures.<projeto>.local.json`) |
| `npm run staging:dev` | Servidor Next (webpack, porta 3300) conectado ao staging, para prova manual |
| `npm run staging:verify` | Suíte completa (e2e existente + `tests/staging/*`) contra o staging real |
| `npm run staging:cleanup` | Remove contas efêmeras (`@*.example.test` que não sejam fixtures) e seus perfis |
| `npm run staging:selftest` | Ensaio do próprio harness em emuladores (`demo-cantina`); nunca toca a nuvem |

Os scripts de seed/reset dos emuladores (`npm run seed`, `emulators`) **não** foram usados na nuvem (recusam alvo não local).

Fixtures duráveis (`staging:fixtures`): admin, secretaria, cantina, familia-a, familia-b, aluno (login de aluno), semperfil, desativada — todas `@hml.example.test`, sem caixa de correio real; mais 4 produtos fictícios (`demoProducts`) com 3 fotos no R2. Contas efêmeras de cada execução (`@e2e.example.test`, senha fictícia fixa) são apagadas no teardown.

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

## Limites e pendências (não concluir mais do que foi provado)

1. **Servidor publicado (Vercel): NÃO executado.** Rodou-se apenas local conectado aos serviços reais. Pendente para F24: variáveis `APP_ENV=staging`, `R2_*` e credencial Firebase no gerenciador de segredos, domínio nos “Domínios autorizados” do Auth, limite de corpo de 4,5 MB da Vercel × teto de 2 MB do app, WAF/rate limit.
2. **E-mail de redefinição de senha real: não testado** (fixtures sem caixa de correio; a recuperação com conta existente é pulada em staging para não enviar e-mail). O fluxo com e-mail desconhecido (mensagem genérica) rodou. Requer um endereço do dono.
3. **Auto-cadastro público do Auth não foi desabilitado** (Console → Authentication → Configurações → ações do usuário). Mitigado: conta sem perfil não acessa nada (e2e e Rules acima). Convite usa o Admin SDK e não depende dessa opção.
4. **Primeiro administrador real e bootstrap**: aqui o admin é fixture criada pelo Admin SDK; script de bootstrap segue em F24.
5. **R2**: ausência de `r2.dev`/domínio público ainda precisa ser conferida no painel (o endpoint S3 anônimo foi negado); checksum padrão do SDK não testado. Credencial R2 usada passou pelo chat em etapa anterior: rotacionar após a homologação.
6. **Concorrência**: 1 execução de 12 escritores (4,2 s, 0 falhas) no Firestore real; não prova capacidade maior nem substitui medição com a carteira (F08).
7. **Dados de teste persistem** no projeto HML (turmas, alunos, vínculos, convites, `auditLog`, `foundationProbes`); só contas efêmeras e fotos enviadas são removidas. Sem scripts de reset da nuvem por segurança; apagar o projeto/coleções é decisão manual.
8. Limites conhecidos mantidos (F03): “sair de todos os dispositivos” não derruba na hora listeners de outra aba com ID token vigente (≤ 1 h); desativar a conta sim.
9. Backup/PITR/restauração, quotas do plano Spark e monitoramento: não avaliados. Gitleaks/Semgrep: não executados.
10. A recuperação de senha e login com contas efêmeras usam a senha fictícia fixa `senha-fake-123`: aceitável só neste projeto exclusivo e pelo tempo da execução (apagadas no teardown).

## Reproduzir

```
# uma vez: .env.staging.local (ver .env.staging.example) + chave da conta de serviço em .secrets/
npm run staging:preflight
npm run staging:deploy      # só se firebase/firestore.rules ou índices mudarem
npm run staging:verify      # cria fixtures, roda 28 testes, remove contas efêmeras
npm run staging:selftest    # ensaio local sem nuvem
```

Logs locais (ignorados pelo Git): `.agent-logs/staging-real-1.log` (falha corrigida), `.agent-logs/staging-real-2.log` (28/28), `.agent-logs/staging-selftest-2.log`.
