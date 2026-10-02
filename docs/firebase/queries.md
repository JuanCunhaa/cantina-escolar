### 18.1 Leitura, busca e relatórios

Declare todas as consultas e índices compostos em firestore.indexes.json: aluno+data+status, data+turno+status para cantina, produto/período e pagamentos por meio/provedor. Use paginação por cursor; escolha IDs aleatórios/estáveis para não confundir ordenação com datas.

Busca por nome: campo normalizado e estratégia de prefixo/tokens testada para a lista de ~300 alunos, disponível somente a funcionários autorizados. Não alegar que Firestore possui busca textual geral irrestrita. Não introduzir serviço externo de busca sem necessidade; uma leitura limitada de diretório protegido para o operador pode ser adequada, documentando o custo e a atualização.

Relatórios não podem depender de varrer toda a base em cada abertura. Projete registros diários/por produto/taxa quando necessário, com ligação ao lançamento de origem. Atualizações de projeção por trigger precisam ser idempotentes: evento pode ser entregue mais de uma vez. Para o volume pequeno, atualizar contadores pertinentes na transação do negócio pode ser mais simples. Projeções são reconstruíveis; o livro de movimentos e snapshots financeiros continuam a fonte.

Relatórios filtrados/exportação devem respeitar autorização. Totais grandes em inteiro/Decimal devem validar faixa segura do JavaScript e conservar precisão ao serializar. Não armazenar saldo em string formatada como “R$ 50,00”.

### Alunos e responsáveis (F04)

Busca por nome: `students` por intervalo de prefixo em `nameNormalized` (custo = documentos devolvidos), mais matrícula exata; paginação por cursor (≤ 100 por página) via `GET /api/students`, só para quem tem `students.search` (cantina, secretaria, administração). Não há busca textual por trecho/sobrenome no Firestore: a tela filtra no navegador sobre as páginas carregadas (escola de ~300 alunos = 3 leituras de página; aprox. 300 reads por abertura da lista). A importação CSV lê o diretório inteiro (≤ 5000 documentos) na prévia e na confirmação. Responsável: listeners próprios em `guardianStudentLinks` (guardianUid == uid e status == active) + `students/{id}` + `studentPolicies/{id}` por filho; cleanup quando o vínculo some.

### Calendário (F05)

`GET /api/school/calendar?shiftId=` (qualquer perfil ativo): lê o turno, `settings/school` e `calendarDays` por intervalo de ID (hoje…hoje+7, ≤ 8 documentos). `checkPurchase(db, {shiftId, date, now?}, tx?)` faz as mesmas leituras (turno, settings, 1 dia) e pode rodar dentro da transação do checkout. Tela admin escuta `calendarDays` inteira (≤ ~400 documentos por limite de data).

### Catálogo (F06)

- Portal: listener `products where status == active` + `categories` (perfil ativo; ordenação no cliente). Operação: listener de `products` inteiro (catálogo de uma escola: dezenas a poucas centenas de documentos) + `productPrivate` só para administração.
- Histórico de preço: leitura sob demanda `products/{id}/priceHistory orderBy priceVersion desc limit 50` (cantina/administração).
- Servidor: arquivar categoria consulta `products where categoryId == X and status == active limit 1` na transação; venda lê produtos por ID na transação (`readSellableProducts`).

### Cardápio (F07)

- Portal: `GET /api/menu?studentId=` (responsável vinculado, aluno do próprio cadastro sem `studentId`, equipe) — sem listener; o servidor lê aluno/vínculo/política (3), turno, `settings/school`, `calendarDays` da janela (≤ 8), as 8 exceções `menuOverrides/{data}__{turno}` por ID, `defaultMenuRules where shiftIds array-contains turno`, `products where status == active` e `categories` (≈ 30 + produtos + categorias leituras por abertura/foco da página; escola: dezenas a poucas centenas). A tela busca de novo ao voltar ao foco; o checkout revalida tudo.
- Operação (cantina/administração): listeners de `defaultMenuRules` (coleção inteira, ≤ nº de produtos), `menuOverrides/{data}__{turno}` (1 documento) e `menuOverrides where date >= hoje orderBy date limit 100`, mais `settings/school` e `calendarDays/{data}` para avisar dia sem funcionamento.
- Venda (F11/F15): `readMenuForSale` lê por ID na transação — 1 exceção + N produtos + N regras.
