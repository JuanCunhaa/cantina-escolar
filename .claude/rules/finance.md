---
paths:
  - "src/modules/wallet/**"
  - "src/modules/orders/**"
  - "src/modules/payments/**"
  - "src/modules/fulfillment/**"
  - "src/modules/pos/**"
  - "src/modules/inventory/**"
  - "src/modules/policies/**"
  - "src/lib/money/**"
  - "functions/**"
---

Ler docs/firebase/transactions.md e a regra canônica do domínio alterado. Testar replay, falha e disputa. Não executar I/O externo no callback; não separar livro/saldo/reserva/uso em commits divergentes. IDs estáveis e preços autorizados no servidor.
