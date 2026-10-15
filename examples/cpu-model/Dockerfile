FROM python:3.12-slim
WORKDIR /app
COPY model.json server.py ./
USER 1000:1000
EXPOSE 8000
CMD ["python", "server.py"]
