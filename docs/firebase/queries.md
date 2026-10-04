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

### Meus pedidos, detalhe, recibo e extrato (F12)

- `GET /api/orders` (histórico), `GET /api/orders/{id}` (detalhe + recibo interno) e `GET /api/wallets/entries` (extrato): sempre pelo servidor autenticado, com vínculo/perfil lidos na hora (`orders.read` = responsável vinculado ativo, o próprio aluno ou administração; `wallet.read` no extrato). `orders` e `wallets/*/entries` não são lidos pela família diretamente nos pedidos: o documento do pedido tem dados internos (reservas, autor, exceção, política) e as Rules autorizam documento inteiro, então o servidor devolve uma VISÃO só com o que a família vê (snapshot da compra: nome, preço, quantidade, subtotal, total, turno, data, situação).
- Histórico: uma consulta por aluno do escopo (`studentId ==` [+ `status ==`/`in`, `channel ==`, `shiftId ==`] + intervalo de `consumptionDate`, `orderBy consumptionDate desc, orderId desc`, `limit + 1`), fundidas em memória. A ordem é total e igual para todos os alunos, então o cursor opaco `{data, orderId}` (`startAfter`) não duplica nem omite itens entre páginas, mesmo com datas repetidas e pedidos novos chegando. Página padrão 20, máximo 50; custo ≈ (alunos × (limit + 1)) leituras + ≤ 1 leitura por aluno/turno exibido + turnos ativos só na 1ª página. Sem varredura do histórico inteiro.
- Abas: Pendentes/Concluídos/Cancelados = `status in [lista fechada do grupo]` (`STATUS_INFO` em `src/modules/orders/history-model.ts`). Toda situação nova (F13–F15) entra nessa tabela junto com a tarefa que a produz; situação fora dela aparece só em "Todos".
- Extrato: sem período `orderBy seq desc` (contíguo, sempre presente: nenhum movimento some do extrato); com período `createdAt desc, seq desc` (fim exclusivo no dia seguinte, fuso de São Paulo). Filtro de tipo por `type ==`.
- Índices (`firebase/firestore.indexes.json`): `orders` (studentId, [status | channel | shiftId], consumptionDate desc, orderId desc) e `entries` (type | createdAt desc, seq desc | type + seq desc). **O emulador NÃO exige índice**: a criação/uso na nuvem fica pendente de `staging:deploy` e de uso real.
- Tempo real: o portal assina SÓ `wallets/{aluno}` (um documento por aluno do escopo, responsável vinculado; o aluno com login não tem leitura da carteira e relê ao voltar o foco/botão). Quando a `version` da carteira sobe, a 1ª página é relida e reconciliada por `version` do pedido; snapshot de cache é ignorado e nunca confirma compra. Assinaturas encerram na troca de conta/aluno/filtro e na desmontagem; respostas de gerações anteriores são descartadas.

### Pedidos do dia e O que preparar (F13)

- `GET /api/operations/orders?date&shiftId&classId&status&q` (`orders.operate`): `orders where consumptionDate == data [and shiftId == turno] limit 1001` (só igualdades: sem índice composto). Turma/situação/nome (sem acento) são filtrados no servidor sobre ≤ 1000 pedidos; a turma é a atual do aluno (`students/{id}` por `getAll` em blocos de 300). Resposta: `canDeliver` (= data é hoje), `counts` por situação, `truncated`, classes e turnos ativos. Ordenação: turma, nome, ID.
- `GET /api/operations/preparation?date&shiftId`: (1) dia: a mesma consulta acima; (2) previsão: `orders where consumptionDate >= hoje and <= hoje+6` limit 3001 (um intervalo num só campo, sem composto; o turno é filtrado em memória porque `shiftId ==` + intervalo de data exigiria o composto shiftId+consumptionDate — detectado pelo smoke na HML, que o emulador não cobra); (3) pendências: `orders where status == "not_picked_up"` (campo único) e `orders where status in [paid, preparing, ready, partially_delivered] and consumptionDate < hoje` — esta exige o índice composto novo `orders (status asc, consumptionDate asc)` em `firebase/firestore.indexes.json` (não validado na nuvem até o deploy e a espera do estado READY; ver docs/status/firebase-homologation.md). Totais por produto/data/turno: `aggregatePreparation` (conservação: agendadas = canceladas + entregues + restantes + não retiradas).
- Detalhe do pedido (F12) lê também `orders/{id}/deliveries orderBy seq limit 100` (campo único).
- Tempo real: nenhum listener (as telas leem pela API, relêem após cada comando, no botão Atualizar e ao voltar o foco). `orders` não é legível pelo cliente.
- `GET /api/operations/preparation?scope=attention` lê só as duas consultas de pendências (sem dia nem previsão): é o que a lista do dia usa para o aviso. O teto da previsão (3000) é aplicado ANTES do filtro de turno em memória: com muitos pedidos o turno escolhido pode ficar incompleto — a resposta marca `truncated`.
