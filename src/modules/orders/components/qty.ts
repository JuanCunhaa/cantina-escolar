/** Quantidade digitada: só inteiros não negativos, limitada ao máximo da linha (texto vazio ou inválido = 0). */
export const toQty = (text: string, max: number): number => {
  const n = /^\d+$/.test(text.trim()) ? Number(text.trim()) : 0;
  return Math.min(Math.max(n, 0), max);
};
