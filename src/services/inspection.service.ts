import mongoose, { Types } from "mongoose";
import { inspectionResultSchema } from "../shared/validation";
import { z } from "zod";
import { Product } from "../models/catalog.model";
import {
  InspectionAssignment,
  InspectionEvidence,
  InspectionPlan,
  InspectionReport,
  InspectionRequest,
} from "../models/inspection.model";
import { PartnerProfile } from "../models/profiles.model";
import { PlatformSetting } from "../models/engagement.model";
import { PartnerPayout } from "../models/engagement.model";
import { AppError, forbidden, notFound } from "../common/errors";
import { randomId } from "../common/crypto";
import { scoreInspection } from "./scoring.service";
import { notify } from "./notification.service";
import { audit } from "./audit.service";
import type { Request } from "express";

async function settings() {
  const doc = await PlatformSetting.findOne({ key: "platform" });
  return (doc?.value || {}) as {
    assignmentTimeoutMinutes?: number;
    maxPartnerDistanceKm?: number;
  };
}

function distanceKm(a: [number, number], b: [number, number]): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earth = 6371;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

export async function allocatePartner(requestId: string): Promise<void> {
  const request = await InspectionRequest.findById(requestId);
  if (!request) return;
  if (!["paid", "matching", "offered", "expired"].includes(request.status)) return;
  const product = await Product.findById(request.productId);
  const plan = await InspectionPlan.findById(request.planId);
  if (!product || !plan) return;
  const coords = product.location?.coordinates;
  if (!coords || coords.length !== 2) {
    request.status = "matching";
    await request.save();
    return;
  }
  const config = await settings();
  const partners = await PartnerProfile.find({
    verificationStatus: "approved",
    "availability.paused": false,
    categories: product.categorySlug,
    deletedAt: null,
    _id: { $nin: request.excludedPartnerIds },
    // Nobody inspects a device they are buying or selling.
    userId: { $nin: [request.buyerId, request.sellerUserId] },
    location: {
      $near: {
        $geometry: { type: "Point", coordinates: coords },
        $maxDistance: (config.maxPartnerDistanceKm || 150) * 1000,
      },
    },
  }).limit(25);
  const ranked = partners
    .map((partner) => {
      const partnerCoords = partner.location?.coordinates;
      if (!partnerCoords || partnerCoords.length !== 2) return null;
      const km = distanceKm(coords as [number, number], partnerCoords as [number, number]);
      if (km > partner.serviceRadiusKm) return null;
      const stats = partner.stats || { ratingCount: 0, ratingSum: 0, accepted: 0, rejected: 0, openJobs: 0, completed: 0 };
      const rating = stats.ratingCount > 0 ? stats.ratingSum / stats.ratingCount : 4;
      const acceptanceBase = stats.accepted + stats.rejected;
      const acceptance = acceptanceBase === 0 ? 0.7 : stats.accepted / acceptanceBase;
      const score = rating * 20 + acceptance * 30 - km - stats.openJobs * 4;
      return { partner, km, score };
    })
    .filter((item): item is { partner: (typeof partners)[number]; km: number; score: number } => Boolean(item))
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) {
    request.status = "matching";
    request.assignedPartnerId = undefined;
    await request.save();
    return;
  }
  const chosen = ranked[0];
  const timeout = config.assignmentTimeoutMinutes || 60;
  const expiresAt = new Date(Date.now() + timeout * 60 * 1000);
  await InspectionAssignment.create({
    requestId: request._id,
    partnerId: chosen.partner._id,
    status: "offered",
    score: chosen.score,
    distanceKm: chosen.km,
    expiresAt,
  });
  request.status = "offered";
  request.assignedPartnerId = chosen.partner._id;
  request.offerExpiresAt = expiresAt;
  await request.save();
  await notify({
    userId: String(chosen.partner.userId),
    event: "inspection.requested",
    title: "New inspection request",
    body: `${plan.name} is available ${chosen.km.toFixed(1)} km from you.`,
    data: { requestId: String(request._id) },
  });
}

export async function expireOffers(): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;
  const now = new Date();
  const stale = await InspectionRequest.find({ status: "offered", offerExpiresAt: { $lt: now } });
  for (const request of stale) {
    await InspectionAssignment.updateMany(
      { requestId: request._id, status: "offered" },
      { status: "expired" },
    );
    if (request.assignedPartnerId) request.excludedPartnerIds.push(request.assignedPartnerId);
    request.assignedPartnerId = undefined;
    request.status = "matching";
    await request.save();
    await allocatePartner(String(request._id));
  }
}

const reportSchema = z.object({
  results: z.array(inspectionResultSchema).min(1),
  summary: z.string().max(4000).optional(),
});

export async function submitReport(req: Request, requestId: string, body: unknown) {
  const input = reportSchema.parse(body);
  const partner = await PartnerProfile.findOne({ userId: req.user?._id, deletedAt: null });
  if (!partner) throw forbidden("Partner profile required.");
  const request = await InspectionRequest.findById(requestId);
  if (!request) throw notFound("Inspection request not found.");
  if (String(request.assignedPartnerId) !== String(partner._id)) throw forbidden();
  if (!["accepted", "scheduled", "in_progress", "report_submitted"].includes(request.status)) {
    throw new AppError(409, "INVALID_STATE", "This inspection is not ready for a report.");
  }
  const plan = await InspectionPlan.findById(request.planId);
  if (!plan) throw notFound("Inspection plan not found.");
  const scored = scoreInspection(
    plan.checklist.map((item) => ({
      key: item.key,
      label: item.label,
      group: item.group || undefined,
      critical: Boolean(item.critical),
      weight: item.weight,
    })),
    input.results,
  );
  if (scored.verdict === "incomplete") {
    throw new AppError(400, "REPORT_INCOMPLETE", "Every checklist item needs a result before submission.", {
      missing: scored.results.filter((item) => item.result === "not_tested").map((item) => item.key),
    });
  }
  const previous = await InspectionReport.findOne({ requestId: request._id }).sort({ version: -1 });
  const report = await InspectionReport.create({
    requestId: request._id,
    productId: request.productId,
    partnerId: partner._id,
    version: (previous?.version || 0) + 1,
    supersedes: previous?._id,
    results: scored.results,
    score: scored.score,
    componentScores: scored.componentScores,
    criticalFailures: scored.criticalFailures,
    verdict: scored.verdict,
    disclaimer: plan.disclaimer,
    summary: input.summary || "",
    published: Boolean(request.publishOnListing),
  });
  request.status = "completed";
  await request.save();
  partner.stats!.completed += 1;
  partner.stats!.openJobs = Math.max(0, partner.stats!.openJobs - 1);
  await partner.save();
  const product = await Product.findById(request.productId);
  if (product && request.publishOnListing) {
    product.inspection = {
      inspected: true,
      reportId: report._id,
      score: scored.score ?? undefined,
      critical: scored.verdict === "critical_failure",
      published: true,
    };
    await product.save();
  }
  await PartnerPayout.create({
    partnerId: partner._id,
    requestId: request._id,
    amountPaise: plan.partnerPayoutPaise,
    status: "pending",
    note: "Awaiting admin payout. SureGad does not operate an unofficial escrow balance.",
  });
  await notify({
    userId: String(request.buyerId),
    event: "inspection.completed",
    title: "Inspection report is ready",
    body: "Your device inspection report is available. A high score does not hide critical failures.",
    data: { requestId: String(request._id), reportId: String(report._id) },
  });
  await notify({
    userId: String(request.sellerUserId),
    event: "inspection.completed",
    title: "Inspection completed",
    body: "An inspection report was submitted for your listing.",
    data: { requestId: String(request._id) },
  });
  await audit(req, "inspection.report_submitted", "InspectionReport", String(report._id), {
    version: report.version,
    verdict: report.verdict,
  });
  return report.toObject();
}

export async function publicReport(reportId: string) {
  const report = await InspectionReport.findById(reportId).lean();
  if (!report || !report.published) throw notFound("Report is not published.");
  return sanitizeReport(report);
}

export function sanitizeReport(report: {
  _id: unknown;
  version: number;
  score?: number | null;
  componentScores?: unknown;
  criticalFailures?: string[] | null;
  verdict?: string | null;
  disclaimer?: string | null;
  summary?: string | null;
  results?: unknown;
  createdAt?: Date;
  published?: boolean;
}) {
  return {
    id: String(report._id),
    version: report.version,
    score: report.score,
    componentScores: report.componentScores,
    criticalFailures: report.criticalFailures,
    verdict: report.verdict,
    disclaimer: report.disclaimer,
    summary: report.summary,
    results: report.results,
    createdAt: report.createdAt,
    published: report.published,
    guarantee: false,
  };
}

export function newInspectionNumber(): string {
  return `INS-${randomId(4).toUpperCase()}`;
}

export function asObjectId(id: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) throw new AppError(400, "INVALID_ID", "Invalid id.");
  return new Types.ObjectId(id);
}

export async function addEvidence(req: Request, requestId: string, body: { key: string; caption?: string; checklistKey?: string }) {
  const partner = await PartnerProfile.findOne({ userId: req.user?._id });
  if (!partner) throw forbidden();
  const request = await InspectionRequest.findById(requestId);
  if (!request || String(request.assignedPartnerId) !== String(partner._id)) throw forbidden();
  return InspectionEvidence.create({
    requestId,
    partnerId: partner._id,
    key: body.key,
    caption: body.caption,
    checklistKey: body.checklistKey,
  });
}
