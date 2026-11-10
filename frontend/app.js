// Frontend del pronóstico SARIMA.
// La API entrega las horas en UTC (terminan en "Z"); aquí todo se muestra en
// hora de Colombia con Intl.DateTimeFormat y la zona "America/Bogota".

const ZONA = "America/Bogota";

const fmtHora = new Intl.DateTimeFormat("es-CO", {
  timeZone: ZONA, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true,
});
const fmtCorto = new Intl.DateTimeFormat("es-CO", {
  timeZone: ZONA, day: "2-digit", month: "short", hour: "numeric", hour12: true,
});

const aColombia = (iso) => fmtHora.format(new Date(iso));
const aColombiaCorto = (iso) => fmtCorto.format(new Date(iso));
const num = (v) => Number(v).toLocaleString("es-CO", { maximumFractionDigits: 2 });

const $ = (id) => document.getElementById(id);
const ui = {
  horas: $("horas"), horasValor: $("horas-valor"), historia: $("historia"),
  confianza: $("confianza"), actualizar: $("actualizar"),
  error: $("error"), errorTexto: $("error-texto"), cargando: $("cargando"),
  filas: $("filas"), modelo: $("modelo"), subtitulo: $("subtitulo"),
  puntoSalud: $("punto-salud"), textoSalud: $("texto-salud"),
};

let grafica = null;
let unidad = "";   // nombre del field, para las etiquetas

// ------------------------------------------------------------ llamadas a la API
// Devuelve el JSON si la respuesta es exitosa; si no, lanza un Error con el
// texto de "detail" (que es como FastAPI entrega los errores).
async function pedir(url) {
  let respuesta;
  try {
    respuesta = await fetch(url);
  } catch {
    throw new Error("No hay conexión con la API. ¿Está corriendo uvicorn o el contenedor en el puerto 8000?");
  }
  let datos = null;
  try { datos = await respuesta.json(); } catch { /* respuesta sin JSON */ }

  if (!respuesta.ok) {
    let detalle = datos && datos.detail;
    if (Array.isArray(detalle)) {           // errores de validación (422)
      detalle = detalle.map((d) => d.msg).join("; ");
    }
    throw new Error(`(${respuesta.status}) ${detalle || respuesta.statusText || "Error desconocido"}`);
  }
  return datos;
}

function mostrarError(mensaje) {
  ui.errorTexto.textContent = mensaje;
  ui.error.hidden = false;
}
function ocultarError() { ui.error.hidden = true; }

// ------------------------------------------------------------ estado del servicio
async function cargarSalud() {
  try {
    const s = await pedir("/api/salud");
    let clase = "ok";
    let texto = `En línea · atendido por ${s.atendido_por}`;
    if (!s.modelo_cargado) { clase = "mal"; texto = "Sin modelo cargado"; }
    else if (!s.modo_demo && !s.influx_configurado) { clase = "mal"; texto = "InfluxDB sin configurar"; }
    else if (s.modelo_demo || s.modo_demo) { clase = "alerta"; texto += " · modelo demo"; }
    ui.puntoSalud.className = "punto " + clase;
    ui.textoSalud.textContent = texto;
    if (s.field) {
      unidad = s.field;
      ui.subtitulo.textContent = `Variable: ${s.field} · measurement: ${s.measurement}`;
    }
  } catch (e) {
    ui.puntoSalud.className = "punto mal";
    ui.textoSalud.textContent = "Servicio no disponible";
  }
}

async function cargarModelo() {
  try {
    const m = await pedir("/api/modelo");
    const filas = [
      ["Órdenes", `SARIMA(${m.order.join(",")})(${m.seasonal_order.join(",")})`],
      ["Variable", m.field || "—"],
      ["Entrenado", m.entrenado_en || "—"],
      ["Observaciones", m.n_observaciones ?? "—"],
    ];
    if (m.metricas_test) {
      for (const [k, v] of Object.entries(m.metricas_test)) filas.push([`${k.toUpperCase()} (test)`, num(v)]);
    }
    ui.modelo.innerHTML = filas.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  } catch (e) {
    ui.modelo.innerHTML = `<dt>Estado</dt><dd class="aviso">${e.message}</dd>`;
  }
}

// ------------------------------------------------------------ pronóstico
async function cargarPronostico() {
  const horas = ui.horas.value;
  const historia = ui.historia.value;
  const confianza = ui.confianza.value;

  ui.actualizar.disabled = true;
  ui.cargando.hidden = false;
  try {
    const d = await pedir(`/api/prediccion?horas=${horas}&historia=${historia}&confianza=${confianza}`);
    ocultarError();
    pintarIndicadores(d);
    pintarGrafica(d);
    pintarTabla(d);
  } catch (e) {
    mostrarError(e.message);
  } finally {
    ui.actualizar.disabled = false;
    ui.cargando.hidden = true;
  }
}

function pintarIndicadores(d) {
  const p = d.prediccion;
  const proxima = p[0];
  $("ind-proxima").textContent = num(proxima.prediccion);
  $("ind-proxima-det").textContent =
    `${aColombia(proxima.tiempo)} · entre ${num(proxima.limite_inferior)} y ${num(proxima.limite_superior)}`;

  const max = p.reduce((a, b) => (b.prediccion > a.prediccion ? b : a));
  const min = p.reduce((a, b) => (b.prediccion < a.prediccion ? b : a));
  $("ind-max").textContent = num(max.prediccion);
  $("ind-max-det").textContent = aColombia(max.tiempo);
  $("ind-min").textContent = num(min.prediccion);
  $("ind-min-det").textContent = aColombia(min.tiempo);

  $("ind-ultimo").textContent = aColombia(d.ultima_observacion);
  const rell = d.horas_rellenadas || 0;
  $("ind-ultimo-det").innerHTML = rell > 0
    ? `<span class="aviso">${rell} h sin dato rellenadas de ${d.horas_contexto_usadas}</span>`
    : `Sin huecos en las últimas ${d.horas_contexto_usadas} h`;
}

function pintarGrafica(d) {
  const hist = d.historico;
  const pred = d.prediccion;
  const etiquetas = [...hist.map((h) => h.tiempo), ...pred.map((p) => p.tiempo)].map(aColombiaCorto);

  const n = hist.length;
  const vacio = Array(n).fill(null);
  // El pronóstico arranca en el último punto real para que la línea no quede cortada.
  const ultimo = n ? hist[n - 1].valor : null;
  const unir = (arr) => (n ? [...Array(n - 1).fill(null), ultimo, ...arr] : arr);

  const serieHist = [...hist.map((h) => h.valor), ...Array(pred.length).fill(null)];
  const seriePred = unir(pred.map((p) => p.prediccion));
  const serieInf = unir(pred.map((p) => p.limite_inferior));
  const serieSup = unir(pred.map((p) => p.limite_superior));
  const pct = Math.round(d.confianza * 100);

  const datasets = [
    { label: `Límite superior (${pct} %)`, data: serieSup, borderWidth: 0, pointRadius: 0,
      backgroundColor: "rgba(11,122,117,0.16)", fill: "+1" },
    { label: `Límite inferior (${pct} %)`, data: serieInf, borderWidth: 0, pointRadius: 0, fill: false },
    { label: "Histórico", data: serieHist, borderColor: "#2f3e4e", backgroundColor: "#2f3e4e",
      borderWidth: 2, pointRadius: 0, tension: 0.2 },
    { label: "Pronóstico", data: seriePred, borderColor: "#0b7a75", backgroundColor: "#0b7a75",
      borderWidth: 2.5, borderDash: [6, 4], pointRadius: 2, tension: 0.2 },
  ];

  if (grafica) {
    grafica.data.labels = etiquetas;
    grafica.data.datasets = datasets;
    grafica.update();
    return;
  }
  grafica = new Chart($("grafica"), {
    type: "line",
    data: { labels: etiquetas, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      spanGaps: false,
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            // Una sola entrada para la banda de confianza.
            filter: (item) => !item.text.startsWith("Límite inferior"),
            generateLabels: (chart) => Chart.defaults.plugins.legend.labels.generateLabels(chart)
              .map((l) => (l.text.startsWith("Límite superior")
                ? { ...l, text: l.text.replace("Límite superior", "Intervalo de confianza") } : l)),
          },
        },
        tooltip: {
          callbacks: {
            label: (c) => (c.parsed.y == null ? null : `${c.dataset.label}: ${num(c.parsed.y)}`),
          },
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12, maxRotation: 0 }, grid: { display: false } },
        y: { title: { display: !!unidad, text: unidad } },
      },
    },
  });
}

function pintarTabla(d) {
  ui.filas.innerHTML = d.prediccion.map((p) => `
    <tr><td>${aColombia(p.tiempo)}</td><td>${num(p.prediccion)}</td>
        <td>${num(p.limite_inferior)}</td><td>${num(p.limite_superior)}</td></tr>`).join("");
}

// ------------------------------------------------------------ eventos
function marcarAtajo() {
  document.querySelectorAll("[data-horas]").forEach((b) =>
    b.classList.toggle("activo", b.dataset.horas === ui.horas.value));
}

ui.horas.addEventListener("input", () => { ui.horasValor.textContent = ui.horas.value; marcarAtajo(); });
ui.horas.addEventListener("change", cargarPronostico);
ui.historia.addEventListener("change", cargarPronostico);
ui.confianza.addEventListener("change", cargarPronostico);
ui.actualizar.addEventListener("click", () => { cargarSalud(); cargarPronostico(); });
document.querySelectorAll("[data-horas]").forEach((b) => b.addEventListener("click", () => {
  ui.horas.value = b.dataset.horas;
  ui.horasValor.textContent = b.dataset.horas;
  marcarAtajo();
  cargarPronostico();
}));

marcarAtajo();
cargarSalud().then(() => { cargarModelo(); cargarPronostico(); });
