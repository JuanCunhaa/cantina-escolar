## 6. Recarga, pagamentos e taxas

### 6.1 Canais solicitados

- Pix pelo site com confirmação automática: pagamento avulso por QR Code/copia e cola. “Automático” neste projeto significa confirmar o recebimento automaticamente; não implementar Pix recorrente por esse nome.
- Dinheiro na secretaria, após recebimento físico confirmado.
- Pix na secretaria, conferido pelo funcionário antes de registrar.
- Cartão de maquininha na secretaria/balcão, registrado após aprovação.
- Cartão online pelo site, pagamento em UMA parcela, sem parcelamento de recarga.

Responsável ou aluno com acesso e autorização pode iniciar recarga de sua carteira autorizada. A permissão de recarga não dá permissão de comprar. Não receba depósito fictício como prova de saldo. A secretaria deve registrar aluno, valor, forma, operador, data e referência do recebimento. Quando possível, referência externa deve impedir lançar o mesmo recebimento novamente.

### 6.2 Valor integral de crédito

Pagamento confirmado de R$ 50 gera EXATAMENTE R$ 50 de saldo, ainda que o provedor cobre taxa. Não repassar a taxa ao responsável nem descontá-la da carteira.

Exemplo: bruto R$ 50, taxa R$ 1,50, saldo creditado R$ 50 e recebimento líquido R$ 48,50. Taxa é despesa da cantina. Registrar também a data prevista/real de liquidação: aprovação de cartão não significa dinheiro já recebido no banco.

### 6.3 Integrações

O provedor definitivo ainda não foi escolhido. Implemente contrato simples de integração e configuração independente para Pix e cartão, permitindo um provedor para ambos ou um para cada canal. Não construa um sistema genérico de dezenas de gateways.

Antes de implementar o adapter real, confirme nas fontes oficiais do provedor suporte ao caso de recarga fechada da cantina, meios de pagamento, APIs, ambientes e taxas; não suponha que qualquer gateway aceita qualquer uso. Implemente pelo menos o adapter real escolhido para cada canal, com sandbox/homologação e instruções exatas. Se credenciais/conta ainda faltarem, complete o código e testes de contrato, liste a pendência concreta e não marque o pagamento real como homologado.

Mocks somente em testes ou ambiente de demonstração explicitamente separado. Em produção, integração ausente deve apresentar indisponibilidade, nunca creditar saldo por um botão “simular pagamento”. Use checkout/tokenização do provedor; não armazene número completo de cartão ou CVV.

### 6.4 Confirmação confiável

Crie intenção de recarga no servidor, com aluno, valor em centavos, moeda, provedor e ID local. Use idempotência na criação externa. Timeout deve ser conciliado antes de gerar outra cobrança. Confirme assinatura/autenticidade do webhook, consulte o pagamento no provedor quando apropriado e confira identidade, valor, moeda, conta recebedora e estado final.

Credite saldo somente após estado confirmado de pagamento. Redirect de sucesso, email, JSON do browser ou screenshot não confirmam recebimento. Registre o evento externo com unicidade por provedor/conta/ID. Webhooks repetidos ou fora de ordem não duplicam crédito nem rebaixam um pagamento liquidado para pendente.

Faça a gravação de pagamento confirmado, crédito da carteira, movimento e auditoria em uma transação Firestore. A chamada HTTP ao provedor fica fora do callback transacional, que pode ser repetido automaticamente. Mantenha reconciliação para pagamentos que confirmaram, mas cujo webhook se perdeu; execute consulta automática com mecanismo compatível com a implantação e também ação manual autorizada. Expiração local não deve descartar um pagamento que foi efetivamente confirmado depois; concilie-o.

Status de recarga separados de pedidos: aguardando pagamento, confirmada, expirada, falhou, em revisão e revertida conforme aplicável. Mostre QR, copia e cola, validade e acompanhamento no portal.

Cancelamento de PEDIDO retorna somente para carteira. Isso não elimina eventos externos obrigatórios como reversão de pagamento/chargeback. Implemente recebimento e conciliação desses eventos sem duplicar crédito/débito, com revisão administrativa e bloqueio de novas despesas da carteira afetada quando necessário. Se não houver saldo disponível para regularizar, registre a pendência explicitamente; não esconda divergência nem force saldo negativo silencioso. Não ofereça saque ou reembolso Pix voluntário no portal.

### 6.5 Taxas

Cadastre meios, provedores e maquininhas utilizados, taxa percentual, taxa fixa, vigência e condição (Pix/débito/crédito 1x), sem parcelamento online. Salve a regra aplicada no lançamento, valor estimado, valor real quando informado e origem desse dado. Mudança de cadastro não altera lançamentos passados.

Permita conferência do valor real por integração ou operador autorizado. Relatórios devem separar taxas estimadas de confirmadas; não somá-las duas vezes. Diferencie taxa de pagamento, taxa de antecipação quando realmente existente e ajuste/reversão. Dinheiro/Pix manual podem ter taxa zero configurada, sem presumir gratuidade de todo canal.
