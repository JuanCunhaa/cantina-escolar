import { authenticatedRoute } from "@/modules/access/command-route";
import { listPaymentReview } from "@/modules/payments/online/pendencies";

export const dynamic = "force-dynamic";

/** Pendências de reembolso/chargeback e pagamentos em divergência. Somente administração (`payments.review`). */
export const GET = (request: Request) => authenticatedRoute(request, "payments review list", ({ actor, deps }) => listPaymentReview(deps.db, actor));
