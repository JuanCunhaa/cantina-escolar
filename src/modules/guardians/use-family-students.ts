"use client";

import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, query, where } from "firebase/firestore";
import { getFirebaseClient } from "@/lib/firebase/client";
import { parsePolicy } from "@/modules/policies/model";

export type FamilyStudent = {
  id: string;
  name: string;
  enrollment: string;
  classId: string;
  shiftId: string;
  status: string;
  allowSitePurchase: boolean;
  allowCounterPurchase: boolean;
  dailyLimitCents: number | null;
  weeklyLimitCents: number | null;
  blockedProductIds: string[];
  blockedCategoryIds: string[];
  configVersion: number;
  hasLogin: boolean;
};

type Entry = { stop: () => void; student?: Partial<FamilyStudent>; policy?: Partial<FamilyStudent> };
type Result = { status: "loading" | "ready" | "error"; students: FamilyStudent[] };

const EMPTY: FamilyStudent = { id: "", name: "", enrollment: "", classId: "", shiftId: "", status: "active", allowSitePurchase: false, allowCounterPurchase: false, dailyLimitCents: null, weeklyLimitCents: null, blockedProductIds: [], blockedCategoryIds: [], configVersion: 0, hasLogin: false };

/**
 * Alunos vinculados ao responsável, ao vivo: vínculos ativos próprios (Rules exigem guardianUid == uid e status active)
 * e cadastro/política de cada aluno. Vínculo revogado some da lista e seus listeners são encerrados.
 */
export function useFamilyStudents(uid: string): Result {
  const [result, setResult] = useState<Result>({ status: "loading", students: [] });

  useEffect(() => {
    const { db } = getFirebaseClient();
    const perStudent = new Map<string, Entry>();
    const publish = () =>
      setResult({
        status: "ready",
        students: [...perStudent.entries()]
          .filter(([, v]) => v.student)
          .map(([id, v]) => ({ ...EMPTY, id, ...v.student, ...v.policy }))
          .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
      });
    const fail = () => setResult((r) => ({ ...r, status: "error" }));

    const stopLinks = onSnapshot(
      query(collection(db, "guardianStudentLinks"), where("guardianUid", "==", uid), where("status", "==", "active")),
      (snap) => {
        const wanted = new Set(snap.docs.map((d) => String(d.data().studentId)));
        for (const [id, entry] of perStudent) {
          if (!wanted.has(id)) {
            entry.stop();
            perStudent.delete(id);
          }
        }
        for (const id of wanted) {
          if (perStudent.has(id)) continue;
          const entry: Entry = { stop: () => undefined };
          perStudent.set(id, entry);
          const stopStudent = onSnapshot(
            doc(db, "students", id),
            (s) => {
              const d = s.data();
              if (d) {
                entry.student = {
                  name: String(d.name),
                  enrollment: String(d.enrollment),
                  classId: String(d.classId),
                  shiftId: String(d.shiftId),
                  status: String(d.status),
                  hasLogin: Boolean(d.userUid),
                };
              }
              publish();
            },
            fail,
          );
          const stopPolicy = onSnapshot(
            doc(db, "studentPolicies", id),
            (s) => {
              entry.policy = parsePolicy(s.data());
              publish();
            },
            fail,
          );
          entry.stop = () => {
            stopStudent();
            stopPolicy();
          };
        }
        publish();
      },
      fail,
    );
    return () => {
      stopLinks();
      for (const entry of perStudent.values()) entry.stop();
    };
  }, [uid]);

  return result;
}
