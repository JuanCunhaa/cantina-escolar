## 13. PDV de balcão e correção de data

PDV otimizado para um atendente: busca por nome → selecionar aluno correto pela turma → saldo/restrições visíveis → selecionar produtos e quantidades → revisar → confirmar. Atalhos para produtos frequentes e pesquisa de produto. Não exigir câmera, NFC, QR Code ou aplicativo.

Exemplo: aluno compra 10 balas; operador seleciona bala, quantidade 10 e confirma pelo preço do servidor. Debitar saldo, registrar venda com snapshot de preço, baixar estoque e custo, registrar movimentos e marcar entregue, tudo em uma transação. Sem saldo negativo, venda duplicada ou quebra dos limites parentais.

Permita vendas imediatas sem aluno para professor/funcionário, pagas em dinheiro/Pix/cartão e registradas após confirmação do recebimento. Elas usam o mesmo estoque e aparecem separadas por canal/forma. Não creditar uma carteira e registrar venda direta como se fossem dois recebimentos externos. Descobrir/registrar a taxa do pagamento direto quando aplicável.

Se aluno comprou para data errada, operador pode abrir o pedido original e usar “Reagendar/antecipar atendimento”, conforme permissão: conferir disponibilidade hoje, liberar reserva anterior, aplicar reserva/baixa nova, verificar impacto de limites, preservar pagamento/preço e registrar motivo. Não criar segunda cobrança do mesmo lanche. Bypass do fechamento é uma exceção operacional auditada, não uma API pública para o responsável furar horário.

Troca de produto exige disponibilidade e ajuste financeiro pela diferença, com confirmação, motivo e movimentos vinculados. Reembolso nunca ultrapassa valor efetivamente pago. Não alterar fatos históricos apagando a operação anterior.
