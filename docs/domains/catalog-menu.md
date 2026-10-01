## 7. Produtos e cardápio

Produto: ID imutável, nome, descrição, categoria, imagem opcional, ativo, preço atual em centavos, canais permitidos (antecipado/balcão), turnos permitidos e modo de disponibilidade. Unidade é sempre unidade de produto. Compras em caixa podem ser convertidas para unidades na entrada, sem inventário por ingrediente.

Não excluir produto referenciado em histórico. Desativar para novas vendas. Nome e preço antigos precisam continuar compreensíveis nos pedidos.

Cardápio padrão diário: conjunto de produtos já cadastrados, com dias de funcionamento/turnos. Exceção por data/turno: adicionar produto extra, ocultar produto padrão, limitar quantidade ou suspender atendimento. Exemplo: dia do hot-dog, pipoca ou picolé. Não criar outro cadastro de produto só porque ele será oferecido numa sexta-feira.

Resolva o cardápio no servidor para aluno, data e turno; indisponível não pode ser comprado enviando ID manualmente. Mudança de cardápio não cancela pedidos pagos silenciosamente: mostre pedidos afetados para administração e preserve o compromisso ou faça cancelamento/reembolso explícito.
