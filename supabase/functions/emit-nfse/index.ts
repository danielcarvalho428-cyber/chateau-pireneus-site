import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Called fire-and-forget by stripewebhook after checkout.session.completed.
// Registers the emission intent as "pending" — the NFS-e Nacional worker
// (nf-emissor Node.js service) polls this table and does the actual emission.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  })
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json(null, 204)
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)

  // Only the service role key may call this (invoked internally by stripewebhook)
  const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  const auth   = req.headers.get("Authorization") ?? ""
  if (!svcKey || auth !== `Bearer ${svcKey}`) {
    return json({ error: "Unauthorized" }, 401)
  }

  let reservationId: string
  try {
    const body = await req.json()
    reservationId = body.reservation_id
  } catch {
    return json({ error: "Invalid JSON body" }, 400)
  }

  if (!reservationId) return json({ error: "reservation_id is required" }, 400)

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") as string,
    svcKey
  )

  // Verify payment is confirmed
  const { data: reservation, error: resErr } = await supabase
    .from("reservations")
    .select("id, user_id, room_type, check_in, check_out, total_amount, payment_status")
    .eq("id", reservationId)
    .single()

  if (resErr || !reservation) {
    console.error("Reservation not found:", resErr?.message)
    return json({ error: "Reservation not found" }, 404)
  }

  if (reservation.payment_status !== "paid") {
    return json({ error: "Reservation is not paid" }, 422)
  }

  // Fetch guest profile for CPF/name/email
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, email, cpf_cnpj")
    .eq("id", reservation.user_id)
    .single()

  const guestName  = profile?.full_name ?? "Hóspede"
  const guestEmail = profile?.email     ?? null
  const cpfCnpj    = profile?.cpf_cnpj  ?? null

  // Competencia = month of check-in (when service is rendered, not when paid)
  const competencia = reservation.check_in
    ? (reservation.check_in as string).slice(0, 7)
    : new Date().toISOString().slice(0, 7)

  // Upsert as pending — the worker will pick this up and do the real emission
  const { error: upsertErr } = await supabase
    .from("notas_fiscais")
    .upsert({
      reservation_id: reservationId,
      user_id:        reservation.user_id,
      cpf_cnpj:       cpfCnpj,
      guest_name:     guestName,
      guest_email:    guestEmail,
      amount_brl:     reservation.total_amount,
      competencia,
      status:         "pending",
      provider:       "nacional",
      provider_id:    null,
      pdf_url:        null,
      xml_url:        null,
      error_msg:      null,
      emitted_at:     null,
      updated_at:     new Date().toISOString(),
    }, { onConflict: "reservation_id" })

  if (upsertErr) {
    console.error("Failed to upsert notas_fiscais:", upsertErr)
    return json({ error: upsertErr.message }, 500)
  }

  console.log(`NFS-e Nacional pending registered for reservation ${reservationId}`)
  return json({ queued: true, reservation_id: reservationId, competencia })
})
