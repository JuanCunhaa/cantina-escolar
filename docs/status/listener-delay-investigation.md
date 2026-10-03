# Investigação: atraso na entrega de listeners do Firestore (homologação)

Branch `investigacao/atraso-listener`, 02/10/2026. Estado: **causa NÃO identificada**; nenhuma correção aplicada ao app. Reprodução mínima e relato para o suporte prontos para revisão do dono (nada foi enviado).

## Sintoma

Em navegador, contra o backend de homologação (`cantina-escolar-hml`, Firestore sa-east1), a **primeira alteração** de um documento escutado, depois de abrir a página, às vezes chega ao listener só **~21–27 s após o commit** (≈ 24–30 s após a abertura do canal). O snapshot inicial chega normalmente (~0,2 s) e as alterações seguintes chegam em milissegundos. Efeitos vistos: foto do produto que demora a aparecer após o upload (F06) e `calendar.spec` (F05) na homologação. A gravação no servidor está correta em todos os casos (confirmada por leitura do Admin SDK); o atraso é só de entrega ao cliente.

## Instrumento

`tools/listener-repro/` (uso no cabeçalho de cada arquivo):
- página mínima com o MESMO Web SDK do projeto (firebase 12.19.0, empacotado com o Vite já presente), login e-mail/senha da conta fixture de administração, listeners no backend de homologação, **sem nenhum código da aplicação**;
- executor em Node: grava pelo Admin SDK (ou pela transação equivalente, ou pela própria rota publicada do app), mede `login pronto → inscrição → 1º snapshot do servidor → commit → snapshot atualizado → renderização`, registra início/fim e servidor (IP) das requisições do canal `Listen` e, opcionalmente, a chegada dos bytes do GET de retorno (CDP);
- linha de base em Node (`node-baseline.ts`: o mesmo Web SDK usa gRPC/HTTP2 em Node, não WebChannel);
- medição do app (`app-measure.spec.ts`, config própria, fora do `staging:verify`): tela do calendário e fluxo da foto (envio → confirmação → listener → GET da foto → imagem carregada);
- resultados sanitizados (só tempos, nomes de parâmetros, hashes de sessão e IPs públicos do Google; sem token, e-mail, senha ou uid) em `tools/listener-repro/results/`, agregados por `summarize.ts`.

Escritas fictícias e transitórias: `calendarDays` com datas de 2027/2028 (apagadas em seguida; pela rota do app quando o modo era `api`) e o campo `n` de `foundationProbes/{uid da fixture}`. Produtos temporários da medição da foto foram desativados (nada apagado; objetos novos no R2 de homologação, nenhum removido).

## Resultados (218 rodadas, todas preservadas)

"Lenta" = entrega > 5 s após o commit (nenhuma rodada ficou sem entrega na janela de medição de 60 s).

| Cenário | Rodadas | Lentas (> 5 s) | Mediana das rápidas (ms) | Lentas (ms) |
|---|---:|---:|---:|---|
| fumaca | 1 | 0 | 14 | — |
| M1-chromium-padrao | 6 | 0 | 22 | — |
| M2-chromium-listeners-da-tela | 6 | 0 | 22 | — |
| HB-chromium-churn | 6 | 0 | 14 | — |
| HA-chromium-firestore-antes-do-login | 6 | 0 | 25 | — |
| W-tx-chromium | 6 | 0 | 24 | — |
| W-api-publicada-chromium | 6 | 0 | 15 | — |
| HC-chromium-stagger-30 | 4 | 0 | 14 | — |
| HC-chromium-stagger-100 | 4 | 0 | 18 | — |
| APP-calendario (URL publicada) | 4 | 0 | 6 | — |
| APP-calendario (app local, next dev) | 4 | 2 | 6 | 23563, 21527 |
| HD-chromium-rajada-churn | 8 | 2 | 24 | 26453, 27006 |
| HD-chromium-rajada-sem-churn | 8 | 1 | 25 | 23995 |
| HD-debug-rajada-churn | 6 | 0 | 21 | — |
| HD-cdp-rajada-churn | 8 | 0 | 24 | — |
| HD-replica-rajada-churn | 8 | 0 | 27 | — |
| fumaca-firefox | 1 | 0 | 9 | — |
| INT-navegadores-chromium-padrao | 8 | 1 | 14 | 26204 |
| INT-navegadores-chromium-rajada | 8 | 0 | 17 | — |
| INT-navegadores-firefox-padrao | 8 | 2 | 13 | 25694, 27176 |
| INT-navegadores-firefox-rajada | 8 | 0 | 7 | — |
| INT-navegadores-msedge-padrao | 8 | 0 | 17 | — |
| INT-ip-chromium-padrao | 8 | 0 | 12 | — |
| INT-ip-chromium-ipv4 | 8 | 0 | 13 | — |
| INT-ip-firefox-padrao | 8 | 1 | 5 | 25929 |
| INT-ip-firefox-ipv4 | 8 | 0 | 9 | — |
| NODE-grpc | 30 | 0 | 16 | — |
| LP-chromium-longpolling | 20 | 0 | 21 | — |
| APP-foto (URL publicada) | 4 | 1 | 865 | 21542 |

Total: 218 rodadas em 29 cenários.

Sessão anterior (02/10, tarde; não arquivada em JSON, registrada no PROGRESS): app local × homologação com 1ª entrega de 23–28 s em ~65% das aberturas; Web SDK em Node (gRPC) 0/10 lentas; um trace do app com long-polling forçado (NÃO arquivado) em que, entre ~0,6 s e ~28,8 s após a abertura, não aparece nenhuma requisição do canal e o cliente só confirma o recebimento (AID) em ~28 s. Esse trace não permite afirmar quem segurou os dados: o servidor, algum ponto do caminho ou o próprio cliente (sem GET aberto naquele intervalo).

## Hipóteses e conclusões

| Hipótese | Evidência | Conclusão |
|---|---|---|
| Código/tela da aplicação | 7 eventos lentos na página mínima, sem nenhum código do app (Chromium e Firefox) | Não é necessária para o atraso (a página mínima reproduz); não exclui que o app o agrave |
| Motor do navegador | Lentas: Chromium 4/115, Firefox 3/33, Edge 0/8 (amostra pequena) | Não é específico do Chromium (Firefox também atrasa); taxas por motor não comparáveis (amostras e condições diferentes) |
| Caminho/forma da escrita | Lentas com `set` simples pelo Admin SDK; rota publicada do app e transação equivalente sem lentas nas séries (6 + 6) | Não é necessária (ocorre com `set` simples); 0/12 nos outros caminhos não mostra imunidade |
| Rajada de envios / inscreve-cancela-inscreve (modo estrito do React) | Com rajada 3/54, sem rajada 4/102 | Não é necessária (ocorre sem rajada); sem diferença demonstrável entre as taxas |
| Quantidade/ordem de listeners, Firestore criado antes do login | 0/6 em cada variação; lentas também só com 4 listeners | Sem efeito observado |
| Canal dividido entre IPv4/IPv6 ou frontends | No evento lento registrado (Firefox), abertura e retorno no MESMO IPv6; IPv4 fixo 0/16 × padrão 1/16 | Não sustentada (amostra insuficiente para descartar a família de IP) |
| QUIC | Sessão anterior: 1 rodada lenta com QUIC desligado no Chromium (não arquivada); Firefox também atrasa, mas também usa QUIC | **Não conclusivo** (1 observação) |
| Retenção de streaming por proxy/rede | Em long-polling forçado: 0/20 lentas na página mínima (arquivadas) e 1 lenta no app (trace não arquivado, ver acima); no streaming padrão, o único caso lento com tempos de rede (Firefox) mostra o cliente confirmando o recebimento só em ~28 s, sem informar em que ponto os bytes ficaram | **Não conclusivo**: não há captura do instante de chegada dos bytes (`--cdp`) em nenhum caso lento; as 8 rodadas com `--cdp` não tiveram evento |
| Rules com `get()` do perfil | Mesmas Rules no Node/gRPC sem lentas (0/30 arquivadas; 0/10 na sessão anterior, não arquivadas); navegador 7/156 | **Não descartada** (p ≈ 0,25) |
| Transporte WebChannel (cliente) × gRPC | Navegador 7/156 × Node 0/30 | **Não descartada** (p ≈ 0,25: com 4,5% de taxa, 30 rodadas sem evento ocorrem em ~1 de cada 4 séries) |
| Rede/ISP desta estação × backend do Firebase | Só uma rede testada | **Não testada** — principal lacuna |
| Variação no tempo | Eventos próximos no tempo (ex.: 3 em ~2 min na série da rajada, 2 em ~1 min no Firefox) e séries inteiras sem evento | Observação NÃO testada (sem controle de horário nem de carga); apenas explica por que séries pequenas podem não ter eventos |

Assinatura comum a todos os eventos: 1º snapshot imediato; primeira alteração entregue ~24–30 s após a ABERTURA do canal (não após a escrita, que sempre ocorreu ~2 s depois do snapshot); alterações seguintes imediatas; um único GET de retorno e confirmação de recebimento (`AID`) só quando os dados chegam.

## Limitações dos testes (leia antes de tirar conclusões)

- **Uma rede, uma máquina, um backend, janela curta:** todas as séries partem desta estação (dual-stack, Brasil), contra o mesmo projeto, em cerca de uma hora de 02/10 mais a sessão anterior. Nada separa "rede local" de "serviço".
- **Taxa baixa e amostras pequenas:** ~4,5% das rodadas da página mínima foram lentas; as células comparadas têm 2–8 rodadas (grupos de 16–102). Nenhuma comparação (rajada, IPv4, motor, Node × navegador) é estatisticamente significativa; "sem evento" numa célula não prova ausência do problema.
- **Onde os bytes ficaram retidos é desconhecido:** nenhuma rodada lenta foi capturada com a chegada dos bytes na camada de rede (`--cdp`) nem com o log do SDK (`--debug`); as séries com essas opções tiveram 0 eventos. Os rastros de rede sem isso só mostram quando o cliente confirmou o recebimento.
- **Escrita sempre 2 s após o 1º snapshot:** em todos os eventos a entrega ocorreu ~26–30 s após a ABERTURA do canal. Como a escrita nunca variou, não se sabe se o instante da entrega está ligado à idade do canal (~28 s) ou ao tempo desde a escrita. Experimento barato e ainda não feito: variar o instante da escrita.
- **Linha de base Node não é equivalente:** transporte diferente (gRPC), mesmo processo e instâncias sequenciais; 0/30 não é evidência forte (p ≈ 0,25).
- **Séries do app pequenas:** 4 rodadas por cenário (calendário local 2/4 lentas; publicado 0/4; foto publicada 1/4), em ambientes diferentes (servidor de desenvolvimento × deployment).
- **Dados não arquivados:** a sessão anterior (taxa de ~65% no app local, Node 0/10, traces de long-polling, QUIC desligado) não tem JSON/trace preservado; vale como pista, não como medida.
- **Limites do instrumento:** "lenta" = entrega > 5 s; janela de medição de 60 s (nenhuma rodada ficou sem entrega); relógio único (mesma máquina) para todos os marcos; um navegador sempre headless via Playwright.
- **Ordem das séries:** as séries intercaladas reduzem, mas não eliminam, o efeito do momento; as demais foram sequenciais.

## O que NÃO foi feito e por quê

- Nenhuma mudança no app, nas Rules, nos timeouts ou no transporte: a causa não foi identificada e as mudanças testadas no app (long-polling forçado, `timeoutSeconds`) não eliminaram o atraso numa rodada cada (amostras de 1; não arquivadas), e na página mínima o long-polling teve 0/20 — sem diferença demonstrável em relação ao padrão com estes tamanhos de amostra.
- Outra rede: não disponível nesta máquina. Opções que exigem decisão do dono: (a) rodar `tools/listener-repro` de outra rede (ex.: roteador do celular) — basta `npx vite build -c tools/listener-repro/vite.config.ts` e `node tools/listener-repro/run.ts ...` com o `.env.staging.local`; (b) runner do GitHub Actions como "outra rede", o que exigiria cadastrar credenciais da homologação como segredos do repositório.
- Nenhuma issue pública nem mensagem ao suporte: rascunho em `docs/status/listener-delay-support-draft.md` para revisão.

## Próximos passos sugeridos

0. Variar o instante da escrita (ex.: 2 s, 10 s, 40 s após o 1º snapshot) em série intercalada, para ligar o atraso à idade do canal ou à escrita; capturar `--cdp` nos casos lentos.
1. Mesma série intercalada (`tools/listener-repro/interleave.ps1`) de outra rede, num horário com muitos eventos; comparar com esta máquina no mesmo período.
2. Série intercalada longa navegador × Node (gRPC) num período de muitos eventos, para decidir se o gRPC também é afetado (separa WebChannel × backend de watch).
3. Com a decisão de 1–2: enviar o relato ao suporte (Firebase) com os JSON sanitizados, ou tratar como condição de rede local.
4. Mitigação de UX independente da causa, se o dono quiser: refletir na tela o resultado já confirmado pelo comando (ex.: a chave da foto devolvida pelo upload; o dia salvo no calendário) em vez de depender só do listener — decisão de produto, não aplicada.

## Execução

- Skills invocadas via ferramenta Skill: cantina-debug, cantina-firebase, cantina-testing, cantina-verify.
- Checks da branch (só ferramentas e documentação; nada em src/, Rules ou testes do app): typecheck 0, lint 0 (ESLint passa a ignorar `**/dist/**`, saída do empacotamento da reprodução). Varredura de segredos nos arquivos alterados: nenhum token, chave, e-mail de conta ou uid.
- Firefox do Playwright (v1543) instalado nesta máquina para a comparação entre motores (sem mudança no package.json).

## Adendo (03/10/2026): experimento no CI

O passo 0 dos próximos passos (variar o instante da escrita) e a opção (b) de "outra rede" foram executados num runner do GitHub Actions (9 rodadas, escritas 2/10/35 s após a inscrição): **não reproduzido nesta amostra**, sem concluir nada sobre a causa. Ver `listener-ci-experiment.md`.
