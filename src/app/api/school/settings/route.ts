import { authenticatedRoute } from "@/modules/access/command-route";
import { authorize } from "@/modules/access/authorize";
import { loadSettings, updateSchoolSettings } from "@/modules/school/settings";

export const dynamic = "force-dynamic";

/** Identidade, dias de funcionamento e horários por turno (administração). */
export const GET = (request: Request) =>
  authenticatedRoute(request, "school settings read", async ({ actor, deps }) => {
    authorize(actor, "students.manage");
    return loadSettings(deps.db);
  });

export const POST = (request: Request) =>
  authenticatedRoute(request, "school settings", ({ actor, deps, body }) => updateSchoolSettings(deps.db, actor, body));
