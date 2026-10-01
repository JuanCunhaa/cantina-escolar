## 8. Calendário, turnos e horários

Turnos iniciais: manhã e tarde. O turno está no ALUNO, não na conta do responsável. Salve data e turno no pedido. Horários independentes e configuráveis no painel:

| Turno | Fecha compra antecipada para o próprio dia | Fecha cancelamento familiar |
| --- | --- | --- |
| Manhã | 07:00 | 08:00 |
| Tarde | 14:00 | 15:00 |

Use regra explícita: ao atingir o horário (`agora >= limite`), a ação está encerrada. Às 07:00 não confirmar novo pedido antecipado da manhã; às 08:00 não permitir cancelamento familiar da manhã. A diferença entre fechar compra e fechar cancelamento é intencional.

É possível comprar para hoje antes do limite do turno e até sete dias corridos à frente, inclusive hoje + 7. Dias sem funcionamento ficam bloqueados e não estendem a janela para “sete dias úteis”. Amanhã ainda é permitido depois do limite de hoje. Um filho da manhã não compra o turno da tarde por usar outro horário.

Valide horário, calendário e janela novamente no checkout. Carrinho aberto antes do fechamento não garante compra após o horário. Valide tudo no backend com o horário do servidor.

Salve os limites/política aplicados no pedido para que o prazo de cancelamento já informado seja estável. Alterações administrativas afetam novos pedidos; caso a escola queira afetar pedidos existentes, exija ação explícita, prévia dos afetados e auditoria. Dias letivos extras podem ser habilitados individualmente.

O fechamento de pedidos antecipados NÃO bloqueia PDV no próprio dia. Venda de balcão continua conforme disponibilidade, permissões e funcionamento.
