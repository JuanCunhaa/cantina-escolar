# Migração do armazenamento de arquivos: Firebase Storage → Cloudflare R2

Data: 01/10/2026. Autorizada pelo dono do projeto (mudança de arquitetura). Escopo: **somente arquivos**. Firebase Auth e Firestore permanecem. F06 e a homologação completa não foram iniciadas.

## Estado

| Item | Estado |
| --- | --- |
| Código, testes locais, CI, documentação | Migrado e verde (abaixo) |
| Nenhum caminho depende do Firebase Storage | Sim: removidos Storage Rules, Storage Emulator, `firebase/storage` (cliente) e `firebase-admin/storage` (servidor) |
| Integração real com um bucket R2 | **NÃO executada** — ver "Pendências" |
| Migração "completa"? | **Código completo; comprovação em R2 real pendente.** Não declarar homologada. |

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
| `npm run test:r2` | 1 passou, 3 **puladas** (sem `R2_TEST_*`) |

Antes da migração: unit 64, rules 31, integration 83, e2e 17. A diferença em rules/integration vem dos testes de Storage Rules (removidos) e dos testes do novo fluxo.

## O que cada teste prova (e o que não prova)

- **Double local (`STORAGE_LOCAL_DIR`)** em `tests/integration/photo-route.test.ts`, com Auth e Firestore em emulador real: autorização e papéis (401/403, conta desativada, sem perfil), validação de conteúdo/tamanho, chave gerada no servidor, ausência de sobrescrita, leitura indevida, ordem das operações e falhas R2 × Firestore (PUT falha; objeto não confirmado; permissão revogada, conta desativada ou produto removido durante o envio; commit com resultado incerto; falha ao apagar a anterior; envio interrompido; sweep). **Não prova o comportamento do R2.**
- **Servidor S3 duplo** em `tests/unit/storage.test.ts`: o SDK S3 real fala com um servidor HTTP em loopback que registra cabeçalhos — prova que o cliente envia `If-None-Match: *`, assina com região `auto`, não envia checksum CRC32 e que 412 vira `ObjectExistsError`. **Não prova o R2.**
- **R2 real** (`tests/r2/r2-integration.test.ts`): escrito, **não executado**. Cobre: PUT condicional real (segunda gravação recusada, bytes intactos), ETag = MD5, HEAD/GET/DELETE/LIST, objeto de 2 MB, ausente = null, bucket sem leitura anônima. Limpa apenas as chaves criadas pela própria execução (`_it/<runId>/`).

## Pendências (bloqueios agrupados)

Nesta máquina não há `wrangler`, sessão Cloudflare nem variáveis `CLOUDFLARE_*`/`R2_*`; por isso nenhuma operação externa foi feita (nenhum bucket foi criado e a conta/bucket não foram confirmados). Para fechar, é preciso (ação sua, sem enviar segredos pelo chat):

1. Confirmar a conta Cloudflare e o nome do bucket de homologação (sugestão: `cantina-fotos-staging`); confirmar se o R2 já está habilitado na conta e se a ativação pede forma de pagamento (a página de preços não esclarece — não ative plano pago sem decidir).
2. Criar o bucket (privado: não habilitar domínio público nem `r2.dev`) e um token de API R2 "Object Read & Write" restrito a esse bucket (Cloudflare → R2 → Manage R2 API Tokens). Anotar Account ID, Access Key ID e Secret.
3. No shell (não em arquivo): definir `R2_TEST_ACCOUNT_ID`, `R2_TEST_ACCESS_KEY_ID`, `R2_TEST_SECRET_ACCESS_KEY`, `R2_TEST_BUCKET` e rodar `npm run test:r2`. Anexar o resultado aqui e em `docs/status/acceptance.json` (A36).

Outras pendências:

- Homologação do app com `APP_ENV=staging` e `R2_*` (Vercel): F24. O `.env` local real não foi lido nem alterado; ele não define `R2_*` — a rota de fotos continua indisponível em produção (catálogo de demonstração) até F06.
- Se o ambiente de homologação ficar em jurisdição UE, definir `R2_ENDPOINT` com o domínio da jurisdição.
- Confirmar no R2 real: `If-None-Match: *` (fonte oficial diz suportado), ETag = MD5 em PUT simples e necessidade/inocuidade do `WHEN_REQUIRED`.
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
npm run test:r2        # pulado sem R2_TEST_*; ver "Pendências" para executar de verdade
```

Prova manual local: `npm run emulators` → `npm run dev:emulator` → `npm run seed` (fotos fictícias vão para `.local-storage/`, ignorado pelo Git).
