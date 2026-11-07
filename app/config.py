"""
Configuración central de la aplicación.

Todas las credenciales se leen de variables de entorno:
  - En Codespaces: como *Codespaces secrets*.
  - En Docker: con `docker run -e ...` o `--env-file .env`. El token NUNCA
    se copia dentro de la imagen.
  - En local: en un archivo .env (que NUNCA se sube a GitHub).
"""
import os
from pathlib import Path

from dotenv import load_dotenv

# Carga .env si existe (en la raíz del repositorio). No reemplaza
# variables que ya existan, así que los Codespaces secrets tienen prioridad.
load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent   # raíz del repositorio

# --- InfluxDB 2.x -----------------------------------------------------------
INFLUX_URL = os.getenv("INFLUX_URL", "")            # p.ej. https://us-east-1-1.aws.cloud2.influxdata.com
INFLUX_TOKEN = os.getenv("INFLUX_TOKEN", "")
INFLUX_ORG = os.getenv("INFLUX_ORG", "")
INFLUX_BUCKET = os.getenv("INFLUX_BUCKET", "")

# Qué serie se consulta dentro del bucket
INFLUX_MEASUREMENT = os.getenv("INFLUX_MEASUREMENT", "")   # p.ej. "sensores"
INFLUX_FIELD = os.getenv("INFLUX_FIELD", "")               # p.ej. "temperatura"
# Filtro opcional por tag (p.ej. INFLUX_TAG_KEY=device, INFLUX_TAG_VALUE=esp32_01)
INFLUX_TAG_KEY = os.getenv("INFLUX_TAG_KEY", "")
INFLUX_TAG_VALUE = os.getenv("INFLUX_TAG_VALUE", "")

# --- Modelo -----------------------------------------------------------------
MODEL_PATH = Path(os.getenv("MODEL_PATH", BASE_DIR / "models" / "sarima_config.json"))

# Horas de historia que se le pasan al modelo para "ubicarlo" en el presente
# antes de pronosticar. Debe cubrir varias temporadas (s=24 -> mínimo ~3 días).
HORAS_CONTEXTO = int(os.getenv("HORAS_CONTEXTO", "336"))   # 14 días
MAX_HORAS_PREDICCION = int(os.getenv("MAX_HORAS_PREDICCION", "72"))

# --- Modo demo --------------------------------------------------------------
# Con DEMO_MODE=true la API genera datos sintéticos en lugar de consultar
# InfluxDB. Sirve para probar Codespaces + frontend antes de conectar la base.
DEMO_MODE = os.getenv("DEMO_MODE", "false").lower() in ("1", "true", "yes", "si", "sí")


def influx_configurado() -> bool:
    return all([INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET,
                INFLUX_MEASUREMENT, INFLUX_FIELD])
