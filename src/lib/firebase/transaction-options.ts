/**
 * Orçamento de tentativas das transações de comando (Admin SDK). O padrão do SDK (5) é insuficiente sob disputa no
 * mesmo documento: transações que leem e depois escrevem o mesmo documento (carteira, uso, idempotência) disputam a
 * promoção do lock de leitura para escrita; o Firestore Emulator resolve cada impasse só após o "lock timeout"
 * (~3,4 s medidos) e aborta a transação ao esgotar as tentativas ("10 ABORTED: Transaction lock timeout").
 * Medido no emulador (docs/status/history.md, "Transaction lock timeout"): 12 escritores concorrentes no mesmo documento
 * chegam a 5–6 tentativas; com 5 o comando falha em parte das execuções, com 10 não. Todo comando que usa este
 * orçamento é idempotente (chave + hash do payload) e mantém efeitos externos fora do callback, então reexecutar é seguro.
 */
export const COMMAND_TRANSACTION = { maxAttempts: 10 } as const;
