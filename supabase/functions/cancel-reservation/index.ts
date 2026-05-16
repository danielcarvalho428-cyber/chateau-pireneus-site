import Stripe from "https://esm.sh/stripe@14?target=denonext"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") as string, {
  apiVersion: "2026-03-25.dahlia",
})

interface Payload {
  reservation_id: string
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return json(null, 204)
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405)
  }

  let payload: Payload
  try {
    payload = await req.json()
  } catch {
    return json({ error: "Invalid JSON" }, 400)
  }

  const { reservation_id } = payload
  if (!reservation_id) return json({ error: "reservation_id required" }, 400)

  // Authenticate the requesting user
  const authHeader = req.headers.get("Authorization") ?? ""
  const token = authHeader.replace("Bearer ", "")

  const sbUser = createClient(
    Deno.env.get("SUPABASE_URL") as string,
    Deno.env.get("SUPABASE_ANON_KEY") as string,
    { global: { headers: { Authorization: authHeader } } }
  )
  const { data: { user }, error: authErr } = await sbUser.auth.getUser(token)
  if (authErr || !user) return json({ error: "Unauthorized" }, 401)

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") as string,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") as string
  )

  // Fetch the reservation (must belong to this user)
  const { data: res, error: resErr } = await sb
    .from("reservations")
    .select("*")
    .eq("id", reservation_id)
    .eq("user_id", user.id)
    .single()

  if (resErr || !res) {
    return json({ error: "Reserva não encontrada." }, 404)
  }

  // Must be a paid/confirmed reservation to cancel with refund
  const paymentStatus = (res.payment_status || "").toLowerCase()
  const isPaid = ["paid", "confirmed"].includes(paymentStatus) ||
                 (res.status || "").toLowerCase() === "confirmed"

  if (!isPaid) {
    return json({ error: "Apenas reservas confirmadas e pagas podem ser canceladas por este canal." }, 409)
  }

  // Must be before check-in
  const now       = new Date()
  const checkIn   = new Date(`${res.check_in}T12:00:00`)
  if (checkIn <= now) {
    return json({ error: "Não é possível cancelar uma reserva após o check-in." }, 409)
  }

  // --- Refund policy ---
  // Rule 1 (lei de arrependimento): booking made ≥ 5 days before check-in
  //   → 100% refund if cancelled within 7 days of booking
  // Rule 2 (short-notice): booking made < 5 days before check-in
  //   → 100% refund if cancelled at least 48 hours before check-in
  // Otherwise: 0% refund

  const bookingDate           = new Date(res.created_at)
  const daysSinceBooking      = (now.getTime() - bookingDate.getTime()) / 86_400_000
  const daysUntilCheckIn      = (checkIn.getTime() - now.getTime()) / 86_400_000
  const daysBookingToCheckIn  = (checkIn.getTime() - bookingDate.getTime()) / 86_400_000

  let refundPct = 0
  let refundRule = "no_refund"

  if (daysBookingToCheckIn >= 5 && daysSinceBooking <= 7) {
    refundPct  = 100
    refundRule = "lei_arrependimento"
  } else if (daysBookingToCheckIn < 5 && daysUntilCheckIn >= 2) {
    refundPct  = 100
    refundRule = "short_notice_48h"
  }

  const totalAmount   = parseFloat(res.total_amount) || 0
  const refundAmount  = Math.round((totalAmount * refundPct) / 100 * 100) // in cents

  // If a Stripe payment intent exists, issue the refund via Stripe
  const paymentIntentId: string | null = res.stripe_payment_intent_id ?? null

  let stripeRefundId: string | null = null

  if (refundAmount > 0 && paymentIntentId) {
    try {
      const refund = await stripe.refunds.create({
        payment_intent: paymentIntentId,
        amount: refundAmount,
        reason: "requested_by_customer",
        metadata: { reservation_id, refund_rule: refundRule },
      })
      stripeRefundId = refund.id
    } catch (err) {
      console.error("Stripe refund failed:", err)
      return json({ error: "Não foi possível processar o reembolso. Entre em contato com a pousada." }, 502)
    }
  }

  // Update reservation status
  const { error: updateErr } = await sb
    .from("reservations")
    .update({
      status:         "cancelled",
      booking_status: "cancelled",
      payment_status: refundAmount > 0 ? "refunded" : paymentStatus,
      cancelled_at:   now.toISOString(),
      refund_rule:    refundRule,
      refund_amount:  refundAmount / 100,
      stripe_refund_id: stripeRefundId,
    })
    .eq("id", reservation_id)

  if (updateErr) {
    console.error("Reservation update error:", updateErr)
    return json({ error: "Reserva cancelada, mas não foi possível atualizar o status. Entre em contato com a pousada." }, 500)
  }

  // Release the availability slot
  await sb.rpc("release_booking_hold", { p_reservation_id: reservation_id })
    .then(({ error: e }) => { if (e) console.error("release_booking_hold error:", e) })

  return json({
    ok: true,
    refund_pct:    refundPct,
    refund_amount: refundAmount / 100,
    refund_rule:   refundRule,
    stripe_refund: stripeRefundId,
  })
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  })
}
