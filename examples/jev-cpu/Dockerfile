FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt
COPY vendor ./vendor
COPY service.py provenance.json ./
COPY model /models/qwen3-0.6b
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 BIND_HOST=0.0.0.0 PORT=8000 CPU_THREADS=2 MAX_INPUT_TOKENS=1024
USER 1000:1000
EXPOSE 8000
CMD ["python", "service.py"]
