#!/usr/bin/env python3
"""Genera el PDF de un comprobante de ingreso (CI) a partir del JSON de
tesoreria.fn_datos_recibo(id). Solo código: todos los datos llegan en el JSON.

Uso: python3 recibo_pdf.py datos.json salida.pdf [logo.jpg]
"""
import json
import sys
from datetime import datetime, date, timedelta, timezone

from reportlab.lib.colors import HexColor, Color
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.lib.utils import simpleSplit, ImageReader

VERDE = HexColor('#1f6b4f')
GRIS = HexColor('#66706c')
LINEA = HexColor('#c9cfcc')
TINTA = HexColor('#1d2321')
BOGOTA = timezone(timedelta(hours=-5))

MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
         'septiembre', 'octubre', 'noviembre', 'diciembre']
MES3 = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
MEDIOS = {'transferencia': 'Transferencia', 'consignacion': 'Consignación', 'pse': 'PSE',
          'efectivo': 'Efectivo', 'cheque': 'Cheque', 'cruce': 'Cruce de cuentas'}
TIPO_CUENTA = {'ahorros': 'ahorros', 'corriente': 'corriente'}


def cop(n):
    n = int(round(float(n or 0)))
    s = f'{abs(n):,}'.replace(',', '.')
    return ('-' if n < 0 else '') + s + ' COP'


def puntos(n):
    return f'{int(n):,}'.replace(',', '.')


def doc(t):
    if not t or not t.get('num_doc'):
        return ''
    tipo = {'CC': 'C.C.', 'NIT': 'NIT', 'CE': 'C.E.', 'PP': 'Pasaporte'}.get(t.get('tipo_doc'), t.get('tipo_doc') or '')
    num = puntos(t['num_doc']) if str(t['num_doc']).isdigit() else t['num_doc']
    if t.get('tipo_doc') == 'NIT' and t.get('dv') is not None:
        num += f"-{t['dv']}"
    return f'{tipo} {num}'.strip()


def fecha_larga(d):
    d = d if isinstance(d, date) else date.fromisoformat(str(d)[:10])
    return f'{d.day} de {MESES[d.month - 1]} de {d.year}'


def periodo(desde, hasta):
    a, b = date.fromisoformat(desde), date.fromisoformat(hasta)
    if a.day == 1 and (b + timedelta(days=1)).day == 1 and a.month == b.month:
        return f'{MESES[a.month - 1]} {a.year}'
    ia = f'{a.day} {MES3[a.month - 1]}' + (f' {a.year}' if a.year != b.year else '')
    return f'{ia} al {b.day} {MES3[b.month - 1]} {b.year}'


def incremento(k, fpago):
    regla = k.get('regla_reajuste')
    mes = k.get('mes_reajuste')
    if not regla or regla == 'sin_regla' or not mes:
        return None
    pts = float(k.get('puntos_reajuste') or 0) * 100
    pts_t = (f'{pts:.2f}'.rstrip('0').rstrip('.')).replace('.', ',')
    txt = {'pct_fijo': f'{pts_t} %', 'ipc': 'IPC', 'ipc_mas_puntos': f'IPC + {pts_t} puntos',
           'ipc_tope_vivienda': 'IPC (tope legal de vivienda, Ley 820 de 2003)'}.get(regla, regla)
    fp = date.fromisoformat(str(fpago)[:10])
    dia = date.fromisoformat(str(k.get('fecha_inicio'))[:10]).day if k.get('fecha_inicio') else 1
    def fecha_en(anio):
        for dd in (dia, 30, 29, 28):
            try:
                return date(anio, mes, dd)
            except ValueError:
                pass
    prox = fecha_en(fp.year)
    if prox <= fp:
        prox = fecha_en(fp.year + 1)
    return f'{txt} · próximo incremento: {MESES[prox.month - 1]} de {prox.year}'


def aparato(ua):
    """Descripción corta del aparato y navegador a partir del User-Agent."""
    if not ua:
        return ''
    u = ua.lower()
    if 'iphone' in u:
        so = 'celular iPhone'
    elif 'ipad' in u:
        so = 'tableta iPad'
    elif 'android' in u:
        so = 'celular Android' if 'mobile' in u else 'tableta Android'
    elif 'windows' in u:
        so = 'computador Windows'
    elif 'mac os' in u or 'macintosh' in u:
        so = 'computador Mac'
    elif 'linux' in u:
        so = 'computador Linux'
    else:
        so = 'aparato no identificado'
    if 'edg/' in u:
        nav = 'Edge'
    elif 'samsungbrowser' in u:
        nav = 'Samsung Internet'
    elif 'crios' in u or ('chrome/' in u and 'chromium' not in u):
        nav = 'Chrome'
    elif 'fxios' in u or 'firefox/' in u:
        nav = 'Firefox'
    elif 'safari/' in u:
        nav = 'Safari'
    else:
        nav = ''
    return f'{so} ({nav})' if nav else so


def ts_bogota(s):
    t = datetime.fromisoformat(str(s).replace('Z', '+00:00')).astimezone(BOGOTA)
    h = t.hour % 12 or 12
    ampm = 'a. m.' if t.hour < 12 else 'p. m.'
    return t.strftime('%Y-%m-%d ') + f'{h}:{t.minute:02d}:{t.second:02d} {ampm}'


# ---- número en letras (pesos) ----
_U = ['', 'UN', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ', 'ONCE', 'DOCE',
      'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE',
      'VEINTIÚN', 'VEINTIDÓS', 'VEINTITRÉS', 'VEINTICUATRO', 'VEINTICINCO', 'VEINTISÉIS', 'VEINTISIETE',
      'VEINTIOCHO', 'VEINTINUEVE']
_D = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA']
_C = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS',
      'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS']


def _cientos(n):
    if n == 100:
        return 'CIEN'
    c, r = divmod(n, 100)
    if r < 30:
        dec = _U[r]
    else:
        d, u = divmod(r, 10)
        dec = _D[d] + (' Y ' + _U[u] if u else '')
    return ' '.join(x for x in (_C[c], dec) if x)


def letras(n):
    n = int(round(n))
    if n == 0:
        return 'CERO'
    partes = []
    millones, resto = divmod(n, 1_000_000)
    miles, unidades = divmod(resto, 1000)
    if millones:
        partes.append('UN MILLÓN' if millones == 1 else letras(millones) + ' MILLONES')
    if miles:
        partes.append('MIL' if miles == 1 else _cientos(miles) + ' MIL')
    if unidades:
        partes.append(_cientos(unidades))
    txt = ' '.join(partes)
    if unidades == 0 and miles == 0 and millones:
        txt += ' DE'
    return txt


def generar(d, salida, logo=None):
    W, H = letter
    c = canvas.Canvas(salida, pagesize=letter)
    c.setTitle(d['codigo'])
    c.setAuthor(d['titular']['nombre'])
    M = 18 * mm
    y = H - M

    tit = d['titular']
    es_soc = tit.get('tipo_persona') == 'juridica'
    x0 = M
    if logo and es_soc:
        img = ImageReader(logo)
        iw, ih = img.getSize()
        h = 22 * mm
        w = h * iw / ih
        c.drawImage(img, M, y - h, w, h, mask='auto')
        x0 = M + w + 5 * mm
    c.setFillColor(TINTA)
    c.setFont('Helvetica-Bold', 15)
    c.drawString(x0, y - 6 * mm, tit['nombre'])
    c.setFont('Helvetica', 8.5)
    c.setFillColor(GRIS)
    c.drawString(x0, y - 11 * mm, f"{doc(tit)} · COMPROBANTE DE INGRESO · ARRENDAMIENTO")
    c.setFillColor(TINTA)
    c.setFont('Helvetica-Bold', 15)
    c.drawRightString(W - M, y - 6 * mm, d['codigo'])
    c.setFont('Helvetica', 8.5)
    c.setFillColor(GRIS)
    creado = datetime.fromisoformat(d['creado_en'].replace('Z', '+00:00')).astimezone(BOGOTA).date()
    c.drawRightString(W - M, y - 11 * mm, f'Medellín, {fecha_larga(creado)}')
    y -= (26 * mm if logo and es_soc else 15 * mm)
    c.setStrokeColor(TINTA)
    c.setLineWidth(1.2)
    c.line(M, y, W - M, y)
    y -= 8 * mm

    # ---- datos ----
    k = d.get('contrato') or {}
    linea0 = (d.get('lineas') or [{}])[0]
    inm = linea0.get('inmueble') or ((k.get('inmuebles') or [None])[0])
    cta = d.get('cuenta') or {}
    medio = MEDIOS.get(d['medio'], d['medio'])
    if cta.get('tipo') in TIPO_CUENTA and cta.get('banco'):
        ult = cta.get('ultimos4') or ''.join(ch for ch in cta.get('codigo', '') if ch.isdigit())[-4:]
        medio += f" a la cuenta de {TIPO_CUENTA[cta['tipo']]} {cta['banco']} ****{ult}"
    campos = [
        ('Fecha del pago:', fecha_larga(d['fecha_pago'])),
        ('Recibido de:', d['pagador']['nombre']),
        ('Cédula o NIT:', doc(d['pagador'])),
    ]
    if inm:
        campos.append(('Inmueble:', f"{inm['codigo']} - {inm['direccion']}, {inm.get('municipio') or 'Medellín'}"))
    if k.get('codigo'):
        campos.append(('Contrato:', k['codigo']))
    inc = incremento(k, d['fecha_pago']) if k else None
    if inc:
        campos.append(('Incremento:', inc))
    campos.append(('Forma de pago:', medio))
    if d.get('referencia'):
        campos.append(('Referencia:', d['referencia']))
    if es_soc:
        facts = sorted({str(g['factura']) for g in (d.get('cobertura') or {}).get('cubre') or [] if g.get('factura')})
        campos.append(('Factura que cancela:', ', '.join(facts) if facts else 'pendiente de enlazar'))
    if d.get('observacion'):
        campos.append(('Observaciones:', d['observacion']))
    for et, val in campos:
        c.setFont('Helvetica-Bold', 9.5)
        c.setFillColor(TINTA)
        c.drawString(M, y, et)
        c.setFont('Helvetica', 9.5)
        filas = simpleSplit(str(val), 'Helvetica', 9.5, W - 2 * M - 42 * mm)
        for i, f in enumerate(filas):
            c.drawString(M + 42 * mm, y - i * 4.6 * mm, f)
        y -= max(1, len(filas)) * 4.6 * mm + 1.6 * mm
    y -= 4 * mm

    # ---- tabla ----
    cx = [M, M + 72 * mm, W - M]
    c.setFont('Helvetica-Bold', 8)
    c.setFillColor(GRIS)
    c.drawString(cx[0], y, 'CONCEPTO')
    c.drawString(cx[1], y, 'PERIODO / DETALLE')
    c.drawRightString(cx[2], y, 'VALOR')
    y -= 2.5 * mm
    c.setStrokeColor(TINTA)
    c.setLineWidth(0.6)
    c.line(M, y, W - M, y)
    y -= 5 * mm
    cob = d.get('cobertura') or {}
    total = sum(int(l['valor']) for l in d['lineas'])
    ret = sum(int(l.get('retencion') or 0) for l in d['lineas'])
    filas = []
    aplicado = 0
    for g in cob.get('cubre') or []:
        a = int(round(float(g['aplicado'])))
        aplicado += a
        nombre = 'Canon de arrendamiento' if g['tipo'] == 'canon' else g['tipo'].replace('_', ' ').capitalize()
        det = periodo(g['desde'], g['hasta'])
        tot_g = int(round(float(g['total'])))
        pend = int(round(float(g.get('pendiente_antes', tot_g))))
        if a < pend:
            det += f" (abono parcial; quedan {cop(pend - a)})"
        elif pend < tot_g:
            det += ' (saldo del periodo; queda pagado)'
        filas.append((nombre, det, a))
    otros = [l for l in d['lineas'] if l['concepto'] != 'canon']
    for l in otros:
        filas.append((l.get('descripcion') or l['concepto'], '', int(l['valor'])))
    canon_total = sum(int(l['valor']) for l in d['lineas'] if l['concepto'] == 'canon')
    if canon_total - aplicado > 0:
        filas.append(('Saldo a favor del arrendatario', 'se aplicará a los siguientes cánones', canon_total - aplicado))
    c.setFillColor(TINTA)
    for a, b, v in filas:
        c.setFont('Helvetica', 9.5)
        c.drawString(cx[0], y, a)
        fb = simpleSplit(b, 'Helvetica', 9, cx[2] - cx[1] - 30 * mm)
        c.setFont('Helvetica', 9)
        for i, f in enumerate(fb or ['']):
            c.drawString(cx[1], y - i * 4.3 * mm, f)
        c.setFont('Helvetica', 9.5)
        c.drawRightString(cx[2], y, cop(v))
        y -= max(1, len(fb)) * 4.3 * mm + 2.5 * mm
    c.setStrokeColor(LINEA)
    c.line(M, y + 1 * mm, W - M, y + 1 * mm)
    y -= 4 * mm

    def tot(et, val, bold=False):
        nonlocal y
        c.setFont('Helvetica-Bold' if bold else 'Helvetica', 9.5 if bold else 9)
        c.drawString(cx[1] + 20 * mm, y, et)
        c.drawRightString(cx[2], y, val)
        y -= 5.2 * mm

    tot('Total del recibo', cop(total), True)
    if ret:
        tot('Retención en la fuente practicada', cop(-ret))
        tot('Total recibido', cop(total - ret), True)
    if cob.get('saldo_antes') is not None and k.get('codigo'):
        sa = float(cob['saldo_antes'])
        sd = sa - canon_total
        fmt = lambda s: (('debe ' + cop(s)) if s > 0 else (cop(-s) + ' a favor' if s < 0 else '0 COP'))
        tot('Saldo antes del pago', fmt(sa))
        tot('Saldo después del pago', fmt(sd))
    y -= 3 * mm
    c.setFont('Helvetica', 9)
    c.drawString(M, y, f'Son: {letras(total)} PESOS M/CTE.')
    y -= 7 * mm
    texto = (f"{tit['nombre']} declara haber recibido de {d['pagador']['nombre']} la suma de {cop(total)}"
             + (f", de los cuales {cop(ret)} corresponden a la retención en la fuente practicada por el arrendatario" if ret else '')
             + ', por los conceptos y periodos indicados.')
    for f in simpleSplit(texto, 'Helvetica', 9, W - 2 * M):
        c.drawString(M, y, f)
        y -= 4.3 * mm
    y -= 6 * mm

    # ---- firmas (recuadros horizontales) ----
    el = d.get('elaboro') or {}
    bw = (W - 2 * M - 6 * mm) / 2
    bh = 38 * mm
    ap = aparato(d.get('firma_user_agent'))
    medio_form = ('Formulario «Recibos de arriendo»' + (f' desde {ap}' if ap else '')
                  + '. Usuario verificado con código enviado a su correo')
    cajas = [('ELABORADO POR', el.get('nombre'), doc(el), ts_bogota(d['creado_en']), medio_form)]
    if d['medio'] == 'efectivo':
        cajas.append(('RECIBIDO POR', cta.get('responsable') or el.get('nombre'),
                      doc(el) if (cta.get('responsable') or el.get('nombre')) == el.get('nombre') else '',
                      ts_bogota(d['creado_en']), f"Efectivo en la caja {cta.get('codigo', '')}, por cuenta de {tit['nombre']}"))
    else:
        cajas.append(('RECIBIDO EN', tit['nombre'], doc(tit), None,
                      'Abono en la cuenta indicada en «Forma de pago»'))
    for i, (cab, nom, dc, cuando, medio_f) in enumerate(cajas):
        bx = M + i * (bw + 6 * mm)
        c.setStrokeColor(LINEA)
        c.setLineWidth(0.8)
        c.rect(bx, y - bh, bw, bh)
        c.setFont('Helvetica-Bold', 7.5)
        c.setFillColor(GRIS)
        c.drawString(bx + 3 * mm, y - 5 * mm, cab)
        yy = y - 10.5 * mm
        if cuando:
            sello = 'FIRMADO ELECTRÓNICAMENTE'
            sw = c.stringWidth(sello, 'Helvetica-Bold', 7.5) + 4 * mm
            c.setFillColor(VERDE)
            c.roundRect(bx + 3 * mm, yy - 1.6 * mm, sw, 5 * mm, 1.2 * mm, stroke=0, fill=1)
            c.setFillColor(HexColor('#ffffff'))
            c.setFont('Helvetica-Bold', 7.5)
            c.drawString(bx + 5 * mm, yy, sello)
            yy -= 6 * mm
            c.setFillColor(VERDE)
            c.setFont('Helvetica-Bold', 10)
            c.drawString(bx + 3 * mm, yy, nom or '')
        else:
            c.setFillColor(TINTA)
            c.setFont('Helvetica-Bold', 9.5)
            c.drawString(bx + 3 * mm, yy, nom or '')
        yy -= 4.5 * mm
        c.setFont('Helvetica', 8)
        c.setFillColor(TINTA)
        if dc:
            c.drawString(bx + 3 * mm, yy, dc)
            yy -= 4 * mm
        if cuando:
            c.drawString(bx + 3 * mm, yy, f'Fecha y hora: {cuando} (hora Colombia)')
            yy -= 4 * mm
        for f in simpleSplit(f'Medio: {medio_f}', 'Helvetica', 8, bw - 6 * mm):
            c.drawString(bx + 3 * mm, yy, f)
            yy -= 3.8 * mm
    y -= bh + 6 * mm

    c.setFont('Helvetica', 7.5)
    c.setFillColor(GRIS)
    pie = ('Comprobante registrado y firmado electrónicamente (Ley 527 de 1999). Los datos personales se tratan '
           'para la administración del contrato de arrendamiento (Ley 1581 de 2012).')
    for f in simpleSplit(pie, 'Helvetica', 7.5, W - 2 * M):
        c.drawString(M, y, f)
        y -= 3.6 * mm

    # ---- marcas de agua ----
    def marca(txt, color, tam):
        c.saveState()
        c.setFillColor(color)
        c.setFont('Helvetica-Bold', tam)
        c.translate(W / 2, H / 2)
        c.rotate(35)
        c.drawCentredString(0, 0, txt)
        c.restoreState()

    if d.get('es_prueba'):
        c.setFillColor(HexColor('#b26a00'))
        c.setFont('Helvetica-Bold', 9)
        c.drawRightString(W - M, H - M + 3 * mm, 'RECIBO DE PRUEBA · SIN VALIDEZ')
    if d.get('estado') == 'anulado':
        marca('ANULADO', Color(0.75, 0.1, 0.1, alpha=0.25), 110)
        c.setFillColor(HexColor('#b3261e'))
        c.setFont('Helvetica-Bold', 9)
        c.drawString(M, M + 8 * mm, f"ANULADO el {ts_bogota(d['anulado_en'])} (hora Colombia).")
        c.setFont('Helvetica', 9)
        for i, f in enumerate(simpleSplit(f"Motivo: {d.get('motivo_anulacion') or ''}", 'Helvetica', 9, W - 2 * M)):
            c.drawString(M, M + 3.5 * mm - i * 4.2 * mm, f)
    c.showPage()
    c.save()


if __name__ == '__main__':
    datos = json.load(open(sys.argv[1], encoding='utf-8'))
    generar(datos, sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    print(sys.argv[2])
