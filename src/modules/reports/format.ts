/** Formatação pura (sem Firebase) compartilhada por servidor, tela e exportações dos relatórios. */

/** Moeda pt-BR a partir de centavos INTEIROS (12345 → "123,45"); texto gerado aqui, nunca vindo de usuário. */
export function brl(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

/** Pontos-base → percentual com 2 casas, sem ponto flutuante (4750 → "47,50"; -125 → "-1,25"). */
export function bpDecimal(bp: number): string {
  const abs = Math.abs(bp);
  return `${bp < 0 ? "-" : ""}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}
