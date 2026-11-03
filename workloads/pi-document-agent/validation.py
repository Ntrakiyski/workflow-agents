"""Controller-side byte/OOXML validation, independent of Pi or its claims."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import xml.etree.ElementTree as ET
import zipfile

MAX_FILE = 16 * 1024 * 1024
WORD_NS = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def sha256_file(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def validate_docx(path):
    if path.is_symlink() or path.suffix != '.docx' or not 0 < path.stat().st_size <= MAX_FILE:
        raise ValueError('Invalid DOCX file boundary')
    with zipfile.ZipFile(path) as archive:
        items = archive.infolist()
        names = [item.filename for item in items]
        if (len(items) > 10000 or len(names) != len(set(names))
                or sum(item.file_size for item in items) > 128 * 1024 * 1024
                or not {'[Content_Types].xml', '_rels/.rels', 'word/document.xml'} <= set(names)):
            raise ValueError('Invalid DOCX package limits or parts')
        for item in items:
            name = PurePosixPath(item.filename)
            if (name.is_absolute() or '..' in name.parts or '\\' in item.filename
                    or stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1
                    or item.filename.lower().endswith('vbaproject.bin')):
                raise ValueError('Unsafe DOCX package entry')
            # Read each entry to check CRC; XML entities and external relationships are forbidden.
            data = archive.read(item)
            if item.filename.endswith(('.xml', '.rels')):
                if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
                    raise ValueError('XML entities are forbidden')
                document = ET.fromstring(data)
                if item.filename.endswith('.rels') and any(
                        child.attrib.get('TargetMode', '').lower() == 'external' for child in document):
                    raise ValueError('External document relationships are forbidden')
        document = ET.fromstring(archive.read('word/document.xml'))
        if document.tag != WORD_NS + 'document' or document.find(WORD_NS + 'body') is None:
            raise ValueError('Missing Word body')
    paragraphs = [''.join(p.itertext()) for p in document.iter(WORD_NS + 'p')]
    return {'paragraphs': len(paragraphs), 'text': '\n'.join(paragraphs)}


def file_manifest(path, media_type):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_FILE:
        raise ValueError('Invalid output file')
    return {'path': path.name, 'media_type': media_type, 'size_bytes': path.stat().st_size,
            'sha256': sha256_file(path)}


def validate_delivery(directory, expected_request_id=None):
    report_path = directory / 'result.json'
    if report_path.is_symlink() or report_path.stat().st_size > 256 * 1024:
        raise ValueError('Invalid result boundary')
    result = json.loads(report_path.read_text())
    if result.get('schema_version') != 1 or result.get('outcome') != 'completed' or not isinstance(result.get('text'), str):
        raise ValueError('Workload did not complete')
    if not result['text'].strip() or len(result['text']) > 64000:
        raise ValueError('Missing or oversized final text')
    if expected_request_id is not None and result.get('request_id') != expected_request_id:
        raise ValueError('Request identity mismatch')
    validations = result.get('validations')
    if not isinstance(validations, list) or len(validations) > 32:
        raise ValueError('Invalid validation findings')
    for finding in validations:
        if (finding.get('category') not in ('structural', 'content', 'rendered_layout')
                or finding.get('status') not in ('passed', 'not_performed')
                or not isinstance(finding.get('code'), str) or not isinstance(finding.get('message'), str)):
            raise ValueError('Output has failed or invalid validation findings')
    artifacts = result.get('artifacts')
    if not isinstance(artifacts, list) or len(artifacts) > 8:
        raise ValueError('Invalid manifest')
    names = set()
    for artifact in artifacts:
        name = artifact['path']
        if not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}', name) or name in names:
            raise ValueError('Unsafe or duplicate artifact name')
        names.add(name)
        actual = file_manifest(directory / name, artifact['media_type'])
        if actual != artifact:
            raise ValueError('Output checksum or metadata mismatch')
        if name.endswith('.docx'):
            validate_docx(directory / name)
        elif name.endswith(('.txt', '.md')):
            (directory / name).read_text(encoding='utf-8')
        else:
            raise ValueError('Unsupported delivery type')
    return {'outcome': 'passed', 'checks': ['manifest_checksums', 'independent_package_structure'],
            'content_accuracy': 'not_performed', 'rendered_layout': 'not_performed',
            'artifacts': len(artifacts)}


if __name__ == '__main__':
    try:
        print(json.dumps(validate_delivery(Path(sys.argv[1]))))
    except Exception:
        print(json.dumps({'outcome': 'failed', 'code': 'delivery_validation_failed'}))
        raise SystemExit(1)
