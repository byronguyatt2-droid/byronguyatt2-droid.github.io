# Korvus Worker (`korva`)

`worker.js` is the full source of the Cloudflare Worker at
`https://korva.byronguyatt2.workers.dev`. It is the live v6 Worker (AI proxy,
sign-in check, plan limits) plus the Stripe billing routes the app already
calls:

| Route | Called by | What it does |
| --- | --- | --- |
| `GET /stripe/subscription-status` | Settings › Billing | Returns the business's plan, status, trial end, AI calls used and limit |
| `POST /stripe/create-checkout-session` | Upgrade buttons | Returns a Stripe Checkout link for `starter`, `pro` or `business` |
| `POST /stripe/create-portal-session` | Manage button | Returns a Stripe Billing Portal link (change plan, card, cancel) |
| `POST /stripe/webhook` | Stripe | Updates the `subscriptions` row when someone pays, changes plan or cancels |
| `POST /send-email` | Send, Email to client, Email certificate, Email invoice | Emails the PDFs to the client from the business through Resend, with a copy to the business; answers 501 until Resend is set up, and the app then uses the phone's mail app |
| `POST /transcribe` | Experimental AI audio transcription | Runs the recording through Whisper on Workers AI and returns `{ transcript }`; counts as one AI call |

Only the business owner can start checkout or open the portal. The AI proxy's
token cap is now 4096 (was 3000) to match what the app asks for. Everything
else the Worker did before is unchanged.

`/transcribe` needs a Workers AI binding named exactly `AI` (korva › Settings ›
Bindings › Add › Workers AI). Without it the route answers 501 and the app
quietly keeps the on-device transcript.

## Sending email (Resend)

Until both secrets below are set, KORVUS keeps sending through the phone's mail
app. Emails need to come from your own domain, or they land in spam.

1. Sign up at resend.com (free up to 3,000 emails a month).
2. Resend › Domains › Add domain › your domain. Add the DNS records it shows
   at your domain provider, then wait for Resend to show it as Verified.
3. Resend › API Keys › Create API key (Sending access). Copy it (starts with `re_`).
4. Cloudflare › Workers & Pages › `korva` › Settings › Variables and Secrets ›
   Add, as type **Secret**:
   - `RESEND_API_KEY`: the key from step 3
   - `MAIL_FROM`: the address to send from, e.g. `reports@yourdomain.com.au`

Clients see the business's name (Company details) as the sender, and replies
go to the business email in Company details, which also gets a copy of every
email sent.

## One-time Stripe setup

Do this in **test mode** first (toggle at the top of the Stripe dashboard), then
repeat with live keys when you're ready to charge real cards.

1. **Create the three products.** Stripe › Product catalogue › Add product.
   Make Starter ($49/month), Pro ($99/month) and Business ($199/month), each with
   a recurring monthly price. Copy each price's ID (starts with `price_`).
2. **Get your secret key.** Developers › API keys › Secret key (starts with
   `sk_test_` in test mode, `sk_live_` in live mode).
3. **Add the webhook.** Developers › Webhooks › Add endpoint.
   - Endpoint URL: `https://korva.byronguyatt2.workers.dev/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`
   - After saving, reveal the **Signing secret** (starts with `whsec_`).
4. **Turn on the Billing Portal.** Settings › Billing › Customer portal ›
   Activate. Allow customers to update payment methods, cancel, and switch
   plans between the three products above.

## Add the secrets to the Worker

Cloudflare dashboard › Workers & Pages › `korva` › Settings › Variables and
Secrets › Add. Add each as type **Secret**:

| Name | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | `sk_test_…` (later `sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from step 3 |
| `STRIPE_PRICE_STARTER` | Starter's `price_…` |
| `STRIPE_PRICE_PRO` | Pro's `price_…` |
| `STRIPE_PRICE_BUSINESS` | Business's `price_…` |

`ANTHROPIC_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are already set and stay
as they are.

Test-mode and live-mode keys, price IDs and webhook secrets are all different,
so when you switch to live, replace all five values.

## Deploy

Cloudflare dashboard › Workers & Pages › `korva` › Edit code. Replace the
contents of `worker.js` with this file and click **Deploy**. No packages or
build step are needed.

(If you use Wrangler instead: `npx wrangler deploy worker/worker.js --name korva`,
and `npx wrangler secret put STRIPE_SECRET_KEY --name korva` for each secret.)

## Check it works (test mode)

1. Open the app, sign in as a business owner, open Settings › Billing. The plan
   line should show the trial and usage instead of "Billing isn't set up yet".
2. Tap Upgrade on any plan and pay with card `4242 4242 4242 4242`, any future
   date, any CVC.
3. You land back in the app with "Subscription updated". The plan line now
   shows the new plan, and the Manage button appears.
4. In Stripe › Developers › Webhooks, the endpoint's recent deliveries should
   all show `200`. If any failed, the Worker's Logs tab in Cloudflare shows why.

## How the plan gets updated

Checkout itself doesn't change anything in Supabase. Stripe calls the webhook,
which writes `plan`, `status`, `stripe_customer_id` and `stripe_subscription_id`
onto the business's `subscriptions` row. A new paid subscription also resets the
month's AI usage to 0. Stripe statuses map onto the table's allowed values:
`active`/`trialing` → `active`; `past_due`/`unpaid`/`incomplete`/`paused` →
`past_due`; anything else → `canceled`. A canceled plan blocks AI calls, as it
already did.
