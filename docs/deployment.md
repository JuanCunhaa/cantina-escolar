### 2.4 Implantação e custos

Vercel hospeda Next.js; Firebase guarda identidade e dados; arquivos ficam no Cloudflare R2 (bucket privado por ambiente). Declare ambientes separados para emuladores, homologação e produção. Não usar filesystem temporário da Vercel como banco. Configure regiões próximas para Vercel e Firestore (o R2 usa localização automática ou jurisdição opcional via R2_ENDPOINT), conforme a disponibilidade da conta.

Decisão de 01/10/2026: arquivos saem do Cloud Storage for Firebase (que exigia plano Blaze, conforme consulta de 29/09/2026) e vão para o Cloudflare R2. A página oficial de preços do R2 (developers.cloudflare.com/r2/pricing, atualizada em 01/10/2026) lista camada mensal gratuita (10 GB-mês de armazenamento, 1 milhão de operações Classe A, 10 milhões de Classe B) e egress gratuito, mas NÃO esclarece se a ativação do R2 exige forma de pagamento: confirmar na conta antes de ativar; nada de assinatura/faturamento automático. Isso não elimina a avaliação do plano do Firebase para Auth/Firestore. Revalide condições/cotas e documente alertas de orçamento, leituras/gravações de listeners, uploads e retenção. Alertas de orçamento não devem ser descritos como um teto financeiro garantido.

O plano Hobby da Vercel é restrito a uso pessoal não comercial; documente plano apropriado para a operação comercial da cantina. Pagamentos e suas taxas são custos separados de infraestrutura.

Referências oficiais:
- https://firebase.google.com/docs/firestore/query-data/listen
- https://firebase.google.com/docs/firestore/manage-data/transactions
- https://firebase.google.com/docs/firestore/security/rules-query
- https://firebase.google.com/docs/auth/admin/manage-cookies
- https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024 (histórico: motivo da migração)
- https://developers.cloudflare.com/r2/api/s3/api/ e https://developers.cloudflare.com/r2/pricing/ (verificados em 01/10/2026)
- https://vercel.com/docs/functions/limitations (corpo de requisição de Function: 4,5 MB; fotos aceitas: 2 MB)
- https://firebase.google.com/pricing
- https://vercel.com/docs/plans/hobby
