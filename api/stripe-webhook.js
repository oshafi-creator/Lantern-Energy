const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function findAuthUserByEmail(email) {
  const { data, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (error || !data?.users) return null;

  return data.users.find(
    (u) => u.email && u.email.toLowerCase() === email.toLowerCase()
  );
}

async function upsertAccess({
  email,
  stripeCustomerId,
  stripeSubscriptionId,
  accessStatus,
  currentPeriodEnd,
  planName,
}) {
  if (!email) return;

  const authUser = await findAuthUserByEmail(email);

  const payload = {
    email,
    user_id: authUser ? authUser.id : null,
    has_access: ["active", "trialing"].includes(accessStatus),
    access_status: accessStatus,
    stripe_customer_id: stripeCustomerId || null,
    stripe_subscription_id: stripeSubscriptionId || null,
    current_period_end: currentPeriodEnd
      ? new Date(currentPeriodEnd * 1000).toISOString()
      : null,
    plan_name: planName || null,
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = await supabase
    .from("user_access")
    .select("id")
    .ilike("email", email)
    .maybeSingle();

  if (existing) {
    await supabase.from("user_access").update(payload).eq("id", existing.id);
  } else {
    await supabase.from("user_access").insert(payload);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  let event;

  try {
    const sig = req.headers["stripe-signature"];
    const rawBody = await getRawBody(req);

    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const email =
        session.customer_details?.email ||
        session.customer_email ||
        null;

      let subscription = null;

      if (session.subscription) {
        subscription = await stripe.subscriptions.retrieve(session.subscription);
      }

      await upsertAccess({
        email,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        accessStatus: subscription ? subscription.status : "active",
        currentPeriodEnd: subscription ? subscription.current_period_end : null,
        planName: session.metadata?.plan_name || "stripe-checkout",
      });
    }

    if (
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const subscription = event.data.object;
      const customer = await stripe.customers.retrieve(subscription.customer);

      await upsertAccess({
        email: customer.email,
        stripeCustomerId: subscription.customer,
        stripeSubscriptionId: subscription.id,
        accessStatus:
          event.type === "customer.subscription.deleted"
            ? "canceled"
            : subscription.status,
        currentPeriodEnd: subscription.current_period_end,
        planName: "stripe-subscription",
      });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
