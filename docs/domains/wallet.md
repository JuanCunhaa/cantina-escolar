## 5. Carteira por aluno

Cada aluno possui UMA carteira individual em BRL. Não existe carteira familiar compartilhada. O responsável vê o total consolidado dos filhos e cada saldo individual.

Exemplo: aluno A tem R$ 50, gasta R$ 10 e fica com R$ 40; aluno B tem R$ 20, gasta R$ 10 e fica com R$ 10. Nenhuma compra de A debita B automaticamente.

Permita transferir saldo disponível entre alunos aos quais o responsável tenha vínculo ativo com autorização. Verifique acesso às DUAS carteiras. Registre duas pernas ligadas pelo mesmo ID: débito da origem e crédito do destino. Total das carteiras não muda, não há nova receita nem taxa de pagamento nessa transferência. A transação Firestore lê as duas carteiras e o registro de idempotência antes de gravar as duas pernas; conflitos são tratados pela transação e nenhum saldo fica negativo ou é duplicado em retentativas.

A carteira deve ter livro de movimentos imutável: recarga confirmada, compra antecipada, compra de balcão, reembolso de pedido, transferência enviada/recebida e ajuste/estorno autorizado. Saldo pode ser armazenado como projeção protegida, mas precisa ser reconciliável com o livro. Ajustes são novos movimentos com motivo e referência ao lançamento original; não alteração/destruição de um pagamento já confirmado.

Desconte o valor TOTAL de um pedido antecipado imediatamente na confirmação. Não use saldo pendente de Pix ou cartão. O valor já debitado não continua disponível para transferir ou gastar. “Pedido pendente” significa pendente de entrega, não de pagamento.

Use centavos inteiros para saldo, preços e pagamentos. Custos médios exigem precisão decimal maior: use Decimal no cálculo e serialize valores decimais exatos como strings ou unidades inteiras escaladas documentadas no Firestore, definindo arredondamento em centavos na saída e conservação do valor remanescente do estoque. Não use ponto flutuante binário como fonte financeira.
