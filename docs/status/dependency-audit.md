# Auditoria de dependências de produção (`npm run audit:prod`)

Análise de 30/09/2026 (F03), revisada e fechada em 01/10/2026. IDs, severidades e faixas conferidos com `gh api advisories/<ID>` e `npm audit --json`.

## Advisories (IDs exatos)

| ID | Pacote | Severidade (advisory) | Alcance | Faixa afetada → corrigida | Estado antes | Estado agora |
| --- | --- | --- | --- | --- | --- | --- |
| GHSA-m9gg-hp2v-232j | `@grpc/grpc-js` | alta | servidor gRPC com `requireClientCertificate:false` e uso de `getAuthContext` | < 1.13.6 / 1.14.0–1.14.4 → 1.13.6, 1.14.5 | reportado: cópia 1.9.16 (cadeia `firebase`) | 1.14.5 em todas as cópias |
| GHSA-f596-whhp-79r4 | `@grpc/grpc-js` | **baixa** (o npm agrupa o pacote como "alta" pelo m9gg) | servidor gRPC devolve mensagem de erro de handler ao cliente | idem | reportado: cópia 1.9.16 | 1.14.5 |
| GHSA-99f4-grh7-6pcq | `@grpc/grpc-js` | alta | **cliente e servidor**: mensagem comprimida malformada derruba o processo | < 1.9.16; 1.10.x < 1.10.12; 1.11.x < 1.11.4; 1.12.x < 1.12.7; 1.13.x < 1.13.5; 1.14.x < 1.14.4 | **não reportado**: cópias 1.9.16 (corrigida) e 1.14.5 (corrigida) | 1.14.5 em todas as cópias |
| GHSA-w5hq-g745-h8pq | `uuid` | média | `v3()/v5()/v6()` com `buf` externo | < 11.1.1 (e 12.0.0, 13.0.0) → 11.1.1, 12.0.1, 13.0.1 | reportado: `uuid` 9.0.1 (cadeia `firebase-admin`) | 11.1.1 |

Correção desta revisão: a versão anterior deste arquivo não citava o GHSA-99f4-grh7-6pcq e generalizava que as falhas do `@grpc/grpc-js` eram "do lado servidor". Isso vale só para m9gg e f596 (confirmado no texto dos advisories). O 99f4 afeta cliente e servidor; a conclusão correta é que **não havia exposição** a ele porque as duas cópias instaladas já estavam na versão corrigida (1.9.16 ≥ 1.9.16 e 1.14.5 ≥ 1.14.4), e por isso o `npm audit` não o lista. Também corrige-se a severidade do f596 (baixa). O m9gg e o f596 foram publicados em 30/09/2026.

Cadeias de produção reportadas: `firebase` 12.19.0 → `@firebase/firestore` 4.17.2 → `@grpc/grpc-js` ~1.9.0; `firebase-admin` 14.5.0 → `@google-cloud/storage` 8.2.0 → `gaxios` ^6.0.2 (6.7.1) → `uuid` ^9.0.1. O caminho do Admin SDK para o Firestore (`google-gax`) já usava `@grpc/grpc-js` 1.14.5.

## Impacto (antes da correção)

- m9gg/f596: do lado servidor gRPC, que a aplicação não executa; o SDK web só usa `@grpc/grpc-js` no build Node (testes contra o emulador), não no navegador. Não alcançável em produção.
- 99f4: sem exposição (versões já corrigidas).
- w5hq: `gaxios` 6.7.1 só chama `uuid.v4()` sem `buf` (boundary multipart). Não alcançável.

## Solução aplicada (01/10/2026)

Autorizada para correção local. Sem downgrade, sem `npm audit fix --force`.

1. **Dentro dos intervalos suportados / dependência responsável: não há correção.** `firebase` 12.19.0 e `@firebase/firestore` 4.17.2 são as últimas estáveis (o dist-tag `next`, 4.18.0-20260929…, continua com `@grpc/grpc-js ~1.9.0`); `@google-cloud/storage` 8.2.0 e `firebase-admin` 14.5.0 são as últimas e mantêm `gaxios ^6.0.2` → `uuid ^9.0.1` (o `gaxios` 7.x já não depende de `uuid`, mas o `@google-cloud/storage` não o aceita). `npm outdated` só lista eslint 10, typescript 7 e firebase-tools 15.32.1 (ferramentas de desenvolvimento, fora do problema). Atualizar o lockfile dentro dos intervalos não muda nada.
2. **Override necessário e mínimo**, com versão corrigida, restrito às duas cadeias, em `package.json`:

```json
"overrides": {
  "@firebase/firestore": { "@grpc/grpc-js": "1.14.5" },
  "@google-cloud/storage": { "gaxios": { "uuid": "11.1.1" } }
}
```

Efeito no lockfile: uma única cópia hoistada de `@grpc/grpc-js` 1.14.5 (as cópias aninhadas 1.14.5 e a 1.9.16 foram unificadas; `@grpc/proto-loader` 0.7.15 do SDK web e 0.8.1 do restante permanecem) e `uuid` 11.1.1 sob `gaxios` 6.7.1.

## Compatibilidade demonstrada

- `npm run audit:prod`: **0 vulnerabilidades** (antes: 2 avisos-raiz / 6 contados).
- Suíte completa uma vez após a mudança: typecheck 0; lint 0; unit 34/34; rules 26/26 (o SDK web em Node usa o `@grpc/grpc-js` 1.14.5 contra o emulador); integration 46/46 (Admin SDK, Storage e Firestore); e2e 12/12; `build:webpack` 0.
- `uuid` 11.1.1 com `gaxios` 6.7.1: requisição multipart real (script isolado) gerou `Content-Type: multipart/related; boundary=<uuid v4>` e foi aceita por um servidor HTTP local (status 200).
- Limite da prova: o caminho do SDK web com grpc-js 1.14.5 foi exercitado só no emulador (Node); o navegador não usa grpc-js.

## Limitações e manutenção

- Os overrides ficam fora do intervalo declarado por `@firebase/firestore` (`~1.9.0`). Remover quando `firebase`/`@firebase/firestore` subirem o intervalo e o `@google-cloud/storage` subir o `gaxios`; rever a cada atualização de `firebase`/`firebase-admin` (`npm ls @grpc/grpc-js uuid`).
- `npm audit` completo (com dependências de desenvolvimento) ainda lista 3 avisos moderados (GHSA-8988-4f7v-96qf, `@opentelemetry/core` < 2.8.0, via `firebase-tools` → `@google-cloud/pubsub`). É ferramenta de desenvolvimento, fora do `audit:prod`; a "correção" sugerida pelo npm exige `--force` (downgrade do firebase-tools) e não foi aplicada.
