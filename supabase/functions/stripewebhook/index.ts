import Stripe from "https://esm.sh/stripe@14?target=denonext"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") as string, {
  apiVersion: "2026-03-25.dahlia",
})

const cryptoProvider = Stripe.createSubtleCryptoProvider()

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 })
  }

  const signature = request.headers.get("Stripe-Signature")

  if (!signature) {
    return new Response("Missing Stripe-Signature header", { status: 400 })
  }

  const body = await request.text()

  let event: Stripe.Event

  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      Deno.env.get("STRIPE_WEBHOOK_SIGNING_SECRET") as string,
      undefined,
      cryptoProvider
    )
  } catch (err) {
    console.error("Webhook signature verification failed:", err)
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Invalid signature" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    )
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") as string,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") as string
  )

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session

        const reservationId =
          session.client_reference_id ||
          session.metadata?.reservation_id ||
          null

        if (!reservationId) {
          console.error("Missing reservation_id in checkout.session.completed")
          break
        }

        const paymentIntentId =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id || null

        const { error: updateError } = await supabase
          .from("reservations")
          .update({
            payment_provider: "stripe",
            payment_status: "paid",
            payment_id: session.id,
            payment_preference_id: session.id,
            payment_external_reference: reservationId,
            stripe_checkout_session_id: session.id,
            stripe_payment_intent_id: paymentIntentId,
          })
          .eq("id", reservationId)

        if (updateError) {
          console.error("Reservation update error:", updateError)
          return new Response(
            JSON.stringify({ error: updateError.message }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        const { error: confirmError } = await supabase.rpc("confirm_booking_payment", {
          p_reservation_id: reservationId,
        })

        if (confirmError) {
          console.error("confirm_booking_payment error:", confirmError)
          return new Response(
            JSON.stringify({ error: confirmError.message }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        console.log("Reservation confirmed:", reservationId)
        break
      }

      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session

        const reservationId =
          session.client_reference_id ||
          session.metadata?.reservation_id ||
          null

        if (!reservationId) {
          console.error("Missing reservation_id in checkout.session.expired")
          break
        }

        const { error: releaseError } = await supabase.rpc("release_booking_hold", {
          p_reservation_id: reservationId,
        })

        if (releaseError) {
          console.error("release_booking_hold error:", releaseError)
          return new Response(
            JSON.stringify({ error: releaseError.message }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        console.log("Reservation released after session expiration:", reservationId)
        break
      }

      case "payment_intent.payment_failed": {
        const paymentIntent = event.data.object as Stripe.PaymentIntent
        const reservationId = paymentIntent.metadata?.reservation_id || null

        if (!reservationId) {
          console.log("No reservation_id in failed payment intent")
          break
        }

        const { error: releaseError } = await supabase.rpc("release_booking_hold", {
          p_reservation_id: reservationId,
        })

        if (releaseError) {
          console.error("release_booking_hold error:", releaseError)
          return new Response(
            JSON.stringify({ error: releaseError.message }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        console.log("Reservation released after failed payment:", reservationId)
        break
      }

      default:
        console.log("Unhandled event type:", event.type)
        break
    }

    return new Response(
      JSON.stringify({ received: true }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    )
  } catch (err) {
    console.error("Webhook processing error:", err)

    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unexpected webhook error" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    )
  }
})