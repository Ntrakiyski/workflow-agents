FROM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PORT=8000 BOX_ROOT=/var/lib/sandbox-provider/boxlite
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir --requirement requirements.lock && groupadd --gid 10001 provider && useradd --uid 10001 --gid provider --create-home provider && mkdir -p /var/lib/sandbox-provider/boxlite && chown -R provider:provider /var/lib/sandbox-provider
COPY provider ./provider
COPY migrations ./migrations
COPY scripts ./scripts
COPY config ./config
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/ready',timeout=3)"
CMD ["python", "-m", "provider.app"]
