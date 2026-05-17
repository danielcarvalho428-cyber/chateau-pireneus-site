import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const FNRH_USUARIO = Deno.env.get("FNRH_USUARIO") as string
const FNRH_CHAVE   = Deno.env.get("FNRH_CHAVE")   as string
const FNRH_BASE    = "https://fnrh.turismo.serpro.gov.br/FNRH_API/rest/v1"

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  })
}

function fnrhAuthHeader(): string {
  return "Basic " + btoa(`${FNRH_USUARIO}:${FNRH_CHAVE}`)
}

// Map Portuguese sex values to FNRH API codes
const SEX_MAP: Record<string, string> = {
  "Masculino": "M",
  "Feminino":  "F",
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS })
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 })
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  const authHeader = req.headers.get("Authorization")
  if (!authHeader) return json({ error: "Unauthorized" }, 401)

  const sbUser = createClient(
    Deno.env.get("SUPABASE_URL") as string,
    Deno.env.get("SUPABASE_ANON_KEY") as string,
    { global: { headers: { Authorization: authHeader } } }
  )

  const { data: { user }, error: authErr } = await sbUser.auth.getUser()
  if (authErr || !user) return json({ error: "Invalid session" }, 401)

  const sbAdmin = createClient(
    Deno.env.get("SUPABASE_URL") as string,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") as string
  )

  // ── Parse body ──────────────────────────────────────────────────────────────

  let booking_id: string | null = null
  try {
    const body = await req.json()
    booking_id = body.booking_id ?? null
  } catch { /* booking_id stays null */ }

  // ── Fetch profile ───────────────────────────────────────────────────────────

  const { data: profile, error: profileErr } = await sbAdmin
    .from("profiles")
    .select(`
      full_name, cpf_cnpj, date_of_birth, sex, profession, nationality,
      phone, address_zip, address_street, address_number,
      address_city, address_state, address_country
    `)
    .eq("id", user.id)
    .maybeSingle()

  if (profileErr || !profile) {
    return json({ error: "Perfil não encontrado" }, 404)
  }

  // ── Validate required FNRH fields ───────────────────────────────────────────

  const missing: string[] = []
  if (!profile.full_name)       missing.push("nome completo")
  if (!profile.date_of_birth)   missing.push("data de nascimento")
  if (!profile.sex)             missing.push("sexo")
  if (!profile.profession)      missing.push("profissão")
  if (!profile.nationality)     missing.push("nacionalidade")
  if (!profile.phone)           missing.push("telefone")
  if (!profile.address_zip)     missing.push("CEP")
  if (!profile.address_street)  missing.push("logradouro")
  if (!profile.address_number)  missing.push("número")
  if (!profile.address_city)    missing.push("cidade")
  if (!profile.address_state)   missing.push("estado")

  if (missing.length) {
    return json({ error: "Campos obrigatórios incompletos na ficha", missing }, 422)
  }

  // ── Fetch reservation (optional) ────────────────────────────────────────────

  let reservation: Record<string, string> | null = null
  if (booking_id) {
    const { data } = await sbAdmin
      .from("reservations")
      .select("id, check_in, check_out, room_type, room_name, purpose_of_visit")
      .eq("id", booking_id)
      .eq("user_id", user.id)
      .maybeSingle()
    reservation = data
  }

  // ── Build FNRH payload ──────────────────────────────────────────────────────

  const hospede = {
    nome:            profile.full_name,
    cpf:             profile.cpf_cnpj?.replace(/\D/g, "") || null,
    data_nascimento: profile.date_of_birth,
    sexo:            SEX_MAP[profile.sex] ?? "N",
    profissao:       profile.profession,
    nacionalidade:   profile.nationality,
    email:           user.email ?? null,
    telefone:        profile.phone?.replace(/\D/g, "") || null,
    endereco: {
      cep:        profile.address_zip?.replace(/\D/g, "") || null,
      logradouro: profile.address_street,
      numero:     profile.address_number,
      municipio:  profile.address_city,
      estado:     profile.address_state,
      pais:       profile.address_country ?? "Brasil",
    },
    motivo_viagem: reservation?.purpose_of_visit ?? null,
    is_principal:  true,
  }

  const fnrhPayload = {
    codigo_reserva: booking_id ?? user.id,
    data_entrada:   reservation?.check_in  ?? null,
    data_saida:     reservation?.check_out ?? null,
    tipo_unidade:   reservation?.room_name ?? reservation?.room_type ?? null,
    hospedes:       [hospede],
  }

  console.log("FNRH payload submitted for reservation:", reservationId)

  // ── Submit to e-FNRH API ────────────────────────────────────────────────────

  let fnrhStatus: number
  let fnrhBody: unknown

  try {
    const res = await fetch(`${FNRH_BASE}/hospedagem`, {
      method: "POST",
      headers: {
        "Authorization": fnrhAuthHeader(),
        "Content-Type":  "application/json",
        "Accept":        "application/json",
      },
      body: JSON.stringify(fnrhPayload),
    })

    fnrhStatus = res.status
    const text = await res.text()
    try { fnrhBody = JSON.parse(text) } catch { fnrhBody = text }

    console.log(`FNRH response ${fnrhStatus}:`, JSON.stringify(fnrhBody))

    if (!res.ok) {
      return json({
        error:  "A API da FNRH retornou um erro",
        status: fnrhStatus,
        detail: fnrhBody,
      }, fnrhStatus >= 500 ? 502 : 400)
    }
  } catch (err) {
    console.error("FNRH fetch error:", err)
    return json({ error: "Não foi possível contactar a API da FNRH", detail: String(err) }, 502)
  }

  // ── Mark reservation as FNRH-submitted (best-effort) ───────────────────────

  if (booking_id) {
    await sbAdmin
      .from("reservations")
      .update({ fnrh_submitted_at: new Date().toISOString() })
      .eq("id", booking_id)
      .eq("user_id", user.id)
      .then(({ error }) => {
        if (error) console.warn("Could not update fnrh_submitted_at:", error.message)
      })
  }

  return json({ ok: true, fnrh: fnrhBody })
})
