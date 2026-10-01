# Auditoria de dependências de produção (`npm run audit:prod`)

Análise de 30/09/2026 (F03). Nenhuma alteração de dependência foi aplicada: sem `npm audit fix --force` e sem o downgrade que o npm sugere (firebase 9.14.0, major anterior).

## Achados (2 avisos-raiz; o npm conta 6 por propagação)

| Aviso | Severidade | Cadeia (produção) | Versão instalada | Corrigido em |
| --- | --- | --- | --- | --- |
| GHSA-m9gg-hp2v-232j (`getAuthContext` pode tratar certificado não autorizado como autorizado) e GHSA-f596-whhp-79r4 (servidor gRPC devolve mensagens de erro do handler ao cliente, baixa) — `@grpc/grpc-js` | alta | `firebase` 12.19.0 → `@firebase/firestore` 4.17.2 → `@grpc/grpc-js` **1.9.16** (fixado em `~1.9.0` pelo SDK web) | 1.9.16 | ≥ 1.13.6 (1.14.5 é a última) |
| GHSA-w5hq-g745-h8pq (`uuid` v3/v5/v6 sem checagem de limites quando recebe `buf`) | moderada | `firebase-admin` 14.5.0 → `@google-cloud/storage` 8.2.0 → `gaxios` 6.7.1 → `uuid` **9.0.1** | 9.0.1 | ≥ 11.1.1 |

`firebase`, `@firebase/firestore`, `@firebase/firestore-compat` e `gaxios` aparecem só por propagação. O caminho do Admin SDK para o Firestore já usa `@grpc/grpc-js` 1.14.5 (corrigido); `firebase-tools`, que também traz `uuid` (14.x e 9.x), é dependência de desenvolvimento e fica fora do `--omit=dev`.

## Impacto real no produto

- **gRPC (alta)**: as duas falhas são do lado *servidor* gRPC (autenticação mTLS e mensagens de erro de handlers). A aplicação nunca abre servidor gRPC. O SDK web só usa `@grpc/grpc-js` no build Node (`index.node.*`); no navegador o Firestore usa WebChannel/fetch (`dist/index.esm.js` não referencia `@grpc/grpc-js`). Os imports de `firebase/*` ficam em componentes cliente e só inicializam em efeitos/handlers, portanto nenhuma conexão gRPC sai do servidor Next. O build Node do SDK web só é executado nos testes (`@firebase/rules-unit-testing`) contra o emulador local. **Não alcançável em produção**; risco residual: nenhum conhecido, mas o aviso persiste no relatório e a falha do CI `audit:prod` (`--audit-level=high`) continua.
- **uuid (moderada)**: o `gaxios` 6.7.1 só chama `uuid.v4()` sem `buf` (`node_modules/gaxios/build/src/gaxios.js:417`, fronteira de multipart). O defeito exige v3/v5/v6 com `buf` fornecido. **Não alcançável.**

## Solução compatível (validada só na resolução do lockfile)

Sobrescrever apenas as duas dependências transitivas por versões corrigidas do mesmo major de cada pacote, em `package.json`:

```json
"overrides": {
  "@firebase/firestore": { "@grpc/grpc-js": "1.14.5" },
  "@google-cloud/storage": { "gaxios": { "uuid": "11.1.1" } }
}
```

Em cópia isolada (scratchpad, sem tocar no projeto): `npm install --package-lock-only` resolveu `@grpc/grpc-js` 1.14.5 e `uuid` 11.1.1 na cadeia de produção e `npm audit --omit=dev` passou a reportar **0 vulnerabilidades**. É compatível com a API usada: o Admin SDK já roda com o grpc-js 1.14.5; `gaxios` só usa `v4` do uuid.

**Não aplicado** (decisão pendente do responsável): é uma sobrescrita fora do intervalo declarado por `@firebase/firestore` (`~1.9.0`). Antes de aplicar, rodar a suíte completa (rules e integração exercitam o grpc-js do SDK web contra o emulador) e o build. Alternativa sem override: aguardar versão do `firebase`/`@firebase/firestore` que suba o intervalo do grpc-js e do `@google-cloud/storage` que suba o `gaxios`, e então atualizar com a rotina de versões.

Enquanto não for aplicada, o job `audit:prod` do CI deve ser tratado como falha conhecida e documentada (nada novo foi introduzido; os dois avisos existem desde F01).
