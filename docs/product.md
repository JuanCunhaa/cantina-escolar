## 1. Sua tarefa e forma de trabalhar

Você é a IA responsável por desenvolver e entregar integralmente uma plataforma web de gestão de cantina para UMA escola. Implemente frontend, backend, banco, autenticação, permissões, pagamentos, estoque, relatórios, testes e documentação de implantação. Não entregue apenas telas, um protótipo com dados fictícios ou um plano de desenvolvimento.

O sistema atenderá aproximadamente 300 alunos, uma cantina e um ponto de atendimento. A internet é confiável. Um funcionário opera o balcão, enquanto responsáveis, alunos autorizados e secretaria podem acessar o site. Não existe necessidade de arquitetura para várias escolas, multi-tenant, franquias, marketplace, aplicativo nativo, controle de ingredientes ou microsserviços.

A hospedagem do site desejada é Vercel. Os dados persistentes do sistema ficarão no Firebase (exceto arquivos): autenticação no Firebase Authentication, banco no Cloud Firestore, atualização em tempo real por listeners do Firestore e arquivos/fotos no Cloudflare R2 (bucket privado, acessado só pelo servidor; migração aprovada em 01/10/2026, docs/status/r2-migration.md). O projeto inteiro deve ser em TypeScript com strict mode, incluindo backend e eventuais Functions. Não trocar Firebase por Supabase/PostgreSQL/Better Auth. Serviços externos de pagamento continuam necessários; Firebase não processa Pix/cartão por si só.

Se já existir um repositório de trabalho, leia as instruções aplicáveis, inspecione a estrutura e preserve o trabalho existente. Resolva escolhas rotineiras de implementação usando este documento. Registre as decisões em documentação. Solicite somente informações externas realmente necessárias, como credenciais de pagamento e domínio. Continue desenvolvendo e testando os fluxos independentes enquanto essas informações não estiverem disponíveis.

Organize a execução em etapas, mas entregue todo o escopo. Mantenha um arquivo de progresso e faça commits coerentes quando houver Git disponível. Não anuncie uma integração como pronta se ela funciona apenas em simulação. Não publique pagamentos reais nem movimente dinheiro durante testes.
