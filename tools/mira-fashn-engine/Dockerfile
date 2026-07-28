FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-venv python3-pip libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY vendor/fashn-vton-1.5-main /app/fashn-vton
COPY requirements-api.txt /app/requirements-api.txt
RUN python3.11 -m pip install --upgrade pip \
    && python3.11 -m pip install --index-url https://download.pytorch.org/whl/cu124 torch torchvision \
    && python3.11 -m pip install -e /app/fashn-vton \
    && python3.11 -m pip install -r /app/requirements-api.txt

COPY server.py /app/server.py
EXPOSE 8000
CMD ["python3.11", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
