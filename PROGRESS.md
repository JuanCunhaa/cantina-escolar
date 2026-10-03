# Estado do desenvolvimento

Data de referência: 02/10/2026. Este arquivo descreve código entregue, não apenas intenção.

## Concluído
- F01 — fundação técnica e prova de isolamento (escopo implementado; critérios A32–A35 seguem parciais).
- F02 — shell visual, navegação por papel e fotos (escopo implementado; A36/A37 parciais).
- F03 — autenticação, papéis e autorização (escopo implementado; A02/A08/A30/A33/A34 parciais).
- F04 — alunos, responsáveis, vínculos e convites (escopo implementado; A01/A02/A30/A33 parciais).
- F05 — escola, calendário e datas locais (escopo implementado; A12/A13/A14 parciais).
- F06 — catálogo, preço histórico e canais (mesclada na `main` em 02/10/2026 pelo PR #1, publicada na homologação e validada pela URL publicada; A16/A36/A37 parciais, A15 é da F07).
- F07 — cardápio por data, turno e exceções: PR #3 mesclado em 02/10/2026 (merge `9553e62`, checks verdes no head `9e3215c`; CI da main verde, run 37070776248), publicada no projeto Vercel `cantina-escolar-hml`. Validação pela URL publicada: 31/32 (menu-api, menu, catalog, shell-photos, access, students, catalog-api, isolation verdes; `calendar.spec` falha na exibição atrasada do dia salvo — gravação confirmada no Firestore, ver pendência do listener). A12/A14/A15 parciais (not_run). Detalhes: docs/status/history.md.

- F08 — carteira, livro e transferências (implementada na branch `feature/f08-carteira`; PR aberto, NÃO mesclado; validada só em emuladores — sem homologação/publicação). A01/A03/A17/A18/A34/A35 parciais (not_run). Detalhes: docs/status/history.md.

## Em andamento
- F08 aguardando revisão/merge do PR (checks do CI a conferir no PR). F09 NÃO iniciada. Investigação do atraso de listener segue **INCONCLUSIVA** (PR #4), preservada e não repetida.

## Atraso conhecido dos listeners (inconclusivo)
- No navegador, contra a homologação, a 1ª alteração após abrir o canal chega às vezes ~24–30 s depois (7/156 rodadas da página mínima, só com o Web SDK; também no app: calendário local 2/4, foto publicada 1/4). O snapshot inicial e as alterações seguintes são imediatos; a gravação é correta. Causa NÃO identificada: reproduz sem a aplicação em Chromium e Firefox; transporte (WebChannel × gRPC), Rules e rede desta máquina NÃO descartados. Limitações (uma rede, amostras pequenas, sem captura de bytes nos casos lentos, escrita sempre 2 s após o 1º snapshot): docs/status/listener-delay-investigation.md. Rascunho ao suporte NÃO enviado: docs/status/listener-delay-support-draft.md.
- Mitigação F08 (autorizada): na carteira o resultado de um comando vem da RESPOSTA confirmada do servidor e é reconciliado com a leitura/listener pela `version` do servidor (saldo nunca regride; o listener não confirma operação; a tela marca "atualizando a leitura"). Isso NÃO diagnostica nem corrige a causa do atraso, que não foi reproduzido nem medido na F08.
- Falha conhecida na homologação: `calendar.spec` (exibição do dia salvo em 5 s). Não foi mascarada: sem aumento de timeout; a gravação é confirmada no Firestore.

## Aceite (parcial; todos permanecem not_run globalmente — evidência em docs/status/acceptance.json)
- A01: independência de cadastro/política (F04) e de carteiras (F08, emulador); "gasto de A não debita B" por compra depende de F11/F15.
- A03: provado no emulador (API, Rules, Admin, interface); não homologado na nuvem. A17/A18: parciais (transferência; checkout/cota/estoque em F10/F11/F15). A34/A35: parciais (carteira).
- A12/A13/A14: regra, limites exatos, janela hoje+7, fuso e horários configuráveis provados (unit/integração/rules/e2e admin); checkout/PDV/cancelamento real e "não cancelar entregue" dependem de F11/F13/F15 — seguem not_run.
- A02: ambos os responsáveis alteram as permissões de compra com autor auditado; sem vínculo/vínculo revogado negados (API, Rules, e2e). Limites/bloqueios por produto (F09) e efeito em checkout/PDV (F11/F15) pendentes.
- A08: decisão de autorização com política atual provada (F03); bloqueio de checkout/PDV e preservação de pedidos dependem de F11/F15.
- A30: aluno/responsável/cantina/secretaria negados nas APIs administrativas (usuários, turmas, alunos, importação, vínculos, convites); rotas de custos/lucro/relatórios inexistentes ainda (F06/F10/F21).
- A33: Rules/servidor provados para papéis, vínculos, políticas, cadastro e convites; carteira/pedidos/estoque/preço reais ainda não existem.
- A34: perfil/sessão ao vivo e listener de saldo de prova; saldo/pedidos/estoque reais e troca de aluno (F08+/F12) pendentes. A32/A35/A36/A37: sem mudança.

## Pendências
- Dependências: overrides escopados (ver "Fechamento pós-F03" e docs/status/dependency-audit.md). `npm audit` completo ainda lista 3 avisos moderados só de desenvolvimento (GHSA-8988-4f7v-96qf, @opentelemetry/core via firebase-tools); a correção sugerida exige `--force` e não foi aplicada.
- Primeiro administrador real: criar no Console (Auth + `users/{uid}` role admin); script de bootstrap fica para F24. Desabilitar cadastro público no Firebase Auth do projeto real (conta sem perfil já não acessa nada).
- Homologação: app local × Firebase/R2 reais concluída em 01/10/2026 (docs/status/firebase-homologation.md). Servidor publicado (Vercel HML) validado em 01/10/2026. Pendente: e-mail de redefinição de senha (Firebase Auth), desabilitar auto-cadastro público.
- Sem tela de administração de usuários/funcionários (só API `POST /api/admin/users`); papel `student` só tem portal de consulta.
- F04: convite não é enviado por e-mail (a escola copia o link; nenhuma integração de e-mail inventada); resgate público sem limitação de taxa própria (WAF/edge em F24); tela de revisão de pedidos futuros após troca de turma/turno depende de pedidos (F11+); edição de contato do responsável e de matrícula não existe (matrícula é imutável); busca por trecho/sobrenome é filtro no navegador sobre a lista carregada; importação testada até 300 linhas (limite 500); Gitleaks/Semgrep não executados.
- F05: horários vivem em `settings/school` (turno novo fora de manhã/tarde precisa de horário configurado, senão fica indisponível); sem tela de revisão de pedidos afetados (F11); sem sincronização automática de feriados; Gitleaks/Semgrep não executados.
- `demoProducts` removido em F06 (sweep já lê `products`); `/api/probe`/`foundationProbes` seguem (ver Próxima ação, item 6).
- Concorrência no mesmo documento: transações leitura→escrita disputam a promoção do lock (≈3,4 s por impasse no emulador); com `COMMAND_TRANSACTION` 12 escritores/documento passam. Não medido no Firestore real; revalidar na homologação (F24); a carteira (F08) foi testada com 8 transferências simultâneas e A↔B no emulador, sem medição na nuvem.
- Segurança no CI: Gitleaks e Semgrep (1.179.0, regras `--config=auto` do registry, que podem mudar) executados e verdes. Semgrep AppSec Platform ativo desde 01/10/2026 (`semgrep ci`, segredo `SEMGREP_APP_TOKEN` no GitHub; run 36956590251: 12 achados, 0 bloqueantes). Não bloqueantes a avaliar: actions por tag mutável (fixar SHA), `spawn` com `shell: true` em scripts/staging/run.ts (args internos), MD5 em ETag/integridade do R2 (não é uso criptográfico), basic-ftp e @opentelemetry/core só de desenvolvimento via firebase-tools.
- Build: Turbopack comprovado no CI e na Vercel; local segue `build:webpack` (SWC nativo bloqueado nesta máquina).
- `.env` local real (APP_ENV=production + conta de serviço; ignorado pelo Git): nunca usar com testes/dev de emulador — use `npm run dev:emulator`. Ação manual sua: confirmar origem e, se a chave circulou fora desta máquina, rotacioná-la.
- Vercel: plano Hobby é só para uso pessoal não comercial — serve à homologação; produção da escola exige plano adequado e **outro** projeto (decisão do dono). Proteção por senha não existe no Hobby (usada Vercel Authentication). Override `jwks-rsa>jose`: remover quando o upstream corrigir (#3181).
- Ações manuais do dono (não feitas por mim): (1) o token do Semgrep em uso passou pelo chat: ao rotacioná-lo, regravar com `gh secret set SEMGREP_APP_TOKEN -R JuanCunhaa/cantina-escolar` (entrada oculta); (2) conferir em Vercel → Settings → Deployment Protection quem do time pode abrir a URL; (3) pendências anteriores: rotacionar credencial R2, desabilitar auto-cadastro no Auth HML, conferir r2.dev.
- Provedores Pix/cartão e projeto Firebase de produção: pendências externas.
- npm install-scripts bloqueados (@firebase/util, protobufjs, re2, unrs-resolver): sem efeito observado.
- Dica de ambiente: `npm run test:e2e` não aceita filtro; para um spec use `npx firebase emulators:exec --only auth,firestore --project demo-cantina "npx playwright test <arquivo>"`. Seed local agora cria também secretaria@/admin@example.test (perfis em `users`).

## Próxima ação
- Conferir o CI do PR da F08 e mesclar (decisão do dono). Depois, **F09 — políticas, bloqueios e uso por consumo** (primeira elegível após a F08).
- F08, fora do que ficou provado: (1) NÃO executada na homologação (Firebase `cantina-escolar-hml`/Vercel): publicar Rules novas (`wallets`) segue expandir → migrar → contrair — a main antiga ignora a coleção, então é compatível; rodar `staging:verify` com a carteira depois do merge; (2) propagação entre sessões pelo listener (`npm run test:e2e:propagation`, suíte à parte, passo NÃO bloqueante no CI): amostras: local (emulador) 3/3 passaram; CI do PR #5: 1ª execução FALHOU (sessão observadora ainda em "connecting" após 5 s; propagação não chegou a ser exercitada) e a execução seguinte (run 37093327283) passou — amostra pequena, NÃO está comprovada de forma estável, sem timeout aumentado; decisão do dono sobre o gate e sobre a investigação segue aberta; (3) concorrência de carteira não medida no Firestore real; (4) decidido no fechamento: transferência exige alunos ATIVOS nas duas pontas; o servidor bloqueia arquivar aluno com saldo ≠ 0 (saldo lido na transação; disputa testada); aluno já arquivado com saldo: reativação administrativa auditada → fluxo normal → arquivar com saldo zero (sem ajuste livre, sem apagar histórico, sem alterar vínculos); (5) aluno com login lê por API, ainda sem tela; cantina/secretaria sem leitura de saldo até F15/F17; (6) `/api/probe`/`foundationProbes` mantidos porque a evidência F01 de A33/A34/A35 ainda os usa — remover em tarefa própria migrando esses testes; (7) Semgrep só no CI.
- Turnos de teste acumulados na HML (>10 ativos): arquivar/limpar em tarefa autorizada de limpeza (não feito: instrução de não limpar dados antigos).
- Limpeza das fotos antigas `products/demo-*/demo.png` no R2 de homologação (`POST /api/admin/storage/sweep` dry-run e depois `apply`). Não feita no fechamento da F06.
- Fixar as GitHub Actions do workflow por SHA de commit (2 achados não bloqueantes do Semgrep AppSec).
- Homologação publicada com o catálogo real: https://cantina-escolar-hml.vercel.app (login Vercel + contas fictícias `@hml.example.test`).
