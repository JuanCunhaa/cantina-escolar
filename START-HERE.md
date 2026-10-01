# Começar o desenvolvimento

1. Extrair o pacote e abrir a pasta cantina-claude no VSCode/Cursor/terminal. Se houver repositório existente, fazer cópia/commit antes de mesclar e preservar seus arquivos; não sobrescrever instruções em conflito.
2. Ter Claude Code instalado e autenticado. Verificar `claude --version`; Sonnet 5.5 exige v2.1.284+ conforme documentação consultada. Atualizar com `claude update` quando necessário.
3. Dentro da pasta, executar:

```bash
claude --model claude-sonnet-5-5
```

4. Dentro do Claude Code:

```text
/cantina-task F01
```

Como alternativa, colar o pedido completo abaixo:

```text
Você é responsável por desenvolver integralmente a Cantina Escolar descrita neste repositório. Use Claude Sonnet 5.5, quando disponível, preservando TypeScript strict, Next.js, Firebase Auth/Firestore e arquivos no Cloudflare R2 (migração aprovada em 01/10/2026).

Comece lendo CLAUDE.md, PROGRESS.md e docs/tasks/F01.md. Leia apenas os documentos e critérios necessários para essa tarefa. Execute F01 por completo: inicialize a aplicação no diretório atual sem sobrescrever a estrutura, configure emuladores/ambientes e prove login, listener privado e comando servidor transacional com duas contas isoladas. Entregue comportamento funcionando e testado, não somente plano ou telas.

Resolva escolhas rotineiras pelas regras do projeto e fontes oficiais; registre decisões duráveis. Não invente requisito, API, credencial, resultado de teste ou integração homologada. Avance em partes independentes se faltar informação externa. Atualize PROGRESS.md e evidências ao final. Nesta sessão, conclua F01; o desenvolvimento integral seguirá nas tarefas F02–F24.
```

Para continuar depois:

```text
/cantina-resume
```

Para uma tarefa específica:

```text
/cantina-task F08
```

F01 cria package.json, lockfile e scripts: não executar npm install/dev antes de a aplicação ser inicializada. Firebase rules iniciais negam tudo e os índices ainda estão vazios; o agente precisa implementá-los com evidência. A estrutura completa organiza a implementação, mas não afirma que o sistema já existe.

Guia de contexto/modelo: docs/claude-code.md. Cronograma/dependências: docs/tasks/index.md. Pendências reais: docs/external-dependencies.md.

Cada tarefa já orienta qual skill usar para contexto, Firebase, segurança, testes e interface. Não é necessário pedir manualmente todas as skills a cada sessão. Para uso independente, consultar docs/skill-workflow.md. Ferramentas externas têm instruções e estado explícito em docs/development-tools.md; não foram instaladas na sua máquina pelo pacote.
