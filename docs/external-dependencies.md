# Pendências externas e trabalho independente

| Pendência | Necessária para | Pode avançar sem ela |
| --- | --- | --- |
| Projeto/conta Firebase homologação | Configurar serviços/cloud e validar fora do emulador | F01–F17 usando Emulator Suite |
| Storage/faturamento/região | Upload/homologação cloud e custos | Fluxo e rules em Storage Emulator |
| Provedor Pix/cartão e elegibilidade | Adapter final e homologação de pagamento | Contratos, estados e testes; não inventar API/confirmar integração |
| Credenciais gateway sandbox/webhook | Evidência ponta a ponta do adapter real | Fixtures de contrato e integração interna, registradas como tal |
| Domínio/conta/plano Vercel | Domínios autorizados, callbacks e deploy final | Desenvolvimento/build e roteiro de implantação |
| Identidade/fotos da escola | Publicação com dados reais | Configuração e demo isolada/fictícia |

O provedor definitivo não foi escolhido no escopo. Levantar alternativas/elegibilidade no momento da decisão, sem escolher preço/API não verificados. Credenciais ausentes não impedem desenvolver o restante nem autorizam crédito simulado em produção.

Guardar segredos em ambiente seguro, nunca em PROGRESS.md/docs/Git. Pedir apenas o dado que realmente bloqueia a próxima ação dependente.
