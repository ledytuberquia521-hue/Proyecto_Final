# Proyecto final · Pronóstico de series de tiempo en producción

**Computación Avanzada — Cierre del curso**

Vas a construir un servicio web que pronostica las próximas horas de una variable medida por sensores. Los datos vienen de **InfluxDB**, el modelo es un **SARIMA** que tú entrenas en **Google Colab**, la API está hecha en **FastAPI** y todo corre en **GitHub Codespaces**. Al final lo empaquetas en un **contenedor Docker**.

## Qué recibes y qué construyes

La API ya está hecha: consulta InfluxDB, carga tu modelo y entrega el pronóstico en JSON. **No necesitas modificarla.** Tú construyes las tres piezas que la convierten en un servicio completo:

| Pieza | ¿Quién la hace? |
|---|---|
| Entorno del Codespace (`.devcontainer/`) | ✅ Viene lista |
| API (`app/`) | ✅ Viene lista |
| Notebook de entrenamiento (`notebooks/`) | ✅ Viene listo, **tú lo adaptas a tu serie** |
| **Modelo** (`models/sarima_config.json`) | ✏️ **Tú lo entrenas** (Fase 1) |
| **Frontend** (`frontend/index.html`) | ✏️ **Tú lo diseñas** a partir de un esqueleto (Fase 2) |
| **Contenedor** (`Dockerfile`, `.dockerignore`) | ✏️ **Tú lo escribes** (Fase 4) |

| Fase | Dónde | Qué haces | Pregunta que responde |
|---|---|---|---|
| 0 | GitHub | Crear tu repo, abrir el Codespace, guardar credenciales | — |
| 1 | Colab | Entrenar tu modelo SARIMA | ¿Qué modelo describe mi serie? |
| 2 | Codespaces | Diseñar tu frontend | ¿Cómo lo ve un usuario? |
| 3 | Codespaces | Ejecutar el servicio completo **sin Docker** | ¿Funciona mi código? |
| 4 | Codespaces | Ejecutar el servicio **dentro de un contenedor** | ¿Funciona mi contenedor? |

> Las fases 1 y 2 son independientes: en un equipo, una persona puede entrenar el modelo mientras otra diseña el frontend.

## Estructura del repositorio

```
.
├── .devcontainer/devcontainer.json   ← máquina del Codespace (Python + Docker)
├── app/                              ← la API (no la modifiques)
│   ├── main.py                       ← endpoints y servidor del frontend
│   ├── config.py                     ← lee las variables de entorno
│   ├── influx.py                     ← consulta InfluxDB y arma la serie horaria
│   └── model.py                      ← carga tu modelo y pronostica
├── frontend/
│   └── index.html                    ← ESQUELETO: lo conviertes en tu interfaz (Fase 2)
├── models/                           ← aquí va TU sarima_config.json (Fase 1)
├── notebooks/
│   └── entrenamiento_sarima_colab.ipynb
├── scripts/
│   ├── probar_conexion.py            ← muestra qué hay en tu bucket
│   └── crear_modelo_demo.py          ← modelo de prueba para trabajar sin datos reales
├── pruebas.http                      ← peticiones de prueba a la API
├── requirements.txt
└── .env.example
```

---

## Fase 0 — Preparar tu repositorio

### 0.1 Crea tu copia y abre el Codespace

1. En la página de este repositorio: **Use this template → Create a new repository**, en **tu** cuenta.
2. En tu repositorio: **Code → Codespaces → Create codespace on main**. La primera vez tarda unos minutos.

### 0.2 Guarda las credenciales de InfluxDB

El profesor te entrega la URL, el token, la org y el bucket. **El token nunca va en el código.**

1. En tu repositorio: **Settings → Secrets and variables → Codespaces → New repository secret**.
2. Crea los cuatro: `INFLUX_URL`, `INFLUX_TOKEN`, `INFLUX_ORG` e `INFLUX_BUCKET`.
3. En el Codespace aparecerá un aviso para recargar: **Reload**. Si no aparece: `F1` → **Codespaces: Rebuild Container**.

### 0.3 Verifica

En la terminal del Codespace:

```bash
python --version
docker --version
echo ${#INFLUX_TOKEN}
python scripts/probar_conexion.py
```

`echo ${#INFLUX_TOKEN}` muestra cuántos caracteres tiene el token sin mostrarlo. El último comando lista los **measurements** del bucket. Para ver los **fields** de uno de ellos:

```bash
INFLUX_MEASUREMENT=nombre_del_measurement python scripts/probar_conexion.py
```

Anota el measurement y el field de **tu** serie: los necesitas en la Fase 1.

**✅ Checklist Fase 0**
- [ ] La terminal no muestra el mensaje *recovery mode*.
- [ ] `docker --version` responde.
- [ ] `echo ${#INFLUX_TOKEN}` da un número mayor que 0.
- [ ] `probar_conexion.py` muestra `Ping: OK` y conoces tu measurement y tu field.

---

## Fase 1 — Tu modelo (Colab)

1. En Colab: **Archivo → Abrir notebook → pestaña GitHub** → tu repositorio → `notebooks/entrenamiento_sarima_colab.ipynb`.
2. En **Secrets** (🔑) crea `INFLUX_URL`, `INFLUX_TOKEN`, `INFLUX_ORG` e `INFLUX_BUCKET`, y activa **Acceso al notebook** en cada uno.
3. En la celda **0. Configuración** escribe tu `MEASUREMENT` y tu `FIELD`.
4. Ejecuta las celdas **en orden**, una por una, y lee lo que muestra cada una. El notebook elige solo el mejor modelo.
5. Descarga `sarima_config.json` (sección 6, opción A), arrástralo a la carpeta `models/` del Codespace y súbelo:

   ```bash
   git add models/sarima_config.json
   git commit -m "Modelo SARIMA entrenado en Colab"
   git push
   ```

6. Guarda el notebook ejecutado en tu repo: en Colab, **Archivo → Guardar una copia en GitHub** → carpeta `notebooks/`.

> **Recuerda:** InfluxDB guarda las horas en **UTC**. Colombia está en UTC−5: las 15:00 UTC son las 10:00 a. m. en Colombia.

**✅ Checklist Fase 1**
- [ ] La sección 5 muestra el MAE de tu SARIMA y el de la línea base ingenua (si tu SARIMA no gana, no pasa nada).
- [ ] La verificación de la sección 6 dice `Diferencia máxima API vs. modelo original: 0.0`.
- [ ] `models/sarima_config.json` y el notebook ejecutado están en tu repo.

---

## Fase 2 — Tu frontend

`frontend/index.html` es un **esqueleto**: pide el pronóstico a la API y lo muestra en una tabla sin formato. Conviértelo en una interfaz que alguien quiera usar.

### Trabajar sin modelo todavía

Si tu modelo aún no está listo, usa el modo demo con datos sintéticos:

```bash
python scripts/crear_modelo_demo.py
DEMO_MODE=true uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Abre el puerto 8000 (pestaña **Puertos** → 🌐). Con `--reload`, cada vez que guardas un cambio basta con recargar la página.

> El modelo demo se guarda en `models/sarima_config.json`. **No lo subas a GitHub**: reemplázalo por tu modelo real de la Fase 1.

### Requisitos mínimos

1. **Una gráfica** con el histórico, el pronóstico y el intervalo de confianza.
2. **Las horas en hora de Colombia.** La API las entrega en UTC (terminan en `Z`).
3. **Al menos un indicador destacado:** valor de la próxima hora, máximo esperado, hora del último dato…
4. **Controles** para elegir cuántas horas pronosticar.
5. **Un mensaje claro** cuando la API responde con error.

El diseño es libre. Puedes cargar cualquier librería de gráficas desde un CDN (Chart.js, Plotly, ECharts…) y poner archivos `.css` o `.js` en la carpeta `frontend/`: se sirven en `/static/<nombre>`.

### Lo que entrega la API

Pruébalo en `/docs` o en el archivo `pruebas.http`. El endpoint principal:

`GET /api/prediccion?horas=12&historia=48&confianza=0.95`

```json
{
  "ultima_observacion": "2026-10-27T15:00:00Z",
  "horas_contexto_usadas": 336,
  "horas_rellenadas": 0,
  "confianza": 0.95,
  "historico": [
    {"tiempo": "2026-10-27T15:00:00Z", "valor": 177.56}
  ],
  "prediccion": [
    {"tiempo": "2026-10-27T16:00:00Z", "prediccion": 266.94,
     "limite_inferior": 143.34, "limite_superior": 390.54}
  ]
}
```

| Endpoint | Para qué sirve |
|---|---|
| `GET /api/prediccion` | Pronóstico + intervalo + histórico para graficar |
| `GET /api/historico?horas=48` | Solo el histórico |
| `GET /api/modelo` | Órdenes del SARIMA, métricas y fecha de entrenamiento |
| `GET /api/salud` | Estado del servicio y `atendido_por` (lo usarás en la Fase 4) |

`horas_rellenadas` cuenta las horas sin dato que la API rellenó (por interpolación o con el valor vecino). Si es alto, el sensor estuvo caído y el pronóstico es menos confiable: es un buen dato para mostrar en tu frontend.

Si la respuesta no es exitosa, el mensaje de error viene en el campo `detail`.

**✅ Checklist Fase 2**
- [ ] Se cumplen los 5 requisitos mínimos.
- [ ] Tu `frontend/index.html` está en tu repo.

---

## Fase 3 — El servicio completo en Codespaces (sin Docker)

Con tu modelo real en `models/` y tu frontend terminado:

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Sin `DEMO_MODE`: ahora los datos vienen de InfluxDB. Abre el puerto 8000 y revisa que todo funcione. Visita también `/api/salud` y **anota el valor de `atendido_por`**.

Detén la API con **Ctrl + C**.

**✅ Checklist Fase 3**
- [ ] Tu frontend muestra el pronóstico con datos reales.
- [ ] `/api/salud` muestra `"modelo_cargado": true` e `"influx_configurado": true`.
- [ ] `/api/salud` muestra `"modelo_demo": false` (no estás usando el modelo de prueba).

---

## Fase 4 — Tu contenedor

Ahora empaquetas el servicio en una imagen Docker que pueda correr en cualquier máquina.

### 4.1 Escribe el `Dockerfile`

Crea un archivo llamado `Dockerfile`, sin extensión, **en la raíz del repositorio**. Debe hacer esto, en este orden:

1. Partir de una **imagen base** oficial de Python 3.12 en su versión liviana (`slim`).
2. Definir `/app` como **carpeta de trabajo**.
3. Copiar **solo** `requirements.txt` e **instalar las dependencias** con `pip`, sin guardar caché.
4. Copiar las carpetas que necesita la app: `app/`, `frontend/` y `models/`.
5. **Exponer** el puerto 8000.
6. Definir el **comando de arranque**: `uvicorn` sirviendo `app.main:app` en el host `0.0.0.0` y el puerto `8000`.

Antes de escribirlo, piensa en estas dos preguntas:
- ¿Por qué se copia `requirements.txt` **antes** que el resto del código?
- ¿Por qué el host debe ser `0.0.0.0` y no `127.0.0.1` dentro de un contenedor?

### 4.2 Escribe el `.dockerignore`

Crea `.dockerignore` en la raíz. Su trabajo es impedir que entren a la imagen archivos que no deben estar ahí. Como mínimo, el `.env` (credenciales), la carpeta `.git`, los notebooks y las cachés de Python (`__pycache__`).

> **Pruébalo:** tu Dockerfile copia carpeta por carpeta, así que el `.env` no entraría aunque no tuvieras `.dockerignore`. Cambia temporalmente los `COPY` por un solo `COPY . .`, construye y ejecuta `docker run --rm pronostico ls -a /app` con y sin `.dockerignore`. ¿Qué cambia?

### 4.3 Construye la imagen

```bash
docker build -t pronostico .
```

La primera vez tarda 1–3 minutos. Si cambias solo el frontend y vuelves a construir, debe tardar segundos. Fíjate en cuáles pasos dicen `CACHED`.

### 4.4 Ejecuta el contenedor

```bash
docker run --rm -p 8000:8000 \
  -e INFLUX_URL -e INFLUX_TOKEN -e INFLUX_ORG -e INFLUX_BUCKET \
  pronostico
```

- `-p 8000:8000` conecta el puerto del contenedor con el del Codespace. Sin esto, la app corre pero nadie la ve.
- `-e INFLUX_TOKEN`, sin valor, copia al contenedor la variable que ya existe en tu Codespace. **Las credenciales se entregan al ejecutar la imagen, nunca dentro de ella.**

Abre el puerto 8000: debe verse exactamente igual que en la Fase 3.

### 4.5 La evidencia

En otra terminal (botón **+**):

```bash
docker ps
```

Compara el **CONTAINER ID** con el campo `atendido_por` de `/api/salud`. Deben ser **iguales**, y distintos del valor que anotaste en la Fase 3: quien responde ahora es el contenedor, no el Codespace.

Verifica también que tu imagen **no contiene credenciales**. Estos dos comandos no deben mostrar ni el token ni un archivo `.env`:

```bash
docker run --rm pronostico env | grep -i influx
docker run --rm pronostico ls -a /app
```

Sube tus archivos:

```bash
git add Dockerfile .dockerignore
git commit -m "Contenerización del servicio"
git push
```

**✅ Checklist Fase 4**
- [ ] `docker build` termina sin errores.
- [ ] La app funciona desde el contenedor en el puerto 8000.
- [ ] `atendido_por` coincide con el CONTAINER ID de `docker ps`.
- [ ] La imagen no contiene el token ni el `.env`.
- [ ] `Dockerfile` y `.dockerignore` están en tu repo.

---

## Entregables

En tu repositorio de GitHub:

1. `models/sarima_config.json`: tu modelo.
2. `notebooks/entrenamiento_sarima_colab.ipynb`: ejecutado completo.
3. `frontend/index.html`, y tus archivos `.css` o `.js` si los usaste.
4. `Dockerfile` y `.dockerignore`.
5. Una sección **Video** al inicio de este README con el enlace a tu video.

### El video (máximo 5 minutos)

Reemplaza la sustentación en vivo. Muestra tu app funcionando de las dos formas:

1. **Sin Docker:** ejecuta `uvicorn app.main:app --host 0.0.0.0 --port 8000`, abre tu frontend con datos reales, cambia las horas a pronosticar y abre `/api/salud` (debe decir `"modelo_demo": false`).
2. **Con Docker:** ejecuta `docker build` y `docker run` con los `-e`, abre tu frontend, y muestra `docker ps` junto a `/api/salud`: el CONTAINER ID debe coincidir con `atendido_por`.

Reglas: nunca muestres el token; la terminal y el navegador deben leerse bien; súbelo a YouTube como *no listado* o a Google Drive con acceso para el profesor.

> ⚠️ Si tu token aparece en el repositorio, en el historial de commits, dentro de la imagen o en el video, se descuenta de la nota.

---

## Problemas frecuentes

| Síntoma | Causa / solución |
|---|---|
| La terminal dice *recovery mode* | `F1` → *Codespaces: View Creation Log*, busca `error`. Avisa al profesor. |
| `echo ${#INFLUX_TOKEN}` da `0` | El Codespace no tomó los secrets: `F1` → *Codespaces: Rebuild Container*. |
| `Faltan variables de InfluxDB…` | Faltan secrets, o en `docker run` faltan los `-e`. |
| `(401) unauthorized` | Token mal copiado: revisa que esté completo, sin espacios. |
| `InfluxDB no devolvió datos…` | Measurement o field mal escritos. Usa `scripts/probar_conexion.py`. |
| `No hay modelo cargado` | Falta `models/sarima_config.json`. En Docker: vuelve a construir la imagen después de agregarlo. |
| En Colab: `No module named 'influxdb_client'` | No ejecutaste la celda `!pip install`. Ejecútala y repite. |
| En Colab: la serie sale constante | Ejecutaste las celdas fuera de orden. *Entorno de ejecución → Reiniciar y ejecutar todo.* |
| Tu frontend muestra horas 5 h adelantadas | Estás mostrando la hora UTC sin convertir. |
| `address already in use` en el puerto 8000 | Quedó corriendo uvicorn o un contenedor. Ctrl + C, o `docker ps` y `docker stop <id>`. |
| La app corre en Docker pero no abre | Falta `-p 8000:8000`, o el comando de arranque usa `127.0.0.1` en vez de `0.0.0.0`. |
| `docker build`: *failed to compute cache key… not found* | Un `COPY` apunta a una carpeta que no existe, o el `.dockerignore` la está excluyendo. |
| `ModuleNotFoundError: No module named 'app'` en el contenedor | No copiaste la carpeta `app/`, o el comando de arranque no es `app.main:app`. |

## Al terminar cada sesión

Detén la API con **Ctrl + C**. El Codespace se detiene solo tras 30 minutos sin actividad. Tu cuota gratuita es de **60 horas al mes** con la máquina de 2 núcleos. Revisa tu consumo en **github.com/settings/billing → Usage**, filtrando por Codespaces.
