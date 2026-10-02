# Evidências de desenvolvimento

Sem execução de testes da aplicação nesta entrega. Adicionar tarefa, commit/caminhos, comando, resultado, data e pendência externa quando houver.

## F01 — fundação técnica (30/09/2026)
- Arquivos: package.json/lockfile, tsconfig, next/eslint/vitest/playwright configs, src/lib/{env,firebase/client,firebase/admin}, src/modules/access/{actor,probe}, src/app (layout, page, api/probe), src/components/layout/foundation-probe.tsx, firebase/firestore.rules, scripts/seed.ts, tests/{unit,rules,integration,e2e,helpers,stubs}, .github/workflows/ci.yml.
- Resultados: typecheck 0; lint 0; unit 9/9; rules 7/7; integration 14/14; e2e 1/1; build:webpack 0. Logs brutos em .agent-logs/ (ignorado pelo Git).
- Falhas resolvidas: ESLint 10 incompatível (→9); merge de `include` do Vitest; revogação de token no mesmo segundo (teste); allowedDevOrigins; `.env` local com credencial derrubou e2e (→ env hermético).
- Não executado: gitleaks (bloqueado), semgrep, Turbopack, homologação Firebase real, CI no GitHub.

## F01 — fechamento de pendências (30/09/2026)
- .env local inesperado (criado 19:32, não por F01): inspecionados só nomes/indicadores. 21 variáveis; APP_ENV=production, NEXT_PUBLIC_USE_FIREBASE_EMULATORS=false, conta de serviço presente (client email + private key), projeto não-demo, sem variáveis de emulador, segredos de pagamento vazios; 1 extra (NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID, adicionada como opcional ao .env.example) e 3 hosts de emulador só no example. Coberto por `.env*` no .gitignore (exceto .env.example); sem Git local, exclusão do histórico não verificável. Arquivo não lido além disso, não alterado nem apagado.
- Gitleaks: job CI com v8.30.1 + SHA-256 fixados (download/hash verificados localmente); execução local segue bloqueada; CI não executado.
- Build: scripts build (padrão) e build:webpack; só webpack comprovado (exit 0). Padrão pendente de CI/Vercel.
- CLAUDE.md: bloco nextjs-agent-rules movido para AGENTS.md (gerador só regrava lá e não regenerou no teste); referência curta no CLAUDE.md limitando a leitura ao necessário.
- Novo: scripts/dev-emulator.ts (npm run dev:emulator), fluxo manual validado de ponta a ponta no emulador. typecheck 0, lint 0 após as mudanças; testes automatizados não repetidos (sem mudança em src/tests).

## F02 — shell visual, navegação e fotos (30/09/2026)
- Arquivos: src/app/{globals.css,layout,page,portal/*,operacao/*,api/catalog/photo}, src/components/{layout/{app-shell,area-home,sign-in-form},ui/product-photo}, src/modules/access/{roles,navigation,use-session,actor}, src/modules/catalog/{photo,use-demo-products,components/*}, src/lib/{money/format,validation/photo,firebase/{admin,client},env}, firebase/{storage,firestore}.rules, scripts/{seed,dev-emulator,lib/demo-seed}.ts, playwright.config.ts, package.json (emuladores incluem storage), tests/{unit/photo-navigation,rules,integration/photo-route,e2e/shell-photos,helpers}.
- Resultados: typecheck 0; lint 0; unit 17/17; rules 13/13; integration 21/21; e2e 7/7 (1 de F01 + 6 de F02); build:webpack 0.
- Achado de revisão corrigido: Rules permitiam sobrescrever foto já validada (update) → só create com `resource == null`; teste de regressão.
- Falhas resolvidas: lint react-hooks/set-state-in-effect (estado chaveado por uid/caminho); e2e: foco do Tab após login, alert duplicado do route announcer, 1ª compilação de rota no dev server.
- `npm run audit:prod`: 2 achados já existentes (@grpc/grpc-js alto, uuid moderado via firebase/firebase-admin); sem dependência nova em F02; não corrigido (a correção sugerida rebaixa firebase para 9.x).
- Não executado: Gitleaks/Semgrep (indisponíveis), Turbopack, CI, homologação Firebase real, axe automatizado.

## F03 — autenticação, papéis e autorização (30/09/2026)
- Arquivos: src/modules/access/{roles,permissions,errors,profile,actor,authorize,http,users-command,use-session,session-actions,navigation}.ts, src/modules/audit/log.ts, src/app/api/{admin/users,session/revoke}/route.ts (+ probe e catalog/photo adaptados), src/components/layout/{app-shell,sign-in-form}.tsx, src/modules/catalog/photo.ts, src/app/operacao/produtos/page.tsx, firebase/{firestore,storage}.rules, scripts/{seed,lib/demo-seed}.ts, tests/{unit/access,unit/photo-navigation,rules,integration/access-api,e2e/access,helpers}, docs (decisions, schema, status/dependency-audit.md).
- Resultados: typecheck 0; lint 0; unit 34/34; rules 26/26; integration 46/46; e2e 12/12 (F01 1 + F02 6 + F03 5); build:webpack 0. Skills: cantina-token-economy, -testing, -firebase, -ui, -security, -verify (via ferramenta Skill).
- Papel migrou de claim para `users/{uid}` (servidor + Firestore Rules + Storage Rules entre serviços, comprovado no emulador). Revogação formalizada e testada (ver decisões de F03).
- Achado de revisão corrigido: administrador rebaixado no meio da requisição ainda poderia concluir o comando → perfil do ator relido dentro da transação (teste de regressão).
- Observação: em 1 de 4 execuções completas de `test:integration`, `probe-command` (F01, 12 escritas concorrentes no mesmo documento) falhou com `10 ABORTED: Transaction lock timeout` do emulador; passou isolado, em 2 reexecuções completas e no commit anterior (git stash). Tratado como instabilidade de carga do emulador, não explicada a fundo; reavaliar se reaparecer.
- audit:prod: análise em docs/status/dependency-audit.md (não alcançáveis em produção; override compatível validado só no lockfile, NÃO aplicado).
- Não executado: Gitleaks/Semgrep (indisponíveis nesta máquina), Turbopack, CI, homologação Firebase real (incl. regra entre serviços do Storage), axe automatizado.

## Fechamento pós-F03 — dependências e lock timeout (01/10/2026)
- Arquivos: package.json/package-lock.json (overrides), docs/status/dependency-audit.md (reescrito), src/lib/firebase/transaction-options.ts (novo), src/modules/access/{probe,users-command}.ts, tests/integration/probe-command.test.ts (timeout de 90 s no teste de 12 escritores; asserções intactas), docs/firebase/transactions.md, PROGRESS.md.
- audit:prod: 6 → 0 vulnerabilidades; ver dependency-audit.md (IDs m9gg/f596/99f4/w5hq, correção do doc, override mínimo e provas).
- Lock timeout: evidência — emulador loga "Transaction lock timeout" em ReactiveLockManager.acquireLocks (commit) mesmo nas execuções que passam (~1.200 ocorrências por rodada); reprodução com transação nua leitura→escrita (sem código do repositório): 2 concorrentes ≈ 3 s, serial ≈ 50 ms; maxAttempts 5 → falhas com 12 e 24 escritores, 25 → 0 falhas em 4 rodadas. Hipótese confirmada: impasse de promoção de lock + orçamento de 5 tentativas. Não foi "repetir até passar": a execução anterior que passava estava na margem do orçamento (tentativas máx. = 5 em 1 de 6 rodadas).
- Validação: suíte completa uma vez após a mudança (typecheck/lint/unit 34/rules 26/integration 46/e2e 12/build:webpack/audit:prod). Arquivos temporários de reprodução removidos.

## F04 — alunos, responsáveis, vínculos e convites (01/10/2026)
- Arquivos novos: src/lib/{domain-error,api-client}.ts, src/lib/firebase/command.ts (idempotência/comando); src/modules/school/{commands,use-units}.ts + components/school-units.tsx; src/modules/students/{normalize,commands,queries,csv,import}.ts + components/{students-directory,student-detail,import-students}.tsx; src/modules/policies/commands.ts; src/modules/guardians/{links,invitations,queries,use-family-students}.ts + components/{guardians-list,family-students,redeem-invitation}.tsx; src/modules/access/command-route.ts; rotas /api/{school,students,students/import,students/[id],policies,links,invitations,invitations/redeem,guardians}; páginas /operacao/{alunos,alunos/[id],alunos/importar,escola,responsaveis}, /portal/alunos, /convite; testes tests/unit/students.test.ts, tests/integration/students-api.test.ts, tests/e2e/students.spec.ts, +4 casos em tests/rules. Alterados: firebase/firestore.rules (classes/shifts), navigation.ts, permissions.ts (students.manage), users-command.ts (merge preserva `contact`; IdempotencyConflictError movida para command.ts), globals.css.
- Resultados (validação única após a última mudança de código): typecheck 0; lint 0; unit 46/46; rules 30/30; integration 73/73; e2e 15/15; build:webpack 0; audit:prod 0 vulnerabilidades. Skills invocadas via ferramenta Skill: cantina-token-economy, -firebase, -testing, -ui, -security (revisão), -verify.
- Revisão de segurança dos arquivos alterados (cantina-security, manual + testes negativos): token de convite no fragmento da URL (fora dos logs de acesso) e só o hash no Firestore; `setUserAccess` passou a usar merge (preservaria `contact`; teste de regressão); resgate público sem limitação de taxa própria (risco documentado em decisions.md, pendente do edge em F24). Gitleaks/Semgrep: não executados (indisponíveis nesta máquina, como em F03).
- Ocorrências de teste (não são defeitos de produto): e2e no servidor de desenvolvimento recarrega/aborta navegação ao compilar rota pela primeira vez → o spec compila APIs e páginas antes (beforeAll) e trata o recarregamento no resgate do convite; ordem de homônimos na lista é por nome e depois ID (teste não presume ordem). Uma execução dupla acidental da suíte (processos órfãos) colidiu nas portas dos emuladores; descartada e repetida limpa.
- Limitações: a busca por nome é por prefixo (servidor) + filtro por trecho no navegador (~300 alunos); capacidade da importação testada com 300 linhas (limite 500); revisão de pedidos futuros após troca de turma/turno depende de F11+; e-mail de convite não é enviado (a escola entrega o link).

## F05 — escola, calendário e datas locais (01/10/2026)
- Arquivos novos: src/lib/dates/school-time.ts; src/modules/school/{calendar,settings}.ts + components/school-calendar.tsx; src/app/api/school/{settings,calendar}/route.ts; src/app/operacao/calendario/page.tsx; tests/unit/calendar.test.ts, tests/integration/school-calendar.test.ts, tests/rules/school-calendar.rules.test.ts, tests/e2e/calendar.spec.ts. Alterados: firebase/firestore.rules (settings, calendarDays), navegação (admin), schema/queries/decisions.
- Resultados (execução única após a última mudança de código): typecheck 0; lint 0; unit 64/64; rules 31/31; integration 83/83; e2e 17/17; build:webpack 0; audit:prod 0. Inspeção da captura 375 px (test-results/f05-calendario-375.png): sem rolagem horizontal, janela hoje…hoje+7 correta.
- Segurança (cantina-security, manual + testes negativos): escrita só admin (capacidade + perfil atual na transação), 403/401 testados; leitura de janela só com perfil ativo; chaves de política limitadas a 50 e validadas contra turnos existentes; sem dados financeiros/custos envolvidos. Gitleaks/Semgrep não executados.
- Skills invocadas via Skill: cantina-token-economy, cantina-testing, cantina-firebase, cantina-ui, cantina-security, cantina-verify.

## Migração do armazenamento de arquivos para Cloudflare R2 (01/10/2026)
- Ver docs/status/r2-migration.md (arquivos, comandos reais, resultados, pendências) e docs/decisions.md ("Armazenamento de arquivos em Cloudflare R2").

## F06 — catálogo, preço histórico e canais (02/10/2026)
- Branch `feature/f06-catalogo`. Arquivos e decisões: PROGRESS.md (seção F06) e docs/decisions.md ("Decisões de F06").
- Local (emulador demo-cantina): typecheck 0; lint 0; unit 112/112; rules 28/28; integration 115/115; e2e 19/19; build:webpack 0; audit:prod 0; Gitleaks dir (src/tests/scripts/firebase) 0. Logs brutos: .agent-logs/f06-*.log.
- Falhas resolvidas: limite de canais rejeitava lista com repetição (schema); e2e admin perdia o painel aberto quando o dev server recompilava outra rota (HMR) — portal da família aberto antes do fluxo; 1ª execução estourou 60 s por compilação (timeout do teste 150 s).
- Homologação: `npm run staging:deploy` (Rules F06 no cantina-escolar-hml); `staging:verify` dirigido (catalog, shell-photos, access, photos-r2, isolation) 22/22. Log: .agent-logs/f06-staging-local.log.
