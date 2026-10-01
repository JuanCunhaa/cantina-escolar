/** Sem identidade válida (token ausente, inválido, expirado ou revogado). */
export class UnauthenticatedError extends Error {}
/** Identidade válida, porém sem papel, vínculo ou permissão para a ação. */
export class ForbiddenError extends Error {}
/** Conta desativada/revogada pela administração. */
export class AccountInactiveError extends Error {}
