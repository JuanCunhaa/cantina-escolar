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
