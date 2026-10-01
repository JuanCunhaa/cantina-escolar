import { invalid } from "@/lib/domain-error";
import { authenticatedRoute } from "@/modules/access/command-route";
import { commitStudentImport, importSchema, previewStudentImport } from "@/modules/students/import";

export const dynamic = "force-dynamic";

/** Importação CSV: `mode: "preview"` valida sem gravar; `mode: "commit"` exige o resumo da prévia aprovada. */
export const POST = (request: Request) =>
  authenticatedRoute(request, "student import", async ({ actor, deps, body }) => {
    const mode = importSchema.parse(body).mode;
    if (mode === "preview") return previewStudentImport(deps.db, actor, body);
    if (mode === "commit") return commitStudentImport(deps.db, actor, body);
    throw invalid("invalid_mode");
  });
