# Usar no Claude Code

Este pacote é uma estrutura de desenvolvimento, não uma aplicação pronta. Preserva o escopo do documento fornecido e define contexto sob demanda para o agente implementá-lo.

## Modelo e compatibilidade

Configuração de projeto: `.claude/settings.json` usa `claude-sonnet-5-5` e esforço `medium`. A documentação oficial consultada em 30/09/2026 informa Claude Code v2.1.284+ para Sonnet 5.5. Disponibilidade depende da conta/provedor. Verificar versão com `claude --version`; atualização: `claude update`. Conferir o modelo ativo com `/model`; usar `/context` para verificar instruções carregadas.

O alias `sonnet` pode mudar de versão e depende do provedor; por isso o pacote fixa o ID. Em gateway/Bedrock/Foundry, confirmar ID suportado e ajustar a configuração local, sem presumir que o ID direto da Anthropic seja válido. Se 5.5 estiver indisponível, selecionar explicitamente um Sonnet disponível, sem inventar compatibilidade. Nenhum modelo processa o sistema automaticamente só por estar escrito no prompt; é preciso o cliente Claude Code com acesso à pasta.

## Sessões e contexto

1. Abrir terminal na pasta `cantina-claude` e executar `claude --model claude-sonnet-5-5`.
2. Enviar `/cantina-task F01` ou o texto de START-HERE.md.
3. Após uma tarefa, conferir PROGRESS.md/evidências e começar sessão nova ou usar `/clear` para tarefa independente; retomar com `/cantina-resume` ou `/cantina-task F02`.
4. Na mesma tarefa longa, usar `/compact Preserve tarefa, invariantes, arquivos, decisões, comandos/resultados e próxima ação`.
5. Consultar `/context` para tamanho/composição do contexto e `/mcp` se houver servidores externos configurados pelo usuário. O pacote não configura MCPs.

Skills de domínio são carregadas conforme relevância. `cantina-task` e `cantina-resume` têm invocação manual para não disparar execução por conta própria. As demais são curtas e não duplicam regras de produto. Cada tarefa especifica skills por etapa; cantina-task deve invocá-las e registrar evidência. Ver docs/skill-workflow.md e docs/development-tools.md.

As regras em `.claude/rules` possuem `paths`: elas entram quando se leem arquivos correspondentes. Não usar imports de todos os docs no CLAUDE.md: imports também entram no contexto. Manter PROGRESS.md curto e usar evidências duráveis nos arquivos.

O pacote não permite estimar uma porcentagem garantida de economia. A estrutura reduz leitura repetida; consumo real depende da tarefa, histórico, ferramentas, testes e plano. Não reduzir testes de integridade para gastar menos.

## Claude em chat comum

CLAUDE.md/regras/skills de projeto são mecanismos do Claude Code com acesso ao repositório. Colar um prompt no chat comum não faz o Claude instalar ou editar o projeto local automaticamente. Para chat comum, enviar explicitamente os arquivos/tarefa relevantes; algumas propriedades do SKILL.md deste pacote são específicas do Claude Code.

## Documentação oficial consultada

- https://code.claude.com/docs/en/model-config — modelos/IDs, versão mínima e configuração de esforço.
- https://code.claude.com/docs/en/settings — settings compartilhadas/locais e precedência.
- https://code.claude.com/docs/en/memory — CLAUDE.md e rules com paths.
- https://code.claude.com/docs/en/skills — skills de projeto e invocação manual.
- https://code.claude.com/docs/en/costs — contexto, sessões, compactação, MCP e custo.
- https://code.claude.com/docs/en/cli-reference — comandos de CLI.

## Receita local comprovada (F01)

`npm install` → `npm run typecheck && npm run lint && npm test` → `npm run test:rules && npm run test:integration` → `npm run test:e2e`. Cada teste de emulador usa `firebase emulators:exec` com projeto `demo-cantina`; nada acessa produção. Em Windows com SWC bloqueado, `npm run build:webpack`. Ver bloco "Comandos após F01" em CLAUDE.md.
