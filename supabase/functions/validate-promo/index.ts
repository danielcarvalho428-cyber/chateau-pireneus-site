import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

interface Payload {
  code: string
  total_amount: number
  nights: number
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

  const { code, total_amount, nights } = payload
  if (!code) return json({ error: "Código não informado." }, 400)

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") as string,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") as string
  )

  const { data: promo, error } = await sb
    .from("promo_codes")
    .select("*")
    .eq("code", code.trim().toUpperCase())
    .eq("active", true)
    .single()

  if (error || !promo) {
    return json({ valid: false, error: "Código inválido ou inativo." })
  }

  const today = new Date().toISOString().slice(0, 10)
  if (promo.valid_from && today < promo.valid_from) {
    return json({ valid: false, error: "Código ainda não está válido." })
  }
  if (promo.valid_until && today > promo.valid_until) {
    return json({ valid: false, error: "Código expirado." })
  }
  if (promo.max_uses !== null && promo.uses_count >= promo.max_uses) {
    return json({ valid: false, error: "Código esgotado." })
  }
  if (promo.min_nights && nights < promo.min_nights) {
    return json({ valid: false, error: `Código válido apenas para estadias de ${promo.min_nights}+ noites.` })
  }
  if (promo.min_amount && total_amount < promo.min_amount) {
    return json({ valid: false, error: `Código válido para reservas acima de R$ ${promo.min_amount.toFixed(2).replace(".", ",")}.` })
  }

  const discount = calcDiscount(promo.discount_type, promo.discount_value, total_amount)
  const final_amount = Math.max(0, total_amount - discount)

  return json({
    valid: true,
    code: promo.code,
    promo_id: promo.id,
    discount_type: promo.discount_type,
    discount_value: promo.discount_value,
    discount_amount: Math.round(discount * 100) / 100,
    final_amount: Math.round(final_amount * 100) / 100,
    description: promo.description,
  })
})

function calcDiscount(type: string, value: number, total: number): number {
  if (type === "percentage") return (total * value) / 100
  return Math.min(value, total)
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
