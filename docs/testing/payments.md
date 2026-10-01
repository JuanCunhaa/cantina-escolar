# Critérios de aceite — payments

## A04

Recarga de R$ 50 com taxa de R$ 1,50 credita R$ 50 e registra líquido R$ 48,50; taxa não reaparece na compra com saldo.

## A05

Webhook duplicado credita uma vez; inválido, valor/moeda/conta divergentes e redirect de sucesso não creditam. Evento fora de ordem não corrompe estado.

## A06

Timeout de criação de cobrança e pagamento confirmado depois da expiração local são conciliados sem cobrança/crédito duplos.

## A07

Recarga manual exige permissão, confirmação, operador e trilha; estorno é novo movimento.

## A29

Mudança de regra de taxa não altera histórico; estimativa e taxa real não são somadas juntas. Exportação mensal bate com detalhes.

## A31

Reversão externa é idempotente e abre pendência quando necessário, sem esconder crédito indevido ou gerar saldo negativo silencioso.
