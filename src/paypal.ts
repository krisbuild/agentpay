// Minimal PayPal REST client for the Payouts API.
// Docs: https://developer.paypal.com/docs/api/payments.payouts-batch/v1/

const BASE_URLS = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
} as const;

export type PayPalEnv = keyof typeof BASE_URLS;

export interface PayoutRequest {
  /** Idempotency key: PayPal rejects a second batch with the same id. */
  senderBatchId: string;
  receiverEmail: string;
  amount: string; // decimal string, e.g. "25.00"
  currency: string; // ISO 4217, e.g. "USD"
  note: string;
}

export interface PayoutResult {
  payoutBatchId: string;
  batchStatus: string;
}

export class PayPalClient {
  private token?: { value: string; expiresAt: number };
  readonly env: PayPalEnv;

  constructor(
    private clientId = requireEnv("PAYPAL_CLIENT_ID"),
    private clientSecret = requireEnv("PAYPAL_CLIENT_SECRET"),
    env: PayPalEnv = (process.env.PAYPAL_ENV as PayPalEnv) ?? "sandbox",
  ) {
    if (!(env in BASE_URLS)) throw new Error(`PAYPAL_ENV must be "sandbox" or "live", got "${env}"`);
    this.env = env;
  }

  private get baseUrl() {
    return BASE_URLS[this.env];
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`PayPal ${method} ${path} failed: ${res.status} ${text}`);
    return JSON.parse(text) as T;
  }

  async createPayout(p: PayoutRequest): Promise<PayoutResult> {
    const body = await this.request<{ batch_header: { payout_batch_id: string; batch_status: string } }>(
      "POST",
      "/v1/payments/payouts",
      {
        sender_batch_header: {
          sender_batch_id: p.senderBatchId,
          email_subject: "You received a bounty payout",
          email_message: p.note,
        },
        items: [
          {
            recipient_type: "EMAIL",
            amount: { value: p.amount, currency: p.currency },
            receiver: p.receiverEmail,
            note: p.note,
            sender_item_id: p.senderBatchId,
          },
        ],
      },
    );
    return {
      payoutBatchId: body.batch_header.payout_batch_id,
      batchStatus: body.batch_header.batch_status,
    };
  }

  async getPayoutStatus(payoutBatchId: string): Promise<string> {
    const body = await this.request<{ batch_header: { batch_status: string } }>(
      "GET",
      `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`,
    );
    return body.batch_header.batch_status;
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}
