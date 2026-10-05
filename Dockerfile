FROM python:3.12-slim
WORKDIR /app
COPY server.py ./
COPY backend ./backend
COPY web ./web
RUN mkdir -p /app/data && useradd --uid 10001 --create-home appuser && chown -R appuser:appuser /app
USER appuser
EXPOSE 8000
CMD ["python", "server.py", "--host", "0.0.0.0"]
