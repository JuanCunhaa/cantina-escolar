---
name: cantina-node-env
description: "Prefixar todo comando node/npm/npx/firebase/playwright da Cantina Escolar na nuvem (Claude Code remoto, Linux) com o Node 24 e o Chromium compatíveis com o projeto."
---

# Ambiente Node na nuvem

Vale somente quando `CLAUDE_CODE_REMOTE=true` (container Linux do Claude Code na nuvem). No Windows local, não aplicar: lá valem os comandos de CLAUDE.md.

Motivo: no container, `/opt/node22/bin` vem antes de `/usr/local/bin` no PATH, e o `node` resolvido é o v22 (o projeto exige >=24.12; o setup instala o v24.20.0 em `/usr/local/bin`). `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` só traz o Chromium 1194, mas `@playwright/test` 1.63 exige o 1243. O shell da ferramenta Bash não lê `~/.bashrc`, então o ajuste precisa ir em cada chamada.

## Regra

1. Em toda chamada Bash que execute `node`, `npm`, `npx`, `firebase`, `playwright`, `vitest`, `tsc`, `next` ou script `npm run …`, começar com:

   ```bash
   export PATH=/usr/local/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright;
   ```

   Exemplo: `export PATH=/usr/local/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright; npm run typecheck`.
2. Na primeira chamada da sessão, conferir `node -v` (esperado `v24.x`). Se não for v24, parar e reportar; não instalar outro Node nem rodar npm com v22.
3. Antes de E2E/Playwright, conferir se existe `$HOME/.cache/ms-playwright/chromium-<rev>`, com `<rev>` de `node_modules/playwright-core/browsers.json`. Se faltar (container recriado), instalar só ali, sem tocar em `/opt/pw-browsers`:

   ```bash
   export PATH=/usr/local/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright; PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= npx --no-install playwright install chromium
   ```
4. Se faltar o jar do emulador Firestore em `~/.cache/firebase/emulators`, rodar `npx --no-install firebase setup:emulators:firestore` com o mesmo prefixo.
5. Usar sempre as CLIs locais (`npx --no-install …`), nunca instalação global. Avisos de porta IPv6 (`::1` EAFNOSUPPORT) dos emuladores são inofensivos.
