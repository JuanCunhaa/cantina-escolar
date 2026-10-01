# Tarefas de desenvolvimento

Executar uma tarefa por sessão/marco. O objetivo final continua sendo entregar todo o escopo A–E. Uma tarefa depende da implementação comprovada das predecessoras, não apenas de suas pastas.

Comando: `/cantina-task F01`. Retomada: `/cantina-resume`.

| ID | Etapa | Resultado | Dependências |
| --- | --- | --- | --- |
| [F01](F01.md) | A | Fundação técnica e prova de isolamento | — |
| [F02](F02.md) | A | Shell visual, navegação e fotos | F01 |
| [F03](F03.md) | B | Autenticação, papéis e autorização | F01 |
| [F04](F04.md) | B | Alunos, responsáveis, vínculos e convites | F03 |
| [F05](F05.md) | B | Escola, calendário e datas locais | F04 |
| [F06](F06.md) | B | Catálogo, preço histórico e canais | F02, F03 |
| [F07](F07.md) | B | Cardápio por data, turno e exceções | F05, F06 |
| [F08](F08.md) | B | Carteira, livro e transferências | F04 |
| [F09](F09.md) | B | Políticas, bloqueios e uso por consumo | F05, F08 |
| [F10](F10.md) | C | Estoque, cotas e custo médio | F06, F07 |
| [F11](F11.md) | C | Checkout antecipado e lote de datas | F07, F08, F09, F10 |
| [F12](F12.md) | C | Meus pedidos, extrato e realtime | F11 |
| [F13](F13.md) | C | Preparação, entrega parcial e não retirada | F11 |
| [F14](F14.md) | C | Cancelamentos e reembolsos | F13, F08 |
| [F15](F15.md) | C | PDV e venda direta | F09, F10, F11 |
| [F16](F16.md) | C | Reagendamento e troca de produtos | F13, F14, F15 |
| [F17](F17.md) | D | Secretaria, recarga manual e estorno | F08, F03, F15 |
| [F18](F18.md) | D | Adapters reais de Pix e cartão 1x | F08, F03 |
| [F19](F19.md) | D | Webhooks, conciliação e reversões | F18, F17 |
| [F20](F20.md) | D | Taxas, liquidação e fechamento de caixa | F15, F17, F19 |
| [F21](F21.md) | D | Relatórios e projeções reconstruíveis | F14, F16, F20 |
| [F22](F22.md) | D | Auditoria e rotinas de operação | F21 |
| [F23](F23.md) | E | Aceite integrado, segurança e UX | F22 |
| [F24](F24.md) | E | Homologação, backup e entrega | F23 |

F18 depende da escolha externa do gateway. Registrar código/testes prontos e homologação pendente separadamente; continuar trabalho independente. Segurança/auditoria/testes surgem em cada módulo desde F01/F03 e recebem revisão global em F22/F23.
