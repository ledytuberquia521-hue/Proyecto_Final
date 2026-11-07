"""
Carga del modelo SARIMA exportado desde Colab y generación de pronósticos.

Por qué JSON y no pickle:
  Un pickle de statsmodels solo carga con la MISMA versión de statsmodels,
  pandas y numpy con la que se creó, y Colab actualiza sus librerías sin
  avisar. Por eso desde Colab exportamos solo lo que define al modelo:
  órdenes (p,d,q)(P,D,Q,s) y parámetros estimados. Aquí reconstruimos el
  SARIMAX con los datos recientes de InfluxDB y aplicamos esos parámetros
  SIN reentrenar (`model.filter(params)`). Resultado: el pronóstico arranca
  desde la última hora real disponible, con los coeficientes aprendidos en Colab.
"""
from __future__ import annotations

import json
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from statsmodels.tsa.statespace.sarimax import SARIMAX


class ModeloSARIMA:
    def __init__(self, ruta: Path):
        with open(ruta, encoding="utf-8") as f:
            self.config = json.load(f)

        self.order = tuple(self.config["order"])
        self.seasonal_order = tuple(self.config["seasonal_order"])
        self.trend = self.config.get("trend")
        self.enforce_stationarity = self.config.get("enforce_stationarity", False)
        self.enforce_invertibility = self.config.get("enforce_invertibility", False)
        self.params: dict[str, float] = self.config["params"]

    @property
    def minimo_observaciones(self) -> int:
        p, d, q = self.order
        P, D, Q, s = self.seasonal_order
        return max(3 * s, s * D + d + max(p, P * s, q, Q * s) + 1, 30)

    def _construir(self, serie: pd.Series) -> SARIMAX:
        return SARIMAX(
            serie,
            order=self.order,
            seasonal_order=self.seasonal_order,
            trend=self.trend,
            enforce_stationarity=self.enforce_stationarity,
            enforce_invertibility=self.enforce_invertibility,
        )

    def pronosticar(self, serie: pd.Series, pasos: int, alpha: float = 0.05) -> pd.DataFrame:
        if len(serie) < self.minimo_observaciones:
            raise ValueError(
                f"Se necesitan al menos {self.minimo_observaciones} horas de datos "
                f"y solo hay {len(serie)}."
            )
        modelo = self._construir(serie)

        faltantes = [n for n in modelo.param_names if n not in self.params]
        if faltantes:
            raise ValueError(
                f"El JSON no tiene los parámetros {faltantes}. ¿Las órdenes del "
                f"modelo coinciden con las usadas en Colab?"
            )
        params = np.array([self.params[n] for n in modelo.param_names])

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            resultado = modelo.filter(params)
            pred = resultado.get_forecast(steps=pasos).summary_frame(alpha=alpha)

        pred = pred.rename(columns={
            "mean": "prediccion",
            "mean_ci_lower": "limite_inferior",
            "mean_ci_upper": "limite_superior",
        })[["prediccion", "limite_inferior", "limite_superior"]]
        pred.index.name = "tiempo"
        return pred

    def info(self) -> dict:
        """Metadatos para mostrar en el frontend (sin parámetros crudos)."""
        claves = ["order", "seasonal_order", "trend", "measurement", "field",
                  "entrenado_en", "n_observaciones", "metricas_test",
                  "rango_entrenamiento", "versiones"]
        return {k: self.config.get(k) for k in claves if k in self.config}


def cargar_modelo(ruta: Path) -> ModeloSARIMA | None:
    if not Path(ruta).exists():
        return None
    return ModeloSARIMA(ruta)
