## 18. Modelo de dados no Firestore

Crie modelo documental próprio, sem entidades de tenant. Sugestão de coleções/subcoleções, a ajustar com justificativa:

- users/{uid}: perfil e papéis; senhas/sessões de identidade pertencem ao Firebase Auth.
- students/{studentId}: matrícula, nome normalizado para busca, turma, turno e situação; não incluir custos/dados administrativos em documento público familiar.
- guardianStudentLinks/{guardianUid_studentId}: vínculo ativo e permissões; child access mapping correspondente.
- classes, shifts, settings, calendarDays e invitations.
- studentPolicies/{studentId}: permissões, limites, bloqueios e versão de configuração.
- wallets/{studentId}: saldo projetado em centavos e versão; wallets/{studentId}/entries/{entryId}: livro imutável.
- walletTransfers/{transferId}: referências das duas pernas.
- studentUsage/{studentId}/days/{localDate} e weeks/{weekStart}: comprometimento de consumo atualizado na mesma transação da operação.
- products, categories, priceHistory, defaultMenuRules, menuOverrides.
- dailyCapacity/{productId_date_shift}: cota/comprometimento de produto planejado.
- stockBalances/{productId}, stockReceipts, stockMovements, stockReservations e lotes quando usados.
- orders/{orderId}: aluno, data local, turno, ator, status, total, versões/prazos e snapshots de itens com tamanho limitado. Itens/eventos podem ser subcoleções se isso servir às operações, mas entrega/cancelamento precisam de IDs diretos para validar a transação.
- paymentMethods, paymentProviders, terminalAccounts, feeRules, topups, paymentTransactions e paymentEvents.
- cashSessions, reconciliationCases, auditLog e idempotencyRecords.
- reportingDaily, reportingProductDaily e reportingFeeDaily: projeções mínimas para relatórios conforme necessidade.
- uniquenessKeys: somente quando necessária para preservar matrícula/referência única em transação.

Firestore não possui JOIN/FK/UNIQUE como banco SQL. Referências, autorização, consistência e unicidade precisam de transações e IDs determinísticos. Carteira tem ID do aluno; evento externo e idempotência têm IDs derivados da identidade completa (provedor/conta/evento, usuário/ação/chave), com formato seguro e validação de payload. Não usar MAX + 1 nem presumir que consulta prévia fora da transação garante unicidade.

Não gravar arrays crescentes de todos os pedidos, movimentos ou imagens em um documento. Limite carrinho e lote semanal para caber em limites de documentos/gravações/transação e não surpreender o usuário. Declare a operação máxima suportada e teste o limite. Não usar um documento global de saldo/estoque de toda a escola como gargalo único.

Cada transação sensível lê documentos conhecidos e pequenos: carteira, política, aluno/vínculo, uso diário/semanal, produtos/estoque/cotas, idempotência e pedido quando aplicável. Faça todas as leituras necessárias antes das gravações, conforme o SDK adotado. IDs e resultados devem ser estáveis nas retentativas; efeito HTTP/email/upload fica fora do callback. Não depender de total calculado por consulta de pedidos fora da transação para garantir um limite: use documentos de comprometimento por aluno/data/semana.

Cadastros mutáveis, permissões e estoque que invalidam um checkout devem estar incluídos na leitura transacional relevante. Não manter saldo e livro em transações separadas. Transferência, entrega parcial e reagendamento precisam da mesma disciplina.
