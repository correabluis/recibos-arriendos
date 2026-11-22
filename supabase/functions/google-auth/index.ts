// Autoriza una sola vez al sistema para archivar PDF en el Drive de Luis.
// Flujo: ?iniciar=<estado de un solo uso> → Google → ?code&state → guarda el
// refresh token en Supabase Vault (nunca en tablas ni en el código).
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const REDIRECT = `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-auth`;
const SCOPES = "openid email https://www.googleapis.com/auth/drive";

// Las funciones de Supabase no muestran HTML: se redirige a una página del formulario.
function pagina(titulo: string, texto: string, ok = false, _status = 200) {
  const u = new URL("https://correabluis.github.io/recibos-arriendos/google.html");
  u.search = new URLSearchParams({ r: ok ? "ok" : "error", t: titulo, m: texto.replace(/<[^>]+>/g, "") }).toString();
  return Response.redirect(u.toString(), 302);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  try {
    if (!CLIENT_ID || !CLIENT_SECRET) return pagina("Falta configuración", "Aún no están los secretos GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Supabase.", false, 500);

    // Diagnóstico sin datos secretos: muestra el ID de cliente (público) y solo la forma del secreto.
    if (url.searchParams.has("diag")) {
      const vis = (x: string) => JSON.stringify(x);
      return pagina("Diagnóstico", `ID de cliente: ${vis(CLIENT_ID)} (largo ${CLIENT_ID.length}). Secreto: largo ${CLIENT_SECRET.length}, empieza por ${vis(CLIENT_SECRET.slice(0, 7))}, ${/\s/.test(CLIENT_SECRET) ? "TIENE espacios" : "sin espacios"}.`, true);
    }

    const iniciar = url.searchParams.get("iniciar");
    if (iniciar) {
      const [e] = await sql`select 1 from privado.oauth_estado where estado = ${iniciar} and expira > now()`;
      if (!e) return pagina("Enlace vencido", "Este enlace ya no sirve. Pide uno nuevo.", false, 400);
      const g = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      g.search = new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", scope: SCOPES,
        access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: iniciar,
      }).toString();
      return Response.redirect(g.toString(), 302);
    }

    const error = url.searchParams.get("error");
    if (error) return pagina("No se autorizó", `Google respondió: ${error}. No se guardó nada.`, false, 400);

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return pagina("Enlace incompleto", "Abre el enlace que te envió Claude.", false, 400);

    const [e] = await sql`delete from privado.oauth_estado where estado = ${state} and expira > now() returning estado`;
    if (!e) return pagina("Enlace vencido", "Este enlace ya se usó o venció. Pide uno nuevo.", false, 400);

    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: "authorization_code" }),
    });
    const t = await r.json();
    if (!r.ok || !t.refresh_token) return pagina("No se pudo completar", `Google no entregó el permiso permanente (${t.error ?? r.status}). Revisa que la app esté publicada y vuelve a intentar.`, false, 400);

    let email = "";
    try { email = JSON.parse(atob(t.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email ?? ""; } catch { /* sin correo */ }

    // Comprueba que esta cuenta sí ve las carpetas de recibos.
    const [raiz] = await sql`select drive_id from tesoreria.carpeta_ingresos_drive order by anio desc limit 1`;
    if (raiz) {
      const f = await fetch(`https://www.googleapis.com/drive/v3/files/${raiz.drive_id}?fields=id,name&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${t.access_token}` } });
      if (!f.ok) return pagina("Cuenta equivocada", `La cuenta ${email || "usada"} no tiene acceso a las carpetas de recibos. Entra con la cuenta dueña de tu Drive. No se guardó nada.`, false, 403);
    }

    await sql.begin(async (tx) => {
      const [s] = await tx`select id from vault.secrets where name = 'google_refresh_token'`;
      if (s) await tx`select vault.update_secret(${s.id}::uuid, ${t.refresh_token})`;
      else await tx`select vault.create_secret(${t.refresh_token}, 'google_refresh_token', 'Permiso de Google Drive para archivar recibos (google-auth)')`;
      await tx`insert into maestros.parametro_texto (clave, valor, observacion) values ('google_cuenta_drive', ${email}, 'Cuenta de Google que autorizó el archivo en línea de recibos en Drive')
               on conflict (clave) do update set valor = excluded.valor, updated_at = now()`;
    });

    return pagina("Listo", `Quedó autorizado con la cuenta <b>${email}</b>. Desde ahora cada recibo se archiva en Drive en el momento en que se emite. Puedes cerrar esta página.`, true);
  } catch (err) {
    console.error(err);
    return pagina("Error", "Algo falló. No se guardó nada. Avísale a Claude.", false, 500);
  }
});
