# Experimento dirigido no CI: atraso de listener (homologação)

Branch `diagnostico/listener-ci-hml`, 03/10/2026. Complementa `listener-delay-investigation.md` (PR #4, **causa não identificada**). Este experimento é **separado dos gates financeiros e do CI exigido**: não bloqueia nem substitui nenhum check, e o PR que o carrega não deve ser mesclado sem decisão do dono.

## Pergunta e desenho

O atraso local aparece como uma entrega ~24–30 s após a **abertura do canal**, com a escrita sempre feita ~2 s depois do 1º snapshot (limitação já registrada: o instante da escrita nunca variou). Aqui a escrita varia: **2, 10 e 35 s contados da inscrição do listener**, 3 execuções por intervalo = **9 rodadas** (limite desta etapa; nenhuma rodada extra, nenhuma repetida).

- Reprodução mínima reaproveitada (`tools/listener-repro/main.ts`): Web SDK firebase **12.19.0**, transporte padrão, sem código da aplicação, sem churn, um listener (`probe`).
- Executor novo `tools/listener-repro/ci-run.ts` (uma rodada por job), mesmas medições do `run.ts`: inscrição, 1º snapshot (com `fromCache`), confirmação da escrita (Admin SDK), snapshot com o valor novo (com `fromCache`), requisições do canal `Listen` (início, tipo, nomes de parâmetros, falhas, IP do Google), chegada dos blocos de bytes na camada de rede (CDP) e avisos/erros do SDK no console.
- GitHub Actions (`.github/workflows/listener-diagnostic.yml`, workflow próprio, só por push nesta branch), `ubuntu-latest` (ubuntu24), Node v24.21.0, **Chromium 153.0.8010.12 / Playwright 1.63.0 / firebase 12.19.0 — os mesmos da comparação local** (todas as séries Chromium locais usaram `chromium 153.0.8010.12`). Uma rodada por vez (`max-parallel: 1`), intercaladas por rodada (2, 10, 35 s; 2, 10, 35 s; …) para reduzir o efeito do horário. Run **37098798557**, commit `c451a87`, 9/9 jobs concluídos sem falha de infraestrutura.

## Autorização restrita e credenciais

- Destino único: `cantina-escolar-hml` (o executor aborta se o projeto, a conta de serviço ou o e-mail forem outros, ou se variável de emulador estiver definida).
- Conta fictícia **própria do diagnóstico** (`listener-diag@hml.example.test`), **sem perfil em `users/`** (não acessa nada do app) e **sem alteração de Rules**: ela só lê o próprio `foundationProbes/{uid}` (regra existente, `isOwner`); a escrita é do Admin SDK nesse mesmo documento (campo `n`), apagado a cada rodada. Nenhuma carteira, crédito, pagamento ou Rules foram tocados; não houve uso do Vercel nem de bypass.
- Credenciais só por secrets do **ambiente restrito** `diagnostico-listener` (publicável apenas pela branch do diagnóstico), `permissions: contents: read`; a conta de serviço entra como base64 numa variável de ambiente do passo e nunca é impressa; o executor não loga erro bruto. Os artefatos (JSON) têm só tempos, nomes de parâmetros e IPs públicos do Google (varredura de segredos: nada encontrado).
- **Limpeza feita ao fim** (`node tools/listener-repro/ci-setup.ts cleanup`): os 4 secrets, a conta fictícia, o documento de sonda e o ambiente foram apagados. Como uma cópia da chave de serviço da homologação ficou ~20 min em secrets do GitHub, **recomenda-se a rotação dessa chave** (ação do dono; não feita).

## Resultados (9 rodadas, todas preservadas em `tools/listener-repro/results/ci/`)

| Rodada | Escrita alvo / real (ms após inscrição) | 1º snapshot (ms) · fromCache | Confirmação da escrita (commit, ms) | Snapshot com valor novo (ms após inscrição) · fromCache | commit→snapshot (ms) | Requisições do canal (BACK renovados) | Erros do SDK / avisos no console / falhas de requisição |
|---:|---|---|---:|---|---:|---|---|
| 1 | 2 s / 2001 | 1590 · false | 200 | 2208 · false | 7 | 2 (0) | 0 / 0 / 0 |
| 1 | 10 s / 10000 | 1433 · false | 183 | 10189 · false | 6 | 2 (0) | 0 / 0 / 0 |
| 1 | 35 s / 35002 | 2013 · false | 234 | 35420 · false | 184 | 9 (7) | 0 / 0 / 6 |
| 2 | 2 s / 2001 | 1515 · false | 175 | 2178 · false | 2 | 2 (0) | 0 / 0 / 0 |
| 2 | 10 s / 10001 | 1183 · false | 223 | 10447 · false | 223 | 8 (6) | 0 / 0 / 5 |
| 2 | 35 s / 35004 | 413 · false | 200 | 35210 · false | 6 | 2 (0) | 0 / 0 / 0 |
| 3 | 2 s / 2002 | 1184 · false | 175 | 2333 · false | 156 | 8 (6) | 0 / 0 / 4 |
| 3 | 10 s / 10002 | 1488 · false | 789 | 10799 · false | 8 | 2 (0) | 0 / 0 / 0 |
| 3 | 35 s / 35004 | 2249 · false | 248 | 35279 · false | 27 | 2 (0) | 0 / 0 / 0 |

Resumo: **9/9 entregues, 0 lentas (> 5 s)**, nenhuma sem entrega na janela de 60 s; maior `commit→snapshot` = 223 ms. O primeiro snapshot foi sempre do servidor (`fromCache=false`, sem snapshot de cache antes) e o snapshot com o valor novo também. Nenhum erro do SDK (callback de erro), nenhum aviso/erro de console, nenhum erro de página.

**Reconexões observáveis:** em 3/9 rodadas (2 s r3, 10 s r2, 35 s r1) o GET de retorno do canal foi renovado várias vezes (6–7 renovações, aparecendo como `requestfailed` do tipo `BACK`: ~1–2 s após a abertura e de novo perto do instante da escrita; na rodada 35 s r1 também aos ~32 s) e a entrega nessas rodadas levou 156–223 ms em vez de ~2–8 ms; ainda assim muito abaixo do limiar de 5 s e sem erro do SDK. Não se sabe se a renovação é do SDK, do proxy ou do runner; o evento não tem relação aparente com o intervalo da escrita (um em cada intervalo).

## Comparação com os registros locais (`tools/listener-repro/results/`)

| | Local (02/10) | CI (03/10) |
|---|---|---|
| Navegador / SDK | Chromium 153.0.8010.12, firebase 12.19.0 | **idênticos** (Playwright 1.63.0) |
| Rodadas Chromium | 135 arquivadas (todas as séries) | 9 |
| Lentas (> 5 s) | 4 (3,0%): 26453, 27006, 23995, 26204 ms após o commit (28,7/29,3/26,3/28,5 s após a abertura do canal) | **0** |
| Mediana das rápidas (commit→snapshot) | 19 ms (máx. 101) | 8 ms (máx. 223; 3 rodadas com renovação do canal) |
| 1º snapshot após a inscrição (mediana) | 142 ms | 1488 ms |
| Confirmação da escrita (mediana) | 37 ms | 200 ms |
| Servidor do canal | IPv6 (2800:3f0:4001…) e IPv4 172.217.x | IPv4 142.251.x (região do runner não medida) |
| Escrita | ~2 s após o 1º snapshot, sempre | 2, 10 e 35 s após a inscrição |
| Medida / listener / conta | calendário (ou sonda), 2 listeners, conta fixture de administração | sonda `foundationProbes/{uid}`, 1 listener, conta fictícia própria sem perfil |
| Rede | uma estação, dual-stack, Brasil | runner do GitHub (Azure; latência até `southamerica-east1` visivelmente maior: 1º snapshot e commit ~10× e ~5× mais lentos) |

## Limitações

- **Amostra pequena e poder baixo**: com a taxa local de 3,0% (ou 4,5%, a da página mínima), a chance de **0 eventos em 9 rodadas é ~76% (ou ~66%)** — a ausência de evento aqui é o resultado esperado também se o problema existir na mesma taxa. Nenhuma conclusão estatística (nem a favor nem contra) é possível; 6 rodadas antes de 28 s e 3 depois de 28 s de idade do canal não permitem testar a hipótese "atraso ligado à idade do canal".
- **Vários fatores mudaram ao mesmo tempo** (documento, nº de listeners, conta/Rules sem `get()` de perfil — a regra de `foundationProbes` não consulta o perfil —, âncora da escrita, rede, região, família de IP, relógio). Não se isolou nenhum deles.
- Um runner (Azure/GitHub) e uma hora (05:07–05:23 UTC de 03/10); sem controle de carga/horário; headless Chromium igual ao local. O GET de retorno foi observado por CDP, mas nenhuma rodada foi lenta, então **o ponto onde os bytes ficam retidos continua desconhecido**.
- Latência maior do runner até a região do Firestore (1º snapshot 1,5 s) muda o instante relativo da escrita ao 1º snapshot (no intervalo de 2 s, a escrita ocorreu ~0,4–0,8 s depois do 1º snapshot; local: ~2 s).
- Resultado financeiro, de autorização e de confirmação de comandos **não** é medido aqui; a carteira não foi usada.

## Conclusão

**Não reproduzido nesta amostra** (0/9 rodadas lentas, com escritas aos 2, 10 e 35 s da inscrição, contra a homologação a partir de um runner do GitHub com o mesmo Chromium e o mesmo SDK da comparação local). Isso **não** resolve o problema e **não** o descarta: a amostra é pequena demais para distinguir taxa zero de taxa de ~3–5%. A diferença de ambiente (runner × estação local) também **não prova**, sozinha, que a rede local seja a causa — vários fatores diferem ao mesmo tempo, e a própria ausência de evento é esperada com boa probabilidade mesmo se o problema existisse no CI. O diagnóstico do PR #4 permanece **INCONCLUSIVO**; nenhuma mudança no app, nas Rules, nos timeouts ou no transporte foi feita ou sugerida por este resultado.

Se o dono quiser avançar (decisões abertas): (a) uma série longa e intercalada no CI e na estação local no mesmo período (centenas de rodadas, não 9) para comparar taxas com poder estatístico; (b) variar a latência até o backend sem mudar o resto; (c) enviar o relato ao suporte (`listener-delay-support-draft.md`) incluindo este resultado como "não reproduzido a partir do CI". Qualquer nova execução exige nova autorização (limite desta etapa: 9 rodadas) e recriar o ambiente com `node tools/listener-repro/ci-setup.ts setup`.

## Reproduzir

```
node tools/listener-repro/ci-setup.ts setup      # local: ambiente restrito, conta fictícia própria e secrets (não imprime valores)
git push origin diagnostico/listener-ci-hml      # com mudança em ci-run.ts ou no workflow: dispara as 9 rodadas
gh run download <run-id> -D out                  # artefatos diag-<s>s-r<n> (JSON sanitizado)
node tools/listener-repro/ci-summarize.ts <pasta com rodada-*.json>
node tools/listener-repro/ci-setup.ts cleanup    # apaga secrets, conta, documento e ambiente
```
