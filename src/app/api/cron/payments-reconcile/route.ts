import { timingSafeEqual } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { sweepIntents } from "@/modules/payments/online/confirmation";
import { onlineProviders } from "@/modules/payments/online/config";

export const dynamic = "force-dynamic";
/** A varredura tem prazo próprio (45 s); a função serverless precisa de folga para terminar e responder. */
export const maxDuration = 60;

function authorized(request: Request): boolean | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Conciliação agendada (Vercel Cron, 1×/dia no plano Hobby; ver vercel.json): recupera notificações perdidas e pagamentos
 * tardios, e detecta reembolso/chargeback. Vercel envia `Authorization: Bearer $CRON_SECRET`. Sem `CRON_SECRET` = 503
 * (falha fechada). A regra de negócio é a mesma do webhook (src/modules/payments/online/confirmation.ts).
 */
export async function GET(request: Request): Promise<Response> {
  const ok = authorized(request);
  if (ok === null) return Response.json({ error: "cron_unavailable" }, { status: 503 });
  if (!ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    return Response.json({ sweep: await sweepIntents(adminDb(), { providers: onlineProviders() }) });
  } catch (error) {
    console.error("payments cron failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
