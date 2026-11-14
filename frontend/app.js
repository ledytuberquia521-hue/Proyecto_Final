/* =====================================================================
   Centro de pronóstico — lógica del panel
   ---------------------------------------------------------------------
   Fuentes (todas de la API que ya existe):
     /api/salud        estado del servicio
     /api/modelo       ficha y métricas del modelo
     /api/prediccion   pronóstico + histórico (se llama dos veces:
                       banda exterior con 336 h de historia, y banda 80 %)
   Todo lo demás (perfil diario, anomalías, riesgo, calidad) se calcula
   aquí, en el navegador, a partir de esos datos.

   Horas: la API entrega UTC (terminan en "Z"). Se muestran en hora de
   Colombia con Intl.DateTimeFormat y la zona "America/Bogota".
   ===================================================================== */

const ZONA = "America/Bogota";
const UNIDAD = "";            // p.ej. "kW" si conoces la unidad del sensor
const HISTORIA_ANALISIS = 336; // 14 días para patrones, anomalías y calidad
const Z_ROBUSTO = 3.5;         // umbral de anomalía (desviaciones robustas)
const REFRESCO_MS = 5 * 60 * 1000;

const C = {
  real: "#2b2b29", azul: "#2a78d6", azulOsc: "#1c5cab",
  azul80: "rgba(42,120,214,0.30)", azulExt: "rgba(42,120,214,0.12)",
  habitual: "#9a9890", bien: "#1e8a3c", aviso: "#b87800", critico: "#c73636",
  naranja: "#eb6834", rejilla: "#ecebe7", tinta2: "#52514e",
};
const RAMPA = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];

/* ------------------------------------------------------------ formato */
const fHora = new Intl.DateTimeFormat("es-CO", { timeZone: ZONA, hour: "numeric", hour12: true });
const fDiaHora = new Intl.DateTimeFormat("es-CO", { timeZone: ZONA, weekday: "short", day: "numeric", hour: "numeric", hour12: true });
const fCompleta = new Intl.DateTimeFormat("es-CO", { timeZone: ZONA, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
const fFecha = new Intl.DateTimeFormat("es-CO", { timeZone: ZONA, day: "numeric", month: "short", year: "numeric" });
const fDia = new Intl.DateTimeFormat("es-CO", { timeZone: ZONA, weekday: "short", day: "numeric", month: "short" });
const fReloj = new Intl.DateTimeFormat("es-CO", { timeZone: ZONA, hour: "numeric", minute: "2-digit", hour12: true });

const hora = (d) => fHora.format(d);                 // "11 a. m."
const diaHora = (d) => fDiaHora.format(d);           // "lun, 9, 11 a. m."
const completa = (d) => fCompleta.format(d);         // "9 nov, 11:00 a. m."

// Colombia no tiene horario de verano: siempre UTC−5. Se usa para agrupar
// por hora del día y por fecha (la presentación usa Intl, arriba).
const horaCO = (d) => (d.getUTCHours() + 19) % 24;
const fechaCO = (d) => new Date(d.getTime() - 5 * 3600e3).toISOString().slice(0, 10);
const ETIQ_HORA = Array.from({ length: 24 }, (_, h) => (h === 0 ? "12 a. m." : h < 12 ? `${h} a. m.` : h === 12 ? "12 p. m." : `${h - 12} p. m.`));

function num(v, dec) {
  if (v == null || !isFinite(v)) return "—";
  if (dec == null) dec = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  return Number(v).toLocaleString("es-CO", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
const conUnidad = (v, dec) => `${num(v, dec)}${UNIDAD ? " " + UNIDAD : ""}`;
const pct = (v, dec = 0) => `${num(v * 100, dec)} %`;
function signo(v, dec = 0) {
  const r = Number((v * 100).toFixed(dec));          // evita "−0 %"
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${num(Math.abs(r), dec)} %`;
}

/* ------------------------------------------------------------ estadística */
const ordenar = (a) => [...a].sort((x, y) => x - y);
function cuantil(arr, q) {
  const s = ordenar(arr.filter((x) => x != null && isFinite(x)));
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q, b = Math.floor(pos), r = pos - b;
  return s[b + 1] !== undefined ? s[b] + r * (s[b + 1] - s[b]) : s[b];
}
const media = (a) => a.reduce((x, y) => x + y, 0) / a.length;
// Función de distribución normal acumulada (aproximación de Abramowitz-Stegun)
function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
const Z_DE = { 0.8: 1.2816, 0.9: 1.6449, 0.95: 1.96, 0.99: 2.5758 };

/* ------------------------------------------------------------ estado */
const $ = (id) => document.getElementById(id);
const E = {
  salud: null, modelo: null, ext: null, int: null,
  hist: [], pred: [], perfil: [], anomalias: [], umbralManual: false,
  graficas: {}, ultimaCarga: null,
};

/* ------------------------------------------------------------ API */
async function pedir(url) {
  let r;
  try { r = await fetch(url); }
  catch { const e = new Error("No hay conexión con la API."); e.estado = 0; throw e; }
  let datos = null;
  try { datos = await r.json(); } catch { /* sin JSON */ }
  if (!r.ok) {
    let d = datos && datos.detail;
    if (Array.isArray(d)) d = d.map((x) => x.msg).join("; ");
    const e = new Error(`(${r.status}) ${d || r.statusText || "Error desconocido"}`);
    e.estado = r.status; throw e;
  }
  return datos;
}

function pistaError(e) {
  const m = e.message || "";
  if (e.estado === 0) return "¿Está corriendo uvicorn o el contenedor en el puerto 8000?";
  if (m.includes("Faltan variables")) return "Si estás en Docker, revisa que el docker run tenga los cuatro -e (INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET).";
  if (m.includes("No hay modelo")) return "Sube models/sarima_config.json desde Colab y recarga el modelo.";
  if (e.estado === 502) return "InfluxDB no respondió bien: revisa la URL y el token en los secrets.";
  if (e.estado === 422) return "Algún parámetro está fuera de rango.";
  return "";
}
function mostrarError(e) {
  $("error-texto").textContent = e.message;
  $("error-pista").textContent = pistaError(e);
  $("error").hidden = false;
}

/* ------------------------------------------------------------ carga */
async function cargarTodo() {
  const btn = $("actualizar");
  btn.disabled = true; btn.classList.add("girando");
  const horas = $("horas").value;
  const conf = $("confianza").value;

  const [rSalud, rModelo, rExt, rInt] = await Promise.allSettled([
    pedir("/api/salud"),
    pedir("/api/modelo"),
    pedir(`/api/prediccion?horas=${horas}&historia=${HISTORIA_ANALISIS}&confianza=${conf}`),
    pedir(`/api/prediccion?horas=${horas}&historia=0&confianza=0.8`),
  ]);

  btn.disabled = false; btn.classList.remove("girando");
  pintarSalud(rSalud);
  E.modelo = rModelo.status === "fulfilled" ? rModelo.value : null;

  if (rExt.status === "rejected" || rInt.status === "rejected") {
    mostrarError(rExt.reason || rInt.reason);
    pintarFlujo();
    return;
  }
  $("error").hidden = true;
  E.ext = rExt.value; E.int = rInt.value; E.ultimaCarga = new Date();

  prepararDatos();
  pintarTodo();
}

function pintarSalud(r) {
  const p = $("punto-salud"), t = $("texto-salud");
  if (r.status === "rejected") { p.className = "punto mal"; t.textContent = "Servicio no disponible"; E.salud = null; return; }
  const s = E.salud = r.value;
  let clase = "ok", texto = `En línea · atendido por ${s.atendido_por}`;
  if (!s.modelo_cargado) { clase = "mal"; texto = "Sin modelo cargado"; }
  else if (!s.modo_demo && !s.influx_configurado) { clase = "mal"; texto = "InfluxDB sin configurar"; }
  else if (s.modelo_demo || s.modo_demo) { clase = "aviso"; texto += " · modelo demo"; }
  p.className = "punto " + clase; t.textContent = texto;
  if (s.field) $("subtitulo").textContent = `Variable ${s.field} · measurement ${s.measurement} · pronóstico horario con SARIMA`;
  $("pie-host").textContent = `Servido por ${s.atendido_por}`;
}

/* ------------------------------------------------------------ cálculos */
function prepararDatos() {
  E.hist = E.ext.historico.map((h) => ({ t: new Date(h.tiempo), v: h.valor }));
  const int = E.int.prediccion;
  const zExt = Z_DE[E.ext.confianza] || 1.96;
  E.pred = E.ext.prediccion.map((p, i) => {
    const t = new Date(p.tiempo);
    return {
      t, v: p.prediccion, extInf: p.limite_inferior, extSup: p.limite_superior,
      intInf: int[i] ? int[i].limite_inferior : null, intSup: int[i] ? int[i].limite_superior : null,
      sigma: Math.max((p.limite_superior - p.prediccion) / zExt, 1e-9),
    };
  });

  // Perfil diario: mediana, cuartiles y MAD por hora de Colombia
  const grupos = Array.from({ length: 24 }, () => []);
  E.hist.forEach((h) => grupos[horaCO(h.t)].push(h.v));
  E.perfil = grupos.map((g) => {
    if (!g.length) return { med: NaN, q1: NaN, q3: NaN, esc: NaN, n: 0 };
    const med = cuantil(g, 0.5);
    const mad = cuantil(g.map((x) => Math.abs(x - med)), 0.5);
    const q1 = cuantil(g, 0.25), q3 = cuantil(g, 0.75);
    // escala robusta: 1.4826·MAD; si MAD=0, se usa el rango intercuartílico
    const esc = mad > 0 ? 1.4826 * mad : (q3 - q1) / 1.349 || Math.abs(med) * 0.05 || 1;
    return { med, q1, q3, esc, n: g.length };
  });

  // Anomalías: |valor − mediana de su hora| > 3,5 escalas robustas
  E.anomalias = E.hist.map((h) => {
    const p = E.perfil[horaCO(h.t)];
    const z = (h.v - p.med) / p.esc;
    return { ...h, med: p.med, z };
  }).filter((a) => Math.abs(a.z) > Z_ROBUSTO);

  // Umbral por defecto: percentil 90 de las 2 semanas
  if (!E.umbralManual) {
    const p90 = cuantil(E.hist.map((h) => h.v), 0.9);
    $("umbral").value = Math.abs(p90) >= 100 ? Math.round(p90) : Number(p90.toFixed(1));
  }
  const u = Number($("umbral").value);
  E.pred.forEach((p) => { p.prob = 1 - phi((u - p.v) / p.sigma); p.hab = E.perfil[horaCO(p.t)].med; });
}

const umbral = () => Number($("umbral").value);
const nivelRiesgo = (p) => (p > 0.5 ? "critico" : p >= 0.2 ? "aviso" : "bien");
const colorRiesgo = (p) => C[nivelRiesgo(p) === "bien" ? "bien" : nivelRiesgo(p)];

function cambioDeNivel() {
  const ult = E.hist.slice(-24);
  if (ult.length < 12) return 0;
  const habitual = media(ult.map((h) => E.perfil[horaCO(h.t)].med));
  return (media(ult.map((h) => h.v)) - habitual) / Math.abs(habitual || 1);
}
function edadModeloDias() {
  const s = E.modelo && E.modelo.entrenado_en;
  if (!s) return null;
  const d = new Date(s.replace(" UTC", "Z").replace(" ", "T"));
  return isNaN(d) ? null : (Date.now() - d) / 86400e3;
}

/* ------------------------------------------------------------ pintar */
function pintarTodo() {
  $("actualizado").textContent = `Actualizado ${fReloj.format(E.ultimaCarga)}`;
  $("th-exterior").textContent = `Rango ${pct(E.ext.confianza)}`;
  pintarHistoria();
  pintarKPIs();
  pintarPrincipal();
  pintarRiesgo();
  pintarVsHabitual();
  pintarTabla();
  pintarPatrones();
  pintarCalidad();
  pintarModelo();
  pintarFlujo();
}

/* ---- narrativa: el titular que resume lo importante ---- */
function pintarHistoria() {
  const P = E.pred, H = P.length, u = umbral();
  const ahora = E.hist[E.hist.length - 1];
  const pico = P.reduce((a, b) => (b.v > a.v ? b : a));
  const maxP = P.reduce((a, b) => (b.prob > a.prob ? b : a));
  const tendencia = (media(P.map((p) => p.v)) - ahora.v) / Math.abs(ahora.v || 1);
  const habAhora = E.perfil[horaCO(ahora.t)].med;
  const altas = P.filter((p) => p.prob > 0.5);

  let titular;
  if (altas.length) {
    const primera = altas[0].t, ultima = altas[altas.length - 1].t;
    const mismoDia = fechaCO(primera) === fechaCO(ultima) && altas.length === (ultima - primera) / 3600e3 + 1;
    titular = mismoDia
      ? `Alerta: es probable superar ${conUnidad(u)} entre las ${hora(primera)} y las ${hora(ultima)}.`
      : `Alerta: es probable superar ${conUnidad(u)} en ${altas.length} de las próximas ${H} h, desde ${diaHora(primera)}.`;
  } else if (maxP.prob >= 0.2) {
    titular = `Atención: riesgo moderado (${pct(maxP.prob)}) de superar ${conUnidad(u)} hacia las ${hora(maxP.t)}.`;
  } else {
    const verbo = tendencia > 0.1 ? "subirá" : tendencia < -0.1 ? "bajará" : "se mantendrá estable";
    titular = `En las próximas ${H} h el consumo ${verbo}, con un pico de ${conUnidad(pico.v)} a las ${hora(pico.t)}.`;
  }

  const difPico = (pico.v - pico.hab) / Math.abs(pico.hab || 1);
  const difAhora = (ahora.v - habAhora) / Math.abs(habAhora || 1);
  const compara = (d) => (Math.abs(d) < 0.05 ? "en línea con lo habitual" : `${signo(d)} ${d > 0 ? "por encima" : "por debajo"} de lo habitual`);
  const m1 = P[0].extSup - P[0].v, mH = P[H - 1].extSup - P[H - 1].v;

  $("titular").textContent = titular.replace(/\.\.$/, ".");   // "p. m.." → "p. m."
  $("historia-detalle").innerHTML =
    `A las ${hora(ahora.t)} el consumo fue <b>${conUnidad(ahora.v)}</b>, ${compara(difAhora)} para esa hora. ` +
    `El pico esperado (${diaHora(pico.t)}) queda ${compara(difPico)}. ` +
    `El margen de error pasa de <b>±${num(m1)}</b> en la próxima hora a <b>±${num(mH)}</b> al final del horizonte` +
    (H > 1 ? ": cuanto más lejos, menos certeza." : ".");
}

function kpi(id, valor, delta, deltaClase, nota) {
  $(`k-${id}`).innerHTML = valor;
  const d = $(`k-${id}-delta`); d.innerHTML = delta || "&nbsp;"; d.className = "kpi-delta " + (deltaClase || "");
  $(`k-${id}-nota`).innerHTML = nota || "&nbsp;";
}
const flecha = (d) => (d > 0.02 ? "▲" : d < -0.02 ? "▼" : "●");
const claseDelta = (d) => (d > 0.02 ? "sube" : d < -0.02 ? "baja" : "neutro");
const unidadHTML = UNIDAD ? `<span class="kpi-unidad">${UNIDAD}</span>` : "";

function pintarKPIs() {
  const P = E.pred, ahora = E.hist[E.hist.length - 1];
  const p0 = P[0];
  const d0 = (p0.v - ahora.v) / Math.abs(ahora.v || 1);
  kpi("proxima", num(p0.v) + unidadHTML, `${flecha(d0)} ${signo(d0)} frente al último dato`, claseDelta(d0),
      `${hora(p0.t)} · 80 %: ${num(p0.intInf)} a ${num(p0.intSup)}`);

  const pico = P.reduce((a, b) => (b.v > a.v ? b : a));
  const dp = (pico.v - pico.hab) / Math.abs(pico.hab || 1);
  kpi("pico", num(pico.v) + unidadHTML, `${flecha(dp)} ${signo(dp)} vs. lo habitual`, claseDelta(dp), diaHora(pico.t));

  const valle = P.reduce((a, b) => (b.v < a.v ? b : a));
  const dv = (valle.v - valle.hab) / Math.abs(valle.hab || 1);
  kpi("valle", num(valle.v) + unidadHTML, `${flecha(dv)} ${signo(dv)} vs. lo habitual`, claseDelta(dv), diaHora(valle.t));

  const mx = P.reduce((a, b) => (b.prob > a.prob ? b : a));
  const niv = nivelRiesgo(mx.prob);
  const txt = { bien: "Bajo", aviso: "Moderado", critico: "Alto" }[niv];
  $("kpi-riesgo").className = `kpi estado-${niv}`;
  kpi("riesgo", pct(mx.prob), `<span class="etiqueta ${niv}">${txt}</span>`, "",
      `Máximo a las ${hora(mx.t)} · umbral ${num(umbral())}`);

  const fin = new Date(new Date(E.ext.ultima_observacion).getTime() + 3600e3);   // la hora termina 60 min después
  const min = Math.max(0, Math.round((Date.now() - fin) / 60000));
  const fresco = min <= 90;
  const rell = E.ext.horas_rellenadas || 0;
  kpi("ultimo", completa(new Date(E.ext.ultima_observacion)),
      fresco ? `● Datos al día (hace ${min} min)` : `▲ Sin datos nuevos hace ${Math.round(min / 60)} h`,
      fresco ? "baja" : "sube",
      rell ? `${rell} h rellenadas de ${E.ext.horas_contexto_usadas}` : `Sin huecos en ${E.ext.horas_contexto_usadas} h`);
}

/* ---- gráficas: utilidades comunes ---- */
Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
Chart.defaults.font.size = 12;
Chart.defaults.color = C.tinta2;

function dibujar(id, config) {
  if (E.graficas[id]) E.graficas[id].destroy();
  E.graficas[id] = new Chart($(id), config);
}
const ejesBase = (extraY = {}) => ({
  x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, border: { color: "#d5d4ce" } },
  y: { grid: { color: C.rejilla }, border: { display: false }, ticks: { callback: (v) => num(v) }, ...extraY },
});
const tooltipBase = {
  backgroundColor: "#0b0b0b", padding: 10, cornerRadius: 8, titleFont: { weight: "600" }, boxPadding: 4,
};

// Línea vertical "Ahora" en la frontera entre lo real y lo pronosticado
const pluginAhora = {
  id: "ahora",
  afterDatasetsDraw(chart, _a, opts) {
    if (opts.indice == null) return;
    const x = chart.scales.x.getPixelForValue(opts.indice);
    const { top, bottom } = chart.chartArea, ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = "#7d7c76"; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = "#52514e"; ctx.font = "600 11px system-ui";
    ctx.fillText("Ahora", x + 6, top + 12);
    ctx.restore();
  },
};

/* ---- gráfica principal (requisito 1) ---- */
function pintarPrincipal() {
  const nHist = Number($("historia").value);
  const hist = E.hist.slice(-nHist), P = E.pred, n = hist.length;
  const ult = hist[n - 1];
  const etiquetas = [...hist.map((h) => h.t), ...P.map((p) => p.t)];
  const vacio = (k) => Array(k).fill(null);
  // Las series del pronóstico arrancan en el último punto real (sin hueco)
  const futuro = (f) => [...vacio(n - 1), ult.v, ...P.map(f)];

  const conjuntoAnom = new Set(E.anomalias.map((a) => +a.t));
  const u = umbral();
  const pico = P.reduce((a, b) => (b.v > a.v ? b : a));
  const iPico = n + P.indexOf(pico);
  const extTxt = pct(E.ext.confianza);

  const datasets = [
    { label: `Banda ${extTxt}`, data: futuro((p) => p.extSup), borderWidth: 0, pointRadius: 0, backgroundColor: C.azulExt, fill: "+1", order: 9 },
    { label: "ext-inf", data: futuro((p) => p.extInf), borderWidth: 0, pointRadius: 0, fill: false, order: 9 },
    { label: "Banda 80 %", data: futuro((p) => p.intSup), borderWidth: 0, pointRadius: 0, backgroundColor: C.azul80, fill: "+1", order: 8 },
    { label: "int-inf", data: futuro((p) => p.intInf), borderWidth: 0, pointRadius: 0, fill: false, order: 8 },
    { label: "Habitual a esa hora", data: [...vacio(n), ...P.map((p) => p.hab)], borderColor: C.habitual, borderWidth: 1.5, borderDash: [2, 3], pointRadius: 0, order: 4 },
    { label: "Real", data: [...hist.map((h) => h.v), ...vacio(P.length)], borderColor: C.real, borderWidth: 2, pointRadius: 0, tension: 0.25, order: 2 },
    { label: "Pronóstico", data: futuro((p) => p.v), borderColor: C.azul, borderWidth: 2.5, borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 5, tension: 0.25, order: 1 },
    { label: `Umbral (${num(u)})`, data: etiquetas.map(() => u), borderColor: C.aviso, borderWidth: 1.5, borderDash: [8, 4], pointRadius: 0, order: 5 },
    { label: "Anomalía", data: [...hist.map((h) => (conjuntoAnom.has(+h.t) ? h.v : null)), ...vacio(P.length)], showLine: false,
      pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: C.critico, pointBorderColor: "#fff", pointBorderWidth: 2, order: 0 },
    { label: "pico", data: etiquetas.map((_, i) => (i === iPico ? pico.v : null)), showLine: false,
      pointRadius: 6, pointBackgroundColor: C.azulOsc, pointBorderColor: "#fff", pointBorderWidth: 2.5, order: 0 },
  ];

  dibujar("g-principal", {
    type: "line",
    data: { labels: etiquetas, datasets },
    plugins: [pluginAhora],
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
      interaction: { mode: "index", intersect: false },
      scales: { ...ejesBase(), x: { ...ejesBase().x, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 9, callback(i) { return diaHora(etiquetas[i]); } } } },
      plugins: {
        ahora: { indice: n - 1 },
        legend: {
          position: "bottom", labels: { usePointStyle: true, boxWidth: 8, padding: 16,
            filter: (it) => !["ext-inf", "int-inf", "pico"].includes(it.text) && !(it.text === "Anomalía" && !conjuntoAnom.size) },
        },
        tooltip: {
          ...tooltipBase,
          callbacks: {
            title: (items) => completa(etiquetas[items[0].dataIndex]),
            label(c) {
              const y = c.parsed.y, l = c.dataset.label, i = c.dataIndex;
              if (y == null || ["ext-inf", "int-inf", "pico"].includes(l) || l.startsWith("Umbral")) return null;
              if (i === n - 1 && l !== "Real" && l !== "Anomalía") return null;
              if (l.startsWith("Banda")) {
                const inf = c.chart.data.datasets[c.datasetIndex + 1].data[i];
                return ` ${l}: ${num(inf)} a ${num(y)}`;
              }
              return ` ${l}: ${conUnidad(y)}`;
            },
            afterBody(items) {
              const i = items[0].dataIndex - n;
              return i >= 0 && P[i] ? [` P(> umbral): ${pct(P[i].prob)}`] : [];
            },
          },
        },
      },
    },
  });
}

/* ---- riesgo hora por hora ---- */
function pintarRiesgo() {
  const P = E.pred;
  $("riesgo-sub").textContent = `Umbral: ${conUnidad(umbral())}. Calculado con la distribución del pronóstico en cada hora.`;
  dibujar("g-riesgo", {
    type: "bar",
    data: { labels: P.map((p) => p.t), datasets: [{ label: "Probabilidad", data: P.map((p) => p.prob * 100),
      backgroundColor: P.map((p) => colorRiesgo(p.prob)), borderRadius: 4, borderSkipped: "bottom", maxBarThickness: 26 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { ...ejesBase({ min: 0, max: 100, ticks: { callback: (v) => `${v} %` } }),
                x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8, callback(i) { return hora(P[i].t); } } } },
      plugins: { legend: { display: false }, tooltip: { ...tooltipBase, callbacks: {
        title: (it) => completa(P[it[0].dataIndex].t),
        label: (c) => ` ${num(c.parsed.y, 1)} % de probabilidad (${{ bien: "bajo", aviso: "moderado", critico: "alto" }[nivelRiesgo(c.parsed.y / 100)]})`,
        afterLabel: (c) => ` Pronóstico: ${conUnidad(P[c.dataIndex].v)}`,
      } } },
    },
  });
}

/* ---- pronóstico vs habitual (divergente) ---- */
function pintarVsHabitual() {
  const P = E.pred;
  const dif = P.map((p) => p.v - p.hab);
  const arriba = dif.filter((d) => d > 0).length;
  dibujar("g-vs-habitual", {
    type: "bar",
    data: { labels: P.map((p) => p.t), datasets: [{ label: "Diferencia", data: dif,
      backgroundColor: dif.map((d) => (d >= 0 ? C.naranja : C.azul)), borderRadius: 4, maxBarThickness: 26 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { ...ejesBase({ ticks: { callback: (v) => (v > 0 ? "+" : "") + num(v) } }),
                x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8, callback(i) { return hora(P[i].t); } } } },
      plugins: { legend: { display: false }, tooltip: { ...tooltipBase, callbacks: {
        title: (it) => completa(P[it[0].dataIndex].t),
        label: (c) => { const p = P[c.dataIndex]; return [` Pronóstico: ${conUnidad(p.v)}`, ` Habitual: ${conUnidad(p.hab)}`, ` Diferencia: ${c.parsed.y > 0 ? "+" : ""}${num(c.parsed.y)}`]; },
      } } },
    },
  });
  $("vs-habitual-nota").innerHTML =
    `<span class="sw" style="background:${C.naranja}"></span>Por encima de lo habitual: <b>${arriba}</b> de ${P.length} h &nbsp; ` +
    `<span class="sw" style="background:${C.azul}"></span>Por debajo: <b>${P.length - arriba}</b> h.`;
}

function pintarTabla() {
  $("filas").innerHTML = E.pred.map((p) => `
    <tr><td>${completa(p.t)}</td><td><b>${num(p.v)}</b></td>
    <td>${num(p.intInf)} – ${num(p.intSup)}</td><td>${num(p.extInf)} – ${num(p.extSup)}</td>
    <td>${num(p.hab)}</td><td><span class="etiqueta ${nivelRiesgo(p.prob)}">${pct(p.prob, 1)}</span></td></tr>`).join("");
}

/* ---- pestaña patrones ---- */
function pintarPatrones() {
  const pf = E.perfil;
  const validas = pf.map((p, h) => ({ ...p, h })).filter((p) => isFinite(p.med));
  const hp = validas.reduce((a, b) => (b.med > a.med ? b : a));
  const hv = validas.reduce((a, b) => (b.med < a.med ? b : a));
  const amp = (hp.med - hv.med) / Math.abs(hv.med || 1);
  const dias = new Set(E.hist.map((h) => fechaCO(h.t))).size;
  $("patron-kpis").innerHTML = `
    <article class="kpi"><h3>Hora pico típica</h3><p class="kpi-valor">${ETIQ_HORA[hp.h]}</p><p class="kpi-nota">Mediana ${conUnidad(hp.med)}</p></article>
    <article class="kpi"><h3>Hora valle típica</h3><p class="kpi-valor">${ETIQ_HORA[hv.h]}</p><p class="kpi-nota">Mediana ${conUnidad(hv.med)}</p></article>
    <article class="kpi"><h3>Variación dentro del día</h3><p class="kpi-valor">${signo(amp)}</p><p class="kpi-nota">El pico supera al valle en esa proporción · ${dias} días analizados</p></article>`;

  // Mapa de calor día × hora
  const porDia = new Map();
  E.hist.forEach((h) => {
    const k = fechaCO(h.t);
    if (!porDia.has(k)) porDia.set(k, { t: h.t, v: Array(24).fill(null) });
    porDia.get(k).v[horaCO(h.t)] = h;
  });
  const valores = E.hist.map((h) => h.v);
  const cortes = RAMPA.slice(1).map((_, i) => cuantil(valores, (i + 1) / RAMPA.length));
  const colorDe = (v) => RAMPA[cortes.filter((c) => v > c).length];
  const anom = new Set(E.anomalias.map((a) => +a.t));

  let html = `<div></div>` + ETIQ_HORA.map((e, h) => `<div class="mc-hora">${h % 3 === 0 ? e.replace(" a. m.", "a").replace(" p. m.", "p") : ""}</div>`).join("");
  [...porDia.values()].forEach((d) => {
    html += `<div class="mc-dia">${fDia.format(d.t)}</div>`;
    d.v.forEach((h, i) => {
      if (!h) { html += `<div class="mc-celda vacia" data-tip="Sin dato"></div>`; return; }
      const tip = `<b>${completa(h.t)}</b><br>${conUnidad(h.v)} · habitual ${num(E.perfil[i].med)}${anom.has(+h.t) ? "<br>⚠ Anomalía" : ""}`;
      html += `<div class="mc-celda${anom.has(+h.t) ? " anomala" : ""}" style="background:${colorDe(h.v)}" data-tip="${tip.replace(/"/g, "&quot;")}"></div>`;
    });
  });
  $("mapa-calor").innerHTML = html;
  $("escala").innerHTML = `<span>${num(Math.min(...valores))}</span><div class="barra">${RAMPA.map((c) => `<span style="background:${c}"></span>`).join("")}</div><span>${num(Math.max(...valores))}</span><span style="margin-left:14px"><span class="sw" style="background:transparent;box-shadow:inset 0 0 0 2px ${C.critico}"></span>Anomalía</span>`;

  // Día típico: mediana + franja Q1–Q3 + hoy + ayer
  const hoy = fechaCO(E.hist[E.hist.length - 1].t);
  const ayer = fechaCO(new Date(E.hist[E.hist.length - 1].t.getTime() - 86400e3));
  const serieDia = (k) => { const d = porDia.get(k); return d ? d.v.map((h) => (h ? h.v : null)) : Array(24).fill(null); };
  dibujar("g-perfil", {
    type: "line",
    data: { labels: ETIQ_HORA, datasets: [
      { label: "Rango típico (Q1–Q3)", data: pf.map((p) => p.q3), borderWidth: 0, pointRadius: 0, backgroundColor: "rgba(154,152,144,0.22)", fill: "+1" },
      { label: "q1", data: pf.map((p) => p.q1), borderWidth: 0, pointRadius: 0, fill: false },
      { label: "Día típico (mediana)", data: pf.map((p) => p.med), borderColor: C.habitual, borderWidth: 2, borderDash: [2, 3], pointRadius: 0, tension: 0.3 },
      { label: "Ayer", data: serieDia(ayer), borderColor: "#86b6ef", borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
      { label: "Hoy", data: serieDia(hoy), borderColor: C.real, borderWidth: 2.5, pointRadius: 3, pointBackgroundColor: C.real, tension: 0.3 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      scales: { ...ejesBase(), x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } } },
      plugins: {
        legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8, padding: 16, filter: (it) => it.text !== "q1" } },
        tooltip: { ...tooltipBase, callbacks: { label(c) {
          if (c.parsed.y == null || c.dataset.label === "q1") return null;
          if (c.dataset.label.startsWith("Rango")) return ` Rango típico: ${num(pf[c.dataIndex].q1)} a ${num(c.parsed.y)}`;
          return ` ${c.dataset.label}: ${conUnidad(c.parsed.y)}`;
        } } },
      },
    },
  });
}

/* ---- pestaña calidad ---- */
function tarjetaKPI(titulo, valor, estado, etiqueta, nota) {
  return `<article class="kpi estado-${estado}"><h3>${titulo}</h3><p class="kpi-valor">${valor}</p>
    <p class="kpi-delta"><span class="etiqueta ${estado}">${etiqueta}</span></p><p class="kpi-nota">${nota}</p></article>`;
}

function pintarCalidad() {
  const usadas = E.ext.horas_contexto_usadas, rell = E.ext.horas_rellenadas || 0;
  const comp = 1 - rell / usadas;
  const fin = new Date(new Date(E.ext.ultima_observacion).getTime() + 3600e3);
  const min = Math.max(0, Math.round((Date.now() - fin) / 60000));
  const anom24 = E.anomalias.filter((a) => Date.now() - a.t < 86400e3).length;
  const cambio = cambioDeNivel();

  $("calidad-kpis").innerHTML =
    tarjetaKPI("Completitud", pct(comp, 1), comp >= 0.98 ? "bien" : comp >= 0.9 ? "aviso" : "critico",
      comp >= 0.98 ? "Excelente" : comp >= 0.9 ? "Aceptable" : "Baja", `${rell} de ${usadas} h rellenadas`) +
    tarjetaKPI("Frescura", min < 60 ? `${min} min` : `${num(min / 60, 1)} h`, min <= 90 ? "bien" : min <= 180 ? "aviso" : "critico",
      min <= 90 ? "Al día" : min <= 180 ? "Retrasado" : "Sin datos", "Tiempo desde la última hora completa") +
    tarjetaKPI("Anomalías (14 días)", String(E.anomalias.length), anom24 === 0 ? (E.anomalias.length > 10 ? "aviso" : "bien") : anom24 > 2 ? "critico" : "aviso",
      anom24 ? `${anom24} en las últimas 24 h` : "Ninguna hoy", `${pct(E.anomalias.length / E.hist.length, 1)} de las horas`) +
    tarjetaKPI("Cambio de nivel (24 h)", signo(cambio), Math.abs(cambio) <= 0.1 ? "bien" : Math.abs(cambio) <= 0.2 ? "aviso" : "critico",
      Math.abs(cambio) <= 0.1 ? "Estable" : Math.abs(cambio) <= 0.2 ? "Vigilar" : "Posible recalibración",
      "Últimas 24 h frente a lo habitual para esas horas");

  // Gráfica: real + franja robusta + anomalías
  const H = E.hist;
  const banda = (s) => H.map((h) => { const p = E.perfil[horaCO(h.t)]; return p.med + s * Z_ROBUSTO * p.esc; });
  const anomSet = new Set(E.anomalias.map((a) => +a.t));
  dibujar("g-anomalias", {
    type: "line",
    data: { labels: H.map((h) => h.t), datasets: [
      { label: "Rango esperado", data: banda(1), borderWidth: 0, pointRadius: 0, backgroundColor: "rgba(30,138,60,0.10)", fill: "+1" },
      { label: "inf", data: banda(-1), borderWidth: 0, pointRadius: 0, fill: false },
      { label: "Real", data: H.map((h) => h.v), borderColor: C.real, borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
      { label: "Anomalía", data: H.map((h) => (anomSet.has(+h.t) ? h.v : null)), showLine: false, pointRadius: 5,
        pointBackgroundColor: C.critico, pointBorderColor: "#fff", pointBorderWidth: 2 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      scales: { ...ejesBase(), x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10, callback(i) { return fDia.format(H[i].t); } } } },
      plugins: {
        legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8, padding: 16, filter: (it) => it.text !== "inf" } },
        tooltip: { ...tooltipBase, callbacks: {
          title: (it) => completa(H[it[0].dataIndex].t),
          label(c) {
            if (c.parsed.y == null || c.dataset.label === "inf") return null;
            if (c.dataset.label === "Rango esperado") return ` Rango esperado: ${num(c.chart.data.datasets[1].data[c.dataIndex])} a ${num(c.parsed.y)}`;
            return ` ${c.dataset.label}: ${conUnidad(c.parsed.y)}`;
          },
        } },
      },
    },
  });

  const filas = [...E.anomalias].reverse().slice(0, 30);
  $("filas-anomalias").innerHTML = filas.length ? filas.map((a) => `
    <tr><td>${completa(a.t)}</td><td><b>${num(a.v)}</b></td><td>${num(a.med)}</td>
    <td>${a.z > 0 ? "+" : "−"}${num(Math.abs(a.z), 1)} σ</td>
    <td><span class="etiqueta ${a.z > 0 ? "critico" : "aviso"}">${a.z > 0 ? "▲ Pico" : "▼ Caída"}</span></td></tr>`).join("")
    : `<tr><td colspan="5" style="text-align:center;color:var(--tinta-2)">No se detectaron anomalías en las últimas 2 semanas.</td></tr>`;
}

/* ---- pestaña modelo ---- */
function pintarModelo() {
  const m = E.modelo;
  if (!m) { $("ficha").innerHTML = `<dt>Estado</dt><dd>No se pudo leer /api/modelo</dd>`; return; }
  const edad = edadModeloDias();
  const rango = m.rango_entrenamiento || {};
  const aFecha = (s) => (s ? fFecha.format(new Date(s.replace(" ", "T") + "Z")) : "—");
  const filas = [
    ["Modelo", `SARIMA(${m.order.join(",")})(${m.seasonal_order.join(",")})`],
    ["Ciclo estacional", `${m.seasonal_order[3]} h (un día)`],
    ["Variable", `${m.field} · ${m.measurement}`],
    ["Datos de entrenamiento", `${aFecha(rango.inicio)} → ${aFecha(rango.fin)}`],
    ["Observaciones", `${num(m.n_observaciones, 0)} horas`],
    ["Entrenado", `${m.entrenado_en || "—"}${edad != null ? ` (hace ${num(edad, 1)} días)` : ""}`],
  ];
  if (m.versiones) filas.push(["Versiones", Object.entries(m.versiones).map(([k, v]) => `${k} ${v}`).join(" · ")]);
  $("ficha").innerHTML = filas.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");

  // Métricas
  const mt = m.metricas_test || {}, mi = m.metricas_ingenua || null;
  const promedio = media(E.hist.map((h) => h.v));
  const def = [["MAE", "Error medio", (v) => num(v)], ["RMSE", "Error cuadrático", (v) => num(v)], ["MAPE", "Error porcentual", (v) => `${num(v, 1)} %`]];
  $("metricas").innerHTML = def.filter(([k]) => mt[k] != null).map(([k, nombre, f]) => {
    let comp = "";
    if (mi && mi[k] != null) {
      const mejora = 1 - mt[k] / mi[k];
      comp = mejora > 0 ? `<span style="color:var(--bien)">▼ ${pct(mejora)} menos que la línea base (${f(mi[k])})</span>`
                        : `<span style="color:var(--critico)">▲ ${pct(-mejora)} más que la línea base (${f(mi[k])})</span>`;
    } else if (k === "MAE") comp = `≈ ${pct(mt[k] / Math.abs(promedio))} del consumo promedio`;
    return `<div class="metrica"><div class="nombre">${k} · ${nombre}</div><div class="valor">${f(mt[k])}</div><div class="comp">${comp}</div></div>`;
  }).join("") || `<p class="tarjeta-sub">El modelo no trae métricas de prueba.</p>`;

  const conGraf = mi && mt.MAE != null && mi.MAE != null;
  $("g-metricas").parentElement.hidden = !conGraf;
  if (conGraf) {
    const ks = ["MAE", "RMSE"].filter((k) => mt[k] != null && mi[k] != null);
    dibujar("g-metricas", {
      type: "bar",
      data: { labels: ks, datasets: [
        { label: "SARIMA (tu modelo)", data: ks.map((k) => mt[k]), backgroundColor: C.azul, borderRadius: 4, maxBarThickness: 34 },
        { label: "Línea base ingenua", data: ks.map((k) => mi[k]), backgroundColor: "#c3c2b7", borderRadius: 4, maxBarThickness: 34 },
      ] },
      options: { indexAxis: "y", responsive: true, maintainAspectRatio: false,
        scales: { x: { grid: { color: C.rejilla }, border: { display: false }, beginAtZero: true, ticks: { callback: (v) => num(v) } }, y: { grid: { display: false } } },
        plugins: { legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } }, tooltip: { ...tooltipBase } } },
    });
  }

  // Ancho de la banda según el horizonte
  const P = E.pred;
  dibujar("g-ancho", {
    type: "line",
    data: { labels: P.map((_, i) => `+${i + 1} h`), datasets: [
      { label: `Banda ${pct(E.ext.confianza)}`, data: P.map((p) => p.extSup - p.extInf), borderColor: C.azul, backgroundColor: C.azulExt, fill: "origin", borderWidth: 2, pointRadius: 0, tension: 0.3 },
      { label: "Banda 80 %", data: P.map((p) => p.intSup - p.intInf), borderColor: C.azulOsc, borderWidth: 1.5, borderDash: [4, 3], pointRadius: 0, tension: 0.3 },
    ] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      scales: { ...ejesBase({ beginAtZero: true }), x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } } },
      plugins: { legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } },
        tooltip: { ...tooltipBase, callbacks: { label: (c) => ` ${c.dataset.label}: ancho ${num(c.parsed.y)} (±${num(c.parsed.y / 2)})` } } } },
  });
  const a1 = P[0].extSup - P[0].extInf, aH = P[P.length - 1].extSup - P[P.length - 1].extInf;
  $("ancho-nota").textContent = P.length > 1
    ? `A +1 h el margen es ±${num(a1 / 2)}; a +${P.length} h es ±${num(aH / 2)} (${num(aH / a1, 1)} veces más ancho). Para decisiones finas, confía más en las primeras horas.`
    : `A +1 h el margen es ±${num(a1 / 2)}.`;

  pintarReentreno(edad, mt, mi);
}

function pintarReentreno(edad, mt, mi) {
  const cambio = cambioDeNivel();
  const anom24 = E.anomalias.filter((a) => Date.now() - a.t < 86400e3).length;
  const reglas = [
    edad == null ? ["med", "No se conoce la fecha de entrenamiento"]
      : edad <= 7 ? ["ok", `Modelo reciente: ${num(edad, 1)} días (límite 7)`]
      : edad <= 14 ? ["med", `Modelo de ${num(edad, 0)} días: conviene reentrenar esta semana`]
      : ["no", `Modelo de ${num(edad, 0)} días: superó el límite de 7`],
    Math.abs(cambio) <= 0.1 ? ["ok", `Nivel estable (${signo(cambio)} frente a lo habitual)`]
      : Math.abs(cambio) <= 0.2 ? ["med", `Nivel desplazado ${signo(cambio)}: vigilar`]
      : ["no", `Cambio de nivel ${signo(cambio)}: posible recalibración del sensor o carga nueva`],
    anom24 <= 2 ? ["ok", `${anom24} anomalías en las últimas 24 h`] : ["no", `${anom24} anomalías en las últimas 24 h`],
  ];
  if (mi && mt.MAE != null && mi.MAE != null) {
    reglas.push(mt.MAE < mi.MAE ? ["ok", "Le gana a la línea base ingenua"] : ["no", "No le gana a la línea base ingenua"]);
  }
  const nNo = reglas.filter((r) => r[0] === "no").length, nMed = reglas.filter((r) => r[0] === "med").length;
  const [cls, ico, txt, sub] = nNo ? ["critico", "⟳", "Sí, se recomienda reentrenar", "Al menos una condición indica que el modelo puede estar desactualizado."]
    : nMed ? ["aviso", "◔", "Pronto", "Todo funciona, pero hay señales que vigilar."]
    : ["bien", "✓", "No por ahora", "El modelo es reciente y los datos se comportan como en el entrenamiento."];
  const marca = { ok: "✓", med: "!", no: "✕" };
  $("reentreno").innerHTML = `
    <div class="veredicto ${cls}"><span class="icono">${ico}</span><div><strong>${txt}</strong><span class="tarjeta-sub">${sub}</span></div></div>
    <ul class="razones">${reglas.map(([e, t]) => `<li><span class="marca-r ${e}">${marca[e]}</span>${t}</li>`).join("")}</ul>`;
}

/* ---- pestaña arquitectura: flujo con estado en vivo ---- */
function pintarFlujo() {
  const s = E.salud, m = E.modelo, ok = !!E.ext;
  const enDocker = s && /^[0-9a-f]{12}$/.test(s.atendido_por);
  const nodos = [
    ["Sensor", "Mide el consumo del servidor", ok ? "ok" : "mal", s && s.field ? `${s.measurement} / ${s.field}` : "—"],
    ["InfluxDB", "Base de datos de series de tiempo", ok ? "ok" : s && !s.influx_configurado ? "mal" : "aviso",
      ok ? `Último dato: ${hora(new Date(E.ext.ultima_observacion))}` : "Sin respuesta"],
    ["Preparación", "Promedio horario y relleno de huecos", ok ? ((E.ext.horas_rellenadas || 0) ? "aviso" : "ok") : "mal",
      ok ? `${E.ext.horas_rellenadas || 0} h rellenadas de ${E.ext.horas_contexto_usadas}` : "—"],
    ["Modelo SARIMA", "Entrenado en Colab, exportado a JSON", m ? (s && s.modelo_demo ? "aviso" : "ok") : "mal",
      m ? `(${m.order.join(",")})(${m.seasonal_order.join(",")})` : "No cargado"],
    ["API FastAPI", enDocker ? "Corriendo dentro de Docker" : "Corriendo en el Codespace", s ? "ok" : "mal",
      s ? `atendido_por: ${s.atendido_por}` : "Sin respuesta"],
    ["Este panel", "HTML + Chart.js en el navegador", ok ? "ok" : "aviso",
      E.ultimaCarga ? `Actualizado ${fReloj.format(E.ultimaCarga)}` : "Esperando datos"],
  ];
  $("flujo").innerHTML = nodos.map(([t, q, e, v], i) =>
    `${i ? '<div class="flecha">→</div>' : ""}<div class="nodo ${e}"><div class="n-titulo">${t}</div><div class="n-que">${q}</div><div class="n-vivo">${v}</div></div>`).join("");
}

/* ------------------------------------------------------------ eventos */
function marcarAtajo() {
  $("horas-valor").textContent = `${$("horas").value} h`;
  document.querySelectorAll("[data-horas]").forEach((b) => b.classList.toggle("activo", b.dataset.horas === $("horas").value));
}
$("horas").addEventListener("input", marcarAtajo);
$("horas").addEventListener("change", cargarTodo);
$("confianza").addEventListener("change", cargarTodo);
$("historia").addEventListener("change", () => E.ext && pintarPrincipal());
$("umbral").addEventListener("change", () => {
  E.umbralManual = true;
  if (!E.ext) return;
  prepararDatos(); pintarTodo();
});
$("actualizar").addEventListener("click", cargarTodo);
document.querySelectorAll("[data-horas]").forEach((b) => b.addEventListener("click", () => {
  $("horas").value = b.dataset.horas; marcarAtajo(); cargarTodo();
}));

// Pestañas
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  document.querySelectorAll(".panel").forEach((p) => { p.hidden = p.id !== `tab-${b.dataset.tab}`; });
  Object.values(E.graficas).forEach((g) => g.resize());
}));

// Tooltip para el mapa de calor y las ayudas
const tip = $("tooltip");
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-tip],[data-ayuda]");
  if (!el) { tip.hidden = true; return; }
  tip.innerHTML = el.dataset.tip || el.dataset.ayuda;
  tip.hidden = false;
});
document.addEventListener("mousemove", (e) => {
  if (tip.hidden) return;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`; tip.style.top = `${e.clientY + 14}px`;
});

// Actualización automática
setInterval(() => { if ($("auto").checked && !document.hidden) cargarTodo(); }, REFRESCO_MS);

marcarAtajo();
cargarTodo();
