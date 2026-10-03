import { z } from "zod";
import { authenticatedRoute } from "@/modules/access/command-route";
import { readWallet } from "@/modules/wallet/queries";

export const dynamic = "force-dynamic";

const querySchema = z.object({ studentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });

/** Saldo, versão e últimos movimentos de um aluno (responsável vinculado, o próprio aluno ou administração). */
export const GET = (request: Request) =>
  authenticatedRoute(request, "wallet read", ({ actor, deps, url }) => {
    const { studentId } = querySchema.parse({ studentId: url.searchParams.get("studentId") });
    return readWallet(deps.db, actor, studentId);
  });
