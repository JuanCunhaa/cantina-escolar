# Decisões e dúvidas

## Confirmadas no escopo

- Construir aplicação/domínio próprios do zero com Next.js/TypeScript e Firebase; referências open source não são a fundação.
- Uma escola; carteira por aluno; vários responsáveis equivalentes; ausência de ingredientes, multi-tenant, saque voluntário ou parcelamento online.
- Direção visual clean, fotografias e movimento discreto; priorizar lista/tabela/seção aberta.
- Datas de consumo locais e instantes UTC; manhã/tarde com horários independentes.

## Configuração do agente

- Claude Code local/terminal/IDE que leia a pasta do projeto. Modelo padrão `claude-sonnet-5-5` e esforço `medium`; não alterar modelo automaticamente.
- Skills de projeto nativas em .claude/skills, cinco regras por caminho e nenhuma ativação automática de MCP/agentes paralelos.

## A decidir durante implementação

- Versões estáveis e gerenciador de pacote, com lockfile em F01.
- Provedor real por canal em F18, mediante documentação oficial e elegibilidade para recarga fechada.
- Tamanho máximo de carrinho/lote e representação Decimal exata documentados antes dos comandos financeiros.
- Mecanismo de conciliação agendada, após confirmar disponibilidade na hospedagem.
- Classificação de encerramento de não retirada com cobrança, de forma explícita em F13.

Acrescentar decisão com contexto breve, opção adotada, efeito e fonte oficial quando houver API/serviço externo. Não inventar preferência do usuário para fechar pendência.

## Decisões de F01 (30/09/2026)

- Versões fixas (sem ^): Next 16.3.8, React 19.3.0, firebase 12.19.0, firebase-admin 14.5.0, TypeScript 6.0.3 (TS 7 excede o peer de typescript-eslint <6.1), ESLint 9.39.5 (ESLint 10 quebra eslint-plugin-react), Vitest 5.0.3, Playwright 1.63.0, firebase-tools 15.32.0. Sem Tailwind/Radix ainda: entram com a primeira tela real (cantina-ui).
- Sessão: ID token Firebase em `Authorization: Bearer`, verificado com revogação no servidor (`requireActor`); sem cookie de sessão por ora, logo sem superfície CSRF. Ator vem sempre do token, nunca do payload.
- Comando de prova `/api/probe` (coleção `foundationProbes`) exercita idempotência/transação; desligado em produção/sem APP_ENV. Substituído pela carteira real em F08; remover rota, coleção e regra então.
- Rules: deny-all, exceto get do próprio `foundationProbes/{uid}` e leitura do próprio livro; sem list na coleção raiz. Storage segue deny-all até a tarefa de fotos.
- Env: validação fechada em `src/lib/env.ts` (emulador sem credencial; staging/produção sem variáveis de emulador nem projeto demo-*).
- Ambiente local: política de Controle de Aplicativo bloqueia SWC nativo e gitleaks; Webpack/WASM usado localmente, Turbopack a verificar no CI/Vercel.

## Decisões de F02 (30/09/2026)

- Papel provisório: custom claim `role` (guardian|cantina|secretaria|admin) no ID token, definida só pelo servidor/Admin. Serve Storage Rules, `requireActor` (`Actor.role`) e navegação. F03 formaliza papéis/permissões e pode substituir; Rules não checam revogação (vale até o token expirar).
- Fotos: upload direto ao Storage em `products/{productId}/{nome-aleatório}.{jpg|png|webp}`; Rules só `create` (sem sobrescrever; substituir = novo arquivo), cantina/admin, tipo e ≤ 2 MB. Servidor (`/api/catalog/photo`) revalida papel, caminho do produto, tipo, tamanho e assinatura dos bytes antes de gravar `photoPath`; arquivo reprovado é apagado. SVG nunca aceito. Leitura: contas autenticadas; qualquer outro caminho (comprovantes) fechado.
- Catálogo de demonstração: coleção `demoProducts` (fictícia, marcada `isDemo`, leitura autenticada, escrita só seed/servidor); imagens de exemplo geradas em código (sem terceiros). Substituída pelo catálogo real em F06; remover coleção/rota/regra então. `/api/catalog/photo` indisponível em produção.
- UI: tokens em src/app/globals.css; seções abertas e listas, cards só na foto do produto; sem Tailwind/Radix (CSS próprio suficiente); reduced motion zera transições via tokens. Navegação por papel em src/modules/access/navigation.ts (itens de tarefas futuras aparecem "em breve", sem link).

## Decisões de F03 (30/09/2026)

- Papel geral na Firestore, não em claim: `users/{uid}` (role, status, permissions, accessVersion) é a fonte ATUAL lida pelo servidor (`requireActor`), pelas Firestore Rules e pelas Storage Rules (regra entre serviços `firestore.get`, comprovada no emulador). A claim `role` de F02 foi abandonada: claim antiga ou forjada não concede nada (testado). Efeito: rebaixar/desativar vale na próxima requisição/leitura, sem esperar o ID token expirar.
- Papéis: guardian, student (novo; portal, consulta), cantina, secretaria, admin. Capacidades por papel em src/modules/access/permissions.ts (custos/lucro/auditoria/usuários só admin; secretaria só busca de aluno e recebimento; estorno manual da secretaria = permissão extra individual `topup.reverse`, concedida só a esse papel).
- Vínculo e política são fontes mutáveis separadas: `guardianStudentLinks` (ativo/revogado) e `studentPolicies` (`allowSitePurchase`, `allowCounterPurchase`). `authorizeStudent`/`decideStudentAction` decidem view/manage/purchase.site/purchase.counter por vínculo e política atuais, também dentro de transação; Rules espelham a leitura. Compra exige aluno ativo; política limita a autonomia do aluno, não o responsável. Revogar permissão não toca pedidos existentes (pedidos: F11+).
- Comportamento formal de revogação: papel rebaixado → 403 na próxima chamada (mesmo token); conta desativada → perfil `disabled` + Auth desabilitado + refresh tokens revogados (401 no servidor, Rules negam na hora, listener local encerra a sessão com aviso); reativar exige novo login; vínculo revogado nega na hora (servidor e Rules). Perfil malformado/sem perfil = sem papel (falha fechada). Limite conhecido: "Sair de todos os dispositivos" revoga refresh tokens e invalida o servidor imediatamente, mas Firestore/Storage Rules só leem o perfil, então outra aba com ID token vigente mantém listeners até o token expirar (≤ 1 h); desativar a conta fecha as Rules imediatamente.
- Comando único de acesso: `setUserAccess` (POST /api/admin/users, só admin): cria conta no Auth com senha aleatória descartada quando o email é novo (a pessoa define a senha por "Esqueci minha senha", email do próprio Firebase Auth) e altera papel/situação/permissões; idempotente (chave por ator), perfil e `auditLog` na mesma transação, perfil do ator relido na transação, guarda do último administrador ativo (consulta dentro da transação). Efeito no Auth só após o commit e re-executável.
- Auditoria mínima: `auditLog/{id}` com ID derivado da operação (append-only, `create`), helper em src/modules/audit/log.ts, reutilizado por `session.revoke_all` e por todo comando futuro.
- Sessão: ID token em `Authorization: Bearer` (sem cookie, sem CSRF), `useSession` assina `users/{uid}` ao vivo e desliga no logout. Recuperação e login usam mensagens genéricas (sem enumerar emails); página de redefinição é a hospedada pelo Firebase Auth.
- Primeiro administrador de um projeto real: criar o usuário no Auth e o documento `users/{uid}` pelo Console (role admin, status active, accessVersion 1); sem script de produção por ora (bootstrap fica para F24). Cadastro público de contas do Firebase Auth deve ser desabilitado no projeto real: sem perfil ativo a conta não acessa nada, mas não deve existir.
- `foundationProbes` segue legível por qualquer conta autenticada (prova F01, desligada em produção); `demoProducts` e fotos exigem perfil ativo.
