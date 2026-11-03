"""LOCAL TEST ONLY: real HTTP API/DB with an explicitly fake in-memory runtime.

Not copied into the production image. Not a microVM demonstration.
"""
import os
import uvicorn
from provider.app import create_app
from provider.config import Settings
from .fake_runtime import FakeRuntime

if __name__ == '__main__':
    uvicorn.run(create_app(Settings.from_env(), FakeRuntime()), host='127.0.0.1',
                port=int(os.getenv('PORT', '8000')), access_log=False)
