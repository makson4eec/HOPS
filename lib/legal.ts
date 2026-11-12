import "server-only";
import { db, type LocalDb } from "./db";
import type { Rows } from "./models";
import { UserFacingError } from "./security";
import { digest } from "./storage";

const flowDocuments = {
  account: ["privacy", "account-consent"],
  checkout: ["privacy", "offer", "returns"],
  review: ["privacy", "review-consent"],
  newsletter: ["privacy", "newsletter-consent", "advertising-consent"],
} as const;

export type LegalFlow = keyof typeof flowDocuments;
export type LegalVersions = Record<string, string>;

export function documentVersion(doc: Pick<Rows["document"], "slug" | "title" | "content">) {
  return digest(JSON.stringify([doc.slug, doc.title, doc.content]));
}

export async function legalFormState(flow: LegalFlow) {
  const slugs = flowDocuments[flow];
  const docs = await db.document.findMany({ where: { published: true, slug: { in: slugs } } });
  const origin = new URL(process.env.APP_URL || "http://localhost:3000");
  const localPreview = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  const versions = Object.fromEntries(docs.sort((a, b) => a.slug.localeCompare(b.slug)).map(doc => [doc.slug, documentVersion(doc)]));
  return {
    ready: localPreview || docs.length === slugs.length,
    versions,
    revision: digest(JSON.stringify(versions)),
  };
}

export async function acceptLegalForm(flow: LegalFlow, form: FormData) {
  const { ready, revision, versions } = await legalFormState(flow);
  if (!ready) throw new UserFacingError("Форма станет доступна после публикации документов магазина.");
  if (form.get("legalRevision") !== revision) throw new UserFacingError("Документы обновились. Обновите страницу и проверьте условия.");
  if (form.get("consent") !== "on") {
    throw new UserFacingError(flow === "checkout" ? "Примите условия самовывоза." : "Подтвердите согласие на обработку персональных данных.");
  }
  if (flow === "newsletter" && form.get("advertisingConsent") !== "on") throw new UserFacingError("Отдельно подтвердите согласие на получение рассылки.");
  return versions;
}

export async function recordLegalAcceptance(tx: LocalDb, flow: LegalFlow, actorId: string, targetId: string, versions: LegalVersions) {
  if (Object.keys(versions).length) {
    await tx.auditLog.create({ data: { actorId, targetId, action: `LEGAL_ACCEPT_${flow.toUpperCase()}`, legalVersions: versions } });
  }
}
