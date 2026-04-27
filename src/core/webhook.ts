import { createHmac } from "crypto";

export interface WebhookOptions {
  url: string;
  payload: unknown;
  secret?: string;
  maxRetries?: number;
  userAgent?: string;
  timeoutMs?: number;
}

/**
 * POST a JSON payload to a webhook with exponential backoff and optional HMAC.
 * Retries on network failure or 5xx, gives up immediately on 4xx.
 */
export async function sendWebhookWithRetries(opts: WebhookOptions): Promise<void> {
  const { url, payload, secret } = opts;
  const maxRetries = opts.maxRetries ?? 3;
  const userAgent = opts.userAgent ?? "Transflow/1.0";
  const timeoutMs = opts.timeoutMs ?? 30000;

  const body = JSON.stringify(payload ?? {});
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": userAgent,
  };

  if (secret) {
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    headers["X-Transflow-Signature"] = `sha256=${signature}`;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        console.log(`Webhook sent successfully to ${url}`);
        return;
      }

      if (response.status >= 400 && response.status < 500) {
        throw new Error(
          `Webhook failed with client error: ${response.status} ${response.statusText}`
        );
      }

      throw new Error(
        `Webhook failed with server error: ${response.status} ${response.statusText}`
      );
    } catch (error) {
      console.error(`Webhook attempt ${attempt + 1} failed:`, error);
      if (attempt === maxRetries) throw error;
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
