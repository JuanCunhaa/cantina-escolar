### 2.4 Implantação e custos

Vercel hospeda Next.js; Firebase guarda identidade, dados e arquivos. Declare ambientes separados para emuladores, homologação e produção. Não usar filesystem temporário da Vercel como banco. Configure regiões próximas para Vercel, Firestore e Storage, conforme a disponibilidade da conta.

A documentação oficial consultada em 29/09/2026 informa que Cloud Storage for Firebase exige plano Blaze, com faturamento vinculado. Isso não implica cobrança fixa obrigatória em todo mês, mas impede prometer o sistema inteiro no Spark sem faturamento. Revalide condições/cotas e documente alertas de orçamento, leituras/gravações de listeners, uploads e retenção. Alertas de orçamento não devem ser descritos como um teto financeiro garantido.

O plano Hobby da Vercel é restrito a uso pessoal não comercial; documente plano apropriado para a operação comercial da cantina. Pagamentos e suas taxas são custos separados de infraestrutura.

Referências oficiais:
- https://firebase.google.com/docs/firestore/query-data/listen
- https://firebase.google.com/docs/firestore/manage-data/transactions
- https://firebase.google.com/docs/firestore/security/rules-query
- https://firebase.google.com/docs/auth/admin/manage-cookies
- https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024
- https://firebase.google.com/pricing
- https://vercel.com/docs/plans/hobby
