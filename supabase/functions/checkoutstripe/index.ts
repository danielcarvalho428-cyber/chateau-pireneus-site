import Stripe from "https://esm.sh/stripe@14?target=denonext"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") as string, {
  apiVersion: "2026-03-25.dahlia",
})

interface Payload {
  reservation_id: string
  promo_code?: string
  add_ons?: string[]
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

  const { reservation_id, promo_code, add_ons } = payload
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

  const { data: res, error: resErr } = await sb
    .from("reservations")
    .select("*")
    .eq("id", reservation_id)
    .eq("user_id", user.id)
    .single()

  if (resErr || !res) {
    console.error("Reservation lookup failed:", resErr?.message, "reservation_id:", reservation_id, "user_id:", user.id)
    return json({ error: "Reserva nao encontrada." }, 404)
  }

  if (res.payment_status === "paid" || res.status === "confirmed" || res.booking_status === "booked") {
    return json({ error: "Esta reserva ja esta paga ou confirmada." }, 409)
  }

  if (res.expires_at && new Date(res.expires_at).getTime() <= Date.now()) {
    await sb.rpc("release_booking_hold", { p_reservation_id: reservation_id })
    return json({ error: "O prazo desta reserva expirou. Escolha as datas novamente." }, 409)
  }

  const baseAmount: number = parseFloat(res.total_amount) || 0
  if (baseAmount <= 0) {
    return json({ error: "Valor da reserva invalido." }, 422)
  }

  let discountAmount = 0
  let promoId: string | null = null
  let promoCodeUsed: string | null = null

  if (promo_code) {
    const code = promo_code.trim().toUpperCase()
    const { data: promo, error: promoErr } = await sb
      .from("promo_codes")
      .select("*")
      .eq("code", code)
      .eq("active", true)
      .single()

    if (promoErr || !promo) {
      return json({ error: "Codigo promocional invalido ou inativo." }, 422)
    }

    const today = new Date().toISOString().slice(0, 10)
    const nights = countNights(res.check_in, res.check_out)

    if (promo.valid_from && today < promo.valid_from) {
      return json({ error: "Codigo promocional ainda nao esta valido." }, 422)
    }
    if (promo.valid_until && today > promo.valid_until) {
      return json({ error: "Codigo promocional expirado." }, 422)
    }
    if (promo.max_uses !== null && promo.uses_count >= promo.max_uses) {
      return json({ error: "Codigo promocional esgotado." }, 422)
    }
    if (promo.min_nights && nights < Number(promo.min_nights)) {
      return json({ error: `Codigo valido apenas para estadias de ${promo.min_nights}+ noites.` }, 422)
    }
    if (promo.min_amount && baseAmount < Number(promo.min_amount)) {
      return json({ error: "Valor minimo da reserva nao atingido para este codigo." }, 422)
    }

    discountAmount = promo.discount_type === "percentage"
      ? (baseAmount * Number(promo.discount_value)) / 100
      : Math.min(Number(promo.discount_value), baseAmount)
    promoId = promo.id
    promoCodeUsed = promo.code
  }

  const finalAmount = Math.max(baseAmount - discountAmount, 0)
  const amountCents = Math.round(finalAmount * 100)
  if (amountCents <= 0) {
    return json({ error: "Pagamento online indisponivel para reserva com valor zerado." }, 422)
  }

  // Build validated add-on line items from DB (prices/labels/active are authoritative from DB)
  const nights = countNights(res.check_in, res.check_out)
  const guests = Math.max(1, Math.min(Number(res.guests) || 1, 10))
  const addonLineItems: { quantity: number; price_data: { currency: string; unit_amount: number; product_data: { name: string } } }[] = []
  let addonTotal = 0

  if (add_ons && add_ons.length > 0) {
    const { data: addonRows } = await sb
      .from("addons")
      .select("id, label, price, per, active")
      .in("id", add_ons)
      .eq("active", true)

    for (const addon of (addonRows ?? [])) {
      const unitAmount = addon.per === "person_night"
        ? Math.round(Number(addon.price) * guests * nights * 100)
        : Math.round(Number(addon.price) * 100)
      addonLineItems.push({
        quantity: 1,
        price_data: {
          currency: "brl",
          unit_amount: unitAmount,
          product_data: { name: addon.label },
        },
      })
      addonTotal += unitAmount / 100
    }
  }

  const nowSecs = Math.floor(Date.now() / 1000)
  const holdRemainingSecs = res.expires_at
    ? Math.max(Math.floor((new Date(res.expires_at).getTime() - Date.now()) / 1000), 0)
    : 3600
  const sessionExpiresAt = Math.min(nowSecs + Math.max(1800, holdRemainingSecs), nowSecs + 86400)

  const checkIn = (res.check_in || "").replaceAll("-", "/")
  const checkOut = (res.check_out || "").replaceAll("-", "/")
  const roomName = res.room_name || res.room_id || "Suite"

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    payment_method_types: ["card"],
    payment_method_options: {
      card: { installments: { enabled: true } },
    },
    client_reference_id: reservation_id,
    customer_email: user.email ?? undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "brl",
          unit_amount: amountCents,
          product_data: {
            name: `${roomName} - Chateau Pireneus`,
            description: `Check-in: ${checkIn} - Check-out: ${checkOut}${promoCodeUsed ? ` - Desconto: ${promoCodeUsed}` : ""}`,
          },
        },
      },
      ...addonLineItems,
    ],
    metadata: { reservation_id, promo_code: promoCodeUsed ?? "" },
    payment_intent_data: {
      metadata: { reservation_id, promo_code: promoCodeUsed ?? "" },
    },
    success_url: `${Deno.env.get("SITE_URL") ?? "https://chateaupireneus.com.br"}/booking-success.html?reservation_id=${reservation_id}`,
    cancel_url: `${Deno.env.get("SITE_URL") ?? "https://chateaupireneus.com.br"}/booking-success.html?reservation_id=${reservation_id}&cancelled=1`,
    expires_at: sessionExpiresAt,
  }

  let session: Stripe.Checkout.Session
  try {
    session = await stripe.checkout.sessions.create(sessionParams)
  } catch (err) {
    console.error("Stripe checkout creation failed:", err)
    return json({ error: "Nao foi possivel iniciar o pagamento." }, 502)
  }

  // Core update — fields that exist in the base schema (must succeed)
  const coreUpdate: Record<string, unknown> = {
    stripe_checkout_session_id: session.id,
    discount_amount: discountAmount,
  }
  if (promoId) coreUpdate.promo_code_id = promoId
  if (promoCodeUsed) coreUpdate.promo_code = promoCodeUsed

  const { error: updateErr } = await sb
    .from("reservations")
    .update(coreUpdate)
    .eq("id", reservation_id)

  if (updateErr) {
    console.error("Reservation checkout update error:", updateErr)
    return json({ error: "Nao foi possivel atualizar a reserva." }, 500)
  }

  // Optional update — addon columns added by migration; swallow error if columns don't exist yet
  if (addonTotal > 0 || (add_ons && add_ons.length > 0)) {
    await sb
      .from("reservations")
      .update({ addons_amount: addonTotal, addons: add_ons ?? [] })
      .eq("id", reservation_id)
      .then(({ error: e }) => { if (e) console.warn("addon column update skipped (migration pending?):", e.message) })
  }

  return json({ checkout_url: session.url })
})

function countNights(checkIn: string | null, checkOut: string | null): number {
  if (!checkIn || !checkOut) return 0
  const start = new Date(`${checkIn}T00:00:00Z`).getTime()
  const end = new Date(`${checkOut}T00:00:00Z`).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  return Math.round((end - start) / 86_400_000)
}

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
