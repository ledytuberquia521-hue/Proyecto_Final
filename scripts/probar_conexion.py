"""
Verifica la conexión con InfluxDB y muestra qué hay en el bucket.

    python scripts/probar_conexion.py

Imprime los measurements, los fields de su measurement y las últimas horas
de la serie que usará la API. Úselo para confirmar los valores de
INFLUX_MEASUREMENT e INFLUX_FIELD.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config, influx  # noqa: E402

faltan = [n for n in ["INFLUX_URL", "INFLUX_TOKEN", "INFLUX_ORG", "INFLUX_BUCKET"]
          if not getattr(config, n)]
if faltan:
    sys.exit(f"Faltan variables de entorno: {', '.join(faltan)}")

client = influx.get_client()
print("Ping:", "OK" if client.ping() else "SIN RESPUESTA")
q = client.query_api()

flux_meas = f'''
import "influxdata/influxdb/schema"
schema.measurements(bucket: "{config.INFLUX_BUCKET}", start: -30d)
'''
measurements = [r.get_value() for t in q.query(flux_meas, org=config.INFLUX_ORG) for r in t.records]
print(f"\nMeasurements en '{config.INFLUX_BUCKET}' (últimos 30 días):", measurements)

if config.INFLUX_MEASUREMENT:
    flux_fields = f'''
import "influxdata/influxdb/schema"
schema.measurementFieldKeys(bucket: "{config.INFLUX_BUCKET}",
                            measurement: "{config.INFLUX_MEASUREMENT}", start: -30d)
'''
    fields = [r.get_value() for t in q.query(flux_fields, org=config.INFLUX_ORG) for r in t.records]
    print(f"Fields de '{config.INFLUX_MEASUREMENT}':", fields)

if config.influx_configurado():
    serie = influx.leer_serie_horaria(72)
    print(f"\nSerie horaria ({config.INFLUX_MEASUREMENT}/{config.INFLUX_FIELD}): "
          f"{len(serie)} horas")
    print(serie.tail(10))
else:
    print("\nDefina INFLUX_MEASUREMENT e INFLUX_FIELD para ver la serie.")

influx.cerrar_client()
