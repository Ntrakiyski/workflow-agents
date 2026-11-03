"""Read-only operator evidence safeguards; no real runtime is opened."""
import json
import pytest

from scripts.qualify_runtime import Qualification, QualificationError
from scripts.read_runtime_diagnostic import TAIL_BYTES, inspect_existing
from .test_qualification import configured, SESSION


def existing(tmp_path):
    settings = configured(tmp_path)
    qualification = Qualification(settings, SESSION)
    qualification.save()
    logs = qualification.home / 'logs'
    logs.mkdir(parents=True)
    return settings, qualification, logs


def test_missing_session_creates_nothing(tmp_path):
    with pytest.raises(QualificationError, match='session_state_missing'):
        inspect_existing(configured(tmp_path), SESSION)
    assert list(tmp_path.iterdir()) == []


def test_log_reader_is_bounded_redacted_and_does_not_change_session(tmp_path):
    settings, qualification, logs = existing(tmp_path)
    contents = 'x' * (TAIL_BYTES * 2) + '\nbwrap: Operation not permitted ' + settings.auth[0]['token']
    for index in range(1, 4):
        (logs / f'boxlite.log.2026-11-0{index}').write_text(contents)
    before = {str(p): p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
    report = inspect_existing(settings, SESSION)
    after = {str(p): p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
    assert before == after
    assert report['outcome'] == 'passed' and len(report['sdk_logs']) == 2
    assert all(item['prefix_truncated'] for item in report['sdk_logs'])
    assert all(len(item['tail'].encode()) <= TAIL_BYTES for item in report['sdk_logs'])
    assert 'Operation not permitted' in json.dumps(report)
    assert settings.auth[0]['token'] not in json.dumps(report)


def test_log_symlinks_and_unrelated_files_are_not_read(tmp_path):
    settings, qualification, logs = existing(tmp_path)
    unrelated = tmp_path / 'unrelated-secret'
    unrelated.write_text('must not appear')
    (logs / 'boxlite.log').symlink_to(unrelated)
    (logs / 'boxlite.log.arbitrary').write_text('must not appear')
    result = inspect_existing(settings, SESSION)
    assert result['outcome'] == 'unavailable' and result['sdk_logs'] == []


def test_log_directory_symlink_is_refused(tmp_path):
    settings, qualification, logs = existing(tmp_path)
    logs.rmdir()
    logs.symlink_to(tmp_path)
    with pytest.raises(QualificationError, match='unsafe_diagnostic_directory'):
        inspect_existing(settings, SESSION)
