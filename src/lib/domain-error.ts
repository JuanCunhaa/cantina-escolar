/** Erro de regra de negócio com código estável e status HTTP; `accessErrorResponse`-like mapeamento em command-route. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409 | 422 | 503,
    message?: string,
    /** Dados estruturados para a tela (ex.: o que falta registrar). Sem segredo, custo ou dado de outra família. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

export const notFound = (code: string, message?: string) => new DomainError(code, 404, message);
export const conflict = (code: string, message?: string, details?: Record<string, unknown>) => new DomainError(code, 409, message, details);
export const invalid = (code: string, message?: string) => new DomainError(code, 422, message);
/** Serviço externo indisponível ou não configurado (ex.: provedor de pagamento ausente): nada foi gravado nem cobrado. */
export const unavailable = (code: string, message?: string) => new DomainError(code, 503, message);
