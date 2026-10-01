import type { Firestore } from "firebase-admin/firestore";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { notFound } from "@/lib/domain-error";

/** Leituras administrativas (servidor): diretório de responsáveis e ficha de acesso de um aluno. */
export type GuardianRow = {
  uid: string;
  name: string;
  email: string;
  status: string;
  contact: string | null;
  studentIds: string[];
};

const DIRECTORY_LIMIT = 1000;

export async function listGuardians(db: Firestore, actor: Actor): Promise<{ guardians: GuardianRow[] }> {
  authorize(actor, "students.manage");
  const [users, links] = await Promise.all([
    db.collection("users").where("role", "==", "guardian").limit(DIRECTORY_LIMIT).get(),
    db.collection("guardianStudentLinks").where("status", "==", "active").limit(DIRECTORY_LIMIT * 4).get(),
  ]);
  const byGuardian = new Map<string, string[]>();
  for (const doc of links.docs) {
    const { guardianUid, studentId } = doc.data() as { guardianUid: string; studentId: string };
    byGuardian.set(guardianUid, [...(byGuardian.get(guardianUid) ?? []), studentId]);
  }
  const guardians = users.docs
    .map<GuardianRow>((doc) => {
      const d = doc.data() as { displayName: string; email: string; status: string; contact?: string };
      return { uid: doc.id, name: d.displayName, email: d.email, status: d.status, contact: d.contact ?? null, studentIds: byGuardian.get(doc.id) ?? [] };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return { guardians };
}

export type StudentAccess = {
  student: { id: string; enrollment: string; name: string; classId: string; shiftId: string; status: string; hasLogin: boolean; loginEmail: string | null };
  policy: { allowSitePurchase: boolean; allowCounterPurchase: boolean; configVersion: number };
  links: { guardianUid: string; name: string; email: string; status: string }[];
};

export async function getStudentAccess(db: Firestore, actor: Actor, studentId: string): Promise<StudentAccess> {
  authorize(actor, "students.manage");
  const [student, policy, links] = await Promise.all([
    db.doc(`students/${studentId}`).get(),
    db.doc(`studentPolicies/${studentId}`).get(),
    db.collection("guardianStudentLinks").where("studentId", "==", studentId).limit(50).get(),
  ]);
  if (!student.exists) throw notFound("student_not_found");
  const s = student.data() as { enrollment: string; name: string; classId: string; shiftId: string; status: string; userUid: string | null };
  const guardianUids = links.docs.map((d) => (d.data() as { guardianUid: string }).guardianUid);
  const refs = [...guardianUids, ...(s.userUid ? [s.userUid] : [])].map((uid) => db.doc(`users/${uid}`));
  const profiles = refs.length > 0 ? await db.getAll(...refs) : [];
  const profileOf = new Map(profiles.map((p) => [p.id, p.data() as { displayName?: string; email?: string } | undefined] as const));
  const p = (policy.data() ?? {}) as { allowSitePurchase?: boolean; allowCounterPurchase?: boolean; configVersion?: number };
  return {
    student: {
      id: studentId,
      enrollment: s.enrollment,
      name: s.name,
      classId: s.classId,
      shiftId: s.shiftId,
      status: s.status,
      hasLogin: Boolean(s.userUid),
      loginEmail: s.userUid ? (profileOf.get(s.userUid)?.email ?? null) : null,
    },
    policy: { allowSitePurchase: p.allowSitePurchase === true, allowCounterPurchase: p.allowCounterPurchase === true, configVersion: p.configVersion ?? 0 },
    links: links.docs
      .map((d) => d.data() as { guardianUid: string; status: string })
      .map((l) => ({ guardianUid: l.guardianUid, status: l.status, name: profileOf.get(l.guardianUid)?.displayName ?? "—", email: profileOf.get(l.guardianUid)?.email ?? "" })),
  };
}
