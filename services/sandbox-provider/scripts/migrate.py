import asyncio
import os
from provider.db import Database

async def main():
    db = Database(os.environ['DATABASE_URL'])
    await db.open()
    await db.close()
    print('Provider registry migrations applied.')

asyncio.run(main())
