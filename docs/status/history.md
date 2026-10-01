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
