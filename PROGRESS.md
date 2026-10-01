# Estado do desenvolvimento

Data de referência: 30/09/2026. Este arquivo descreve código entregue, não apenas intenção.

## Concluído
- F01 — fundação técnica e prova de isolamento (escopo implementado; critérios A32–A35 seguem parciais, ver abaixo).

## Passagem de etapa
- 30/09/2026: Git local inicializado (branch main) e F01 commitada localmente, sem push. Estágio auditado: sem .env, logs, .next, tsbuildinfo, test-results, next-env.d.ts nem credenciais; .env.example só com padrões não sensíveis; valores reais do .env buscados no conteúdo commitado (apenas identificadores não sensíveis como APP_ENV e nome do projeto aparecem em docs/exemplos). Adicionados .gitattributes (eol=lf, conforme .editorconfig) e next-env.d.ts ao .gitignore. Hash: git log -1.
- Gitleaks segue não executado (local bloqueado; CI configurado e não executado); Turbopack não comprovado.

## Em andamento
- Nenhuma. Próxima tarefa elegível: F02 (ver docs/tasks/index.md).

## F01 — resumo
- Arquivos: ver docs/status/history.md. App Next 16/TS strict, Firebase client/admin, env fechado, comando transacional de prova idempotente (`/api/probe`), rules deny-all com única abertura do próprio `foundationProbes/{uid}`, CI em .github/workflows/ci.yml, scripts seed/emulators.
- Validação (emulador `demo-cantina`): typecheck 0; lint 0; unit 9/9; rules 7/7; integration 14/14; e2e 1/1 (duas contas); build:webpack 0.
- Decisões: docs/decisions.md ("Decisões de F01").
- Skills invocadas via ferramenta Skill: cantina-token-economy, cantina-architecture, cantina-testing, cantina-firebase, cantina-security, cantina-verify.

## Aceite (parcial; todos permanecem not_run globalmente — evidência em docs/status/acceptance.json)
- A32: checks locais verdes; falta homologação Firebase real e build Turbopack.
- A33/A34/A35: provados só para a prova de fundação; completar com F03+ (vínculos/papéis), F04+ (carteira/pedidos), F08/F09 (uso/limites).

## Pendências
- Gitleaks: job no CI (v8.30.1, SHA-256 fixado) CONFIGURADO, não executado; local bloqueado pela política do Windows (não contornado). Semgrep: job sem versão fixada, não executado.
- Build: só `npm run build:webpack` comprovado (exit 0, local). Build padrão (Turbopack) NÃO comprovado: depende do primeiro run do CI ou deploy Vercel. CI nunca executado.
- `.env` local real (APP_ENV=production + conta de serviço; não criado por F01; ignorado pelo Git via `.env*`): nunca usar com testes/dev de emulador — use `npm run dev:emulator`. Ação manual sua: confirmar origem/propósito do arquivo e, se a chave já circulou fora desta máquina, rotacioná-la.
- CLAUDE.md: bloco do Next agora em AGENTS.md (gerado, não editar); bloco rtk duplica ~7 linhas do RTK.md global (mantido).
- Conta/projeto Firebase, Vercel, provedores Pix/cartão: pendências externas.
- Remover `/api/probe`, `foundationProbes` e sua regra quando a carteira real (F04) existir.
- npm install-scripts bloqueados (@firebase/util, protobufjs, re2, unrs-resolver): sem efeito observado.

## Próxima ação
- Executar /cantina-task F02.
