---
name: cantina-resume
description: "Retomar tarefa em andamento ou próxima tarefa elegível da Cantina Escolar seguindo suas skills integradas."
disable-model-invocation: true
---

# Retomar execução

1. Ler CLAUDE.md/PROGRESS.md e inspecionar arquivos/diff citados. Preservar trabalho não commitado.
2. Retomar tarefa em andamento ou selecionar próxima elegível pelas dependências reais. Consultar metadados com `node scripts/agent-context.ts <Fxx>` e ler a tarefa.
3. Aplicar diretamente o mesmo workflow de cantina-task: acionar somente skills da etapa atual e condicionais relevantes. Não invocar cantina-task por ferramenta se sua invocação pelo modelo está desabilitada.
4. Executar implementação/verificação e registrar progresso/nomes de skills/evidência. Não reler todo o escopo nem reexecutar checks válidos sem mudança.
5. Se falta dado externo, registrar bloqueio e continuar trabalho independente elegível. Não tratar sandbox pendente como homologação concluída.
