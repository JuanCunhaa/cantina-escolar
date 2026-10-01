import { ForbiddenError } from "@/modules/access/errors";
import { authenticatedRoute } from "@/modules/access/command-route";
import { changeCalendarDay, purchaseWindow } from "@/modules/school/settings";
import { invalid } from "@/lib/domain-error";

export const dynamic = "force-dynamic";

/** Janela de compra hoje…hoje+7 de um turno (qualquer conta com perfil ativo); a decisão final é do checkout. */
export const GET = (request: Request) =>
  authenticatedRoute(request, "school calendar window", async ({ actor, deps, url }) => {
    if (!actor.role) throw new ForbiddenError("Sem perfil ativo.");
    const shiftId = url.searchParams.get("shiftId") ?? "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(shiftId)) throw invalid("invalid_shift", "Turno inválido.");
    return purchaseWindow(deps.db, shiftId);
  });

/** Dias extras/fechados (administração). */
export const POST = (request: Request) =>
  authenticatedRoute(request, "school calendar day", ({ actor, deps, body }) => changeCalendarDay(deps.db, actor, body));
