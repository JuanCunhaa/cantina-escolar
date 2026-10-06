import { sha256Hex } from "@/lib/firebase/command";
import type { ReferenceFamily } from "./topup-model";

/** Documento de unicidade da referência (`uniquenessKeys/{id}`, só servidor): hash da família + referência normalizada. */
export const referenceKeyId = (family: ReferenceFamily, normalized: string): string => `topupRef_${sha256Hex(`${family}\u0000${normalized}`).slice(0, 40)}`;
