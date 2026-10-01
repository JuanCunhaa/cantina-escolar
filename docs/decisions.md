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
- Comando de prova `/api/probe` (coleção `foundationProbes`) exercita idempotência/transação; desligado em produção/sem APP_ENV. Substituído pela carteira real em F04; remover rota, coleção e regra então.
- Rules: deny-all, exceto get do próprio `foundationProbes/{uid}` e leitura do próprio livro; sem list na coleção raiz. Storage segue deny-all até a tarefa de fotos.
- Env: validação fechada em `src/lib/env.ts` (emulador sem credencial; staging/produção sem variáveis de emulador nem projeto demo-*).
- Ambiente local: política de Controle de Aplicativo bloqueia SWC nativo e gitleaks; Webpack/WASM usado localmente, Turbopack a verificar no CI/Vercel.
