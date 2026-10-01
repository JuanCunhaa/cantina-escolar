## 14. Cancelamentos e reembolsos

Responsável pode cancelar pedido não entregue até o prazo independente do turno. Aluno não cancela sozinho por padrão. Administração/cantina autorizada pode cancelar depois do prazo com motivo. Pedido entregue não possui cancelamento familiar; correção administrativa exige fluxo de estorno e tratamento do produto.

Reembolso de pedido volta SOMENTE à carteira do aluno que pagou. Não devolve Pix/cartão nem muda de aluno porque um responsável está logado. Reembolso parcial calcula valor efetivo pago pelos itens/quantidades cancelados, inclusive rateio consistente de desconto quando existente; preserve centavos totais e limite pelo saldo reembolsável original.

Cancelamento é atômico: ler o estado/versão do pedido na transação Firestore, verificar quantidade ainda cancelável, registrar cancelamento, creditar carteira, movimento, liberar reserva/cota e auditar. Dois responsáveis cancelando juntos ou um atendente entregando ao mesmo tempo não podem gerar entrega e devolução indevidas. Identifique todas as ações de quem opera.

Trate separadamente dinheiro e disponibilidade física:
- Produto ainda não entregue e não consumido: liberar reserva, sem inventar nova entrada física.
- Produto planejado ainda não produzido: liberar cota.
- Produto preparado que pode ser reaproveitado com segurança operacional: manter unidade física disponível conforme decisão do operador.
- Produto descartado: baixa de perda com custo e motivo, mesmo que o dinheiro tenha voltado à carteira.
