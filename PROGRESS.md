# Estado do desenvolvimento

Data de referência: 30/09/2026. Este arquivo descreve código entregue, não apenas intenção.

## Concluído
- F01 — fundação técnica e prova de isolamento (escopo implementado; critérios A32–A35 seguem parciais).
- F02 — shell visual, navegação por papel e fotos (escopo implementado; A36/A37 parciais, ver abaixo).

## Em andamento
- Nenhuma. Próxima tarefa elegível: F03 (autenticação, papéis e autorização) — ver docs/tasks/index.md. F06 também depende de F02+F03.

## F02 — resumo
- Entregue: tokens/CSS (src/app/globals.css), casca `AppShell` para `/portal` e `/operacao` (skip link, navegação por papel, login), `ProductPhoto` (4:3, alt, lazy, fallback), cardápio de demonstração em tempo real (`demoProducts`, fictício) com quantidade/total BRL, tela de operação para enviar foto, Storage Rules (cantina/admin, só create, tipo/≤2 MB/caminho), `/api/catalog/photo` (servidor revalida papel, caminho, tipo, tamanho e bytes), seed com contas e fotos fictícias.
- Validação (emulador `demo-cantina`): typecheck 0; lint 0; unit 17/17; rules 13/13; integration 21/21; e2e 7/7; build:webpack 0. Capturas desktop/mobile inspecionadas.
- Decisões: docs/decisions.md ("Decisões de F02"); detalhes em docs/status/history.md.
- Skills invocadas via ferramenta Skill: cantina-token-economy, cantina-testing, cantina-firebase, cantina-ui, cantina-security, cantina-verify.

## Aceite (parcial; todos permanecem not_run globalmente — evidência em docs/status/acceptance.json)
- A32: checks locais verdes; falta homologação Firebase real e build Turbopack.
- A33/A34/A35: provados só para a prova de fundação; completar com F03+ (vínculos/papéis), F04+ (carteira/pedidos), F08/F09 (uso/limites).
- A36: provado no emulador com papel provisório (custom claim `role`); papéis reais e revogação em F03; homologação Storage real e limpeza de órfãos (F06) pendentes.
- A37: provado no portal de demonstração e na tela de fotos (teclado, 375 px, reduced motion, sem excesso de cards); repetir em PDV/entrega/pedidos (F11–F16); sem axe automatizado.

## Pendências
- Papel provisório por claim: F03 deve formalizar; Rules não checam revogação (token vale até expirar).
- Remover `demoProducts`, `/api/catalog/photo` e a regra quando o catálogo real (F06) existir; remover `/api/probe`/`foundationProbes` quando a carteira (F04/F08) existir.
- `npm run audit:prod`: 2 achados já existentes (@grpc/grpc-js alto, uuid moderado, via firebase/firebase-admin); sem dependência nova em F02; correção sugerida rebaixa firebase para 9.x — avaliar com atualização de versões.
- Gitleaks: job no CI (v8.30.1, SHA-256 fixado) CONFIGURADO, não executado; local bloqueado pela política do Windows. Semgrep: não executado.
- Build: só `npm run build:webpack` comprovado. Turbopack e CI NÃO comprovados.
- `.env` local real (APP_ENV=production + conta de serviço; ignorado pelo Git): nunca usar com testes/dev de emulador — use `npm run dev:emulator`. Ação manual sua: confirmar origem e, se a chave circulou fora desta máquina, rotacioná-la.
- Conta/projeto Firebase, Vercel, provedores Pix/cartão: pendências externas.
- npm install-scripts bloqueados (@firebase/util, protobufjs, re2, unrs-resolver): sem efeito observado.
- Dica de ambiente: `npm run test:e2e` não aceita filtro; para um spec use `npx firebase emulators:exec --only auth,firestore,storage --project demo-cantina "npx playwright test <arquivo>"`.

## Próxima ação
- Executar /cantina-task F03.
