import Stripe from "https://esm.sh/stripe@14?target=denonext"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") as string, {
  apiVersion: "2026-03-25.dahlia",
})

interface Payload {
  reservation_id: string
  promo_code?: string
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() })
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

  const { reservation_id, promo_code } = payload
  if (!reservation_id) return json({ error: "reservation_id required" }, 400)

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

  // Fetch reservation
  const { data: res, error: resErr } = await sb
    .from("reservations")
    .select("*, profiles(full_name, email)")
    .eq("id", reservation_id)
    .eq("user_id", user.id)
    .single()

  if (resErr || !res) {
    return json({ error: "Reserva não encontrada." }, 404)
  }

  const baseAmount: number = parseFloat(res.total_amount) || 0
  if (baseAmount <= 0) {
    return json({ error: "Valor da reserva inválido." }, 422)
  }

  // Validate and apply promo code if provided
  let discountAmount = 0
  let promoId: string | null = null
  let promoCodeUsed: string | null = null

  if (promo_code) {
    const code = promo_code.trim().toUpperCase()
    const { data: promo } = await sb
      .from("promo_codes")
      .select("*")
      .eq("code", code)
      .eq("active", true)
      .single()

    if (promo) {
      const today = new Date().toISOString().slice(0, 10)
      const isValid =
        (!promo.valid_from  || today >= promo.valid_from)  &&
        (!promo.valid_until || today <= promo.valid_until) &&
        (promo.max_uses === null || promo.uses_count < promo.max_uses)

      if (isValid) {
        discountAmount = promo.discount_type === "percentage"
          ? (baseAmount * promo.discount_value) / 100
          : Math.min(promo.discount_value, baseAmount)
        promoId = promo.id
        promoCodeUsed = promo.code
      }
    }
  }

  const finalAmount = Math.max(baseAmount - discountAmount, 0)
  const amountCents = Math.round(finalAmount * 100)

  const checkIn  = (res.check_in  || "").replaceAll("-", "/")
  const checkOut = (res.check_out || "").replaceAll("-", "/")
  const roomName = res.room_name || res.room_id || "Suíte"

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    client_reference_id: reservation_id,
    customer_email: res.profiles?.email ?? undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "brl",
          unit_amount: amountCents,
          product_data: {
            name: `${roomName} — Château Pireneus`,
            description: `Check-in: ${checkIn} · Check-out: ${checkOut}${promoCodeUsed ? ` · Desconto: ${promoCodeUsed}` : ""}`,
          },
        },
      },
    ],
    metadata: { reservation_id, promo_code: promoCodeUsed ?? "" },
    success_url: `${Deno.env.get("SITE_URL") ?? "https://chateaupireneus.com.br"}/booking-success.html?reservation_id=${reservation_id}`,
    cancel_url:  `${Deno.env.get("SITE_URL") ?? "https://chateaupireneus.com.br"}/booking-cancel.html?reservation_id=${reservation_id}`,
    expires_at: Math.floor(Date.now() / 1000) + 1800, // 30 min
  })

  // Persist discount info on reservation + increment promo uses
  const reservationUpdate: Record<string, unknown> = {
    stripe_checkout_session_id: session.id,
    discount_amount: discountAmount,
  }
  if (promoId)       reservationUpdate.promo_code_id = promoId
  if (promoCodeUsed) reservationUpdate.promo_code    = promoCodeUsed

  await sb.from("reservations").update(reservationUpdate).eq("id", reservation_id)

  if (promoId) {
    await sb.rpc("increment_promo_uses", { p_promo_id: promoId })
  }

  return json({ checkout_url: session.url })
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  })
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  }
}
