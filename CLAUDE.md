# Cantina Escolar — instruções do projeto

Desenvolver site operacional para uma escola (~300 alunos), com Next.js/React, TypeScript strict, Firebase Auth e Firestore, arquivos no Cloudflare R2 privado (src/lib/storage; Firebase Storage não é mais usado); deploy desejado Vercel. UI pt-BR, BRL, America/Sao_Paulo. Claude Code é o agente de desenvolvimento.

## Iniciar e localizar contexto

- Ler PROGRESS.md e o arquivo docs/tasks/Fxx.md solicitado. Se não houver tarefa, selecionar a primeira elegível em docs/tasks/index.md.
- Usar `node scripts/agent-context.ts Fxx` para obter contexto/workflow mínimo; fallback: entrada específica de docs/context-map.json. Ler somente documentos/aceites pertinentes.
- Não reler documento, saída de contexto ou SKILL.md já carregado e válido na tarefa. Reutilizar evidência de check após a última mudança pertinente.
- Produto canônico está dividido em docs/; consultar docs/spec-index.md se faltar requisito. Não ler tudo a cada sessão e não importar a documentação inteira aqui.
- Conflito de requisito: localizar a seção original indicada no índice; preservar a decisão de produto ou registrar dúvida concreta. Não remover requisito para economizar tokens.
- Skills em .claude/skills; /cantina-task F01 e /cantina-resume seguem a seção "Skills integradas" de cada tarefa, acionando a skill correspondente via ferramenta Skill na etapa atual. Registrar uso por invocação/leitura e evidência; não carregar todas de uma vez.

## Invariantes globais

- Carteira individual por aluno. Dinheiro em centavos inteiros; custo médio usa Decimal/representação exata documentada.
- Comandos financeiros/estoque/papéis/vínculos passam pelo servidor autenticado e autorizado; Admin SDK é server-only e ignora Security Rules.
- Carteira, livro, pedidos, estoque/cotas e uso por data de consumo devem permanecer consistentes via transação idempotente. Leituras antes de escritas; efeitos externos fora do callback.
- Livro/auditoria imutáveis; corrigir por novo movimento com referência e motivo. Saldo não fica negativo silenciosamente.
- Recarga confirmada R$50 credita R$50; taxa é despesa. Pedido cancelado reembolsa carteira original, sem saque voluntário.
- Firebase Web Auth permanece coerente com sessão servidor e listeners. Rules negam dados de outra família e escrita financeira do cliente.
- Não alterar stack/escopo: uma escola, unidade de produto, sem ingredientes, app nativo, multi-tenant ou parcelamento.
- UI clean com fotos, listas/tabelas/seções abertas e movimento discreto acessível; não transformar tudo em cards.
- Não inventar integração/API/credencial. Demo somente isolada e explícita; produção indisponível se provedor ausente.

## Trabalhar e validar

- Inspecionar antes de editar; preservar estrutura e trabalho existente. Pesquisar primeiro com rg e abrir trechos relevantes.
- Não lançar agentes paralelos nem ligar MCPs adicionais por padrão. Usar shell e documentação oficial direcionada conforme necessidade.
- Testes financeiros/concorrência/rules exigem evidência; mocks não substituem emulador ou sandbox de gateway.
- Rodar testes do módulo, typecheck e lint afetado. Nos marcos A–E e antes da entrega, suíte integrada e build/CI conforme docs/testing/strategy.md.
- Para saída extensa, usar scripts/run-check.ts ou RTK já validado; guardar log bruto e status. Consultar docs/development-tools.md só para instalar/configurar capacidade necessária. Não esconder falha no resumo.
- PROGRESS.md deve conter tarefa, arquivos, decisões, comandos/resultados, pendências e próxima ação; manter curto. Histórico detalhado pode ir em docs/status/history.md.
- Marcar concluído somente comportamento integrado/aceite comprovado; pendência de credencial não equivale a homologação.
- Fazer commits coerentes quando Git disponível; não criar push/deploy/operação real de pagamento sem autorização pertinente.
- Pacote inicial ainda não tem aplicação/dependências. F01 cria package.json/lockfile e scripts válidos no diretório atual sem sobrescrever estes documentos. Não rodar npm antes disso.

## Comandos após F01

Comandos reais (F01, `package.json`, npm; Node >=24.12, Java 21 para emuladores; projeto emulador `demo-cantina`):

- `npm run dev` / `npm run build` — Next padrão (Turbopack). Nesta máquina Windows o binário SWC nativo é bloqueado: usar `npm run dev:webpack` / `npm run build:webpack`.
- `npm run lint` (ESLint 9), `npm run typecheck` (tsc strict), `npm test` (unit, Vitest).
- `npm run test:rules`, `npm run test:integration`, `npm run test:e2e` — sobem Auth/Firestore via `firebase emulators:exec` (arquivos: armazenamento local `STORAGE_LOCAL_DIR`, double do R2; sem Storage Emulator); e2e usa Playwright com `next dev --webpack` na porta 3100 e ambiente hermético (zera credencial de `.env` local).
- Prova manual local: `npm run emulators` (UI em 4000) → outro terminal `npm run dev:emulator` (Next webpack hermético, porta 3000; ignora .env) → `npm run seed` (contas fictícias familia-a/b@example.test; recusa alvo não local). Não usar `npm run dev` com o .env atual (APP_ENV=production).
- Homologação integrada (Firebase `cantina-escolar-hml` + R2 `cantina-fotos-staging`, config em `.env.staging.local`, nunca o `.env`): `npm run staging:preflight | staging:deploy | staging:fixtures | staging:dev | staging:verify | staging:cleanup`; `npm run staging:selftest` ensaia o harness em emuladores. Detalhes e limites: docs/status/firebase-homologation.md. Nunca apontar para `cantina-claude`/produção.
- `npm run audit:prod` — `npm audit` só de produção.
- `npm run test:r2` — integração OPCIONAL com bucket R2 de homologação (variáveis `R2_TEST_*` só no shell); sem elas os testes são pulados. Não contar como evidência de R2 real quando pulada.
- Não usar logs com `:` no nome no Windows; `.env` local real nunca é lido pelos testes de emulador.

## Compact instructions

Preservar tarefa/objetivo, invariantes relevantes, arquivos alterados, decisões, falhas ativas, comandos/resultados e próxima ação. Consultar PROGRESS.md após retomada; não afirmar testes que não foram executados.

<!-- rtk-instructions v2 -->
# Command output

Command output here is condensed to save tokens, keeping every signal and
dropping costly noise. Treat it as the complete result: run commands
normally, and batch related commands into one call to avoid extra turns.
Truncated results state their recovery path in their own output. Re-run a
command as `rtk proxy <cmd>` only when its result is unusable: empty when
output was clearly expected, contradicting its exit code, or garbled.
<!-- /rtk-instructions -->

## Next.js (versão nova)

- Bloco gerado pelo `next dev` vive em AGENTS.md (não editar; é regerado se alterado). Guias: node_modules/next/dist/docs/. Ler o guia do tópico só ao usar API/convenção Next cuja versão seja incerta (cantina-research); não ler antes de todo código, conforme economia de contexto acima.
