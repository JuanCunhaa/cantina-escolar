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

Sessão anterior (02/10, tarde; não arquivada em JSON, registrada no PROGRESS): app local × homologação com 1ª entrega de 23–28 s em ~65% das aberturas; Web SDK em Node (gRPC) 0/10 lentas; trace do app com long-polling forçado mostrando o GET de retorno pendente ~28 s no fio e devolvendo a alteração só ao terminar.

## Hipóteses e conclusões

| Hipótese | Evidência | Conclusão |
|---|---|---|
| Código/tela da aplicação | 7 eventos lentos na página mínima, sem nenhum código do app (Chromium e Firefox) | **Descartada** como causa necessária |
| Motor do navegador | Lentas em Chromium (3) e Firefox (4); Edge 0/8 (amostra pequena) | **Descartada** (não é específico do Chromium) |
| Caminho/forma da escrita | Lentas com `set` simples pelo Admin SDK; rota publicada do app e transação equivalente sem lentas nas séries (6 + 6) | **Descartada** como causa necessária |
| Rajada de envios / inscreve-cancela-inscreve (modo estrito do React) | Com rajada 3/54, sem rajada 4/108 | **Descartada** |
| Quantidade/ordem de listeners, Firestore criado antes do login | 0/6 em cada variação; lentas também só com 4 listeners | Sem efeito observado |
| Canal dividido entre IPv4/IPv6 ou frontends | No evento lento registrado (Firefox), abertura e retorno no MESMO IPv6; IPv4 fixo 0/16 × padrão 1/16 | Não sustentada (amostra insuficiente para descartar a família de IP) |
| QUIC | Sessão anterior: uma rodada lenta com QUIC desligado; Firefox também atrasa | Não é necessário QUIC |
| Retenção de streaming por proxy/rede | Sessão anterior: em long-polling (resposta completa por requisição) o GET ficou ~28 s pendente e só então trouxe a alteração | Contra retenção de streaming; compatível com servidor/frontend segurando a resposta |
| Rules com `get()` do perfil | Mesmas Rules no Node/gRPC sem lentas (0/30 + 0/10); navegador 7/162 | **Não descartada** (p ≈ 0,30) |
| Transporte WebChannel (cliente) × gRPC | Navegador 7/162 × Node 0/30 | **Não descartada** (p ≈ 0,30) |
| Rede/ISP desta estação × backend do Firebase | Só uma rede testada | **Não testada** — principal lacuna |
| Variação no tempo | Lentas em ondas (muitas à tarde; agrupadas em minutos seguidos) | Observado; explica amostras pequenas sem eventos |

Assinatura comum a todos os eventos: 1º snapshot imediato; primeira alteração entregue ~24–30 s após a ABERTURA do canal (não após a escrita, que sempre ocorreu ~2 s depois do snapshot); alterações seguintes imediatas; um único GET de retorno e confirmação de recebimento (`AID`) só quando os dados chegam.

## O que NÃO foi feito e por quê

- Nenhuma mudança no app, nas Rules, nos timeouts ou no transporte: a causa não foi identificada e as mudanças testadas (long-polling forçado, `timeoutSeconds`) não eliminaram o atraso.
- Outra rede: não disponível nesta máquina. Opções que exigem decisão do dono: (a) rodar `tools/listener-repro` de outra rede (ex.: roteador do celular) — basta `npx vite build -c tools/listener-repro/vite.config.ts` e `node tools/listener-repro/run.ts ...` com o `.env.staging.local`; (b) runner do GitHub Actions como "outra rede", o que exigiria cadastrar credenciais da homologação como segredos do repositório.
- Nenhuma issue pública nem mensagem ao suporte: rascunho em `docs/status/listener-delay-support-draft.md` para revisão.

## Próximos passos sugeridos

1. Mesma série intercalada (`tools/listener-repro/interleave.ps1`) de outra rede, num horário com muitos eventos; comparar com esta máquina no mesmo período.
2. Série intercalada longa navegador × Node (gRPC) num período de muitos eventos, para decidir se o gRPC também é afetado (separa WebChannel × backend de watch).
3. Com a decisão de 1–2: enviar o relato ao suporte (Firebase) com os JSON sanitizados, ou tratar como condição de rede local.
4. Mitigação de UX independente da causa, se o dono quiser: refletir na tela o resultado já confirmado pelo comando (ex.: a chave da foto devolvida pelo upload; o dia salvo no calendário) em vez de depender só do listener — decisão de produto, não aplicada.

## Execução

- Skills invocadas via ferramenta Skill: cantina-debug, cantina-firebase, cantina-testing, cantina-verify.
- Checks da branch (só ferramentas e documentação; nada em src/, Rules ou testes do app): typecheck 0, lint 0 (ESLint passa a ignorar `**/dist/**`, saída do empacotamento da reprodução). Varredura de segredos nos arquivos alterados: nenhum token, chave, e-mail de conta ou uid.
- Firefox do Playwright (v1543) instalado nesta máquina para a comparação entre motores (sem mudança no package.json).
