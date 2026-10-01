---
name: cantina-testing
description: "Planejar, implementar e executar testes de domínio, concorrência, Firebase Rules e E2E relevantes na Cantina Escolar."
---

# Testar comportamento

Entrada: $ARGUMENTS. Se vier "planejar", definir/implementar casos; se vier "executar", rodar os casos existentes pertinentes. Na falta de modo, seguir necessidade da tarefa.

1. Localizar IDs de aceite da tarefa via scripts/agent-context.ts e ler apenas seus enunciados canônicos em docs/testing. Consultar estratégia quando precisar escolher camada.
2. Regras puras: Vitest ou equivalente TS. Transações/rules: Emulator Suite + testes reais. Jornada visual: Playwright com emuladores/dados fictícios. Gateway: contratos e sandbox real separados.
3. Em comando sensível, incluir replay, mesma chave/payload diferente, duas operações concorrentes, falha intermediária, acesso sem vínculo e conservação de dinheiro/unidades. Usar barreira/concorrência efetiva, não só duas chamadas sequenciais.
4. Planejar regressão antes ou junto ao código quando o risco exigir; evitar teste que apenas repete implementação. Não criar dezenas de testes redundantes para CSS simples.
5. Executar testes relevantes uma vez por mudança, depois typecheck/lint/build conforme risco e marco. Preservar exit code/log bruto via scripts/run-check.ts quando útil.
6. Registrar resultado por critério comprovado. Aceite de fluxo que depende de módulo futuro permanece not_run com nota de evidência parcial. Mocks não provam regras/concorrência; emulador não homologa gateway/cloud.
7. Quando houver falha não trivial, acionar cantina-debug; após correção, repetir checks afetados. F23 executa A01–A38 e regressão integrada, sem dispensar pendências externas.
