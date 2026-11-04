import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bootstrap import install, prepare, require_prepared
from guest import answer_from_events, office_schema_passed, read_request
from guest import collect_process, prompts, run
from render_profile import profile
from validation import file_manifest, validate_delivery, validate_docx

DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'


def make_docx(path, relationships=None, body=None):
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr('[Content_Types].xml', '<Types/>')
        archive.writestr('_rels/.rels', relationships or '<Relationships/>')
        archive.writestr('word/document.xml', body or '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic fixture</w:t></w:r></w:p></w:body></w:document>')


class WorkloadTests(unittest.TestCase):
    def test_interrupted_request_fence_refuses_new_side_effects(self):
        with tempfile.TemporaryDirectory() as temp:
            transfer = Path(temp)
            request_id = 'b86c005c-3cbf-4879-b06c-6856567f20c1'
            root = transfer / 'requests' / request_id
            root.mkdir(parents=True)
            (root / '.execution-started').write_text(request_id)
            with patch('guest.TRANSFER_ROOT', transfer):
                with self.assertRaisesRegex(ValueError, 'uncertain'):
                    run(request_id)
            self.assertFalse((root / 'outputs/result.json').exists())

    def test_process_wait_drains_both_streams_and_rejects_nonzero_or_oversized_output(self):
        import os
        with tempfile.TemporaryDirectory() as temp:
            out, err = collect_process([sys.executable, '-c', 'import sys;print("complete");print("notice",file=sys.stderr)'], os.environ, temp, 5)
            self.assertEqual(out.strip(), 'complete')
            self.assertEqual(err.strip(), 'notice')
            with self.assertRaises(RuntimeError):
                collect_process([sys.executable, '-c', 'raise SystemExit(2)'], os.environ, temp, 5)
            with self.assertRaises(ValueError):
                collect_process([sys.executable, '-c', 'import sys;sys.stdout.write("x"*(11*1024*1024))'], os.environ, temp, 5)

    def test_officecli_actual_resident_and_nonresident_schema_shapes(self):
        self.assertTrue(office_schema_passed({'success': True, 'data': 'Validation passed: no errors found.'}))
        self.assertTrue(office_schema_passed({'success': True, 'data': {'count': 0, 'errors': []}}))
        self.assertFalse(office_schema_passed({'success': True, 'data': {'count': 0, 'errors': ['invalid']}}))
        self.assertFalse(office_schema_passed({'success': False, 'data': {'count': 1, 'errors': ['invalid']}}))

    def test_controller_rejects_changed_bytes_and_validates_actual_document(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / 'document.docx'
            make_docx(path)
            self.assertEqual(validate_docx(path)['paragraphs'], 1)
            result = {'schema_version': 1, 'outcome': 'completed', 'text': 'Complete',
                      'artifacts': [file_manifest(path, DOCX)], 'validations': [], 'session_files': []}
            (root / 'result.json').write_text(json.dumps(result))
            report = validate_delivery(root)
            self.assertEqual(report['rendered_layout'], 'not_performed')
            path.write_bytes(path.read_bytes() + b'changed')
            with self.assertRaises(ValueError):
                validate_delivery(root)

    def test_unsafe_ooxml_external_relationship_entities_and_wrong_body_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'document.docx'
            for kwargs in ({'relationships': '<Relationships><Relationship TargetMode="External" Target="https://example.com"/></Relationships>'},
                           {'body': '<!DOCTYPE x [<!ENTITY z "bad">]><x/>'}, {'body': '<x/>'}):
                make_docx(path, **kwargs)
                with self.assertRaises(ValueError):
                    validate_docx(path)

    def test_archive_rejects_traversal_symlinks_expansion_and_checksum(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name, symlink in (('../escape', False), ('/absolute', False), ('link', True)):
                archive = root / 'bundle.tar.gz'
                with tarfile.open(archive, 'w:gz') as target:
                    item = tarfile.TarInfo(name)
                    if symlink:
                        item.type, item.linkname = tarfile.SYMTYPE, '/etc/passwd'
                    else:
                        item.size = 4
                    target.addfile(item, None if symlink else io.BytesIO(b'test'))
                digest = hashlib.sha256(archive.read_bytes()).hexdigest()
                with self.assertRaises(ValueError):
                    install(archive, root / 'runtime', digest)
                self.assertFalse((root / 'runtime').exists())
            with self.assertRaises(ValueError):
                install(archive, root / 'runtime', '0' * 64)

    def test_archive_replay_detects_changed_installed_file(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive, runtime = root / 'bundle.tar.gz', root / 'runtime'
            with tarfile.open(archive, 'w:gz') as target:
                item = tarfile.TarInfo('file')
                item.size = 4
                target.addfile(item, io.BytesIO(b'test'))
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            install(archive, runtime, digest)
            install(archive, runtime, digest)
            (runtime / 'file').chmod(0o644)
            (runtime / 'file').write_text('edited')
            with self.assertRaises(ValueError):
                install(archive, runtime, digest)
            (runtime / 'file').write_text('test')
            runtime.chmod(0o755)
            (runtime / 'unexpected.pyc').write_bytes(b'unapproved code')
            with self.assertRaisesRegex(ValueError, 'unexpected'):
                install(archive, runtime, digest)

    def test_truncated_empty_or_failed_pi_messages_do_not_become_success(self):
        for value in ('', json.dumps({'type': 'message_end', 'message': {'role': 'assistant', 'stopReason': 'length', 'content': [{'type': 'text', 'text': 'partial'}]}})):
            with self.assertRaises(ValueError):
                answer_from_events(value)
        value = json.dumps({'type': 'message_end', 'message': {'role': 'assistant', 'stopReason': 'stop', 'content': [{'type': 'text', 'text': 'Complete.'}]}})
        self.assertEqual(answer_from_events(value), ('Complete.', []))

    def test_request_checksums_scope_and_document_count(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'inputs').mkdir()
            path = root / 'inputs/source.docx'
            make_docx(path)
            request_id = 'b86c005c-3cbf-4879-b06c-6856567f20c1'
            request = {'schema_version': 2, 'request_id': request_id, 'system_prompt': 'Work within the request folder.', 'instructions': 'Review',
                       'inputs': [file_manifest(path, DOCX)]}
            (root / 'request.json').write_text(json.dumps(request))
            self.assertEqual(len(read_request(root, request_id)[2]), 1)
            request['inputs'][0]['path'] = '../source.docx'
            (root / 'request.json').write_text(json.dumps(request))
            with self.assertRaises(ValueError):
                read_request(root, request_id)

    def test_profile_contains_no_secret_and_narrow_https_host(self):
        value = profile({'sha256': 'a' * 64}, 'docker.io/library/python@sha256:' + 'b' * 64,
                        'https://litellm.example.com/v1', 'approved-alias')
        self.assertEqual(value['sandboxes']['pi-document-cloud:v3']['allowed_hosts'], ['litellm.example.com'])
        self.assertNotIn('LITELLM_API_KEY', value['workloads']['pi-document-agent:v4']['environment'])
        for endpoint in ('http://litellm.example.com/v1', 'https://litellm.example.com:8443/v1'):
            with self.assertRaises(ValueError):
                profile({'sha256': 'a' * 64}, 'docker.io/library/python@sha256:' + 'b' * 64, endpoint, 'model')
        with self.assertRaises(ValueError):
            profile({'sha256': 'a' * 64}, 'python:latest', 'https://litellm.example.com/v1', 'model')


if __name__ == '__main__':
    unittest.main()
