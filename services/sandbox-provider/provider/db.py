import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool


class Database:
    def __init__(self, url):
        self.pool = AsyncConnectionPool(url, min_size=1, max_size=8, open=False, kwargs={'row_factory': dict_row}, timeout=5)

    async def open(self):
        await self.pool.open(wait=True, timeout=10)
        async with self.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute('SELECT pg_advisory_xact_lock(720119451)')
                exists = await one(conn, "SELECT to_regclass('schema_migrations') IS NOT NULL AS present")
                applied = {row['version'] for row in await all_rows(conn, 'SELECT version FROM schema_migrations')} if exists['present'] else set()
                for migration in sorted(Path(__file__).parent.parent.joinpath('migrations').glob('*.sql')):
                    if int(migration.name.split('_', 1)[0]) not in applied:
                        await conn.execute(migration.read_text())

    async def close(self):
        await self.pool.close()

    @asynccontextmanager
    async def tx(self):
        async with self.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute("SET LOCAL statement_timeout = '10s'")
                yield conn

    async def health(self):
        async with self.tx() as c:
            await c.execute('SELECT 1')


async def one(conn, query, values=()):
    return await (await conn.execute(query, values)).fetchone()


async def all_rows(conn, query, values=()):
    return await (await conn.execute(query, values)).fetchall()
