"""
Acceso a InfluxDB 2.x con el cliente oficial `influxdb-client` y consultas Flux.

La función principal, `leer_serie_horaria`, devuelve una pd.Series con índice
horario regular (UTC, sin zona) lista para alimentar el SARIMA. Es la MISMA
lógica que usa el notebook de Colab para entrenar, así el modelo ve en
producción datos preparados igual que en el entrenamiento.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from influxdb_client import InfluxDBClient

from . import config

_client: InfluxDBClient | None = None


def get_client() -> InfluxDBClient:
    """Crea el cliente una sola vez y lo reutiliza."""
    global _client
    if _client is None:
        _client = InfluxDBClient(
            url=config.INFLUX_URL,
            token=config.INFLUX_TOKEN,
            org=config.INFLUX_ORG,
            timeout=30_000,
        )
    return _client


def cerrar_client() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None


def construir_flux(horas: int) -> str:
    """Consulta Flux: últimas `horas` horas, promedio por hora."""
    filtro_tag = ""
    if config.INFLUX_TAG_KEY and config.INFLUX_TAG_VALUE:
        filtro_tag = (f'\n  |> filter(fn: (r) => r["{config.INFLUX_TAG_KEY}"] == '
                      f'"{config.INFLUX_TAG_VALUE}")')
    return f'''
from(bucket: "{config.INFLUX_BUCKET}")
  |> range(start: -{horas + 2}h)
  |> filter(fn: (r) => r["_measurement"] == "{config.INFLUX_MEASUREMENT}")
  |> filter(fn: (r) => r["_field"] == "{config.INFLUX_FIELD}"){filtro_tag}
  |> aggregateWindow(every: 1h, fn: mean, createEmpty: false, timeSrc: "_start")
  |> keep(columns: ["_time", "_value"])
  |> sort(columns: ["_time"])
'''


def preparar_serie_horaria(tiempos, valores, horas: int) -> pd.Series:
    """
    Convierte (tiempos, valores) en una serie horaria regular:
      1. Índice en UTC sin zona horaria (statsmodels lo prefiere así).
      2. Si hay varias tablas (varios tags), promedia por hora.
      3. Descarta la hora en curso (está incompleta).
      4. Rellena huecos (interpolación hasta 6 h, luego valor vecino) y anota
         cuántas horas rellenó en s.attrs["horas_rellenadas"].
    """
    if len(tiempos) == 0:
        return pd.Series(dtype=float, name="valor")

    # floor("h"): la primera ventana de aggregateWindow empieza en el inicio
    # del rango (p.ej. 09:47:31), no en una hora exacta. Sin redondear, esa
    # marca desalinea toda la serie.
    idx = pd.to_datetime(pd.Series(tiempos), utc=True).dt.tz_localize(None).dt.floor("h")
    s = pd.Series(np.asarray(valores, dtype=float), index=pd.DatetimeIndex(idx), name="valor")
    s = s.groupby(level=0).mean().sort_index()

    hora_actual = pd.Timestamp.now(tz="UTC").tz_localize(None).floor("h")
    s = s[s.index < hora_actual]
    if s.empty:
        return s

    rango = pd.date_range(s.index.min(), s.index.max(), freq="h")
    s = s.reindex(rango)
    huecos = s.isna()                     # horas sin dato antes de rellenar
    s = s.interpolate(method="time", limit=6).ffill().bfill()
    s.index.name = "tiempo"
    s = s.iloc[-horas:].asfreq("h")
    s.attrs["horas_rellenadas"] = int(huecos.reindex(s.index).sum())
    return s


def leer_serie_horaria(horas: int) -> pd.Series:
    """Lee las últimas `horas` horas (o datos sintéticos en DEMO_MODE)."""
    if config.DEMO_MODE:
        return serie_demo(horas)

    tablas = get_client().query_api().query(construir_flux(horas), org=config.INFLUX_ORG)
    tiempos, valores = [], []
    for tabla in tablas:
        for registro in tabla.records:
            if registro.get_value() is not None:
                tiempos.append(registro.get_time())
                valores.append(registro.get_value())
    return preparar_serie_horaria(tiempos, valores, horas)


def serie_demo(horas: int, semilla: int = 7) -> pd.Series:
    """Serie sintética tipo temperatura: ciclo diario + ruido."""
    fin = pd.Timestamp.now(tz="UTC").tz_localize(None).floor("h") - pd.Timedelta(hours=1)
    idx = pd.date_range(end=fin, periods=horas, freq="h")
    hora_local = (idx.hour - 5) % 24          # Medellín UTC-5: pico ~15:00 local
    # El ruido depende solo de la hora (no de cuántas horas se piden), así
    # /api/historico y /api/prediccion muestran el mismo valor para cada hora.
    ruido = np.array([np.random.default_rng([semilla, int(t.timestamp() // 3600)]).normal(0, 0.6)
                      for t in idx])
    valores = 22 + 5 * np.sin(2 * np.pi * (hora_local - 9) / 24) + ruido
    s = pd.Series(valores, index=idx, name="valor")
    s.index.name = "tiempo"
    return s.asfreq("h")
