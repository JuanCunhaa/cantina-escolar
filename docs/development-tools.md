# Ferramentas para desenvolvimento e contexto

Skills orientam; ferramentas executam. Este pacote inclui dois utilitários TypeScript locais já utilizáveis com Node 24.12+, sem dependências. Ferramentas externas abaixo são recomendações/configuração de implementação; não estão instaladas pelo ZIP. F01 verifica o ambiente, fixa versões no projeto/CI e registra capacidades reais. Não criar configuração que referencia binário ausente.

## Base do projeto

| Ferramenta | Para quê | Quando |
| --- | --- | --- |
| rg/ripgrep | Buscar símbolo/padrão/pasta com saída pequena | Inspeção antes de abrir arquivos |
| TypeScript tsc | Conferir tipos realmente | Mudança TS e marcos |
| Firebase CLI + Emulator Suite | Auth/Firestore/rules/transações locais (arquivos usam armazenamento local de emulator, não há Storage Emulator) | Desde F01 e mudanças Firebase |
| Vitest | Regras puras e integração TS | Casos relevantes da tarefa |
| Playwright | Jornada do site e inspeção visual | Caminhos afetados e aceite E |
| Gitleaks | Detectar segredo em arquivos/Git | Credenciais/config e entrega |
| Semgrep | Análise estática de código sensível | Handler, autorização, input, dependências/risco |
| Auditoria do gerenciador | Vulnerabilidades em dependências | Mudança de lockfile e entrega |

Scanners não substituem testes de autorização, concorrência ou revisão de negócio. F01 cria scripts de teste/CI após fixar dependências. Não executar npm install antes de criar package.json. Não enviar dados da escola para scanners cloud para fazer um teste local.

## Utilitários incluídos

### Seleção determinística de contexto

```bash
node scripts/agent-context.ts F11
node scripts/agent-context.ts domain:wallet
```

Devolve somente documentos, IDs de aceite e skills da tarefa/domínio pedido; não despeja docs/context-map.json inteiro. Código lê o mapa local, não acessa serviços. As skills de execução já orientam seu uso.

### Resumo de logs com status preservado

```bash
node scripts/run-check.ts -- node node_modules/typescript/bin/tsc --noEmit
node scripts/run-check.ts -- node node_modules/vitest/vitest.mjs run tests/unit/wallet
```

Os caminhos de CLI devem ser confirmados por F01 com as versões instaladas. O wrapper roda um executável sem shell, salva stdout/stderr bruto em .agent-logs, mostra saída curta e propaga o código de falha. Em falha, o resumo não é prova suficiente quando a causa ficou fora do trecho: abrir o log pertinente. Não usar wrapper para imprimir credenciais; logs não são mecanismo de redaction.

Com npm/pnpm/yarn no Windows, os shims .cmd podem não funcionar com execução sem shell. Preferir executar o CLI via node como acima ou rodar o comando diretamente no terminal e registrar status. Não ativar shell para interpolar argumentos de origem desconhecida. Node apenas remove tipos: o wrapper não realiza typecheck.

## Complementos para economia

### RTK — opcional após validação

RTK é uma CLI de terceiros para compactar saída de comandos de desenvolvimento. O mantenedor anuncia redução de tokens nas saídas; isso não significa a mesma redução da sessão inteira. Comparar um check representativo com execução original: status, contagem de testes, erro e acesso ao log completo devem continuar confiáveis. Usar `rtk gain` para estatística local e medir o efeito no próprio fluxo.

Para esta primeira entrega, o wrapper local é o caminho pronto. RTK não foi instalado, nenhum hook global foi alterado. Usar releases/instalação do mantenedor conforme Windows/WSL; verificar binário/versão correta antes de integrar. O projeto não configura automaticamente `rtk init -g`, que altera hooks pessoais do Claude Code. Não envolver run-check com outro redutor sem preservar status/log da execução original.

### Navegação TypeScript por LSP — opcional

O plugin oficial typescript-lsp permite localizar definição/referências sem ler múltiplos candidatos. Conferir servidor/plugin funcional na versão do TypeScript/Claude, principalmente em Windows, antes de depender dele. Instalar plugin no Claude Code e binário requerido conforme README oficial. LSP não substitui tsc/CI.

```text
/plugin install typescript-lsp@claude-plugins-official
```

Se não oferecer navegação real, usar rg como fallback e registrar indisponibilidade; não marcar plugin como funcional porque está listado como instalado. Não ativar plugin extra que duplique as mesmas capacidades.

### Firebase plugin/MCP oficial — opcional e sob demanda

É útil para ações concretas na conta/projeto Firebase; não é necessário para escrever TypeScript ou rodar emuladores. Preferir CLI em trabalho local. Configurar apenas quando houver uso externo definido, projeto correto e autorização pertinente.

O setup oficial para Claude Code apresenta:

```bash
claude plugin marketplace add firebase/firebase-tools
claude plugin install firebase@firebase
```

Consultar documentação para credenciais, escopo e grupos de ferramentas disponíveis. O servidor suporta `--only` para limitar recursos, mas ferramentas core continuam disponíveis. O pacote não inclui .mcp.json nem instala plugin; F01 registra se está realmente presente. Autorizar plugin não torna todos os projetos/ambientes acessíveis ou seguros para alteração.

## Comandos de segurança de referência

Confirmar versão instalada e criar scripts/CI correspondentes. Executar em código fictício/local sem divulgar secrets:

```bash
gitleaks dir --redact .
gitleaks git --redact .
semgrep scan --config=auto src
```

No CI as versões ficam fixadas por SHA-256/digest em scripts/ci/tools/ e no workflow (Gitleaks 8.30.1, actionlint 1.7.12, Veracode Pipeline Scan `cmd-26.9.0` e SCA `srcclr` 3.8.122); nesta máquina a política de Controle de Aplicativo bloqueia o Gitleaks — usar o CI. Detalhes, critérios e configuração externa: docs/testing/ci.md. Gitleaks dir verifica arquivos, git verifica histórico; sem Git, usar dir. Semgrep auto usa regras do registry; fixar regras/versões relevantes para CI reprodutível e avaliar findings. Esses comandos não foram rodados na aplicação, que ainda será desenvolvida. Em logs, manter redaction e não colar valor do segredo encontrado.

## Estado das ferramentas

Manter docs/status/tools.json com versão/disponibilidade/configuração comprovadas. Instalação global, conexão de conta/MCP e alteração de hooks pessoais não são implícitas por esta documentação. Ferramentas não disponíveis devem ser reportadas e substituídas pelo fallback viável.

## Fontes oficiais/mantenedores consultados em 30/09/2026

- https://code.claude.com/docs/en/costs
- https://code.claude.com/docs/en/skills
- https://github.com/anthropics/claude-plugins-official/tree/main/plugins/typescript-lsp
- https://firebase.google.com/docs/cli
- https://firebase.google.com/docs/emulator-suite/install_and_configure
- https://firebase.google.com/docs/ai-assistance/mcp-server
- https://github.com/rtk-ai/rtk
- https://github.com/gitleaks/gitleaks
- https://docs.semgrep.dev/running-rules
- https://nodejs.org/api/typescript.html

Revalidar API/compatibilidade quando implementar; não carregar todas estas páginas toda sessão.
