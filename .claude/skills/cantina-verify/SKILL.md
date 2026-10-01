---
name: cantina-verify
description: "Coordenar checks finais de uma tarefa ou marco da Cantina Escolar sem repetir testes já comprovados."
---

# Verificar marco

1. Identificar tarefa/arquivos alterados e aceites via scripts/agent-context.ts; ler a estratégia necessária.
2. Consultar o que cantina-testing/cantina-security já executaram após a última mudança. Reusar evidência válida; não repetir os mesmos comandos só porque chegou outra skill.
3. Acionar cantina-testing no modo executar para casos ainda não comprovados, typecheck/lint e build conforme risco/marco. Se surgiu risco de acesso/segredo, acionar cantina-security só no escopo afetado.
4. Usar scripts/run-check.ts para log extenso ou RTK validado; preservar exit code e abrir log bruto necessário em falha. Ferramenta ausente não equivale a passou.
5. Registrar evidência por critério inteiro e pendências externas; A01–A38 são revisados globalmente em F23. Não prometer funcionamento cloud usando apenas emulador.
6. Corrigir falhas e repetir somente checks afetados. Registrar skill invocada/lida e resultado real, sem afirmar que validou Firebase/gateway se apenas validou documentação.
