import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const NFSE_BASE = "https://api.nfe.io/v1"

// Service code for "Serviços de alojamento e hospedagem" — adjust per your municipio
const CITY_SERVICE_CODE = Deno.env.get("NFSE_CITY_SERVICE_CODE") ?? "0107"

async function isAuthorized(req: Request): Promise<boolean> {
  const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  const auth = req.headers.get("Authorization") ?? ""
  if (svcKey && auth === `Bearer ${svcKey}`) return true

  const token = auth.replace("Bearer ", "")
  if (!token) return false

  const sbUser = createClient(
    Deno.env.get("SUPABASE_URL") as string,
    Deno.env.get("SUPABASE_ANON_KEY") as string,
    { global: { headers: { Authorization: auth } } }
  )

  const { data: { user }, error: authErr } = await sbUser.auth.getUser(token)
  if (authErr || !user) return false

  const { data: isAdmin, error: adminErr } = await sbUser.rpc("is_current_user_admin")
  return !adminErr && isAdmin === true
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json(null, 204)
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
  if (!(await isAuthorized(req))) return json({ error: "Unauthorized" }, 401)

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") as string,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") as string
  )

  const apiKey    = Deno.env.get("NFSE_API_KEY")
  const companyId = Deno.env.get("NFSE_COMPANY_ID")

  if (!apiKey || !companyId) {
    console.error("NFSE_API_KEY or NFSE_COMPANY_ID not configured")
    return json({ error: "Nota fiscal service not configured" }, 503)
  }

  let reservationId: string
  try {
    const body = await req.json()
    reservationId = body.reservation_id
  } catch {
    return json({ error: "Invalid JSON body" }, 400)
  }

  if (!reservationId) {
    return json({ error: "reservation_id is required" }, 400)
  }

  // Fetch reservation
  const { data: reservation, error: resErr } = await supabase
    .from("reservations")
    .select("id, user_id, room_type, check_in, check_out, total_amount, payment_status")
    .eq("id", reservationId)
    .single()

  if (resErr || !reservation) {
    return json({ error: "Reservation not found" }, 404)
  }

  if (reservation.payment_status !== "paid") {
    return json({ error: "Reservation is not paid yet" }, 422)
  }

  // Fetch guest profile
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, email, cpf_cnpj")
    .eq("id", reservation.user_id)
    .single()

  const cpfCnpjRaw  = profile?.cpf_cnpj ?? null
  const cpfCnpjClean = cpfCnpjRaw ? cpfCnpjRaw.replace(/\D/g, "") : null
  const guestName   = profile?.full_name ?? "Hóspede"
  const guestEmail  = profile?.email ?? null

  // Upsert a "pending" NF record so the admin can see it started
  const { error: upsertErr } = await supabase
    .from("notas_fiscais")
    .upsert({
      reservation_id: reservationId,
      user_id:        reservation.user_id,
      cpf_cnpj:       cpfCnpjRaw,
      guest_name:     guestName,
      guest_email:    guestEmail,
      amount_brl:     reservation.total_amount,
      status:         "pending",
      provider:       "nfeio",
      error_msg:      null,
      updated_at:     new Date().toISOString(),
    }, { onConflict: "reservation_id" })

  if (upsertErr) {
    console.error("Failed to upsert notas_fiscais record:", upsertErr)
    return json({ error: upsertErr.message }, 500)
  }

  // Build NFE.io NFS-e payload
  const checkIn  = formatDateBR(reservation.check_in)
  const checkOut = formatDateBR(reservation.check_out)
  const description = `Hospedagem - ${reservation.room_type} - Check-in ${checkIn} / Check-out ${checkOut}`

  const borrower: Record<string, unknown> = {
    name: guestName,
    address: {
      country:    "BRA",
      state:      "GO",
      city:       { name: "Pirenópolis" },
      postalCode: "72980000",
    },
  }
  if (guestEmail)    borrower.email          = guestEmail
  if (cpfCnpjClean)  borrower.federalTaxNumber = cpfCnpjClean

  const payload = {
    cityServiceCode:  CITY_SERVICE_CODE,
    description,
    servicesAmount:   Number(reservation.total_amount),
    borrower,
  }

  // Call NFE.io
  let nfRes: Response
  try {
    nfRes = await fetch(`${NFSE_BASE}/companies/${companyId}/serviceinvoices`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": apiKey,
      },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error reaching NFE.io"
    console.error("NFE.io network error:", msg)
    await markFailed(supabase, reservationId, msg)
    return json({ error: msg }, 502)
  }

  const nfData = await nfRes.json().catch(() => null)

  if (!nfRes.ok) {
    const errMsg = nfData?.message ?? nfData?.error ?? `NFE.io returned ${nfRes.status}`
    console.error("NFE.io API error:", errMsg, nfData)
    await markFailed(supabase, reservationId, errMsg)
    return json({ error: errMsg }, nfRes.status >= 500 ? 502 : 422)
  }

  // NFE.io may return "IssuedWithErrors", "Issued", or "Processing"
  const flowStatus = nfData?.flowStatus ?? ""
  const status     = flowStatus === "Issued" ? "emitted" : "processing"
  const invoiceId  = nfData?.id ?? null
  const pdfUrl     = nfData?.pdfUrl ?? nfData?.pdfFileUrl ?? null
  const xmlUrl     = nfData?.xmlUrl ?? nfData?.xmlFileUrl ?? null

  await supabase
    .from("notas_fiscais")
    .update({
      status,
      provider_id: invoiceId,
      pdf_url:     pdfUrl,
      xml_url:     xmlUrl,
      error_msg:   null,
      emitted_at:  status === "emitted" ? new Date().toISOString() : null,
      updated_at:  new Date().toISOString(),
    })
    .eq("reservation_id", reservationId)

  console.log(`NFS-e ${status} for reservation ${reservationId}, invoice ${invoiceId}`)

  return json({ success: true, status, invoice_id: invoiceId, pdf_url: pdfUrl })
})

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function formatDateBR(dateStr: string): string {
  if (!dateStr) return ""
  const [y, m, d] = dateStr.split("-")
  return `${d}/${m}/${y}`
}

async function markFailed(
  supabase: ReturnType<typeof createClient>,
  reservationId: string,
  errorMsg: string
) {
  await supabase
    .from("notas_fiscais")
    .update({ status: "failed", error_msg: errorMsg, updated_at: new Date().toISOString() })
    .eq("reservation_id", reservationId)
}
