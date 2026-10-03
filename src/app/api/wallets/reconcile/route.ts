import { z } from "zod";
import { authorize } from "@/modules/access/authorize";
import { authenticatedRoute } from "@/modules/access/command-route";
import { reconcileWallet } from "@/modules/wallet/queries";

export const dynamic = "force-dynamic";

const querySchema = z.object({ studentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });

/** Reconciliação saldo × livro de uma carteira: somente administração (capacidade audit.read). */
export const GET = (request: Request) =>
  authenticatedRoute(request, "wallet reconcile", ({ actor, deps, url }) => {
    authorize(actor, "audit.read");
    const { studentId } = querySchema.parse({ studentId: url.searchParams.get("studentId") });
    return reconcileWallet(deps.db, studentId);
  });
