# Cantina Escolar — estrutura para Claude Code

Projeto de desenvolvimento para uma escola, cerca de 300 alunos, com carteira individual, pedidos antecipados, PDV, estoque por unidade, pagamentos, relatórios e auditoria. Next.js + TypeScript strict + Firebase, com hospedagem desejada na Vercel.

Comece em [START-HERE.md](START-HERE.md). O modelo preferido já está configurado como Claude Sonnet 5.5. Este pacote organiza o trabalho; a aplicação ainda será implementada.

| Caminho | Função |
| --- | --- |
| CLAUDE.md | Invariantes e instruções curtas carregadas no projeto |
| PROGRESS.md | Estado real e próxima ação, inicialmente F01 |
| .claude/settings.json | Modelo e esforço padrão |
| .claude/skills | 14 workflows nativos do Claude Code, acionados por etapa |
| .claude/rules | Cinco regras por caminho, com carregamento específico |
| docs/tasks | 24 tarefas com dependências, contexto, aceites e sequência explícita de skills |
| docs/domains | Regras completas de produto divididas por domínio |
| docs/firebase | Schema, queries, Auth/realtime, rules e transações |
| docs/testing | 38 critérios originais organizados por área |
| docs/status | Evidência e status inicialmente não executado |
| docs/context-map.json | Roteamento legível por máquina |
| docs/spec-index.md | Índice da fonte canônica |
| firebase.json + firebase/ | Configuração inicial de emuladores; rules deny-all |
| src/ + tests/ + scripts/ | Diretórios reservados para implementação |
| .env.example | Modelo sem segredos, a conectar em F01/F18 |

Escopo preservado: uma escola, Firebase como persistência/identidade, vários responsáveis por aluno, dinheiro em centavos, recarga integral, limites por consumo, estoque físico/planejado, cancelamento para carteira e cartão online 1x. Direção clean, produtos fotografados e movimento discreto, sem excesso de cards.

O agente deve completar A–E, passando por tarefas menores. Pastas vazias/documentação não contam como entrega funcional. F01 deve acrescentar comandos reais de instalação/dev/build/test, dependências travadas, configuração de runtime e CI. F24 finaliza os manuais de operação/implantação e pendências de produção.

Workflow e uso direto: [docs/skill-workflow.md](docs/skill-workflow.md). Ferramentas/instalação/fallback: [docs/development-tools.md](docs/development-tools.md). Utilitários incluídos: scripts/agent-context.ts e scripts/run-check.ts, executáveis com Node 24.12+.
