#!/usr/bin/env python3
"""Validate one actual HTTP JSON response against the frozen contract.

Usage: python contracts/assert_response.py provider GET /v1/sandboxes/sbx_a 200 response.json
This reads a captured response; it does not make HTTP requests or log credentials.
"""
import json
from pathlib import Path
import re
import sys
from jsonschema import Draft202012Validator, FormatChecker

ROOT=Path(__file__).resolve().parent

def assert_response(service,method,path,status,payload):
    if service not in {'runner','provider'}:
        raise ValueError('service must be runner or provider')
    doc=json.loads((ROOT/'v1'/f'{service}-v1.openapi.json').read_text())
    operation=None
    for template,methods in doc['paths'].items():
        pattern=re.sub(r'\{[^}]+\}', '[^/]+', template)
        if re.fullmatch(pattern,path) and method.lower() in methods:
            operation=methods[method.lower()]
            break
    if operation is None:
        raise ValueError('No matching operation')
    response=operation['responses'].get(str(status))
    if response is None:
        raise ValueError('Undocumented HTTP status')
    schema={'components':doc['components'],**response['content']['application/json']['schema']}
    Draft202012Validator(schema,format_checker=FormatChecker()).validate(payload)

if __name__=='__main__':
    if len(sys.argv)!=6:
        raise SystemExit(__doc__)
    service,method,path,status,filename=sys.argv[1:]
    assert_response(service,method,path,status,json.loads(Path(filename).read_text()))
    print('PASS: captured HTTP response conforms to frozen contract')
