---
name: cantina-finance
description: "Implementar ou revisar carteira, checkout, reembolso, entrega, transferência, recarga ou estoque com transações idempotentes na Cantina Escolar."
---

# Preservar integridade

1. Roteiar $ARGUMENTS pelo docs/context-map.json; ler docs/firebase/transactions.md e os domínios envolvidos.
2. Listar invariantes e documentos da transação. Ler política/vínculo/estado atual relevantes; todas as leituras precedem escritas.
3. Implementar autorização servidor, chave/payload idempotentes, IDs estáveis, livro imutável e resultado atômico. Manter I/O externo fora do callback.
4. Executar aceites de falha/replay/concorrência no Emulator Suite. Conferir conservação de dinheiro/unidades, custo residual e ausência de cobrança/reembolso duplicados.
5. Para gateway, consultar docs/domains/payments.md e documentação oficial do adapter escolhido; não dar crédito pelo browser/redirect.
6. Atualizar evidência e decisões; não declarar integridade usando somente mocks.
