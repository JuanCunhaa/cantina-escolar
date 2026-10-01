# Estado do desenvolvimento

Data de referência: 30/09/2026. Este arquivo descreve código entregue, não apenas intenção.

## Concluído
- F01 — fundação técnica e prova de isolamento (escopo implementado; critérios A32–A35 seguem parciais).
- F02 — shell visual, navegação por papel e fotos (escopo implementado; A36/A37 parciais).
- F03 — autenticação, papéis e autorização (escopo implementado; A02/A08/A30/A33/A34 parciais, ver abaixo).

## Em andamento
- Nenhuma. Próxima tarefa elegível: F04 (alunos, responsáveis, vínculos e convites; depende de F03). F06 também está liberada (F02+F03). A carteira real é F08 (depende de F04).

## Fechamento pós-F03 (01/10/2026)
- Dependências: `audit:prod` agora 0 vulnerabilidades. Sem correção dentro dos intervalos nem na dependência responsável (firebase/@firebase/firestore, @google-cloud/storage e firebase-admin já são as últimas; limites `~1.9.0` e `gaxios ^6`). Aplicados dois overrides mínimos e escopados em package.json (`@firebase/firestore>@grpc/grpc-js` 1.14.5; `@google-cloud/storage>gaxios>uuid` 11.1.1); sem downgrade nem `audit fix --force`. IDs conferidos: m9gg (alta) e f596 (baixa) só de servidor gRPC; **99f4 (cliente e servidor) não afetava** (cópias já em 1.9.16/1.14.5, por isso fora do audit) — dependency-audit.md corrigido. Compatibilidade: suíte completa verde (abaixo) + multipart real do gaxios com uuid 11.1.1. Remover os overrides quando o upstream subir os intervalos.
- Transaction lock timeout (cantina-debug): reproduzido sem código do repositório — duas transações leitura→escrita no mesmo documento sempre deadlockam (promoção do lock) e cada impasse custa um lock timeout do emulador (~3,4 s; 2 concorrentes ≈ 3,0–3,8 s; serial ≈ 50 ms); o padrão de 5 tentativas do SDK falhou com 12 escritores (2 de 12 falharam numa rodada; 24 escritores: 13 e 9 falhas) com o erro "10 ABORTED: Transaction lock timeout". Correção: `COMMAND_TRANSACTION` (maxAttempts 10, src/lib/firebase/transaction-options.ts) nos comandos transacionais; teste n=12 intacto (só timeout próprio de 90 s). Validação dirigida do comando real: 12 escritores ×10 rodadas e 24 ×5, 0 falhas, saldo conservado, máx. 6 tentativas, 4–27 s. Limitação: produção não medida; capacidade testada 12 escritores/documento; cada disputa custa segundos no emulador.
- Validação única pós-mudança: typecheck 0; lint 0; unit 34/34; rules 26/26; integration 46/46; e2e 12/12; build:webpack 0; audit:prod 0 vulnerabilidades.

## F03 — resumo
- Entregue: papéis em `users/{uid}` (guardian, student, cantina, secretaria, admin; status active/disabled; permissão extra `topup.reverse` só da secretaria) como fonte atual para servidor, Firestore Rules e Storage Rules (claim abandonada). `requireActor` (token + revogação + perfil atual), `authorize`/`can` (capacidades), `authorizeStudent`/`decideStudentAction` (vínculo e política atuais, também em transação), `setUserAccess` (POST /api/admin/users, só admin; idempotente, auditado, guarda do último admin, perfil do ator relido na transação), `POST /api/session/revoke` ("Sair de todos os dispositivos"), `auditLog` mínimo append-only, Rules para users/students/guardianStudentLinks/studentPolicies, login + recuperação de senha (mensagens genéricas), sessão com perfil ao vivo, tela "Acesso ainda não liberado", aviso de acesso encerrado.
- Validação (emulador `demo-cantina`): typecheck 0; lint 0; unit 34/34; rules 26/26; integration 46/46; e2e 12/12; build:webpack 0. Capturas 375 px inspecionadas (sem rolagem horizontal).
- Comportamento após remoção de permissão/revogação (formal, testado): papel rebaixado → 403 na próxima chamada com o mesmo token; conta desativada → 401 no servidor, Rules fechadas na hora, sessão local encerrada com aviso, reativar exige novo login; vínculo revogado → negado na hora (servidor e Rules); perfil ausente/malformado → sem acesso. Limite: "sair de todos os dispositivos" não derruba na hora listeners de outra aba com ID token vigente (≤ 1 h) — desativar a conta sim.
- Decisões: docs/decisions.md ("Decisões de F03"); contrato de campos em docs/firebase/schema.md ("Campos de acesso (F03)"); detalhes em docs/status/history.md.
- Skills invocadas via ferramenta Skill: cantina-token-economy, cantina-testing, cantina-firebase, cantina-ui, cantina-security, cantina-verify.

## Aceite (parcial; todos permanecem not_run globalmente — evidência em docs/status/acceptance.json)
- A02: leitura por vínculo (Rules) e autorização de servidor provadas; configuração por ambos os responsáveis com auditoria de autor depende de F04/F09.
- A08: decisão de autorização com política atual provada; bloqueio de checkout/PDV e preservação de pedidos dependem de F11/F15.
- A30: aluno/responsável/cantina/secretaria negados na API administrativa; matriz sem custos/lucro para secretaria; rotas de custos/lucro/relatórios inexistentes ainda (F06/F10/F21).
- A33: isolamento por vínculo, perfil e escrita do cliente provados; carteira/pedidos/estoque/preço reais ainda não existem.
- A34: perfil/sessão ao vivo e listener de saldo de prova; saldo/pedidos/estoque reais e troca de aluno (F08+/F12) pendentes.
- A32/A35/A36/A37: sem mudança de status (ver acceptance.json; A36 agora usa papel real + Storage Rules por perfil).

## Pendências
- Dependências: overrides escopados (ver "Fechamento pós-F03" e docs/status/dependency-audit.md). `npm audit` completo ainda lista 3 avisos moderados só de desenvolvimento (GHSA-8988-4f7v-96qf, @opentelemetry/core via firebase-tools); a correção sugerida exige `--force` e não foi aplicada.
- Primeiro administrador real: criar no Console (Auth + `users/{uid}` role admin); script de bootstrap fica para F24. Desabilitar cadastro público no Firebase Auth do projeto real (conta sem perfil já não acessa nada).
- Homologação real pendente: regra entre serviços do Storage (exige permissão IAM do serviço no projeto), e-mail de redefinição de senha (Firebase Auth), domínios autorizados.
- Sem tela de administração de usuários (só API); sem convites/vínculos reais (F04); papel `student` só tem portal de consulta.
- Remover `demoProducts`, `/api/catalog/photo` e a regra quando o catálogo real (F06) existir; remover `/api/probe`/`foundationProbes` quando a carteira real (F08) existir.
- Concorrência no mesmo documento: transações leitura→escrita disputam a promoção do lock (≈3,4 s por impasse no emulador); com `COMMAND_TRANSACTION` 12 escritores/documento passam. Não medido no Firestore real; revalidar na homologação (F24) e ao implementar a carteira (F08).
- Gitleaks: job no CI (v8.30.1, SHA-256 fixado) CONFIGURADO, não executado; local bloqueado pela política do Windows. Semgrep: não executado.
- Build: só `npm run build:webpack` comprovado. Turbopack e CI NÃO comprovados.
- `.env` local real (APP_ENV=production + conta de serviço; ignorado pelo Git): nunca usar com testes/dev de emulador — use `npm run dev:emulator`. Ação manual sua: confirmar origem e, se a chave circulou fora desta máquina, rotacioná-la.
- Conta/projeto Firebase, Vercel, provedores Pix/cartão: pendências externas.
- npm install-scripts bloqueados (@firebase/util, protobufjs, re2, unrs-resolver): sem efeito observado.
- Dica de ambiente: `npm run test:e2e` não aceita filtro; para um spec use `npx firebase emulators:exec --only auth,firestore,storage --project demo-cantina "npx playwright test <arquivo>"`. Seed local agora cria também secretaria@/admin@example.test (perfis em `users`).

## Próxima ação
- Executar /cantina-task F04.
