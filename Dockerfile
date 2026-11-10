# 1. Imagen base oficial de Python 3.12, versión liviana
FROM python:3.12-slim

# 2. Carpeta de trabajo dentro del contenedor
WORKDIR /app

# 3. Primero solo requirements.txt: si el código cambia pero las dependencias
#    no, Docker reutiliza esta capa (CACHED) y no reinstala todo.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 4. Copiar solo lo que la app necesita (nunca el .env ni las credenciales)
COPY app/ ./app/
COPY frontend/ ./frontend/
COPY models/ ./models/

# 5. Puerto donde escucha uvicorn
EXPOSE 8000

# 6. Arranque: 0.0.0.0 para aceptar conexiones que llegan desde fuera del contenedor
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
