# Migração do armazenamento de arquivos: Firebase Storage → Cloudflare R2

Data: 01/10/2026. Autorizada pelo dono do projeto (mudança de arquitetura). Escopo: **somente arquivos**. Firebase Auth e Firestore permanecem. F06 e a homologação completa não foram iniciadas.

## Estado

| Item | Estado |
| --- | --- |
| Código, testes locais, CI, documentação | Migrado e verde (abaixo) |
| Nenhum caminho depende do Firebase Storage | Sim: removidos Storage Rules, Storage Emulator, `firebase/storage` (cliente) e `firebase-admin/storage` (servidor) |
| Integração real com um bucket R2 | **Executada em 01/10/2026** contra o bucket de homologação `cantina-fotos-staging`: 3/3 passaram (ver "Integração R2 real") |
| Migração "completa"? | **Código completo e camada de armazenamento comprovada no R2 real.** Falta a homologação do app inteiro (Vercel + Firebase real, F24); não declarar homologada. |

## O que foi migrado

- `src/lib/storage/` (novo): contrato `ObjectStore`; `r2.ts` (S3-compatível, `@aws-sdk/client-s3` 3.1145.0 fixado); `local.ts` (disco, só `APP_ENV=emulator`, double de teste); `config.ts` (config fechada por ambiente); `image.ts` (bytes da imagem); `body.ts` (corpo com teto).
- `src/modules/catalog/photo.ts`: `uploadProductPhoto` e `readProductPhoto`; `photo-sweep.ts`: `sweepOrphanPhotos`.
- Rotas: `POST/GET /api/catalog/photo` (upload pelo servidor e leitura autenticada), `POST /api/admin/storage/sweep` (capacidade nova `storage.maintain`, só administração).
- UI: `ProductPhoto` busca a foto autenticada e usa blob local; `PhotoManager` envia os bytes ao servidor. Aparência, proporção 4:3 e fallback inalterados.
- Removidos: `firebase/storage.rules`, bloco `storage` do `firebase.json`, emulador `storage` dos scripts, `adminBucket`, variáveis `FIREBASE_STORAGE_*`/`NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, testes de Storage Rules (substituídos por testes do servidor).
- Preservado: foto validada nunca é sobrescrita (chave aleatória gerada no servidor + `If-None-Match: *`); mesmas permissões (cantina/admin enviam, perfil ativo lê); limite de 2 MB; revogação imediata pelo perfil atual (relido na transação de confirmação).

Decisões, limites e fontes: `docs/decisions.md` ("Armazenamento de arquivos em Cloudflare R2"). Contrato de campos: `docs/firebase/schema.md`.

## Fontes oficiais consultadas (01/10/2026)

- API S3 do R2 (operações/cabeçalhos suportados, incl. `If-None-Match` no PutObject): https://developers.cloudflare.com/r2/api/s3/api/
- SDK JS v3 com R2 (região `auto`, endpoint por conta): https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/
- Preços do R2: https://developers.cloudflare.com/r2/pricing/
- Limite de corpo das Functions da Vercel (4,5 MB): https://vercel.com/docs/functions/limitations
- `requestChecksumCalculation/responseChecksumValidation: WHEN_REQUIRED`: **fonte secundária** (resultado de busca citando o SDK ≥ 3.729); a página oficial do R2 consultada não menciona. Mantido por ser inofensivo; confirmar na integração real.

## Comandos reais e resultados

Execução após a última mudança de código (Windows, emuladores `demo-cantina`; sem Storage Emulator):

| Comando | Resultado |
| --- | --- |
| `npx tsc --noEmit` (`npm run typecheck`) | 0 |
| `npx eslint .` (`npm run lint`) | 0 problemas |
| `npm test` | 86/86 (inclui `tests/unit/storage.test.ts`: 22) |
| `npm run test:rules` | 24/24 |
| `npm run test:integration` | 101/101 (inclui `tests/integration/photo-route.test.ts`: 24) |
| `npm run test:e2e` | 17/17 |
| `npm run build:webpack` | 0 |
| `npm run audit:prod` | 0 vulnerabilidades |
| `npm run test:r2` (sem credenciais, execução inicial) | 1 passou, 3 puladas |
| `npm run test:r2` (bucket de homologação) | 3 passaram, 1 "pulado" é só o aviso de ausência de credenciais — ver abaixo |

Antes da migração: unit 64, rules 31, integration 83, e2e 17. A diferença em rules/integration vem dos testes de Storage Rules (removidos) e dos testes do novo fluxo.

## O que cada teste prova (e o que não prova)

- **Double local (`STORAGE_LOCAL_DIR`)** em `tests/integration/photo-route.test.ts`, com Auth e Firestore em emulador real: autorização e papéis (401/403, conta desativada, sem perfil), validação de conteúdo/tamanho, chave gerada no servidor, ausência de sobrescrita, leitura indevida, ordem das operações e falhas R2 × Firestore (PUT falha; objeto não confirmado; permissão revogada, conta desativada ou produto removido durante o envio; commit com resultado incerto; falha ao apagar a anterior; envio interrompido; sweep). **Não prova o comportamento do R2.**
- **Servidor S3 duplo** em `tests/unit/storage.test.ts`: o SDK S3 real fala com um servidor HTTP em loopback que registra cabeçalhos — prova que o cliente envia `If-None-Match: *`, assina com região `auto`, não envia checksum CRC32 e que 412 vira `ObjectExistsError`. **Não prova o R2.**
- **R2 real** (`tests/r2/r2-integration.test.ts`): executado, ver "Integração R2 real".

## Integração R2 real (01/10/2026)

- Destino: único autorizado, bucket `cantina-fotos-staging` na conta Cloudflare informada pelo dono (o teste falha, não pula, para qualquer outra conta/bucket; a conta é conferida por SHA-256 e o ID não é versionado). Nenhuma aplicação foi iniciada e o Firebase real não foi acessado.
- Configuração: o teste recebe `R2_TEST_*` (única cópia, no `.env` local, ignorado pelo Git — confirmado com `git check-ignore`; o `vitest.r2.config.ts` carrega do `.env` só as chaves `R2_TEST_*`). As `R2_*` da aplicação ficam vazias porque o `.env` tem `APP_ENV=emulator`, que recusa R2; nada foi duplicado em outro arquivo, e nenhum valor foi impresso ou registrado.
- Resultado final: 3 passaram, 1 "pulado" (o bloco que só avisa quando não há credenciais).
  1. Gravação condicional real: a segunda gravação na mesma chave é recusada (412 → `ObjectExistsError`) e os bytes originais permanecem; ETag do PUT = MD5 dos bytes; HEAD (tamanho/tipo) e GET devolvem o objeto e a imagem é reinspecionada.
  2. Objeto de 2 MB faz ida e volta; ausente → `null`; DELETE idempotente; LIST enxerga o prefixo.
  3. O endpoint S3 nega leitura anônima: responde 400 `InvalidArgument: Authorization`.
- Investigação da única falha: na primeira execução o teste 3 falhou porque eu esperava 401/403/404 e o R2 devolveu 400. Consultei o endpoint anonimamente (o corpo é só o XML de erro acima), concluí que a negação estava correta e a expectativa errada, e a troquei por "4xx, sem devolver a imagem". Os testes 1 e 2 já tinham passado. Reexecução só depois desse ajuste (e outra depois de trocar a constante de conta por hash).
- Limpeza: o teste apaga somente as chaves que criou (`_it/<runId>/`) e confirma que o prefixo ficou vazio; uma listagem de leitura do bucket ao final mostrou 0 objetos.
- NÃO comprovado: (a) se o SDK com checksum padrão realmente falha no R2 — o `WHEN_REQUIRED` funciona, mas não testei o padrão; (b) ausência de acesso público por `r2.dev` ou domínio customizado (configuração do painel que o token não lê; o teste 3 cobre só o endpoint S3); (c) o fluxo completo da aplicação (rotas + Firestore real) contra o R2 — as rotas continuam provadas só com o double local.

## Pendências (bloqueios agrupados)

O token usado é restrito a objetos (não lista nem cria buckets); o bucket foi criado pelo dono. As credenciais passaram pelo chat: rotacioná-las após a homologação.

Outras pendências:

- Homologação do app com `APP_ENV=staging` e `R2_*` (Vercel): F24. O `.env` local real não foi lido nem alterado; ele não define `R2_*` — a rota de fotos continua indisponível em produção (catálogo de demonstração) até F06.
- Se o ambiente de homologação ficar em jurisdição UE, definir `R2_ENDPOINT` com o domínio da jurisdição.
- Confirmar no painel que o bucket `cantina-fotos-staging` não tem `r2.dev` nem domínio customizado habilitados; testar o comportamento do SDK com checksum padrão, se quiser remover o `WHEN_REQUIRED`.
- Quando o app for implantado em homologação (F24): `APP_ENV=staging` + `R2_*` no gerenciador de segredos; nunca `R2_*` com `APP_ENV=emulator`/`production` apontando para esse bucket (a configuração já recusa).
- F06 deve acrescentar as coleções do catálogo real a `referencedPhotoKeys` (sweep) e decidir se fotos antigas ligadas a pedidos devem ser preservadas.
- Sweep é manual (rota admin). Agendamento (cron) fica para F24, com autenticação adequada.
- Gitleaks/Semgrep: não executados (mesma limitação do restante do projeto).
- Sem limitação de taxa nas rotas de foto (WAF/edge em F24).

## Reproduzir

```
npm ci
npm run typecheck && npm run lint
npm test
npm run test:rules
npm run test:integration
npm run test:e2e
npm run build:webpack
npm run audit:prod
npm run test:r2        # exige R2_TEST_* (no .env local ou no shell); pulado sem elas
```

Prova manual local: `npm run emulators` → `npm run dev:emulator` → `npm run seed` (fotos fictícias vão para `.local-storage/`, ignorado pelo Git).
