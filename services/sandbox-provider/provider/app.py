import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, PlainTextResponse
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012
from psycopg import Error as DatabaseError
from . import VERSION
from .audit import emit_log
from .config import ID, Settings
from .errors import ServiceError, unavailable
from .runtime import BoxLiteRuntime
from .service import ProviderService, sandbox_json, run_json

OPENAPI = json.loads(Path(__file__).with_name('openapi.json').read_text())
REGISTRY = Registry().with_resource('urn:workflow:provider:openapi', Resource.from_contents(OPENAPI, default_specification=DRAFT202012))


def response(value, status=200):
    return JSONResponse(jsonable_encoder(value), status_code=status)


def err_response(err, correlation):
    return response({'code': err.code, 'message': err.message, 'retryable': err.retryable, 'correlation_id': correlation}, err.status)


def create_app(settings=None, runtime=None, dispatcher=True):
    settings = settings or Settings.from_env()
    runtime = runtime or BoxLiteRuntime(settings.box_root)
    service = ProviderService(settings, runtime)

    @asynccontextmanager
    async def lifespan(app):
        try:
            await service.open(dispatcher=dispatcher)
            yield
        finally:
            await service.close()

    app = FastAPI(title='Sandbox Provider', version=VERSION, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.openapi = lambda: OPENAPI
    app.state.service = service

    @app.middleware('http')
    async def protocol(request, call_next):
        started = time.monotonic()
        correlation = request.headers.get('x-correlation-id') or 'corr_' + uuid.uuid4().hex
        if not ID.fullmatch(correlation):
            correlation = 'corr_' + uuid.uuid4().hex
            result = err_response(ServiceError(400, 'invalid_request', 'Correlation header is invalid.'), correlation)
        else:
            request.state.correlation = correlation
            try:
                for name, value in request.path_params.items():
                    if not ID.fullmatch(value):
                        raise ServiceError(400, 'invalid_request', 'Resource identifier is invalid.')
                if request.url.path.startswith('/v1/') or request.url.path == '/metrics':
                    request.state.identity = settings.authenticate(request.headers.get('authorization'), request.headers.get('x-owner-id'))
                if request.headers.get('content-length'):
                    try:
                        if int(request.headers['content-length']) > settings.max_body:
                            raise ServiceError(413, 'invalid_request', 'Request body exceeds the allowed size.')
                    except ValueError:
                        raise ServiceError(400, 'invalid_request', 'Content length is invalid.')
                result = await call_next(request)
            except ServiceError as exc:
                result = err_response(exc, correlation)
            except Exception:
                result = err_response(unavailable('dependency_unavailable'), correlation)
        result.headers['X-Correlation-ID'] = correlation
        emit_log('http.request', correlation, getattr(getattr(request.state, 'identity', None), 'actor', None),
                 getattr(getattr(request.state, 'identity', None), 'owner', None),
                 duration_ms=round((time.monotonic() - started) * 1000, 3), outcome=str(result.status_code),
                 method=request.method)
        return result

    @app.exception_handler(ServiceError)
    async def service_error(request, exc):
        return err_response(exc, request.state.correlation)

    @app.exception_handler(DatabaseError)
    async def database_error(request, exc):
        return err_response(unavailable('dependency_unavailable'), request.state.correlation)

    async def body(request, schema):
        if request.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json':
            raise ServiceError(415, 'invalid_request', 'Content type must be application/json.')
        data = bytearray()
        async for part in request.stream():
            data.extend(part)
            if len(data) > settings.max_body:
                raise ServiceError(413, 'invalid_request', 'Request body exceeds the allowed size.')
        try:
            value = json.loads(data, parse_constant=lambda value: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeDecodeError):
            raise ServiceError(400, 'invalid_request', 'Request body must be valid JSON.')
        if not Draft202012Validator({'$ref': 'urn:workflow:provider:openapi#/components/schemas/' + schema}, registry=REGISTRY).is_valid(value):
            raise ServiceError(422, 'invalid_request', 'Request does not match the published schema.')
        return value

    def key(request):
        value = request.headers.get('idempotency-key')
        if not value or not ID.fullmatch(value):
            raise ServiceError(400, 'invalid_request', 'A valid Idempotency-Key header is required.')
        return value

    def require(request, action):
        if 'sandbox:' + action not in request.state.identity.policy['permissions']:
            raise ServiceError(403, 'forbidden', 'Operation is not permitted by credential policy.')

    def ids(*values):
        if any(not ID.fullmatch(v) for v in values):
            raise ServiceError(400, 'invalid_request', 'Resource identifier is invalid.')

    @app.get('/metrics')
    async def metrics(request: Request):
        require(request, 'read')
        async with service.db.tx() as c:
            rows = await (await c.execute('SELECT status,count(*) AS count FROM sandboxes WHERE owner_id=%s GROUP BY status', (request.state.identity.owner,))).fetchall()
            runs = await (await c.execute('SELECT status,count(*) AS count FROM runs WHERE owner_id=%s GROUP BY status', (request.state.identity.owner,))).fetchall()
        lines = ['# HELP sandbox_provider_sandboxes Current environments for the authenticated owner.', '# TYPE sandbox_provider_sandboxes gauge']
        lines += ['sandbox_provider_sandboxes{state="' + row['status'] + '"} ' + str(row['count']) for row in rows]
        lines += ['# HELP sandbox_provider_runs Durable runs for the authenticated owner.', '# TYPE sandbox_provider_runs gauge']
        lines += ['sandbox_provider_runs{state="' + row['status'] + '"} ' + str(row['count']) for row in runs]
        return PlainTextResponse('\n'.join(lines) + '\n', media_type='text/plain; version=0.0.4')

    @app.get('/health/live')
    async def live():
        return response({'status': 'ok', 'service': 'sandbox-provider', 'version': VERSION, 'checks': {'process': 'ok'}})

    @app.get('/health/ready')
    async def ready():
        checks = {'database': 'ok', 'runtime': 'ok'}
        try:
            await service.db.health()
        except Exception:
            checks['database'] = 'unavailable'
        try:
            if not await runtime.ready():
                checks['runtime'] = 'unavailable'
        except Exception:
            checks['runtime'] = 'unavailable'
        if runtime.kind != 'boxlite':
            checks['runtime'] = 'disabled'
        ok = all(v == 'ok' for v in checks.values())
        return response({'status': 'ok' if ok else 'unavailable', 'service': 'sandbox-provider', 'version': VERSION, 'checks': checks}, 200 if ok else 503)

    @app.post('/v1/sandboxes')
    async def create(request: Request):
        require(request, 'create')
        payload = await body(request, 'CreateSandbox')
        return response(await service.create(request.state.identity, key(request), payload, request.state.correlation), 201)

    @app.get('/v1/sandboxes/{sandbox_id}')
    async def inspect(sandbox_id: str, request: Request):
        require(request, 'read')
        ids(sandbox_id)
        async with service.db.tx() as c:
            return response(sandbox_json(await service.get_sandbox(c, request.state.identity, sandbox_id)))

    @app.get('/v1/sandboxes/{sandbox_id}/events')
    async def events(sandbox_id: str, request: Request):
        require(request, 'read')
        ids(sandbox_id)
        if any(k not in ('cursor', 'limit') for k in request.query_params):
            raise ServiceError(400, 'invalid_request', 'Unknown query parameter.')
        try:
            limit = int(request.query_params.get('limit', '50'))
        except ValueError:
            raise ServiceError(400, 'invalid_request', 'Event limit is invalid.')
        return response(await service.events(request.state.identity, sandbox_id, request.query_params.get('cursor'), limit))

    @app.post('/v1/sandboxes/{sandbox_id}/start')
    async def start(sandbox_id: str, request: Request):
        require(request, 'start')
        ids(sandbox_id)
        await body(request, 'Empty')
        return response(await service.lifecycle(request.state.identity, sandbox_id, 'start', request.state.correlation))

    @app.post('/v1/sandboxes/{sandbox_id}/stop')
    async def stop(sandbox_id: str, request: Request):
        require(request, 'stop')
        ids(sandbox_id)
        await body(request, 'Empty')
        return response(await service.lifecycle(request.state.identity, sandbox_id, 'stop', request.state.correlation))

    @app.post('/v1/sandboxes/{sandbox_id}/destroy')
    async def destroy(sandbox_id: str, request: Request):
        require(request, 'destroy')
        ids(sandbox_id)
        await body(request, 'DestroyRequest')
        if 'sandbox:destroy' not in request.state.identity.policy['permissions']:
            raise ServiceError(403, 'forbidden', 'Explicit environment destruction is not permitted.')
        return response(await service.lifecycle(request.state.identity, sandbox_id, 'destroy', request.state.correlation))

    @app.post('/v1/sandboxes/{sandbox_id}/execute')
    async def execute(sandbox_id: str, request: Request):
        require(request, 'execute')
        ids(sandbox_id)
        payload = await body(request, 'ExecuteRequest')
        return response(await service.execute(request.state.identity, sandbox_id, key(request), payload, request.state.correlation), 202)

    @app.post('/v1/sandboxes/{sandbox_id}/runs/cancel-by-reference')
    async def cancel_by_reference(sandbox_id: str, request: Request):
        require(request, 'cancel')
        ids(sandbox_id)
        payload = await body(request, 'CancelByReferenceRequest')
        return response(await service.cancel_by_reference(request.state.identity, sandbox_id, payload, request.state.correlation), 202)

    @app.get('/v1/sandboxes/{sandbox_id}/runs/{run_id}')
    async def inspect_run(sandbox_id: str, run_id: str, request: Request):
        require(request, 'read')
        ids(sandbox_id, run_id)
        async with service.db.tx() as c:
            return response(run_json(await service.get_run(c, request.state.identity, sandbox_id, run_id)))

    @app.post('/v1/sandboxes/{sandbox_id}/runs/{run_id}/cancel')
    async def cancel(sandbox_id: str, run_id: str, request: Request):
        require(request, 'cancel')
        ids(sandbox_id, run_id)
        await body(request, 'CancelRequest')
        return response(await service.cancel(request.state.identity, sandbox_id, run_id, request.state.correlation), 202)

    return app


def main():
    import os
    import uvicorn
    from .audit import JsonFormatter
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    logging.basicConfig(level=getattr(logging, os.getenv('LOG_LEVEL', 'INFO').upper(), logging.INFO), handlers=[handler], force=True)
    # Access logging is disabled: service middleware emits bounded JSON metadata.
    uvicorn.run(create_app(), host='0.0.0.0', port=int(os.getenv('PORT', '8000')), access_log=False, log_config=None)


if __name__ == '__main__':
    main()
