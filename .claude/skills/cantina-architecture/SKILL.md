---
name: cantina-architecture
description: "Definir ou revisar fronteiras de domínio, schema, transações e contratos quando uma tarefa da Cantina Escolar alterar arquitetura."
---

# Decidir arquitetura necessária

1. Ler docs/architecture.md e somente domínio/schema relevante. Preservar stack, uma escola e domínio próprio; não introduzir plataforma genérica/microsserviços.
2. Definir fronteira entre regras puras, serviços, Firestore repositories e handlers finos. Backend tem comando único; React/listener não são a regra do negócio.
3. Para mudança de schema/contrato, listar invariantes, consultas/índices e projeções reconstruíveis. Em finanças, acionar cantina-finance; em Firebase, cantina-firebase.
4. Escolher solução simples que cumpre o escopo; registrar decisão/limites/migração no documento canônico. Implementar logo após decidir, evitando planejamento sem entrega.
5. Se alteração exige preferência de produto ausente, explicitar dúvida concreta; rotina de implementação não exige nova aprovação.
