/**
 * Paid plans for the hosted service. Self-hosted servers run without billing and without
 * limits; billing is on only when the Stripe settings are present.
 */
import Stripe from "stripe";

export type Limits = { devices: number; collections: number; storageBytes: number };
export type Plan = "free" | "plus";
export type Plans = Record<Plan, Limits>;

/** What the server needs from a payment provider. Stripe in production, a fake in tests. */
export interface Billing {
  /** A hosted checkout page for upgrading the account. */
  checkoutUrl(input: { accountId: string; customerId: string | null }): Promise<string>;
  /** The customer portal, to change payment details or cancel. */
  portalUrl(customerId: string): Promise<string>;
  cancel(subscriptionId: string): Promise<void>;
  /** Verifies a webhook and returns the subscription's current state, if the event concerns one. */
  webhook(body: string, signature: string): Promise<SubscriptionState | null>;
}

export type SubscriptionState = {
  accountId: string | undefined;
  customerId: string;
  subscriptionId: string;
  status: string;
};

/** Subscription statuses that keep the paid plan. `past_due` keeps it while Stripe retries the card. */
export const planFor = (status: string): Plan => (["active", "trialing", "past_due"].includes(status) ? "plus" : "free");

const idOf = (value: string | { id: string }) => (typeof value === "string" ? value : value.id);

export function stripeBilling(options: {
  secretKey: string;
  webhookSecret: string;
  priceId: string;
  publicUrl: string;
  /** Tests pass a fake `fetch` here instead of calling Stripe. */
  fetch?: typeof fetch;
}): Billing {
  const stripe = new Stripe(options.secretKey, options.fetch ? { httpClient: Stripe.createFetchHttpClient(options.fetch) } : {});
  const returnUrl = `${options.publicUrl}/billing/return`;

  /** Events can arrive out of order, so always read the subscription as it is now. */
  const current = async (subscriptionId: string): Promise<SubscriptionState> => {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return {
      accountId: subscription.metadata.accountId,
      customerId: idOf(subscription.customer),
      subscriptionId: subscription.id,
      status: subscription.status,
    };
  };

  return {
    async checkoutUrl({ accountId, customerId }) {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: options.priceId, quantity: 1 }],
        client_reference_id: accountId,
        ...(customerId ? { customer: customerId } : {}),
        subscription_data: { metadata: { accountId } },
        success_url: `${returnUrl}?done=1`,
        cancel_url: returnUrl,
      });
      if (!session.url) throw new Error("Stripe didn't return a checkout page");
      return session.url;
    },
    async portalUrl(customerId) {
      return (await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl })).url;
    },
    async cancel(subscriptionId) {
      await stripe.subscriptions.cancel(subscriptionId);
    },
    async webhook(body, signature) {
      const event = await stripe.webhooks.constructEventAsync(body, signature, options.webhookSecret);
      switch (event.type) {
        case "checkout.session.completed":
          return event.data.object.subscription ? current(idOf(event.data.object.subscription)) : null;
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted":
          return current(event.data.object.id);
        default:
          return null;
      }
    },
  };
}

const MB = 1024 * 1024;

/** Plan limits from the environment, with defaults for the hosted service. */
export function plansFromEnv(env: Record<string, string | undefined>): Plans {
  const number = (name: string, fallback: number) => Number(env[name] ?? fallback);
  return {
    free: { devices: number("FREE_DEVICES", 3), collections: number("FREE_COLLECTIONS", 5), storageBytes: number("FREE_STORAGE_MB", 25) * MB },
    plus: { devices: number("PLUS_DEVICES", 20), collections: number("PLUS_COLLECTIONS", 200), storageBytes: number("PLUS_STORAGE_MB", 1024) * MB },
  };
}
