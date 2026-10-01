## 11. Meus pedidos

Tela obrigatória no portal, com abas/filtros Pendentes, Concluídos, Cancelados e opcional Todos.

- Pendentes: pagos/agendados, em preparação, prontos e não retirados ainda sem resolução.
- Concluídos: entregues, incluindo compra imediata no balcão.
- Cancelados: totalmente cancelados com registro de reembolso. Cancelamento parcial mantém o pedido no grupo adequado com badge de parcial e itens detalhados.

Filtros adicionais: aluno, período de consumo, turno, canal e situação detalhada. Responsável pode ver um filho ou todos os vinculados; aluno vê somente seus pedidos.

Mostrar código, aluno, turma, data com dia da semana, turno, produtos, quantidades, preço histórico, total, origem e situação. Destaque próximos pedidos, por exemplo “Amanhã, quarta-feira — manhã”. Detalhe apresenta criação/pagamento, entrega, cancelamento, autor da compra, motivo e crédito de reembolso.

Botão cancelar somente quando elegível; apresentar prazo e confirmação com valor que retorna à carteira. Botões desabilitados explicam o motivo sem revelar implementação. Extrato e recibo interno acessíveis. Paginação por cursor e filtros com índices Firestore, sem carregar histórico inteiro desnecessariamente.
