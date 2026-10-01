## 4. Papéis, cadastros e vínculos

### 4.1 Administração
Pode administrar produtos, categorias, preços, compras, estoque, perdas, calendário, turnos, horários, alunos, responsáveis, funcionários, meios de pagamento, taxas e relatórios. Pode cancelar/reagendar excepcionalmente e corrigir lançamentos por estorno auditável. Não pode apagar fatos financeiros para “corrigir” o saldo.

### 4.2 Cantina
Pode buscar aluno pelo nome, visualizar identificação, turma, turno, saldo e restrições necessárias à venda; operar PDV, visualizar pedidos e quantidades a preparar, entregar, registrar não retirada e cancelar/reagendar conforme permissão. Não recebe automaticamente acesso a custos, lucro, cadastro de funcionários ou ajustes livres de saldo.

### 4.3 Secretaria
Pode localizar aluno e registrar recebimentos confirmados de dinheiro, Pix e cartão de maquininha, consultar as recargas necessárias à conferência e emitir comprovante interno. Permissão de estorno manual configurada separadamente. Não recebe acesso a lucros e custos apenas por poder recarregar.

### 4.4 Responsável
Tem acesso completo aos alunos vinculados: saldo, recargas, transferências permitidas, pedidos, extratos, limites e bloqueios. Pode comprar e cancelar dentro das regras. Um responsável pode estar ligado a vários alunos; um aluno pode ter vários responsáveis. TODOS os responsáveis vinculados têm a mesma capacidade de administrar a conta; não criar “responsável principal”. Uma mudança vale para a conta do aluno, não somente para quem a fez, e fica auditada.

### 4.5 Aluno
Cadastro de aluno não exige que ele tenha login. A escola/responsável pode ativar acesso por convite, usando a autenticação estabelecida. Nome serve para busca no balcão, não como credencial de autenticação.

O responsável pode conceder/revogar separadamente: compra pelo site e compra no balcão com saldo. Sem permissão de compra, o acesso do aluno pode ser de consulta. Revogar permissão não apaga pedidos existentes nem movimenta saldo. Restrições são verificadas no backend e no PDV, não somente nos botões da tela.

### 4.6 Cadastros

Aluno: identificador/matrícula única interna, nome, turma, turno, ativo/inativo, responsáveis vinculados e eventual acesso de usuário. Não exigir foto ou QR Code. Resultado da busca por nome deve exibir turma/turno para diferenciar homônimos.

Responsável: nome, email/login, contato opcional, situação e alunos vinculados. Funcionário: conta individual e papel/permissões. Turmas e turnos podem ser cadastrados pelo administrador.

O cadastro/vínculo deve ser feito por administração ou convite validado; uma pessoa não ganha acesso ao saldo de uma criança apenas pesquisando seu nome. Convites devem ser limitados, expirar e ser de uso único. Disponibilize importação CSV de alunos com prévia, validação e tratamento de duplicidades.

Arquive/desative cadastros sem quebrar histórico. Mudança de turma/turno não altera retroativamente o turno salvo em um pedido pago. Trate pedidos futuros afetados em tela de revisão, com decisão explícita de administração.
