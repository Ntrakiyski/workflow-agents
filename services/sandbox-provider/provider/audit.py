import json
import logging
import uuid
from datetime import datetime, timezone
from psycopg.types.json import Jsonb

logger = logging.getLogger('sandbox-provider')


def emit_log(action, correlation_id, actor_id=None, owner_id=None, **fields):
    entry = {'timestamp': datetime.now(timezone.utc).isoformat(), 'service': 'sandbox-provider',
             'correlation_id': correlation_id, 'actor_id': actor_id, 'owner_id': owner_id,
             'action': action, 'duration_ms': fields.pop('duration_ms', 0), 'outcome': fields.pop('outcome', 'ok'), **fields}
    logger.info(json.dumps(entry, separators=(',', ':')))


async def event(conn, sandbox, identity, correlation, kind, status, run_id=None, detail=None):
    event_id = 'evt_' + uuid.uuid4().hex
    await conn.execute('''INSERT INTO audit_events(event_id,sandbox_id,run_id,type,status,correlation_id,actor_id,owner_id,detail)
                         VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                       (event_id, sandbox['sandbox_id'], run_id, kind, status, correlation, identity.actor, identity.owner, Jsonb(detail or {})))
    emit_log(kind, correlation, identity.actor, identity.owner, sandbox_id=sandbox['sandbox_id'], run_id=run_id,
             outcome=status, **(detail or {}))
