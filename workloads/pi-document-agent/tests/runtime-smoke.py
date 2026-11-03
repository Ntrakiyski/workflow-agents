"""Run actual pinned binaries and the constrained extension, without model/network calls."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from validation import validate_docx
from guest import office_schema_passed

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--runtime', type=Path, required=True)
runtime = parser.parse_args().runtime.resolve()

with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    (root / 'outputs').mkdir()
    document = root / 'outputs/document.docx'
    env = os.environ | {'HOME': str(root), 'OFFICECLI_NO_AUTO_RESIDENT': '1',
                        'PI_REQUEST_ROOT': str(root), 'PI_DOCX_PATH': str(document)}
    def run(argv):
        return subprocess.check_output(argv, env=env, text=True, timeout=90).strip()
    assert run([str(runtime / 'node'), '--version']) == 'v24.22.2'
    assert run([str(runtime / 'node'), str(runtime / 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--version']) == '1.5.0'
    assert run([str(runtime / 'officecli'), '--version']).splitlines()[-1] == '1.0.160'
    run([str(runtime / 'officecli'), 'create', str(document)])
    run([str(runtime / 'officecli'), 'add', str(document), '/body', '--type', 'paragraph', '--prop', 'text=Synthetic workflow fixture.'])
    checked = json.loads(run([str(runtime / 'officecli'), 'validate', str(document), '--json']))
    assert office_schema_passed(checked)
    assert 'Synthetic workflow fixture.' in validate_docx(document)['text']
    script = '''
import { createJiti } from %s;
const jiti = createJiti(import.meta.url);
const register = await jiti.import(%s, {default: true});
let tool;
register({registerTool(value) {tool=value;}});
if (!tool || tool.name !== 'officecli') throw new Error('Tool did not register');
const result=await tool.execute('smoke',{operation:'read'});
if (result.isError || !result.content.some(p=>p.text?.includes('Synthetic workflow fixture.'))) throw new Error('Actual tool readback failed');
process.stdout.write(JSON.stringify({registered:true,readback:true}));
''' % (json.dumps(str(runtime / 'node_modules/jiti/lib/jiti.mjs')),
       json.dumps(str(runtime / 'officecli-tool.ts')))
    checked = json.loads(run([str(runtime / 'node'), '--input-type=module', '-e', script]))
    assert checked == {'registered': True, 'readback': True}
    print(json.dumps({'outcome': 'passed', 'actual_binaries': ['Node24.22.2', 'Pi1.5.0', 'OfficeCLI1.0.160'],
                      'checks': ['docx_creation', 'persisted_paragraph', 'officecli_schema', 'independent_ooxml', 'extension_readback'],
                      'model_call': 'not_performed', 'rendered_layout': 'not_performed'}))
