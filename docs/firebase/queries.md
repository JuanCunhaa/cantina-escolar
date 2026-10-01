### 18.1 Leitura, busca e relatórios

Declare todas as consultas e índices compostos em firestore.indexes.json: aluno+data+status, data+turno+status para cantina, produto/período e pagamentos por meio/provedor. Use paginação por cursor; escolha IDs aleatórios/estáveis para não confundir ordenação com datas.

Busca por nome: campo normalizado e estratégia de prefixo/tokens testada para a lista de ~300 alunos, disponível somente a funcionários autorizados. Não alegar que Firestore possui busca textual geral irrestrita. Não introduzir serviço externo de busca sem necessidade; uma leitura limitada de diretório protegido para o operador pode ser adequada, documentando o custo e a atualização.

Relatórios não podem depender de varrer toda a base em cada abertura. Projete registros diários/por produto/taxa quando necessário, com ligação ao lançamento de origem. Atualizações de projeção por trigger precisam ser idempotentes: evento pode ser entregue mais de uma vez. Para o volume pequeno, atualizar contadores pertinentes na transação do negócio pode ser mais simples. Projeções são reconstruíveis; o livro de movimentos e snapshots financeiros continuam a fonte.

Relatórios filtrados/exportação devem respeitar autorização. Totais grandes em inteiro/Decimal devem validar faixa segura do JavaScript e conservar precisão ao serializar. Não armazenar saldo em string formatada como “R$ 50,00”.
