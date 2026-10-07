# Provedor de Pix e cartão 1x — pesquisa (F18)

Consulta: 06/10/2026, só em páginas dos próprios provedores. Nenhuma conta aberta, plano contratado ou cobrança feita.
**Aprovado pelo dono em 06/10/2026: Mercado Pago para Pix e cartão 1x.** Adapter em
`src/modules/payments/online/mercadopago.ts` (seção "Adapter" abaixo). Aceitação comercial por escrito e taxas da conta
seguem pendentes (itens 2–3); sem elas não há produção.

Legenda: **V** = lido na página oficial nesta consulta; **R** = obtido de resumo de busca sobre página do provedor (não
lido por inteiro); **?** = não verificado. Preço/taxa é sempre "publicado em 06/10/2026", não contrato.

## Comparação

| Item | Mercado Pago (Checkout Transparente, API Orders) | Asaas | Pagar.me (API v5) |
|---|---|---|---|
| Pix avulso | **V** `POST /v1/orders`, `payment_method {id: "pix", type: "bank_transfer"}`; resposta `qr_code` (copia e cola), `qr_code_base64` (imagem), `ticket_url`; status `action_required`/`waiting_transfer`. Exige chave Pix cadastrada na conta | **R** cobrança `billingType` Pix pela API de cobranças; QR por endpoint próprio (**?** campos) | **R** `payment_method: "pix"` no pedido (`orders`) |
| Validade do Pix | **V** `expiration_time` ISO 8601; mín. 30 min, máx. 30 dias, padrão 24 h | ? | ? |
| Cartão sem PAN no servidor | **V** Card Payment Brick / MercadoPago.js gera `CardToken` (uso único, 7 dias); servidor envia só o token | **V** recomenda a fatura hospedada (`invoiceUrl`); enviar `creditCard` pela API põe o dado de cartão na aplicação (HTTPS, `remoteIp`); tokenização em produção "solicite a habilitação ao seu gerente" | **R** `tokenizecard.js` com chave pública; token de cartão de uso único, expira em 60 s |
| Uma parcela | servidor envia 1; **?** parâmetro do Brick para fixar 1 parcela | **R** parcelamento é opcional por cobrança | ? |
| Autenticação | **V** `Authorization: Bearer <access token>` | ? (chave de API em cabeçalho) | **R** Basic com a secret key (`sk_test_*` em sandbox) |
| Idempotência na criação | **V** cabeçalho `X-Idempotency-Key` obrigatório nas chamadas | **V** sem cabeçalho de idempotência documentado no que foi lido; recomenda `externalReference` estável + registro local antes de reenviar | **V** cabeçalho `Idempotency-key`; validade 24 h (sandbox 5 min); mesma chave = um pedido; repetição muito rápida = 409; 400/500 não gravam a chave |
| Consulta | **V** `GET /v1/orders/{id}`; **?** busca por `external_reference` na API Orders | ? | ? |
| Webhook | **V** cabeçalhos `x-signature` (`ts`, `v1`) e `x-request-id`; HMAC-SHA256 com a chave secreta sobre `id:[data.id];request-id:[x-request-id];ts:[ts];`; responder 200/201 em até 22 s; novas tentativas a cada 15 min; recomenda consultar a order | **V** token fixo no cabeçalho `asaas-access-token` (sem assinatura do corpo); entrega "pelo menos uma vez"; fila pausa após 15 falhas; eventos guardados 14 dias | **R** eventos `order.paid`, `order.payment_failed`, `charge.refunded`; **?** autenticação/assinatura |
| Sandbox | **R** credenciais e cartões de teste | **V** ambiente Sandbox separado (cobranças Pix/cartão, webhooks) | **R** chaves `sk_test`/`pk_test`, host sandbox; operações de teste não geram recebíveis |
| Taxas publicadas | **R** Pix 0% "para a maioria" (0,49% para novos CNPJ com faturamento ≥ R$ 15 mil/mês); crédito à vista 4,98% (receber na hora) ou 3,98% (30 dias) | **?** a página de preços lida trouxe valores divergentes do resumo de busca (Pix R$ 1,99 × R$ 0,35 + 1,89%; cartão R$ 0,49 + 2,99%); promoção de 3 meses; sem mensalidade — **confirmar na conta** | **R** Pix 1,19%; crédito à vista 4,39% (plano à vista); R$ 0,99 por transação; saque R$ 3,67 |
| Liquidação | **R** Pix na hora; cartão na hora/14/30 dias conforme taxa | **R** cartão até 32 dias (à vista), antecipação paga | **R** até 15 dias no modelo padrão |
| Requisitos de conta | ? (PF/PJ) | conta gratuita (**R**) | **R** CNPJ ou MEI ativo e "modelo de negócio compatível" |
| Recarga fechada (crédito pré-pago de cantina escolar, sem saque) | Termos proíbem uso como adiantamento de dinheiro, autofinanciamento, empréstimo (**R**); **não há menção** ao caso. Ausência de proibição NÃO é aprovação | sem menção encontrada | exige modelo de negócio "compatível" (aprovação comercial) |

## Recomendação

**Mercado Pago (API Orders) para os dois canais**, condicionada às confirmações abaixo. Motivos objetivos: (1) idempotência
garantida pela API (`X-Idempotency-Key`) — encaixa direto na chave = ID da intenção; (2) webhook com assinatura HMAC do
evento + consulta da order, o que a F19 exige; (3) cartão só por token do Brick (PAN/CVV nunca no servidor); (4) Pix com
QR, copia e cola e validade configurável na mesma API; (5) taxa de Pix publicada 0% para a maioria. Contra: crédito à
vista publicado mais caro (4,98% D+0 / 3,98% D+30) que o publicado pelo Pagar.me.

Alternativa: **Pagar.me**, se a escola tiver CNPJ, preferir a taxa de cartão publicada e o provedor aprovar o modelo de
negócio — falta verificar a autenticação do webhook. **Asaas** não é recomendado para o cartão online: sem idempotência na
API e cartão sem PAN só por fatura hospedada (tokenização depende de liberação manual); webhook só com token fixo.

## Pendências concretas (dono do produto)

1. ~~Aprovar o provedor~~ — **feito em 06/10/2026: Mercado Pago, um para os dois canais.**
2. **Aceitação comercial por escrito** do provedor escolhido para "venda de crédito pré-pago em carteira fechada de cantina
   escolar, consumo só na cantina, sem saque nem reembolso em dinheiro": categoria/MCC, risco de bloqueio, retenção.
3. **Confirmar na conta**: taxas e prazos de liquidação aplicáveis à conta da cantina (PF/PJ), chave Pix cadastrada.
4. **Abrir o sandbox** (ação do dono) e entregar por canal seguro: access token de teste, chave pública de teste e chave
   secreta de webhook (para a F19). Nada disso vai para o repositório.
5. ~~Para o adapter: busca por `external_reference` e 1 parcela no Brick~~ — confirmados na documentação (seção "Adapter").

## Adapter (06/10/2026)

Documentação consultada: API Orders (criar, buscar, obter), Pix (Orders) e teste de Pix, Cartões (Orders) e Card Payment
Brick (parcelas e meios). Mapeamento implementado:

- Criação `POST /v1/orders` com `X-Idempotency-Key` = ID da intenção e `external_reference` = mesmo ID; valor em string
  exata a partir de centavos (`5000` → `"50.00"`).
- Pix: `payment_method {id: "pix", type: "bank_transfer"}`, `expiration_time` ISO 8601 (mín. 30 min, máx. 30 dias);
  resposta `action_required`/`waiting_transfer` com `qr_code` (copia e cola) e `qr_code_base64` (imagem), exibidos no
  nosso site — sem `ticket_url`/redirecionamento.
- Cartão: só o token do Card Payment Brick (SDK `sdk.mercadopago.com/js/v2`), crédito, `installments: 1`
  (`minInstallments = maxInstallments = 1`; débito e pré-pago excluídos). Desafio 3DS (`action_required`) = recusado.
- Respostas: 2xx/402 → order mapeada; 409/423/429/5xx/rede/timeout → **incerto** (só a consulta decide);
  400/401/403/404/422 → recusa definitiva. `processed` (Pix ou cartão) = "em análise" — **não credita** (F19).
- Conciliação: `GET /v1/orders?begin_date&end_date&external_reference` (datas obrigatórias) + `GET /v1/orders/{id}`.
- Sandbox: pagador Pix `test_user_br@testuser.com` com nome `APRO` (a order volta `action_required` com QR e é aprovada
  depois pelo sandbox); cartão com `test@testuser.com` e cartões de teste. O pagador de teste só é usado com
  `MERCADOPAGO_ENV=sandbox`.
- Medido no sandbox (06/10/2026): 402 traz `{ errors, data: order }` (cartão recusado → `data.status = "failed"`); a busca
  por `external_reference` tem atraso de indexação (vazia no instante 0, presente em ≤ 5 s; `GET /v1/orders/{id}` é
  imediato) — "não encontrada" logo depois de um timeout não encerra nada (desistência só após 30 min; reenvio usa a
  mesma chave → 409 → incerto); cartões de teste da API Orders são outros que os da API Payments (Mastercard
  `5480 8328 0103 3311`, titular `APRO`/`OTHE`); no Brick, só crédito via `types.included: ["credit_card"]` (o SDK grafa
  `prepaid-card`) e os campos seguros (`secure-fields.mercadopago.com`) exigem digitação, não preenchimento.
- Evidência (simulado × sandbox × publicado) e limites: PROGRESS.md, "Recarga online (F18): o que foi provado onde", e PR #25.
- Produção: NÃO habilitada. Credenciais de produção não foram cadastradas; exigem aceitação comercial por escrito e taxas
  da conta (itens 2–3) e `APP_ENV=production` + `MERCADOPAGO_ENV=production`.
- Variáveis: `PAYMENTS_PIX_PROVIDER`/`PAYMENTS_CARD_PROVIDER=mercadopago`, `MERCADOPAGO_ENV` (`sandbox` fora de
  `APP_ENV=production`; `production` só nela), `MERCADOPAGO_ACCESS_TOKEN` (segredo do servidor), `MERCADOPAGO_PUBLIC_KEY`
  (cartão). Falta/combinação proibida = canal indisponível.

## Fontes (consultadas em 06/10/2026)
- Mercado Pago — teste de Pix (Orders): https://www.mercadopago.com.br/developers/en/docs/checkout-api-orders/integration-test/pix.md
- Mercado Pago — teste de cartões (Orders): https://www.mercadopago.com.br/developers/en/docs/checkout-api-orders/integration-test/cards.md
- Card Payment Brick (SDK JS): https://github.com/mercadopago/sdk-js/blob/main/docs/bricks/card-payment.md · textos: https://www.mercadopago.com.br/developers/en/docs/checkout-bricks/card-payment-brick/visual-customizations/change-texts.md

- Mercado Pago — Pix (Orders): https://www.mercadopago.com.br/developers/en/docs/checkout-api-orders/payment-integration/pix.md
- Mercado Pago — Pix (Payments): https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/integration-configuration/integrate-pix
- Mercado Pago — Cartões (Orders): https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-integration/websites/cards
- Mercado Pago — Notificações (Orders): https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/notifications
- Mercado Pago — taxas (blog do provedor): https://www.mercadopago.com.br/blog/quanto-custa-receber-pagamentos-via-pix-e-codigo-qr e https://www.mercadopago.com.br/blog/comparando-taxas-checkout-gateways-pagamento
- Mercado Pago — termos e práticas proibidas: https://www.mercadopago.com.br/ajuda/termos-e-condicoes_300 e https://www.mercadopago.com.br/ajuda/contornar_estrutura_programas_4822
- Asaas — webhooks: https://docs.asaas.com/docs/sobre-os-webhooks · retries e idempotência: https://docs.asaas.com/docs/retries-e-idempot%C3%AAncia · cartão: https://docs.asaas.com/docs/cobrancas-via-cartao-de-credito · sandbox: https://docs.asaas.com/docs/duvidas-frequentes-sandbox · preços: https://www.asaas.com/precos-e-taxas
- Pagar.me — idempotência: https://docs.pagar.me/docs/o-que-%C3%A9 · tokenização: https://docs.pagar.me/reference/pagarme-js · autenticação: https://docs.pagar.me/reference/autentica%C3%A7%C3%A3o-2 · webhook (exemplo): https://docs.pagar.me/reference/exemplo-de-webhook-1 · ofertas: https://www.pagar.me/ofertas
