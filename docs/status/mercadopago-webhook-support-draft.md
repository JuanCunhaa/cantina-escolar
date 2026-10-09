# Rascunho para o suporte do Mercado Pago — assinatura das notificações automáticas (NÃO ENVIADO)

Rascunho preparado em 08/10/2026 para o dono revisar e enviar. Não contém tokens, chaves, senhas nem a URL com o parâmetro de bypass da
Vercel. Os horários estão em UTC (America/Sao_Paulo = UTC−3).

## Assunto sugerido
Webhooks da API Orders (Checkout Transparente, credenciais de teste): a "Simular notificação" é validada com a assinatura secreta do
painel, mas as notificações automáticas do sandbox chegam e não validam. Qual chave e qual manifesto devem ser usados?

## Contexto
- Integração: aplicação **Cantina-Escolar-Homologacao**, número **5808731235545127**, produto Checkout Transparente (API Orders).
- Credenciais de teste do painel: aplicação **6280026068764968**, usuário vendedor de teste (User ID) **3745150346**. É com elas que as
  orders são criadas (`integration_data.application_id = 6280026068764968`).
- Webhook configurado **apenas no modo de teste** (URL HTTPS pública) com o evento "Order (Mercado Pago)". O modo de produção está sem URL.
- A assinatura secreta usada é a exibida no painel da aplicação 5808731235545127 (uma única).
- Validação implementada conforme a documentação "Configurar notificações de orders": cabeçalhos `x-signature` (`ts`, `v1`) e `x-request-id`,
  `data.id` da query, HMAC-SHA256 em hexadecimal.

## Resultado A — "Simular notificação" do painel: VÁLIDA
Order real do sandbox usada no ID da simulação: `ORDTST01M4ER1PTXV6ZZS30BFJFGRFHP` (Pix aprovado, R$ 13,00).
- Origem: `User-Agent: restclient-node/5.5.0`.
- Query: `data.id`, `type` (somente).
- Corpo: `action: order.processed`, `type: order`, `application_id: 5808731235545127`, `user_id: 1176606073`, `live_mode: true`, `data.version: 3`.
- `x-signature` com as chaves `ts` (10 dígitos, segundos) e `v1`.
- **Observação**: a assinatura só valida quando o `data.id` entra no manifesto **exatamente como veio** (`ORDTST…` em maiúsculas), não em
  minúsculas como diz a documentação (`id:[data.id_url]` "em minúsculas"). Com IDs só numéricos (ex.: `123456`) a diferença não aparece.
  Evidência: nas 3 simulações de 08/10/2026 com a order `ORDTST01M4EDRH87FT6X358XRZ41CZZK` (21:45:00Z, 21:46:52Z e 21:47:17Z,
  `x-request-id` `1c68f6ea-…`, `46f7036b-…`, `629ae34b-…`) só a variante "ID como recebido" bateu com a chave do painel.

## Resultado B — notificações AUTOMÁTICAS do sandbox: chegam e NÃO validam
Nas mesmas orders do sandbox, as notificações automáticas chegam ao mesmo endpoint e a assinatura não valida com a mesma chave:
- Origem: `User-Agent: MercadoPago WebHook v1.0 order`.
- Query: `data.external_reference`, `data.id`, `type` (a simulação não traz `data.external_reference`).
- Corpo: `application_id: 6280026068764968`, `user_id: 3745150346`, `live_mode: false`, `action: order.action_required` (criação do Pix) e
  `order.processed` (aprovação).
- `x-signature` com `ts` (10 dígitos, segundos) e `v1`; `x-request-id` UUID.
- Cada evento chega **duas vezes**, com `x-request-id` diferentes e `ts` iguais ou com 1 s de diferença.
- Cabeçalhos presentes (nomes): `accept`, `accept-encoding`, `connection`, `content-length`, `content-type`, `forwarded`, `host`, `referer`,
  `traceparent`, `user-agent`, `x-b3-sampled`, `x-b3-spanid`, `x-b3-traceid`, `x-forwarded-*`, `x-request-id`, `x-rest-pool-name`,
  `x-signature`, `x-socket-timeout`, `x-trace-digest-*`.

Exemplos (todos recusados pela validação de assinatura; order `ORDTST01M4ER1PTXV6ZZS30BFJFGRFHP`, criada e aprovada em 08/10/2026):

| Hora (UTC) | Ação | x-request-id |
|---|---|---|
| 21:52:29 | order.action_required | `2086cf60-900b-49dc-bba4-07eee2d66e0d` |
| 21:52:29 | order.action_required | `369b1067-2199-41fc-9881-428c6d5cba42` |
| 21:52:35 | order.processed | `f45a71ff-bbfd-4812-9bc2-3d4624bf4b76` |
| 21:52:35 | order.processed | `0bbe05e2-f159-4533-9af3-bbda63843590` |

Outro exemplo: order `ORDTST01M4DYBTQ8KZ0SK9MR53ZCKCMS`, `order.processed`, 21:21:18Z, `x-request-id` `208a9093-e8c7-4c80-a983-974d89d7d5ba`.

Testes feitos do nosso lado (sem sucesso): manifesto `id;request-id;ts` com o ID em minúsculas e como recebido, `ts` em segundos e em
milissegundos, com e sem `request-id`/`ts`, com `data.external_reference` e a query inteira no manifesto, e a chave como texto, em bytes
hexadecimais e em base64. A "Simular notificação" valida com a mesma chave, então a chave exibida no painel está correta para a simulação.

## Perguntas
1. Qual **chave secreta** assina as notificações automáticas geradas por orders criadas com as **credenciais de teste** (aplicação
   6280026068764968)? É a mesma exibida no painel da aplicação 5808731235545127 ou outra?
2. Qual é o **manifesto exato** das notificações automáticas da API Orders (inclui `data.external_reference`? `ts` em segundos ou ms? ID em
   minúsculas ou como recebido)? A documentação diz minúsculas, mas a simulação do painel assina com o ID como recebido.
3. Por que cada evento automático é entregue **duas vezes** (dois `x-request-id`, mesmo `ts`)? Há duas assinaturas/configurações ativas?
4. O comportamento é específico do sandbox/credenciais de teste? Em produção (aplicação com credenciais reais) vale a chave do painel?

## O que podemos fornecer, se necessário
Pares `x-signature`/`x-request-id` completos de entregas automáticas recusadas (sem o corpo sensível), por canal seguro indicado pelo suporte.
