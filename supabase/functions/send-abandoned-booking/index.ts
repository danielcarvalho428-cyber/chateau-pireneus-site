import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") as string
const FROM_EMAIL     = Deno.env.get("EMAIL_FROM") ?? "reservas@chateaupireneus.com.br"
const SITE_URL       = "https://chateaupireneus.com.br"

function isInternalRequest(req: Request): boolean {
  const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  return req.headers.get("Authorization") === `Bearer ${svcKey}`
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 })
  }
  if (!isInternalRequest(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") as string,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") as string
  )

  // Reservations that have been pending for at least 2 hours,
  // hold has not expired yet, and reminder has not been sent yet.
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const now    = new Date().toISOString()

  const { data: reservations, error } = await sb
    .from("reservations")
    .select("*, profiles!left(full_name, email)")
    .in("payment_status", ["pending", "held", "hold"])
    .lt("created_at", cutoff)
    .gt("expires_at", now)
    .is("abandoned_email_sent_at", null)

  if (error) {
    console.error("DB fetch error:", error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }

  if (!reservations || reservations.length === 0) {
    return new Response(JSON.stringify({ ok: true, sent: 0 }), { status: 200 })
  }

  let sent = 0
  let failed = 0

  for (const res of reservations) {
    const guestName:  string = res.profiles?.full_name ?? "Hóspede"
    const guestEmail: string = res.profiles?.email ?? ""

    if (!guestEmail) {
      console.warn("No email for reservation:", res.id)
      // Mark as sent anyway so we don't keep trying
      await sb.from("reservations")
        .update({ abandoned_email_sent_at: new Date().toISOString() })
        .eq("id", res.id)
      failed++
      continue
    }

    const expiresAt  = res.expires_at ? new Date(res.expires_at) : null
    const roomName   = res.room_name ?? res.room_id ?? "Suíte"
    const checkIn    = formatDate(res.check_in)
    const checkOut   = formatDate(res.check_out)
    const resumeUrl  = `${SITE_URL}/booking-success.html?reservation_id=${res.id}`

    const html = buildAbandonedEmail({ guestName, roomName, checkIn, checkOut, expiresAt, resumeUrl })

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        from:    `Château Pireneus <${FROM_EMAIL}>`,
        to:      [guestEmail],
        subject: "Sua reserva no Château Pireneus ainda está esperando por você",
        html,
      }),
    })

    // Mark as sent regardless of Resend result to avoid spam on transient failures
    await sb.from("reservations")
      .update({ abandoned_email_sent_at: new Date().toISOString() })
      .eq("id", res.id)

    if (resendRes.ok) {
      sent++
      console.log("Abandoned email sent to:", guestEmail)
    } else {
      failed++
      console.error("Resend error for", guestEmail, await resendRes.text())
    }
  }

  return new Response(JSON.stringify({ ok: true, sent, failed }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
})

function formatDate(iso: string | null): string {
  if (!iso) return ""
  const [y, m, d] = iso.split("-")
  return `${d}/${m}/${y}`
}

function buildAbandonedEmail(p: {
  guestName:  string
  roomName:   string
  checkIn:    string
  checkOut:   string
  expiresAt:  Date | null
  resumeUrl:  string
}): string {
  const expiryLine = p.expiresAt
    ? `<p class="subtitle">Sua reserva ainda está reservada até <strong>${p.expiresAt.toLocaleString("pt-BR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" })}</strong>. Após esse prazo ela será liberada automaticamente.</p>`
    : `<p class="subtitle">Sua reserva ainda está disponível por tempo limitado. Conclua o pagamento para garantir sua vaga.</p>`

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sua reserva está esperando</title>
  <style>
    body{margin:0;padding:0;background:#f5f0e8;font-family:'Georgia',serif;}
    .wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);}
    .header{background:#1d3557;padding:36px 40px 28px;text-align:center;}
    .header h1{margin:0;color:#d8c7a1;font-size:22px;letter-spacing:2px;font-weight:normal;text-transform:uppercase;}
    .header p{margin:6px 0 0;color:rgba(255,255,255,.65);font-size:13px;letter-spacing:1px;}
    .badge{display:inline-block;background:#d8c7a1;color:#1d3557;border-radius:20px;padding:6px 20px;font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;margin:20px 0 0;}
    .body{padding:36px 40px;}
    .greeting{font-size:18px;color:#1d3557;margin:0 0 8px;}
    .subtitle{font-size:14px;color:#666;margin:0 0 24px;line-height:1.6;}
    .card{background:#f5f0e8;border-radius:10px;padding:24px 28px;margin:0 0 24px;}
    .card-title{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1.5px;margin:0 0 16px;}
    .detail-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(29,53,87,.08);}
    .detail-row:last-child{border-bottom:none;}
    .detail-label{font-size:13px;color:#666;}
    .detail-value{font-size:13px;color:#1d3557;font-weight:bold;text-align:right;}
    .cta{text-align:center;margin:28px 0;}
    .cta a{background:#1d3557;color:#d8c7a1;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:14px;letter-spacing:.5px;display:inline-block;}
    .footer{background:#1d3557;padding:24px 40px;text-align:center;}
    .footer p{margin:4px 0;color:rgba(255,255,255,.55);font-size:12px;line-height:1.7;}
    .footer a{color:#d8c7a1;text-decoration:none;}
    @media(max-width:600px){.body,.header,.footer{padding:24px 20px;}.card{padding:18px 16px;}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <h1>Château Pireneus</h1>
      <p>Pousada de Charme · Pirenópolis, GO</p>
      <div class="badge">⏳ Reserva aguardando pagamento</div>
    </div>
    <div class="body">
      <p class="greeting">Olá, ${p.guestName}!</p>
      <p class="subtitle">Percebemos que você iniciou uma reserva no Château Pireneus, mas o pagamento ainda não foi concluído.</p>
      ${expiryLine}
      <div class="card">
        <div class="card-title">Detalhes da reserva</div>
        <div class="detail-row">
          <span class="detail-label">Acomodação</span>
          <span class="detail-value">${p.roomName}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Check-in</span>
          <span class="detail-value">${p.checkIn}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Check-out</span>
          <span class="detail-value">${p.checkOut}</span>
        </div>
      </div>
      <div class="cta">
        <a href="${p.resumeUrl}">Concluir pagamento</a>
      </div>
      <p style="font-size:13px;color:#888;line-height:1.7;margin:0;">
        Se tiver qualquer dúvida, fale conosco pelo
        <a href="https://wa.me/5562998167654" style="color:#1d3557;">WhatsApp (62) 99816-7654</a>.
      </p>
    </div>
    <div class="footer">
      <p><strong style="color:#d8c7a1;">Château Pireneus</strong></p>
      <p>Pirenópolis, Goiás · Brasil</p>
      <p><a href="https://chateaupireneus.com.br/privacidade.html">Política de Privacidade</a></p>
    </div>
  </div>
</body>
</html>`
}
