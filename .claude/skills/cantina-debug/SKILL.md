---
name: cantina-debug
description: "Diagnosticar falha de teste, Firebase, listener, build, transação ou integração da Cantina Escolar com leitura direcionada."
---

# Diagnosticar e corrigir

1. Reproduzir a menor falha relevante, registrar comando/status e ambiente. Ler log bruto específico se resumo de RTK/run-check for insuficiente.
2. Formular hipótese ligada a evidência e localizar símbolo/consumidores com LSP/rg; não reler todos os docs nem mudar arquivos sem relação.
3. Em Firebase, distinguir Auth Web/cookie/Admin/rules/índice/emulador/projeto. Em transação, inspecionar leitura, retry e consistência de todos os documentos. Em gateway, separar simulação/contrato/sandbox real.
4. Corrigir causa no escopo e adicionar regressão de negócio quando útil. Não esconder erro, relaxar rules, remover assertiva ou instalar dependência aleatória para fazer teste passar.
5. Rodar checks afetados e registrar evidência. Não marcar hipótese como fato ou reiniciar sessão sem preservar estado em PROGRESS.md.
