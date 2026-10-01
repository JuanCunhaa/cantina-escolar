# Roteiro para comandos transacionais

Este arquivo define o procedimento técnico; as regras de produto são canônicas nos documentos do domínio.

1. Identificar ator, comando, payload normalizado e chave de idempotência. Vincular chave a usuário/ação/hash do payload; rejeitar reutilização com conteúdo diferente.
2. Derivar os IDs estáveis antes do callback. Autenticar no servidor; reler vínculos/políticas relevantes dentro da transação.
3. Listar documentos de leitura/gravação: carteira/livro, pedido/itens, estoque/reservas/cotas, uso por dia/semana, vínculo/política, idempotência e auditoria, conforme o comando.
4. Ler tudo antes de gravar. Verificar versões, disponibilidade, preços históricos e estado atual. Incluir documentos mutáveis cuja alteração invalida o comando.
5. Aplicar resultado inteiro ou nada; salvar resposta reproduzível no registro de idempotência. Manter livro e saldo na mesma transação.
6. Manter HTTP do gateway, email, upload e outros efeitos externos fora do callback. Retentativa automática não pode repeti-los.
7. Testar falha intermediária, replay e disputa real no Emulator Suite; verificar os invariantes após todos os commits.

Contratos detalhados e limites: [modelo documental](schema.md). Fluxos de autenticação/listeners: [Auth/realtime](auth-realtime.md).

Para pagamento externo: criar intenção local, executar integração idempotente fora da transação, conciliar resultado e só então confirmar crédito transacional. Não simular atomicidade distribuída entre gateway e Firestore.

Disputa no mesmo documento: use `COMMAND_TRANSACTION` (src/lib/firebase/transaction-options.ts, maxAttempts 10) em `runTransaction` de comando. Duas transações que leem e depois escrevem o mesmo documento disputam a promoção do lock; no emulador cada impasse custa ~3,4 s (lock timeout) e o padrão de 5 tentativas do SDK falha com 12 escritores simultâneos. Capacidade testada: 12 escritores simultâneos por documento; não projetar fluxo que concentre mais que isso em uma carteira/cota. Produção não foi medida.
