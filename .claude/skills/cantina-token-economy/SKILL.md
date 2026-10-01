---
name: cantina-token-economy
description: "Reduzir leituras e saída de ferramentas durante tarefas da Cantina Escolar, preservando regras e evidência."
---

# Economizar contexto

1. Selecionar tarefa e consultar `node scripts/agent-context.ts Fxx` na raiz. O script devolve só os metadados pertinentes, não a documentação inteira. Se essa saída já estiver carregada e válida nesta tarefa, reutilizá-la sem rodar o script novamente. Para mudança sem tarefa, usar `domain:wallet` ou outro domínio.
2. Buscar símbolo com LSP funcional ou rg restrito à pasta; abrir definição/consumidores pertinentes. Não ler dumps, lockfile, todos os testes ou docs completos por hábito.
3. Carregar somente skills previstas para a etapa atual e documentos necessários. Não executar pesquisa de versões se API/versão já estiver verificada no lockfile/decisão e não houve mudança relevante.
4. Rodar checks direcionados. Para comandos com saída extensa, usar scripts/run-check.ts ou RTK já instalado/validado. Preservar status, resultado e log bruto; inspecionar mais quando o resumo não explica falha.
5. Atualizar PROGRESS.md antes de fim de marco/compactação. Na mesma tarefa longa, /compact com estado necessário; em tarefa independente, sessão nova/clear depois de salvar estado.
6. Não ativar vários MCPs/agentes por padrão. Não trocar modelo/esforço preferidos automaticamente nem prometer porcentagem de economia.

O script TypeScript roda com Node 24.12+ sem instalar dependências; isso não realiza typecheck. Instalação de RTK/LSP e alternativas: docs/development-tools.md. Não rodar hooks globais durante uma tarefa sem pedido de configuração do ambiente.
