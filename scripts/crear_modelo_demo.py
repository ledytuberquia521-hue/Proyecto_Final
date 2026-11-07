"""
Crea un modelo SARIMA de DEMOSTRACIÓN con datos sintéticos y lo guarda en
models/sarima_config.json con el mismo formato que exporta el notebook de Colab.

Úselo solo para probar la API y el frontend antes de tener el modelo real:
    python scripts/crear_modelo_demo.py
    DEMO_MODE=true uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

Cuando suba el modelo entrenado en Colab, este archivo se reemplaza.
"""
import json
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels
from statsmodels.tsa.statespace.sarimax import SARIMAX

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))
from app.influx import serie_demo  # noqa: E402

ORDER = (1, 0, 1)
SEASONAL_ORDER = (1, 1, 1, 24)

serie = serie_demo(24 * 21)
modelo = SARIMAX(serie, order=ORDER, seasonal_order=SEASONAL_ORDER,
                 enforce_stationarity=False, enforce_invertibility=False)
with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    res = modelo.fit(disp=False)

config = {
    "tipo": "SARIMAX (statsmodels)",
    "order": list(ORDER),
    "seasonal_order": list(SEASONAL_ORDER),
    "trend": None,
    "enforce_stationarity": False,
    "enforce_invertibility": False,
    "freq": "h",
    "params": {k: float(v) for k, v in res.params.items()},
    "measurement": "demo",
    "field": "temperatura_sintetica",
    "n_observaciones": int(len(serie)),
    "rango_entrenamiento": {"inicio": str(serie.index[0]), "fin": str(serie.index[-1])},
    "metricas_test": None,
    "aic": float(res.aic),
    "entrenado_en": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    "versiones": {"statsmodels": statsmodels.__version__, "pandas": pd.__version__,
                  "numpy": np.__version__},
}

destino = RAIZ / "models" / "sarima_config.json"
destino.parent.mkdir(exist_ok=True)
destino.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")
print(f"Modelo demo guardado en {destino}")
print(f"AIC={res.aic:.1f}  params={list(res.params.index)}")
