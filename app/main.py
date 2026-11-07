"""
API de pronóstico horario con SARIMA sobre datos de InfluxDB 2.x.

Ejecutar (desde la raíz del repositorio):
    uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

Documentación interactiva: /docs
Frontend: /
"""
from __future__ import annotations

import socket
from contextlib import asynccontextmanager

import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import config, influx
from .model import cargar_modelo

estado: dict = {"modelo": None}


def _activar_modelo(modelo) -> None:
    """Guarda el modelo y, si no se definieron INFLUX_MEASUREMENT/FIELD/TAG,
    usa los que quedaron registrados en el JSON exportado desde Colab."""
    estado["modelo"] = modelo
    if modelo is None:
        return
    cfg = modelo.config
    if not config.INFLUX_MEASUREMENT and cfg.get("measurement"):
        config.INFLUX_MEASUREMENT = cfg["measurement"]
    if not config.INFLUX_FIELD and cfg.get("field"):
        config.INFLUX_FIELD = cfg["field"]
    tag = cfg.get("tag") or {}
    if not config.INFLUX_TAG_KEY and len(tag) == 1:
        config.INFLUX_TAG_KEY, config.INFLUX_TAG_VALUE = next(iter(tag.items()))


@asynccontextmanager
async def lifespan(app: FastAPI):
    _activar_modelo(cargar_modelo(config.MODEL_PATH))
    yield
    influx.cerrar_client()


app = FastAPI(
    title="API de pronóstico SARIMA + InfluxDB",
    description="Consulta series de InfluxDB 2.x y pronostica las próximas horas "
                "con un modelo SARIMA entrenado en Google Colab.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],       # en producción, restrinja a su dominio
    allow_methods=["GET"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------- utilidades
def _iso(ts: pd.Timestamp) -> str:
    """Las marcas de tiempo internas son UTC sin zona; se envían con 'Z'."""
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


def _serie_a_lista(s: pd.Series) -> list[dict]:
    return [{"tiempo": _iso(t), "valor": round(float(v), 4)} for t, v in s.items()]


def _verificar_fuente():
    if not config.DEMO_MODE and not config.influx_configurado():
        raise HTTPException(
            status_code=503,
            detail="Faltan variables de InfluxDB (INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, "
                   "INFLUX_BUCKET, INFLUX_MEASUREMENT, INFLUX_FIELD). "
                   "Configúrelas como Codespaces secrets o en .env, o use DEMO_MODE=true.",
        )


def _leer(horas: int) -> pd.Series:
    _verificar_fuente()
    try:
        return influx.leer_serie_horaria(horas)
    except Exception as e:  # errores de red, token, Flux...
        raise HTTPException(status_code=502, detail=f"Error consultando InfluxDB: {e}")


# ---------------------------------------------------------------- endpoints
@app.get("/api/salud", tags=["sistema"])
def salud():
    """Estado del servicio: ¿hay modelo cargado?, ¿Influx configurado?"""
    return {
        "estado": "ok",
        # Nombre de la máquina que responde. Dentro de Docker coincide con el
        # CONTAINER ID que muestra `docker ps`; fuera de Docker, con el Codespace.
        "atendido_por": socket.gethostname(),
        "modo_demo": config.DEMO_MODE,
        "influx_configurado": config.influx_configurado(),
        "modelo_cargado": estado["modelo"] is not None,
        # True si models/sarima_config.json es el de crear_modelo_demo.py
        "modelo_demo": estado["modelo"] is not None
                       and estado["modelo"].config.get("measurement") == "demo",
        "measurement": config.INFLUX_MEASUREMENT or None,
        "field": config.INFLUX_FIELD or None,
    }


@app.get("/api/historico", tags=["datos"])
def historico(horas: int = Query(48, ge=1, le=24 * 60, description="Horas hacia atrás")):
    """Promedios horarios de las últimas `horas` horas leídos de InfluxDB."""
    s = _leer(horas)
    if s.empty:
        raise HTTPException(404, "InfluxDB no devolvió datos para ese rango/measurement/field.")
    return {"n": len(s), "horas_rellenadas": s.attrs.get("horas_rellenadas", 0),
            "datos": _serie_a_lista(s)}


@app.get("/api/prediccion", tags=["modelo"])
def prediccion(
    horas: int = Query(12, ge=1, description="Horas a pronosticar"),
    historia: int = Query(48, ge=0, le=24 * 30, description="Horas de historia a devolver para graficar"),
    confianza: float = Query(0.95, gt=0.5, lt=1.0, description="Nivel del intervalo de confianza"),
):
    """Pronóstico SARIMA de las próximas `horas` horas, con intervalo de confianza."""
    modelo = estado["modelo"]
    if modelo is None:
        raise HTTPException(
            503,
            "No hay modelo cargado. Entrénelo en Colab y suba "
            "models/sarima_config.json al repositorio.",
        )
    if horas > config.MAX_HORAS_PREDICCION:
        raise HTTPException(422, f"Máximo {config.MAX_HORAS_PREDICCION} horas de pronóstico.")

    contexto = max(config.HORAS_CONTEXTO, modelo.minimo_observaciones, historia)
    serie = _leer(contexto)
    try:
        pred = modelo.pronosticar(serie, pasos=horas, alpha=1 - confianza)
    except ValueError as e:
        raise HTTPException(422, str(e))

    return {
        "ultima_observacion": _iso(serie.index[-1]),
        "horas_contexto_usadas": len(serie),
        "horas_rellenadas": serie.attrs.get("horas_rellenadas", 0),
        "confianza": confianza,
        "historico": _serie_a_lista(serie.iloc[-historia:]) if historia else [],
        "prediccion": [
            {
                "tiempo": _iso(t),
                "prediccion": round(float(r.prediccion), 4),
                "limite_inferior": round(float(r.limite_inferior), 4),
                "limite_superior": round(float(r.limite_superior), 4),
            }
            for t, r in pred.iterrows()
        ],
    }


@app.get("/api/modelo", tags=["modelo"])
def info_modelo():
    """Metadatos del modelo exportado desde Colab (órdenes, métricas, fechas)."""
    if estado["modelo"] is None:
        raise HTTPException(503, "No hay modelo cargado.")
    return estado["modelo"].info()


@app.post("/api/modelo/recargar", tags=["modelo"])
def recargar_modelo():
    """Vuelve a leer models/sarima_config.json sin reiniciar el servidor
    (útil después de hacer `git pull` con un modelo nuevo)."""
    _activar_modelo(cargar_modelo(config.MODEL_PATH))
    if estado["modelo"] is None:
        raise HTTPException(404, "No se encontró models/sarima_config.json")
    return {"recargado": True, **estado["modelo"].info()}


# ---------------------------------------------------------------- frontend
FRONTEND_DIR = config.BASE_DIR / "frontend"
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/", include_in_schema=False)
def inicio():
    return FileResponse(FRONTEND_DIR / "index.html")
