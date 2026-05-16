import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") as string
const FROM_EMAIL = Deno.env.get("EMAIL_FROM") ?? "reservas@chateaupireneus.com.br"

interface Payload {
  reservation_id: string
  to_email: string
  subject: string
  body: string
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() })
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405)
  }

  // Verify caller is an admin
  const authHeader = req.headers.get("Authorization") ?? ""
  const token = authHeader.replace("Bearer ", "")

  const sbUser = createClient(
    Deno.env.get("SUPABASE_URL") as string,
    Deno.env.get("SUPABASE_ANON_KEY") as string,
    { global: { headers: { Authorization: authHeader } } }
  )

  const { data: { user }, error: authErr } = await sbUser.auth.getUser(token)
  if (authErr || !user) return json({ error: "Unauthorized" }, 401)

  const { data: isAdmin, error: adminErr } = await sbUser.rpc("is_current_user_admin")
  if (adminErr || isAdmin !== true) return json({ error: "Forbidden" }, 403)

  let payload: Payload
  try {
    payload = await req.json()
  } catch {
    return json({ error: "Invalid JSON" }, 400)
  }

  const { reservation_id, to_email, subject, body } = payload
  if (!to_email || !subject || !body) {
    return json({ error: "to_email, subject, and body are required" }, 400)
  }

  // Sanitize: plain text body wrapped in minimal HTML
  const htmlBody = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:'Georgia',serif;">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);">
    <div style="background:#1d3557;padding:28px 40px;text-align:center;">
      <h1 style="margin:0;color:#d8c7a1;font-size:20px;letter-spacing:2px;font-weight:normal;text-transform:uppercase;">Château Pireneus</h1>
      <p style="margin:6px 0 0;color:rgba(255,255,255,.65);font-size:13px;letter-spacing:1px;">Pousada de Charme · Pirenópolis, GO</p>
    </div>
    <div style="padding:36px 40px;">
      <div style="font-size:15px;color:#333;line-height:1.75;white-space:pre-wrap;">${escapeHtml(body)}</div>
      <hr style="margin:28px 0;border:none;border-top:1px solid rgba(29,53,87,.08);">
      <p style="font-size:13px;color:#888;margin:0;">
        Dúvidas? Fale conosco pelo
        <a href="https://wa.me/5562998167654" style="color:#1d3557;">WhatsApp (62) 99816-7654</a>.
      </p>
    </div>
    <div style="background:#1d3557;padding:20px 40px;text-align:center;">
      <p style="margin:0;color:rgba(255,255,255,.55);font-size:12px;">Château Pireneus · Pirenópolis, Goiás · Brasil</p>
    </div>
  </div>
</body>
</html>`

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `Château Pireneus <${FROM_EMAIL}>`,
      to: [to_email],
      subject,
      html: htmlBody,
    }),
  })

  if (!resendRes.ok) {
    const errText = await resendRes.text()
    console.error("Resend error:", errText)
    return json({ error: "Falha ao enviar email", detail: errText }, 502)
  }

  const result = await resendRes.json()
  console.log("Admin message sent:", result.id, "→", to_email, "re:", reservation_id)
  return json({ ok: true, email_id: result.id })
})

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
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
