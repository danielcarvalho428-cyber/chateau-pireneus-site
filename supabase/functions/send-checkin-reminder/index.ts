import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") as string
const FROM_EMAIL = Deno.env.get("EMAIL_FROM") ?? "reservas@chateaupireneus.com.br"
const SITE_URL = "https://chateaupireneus.com.br"

Deno.serve(async (req) => {
  // Allow GET for cron invocation, POST for manual triggers
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 })
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") as string,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") as string
  )

  const tomorrow = new Date()
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  const tomorrowStr = tomorrow.toISOString().slice(0, 10)

  const { data: reservations, error } = await sb
    .from("reservations")
    .select("*, profiles!left(full_name, email)")
    .eq("check_in", tomorrowStr)
    .in("payment_status", ["paid", "confirmed"])

  if (error) {
    console.error("DB fetch error:", error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }

  if (!reservations || reservations.length === 0) {
    console.log("No check-ins tomorrow:", tomorrowStr)
    return new Response(JSON.stringify({ ok: true, sent: 0 }), { status: 200 })
  }

  let sent = 0
  let failed = 0

  for (const res of reservations) {
    const guestName: string = res.profiles?.full_name ?? "Hóspede"
    const guestEmail: string = res.profiles?.email ?? ""

    if (!guestEmail) {
      console.warn("No email for reservation:", res.id)
      failed++
      continue
    }

    const checkIn  = formatDate(res.check_in)
    const checkOut = formatDate(res.check_out)
    const nights   = daysBetween(res.check_in, res.check_out)
    const roomName = res.room_name ?? res.room_id ?? "Suíte"

    const html = buildReminderEmail({ guestName, checkIn, checkOut, nights, roomName })

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `Château Pireneus <${FROM_EMAIL}>`,
        to: [guestEmail],
        subject: `Seu check-in é amanhã — Château Pireneus`,
        html,
      }),
    })

    if (resendRes.ok) {
      sent++
      console.log("Reminder sent to:", guestEmail)
    } else {
      failed++
      console.error("Resend error for", guestEmail, await resendRes.text())
    }
  }

  return new Response(JSON.stringify({ ok: true, sent, failed, date: tomorrowStr }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
})

function formatDate(iso: string): string {
  if (!iso) return ""
  const [y, m, d] = iso.split("-")
  return `${d}/${m}/${y}`
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000)
}

function buildReminderEmail(p: {
  guestName: string
  checkIn: string
  checkOut: string
  nights: number
  roomName: string
}): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Check-in Amanhã</title>
  <style>
    body{margin:0;padding:0;background:#f5f0e8;font-family:'Georgia',serif;}
    .wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);}
    .header{background:#1d3557;padding:36px 40px 28px;text-align:center;}
    .header h1{margin:0;color:#d8c7a1;font-size:22px;letter-spacing:2px;font-weight:normal;text-transform:uppercase;}
    .header p{margin:6px 0 0;color:rgba(255,255,255,.65);font-size:13px;letter-spacing:1px;}
    .badge{display:inline-block;background:#d8c7a1;color:#1d3557;border-radius:20px;padding:6px 20px;font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;margin:20px 0 0;}
    .body{padding:36px 40px;}
    .greeting{font-size:18px;color:#1d3557;margin:0 0 8px;}
    .subtitle{font-size:14px;color:#666;margin:0 0 28px;line-height:1.6;}
    .card{background:#f5f0e8;border-radius:10px;padding:24px 28px;margin:0 0 24px;}
    .card-title{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1.5px;margin:0 0 16px;}
    .detail-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(29,53,87,.08);}
    .detail-row:last-child{border-bottom:none;}
    .detail-label{font-size:13px;color:#666;}
    .detail-value{font-size:13px;color:#1d3557;font-weight:bold;text-align:right;}
    .info-box{border-left:3px solid #d8c7a1;padding:16px 20px;margin:0 0 24px;background:#fffdf8;}
    .info-box p{margin:0 0 6px;font-size:13px;color:#555;line-height:1.6;}
    .info-box p:last-child{margin:0;}
    .info-box strong{color:#1d3557;}
    .cta{text-align:center;margin:28px 0;}
    .cta a{background:#1d3557;color:#d8c7a1;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:14px;letter-spacing:.5px;display:inline-block;}
    .footer{background:#1d3557;padding:24px 40px;text-align:center;}
    .footer p{margin:4px 0;color:rgba(255,255,255,.55);font-size:12px;line-height:1.7;}
    .footer a{color:#d8c7a1;text-decoration:none;}
    @media(max-width:600px){
      .body,.header,.footer{padding:24px 20px;}
      .card{padding:18px 16px;}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <h1>Château Pireneus</h1>
      <p>Pousada de Charme · Pirenópolis, GO</p>
      <div class="badge">📅 Check-in Amanhã</div>
    </div>

    <div class="body">
      <p class="greeting">Olá, ${p.guestName}!</p>
      <p class="subtitle">Seu check-in é <strong>amanhã, ${p.checkIn}</strong>. Estamos preparando tudo com carinho para recebê-lo no Château Pireneus.</p>

      <div class="card">
        <div class="card-title">Resumo da sua estadia</div>
        <div class="detail-row">
          <span class="detail-label">Acomodação</span>
          <span class="detail-value">${p.roomName}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Check-in</span>
          <span class="detail-value">${p.checkIn} a partir das 14h</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Check-out</span>
          <span class="detail-value">${p.checkOut} até as 12h</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Duração</span>
          <span class="detail-value">${p.nights} ${p.nights === 1 ? "noite" : "noites"}</span>
        </div>
      </div>

      <div class="info-box">
        <p><strong>Endereço:</strong> Rua Tupinambás, Quadra 09, Lote 16 — Pirenópolis, GO</p>
        <p><strong>WhatsApp:</strong> <a href="https://wa.me/5562998167654" style="color:#1d3557;">(62) 99816-7654</a></p>
        <p>Em caso de dúvidas sobre como chegar ou qualquer outro detalhe, fique à vontade para nos chamar!</p>
      </div>

      <div class="cta">
        <a href="https://wa.me/5562998167654?text=Olá!+Farei+check-in+amanhã.+Poderia+me+passar+as+instruções+de+chegada%3F">Falar pelo WhatsApp</a>
      </div>

      <p style="font-size:13px;color:#888;line-height:1.7;margin:0;">
        Mal podemos esperar para recebê-lo. Até amanhã!
      </p>
    </div>

    <div class="footer">
      <p><strong style="color:#d8c7a1;">Château Pireneus</strong></p>
      <p>Pirenópolis, Goiás · Brasil</p>
      <p><a href="${SITE_URL}/privacidade.html">Política de Privacidade</a></p>
    </div>
  </div>
</body>
</html>`
}
