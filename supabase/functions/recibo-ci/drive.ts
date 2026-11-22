// Archivo en línea de PDF en Google Drive (permiso de Luis guardado en Vault por «google-auth»).
// Si algo falla, la fila queda en tesoreria.comprobante_archivo_pendiente y la
// tarea horaria «Archivar recibos en Drive» la sube después (respaldo).
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const FOLDER = "application/vnd.google-apps.folder";
const API = "https://www.googleapis.com/drive/v3/files";

let cache: { token: string; vence: number } | null = null;

async function accessToken(sql: any): Promise<string | null> {
  if (cache && cache.vence > Date.now() + 60_000) return cache.token;
  const [s] = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'google_refresh_token'`;
  if (!s) return null; // aún no autorizado: queda para la tarea horaria
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "", client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
      refresh_token: s.decrypted_secret, grant_type: "refresh_token",
    }),
  });
  const t = await r.json();
  if (!r.ok) throw new Error(`token Google: ${t.error ?? r.status}`);
  cache = { token: t.access_token, vence: Date.now() + (t.expires_in ?? 3000) * 1000 };
  return cache.token;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function buscar(tk: string, padre: string, nombre: string, carpeta: boolean) {
  const q = `'${padre}' in parents and name = '${esc(nombre)}' and trashed = false and mimeType ${carpeta ? "=" : "!="} '${FOLDER}'`;
  const r = await fetch(`${API}?q=${encodeURIComponent(q)}&fields=files(id,name,size)&supportsAllDrives=true&includeItemsFromAllDrives=true`, { headers: { Authorization: `Bearer ${tk}` } });
  if (!r.ok) throw new Error(`buscar ${nombre}: ${r.status}`);
  return (await r.json()).files as { id: string; name: string; size?: string }[];
}

async function carpeta(tk: string, padre: string, nombre: string, crear: boolean): Promise<string | null> {
  const f = await buscar(tk, padre, nombre, true);
  if (f.length) return f[0].id;
  if (!crear) return null;
  const r = await fetch(`${API}?supportsAllDrives=true&fields=id`, {
    method: "POST", headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: nombre, mimeType: FOLDER, parents: [padre] }),
  });
  if (!r.ok) throw new Error(`crear carpeta ${nombre}: ${r.status}`);
  return (await r.json()).id;
}

async function subir(tk: string, padre: string, nombre: string, pdf: Uint8Array) {
  const limite = "lim" + crypto.randomUUID();
  const meta = JSON.stringify({ name: nombre, parents: [padre], mimeType: "application/pdf" });
  const enc = new TextEncoder();
  const cab = enc.encode(`--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${limite}\r\nContent-Type: application/pdf\r\n\r\n`);
  const pie = enc.encode(`\r\n--${limite}--`);
  const body = new Uint8Array(cab.length + pdf.length + pie.length);
  body.set(cab); body.set(pdf, cab.length); body.set(pie, cab.length + pdf.length);
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,size", {
    method: "POST", headers: { Authorization: `Bearer ${tk}`, "Content-Type": `multipart/related; boundary=${limite}` }, body,
  });
  if (!r.ok) throw new Error(`subir ${nombre}: ${r.status} ${await r.text()}`);
  return await r.json() as { id: string; size: string };
}

async function papelera(tk: string, id: string) {
  const r = await fetch(`${API}/${id}?supportsAllDrives=true`, {
    method: "PATCH", headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }),
  });
  if (!r.ok) throw new Error(`papelera ${id}: ${r.status}`);
}

/** Sube a Drive el PDF que está en la cola para (comprobante, anulado). Devuelve el id de Drive o null si quedó para la tarea. */
export async function archivarEnDrive(sql: any, comprobanteId: number, anulado: boolean): Promise<string | null> {
  try {
    const tk = await accessToken(sql);
    if (!tk) return null;
    const [f] = await sql`select p.nombre, p.pdf, v.codigo, v.titular, v.fecha_pago, v.es_prueba
      from tesoreria.comprobante_archivo_pendiente p join tesoreria.v_comprobante v on v.id = p.comprobante_id
      where p.comprobante_id = ${comprobanteId} and p.anulado = ${anulado}`;
    if (!f) return null;
    const pdf = new Uint8Array(f.pdf);

    let destino: string | null;
    if (f.es_prueba) {
      const [c] = await sql`select valor from maestros.parametro_texto where clave = 'drive_carpeta_pruebas_ci'`;
      destino = c?.valor ?? null;
    } else {
      const fecha = new Date(f.fecha_pago);
      const anio = fecha.getUTCFullYear(), mes = fecha.getUTCMonth();
      const [raiz] = await sql`select c.drive_id from tesoreria.carpeta_ingresos_drive c join maestros.entidad_propia e on e.id = c.entidad_propia_id
        where e.codigo = ${f.titular} and c.anio = ${anio}`;
      if (!raiz) throw new Error(`falta la carpeta raíz de ${f.titular} ${anio} en tesoreria.carpeta_ingresos_drive`);
      const nombreMes = `${String(mes + 1).padStart(2, "0")}. Facturas de venta y comprobantes ${MESES[mes]}`;
      const existia = await carpeta(tk, raiz.drive_id, nombreMes, false);
      const idMes = existia ?? await carpeta(tk, raiz.drive_id, nombreMes, true);
      if (!existia) await carpeta(tk, idMes!, "1. Facturas de venta", true);
      destino = await carpeta(tk, idMes!, "2. Comprobantes de ingreso", true);
    }
    if (!destino) throw new Error("sin carpeta de destino");

    // Si ya está (reintento), no duplicar.
    const ya = (await buscar(tk, destino, f.nombre, false)).find((x) => Number(x.size) === pdf.length);
    const subido = ya ?? await subir(tk, destino, f.nombre, pdf);
    if (Number(subido.size) !== pdf.length) { await papelera(tk, subido.id); throw new Error(`tamaño distinto al subir ${f.nombre}`); }

    if (anulado) {
      const [orig] = await sql`select drive_id from tesoreria.comprobante_archivo where comprobante_id = ${comprobanteId} and not anulado`;
      if (orig?.drive_id) await papelera(tk, orig.drive_id).catch(() => {});
    }

    await sql.begin(async (tx: any) => {
      await tx`insert into tesoreria.comprobante_archivo (comprobante_id, anulado, drive_id, nombre, archivado_en)
               values (${comprobanteId}, ${anulado}, ${subido.id}, ${f.nombre}, now())`;
      await tx`delete from tesoreria.comprobante_archivo_pendiente where comprobante_id = ${comprobanteId} and anulado = ${anulado}`;
      if (!f.es_prueba && !anulado) await tx`update tesoreria.comprobante set pdf_drive_id = ${subido.id} where id = ${comprobanteId} and pdf_drive_id is null`;
    });
    return subido.id;
  } catch (e) {
    console.error("archivarEnDrive", e);
    await sql`insert into tesoreria.archivo_drive_error (comprobante_id, anulado, error) values (${comprobanteId}, ${anulado}, ${String((e as Error)?.message ?? e).slice(0, 500)})`.catch(() => {});
    return null;
  }
}
