### 2.3 Realtime, login e backend seguro

Firestore listeners fornecem dados de leitura: saldo atualizado, pedido que muda de estado, disponibilidade e filas da cantina. Checkout, entrega, cancelamento, recarga, transferência e ajustes são comandos do servidor com transações Firestore, validação e idempotência.

Mantenha Firebase Auth ativo no browser para que Security Rules recebam request.auth nos listeners. Para páginas/handlers protegidos, verifique Firebase ID token ou use session cookies oficiais criados via Admin SDK; se usar cookie, configure HttpOnly/Secure/SameSite, proteção de origem/CSRF, expiração e logout/revogação coerentes. Não presumir que cookie de servidor autentica automaticamente o listener Web SDK. Não limpar a sessão Firebase do browser e depois abrir listener privado sem identidade.

Admin SDK ignora Firestore Security Rules: todo handler que o utiliza deve verificar usuário, papel, vínculo e política, mesmo com rules perfeitas. Custom claims podem representar papéis gerais, mas vínculo familiar, bloqueios e permissões mutáveis precisam de fonte atual no Firestore. Não confiar somente em claim antiga para permitir uma operação após revogação.

Listeners devem usar consultas limitadas e autorizáveis pelas rules. Fazer unsubscribe em desmontagem/logout/troca de aluno, tratar reconexão/erro e sinalizar dado de cache quando relevante. Rules não filtram resultados depois de uma consulta ampla: a consulta deve ser compatível com o acesso permitido. Uma família não pode assinar toda a coleção de alunos ou pedidos e esconder os outros no frontend.
