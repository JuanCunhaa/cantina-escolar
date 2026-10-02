## 2. Decisão de implementação e stack

A decisão atual é construir o domínio e a aplicação específicos do zero. Os projetos open source examinados continuam sendo referências de fluxo, mas NÃO são a base de arquitetura. O motivo: responsáveis múltiplos, carteiras por aluno, limites por dia de consumo, agendamento escolar e reembolso não correspondem aos modelos das bases examinadas. Adaptá-las, trocar persistência e autenticação e corrigir os problemas encontrados adiciona trabalho sem garantir economia.

“Do zero” não significa escrever bibliotecas de autenticação, gráficos, componentes acessíveis ou pagamentos. Use bibliotecas maduras, com licença compatível, para esses blocos; implemente as regras particulares da cantina e um desenho de dados próprio.

### 2.1 Stack obrigatória

- TypeScript strict no frontend, backend, scripts de dados e testes. Componentes React em TSX. Nenhum backend Python/PHP nem módulos de negócio novos em JavaScript sem tipos.
- Next.js/React para site responsivo e backend seguro compatível com Vercel; escolha versões estáveis suportadas, fixe versões e confira documentação atual.
- Firebase Authentication como identidade única de responsáveis, alunos com login e funcionários; login por email/senha, recuperação e convites. Não criar outro banco de senhas.
- Cloud Firestore como banco de toda a aplicação: cadastros, carteiras, movimentos, pedidos, estoque, taxas, relatórios e auditoria.
- Listeners nativos do Firestore para tempo real. Cloud Firestore já permite atualização em tempo real; não implantar Realtime Database junto sem uma necessidade concreta. Não dividir a fonte de verdade entre dois bancos.
- Arquivos (fotos, logotipo, documentos privados quando houver): Cloudflare R2 (bucket privado, API S3-compatível, via src/lib/storage), alteração de arquitetura aprovada em 01/10/2026 (Firebase Storage não é mais usado). Credenciais só no servidor; leitura sempre autorizada pelo servidor; Firestore guarda só metadados e a chave do objeto, nunca URL. Não armazenar binários ou base64 de imagens em documentos Firestore.
- Firebase Admin SDK apenas no servidor para comandos financeiros e administrativos. Nunca bundlar credenciais administrativas no browser.
- Tailwind CSS, primitivas acessíveis como Radix/shadcn, ícones discretos e biblioteca de animação como Motion, quando útil.
- Zod para validação; decimal.js ou representação decimal exata para custos; biblioteca de gráficos para relatórios; bibliotecas de CSV/XLSX com licença compatível.
- Vitest ou equivalente TypeScript para testes, Firebase Emulator Suite para integração/rules e Playwright para fluxos E2E.

Não é necessário tRPC, monorepo complexo ou plataforma de addons. Prefira uma aplicação modular única, APIs tipadas e camadas simples. SSR e rotas seguras podem usar Firebase Admin SDK; comandos de negócio devem ter uma única implementação. Se Cloud Functions TypeScript forem necessárias para tarefa agendada, processamento de imagem ou evento, reutilize os mesmos serviços em vez de criar outro checkout divergente.

### 2.2 Organização modular

Organize por domínio: auth/access, school, students, guardians, catalog, menu, wallet, payments, orders, fulfillment, pos, inventory, fees, reports, audit. Dentro de cada módulo, separe tipos/schemas, regras puras, serviços/casos de uso, acesso ao Firestore, hooks de leitura e componentes. Não dividir cada função em um arquivo nem fazer tudo em um único componente.

Exemplo de estrutura, adaptável sem seguir mecanicamente:

- src/app: páginas, layouts e handlers HTTP finos.
- src/modules/<dominio>: regras, schemas, services, repositories, hooks e componentes do domínio.
- src/components/ui: primitivas acessíveis.
- src/components/layout: navegação e estrutura visual.
- src/lib/firebase/client.ts: Firebase Web SDK e inicialização única.
- src/lib/firebase/admin.ts: Admin SDK com server-only.
- src/lib/money, dates, validation: utilitários compartilhados bem definidos.
- firebase/firestore.rules, firestore.indexes.json: regras e índices versionados (não há mais storage.rules).
- src/lib/storage: contrato `ObjectStore` + implementação R2 (staging/production) e disco local só para emulator; src/modules/catalog/photo*.ts: regras de negócio de fotos; src/modules/catalog/{model,commands}.ts: catálogo (F06) — validação, comandos idempotentes e leitura canônica de venda.
- scripts: bootstrap, migrações documentais, reconciliação e seed TypeScript.
- tests: domínio, integração, rules e E2E.
- functions: somente se existir necessidade real de Functions, inteiramente TypeScript.

O domínio não deve importar componentes React nem depender de um listener da tela. Use converter/mapeamento tipado de Timestamp, IDs, dinheiro e estados. No backend, verifique dados lidos do banco quando necessário, sem confiar em cast TypeScript como validação.
