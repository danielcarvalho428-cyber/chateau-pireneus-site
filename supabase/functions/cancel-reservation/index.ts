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

  const { data: profile } = await sb
    .from("profiles")
    .select("full_name, email")
    .eq("id", user.id)
    .maybeSingle()

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

  const totalAmount    = parseFloat(res.total_amount) || 0
  const discountAmount = parseFloat(res.discount_amount) || 0
  const paidAmount     = Math.max(totalAmount - discountAmount, 0)
  const refundAmount   = Math.round((paidAmount * refundPct) / 100 * 100) // in cents

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

  // Update reservation status — core fields that exist in base schema
  const { error: updateErr } = await sb
    .from("reservations")
    .update({
      status:         "cancelled",
      booking_status: "cancelled",
      payment_status: refundAmount > 0 ? "refunded" : paymentStatus,
    })
    .eq("id", reservation_id)

  if (updateErr) {
    console.error("Reservation update error:", updateErr)
    return json({ error: "Reserva cancelada, mas não foi possível atualizar o status. Entre em contato com a pousada." }, 500)
  }

  // Optional — new columns from migration; swallow error if columns don't exist yet
  await sb
    .from("reservations")
    .update({ cancelled_at: now.toISOString(), refund_rule: refundRule, refund_amount: refundAmount / 100, stripe_refund_id: stripeRefundId })
    .eq("id", reservation_id)
    .then(({ error: e }) => { if (e) console.warn("cancel detail columns skipped (migration pending?):", e.message) })

  // Release the availability slot
  await sb.rpc("release_booking_hold", { p_reservation_id: reservation_id })
    .then(({ error: e }) => { if (e) console.error("release_booking_hold error:", e) })

  // Fire-and-forget cancellation confirmation email
  const guestEmail: string = profile?.email ?? user.email ?? ""
  const guestName:  string = profile?.full_name ?? "Hóspede"
  if (guestEmail) {
    const FROM_EMAIL    = Deno.env.get("EMAIL_FROM")    ?? "reservas@chateaupireneus.com.br"
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") as string
    const fmtDate = (iso: string | null) => iso ? iso.split("-").reverse().join("/") : "—"
    const fmtBRL  = (v: number) => "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2 })
    const refundLine = refundAmount > 0
      ? `<p style="margin:0 0 8px;font-size:13px;color:#555;">O reembolso de <strong>${fmtBRL(refundAmount / 100)}</strong> será estornado para o seu cartão em até 5 dias úteis.</p>`
      : `<p style="margin:0 0 8px;font-size:13px;color:#555;">Conforme nossa política de cancelamento, não há reembolso para esta reserva.</p>`
    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f5f0e8;font-family:'Georgia',serif;">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);">
  <div style="background:#1d3557;padding:36px 40px 28px;text-align:center;">
    <h1 style="margin:0;color:#d8c7a1;font-size:22px;letter-spacing:2px;font-weight:normal;text-transform:uppercase;">Château Pireneus</h1>
    <p style="margin:6px 0 0;color:rgba(255,255,255,.65);font-size:13px;">Pousada de Charme · Pirenópolis, GO</p>
    <div style="display:inline-block;background:#d8c7a1;color:#1d3557;border-radius:20px;padding:6px 20px;font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;margin:20px 0 0;">Reserva Cancelada</div>
  </div>
  <div style="padding:36px 40px;">
    <p style="font-size:18px;color:#1d3557;margin:0 0 12px;">Olá, ${guestName.split(" ")[0]}!</p>
    <p style="font-size:14px;color:#555;margin:0 0 24px;line-height:1.7;">Sua reserva foi cancelada conforme solicitado. Veja o resumo abaixo.</p>
    <div style="background:#f5f0e8;border-radius:10px;padding:20px 24px;margin:0 0 20px;">
      <p style="margin:0 0 8px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1.5px;">Reserva cancelada</p>
      <p style="margin:0 0 6px;font-size:13px;color:#666;">Acomodação: <strong style="color:#1d3557;">${res.room_name ?? res.room_id ?? "—"}</strong></p>
      <p style="margin:0 0 6px;font-size:13px;color:#666;">Check-in: <strong style="color:#1d3557;">${fmtDate(res.check_in)}</strong></p>
      <p style="margin:0;font-size:13px;color:#666;">Check-out: <strong style="color:#1d3557;">${fmtDate(res.check_out)}</strong></p>
    </div>
    ${refundLine}
    <p style="font-size:13px;color:#888;line-height:1.7;margin:20px 0 0;">Se tiver qualquer dúvida, fale conosco pelo <a href="https://wa.me/5562998167654" style="color:#1d3557;">WhatsApp (62) 99816-7654</a>.</p>
  </div>
  <div style="background:#1d3557;padding:24px 40px;text-align:center;">
    <p style="margin:4px 0;color:rgba(255,255,255,.55);font-size:12px;">Château Pireneus · Pirenópolis, GO</p>
    <p style="margin:4px 0;font-size:12px;"><a href="https://chateaupireneus.com.br/privacidade.html" style="color:#d8c7a1;text-decoration:none;">Política de Privacidade</a></p>
  </div>
</div></body></html>`

    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `Château Pireneus <${FROM_EMAIL}>`,
        to: [guestEmail],
        subject: "Sua reserva foi cancelada — Château Pireneus",
        html,
      }),
    }).catch(err => console.error("Cancellation email failed:", err))
  }

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
