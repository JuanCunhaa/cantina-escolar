---
name: cantina-task
description: "Executar uma tarefa F01–F24 acionando skills por etapa e registrando implementação/evidência."
disable-model-invocation: true
---

# Executar tarefa com skills

Tarefa solicitada: $ARGUMENTS.

1. Ler CLAUDE.md/PROGRESS.md. Executar `node scripts/agent-context.ts <Fxx>` na raiz para obter só contexto/workflow da tarefa. Se ID ausente, selecionar primeira elegível em docs/tasks/index.md, verificando código/dependências reais.
2. Ler docs/tasks/<Fxx>.md e documentos pertinentes. Acionar cantina-token-economy para contexto e as skills da seção "Skills integradas" usando ferramenta Skill, na ordem da etapa atual; passar objetivo restrito para cada uma.
3. Planejar testes do risco real, implementar persistência/domínio/interface e revisar acesso. Skill não substitui código e não prova teste. Não carregar antecipadamente todas as skills nem recursar em cantina-task.
4. Usar cantina-research somente quando API/versão for desconhecida; cantina-debug se falhar. Reutilizar serviço/regra canônica; não executar checagem igual em cada skill.
5. Acionar cantina-verify para checks finais da tarefa. Registrar nomes das skills realmente invocadas (ou lidas se Skill indisponível), comandos/status e evidências por aceite em PROGRESS.md/docs/status.
6. Se Node compatível não estiver disponível, ler a seção Fxx do mapa e o SKILL.md necessário diretamente; registrar fallback. Não inventar instalação/execução.
7. Resumir resultado, validação e próxima tarefa. Concluir este marco integrado; seguir projeto inteiro em tarefas posteriores, sem tratar pastas/mocks como aplicação pronta.

Não publicar, habilitar faturamento ou mover dinheiro real pelo simples uso desta skill. Credencial ausente vira pendência concreta; continuar partes independentes.
