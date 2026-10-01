## 10. Compra antecipada e preço histórico

Fluxo: escolher aluno → escolher data → visualizar turno/cardápio → selecionar unidades → revisar identificação, data por extenso, turno e total → confirmar → debitar saldo e reservar disponibilidade → mostrar pedido pago/agendado.

Cada pedido é para um aluno, uma data e um turno. Para uma semana, permitir montar compras para várias datas em uma sequência conveniente, mas crie pedidos separados por data. Se oferecer confirmação única da semana, trate a confirmação como lote atômico de pedidos ou apresente falhas por data sem cobrar itens rejeitados; escolha e documente a abordagem. Prefira lote tudo-ou-nada para evitar cobrança parcial inesperada.

No item pago, preserve snapshot de nome, unidade, quantidade, preço unitário autorizado, desconto efetivo se houver, subtotal e total. Preço de produto alterado de R$ 8 para R$ 9 depois da compra não muda o pedido de R$ 8. O servidor calcula preços; valores enviados pelo cliente são apenas indicação para detectar que o preço mudou e pedir revisão.

Se preço variar entre visualização e confirmação, não cobrar valor maior silenciosamente. Retorne atualização do carrinho e peça confirmação do novo total. Quantidades devem ser inteiras positivas e limitar abuso de requisição.

O checkout precisa ser transacional: autenticar, autorizar vínculo/ator, revalidar período, produtos, preço, limites, saldo e disponibilidade; criar pedido/itens; debitar carteira; criar movimento; reservar unidades/cota; auditar; commit. Falha em qualquer etapa não pode deixar pedido sem cobrança, cobrança sem pedido ou estoque parcialmente reservado. Use idempotency key associada a usuário/ação/payload, retornando a mesma resposta em retries.
