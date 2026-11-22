// Generador del PDF del comprobante de ingreso (CI). Solo código: los datos
// llegan en el JSON de tesoreria.fn_datos_recibo(id).
import { PDFDocument, StandardFonts, rgb, degrees, PDFFont, PDFPage } from "npm:pdf-lib@1.17.1";

const MM = 72 / 25.4;
const VERDE = rgb(0x1f / 255, 0x6b / 255, 0x4f / 255);
const GRIS = rgb(0x66 / 255, 0x70 / 255, 0x6c / 255);
const LINEA = rgb(0xc9 / 255, 0xcf / 255, 0xcc / 255);
const TINTA = rgb(0x1d / 255, 0x23 / 255, 0x21 / 255);
const ROJO = rgb(0xb3 / 255, 0x26 / 255, 0x1e / 255);
const NARANJA = rgb(0xb2 / 255, 0x6a / 255, 0);
const BLANCO = rgb(1, 1, 1);

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MES3 = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MEDIOS: Record<string, string> = { transferencia: "Transferencia", consignacion: "Consignación", pse: "PSE", efectivo: "Efectivo", cheque: "Cheque", cruce: "Cruce de cuentas" };

// deno-lint-ignore no-explicit-any
type J = any;

export const puntos = (n: number | string) => Math.round(Number(n || 0)).toLocaleString("en-US").replace(/,/g, ".");
export const cop = (n: number | string) => { const v = Math.round(Number(n || 0)); return (v < 0 ? "-" : "") + puntos(Math.abs(v)) + " COP"; };

function doc(t: J): string {
  if (!t || !t.num_doc) return "";
  const tipo: Record<string, string> = { CC: "C.C.", NIT: "NIT", CE: "C.E.", PP: "Pasaporte" };
  let num = /^\d+$/.test(String(t.num_doc)) ? puntos(t.num_doc) : String(t.num_doc);
  if (t.tipo_doc === "NIT" && t.dv !== null && t.dv !== undefined) num += `-${t.dv}`;
  return `${tipo[t.tipo_doc] ?? t.tipo_doc ?? ""} ${num}`.trim();
}

const ymd = (s: string) => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return { y, m, d }; };
const fechaLarga = (s: string) => { const { y, m, d } = ymd(s); return `${d} de ${MESES[m - 1]} de ${y}`; };

function periodo(desde: string, hasta: string): string {
  const a = ymd(desde), b = ymd(hasta);
  const finMes = new Date(Date.UTC(b.y, b.m, 0)).getUTCDate() === b.d;
  if (a.d === 1 && finMes && a.m === b.m && a.y === b.y) return `${MESES[a.m - 1]} ${a.y}`;
  return `${a.d} ${MES3[a.m - 1]}${a.y !== b.y ? " " + a.y : ""} al ${b.d} ${MES3[b.m - 1]} ${b.y}`;
}

// Fecha y hora en Bogotá (UTC-5, sin horario de verano)
function bogota(s: string) {
  const t = new Date(new Date(s).getTime() - 5 * 3600 * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
}
function tsBogota(s: string): string {
  const b = bogota(s);
  const h12 = b.h % 12 || 12;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${b.y}-${p(b.m)}-${p(b.d)} ${h12}:${p(b.mi)}:${p(b.s)} ${b.h < 12 ? "a. m." : "p. m."}`;
}

function incremento(k: J, fpago: string): string | null {
  const regla = k?.regla_reajuste, mes = k?.mes_reajuste;
  if (!regla || regla === "sin_regla" || !mes) return null;
  const pts = Number(k.puntos_reajuste || 0) * 100;
  const ptsT = String(Number(pts.toFixed(2))).replace(".", ",");
  const txt: Record<string, string> = { pct_fijo: `${ptsT} %`, ipc: "IPC", ipc_mas_puntos: `IPC + ${ptsT} puntos`, ipc_tope_vivienda: "IPC (tope legal de vivienda, Ley 820 de 2003)" };
  const fp = ymd(fpago);
  const dia = k.fecha_inicio ? ymd(k.fecha_inicio).d : 1;
  const en = (anio: number) => { const ult = new Date(Date.UTC(anio, mes, 0)).getUTCDate(); return { y: anio, m: mes, d: Math.min(dia, ult) }; };
  const cmp = (a: J, b: J) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
  let prox = en(fp.y);
  if (cmp(prox, fp) <= 0) prox = en(fp.y + 1);
  return `${txt[regla] ?? regla} · próximo incremento: ${MESES[prox.m - 1]} de ${prox.y}`;
}

export function aparato(ua?: string | null): string {
  if (!ua) return "";
  const u = ua.toLowerCase();
  let so = "aparato no identificado";
  if (u.includes("iphone")) so = "celular iPhone";
  else if (u.includes("ipad")) so = "tableta iPad";
  else if (u.includes("android")) so = u.includes("mobile") ? "celular Android" : "tableta Android";
  else if (u.includes("windows")) so = "computador Windows";
  else if (u.includes("mac os") || u.includes("macintosh")) so = "computador Mac";
  else if (u.includes("linux")) so = "computador Linux";
  let nav = "";
  if (u.includes("edg/")) nav = "Edge";
  else if (u.includes("samsungbrowser")) nav = "Samsung Internet";
  else if (u.includes("crios") || (u.includes("chrome/") && !u.includes("chromium"))) nav = "Chrome";
  else if (u.includes("fxios") || u.includes("firefox/")) nav = "Firefox";
  else if (u.includes("safari/")) nav = "Safari";
  return nav ? `${so} (${nav})` : so;
}

// ---- número en letras ----
const U = ["", "UN", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE", "DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISÉIS", "DIECISIETE", "DIECIOCHO", "DIECINUEVE", "VEINTE", "VEINTIÚN", "VEINTIDÓS", "VEINTITRÉS", "VEINTICUATRO", "VEINTICINCO", "VEINTISÉIS", "VEINTISIETE", "VEINTIOCHO", "VEINTINUEVE"];
const D = ["", "", "", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
const C = ["", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS", "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS"];
function cientos(n: number): string {
  if (n === 100) return "CIEN";
  const c = Math.floor(n / 100), r = n % 100;
  let dec: string;
  if (r < 30) dec = U[r]; else { const d = Math.floor(r / 10), u = r % 10; dec = D[d] + (u ? " Y " + U[u] : ""); }
  return [C[c], dec].filter(Boolean).join(" ");
}
export function letras(n: number): string {
  n = Math.round(n);
  if (n === 0) return "CERO";
  const millones = Math.floor(n / 1e6), resto = n % 1e6, miles = Math.floor(resto / 1000), unidades = resto % 1000;
  const p: string[] = [];
  if (millones) p.push(millones === 1 ? "UN MILLÓN" : letras(millones) + " MILLONES");
  if (miles) p.push(miles === 1 ? "MIL" : cientos(miles) + " MIL");
  if (unidades) p.push(cientos(unidades));
  let t = p.join(" ");
  if (!unidades && !miles && millones) t += " DE";
  return t;
}

function partir(texto: string, font: PDFFont, size: number, ancho: number): string[] {
  const out: string[] = [];
  for (const parr of String(texto ?? "").split("\n")) {
    let linea = "";
    for (const pal of parr.split(/\s+/).filter(Boolean)) {
      const prueba = linea ? linea + " " + pal : pal;
      if (font.widthOfTextAtSize(prueba, size) <= ancho || !linea) linea = prueba;
      else { out.push(linea); linea = pal; }
    }
    out.push(linea);
  }
  return out;
}

export async function generarPdf(d: J, logo?: { bytes: Uint8Array; mime: string } | null): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(d.codigo);
  pdf.setAuthor(d.titular.nombre);
  pdf.setProducer("Recibos de arriendo (Supabase)");
  const page: PDFPage = pdf.addPage([612, 792]);
  const R = await pdf.embedFont(StandardFonts.Helvetica);
  const B = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 18 * MM;
  const txt = (s: string, x: number, y: number, f: PDFFont, size: number, color = TINTA) => page.drawText(s, { x, y, font: f, size, color });
  const der = (s: string, x: number, y: number, f: PDFFont, size: number, color = TINTA) => page.drawText(s, { x: x - f.widthOfTextAtSize(s, size), y, font: f, size, color });
  let y = H - M;

  const tit = d.titular;
  const esSoc = tit.tipo_persona === "juridica";
  let x0 = M;
  const conLogo = !!(logo && esSoc);
  if (conLogo) {
    const img = logo!.mime.includes("png") ? await pdf.embedPng(logo!.bytes) : await pdf.embedJpg(logo!.bytes);
    const h = 22 * MM, w = h * img.width / img.height;
    page.drawImage(img, { x: M, y: y - h, width: w, height: h });
    x0 = M + w + 5 * MM;
  }
  if (d.es_prueba) der("RECIBO DE PRUEBA · SIN VALIDEZ", W - M, H - M + 3 * MM, B, 9, NARANJA);
  txt(tit.nombre, x0, y - 6 * MM, B, 15);
  txt(`${doc(tit)} · COMPROBANTE DE INGRESO · ARRENDAMIENTO`, x0, y - 11 * MM, R, 8.5, GRIS);
  der(d.codigo, W - M, y - 6 * MM, B, 15);
  const cb = bogota(d.creado_en);
  der(`Medellín, ${cb.d} de ${MESES[cb.m - 1]} de ${cb.y}`, W - M, y - 11 * MM, R, 8.5, GRIS);
  y -= conLogo ? 26 * MM : 15 * MM;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.2, color: TINTA });
  y -= 8 * MM;

  // ---- datos ----
  const k = d.contrato || {};
  const l0 = (d.lineas || [{}])[0] || {};
  const inm = l0.inmueble || (k.inmuebles || [])[0];
  const cta = d.cuenta || {};
  let medio = MEDIOS[d.medio] ?? d.medio;
  if ((cta.tipo === "ahorros" || cta.tipo === "corriente") && cta.banco) {
    const ult = cta.ultimos4 || String(cta.codigo || "").replace(/\D/g, "").slice(-4);
    medio += ` a la cuenta de ${cta.tipo} ${cta.banco} ****${ult}`;
  }
  const campos: [string, string][] = [
    ["Fecha del pago:", fechaLarga(d.fecha_pago)],
    ["Recibido de:", d.pagador.nombre],
    ["Cédula o NIT:", doc(d.pagador)],
  ];
  if (inm) campos.push(["Inmueble:", `${inm.codigo} - ${inm.direccion}, ${inm.municipio || "Medellín"}`]);
  if (k.codigo) campos.push(["Contrato:", k.codigo]);
  const inc = k.codigo ? incremento(k, d.fecha_pago) : null;
  if (inc) campos.push(["Incremento:", inc]);
  campos.push(["Forma de pago:", medio]);
  if (d.referencia) campos.push(["Referencia:", d.referencia]);
  if (esSoc) {
    const facts = [...new Set(((d.cobertura || {}).cubre || []).map((g: J) => g.factura).filter(Boolean).map(String))].sort();
    campos.push(["Factura que cancela:", facts.length ? facts.join(", ") : "pendiente de enlazar"]);
  }
  if (d.observacion) campos.push(["Observaciones:", d.observacion]);
  for (const [et, val] of campos) {
    txt(et, M, y, B, 9.5);
    const fs = partir(String(val ?? ""), R, 9.5, W - 2 * M - 42 * MM);
    fs.forEach((f, i) => txt(f, M + 42 * MM, y - i * 4.6 * MM, R, 9.5));
    y -= Math.max(1, fs.length) * 4.6 * MM + 1.6 * MM;
  }
  y -= 4 * MM;

  // ---- tabla ----
  const cx = [M, M + 72 * MM, W - M];
  txt("CONCEPTO", cx[0], y, B, 8, GRIS);
  txt("PERIODO / DETALLE", cx[1], y, B, 8, GRIS);
  der("VALOR", cx[2], y, B, 8, GRIS);
  y -= 2.5 * MM;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: TINTA });
  y -= 5 * MM;
  const cob = d.cobertura || {};
  const lineas: J[] = d.lineas || [];
  const total = lineas.reduce((s, l) => s + Number(l.valor), 0);
  const ret = lineas.reduce((s, l) => s + Number(l.retencion || 0), 0);
  const canonTotal = lineas.filter((l) => l.concepto === "canon").reduce((s, l) => s + Number(l.valor), 0);
  const filas: [string, string, number][] = [];
  let aplicado = 0;
  for (const g of cob.cubre || []) {
    const a = Math.round(Number(g.aplicado)); aplicado += a;
    const nombre = g.tipo === "canon" ? "Canon de arrendamiento" : String(g.tipo).replace(/_/g, " ").replace(/^./, (c: string) => c.toUpperCase());
    let det = periodo(g.desde, g.hasta);
    const totG = Math.round(Number(g.total)), pend = Math.round(Number(g.pendiente_antes ?? totG));
    if (a < pend) det += ` (abono parcial; quedan ${cop(pend - a)})`;
    else if (pend < totG) det += " (saldo del periodo; queda pagado)";
    filas.push([nombre, det, a]);
  }
  for (const l of lineas.filter((l) => l.concepto !== "canon")) filas.push([l.descripcion || l.concepto, "", Number(l.valor)]);
  if (canonTotal - aplicado > 0) filas.push(["Saldo a favor del arrendatario", "se aplicará a los siguientes cánones", canonTotal - aplicado]);
  // Descuentos que hizo el administrador del inmueble antes de transferir (cruce con sus cuentas)
  const cruces: J[] = d.cruces || [];
  const descuentos = cruces.reduce((s, z) => s + Number(z.valor), 0);
  const filasDesc: [string, string, number][] = cruces.map((z) => {
    if (z.tipo_gasto === "comision_administracion") {
      let det = `${z.tercero}${z.numero ? ", factura " + z.numero : ""}`;
      if (Number(z.retefuente) > 0) det += ` (total ${cop(Number(z.subtotal) + Number(z.iva))}, menos retención ${cop(z.retefuente)})`;
      return ["Menos: comisión del administrador", det, -Number(z.valor)];
    }
    return ["Menos: costo de la transferencia", `descontado por ${z.tercero}`, -Number(z.valor)];
  });
  for (const [a, b, v] of [...filas, ...filasDesc]) {
    txt(a, cx[0], y, R, 9.5);
    const fb = partir(b, R, 9, cx[2] - cx[1] - 30 * MM);
    fb.forEach((f, i) => txt(f, cx[1], y - i * 4.3 * MM, R, 9));
    der(cop(v), cx[2], y, R, 9.5);
    y -= Math.max(1, fb.length) * 4.3 * MM + 2.5 * MM;
  }
  page.drawLine({ start: { x: M, y: y + MM }, end: { x: W - M, y: y + MM }, thickness: 0.6, color: LINEA });
  y -= 4 * MM;
  const tot = (et: string, val: string, bold = false) => {
    txt(et, cx[1] + 20 * MM, y, bold ? B : R, bold ? 9.5 : 9);
    der(val, cx[2], y, bold ? B : R, bold ? 9.5 : 9);
    y -= 5.2 * MM;
  };
  const recibido = total - ret - descuentos;
  tot(descuentos ? "Total del canon pagado" : "Total del recibo", cop(total), true);
  if (ret) tot("Retención en la fuente practicada", cop(-ret));
  if (descuentos) tot("Descontado por el administrador", cop(-descuentos));
  if (ret || descuentos) tot("Total recibido", cop(recibido), true);
  if (cob.saldo_antes !== null && cob.saldo_antes !== undefined && k.codigo) {
    const sa = Number(cob.saldo_antes), sd = sa - canonTotal;
    const fmt = (s: number) => s > 0 ? "debe " + cop(s) : s < 0 ? cop(-s) + " a favor" : "0 COP";
    tot("Saldo antes del pago", fmt(sa));
    tot("Saldo después del pago", fmt(sd));
  }
  y -= 3 * MM;
  txt(`Son: ${letras(descuentos ? recibido : total)} PESOS M/CTE.`, M, y, R, 9);
  y -= 7 * MM;
  const decl = `${tit.nombre} declara haber recibido de ${d.pagador.nombre} la suma de ${cop(total)}` +
    (ret ? `, de los cuales ${cop(ret)} corresponden a la retención en la fuente practicada por el arrendatario` : "") +
    (descuentos ? `; de esa suma, ${cop(descuentos)} los descontó ${cruces[0].tercero}, administrador del inmueble, por su comisión y gastos, y ${cop(recibido)} ingresaron por ${(MEDIOS[d.medio] ?? d.medio).toLowerCase()}` : "") +
    ", por los conceptos y periodos indicados.";
  for (const f of partir(decl, R, 9, W - 2 * M)) { txt(f, M, y, R, 9); y -= 4.3 * MM; }
  y -= 6 * MM;

  // ---- firmas ----
  const el = d.elaboro || {};
  const bw = (W - 2 * M - 6 * MM) / 2, bh = 38 * MM;
  const ap = aparato(d.firma_user_agent);
  const medioForm = "Formulario «Recibos de arriendo»" + (ap ? ` desde ${ap}` : "") + ". Usuario verificado con código enviado a su correo";
  const cajas: [string, string, string, string | null, string][] = [["ELABORADO POR", el.nombre || "", doc(el), tsBogota(d.creado_en), medioForm]];
  if (d.medio === "efectivo") {
    const resp = cta.responsable || el.nombre;
    cajas.push(["RECIBIDO POR", resp, resp === el.nombre ? doc(el) : "", tsBogota(d.creado_en), `Efectivo en la caja ${cta.codigo || ""}, por cuenta de ${tit.nombre}`]);
  } else {
    cajas.push(["RECIBIDO EN", tit.nombre, doc(tit), null, "Abono en la cuenta indicada en «Forma de pago»"]);
  }
  cajas.forEach(([cab, nom, dc, cuando, mf], i) => {
    const bx = M + i * (bw + 6 * MM);
    page.drawRectangle({ x: bx, y: y - bh, width: bw, height: bh, borderColor: LINEA, borderWidth: 0.8 });
    txt(cab, bx + 3 * MM, y - 5 * MM, B, 7.5, GRIS);
    let yy = y - 10.5 * MM;
    if (cuando) {
      const sello = "FIRMADO ELECTRÓNICAMENTE";
      const sw = B.widthOfTextAtSize(sello, 7.5) + 4 * MM;
      page.drawRectangle({ x: bx + 3 * MM, y: yy - 1.6 * MM, width: sw, height: 5 * MM, color: VERDE });
      txt(sello, bx + 5 * MM, yy, B, 7.5, BLANCO);
      yy -= 6 * MM;
      txt(nom, bx + 3 * MM, yy, B, 10, VERDE);
    } else {
      txt(nom, bx + 3 * MM, yy, B, 9.5);
    }
    yy -= 4.5 * MM;
    if (dc) { txt(dc, bx + 3 * MM, yy, R, 8); yy -= 4 * MM; }
    if (cuando) { txt(`Fecha y hora: ${cuando} (hora Colombia)`, bx + 3 * MM, yy, R, 8); yy -= 4 * MM; }
    for (const f of partir(`Medio: ${mf}`, R, 8, bw - 6 * MM)) { txt(f, bx + 3 * MM, yy, R, 8); yy -= 3.8 * MM; }
  });
  y -= bh + 6 * MM;
  const pie = "Comprobante registrado y firmado electrónicamente (Ley 527 de 1999). Los datos personales se tratan para la administración del contrato de arrendamiento (Ley 1581 de 2012).";
  for (const f of partir(pie, R, 7.5, W - 2 * M)) { txt(f, M, y, R, 7.5, GRIS); y -= 3.6 * MM; }

  if (d.estado === "anulado") {
    const t = "ANULADO", size = 110, w = B.widthOfTextAtSize(t, size);
    const a = 35 * Math.PI / 180;
    page.drawText(t, { x: W / 2 - (w / 2) * Math.cos(a), y: H / 2 - (w / 2) * Math.sin(a), size, font: B, color: rgb(0.75, 0.1, 0.1), opacity: 0.25, rotate: degrees(35) });
    txt(`ANULADO el ${tsBogota(d.anulado_en)} (hora Colombia).`, M, M + 8 * MM, B, 9, ROJO);
    partir(`Motivo: ${d.motivo_anulacion || ""}`, R, 9, W - 2 * M).forEach((f, i) => txt(f, M, M + 3.5 * MM - i * 4.2 * MM, R, 9, ROJO));
  }
  return await pdf.save();
}
