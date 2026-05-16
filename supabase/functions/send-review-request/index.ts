import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") as string
const FROM_EMAIL     = Deno.env.get("EMAIL_FROM") ?? "reservas@chateaupireneus.com.br"
// Set GOOGLE_REVIEW_URL in Supabase secrets to your Google Maps review link.
// e.g. https://g.page/r/YOUR_PLACE_ID/review
const GOOGLE_REVIEW_URL = Deno.env.get("GOOGLE_REVIEW_URL") ?? "https://g.page/r/CQpHvSHbimQREAE/review"

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 })
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") as string,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") as string
  )

  // Find paid reservations whose check_out was yesterday and haven't received a review request yet.
  const yesterday = new Date()
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)
  const yesterdayStr = yesterday.toISOString().slice(0, 10)

  const { data: reservations, error } = await sb
    .from("reservations")
    .select("*, profiles(full_name, email)")
    .eq("check_out", yesterdayStr)
    .in("payment_status", ["paid", "confirmed"])
    .is("review_email_sent_at", null)

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

    // Mark as processed first to avoid re-sending even if email fails
    await sb.from("reservations")
      .update({ review_email_sent_at: new Date().toISOString() })
      .eq("id", res.id)

    if (!guestEmail) {
      console.warn("No email for reservation:", res.id)
      failed++
      continue
    }

    const roomName = res.room_name ?? res.room_id ?? "Suíte"
    const checkIn  = formatDate(res.check_in)
    const checkOut = formatDate(res.check_out)
    const html     = buildReviewEmail({ guestName, roomName, checkIn, checkOut })

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        from:    `Château Pireneus <${FROM_EMAIL}>`,
        to:      [guestEmail],
        subject: `Como foi sua estadia no Château Pireneus, ${guestName.split(" ")[0]}?`,
        html,
      }),
    })

    if (resendRes.ok) {
      sent++
      console.log("Review request sent to:", guestEmail)
    } else {
      failed++
      console.error("Resend error for", guestEmail, await resendRes.text())
    }
  }

  return new Response(JSON.stringify({ ok: true, sent, failed, date: yesterdayStr }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
})

function formatDate(iso: string | null): string {
  if (!iso) return ""
  const [y, m, d] = iso.split("-")
  return `${d}/${m}/${y}`
}

function buildReviewEmail(p: {
  guestName: string
  roomName:  string
  checkIn:   string
  checkOut:  string
}): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Como foi sua estadia?</title>
  <style>
    body{margin:0;padding:0;background:#f5f0e8;font-family:'Georgia',serif;}
    .wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);}
    .header{background:#1d3557;padding:36px 40px 28px;text-align:center;}
    .header h1{margin:0;color:#d8c7a1;font-size:22px;letter-spacing:2px;font-weight:normal;text-transform:uppercase;}
    .header p{margin:6px 0 0;color:rgba(255,255,255,.65);font-size:13px;letter-spacing:1px;}
    .badge{display:inline-block;background:#d8c7a1;color:#1d3557;border-radius:20px;padding:6px 20px;font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;margin:20px 0 0;}
    .body{padding:36px 40px;}
    .greeting{font-size:18px;color:#1d3557;margin:0 0 12px;}
    .text{font-size:14px;color:#555;margin:0 0 20px;line-height:1.7;}
    .stars{text-align:center;font-size:28px;margin:0 0 24px;letter-spacing:4px;}
    .cta{text-align:center;margin:28px 0;}
    .cta a{background:#1d3557;color:#d8c7a1;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:14px;letter-spacing:.5px;display:inline-block;}
    .divider{border:none;border-top:1px solid rgba(29,53,87,.08);margin:24px 0;}
    .footer{background:#1d3557;padding:24px 40px;text-align:center;}
    .footer p{margin:4px 0;color:rgba(255,255,255,.55);font-size:12px;line-height:1.7;}
    .footer a{color:#d8c7a1;text-decoration:none;}
    @media(max-width:600px){.body,.header,.footer{padding:24px 20px;}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <h1>Château Pireneus</h1>
      <p>Pousada de Charme · Pirenópolis, GO</p>
      <div class="badge">✨ Obrigado pela sua visita</div>
    </div>
    <div class="body">
      <p class="greeting">Olá, ${p.guestName.split(" ")[0]}!</p>
      <p class="text">
        Foi um prazer enorme recebê-lo(a) no Château Pireneus. Esperamos que sua estadia na <strong>${p.roomName}</strong>
        (${p.checkIn} – ${p.checkOut}) tenha sido relaxante e especial.
      </p>
      <p class="text">
        Se puder dedicar um minutinho, sua avaliação no Google faz uma diferença enorme para nós
        e ajuda outros viajantes a descobrirem o Château. 🙏
      </p>

      <div class="stars">⭐⭐⭐⭐⭐</div>

      <div class="cta">
        <a href="${GOOGLE_REVIEW_URL}">Deixar avaliação no Google</a>
      </div>

      <hr class="divider">

      <p class="text" style="font-size:13px;color:#888;">
        Se algo não saiu como esperado durante sua estadia, gostaríamos de saber antes de tudo.
        Fale conosco diretamente pelo
        <a href="https://wa.me/5562998167654" style="color:#1d3557;">WhatsApp (62) 99816-7654</a>
        — estamos sempre aqui para melhorar.
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
