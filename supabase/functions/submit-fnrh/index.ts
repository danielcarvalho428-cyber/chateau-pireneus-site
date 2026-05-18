import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const FNRH_USUARIO = Deno.env.get("FNRH_USUARIO") ?? ""
const FNRH_CHAVE   = Deno.env.get("FNRH_CHAVE")   ?? ""
const FNRH_BASE    = Deno.env.get("FNRH_BASE_URL") ?? "https://fnrh.turismo.serpro.gov.br/FNRH_API/rest/v1"

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

type SupabaseClient = ReturnType<typeof createClient>

type SubmitPayload = {
  booking_id?: string | null
  reservation_id?: string | null
  retry_failed?: boolean
  limit?: number
}

const SEX_MAP: Record<string, string> = {
  "Masculino": "M",
  "Feminino": "F",
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS })
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405)

  const authHeader = req.headers.get("Authorization") ?? ""
  const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  const isServiceRole = !!svcKey && authHeader === `Bearer ${svcKey}`

  const sbAdmin = createClient(
    Deno.env.get("SUPABASE_URL") as string,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") as string
  )

  let payload: SubmitPayload = {}
  try {
    payload = await req.json()
  } catch {
    payload = {}
  }

  if (payload.retry_failed) {
    if (!isServiceRole) return json({ error: "Unauthorized" }, 401)
    return retryFailedSubmissions(sbAdmin, payload.limit)
  }

  const reservationId = payload.booking_id ?? payload.reservation_id ?? null

  if (isServiceRole) {
    if (!reservationId) return json({ error: "booking_id is required for service submissions" }, 400)
    return submitOne(sbAdmin, { reservationId, callerUserId: null, isServiceRole: true })
  }

  const user = await getAuthenticatedUser(authHeader)
  if (!user) return json({ error: "Invalid session" }, 401)

  return submitOne(sbAdmin, { reservationId, callerUserId: user.id, isServiceRole: false })
})

async function getAuthenticatedUser(authHeader: string): Promise<{ id: string; email?: string } | null> {
  if (!authHeader) return null
  const token = authHeader.replace("Bearer ", "")
  if (!token) return null

  const sbUser = createClient(
    Deno.env.get("SUPABASE_URL") as string,
    Deno.env.get("SUPABASE_ANON_KEY") as string,
    { global: { headers: { Authorization: authHeader } } }
  )

  const { data: { user }, error } = await sbUser.auth.getUser(token)
  if (error || !user) return null
  return { id: user.id, email: user.email ?? undefined }
}

async function retryFailedSubmissions(sbAdmin: SupabaseClient, rawLimit: number | undefined): Promise<Response> {
  const limit = Math.max(1, Math.min(Number(rawLimit) || 25, 100))
  const retryBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString()

  const { data: reservations, error } = await sbAdmin
    .from("reservations")
    .select("id")
    .in("fnrh_status", ["pending", "failed"])
    .lt("fnrh_attempt_count", 8)
    .or(`fnrh_last_attempt_at.is.null,fnrh_last_attempt_at.lt.${retryBefore}`)
    .order("fnrh_last_attempt_at", { ascending: true, nullsFirst: true })
    .limit(limit)

  if (error) return json({ error: error.message }, 500)

  const results = []
  for (const reservation of reservations ?? []) {
    const result = await submitOneInternal(sbAdmin, {
      reservationId: reservation.id,
      callerUserId: null,
      isServiceRole: true,
    })
    results.push({ reservation_id: reservation.id, ok: result.ok, status: result.status, error: result.error ?? null })
  }

  return json({ ok: true, retried: results.length, results })
}

async function submitOne(
  sbAdmin: SupabaseClient,
  args: { reservationId: string | null; callerUserId: string | null; isServiceRole: boolean }
): Promise<Response> {
  const result = await submitOneInternal(sbAdmin, args)
  if (result.ok) return json({ ok: true, fnrh: result.responseBody ?? null })
  return json({ error: result.error, missing: result.missing, detail: result.responseBody }, result.httpStatus)
}

async function submitOneInternal(
  sbAdmin: SupabaseClient,
  args: { reservationId: string | null; callerUserId: string | null; isServiceRole: boolean }
): Promise<{ ok: boolean; status: "submitted" | "failed"; httpStatus: number; error?: string; missing?: string[]; responseBody?: unknown }> {
  let reservation: Record<string, any> | null = null
  let userId = args.callerUserId

  if (args.reservationId) {
    let query = sbAdmin
      .from("reservations")
      .select("id, user_id, check_in, check_out, room_type, room_name, purpose_of_visit, fnrh_attempt_count")
      .eq("id", args.reservationId)

    if (!args.isServiceRole && args.callerUserId) {
      query = query.eq("user_id", args.callerUserId)
    }

    const { data, error } = await query.maybeSingle()
    if (error || !data) {
      return { ok: false, status: "failed", httpStatus: 404, error: "Reserva não encontrada" }
    }

    reservation = data
    userId = data.user_id
  }

  if (!userId) {
    return { ok: false, status: "failed", httpStatus: 400, error: "Usuário não identificado" }
  }

  const { data: profile, error: profileErr } = await sbAdmin
    .from("profiles")
    .select(`
      full_name, email, cpf_cnpj, date_of_birth, sex, profession, nationality,
      phone, address_zip, address_street, address_number,
      address_city, address_state, address_country
    `)
    .eq("id", userId)
    .maybeSingle()

  if (profileErr || !profile) {
    await markReservationFailed(sbAdmin, reservation, userId, "Perfil não encontrado", 404)
    return { ok: false, status: "failed", httpStatus: 404, error: "Perfil não encontrado" }
  }

  const missing = requiredMissing(profile, reservation)
  if (missing.length) {
    const msg = "Campos obrigatórios incompletos na ficha"
    await markReservationFailed(sbAdmin, reservation, userId, `${msg}: ${missing.join(", ")}`, 422)
    return { ok: false, status: "failed", httpStatus: 422, error: msg, missing }
  }

  if (!FNRH_USUARIO || !FNRH_CHAVE) {
    const msg = "Credenciais FNRH não configuradas"
    await markReservationFailed(sbAdmin, reservation, userId, msg, 503)
    return { ok: false, status: "failed", httpStatus: 503, error: msg }
  }

  const fnrhPayload = buildFnrhPayload(profile, reservation, userId)
  await markReservationPending(sbAdmin, reservation, userId)

  let fnrhStatus = 0
  let fnrhBody: unknown = null

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

    if (!res.ok) {
      const errMsg = extractErrorMessage(fnrhBody) ?? `FNRH returned ${fnrhStatus}`
      await markReservationFailed(sbAdmin, reservation, userId, errMsg, fnrhStatus, fnrhBody, false)
      return {
        ok: false,
        status: "failed",
        httpStatus: fnrhStatus >= 500 ? 502 : 400,
        error: "A API da FNRH retornou um erro",
        responseBody: fnrhBody,
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await markReservationFailed(sbAdmin, reservation, userId, msg, 502, null, false)
    return { ok: false, status: "failed", httpStatus: 502, error: "Não foi possível contactar a API da FNRH" }
  }

  await markReservationSubmitted(sbAdmin, reservation, userId, fnrhStatus, fnrhBody)
  return { ok: true, status: "submitted", httpStatus: 200, responseBody: fnrhBody }
}

function requiredMissing(profile: Record<string, any>, reservation: Record<string, any> | null): string[] {
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

  if (reservation) {
    if (!reservation.check_in)         missing.push("check-in")
    if (!reservation.check_out)        missing.push("check-out")
    if (!reservation.room_name && !reservation.room_type) missing.push("tipo de unidade")
    if (!reservation.purpose_of_visit) missing.push("motivo da viagem")
  }

  return missing
}

function buildFnrhPayload(profile: Record<string, any>, reservation: Record<string, any> | null, userId: string) {
  const hospede = {
    nome:            profile.full_name,
    cpf:             profile.cpf_cnpj?.replace(/\D/g, "") || null,
    data_nascimento: profile.date_of_birth,
    sexo:            SEX_MAP[profile.sex] ?? "N",
    profissao:       profile.profession,
    nacionalidade:   profile.nationality,
    email:           profile.email ?? null,
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

  return {
    codigo_reserva: reservation?.id ?? userId,
    data_entrada:   reservation?.check_in  ?? null,
    data_saida:     reservation?.check_out ?? null,
    tipo_unidade:   reservation?.room_name ?? reservation?.room_type ?? null,
    hospedes:       [hospede],
  }
}

async function markReservationPending(sbAdmin: SupabaseClient, reservation: Record<string, any> | null, userId: string) {
  if (!reservation) return
  const attemptCount = Number(reservation.fnrh_attempt_count || 0) + 1
  const now = new Date().toISOString()
  await sbAdmin
    .from("reservations")
    .update({
      fnrh_status: "pending",
      fnrh_last_attempt_at: now,
      fnrh_attempt_count: attemptCount,
      fnrh_last_error: null,
    })
    .eq("id", reservation.id)

  await insertAttempt(sbAdmin, reservation.id, userId, "pending", null, null, null)
}

async function markReservationSubmitted(
  sbAdmin: SupabaseClient,
  reservation: Record<string, any> | null,
  userId: string,
  httpStatus: number,
  responseBody: unknown
) {
  if (!reservation) return
  const now = new Date().toISOString()
  await sbAdmin
    .from("reservations")
    .update({
      fnrh_status: "submitted",
      fnrh_submitted_at: now,
      fnrh_last_attempt_at: now,
      fnrh_last_error: null,
    })
    .eq("id", reservation.id)

  await insertAttempt(sbAdmin, reservation.id, userId, "submitted", httpStatus, null, responseBody)
}

async function markReservationFailed(
  sbAdmin: SupabaseClient,
  reservation: Record<string, any> | null,
  userId: string | null,
  errorMsg: string,
  httpStatus: number,
  responseBody: unknown = null,
  incrementAttempt = true
) {
  if (!reservation) return
  const now = new Date().toISOString()
  const attemptCount = Number(reservation.fnrh_attempt_count || 0)
  const update: Record<string, unknown> = {
    fnrh_status: "failed",
    fnrh_last_attempt_at: now,
    fnrh_last_error: errorMsg,
  }

  if (incrementAttempt) {
    update.fnrh_attempt_count = attemptCount + 1
  }

  await sbAdmin
    .from("reservations")
    .update(update)
    .eq("id", reservation.id)

  await insertAttempt(sbAdmin, reservation.id, userId, "failed", httpStatus, errorMsg, responseBody)
}

async function insertAttempt(
  sbAdmin: SupabaseClient,
  reservationId: string | null,
  userId: string | null,
  status: "pending" | "submitted" | "failed",
  httpStatus: number | null,
  errorMsg: string | null,
  responseBody: unknown
) {
  await sbAdmin
    .from("fnrh_submission_attempts")
    .insert({
      reservation_id: reservationId,
      user_id: userId,
      status,
      http_status: httpStatus,
      error_msg: errorMsg,
      response_body: safeJson(responseBody),
    })
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) console.warn("Could not insert FNRH attempt:", error.message)
    })
}

function fnrhAuthHeader(): string {
  return "Basic " + btoa(`${FNRH_USUARIO}:${FNRH_CHAVE}`)
}

function extractErrorMessage(body: unknown): string | null {
  if (!body) return null
  if (typeof body === "string") return body.slice(0, 500)
  if (typeof body === "object") {
    const record = body as Record<string, unknown>
    const value = record.error ?? record.message ?? record.detail ?? record.details
    if (typeof value === "string") return value.slice(0, 500)
  }
  return null
}

function safeJson(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === "string") return { text: value.slice(0, 2000) }
  return value
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  })
}
