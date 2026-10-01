## 21. Entregáveis e sequência de execução

### Etapa A — fundação técnica e visual
Inicializar aplicação TypeScript strict, módulos, Firebase Auth/Firestore, armazenamento de arquivos em Cloudflare R2 (módulo src/lib/storage) e Emulator Suite. Configurar rules, índices e ambientes. Fazer uma prova de login + listener privado + comando servidor transacional, com duas contas e verificação de isolamento. Construir shell visual clean e uma página de produtos com fotos e responsividade; não gastar a primeira etapa somente em decoração.

### Etapa B — cadastros e carteira
Papéis/vínculos, escola/turno/calendário, alunos/responsáveis, catálogo/cardápio, carteira/livro/transferências, políticas e documentos de uso diário/semanal. Rotinas de dados em TypeScript; sem multi-tenant.

### Etapa C — operação completa
Estoque/cotas/custos, compra antecipada, Meus pedidos, limites/bloqueios, entrega, cancelamento/reembolso e PDV. Listeners relevantes e testes transacionais/rules desde esses módulos.

### Etapa D — pagamentos e gestão
Adapters reais Pix/cartão 1x, secretaria, taxas, conciliação, relatórios/exportações, caixa e auditoria. Homologar fluxo completo. Não substituir integração por mock visível em produção.

### Etapa E — entrega
E2E, revisão de permissões/rules, concorrência, build, acessibilidade, fotos, reduced motion, documentação e implantação Vercel/Firebase. Validar em homologação com credenciais autorizadas; preparar produção e listar pendências concretas.

Entregar:
- Código completo TypeScript modular, dependências travadas e atribuições de bibliotecas.
- README de instalação, execução, testes e arquitetura.
- .env.example sem segredos, separando configuração pública Firebase das credenciais servidor/gateway.
- firestore.rules, firestore.indexes.json, firebase.json e configuração de emuladores.
- Scripts TypeScript de bootstrap, migração, seed fictício, conciliação/reconstrução e backup/restauração documentados.
- docs/arquitetura.md: decisão de construir domínio próprio, módulos, Firestore, Auth, realtime, comandos e transações.
- docs/design.md: layout clean, fotos, listas/tabelas, tokens, motion e acessibilidade.
- docs/regras-negocio.md e modelo documental com índices/consultas/invariantes.
- docs/pagamentos.md: provedores, sandbox, webhooks, idempotência, taxas e pendências.
- docs/relatorios.md: fórmulas, bases de data, fonte histórica e projeções.
- docs/deploy-vercel-firebase.md: runtime, regiões, variáveis, Auth domains, callbacks, rules, bucket R2 e credenciais por ambiente, projetos e planos/custos.
- docs/operacao.md: secretaria/cantina/administração, caixa, estoque e recuperação.
- Testes de domínio/integração/rules/E2E e CI com tipos/lint/build/emuladores, sem dados reais.
- Evidência do que passou e do que depende de credenciais/configuração externa.

Seu objetivo é um site operacional específico desta escola, clean e natural, com produtos fotografados, movimentos discretos e dinheiro/estoque íntegros. Construa o domínio do zero sobre Firebase e bibliotecas consolidadas, preservando todas as regras de produto deste documento. Não encerre ao entregar apenas o portal ou o dashboard.
