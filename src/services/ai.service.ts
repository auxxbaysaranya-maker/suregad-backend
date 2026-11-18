import { env } from "../config/env";
import { AIJob, AIRiskEvent } from "../models/engagement.model";
import { AppError } from "../common/errors";
import { kolkataMonthRange } from "../common/time";

interface CompletionResult {
  text: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

async function assertBudget(): Promise<void> {
  const { start, end } = kolkataMonthRange();
  const rows = await AIJob.aggregate([
    { $match: { createdAt: { $gte: start, $lt: end }, status: "completed" } },
    { $group: { _id: null, tokens: { $sum: { $add: ["$promptTokens", "$completionTokens"] } } } },
  ]);
  const used = rows[0]?.tokens || 0;
  if (used >= env.ai.monthlyTokenBudget) {
    throw new AppError(429, "AI_BUDGET_EXCEEDED", "The monthly AI usage budget has been reached.");
  }
}

export async function completeAi(input: {
  userId?: string;
  task: string;
  system: string;
  user: string;
}): Promise<CompletionResult> {
  if (!env.ai.apiKey) {
    await AIJob.create({ userId: input.userId, task: input.task, status: "refused", error: "AI_NOT_CONFIGURED" });
    throw new AppError(
      503,
      "AI_NOT_CONFIGURED",
      "Set AI_API_KEY on the server before using AI features. No request was sent.",
    );
  }
  await assertBudget();
  try {
    const response = await fetch(`${env.ai.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.ai.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.ai.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      }),
    });
    if (!response.ok) {
      await AIJob.create({
        userId: input.userId,
        task: input.task,
        status: "failed",
        provider: env.ai.provider,
        model: env.ai.model,
        error: `HTTP_${response.status}`,
      });
      throw new AppError(502, "AI_PROVIDER_ERROR", "The AI provider rejected the request.");
    }
    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = payload.choices?.[0]?.message?.content || "";
    const result = {
      text,
      provider: env.ai.provider,
      model: env.ai.model,
      promptTokens: payload.usage?.prompt_tokens || 0,
      completionTokens: payload.usage?.completion_tokens || 0,
    };
    await AIJob.create({ userId: input.userId, task: input.task, status: "completed", ...result });
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    await AIJob.create({ userId: input.userId, task: input.task, status: "failed", error: "NETWORK" });
    throw new AppError(502, "AI_PROVIDER_ERROR", "The AI provider could not be reached.");
  }
}

export async function listingAssistant(userId: string, specs: Record<string, unknown>, notes?: string) {
  const result = await completeAi({
    userId,
    task: "listing_assistant",
    system:
      "You help write marketplace listings for used electronics in India. Reply with JSON only: {title, description, missingFields}. Do not invent IMEI, serial numbers, or verification status. Mention condition only if provided. Never claim the device was inspected.",
    user: JSON.stringify({ specs, notes: notes || "" }),
  });
  return parseJson(result.text);
}

export async function pricingAssistant(userId: string, context: Record<string, unknown>) {
  const result = await completeAi({
    userId,
    task: "pricing_assistant",
    system:
      "Suggest a used-device asking price in INR from comparable listing summaries. Reply with JSON only: {suggestedPriceInr, lowInr, highInr, positioning}. Do not claim a guaranteed sale price.",
    user: JSON.stringify(context),
  });
  return parseJson(result.text);
}

export async function buyerAssistant(userId: string, question: string, listings: unknown[]) {
  const result = await completeAi({
    userId,
    task: "buyer_assistant",
    system:
      "Answer as SureGad's buyer assistant using only the supplied public listings. Do not invent inspection results. If a listing is not inspected, say so. Reply in plain text under 180 words.",
    user: JSON.stringify({ question, listings }),
  });
  return { answer: result.text };
}

export async function reportSummary(userId: string, report: unknown) {
  const result = await completeAi({
    userId,
    task: "report_summary",
    system:
      "Summarise a physical inspection report for a buyer in India. Lead with critical failures if any. State clearly that the inspection does not guarantee future reliability. Do not upgrade a failed critical check into a pass. Plain text under 160 words.",
    user: JSON.stringify(report),
  });
  return { summary: result.text };
}

export async function recordRiskSignal(input: { subjectType: string; subjectId: string; signals: string[]; summary: string }) {
  return AIRiskEvent.create({ ...input, requiresHumanReview: true });
}

function parseJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return { text };
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return { text };
  }
}
