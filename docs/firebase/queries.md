### 18.1 Leitura, busca e relatórios

Declare todas as consultas e índices compostos em firestore.indexes.json: aluno+data+status, data+turno+status para cantina, produto/período e pagamentos por meio/provedor. Use paginação por cursor; escolha IDs aleatórios/estáveis para não confundir ordenação com datas.

Busca por nome: campo normalizado e estratégia de prefixo/tokens testada para a lista de ~300 alunos, disponível somente a funcionários autorizados. Não alegar que Firestore possui busca textual geral irrestrita. Não introduzir serviço externo de busca sem necessidade; uma leitura limitada de diretório protegido para o operador pode ser adequada, documentando o custo e a atualização.

Relatórios não podem depender de varrer toda a base em cada abertura. Projete registros diários/por produto/taxa quando necessário, com ligação ao lançamento de origem. Atualizações de projeção por trigger precisam ser idempotentes: evento pode ser entregue mais de uma vez. Para o volume pequeno, atualizar contadores pertinentes na transação do negócio pode ser mais simples. Projeções são reconstruíveis; o livro de movimentos e snapshots financeiros continuam a fonte.

Relatórios filtrados/exportação devem respeitar autorização. Totais grandes em inteiro/Decimal devem validar faixa segura do JavaScript e conservar precisão ao serializar. Não armazenar saldo em string formatada como “R$ 50,00”.

### Alunos e responsáveis (F04)

Busca por nome: `students` por intervalo de prefixo em `nameNormalized` (custo = documentos devolvidos), mais matrícula exata; paginação por cursor (≤ 100 por página) via `GET /api/students`, só para quem tem `students.search` (cantina, secretaria, administração). Não há busca textual por trecho/sobrenome no Firestore: a tela filtra no navegador sobre as páginas carregadas (escola de ~300 alunos = 3 leituras de página; aprox. 300 reads por abertura da lista). A importação CSV lê o diretório inteiro (≤ 5000 documentos) na prévia e na confirmação. Responsável: listeners próprios em `guardianStudentLinks` (guardianUid == uid e status == active) + `students/{id}` + `studentPolicies/{id}` por filho; cleanup quando o vínculo some.

### Calendário (F05)

`GET /api/school/calendar?shiftId=` (qualquer perfil ativo): lê o turno, `settings/school` e `calendarDays` por intervalo de ID (hoje…hoje+7, ≤ 8 documentos). `checkPurchase(db, {shiftId, date, now?}, tx?)` faz as mesmas leituras (turno, settings, 1 dia) e pode rodar dentro da transação do checkout. Tela admin escuta `calendarDays` inteira (≤ ~400 documentos por limite de data).
