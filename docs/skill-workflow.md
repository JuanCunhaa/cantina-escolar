# Skills acionadas por etapa

O pacote tem 14 skills: cinco workflows originais revisados e nove especializados. Elas são instruções nativas de projeto para Claude Code, não bibliotecas do produto. Não instalam CLI/plugin/MCP nem executam testes só por existirem.

`/cantina-task Fxx` lê a tarefa, identifica a etapa atual e aciona a skill pertinente via ferramenta Skill do Claude Code. Quando a ferramenta não existe/está indisponível, o agente lê seu SKILL.md e registra que usou por leitura. Esta é uma instrução explícita, não garantia de execução independente da capacidade/configuração do cliente; evidência no progresso é necessária.

## Catálogo

| Skill | Resultado | Gatilho |
| --- | --- | --- |
| cantina-task | Implementar uma das 24 tarefas | Manual, Fxx |
| cantina-resume | Retomar etapa atual/próxima elegível | Manual |
| cantina-context | Roteiar mudança sem tarefa definida | Contexto/domínio ambíguo |
| cantina-token-economy | Reduzir leituras e logs | Contexto da tarefa |
| cantina-architecture | Definir contratos/schema/fronteiras | Mudança arquitetural |
| cantina-firebase | Implementar dados/Auth/rules/listeners (arquivos: src/lib/storage, R2) | Alteração Firebase |
| cantina-finance | Garantir transações/invariantes do comando | Dinheiro/estoque/uso |
| cantina-ui | Entregar tela acessível e funcional | Interface |
| cantina-security | Revisar autorização/segredos/risco | Código sensível/limite de acesso |
| cantina-testing | Planejar e executar testes de negócio | Mudança que precisa evidência |
| cantina-verify | Fechar checks sem repetição | Fim de tarefa/marco |
| cantina-research | Confirmar versão/API oficial | Informação ainda desconhecida |
| cantina-debug | Diagnosticar causa de falha | Falha reproduzível |
| cantina-release | Preparar homologação/entrega | Etapa F24/solicitação de entrega |

As skills ficam em .claude/skills/<nome>/SKILL.md. Os dois comandos de execução são manuais; as especializadas podem ser usadas pelo agente conforme relevância. Descrições curtas continuam tendo custo de contexto; somente o corpo é carregado sob demanda. Evitar carregar as 14 numa mudança simples.

## Exemplo: F11 checkout

1. Usar cantina-token-economy para obter contexto da F11.
2. Usar cantina-architecture para definir contrato/limites de lote.
3. Usar cantina-testing para os casos negativos/concorrentes e IDs A10/A11/A12/A14/A15/A16/A17/A18/A35.
4. Usar cantina-firebase para documentos, leituras transacionais, índices e listener.
5. Usar cantina-finance para débito/pedido/reserva/uso idempotentes.
6. Usar cantina-ui para revisão de aluno/data/turno/preço e feedback de confirmação.
7. Usar cantina-security para acesso, adulteração de preço/ID, dupla cobrança e backend autorizado.
8. Usar cantina-verify para rodar os checks pendentes e registrar evidência. Se já foram executados após a última alteração, reutilizar evidência válida.

Em F02, não há skill financeira; segurança se restringe ao acesso/upload e testes a UI/armazenamento de arquivos. Em uma correção de espaçamento, não carregar arquitetura, gateway e regras de carteira. O fluxo é ajustado pela mudança real.

## Uso direto

```text
/cantina-firebase Implemente o schema e os índices necessários para a F11, seguindo os contratos atuais.
```

```text
/cantina-security Revise apenas as alterações da F14, com foco em acesso por aluno e corrida de cancelamento versus entrega.
```

```text
/cantina-testing executar F08: comprove transferência atômica e replay com Firebase Emulator Suite.
```

```text
/cantina-token-economy Reduza o contexto da tarefa atual preservando regras e logs de falha.
```

Não é preciso repetir esses pedidos a cada sessão: cada docs/tasks/Fxx.md possui a sequência e o orquestrador deve segui-la. PROGRESS.md registra os nomes realmente usados e modo invocação/leitura, mais evidências. Skill de segurança não dá selo de segurança; testes/scanners devem ser executados e o resultado avaliado.
