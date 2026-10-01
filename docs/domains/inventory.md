## 15. Estoque por unidade, compras e produção

Não implementar receitas, ingredientes ou ficha técnica. O custo de um produto produzido pode ser informado como custo unitário do lote de produto acabado.

### 15.1 Dois modos simples

1. Estoque físico: bebidas, doces, produtos comprados prontos. Pedido antecipado reserva unidades livres; físico não baixa na reserva. Disponível = físico vendável − reservas ativas. PDV não vende reservas de outros pedidos. Não permitir usar lote vencido para data de consumo.
2. Disponibilidade planejada por data/turno: hot-dog, lanche do dia etc. Administração estabelece cota de produção/compra; pedido reserva cota futura, sem inventar estoque hoje. Registrar entrada de produto acabado com quantidade, custo unitário e data de disponibilidade antes de entrega. Entrega consome unidade física elegível para o dia e baixa a reserva planejada, sem duplo desconto de cota/estoque. Sobras podem virar disponibilidade de balcão ou perda mediante ação explícita.

O modo deve ficar claro no cadastro e nas telas. Ambos vendem por unidade. Não aceite estoque físico negativo. Uma entrega sem entrada/custo necessários deve informar precisamente o que registrar; não inventar custo zero para esconder cadastro incompleto.

### 15.2 Entradas e custos

Entrada: produto, quantidade em unidades, custo unitário Decimal, total, data, fornecedor opcional, documento/referência opcional, lote/validade opcionais, operador e observação. Toda nova compra cria entrada separada. Exemplo: 100 unidades a R$ 1 e outra compra de 100 a R$ 1,10 são duas entradas, não edição do primeiro custo.

Usar custo médio móvel ponderado como método inicial. Média calcula sobre quantidade/valor ainda em estoque antes da entrada, não sobre todas as compras desde o início. Precisão e arredondamento devem preservar valor residual. Se validade/lote for registrado, seleção física pode priorizar vencimento sem confundir isso com método contábil do custo.

Saldo de estoque, entradas, saídas, reservas, liberação, ajustes, perdas e custo devem ser reconciliáveis. Reserva não é saída contábil; não altera custo médio. Na saída definitiva, salvar custo unitário e custo total históricos. Receita de compra futura tem margem estimada até a saída real; mostrar a diferença claramente.

Não alterar custo/preço de saída histórica porque mudou o cadastro ou chegou nova compra. Correção de entrada equivocada deve usar estorno e novo lançamento com trilha; quando já houver consumo, impedir alteração simples e apresentar tratamento de ajuste. Não executar reposição retrospectiva silenciosa de todas as vendas.

### 15.3 Operações complementares

Contagem física/inventário, ajuste por divergência, estoque inicial, perdas por vencimento/quebra/descarte e consumo interno. Motivos obrigatórios e permissões específicas. Alertas de estoque baixo, validade quando cadastrada e compromissos futuros. Uma perda que afeta unidades reservadas deve destacar pedidos comprometidos para tratamento, em vez de permitir venda/entrega fictícia.
