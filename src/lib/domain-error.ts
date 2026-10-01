/** Erro de regra de negócio com código estável e status HTTP; `accessErrorResponse`-like mapeamento em command-route. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409 | 422,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const notFound = (code: string, message?: string) => new DomainError(code, 404, message);
export const conflict = (code: string, message?: string) => new DomainError(code, 409, message);
export const invalid = (code: string, message?: string) => new DomainError(code, 422, message);
