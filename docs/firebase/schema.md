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

### Campos de acesso (F03)

Contrato de acesso já usado por Rules, servidor e testes; F04+ criam/gerenciam os documentos, mas devem respeitar estes nomes.

- `users/{uid}`: `email`, `displayName`, `role` (`guardian|student|cantina|secretaria|admin`), `status` (`active|disabled`), `permissions` (lista de extras; hoje só `topup.reverse`, só secretaria), `accessVersion` (inteiro ≥ 1, +1 a cada mudança), `updatedAt`. Fonte ATUAL do papel (a claim do token não é usada). Escrita só pelo servidor (`setUserAccess`); o dono lê o próprio documento. Conta autenticada sem perfil ativo não lê nada.
- `students/{studentId}`: além dos campos de F04, `status` (`active|inactive`) e `userUid` (uid do login do aluno ou `null`). Perfil necessário para equipe, responsável vinculado ativo e o próprio aluno; sem custos/dados administrativos.
- `guardianStudentLinks/{guardianUid_studentId}`: `guardianUid`, `studentId`, `status` (`active|revoked`). Revogar = `status: revoked` (nunca apagar). O responsável lista os próprios vínculos com `where guardianUid == uid` e `status == active`.
- `studentPolicies/{studentId}`: `allowSitePurchase`, `allowCounterPurchase` (booleanos; ausência = negado), mais limites/bloqueios de F09. Leitura: PDV/administração, responsável vinculado e o próprio aluno (secretaria não).
- `auditLog/{id}`: `action`, `actorUid`, `actorRole`, `target{type,id}`, `reason`, `before`, `after`, `createdAt`. ID derivado da operação; criada na mesma transação do comando; nunca lida nem escrita pelo cliente.

### Cadastros, vínculos e convites (F04)

Escritas só pelo servidor (Admin SDK) em transação com auditoria; o cliente lê apenas o que as Rules abrem.

- `classes/{classId}` e `shifts/{shiftId}`: `name`, `nameSlug`, `status` (`active|archived`), `createdAt`, `updatedAt`. ID `cls_…`/`shf_…` derivado de (ator, chave). Leitura por qualquer conta com perfil ativo (só nomes); arquivar é bloqueado enquanto há aluno ativo; unidade arquivada não aceita novos alunos.
- `students/{studentId}` (ID `stu_…` derivado de ator+chave, nunca do nome): `enrollment` (normalizada: caixa alta, sem espaços; imutável), `name`, `nameNormalized` (busca por prefixo), `classId`, `shiftId`, `status`, `userUid` (login opcional), `version` (+1 a cada alteração; checkout/pedidos devem ler), `createdAt`, `updatedAt`. Sem foto, QR nem dados administrativos.
- `uniquenessKeys/enrollment_{MATRÍCULA}` → `{studentId}`: unicidade da matrícula, criada na mesma transação do aluno (nunca liberada, nem ao arquivar). `uniquenessKeys/class_{slug}` / `shift_{slug}`: unicidade de nome de turma/turno (trocada na renomeação). `uniquenessKeys/studentLogin_{uid}`: uma conta de aluno ↔ um aluno.
- `studentPolicies/{studentId}`: criado com o aluno (`allowSitePurchase:false`, `allowCounterPurchase:false`, `configVersion:1`); alterações por `POST /api/policies` (qualquer responsável vinculado ativo ou administração), `configVersion` +1, `updatedBy`, auditoria com autor.
- `guardianStudentLinks/{guardianUid_studentId}`: além do contrato F03, `source` (`admin|invitation`), `createdBy`, `invitationId?`, `revokedBy/revokedAt` ao revogar (nunca apagado). Não existe "responsável principal".
- `invitations/{sha256 do token}`: `kind` (`guardian|student`), `studentId`, `status` (`pending|used|revoked`; "expirado" é derivado de `expiresAt`), `expiresAt`, `createdBy`, `createdByRole`, `usedBy/usedAt`, `revokedBy/revokedAt`. O token (256 bits) NÃO é gravado; só aparece na resposta da criação. Validade 1 h–14 dias (padrão 72 h), no máximo 5 pendentes por aluno. Fechado ao cliente (Rules negam).
- `users/{uid}.contact` (opcional, responsável, texto ≤ 60): gravado no resgate do convite; `setUserAccess` usa `merge` e preserva o campo.
- `auditLog` (ações F04): `school.{class|shift}.{create|rename|archive|restore}`, `student.create`, `student.update`, `student.import` (resumo), `student.login.revoke`, `link.add`, `link.revoke`, `policy.set`, `invitation.create|revoke|redeem`.
- Índices: nenhum composto necessário (consultas só de igualdade ou intervalo em um campo + ordenação pelo mesmo campo; `firestore.indexes.json` segue vazio). Diretório de alunos: leitura paginada por cursor, ordenada por `nameNormalized`.
