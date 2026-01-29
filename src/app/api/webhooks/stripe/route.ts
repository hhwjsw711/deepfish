import { stripe } from "~/lib/stripe";
import { db } from "~/server/db";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { users } from "~/server/db/schema";
import type Stripe from "stripe";

export const dynamic = "force-dynamic";

// Configuration
const CREDITS_PER_PACK = 50;
const SUBSCRIPTION_CREDITS = 200;

/**
 * Sync subscription state from webhook event data
 * Uses event data directly to avoid API calls and timeouts
 */
async function syncSubscription(
  subscription: Stripe.Subscription,
  eventId: string,
) {
  const customerId = subscription.customer as string;

  const user = await db.query.users.findFirst({
    where: eq(users.stripeCustomerId, customerId),
  });

  if (!user) {
    console.error(
      `[Stripe] User not found for customer ${customerId} | Event: ${eventId}`,
    );
    return;
  }

  // Get period end from subscription or first item
  const periodEnd =
    subscription.current_period_end ||
    subscription.items?.data?.[0]?.current_period_end;

  if (!periodEnd) {
    console.log(
      `[Stripe] Skipping - no period end for subscription ${subscription.id} | Event: ${eventId}`,
    );
    return;
  }

  // Determine if we should add credits (new billing period)
  const shouldAddCredits =
    subscription.status === "active" &&
    (!user.stripeCurrentPeriodEnd ||
      new Date(periodEnd * 1000).getTime() >
        user.stripeCurrentPeriodEnd.getTime());

  // Sync subscription state to database with transaction
  await db
    .update(users)
    .set({
      subscribed: subscription.status === "active",
      stripeSubscriptionId: subscription.id,
      stripePriceId: subscription.items.data[0]?.price.id ?? null,
      stripeCurrentPeriodEnd: new Date(periodEnd * 1000),
      ...(shouldAddCredits && {
        creditBalance: user.creditBalance + SUBSCRIPTION_CREDITS,
      }),
    })
    .where(eq(users.id, user.id));

  console.log(
    `[Stripe] Synced subscription for user ${user.id} | Status: ${subscription.status} | Credits: ${shouldAddCredits ? `+${SUBSCRIPTION_CREDITS}` : "0"} | Event: ${eventId}`,
  );
}

export async function POST(req: Request) {
  const body = await req.text();
  const signature = (await headers()).get("Stripe-Signature") as string;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch (error) {
    console.error("[Stripe] Webhook signature verification failed:", error);
    return new Response(
      `Webhook Error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      { status: 400 },
    );
  }

  console.log(`[Stripe] Processing event ${event.id} | Type: ${event.type}`);

  try {
    switch (event.type) {
      // All subscription events use unified sync function
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        const subscription = event.data.object as Stripe.Subscription;
        await syncSubscription(subscription, event.id);
        break;

      // checkout session completion for credit pack purchase
      case "checkout.session.completed":
        const checkoutSession = event.data.object as Stripe.Checkout.Session;

        // for credit pack purchase
        if (checkoutSession.mode === "payment") {
          const customerId = checkoutSession.customer as string;

          if (customerId) {
            // find user by stripe customer id
            const [user] = await db
              .select()
              .from(users)
              .where(eq(users.stripeCustomerId, customerId));

            if (user) {
              const sessionWithLineItems =
                await stripe.checkout.sessions.retrieve(checkoutSession.id, {
                  expand: ["line_items"],
                });

              const lineItem = sessionWithLineItems.line_items?.data?.[0];
              const quantity = lineItem?.quantity || 1;
              const creditsToAdd = CREDITS_PER_PACK * quantity;

              await db
                .update(users)
                .set({
                  creditBalance: user.creditBalance + creditsToAdd,
                })
                .where(eq(users.stripeCustomerId, customerId));

              console.log(
                `[Stripe] Added ${creditsToAdd} credits (${quantity} packs × ${CREDITS_PER_PACK}) to user ${user.id} | Event: ${event.id}`,
              );
            } else {
              console.error(
                `[Stripe] User not found for customer ${customerId} | Event: ${event.id}`,
              );
            }
          }
        }
        break;
    }
  } catch (error) {
    console.error(
      `[Stripe] Error processing event ${event.id} (${event.type}):`,
      error,
    );
    return new Response(
      `Error processing webhook: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      { status: 500 },
    );
  }

  return new Response(null, { status: 200 });
}
