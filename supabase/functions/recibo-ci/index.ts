// Función «recibo-ci»: genera el PDF del comprobante de ingreso en el momento
// de emitirlo, lo guarda en el almacenamiento privado «recibos» y lo envía por
// WhatsApp (Bird). Solo código: los datos salen de la base.
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.4";
import { Buffer } from "node:buffer";
import { generarPdf, puntos } from "./pdf.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w .,$-]/g, "").trim();
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MES3 = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function celularE164(v?: string | null): string | null {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length === 10 && d.startsWith("3")) return "+57" + d;
  if (d.length === 12 && d.startsWith("573")) return "+" + d;
  return null;
}

function periodoTexto(g: { desde: string; hasta: string }): string {
  const [ay, am, ad] = g.desde.split("-").map(Number);
  const [by, bm, bd] = g.hasta.split("-").map(Number);
  const finMes = new Date(Date.UTC(by, bm, 0)).getUTCDate() === bd;
  if (ad === 1 && finMes && am === bm && ay === by) return `${MESES[am - 1]} de ${ay}`;
  return `${ad} ${MES3[am - 1]} al ${bd} ${MES3[bm - 1]} ${by}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u, error: eu } = await sb.auth.getUser(token);
    if (eu || !u?.user) return json({ error: "Sesión no válida" }, 401);
    const uid = u.user.id;
    const body = await req.json().catch(() => ({}));
    const id = Number(body.id);
    if (!id) return json({ error: "Falta el id del comprobante" }, 400);

    const [usr] = await sql`select rol, tercero_id from maestros.usuario where user_id = ${uid} and activo`;
    const [c] = await sql`select id, creado_por, tercero_id, es_prueba, estado from tesoreria.comprobante where id = ${id} and tipo = 'CI'`;
    if (!usr || !c) return json({ error: "Comprobante no disponible" }, 404);
    if (usr.rol !== "admin" && c.creado_por !== uid) return json({ error: "Sin permiso sobre este comprobante" }, 403);

    const [{ d }] = await sql`select tesoreria.fn_datos_recibo(${id}) as d`;
    const [logo] = await sql`select logo, logo_mime from maestros.entidad_propia where codigo = ${d.titular.codigo}`;
    const bytes = await generarPdf(d, logo?.logo ? { bytes: new Uint8Array(logo.logo), mime: logo.logo_mime || "image/jpeg" } : null);
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map((b) => b.toString(16).padStart(2, "0")).join("");

    const fp = String(d.fecha_pago);
    const total = (d.lineas || []).reduce((s: number, l: { valor: number }) => s + Number(l.valor), 0);
    const anulado = d.estado === "anulado";
    const nombreArchivo = `${fp.replace(/-/g, "")} ${sinTildes(d.pagador.nombre)} $${puntos(total)} ${d.codigo}${anulado ? " ANULADO" : ""}.pdf`;
    const ruta = `${d.titular.codigo}/${fp.slice(0, 7)}/${d.codigo}${anulado ? "-ANULADO" : ""}.pdf`;
    const up = await sb.storage.from("recibos").upload(ruta, bytes, { contentType: "application/pdf", upsert: true });
    if (up.error) return json({ error: "No se pudo guardar el PDF: " + up.error.message }, 500);
    if (!anulado) await sql`update tesoreria.comprobante set pdf_storage_path = ${ruta}, pdf_sha256 = ${sha} where id = ${id} and pdf_sha256 is null`;
    // Cola de archivo en Drive (la tarea programada la sube y la borra)
    await sql`insert into tesoreria.comprobante_archivo_pendiente (comprobante_id, anulado, nombre, pdf)
      select ${id}, ${anulado}, ${nombreArchivo}, ${Buffer.from(bytes)}
      where not exists (select 1 from tesoreria.comprobante_archivo a where a.comprobante_id = ${id} and a.anulado = ${anulado})
      on conflict (comprobante_id, anulado) do update set nombre = excluded.nombre, pdf = excluded.pdf, created_at = now()`;
    const { data: firmado } = await sb.storage.from("recibos").createSignedUrl(ruta, 7 * 24 * 3600, { download: nombreArchivo });
    const url = firmado?.signedUrl;

    // ---- WhatsApp ----
    let envio: Record<string, unknown> = { estado: "no_enviado" };
    const yaEnviado = (await sql`select 1 from tesoreria.comprobante_envio where comprobante_id = ${id} and mensaje_id is not null limit 1`).length > 0;
    // Contratos administrados por agencia: no se le escribe al arrendatario (regla única en privado.fn_comunicar_arrendatario)
    const conAdministrador = !c.es_prueba && d.contrato?.id &&
      !(await sql`select privado.fn_comunicar_arrendatario(${d.contrato.id}) as ok`)[0].ok;
    if (anulado) envio = { estado: "no_aplica", motivo: "comprobante anulado" };
    else if (conAdministrador) envio = { estado: "no_aplica", motivo: "inmueble administrado por un tercero: no se le escribe al arrendatario" };
    else if (body.soloPdf) envio = { estado: "omitido" };
    else if (yaEnviado && !(body.reenviar && usr.rol === "admin")) envio = { estado: "ya_enviado" };
    else {
      const destId = c.es_prueba ? usr.tercero_id : c.tercero_id;
      const [dest] = await sql`select t.id, t.tipo_persona, t.primer_nombre, t.nombre_mostrar,
          (select valor from maestros.tercero_contacto k where k.tercero_id = t.id and k.vigente and k.tipo = 'celular'
            order by k.para_whatsapp desc, k.principal desc, k.id limit 1) as celular
        from maestros.tercero t where t.id = ${destId}`;
      const para = celularE164(dest?.celular);
      const key = Deno.env.get("BIRD_API_KEY");
      const params = Object.fromEntries((await sql`select clave, valor from maestros.parametro_texto where clave in ('whatsapp_remitente','plantilla_ci','bird_region')`).map((r) => [r.clave, r.valor]));
      let error: string | null = null, mensajeId: string | null = null;
      if (!para) error = "El destinatario no tiene celular válido en Terceros";
      else if (!key) error = "Falta la llave de Bird (BIRD_API_KEY) en Supabase";
      else if (!url) error = "No se pudo crear el enlace del PDF";
      else {
        const nombre = dest.tipo_persona === "juridica" ? dest.nombre_mostrar : (dest.primer_nombre || dest.nombre_mostrar).toLowerCase().replace(/^./, (x: string) => x.toUpperCase());
        const inm = (d.lineas?.[0]?.inmueble) || (d.contrato?.inmuebles || [])[0];
        const cubre = d.cobertura?.cubre || [];
        let concepto = "canon de arrendamiento" + (inm ? ` del Inmueble ${inm.direccion}, Medellín` : "");
        if (cubre.length) concepto += `, periodo ${cubre.map(periodoTexto).join(" y ")}`;
        if (c.es_prueba) concepto = "PRUEBA (no válido): " + concepto;
        const region = String(key).match(/^b[km]_(\w+?)_/)?.[1] || params.bird_region || "us1";
        const r = await fetch(`https://${region}.platform.bird.com/v1/whatsapp/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `ci/${id}${body.reenviar ? "/" + Date.now() : ""}` },
          body: JSON.stringify({
            from: params.whatsapp_remitente, to: para, reference: d.codigo,
            tags: [{ name: "tipo", value: "comprobante_ingreso" }],
            template: { slug: params.plantilla_ci, language: "es", parameters: {
              header_url: url, header_filename: nombreArchivo, nombre, numero: d.codigo,
              valor: `${puntos(total)} COP`, concepto, sociedad: d.titular.nombre } },
          }),
        });
        const res = await r.json().catch(() => ({}));
        if (r.ok) mensajeId = res.id || res.message_id || "aceptado";
        else error = `Bird ${r.status}: ${(res?.detail || res?.message || res?.title || JSON.stringify(res)).toString().slice(0, 300)}`;
      }
      await sql`insert into tesoreria.comprobante_envio (comprobante_id, para_tercero_id, para_ultimos4, enviado_en, mensaje_id, error, es_prueba)
        values (${id}, ${dest?.id ?? null}, ${para ? para.slice(-4) : null}, ${mensajeId ? new Date() : null}, ${mensajeId}, ${error}, ${c.es_prueba})`;
      envio = mensajeId ? { estado: "enviado", para: "****" + para!.slice(-4), a: c.es_prueba ? "quien emitió (prueba)" : "arrendatario" } : { estado: "error", error };
    }
    return json({ ok: true, codigo: d.codigo, url, archivo: nombreArchivo, envio });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
