FROM python:3.11-slim-bookworm
WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir . fastapi==0.115.6 uvicorn==0.34.0
COPY api.py ./
COPY problems ./problems
RUN useradd -r -u 10001 judge && chown -R judge:judge /app
USER judge
EXPOSE 8100
CMD ["uvicorn","api:app","--host","0.0.0.0","--port","8100","--workers","1"]
